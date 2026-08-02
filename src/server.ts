#!/usr/bin/env node
// FlowMCP — workflow-first MCP server over stdio.
// stdout is the protocol channel; all logging goes to stderr.

import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  checkServerRefs,
  flowEffects,
  loadFlows,
  loadServers,
  topLevelWriteStepIds,
  type FlowEffects,
} from './loader.js';
import { executeFlow, resumeFlow, FlowError, type PendingFlow } from './engine.js';
import { McpPool, PROTOCOL_REVISIONS } from './mcp-pool.js';
import type { Flow } from './flow-schema.js';
import {
  appendLog,
  checkRegistryCoverage,
  computeHealth,
  loadRegistry,
  readLog,
  REGISTRY_FILE,
  type Registry,
} from './registry.js';

const VERSION = '0.7.0';
const APPROVAL_TTL_MS = 5 * 60_000;
// Our surface (initialize / tools/list / tools/call / ping) is unchanged across
// these revisions; echo the client's requested version when we know it.
const SUPPORTED_PROTOCOLS = new Set(PROTOCOL_REVISIONS);
const DEFAULT_PROTOCOL = '2025-03-26';

interface PendingApproval {
  flowName: string;
  pending: PendingFlow;
  expiresAt: number;
}

interface ServerState {
  flows: Flow[];
  pool: McpPool;
  effects: Map<string, FlowEffects>;
  writeGates: Map<string, Set<string>>;
  approvals: Map<string, PendingApproval>;
  clientElicitation: boolean;
  /** Present iff registry.json5 exists — turns on state enforcement + run logging. */
  registry?: Registry;
  dir: string;
}

// Best-effort run logging: a log write failure must never fail the tool call.
async function recordRun(state: ServerState, flowName: string, ok: boolean, startedAt: number, error?: string): Promise<void> {
  if (!state.registry) return;
  try {
    await appendLog(state.dir, {
      ts: new Date().toISOString(),
      flow: flowName,
      kind: 'run',
      ok,
      ms: Date.now() - startedAt,
      ...(error ? { error } : {}),
    });
  } catch (e) {
    log(`registry log append failed: ${e instanceof Error ? e.message : e}`);
  }
}

// Server-initiated requests (elicitation). Responses are routed OUTSIDE the
// serial request queue — a queued response while tools/call awaits it would
// deadlock.
const pendingOutgoing = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let outgoingSeq = 0;

interface ElicitResult { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }

function elicit(message: string, requestedSchema: Record<string, unknown>, timeoutMs = APPROVAL_TTL_MS): Promise<ElicitResult> {
  const id = `elicit-${++outgoingSeq}`;
  send({ jsonrpc: '2.0', id, method: 'elicitation/create', params: { message, requestedSchema } });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingOutgoing.delete(id);
      reject(new Error('elicitation timed out (no response from the client)'));
    }, timeoutMs);
    pendingOutgoing.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v as ElicitResult); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
  });
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

function log(message: string): void {
  process.stderr.write(`flowmcp: ${message}\n`);
}

function send(message: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function sendResult(id: number | string | null, result: unknown): void {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id: number | string | null, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function toolsList(state: ServerState): Record<string, unknown> {
  return {
    tools: state.flows.map((flow) => {
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [name, param] of Object.entries(flow.input)) {
        // Advertise defaults in BOTH channels: JSON Schema `default` and the
        // description text — some models ignore schema defaults, and an
        // unadvertised default sends reasoning models into deliberation
        // instead of a call (measured: 240s stalls on the vague-prompt task).
        const withDefault =
          param.default !== undefined
            ? `${param.description} Optional; defaults to ${JSON.stringify(param.default)}.`
            : param.description;
        properties[name] = {
          type: param.type,
          description: withDefault,
          ...(param.default !== undefined ? { default: param.default } : {}),
        };
        if (param.required) required.push(name);
      }
      // Statically computed from the flow's steps — a POST or an allowlisted
      // downstream write makes the flow non-read-only, and clients must see that.
      const fx = state.effects.get(flow.name) ?? { readOnly: false, openWorld: true };
      if (!fx.readOnly) {
        properties['confirm'] = {
          type: 'string',
          description: 'Approval token from a previous proposal. Only pass after reviewing the proposed writes.',
        };
      }
      return {
        name: flow.name,
        description: flow.description,
        inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) },
        annotations: {
          readOnlyHint: fx.readOnly,
          destructiveHint: !fx.readOnly, // pessimistic: unknown write effects count as destructive
          openWorldHint: fx.openWorld,
        },
      };
    }),
  };
}

