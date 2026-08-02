import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { RpcClient, projectRoot, spawnServer } from './helpers.js';
import { computeHealth, loadRegistry, readLog, type LogRecord } from '../src/registry.js';

const OK_FLOW = `{
  name: 'reg_ok',
  description: 'WHEN TO USE: registry test flow that succeeds.',
  input: {},
  steps: [{ id: 't', kind: 'template', template: 'hello from reg_ok' }],
  output: '{{steps.t}}',
}`;

// Fails at runtime (reads through undefined) but validates fine — hermetic.
const FAIL_FLOW = `{
  name: 'reg_fail',
  description: 'WHEN TO USE: registry test flow that fails at runtime.',
  input: {},
  steps: [{ id: 't', kind: 'transform', expr: 'steps.missing.field' }],
  output: '{{steps.t}}',
}`;

const dirs: string[] = [];
async function makeDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'flowmcp-registry-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
  return dir;
}

afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function initialized(client: RpcClient): Promise<void> {
  await client.request('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  });
  client.notify('notifications/initialized');
}

function run(extraArgs: string[], dir: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/server.ts', '--flows', dir, ...extraArgs],
      { cwd: projectRoot, env: process.env },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('registry enforcement', () => {
  it('serves only active flows when a registry is present', async () => {
    const dir = await makeDir({
      'ok.flow.json5': OK_FLOW,
      'fail.flow.json5': FAIL_FLOW,
      'registry.json5': `{ reg_ok: { state: 'active' }, reg_fail: { state: 'candidate' } }`,
    });
    const client = new RpcClient(spawnServer(dir));
    try {
      await initialized(client);
      const list = await client.request('tools/list');
      const names = (list.result!.tools as Array<{ name: string }>).map((t) => t.name);
      expect(names).toEqual(['reg_ok']);
      expect(client.stderr).toContain(`'reg_fail' is 'candidate'`);
    } finally {
      client.close();
    }
  });

  it('fails startup when a flow file is not listed in the registry', async () => {
    const dir = await makeDir({
      'ok.flow.json5': OK_FLOW,
      'registry.json5': `{}`,
    });
    const res = await run(['--validate'], dir);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain(`flow 'reg_ok' is not listed`);
  });

  it('fails startup on a registry entry with no matching flow', async () => {
    const dir = await makeDir({
      'ok.flow.json5': OK_FLOW,
      'registry.json5': `{ reg_ok: { state: 'active' }, ghost: { state: 'active' } }`,
    });
    const res = await run(['--validate'], dir);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain(`'ghost' does not match any loaded flow`);
  });

  it('rejects an invalid state value, naming the field', async () => {
    const dir = await makeDir({
      'ok.flow.json5': OK_FLOW,
      'registry.json5': `{ reg_ok: { state: 'live' } }`,
    });
    const res = await run(['--validate'], dir);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('reg_ok.state');
  });

  it('no registry file means every valid flow serves (pre-registry behavior)', async () => {
    const dir = await makeDir({ 'ok.flow.json5': OK_FLOW, 'fail.flow.json5': FAIL_FLOW });
    const client = new RpcClient(spawnServer(dir));
    try {
      await initialized(client);
      const list = await client.request('tools/list');
      const names = (list.result!.tools as Array<{ name: string }>).map((t) => t.name).sort();
      expect(names).toEqual(['reg_fail', 'reg_ok']);
      expect(await loadRegistry(dir)).toBeUndefined();
    } finally {
      client.close();
    }
  });
});

describe('run logging', () => {
  it('appends pass and fail run records to registry-log.jsonl', async () => {
    const dir = await makeDir({
      'ok.flow.json5': OK_FLOW,
      'fail.flow.json5': FAIL_FLOW,
      'registry.json5': `{ reg_ok: { state: 'active' }, reg_fail: { state: 'active' } }`,
    });
    const client = new RpcClient(spawnServer(dir));
    try {
      await initialized(client);
      const ok = await client.request('tools/call', { name: 'reg_ok', arguments: {} });
      expect(ok.result!.isError).toBeFalsy();
      const fail = await client.request('tools/call', { name: 'reg_fail', arguments: {} });
      expect((fail.result as { isError?: boolean }).isError).toBe(true);
    } finally {
      client.close();
    }
    const { records, malformed } = await readLog(dir);
    expect(malformed).toBe(0);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ flow: 'reg_ok', kind: 'run', ok: true });
    expect(records[1]).toMatchObject({ flow: 'reg_fail', kind: 'run', ok: false });
    expect((records[1] as { error?: string }).error).toContain(`step 't'`);
  });

  it('does not log runs when no registry is present', async () => {
    const dir = await makeDir({ 'ok.flow.json5': OK_FLOW });
    const client = new RpcClient(spawnServer(dir));
    try {
      await initialized(client);
      await client.request('tools/call', { name: 'reg_ok', arguments: {} });
    } finally {
      client.close();
    }
    await expect(readFile(join(dir, 'registry-log.jsonl'), 'utf8')).rejects.toThrow();
  });
});

