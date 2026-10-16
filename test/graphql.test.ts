// GraphQL downstream: an introspected GraphQL endpoint as governed tools —
// Query fields read, Mutation fields write (refused unless allow-listed,
// then two-phase gated). The operation document is generated from the
// schema; the caller's `select` can shape the selection but never inject
// arguments, aliases, fragments or directives.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { projectRoot, RpcClient, spawnServer } from './helpers.js';
import { startGraphqlApi, type GraphqlApi } from './fixtures/graphql-api.js';
import { GraphqlDownstreamClient } from '../src/graphql.js';

const TOKEN = 'gql-token-abcdef123';
const flowsDir = join(projectRoot, 'test/fixtures/graphql-flows');
const soon = () => Date.now() + 5_000;
const text = (res: { result?: Record<string, unknown> }) =>
  (res.result as { content: [{ text: string }] }).content[0].text;
const isError = (res: { result?: Record<string, unknown> }) => (res.result as { isError?: boolean }).isError;

let api: GraphqlApi;
beforeAll(async () => {
  api = await startGraphqlApi(TOKEN);
});
afterAll(() => api.close());

const adapter = (url = api.url) =>
  new GraphqlDownstreamClient('crm', { graphql: url, headers: { Authorization: `Bearer ${TOKEN}` } });

describe('GraphQL adapter', () => {
  it('lists Query fields as reads and Mutation fields as unannotated writes', async () => {
    const c = adapter();
    await c.connect(soon());
    const by = Object.fromEntries((await c.listTools()).map((t) => [t.name, t]));
    expect(Object.keys(by).sort()).toEqual(['createCustomer', 'customer', 'customers', 'deleteCustomer', 'version']);
    expect(by.customer!.annotations?.readOnlyHint).toBe(true);
    expect(by.createCustomer!.annotations).toBeUndefined();
    expect(by.customer!.inputSchema).toMatchObject({ required: ['id'], properties: { id: { type: 'string' }, select: { type: 'string' } } });
    // defaults make an arg optional; enums and input objects map to JSON Schema
    expect(by.customers!.inputSchema).toMatchObject({
      properties: { limit: { type: 'integer', default: 10 }, status: { enum: ['ACTIVE', 'CLOSED'] } },
    });
    expect((by.customers!.inputSchema as { required?: string[] }).required).toBeUndefined();
    expect(by.createCustomer!.inputSchema).toMatchObject({
      required: ['input'], properties: { input: { type: 'object', required: ['name'] } },
    });
  });

  it('generates a typed operation with a bounded default selection', async () => {
    const c = adapter();
    await c.connect(soon());
    const res = await c.callTool('customer', { id: 'c1' }, soon());
    expect(res.structuredContent).toMatchObject({ id: 'c1', name: 'Acme', address: { city: 'Lisbon' } });
    const doc = api.documents.at(-1)!;
    expect(doc.query).toBe('query FlowMcp($id: ID!) { customer(id: $id) { id name status address { city } } }');
    expect(doc.variables).toEqual({ id: 'c1' });
  });

  it('returns lists and scalars as JSON text', async () => {
    const c = adapter();
    await c.connect(soon());
    const list = await c.callTool('customers', { status: 'CLOSED' }, soon());
    expect(list.structuredContent).toBeUndefined();
    expect(JSON.parse(list.content![0]!.text!)).toEqual([expect.objectContaining({ id: 'c2' })]);
    expect((await c.callTool('version', {}, soon())).content![0]!.text).toBe('"1.2.3"');
  });

  it('accepts a field-only select and rejects anything that could inject', async () => {
    const c = adapter();
    await c.connect(soon());
    await c.callTool('customer', { id: 'c1', select: 'name address { country { code } }' }, soon());
    expect(api.documents.at(-1)!.query).toContain('customer(id: $id) { name address { country { code } } }');
    const before = api.documents.length;
    for (const select of ['name orders(first: 100) { id }', '...on Customer { id }', 'name @include(if: true)', 'a: name', '{ name']) {
      const res = await c.callTool('customer', { id: 'c1', select }, soon());
      expect(res.isError, select).toBe(true);
    }
    expect(api.documents.length).toBe(before);
  });

  it('treats GraphQL errors as failures and redacts reflected credentials', async () => {
    const c = adapter();
    await c.connect(soon());
    const res = await c.callTool('customer', { id: 'nope' }, soon());
    expect(res.isError).toBe(true);
    expect(res.content![0]!.text).toMatch(/GraphQL error: no customer/);
    expect(res.content![0]!.text).not.toContain(TOKEN);
    expect((await c.callTool('customer', {}, soon())).content![0]!.text).toMatch(/missing required parameter 'id'/);
  });

  it('explains a failed introspection', async () => {
    const locked = await startGraphqlApi(TOKEN, { introspection: false });
    try {
      await expect(adapter(locked.url).connect(soon())).rejects.toThrow(/is introspection disabled/);
    } finally {
      await locked.close();
    }
  });
});

describe('GraphQL downstream through FlowMCP', () => {
  let client: RpcClient;
  beforeAll(async () => {
    client = new RpcClient(spawnServer(flowsDir, { CRM_GRAPHQL_URL: api.url, CRM_TOKEN: TOKEN }));
    await client.request('initialize', { protocolVersion: '2025-03-26', capabilities: {} });
    client.notify('notifications/initialized');
  });
  afterAll(() => client.close());

  it('runs a read flow', async () => {
    const res = await client.request('tools/call', { name: 'crm_customer', arguments: { id: 'c2' } });
    expect(isError(res)).toBeUndefined();
    expect(text(res)).toBe('Globex in Oslo');
  });

  it('refuses an unlisted mutation without sending it', async () => {
    const before = api.mutations();
    const res = await client.request('tools/call', { name: 'crm_delete', arguments: {} });
    expect(isError(res)).toBe(true);
    expect(text(res)).toMatch(/read-only by default/);
    expect(api.mutations()).toBe(before);
  });

  it('gates an allow-listed mutation behind confirmation', async () => {
    const tools = (await client.request('tools/list')).result!.tools as Array<{ name: string; annotations: Record<string, boolean> }>;
    expect(tools.find((t) => t.name === 'crm_create')!.annotations.readOnlyHint).toBe(false);
    const before = api.mutations();
    const proposal = await client.request('tools/call', { name: 'crm_create', arguments: { name: 'Initech' } });
    expect(text(proposal)).toContain('About to create customer Initech.');
    expect(api.mutations()).toBe(before);
    const token = /"confirm": "([0-9a-f-]+)"/.exec(text(proposal))?.[1];
    const done = await client.request('tools/call', { name: 'crm_create', arguments: { name: 'Initech', confirm: token } });
    expect(text(done)).toBe(`created c${10 + before + 1}`);
  });
});
