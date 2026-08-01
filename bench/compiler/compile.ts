// The script→flow compiler, v0. Input: a matched pair of instrumented traces
// (fixture variants 0 and 1) for one successful script. Output: a candidate
// .flow.json5 (mcp_call steps against the primitives server) + provenance.
// The observed trace is the evidence; the script is only where the trace came
// from. Fail-closed: any ambiguity is a refusal, not a guess.
//
//   npx tsx bench/compiler/compile.ts <traces/name.v0.json> <out-dir> <flow_name>

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';

interface TraceEntry { seq: number; name: string; args: Record<string, unknown>; result: unknown }
interface Run { variant: number; result: string; trace: TraceEntry[] }

class Refusal extends Error {}

function leaves(value: unknown, path = ''): Array<[string, unknown]> {
  if (value === null || typeof value !== 'object') return [[path, value]];
  const out: Array<[string, unknown]> = [];
  for (const [k, v] of Object.entries(value)) {
    out.push(...leaves(v, path ? `${path}.${k}` : k));
  }
  return out;
}

// engine path syntax: numeric segments become [n]
const enginePath = (p: string) =>
  p.split('.').map((seg) => (/^\d+$/.test(seg) ? `[${seg}]` : `.${seg}`)).join('').replace(/^\./, '');

function subst(text: string, value: unknown, replacement: string): string {
  const sv = String(value);
  if (/^\d+(\.\d+)?$/.test(sv)) {
    if (sv.length < 2) return text;
    return text.replace(new RegExp(`(?<![\\d.])${sv.replace('.', '\\.')}(?![\\d.])`, 'g'), replacement);
  }
  if (sv.length < 3) return text;
  return text.split(sv).join(replacement);
}

function findRef(trace: TraceEntry[], before: number, value: unknown): { seq: number; path: string } | null {
  for (let i = before - 1; i >= 0; i--) {
    const hit = leaves(trace[i]!.result).find(([, v]) => v === value);
    if (hit) return { seq: trace[i]!.seq, path: hit[0] };
  }
  return null;
}

interface Node {
  id: string;
  tool: string;
  args: Record<string, string>; // interpolation strings
  seqs: number[]; // original trace seqs merged into this node
  fanout?: { overId: string; slice: number; as: string; itemArgPath: string };
}

export interface CompileOpts {
  server?: string | Record<string, string>;   // one server, or tool-name -> server map
  inputHints?: Record<string, string[]>;      // input name -> example values seen
  description?: string;                       // WHEN TO USE text for the emitted flow
}

