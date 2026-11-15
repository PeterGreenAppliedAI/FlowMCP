import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Outbound boundaries are mocked in every test in this file:
//  - the HTTP boundary (global fetch), so no request leaves the process;
//  - the downstream MCP client factory (createDownstreamClient), so the real
//    McpPool admission check runs against a mocked client instead of a child.
// Every test that reaches the pool installs its own mocked client; the default
// factory is the real one, so a test that forgets to mock still gets the real
// transport rather than a silent fake.
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
import { executeFlow, FlowError } from '../src/engine.js';
import { loadServers } from '../src/loader.js';
import { checkRegistryCoverage, REGISTRY_FILE } from '../src/registry.js';
import { flowSchema } from '../src/flow-schema.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const dirs: string[] = [];
const fetchMock = vi.fn();
// Default for every test: no real outbound HTTP. Tests that need a response
// override this with their own stub.
vi.stubGlobal('fetch', fetchMock);

const spies: Array<{ mockRestore: () => void }> = [];

afterEach(async () => {
  mocks.factory.mockClear();
  fetchMock.mockReset();
  while (spies.length) spies.pop()!.mockRestore();
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

// Capture stderr writes for the duration of one test; always restored.
function captureStderr(): string[] {
  const written: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });
  spies.push(spy);
  return written;
}

// A gate that resolves only when released: used to prove that runFlow waits
// for it (cleanup, execution) rather than racing ahead.
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function makeDir(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'flowmcp-run-core-'));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return dir;
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

// A read-only flow with a rich input schema: string, number, boolean.
const typedFlow = (): string =>
  JSON.stringify({
    name: 'typed',
    description: 'WHEN TO USE: input conversion tests.',
    input: {
      s: { type: 'string', description: 'free text' },
      n: { type: 'number', description: 'a number' },
      b: { type: 'boolean', description: 'a flag' },
    },
    steps: [
      {
        id: 'out',
        kind: 'transform',
        expr: '{ s: input.s, n: input.n, b: input.b }',
      },
    ],
    output: '{{steps.out}}',
  });

const defaultsFlow = (): string =>
  JSON.stringify({
    name: 'defaults',
    description: 'WHEN TO USE: default and required tests.',
    input: {
      city: { type: 'string', description: 'city', required: false, default: 'Paris' },
      must: { type: 'string', description: 'required, no default', required: true },
      opt: { type: 'string', description: 'optional, no default' },
    },
    steps: [
      {
        id: 'out',
        kind: 'transform',
        expr: '{ city: input.city, must: input.must, opt: input.opt }',
      },
    ],
    output: '{{steps.out}}',
  });

const httpRead = (url: string): string =>
  JSON.stringify({
    name: 'net_read',
    description: 'WHEN TO USE: fetch boundary test.',
    input: {},
    steps: [{ id: 'r', kind: 'http_request', url }],
    output: '{{steps.r}}',
  });

