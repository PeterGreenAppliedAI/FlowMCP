// `flowmcp author` — the one-command authoring loop.
//
//   flowmcp author --servers-dir <dir containing servers.json5> \
//     --name <flow_name> --model <model id> [--gateway <openai-compatible URL>] \
//     [--input name=value] [--probe 'tool:{"q":"test"}'] [--out <dir>] \
//     "<intent — what the flow should do>"
//
// Pipeline: introspect connected MCP servers (read-only tools only) → build a
// truthful tool doc (explicit probes supply example returns) → a model writes
// main(tools, input) → one sandboxed record run per input set against the REAL
// servers (cassette) → repair loop fed with the actually-recorded results on
// failure → replay v0/v1 → compile to a candidate flow with provenance →
// --validate. `--input repo=a,b` gives two input sets; a call that is "not
// found" for one of them becomes an `absent` step with a branch. Review remains
// human. The model endpoint comes from --gateway or the GATEWAY env var —
// there is no default endpoint or model; your infrastructure is yours to name.

import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, copyFileSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadServers } from './loader.js';
import { createDownstreamClient } from './downstream.js';
import { compilePaths, type Path } from './compile.js';

// Sibling scripts must be spawnable both in dev (tsx over .ts) and from the
// compiled package (plain node over dist/*.js).
const IS_TS = import.meta.url.endsWith('.ts');
const sibling = (name: string): string => fileURLToPath(new URL(`./${name}.${IS_TS ? 'ts' : 'js'}`, import.meta.url));
const nodeArgs = (script: string): string[] => (IS_TS ? ['--import', 'tsx', script] : [script]);

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
function flags(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => { if (a === name && process.argv[i + 1]) out.push(process.argv[i + 1]!); });
  return out;
}

// The compiled flow is a fixed template over tool values, so the script may
// only interpolate them. Told to the model up front and again on failure.
const TEMPLATE_RULES =
  'The script is compiled into a fixed template: put each tool value into the output exactly as the tool returned it. ' +
  'Do not reformat values (no toLocaleString, no Date parsing or slicing, no rounding or arithmetic) and do not sort or ' +
  'filter results in code — use the tools\' own parameters (sort, state, per_page) for that.';

interface ToolDoc { name: string; server: string; description: string; params: string[]; example?: string }
interface RunOut { variant: number; result?: string; error?: string; trace: Array<{ seq: number; name: string; args: unknown; result: unknown; error?: { kind: string; status?: number; text: string } }> }

