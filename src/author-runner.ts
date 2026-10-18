// Broker for `author`: owns the tools bridge, backed by REAL downstream MCP
// servers (record mode) or by a cassette (replay mode), and runs the
// untrusted generated script through runSandboxed (src/sandbox.ts) — a
// separate, permission-restricted, empty-environment child in which the
// script holds only tool NAMES. This process (connections, credentials) is
// never where model-generated code executes.
// Discovery is read-only by construction: only tools advertising
// annotations.readOnlyHint are callable — allowlisted write tools are NOT
// callable during authoring.
//
//   record: npx tsx author-runner.ts <script.js> record <cassette.json> <serversDir>
//   replay: npx tsx author-runner.ts <script.js> replay <cassette.json> --variant 0|1

import { readFileSync, writeFileSync } from 'node:fs';
import { loadServers } from './loader.js';
import { createDownstreamClient, type DownstreamClient } from './downstream.js';
import { runSandboxed } from './sandbox.js';

interface ToolInfo { name: string; description?: string; annotations?: { readOnlyHint?: boolean } }

const [scriptPath, mode, cassettePath, serversDir] = [process.argv[2]!, process.argv[3]!, process.argv[4]!, process.argv[5]];
const variantIdx = Number(process.argv[process.argv.indexOf('--variant') + 1] || 0) || 0;
const code = readFileSync(scriptPath, 'utf8');

// Variant 1's altered data. Each string is tagged by where it sits (tool +
// path), so two fields that hold the same value live — a release's
// published_at and updated_at — differ here, and the replayed output shows
// which one the script actually read.
function mutate(value: unknown, at: string): unknown {
  if (typeof value === 'string') {
    let h = 5381;
    for (let i = 0; i < at.length; i++) h = ((h * 33) ^ at.charCodeAt(i)) >>> 0;
    const tag = (h % 46656).toString(36).padStart(3, '0');
    if (value.startsWith('http')) return `${value}/alt${tag}`;
    return value.length >= 3 ? `ALT${tag} ${value}` : value;
  }
  if (Array.isArray(value)) return value.map((v, i) => mutate(v, `${at}.${i}`));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mutate(v, `${at}.${k}`)]));
  }
  return value;
}

type Cassette = Record<string, unknown>;
const cassette: Cassette = mode === 'replay' ? (JSON.parse(readFileSync(cassettePath, 'utf8')) as Cassette) : {};
const key = (name: string, args: unknown) => `${name}|${JSON.stringify(args)}`;

interface TraceEntry { seq: number; name: string; args: unknown; result: unknown }
const trace: TraceEntry[] = [];
let seq = 0;
const clients: DownstreamClient[] = [];

async function buildTools(): Promise<Record<string, (args?: Record<string, unknown>) => Promise<unknown>>> {
  const tools: Record<string, (args?: Record<string, unknown>) => Promise<unknown>> = {};
  const record = (name: string, args: unknown, result: unknown) => {
    if (trace.length > 40) throw new Error('trace call limit exceeded');
    trace.push({ seq: seq++, name, args: JSON.parse(JSON.stringify(args ?? {})), result });
    return result;
  };
  if (mode === 'replay') {
    // any tool named in the cassette becomes available; no live connections
    const names = new Set([...Object.keys(cassette)].map((k) => k.split('|')[0]!));
    for (const name of names) {
      tools[name] = async (args = {}) => {
        const hit = cassette[key(name, args)];
        if (hit === undefined) throw new Error(`cassette miss: ${key(name, args)}`);
        return record(name, args, variantIdx === 1 ? mutate(hit, name) : hit);
      };
    }
    return tools;
  }
  const configs = await loadServers(serversDir!);
  const dl = () => Date.now() + 30_000;
  for (const [serverName, config] of Object.entries(configs)) {
    const client = createDownstreamClient(serverName, config.transport === 'http' ? config : { ...config, cwd: serversDir! });
    clients.push(client);
    await client.connect(dl());
    const listed = await client.listTools(dl());
    for (const t of listed) {
      // discovery is read-only: annotated OR operator-attested; never allow-listed writes
      if (t.annotations?.readOnlyHint !== true && !config.attestReadOnly.includes(t.name)) continue;
      if (tools[t.name]) throw new Error(`tool name collision across servers: ${t.name}`);
      process.stderr.write(`TOOLMAP ${t.name} ${serverName}\n`);
      tools[t.name] = async (args = {}) => {
        const res = await client.callTool(t.name, args, dl());
        const text = (res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
        if (res.isError) throw new Error(`${t.name} error: ${text.slice(0, 200)}`);
        let parsed: unknown;
        if (res.structuredContent !== undefined) parsed = res.structuredContent;
        else { try { parsed = JSON.parse(text); } catch { parsed = text; } }
        cassette[key(t.name, args)] = parsed;
        return record(t.name, args, parsed);
      };
    }
  }
  return tools;
}

console.log = console.info = console.warn = ((...a: unknown[]) => process.stderr.write(a.map(String).join(' ') + '\n')) as typeof console.log;
const emit = (s: string) => process.stdout.write(s + '\n');

// close() can be async (HTTP session termination) — await it on BOTH exit
// paths, or process.exit kills the DELETE in flight and strands sessions.
const closeClients = () => Promise.all(clients.map((c) => Promise.resolve(c.close()).catch(() => {})));

(async () => {
  const tools = await buildTools();
  const result = await runSandboxed(code, Object.keys(tools), (name, args) => tools[name]!(args), {
    timeoutMs: 55_000,
    onLog: (line) => process.stderr.write(`[script] ${line}\n`),
  });
  if (mode === 'record') writeFileSync(cassettePath, JSON.stringify(cassette, null, 1));
  emit(JSON.stringify({ variant: mode === 'record' ? -1 : variantIdx, result: String(result), trace }, null, 1));
  await closeClients();
  process.exit(0);
})().catch(async (e: unknown) => {
  emit(JSON.stringify({ variant: variantIdx, error: e instanceof Error ? e.message : String(e), trace }, null, 1));
  await closeClients();
  process.exit(1);
});
