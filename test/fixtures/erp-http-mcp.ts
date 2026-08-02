// Enterprise-shaped remote MCP test double: Streamable HTTP transport, bearer
// auth, and — like most production SaaS MCPs — NO annotations on any tool.
// Mixed read/write surface (Business Central / Shopify shaped). Standalone:
//   ERP_PORT=0 npx tsx test/fixtures/erp-http-mcp.ts  (prints chosen port)
//
// Production behaviors deliberately modeled so the client can be proven
// against them (a mock that never misbehaves cannot detect regressions):
//   - REAL session lifecycle: initialize issues an Mcp-Session-Id, every
//     later request must present a live one (404 otherwise), DELETE
//     terminates it, and POST /expire-sessions force-expires server-side.
//   - PAGINATED tools/list: two pages via nextCursor — attested tools on
//     page 2 are invisible to a client that only reads page 1.
//   - CREDENTIAL REFLECTION: reflect_500 echoes the Authorization header in
//     its error body, the way misconfigured proxies and debug pages do.
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
  // ---- page 2 (attested/allowed tools live here on purpose) ----
  { name: 'list_overdue_invoices', description: 'Invoices overdue by at least N days', inputSchema: { type: 'object', properties: { days: { type: 'number' } } } },
  { name: 'create_order', description: 'Create a sales order (WRITE)', inputSchema: { type: 'object', properties: { customer: { type: 'string' } } } },
  { name: 'post_invoice', description: 'Post an invoice to the ledger (WRITE)', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'reflect_500', description: 'Broken backend whose error page echoes request headers', inputSchema: { type: 'object', properties: {} } },
];
const TOOLS_PAGE_SIZE = 4;

let postedInvoices = 0;
let sessionSeq = 0;
let terminatedSessions = 0;
let deleteAttempts = 0; // every DELETE, even for already-gone sessions — proves cleanup was ATTEMPTED
const sessions = new Set<string>();

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
  // test observability side-channels (no auth, no session)
  if (req.url === '/posted-count') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ posted: postedInvoices }));
    return;
  }
  if (req.url === '/session-count') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ active: sessions.size, terminated: terminatedSessions, deleteAttempts }));
    return;
  }
  if (req.url === '/expire-sessions') { // server-side session expiry, forced
    sessions.clear();
    res.end('expired');
    return;
  }
  if (req.method === 'DELETE') { // MCP session termination
    deleteAttempts++;
    // spec-strict: post-initialization requests must carry the protocol
    // version header — reject its absence so the requirement stays
    // regression-tested, not just implemented
    if (!req.headers['mcp-protocol-version']) {
      res.statusCode = 400;
      res.end('missing mcp-protocol-version header');
      return;
    }
    const sid = String(req.headers['mcp-session-id'] ?? '');
    if (sessions.delete(sid)) { terminatedSessions++; res.statusCode = 200; res.end(); }
    else { res.statusCode = 404; res.end('session not found'); }
    return;
  }
  if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
  if (req.headers.authorization === 'Bearer expired-token') { res.statusCode = 403; res.end('token expired'); return; }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.statusCode = 401; res.end('unauthorized'); return; }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const msg = JSON.parse(body) as { id?: number; method: string; params?: { protocolVersion?: string; name?: string; cursor?: string; arguments?: Record<string, unknown> } };
    const reply = (result: unknown, sessionId?: string) => {
      res.setHeader('content-type', 'application/json');
      if (sessionId) res.setHeader('mcp-session-id', sessionId);
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    };
    if (msg.method === 'initialize') {
      const sid = `erp-session-${++sessionSeq}`;
      sessions.add(sid);
      // ERP_BAD_INIT: issue a session id, then make initialization FAIL
      // client-side (unsupported protocol version) — models a server that
      // allocates the session before the handshake is validated
      const version = process.env.ERP_BAD_INIT === '1' ? '1900-01-01' : (msg.params?.protocolVersion ?? '2025-03-26');
      reply({ protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: 'erp-mock', version: '1' } }, sid);
      return;
    }
    // every non-initialize request needs a LIVE session — like production
    const sid = String(req.headers['mcp-session-id'] ?? '');
    if (!sessions.has(sid)) { res.statusCode = 404; res.end('session not found or expired'); return; }
    if (msg.id === undefined) { res.statusCode = 202; res.end(); return; }
    if (msg.method === 'tools/list') {
      // deliberately NO annotations — production reality; and PAGINATED
      const start = msg.params?.cursor === 'page-2' ? TOOLS_PAGE_SIZE : 0;
      const page = TOOLS.slice(start, start + TOOLS_PAGE_SIZE);
      reply({ tools: page, ...(start + TOOLS_PAGE_SIZE < TOOLS.length ? { nextCursor: 'page-2' } : {}) });
    } else if (msg.method === 'tools/call') {
      if (msg.params?.name === 'flaky_500') {
        // hostile body ON PURPOSE: mentions "404" and "session" like a REST
        // wrapper would — session-invalidation detection must be typed on the
        // transport status, never on error text
        res.statusCode = 500;
        res.end('internal error: customer 404 not found; reporting session unavailable');
        return;
      }
      if (msg.params?.name === 'reflect_500') {
        res.statusCode = 500;
        res.end(`internal error; request was: Authorization: ${req.headers.authorization ?? '(none)'}`);
        return;
      }
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
