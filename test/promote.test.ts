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
import { buildPromotion, promote, renderFlow } from '../src/promote.js';
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