// ---------------------------------------------------------------------------
// Completion, step/output failure, unexpected pending
// ---------------------------------------------------------------------------
describe('runFlow completion and failures', () => {
  it('completes a read-only flow and returns its text', async () => {
    const dir = await makeDir({
      'a.flow.json5': flow('ok_flow'),
      'b.flow.json5': flow('other_flow'),
    });
    expect(await runFlow({ dir, flow: 'ok_flow' })).toEqual({ text: 'ran ok_flow' });
  });

  it('returns absent ids from a completed flow', async () => {
    fetchMock.mockResolvedValue(new Response('gone', { status: 404 }));
    const dir = await makeDir({
      'a.flow.json5': JSON.stringify({
        name: 'abs',
        description: 'WHEN TO USE: absence test.',
        input: {},
        steps: [{ id: 'r', kind: 'http_request', url: 'http://x.test/thing', absent: [404] }],
        output: 'r={{steps.r}}',
      }),
    });
    const res = await runFlow({ dir, flow: 'abs' });
    expect(res.text).toBe('r=');
    expect(res.absent).toEqual(['r']);
  });

  it('preserves the step id and cause of a step failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('network down'));
    const dir = await makeDir({ 'a.flow.json5': httpRead('http://x.test/boom') });
    const err = await runFlow({ dir, flow: 'net_read' }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(FlowError);
    expect((err as FlowError).stepId).toBe('r');
    // GET retries once on a network-level failure; both attempts fail.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((err as FlowError).message).toContain('network down');
  });

  it('preserves the output step id and cause of an output failure', async () => {
    const dir = await makeDir({
      'a.flow.json5': JSON.stringify({
        name: 'bad_out',
        description: 'WHEN TO USE: output failure test.',
        input: {},
        steps: [{ id: 't', kind: 'template', template: 'x' }],
        output: '{{steps.t.nope.deeper}}',
      }),
    });
    const err = await runFlow({ dir, flow: 'bad_out' }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(FlowError);
    expect((err as FlowError).stepId).toBe('output');
  });

  it('rejects an unexpected pending result and does not resume it', async () => {
    // A write-capable flow is refused before execution, so a pending result is
    // reachable here only if the engine returns pending for a flow the loader
    // judged read-only. Mock the engine's single call: runFlow must reject
    // with the paused step id and never call the engine again (no resume).
    const engine = await import('../src/engine.js');
    const once = vi.spyOn(engine, 'executeFlow').mockImplementation((async () => ({
      status: 'pending' as const,
      pending: { ctx: null, stepIndex: 0 },
      proposalText: 'p',
    })) as unknown as typeof engine.executeFlow);
    try {
      const dir = await makeDir({ 'a.flow.json5': flow('gate_flow') });
      const err = await runFlow({ dir, flow: 'gate_flow' }).then(() => undefined, (e: unknown) => e);
      expect(err).toBeInstanceOf(FlowError);
      expect((err as FlowError).stepId).toBe('out');
      expect((err as FlowError).message).toMatch(/paused unexpectedly/);
      expect(once).toHaveBeenCalledTimes(1);
    } finally {
      once.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Input conversion
// ---------------------------------------------------------------------------
describe('runFlow input conversion', () => {
  async function run(inputPairs: string[], fixture = typedFlow(), name = 'typed'): Promise<Record<string, unknown>> {
    const dir = await makeDir({ 'a.flow.json5': fixture });
    const res = await runFlow({ dir, flow: name, inputPairs });
    return JSON.parse(res.text) as Record<string, unknown>;
  }

  async function failure(inputPairs: string[], fixture = typedFlow(), name = 'typed'): Promise<unknown> {
    const dir = await makeDir({ 'a.flow.json5': fixture });
    return runFlow({ dir, flow: name, inputPairs }).then(() => undefined, (e: unknown) => e);
  }

  it('splits at the first = and preserves the string remainder exactly', async () => {
    expect((await run(['s=a=b=c,d,, e'])).s).toBe('a=b=c,d,, e');
    expect((await run(['s='])).s).toBe('');
    expect((await run(['s===='])).s).toBe('===');
    expect((await run(['s= pad '])).s).toBe(' pad ');
    expect((await run(['s=,,,'])).s).toBe(',,,');
    expect((await run(['s=a=b'])).s).toBe('a=b');
    expect((await run(['s=true'])).s).toBe('true');
    expect((await run(['s=1'])).s).toBe('1');
  });

  it('converts booleans strictly', async () => {
    expect(await run(['b=true'])).toMatchObject({ b: true });
    expect(await run(['b=false'])).toMatchObject({ b: false });
    for (const bad of ['TRUE', 'True', '1', '0', 'yes', ' true', '', 'false ', 'true\n']) {
      const err = await failure([`b=${bad}`]);
      expect(err).toBeInstanceOf(FlowError);
      expect((err as FlowError).stepId).toBe('input');
    }
  });

  it('accepts finite JSON-number literals and rejects everything else', async () => {
    expect(await run(['n=0'])).toMatchObject({ n: 0 });
    expect(await run(['n=-12'])).toMatchObject({ n: -12 });
    expect(await run(['n=1.5'])).toMatchObject({ n: 1.5 });
    expect(await run(['n=1e3'])).toMatchObject({ n: 1000 });
    expect(await run(['n=1E+3'])).toMatchObject({ n: 1000 });
    expect(await run(['n=1e-3'])).toMatchObject({ n: 0.001 });
    expect(await run(['n=-0.25'])).toMatchObject({ n: -0.25 });
    for (const bad of [
      '',
      ' 1',
      '1 ',
      '7\n',
      '\n7',
      '1\n2',
      '7\r',
      '7\t',
      '+1',
      '01',
      '.5',
      '1.',
      '1.e3',
      '0x10',
      '1e999',
      '-1e999',
      'Infinity',
      '-Infinity',
      'NaN',
      'abc',
      '1,2',
      '1e',
      '--1',
    ]) {
      const err = await failure([`n=${bad}`]);
      expect(err).toBeInstanceOf(FlowError);
      expect((err as FlowError).stepId).toBe('input');
      expect((err as FlowError).message).toMatch(/JSON number|finite number/);
    }
  });

  it("rejects input 'n=7\\n' at the flow boundary", async () => {
    const dir = await makeDir({ 'a.flow.json5': typedFlow() });
    fetchMock.mockResolvedValue(new Response('ok'));
    const err = await runFlow({ dir, flow: 'typed', inputPairs: ['n=7\n'] }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(FlowError);
    expect((err as FlowError).stepId).toBe('input');
    expect((err as FlowError).message).toContain("got '7\n'");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.factory).not.toHaveBeenCalled();
  });

  it('applies defaults and leaves optional inputs omitted', async () => {
    const got = await run(['must=ok'], defaultsFlow(), 'defaults');
    expect(got.city).toBe('Paris');
    expect('opt' in got).toBe(false);
    expect(got.must).toBe('ok');
    const overridden = await run(['must=ok', 'city=Rome'], defaultsFlow(), 'defaults');
    expect(overridden.city).toBe('Rome');
  });

  it('checks missing required parameters without defaults before the engine runs', async () => {
    const dir = await makeDir({ 'a.flow.json5': defaultsFlow() });
    fetchMock.mockResolvedValue(new Response('ok'));
    const err = await runFlow({ dir, flow: 'defaults' }).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(FlowError);
    expect((err as FlowError).stepId).toBe('input');
    expect((err as FlowError).message).toContain("missing required parameter 'must'");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.factory).not.toHaveBeenCalled();
  });

  it('checks a required inherited name (constructor) as missing before the engine runs', async () => {
    const fixture = JSON.stringify({
      name: 'proto_req',
      description: 'WHEN TO USE: inherited required name.',
      input: {
        constructor: { type: 'string', description: 'required, no default', required: true },
      },
      steps: [{ id: 'out', kind: 'template', template: 'ran' }],
      output: '{{steps.out}}',
    });
    const dir = await makeDir({ 'a.flow.json5': fixture });
    const err = await runFlow({ dir, flow: 'proto_req' }).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(FlowError);
    expect((err as FlowError).stepId).toBe('input');
    expect((err as FlowError).message).toContain("missing required parameter 'constructor'");
    expect(mocks.factory).not.toHaveBeenCalled();
  });

  it('rejects a pair with no = and an empty key', async () => {
    for (const pair of ['s', '=ok', '']) {
      const err = await failure([pair]);
      expect(err).toBeInstanceOf(FlowError);
      expect((err as FlowError).stepId).toBe('input');
    }
  });

  it('rejects duplicate keys', async () => {
    const err = await failure(['s=a', 's=b']);
    expect(err).toBeInstanceOf(FlowError);
    expect((err as FlowError).message).toContain("duplicate parameter 's'");
  });

  it('rejects unknown keys, including inherited prototype names', async () => {
    for (const key of ['bogus', 'constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
      const err = await failure([`${key}=x`]);
      expect(err).toBeInstanceOf(FlowError);
      expect((err as FlowError).stepId).toBe('input');
      expect((err as FlowError).message).toContain(`unknown parameter '${key}'`);
    }
  });

  it('rejects input on a flow that takes no parameters', async () => {
    const err = await failure(['x=1'], flow('no_params'), 'no_params');
    expect(err).toBeInstanceOf(FlowError);
    expect((err as FlowError).message).toContain('takes no parameters');
  });
});

// ---------------------------------------------------------------------------
// Registry states and admission
// ---------------------------------------------------------------------------
describe('runFlow registry admission', () => {
  const states = ['candidate', 'reviewed', 'active', 'retired'] as const;

  it.each(states)('state %s without override', async (state) => {
    const written = captureStderr();
    const dir = await makeDir({
      'a.flow.json5': flow('reg_flow'),
      [REGISTRY_FILE]: `{ reg_flow: { state: '${state}' } }`,
    });
    const res = await runFlow({ dir, flow: 'reg_flow' }).then(() => 'ok', (e: unknown) => e);
    if (state === 'active') {
      expect(res).toBe('ok');
    } else {
      expect(res).toBeInstanceOf(Error);
      expect((res as Error).message).toContain(`'${state}'`);
    }
    // Only candidate/reviewed with the override note; no other state writes.
    expect(written.join('')).toBe('');
  });

  it.each(states)('state %s with allowInactive', async (state) => {
    const written = captureStderr();
    const dir = await makeDir({
      'a.flow.json5': flow('reg_flow'),
      [REGISTRY_FILE]: `{ reg_flow: { state: '${state}' } }`,
    });
    const res = await runFlow({ dir, flow: 'reg_flow', allowInactive: true }).then(
      () => 'ok',
      (e: unknown) => e,
    );
    if (state === 'retired') {
      expect(res).toBeInstanceOf(Error);
      expect((res as Error).message).toContain("'retired'");
      expect(written.join('')).toBe('');
    } else if (state === 'active') {
      expect(res).toBe('ok');
      expect(written.join('')).toBe('');
    } else {
      expect(res).toBe('ok');
      const noteText = written.join('');
      expect(noteText).toContain(`'${state}'`);
      expect(noteText).toContain('allowInactive');
    }
  });

  it('runs any valid read-only flow with no registry', async () => {
    const dir = await makeDir({ 'a.flow.json5': flow('free_flow') });
    expect(await runFlow({ dir, flow: 'free_flow' })).toEqual({ text: 'ran free_flow' });
  });

  it('uses own-property registry lookups: an empty registry never admits an unknown flow', async () => {
    // No entry at all: the flow must be refused as unlisted before any run.
    const dir = await makeDir({
      'a.flow.json5': flow('reg_flow'),
      [REGISTRY_FILE]: `{}`,
    });
    fetchMock.mockResolvedValue(new Response('ok'));
    const err = await runFlow({ dir, flow: 'reg_flow' }).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/not listed/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('checkRegistryCoverage reports a flow without an entry as unlisted', () => {
    expect(() => checkRegistryCoverage({}, ['reg_flow'])).toThrow(/not listed/);
    // A real entry is accepted, and an entry for an unloaded flow is refused.
    expect(() => checkRegistryCoverage({ reg_flow: { state: 'active' as const } }, ['reg_flow'])).not.toThrow();
    expect(() => checkRegistryCoverage({ ghost: { state: 'active' as const } }, [])).toThrow(/does not match/);
  });

  it("rejects registry text 'n=7\\n' as invalid configuration", async () => {
    const dir = await makeDir({
      'a.flow.json5': flow('reg_flow'),
      [REGISTRY_FILE]: 'n=7\n',
    });
    const err = await runFlow({ dir, flow: 'reg_flow' }).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(REGISTRY_FILE);
  });

  it('refuses an unknown flow name', async () => {
    const dir = await makeDir({ 'a.flow.json5': flow('known') });
    await expect(runFlow({ dir, flow: 'nope' })).rejects.toThrow(/no flow named 'nope'/);
  });
});

// ---------------------------------------------------------------------------
// Whole-directory validation before execution
// ---------------------------------------------------------------------------
// A flow whose first step is a visible probe: if execution started, fetch and
// the downstream factory were called. Every validation test asserts neither.
const probeFlow = (name: string): string =>
  JSON.stringify({
    name,
    description: `WHEN TO USE: probe '${name}'.`,
    input: {},
    steps: [{ id: 'probe', kind: 'http_request', url: `http://x.test/${name}` }],
    output: '{{steps.probe}}',
  });

function expectNoExecution(): void {
  expect(fetchMock).not.toHaveBeenCalled();
  expect(mocks.factory).not.toHaveBeenCalled();
}

describe('runFlow directory validation', () => {
  it('refuses a selected flow when an invalid sibling flow is present', async () => {
    fetchMock.mockResolvedValue(new Response('ok'));
    const dir = await makeDir({
      'a.flow.json5': probeFlow('good'),
      'b.flow.json5': `{ name: 'broken', steps: [] }`,
    });
    await expect(runFlow({ dir, flow: 'good' })).rejects.toThrow(/broken|invalid/);
    expectNoExecution();
  });

  it('refuses a selected flow when a sibling calls an unknown server', async () => {
    fetchMock.mockResolvedValue(new Response('ok'));
    const dir = await makeDir({
      'a.flow.json5': probeFlow('good'),
      'b.flow.json5': JSON.stringify({
        name: 'orphan',
        description: 'WHEN TO USE: sibling.',
        input: {},
        steps: [{ id: 'c', kind: 'mcp_call', server: 'ghost', tool: 't' }],
        output: '{{steps.c}}',
      }),
    });
    await expect(runFlow({ dir, flow: 'good' })).rejects.toThrow(/unknown MCP server 'ghost'/);
    expectNoExecution();
  });

  it('refuses a selected flow when servers.json5 is invalid', async () => {
    fetchMock.mockResolvedValue(new Response('ok'));
    const dir = await makeDir({
      'a.flow.json5': probeFlow('good'),
      'servers.json5': `{ bad: { command: 42 } }`,
    });
    await expect(runFlow({ dir, flow: 'good' })).rejects.toThrow(/servers\.json5: invalid/);
    expectNoExecution();
  });

  it('refuses a selected flow when an absence declaration is invalid', async () => {
    fetchMock.mockResolvedValue(new Response('ok'));
    const dir = await makeDir({
      'a.flow.json5': probeFlow('good'),
      'b.flow.json5': JSON.stringify({
        name: 'bad_absent',
        description: 'WHEN TO USE: sibling.',
        input: {},
        steps: [{ id: 'p', kind: 'http_request', method: 'POST', url: 'http://x.test/w', absent: [404] }],
        output: '{{steps.w}}',
      }),
    });
    // The POST step is also write-capable; the absence check runs first.
    await expect(runFlow({ dir, flow: 'good' })).rejects.toThrow(/absent.*only for reads/);
    expectNoExecution();
  });

  it('refuses a selected flow when registry coverage is incomplete', async () => {
    fetchMock.mockResolvedValue(new Response('ok'));
    const dir = await makeDir({
      'a.flow.json5': probeFlow('good'),
      'b.flow.json5': probeFlow('unlisted'),
      [REGISTRY_FILE]: `{ good: { state: 'active' } }`,
    });
    await expect(runFlow({ dir, flow: 'good' })).rejects.toThrow(/not listed/);
    expectNoExecution();
  });

  it('refuses a selected flow when registry.json5 is a directory (read error)', async () => {
    fetchMock.mockResolvedValue(new Response('ok'));
    const dir = await makeDir({ 'a.flow.json5': probeFlow('good') });
    await mkdir(join(dir, REGISTRY_FILE));
    const err = await runFlow({ dir, flow: 'good' }).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as NodeJS.ErrnoException).code).toBe('EISDIR');
    expectNoExecution();
  });
});

// ---------------------------------------------------------------------------
// Write refusal, including maps and both branch arms
// ---------------------------------------------------------------------------
describe('runFlow write refusal', () => {
  // Every write flow starts with a visible probe read (or, for the map, a
  // transform that produces values) before the write, so the assertions below
  // can see whether execution started at all.
  const writeFlows: Record<string, string> = {
    direct_post: JSON.stringify({
      name: 'direct_post',
      description: 'WHEN TO USE: write.',
      input: {},
      steps: [
        { id: 'probe', kind: 'http_request', url: 'http://x.test/read-first' },
        { id: 'w', kind: 'http_request', method: 'POST', url: 'http://x.test/w' },
      ],
      output: '{{steps.probe}}',
    }),
    map_post: JSON.stringify({
      name: 'map_post',
      description: 'WHEN TO USE: write.',
      input: {},
      steps: [
        { id: 'probe', kind: 'http_request', url: 'http://x.test/read-first' },
        { id: 'nums', kind: 'transform', expr: '[1, 2]' },
        {
          id: 'm',
          kind: 'map',
          over: 'steps.nums',
          as: 'n',
          step: { kind: 'http_request', method: 'POST', url: 'http://x.test/w' },
        },
      ],
      output: '{{steps.m}}',
    }),
    // The branch condition selects the read arm; the write sits in then.
    branch_then: JSON.stringify({
      name: 'branch_then',
      description: 'WHEN TO USE: write.',
      input: {},
      steps: [
        { id: 'probe', kind: 'http_request', url: 'http://x.test/read-first' },
        {
          id: 'br',
          kind: 'branch',
          if: 'false',
          then: [{ id: 'w', kind: 'http_request', method: 'POST', url: 'http://x.test/w' }],
          else: [{ id: 'r', kind: 'template', template: 'read' }],
        },
      ],
      output: '{{steps.probe}}',
    }),
    // The branch condition selects the read arm; the write sits in else.
    branch_else: JSON.stringify({
      name: 'branch_else',
      description: 'WHEN TO USE: write.',
      input: {},
      steps: [
        { id: 'probe', kind: 'http_request', url: 'http://x.test/read-first' },
        {
          id: 'br',
          kind: 'branch',
          if: 'true',
          then: [{ id: 'r', kind: 'template', template: 'read' }],
          else: [{ id: 'w', kind: 'http_request', method: 'POST', url: 'http://x.test/w' }],
        },
      ],
      output: '{{steps.probe}}',
    }),
    map_allowlisted: JSON.stringify({
      name: 'map_allowlisted',
      description: 'WHEN TO USE: write.',
      input: {},
      steps: [
        { id: 'probe', kind: 'http_request', url: 'http://x.test/read-first' },
        { id: 'nums', kind: 'transform', expr: '[1, 2]' },
        {
          id: 'm',
          kind: 'map',
          over: 'steps.nums',
          as: 'n',
          step: { kind: 'mcp_call', server: 'm', tool: 'write_it' },
        },
      ],
      output: '{{steps.m}}',
    }),
    // The else arm holds the write; the condition selects then.
    branch_allowlisted: JSON.stringify({
      name: 'branch_allowlisted',
      description: 'WHEN TO USE: write.',
      input: {},
      steps: [
        { id: 'probe', kind: 'http_request', url: 'http://x.test/read-first' },
        {
          id: 'br',
          kind: 'branch',
          if: 'true',
          then: [{ id: 'r', kind: 'template', template: 'read' }],
          else: [{ id: 'w', kind: 'mcp_call', server: 'm', tool: 'write_it' }],
        },
      ],
      output: '{{steps.probe}}',
    }),
    // The then arm holds the allowlisted write; the condition selects else.
    branch_then_allowlisted: JSON.stringify({
      name: 'branch_then_allowlisted',
      description: 'WHEN TO USE: write.',
      input: {},
      steps: [
        { id: 'probe', kind: 'http_request', url: 'http://x.test/read-first' },
        {
          id: 'br',
          kind: 'branch',
          if: 'false',
          then: [{ id: 'w', kind: 'mcp_call', server: 'm', tool: 'write_it' }],
          else: [{ id: 'r', kind: 'template', template: 'read' }],
        },
      ],
      output: '{{steps.probe}}',
    }),
  };

  const serversWithAllow = `{ m: { command: 'node', allow: ['write_it'] } }`;

  for (const [name, text] of Object.entries(writeFlows)) {
    it(`refuses ${name} before any step`, async () => {
      fetchMock.mockResolvedValue(new Response('ok'));
      const dir = await makeDir({ 'a.flow.json5': text });
      if (name.includes('allowlisted')) {
        await writeFile(join(dir, 'servers.json5'), serversWithAllow);
      }
      await expect(runFlow({ dir, flow: name })).rejects.toThrow(/write-capable.*flowmcp serve/);
      // The preceding read must not have run: no fetch, no downstream client.
      expectNoExecution();
    });
  }

  it('a map of reads stays eligible', async () => {
    fetchMock.mockImplementation(async () => new Response('one', { status: 200 }));
    const dir = await makeDir({
      'a.flow.json5': JSON.stringify({
        name: 'map_reads',
        description: 'WHEN TO USE: reads.',
        input: {},
        steps: [
          { id: 'nums', kind: 'transform', expr: '[1, 2]' },
          {
            id: 'm',
            kind: 'map',
            over: 'steps.nums',
            as: 'n',
            step: { kind: 'http_request', url: 'http://x.test/r' },
          },
        ],
        output: '{{steps.m}}',
      }),
    });
    const res = await runFlow({ dir, flow: 'map_reads' });
    expect(res.text).toBe('one\none');
  });
});

// ---------------------------------------------------------------------------
// Real McpPool admission with a mocked downstream client
// ---------------------------------------------------------------------------
describe('runFlow MCP admission and pool lifecycle', () => {
  // A mocked downstream that lists a read-annotated tool and an unannotated
  // tool, records every call it receives, and closes only when released.
  // close() never resolves until the test releases it, so a run that does not
  // await closeAll stays pending and the test can observe that.
  interface MockClient {
    calls: string[];
    opened: () => number;
    closed: () => number;
    releaseClose: () => void;
    listTools: ReturnType<typeof vi.fn>;
    callTool: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }

  function mockClient(): MockClient {
    const state = { calls: [] as string[], opened: 0, closed: 0 };
    const gate = deferred();
    return {
      calls: state.calls,
      opened: () => state.opened,
      closed: () => state.closed,
      releaseClose: () => gate.resolve(),
      connect: vi.fn(async () => {
        state.opened++;
      }),
      listTools: vi.fn(async () => [
        { name: 'echo', description: 'read tool', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
        { name: 'write_thing', description: 'unannotated', inputSchema: { type: 'object' } },
      ]),
      callTool: vi.fn(async (name: string) => {
        state.calls.push(name);
        return { content: [{ type: 'text', text: 'echoed' }] };
      }),
      close: vi.fn(async () => {
        // Count only when the close actually finishes.
        await gate.promise;
        state.closed++;
      }),
    } as MockClient & Record<string, unknown>;
  }

  const mcpFlow = (tool: string, extra: Record<string, unknown> = {}, name = 'mcp_flow'): string =>
    JSON.stringify({
      name,
      description: 'WHEN TO USE: mcp admission.',
      input: {},
      steps: [
        { id: 'c', kind: 'mcp_call', server: 'm', tool, ...extra },
        { id: 'out', kind: 'template', template: '{{steps.c}}' },
      ],
      output: '{{steps.out}}',
    });

  it('never calls an unannotated, unattested, unallowed tool', async () => {
    const client = mockClient();
    client.releaseClose();
    mocks.factory.mockReturnValueOnce(client);
    const dir = await makeDir({
      'a.flow.json5': mcpFlow('write_thing'),
      'servers.json5': `{ m: { command: 'node' } }`,
    });
    const err = await runFlow({ dir, flow: 'mcp_flow' }).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(FlowError);
    expect((err as FlowError).stepId).toBe('c');
    expect((err as FlowError).message).toMatch(/not marked read-only/);
    expect(client.calls).toEqual([]);
    expect(client.closed()).toBe(1);
  });

  it('calls a read-annotated tool through the pool and closes it', async () => {
    const client = mockClient();
    client.releaseClose();
    mocks.factory.mockReturnValueOnce(client);
    const dir = await makeDir({
      'a.flow.json5': mcpFlow('echo'),
      'servers.json5': `{ m: { command: 'node' } }`,
    });
    expect(await runFlow({ dir, flow: 'mcp_flow' })).toEqual({ text: 'echoed' });
    expect(client.calls).toEqual(['echo']);
    expect(client.closed()).toBe(1);
  });

  it('passes baseDir = dir to the pool (relative paths anchor to the flows dir)', async () => {
    const client = mockClient();
    client.releaseClose();
    mocks.factory.mockReturnValueOnce(client);
    const dir = await makeDir({
      'a.flow.json5': mcpFlow('echo'),
      'servers.json5': `{ m: { command: 'node', args: ['relative/server.ts'] } }`,
    });
    const written = captureStderr();
    await runFlow({ dir, flow: 'mcp_flow' });
    const target = mocks.factory.mock.calls[0]![1] as { cwd?: string };
    expect(target.cwd).toBe(dir);
    // The pool warns about the missing relative path against that baseDir.
    expect(written.join('')).toContain(`relative to ${dir}`);
  });

  it('awaits closeAll on success and keeps the run unsettled until cleanup finishes', async () => {
    const client = mockClient();
    mocks.factory.mockReturnValueOnce(client);
    const dir = await makeDir({
      'a.flow.json5': mcpFlow('echo'),
      'servers.json5': `{ m: { command: 'node' } }`,
    });
    let settled = false;
    const run = runFlow({ dir, flow: 'mcp_flow' }).then(
      (v) => {
        settled = true;
        return v;
      },
      (e) => {
        settled = true;
        throw e;
      },
    );
    run.catch(() => {});
    await new Promise((r) => setTimeout(r, 25));
    expect(settled).toBe(false);
    expect(client.closed()).toBe(0);
    client.releaseClose();
    expect(await run).toEqual({ text: 'echoed' });
    expect(client.closed()).toBe(1);
  });

  it('awaits closeAll on failure and keeps the rejection unsettled until cleanup finishes', async () => {
    const client = mockClient();
    client.callTool.mockImplementation(async () => {
      throw new Error('downstream exploded');
    });
    mocks.factory.mockReturnValueOnce(client);
    const dir = await makeDir({
      'a.flow.json5': mcpFlow('echo'),
      'servers.json5': `{ m: { command: 'node' } }`,
    });
    let settled = false;
    const run = runFlow({ dir, flow: 'mcp_flow' }).then(
      () => {
        settled = true;
      },
      (e: unknown) => {
        settled = true;
        return e;
      },
    );
    await new Promise((r) => setTimeout(r, 25));
    expect(settled).toBe(false);
    expect(client.closed()).toBe(0);
    client.releaseClose();
    const err = await run;
    expect(err).toBeInstanceOf(FlowError);
    expect((err as FlowError).message).toMatch(/downstream exploded/);
    expect(client.closed()).toBe(1);
  });

  it('awaits closeAll on an unexpected pending result', async () => {
    // A write-capable flow is refused before execution, so the runner's
    // pending branch is reached only when the engine returns pending for a
    // flow the loader judged read-only. This test mocks executeFlow for the
    // runner's single call, then releases a deferred closeAll so the pending
    // rejection stays unsettled until cleanup has finished.
    const engine = await import('../src/engine.js');
    const pool = await import('../src/mcp-pool.js');
    const once = vi.spyOn(engine, 'executeFlow').mockImplementation((async () => ({
      status: 'pending' as const,
      pending: { ctx: null, stepIndex: 1 },
      proposalText: 'p',
    })) as unknown as typeof engine.executeFlow);
    const closeGate = deferred();
    const closeAll = vi.spyOn(pool.McpPool.prototype, 'closeAll').mockImplementation(async () => {
      await closeGate.promise;
    });
    try {
      const dir = await makeDir({
        'a.flow.json5': mcpFlow('echo'),
        'servers.json5': `{ m: { command: 'node' } }`,
      });
      let settled = false;
      const run = runFlow({ dir, flow: 'mcp_flow' }).then(
        () => {
          settled = true;
        },
        (e: unknown) => {
          settled = true;
          return e;
        },
      );
      await new Promise((r) => setTimeout(r, 25));
      expect(settled).toBe(false);
      expect(once).toHaveBeenCalledTimes(1);
      expect(closeAll).toHaveBeenCalledTimes(1);
      closeGate.resolve();
      const err = await run;
      expect(err).toBeInstanceOf(FlowError);
      expect((err as FlowError).stepId).toBe('out');
      expect((err as Error).message).toMatch(/paused unexpectedly/);
      expect(once).toHaveBeenCalledTimes(1); // never resumed
    } finally {
      closeAll.mockRestore();
      once.mockRestore();
    }
  });

  it('does not create a pool when inputs are invalid', async () => {
    const dir = await makeDir({
      'a.flow.json5': mcpFlow('echo'),
      'servers.json5': `{ m: { command: 'node' } }`,
    });
    const err = await runFlow({ dir, flow: 'mcp_flow', inputPairs: ['x=1'] }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(FlowError);
    expect(mocks.factory).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Owner decisions: loadServers read errors, coerceInput own properties
// ---------------------------------------------------------------------------
describe('loadServers read errors', () => {
  it('returns {} when servers.json5 is missing', async () => {
    const dir = await makeDir({ 'a.flow.json5': flow('x') });
    expect(await loadServers(dir)).toEqual({});
  });

  it('rejects with EISDIR when servers.json5 is a directory', async () => {
    const dir = await makeDir({ 'a.flow.json5': flow('x') });
    await mkdir(join(dir, 'servers.json5'));
    const err = await loadServers(dir).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as NodeJS.ErrnoException).code).toBe('EISDIR');
  });

  it('refuses a selected flow when servers.json5 is a directory (read error)', async () => {
    const dir = await makeDir({ 'a.flow.json5': flow('x') });
    await mkdir(join(dir, 'servers.json5'));
    const err = await runFlow({ dir, flow: 'x' }).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as NodeJS.ErrnoException).code).toBe('EISDIR');
  });
});

describe('coerceInput own properties', () => {
  const flowWithInput = (input: Record<string, unknown>) =>
    flowSchema.parse({
      name: 'f',
      description: 'WHEN TO USE: own-property test.',
      input,
      steps: [{ id: 'out', kind: 'template', template: '{{input.a}}' }],
      output: '{{steps.out}}',
    });

  it('rejects inherited Object.prototype names as unknown parameters', async () => {
    const f = flowWithInput({ a: { type: 'string', description: 'a' } });
    for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const err = await executeFlow(f, JSON.parse(`{"${key}": "x"}`)).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(FlowError);
      expect((err as FlowError).message).toMatch(/unknown parameter/);
    }
  });

  it('does not read an inherited value for a declared parameter (omits it)', async () => {
    const f = flowWithInput({ a: { type: 'string', description: 'a' } });
    // The argument object inherits 'a' (a getter on its prototype) but owns no
    // 'a'. A prototype-chain read would hand 'inherited' to the engine.
    const proto = Object.defineProperty({}, 'a', {
      get: () => 'inherited',
      enumerable: true,
    });
    const args = Object.create(proto) as Record<string, unknown>;
    const run = await executeFlow(f, args);
    expect(run.status).toBe('complete');
    expect((run as { text: string }).text).toBe('');
  });

  it('does not read an inherited value, and applies an own default when omitted', async () => {
    const f = flowWithInput({ a: { type: 'string', description: 'a', default: 'dflt' } });
    const proto = Object.defineProperty({}, 'a', {
      get: () => 'inherited',
      enumerable: true,
    });
    const args = Object.create(proto) as Record<string, unknown>;
    expect(await executeFlow(f, args)).toMatchObject({ status: 'complete', text: 'dflt' });
    // An own supplied value wins over the default.
    const own: Record<string, unknown> = { a: 'own' };
    expect(await executeFlow(f, own)).toMatchObject({ status: 'complete', text: 'own' });
  });

  it('keeps the nullish fallback: a null value falls back to a default or is omitted', async () => {
    // Existing behavior preserved: an explicit null is "not supplied".
    const withDefault = flowWithInput({ a: { type: 'string', description: 'a', default: 'dflt' } });
    expect(await executeFlow(withDefault, { a: null })).toMatchObject({ status: 'complete', text: 'dflt' });
    const optional = flowWithInput({ a: { type: 'string', description: 'a' } });
    expect(await executeFlow(optional, { a: null })).toMatchObject({ status: 'complete', text: '' });
  });

  it('rejects a supplied value of the wrong type', async () => {
    const f = flowWithInput({ a: { type: 'string', description: 'a' } });
    const err = await executeFlow(f, { a: 3 }).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(FlowError);
    expect((err as FlowError).stepId).toBe('input');
  });
});
