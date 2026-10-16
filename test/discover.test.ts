// `flowmcp discover`: one command finds an endpoint's tools — OpenAPI spec,
// MCP (HTTP or stdio), or GraphQL — and drafts a FAIL-CLOSED servers.json5
// entry that the real loader accepts. Probing never sends a write: the spec
// probes are GETs, and the draft admits nothing beyond self-declared reads.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import JSON5 from 'json5';
import { projectRoot } from './helpers.js';
import { startGraphqlApi } from './fixtures/graphql-api.js';
import { discover, renderDraft } from '../src/discover.js';
import { serversSchema } from '../src/mcp-pool.js';

const petsSpec = readFileSync(join(projectRoot, 'test/fixtures/openapi-flows/pets.openapi.json'), 'utf8');

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
const close = (server: Server) => new Promise<void>((r) => server.close(() => r()));

/** The draft must parse as JSON5 and pass the real servers.json5 schema. */
function parseDraft(name: string, draft: string) {
  const parsed = serversSchema.safeParse(JSON5.parse(`{\n${draft}}`));
  expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  return parsed.data![name]!;
}

describe('discover', () => {
  it('finds an OpenAPI spec at a well-known path, using only GETs', async () => {
    const methods: string[] = [];
    // spec with no servers[] — discover must supply baseUrl from the origin
    const spec = JSON.parse(petsSpec) as Record<string, unknown>;
    delete spec.servers;
    const server = createServer((req, res) => {
      methods.push(req.method ?? '');
      if (req.url === '/openapi.json') {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify(spec));
      }
      res.statusCode = 404;
      res.end('<html>nope</html>');
    });
    const url = await listen(server);
    try {
      const d = await discover(url);
      expect(d.transport).toBe('openapi');
      expect(d.entry).toMatchObject({ openapi: `${url}/openapi.json`, baseUrl: url });
      expect(new Set(methods)).toEqual(new Set(['GET']));
      const by = Object.fromEntries(d.tools.map((t) => [t.name, t.access]));
      expect(by).toMatchObject({ listPets: 'read', getPet: 'read', createPet: 'write', deletePet: 'write' });

      const draft = renderDraft('pets', d);
      const entry = parseDraft('pets', draft);
      expect(entry).toMatchObject({ transport: 'openapi', attestReadOnly: [], allow: [] });
      expect(draft).toMatch(/refused until attested or allow-listed:\n\s+\/\/\s+createPet/);
    } finally {
      await close(server);
    }
  });

  it('finds a GraphQL endpoint under /graphql, with templated auth kept verbatim', async () => {
    process.env.DISCOVER_GQL_TOKEN = 'gql-discover-token-1';
    const api = await startGraphqlApi('gql-discover-token-1');
    try {
      const origin = new URL(api.url).origin;
      const d = await discover(origin, { headers: { Authorization: 'Bearer {{env.DISCOVER_GQL_TOKEN}}' } });
      expect(d.transport).toBe('graphql');
      expect(d.entry).toEqual({ graphql: api.url, headers: { Authorization: 'Bearer {{env.DISCOVER_GQL_TOKEN}}' } });
      expect(d.tools.find((t) => t.name === 'customers')?.access).toBe('read');
      expect(d.tools.find((t) => t.name === 'createCustomer')?.access).toBe('write');
      expect(api.mutations()).toBe(0);
      const draft = renderDraft('crm', d);
      expect(draft).not.toContain('gql-discover-token-1');
      expect(parseDraft('crm', draft)).toMatchObject({ transport: 'graphql' });
    } finally {
      delete process.env.DISCOVER_GQL_TOKEN;
      await api.close();
    }
  });

  describe('MCP over HTTP', () => {
    let erp: ChildProcessWithoutNullStreams;
    let erpUrl = '';
    beforeAll(async () => {
      erp = spawn(process.execPath, ['--import', 'tsx', 'test/fixtures/erp-http-mcp.ts'], {
        cwd: projectRoot,
        env: { ...process.env, ERP_PORT: '0', ERP_TOKEN: 'erp-discover-token' },
      });
      erpUrl = await new Promise<string>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('erp mock did not start')), 10_000);
        erp.stdout.on('data', (c: Buffer) => {
          const m = /ERP_LISTENING (\d+)/.exec(c.toString());
          if (m) { clearTimeout(t); resolve(`http://127.0.0.1:${m[1]}`); }
        });
      });
    });
    afterAll(() => erp.kill());

    it('lists an unannotated server as all-refused until reviewed', async () => {
      process.env.DISCOVER_ERP_TOKEN = 'erp-discover-token';
      try {
        const d = await discover(erpUrl, { headers: { Authorization: 'Bearer {{env.DISCOVER_ERP_TOKEN}}' } });
        expect(d.transport).toBe('mcp');
        expect(d.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['list_customers', 'post_invoice']));
        expect(d.tools.every((t) => t.access === 'write')).toBe(true);
        expect(parseDraft('erp', renderDraft('erp', d))).toMatchObject({ transport: 'http', url: `${erpUrl}/` });
      } finally {
        delete process.env.DISCOVER_ERP_TOKEN;
      }
    });
  });

  it('catalogs a stdio MCP server', async () => {
    const d = await discover('', {
      stdio: { command: process.execPath, args: ['--import', 'tsx', join(projectRoot, 'test/fixtures/mock-mcp.ts')] },
    });
    expect(d.transport).toBe('stdio');
    const by = Object.fromEntries(d.tools.map((t) => [t.name, t.access]));
    expect(by).toMatchObject({ echo: 'read', write_thing: 'write' });
    expect(parseDraft('mock', renderDraft('mock', d))).toMatchObject({ transport: 'stdio', command: process.execPath });
  });

  it('reports every probe when nothing is found', async () => {
    const server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
    const url = await listen(server);
    try {
      await expect(discover(url, { timeoutMs: 2_000 })).rejects.toThrow(/no MCP server, OpenAPI\/Swagger spec, or GraphQL endpoint[\s\S]*GET .*\/openapi\.json[\s\S]*MCP initialize[\s\S]*__typename/);
    } finally {
      await close(server);
    }
  });

  it('CLI: drafts an entry from a local spec file', async () => {
    const res = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'discover', 'test/fixtures/openapi-flows/pets.openapi.json'], { cwd: projectRoot });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c: Buffer) => (stdout += c));
      child.stderr.on('data', (c: Buffer) => (stderr += c));
      child.on('exit', (code) => resolve({ code, stdout, stderr }));
    });
    expect(res.code, res.stderr).toBe(0);
    expect(res.stderr).toMatch(/R {2}listPets/);
    expect(parseDraft('pets', res.stdout)).toMatchObject({ transport: 'openapi' });
  });
});