async function toolsCall(state: ServerState, params: Record<string, unknown>): Promise<unknown> {
  const name = params.name;
  const flow = state.flows.find((f) => f.name === name);
  if (!flow) throw new MethodError(-32602, `unknown tool '${String(name)}'`);
  const { confirm, ...args } = (params.arguments ?? {}) as Record<string, unknown>;
  // Small models pad arguments (an empty {"input": ""} on a no-param flow is
  // common). On READ-ONLY flows unknown parameters are dropped with a stderr
  // note — rejecting them fails the model for noise. Write flows stay strict:
  // an unexpected argument on a write is a reason to stop, not to guess.
  if (state.effects.get(flow.name)?.readOnly) {
    for (const key of Object.keys(args)) {
      if (!(key in flow.input)) {
        log(`ignoring unknown parameter '${key}' on read-only flow '${flow.name}'`);
        delete args[key];
      }
    }
  }
  const startedAt = Date.now();
  try {
    if (confirm !== undefined) {
      const res = await confirmedCall(state, flow, String(confirm));
      if (!(res as { isError?: boolean }).isError) await recordRun(state, flow.name, true, startedAt);
      return res;
    }
    // Structural ask-the-user: missing required parameters are elicited from
    // the client when it advertises the capability, instead of erroring.
    if (state.clientElicitation) {
      const missing = Object.entries(flow.input).filter(([k, p]) => p.required && args[k] === undefined);
      if (missing.length) {
        const res = await elicit(
          `'${flow.name}' needs ${missing.length} more value(s) to run.`,
          {
            type: 'object',
            properties: Object.fromEntries(missing.map(([k, p]) => [k, { type: p.type, description: p.description }])),
            required: missing.map(([k]) => k),
          },
        );
        if (res.action !== 'accept' || !res.content) {
          return { content: [{ type: 'text', text: `Cancelled: required input for '${flow.name}' was not provided.` }], isError: true };
        }
        Object.assign(args, res.content);
      }
    }
    const gate = state.writeGates.get(flow.name);
    const run = await executeFlow(flow, args, {
      mcp: state.pool,
      writeGate: gate?.size ? gate : undefined,
    });
    if (run.status === 'complete') {
      await recordRun(state, flow.name, true, startedAt);
      return { content: [{ type: 'text', text: run.text }] };
    }
    // Write pause. With elicitation, the host mediates the approval — the
    // model never holds a consumable token. Without it, fall back to the
    // v0.3 two-phase confirmation protocol.
    if (state.clientElicitation) {
      const res = await elicit(
        `${run.proposalText}\n\nApprove executing the write step(s) of '${flow.name}'? Nothing has been written yet.`,
        {
          type: 'object',
          properties: { approve: { type: 'boolean', description: 'true to execute the proposed writes' } },
          required: ['approve'],
        },
      );
      if (res.action !== 'accept' || res.content?.approve !== true) {
        return { content: [{ type: 'text', text: `Declined: '${flow.name}' was not approved. Nothing was written.` }] };
      }
      const resumed = await resumeFlow(flow, run.pending, { mcp: state.pool });
      await recordRun(state, flow.name, true, startedAt);
      return { content: [{ type: 'text', text: resumed.status === 'complete' ? resumed.text : '' }] };
    }
    const token = randomUUID();
    state.approvals.set(token, {
      flowName: flow.name,
      pending: run.pending,
      expiresAt: Date.now() + APPROVAL_TTL_MS,
    });
    const text =
      `${run.proposalText}\n\n` +
      `Nothing has been written yet. To approve, call '${flow.name}' again with ` +
      `{"confirm": "${token}"} within 5 minutes. To cancel, do nothing.`;
    return { content: [{ type: 'text', text }] };
  } catch (e) {
    const detail =
      e instanceof FlowError
        ? `Flow '${flow.name}' failed at step '${e.stepId}': ${e.message}`
        : `Flow '${flow.name}' failed: ${e instanceof Error ? e.message : e}`;
    log(detail);
    await recordRun(state, flow.name, false, startedAt, detail);
    return { content: [{ type: 'text', text: detail }], isError: true };
  }
}

