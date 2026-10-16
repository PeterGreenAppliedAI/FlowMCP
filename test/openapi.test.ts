// OpenAPI downstream: a plain REST API (no MCP server anywhere) wrapped from
// its spec, under the same governance as an MCP downstream — method-derived
// reads, attested POST reads, allow-listed writes behind the two-phase gate,
// unlisted writes refused. Plus adapter-level hardening: path-parameter
// traversal, base-URL confinement, cross-origin redirects, credential
// redaction, and unsupported constructs failing closed.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectRoot, RpcClient, spawnServer } from './helpers.js';
import { OpenApiDownstreamClient } from '../src/openapi.js';

const flowsDir = join(projectRoot, 'test/fixtures/openapi-flows');
const specPath = join(flowsDir, 'pets.openapi.json');
const KEY = 'secret-key-123';

const text = (res: { result?: Record<string, unknown> }) =>
  (res.result as { content: [{ text: string }] }).content[0].text;
const isError = (res: { result?: Record<string, unknown> }) => (res.result as { isError?: boolean }).isError;

let api: Server;
let apiUrl = '';
const seen: Array<{ method: string; path: string }> = [];
let created = 0;

beforeAll(async () => {
  api = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    seen.push({ method: req.method ?? '', path: url.pathname + url.search });
    const json = (status: number, data: unknown) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(data));
    };
    if (req.headers['x-api-key'] !== KEY) return json(401, { error: 'bad key' });
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const p = url.pathname;
      if (p === '/api/pets' && req.method === 'GET') {
        const limit = Number(url.searchParams.get('limit') ?? 10);
        const pets = [{ id: 'p1', name: 'Rex' }, { id: 'p2', name: 'Tom' }, { id: 'p3', name: 'Kit' }].slice(0, limit);
        return json(200, { count: pets.length, pets });
      }
      if (p === '/api/pets' && req.method === 'POST') {
        created++;
        return json(201, { id: `new${created}`, ...JSON.parse(body) });
      }
      if (p === '/api/pets/search' && req.method === 'POST') {
        return json(200, { matches: [`match:${JSON.parse(body).q}`] });
      }
      if (p === '/api/pets/p1') return json(200, { id: 'p1', name: 'Rex' });
      if (p.startsWith('/api/pets/')) {
        // a misbehaving server that reflects the credential into its error
        return json(404, { error: `no such pet (key was ${req.headers['x-api-key']})` });
      }
      if (p === '/api/tags') return json(200, ['a', 'b']);
      if (p === '/api/redirect-out') { res.statusCode = 302; res.setHeader('location', 'http://example.invalid/steal'); return res.end(); }
      if (p === '/api/redirect-in') { res.statusCode = 302; res.setHeader('location', '/api/pets/p1'); return res.end(); }
      if (p === '/api/created-count') return json(200, { created });
      json(404, { error: 'not found' });
    });
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  const addr = api.address() as { port: number };
  apiUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => new Promise<void>((r) => api.close(() => r())));

function adapter(overrides: Partial<ConstructorParameters<typeof OpenApiDownstreamClient>[1]> = {}) {
  return new OpenApiDownstreamClient('pets', {
    openapi: specPath,
    baseUrl: `${apiUrl}/api`,
    headers: { 'X-Api-Key': KEY },
    query: {},
    ...overrides,
  });
}
const soon = () => Date.now() + 5_000;

