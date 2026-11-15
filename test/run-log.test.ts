import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hermetic: the downstream MCP client factory is mocked (so no child process
// is ever spawned), and no test needs HTTP except the absence tests, whose
// global fetch is stubbed per test below. Every fixture directory is a fresh
// temp dir removed afterwards.
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => {
  const real = { createDownstreamClient: undefined as unknown };
  const factory = vi.fn((...args: unknown[]) =>
    (real.createDownstreamClient as (...a: unknown[]) => unknown)(...args),
  );
  return { real, factory };
});

vi.mock('../src/downstream.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/downstream.js')>();
  mocks.real.createDownstreamClient = actual.createDownstreamClient;
  return { ...actual, createDownstreamClient: mocks.factory };
});

import { runFlow } from '../src/run-core.js';
import { appendLog, LOG_FILE, loadRegistry, REGISTRY_FILE } from '../src/registry.js';
import { FlowError } from '../src/engine.js';

const dirs: string[] = [];
const spies: Array<{ mockRestore: () => void }> = [];

afterEach(async () => {
  mocks.factory.mockClear();
  vi.unstubAllGlobals();
  while (spies.length) spies.pop()!.mockRestore();
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

// One turn of the event loop: queued promise callbacks run first. Used after a
// signal so a run that settles without awaiting something has settled before
// the test looks. An ordering point, not a delay.
function drainQueued(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function captureStderr(): string[] {
  const written: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });
  spies.push(spy);
  return written;
}

async function makeDir(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'flowmcp-run-log-'));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return dir;
}

// Raw JSONL lines, unparsed by readLog: readLog's schema drops `absent`.
async function rawLines(dir: string): Promise<string[]> {
  const text = await readFile(join(dir, LOG_FILE), 'utf8');
  return text.split('\n').filter((l) => l.trim());
}