async function confirmedCall(state: ServerState, flow: Flow, token: string): Promise<unknown> {
  for (const [key, approval] of state.approvals) {
    if (approval.expiresAt <= Date.now()) state.approvals.delete(key);
  }
  const approval = state.approvals.get(token);
  if (!approval || approval.flowName !== flow.name) {
    return {
      content: [
        {
          type: 'text',
          text: `No pending approval for '${flow.name}' with that token — it may have expired (5 min). Call the tool again without 'confirm' to get a fresh proposal.`,
        },
      ],
      isError: true,
    };
  }
  state.approvals.delete(token); // single use
  const run = await resumeFlow(flow, approval.pending, { mcp: state.pool });
  // resumeFlow never re-gates, so it can only complete or throw.
  return { content: [{ type: 'text', text: run.status === 'complete' ? run.text : '' }] };
}

class MethodError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

async function dispatch(state: ServerState, req: JsonRpcRequest): Promise<unknown> {
  const params = req.params ?? {};
  switch (req.method) {
    case 'initialize': {
      const requested = params.protocolVersion;
      const caps = params.capabilities as { elicitation?: unknown } | undefined;
      state.clientElicitation = caps?.elicitation !== undefined;
      return {
        protocolVersion:
          typeof requested === 'string' && SUPPORTED_PROTOCOLS.has(requested)
            ? requested
            : DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: 'flowmcp', version: VERSION },
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return toolsList(state);
    case 'tools/call':
      return toolsCall(state, params);
    default:
      throw new MethodError(-32601, `method not found: ${req.method}`);
  }
}

function flowsDir(): string {
  const argIdx = process.argv.indexOf('--flows');
  if (argIdx !== -1 && process.argv[argIdx + 1]) return resolve(process.argv[argIdx + 1]!);
  if (process.env.FLOWMCP_FLOWS_DIR) return resolve(process.env.FLOWMCP_FLOWS_DIR);
  return fileURLToPath(new URL('../flows', import.meta.url));
}

async function main(): Promise<void> {
  const dir = flowsDir();
  let state: ServerState;
  try {
    let flows = await loadFlows(dir);
    const servers = await loadServers(dir);
    checkServerRefs(flows, new Set(Object.keys(servers)));
    // A registry beside the flows opts the directory into promotion
    // governance: every flow must be listed, only 'active' flows serve.
    const registry = await loadRegistry(dir);
    if (registry) {
      checkRegistryCoverage(registry, flows.map((f) => f.name));
      for (const f of flows) {
        const s = registry[f.name]!.state;
        if (s !== 'active') log(`registry: flow '${f.name}' is '${s}' — not serving it`);
      }
      flows = flows.filter((f) => registry[f.name]!.state === 'active');
    }
    const effects = new Map(flows.map((f) => [f.name, flowEffects(f, servers)]));
    const writeGates = new Map(flows.map((f) => [f.name, topLevelWriteStepIds(f, servers)]));
    state = { flows, pool: new McpPool(servers, { baseDir: dir }), effects, writeGates, approvals: new Map(), clientElicitation: false, registry, dir };
    log(`loaded ${flows.length} flows from ${dir}: ${flows.map((f) => f.name).join(', ')}`);
    const serverNames = Object.keys(servers);
    if (serverNames.length) log(`downstream MCP servers: ${serverNames.join(', ')}`);
  } catch (e) {
    log(`startup failed: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
  if (process.argv.includes('--validate')) {
    log('flows valid');
    process.exit(0);
  }
  if (process.argv.includes('--status')) {
    if (!state.registry) {
      console.log(`no ${REGISTRY_FILE} in ${dir} — registry disabled (all valid flows serve)`);
      process.exit(0);
    }
    const { records, malformed } = await readLog(dir);
    const names = Object.keys(state.registry).sort();
    const rows = names.map((name) => {
      const h = computeHealth(records, name);
      const signals = Object.entries(h.signals).map(([s, n]) => `${s}:${n}`).join(' ') || '-';
      return {
        name,
        state: state.registry![name]!.state,
        runs: `${h.passed}/${h.runs}`,
        consec: String(h.consecutiveFailures),
        last: h.lastRun ?? '-',
        signals,
        nominations: h.nominations,
      };
    });
    const w = (k: 'name' | 'state' | 'runs' | 'consec' | 'last' | 'signals') =>
      Math.max(k.length, ...rows.map((r) => r[k].length));
    const header = ['name', 'state', 'runs', 'consec', 'last', 'signals'] as const;
    console.log(header.map((k) => k.padEnd(w(k))).join('  '));
    for (const r of rows) console.log(header.map((k) => r[k].padEnd(w(k))).join('  '));
    const nominated = rows.filter((r) => r.nominations.length);
    console.log('');
    if (nominated.length === 0) console.log('no nominations');
    for (const r of nominated) for (const n of r.nominations) console.log(`NOMINATION ${r.name}: ${n}`);
    if (malformed) console.log(`(${malformed} malformed log line(s) skipped)`);
    process.exit(0);
  }
  if (process.argv.includes('--explain')) {
    // Routing preamble, generated FROM the surface — paste into any router's
    // system prompt so an LLM can pick the right flow (or decline).
    const lines = [
      `You can call ${state.flows.length} workflow tool(s). Pick the ONE whose description matches the request; fill only its listed parameters. Parameters with defaults can be omitted — trust the default rather than deliberating. If a required parameter or an environment choice (which account, store, tenant, city) is genuinely ambiguous from the request, ASK the user one concise question before calling — never guess. If no workflow fits, do not force one — use other means or say so.`,
      '',
    ];
    for (const f of state.flows) {
      const fx = state.effects.get(f.name)!;
      const params = Object.entries(f.input)
        .map(([n, p]) => `${n}${p.required ? '' : '?'}: ${p.type}${p.default !== undefined ? ` = ${JSON.stringify(p.default)}` : ''}`)
        .join(', ');
      lines.push(`- ${f.name}(${params})${fx.readOnly ? '' : ' [WRITE — requires confirmation]'}: ${f.description}`);
    }
    console.log(lines.join('\n'));
    process.exit(0);
  }

  const rl = createInterface({ input: process.stdin });
  let queue = Promise.resolve();
  rl.on('line', (line) => {
    if (!line.trim()) return;
    // Responses to server-initiated requests bypass the serial queue.
    try {
      const peek = JSON.parse(line) as { id?: string | number; method?: string; result?: unknown; error?: { message?: string } };
      if (peek.method === undefined && peek.id !== undefined && pendingOutgoing.has(String(peek.id))) {
        const pending = pendingOutgoing.get(String(peek.id))!;
        pendingOutgoing.delete(String(peek.id));
        if (peek.error) pending.reject(new Error(peek.error.message ?? 'elicitation error'));
        else pending.resolve(peek.result);
        return;
      }
    } catch { /* fall through to normal handling */ }
    queue = queue.then(() => handleLine(state, line));
  });
  rl.on('close', () => {
    // Drain in-flight requests before exiting (stdin closes immediately for piped input).
    void queue.then(() => {
      state.pool.closeAll();
      process.exit(0);
    });
  });
}

async function handleLine(state: ServerState, line: string): Promise<void> {
  let req: JsonRpcRequest;
  try {
    req = JSON.parse(line);
  } catch {
    sendError(null, -32700, 'parse error');
    return;
  }
  const isNotification = req.id === undefined;
  try {
    const result = await dispatch(state, req);
    if (!isNotification) sendResult(req.id!, result);
  } catch (e) {
    if (isNotification) return;
    if (e instanceof MethodError) sendError(req.id!, e.code, e.message);
    else sendError(req.id!, -32603, e instanceof Error ? e.message : String(e));
  }
}

main();