describe('OpenAPI adapter', () => {
  it('lists every operation as a tool, with reads derived from method semantics', async () => {
    const c = adapter();
    await c.connect(soon());
    const tools = await c.listTools();
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(by)).toEqual(expect.arrayContaining(['listPets', 'createPet', 'searchPets', 'getPet', 'deletePet', 'get_tags']));
    expect(by.listPets!.annotations?.readOnlyHint).toBe(true);
    expect(by.getPet!.annotations?.readOnlyHint).toBe(true);
    expect(by.createPet!.annotations).toBeUndefined(); // a POST is a write until attested
    expect(by.deletePet!.annotations).toBeUndefined();
    // path-level parameters are inherited; local $refs resolve (cycle-safe)
    expect(by.getPet!.inputSchema).toMatchObject({ required: ['petId'] });
    expect(by.createPet!.inputSchema).toMatchObject({
      required: ['body'],
      properties: { body: { required: ['name'], properties: { name: { type: 'string' }, friend: {} } } },
    });
  });

  it('calls with path + query params and auth, returning structured JSON', async () => {
    const c = adapter();
    await c.connect(soon());
    const res = await c.callTool('listPets', { limit: 1 }, soon());
    expect(res.structuredContent).toEqual({ count: 1, pets: [{ id: 'p1', name: 'Rex' }] });
    expect(seen.at(-1)).toEqual({ method: 'GET', path: '/api/pets?limit=1' });
    // non-object JSON stays as text (MCP structuredContent must be an object)
    const tags = await c.callTool('get_tags', {}, soon());
    expect(tags.structuredContent).toBeUndefined();
    expect(JSON.parse(tags.content![0]!.text!)).toEqual(['a', 'b']);
  });

  it('refuses dot-segment path parameters before any request is sent', async () => {
    const c = adapter();
    await c.connect(soon());
    const before = seen.length;
    for (const petId of ['..', '.']) {
      const res = await c.callTool('getPet', { petId }, soon());
      expect(res.isError).toBe(true);
    }
    // slashes are encoded, not interpreted
    await c.callTool('getPet', { petId: '../../created-count' }, soon());
    expect(seen.slice(before).map((s) => s.path)).toEqual(['/api/pets/..%2F..%2Fcreated-count']);
  });

  it('confines spec paths to the configured base URL', async () => {
    const c = adapter();
    await c.connect(soon());
    const res = await c.callTool('escape', {}, soon());
    expect(res.isError).toBe(true);
    expect(res.content![0]!.text).toMatch(/outside the configured base URL/);
  });

  it('follows same-origin redirects but never cross-origin ones', async () => {
    const c = adapter();
    await c.connect(soon());
    expect((await c.callTool('redirectIn', {}, soon())).structuredContent).toEqual({ id: 'p1', name: 'Rex' });
    const out = await c.callTool('redirectOut', {}, soon());
    expect(out.isError).toBe(true);
    expect(out.content![0]!.text).toMatch(/another origin/);
  });

  it('redacts the credential from reflected error bodies', async () => {
    const c = adapter();
    await c.connect(soon());
    const res = await c.callTool('getPet', { petId: 'nope' }, soon());
    expect(res.isError).toBe(true);
    expect(res.content![0]!.text).toMatch(/HTTP 404/);
    expect(res.content![0]!.text).not.toContain(KEY);
    expect(res.content![0]!.text).toContain('[REDACTED]');
  });

  it('fails closed on unsupported constructs', async () => {
    const c = adapter();
    await c.connect(soon());
    expect((await c.callTool('upload', { body: {} }, soon())).content![0]!.text).toMatch(/not supported/);
    expect((await c.callTool('getPet', {}, soon())).content![0]!.text).toMatch(/missing required parameter 'petId'/);

    const dir = mkdtempSync(join(tmpdir(), 'flowmcp-oas-'));
    writeFileSync(join(dir, 'v1.json'), JSON.stringify({ swagger: '1.2', paths: {} }));
    await expect(adapter({ openapi: 'v1.json', cwd: dir }).connect(soon())).rejects.toThrow(/Swagger 1.2/);
    writeFileSync(join(dir, 'junk.yaml'), 'just a string');
    await expect(adapter({ openapi: 'junk.yaml', cwd: dir }).connect(soon())).rejects.toThrow(/mapping/);
    writeFileSync(join(dir, 'noserver.json'), JSON.stringify({ openapi: '3.1.0', paths: {} }));
    await expect(adapter({ openapi: 'noserver.json', cwd: dir, baseUrl: undefined }).connect(soon())).rejects.toThrow(/baseUrl/);
  });

  it('reads a Swagger 2.0 spec written in YAML, normalized to the same tools', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flowmcp-oas-'));
    const host = new URL(apiUrl).host;
    writeFileSync(join(dir, 'pets.yaml'), [
      'swagger: "2.0"',
      `host: "${host}"`,
      'basePath: /api',
      'schemes: [http]',
      'paths:',
      '  /pets:',
      '    get:',
      '      operationId: listPets',
      '      parameters:',
      '        - { name: limit, in: query, type: integer }',
      '  /pets/search:',
      '    post:',
      '      operationId: searchPets',
      '      parameters:',
      '        - { name: payload, in: body, required: true, schema: { $ref: "#/definitions/Query" } }',
      '  /pets/{petId}:',
      '    parameters:',
      '      - { name: petId, in: path, required: true, type: string }',
      '    get: { operationId: getPet }',
      'definitions:',
      '  Query: { type: object, properties: { q: { type: string } } }',
    ].join('\n'));
    const c = adapter({ openapi: 'pets.yaml', cwd: dir, baseUrl: undefined });
    await c.connect(soon());
    const by = Object.fromEntries((await c.listTools()).map((t) => [t.name, t]));
    expect(by.listPets!.annotations?.readOnlyHint).toBe(true);
    expect(by.searchPets!.inputSchema).toMatchObject({ required: ['body'], properties: { body: { properties: { q: { type: 'string' } } } } });
    expect((await c.callTool('listPets', { limit: 2 }, soon())).structuredContent).toMatchObject({ count: 2 });
    expect((await c.callTool('searchPets', { body: { q: 'kit' } }, soon())).structuredContent).toEqual({ matches: ['match:kit'] });
    expect((await c.callTool('getPet', { petId: 'p1' }, soon())).structuredContent).toEqual({ id: 'p1', name: 'Rex' });
  });

  it('does not send credentials when fetching a spec from another origin', async () => {
    let specAuth: string | undefined = 'unset';
    const specHost = createServer((req, res) => {
      specAuth = req.headers['x-api-key'] as string | undefined;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ openapi: '3.0.0', paths: {} }));
    });
    await new Promise<void>((r) => specHost.listen(0, '127.0.0.1', r));
    const port = (specHost.address() as { port: number }).port;
    try {
      // 'localhost' vs '127.0.0.1': a different origin from the API
      await adapter({ openapi: `http://localhost:${port}/spec.json` }).connect(soon());
      expect(specAuth).toBeUndefined();
    } finally {
      await new Promise<void>((r) => specHost.close(() => r()));
    }
  });
});

