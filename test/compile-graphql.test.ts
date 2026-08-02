import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RpcClient, spawnServer } from './helpers.js';
import {
  compileGraphqlLog,
  lexGraphql,
  parseOperations,
  type QueryLogRecord,
} from '../src/compile-graphql.js';

const GET_ORDERS = 'query GetOrders($region: String!, $limit: Int = 10) { orders(region: $region, limit: $limit) { id total } }';
const OPTS = { server: 'erp', tool: 'graphql_query' };

const rec = (variables: Record<string, unknown>, over: Partial<QueryLogRecord> = {}): QueryLogRecord => ({
  query: GET_ORDERS,
  variables,
  operationName: 'GetOrders',
  success: true,
  ...over,
});

describe('lexer and operation parsing', () => {
  it('normalization is whitespace/comment-insensitive but never mutates strings', () => {
    const a = lexGraphql('query Q { field(arg: "has  # not a comment") }');
    const b = lexGraphql('query Q {\n  # real comment\n  field(arg: "has  # not a comment")\n}');
    expect(a.map((t) => t.raw).join(' ')).toBe(b.map((t) => t.raw).join(' '));
    expect(a.some((t) => t.raw === '"has  # not a comment"')).toBe(true);
  });

  it('parses variable declarations with nullability, lists, and defaults', () => {
    const ops = parseOperations(lexGraphql('query Q($a: String!, $b: Int = 5, $c: [ID!]!, $d: Boolean) { f }'));
    const vars = ops[0]!.varDefs;
    expect(vars.map((v) => [v.name, v.typeName, v.isList, v.required, v.hasDefault])).toEqual([
      ['a', 'String', false, true, false],
      ['b', 'Int', false, false, true],
      ['c', 'ID', true, true, false],
      ['d', 'Boolean', false, false, false],
    ]);
    expect(vars[1]!.defaultValue).toBe(5);
  });

  it('handles fragments, block strings, and multiple operations', () => {
    const doc = '"""doc""" fragment F on T { x } query A { ...F } mutation B { write }';
    const ops = parseOperations(lexGraphql(doc.replace('"""doc""" ', '')));
    expect(ops.map((o) => [o.type, o.name])).toEqual([['query', 'A'], ['mutation', 'B']]);
  });
});

