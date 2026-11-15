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
// (a write gate) is unexpected here — the flow was checked read-only — so it
// rejects rather than resuming. FlowError step ids and causes are preserved.
// No stdout, no stdin, no process exit: diagnostics go to stderr only.

import { checkAbsentSteps, checkServerRefs, flowEffects, loadFlows, loadServers } from './loader.js';
import { executeFlow, FlowError } from './engine.js';
import { McpPool } from './mcp-pool.js';
import { checkRegistryCoverage, loadRegistry, REGISTRY_FILE, registryEntry } from './registry.js';
import type { Flow } from './flow-schema.js';

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

export async function runFlow(options: RunFlowOptions): Promise<RunFlowResult> {
  const { dir, flow: flowName, inputPairs = [], allowInactive = false } = options;

  // 1. Load the entire directory before selecting anything.
  const flows = await loadFlows(dir);
  const servers = await loadServers(dir);
  checkServerRefs(flows, new Set(Object.keys(servers)));
  checkAbsentSteps(flows, servers);
  const registry = await loadRegistry(dir);
  if (registry) checkRegistryCoverage(registry, flows.map((f) => f.name));

  // 2. Look up the flow by declared name.
  const flow = flows.find((f) => f.name === flowName);
  if (!flow) throw new Error(`no flow named '${flowName}' in ${dir}`);

  // 3. Promotion state (only with a registry).
  if (registry) {
    const state = registryEntry(registry, flowName)!.state;
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

  // 6. One execution, then always close the pool.
  const pool = new McpPool(servers, { baseDir: dir });
  try {
    // The engine's write gate is injected here (rather than through the public
    // options) so an unexpected pause can be exercised hermetically: the
    // runner then rejects instead of resuming — it has no approval surface.
    const run = await executeFlow(flow, args, {
      mcp: pool,
      writeGate: injectedWriteGate(flowName),
    });
    if (run.status === 'pending') {
      throw new FlowError(
        flow.steps[run.pending.stepIndex]?.id ?? 'pending',
        `flow '${flowName}' paused unexpectedly at a write gate — the runner was checked read-only; refusing to resume`,
      );
    }
    return run.absent?.length ? { text: run.text, absent: run.absent } : { text: run.text };
  } finally {
    await pool.closeAll();
  }
}

// A test-visible seam for the unexpected-pending branch: tests populate this
// map to simulate a gate on a flow the loader judged read-only. It is empty in
// production, so no gate is ever injected there.
const writeGates = new Map<string, Set<string>>();
export function __simulateWriteGate(flowName: string, ids: string[]): void {
  writeGates.set(flowName, new Set(ids));
}
export function __clearWriteGate(flowName: string): void {
  writeGates.delete(flowName);
}
function injectedWriteGate(flowName: string): Set<string> | undefined {
  return writeGates.get(flowName);
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
    const param = Object.prototype.hasOwnProperty.call(flow.input, key) ? flow.input[key] : undefined;
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
// must be finite JSON-number literals with no surrounding whitespace.
function convertValue(key: string, type: 'string' | 'number' | 'boolean', rest: string): unknown {
  if (type === 'string') return rest;
  if (type === 'boolean') {
    if (rest === 'true') return true;
    if (rest === 'false') return false;
    throw new FlowError('input', `parameter '${key}' must be true or false, got '${rest}'`);
  }
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(rest)) {
    throw new FlowError('input', `parameter '${key}' must be a JSON number, got '${rest}'`);
  }
  const value = Number(rest);
  if (!Number.isFinite(value)) {
    throw new FlowError('input', `parameter '${key}' must be a finite number, got '${rest}'`);
  }
  return value;
}

function checkRequired(flow: Flow, args: Record<string, unknown>): void {
  for (const [key, param] of Object.entries(flow.input)) {
    if (param.required && param.default === undefined && args[key] === undefined) {
      throw new FlowError('input', `missing required parameter '${key}'`);
    }
  }
}
