// `flowmcp promote`: one admitted downstream operation → one ordinary flow
// file. The format's limits still bind (≤3 scalar inputs, computed effects,
// write gate), promotion never widens admission, and the surface budget
// warns when promoted operations pile up.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSON5 from 'json5';
import { projectRoot, RpcClient, spawnServer } from './helpers.js';
import { buildPromotion, promote, renderFlow, tidy } from '../src/promote.js';
import { executeFlow } from '../src/engine.js';
import { flowSchema } from '../src/flow-schema.js';

const fixtures = join(projectRoot, 'test/fixtures/openapi-flows');
let api: Server;
let apiUrl = '';
let dir = '';

beforeAll(async () => {
  api = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/api/pets/p1') return res.end(JSON.stringify({ id: 'p1', name: 'Rex' }));
    if (url.pathname === '/api/pets') return res.end(JSON.stringify({ count: Number(url.searchParams.get('limit') ?? 3) }));
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  apiUrl = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  process.env.PETS_URL = apiUrl;
  process.env.PETS_KEY = 'k';
  // a scratch flows dir holding only the servers config + spec
  dir = mkdtempSync(join(tmpdir(), 'flowmcp-promote-'));
  copyFileSync(join(fixtures, 'servers.json5'), join(dir, 'servers.json5'));
  copyFileSync(join(fixtures, 'pets.openapi.json'), join(dir, 'pets.openapi.json'));
});
afterAll(() => new Promise<void>((r) => api.close(() => r())));

describe('promote', () => {
  it('makes required path params inputs and derives a snake_case flow name', async () => {
    const p = await promote(dir, 'pets', 'getPet');
    expect(p.write).toBe(false);
    expect(p.flow).toMatchObject({
      name: 'pets_get_pet',
      input: { pet_id: { type: 'string', required: true } },
      steps: [{ kind: 'mcp_call', server: 'pets', tool: 'getPet', args: { petId: '{{input.pet_id}}' } }],
    });
    expect(p.flow.proposal).toBeUndefined();
  });

  it('adds optional inputs by request, typed from the schema', async () => {
    const p = await promote(dir, 'pets', 'listPets', { inputs: ['limit'] });
    expect(p.flow.input).toEqual({ limit: { type: 'number', description: 'limit', required: false } });
  });

  it('gates an allow-listed write and reaches into the request body', async () => {
    const p = await promote(dir, 'pets', 'createPet');
    expect(p.write).toBe(true);
    expect(p.inputs).toEqual(['body.name']);
    expect((p.flow.steps as Array<{ args: unknown }>)[0]!.args).toEqual({ body: { name: '{{input.name}}' } });
    expect(p.flow.proposal).toBe('About to call createPet on pets with name={{input.name}}.');
  });

  it('refuses a tool servers.json5 does not admit', async () => {
    await expect(promote(dir, 'pets', 'deletePet')).rejects.toThrow(/not admitted.*never widens/);
  });

  it('refuses more than 3 inputs unless constants are pinned', () => {
    const tool = {
      name: 'report',
      inputSchema: {
        type: 'object',
        required: ['a', 'b', 'c', 'tenant'],
        properties: { a: { type: 'string' }, b: { type: 'string' }, c: { type: 'string' }, tenant: { type: 'string' }, filter: { type: 'object' } },
      },
      annotations: { readOnlyHint: true },
    };
    expect(() => buildPromotion('erp', tool, 'read')).toThrow(/needs 4 inputs.*at most 3/);
    const p = buildPromotion('erp', tool, 'read', { pins: { tenant: 'EMEA', filter: { open: true } } });
    expect(p.inputs).toEqual(['a', 'b', 'c']);
    expect((p.flow.steps as Array<{ args: unknown }>)[0]!.args).toEqual({
      tenant: 'EMEA', filter: { open: true }, a: '{{input.a}}', b: '{{input.b}}', c: '{{input.c}}',
    });
    expect(() => buildPromotion('erp', { ...tool, inputSchema: { ...tool.inputSchema, required: ['filter'] } }, 'read'))
      .toThrow(/'filter' is not a scalar — pin it/);
  });

  it('a pin inside an object keeps the other required fields as inputs (review 2026-10-16, P2)', () => {
    const tool = {
      name: 'create_ticket',
      inputSchema: {
        type: 'object',
        required: ['body'],
        properties: {
          body: { type: 'object', required: ['tenant', 'name'], properties: { tenant: { type: 'string' }, name: { type: 'string' } } },
        },
      },
    };
    const p = buildPromotion('desk', tool, 'write', { pins: { 'body.tenant': 'EMEA' } });
    expect(p.inputs).toEqual(['body.name']);
    expect((p.flow.steps as Array<{ args: unknown }>)[0]!.args).toEqual({ body: { tenant: 'EMEA', name: '{{input.name}}' } });
    // pinning the whole object still means "no inputs from it"
    const whole = buildPromotion('desk', tool, 'write', { pins: { body: { tenant: 'EMEA', name: 'fixed' } } });
    expect(whole.inputs).toEqual([]);
  });

  it('renders a valid flow file that serves and runs', async () => {
    const p = await promote(dir, 'pets', 'getPet');
    const file = join(dir, 'pets_get_pet.flow.json5');
    writeFileSync(file, renderFlow(p, 'pets', 'getPet'));
    expect(flowSchema.safeParse(JSON5.parse(readFileSync(file, 'utf8'))).success).toBe(true);

    const client = new RpcClient(spawnServer(dir, { PETS_URL: apiUrl, PETS_KEY: 'k' }));
    try {
      await client.request('initialize', { protocolVersion: '2025-03-26', capabilities: {} });
      client.notify('notifications/initialized');
      const res = await client.request('tools/call', { name: 'pets_get_pet', arguments: { pet_id: 'p1' } });
      expect(JSON.parse((res.result as { content: [{ text: string }] }).content[0].text)).toEqual({ id: 'p1', name: 'Rex' });
    } finally {
      client.close();
    }
  });

  it('warns when the served surface exceeds the tool budget', async () => {
    const stderr = await new Promise<string>((resolve) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'validate', '--flows', fixtures], {
        cwd: projectRoot,
        env: { ...process.env, FLOWMCP_TOOL_BUDGET: '2' },
      });
      let err = '';
      child.stderr.on('data', (c: Buffer) => (err += c));
      child.on('exit', () => resolve(err));
    });
    expect(stderr).toMatch(/4 tools exceed the surface budget of 2/);
    expect(stderr).toMatch(/flows valid/);
  });
});

