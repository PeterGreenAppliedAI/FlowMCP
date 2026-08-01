// Enterprise-shaped remote MCP test double: Streamable HTTP transport, bearer
// auth, and — like most production SaaS MCPs — NO annotations on any tool.
// Mixed read/write surface (Business Central / Shopify shaped). Standalone:
//   ERP_PORT=0 npx tsx test/fixtures/erp-http-mcp.ts  (prints chosen port)
import { createServer } from 'node:http';

const TOKEN = process.env.ERP_TOKEN ?? 'test-token-123';

const CUSTOMERS = [
  { id: 'C001', name: 'Acme Pest Co', balance: 1250.5 },
  { id: 'C002', name: 'Bugs Away LLC', balance: 0 },
];
const INVOICES = [
  { id: 'INV-77', customer: 'C001', amount: 1250.5, daysOverdue: 45 },
  { id: 'INV-91', customer: 'C002', amount: 310.0, daysOverdue: 12 },
];

const ORDERS = [
  { id: 'SO-1', status: 'open' }, { id: 'SO-2', status: 'open' },
  { id: 'SO-3', status: 'shipped' }, { id: 'SO-4', status: 'open' },
];

const TOOLS = [
  { name: 'list_orders', description: 'List sales orders, paginated (2 per page)', inputSchema: { type: 'object', properties: { page: { type: 'number' } } } },
  { name: 'flaky_500', description: 'Backend that is currently broken', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_customers', description: 'List all customers', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_customer', description: 'Get one customer by id', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'list_overdue_invoices', description: 'Invoices overdue by at least N days', inputSchema: { type: 'object', properties: { days: { type: 'number' } } } },
  { name: 'create_order', description: 'Create a sales order (WRITE)', inputSchema: { type: 'object', properties: { customer: { type: 'string' } } } },
  { name: 'post_invoice', description: 'Post an invoice to the ledger (WRITE)', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
];

let postedInvoices = 0;

function call(name: string, args: Record<string, unknown>): { text: string; isError?: boolean } {
  switch (name) {
    case 'list_customers': return { text: JSON.stringify({ customers: CUSTOMERS }) };
    case 'get_customer': {
      const c = CUSTOMERS.find((x) => x.id === args.id);
      return c ? { text: JSON.stringify(c) } : { text: `no customer ${String(args.id)}`, isError: true };
    }
    case 'list_overdue_invoices': {
      const days = Number(args.days ?? 0);
      return { text: JSON.stringify({ invoices: INVOICES.filter((i) => i.daysOverdue >= days) }) };
    }
    case 'create_order': return { text: JSON.stringify({ ok: true, order: 'SO-1001' }) };
    case 'list_orders': {
      const page = Number(args.page ?? 1);
      const slice = ORDERS.slice((page - 1) * 2, page * 2);
      return { text: JSON.stringify({ orders: slice, nextPage: page * 2 < ORDERS.length ? page + 1 : null }) };
    }
    case 'post_invoice':
      postedInvoices++;
      return { text: JSON.stringify({ ok: true, posted: args.id, totalPosted: postedInvoices }) };
    default: return { text: `unknown tool ${name}`, isError: true };
  }
}

const server = createServer((req, res) => {
  if (req.url === '/posted-count') { // test observability side-channel
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ posted: postedInvoices }));
    return;
  }
  if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
  if (req.headers.authorization === 'Bearer expired-token') { res.statusCode = 403; res.end('token expired'); return; }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.statusCode = 401; res.end('unauthorized'); return; }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const msg = JSON.parse(body) as { id?: number; method: string; params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> } };
    const reply = (result: unknown) => {
      res.setHeader('content-type', 'application/json');
      res.setHeader('mcp-session-id', 'erp-session-1');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    };
    if (msg.id === undefined) { res.statusCode = 202; res.end(); return; }
    if (msg.method === 'initialize') {
      reply({ protocolVersion: msg.params?.protocolVersion ?? '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'erp-mock', version: '1' } });
    } else if (msg.method === 'tools/list') {
      reply({ tools: TOOLS }); // deliberately NO annotations — production reality
    } else if (msg.method === 'tools/call') {
      if (msg.params?.name === 'flaky_500') { res.statusCode = 500; res.end('internal error'); return; }
      const r = call(msg.params?.name ?? '', msg.params?.arguments ?? {});
      reply({ content: [{ type: 'text', text: r.text }], ...(r.isError ? { isError: true } : {}) });
    } else {
      res.statusCode = 404; res.end();
    }
  });
});

server.listen(Number(process.env.ERP_PORT ?? 0), '127.0.0.1', () => {
  const addr = server.address();
  if (addr && typeof addr !== 'string') console.log(`ERP_LISTENING ${addr.port}`);
});
