// Envelope validation in handleLine, driven through the mocked readline
// interface: invalid requests must be answered with -32600 and must not stop
// later queued lines from being processed.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { projectRoot } from './helpers.js';

const listeners = new Map<string, (arg: string) => void>();

vi.mock('node:readline', () => ({
  createInterface: () => ({
    on(event: string, cb: (arg: string) => void) {
      listeners.set(event, cb);
      return this;
    },
  }),
}));

const INVALID_REQUEST = {
  jsonrpc: '2.0',
  id: null,
  error: { code: -32600, message: 'invalid request' },
};

describe('invalid JSON-RPC envelopes', () => {
  const originalArgv = process.argv.slice();
  const originalStdout = process.stdout.write;
  let lines: string[] = [];

  beforeAll(async () => {
    process.argv = [process.argv[0]!, 'src/server.ts', '--flows', join(projectRoot, 'test/fixtures/flows')];
    // Let the worker settle before importing, so process.argv is the one the
    // server reads. The mocked readline keeps main() from reading stdin; the
    // flow pool sees no downstream traffic until a tool is called.
    await new Promise((r) => setTimeout(r, 50));
    await import('../src/server.js');
    await new Promise((r) => setTimeout(r, 50));
  });

  afterAll(() => {
    process.argv = originalArgv;
  });

  afterEach(() => {
    process.stdout.write = originalStdout;
    vi.restoreAllMocks();
  });

  function captureStdout() {
    lines = [];
    process.stdout.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
  }

  function messages() {
    return lines
      .join('')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  function onLine(payload: unknown) {
    const cb = listeners.get('line');
    if (!cb) throw new Error('server not loaded (readline line listener missing)');
    cb(typeof payload === 'string' ? payload : JSON.stringify(payload));
  }

  // Strings are sent as raw lines (e.g. malformed JSON); everything else is
  // serialized to JSON.
  async function send(...payloads: unknown[]) {
    captureStdout();
    for (const payload of payloads) onLine(payload);
    // Let the serial queue drain.
    await new Promise((r) => setTimeout(r, 50));
    return messages();
  }

  const invalidValues: unknown[] = [
    null,
    [],
    7,
    'x',
    {},
    { jsonrpc: '1.0', id: 1, method: 'ping' },
    { jsonrpc: '2.0', id: 1, method: 7 },
    { jsonrpc: '2.0', id: {}, method: 'ping' },
  ];

  it.each(invalidValues.map((v, i) => [JSON.stringify(v) ?? String(v), i] as const))(
    'answers %s with -32600 invalid request',
    async (_label, index) => {
      const value = invalidValues[index]!;
      // A bare string is wrapped in JSON so it reaches handleLine as data
      // rather than as a raw (unparseable) line.
      const out = await send(value === 'x' ? JSON.stringify(value) : value);
      expect(out).toEqual([INVALID_REQUEST]);
    },
  );

  it('continues with later queued requests after an invalid envelope', async () => {
    const out = await send(null, { jsonrpc: '2.0', id: 9, method: 'ping' });
    expect(out).toEqual([INVALID_REQUEST, { jsonrpc: '2.0', id: 9, result: {} }]);
  });

  it('reports malformed JSON as a parse error', async () => {
    const out = await send('{');
    expect(out).toEqual([{ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }]);
  });

  it('sends no response to a notifications/initialized notification', async () => {
    const out = await send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(out).toEqual([]);
  });

  it('reports an unknown method', async () => {
    const out = await send({ jsonrpc: '2.0', id: 8, method: 'unknown' });
    expect(out).toEqual([
      { jsonrpc: '2.0', id: 8, error: { code: -32601, message: 'method not found: unknown' } },
    ]);
  });

  it('answers ping with an empty result', async () => {
    const out = await send({ jsonrpc: '2.0', id: 9, method: 'ping' });
    expect(out).toEqual([{ jsonrpc: '2.0', id: 9, result: {} }]);
  });
});
