// Real downstream MCP server exposing searxng_search — the production
// counterpart of primitives-server.ts. One read-only tool, real fetches
// against the SEARXNG_URL instance, same result shape the traces recorded.
import { createInterface } from 'node:readline';

const SEARXNG_URL = process.env.SEARXNG_URL ?? (() => { throw new Error('SEARXNG_URL env var is required'); })();
const send = (msg: Record<string, unknown>) => process.stdout.write(JSON.stringify(msg) + '\n');

async function search(args: Record<string, unknown>) {
  const q = String(args.q ?? args.query ?? '');
  const timeRange = String(args.time_range ?? 'week');
  const url = `${SEARXNG_URL}/search?q=${encodeURIComponent(q)}&format=json&time_range=${encodeURIComponent(timeRange)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`searxng HTTP ${res.status}`);
  const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string; engine?: string }> };
  return {
    query: q,
    results: (data.results ?? []).slice(0, 8).map((r) => ({
      title: r.title ?? '', url: r.url ?? '', snippet: (r.content ?? '').slice(0, 300), engine: r.engine,
    })),
  };
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  void (async () => {
    const req = JSON.parse(line) as {
      id?: number; method: string;
      params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> };
    };
    if (req.id === undefined) return;
    const reply = (result: unknown) => send({ jsonrpc: '2.0', id: req.id, result });
    if (req.method === 'initialize') {
      reply({ protocolVersion: req.params?.protocolVersion ?? '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'searxng', version: '1' } });
    } else if (req.method === 'tools/list') {
      reply({
        tools: [{
          name: 'searxng_search',
          description: 'Metasearch via the local SearXNG instance',
          inputSchema: { type: 'object', properties: { q: { type: 'string' }, time_range: { type: 'string' } }, required: ['q'] },
          annotations: { readOnlyHint: true },
        }],
      });
    } else if (req.method === 'tools/call') {
      try {
        const result = await search(req.params?.arguments ?? {});
        reply({ content: [{ type: 'text', text: JSON.stringify(result) }] });
      } catch (e) {
        reply({ content: [{ type: 'text', text: `search failed: ${e instanceof Error ? e.message : e}` }], isError: true });
      }
    }
  })();
});