async function rawRecords(dir: string): Promise<Array<Record<string, unknown>>> {
  return (await rawLines(dir)).map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function logExists(dir: string): Promise<boolean> {
  try {
    await readFile(join(dir, LOG_FILE), 'utf8');
    return true;
  } catch {
    return false;
  }
}

function flow(name: string, extra: Record<string, unknown> = {}): string {
  const base = {
    name,
    description: `WHEN TO USE: test fixture '${name}'.`,
    input: {},
    steps: [{ id: 'out', kind: 'template', template: `ran ${name}` }],
    output: '{{steps.out}}',
    ...extra,
  };
  return JSON.stringify(base);
}

const activeRegistry = (name: string, state = 'active'): string => `{ ${name}: { state: '${state}' } }`;

// A flow that fails at runtime (validates fine) without any network.
const failingFlow = (name: string): string =>
  JSON.stringify({
    name,
    description: `WHEN TO USE: failure fixture '${name}'.`,
    input: {},
    steps: [{ id: 'bad', kind: 'transform', expr: 'steps.missing.field' }],
    output: '{{steps.bad}}',
  });

// ---------------------------------------------------------------------------
// Completion, failure, absent
// ---------------------------------------------------------------------------
describe('runFlow run logging', () => {
  it('appends exactly one run record for a completed flow', async () => {
    const dir = await makeDir({
      'a.flow.json5': flow('ok_flow'),
      [REGISTRY_FILE]: activeRegistry('ok_flow'),
    });
    const before = Date.now();
    const res = await runFlow({ dir, flow: 'ok_flow' });
    expect(res).toEqual({ text: 'ran ok_flow' });

    const records = await rawRecords(dir);
    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec.flow).toBe('ok_flow');
    expect(rec.kind).toBe('run');
    expect(rec.ok).toBe(true);
    expect(typeof rec.ts).toBe('string');
    // ISO timestamp, and the same instant the run happened.
    const ts = Date.parse(rec.ts as string);
    expect(new Date(ts).toISOString()).toBe(rec.ts);
    expect(ts).toBeGreaterThanOrEqual(before - 1000);
    expect(ts).toBeLessThanOrEqual(Date.now() + 1000);
    expect(typeof rec.ms).toBe('number');
    expect(rec.ms).toBeGreaterThanOrEqual(0);
    // Nothing beyond the contract: no empty absent/error fields.
    expect(Object.keys(rec).sort()).toEqual(['flow', 'kind', 'ms', 'ok', 'ts']);
  });

  it('appends exactly one failure record naming flow, step and cause', async () => {
    const dir = await makeDir({
      'a.flow.json5': failingFlow('fail_flow'),
      [REGISTRY_FILE]: activeRegistry('fail_flow'),
    });
    const err = await runFlow({ dir, flow: 'fail_flow' }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(FlowError);
    expect((err as FlowError).stepId).toBe('bad');

    const records = await rawRecords(dir);
    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec.flow).toBe('fail_flow');
    expect(rec.kind).toBe('run');
    expect(rec.ok).toBe(false);
    const error = rec.error as string;
    expect(error).toContain(`Flow 'fail_flow'`);
    expect(error).toContain(`step 'bad'`);
    expect(error).toContain((err as FlowError).message);
    expect(typeof rec.ms).toBe('number');
    expect(rec.ms).toBeGreaterThanOrEqual(0);
    expect(rec).not.toHaveProperty('absent');
    expect(Object.keys(rec).sort()).toEqual(['error', 'flow', 'kind', 'ms', 'ok', 'ts']);
  });

  it('logs successful absent step ids, including map-item ids', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('gone', { status: 404 })),
    );
    const dir = await makeDir({
      'a.flow.json5': JSON.stringify({
        name: 'abs_flow',
        description: 'WHEN TO USE: absence log test.',
        input: {},
        steps: [
          { id: 'single', kind: 'http_request', url: 'http://x.test/one', absent: [404] },
          { id: 'nums', kind: 'transform', expr: '[1, 2]' },
          {
            id: 'm',
            kind: 'map',
            over: 'steps.nums',
            as: 'n',
            step: { kind: 'http_request', url: 'http://x.test/r', absent: [404] },
          },
        ],
        output: '{{steps.single}}',
      }),
      [REGISTRY_FILE]: activeRegistry('abs_flow'),
    });
    const res = await runFlow({ dir, flow: 'abs_flow' });
    expect(res.absent).toEqual(['single', 'm[0]', 'm[1]']);

    const records = await rawRecords(dir);
    expect(records).toHaveLength(1);
    expect(records[0]!.ok).toBe(true);
    expect(records[0]!.absent).toEqual(['single', 'm[0]', 'm[1]']);
    expect(records[0]).not.toHaveProperty('error');
  });

  it('omits absent from the record when nothing was absent', async () => {
    const dir = await makeDir({
      'a.flow.json5': flow('plain_flow'),
      [REGISTRY_FILE]: activeRegistry('plain_flow'),
    });
    await runFlow({ dir, flow: 'plain_flow' });
    const records = await rawRecords(dir);
    expect(records).toHaveLength(1);
    expect(records[0]).not.toHaveProperty('absent');
    expect(records[0]).not.toHaveProperty('error');
  });

  it('appends one record per run', async () => {
    const dir = await makeDir({
      'a.flow.json5': flow('twice'),
      [REGISTRY_FILE]: activeRegistry('twice'),
    });
    await runFlow({ dir, flow: 'twice' });
    await runFlow({ dir, flow: 'twice' });
    expect(await rawRecords(dir)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// No log: refusals, no registry, pending
// ---------------------------------------------------------------------------
describe('runFlow does not log refusals', () => {
  it('does not create a log without a registry', async () => {
    const dir = await makeDir({ 'a.flow.json5': flow('free_flow') });
    await runFlow({ dir, flow: 'free_flow' });
    expect(await logExists(dir)).toBe(false);
  });

  it('does not create a log without a registry, even on failure', async () => {
    const dir = await makeDir({ 'a.flow.json5': failingFlow('free_fail') });
    await expect(runFlow({ dir, flow: 'free_fail' })).rejects.toThrow();
    expect(await logExists(dir)).toBe(false);
  });

  it('does not log an unknown flow lookup refusal', async () => {
    const dir = await makeDir({
      'a.flow.json5': flow('known'),
      [REGISTRY_FILE]: activeRegistry('known'),
    });
    await expect(runFlow({ dir, flow: 'nope' })).rejects.toThrow(/no flow named/);
    expect(await logExists(dir)).toBe(false);
  });

  it('does not log an invalid configuration refusal', async () => {
    const dir = await makeDir({
      'a.flow.json5': flow('reg_flow'),
      [REGISTRY_FILE]: 'n=7\n',
    });
    await expect(runFlow({ dir, flow: 'reg_flow' })).rejects.toThrow(REGISTRY_FILE);
    expect(await logExists(dir)).toBe(false);
  });

  it('does not log a registry coverage refusal', async () => {
    const dir = await makeDir({
      'a.flow.json5': flow('good'),
      'b.flow.json5': flow('unlisted'),
      [REGISTRY_FILE]: activeRegistry('good'),
    });
    await expect(runFlow({ dir, flow: 'good' })).rejects.toThrow(/not listed/);
    expect(await logExists(dir)).toBe(false);
  });

  it('does not log an eligibility refusal', async () => {
    const dir = await makeDir({
      'a.flow.json5': flow('reg_flow'),
      [REGISTRY_FILE]: activeRegistry('reg_flow', 'candidate'),
    });
    await expect(runFlow({ dir, flow: 'reg_flow' })).rejects.toThrow(/candidate/);
    expect(await logExists(dir)).toBe(false);
  });

  it('does not log a retired-flow refusal even with allowInactive', async () => {
    const dir = await makeDir({
      'a.flow.json5': flow('reg_flow'),
      [REGISTRY_FILE]: activeRegistry('reg_flow', 'retired'),
    });
    await expect(runFlow({ dir, flow: 'reg_flow', allowInactive: true })).rejects.toThrow(/retired/);
    expect(await logExists(dir)).toBe(false);
  });

  it('does not log a write refusal', async () => {
    const dir = await makeDir({
      'a.flow.json5': JSON.stringify({
        name: 'w_flow',
        description: 'WHEN TO USE: write refusal log test.',
        input: {},
        steps: [{ id: 'w', kind: 'http_request', method: 'POST', url: 'http://x.test/w' }],
        output: '{{steps.w}}',
      }),
      [REGISTRY_FILE]: activeRegistry('w_flow'),
    });
    await expect(runFlow({ dir, flow: 'w_flow' })).rejects.toThrow(/write-capable/);
    expect(await logExists(dir)).toBe(false);
  });

  it('does not log input refusals', async () => {
    const dir = await makeDir({
      'a.flow.json5': JSON.stringify({
        name: 'in_flow',
        description: 'WHEN TO USE: input refusal log test.',
        input: { n: { type: 'number', description: 'a number' } },
        steps: [{ id: 'out', kind: 'transform', expr: '{ n: input.n }' }],
        output: '{{steps.out}}',
      }),
      [REGISTRY_FILE]: activeRegistry('in_flow'),
    });
    const err = await runFlow({ dir, flow: 'in_flow', inputPairs: ['n=01'] }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(FlowError);
    expect(await logExists(dir)).toBe(false);
  });

  it('does not log an unexpected pending result', async () => {
    const engine = await import('../src/engine.js');
    const once = vi.spyOn(engine, 'executeFlow').mockImplementation((async () => ({
      status: 'pending' as const,
      pending: { ctx: null, stepIndex: 0 },
      proposalText: 'p',
    })) as unknown as typeof engine.executeFlow);
    try {
      const dir = await makeDir({
        'a.flow.json5': flow('gate_flow'),
        [REGISTRY_FILE]: activeRegistry('gate_flow'),
      });
      const err = await runFlow({ dir, flow: 'gate_flow' }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(FlowError);
      expect((err as FlowError).message).toMatch(/paused unexpectedly/);
      expect(once).toHaveBeenCalledTimes(1);
      expect(await logExists(dir)).toBe(false);
    } finally {
      once.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Append failure: diagnosed on stderr, never changes the result, still awaited
// ---------------------------------------------------------------------------
describe('runFlow append failures', () => {
  // A gate that holds appendLog until released, so the test can observe that
  // the run does not settle before logging has finished.
  async function mockAppend(gate?: { promise: Promise<void> }) {
    const registry = await import('../src/registry.js');
    const entered = deferred();
    const spy = vi.spyOn(registry, 'appendLog').mockImplementation(async () => {
      entered.resolve();
      if (gate) await gate.promise;
      throw new Error('disk full');
    });
    spies.push(spy);
    return { entered: entered.promise };
  }

  it('keeps a successful run successful and diagnoses stderr', async () => {
    const written = captureStderr();
    await mockAppend();
    const dir = await makeDir({
      'a.flow.json5': flow('ok_flow'),
      [REGISTRY_FILE]: activeRegistry('ok_flow'),
    });
    expect(await runFlow({ dir, flow: 'ok_flow' })).toEqual({ text: 'ran ok_flow' });
    const text = written.join('');
    expect(text).toContain('registry log append failed');
    expect(text).toContain('disk full');
  });

  it('keeps a failing run rejected with its own FlowError', async () => {
    const written = captureStderr();
    await mockAppend();
    const dir = await makeDir({
      'a.flow.json5': failingFlow('fail_flow'),
      [REGISTRY_FILE]: activeRegistry('fail_flow'),
    });
    const err = await runFlow({ dir, flow: 'fail_flow' }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(FlowError);
    expect((err as FlowError).stepId).toBe('bad');
    // The append error never replaces the flow failure.
    expect((err as Error).message).not.toContain('disk full');
    expect(written.join('')).toContain('registry log append failed: disk full');
  });

  it('awaits the append before settling, on success and on failure', async () => {
    for (const fixture of [flow('ok_flow'), failingFlow('fail_flow')]) {
      const gate = deferred();
      const { entered } = await mockAppend(gate);
      const dir = await makeDir({
        'a.flow.json5': fixture,
        [REGISTRY_FILE]: activeRegistry(JSON.parse(fixture).name as string),
      });
      let settled = false;
      const run = runFlow({ dir, flow: JSON.parse(fixture).name as string }).then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await Promise.race([entered, run]);
      await drainQueued();
      expect(settled).toBe(false);
      gate.resolve();
      await run;
      expect(settled).toBe(true);
    }
  });

  it('awaits pool cleanup before logging, and logging before settling', async () => {
    // The append can only run after closeAll finished: hold closeAll, then let
    // appendLog resolve, and assert the run stays unsettled until both finish.
    const pool = await import('../src/mcp-pool.js');
    const closeGate = deferred();
    const closing = deferred();
    const closeAll = vi.spyOn(pool.McpPool.prototype, 'closeAll').mockImplementation(async () => {
      closing.resolve();
      await closeGate.promise;
    });
    const entered = deferred();
    const appendDone = deferred();
    const append = vi
      .spyOn(await import('../src/registry.js'), 'appendLog')
      .mockImplementation(async () => {
        entered.resolve();
        await appendDone.promise;
      });
    let run: Promise<unknown> | undefined;
    try {
      const dir = await makeDir({
        'a.flow.json5': flow('order_flow'),
        [REGISTRY_FILE]: activeRegistry('order_flow'),
      });
      let settled = false;
      run = runFlow({ dir, flow: 'order_flow' }).then(
        (v) => {
          settled = true;
          return v;
        },
        (e) => {
          settled = true;
          return e;
        },
      );
      await Promise.race([closing.promise, run]);
      await drainQueued();
      // Cleanup has begun; logging must not yet have been entered.
      expect(append).not.toHaveBeenCalled();
      closeGate.resolve();
      await Promise.race([entered.promise, run]);
      await drainQueued();
      expect(append).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      appendDone.resolve();
      expect(await run).toEqual({ text: 'ran order_flow' });
    } finally {
      closeGate.resolve();
      appendDone.resolve();
      await run;
      append.mockRestore();
      closeAll.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Registry contents are never rewritten
// ---------------------------------------------------------------------------
describe('registry contents stay byte-identical', () => {
  it('leaves registry.json5 untouched and only appends to the log', async () => {
    const registryText = `{ ok_flow: { state: 'active', provenance: { source: 'test' } } }`;
    const dir = await makeDir({
      'a.flow.json5': flow('ok_flow'),
      [REGISTRY_FILE]: registryText,
    });
    const before = await readFile(join(dir, REGISTRY_FILE), 'utf8');
    expect(await loadRegistry(dir)).toBeDefined();
    await runFlow({ dir, flow: 'ok_flow' });
    const after = await readFile(join(dir, REGISTRY_FILE), 'utf8');
    expect(after).toBe(before);
    expect(after).toBe(registryText);
    // The log is the only added file.
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(dir)).sort()).toEqual([REGISTRY_FILE, 'a.flow.json5', LOG_FILE].sort());
  });

  it('a real append failure leaves the log file absent and the registry intact', async () => {
    const dir = await makeDir({
      'a.flow.json5': flow('ok_flow'),
      [REGISTRY_FILE]: activeRegistry('ok_flow'),
    });
    // Make the log path unwritable by putting a directory there.
    await mkdir(join(dir, LOG_FILE));
    const before = await readFile(join(dir, REGISTRY_FILE), 'utf8');
    const written = captureStderr();
    // A real appendLog that hits EISDIR: the run still succeeds.
    expect(await runFlow({ dir, flow: 'ok_flow' })).toEqual({ text: 'ran ok_flow' });
    expect(written.join('')).toContain('registry log append failed');
    expect(await readFile(join(dir, REGISTRY_FILE), 'utf8')).toBe(before);
  });

  it('a successful append uses appendLog and leaves a parseable record', async () => {
    const dir = await makeDir({
      'a.flow.json5': flow('ok_flow'),
      [REGISTRY_FILE]: activeRegistry('ok_flow'),
    });
    await appendLog(dir, { ts: new Date().toISOString(), flow: 'seed', kind: 'run', ok: true });
    const seed = await readFile(join(dir, LOG_FILE), 'utf8');
    await runFlow({ dir, flow: 'ok_flow' });
    const after = await readFile(join(dir, LOG_FILE), 'utf8');
    // The existing line is preserved verbatim; one record was appended.
    expect(after.startsWith(seed)).toBe(true);
    expect(await rawRecords(dir)).toHaveLength(2);
  });
});
