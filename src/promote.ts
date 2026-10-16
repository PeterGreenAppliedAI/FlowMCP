// `flowmcp promote` — put ONE downstream operation on the model's surface.
//
//   flowmcp promote <server> <tool> [--flows <dir>] [--name <flow_name>]
//     [--input <arg path> ...] [--pin <arg path>=<value> ...]
//     [--description "<WHEN TO USE: …>"] [--force]
//
// The output is an ordinary one-step flow file — reviewable data in the
// portable format, not a runtime passthrough. Everything the format demands
// still holds: at most 3 inputs (scalars only), a ≤300-char description,
// computed effects, and the two-phase gate for writes (a proposal is
// generated). Arguments beyond the inputs are pinned constants or omitted.
//
// Input selection: required scalar arguments (including required scalar
// fields of a request `body`) become inputs automatically; --input adds
// optional ones by path (e.g. `limit`, `body.name`). More than 3 required
// arguments refuses — pin some with --pin, or write a real flow.
//
// Fail-closed: the tool must already be admitted by servers.json5 (declared
// read, attested, or allow-listed). Promotion never widens what can execute.

import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadServers } from './loader.js';
import { createDownstreamClient, type DownstreamTool } from './downstream.js';
import { flowSchema } from './flow-schema.js';

type Json = Record<string, unknown>;
type Scalar = 'string' | 'number' | 'boolean';

export interface PromoteOptions {
  name?: string;
  inputs?: string[];
  pins?: Record<string, unknown>;
  description?: string;
}

export interface Promotion { flow: Json; inputs: string[]; write: boolean; warnings: string[] }

const scalarOf = (schema: Json | undefined): Scalar | undefined => {
  const t = schema?.type;
  if (t === 'string') return 'string';
  if (t === 'integer' || t === 'number') return 'number';
  if (t === 'boolean') return 'boolean';
  if (schema && !t && Array.isArray(schema.enum)) return 'string';
  return undefined;
};

/** Pure: derive the flow from a tool schema + policy. */
export function buildPromotion(
  server: string,
  tool: DownstreamTool,
  admitted: 'read' | 'write',
  opts: PromoteOptions = {},
): Promotion {
  const schema = (tool.inputSchema ?? {}) as Json;
  const props = (schema.properties ?? {}) as Record<string, Json>;
  const required = new Set((schema.required as string[] | undefined) ?? []);
  const pins = opts.pins ?? {};
  const warnings: string[] = [];

  const at = (path: string): { schema?: Json; required: boolean } => {
    const [head, ...rest] = path.split('.');
    let s: Json | undefined = props[head!];
    let req = required.has(head!);
    for (const part of rest) {
      const inner = (s?.properties ?? {}) as Record<string, Json>;
      req = req && ((s?.required as string[] | undefined) ?? []).includes(part);
      s = inner[part];
    }
    return { schema: s, required: req };
  };
  const pinned = (path: string) => Object.keys(pins).some((p) => p === path || path.startsWith(`${p}.`) || p.startsWith(`${path}.`));

  // required arguments, descending one level into an object-typed required arg
  const needed: string[] = [];
  for (const [k, s] of Object.entries(props)) {
    if (!required.has(k) || pinned(k)) continue;
    if (scalarOf(s)) needed.push(k);
    else if (s.type === 'object' || s.properties) {
      const innerReq = (s.required as string[] | undefined) ?? [];
      // nothing inside is required, yet the argument is: omitting it would
      // send a call the API rejects (or worse, interprets) — make it explicit
      if (!innerReq.length) throw new Error(`required argument '${k}' is not a scalar — pin it with --pin ${k}=<json>`);
      for (const ik of innerReq) {
        const path = `${k}.${ik}`;
        if (pinned(path)) continue;
        const inner = ((s.properties ?? {}) as Record<string, Json>)[ik];
        if (!scalarOf(inner)) throw new Error(`required argument '${path}' is not a scalar — pin it with --pin ${path}=<json>`);
        needed.push(path);
      }
    } else {
      throw new Error(`required argument '${k}' is not a scalar (${String(s.type ?? 'any')}) — pin it with --pin ${k}=<json>`);
    }
  }
  const inputs = [...needed];
  for (const extra of opts.inputs ?? []) {
    if (inputs.includes(extra)) continue;
    if (!at(extra).schema) throw new Error(`--input '${extra}' is not an argument of ${tool.name}`);
    if (!scalarOf(at(extra).schema)) throw new Error(`--input '${extra}' is not a scalar — only string/number/boolean can be flow inputs`);
    inputs.push(extra);
  }
  if (inputs.length > 3) {
    throw new Error(
      `${tool.name} needs ${inputs.length} inputs (${inputs.join(', ')}) — flows take at most 3. ` +
        `Pin the constant ones with --pin <arg>=<value>, or write a flow that derives them.`,
    );
  }

  // flow input names: last path segment, made identifier-safe and unique
  const names = new Map<string, string>();
  for (const path of inputs) {
    let n = path.split('.').pop()!.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^[^a-z]+/, '');
    if (!n || ['input', 'steps', 'env', 'confirm'].includes(n)) n = `arg_${n || inputs.indexOf(path)}`;
    while ([...names.values()].includes(n)) n = `${n}_2`;
    names.set(path, n);
  }

  const input: Json = {};
  for (const [path, n] of names) {
    const { schema: s, required: req } = at(path);
    const type = scalarOf(s)!;
    const enumNote = Array.isArray(s!.enum) ? ` One of: ${(s!.enum as unknown[]).join(', ')}.` : '';
    const desc = `${String(s!.description ?? path).replace(/\s+/g, ' ')}${enumNote}`.slice(0, 200);
    const param: Json = { type, description: desc || path, required: req };
    if (!req && s!.default !== undefined && typeof s!.default === type) param.default = s!.default;
    input[n] = param;
  }

  // args: pins first, then placeholders (a placeholder that is the whole
  // string keeps its type through interpolation)
  const args: Json = {};
  const setPath = (path: string, value: unknown) => {
    const parts = path.split('.');
    let cur = args;
    for (const p of parts.slice(0, -1)) cur = (cur[p] ??= {}) as Json;
    cur[parts.at(-1)!] = value;
  };
  for (const [path, value] of Object.entries(pins)) {
    if (!at(path).schema) warnings.push(`--pin '${path}' is not in ${tool.name}'s declared schema — sent anyway`);
    setPath(path, value);
  }
  for (const [path, n] of names) setPath(path, `{{input.${n}}}`);

  const flowName = opts.name ?? `${server}_${tool.name}`.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^[^a-z]+|_+$/g, '');
  const toolDesc = (tool.description ?? tool.name).replace(/\s+/g, ' ').trim();
  const description = (opts.description ?? `WHEN TO USE: ${toolDesc}`).slice(0, 300);
  if (!opts.description && toolDesc.length > 287) warnings.push('description truncated to 300 chars — consider --description');

  const write = admitted === 'write';
  const flow: Json = {
    name: flowName,
    description,
    input,
    steps: [{ id: 'result', kind: 'mcp_call', server, tool: tool.name, args }],
    output: '{{steps.result}}',
    ...(write
      ? { proposal: `About to call ${tool.name} on ${server}${names.size ? ` with ${[...names.values()].map((n) => `${n}={{input.${n}}}`).join(', ')}` : ''}.` }
      : {}),
  };
  const parsed = flowSchema.safeParse(flow);
  if (!parsed.success) {
    throw new Error(`generated flow is invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return { flow, inputs, write, warnings };
}

export async function promote(dir: string, server: string, toolName: string, opts: PromoteOptions = {}): Promise<Promotion> {
  const servers = await loadServers(dir);
  const config = servers[server];
  if (!config) throw new Error(`no server '${server}' in ${join(dir, 'servers.json5')}`);
  const client = createDownstreamClient(server, config.transport === 'http' ? config : { ...config, cwd: dir });
  const deadline = Date.now() + 30_000;
  let tool: DownstreamTool | undefined;
  try {
    await client.connect(deadline);
    tool = (await client.listTools(deadline)).find((t) => t.name === toolName);
  } finally {
    await Promise.resolve(client.close()).catch(() => {});
  }
  if (!tool) throw new Error(`server '${server}' has no tool '${toolName}' — run flowmcp discover to list them`);
  const declaredRead = tool.annotations?.readOnlyHint === true || config.attestReadOnly.includes(toolName);
  const allowed = config.allow.includes(toolName);
  if (!declaredRead && !allowed) {
    throw new Error(
      `'${toolName}' is not admitted on '${server}': it is not a declared read, not in attestReadOnly, and not in allow. ` +
        `Promotion never widens what can execute — review the tool and add it to servers.json5 first.`,
    );
  }
  return buildPromotion(server, tool, allowed ? 'write' : 'read', opts);
}

export function renderFlow(p: Promotion, server: string, tool: string): string {
  const header = [
    `// Promoted from ${server}.${tool} by \`flowmcp promote\` — review before serving.`,
    p.write ? '// WRITE: runs only after two-phase confirmation (see proposal).' : '// Read-only.',
    ...p.warnings.map((w) => `// note: ${w}`),
  ];
  return `${header.join('\n')}\n${JSON.stringify(p.flow, null, 2)}\n`;
}

