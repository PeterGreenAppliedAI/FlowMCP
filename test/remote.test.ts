// Remote enterprise process: Streamable HTTP transport, bearer auth, operator
// attestation for unannotated reads, allow-listed writes behind the two-phase
// gate — the full governance chain over the wire against an ERP-shaped mock.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';
import { projectRoot, RpcClient, spawnServer } from './helpers.js';

const flowsDir = join(projectRoot, 'test/fixtures/erp-flows');

function text(res: { result?: Record<string, unknown> }) {
  return (res.result as { content: [{ text: string }]; isError?: boolean }).content[0].text;
}
function isError(res: { result?: Record<string, unknown> }) {
  return (res.result as { isError?: boolean }).isError;
}

async function startErp(token = 'test-token-123', extraEnv: Record<string, string> = {}): Promise<{ proc: ChildProcessWithoutNullStreams; url: string }> {
  const proc = spawn(process.execPath, ['--import', 'tsx', 'test/fixtures/erp-http-mcp.ts'], {
    cwd: projectRoot,
    env: { ...process.env, ERP_PORT: '0', ERP_TOKEN: token, ...extraEnv },
  });
  const port = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('erp mock did not start')), 10_000);
    proc.stdout.on('data', (c: Buffer) => {
      const m = /ERP_LISTENING (\d+)/.exec(c.toString());
      if (m) { clearTimeout(t); resolve(m[1]!); }
    });
  });
  return { proc, url: `http://127.0.0.1:${port}` };
}

async function sessionCount(url: string): Promise<{ active: number; terminated: number; deleteAttempts: number }> {
  return (await fetch(`${url}/session-count`).then((r) => r.json())) as { active: number; terminated: number; deleteAttempts: number };
}

