// Downstream MCP clients behind ONE narrow interface, shared by the pool and
// the authoring pipeline (no more triplicated connection logic).
//
// Architectural line: FlowMCP hand-implements the MCP server surface it
// governs; for CONSUMING remote servers it uses the reference client
// transport. StdioDownstreamClient is ours (spec-stable, auditable);
// HttpDownstreamClient wraps the official SDK's StreamableHTTPClientTransport
// (pinned v1 line) — SDK types must never escape this module. Lifecycle
// policy (lazy connect, respawn/backoff, idle teardown, pool ownership)
// lives OUTSIDE these clients, in the pool.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { interpolate } from './interpolate.js';

// Protocol revisions the hand-rolled sides of this codebase support. The SDK
// client negotiates its own (current) revision for HTTP downstreams.
export const PROTOCOL_REVISIONS = ['2025-03-26', '2025-06-18', '2025-11-25'];
const NEWEST_PROTOCOL = PROTOCOL_REVISIONS[PROTOCOL_REVISIONS.length - 1]!;
const CLIENT_INFO = { name: 'flowmcp', version: '0.9.2' };

const BASELINE_ENV_KEYS =
  process.platform === 'win32'
    ? ['PATH', 'PATHEXT', 'COMSPEC', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA']
    : ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TERM'];

export interface DownstreamTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
}

export interface McpResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

export interface DownstreamClient {
  connect(deadline: number): Promise<void>; // includes the initialize handshake
  listTools(deadline: number): Promise<DownstreamTool[]>;
  callTool(name: string, args: Record<string, unknown>, deadline: number): Promise<McpResult>;
  /** May be async (HTTP: session termination). Callers that need orderly
   *  shutdown must await it; fire-and-forget is fine for teardown paths. */
  close(): void | Promise<void>;
  /** Fires once if the underlying connection dies unexpectedly. */
  onClose?: (reason: string) => void;
}

// Minimal config shape the clients need (structural subset of ServerConfig).
export interface StdioTarget {
  command: string; args: string[]; env: Record<string, string>;
  inheritEnv: boolean; shell: boolean;
  /** Working directory for the child — anchor for relative paths in
   *  command/args. Defaults to the parent's cwd when absent. */
  cwd?: string;
}
export interface HttpTarget2 { url: string; headers: Record<string, string> }

// ---------------------------------------------------------------- stdio ours
export class StdioDownstreamClient implements DownstreamClient {
  onClose?: (reason: string) => void;
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private buffer = '';
  private closed = false;

  constructor(private readonly name: string, private readonly target: StdioTarget) {}

  async connect(deadline: number): Promise<void> {
    const env: Record<string, string | undefined> = this.target.inheritEnv
      ? { ...process.env }
      : Object.fromEntries(BASELINE_ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(this.target.env)) env[k] = interpolate(v, { env: process.env });
    const child = spawn(this.target.command, this.target.args, {
      env,
      shell: this.target.shell,
      cwd: this.target.cwd,
    });
    this.child = child;
    child.stdin.on('error', () => {});
    child.on('error', (e) => this.die(`failed to start: ${e.message}`));
    child.on('exit', (code) => this.die(`exited with code ${code}`));
    child.stdout.on('data', (c: Buffer) => this.onData(c));
    child.stderr.on('data', (c: Buffer) => process.stderr.write(`flowmcp: [${this.name}] ${c}`));

    const init = (await this.request('initialize', {
      protocolVersion: NEWEST_PROTOCOL, capabilities: {}, clientInfo: CLIENT_INFO,
    }, deadline)) as { protocolVersion?: string };
    if (!PROTOCOL_REVISIONS.includes(init?.protocolVersion ?? '')) {
      throw new Error(`server '${this.name}' negotiated unsupported protocol version '${init?.protocolVersion}'`);
    }
    this.child?.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  }

  async listTools(deadline: number): Promise<DownstreamTool[]> {
    // Paginated: a first-page-only read makes later-page tools invisible and
    // fails connect-time attestation validation for perfectly valid configs.
    const all: DownstreamTool[] = [];
    let cursor: string | undefined;
    do {
      const res = (await this.request('tools/list', cursor ? { cursor } : {}, deadline)) as {
        tools: DownstreamTool[];
        nextCursor?: string;
      };
      all.push(...res.tools);
      cursor = res.nextCursor;
    } while (cursor);
    return all;
  }

  async callTool(name: string, args: Record<string, unknown>, deadline: number): Promise<McpResult> {
    return (await this.request('tools/call', { name, arguments: args }, deadline)) as McpResult;
  }

  close(): void {
    this.closed = true;
    this.die('closed');
  }

  private die(reason: string): void {
    const child = this.child;
    this.child = undefined;
    child?.kill();
    for (const p of this.pending.values()) p.reject(new Error(`server '${this.name}' ${reason}`));
    this.pending.clear();
    if (!this.closed) this.onClose?.(reason);
    this.closed = true;
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString();
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try { msg = JSON.parse(line); } catch {
        process.stderr.write(`flowmcp: [${this.name}] non-JSON on stdout: ${line.slice(0, 120)}\n`);
        continue;
      }
      if (msg.id === undefined) continue;
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (!p) continue;
      if (msg.error) p.reject(new Error(`server '${this.name}': ${msg.error.message ?? 'error'}`));
      else p.resolve(msg.result);
    }
  }

  private request(method: string, params: Record<string, unknown>, deadline: number): Promise<unknown> {
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
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
}

