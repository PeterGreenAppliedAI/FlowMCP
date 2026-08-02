// Mock GraphQL MCP server: one read-only tool, graphql_query, that echoes
// what it received — so tests can assert the exact query constant and the
// TYPES of the variables that arrive (Int must be a number, not "10").
// Plain JS on purpose: spawnable from any cwd with bare `node`, no tsx.
import { createInterface } from 'node:readline';

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  if (req.method === 'initialize') {
    send({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'graphql-mock', version: '0' } } });
  } else if (req.method === 'tools/list') {
    send({
      jsonrpc: '2.0', id: req.id,
      result: {
        tools: [{
          name: 'graphql_query',
          description: 'Execute a GraphQL operation',
          inputSchema: { type: 'object', properties: { query: { type: 'string' }, variables: { type: 'object' } }, required: ['query'] },
          annotations: { readOnlyHint: true },
        }],
      },
    });
  } else if (req.method === 'tools/call') {
    const args = req.params?.arguments ?? {};
    send({
      jsonrpc: '2.0', id: req.id,
      result: {
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: {
          receivedQuery: args.query,
          receivedVariables: args.variables ?? {},
          variableTypes: Object.fromEntries(Object.entries(args.variables ?? {}).map(([k, v]) => [k, typeof v])),
        },
      },
    });
  } else if (req.id !== undefined) {
    send({ jsonrpc: '2.0', id: req.id, result: {} });
  }
});