describe('health computation', () => {
  const rec = (partial: Record<string, unknown>): LogRecord =>
    ({ ts: '2026-08-02T00:00:00Z', flow: 'f', ...partial }) as LogRecord;

  it('nominates after 3 consecutive failed runs', () => {
    const records = [
      rec({ kind: 'run', ok: true }),
      rec({ kind: 'run', ok: false }),
      rec({ kind: 'run', ok: false }),
      rec({ kind: 'run', ok: false }),
    ];
    const h = computeHealth(records, 'f');
    expect(h.runs).toBe(4);
    expect(h.passed).toBe(1);
    expect(h.consecutiveFailures).toBe(3);
    expect(h.nominations.some((n) => n.includes('needs review'))).toBe(true);
  });

  it('a pass resets the consecutive-failure count', () => {
    const records = [
      rec({ kind: 'run', ok: false }),
      rec({ kind: 'run', ok: false }),
      rec({ kind: 'run', ok: true }),
    ];
    expect(computeHealth(records, 'f').consecutiveFailures).toBe(0);
    expect(computeHealth(records, 'f').nominations).toHaveLength(0);
  });

  it('nominates a lens present in each of the last 3 signals of one source', () => {
    const records = [
      rec({ kind: 'signal', source: 'gap_check', lenses: ['china', 'edge'] }),
      rec({ kind: 'signal', source: 'gap_check', lenses: ['china'] }),
      rec({ kind: 'signal', source: 'gap_check', lenses: ['china', 'frontier'] }),
    ];
    const h = computeHealth(records, 'f');
    expect(h.signals).toEqual({ gap_check: 3 });
    expect(h.persistentLenses).toEqual([{ source: 'gap_check', lens: 'china' }]);
    expect(h.nominations.some((n) => n.includes('recompile candidate'))).toBe(true);
  });

  it('fewer than 3 signals never nominate, and sources are tracked separately', () => {
    const records = [
      rec({ kind: 'signal', source: 'gap_check', lenses: ['china'] }),
      rec({ kind: 'signal', source: 'gap_check', lenses: ['china'] }),
      rec({ kind: 'signal', source: 'other', lenses: ['china'] }),
    ];
    const h = computeHealth(records, 'f');
    expect(h.persistentLenses).toHaveLength(0);
    expect(h.signals).toEqual({ gap_check: 2, other: 1 });
  });

  it('a failed shadow replay nominates; records for other flows are ignored', () => {
    const records = [
      rec({ kind: 'shadow', ok: false, note: 'digest diverged' }),
      rec({ flow: 'other_flow', kind: 'run', ok: false }),
    ];
    const h = computeHealth(records, 'f');
    expect(h.runs).toBe(0);
    expect(h.nominations.some((n) => n.includes('shadow replay diverged'))).toBe(true);
  });
});

describe('--status', () => {
  it('prints per-flow health and nominations from a mixed log', async () => {
    const log = [
      { ts: 't1', flow: 'reg_ok', kind: 'run', ok: true, ms: 5 },
      { ts: 't2', flow: 'reg_ok', kind: 'signal', source: 'gap_check', lenses: ['china'] },
      { ts: 't3', flow: 'reg_ok', kind: 'signal', source: 'gap_check', lenses: ['china'] },
      { ts: 't4', flow: 'reg_ok', kind: 'signal', source: 'gap_check', lenses: ['china'] },
      { ts: 't5', flow: 'reg_fail', kind: 'run', ok: false, error: 'x' },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n');
    const dir = await makeDir({
      'ok.flow.json5': OK_FLOW,
      'fail.flow.json5': FAIL_FLOW,
      'registry.json5': `{ reg_ok: { state: 'active' }, reg_fail: { state: 'candidate' } }`,
      'registry-log.jsonl': log + '\nnot json\n',
    });
    const res = await run(['--status'], dir);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('reg_ok');
    expect(res.stdout).toContain('active');
    expect(res.stdout).toContain('candidate');
    expect(res.stdout).toContain('gap_check:3');
    expect(res.stdout).toContain(`NOMINATION reg_ok: lens 'china'`);
    expect(res.stdout).toContain('1 malformed log line(s) skipped');
  });

  it('reports registry disabled when no registry file exists', async () => {
    const dir = await makeDir({ 'ok.flow.json5': OK_FLOW });
    const res = await run(['--status'], dir);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('registry disabled');
  });
});
