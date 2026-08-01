// Pool of downstream MCP servers for composition (mcp_call steps).
//
// The pool owns LIFECYCLE POLICY: lazy connect on first use, kept-alive
// sessions, reconnect on unexpected death (3 attempts, then a 5s backoff
// gate), idle teardown after 5 minutes. Transport lives behind the narrow
// DownstreamClient interface (src/downstream.ts): stdio is hand-rolled,
// Streamable HTTP uses the reference SDK client — SDK types never reach here.

import { z } from 'zod';
import {
  createDownstreamClient,
  type DownstreamClient,
  type DownstreamTool,
  type McpResult,
} from './downstream.js';

export { PROTOCOL_REVISIONS } from './downstream.js';
export type { McpResult } from './downstream.js';

const IDENT = /^[a-z][a-z0-9_]*$/;

const policyFields = {
  // Write-capable tools callable by this server's flows (two-phase gated).
  allow: z.array(z.string()).default([]),
  // Operator SECURITY ASSERTION: these unannotated tools are reads. Callable,
  // and never counted write-capable. Unknown names fail at connect time.
  attestReadOnly: z.array(z.string()).default([]),
};

const stdioServerSchema = z
  .object({
    transport: z.literal('stdio').default('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string()).default({}), // values may use {{env.X}} — never inline secrets
    inheritEnv: z.boolean().default(false),
    shell: z.boolean().default(false), // Windows .cmd shims need the shell
    ...policyFields,
  })
  .strict();

const httpServerSchema = z
  .object({
    transport: z.literal('http'),
    url: z.string().min(1), // may use {{env.X}}
    headers: z.record(z.string()).default({}), // values may use {{env.X}} (auth tokens)
    ...policyFields,
  })
  .strict();

const serverEntry = z
  .preprocess(
    (raw) => {
      if (raw && typeof raw === 'object' && !('transport' in raw)) {
        return { ...raw, transport: 'url' in raw ? 'http' : 'stdio' };
      }
      return raw;
    },
    z.discriminatedUnion('transport', [stdioServerSchema, httpServerSchema]),
  )
  .refine((c) => c.allow.every((t) => !c.attestReadOnly.includes(t)), {
    message: "'allow' and 'attestReadOnly' must be disjoint — a tool is a read or a write, not both",
  });

export const serversSchema = z.record(z.string().regex(IDENT, 'server name must be snake_case'), serverEntry);
export type ServerConfig = z.infer<typeof serverEntry>;

export interface PoolOptions {
  idleMs?: number;
  backoffMs?: number;
  spawnAttempts?: number;
}

class DownstreamServer {
  private client?: DownstreamClient;
  private ready = false;
  private tools = new Map<string, DownstreamTool>();
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
      this.config.attestReadOnly.includes(tool) ||
      this.config.allow.includes(tool);
    if (!admitted) {
      throw new Error(
        `tool '${tool}' on server '${this.name}' is not marked read-only ` +
          `(annotations.readOnlyHint), not attested in 'attestReadOnly', and not in its allow list — ` +
          `flows are read-only by default`,
      );
    }
    const result = await this.client!.callTool(tool, args, deadline);
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
      throw new Error(`server '${this.name}' is in reconnect backoff after repeated failures`);
    }
    const attempts = this.opts.spawnAttempts ?? 3;
    let lastError: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        const client = createDownstreamClient(this.name, this.config);
        client.onClose = () => this.teardown('connection lost');
        await client.connect(deadline);
        const tools = await client.listTools(deadline);
        // connect-time attestation validation: a misspelled or vanished
        // attested tool is a configuration error, not a silent no-op
        const names = new Set(tools.map((t) => t.name));
        const unknown = [...this.config.attestReadOnly, ...this.config.allow].filter((t) => !names.has(t));
        if (unknown.length) {
          client.close();
          throw new Error(
            `server '${this.name}': attested/allowed tool(s) not present on the server: ${unknown.join(', ')} — re-check servers.json5`,
          );
        }
        this.client = client;
        this.tools = new Map(tools.map((t) => [t.name, t]));
        this.ready = true;
        this.touchIdle();
        return;
      } catch (e) {
        lastError = e;
        this.teardown('handshake failed');
        if (Date.now() >= deadline) break;
      }
    }
    this.blockedUntil = Date.now() + (this.opts.backoffMs ?? 5_000);
    throw new Error(
      `server '${this.name}' failed to connect: ${lastError instanceof Error ? lastError.message : lastError}`,
    );
  }

  private touchIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.teardown('idle shutdown'), this.opts.idleMs ?? 300_000);
    this.idleTimer.unref();
  }

  private teardown(reason: string): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const client = this.client;
    this.client = undefined;
    this.ready = false;
    this.tools.clear();
    if (client) {
      client.onClose = undefined;
      client.close();
    }
    void reason;
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