describe('compileGraphqlLog', () => {
  it('emits a flow: query as constant, varying variable as required input, declared default kept', () => {
    const records = [rec({ region: 'EMEA', limit: 10 }), rec({ region: 'APAC', limit: 10 }), rec({ region: 'AMER', limit: 10 })];
    const s = compileGraphqlLog(records, OPTS);
    expect(s.emitted).toHaveLength(1);
    const e = s.emitted[0]!;
    expect(e.flowName).toBe('get_orders');
    expect(e.flow).toContain(`region: { type: 'string'`);
    expect(e.flow).toContain('required: true');
    expect(e.flow).toContain(`limit: { type: 'number'`);
    expect(e.flow).toContain('default: 10'); // from the DECLARATION, not observation
    expect(e.flow).toContain(`region: '{{input.region}}'`);
    expect(e.flow).toContain('query GetOrders');
    expect(s.coverage).toEqual({ emittedRuns: 3, totalRuns: 3 });
  });

  it('never auto-folds observed invariants — they become inputs flagged as candidate constants', () => {
    // region identical across every run (single-tenant log window) — the trap
    const records = [rec({ region: 'EMEA' }), rec({ region: 'EMEA' }), rec({ region: 'EMEA' })];
    const s = compileGraphqlLog(records, OPTS);
    const e = s.emitted[0]!;
    expect(e.flow).toContain(`region: '{{input.region}}'`); // input, NOT baked constant
    expect(e.flow).not.toContain(`region: "EMEA"`);
    const candidates = e.provenance.candidateConstants as Array<{ name: string; note: string }>;
    expect(candidates.map((c) => c.name)).toContain('region');
    expect(candidates[0]!.note).toContain('--fold');
  });

  it('explicit --fold bakes the constant, typed by declaration', () => {
    const records = [rec({ region: 'EMEA', limit: 5 }), rec({ region: 'EMEA', limit: 5 }), rec({ region: 'EMEA', limit: 5 })];
    const s = compileGraphqlLog(records, { ...OPTS, fold: { limit: '5' } });
    const e = s.emitted[0]!;
    expect(e.flow).toContain('limit: 5'); // folded as a NUMBER
    expect(e.flow).not.toContain('{{input.limit}}');
    expect(e.provenance.folded).toEqual({ limit: 5 });
  });

  it('observed values are never executable defaults', () => {
    const q = 'query G($region: String!) { orders(region: $region) { id } }';
    const records = [0, 1, 2].map(() => ({ query: q, variables: { region: 'EMEA' }, success: true }));
    const s = compileGraphqlLog(records, OPTS);
    expect(s.emitted[0]!.flow).not.toContain('EMEA'); // appears nowhere in the flow
  });

  it('provenance redacts observed values by default; opt-in includes them', () => {
    const records = [rec({ region: 'secret-tenant-a' }), rec({ region: 'secret-tenant-a' }), rec({ region: 'secret-tenant-a' })];
    const redacted = compileGraphqlLog(records, OPTS);
    expect(JSON.stringify(redacted.emitted[0]!.provenance)).not.toContain('secret-tenant-a');
    const open = compileGraphqlLog(records, { ...OPTS, includeObservedValues: true });
    expect(JSON.stringify(open.emitted[0]!.provenance)).toContain('secret-tenant-a');
  });

  it('mutations are skipped by default and emitted only with --include-mutations', () => {
    const q = 'mutation PostInvoice($id: ID!) { postInvoice(id: $id) { ok } }';
    const records = [0, 1, 2].map((i) => ({ query: q, variables: { id: String(i) }, success: true }));
    const skipped = compileGraphqlLog(records, OPTS);
    expect(skipped.emitted).toHaveLength(0);
    expect(skipped.refused[0]).toMatchObject({ reason: 'mutation-skipped' });
    const included = compileGraphqlLog(records, { ...OPTS, includeMutations: true });
    expect(included.emitted).toHaveLength(1);
    expect(included.emitted[0]!.provenance.warning).toContain('write-capable');
  });

  it('refuses: subscriptions, list variables, unmapped types, credential-like variables', () => {
    const mk = (query: string, variables: Record<string, unknown>) =>
      [0, 1, 2].map(() => ({ query, variables, success: true }));
    const cases: Array<[QueryLogRecord[], string]> = [
      [mk('subscription S { events { id } }', {}), 'subscription'],
      [mk('query L($ids: [ID!]!) { things(ids: $ids) { id } }', { ids: ['1'] }), 'list-variable'],
      [mk('query C($filter: OrderFilterInput!) { orders(filter: $filter) { id } }', { filter: { a: 1 } }), 'unmapped-type'],
      [mk('query T($apiToken: String!) { me(t: $apiToken) { id } }', { apiToken: 'eyJhbGciOiJIUzI1NiJ9' }), 'credential-like-variable'],
    ];
    for (const [records, reason] of cases) {
      const s = compileGraphqlLog(records, OPTS);
      expect(s.emitted, reason).toHaveLength(0);
      expect(s.refused.map((r) => r.reason), reason).toContain(reason);
    }
  });

  it('--scalar maps a custom scalar instead of refusing', () => {
    const q = 'query D($since: DateTime!) { events(since: $since) { id } }';
    const records = [0, 1, 2].map((i) => ({ query: q, variables: { since: `2026-0${i + 1}-01` }, success: true }));
    const s = compileGraphqlLog(records, { ...OPTS, scalarMap: { DateTime: 'string' } });
    expect(s.emitted).toHaveLength(1);
    expect(s.emitted[0]!.flow).toContain(`since: { type: 'string'`);
  });

  it('refuses >3 inputs, naming observed-invariant fold candidates', () => {
    const q = 'query M($a: String!, $b: String!, $c: String!, $d: String!) { f(a:$a,b:$b,c:$c,d:$d) { id } }';
    const records = [0, 1, 2].map((i) => ({ query: q, variables: { a: String(i), b: String(i), c: String(i), d: 'const' }, success: true }));
    const s = compileGraphqlLog(records, OPTS);
    expect(s.refused[0]).toMatchObject({ reason: 'too-many-inputs' });
    expect(s.refused[0]!.detail).toContain('$d');
  });

  it('success means no GraphQL execution errors — HTTP-200-with-errors is a failure', () => {
    const records = [
      rec({ region: 'A' }, { success: undefined, errors: [{ message: 'boom' }] }),
      rec({ region: 'B' }, { success: undefined, errors: [{ message: 'boom' }] }),
      rec({ region: 'C' }, { success: undefined }),
    ];
    const s = compileGraphqlLog(records, OPTS);
    expect(s.refused[0]).toMatchObject({ reason: 'below-threshold' });
    expect(s.refused[0]!.detail).toContain('33%');
  });

  it('refuses inline-literal variance: same shape, different inlined literals', () => {
    const mk = (region: string) => [0, 1, 2].map(() => ({
      query: `query R { orders(region: "${region}") { id } }`, variables: {}, success: true,
    }));
    const s = compileGraphqlLog([...mk('EMEA'), ...mk('APAC')], OPTS);
    expect(s.emitted).toHaveLength(0);
    expect(s.refused.every((r) => r.reason === 'inline-literal-variance')).toBe(true);
    expect(s.refused[0]!.detail).toContain('use GraphQL variables');
  });

  it('refuses per-record problems: missing query, multi-op without operationName', () => {
    const multi = 'query A { a { id } } query B { b { id } }';
    const s = compileGraphqlLog([
      { variables: {} }, // persisted-query-style record
      { query: multi, variables: {} },
    ], OPTS);
    expect(s.refused.map((r) => r.reason).sort()).toEqual(['missing-query', 'multi-op-no-name']);
  });

  it('whitespace and comment variants cluster together', () => {
    const spaced = 'query GetOrders($region: String!, $limit: Int = 10) {\n  # get them\n  orders(region: $region, limit: $limit) {\n    id\n    total\n  }\n}';
    const s = compileGraphqlLog([rec({ region: 'A' }), rec({ region: 'B' }), { query: spaced, variables: { region: 'C' }, success: true }], OPTS);
    expect(s.clusters).toBe(1);
    expect(s.emitted[0]!.runs).toBe(3);
  });
});

