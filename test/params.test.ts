import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RpcClient, spawnServer } from './helpers.js';

// First-consumer report: small models pad arguments — {"input": ""} on a
// no-param flow is common. Read-only flows drop unknown params with a stderr
// note; write flows stay strict.

const READ_FLOW = `{
  name: 'padded_read',
  description: 'WHEN TO USE: params test, read-only.',
  input: {},
  steps: [{ id: 't', kind: 'template', template: 'ran clean' }],
  output: '{{steps.t}}',
}`;

// Write-capable (POST) — validation fails before any step runs, so the
// unreachable URL is never touched.
const WRITE_FLOW = `{
  name: 'strict_write',
  description: 'WHEN TO USE: params test, write-capable.',
  input: {},
  steps: [{ id: 'w', kind: 'http_request', method: 'POST', url: 'http://127.0.0.1:1/never' }],
  output: 'done',
}`;

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function startClient(): Promise<RpcClient> {
  const dir = await mkdtemp(join(tmpdir(), 'flowmcp-params-'));
  dirs.push(dir);
  await writeFile(join(dir, 'read.flow.json5'), READ_FLOW);
  await writeFile(join(dir, 'write.flow.json5'), WRITE_FLOW);
  const client = new RpcClient(spawnServer(dir));
  await client.request('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  });
  client.notify('notifications/initialized');
  return client;
}

describe('unknown-parameter policy', () => {
  it('read-only flows tolerate padded arguments with a stderr note', async () => {
    const client = await startClient();
    try {
      const res = await client.request('tools/call', {
        name: 'padded_read',
        arguments: { input: '', bogus: 'x' },
      });
      expect((res.result as { isError?: boolean }).isError).toBeFalsy();
      const text = (res.result!.content as Array<{ text: string }>)[0]!.text;
      expect(text).toBe('ran clean');
      expect(client.stderr).toContain(`ignoring unknown parameter 'input'`);
      expect(client.stderr).toContain(`ignoring unknown parameter 'bogus'`);
    } finally {
      client.close();
    }
  });

  it('write flows stay strict: an unknown parameter is an error, before any step runs', async () => {
    const client = await startClient();
    try {
      const res = await client.request('tools/call', {
        name: 'strict_write',
        arguments: { bogus: 'x' },
      });
      expect((res.result as { isError?: boolean }).isError).toBe(true);
      const text = (res.result!.content as Array<{ text: string }>)[0]!.text;
      expect(text).toContain(`unknown parameter 'bogus'`);
    } finally {
      client.close();
    }
  });
});
