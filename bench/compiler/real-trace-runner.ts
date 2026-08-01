// Real-world trace runner with cassette record/replay — the dogfood
// counterpart of trace-runner.ts. Live APIs are nondeterministic, so variant
// differencing can't run against them directly. Instead:
//
//   record : execute the script against the REAL tool bridge (SearXNG), save
//            every (tool, args) -> result pair as a cassette + the trace
//   replay : execute against the cassette (variant 0) or a systematically
//            mutated cassette (variant 1) — deterministic evidence for the
//            compiler, grounded in real captured data
//
//   npx tsx bench/compiler/real-trace-runner.ts <script.js> record <cassette.json>
//   npx tsx bench/compiler/real-trace-runner.ts <script.js> replay <cassette.json> [--variant 0|1]
//
// Env: SEARXNG_URL (record mode)

import { readFileSync, writeFileSync } from 'node:fs';

const SEARXNG_URL = process.env.SEARXNG_URL ?? (() => { throw new Error('SEARXNG_URL env var is required'); })();

interface SearxResult { title: string; url: string; snippet: string; engine?: string }

async function realSearxngSearch(args: Record<string, unknown>): Promise<{ query: string; results: SearxResult[] }> {
  const q = String(args.q ?? args.query ?? '');
  const timeRange = String(args.time_range ?? 'week');
  const url = `${SEARXNG_URL}/search?q=${encodeURIComponent(q)}&format=json&time_range=${encodeURIComponent(timeRange)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`searxng HTTP ${res.status}`);
  const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string; engine?: string }> };
  return {
    query: q,
    results: (data.results ?? []).slice(0, 8).map((r) => ({
      title: r.title ?? '', url: r.url ?? '', snippet: (r.content ?? '').slice(0, 300), engine: r.engine,
    })),
  };
}

// Systematic mutation for variant 1: every string leaf gets a marker suffix on
// its first word, urls get a path suffix — value identity changes everywhere
// while structure is preserved.
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

const [scriptPath, mode, cassettePath] = [process.argv[2]!, process.argv[3]!, process.argv[4]!];
const variantIdx = Number(process.argv[process.argv.indexOf('--variant') + 1] || 0) || 0;
const code = readFileSync(scriptPath, 'utf8');

type Cassette = Record<string, unknown>;
const cassette: Cassette = mode === 'replay' ? (JSON.parse(readFileSync(cassettePath, 'utf8')) as Cassette) : {};
const key = (name: string, args: unknown) => `${name}|${JSON.stringify(args)}`;

interface TraceEntry { seq: number; name: string; args: unknown; result: unknown }
const trace: TraceEntry[] = [];
let seq = 0;

const REAL: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
  searxng_search: realSearxngSearch,
};

const tools: Record<string, (args?: Record<string, unknown>) => Promise<unknown>> = {};
for (const name of Object.keys(REAL)) {
  tools[name] = async (args = {}) => {
    if (trace.length > 30) throw new Error('trace call limit exceeded');
    let result: unknown;
    if (mode === 'record') {
      result = await REAL[name]!(args);
      cassette[key(name, args)] = result;
    } else {
      const hit = cassette[key(name, args)];
      if (hit === undefined) throw new Error(`cassette miss: ${key(name, args)}`);
      result = variantIdx === 1 ? mutate(hit) : hit;
    }
    trace.push({ seq: seq++, name, args: JSON.parse(JSON.stringify(args)), result });
    return result;
  };
}

console.log = console.info = console.warn = ((...a: unknown[]) => process.stderr.write(a.map(String).join(' ') + '\n')) as typeof console.log;
const emit = (s: string) => process.stdout.write(s + '\n');

(async () => {
  const moduleStub = { exports: {} as Record<string, unknown> };
  const factory = new Function('module', 'exports', 'tools',
    `${code}\n;return typeof main === 'function' ? main : (typeof module.exports === 'function' ? module.exports : null);`);
  const main = factory(moduleStub, moduleStub.exports, tools) as null | ((t: typeof tools) => Promise<unknown>);
  if (!main) throw new Error('no main(tools)');
  const result = await main(tools);
  if (mode === 'record') writeFileSync(cassettePath, JSON.stringify(cassette, null, 1));
  emit(JSON.stringify({ variant: mode === 'record' ? -1 : variantIdx, result: String(result), trace }, null, 1));
})().catch((e: unknown) => {
  emit(JSON.stringify({ variant: variantIdx, error: e instanceof Error ? e.message : String(e), trace }, null, 1));
  process.exit(1);
});
