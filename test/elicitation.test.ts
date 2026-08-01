// Elicitation (v0.5): when the client advertises the capability, the server
// mediates write approval and missing-parameter asks through the HOST via
// elicitation/create — the model never holds a consumable confirm token.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { projectRoot, RpcClient, spawnServer, startFixtureServer, type FixtureServer } from './helpers.js';

const flowsDir = join(projectRoot, 'test/fixtures/flows');

function text(res: { result?: Record<string, unknown> }) {
  return (res.result as { content: [{ text: string }]; isError?: boolean }).content[0].text;
}

describe('elicitation-capable client', () => {
  let fixtures: FixtureServer;
  let client: RpcClient;
  const seen: Array<{ method: string; params: Record<string, unknown> }> = [];

  beforeAll(async () => {
    fixtures = await startFixtureServer();
    client = new RpcClient(spawnServer(flowsDir, { FIXTURE_BASE: fixtures.baseUrl }));
    client.onServerRequest = (method, params) => {
      seen.push({ method, params });
      const schema = params.requestedSchema as { properties: Record<string, unknown> };
      if ('approve' in schema.properties) return { action: 'accept', content: { approve: true } };
      if ('msg' in schema.properties) return { action: 'accept', content: { msg: 'from-elicitation' } };
      return { action: 'decline' };
    };
    await client.request('initialize', { protocolVersion: '2025-03-26', capabilities: { elicitation: {} } });
    client.notify('notifications/initialized');
  });

  afterAll(async () => {
    client.close();
    await fixtures.close();
  });

  it('mediates write approval through the host — no token in band', async () => {
    seen.length = 0;
    const before = (await fetch(`${fixtures.baseUrl}/post-count`).then((r) => r.json())) as { count: number };
    const res = await client.request('tools/call', { name: 'post_write', arguments: { msg: 'via host' } });
    expect((res.result as { isError?: boolean }).isError).toBeUndefined();
    expect(text(res)).toBe('posted: via host');
    expect(text(res)).not.toContain('confirm'); // no token dance
    expect(seen.some((s) => s.method === 'elicitation/create' && String(s.params.message).includes('post_write'))).toBe(true);
    const after = (await fetch(`${fixtures.baseUrl}/post-count`).then((r) => r.json())) as { count: number };
    expect(after.count).toBe(before.count + 1);
  });

  it('declined elicitation writes nothing', async () => {
    const declining = new RpcClient(spawnServer(flowsDir, { FIXTURE_BASE: fixtures.baseUrl }));
    declining.onServerRequest = () => ({ action: 'decline' });
    await declining.request('initialize', { protocolVersion: '2025-03-26', capabilities: { elicitation: {} } });
    const before = (await fetch(`${fixtures.baseUrl}/post-count`).then((r) => r.json())) as { count: number };
    const res = await declining.request('tools/call', { name: 'post_write', arguments: { msg: 'never' } });
    expect(text(res)).toContain('Declined');
    const after = (await fetch(`${fixtures.baseUrl}/post-count`).then((r) => r.json())) as { count: number };
    expect(after.count).toBe(before.count);
    declining.close();
  });

  it('elicits missing required parameters instead of erroring', async () => {
    seen.length = 0;
    const res = await client.request('tools/call', { name: 'post_write', arguments: {} });
    expect(text(res)).toBe('posted: from-elicitation');
    // two elicitations: the missing param, then the write approval
    expect(seen.filter((s) => s.method === 'elicitation/create').length).toBe(2);
  });

  it('non-capable clients keep the v0.3 token protocol', async () => {
    const plain = new RpcClient(spawnServer(flowsDir, { FIXTURE_BASE: fixtures.baseUrl }));
    await plain.request('initialize', { protocolVersion: '2025-03-26', capabilities: {} });
    const res = await plain.request('tools/call', { name: 'post_write', arguments: { msg: 'token path' } });
    expect(text(res)).toContain('"confirm"');
    plain.close();
  });
});
