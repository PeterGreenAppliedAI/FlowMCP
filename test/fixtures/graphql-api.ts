// Hermetic GraphQL endpoint for the graphql transport tests. Answers
// introspection from a hand-built schema (no graphql library) and executes
// the generated operations by root field name, recording every document so
// tests can assert what FlowMCP actually sent.
import { createServer, type Server } from 'node:http';

const named = (kind: string, name: string) => ({ kind, name, ofType: null });
const nonNull = (t: object) => ({ kind: 'NON_NULL', name: null, ofType: t });
const list = (t: object) => ({ kind: 'LIST', name: null, ofType: t });
const scalar = (n: string) => named('SCALAR', n);
const obj = (n: string) => named('OBJECT', n);
const field = (name: string, type: object, args: object[] = [], description: string | null = null) =>
  ({ name, description, isDeprecated: false, args, type });
const arg = (name: string, type: object, defaultValue: string | null = null) =>
  ({ name, description: null, defaultValue, type });

export const SCHEMA = {
  queryType: { name: 'Query' },
  mutationType: { name: 'Mutation' },
  types: [
    { kind: 'OBJECT', name: 'Query', fields: [
      field('customer', obj('Customer'), [arg('id', nonNull(scalar('ID')))], 'One customer by id'),
      field('customers', nonNull(list(nonNull(obj('Customer')))), [arg('limit', scalar('Int'), '10'), arg('status', named('ENUM', 'Status'))]),
      field('version', scalar('String')),
    ] },
    { kind: 'OBJECT', name: 'Mutation', fields: [
      field('createCustomer', obj('Customer'), [arg('input', nonNull(named('INPUT_OBJECT', 'NewCustomer')))]),
      field('deleteCustomer', scalar('Boolean'), [arg('id', nonNull(scalar('ID')))]),
    ] },
    { kind: 'OBJECT', name: 'Customer', fields: [
      field('id', nonNull(scalar('ID'))),
      field('name', nonNull(scalar('String'))),
      field('status', named('ENUM', 'Status')),
      field('address', obj('Address')),
      field('orders', list(obj('Order')), [arg('first', nonNull(scalar('Int')))]),
    ] },
    { kind: 'OBJECT', name: 'Address', fields: [field('city', scalar('String')), field('country', obj('Country'))] },
    { kind: 'OBJECT', name: 'Country', fields: [field('code', scalar('String'))] },
    { kind: 'OBJECT', name: 'Order', fields: [field('id', scalar('ID'))] },
    { kind: 'ENUM', name: 'Status', enumValues: [{ name: 'ACTIVE' }, { name: 'CLOSED' }] },
    { kind: 'INPUT_OBJECT', name: 'NewCustomer', inputFields: [
      { name: 'name', description: null, defaultValue: null, type: nonNull(scalar('String')) },
      { name: 'status', description: null, defaultValue: null, type: named('ENUM', 'Status') },
    ] },
    ...['ID', 'String', 'Int', 'Boolean'].map((n) => ({ kind: 'SCALAR', name: n })),
  ],
};

const CUSTOMERS = [
  { id: 'c1', name: 'Acme', status: 'ACTIVE', address: { city: 'Lisbon', country: { code: 'PT' } } },
  { id: 'c2', name: 'Globex', status: 'CLOSED', address: { city: 'Oslo', country: { code: 'NO' } } },
];

export interface GraphqlApi {
  url: string;
  documents: Array<{ query: string; variables?: Record<string, unknown> }>;
  mutations: () => number;
  close: () => Promise<void>;
}

export async function startGraphqlApi(token: string, opts: { introspection?: boolean } = {}): Promise<GraphqlApi> {
  const documents: GraphqlApi['documents'] = [];
  let mutations = 0;
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const send = (status: number, body: unknown) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(body));
      };
      if (req.headers.authorization !== `Bearer ${token}`) return send(401, { errors: [{ message: 'unauthorized' }] });
      const { query, variables } = JSON.parse(raw || '{}') as { query: string; variables?: Record<string, unknown> };
      if (query.includes('__schema')) {
        if (opts.introspection === false) return send(200, { errors: [{ message: 'GraphQL introspection is not allowed' }] });
        return send(200, { data: { __schema: SCHEMA } });
      }
      documents.push({ query, variables });
      const root = /^(?:query|mutation)\s+\w+[^{]*\{\s*(\w+)/.exec(query)?.[1];
      switch (root) {
        case 'customer': {
          const c = CUSTOMERS.find((x) => x.id === variables?.id);
          // a misbehaving server reflecting the credential into its error
          if (!c) return send(200, { data: { customer: null }, errors: [{ message: `no customer (auth: ${req.headers.authorization})` }] });
          return send(200, { data: { customer: c } });
        }
        case 'customers': {
          const filtered = CUSTOMERS.filter((c) => !variables?.status || c.status === variables.status);
          return send(200, { data: { customers: filtered.slice(0, Number(variables?.limit ?? 10)) } });
        }
        case 'version': return send(200, { data: { version: '1.2.3' } });
        case 'createCustomer': {
          mutations++;
          const input = variables?.input as { name: string };
          return send(200, { data: { createCustomer: { id: `c${10 + mutations}`, name: input.name, status: 'ACTIVE', address: null } } });
        }
        case 'deleteCustomer': mutations++; return send(200, { data: { deleteCustomer: true } });
      }
      send(200, { errors: [{ message: `unknown field ${root}` }] });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/graphql`,
    documents,
    mutations: () => mutations,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