export async function authorCli(): Promise<void> {
  const gateway = flag('--gateway') ?? process.env.GATEWAY;
  const model = flag('--model');
  const serversDirFlag = flag('--servers-dir');
  const intent = process.argv[process.argv.length - 1]!;
  if (!gateway || !model || !serversDirFlag || intent.startsWith('--')) {
    console.error(
      'usage: flowmcp author --servers-dir <dir> --name <flow_name> --model <model id>\n' +
        '         [--gateway <openai-compatible base URL>] [--input name=value]\n' +
        "         [--probe 'tool:{\"q\":\"test\"}'] [--out <dir>] \"<intent>\"\n" +
        'The model endpoint comes from --gateway or the GATEWAY env var.',
    );
    process.exit(1);
  }
  const serversDir = resolve(serversDirFlag);
  const flowName = flag('--name') ?? 'authored_flow';
  const outDir = resolve(flag('--out') ?? join('authored', flowName));
  const inputHints: Record<string, string[]> = {};
  for (const kv of flags('--input')) {
    const [k, v] = kv.split('=', 2);
    inputHints[k!] = v!.split(',');
  }
  // input sets, zipped by position; a single value is shared by every set
  const setCount = Math.max(1, ...Object.values(inputHints).map((v) => v.length));
  for (const [k, v] of Object.entries(inputHints)) {
    if (v.length !== 1 && v.length !== setCount) throw new Error(`--input ${k} has ${v.length} values; give 1 or ${setCount}`);
  }
  const inputSets = Array.from({ length: setCount }, (_, i) =>
    Object.fromEntries(Object.entries(inputHints).map(([k, v]) => [k, v.length === 1 ? v[0]! : v[i]!])));
  const probes: Array<{ tool: string; args: Record<string, unknown> }> = flags('--probe').map((p) => {
    const idx = p.indexOf(':');
    return { tool: p.slice(0, idx), args: JSON.parse(p.slice(idx + 1)) as Record<string, unknown> };
  });

  // ---- introspection via the shared DownstreamClient (read-only tools only) ----
  async function introspect(): Promise<ToolDoc[]> {
    const configs = await loadServers(serversDir);
    const docs: ToolDoc[] = [];
    const dl = () => Date.now() + 30_000;
    for (const [serverName, config] of Object.entries(configs)) {
      const client = createDownstreamClient(serverName, config.transport === 'http' ? config : { ...config, cwd: serversDir });
      // failure-path cleanup: a failed probe or paginated list must not
      // strand the connection (HTTP sessions terminate in close())
      try {
        await client.connect(dl());
        const listed = await client.listTools(dl());
        for (const t of listed) {
          if (t.annotations?.readOnlyHint !== true && !config.attestReadOnly.includes(t.name)) continue;
          const doc: ToolDoc = {
            name: t.name,
            server: serverName,
            description: t.description ?? '',
            params: Object.keys((t.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}),
          };
          const probe = probes.find((p) => p.tool === t.name);
          if (probe) {
            const res = await client.callTool(t.name, probe.args, dl());
            const text = (res.content ?? []).map((c) => c.text ?? '').join('');
            doc.example = text.slice(0, 400);
          }
          docs.push(doc);
        }
      } finally {
        await Promise.resolve(client.close()).catch(() => {});
      }
    }
    return docs;
  }

  async function chat(messages: Array<{ role: string; content: string }>): Promise<{ text: string; tokens: number }> {
    const res = await fetch(`${gateway}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages, temperature: 0, max_tokens: 2048 }),
      signal: AbortSignal.timeout(240_000),
    });
    if (!res.ok) throw new Error(`gateway HTTP ${res.status}`);
    const d = (await res.json()) as { choices: [{ message: { content: string | null } }]; usage?: { prompt_tokens: number; completion_tokens: number } };
    return { text: d.choices[0].message.content ?? '', tokens: (d.usage?.prompt_tokens ?? 0) + (d.usage?.completion_tokens ?? 0) };
  }

  function extractCode(text: string): string | null {
    const fence = /```(?:javascript|js)?\s*\n([\s\S]*?)```/.exec(text);
    const code = (fence ? fence[1]! : text).replace(/^```(?:javascript|js)?\s*$/gm, '');
    return /function\s+main|main\s*=/.test(code) ? code : null;
  }

  function runChild(scriptPath: string, mode: string, cassettePath: string, extra: string[] = []): { out: RunOut; toolMap: Record<string, string> } {
    const proc = spawnSync(process.execPath,
      [...nodeArgs(sibling('author-runner')), scriptPath, mode, cassettePath, serversDir, ...extra],
      { timeout: 120_000 });
    const stdout = proc.stdout?.toString() ?? '';
    const stderr = proc.stderr?.toString() ?? '';
    const toolMap: Record<string, string> = {};
    for (const m of stderr.matchAll(/^TOOLMAP (\S+) (\S+)$/gm)) toolMap[m[1]!] = m[2]!;
    try {
      return { out: JSON.parse(stdout) as RunOut, toolMap };
    } catch {
      return { out: { variant: -1, error: (stderr || stdout || 'no output').slice(0, 300), trace: [] }, toolMap };
    }
  }

  console.error(`[author] introspecting servers in ${serversDir} ...`);
  const docs = await introspect();
  if (!docs.length) throw new Error('no read-only tools found on the configured servers');
  const docText = docs.map((d) =>
    `tools.${d.name}({${d.params.join(', ')}}) — ${d.description} [server: ${d.server}]` +
    (d.example ? `\n  returns e.g. ${d.example}` : '')).join('\n');
  console.error(`[author] ${docs.length} read-only tool(s) available`);

  const inputDoc = Object.keys(inputHints).length
    ? `\`input\` holds the task's inputs: ${Object.entries(inputHints).map(([k, v]) => `input.${k} (e.g. ${JSON.stringify(v[0])})`).join(', ')}. Use them; never write their values into the script.\n` +
      (setCount > 1 ? 'The script runs once per input set. A tool call that fails with a not-found error for some inputs (a repo with no releases) throws; catch it and print a short fixed line in that section instead, e.g. "- No published release".\n' : '')
    : '';
  const system =
    'You write a Node.js program to complete the task.\n' +
    'Reply with ONLY JavaScript code defining `async function main(tools, input)`.\n' +
    '`tools` functions are async, take one object argument, return parsed JSON.\n' +
    inputDoc +
    'main must RETURN the final answer as a markdown string built from the retrieved data.\n' +
    'No imports, no network, no filesystem — only the provided tools.\n' + TEMPLATE_RULES + '\n\nAvailable tools:\n' + docText;
  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: system },
    { role: 'user', content: intent },
  ];

  mkdirSync(outDir, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'flowmcp-author-'));
  const cassettePath = join(outDir, 'cassette.json');
  let modelTokens = 0;
  let record: RunOut | null = null;
  let compiled: Awaited<ReturnType<typeof compilePaths>> | null = null;
  let toolMap: Record<string, string> = {};
  let script = '';

  for (let attempt = 1; attempt <= 3; attempt++) {
    console.error(`[author] generation attempt ${attempt} (${model}) ...`);
    const gen = await chat(messages);
    modelTokens += gen.tokens;
    const code = extractCode(gen.text);
    if (!code) {
      messages.push({ role: 'assistant', content: gen.text }, { role: 'user', content: 'Reply with ONLY the JavaScript defining async function main(tools).' });
      continue;
    }
    script = code;
    const scriptPath = join(work, `attempt-${attempt}.js`);
    writeFileSync(scriptPath, code);
    let failure = '';
    let evidence = '';
    const paths: Path[] = [];
    const records: RunOut[] = [];
    for (const [i, input] of inputSets.entries()) {
      const cassette = i === 0 ? cassettePath : join(outDir, `cassette-${i}.json`);
      const inputArgs = ['--input', JSON.stringify(input)];
      const r = runChild(scriptPath, 'record', cassette, inputArgs);
      toolMap = { ...toolMap, ...r.toolMap };
      const on = setCount > 1 ? ` for input ${JSON.stringify(input)}` : '';
      if (r.out.error) {
        failure = `Execution failed${on}: ${r.out.error}`;
        evidence = r.out.trace.slice(0, 3).map((t) => `${t.name}(${JSON.stringify(t.args)}) returned: ${JSON.stringify(t.error ?? t.result).slice(0, 300)}`).join('\n');
        break;
      }
      // A script that runs live must also replay against altered tool data and
      // compile to a fixed template. Reformatting a value (toLocaleString, Date
      // slicing) or a literal that coincides with tool data fails here; the
      // model gets the reason back instead of the run ending.
      const v0 = runChild(scriptPath, 'replay', cassette, ['--variant', '0', ...inputArgs]).out;
      const v1 = runChild(scriptPath, 'replay', cassette, ['--variant', '1', ...inputArgs]).out;
      if (v0.error || v1.error) { failure = `Replaying the script${on} against altered tool data failed: ${v0.error ?? v1.error}`; break; }
      paths.push({ input, v0: v0 as never, v1: v1 as never });
      records.push(r.out);
    }
    if (!failure) {
      try {
        compiled = await compilePaths(paths, flowName, 'authored from intent',
          { server: toolMap, inputHints, description: `WHEN TO USE: ${intent}` });
        record = records[0]!;
        break;
      } catch (e) {
        failure = `The script ran, but could not be compiled into a fixed flow: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    console.error(`[author] attempt ${attempt}: ${failure}`);
    messages.push({ role: 'assistant', content: gen.text },
      { role: 'user', content: `${failure}\n${evidence ? `Actual tool results recorded:\n${evidence}\n` : ''}${TEMPLATE_RULES}\nReply with ONLY the corrected script.` });
  }
  if (!record || !compiled) throw new Error('authoring failed after 3 attempts');
  console.error(`[author] recorded ${record.trace.length} real tool call(s); model spend ${modelTokens} tokens`);
  const { flow, provenance } = compiled;
  // The traces show only the paths the recordings took. A script that catches
  // a tool error no input set triggered has a fallback the flow lacks: there
  // the flow fails instead. Give an input that hits it (--input repo=a,b).
  if (/\bcatch\b|\.catch\(/.test(script) && !(provenance.absent as unknown[] | undefined)?.length) {
    const w = 'the script handles tool errors (try/catch), but no input set triggered one, so the compiled flow has no fallback — add an input where a step 404s (--input repo=a,b)';
    (provenance.warnings as string[] | undefined)?.push(w);
    console.error(`[author] warning: ${w}`);
  }

  writeFileSync(join(outDir, 'source-script.js'), script);
  writeFileSync(join(outDir, `${flowName}.flow.json5`), flow);
  writeFileSync(join(outDir, `${flowName}.provenance.json`), JSON.stringify({ ...provenance, intent, model, modelTokens, toolMap }, null, 2));
  copyFileSync(join(serversDir, 'servers.json5'), join(outDir, 'servers.json5'));

  execFileSync(process.execPath, [...nodeArgs(sibling('server')), '--flows', outDir, '--validate'],
    { env: { ...process.env }, timeout: 60_000 });
  console.error(`[author] candidate written to ${outDir} (validated)`);
  console.log(flow);
}

if (process.argv[1]?.endsWith('author.ts') || process.argv[1]?.endsWith('author.js')) {
  authorCli().catch((e) => { console.error(`AUTHOR FAILED: ${e instanceof Error ? e.message : e}`); process.exit(1); });
}