function values(argv: string[], name: string): string[] {
  const out: string[] = [];
  argv.forEach((a, i) => { if (a === name && argv[i + 1] !== undefined) out.push(argv[i + 1]!); });
  return out;
}

export async function promoteCli(): Promise<void> {
  const argv = process.argv.slice(2);
  const valued = new Set(['--flows', '--name', '--input', '--pin', '--description']);
  const positional = argv.filter((a, i) => !a.startsWith('--') && !valued.has(argv[i - 1] ?? ''));
  const [server, tool] = positional;
  if (!server || !tool) {
    process.stderr.write(
      'usage: flowmcp promote <server> <tool> [--flows <dir>] [--name <flow_name>] [--input <arg> ...]\n' +
        '         [--pin <arg>=<json|text> ...] [--description "<WHEN TO USE: …>"] [--force]\n',
    );
    process.exit(1);
  }
  const dir = resolve(values(argv, '--flows')[0] ?? process.env.FLOWMCP_FLOWS_DIR ?? 'flows');
  const pins: Record<string, unknown> = {};
  for (const kv of values(argv, '--pin')) {
    const i = kv.indexOf('=');
    if (i <= 0) throw new Error(`--pin must be <arg>=<value>, got '${kv}'`);
    const raw = kv.slice(i + 1);
    let v: unknown = raw;
    try { v = JSON.parse(raw); } catch { /* plain text */ }
    pins[kv.slice(0, i)] = v;
  }
  const p = await promote(dir, server, tool, {
    name: values(argv, '--name')[0],
    inputs: values(argv, '--input'),
    pins,
    description: values(argv, '--description')[0],
  });
  const file = join(dir, `${p.flow.name as string}.flow.json5`);
  if (existsSync(file) && !argv.includes('--force')) throw new Error(`${file} exists — pass --force to overwrite`);
  writeFileSync(file, renderFlow(p, server, tool));
  process.stderr.write(`flowmcp: wrote ${file} (${p.write ? 'write, confirmation-gated' : 'read-only'}; inputs: ${p.inputs.join(', ') || 'none'})\n`);
  for (const w of p.warnings) process.stderr.write(`flowmcp: note: ${w}\n`);
}
