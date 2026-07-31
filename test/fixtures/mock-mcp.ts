// Minimal downstream MCP server for composition tests: read-only tools carry
// annotations.readOnlyHint, write tools carry no annotations, plus a slow tool
// and a crash tool for timeout/respawn coverage.
import { createInterface } from 'node:readline';

const send = (msg: Record<string, unknown>) => process.stdout.write(JSON.stringify(msg) + '\n');

const tools = [
  { name: 'echo', description: 'echo args back as JSON', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'env_probe', description: 'report whether TEST_SECRET is visible', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'big_dump', description: 'return 50KB of text', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'slow', description: 'respond after 3s', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'crash', description: 'exit the process', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'write_thing', description: 'a write tool (no annotations)', inputSchema: { type: 'object', properties: {} } },
  { name: 'delete_thing', description: 'a write tool (no annotations)', inputSchema: { type: 'object', properties: {} } },
];

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
  const text = (t: string) => reply({ content: [{ type: 'text', text: t }] });

  if (req.method === 'initialize') {
    reply({
      protocolVersion: req.params?.protocolVersion ?? '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'mock-mcp', version: '0' },
    });
  } else if (req.method === 'tools/list') {
    reply({ tools });
  } else if (req.method === 'tools/call') {
    const name = req.params?.name;
    // echo: decoy text + structuredContent — callers that pass the echo test
    // prove they preferred structuredContent over parsing the text.
    if (name === 'echo') {
      reply({
        content: [{ type: 'text', text: 'TEXT_FALLBACK_SHOULD_NOT_BE_USED' }],
        structuredContent: { echoed: req.params?.arguments ?? {} },
      });
    } else if (name === 'env_probe') text(JSON.stringify({ secret: process.env.TEST_SECRET ?? null }));
    else if (name === 'big_dump') text('x'.repeat(50_000));
    else if (name === 'slow') setTimeout(() => text('finally'), 3_000);
    else if (name === 'crash') process.exit(1);
    else if (name === 'write_thing') text('wrote!');
    else if (name === 'delete_thing') text('deleted!');
    else reply({ content: [{ type: 'text', text: `no such tool ${name}` }], isError: true });
  }
});
