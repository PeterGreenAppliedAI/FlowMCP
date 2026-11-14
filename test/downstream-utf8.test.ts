// StdioDownstreamClient must decode stdout through one persistent UTF-8
// StringDecoder: a multi-byte character split across chunk boundaries must
// survive intact. The mock delivers response bytes ONE AT A TIME — every
// byte of "café 😀" lands in its own stdout chunk — so any per-chunk decode
// would produce replacement characters.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';

const TEXT_RESULT = { content: [{ type: 'text', text: 'café 😀' }] };

type FakeChild = {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  on: (event: string, cb: (arg?: unknown) => void) => FakeChild;
  kill: () => void;
};

// A fake child process backed by in-memory streams. Requests written to
// stdin are parsed line by line; initialize and tools/call are answered with
// JSON-RPC responses delivered byte-by-byte on stdout, each preceded by a
// blank line (a keep-alive newline), to exercise the framing buffer.
function startFakeChild(): FakeChild {
  const child: FakeChild = {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    on: () => child,
    kill: () => {},
  };
  let pending = '';
  child.stdin.on('data', (c: Buffer) => {
    pending += c.toString('utf8');
    let idx: number;
    while ((idx = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, idx);
      pending = pending.slice(idx + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as { id?: number; method?: string };
      if (msg.id === undefined) continue; // notification
      let result: unknown;
      if (msg.method === 'initialize') {
        result = { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'fake', version: '1' } };
      } else if (msg.method === 'tools/call') {
        result = TEXT_RESULT;
      } else {
        result = {};
      }
      const response = Buffer.from('\n' + JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n', 'utf8');
      const deliver = (i: number) => {
        if (i >= response.length) return;
        child.stdout.write(response.subarray(i, i + 1));
        setImmediate(() => deliver(i + 1));
      };
      deliver(0);
    }
  });
  return child;
}

describe('StdioDownstreamClient UTF-8 decoding', () => {
  afterEach(() => {
    vi.doUnmock('node:child_process');
    vi.resetModules();
  });

  it('preserves multi-byte characters when response bytes arrive one at a time', async () => {
    const child = startFakeChild();
    vi.doMock('node:child_process', () => ({ spawn: () => child }));
    const { StdioDownstreamClient } = await import('../src/downstream.js');

    const client = new StdioDownstreamClient('utf8-mock', {
      command: 'fake',
      args: [],
      env: {},
      inheritEnv: false,
      shell: false,
    });
    try {
      await client.connect(Date.now() + 5_000);

      const first = await client.callTool('echo', { n: 1 }, Date.now() + 5_000);
      expect(first).toEqual(TEXT_RESULT);
      expect(first.content?.[0]?.text).toBe('café 😀');
      expect(first.content?.[0]?.text).not.toContain('\uFFFD');

      const second = await client.callTool('echo', { n: 2 }, Date.now() + 5_000);
      expect(second).toEqual(TEXT_RESULT);
      expect(second.content?.[0]?.text).toBe('café 😀');
      expect(second.content?.[0]?.text).not.toContain('\uFFFD');
    } finally {
      client.close();
    }
  });
});
