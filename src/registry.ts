// The flow registry: promotion states, provenance, and run-health tracking.
//
// registry.json5 (beside the flow files) is operator-trusted configuration —
// hand-edited, reviewed like code. Its PRESENCE opts the directory into
// promotion governance: every flow file must be listed, and only 'active'
// flows are served. Absent file = no registry = every valid flow serves
// (the pre-registry behavior).
//
// registry-log.jsonl (same directory) is the machine side: append-only JSONL,
// one record per event. FlowMCP appends 'run' records; EXTERNAL emitters
// (e.g. a consumer's editorial gap-check, a shadow-replay harness) append
// 'signal' and 'shadow' records to the same file. Malformed lines are skipped
// with a count, never fatal — an emitter bug must not take down status
// reporting.

import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import JSON5 from 'json5';
import { z } from 'zod';

export const REGISTRY_FILE = 'registry.json5';
export const LOG_FILE = 'registry-log.jsonl';

// Consecutive occurrences (failed runs, same-lens signals) before a nomination.
export const NOMINATE_AFTER = 3;

export const FLOW_STATES = ['candidate', 'reviewed', 'active', 'retired'] as const;

const entrySchema = z
  .object({
    state: z.enum(FLOW_STATES),
    provenance: z
      .object({
        source: z.string().optional(),
        authoredBy: z.string().optional(),
        compiledAt: z.string().optional(),
        notes: z.string().optional(),
      })
      .strict()
      .optional(),
    review: z
      .object({ by: z.string(), at: z.string(), notes: z.string().optional() })
      .strict()
      .optional(),
  })
  .strict();

export const registrySchema = z.record(z.string(), entrySchema);
export type Registry = z.infer<typeof registrySchema>;
export type RegistryEntry = z.infer<typeof entrySchema>;

// The log contract. External emitters write these shapes verbatim:
//   run    — one flow execution: { ts, flow, kind:'run', ok, ms?, error? }
//   signal — a consumer-side staleness observation, e.g. an editorial
//            gap-check: { ts, flow, kind:'signal', source, lenses?, note? }.
//            A lens naming the thin part of the output enables persistence
//            detection across runs.
//   shadow — a shadow-replay comparison against the specialist path:
//            { ts, flow, kind:'shadow', ok, note? }
const runRecordSchema = z.object({
  ts: z.string(),
  flow: z.string(),
  kind: z.literal('run'),
  ok: z.boolean(),
  ms: z.number().optional(),
  error: z.string().optional(),
});
const signalRecordSchema = z.object({
  ts: z.string(),
  flow: z.string(),
  kind: z.literal('signal'),
  source: z.string(),
  lenses: z.array(z.string()).optional(),
  note: z.string().optional(),
});
const shadowRecordSchema = z.object({
  ts: z.string(),
  flow: z.string(),
  kind: z.literal('shadow'),
  ok: z.boolean(),
  note: z.string().optional(),
});
export const logRecordSchema = z.discriminatedUnion('kind', [
  runRecordSchema,
  signalRecordSchema,
  shadowRecordSchema,
]);
export type LogRecord = z.infer<typeof logRecordSchema>;

export async function loadRegistry(dir: string): Promise<Registry | undefined> {
  let text: string;
  try {
    text = await readFile(join(dir, REGISTRY_FILE), 'utf8');
  } catch {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON5.parse(text);
  } catch (e) {
    throw new Error(`${REGISTRY_FILE}: invalid JSON5 — ${e instanceof Error ? e.message : e}`);
  }
  const parsed = registrySchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`${REGISTRY_FILE}: invalid\n${issues}`);
  }
  return parsed.data;
}

// Fail closed both ways: a registry entry for a flow that doesn't exist is a
// stale judgment; a flow file the registry doesn't mention is an unreviewed
// flow in a directory that opted into review.
export function checkRegistryCoverage(registry: Registry, flowNames: string[]): void {
  const files = new Set(flowNames);
  for (const name of Object.keys(registry)) {
    if (!files.has(name)) {
      throw new Error(`${REGISTRY_FILE}: entry '${name}' does not match any loaded flow`);
    }
  }
  for (const name of flowNames) {
    if (!(name in registry)) {
      throw new Error(
        `${REGISTRY_FILE}: flow '${name}' is not listed — add it (state: 'candidate' until reviewed) or remove the flow file`,
      );
    }
  }
}

export async function appendLog(dir: string, record: LogRecord): Promise<void> {
  await appendFile(join(dir, LOG_FILE), JSON.stringify(record) + '\n', 'utf8');
}

export async function readLog(dir: string): Promise<{ records: LogRecord[]; malformed: number }> {
  let text: string;
  try {
    text = await readFile(join(dir, LOG_FILE), 'utf8');
  } catch {
    return { records: [], malformed: 0 };
  }
  const records: LogRecord[] = [];
  let malformed = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = logRecordSchema.safeParse(JSON.parse(line));
      if (parsed.success) records.push(parsed.data);
      else malformed++;
    } catch {
      malformed++;
    }
  }
  return { records, malformed };
}

export interface FlowHealth {
  runs: number;
  passed: number;
  consecutiveFailures: number;
  lastRun?: string;
  /** signal count per source, e.g. { gap_check: 4 } */
  signals: Record<string, number>;
  /** lenses present in each of the last NOMINATE_AFTER signals of one source */
  persistentLenses: Array<{ source: string; lens: string }>;
  nominations: string[];
}

// Pure computation over the append-ordered log. Nominations are advisory —
// status reporting never mutates the operator's registry file.
export function computeHealth(records: LogRecord[], flow: string): FlowHealth {
  const mine = records.filter((r) => r.flow === flow);
  const runs = mine.filter((r) => r.kind === 'run');
  const passed = runs.filter((r) => r.ok).length;
  let consecutiveFailures = 0;
  for (let i = runs.length - 1; i >= 0 && !runs[i]!.ok; i--) consecutiveFailures++;

  const signals: Record<string, number> = {};
  const lensHistory = new Map<string, string[][]>();
  for (const r of mine) {
    if (r.kind !== 'signal') continue;
    signals[r.source] = (signals[r.source] ?? 0) + 1;
    if (r.lenses?.length) {
      if (!lensHistory.has(r.source)) lensHistory.set(r.source, []);
      lensHistory.get(r.source)!.push(r.lenses);
    }
  }
  const persistentLenses: Array<{ source: string; lens: string }> = [];
  for (const [source, history] of lensHistory) {
    if (history.length < NOMINATE_AFTER) continue;
    const recent = history.slice(-NOMINATE_AFTER);
    for (const lens of new Set(recent[0])) {
      if (recent.every((ls) => ls.includes(lens))) persistentLenses.push({ source, lens });
    }
  }

  const shadows = mine.filter((r) => r.kind === 'shadow');
  const lastShadow = shadows[shadows.length - 1];

  const nominations: string[] = [];
  if (consecutiveFailures >= NOMINATE_AFTER) {
    nominations.push(`${consecutiveFailures} consecutive failed runs — needs review`);
  }
  for (const p of persistentLenses) {
    nominations.push(
      `lens '${p.lens}' patched in each of the last ${NOMINATE_AFTER} '${p.source}' signals — recompile candidate`,
    );
  }
  if (lastShadow && !lastShadow.ok) {
    nominations.push('last shadow replay diverged from the specialist path — needs review');
  }

  return {
    runs: runs.length,
    passed,
    consecutiveFailures,
    lastRun: runs[runs.length - 1]?.ts,
    signals,
    persistentLenses,
    nominations,
  };
}