// ------------------------------------------------------- http via SDK client
export class HttpDownstreamClient implements DownstreamClient {
  onClose?: (reason: string) => void;
  private client?: Client;
  private transport?: StreamableHTTPClientTransport;
  private closed = false;
  // Expanded credential material (interpolated header values, URL password /
  // query values). SDK errors include downstream response bodies, and a
  // misconfigured proxy or debug page can reflect the Authorization header —
  // every error leaving this adapter is scrubbed against these.
  private secrets: string[] = [];

  constructor(private readonly name: string, private readonly target: HttpTarget2) {}

  private redact(message: string): string {
    let out = message;
    for (const s of this.secrets) out = out.split(s).join('[REDACTED]');
    return out;
  }

  private redacted(e: unknown): Error {
    return new Error(this.redact(e instanceof Error ? e.message : String(e)));
  }

  /** MCP Streamable HTTP signals an expired/unknown session as a 404. The
   *  SDK does not reinitialize; a pooled client would keep replaying the
   *  stale session forever. Tear down so the next call reconnects fresh —
   *  the failed call itself is NOT retried (it may have been a write). */
  private isSessionInvalid(e: unknown): boolean {
    const msg = e instanceof Error ? e.message : String(e);
    return /\b404\b/.test(msg) || /session/i.test(msg);
  }

  private invalidateSession(): void {
    const notify = this.onClose;
    this.onClose = undefined;
    this.client = undefined;
    this.transport = undefined;
    notify?.('session expired');
  }

  async connect(deadline: number): Promise<void> {
    const url = new URL(interpolate(this.target.url, { env: process.env }));
    const headers = Object.fromEntries(
      Object.entries(this.target.headers).map(([k, v]) => [k, interpolate(v, { env: process.env })]),
    );
    this.secrets = [
      ...Object.values(headers),
      ...(url.password ? [url.password] : []),
      ...[...url.searchParams.values()],
    ].filter((s) => s.length >= 4);
    const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers } });
    transport.onclose = () => { if (!this.closed) this.onClose?.('connection closed'); };
    const client = new Client(CLIENT_INFO);
    try {
      await client.connect(transport, { timeout: Math.max(1, deadline - Date.now()) });
    } catch (e) {
      await client.close().catch(() => {});
      throw this.redacted(e);
    }
    this.client = client;
    this.transport = transport;
  }

  async listTools(deadline: number): Promise<DownstreamTool[]> {
    if (!this.client) throw new Error(`server '${this.name}' is not connected`);
    // Paginated: attested/allowed tools on later pages must be visible or
    // connect-time validation rejects valid configs.
    const all: DownstreamTool[] = [];
    let cursor: string | undefined;
    try {
      do {
        const res = await this.client.listTools(cursor ? { cursor } : undefined, {
          timeout: Math.max(1, deadline - Date.now()),
        });
        // convert to our shape — SDK types stop here
        all.push(...res.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema as Record<string, unknown>,
          annotations: t.annotations ? { readOnlyHint: t.annotations.readOnlyHint } : undefined,
        })));
        cursor = res.nextCursor;
      } while (cursor);
    } catch (e) {
      if (this.isSessionInvalid(e)) this.invalidateSession();
      throw this.redacted(e);
    }
    return all;
  }

  async callTool(name: string, args: Record<string, unknown>, deadline: number): Promise<McpResult> {
    if (!this.client) throw new Error(`server '${this.name}' is not connected`);
    let res;
    try {
      res = await this.client.callTool({ name, arguments: args }, undefined, {
        timeout: Math.max(1, deadline - Date.now()),
      });
    } catch (e) {
      if (this.isSessionInvalid(e)) {
        this.invalidateSession();
        throw new Error(
          `server '${this.name}': session expired or invalidated (${this.redact(e instanceof Error ? e.message : String(e))}) — connection reset; retry the call`,
        );
      }
      throw this.redacted(e);
    }
    return {
      content: (res.content as McpResult['content']) ?? [],
      structuredContent: res.structuredContent,
      isError: res.isError === true,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    const transport = this.transport;
    const client = this.client;
    this.transport = undefined;
    this.client = undefined;
    if (transport) {
      // Orderly shutdown terminates the server-side session (DELETE). A 405
      // means the server doesn't support termination — that's compliant, not
      // an error. Cap it so a dead server can't hang shutdown.
      await Promise.race([
        transport.terminateSession().catch(() => {}),
        new Promise<void>((r) => setTimeout(r, 2_000).unref()),
      ]);
    }
    await client?.close().catch(() => {});
  }
}

// Factory over the discriminated server config (structural, to avoid a cycle
// with mcp-pool's zod schema).
export function createDownstreamClient(
  name: string,
  config:
    | { transport: 'stdio'; command: string; args: string[]; env: Record<string, string>; inheritEnv: boolean; shell: boolean; cwd?: string }
    | { transport: 'http'; url: string; headers: Record<string, string> },
): DownstreamClient {
  return config.transport === 'http'
    ? new HttpDownstreamClient(name, config)
    : new StdioDownstreamClient(name, config);
}
