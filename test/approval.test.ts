// Write-action flows: the approval gate. A flow containing a write step (POST
// or allowlisted mcp_call) must pause before the first write, return a
// proposal + token, and only execute the write when called again with confirm.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  projectRoot,
  RpcClient,
  spawnServer,
  startFixtureServer,
  type FixtureServer,
} from './helpers.js';

const flowsDir = join(projectRoot, 'test/fixtures/flows');

function text(res: { result?: Record<string, unknown> }) {
  return (res.result as { content: [{ text: string }]; isError?: boolean }).content[0].text;
}
function isError(res: { result?: Record<string, unknown> }) {
  return (res.result as { isError?: boolean }).isError;
}
const tokenFrom = (t: string) => /"confirm": "([0-9a-f-]+)"/.exec(t)?.[1];

describe('approval gate for write flows', () => {
  let fixtures: FixtureServer;
  let client: RpcClient;

  beforeAll(async () => {
    fixtures = await startFixtureServer();
    client = new RpcClient(spawnServer(flowsDir, { FIXTURE_BASE: fixtures.baseUrl }));
    await client.request('initialize', { protocolVersion: '2025-03-26', capabilities: {} });
    client.notify('notifications/initialized');
  });

  afterAll(async () => {
    client.close();
    await fixtures.close();
  });

  it('advertises a confirm parameter on write flows only', async () => {
    const res = await client.request('tools/list');
    const tools = res.result!.tools as Array<{
      name: string;
      inputSchema: { properties: Record<string, unknown> };
    }>;
    expect(tools.find((t) => t.name === 'post_write')!.inputSchema.properties.confirm).toBeDefined();
    expect(tools.find((t) => t.name === 'approval_demo')!.inputSchema.properties.confirm).toBeDefined();
    expect(tools.find((t) => t.name === 'morning_brief')!.inputSchema.properties.confirm).toBeUndefined();
  });

  it('pauses before the write, runs reads first, and renders the custom proposal', async () => {
    const res = await client.request('tools/call', { name: 'approval_demo' });
    expect(isError(res)).toBeUndefined();
    const t = text(res);
    expect(t).toContain('About to write. Read phase saw: pre-write'); // read step already ran
    expect(t).toContain('Nothing has been written yet');
    const token = tokenFrom(t);
    expect(token).toBeDefined();

    const confirmed = await client.request('tools/call', {
      name: 'approval_demo',
      arguments: { confirm: token },
    });
    expect(isError(confirmed)).toBeUndefined();
    expect(text(confirmed)).toBe('write result: wrote!');
  });

  it('does not execute a POST until confirmed, then exactly once', async () => {
    const before = await fetch(`${fixtures.baseUrl}/post-count`).then((r) => r.json());
    const proposal = await client.request('tools/call', {
      name: 'post_write',
      arguments: { msg: 'hello world' },
    });
    expect(isError(proposal)).toBeUndefined();
    const mid = await fetch(`${fixtures.baseUrl}/post-count`).then((r) => r.json());
    expect(mid.count).toBe(before.count); // proposal phase must not write

    const token = tokenFrom(text(proposal))!;
    const confirmed = await client.request('tools/call', {
      name: 'post_write',
      arguments: { confirm: token },
    });
    expect(text(confirmed)).toBe('posted: hello world');
    const after = await fetch(`${fixtures.baseUrl}/post-count`).then((r) => r.json());
    expect(after.count).toBe(before.count + 1);
  });

  it('rejects unknown tokens and refuses token reuse', async () => {
    const bad = await client.request('tools/call', {
      name: 'post_write',
      arguments: { confirm: 'not-a-real-token' },
    });
    expect(isError(bad)).toBe(true);
    expect(text(bad)).toContain('No pending approval');

    const proposal = await client.request('tools/call', {
      name: 'post_write',
      arguments: { msg: 'once only' },
    });
    const token = tokenFrom(text(proposal))!;
    const first = await client.request('tools/call', {
      name: 'post_write',
      arguments: { confirm: token },
    });
    expect(isError(first)).toBeUndefined();
    const reuse = await client.request('tools/call', {
      name: 'post_write',
      arguments: { confirm: token },
    });
    expect(isError(reuse)).toBe(true); // single use
  });

  it("rejects a token minted for a different flow", async () => {
    const proposal = await client.request('tools/call', {
      name: 'post_write',
      arguments: { msg: 'wrong flow' },
    });
    const token = tokenFrom(text(proposal))!;
    const crossed = await client.request('tools/call', {
      name: 'approval_demo',
      arguments: { confirm: token },
    });
    expect(isError(crossed)).toBe(true);
  });

  it('read-only flows are untouched by the gate', async () => {
    const res = await client.request('tools/call', {
      name: 'morning_brief',
      arguments: { city: 'Gateville' },
    });
    expect(isError(res)).toBeUndefined();
    expect(text(res)).toContain('Gateville');
    expect(text(res)).not.toContain('confirm');
  });
});
