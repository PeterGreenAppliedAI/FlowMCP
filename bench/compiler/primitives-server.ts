// A real MCP server exposing the 35 benchmark primitives — the downstream
// server that compiled flows call via mcp_call. Fixture variant selected by
// env VARIANT (0|1); all tools advertise readOnlyHint so FlowMCP's fail-closed
// policy admits them without an allow list.
import { createInterface } from 'node:readline';
import { PRIMITIVE_TOOLS } from '../primitive-tools.js';
import { VARIANTS, execute } from './fixtures.js';

const variant = VARIANTS[Number(process.env.VARIANT ?? 0)]!;
const send = (msg: Record<string, unknown>) => process.stdout.write(JSON.stringify(msg) + '\n');

const tools = PRIMITIVE_TOOLS.map((t) => ({
  name: t.function.name,
  description: t.function.description,
  inputSchema: t.function.parameters,
  annotations: { readOnlyHint: true },
}));

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line) as {
    id?: number;
    method: string;
    params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> };
  };
  if (req.id === undefined) return;
  const reply = (result: unknown) => send({ jsonrpc: '2.0', id: req.id, result });
  if (req.method === 'initialize') {
    reply({ protocolVersion: req.params?.protocolVersion ?? '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'primitives', version: '0' } });
  } else if (req.method === 'tools/list') {
    reply({ tools });
  } else if (req.method === 'tools/call') {
    const name = req.params?.name ?? '';
    const result = execute(name, req.params?.arguments ?? {}, variant);
    reply({ content: [{ type: 'text', text: JSON.stringify(result) }] });
  }
});