describe('end to end: compiled flow through the real server', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
  });

  it('serves an emitted flow; Int variables arrive as numbers; folded constants are sent', async () => {
    const records = [rec({ region: 'EMEA', limit: 7 }), rec({ region: 'APAC', limit: 7 }), rec({ region: 'AMER', limit: 7 })];
    const s = compileGraphqlLog(records, { ...OPTS, fold: { limit: '7' } });
    const dir = await mkdtemp(join(tmpdir(), 'flowmcp-gql-'));
    dirs.push(dir);
    await writeFile(join(dir, 'get_orders.flow.json5'), s.emitted[0]!.flow);
    await writeFile(
      join(dir, 'servers.json5'),
      `{ erp: { command: ${JSON.stringify(process.execPath)}, args: ['${join(process.cwd(), 'test/fixtures/graphql-mock-mcp.mjs').replace(/\\/g, '/')}'] } }`,
    );
    const client = new RpcClient(spawnServer(dir));
    try {
      await client.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } });
      client.notify('notifications/initialized');
      const res = await client.request('tools/call', { name: 'get_orders', arguments: { region: 'APAC' } });
      expect((res.result as { isError?: boolean }).isError).toBeFalsy();
      const text = (res.result!.content as Array<{ text: string }>)[0]!.text;
      const echoed = JSON.parse(text) as { receivedQuery: string; receivedVariables: Record<string, unknown>; variableTypes: Record<string, string> };
      expect(echoed.receivedQuery).toContain('query GetOrders');
      expect(echoed.receivedVariables).toEqual({ region: 'APAC', limit: 7 });
      expect(echoed.variableTypes).toEqual({ region: 'string', limit: 'number' }); // NOT "7"
    } finally {
      client.close();
    }
  });
});
