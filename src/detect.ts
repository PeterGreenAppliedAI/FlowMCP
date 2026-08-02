// The detection layer: reads an execution log (see DETECTION.md), clusters
// runs by tool-call shape signature, scores clusters by frequency × cost ×
// success, and nominates procedures worth compiling — with input candidates
// derived from cross-run argument variance (repetition IS the evidence).
//
//   flowmcp detect <executions.jsonl>
//     [--min-runs 3] [--min-success 0.8] [--min-tokens 2000]

import { readFileSync } from 'node:fs';

interface Call { name: string; args: unknown }
interface Execution { id: string; task: string; agent: string; success: boolean; tokens: number; calls: Call[] }

function leaves(value: unknown, path = ''): Array<[string, unknown]> {
  if (value === null || typeof value !== 'object') return [[path, value]];
  const out: Array<[string, unknown]> = [];
  for (const [k, v] of Object.entries(value)) out.push(...leaves(v, path ? `${path}.${k}` : k));
  return out;
}

function signature(calls: Call[]): string {
  const parts: string[] = [];
  for (const c of calls) {
    const last = parts[parts.length - 1];
    const m = last?.match(/^(.*)×(\d+)$/);
    if (last === c.name) parts[parts.length - 1] = `${c.name}×2`;
    else if (m && m[1] === c.name) parts[parts.length - 1] = `${c.name}×${Number(m[2]) + 1}`;
    else parts.push(c.name);
  }
  return parts.join(' → ');
}

// CLI — exported for the `flowmcp detect` subcommand; the entry guard at the
// bottom covers direct execution.
export function detectCli(): void {
const arg = (flag: string, dflt: number) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? Number(process.argv[i + 1]) : dflt;
};
const MIN_RUNS = arg('--min-runs', 3);
const MIN_SUCCESS = arg('--min-success', 0.8);
const MIN_TOKENS = arg('--min-tokens', 2000);

if (!process.argv[2]) {
  console.error('usage: flowmcp detect <executions.jsonl> [--min-runs N] [--min-success R] [--min-tokens N]');
  process.exit(1);
}
const executions: Execution[] = readFileSync(process.argv[2]!, 'utf8')
  .trim().split('\n').map((l) => JSON.parse(l) as Execution);

const clusters = new Map<string, Execution[]>();
for (const e of executions) {
  const sig = signature(e.calls);
  if (!clusters.has(sig)) clusters.set(sig, []);
  clusters.get(sig)!.push(e);
}

interface Nomination {
  signature: string;
  runs: number;
  successRate: number;
  avgTokens: number;
  spendToDate: number;
  tasks: string[];
  agents: string[];
  constants: Record<string, unknown>;
  inputCandidates: Record<string, unknown[]>;
  sampleRuns: string[];
}

const nominations: Nomination[] = [];
for (const [sig, runs] of clusters) {
  const successes = runs.filter((r) => r.success);
  const successRate = successes.length / runs.length;
  const avgTokens = runs.reduce((s, r) => s + r.tokens, 0) / runs.length;
  if (runs.length < MIN_RUNS || successRate < MIN_SUCCESS || avgTokens < MIN_TOKENS) continue;

  // input discovery across SUCCESSFUL runs: per call-index arg leaf,
  // all-equal → constant, varying → input candidate with observed values
  const constants: Record<string, unknown> = {};
  const inputCandidates: Record<string, unknown[]> = {};
  const callCount = successes[0]!.calls.length;
  if (successes.every((r) => r.calls.length === callCount)) {
    for (let i = 0; i < callCount; i++) {
      const name = successes[0]!.calls[i]!.name;
      const paths = new Set(successes.flatMap((r) => leaves(r.calls[i]!.args).map(([p]) => p)));
      for (const p of paths) {
        const values = successes.map((r) => leaves(r.calls[i]!.args).find(([p1]) => p1 === p)?.[1]);
        const distinct = [...new Set(values.map((v) => (v === undefined ? '"<absent>"' : JSON.stringify(v))))];
        const key = `call[${i}] ${name} ${p || '(bare)'}`;
        if (distinct.length === 1) constants[key] = values[0];
        else inputCandidates[key] = distinct.map((d) => JSON.parse(d) as unknown);
      }
    }
  }

  nominations.push({
    signature: sig,
    runs: runs.length,
    successRate: Math.round(successRate * 100) / 100,
    avgTokens: Math.round(avgTokens),
    spendToDate: runs.reduce((s, r) => s + r.tokens, 0),
    tasks: [...new Set(runs.map((r) => r.task))],
    agents: [...new Set(runs.map((r) => r.agent))],
    constants,
    inputCandidates,
    sampleRuns: successes.slice(0, 3).map((r) => r.id),
  });
}

nominations.sort((a, b) => b.spendToDate - a.spendToDate);
console.log(JSON.stringify({
  scanned: executions.length,
  clusters: clusters.size,
  nominations,
}, null, 2));
console.error(`\n${nominations.length} nomination(s) from ${executions.length} executions in ${clusters.size} clusters`);
for (const n of nominations) {
  console.error(`- [${n.runs} runs, ${Math.round(n.successRate * 100)}% ok, ~${n.avgTokens} tok/run, ${n.spendToDate} spent] ${n.signature}`);
  for (const [k, v] of Object.entries(n.inputCandidates)) console.error(`    input? ${k} — observed: ${JSON.stringify(v)}`);
}
}

if (process.argv[1]?.endsWith('detect.ts') || process.argv[1]?.endsWith('detect.js')) {
  detectCli();
}
