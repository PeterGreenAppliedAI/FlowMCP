import { evalExpr, type ExprContext } from './expr.js';
import { interpolate, interpolateDeep, interpolateUrl, stringify } from './interpolate.js';
import type { Flow, HttpStep, LeafStep, McpCallStep, Step } from './flow-schema.js';
import type { McpPool } from './mcp-pool.js';

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
  mcp?: McpPool;
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
    ctx.steps[step.id] = await runStep(step, step.id, ctx, deadline, opts.mcp);
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
  mcp?: McpPool,
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
      case 'mcp_call':
        return await runMcpCall(step, ctx, deadline, mcp);
      case 'map':
        return await runMap(step, id, ctx, deadline, mcp);
      case 'branch':
        return await runBranch(step, ctx, deadline, mcp);
    }
  } catch (e) {
    if (e instanceof FlowError) throw e;
    throw new FlowError(id, errMessage(e));
  }
}

async function runMcpCall(
  step: McpCallStep,
  ctx: FlowContext,
  deadline: number,
  mcp?: McpPool,
): Promise<unknown> {
  if (!mcp?.has(step.server)) {
    throw new Error(`no MCP server '${step.server}' configured — add it to servers.json5`);
  }
  const args = interpolateDeep(step.args, ctx) as Record<string, unknown>;
  // One budget for spawn + handshake + call, bounded by the flow deadline.
  const callDeadline = Math.min(deadline, Date.now() + step.timeoutMs);
  const result = await mcp.call(step.server, step.tool, args, callDeadline);
  const text = (result.content ?? [])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
  if (result.isError) {
    throw new Error(`tool '${step.tool}' on server '${step.server}' returned an error: ${text || '(no detail)'}`);
  }
  if (text.length > step.maxResultChars) {
    return text.slice(0, step.maxResultChars) + `\n…[truncated ${text.length - step.maxResultChars} chars]`;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
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
  mcp?: McpPool,
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
    results.push(await runStep(step.step, `${id}[${i}]`, itemCtx, deadline, mcp));
  }
  return results;
}

async function runBranch(
  step: Extract<Step, { kind: 'branch' }>,
  ctx: FlowContext,
  deadline: number,
  mcp?: McpPool,
): Promise<{ taken: 'then' | 'else' }> {
  const taken = evalExpr(step.if, ctx) ? 'then' : 'else';
  for (const inner of (taken === 'then' ? step.then : step.else) ?? []) {
    ctx.steps[inner.id] = await runStep(inner, inner.id, ctx, deadline, mcp);
  }
  return { taken };
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export { stringify };
