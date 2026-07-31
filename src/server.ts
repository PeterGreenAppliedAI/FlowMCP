#!/usr/bin/env node
// FlowMCP — workflow-first MCP server over stdio.
// stdout is the protocol channel; all logging goes to stderr.

import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { checkServerRefs, loadFlows, loadServers } from './loader.js';
import { executeFlow, FlowError } from './engine.js';
import { McpPool } from './mcp-pool.js';
import type { Flow } from './flow-schema.js';

const VERSION = '0.2.0';
const PROTOCOL_VERSION = '2025-03-26';

interface ServerState {
  flows: Flow[];
  pool: McpPool;
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

function toolsList(flows: Flow[]): Record<string, unknown> {
  return {
    tools: flows.map((flow) => {
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [name, param] of Object.entries(flow.input)) {
        properties[name] = { type: param.type, description: param.description };
        if (param.required) required.push(name);
      }
      return {
        name: flow.name,
        description: flow.description,
        inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) },
        annotations: { readOnlyHint: true }, // v1 doctrine: all flows are read-only
      };
    }),
  };
}

async function toolsCall(state: ServerState, params: Record<string, unknown>): Promise<unknown> {
  const name = params.name;
  const flow = state.flows.find((f) => f.name === name);
  if (!flow) throw new MethodError(-32602, `unknown tool '${String(name)}'`);
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  try {
    const text = await executeFlow(flow, args, { mcp: state.pool });
    return { content: [{ type: 'text', text }] };
  } catch (e) {
    const detail =
      e instanceof FlowError
        ? `Flow '${flow.name}' failed at step '${e.stepId}': ${e.message}`
        : `Flow '${flow.name}' failed: ${e instanceof Error ? e.message : e}`;
    log(detail);
    return { content: [{ type: 'text', text: detail }], isError: true };
  }
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
    case 'initialize':
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'flowmcp', version: VERSION },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return toolsList(state.flows);
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
    const flows = await loadFlows(dir);
    const servers = await loadServers(dir);
    checkServerRefs(flows, new Set(Object.keys(servers)));
    state = { flows, pool: new McpPool(servers) };
    log(`loaded ${flows.length} flows from ${dir}: ${flows.map((f) => f.name).join(', ')}`);
    const serverNames = Object.keys(servers);
    if (serverNames.length) log(`downstream MCP servers: ${serverNames.join(', ')}`);
  } catch (e) {
    log(`startup failed: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }

  const rl = createInterface({ input: process.stdin });
  let queue = Promise.resolve();
  rl.on('line', (line) => {
    if (!line.trim()) return;
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
