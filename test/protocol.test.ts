// End-to-end: spawn the real server as a child process and speak JSON-RPC to it.
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
const badFlowsDir = join(projectRoot, 'test/fixtures/bad-flows');

describe('MCP protocol over stdio', () => {
  let fixtures: FixtureServer;
  let client: RpcClient;

  beforeAll(async () => {
    fixtures = await startFixtureServer();
    client = new RpcClient(spawnServer(flowsDir, { FIXTURE_BASE: fixtures.baseUrl }));
  });

  afterAll(async () => {
    client.close();
    await fixtures.close();
  });

  it('handshakes: initialize then notifications/initialized', async () => {
    const res = await client.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    expect(res.error).toBeUndefined();
    expect(res.result).toMatchObject({
      protocolVersion: '2025-03-26',
      serverInfo: { name: 'flowmcp' },
      capabilities: { tools: {} },
    });
    client.notify('notifications/initialized');
    const ping = await client.request('ping');
    expect(ping.result).toEqual({});
  });

  it('lists one tool per flow with a small input schema', async () => {
    const res = await client.request('tools/list');
    const tools = res.result!.tools as Array<Record<string, unknown>>;
    expect(tools.map((t) => t.name).sort()).toEqual(['always_fails', 'morning_brief']);
    const brief = tools.find((t) => t.name === 'morning_brief')!;
    expect(brief.inputSchema).toEqual({
      type: 'object',
      properties: { city: { type: 'string', description: 'City for the weather section' } },
    });
  });

  it('runs morning_brief end to end against fixtures', async () => {
    const res = await client.request('tools/call', {
      name: 'morning_brief',
      arguments: { city: 'Testville' },
    });
    const result = res.result as { content: [{ text: string }]; isError?: boolean };
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain('# Morning brief — Testville, Testland');
    expect(text).toContain('High 30.1°C / low 20.2°C, 15% chance of rain.');
    expect(text).toContain('- **Story 101** — 101 points https://example.com/101');
    expect(text).toContain('- **Story 105** — 105 points https://example.com/105');
    expect(text).not.toContain('Story 106');
  });

  it('applies input defaults when arguments are omitted', async () => {
    const res = await client.request('tools/call', { name: 'morning_brief' });
    const result = res.result as { content: [{ text: string }] };
    expect(result.content[0].text).toContain('New York, Testland');
  });

  it('returns a structured isError result when a step fails', async () => {
    const res = await client.request('tools/call', { name: 'always_fails', arguments: {} });
    const result = res.result as { content: [{ text: string }]; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("failed at step 'boom'");
    expect(result.content[0].text).toContain('HTTP 500');
  });

  it('returns isError for unknown parameters so the model can self-correct', async () => {
    const res = await client.request('tools/call', {
      name: 'morning_brief',
      arguments: { town: 'Berlin' },
    });
    const result = res.result as { content: [{ text: string }]; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("unknown parameter 'town'");
    expect(result.content[0].text).toContain('city');
  });

  it('rejects unknown tools and unknown methods with JSON-RPC errors', async () => {
    const unknownTool = await client.request('tools/call', { name: 'nope', arguments: {} });
    expect(unknownTool.error?.code).toBe(-32602);
    const unknownMethod = await client.request('resources/list');
    expect(unknownMethod.error?.code).toBe(-32601);
  });

  it('refuses to start when a flow file is invalid, naming the file', async () => {
    const child = spawnServer(badFlowsDir);
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    expect(code).toBe(1);
    expect(stderr).toContain('broken.flow.json5');
    expect(stderr).toContain('at most 3 input parameters');
  });
});
