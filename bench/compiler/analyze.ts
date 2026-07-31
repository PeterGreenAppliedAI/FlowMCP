// Runs the selected corpus scripts under fixture variants 0 and 1, records
// traces, and reports each script's SHAPE: collapsed call signature, dataflow
// edges (argument leaves found in earlier results), constants (stable across
// variants), and task-input candidates (constants matching task entities).
//
//   npx tsx bench/compiler/analyze.ts

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from '../../test/helpers.js';

const SELECTION = [
  'qwen2.5_7b-E1-brief_city-1.js',
  'mistral_7b_instruct-E1-brief_default-1.js',
  'llama3.1_8b-E2-brief_city-1.js',
  'qwen3.5_9b-E0-hn_now-1.js',
  'gemma4_12b-E1-hn_now-1.js',
  'gpt_oss_20b-E2-brief_default-1.js',
  'qwen3.6_35b-E1-brief_city-1.js',
  'deepseek_v4_flash-E0-brief_default-1.js',
  'deepseek_v4_flash-E2-hn_now-1.js',
  'qwen2.5_7b-E2-brief_default-1.js',
];

const INPUT_ENTITIES = ['Lisbon', 'New York'];

interface TraceEntry { seq: number; name: string; args: unknown; result: unknown }
interface Run { variant: number; result?: string; error?: string; trace: TraceEntry[] }

function leaves(value: unknown, path = '$'): Array<[string, unknown]> {
  if (value === null || typeof value !== 'object') return [[path, value]];
  const out: Array<[string, unknown]> = [];
  for (const [k, v] of Object.entries(value)) out.push(...leaves(v, `${path}.${k}`));
  return out;
}

function containsValue(haystack: unknown, needle: unknown): boolean {
  if (needle === null || needle === undefined || needle === '') return false;
  return leaves(haystack).some(([, v]) => v === needle);
}

function signature(trace: TraceEntry[]): string {
  const parts: string[] = [];
  for (const t of trace) {
    const last = parts[parts.length - 1];
    const m = last?.match(/^(.*)×(\d+)$/);
    if (last === t.name) parts[parts.length - 1] = `${t.name}×2`;
    else if (m && m[1] === t.name) parts[parts.length - 1] = `${t.name}×${Number(m[2]) + 1}`;
    else parts.push(t.name);
  }
  return parts.join(' → ');
}

const tracesDir = join(projectRoot, 'bench/compiler/traces');
mkdirSync(tracesDir, { recursive: true });
const report: string[] = ['# Trace shape report — 10-script compiler corpus sample', ''];

for (const script of SELECTION) {
  const path = join(projectRoot, 'bench/results/code-scripts', script);
  const runs: Run[] = [];
  for (const v of [0, 1]) {
    try {
      const out = execFileSync(process.execPath, ['--import', 'tsx', 'bench/compiler/trace-runner.ts', path, '--variant', String(v)], { cwd: projectRoot, timeout: 30_000 }).toString();
      runs.push(JSON.parse(out) as Run);
    } catch (e) {
      const stdout = (e as { stdout?: Buffer }).stdout?.toString() ?? '';
      try { runs.push(JSON.parse(stdout) as Run); } catch { runs.push({ variant: v, error: String(e).slice(0, 120), trace: [] }); }
    }
    writeFileSync(join(tracesDir, script.replace('.js', `.v${v}.json`)), JSON.stringify(runs[runs.length - 1], null, 1));
  }
  const [r0, r1] = runs as [Run, Run];
  report.push(`## ${script}`, '');
  if (r0.error || r1.error) {
    report.push(`- ERROR: v0=${r0.error ?? 'ok'} v1=${r1.error ?? 'ok'}`, '');
    continue;
  }
  report.push(`- signature: \`${signature(r0.trace)}\``);
  report.push(`- signatures identical across variants: ${signature(r0.trace) === signature(r1.trace)}`);

  // classify every argument leaf of v0 against earlier results + variant stability
  const classes: string[] = [];
  for (const t of r0.trace) {
    for (const [p, v] of leaves(t.args)) {
      const source = [...r0.trace.filter((u) => u.seq < t.seq)].reverse().find((u) => containsValue(u.result, v));
      const t1 = r1.trace.find((u) => u.seq === t.seq && u.name === t.name);
      const v1leaf = t1 ? leaves(t1.args).find(([p1]) => p1 === p)?.[1] : undefined;
      let cls: string;
      if (source) cls = `ref(#${source.seq} ${source.name})`;
      else if (v1leaf === v) cls = INPUT_ENTITIES.includes(String(v)) ? 'INPUT-CANDIDATE' : 'const';
      else cls = 'derived (changed, not verbatim in any prior result)';
      classes.push(`  - #${t.seq} ${t.name} \`${p}\` = ${JSON.stringify(v)} → ${cls}`);
    }
  }
  report.push('- argument classification:', ...classes);

  // does the final answer track the variant world? (hardcoding detector)
  const v1Expected = ['11.3', 'Item 9', 'Altland'];
  const tracked = v1Expected.filter((needle) => (r1.result ?? '').includes(needle));
  report.push(`- v1 output tracks variant world (${tracked.length ? tracked.join(', ') : 'NOTHING — hardcoded output?'})`, '');
}

writeFileSync(join(projectRoot, 'bench/compiler/shapes-report.md'), report.join('\n') + '\n');
console.log(report.join('\n'));
