// Client-side pool of downstream MCP servers for composition (mcp_call steps).
//
// Lifecycle per downstream server: spawn lazily on first use, keep the child
// alive across calls, respawn on crash (3 attempts, then a 5s backoff gate),
// shut down after 5 minutes idle. One protocol session per child, not per flow.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { z } from 'zod';
import { interpolate } from './interpolate.js';

const IDENT = /^[a-z][a-z0-9_]*$/;

// Protocol revisions this codebase's four-method surface is unchanged across.
// The downstream client initiates with the newest and accepts any of them.
export const PROTOCOL_REVISIONS = ['2025-03-26', '2025-06-18', '2025-11-25'];
const NEWEST_PROTOCOL = PROTOCOL_REVISIONS[PROTOCOL_REVISIONS.length - 1]!;

// Baseline env for downstream children when inheritEnv is off: enough to run,
// nothing that could hold a secret. Windows needs its process-launch machinery
// (PATHEXT, ComSpec, SystemRoot) and its temp/profile locations.
const BASELINE_ENV_KEYS =
  process.platform === 'win32'
    ? ['PATH', 'PATHEXT', 'COMSPEC', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA']
    : ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TERM'];

export const serversSchema = z.record(
  z.string().regex(IDENT, 'server name must be snake_case'),
  z
    .object({
      // Local transport: spawn a stdio child.
      command: z.string().min(1).optional(),
      args: z.array(z.string()).default([]),
      env: z.record(z.string()).default({}), // values may use {{env.X}} — never inline secrets
      // Remote transport: Streamable HTTP endpoint. Exactly one of command|url.
      url: z.string().min(1).optional(),
      headers: z.record(z.string()).default({}), // values may use {{env.X}} (auth tokens)
      allow: z.array(z.string()).default([]), // write-capable tools callable by this server's flows
      // Operator attestation: these tools ARE reads even though the server does
      // not annotate them. Callable, and NOT counted as write-capable.
      readOnly: z.array(z.string()).default([]),
      inheritEnv: z.boolean().default(false), // opt-in: pass the full parent environment through
      // Opt-in: launch via the system shell. Required on Windows for .cmd shims
      // like npx (raw spawn cannot exec them); servers.json5 is operator-trusted.
      shell: z.boolean().default(false),
    })
    .strict()
    .refine((c) => (c.command !== undefined) !== (c.url !== undefined), {
      message: "exactly one of 'command' (stdio) or 'url' (Streamable HTTP) is required",
    }),
);

export type ServerConfig = z.infer<typeof serversSchema>[string];

// Minimal Streamable HTTP client: POST one JSON-RPC message, accept either a
// direct JSON response or an SSE stream containing the response message.
// Captures/propagates the mcp-session-id header via the mutable target.
export interface HttpTarget { url: string; headers: Record<string, string>; sessionId?: string }

export async function streamableHttpRequest(
  target: HttpTarget,
  message: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown> | undefined> {
  const res = await fetch(target.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(target.sessionId ? { 'mcp-session-id': target.sessionId } : {}),
      ...target.headers,
    },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const session = res.headers.get('mcp-session-id');
  if (session) target.sessionId = session;
  if (res.status === 202) return undefined; // accepted notification
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const ct = res.headers.get('content-type') ?? '';
  const body = await res.text();
  if (ct.includes('text/event-stream')) {
    for (const line of body.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const msg = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
      if (msg.id === message.id) return msg;
    }
    throw new Error('SSE stream ended without a response message');
  }
  return body.trim() ? (JSON.parse(body) as Record<string, unknown>) : undefined;
}

interface DownstreamTool {
  name: string;
  annotations?: { readOnlyHint?: boolean };
}

export interface McpResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export interface PoolOptions {
  idleMs?: number;
  backoffMs?: number;
  spawnAttempts?: number;
}

class DownstreamServer {
  private child?: ChildProcessWithoutNullStreams;
  private http?: HttpTarget;
  private ready = false;
  private tools = new Map<string, DownstreamTool>();
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = '';
  private connecting?: Promise<void>;
  private blockedUntil = 0;
  private idleTimer?: NodeJS.Timeout;

  constructor(
    private readonly name: string,
    private readonly config: ServerConfig,
    private readonly opts: PoolOptions,
  ) {}

  async call(tool: string, args: Record<string, unknown>, deadline: number): Promise<McpResult> {
    await this.connect(deadline);
    const info = this.tools.get(tool);
    if (!info) throw new Error(`server '${this.name}' has no tool '${tool}'`);
    const admitted =
      info.annotations?.readOnlyHint === true ||
      this.config.readOnly.includes(tool) ||
      this.config.allow.includes(tool);
    if (!admitted) {
      throw new Error(
        `tool '${tool}' on server '${this.name}' is not marked read-only ` +
          `(annotations.readOnlyHint), not attested in 'readOnly', and not in its allow list — ` +
          `flows are read-only by default`,
      );
    }
    const result = (await this.request('tools/call', { name: tool, arguments: args }, deadline)) as McpResult;
    this.touchIdle();
    return result;
  }

  close(): void {
    this.teardown('pool closed');
  }

  private connect(deadline: number): Promise<void> {
    if (this.ready) return Promise.resolve();
    this.connecting ??= this.doConnect(deadline).finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  private async doConnect(deadline: number): Promise<void> {
    if (Date.now() < this.blockedUntil) {
      throw new Error(`server '${this.name}' is in respawn backoff after repeated start failures`);
    }
    const attempts = this.opts.spawnAttempts ?? 3;
    let lastError: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        await this.spawnAndHandshake(deadline);
        return;
      } catch (e) {
        lastError = e;
        this.teardown('handshake failed');
        if (Date.now() >= deadline) break;
      }
    }
    this.blockedUntil = Date.now() + (this.opts.backoffMs ?? 5_000);
    throw new Error(
      `server '${this.name}' failed to start: ${lastError instanceof Error ? lastError.message : lastError}`,
    );
  }

  private async spawnAndHandshake(deadline: number): Promise<void> {
    if (this.config.url) {
      // Remote transport: no process; interpolate url/headers from env.
      this.http = {
        url: interpolate(this.config.url, { env: process.env }),
        headers: Object.fromEntries(
          Object.entries(this.config.headers).map(([k, v]) => [k, interpolate(v, { env: process.env })]),
        ),
      };
      await this.handshake(deadline);
      return;
    }
    // Least privilege for children too: baseline env + configured vars, unless
    // the operator opts into full inheritance.
    const env: Record<string, string | undefined> = this.config.inheritEnv
      ? { ...process.env }
      : Object.fromEntries(BASELINE_ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const [key, value] of Object.entries(this.config.env)) {
      env[key] = interpolate(value, { env: process.env });
    }
    const child = spawn(this.config.command!, this.config.args, {
      env,
      shell: this.config.shell,
    });
    this.child = child;
    child.stdin.on('error', () => {}); // EPIPE surfaces via the exit handler instead
    child.on('error', (e) => this.teardown(`failed to start: ${e.message}`));
    child.on('exit', (code) => this.teardown(`exited with code ${code}`));
    child.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    child.stderr.on('data', (chunk: Buffer) => process.stderr.write(`flowmcp: [${this.name}] ${chunk}`));
    await this.handshake(deadline);
  }

  private async handshake(deadline: number): Promise<void> {
    const init = (await this.request(
      'initialize',
      {
        protocolVersion: NEWEST_PROTOCOL,
        capabilities: {},
        clientInfo: { name: 'flowmcp', version: '0.4.0' },
      },
      deadline,
    )) as { protocolVersion?: string };
    if (!PROTOCOL_REVISIONS.includes(init?.protocolVersion ?? '')) {
      throw new Error(
        `server '${this.name}' negotiated unsupported protocol version '${init?.protocolVersion}'`,
      );
    }
    this.notify('notifications/initialized');
    const listed = (await this.request('tools/list', {}, deadline)) as { tools: DownstreamTool[] };
    this.tools = new Map(listed.tools.map((t) => [t.name, t]));
    this.ready = true;
    this.touchIdle();
  }

  private async request(method: string, params: Record<string, unknown>, deadline: number): Promise<unknown> {
    if (this.http) {
      const timeoutMs = deadline - Date.now();
      if (timeoutMs <= 0) throw new Error(`no time left for server '${this.name}'`);
      const id = this.nextId++;
      const msg = await streamableHttpRequest(this.http, { jsonrpc: '2.0', id, method, params }, timeoutMs);
      if (!msg) throw new Error(`server '${this.name}': empty response to ${method}`);
      if (msg.error) throw new Error(`server '${this.name}': ${(msg.error as { message?: string }).message ?? 'error'}`);
      return msg.result;
    }
    const child = this.child;
    if (!child) return Promise.reject(new Error(`server '${this.name}' is not running`));
    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0) return Promise.reject(new Error(`no time left for server '${this.name}'`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request '${method}' to server '${this.name}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  private notify(method: string): void {
    if (this.http) {
      void streamableHttpRequest(this.http, { jsonrpc: '2.0', method }, 10_000).catch(() => {});
      return;
    }
    this.child?.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString();
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        process.stderr.write(`flowmcp: [${this.name}] non-JSON on stdout: ${line.slice(0, 120)}\n`);
        continue;
      }
      if (msg.id === undefined) continue; // downstream notification — ignore
      const pending = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (!pending) continue;
      if (msg.error) pending.reject(new Error(`server '${this.name}': ${msg.error.message ?? 'error'}`));
      else pending.resolve(msg.result);
    }
  }

  private touchIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.teardown('idle shutdown'), this.opts.idleMs ?? 300_000);
    this.idleTimer.unref();
  }

  private teardown(reason: string): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.http = undefined;
    const child = this.child;
    this.child = undefined;
    this.ready = false;
    this.tools.clear();
    this.buffer = '';
    child?.kill();
    for (const pending of this.pending.values()) {
      pending.reject(new Error(`server '${this.name}' ${reason}`));
    }
    this.pending.clear();
  }
}

export class McpPool {
  private readonly servers = new Map<string, DownstreamServer>();

  constructor(configs: Record<string, ServerConfig>, opts: PoolOptions = {}) {
    for (const [name, config] of Object.entries(configs)) {
      this.servers.set(name, new DownstreamServer(name, config, opts));
    }
  }

  has(name: string): boolean {
    return this.servers.has(name);
  }

  call(name: string, tool: string, args: Record<string, unknown>, deadline: number): Promise<McpResult> {
    const server = this.servers.get(name);
    if (!server) throw new Error(`no MCP server '${name}' configured — add it to servers.json5`);
    return server.call(tool, args, deadline);
  }

  closeAll(): void {
    for (const server of this.servers.values()) server.close();
  }
}