describe('OpenAPI downstream through FlowMCP', () => {
  let client: RpcClient;

  beforeAll(async () => {
    client = new RpcClient(spawnServer(flowsDir, { PETS_URL: apiUrl, PETS_KEY: KEY }));
    await client.request('initialize', { protocolVersion: '2025-03-26', capabilities: {} });
    client.notify('notifications/initialized');
  });
  afterAll(() => client.close());

  it('computes flow effects: method reads and attested POSTs are read-only, allow-listed writes are not', async () => {
    const tools = (await client.request('tools/list')).result!.tools as Array<{ name: string; annotations: Record<string, boolean> }>;
    const ann = (n: string) => tools.find((t) => t.name === n)!.annotations;
    expect(ann('pets_list').readOnlyHint).toBe(true);
    expect(ann('pets_search').readOnlyHint).toBe(true);
    expect(ann('pets_create').readOnlyHint).toBe(false);
  });

  it('runs a read flow chaining two REST operations', async () => {
    const res = await client.request('tools/call', { name: 'pets_list', arguments: { limit: 2 } });
    expect(isError(res)).toBeUndefined();
    expect(text(res)).toBe('2 pets; first is Rex');
  });

  it('runs an attested POST read', async () => {
    const res = await client.request('tools/call', { name: 'pets_search', arguments: { q: 'rex' } });
    expect(text(res)).toBe('found match:rex');
  });

  it('refuses an unlisted DELETE', async () => {
    const res = await client.request('tools/call', { name: 'pets_delete', arguments: {} });
    expect(isError(res)).toBe(true);
    expect(text(res)).toMatch(/read-only by default/);
    expect(seen.some((s) => s.method === 'DELETE')).toBe(false);
  });

  it('gates an allow-listed REST write behind confirmation, then writes once', async () => {
    const before = created;
    const proposal = await client.request('tools/call', { name: 'pets_create', arguments: { name: 'Bo' } });
    expect(text(proposal)).toContain('About to create pet Bo.');
    expect(created).toBe(before);
    const token = /"confirm": "([0-9a-f-]+)"/.exec(text(proposal))?.[1];
    const done = await client.request('tools/call', { name: 'pets_create', arguments: { name: 'Bo', confirm: token } });
    expect(text(done)).toBe(`created new${before + 1}`);
    expect(created).toBe(before + 1);
  });
});
