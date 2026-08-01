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

describe('remote HTTP downstream (ERP-shaped, unannotated)', () => {
  let erp: ChildProcessWithoutNullStreams;
  let erpUrl = '';
  let client: RpcClient;

  beforeAll(async () => {
    erp = spawn(process.execPath, ['--import', 'tsx', 'test/fixtures/erp-http-mcp.ts'], {
      cwd: projectRoot,
      env: { ...process.env, ERP_PORT: '0', ERP_TOKEN: 'test-token-123' },
    });
    const port = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('erp mock did not start')), 10_000);
      erp.stdout.on('data', (c: Buffer) => {
        const m = /ERP_LISTENING (\d+)/.exec(c.toString());
        if (m) { clearTimeout(t); resolve(m[1]!); }
      });
    });
    erpUrl = `http://127.0.0.1:${port}`;
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
    expect(text(res)).toContain("not attested in 'readOnly'");
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

  it('surfaces auth failures instead of masking them', async () => {
    const bad = new RpcClient(spawnServer(flowsDir, { ERP_URL: erpUrl, ERP_TOKEN: 'wrong-token' }));
    await bad.request('initialize', { protocolVersion: '2025-03-26', capabilities: {} });
    const res = await bad.request('tools/call', { name: 'erp_report' });
    expect(isError(res)).toBe(true);
    expect(text(res)).toContain('401');
    bad.close();
  });
});
