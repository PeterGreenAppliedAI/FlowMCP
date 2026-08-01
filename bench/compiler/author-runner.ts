// Generalized sandbox runner for `author`: executes an untrusted generated
// script in this disposable child process, with a tools bridge backed by REAL
// downstream MCP servers (record mode) or by a cassette (replay mode).
// Discovery is read-only by construction: only tools advertising
// annotations.readOnlyHint are callable — allowlisted write tools are NOT
// callable during authoring.
//
//   record: npx tsx author-runner.ts <script.js> record <cassette.json> <serversDir>
//   replay: npx tsx author-runner.ts <script.js> replay <cassette.json> --variant 0|1

import { readFileSync, writeFileSync } from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { loadServers } from '../../src/loader.js';
import { interpolate } from '../../src/interpolate.js';

interface Rpc { id: number; result?: Record<string, unknown>; error?: { message?: string } }

class Client {
  private nextId = 1;
  private pending = new Map<number, (m: Rpc) => void>();
  private buffer = '';
  constructor(private child: ChildProcessWithoutNullStreams) {
    child.stdout.on('data', (c: Buffer) => {
      this.buffer += c.toString();
      let i: number;
      while ((i = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 1);
        if (!line.trim()) continue;
        try {
          const m = JSON.parse(line) as Rpc;
          this.pending.get(m.id)?.(m);
          this.pending.delete(m.id);
        } catch { /* downstream noise */ }
      }
    });
    child.stderr.on('data', () => {});
  }
  request(method: string, params: Record<string, unknown> = {}): Promise<Rpc> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout: ${method}`)), 30_000);
      this.pending.set(id, (m) => { clearTimeout(t); resolve(m); });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  kill(): void { this.child.kill(); }
}

interface ToolInfo { name: string; description?: string; annotations?: { readOnlyHint?: boolean } }

const [scriptPath, mode, cassettePath, serversDir] = [process.argv[2]!, process.argv[3]!, process.argv[4]!, process.argv[5]];
const variantIdx = Number(process.argv[process.argv.indexOf('--variant') + 1] || 0) || 0;
const code = readFileSync(scriptPath, 'utf8');

function mutate(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.startsWith('http')) return value + '/alt';
    return value.length >= 3 ? `ALT ${value}` : value;
  }
  if (Array.isArray(value)) return value.map(mutate);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mutate(v)]));
  }
  return value;
}

type Cassette = Record<string, unknown>;
const cassette: Cassette = mode === 'replay' ? (JSON.parse(readFileSync(cassettePath, 'utf8')) as Cassette) : {};
const key = (name: string, args: unknown) => `${name}|${JSON.stringify(args)}`;

interface TraceEntry { seq: number; name: string; args: unknown; result: unknown }
const trace: TraceEntry[] = [];
let seq = 0;
const clients: Client[] = [];

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
        return record(name, args, variantIdx === 1 ? mutate(hit) : hit);
      };
    }
    return tools;
  }
  const configs = await loadServers(serversDir!);
  for (const [serverName, config] of Object.entries(configs)) {
    const env: Record<string, string | undefined> = { PATH: process.env.PATH, HOME: process.env.HOME };
    for (const [k, v] of Object.entries(config.env)) env[k] = interpolate(v, { env: process.env });
    const child = spawn(config.command, config.args, { env, shell: config.shell });
    const client = new Client(child);
    clients.push(client);
    await client.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'flowmcp-author', version: '0' } });
    const listed = await client.request('tools/list');
    for (const t of (listed.result?.tools ?? []) as ToolInfo[]) {
      if (t.annotations?.readOnlyHint !== true) continue; // discovery is read-only, period
      if (tools[t.name]) throw new Error(`tool name collision across servers: ${t.name}`);
      process.stderr.write(`TOOLMAP ${t.name} ${serverName}\n`);
      tools[t.name] = async (args = {}) => {
        const res = await client.request('tools/call', { name: t.name, arguments: args });
        if (res.error) throw new Error(`${t.name}: ${res.error.message}`);
        const content = (res.result as { content?: Array<{ type: string; text?: string }>; isError?: boolean });
        const text = (content.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
        if (content.isError) throw new Error(`${t.name} error: ${text.slice(0, 200)}`);
        let parsed: unknown;
        try { parsed = JSON.parse(text); } catch { parsed = text; }
        cassette[key(t.name, args)] = parsed;
        return record(t.name, args, parsed);
      };
    }
  }
  return tools;
}

console.log = console.info = console.warn = ((...a: unknown[]) => process.stderr.write(a.map(String).join(' ') + '\n')) as typeof console.log;
const emit = (s: string) => process.stdout.write(s + '\n');

(async () => {
  const tools = await buildTools();
  const moduleStub = { exports: {} as Record<string, unknown> };
  const factory = new Function('module', 'exports', 'tools',
    `${code}\n;return typeof main === 'function' ? main : (typeof module.exports === 'function' ? module.exports : null);`);
  const main = factory(moduleStub, moduleStub.exports, tools) as null | ((t: typeof tools) => Promise<unknown>);
  if (!main) throw new Error('script did not define async function main(tools)');
  const result = await main(tools);
  if (mode === 'record') writeFileSync(cassettePath, JSON.stringify(cassette, null, 1));
  emit(JSON.stringify({ variant: mode === 'record' ? -1 : variantIdx, result: String(result), trace }, null, 1));
  clients.forEach((c) => c.kill());
  process.exit(0);
})().catch((e: unknown) => {
  emit(JSON.stringify({ variant: variantIdx, error: e instanceof Error ? e.message : String(e), trace }, null, 1));
  clients.forEach((c) => c.kill());
  process.exit(1);
});
