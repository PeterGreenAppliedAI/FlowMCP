// Converts the committed benchmark transcripts (waves 4-5) into the detection
// execution-log format: one line per run, with the ordered tool-call sequence,
// success flag, and token cost joined from the results files.
//
//   npx tsx bench/compiler/extract-executions.ts > bench/compiler/executions.jsonl

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from '../../test/helpers.js';

interface ToolCall { function: { name: string; arguments: string } }
interface Transcript { model: string; condition: string; task: string; trial: number; messages: Array<{ role: string; tool_calls?: ToolCall[] }> }
interface Result { model: string; condition: string; task: string; trial: number; success: boolean; promptTokens: number; completionTokens: number }

const dir = join(projectRoot, 'bench/results');
const TRANSCRIPT_FILES = ['transcripts-2026-07-31T18-13-43.json', 'transcripts-2026-07-31T18-19-44.json', 'transcripts-2026-07-31T18-59-04.json'];
const RESULT_FILES = ['results-2026-07-31T18-13-43.json', 'results-2026-07-31T18-19-44.json', 'results-2026-07-31T18-59-04.json'];

const results: Result[] = RESULT_FILES.flatMap((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Result[]);
const lookup = new Map(results.map((r) => [`${r.model}|${r.condition}|${r.task}|${r.trial}`, r]));

let n = 0;
for (const f of TRANSCRIPT_FILES) {
  const transcripts = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Transcript[];
  for (const t of transcripts) {
    const r = lookup.get(`${t.model}|${t.condition}|${t.task}|${t.trial}`);
    if (!r) continue;
    const calls: Array<{ name: string; args: unknown }> = [];
    for (const m of t.messages) {
      for (const c of m.tool_calls ?? []) {
        let args: unknown = {};
        try { args = JSON.parse(c.function.arguments || '{}'); } catch { /* keep {} */ }
        calls.push({ name: c.function.name, args });
      }
    }
    if (calls.length === 0) continue;
    n++;
    console.log(JSON.stringify({
      id: `${t.model.split('/').pop()}-${t.condition}-${t.task}-${t.trial}`,
      task: t.task,
      agent: `${t.model.split('/').pop()} (${t.condition})`,
      success: r.success,
      tokens: r.promptTokens + r.completionTokens,
      calls,
    }));
  }
}
console.error(`extracted ${n} executions`);
