// The internal one-flow runner: load a whole flow directory, run ONE flow
// named by the caller, and return its text. This is the core the `serve`
// surface and any future local invocation share — it is NOT wired to the CLI
// yet (owner decision: core and all protections land before CLI exposure).
//
// Rules it enforces, in order, before any step runs:
//   1. The directory loads completely: flows, servers, references, absence
//      declarations, and the registry (with coverage). A broken sibling flow,
//      server config, reference, absence declaration, registry entry or
//      registry read failure refuses the run — never a partial surface.
//   2. The named flow exists and is admitted: no registry = every valid flow;
//      with a registry, only 'active' flows run. 'candidate'/'reviewed' run
//      only with allowInactive (with a stderr note naming the state);
//      'retired' always refuses.
//   3. The flow is read-only: a POST or an allowlisted downstream write —
//      anywhere in the flow, including a map body or either branch arm —
//      refuses it before any step, even the reads that precede the write.
//      Writes belong on the `serve` surface, where the approval gate exists.
//   4. Inputs are schema-directed: 'k=v' pairs split at the FIRST '=', the
//      remainder preserved verbatim (empty, commas, further '=' and all),
//      scalars converted strictly, keys owned by flow.input only, and
//      required parameters without a default must be present. Default
//      application and optional omission remain executeFlow's job.
//
// Execution is one executeFlow call with a fresh McpPool(servers,{baseDir:dir}),
// and closeAll is awaited in finally after the pool exists. A pending result
// is unexpected here — the flow was checked read-only, and this runner has no
// approval surface — so it rejects rather than resuming. FlowError step ids
// and causes are preserved. No stdout, no stdin, no process exit: diagnostics
// go to stderr only.
//
// Best-effort run logging (same record shape as the server's recordRun, built
// here without importing server.ts): with a registry, a completed execution or
// an exception from execution appends ONE 'run' record to registry-log.jsonl.
// Refusals before execution (load/lookup/coverage/state/write/input) and the
// unexpected-pending refusal never log. A failed append is caught on its own,
// diagnosed on stderr, and never changes the execution result; logging is
// awaited after closeAll, before the run settles. The record's `ms` is elapsed
// execution time, captured as executeFlow settles and before pool cleanup.

import { checkAbsentSteps, checkServerRefs, flowEffects, loadFlows, loadServers } from './loader.js';
import { executeFlow, FlowError } from './engine.js';
import { McpPool } from './mcp-pool.js';
import { appendLog, checkRegistryCoverage, loadRegistry, REGISTRY_FILE } from './registry.js';
import type { Flow } from './flow-schema.js';
import type { Registry } from './registry.js';

export interface RunFlowOptions {
  /** The resolved directory supplied by the caller (loaders read it as-is). */
  dir: string;
  flow: string;
  /** 'key=value' pairs; split at the first '='. Defaults to []. */
  inputPairs?: string[];
  /** With a registry, also run 'candidate'/'reviewed' flows. Defaults to false. */
  allowInactive?: boolean;
}

export interface RunFlowResult {
  text: string;
  absent?: string[];
}

// Registry records come from JSON5, so they are plain objects whose inherited
// Object.prototype names ('constructor', 'toString', …) would look like
// entries under a plain `in`/read. Own properties only.
function ownEntry<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

