// `flowmcp infer-spec`: recorded traffic → an OpenAPI spec the openapi
// transport can wrap. The load-bearing property is the privacy one — the
// spec carries shape only, never a header value, cookie, query value, or
// body value from the capture.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inferSpec } from '../src/har.js';
import { OpenApiDownstreamClient } from '../src/openapi.js';

const SECRETS = ['Bearer har-secret-token-xyz', 'QSECRET-1234567', 'sess=cookie-secret-abc', 'alice@example.com', 'Alice Liddell'];

let api: Server;
let origin = '';
beforeAll(async () => {
  api = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/api/users/123') return res.end(JSON.stringify({ id: 123, name: 'Rex' }));
    if (url.pathname === '/api/users') return res.end(JSON.stringify({ users: [], limit: Number(url.searchParams.get('limit')) }));
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => api.close(() => r())));

function har() {
  const entry = (method: string, url: string, opts: { reqType?: string; reqBody?: unknown; resType?: string; resBody?: unknown; status?: number } = {}) => ({
    request: {
      method,
      url,
      headers: [{ name: 'Authorization', value: SECRETS[0] }, { name: 'Cookie', value: SECRETS[2] }, { name: 'Accept', value: 'application/json' }],
      ...(opts.reqBody !== undefined ? { postData: { mimeType: opts.reqType ?? 'application/json', text: JSON.stringify(opts.reqBody) } } : {}),
    },
    response: {
      status: opts.status ?? 200,
      content: { mimeType: opts.resType ?? 'application/json; charset=utf-8', text: JSON.stringify(opts.resBody ?? {}) },
    },
  });
  return {
    log: {
      entries: [
        entry('GET', `${origin}/api/users/123`, { resBody: { id: 123, name: 'Alice Liddell', email: 'alice@example.com', tags: ['a'] } }),
        entry('GET', `${origin}/api/users/9f86d081884c7d659a2feaa0c55ad015`, { resBody: { id: 7, name: 'B', score: 1.5 } }),
        entry('GET', `${origin}/api/users?limit=10&api_key=QSECRET-1234567`, { resBody: { users: [{ id: 1 }] } }),
        entry('GET', `${origin}/api/users?limit=5&page=2&api_key=QSECRET-1234567`, { resBody: { users: [] } }),
        entry('POST', `${origin}/api/users`, { reqBody: { name: 'Alice Liddell', email: 'alice@example.com' }, status: 201 }),
        entry('POST', `${origin}/api/users`, { reqBody: { name: 'Bob' }, status: 201 }),
        entry('GET', `${origin}/v2/orders/A1B2C3D4/items`, { resBody: [] }),
        entry('GET', `${origin}/api/users/alice%40example.com/profile`, { resBody: { bio: 'x' } }),
        entry('GET', `${origin}/static/app.js`, { resType: 'application/javascript' }),
        entry('GET', `${origin}/`, { resType: 'text/html' }),
        entry('GET', 'https://cdn.other.example/lib.json', {}),
      ],
    },
  };
}

describe('infer-spec', () => {
  it('templates id-like segments, keeps only JSON API traffic on one origin', () => {
    const { spec, report } = inferSpec(har());
    const paths = spec.paths as Record<string, Record<string, { operationId: string; parameters?: Array<Record<string, unknown>> }>>;
    expect(Object.keys(paths).sort()).toEqual(['/api/users', '/api/users/{userId}', '/api/users/{userId}/profile', '/v2/orders/{orderId}/items']);
    expect(paths['/api/users/{userId}']!.get!.operationId).toBe('get_api_users_by_userId');
    expect(paths['/v2/orders/{orderId}/items']!.get!.parameters).toEqual([{ name: 'orderId', in: 'path', required: true, schema: { type: 'string' } }]);
    expect(report.origin).toBe(origin);
    expect(report.used).toBe(8);
    expect(report.skipped).toEqual({ 'static asset': 1, 'non-JSON exchange': 1 });
    expect(report.otherOrigins).toEqual({ 'https://cdn.other.example': 1 });
  });

  it('infers optional typed query params and required body fields from every sample', () => {
    const { spec } = inferSpec(har());
    const users = (spec.paths as Json)['/api/users'] as Record<string, Json>;
    expect(users.get!.parameters).toEqual([
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
      { name: 'page', in: 'query', required: false, schema: { type: 'integer' } },
    ]);
    expect(users.post!.requestBody).toEqual({
      required: true,
      content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, email: { type: 'string' } }, required: ['name'] } } },
    });
    // responses document merged shape (integer ∪ number → number), no required
    const byId = ((spec.paths as Json)['/api/users/{userId}'] as Record<string, Json>).get!;
    expect(JSON.stringify(byId.responses)).toContain('"score":{"type":"number"}');
    expect(JSON.stringify(byId.responses)).not.toContain('required');
  });

  it('never writes a captured value into the spec, and reports auth to configure', () => {
    const { spec, report } = inferSpec(har());
    const text = JSON.stringify(spec);
    for (const s of [...SECRETS, 'QSECRET', 'cookie-secret', 'har-secret', 'api_key', 'alice']) expect(text).not.toContain(s);
    expect(report.authHeaders).toEqual(['authorization', 'cookie']);
    expect(report.authQueryParams).toEqual(['api_key']);
  });

  it('produces a spec the openapi transport wraps and calls', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flowmcp-har-'));
    writeFileSync(join(dir, 'spec.json'), JSON.stringify(inferSpec(har()).spec));
    const c = new OpenApiDownstreamClient('inferred', { openapi: 'spec.json', cwd: dir, headers: {}, query: {} });
    await c.connect(Date.now() + 5_000);
    const tools = Object.fromEntries((await c.listTools()).map((t) => [t.name, t]));
    expect(tools.get_api_users_by_userId!.annotations?.readOnlyHint).toBe(true);
    expect(tools.post_api_users!.annotations).toBeUndefined();
    const res = await c.callTool('get_api_users_by_userId', { userId: '123' }, Date.now() + 5_000);
    expect(res.structuredContent).toEqual({ id: 123, name: 'Rex' });
  });

  it('rejects input that is not a HAR capture or has no API traffic', () => {
    expect(() => inferSpec({})).toThrow(/not a HAR capture/);
    const onlyHtml = { log: { entries: [{ request: { method: 'GET', url: 'https://x.example/' }, response: { status: 200, content: { mimeType: 'text/html' } } }] } };
    expect(() => inferSpec(onlyHtml)).toThrow(/no JSON API traffic/);
  });
});

type Json = Record<string, unknown>;