describe('promote on real-world tool descriptions and payloads (2026-10-16, GitHub)', () => {
  const ghSearch = {
    name: 'search_repos',
    description: 'GET /search/repositories — Search repositories — Find repositories via various criteria. This method returns up to 100 results [per page](https://docs.github.com/rest/guides/using-pagination-in-the-rest-api). When searching for repositories, you can get text match metadata for the **name** and **description** fields when you pass the `text-match` media type. For more details about how to receive highlighted search results, see Text match metadata.',
    inputSchema: {
      type: 'object',
      required: ['q'],
      properties: {
        q: { type: 'string', description: 'The query contains one or more search keywords and qualifiers.' },
        sort: {
          type: 'string',
          enum: ['stars', 'forks', 'help-wanted-issues', 'updated'],
          description: 'Sorts the results of your query by number of `stars`, `forks`, or `help-wanted-issues` or how recently the items were `updated`. Default: [best match](https://docs.github.com/rest/search/search#ranking-search-results)',
        },
      },
    },
    annotations: { readOnlyHint: true },
  };

  it('tidies model-facing text: no markdown, no method prefix, never cut mid-word', () => {
    const p = buildPromotion('github', ghSearch, 'read', { inputs: ['sort'] });
    const d = p.flow.description as string;
    expect(d.startsWith('WHEN TO USE: Search repositories — Find repositories')).toBe(true);
    expect(d).not.toMatch(/\]\(|\*\*|`|GET \//);
    expect(d.length).toBeLessThanOrEqual(300);
    expect(d).toMatch(/[.…]$/);
    expect(tidy('alpha beta gamma delta', 12)).toBe('alpha beta…');
  });

  it('keeps the allowed values even when the description is long', () => {
    const p = buildPromotion('github', ghSearch, 'read', { inputs: ['sort'] });
    const sort = (p.flow.input as Record<string, { description: string }>).sort!.description;
    expect(sort).toMatch(/One of: stars, forks, help-wanted-issues, updated\.$/);
    expect(sort.length).toBeLessThanOrEqual(200);
    expect(sort).toContain('Default: best match.');
  });

  it('--pick projects scalars and one array group, and the flow runs', async () => {
    const p = buildPromotion('github', ghSearch, 'read', { pick: ['total_count,items[].full_name', 'items[].owner.login', 'license.spdx_id'] });
    expect(flowSchema.safeParse(p.flow).success).toBe(true);
    const steps = p.flow.steps as Array<Record<string, unknown>>;
    expect(steps[0]!.maxResultChars).toBe(500_000); // projection happens AFTER the call
    // run the generated steps against a canned result (no network)
    const payload = { total_count: 2, license: { spdx_id: 'MIT' }, items: [{ full_name: 'a/b', owner: { login: 'a' }, noise_url: 'x' }, { full_name: 'c/d', owner: { login: 'c' } }] };
    const pool = { has: () => true, call: async () => ({ content: [{ type: 'text', text: '' }], structuredContent: payload }) };
    const run = await executeFlow(flowSchema.parse(p.flow), { q: 'x' }, { mcp: pool as never });
    expect(run.status).toBe('complete');
    expect(JSON.parse((run as { text: string }).text)).toEqual({ total_count: 2, spdx_id: 'MIT', items: [{ full_name: 'a/b', login: 'a' }, { full_name: 'c/d', login: 'c' }] });
  });

  it('--pick on an array result, and invalid picks refuse', () => {
    const p = buildPromotion('github', ghSearch, 'read', { pick: ['[].name'] });
    expect(p.flow.output).toBe('{{steps.picked_items}}');
    expect((p.flow.steps as Array<{ over?: string }>)[1]!.over).toBe('steps.result[0:10]');
    expect(() => buildPromotion('github', ghSearch, 'read', { pick: ['a[].b', 'c[].d'] })).toThrow(/share one array/);
    expect(() => buildPromotion('github', ghSearch, 'read', { pick: ['a[].b[].c'] })).toThrow(/one level/);
    expect(() => buildPromotion('github', ghSearch, 'read', { pick: ['x.name', 'y.name', 'y_name'] })).toThrow(/duplicate/);
  });
});