describe('remote HTTP downstream (ERP-shaped, unannotated)', () => {
  let erp: ChildProcessWithoutNullStreams;
  let erpUrl = '';
  let client: RpcClient;

  beforeAll(async () => {
    const started = await startErp();
    erp = started.proc;
    erpUrl = started.url;
    client = new RpcClient(spawnServer(flowsDir, { ERP_URL: erpUrl, ERP_TOKEN: 'test-token-123' }));
    await client.request('initialize', { protocolVersion: '2025-03-26', capabilities: {} });
    client.notify('notifications/initialized');
  });

  afterAll(() => {
    client.close();
    erp.kill();
  });

  it('computes effects correctly: attested reads are read-only, allow-listed writes are not', async () => {
    const res = await client.request('tools/list');
    const tools = res.result!.tools as Array<{ name: string; annotations: Record<string, boolean>; inputSchema: { properties: Record<string, unknown> } }>;
    const report = tools.find((t) => t.name === 'erp_report')!;
    expect(report.annotations.readOnlyHint).toBe(true); // attestation is NOT write-capability
    const post = tools.find((t) => t.name === 'erp_post_invoice')!;
    expect(post.annotations.readOnlyHint).toBe(false);
    expect(post.inputSchema.properties.confirm).toBeDefined();
  });

  it('executes attested unannotated reads over Streamable HTTP with bearer auth', async () => {
    const res = await client.request('tools/call', { name: 'erp_report' });
    expect(isError(res)).toBeUndefined();
    expect(text(res)).toBe('Overdue: INV-77 (1250.5) owed by Acme Pest Co');
  });

  it('refuses unannotated, unattested tools fail-closed', async () => {
    const res = await client.request('tools/call', { name: 'erp_blocked' });
    expect(isError(res)).toBe(true);
    expect(text(res)).toContain("not attested in 'attestReadOnly'");
  });

  it('gates the remote write behind two-phase confirmation, then executes exactly once', async () => {
    const before = (await fetch(`${erpUrl}/posted-count`).then((r) => r.json())) as { posted: number };
    const proposal = await client.request('tools/call', { name: 'erp_post_invoice' });
    expect(isError(proposal)).toBeUndefined();
    expect(text(proposal)).toContain('About to post invoice INV-77 for 1250.5');
    const mid = (await fetch(`${erpUrl}/posted-count`).then((r) => r.json())) as { posted: number };
    expect(mid.posted).toBe(before.posted); // nothing written at proposal time
    const token = /"confirm": "([0-9a-f-]+)"/.exec(text(proposal))![1];
    const confirmed = await client.request('tools/call', { name: 'erp_post_invoice', arguments: { confirm: token } });
    expect(isError(confirmed)).toBeUndefined();
    expect(text(confirmed)).toContain('posted INV-77');
    const after = (await fetch(`${erpUrl}/posted-count`).then((r) => r.json())) as { posted: number };
    expect(after.posted).toBe(before.posted + 1);
  });

  it('rejects overlapping attestReadOnly and allow at config load', async () => {
    const { serversSchema } = await import('../src/mcp-pool.js');
    const bad = serversSchema.safeParse({
      erp: { url: 'http://x', attestReadOnly: ['post_invoice'], allow: ['post_invoice'] },
    });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toContain('disjoint');
  });

  it('fails at connect when an attested tool does not exist on the server', async () => {
    const { McpPool } = await import('../src/mcp-pool.js');
    const { serversSchema } = await import('../src/mcp-pool.js');
    const cfg = serversSchema.parse({
      erp: { url: `${erpUrl}`, headers: { Authorization: 'Bearer test-token-123' }, attestReadOnly: ['list_customerz'] },
    });
    const pool = new McpPool(cfg);
    await expect(pool.call('erp', 'list_customerz', {}, Date.now() + 15_000)).rejects.toThrow(/not present on the server: list_customerz/);
    pool.closeAll();
  });

  it('drift pin: matching attestHash connects; mismatch refuses until re-review', async () => {
    const { McpPool, serversSchema } = await import('../src/mcp-pool.js');
    const base = { url: erpUrl, headers: { Authorization: 'Bearer test-token-123' }, attestReadOnly: ['list_customers'] };
    // capture the real hash from the unpinned-connect stderr guidance path:
    // easier — connect pinned-wrong and read the current hash from the error
    const wrong = new McpPool(serversSchema.parse({ erp: { ...base, attestHash: 'deadbeefdeadbeef' } }));
    const err = await wrong.call('erp', 'list_customers', {}, Date.now() + 15_000).catch((e: Error) => e.message);
    wrong.closeAll();
    expect(err).toContain('attestHash mismatch');
    const current = /current ([0-9a-f]{16})/.exec(String(err))![1]!;
    const pinned = new McpPool(serversSchema.parse({ erp: { ...base, attestHash: current } }));
    const res = await pinned.call('erp', 'list_customers', {}, Date.now() + 15_000);
    pinned.closeAll();
    expect(res.isError).toBeFalsy();
  });

  it('never echoes the bearer token in error surfaces', async () => {
    const bad = new RpcClient(spawnServer(flowsDir, { ERP_URL: erpUrl, ERP_TOKEN: 'secret-credential-xyz' }));
    await bad.request('initialize', { protocolVersion: '2025-03-26', capabilities: {} });
    const res = await bad.request('tools/call', { name: 'erp_report' });
    expect(isError(res)).toBe(true);
    expect(text(res)).not.toContain('secret-credential-xyz');
    bad.close();
  });

  it('chains paginated reads via nextPage refs', async () => {
    const res = await client.request('tools/call', { name: 'erp_orders' });
    expect(isError(res)).toBeUndefined();
    expect(text(res)).toBe('orders: SO-1 SO-2 SO-3 SO-4 (next: )');
  });

  it('surfaces a downstream 500 as a clear step failure', async () => {
    const res = await client.request('tools/call', { name: 'erp_flaky' });
    expect(isError(res)).toBe(true);
    expect(text(res)).toContain("failed at step 'boom'");
  });

  it('fails loudly with the path on empty result sets', async () => {
    const res = await client.request('tools/call', { name: 'erp_empty' });
    expect(isError(res)).toBe(true);
    expect(text(res)).toMatch(/cannot read .* of undefined .*invoices/);
  });

  it('surfaces 403 (expired token) distinctly', async () => {
    const bad = new RpcClient(spawnServer(flowsDir, { ERP_URL: erpUrl, ERP_TOKEN: 'expired-token' }));
    await bad.request('initialize', { protocolVersion: '2025-03-26', capabilities: {} });
    const res = await bad.request('tools/call', { name: 'erp_report' });
    expect(isError(res)).toBe(true);
    expect(text(res)).toMatch(/403|expired/i);
    bad.close();
  });

  it('surfaces auth failures instead of masking them', async () => {
    const bad = new RpcClient(spawnServer(flowsDir, { ERP_URL: erpUrl, ERP_TOKEN: 'wrong-token' }));
    await bad.request('initialize', { protocolVersion: '2025-03-26', capabilities: {} });
    const res = await bad.request('tools/call', { name: 'erp_report' });
    expect(isError(res)).toBe(true);
    expect(text(res)).toMatch(/401|unauthorized/i);
    bad.close();
  });

  // NOTE: the whole suite above is also the pagination regression — the ERP
  // mock serves tools/list in two pages, and erp_report's attested tool
  // (list_overdue_invoices) lives on page 2. A first-page-only client fails
  // every test in this file at connect-time validation.

  it('closes failed connection candidates: no leaked sessions after connect failures', async () => {
    const { proc, url } = await startErp();
    try {
      const { McpPool, serversSchema } = await import('../src/mcp-pool.js');
      const cfg = serversSchema.parse({
        erp: { url, headers: { Authorization: 'Bearer test-token-123' }, attestReadOnly: ['no_such_tool'] },
      });
      const pool = new McpPool(cfg);
      await expect(pool.call('erp', 'no_such_tool', {}, Date.now() + 15_000)).rejects.toThrow(/not present on the server/);
      await pool.closeAll();
      // every failed attempt initialized a session; every one must be closed
      const s = await sessionCount(url);
      expect(s.active).toBe(0);
      expect(s.terminated).toBeGreaterThanOrEqual(3); // one per connect attempt
    } finally {
      proc.kill();
    }
  });

  it('detects an expired session, resets the connection, and recovers on the next call', async () => {
    const { proc, url } = await startErp();
    try {
      const { McpPool, serversSchema } = await import('../src/mcp-pool.js');
      const cfg = serversSchema.parse({
        erp: { url, headers: { Authorization: 'Bearer test-token-123' }, attestReadOnly: ['list_customers'] },
      });
      const pool = new McpPool(cfg);
      const first = await pool.call('erp', 'list_customers', {}, Date.now() + 15_000);
      expect(first.isError).toBeFalsy();
      await fetch(`${url}/expire-sessions`, { method: 'POST' }); // server-side expiry
      const attemptsBefore = (await sessionCount(url)).deleteAttempts;
      // the poisoned call fails LOUDLY (never silently replays a stale session,
      // never blindly retries — it might have been a write) ...
      await expect(pool.call('erp', 'list_customers', {}, Date.now() + 15_000))
        .rejects.toThrow(/session expired|404/i);
      // ... invalidation CLOSED the discarded client (the wrapper's handles
      // are the only ones — clearing them first would leak the SDK client;
      // the DELETE attempt against the already-expired session proves the
      // cleanup path actually ran) ...
      expect((await sessionCount(url)).deleteAttempts).toBeGreaterThan(attemptsBefore);
      // ... and the very next call reconnects with a fresh session and works
      const recovered = await pool.call('erp', 'list_customers', {}, Date.now() + 15_000);
      expect(recovered.isError).toBeFalsy();
      expect((await sessionCount(url)).active).toBe(1); // exactly the fresh one
      await pool.closeAll();
    } finally {
      proc.kill();
    }
  });

  it('redacts reflected credentials from SDK error surfaces', async () => {
    // reflect_500 echoes the Authorization header in its error body, the way
    // misconfigured proxies do; the SDK puts response bodies into error
    // messages. The adapter must scrub them before they reach model or logs.
    // (reflect_500 also sits on tools/list page 2 — attesting it doubles as
    // an explicit later-page validation check.)
    const { McpPool, serversSchema } = await import('../src/mcp-pool.js');
    const cfg = serversSchema.parse({
      erp: { url: erpUrl, headers: { Authorization: 'Bearer test-token-123' }, attestReadOnly: ['reflect_500'] },
    });
    const pool = new McpPool(cfg);
    const err = await pool.call('erp', 'reflect_500', {}, Date.now() + 15_000).catch((e: Error) => e.message);
    await pool.closeAll();
    expect(String(err)).toContain('internal error'); // the failure still surfaces
    expect(String(err)).not.toContain('test-token-123');
    expect(String(err)).toContain('[REDACTED]');
  });

  it('ordinary tool 500s with session-y error text do NOT invalidate the connection', async () => {
    // flaky_500's body deliberately says "customer 404 not found; reporting
    // session unavailable" — a REST wrapper's error text must never be
    // mistaken for MCP session expiry (detection is typed on transport status)
    const { proc, url } = await startErp();
    try {
      const { McpPool, serversSchema } = await import('../src/mcp-pool.js');
      const cfg = serversSchema.parse({
        erp: { url, headers: { Authorization: 'Bearer test-token-123' }, attestReadOnly: ['flaky_500', 'list_customers'] },
      });
      const pool = new McpPool(cfg);
      await pool.call('erp', 'list_customers', {}, Date.now() + 15_000);
      await expect(pool.call('erp', 'flaky_500', {}, Date.now() + 15_000)).rejects.toThrow(/internal error/);
      // same session still alive and reused — no teardown, no reconnect
      const again = await pool.call('erp', 'list_customers', {}, Date.now() + 15_000);
      expect(again.isError).toBeFalsy();
      const s = await sessionCount(url);
      expect(s.active).toBe(1); // the ORIGINAL session — a reconnect would have made a second
      expect(s.deleteAttempts).toBe(0);
      await pool.closeAll();
    } finally {
      proc.kill();
    }
  });

  it('initialization failure after a session id was issued still terminates it', async () => {
    // The server allocates the session, then the handshake fails client-side
    // (unsupported protocol version). The SDK closes the transport before
    // rethrowing, so cleanup must run over an independent request path.
    const { proc, url } = await startErp('test-token-123', { ERP_BAD_INIT: '1' });
    try {
      const { McpPool, serversSchema } = await import('../src/mcp-pool.js');
      const cfg = serversSchema.parse({
        erp: { url, headers: { Authorization: 'Bearer test-token-123' }, attestReadOnly: ['list_customers'] },
      });
      const pool = new McpPool(cfg);
      await expect(pool.call('erp', 'list_customers', {}, Date.now() + 15_000)).rejects.toThrow();
      await pool.closeAll();
      const s = await sessionCount(url);
      expect(s.active).toBe(0); // every issued session was cleaned up
      expect(s.terminated).toBeGreaterThanOrEqual(3); // one DELETE per connect attempt, and they REACHED the server
    } finally {
      proc.kill();
    }
  });

  it('orderly shutdown terminates the server-side session', async () => {
    const { proc, url } = await startErp();
    try {
      const { McpPool, serversSchema } = await import('../src/mcp-pool.js');
      const cfg = serversSchema.parse({
        erp: { url, headers: { Authorization: 'Bearer test-token-123' }, attestReadOnly: ['list_customers'] },
      });
      const pool = new McpPool(cfg);
      await pool.call('erp', 'list_customers', {}, Date.now() + 15_000);
      expect((await sessionCount(url)).active).toBe(1);
      await pool.closeAll(); // awaitable: DELETE reaches the server before we move on
      const s = await sessionCount(url);
      expect(s.active).toBe(0);
      expect(s.terminated).toBe(1);
    } finally {
      proc.kill();
    }
  });
});
