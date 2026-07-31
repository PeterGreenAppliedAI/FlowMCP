import { evalExpr, type ExprContext } from './expr.js';
import { interpolate, interpolateDeep, interpolateUrl, stringify } from './interpolate.js';
import type { Flow, HttpStep, LeafStep, Step } from './flow-schema.js';

const FLOW_TIMEOUT_MS = 60_000;
const MAP_LIMIT = 10;

export class FlowError extends Error {
  constructor(
    public readonly stepId: string,
    message: string,
  ) {
    super(message);
  }
}

export interface EngineOptions {
  env?: Record<string, string | undefined>;
  flowTimeoutMs?: number;
}

interface FlowContext extends ExprContext {
  input: Record<string, unknown>;
  env: Record<string, string | undefined>;
  steps: Record<string, unknown>;
}

export async function executeFlow(
  flow: Flow,
  args: Record<string, unknown>,
  opts: EngineOptions = {},
): Promise<string> {
  const ctx: FlowContext = {
    input: coerceInput(flow, args),
    env: opts.env ?? process.env,
    steps: {},
  };
  const deadline = Date.now() + (opts.flowTimeoutMs ?? FLOW_TIMEOUT_MS);
  for (const step of flow.steps) {
    ctx.steps[step.id] = await runStep(step, step.id, ctx, deadline);
  }
  try {
    return interpolate(flow.output, ctx);
  } catch (e) {
    throw new FlowError('output', errMessage(e));
  }
}

function coerceInput(flow: Flow, args: Record<string, unknown>): Record<string, unknown> {
  const declared = flow.input;
  for (const key of Object.keys(args)) {
    if (!(key in declared)) {
      const valid = Object.keys(declared);
      throw new FlowError(
        'input',
        `unknown parameter '${key}'${valid.length ? ` (valid: ${valid.join(', ')})` : ' (this flow takes no parameters)'}`,
      );
    }
  }
  const input: Record<string, unknown> = {};
  for (const [key, param] of Object.entries(declared)) {
    const value = args[key] ?? param.default;
    if (value === undefined) {
      if (param.required) throw new FlowError('input', `missing required parameter '${key}'`);
      continue;
    }
    if (typeof value !== param.type) {
      throw new FlowError('input', `parameter '${key}' must be a ${param.type}, got ${typeof value}`);
    }
    input[key] = value;
  }
  return input;
}

async function runStep(
  step: Step | LeafStep,
  id: string,
  ctx: FlowContext,
  deadline: number,
): Promise<unknown> {
  if (Date.now() >= deadline) throw new FlowError(id, 'flow timed out (60s limit)');
  try {
    switch (step.kind) {
      case 'http_request':
        return await runHttp(step, ctx, deadline);
      case 'transform':
        return evalExpr(step.expr, ctx);
      case 'template':
        return interpolate(step.template, ctx);
      case 'map':
        return await runMap(step, id, ctx, deadline);
      case 'branch':
        return await runBranch(step, ctx, deadline);
    }
  } catch (e) {
    if (e instanceof FlowError) throw e;
    throw new FlowError(id, errMessage(e));
  }
}

async function runHttp(step: HttpStep, ctx: FlowContext, deadline: number): Promise<unknown> {
  // Interpolated values are percent-encoded (see interpolateUrl); new URL() validates.
  const url = new URL(interpolateUrl(step.url, ctx)).toString();
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(step.headers ?? {})) headers[k] = interpolate(v, ctx);
  let body: string | undefined;
  if (step.body !== undefined) {
    const value = interpolateDeep(step.body, ctx);
    body = typeof value === 'string' ? value : JSON.stringify(value);
    headers['content-type'] ??= 'application/json';
  }

  const attempt = async (): Promise<unknown> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('flow timed out (60s limit)');
    const res = await fetch(url, {
      method: step.method,
      headers,
      body,
      signal: AbortSignal.timeout(Math.min(step.timeoutMs, remaining)),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${step.method} ${url}`);
    const contentType = res.headers.get('content-type') ?? '';
    return contentType.includes('json') ? res.json() : res.text();
  };

  try {
    return await attempt();
  } catch (e) {
    // One retry, but only for network-level failures — not HTTP error statuses.
    if (e instanceof TypeError || (e instanceof Error && e.name === 'TimeoutError')) {
      return attempt();
    }
    throw e;
  }
}

async function runMap(
  step: Extract<Step, { kind: 'map' }>,
  id: string,
  ctx: FlowContext,
  deadline: number,
): Promise<unknown[]> {
  const items = evalExpr(step.over, ctx);
  if (!Array.isArray(items)) {
    throw new Error(`map 'over' must resolve to an array, got ${typeof items}`);
  }
  if (items.length > MAP_LIMIT) {
    throw new Error(
      `map over ${items.length} items exceeds the limit of ${MAP_LIMIT} — slice the input, e.g. ${step.over}[0:${MAP_LIMIT}]`,
    );
  }
  const results: unknown[] = [];
  for (let i = 0; i < items.length; i++) {
    const itemCtx: FlowContext = { ...ctx, [step.as]: items[i] };
    results.push(await runStep(step.step, `${id}[${i}]`, itemCtx, deadline));
  }
  return results;
}

async function runBranch(
  step: Extract<Step, { kind: 'branch' }>,
  ctx: FlowContext,
  deadline: number,
): Promise<{ taken: 'then' | 'else' }> {
  const taken = evalExpr(step.if, ctx) ? 'then' : 'else';
  for (const inner of (taken === 'then' ? step.then : step.else) ?? []) {
    ctx.steps[inner.id] = await runStep(inner, inner.id, ctx, deadline);
  }
  return { taken };
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export { stringify };