export async function runFlow(options: RunFlowOptions): Promise<RunFlowResult> {
  const { dir, flow: flowName, inputPairs = [], allowInactive = false } = options;

  // 1. Load the entire directory before selecting anything.
  const flows = await loadFlows(dir);
  const servers = await loadServers(dir);
  checkServerRefs(flows, new Set(Object.keys(servers)));
  checkAbsentSteps(flows, servers);
  const registry = await loadRegistry(dir);
  if (registry) {
    // Own-property coverage for the whole directory: checkRegistryCoverage is
    // the required API call, but its restored implementation uses `in` for
    // flow membership, so an inherited Object.prototype name ('constructor',
    // 'toString', …) would satisfy it. Refuse both an unlisted loaded flow and
    // a registry entry matching no loaded flow using own properties only,
    // before anything runs.
    const files = new Set(flows.map((f) => f.name));
    for (const name of flows.map((f) => f.name)) {
      if (ownEntry(registry, name) === undefined) {
        throw new Error(
          `${REGISTRY_FILE}: flow '${name}' is not listed — add it (state: 'candidate' until reviewed) or remove the flow file`,
        );
      }
    }
    for (const name of Object.keys(registry)) {
      if (!files.has(name)) {
        throw new Error(`${REGISTRY_FILE}: entry '${name}' does not match any loaded flow`);
      }
    }
    checkRegistryCoverage(registry, flows.map((f) => f.name));
  }

  // 2. Look up the flow by declared name.
  const flow = flows.find((f) => f.name === flowName);
  if (!flow) throw new Error(`no flow named '${flowName}' in ${dir}`);

  // 3. Promotion state (only with a registry).
  if (registry) {
    const state = ownEntry(registry, flowName)?.state;
    if (state === undefined) {
      throw new Error(`${REGISTRY_FILE}: flow '${flowName}' has no entry`);
    }
    if (state === 'retired') {
      throw new Error(`flow '${flowName}' is 'retired' in ${REGISTRY_FILE} — retired flows never run`);
    }
    if (state !== 'active') {
      if (!allowInactive) {
        throw new Error(
          `flow '${flowName}' is '${state}' in ${REGISTRY_FILE} — only 'active' flows run; ` +
            `pass allowInactive to run a '${state}' flow explicitly`,
        );
      }
      process.stderr.write(`flowmcp: run: flow '${flowName}' is '${state}' — running it because allowInactive was given\n`);
    }
  }

  // 4. Read-only flows only: writes belong on the serve surface (approval gate).
  if (!flowEffects(flow, servers).readOnly) {
    throw new Error(
      `flow '${flowName}' is write-capable — writes require the approval gate; run it with 'flowmcp serve' instead`,
    );
  }

  // 5. Inputs and the required-parameter check (before the engine runs).
  const args = convertInputs(flow, inputPairs);
  checkRequired(flow, args);

  // 6. One execution, then always close the pool. Only a completed result or
  // an exception from executeFlow itself becomes a run record; the pending
  // refusal (below, outside the execution boundary) does not.
  const pool = new McpPool(servers, { baseDir: dir });
  const startedAt = Date.now();
  let run: Awaited<ReturnType<typeof executeFlow>> | undefined;
  let completed: { text: string; absent?: string[] } | undefined;
  let failed: string | undefined;
  let ms: number | undefined;
  try {
    try {
      run = await executeFlow(flow, args, { mcp: pool });
      // Elapsed EXECUTION time only: captured as execution settles, before the
      // pool cleanup below, so cleanup time never inflates the record.
      ms = Date.now() - startedAt;
      if (run.status === 'complete') {
        completed = run.absent?.length ? { text: run.text, absent: run.absent } : { text: run.text };
      }
    } catch (e) {
      ms = Date.now() - startedAt;
      failed = flowFailureDetail(flowName, e);
      throw e;
    }
  } finally {
    await pool.closeAll();
    if (completed || failed) await recordRun(dir, registry, flowName, ms!, completed, failed);
  }

  if (completed) return completed;
  // Unexpected pending: not a run record — the runner refuses to resume.
  if (!run || run.status !== 'pending') throw new Error('unreachable: execution settled without a result');
  throw new FlowError(
    flow.steps[run.pending.stepIndex]?.id ?? 'pending',
    `flow '${flowName}' paused unexpectedly at a write gate — the runner was checked read-only; refusing to resume`,
  );
}

// Failure diagnostic naming the flow, the available step and the cause. The
// step is only a top-level id: an absent/mocked pending carries none here, so
// it is omitted rather than invented. FlowError is preserved, never replaced.
function flowFailureDetail(flowName: string, e: unknown): string {
  const cause = e instanceof Error ? e.message : String(e);
  return e instanceof FlowError && typeof e.stepId === 'string'
    ? `Flow '${flowName}' failed at step '${e.stepId}': ${cause}`
    : `Flow '${flowName}' failed: ${cause}`;
}

