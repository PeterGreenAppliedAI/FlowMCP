// Composition end-to-end: flowmcp spawns real downstream MCP servers
// (the mock in test/fixtures/mock-mcp.ts, plus a second flowmcp instance)
// and mcp_call steps drive them through the actual protocol.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { projectRoot, RpcClient, spawnServer } from './helpers.js';

const flowsDir = join(projectRoot, 'test/fixtures/flows');
const badServerRefDir = join(projectRoot, 'test/fixtures/bad-server-ref');

function callResult(res: { result?: Record<string, unknown> }) {
  return res.result as { content: [{ text: string }]; isError?: boolean };
}

describe('composition via mcp_call', () => {
  let client: RpcClient;

  beforeAll(async () => {
    // TEST_SECRET is planted in the flowmcp process env; downstream children
    // must not see it unless their server config opts into inheritEnv.
    client = new RpcClient(spawnServer(flowsDir, { TEST_SECRET: 'leaked-if-visible' }));
    await client.request('initialize', { protocolVersion: '2025-03-26', capabilities: {} });
    client.notify('notifications/initialized');
  });

  afterAll(() => {
    client.close();
  });

  it('round-trips interpolated args through a downstream tool and parses JSON results', async () => {
    const res = await client.request('tools/call', {
      name: 'mcp_echo',
      arguments: { msg: 'ping from a flow' },
    });
    const result = callResult(res);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe('echoed: ping from a flow');
  });

  it('blocks non-read-only tools by default (no readOnlyHint, not allowlisted)', async () => {
    const res = await client.request('tools/call', { name: 'mcp_write_blocked' });
    const result = callResult(res);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not marked read-only');
    expect(result.content[0].text).toContain('allow list');
  });

  it('permits an allowlisted write tool — behind the approval gate', async () => {
    const proposal = callResult(await client.request('tools/call', { name: 'mcp_write_allowed' }));
    expect(proposal.isError).toBeUndefined();
    expect(proposal.content[0].text).toContain('Nothing has been written yet');
    const token = /"confirm": "([0-9a-f-]+)"/.exec(proposal.content[0].text)![1];
    const confirmed = callResult(
      await client.request('tools/call', { name: 'mcp_write_allowed', arguments: { confirm: token } }),
    );
    expect(confirmed.isError).toBeUndefined();
    expect(confirmed.content[0].text).toBe('wrote!');
  });

  it('caps oversized downstream results at maxResultChars', async () => {
    const res = await client.request('tools/call', { name: 'mcp_big' });
    const result = callResult(res);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text.length).toBeLessThan(9_000);
    expect(result.content[0].text).toContain('…[truncated 42000 chars]');
  });

  it('applies the step timeout to the whole downstream call', async () => {
    const res = await client.request('tools/call', { name: 'mcp_slow' });
    const result = callResult(res);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('timed out');
  });

  it('fails cleanly when the downstream server crashes, then respawns it on the next call', async () => {
    const crash = callResult(await client.request('tools/call', { name: 'mcp_crash' }));
    expect(crash.isError).toBe(true);
    expect(crash.content[0].text).toContain('exited');

    const after = callResult(
      await client.request('tools/call', { name: 'mcp_echo', arguments: { msg: 'still alive' } }),
    );
    expect(after.isError).toBeUndefined();
    expect(after.content[0].text).toBe('echoed: still alive');
  });

  it('does not leak the parent environment to downstream children by default', async () => {
    const res = await client.request('tools/call', { name: 'mcp_env_probe' });
    const result = callResult(res);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe('secret=[]');
  });

  it('passes the parent environment through when inheritEnv is opted in', async () => {
    const res = await client.request('tools/call', { name: 'mcp_env_inherit' });
    const result = callResult(res);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe('secret=[leaked-if-visible]');
  });

  it('dogfoods: a flowmcp flow calls a flow on another flowmcp instance', async () => {
    const res = await client.request('tools/call', { name: 'mcp_dogfood' });
    const result = callResult(res);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe('hello from the inner flowmcp');
  });

  it('refuses to start when a flow references an unregistered MCP server', async () => {
    const child = spawnServer(badServerRefDir);
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    expect(code).toBe(1);
    expect(stderr).toContain("unknown MCP server 'ghost'");
  });
});