export function compile(v0: Run, v1: Run, flowName: string, sourceName: string, opts: CompileOpts = {}) {
  const serverOf = (tool: string) =>
    typeof opts.server === 'object' ? (opts.server[tool] ?? 'prims') : (opts.server ?? 'prims');
  const inputHints = opts.inputHints ?? { city: ['Lisbon', 'New York'] };
  const provenance: Record<string, unknown> = { source: sourceName, flowName };
  const warnings: string[] = [];
  const dropped: string[] = [];
  const t0 = v0.trace;
  const t1 = v1.trace;
  if (t0.length !== t1.length) throw new Refusal('trace lengths differ across variants');

  // 1. classify args and dedupe identical calls
  const seen = new Map<string, number>(); // signature -> node index
  const nodes: Node[] = [];
  const seqToNode = new Map<number, number>();
  const inputs: Record<string, string> = {}; // input name -> example value
  for (let i = 0; i < t0.length; i++) {
    const call = t0[i]!;
    const call1 = t1[i]!;
    if (call.name !== call1.name) throw new Refusal(`call #${i} differs across variants (${call.name} vs ${call1.name})`);
    const sig = call.name + JSON.stringify(call.args);
    if (seen.has(sig) && JSON.stringify(t0[nodes[seen.get(sig)!]!.seqs[0]!]!.result) === JSON.stringify(call.result)) {
      seqToNode.set(call.seq, seen.get(sig)!);
      nodes[seen.get(sig)!]!.seqs.push(call.seq);
      continue; // dedupe: identical idempotent call
    }
    const args: Record<string, string> = {};
    for (const [p, v] of leaves(call.args)) {
      const v1leaf = leaves(call1.args).find(([p1]) => p1 === p)?.[1];
      const ref = findRef(t0, i, v);
      if (ref) {
        const ref1 = findRef(t1, i, v1leaf);
        if (!ref1 || seqToNode.get(ref.seq) !== seqToNode.get(ref1.seq) || ref.path !== ref1.path) {
          throw new Refusal(`unstable ref for ${call.name}.${p} across variants`);
        }
        args[p] = `{{steps.n${seqToNode.get(ref.seq)}.${enginePath(ref.path)}}}`;
      } else if (v === v1leaf) {
        const hint = Object.entries(inputHints).find(([, vals]) => vals.some((x) => String(v).includes(x)));
        if (hint && typeof v === 'string') {
          const hintVal = hint[1].find((x) => v.includes(x))!;
          inputs[hint[0]] = hintVal;
          args[p] = v.split(hintVal).join(`{{input.${hint[0]}}}`);
        } else {
          args[p] = String(v);
          if (typeof v === 'number') warnings.push(`${call.name}.${p}: numeric const emitted as string`);
        }
      } else {
        throw new Refusal(`derived argument ${call.name}.${p} (${JSON.stringify(v)} vs ${JSON.stringify(v1leaf)}) — cannot represent`);
      }
    }
    const idx = nodes.length;
    nodes.push({ id: `n${idx}`, tool: call.name, args, seqs: [call.seq] });
    seen.set(sig, idx);
    seqToNode.set(call.seq, idx);
  }

  // 2. fanout detection: consecutive nodes, same tool, single distinguishing arg
  //    referencing positions 0..k-1 of one prior array-result node
  const merged: Node[] = [];
  for (let i = 0; i < nodes.length; ) {
    const run: Node[] = [nodes[i]!];
    while (i + run.length < nodes.length && nodes[i + run.length]!.tool === nodes[i]!.tool) run.push(nodes[i + run.length]!);
    const positions = run.map((n, k) => {
      const argPaths = Object.keys(n.args);
      if (argPaths.length !== 1) return null;
      const m = /^\{\{steps\.(n\d+)\.\[(\d+)\]\}\}$/.exec(n.args[argPaths[0]!]!);
      return m && Number(m[2]) === k ? { overId: m[1]!, itemArgPath: argPaths[0]! } : null;
    });
    if (run.length >= 2 && positions.every((p) => p && p.overId === positions[0]!.overId)) {
      merged.push({ id: run[0]!.id, tool: run[0]!.tool, args: {}, seqs: run.flatMap((n) => n.seqs),
        fanout: { overId: positions[0]!.overId, slice: run.length, as: 'item', itemArgPath: positions[0]!.itemArgPath } });
    } else {
      merged.push(...run);
    }
    i += run.length;
  }

  // 3. dead-call elimination: a node must feed a later arg or the final output
  const finalText = v0.result;
  const live = new Set<string>();
  const nodeById = new Map(merged.map((n) => [n.id, n]));
  const usedInOutput = (n: Node) =>
    n.seqs.some((s) => leaves(t0.find((c) => c.seq === s)!.result).some(([, v]) => v !== null && String(v).length >= 3 && finalText.includes(String(v))));
  const feeds = (id: string) => merged.some((m) => Object.values(m.args).some((a) => a.includes(`steps.${id}.`)) || m.fanout?.overId === id);
  for (const n of merged) if (usedInOutput(n) || feeds(n.id)) live.add(n.id);
  // keep transitive dependencies of live nodes
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of merged) {
      if (!live.has(n.id)) continue;
      const deps = [...Object.values(n.args).join(' ').matchAll(/steps\.(n\d+)\./g)].map((m) => m[1]!);
      if (n.fanout) deps.push(n.fanout.overId);
      for (const d of deps) if (!live.has(d)) { live.add(d); grew = true; }
    }
  }
  const kept = merged.filter((n) => live.has(n.id));
  for (const n of merged) if (!live.has(n.id)) dropped.push(`${n.id} (${n.tool}) — result unused`);

  // 4. assemble inference: templatize the final answer against trace values.
  // FOLD GROUPS generalize repetition: a fanout node's per-call results, OR an
  // array-of-objects inside a single call's result (e.g. search results[]) —
  // both become a map/lines step instead of unrolled fixed slots.
  function findObjectArrays(value: unknown, path = ''): Array<[string, unknown[]]> {
    if (Array.isArray(value)) {
      return value.length >= 2 && value.every((e) => e !== null && typeof e === 'object' && !Array.isArray(e))
        ? [[path, value]]
        : [];
    }
    if (value !== null && typeof value === 'object') {
      const out: Array<[string, unknown[]]> = [];
      for (const [k, v] of Object.entries(value)) out.push(...findObjectArrays(v, path ? `${path}.${k}` : k));
      return out;
    }
    return [];
  }

  interface Group { gid: string; overExpr: string; items: unknown[] }

  function templatize(run: Run): { outer: string; inners: Map<string, { template: string; count: number; overExpr: string }> } {
    const t = run.trace;
    const lines = run.result.split('\n');
    const groups: Group[] = [];
    const fan = kept.find((n) => n.fanout);
    if (fan) {
      groups.push({
        gid: fan.id,
        overExpr: `steps.${fan.id}`,
        items: fan.seqs.slice(0, fan.fanout!.slice).map((sq) => t.find((c) => c.seq === sq)!.result),
      });
    }
    for (const n of kept.filter((k) => !k.fanout)) {
      const res = t.find((c) => c.seq === n.seqs[0]!)!.result;
      for (const [ap, arr] of findObjectArrays(res)) {
        groups.push({ gid: `${n.id}${ap ? '_' + ap.replace(/[^A-Za-z0-9]+/g, '_') : ''}`, overExpr: `steps.${n.id}${ap ? '.' + enginePath(ap) : ''}`, items: arr });
      }
    }

    const claimedBy: Array<{ gid: string; item: number } | null> = lines.map(() => null);
    const inners = new Map<string, { template: string; count: number; overExpr: string }>();

    for (const g of groups) {
      const distinctive = (item: unknown, line: string) =>
        leaves(item).some(([, v]) => v !== null && String(v).length >= 3 && line.includes(String(v)));
      const hits: Array<{ lineIdx: number; item: number }> = [];
      lines.forEach((line, li) => {
        if (claimedBy[li]) return;
        const matches = g.items.map((it, k) => (distinctive(it, line) ? k : -1)).filter((k) => k >= 0);
        if (matches.length === 1) hits.push({ lineIdx: li, item: matches[0]! });
      });
      if (hits.length < 2) continue; // nothing repetitive to fold for this group
      const itemsSeen = [...new Set(hits.map((h) => h.item))].sort((a, b) => a - b);
      const contiguous = itemsSeen.every((v, i) => v === i);
      if (!contiguous) {
        throw new Refusal(
          `group ${g.gid}: observed non-contiguous item selection [${itemsSeen.join(',')}] — the script's selection logic (e.g. cross-query dedupe) is not representable; unrolled emission would break when live data has fewer items. Re-author with a contiguous take-N, or hand-write this flow.`,
        );
      }
      // BLOCK-based: an item may render as several lines (title + snippet).
      // Extend each item's claim to the contiguous run following its first hit
      // that contains no other item's values and is non-empty.
      const byItem = new Map<number, number[]>();
      for (const h of hits) {
        if (!byItem.has(h.item)) byItem.set(h.item, []);
        byItem.get(h.item)!.push(h.lineIdx);
      }
      const blockLines = new Map<number, number[]>(); // item -> line indexes
      for (const [item, idxs] of byItem) {
        const all = new Set(idxs);
        const startLine = Math.min(...idxs);
        const endLine = Math.max(...idxs);
        for (let li = startLine; li <= endLine; li++) all.add(li); // fill interior gaps
        blockLines.set(item, [...all].sort((a, b) => a - b));
      }
      const templates = new Set(
        [...blockLines].map(([item, idxs]) => {
          let block = idxs.map((li) => lines[li]!).join('\n');
          for (const [p, v] of leaves(g.items[item]!).sort((a, b) => String(b[1]).length - String(a[1]).length)) {
            if (v !== null) block = subst(block, v, `{{it.${enginePath(p)}}}`);
          }
          return block.replace(new RegExp(`(?<!\\d)${item + 1}(?!\\d)`, 'g'), 'ORD');
        }),
      );
      if (templates.size !== 1) {
        throw new Refusal(
          `group ${g.gid}: per-item blocks not structurally identical (${templates.size} shapes) — unrolled emission would be fragile on live data. Re-author for uniform per-item rendering, or hand-write this flow.`,
        );
      }
      for (const [item, idxs] of blockLines) for (const li of idxs) claimedBy[li] = { gid: g.gid, item };
      inners.set(g.gid, { template: [...templates][0]!, count: itemsSeen.length, overExpr: g.overExpr });
    }

    // rebuild outer: first claimed line of each folded group becomes its marker
    const emitted = new Set<string>();
    const outLines: string[] = [];
    lines.forEach((line, li) => {
      const c = claimedBy[li];
      if (c && inners.has(c.gid)) {
        if (!emitted.has(c.gid)) { outLines.push(`@@G_${c.gid}@@`); emitted.add(c.gid); }
        return;
      }
      outLines.push(line);
    });
    let text = outLines.join('\n');
    for (const n of kept.filter((k) => !k.fanout)) {
      for (const sq of n.seqs) {
        for (const [p, v] of leaves(t.find((c) => c.seq === sq)!.result).sort((a, b) => String(b[1]).length - String(a[1]).length)) {
          if (v === null) continue;
          text = subst(text, v, `{{steps.${n.id}.${enginePath(p)}}}`);
        }
      }
    }
    return { outer: text, inners };
  }
  const a0 = templatize(v0);
  const a1 = templatize(v1);
  const innersEqual =
    a0.inners.size === a1.inners.size &&
    [...a0.inners].every(([gid, v]) => a1.inners.get(gid)?.template === v.template && a1.inners.get(gid)?.count === v.count);
  if (a0.outer !== a1.outer || !innersEqual) {
    throw new Refusal('assemble: templates differ across variants — output not fully explained by trace values');
  }

  // input substitution into templates: the promoted input value appears in the
  // output too (titles, headers) — parameterize it there as well
  const substInputs = (text: string) => {
    let out = text;
    for (const [name, ex] of Object.entries(inputs)) out = subst(out, ex, `{{input.${name}}}`);
    return out;
  };

  // 5. emit flow
  const steps: string[] = [];
  for (const n of kept) {
    if (n.fanout) {
      steps.push(`    { id: '${n.id}', kind: 'map', over: 'steps.${n.fanout.overId}[0:${n.fanout.slice}]', as: 'x',
      step: { kind: 'mcp_call', server: '${serverOf(n.tool)}', tool: '${n.tool}', args: { ${n.fanout.itemArgPath}: '{{x}}' } } },`);
    } else {
      const args = Object.entries(n.args).map(([p, v]) => `${p.includes('.') ? `'${p}'` : p}: '${v}'`).join(', ');
      steps.push(`    { id: '${n.id}', kind: 'mcp_call', server: '${serverOf(n.tool)}', tool: '${n.tool}'${args ? `, args: { ${args} }` : ''} },`);
    }
  }
  let output = a0.outer;
  for (const [gid, inner] of a0.inners) {
    let innerTemplate = substInputs(inner.template);
    if (innerTemplate.includes('ORD')) {
      warnings.push('per-item ordinal numbering dropped: the flow DSL map has no loop index; emitted as list dashes');
      innerTemplate = innerTemplate.replace(/^\s*(?:[A-Za-z]+ )?ORD[.):]?\s*/, '- ').replace(/ORD/g, '');
    }
    const stepId = `lines_${gid}`;
    steps.push(`    { id: '${stepId}', kind: 'map', over: '${inner.overExpr}[0:${inner.count}]', as: 'it',
      step: { kind: 'template', template: ${JSON.stringify(innerTemplate)} } },`);
    output = output.replace(`@@G_${gid}@@`, `{{steps.${stepId}}}`);
  }
  output = substInputs(output);
  const inputBlock = Object.keys(inputs).length
    ? `  input: {\n${Object.entries(inputs).map(([k, ex]) => `    ${k}: { type: 'string', description: ${JSON.stringify(`Observed values include ${ex}`)}, required: false, default: ${JSON.stringify(ex)} },`).join('\n')}\n  },\n`
    : '  input: {},\n';
  const flow = `// COMPILED FLOW — generated by bench/compiler/compile.ts from ${sourceName}.
// Review before use. Evidence: matched traces under two fixture variants.
{
  name: '${flowName}',
  description: ${JSON.stringify((opts.description ?? `WHEN TO USE: compiled candidate from a successful model-authored script (${sourceName}).`).slice(0, 300))},
${inputBlock}  steps: [
${steps.join('\n')}
    { id: 'render', kind: 'template', template: ${JSON.stringify(output)} },
  ],
  output: '{{steps.render}}',
}
`;
  provenance.warnings = warnings;
  provenance.droppedCalls = dropped;
  provenance.dedupedCalls = merged.filter((n) => n.seqs.length > (n.fanout ? n.fanout.slice : 1)).map((n) => n.id);
  provenance.nodes = kept.length;
  return { flow, provenance };
}

// CLI (only when executed directly, not when imported)
if (process.argv[1]?.endsWith('compile.ts') && process.argv[2]) {
  const v0Path = process.argv[2]!;
  const outDir = process.argv[3] ?? 'bench/compiler/out';
  const flowName = process.argv[4] ?? 'compiled_flow';
  const serverName = process.argv[5] ?? 'prims';
  const v0 = JSON.parse(readFileSync(v0Path, 'utf8')) as Run;
  const v1 = JSON.parse(readFileSync(v0Path.replace('.v0.', '.v1.'), 'utf8')) as Run;
  mkdirSync(outDir, { recursive: true });
  try {
    const { flow, provenance } = compile(v0, v1, flowName, basename(v0Path), { server: serverName });
    writeFileSync(join(outDir, `${flowName}.flow.json5`), flow);
    writeFileSync(join(outDir, `${flowName}.provenance.json`), JSON.stringify(provenance, null, 2));
    console.log(`compiled → ${join(outDir, `${flowName}.flow.json5`)}`);
    console.log(JSON.stringify(provenance));
  } catch (e) {
    if (e instanceof Refusal) {
      console.log(`REFUSED: ${e.message}`);
      process.exit(2);
    }
    throw e;
  }
}