// Best-effort: a log write failure must never fail the run. No registry means
// no log file is created.
async function recordRun(
  dir: string,
  registry: Registry | undefined,
  flowName: string,
  ms: number | undefined,
  completed: { text: string; absent?: string[] } | undefined,
  failed: string | undefined,
): Promise<void> {
  if (!registry) return;
  try {
    await appendLog(dir, {
      ts: new Date().toISOString(),
      flow: flowName,
      kind: 'run',
      ok: failed === undefined,
      ms,
      ...(failed ? { error: failed } : {}),
      ...(completed?.absent?.length ? { absent: completed.absent } : {}),
    });
  } catch (e) {
    process.stderr.write(
      `flowmcp: registry log append failed: ${e instanceof Error ? e.message : e}\n`,
    );
  }
}

function convertInputs(flow: Flow, inputPairs: string[]): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const pair of inputPairs) {
    const eq = pair.indexOf('=');
    if (eq === -1) {
      throw new FlowError('input', `input '${pair}' has no '=' — expected key=value`);
    }
    const key = pair.slice(0, eq);
    const rest = pair.slice(eq + 1);
    if (key === '') throw new FlowError('input', `input '${pair}' has an empty key`);
    const param = ownEntry(flow.input, key);
    if (!param) {
      const valid = Object.keys(flow.input);
      throw new FlowError(
        'input',
        `unknown parameter '${key}'${valid.length ? ` (valid: ${valid.join(', ')})` : ' (this flow takes no parameters)'}`,
      );
    }
    if (Object.prototype.hasOwnProperty.call(args, key)) {
      throw new FlowError('input', `duplicate parameter '${key}'`);
    }
    args[key] = convertValue(key, param.type, rest);
  }
  return args;
}

// The string remainder is verbatim. Booleans accept only true/false. Numbers
// must be finite JSON-number literals with no surrounding whitespace. The
// literal test is done by hand rather than with a RegExp: a JS regexp `$`
// also matches before a trailing newline, which would accept '7\n'.
function convertValue(key: string, type: 'string' | 'number' | 'boolean', rest: string): unknown {
  if (type === 'string') return rest;
  if (type === 'boolean') {
    if (rest === 'true') return true;
    if (rest === 'false') return false;
    throw new FlowError('input', `parameter '${key}' must be true or false, got '${rest}'`);
  }
  if (!isJsonNumberLiteral(rest)) {
    throw new FlowError('input', `parameter '${key}' must be a JSON number, got '${rest}'`);
  }
  const value = Number(rest);
  if (!Number.isFinite(value)) {
    throw new FlowError('input', `parameter '${key}' must be a finite number, got '${rest}'`);
  }
  return value;
}

// RFC 8259 number: -?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?
// Every character is checked, so no whitespace (leading, trailing, newline)
// can slip through.
function isJsonNumberLiteral(text: string): boolean {
  let i = 0;
  const digits = (): number => {
    const start = i;
    while (i < text.length && text[i]! >= '0' && text[i]! <= '9') i++;
    return i - start;
  };
  if (text[i] === '-') i++;
  if (text[i] === '0') {
    i++;
    // A lone '0' must not be followed by more integer digits ('01', '00').
    if (text[i] !== undefined && text[i]! >= '0' && text[i]! <= '9') return false;
  } else {
    // Leading digit is 1-9, then any digits (which may end in zero).
    if (text[i] === undefined || text[i]! < '1' || text[i]! > '9') return false;
    i++;
    digits();
  }
  if (text[i] === '.') {
    i++;
    if (digits() === 0) return false;
  }
  if (text[i] === 'e' || text[i] === 'E') {
    i++;
    if (text[i] === '+' || text[i] === '-') i++;
    if (digits() === 0) return false;
  }
  return i === text.length;
}

function checkRequired(flow: Flow, args: Record<string, unknown>): void {
  for (const [key, param] of Object.entries(flow.input)) {
    if (param.required && param.default === undefined && !Object.prototype.hasOwnProperty.call(args, key)) {
      throw new FlowError('input', `missing required parameter '${key}'`);
    }
  }
}
