// `absent` (v0.11): a read step whose "not found" is data, not a failure.
// Motivated by the 2026-10-18 authored GitHub flow: a repo with no releases
// 404s on repos_get-latest-release, and the whole flow failed. The option
// chosen is the narrow one: declared 4xx statuses only, reads only, and
// 'any-error' only as an explicit opt-in for MCP tools, which report no status.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { projectRoot } from './helpers.js';
import { executeFlow } from '../src/engine.js';
import { flowSchema } from '../src/flow-schema.js';
import { checkAbsentSteps } from '../src/loader.js';
import { McpPool, serversSchema } from '../src/mcp-pool.js';

let api: Server;
let apiUrl = '';
beforeAll(async () => {
  api = createServer((req, res) => {
    const json = (status: number, body: unknown) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
    if (req.url === '/api/pets/p1') return json(200, { id: 'p1', name: 'Rex' });
    if (req.url === '/api/pets/broken') return json(500, { error: 'database down' });
    if (req.url === '/api/pets/locked') return json(401, { error: 'bad credentials' });
    json(404, { error: 'not found' });
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  apiUrl = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => api.close(() => r())));

const servers = () => serversSchema.parse({
  pets: { openapi: join(projectRoot, 'test/fixtures/openapi-flows/pets.openapi.json'), baseUrl: `${apiUrl}/api`, attestReadOnly: [] },
  mock: { command: process.execPath, args: ['x.js'] },
});

// "show the pet if there is one" — absent → null → branch picks the fallback
const petFlow = (absent: unknown, extra: Record<string, unknown> = {}) => flowSchema.parse({
  name: 'pet_card', description: 'WHEN TO USE: show a pet card.',
  input: { id: { type: 'string', description: 'pet id', required: true } },
  steps: [
    { id: 'pet', kind: 'mcp_call', server: 'pets', tool: 'getPet', args: { petId: '{{input.id}}' }, absent, ...extra },
    { id: 'card', kind: 'branch', if: 'steps.pet == null',
      then: [{ id: 'msg', kind: 'template', template: 'No pet {{input.id}}.' }],
      else: [{ id: 'msg2', kind: 'template', template: 'Pet: {{steps.pet.name}}' }] },
  ],
  output: '{{steps.msg}}{{steps.msg2}}',
});

describe('absent: declared "not found" is data', () => {
  it('an OpenAPI 404 becomes null, the branch renders the fallback, and the run reports it', async () => {
    const pool = new McpPool(servers(), { baseDir: projectRoot });
    try {
      const flow = petFlow([404]);
      const hit = await executeFlow(flow, { id: 'p1' }, { mcp: pool });
      expect(hit).toEqual({ status: 'complete', text: 'Pet: Rex' }); // nothing absent → no field
      const miss = await executeFlow(flow, { id: 'nope' }, { mcp: pool });
      expect(miss).toEqual({ status: 'complete', text: 'No pet nope.', absent: ['pet'] });
    } finally {
      await pool.closeAll();
    }
  });

  it('an outage or an auth failure still fails the flow', async () => {
    const pool = new McpPool(servers(), { baseDir: projectRoot });
    try {
      await expect(executeFlow(petFlow([404]), { id: 'broken' }, { mcp: pool })).rejects.toThrow(/HTTP 500/);
      await expect(executeFlow(petFlow([404]), { id: 'locked' }, { mcp: pool })).rejects.toThrow(/HTTP 401/);
    } finally {
      await pool.closeAll();
    }
  });

  it('error TEXT never counts: an MCP server saying "HTTP 404" is still a failure', async () => {
    const lying = { has: () => true, call: async () => ({ isError: true, content: [{ type: 'text', text: 'HTTP 404 Not Found', httpStatus: 404 }], httpStatus: 404 }) };
    await expect(executeFlow(petFlow([404]), { id: 'x' }, { mcp: lying as never })).rejects.toThrow(/returned an error/);
  });

  it("'any-error' (explicit MCP opt-in) covers an isError result, but not a thrown failure", async () => {
    const flow = petFlow('any-error');
    const soft = { has: () => true, call: async () => ({ isError: true, content: [{ type: 'text', text: 'no such pet' }] }) };
    expect(await executeFlow(flow, { id: 'x' }, { mcp: soft as never })).toMatchObject({ text: 'No pet x.', absent: ['pet'] });
    const down = { has: () => true, call: async () => { throw new Error('connection refused'); } };
    await expect(executeFlow(flow, { id: 'x' }, { mcp: down as never })).rejects.toThrow(/connection refused/);
  });

  it('http_request: a declared 404 is null; inside map each absent item is null and named', async () => {
    const flow = flowSchema.parse({
      name: 'pets_many', description: 'WHEN TO USE: several pets.',
      steps: [
        { id: 'ids', kind: 'transform', expr: "['p1', 'gone']" },
        { id: 'pets', kind: 'map', over: 'steps.ids', as: 'pid',
          step: { kind: 'http_request', url: `${apiUrl}/api/pets/{{pid}}`, absent: [404] } },
      ],
      output: '{{steps.pets}}',
    });
    const run = await executeFlow(flow, {});
    expect(run).toMatchObject({ status: 'complete', absent: ['pets[1]'] });
    expect((run as { text: string }).text).toContain('"name":"Rex"');
  });
});

describe('absent: refused where it would hide too much', () => {
  const check = (step: Record<string, unknown>, extraServers: Record<string, unknown> = {}) => () => checkAbsentSteps(
    [flowSchema.parse({ name: 'f', description: 'WHEN TO USE: t.', steps: [{ id: 's', ...step }], output: 'x' })],
    { ...servers(), ...serversSchema.parse(extraServers) },
  );

  it('refuses absent on a write step', () => {
    expect(check({ kind: 'http_request', method: 'POST', url: 'http://x.invalid/', absent: [404] })).toThrow(/is a write/);
    expect(check({ kind: 'mcp_call', server: 'w', tool: 'post_invoice', absent: 'any-error' },
      { w: { command: 'node', args: ['x.js'], allow: ['post_invoice'] } })).toThrow(/is a write/);
  });

  it("refuses 'any-error' where HTTP statuses exist, and statuses where none do", () => {
    expect(check({ kind: 'mcp_call', server: 'pets', tool: 'getPet', absent: 'any-error' })).toThrow(/reports HTTP statuses/);
    expect(check({ kind: 'http_request', url: 'http://x.invalid/', absent: 'any-error' })).toThrow(/reports HTTP statuses/);
    expect(check({ kind: 'mcp_call', server: 'mock', tool: 'echo', absent: [404] })).toThrow(/could never match/);
    expect(check({ kind: 'mcp_call', server: 'mock', tool: 'echo', absent: 'any-error' })).not.toThrow();
  });

  it('only 4xx statuses can be declared absent', () => {
    expect(() => flowSchema.parse({ name: 'f', description: 'WHEN TO USE: t.', output: 'x',
      steps: [{ id: 's', kind: 'http_request', url: 'http://x.invalid/', absent: [503] }] })).toThrow();
  });
});
