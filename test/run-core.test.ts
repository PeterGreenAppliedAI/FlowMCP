import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Outbound boundaries are mocked in every test in this file:
//  - the HTTP boundary (global fetch), so no request leaves the process;
//  - the downstream MCP client factory (createDownstreamClient), so the real
//    McpPool admission check runs against a mocked client instead of a child.
// The factory mock delegates to the real module for the cases that need a
// real downstream (the mock MCP server fixture), keyed on the server name.
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

import { __clearWriteGate, __simulateWriteGate, runFlow } from '../src/run-core.js';
import { FlowError } from '../src/engine.js';
import { loadServers } from '../src/loader.js';
import { checkRegistryCoverage, REGISTRY_FILE } from '../src/registry.js';
import { executeFlow } from '../src/engine.js';
import { flowSchema } from '../src/flow-schema.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const dirs: string[] = [];
const fetchMock = vi.fn();
// Default for every test: no real outbound HTTP. Tests that need a response
// override this with their own stub.
vi.stubGlobal('fetch', fetchMock);

afterEach(async () => {
  mocks.factory.mockClear();
  fetchMock.mockReset();
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

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

// A read-only flow with a rich input schema: string, number, boolean,
// defaulted and required parameters. Flows take at most 3 parameters, so the
// conversion tests use two fixtures: one for the scalars, one for defaults.
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

  it('rejects an unexpected pending result without resuming', async () => {
    const dir = await makeDir({ 'a.flow.json5': flow('gate_flow') });
    __simulateWriteGate('gate_flow', ['out']);
    try {
      const err = await runFlow({ dir, flow: 'gate_flow' }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(FlowError);
      expect((err as FlowError).stepId).toBe('out');
      expect((err as FlowError).message).toMatch(/paused unexpectedly/);
    } finally {
      __clearWriteGate('gate_flow');
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
  });

  it('converts booleans strictly', async () => {
    expect(await run(['b=true'])).toMatchObject({ b: true });
    expect(await run(['b=false'])).toMatchObject({ b: false });
    for (const bad of ['TRUE', 'True', '1', '0', 'yes', ' true', '', 'false ']) {
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
    expect(await run(['n=-0.25'])).toMatchObject({ n: -0.25 });
    for (const bad of ['', ' 1', '1 ', '+1', '01', '.5', '1.', '0x10', '1e999', 'Infinity', 'NaN', 'abc', '1,2']) {
      const err = await failure([`n=${bad}`]);
      expect(err).toBeInstanceOf(FlowError);
      expect((err as FlowError).stepId).toBe('input');
    }
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
    const err = await failure([], defaultsFlow(), 'defaults');
    expect(err).toBeInstanceOf(FlowError);
    expect((err as FlowError).stepId).toBe('input');
    expect((err as FlowError).message).toContain("missing required parameter 'must'");
  });

  it('rejects a pair with no = and an empty key', async () => {
    for (const pair of ['s', '=ok']) {
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

  it('rejects unknown keys, including inherited/own prototype names', async () => {
    for (const key of ['bogus', 'constructor', 'toString', 'hasOwnProperty', '__proto__']) {
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
    const dir = await makeDir({
      'a.flow.json5': flow('reg_flow'),
      [REGISTRY_FILE]: `{ reg_flow: { state: '${state}' } }`,
    });
    const err = await runFlow({ dir, flow: 'reg_flow' }).then(() => undefined, (e: unknown) => e);
    if (state === 'active') {
      expect(err).toBeUndefined();
    } else {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain(`'${state}'`);
    }
  });

  it.each(states)('state %s with allowInactive', async (state) => {
    const dir = await makeDir({
      'a.flow.json5': flow('reg_flow'),
      [REGISTRY_FILE]: `{ reg_flow: { state: '${state}' } }`,
    });
    const written: string[] = [];
    const note = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    const res = await runFlow({ dir, flow: 'reg_flow', allowInactive: true }).then(
      () => 'ok',
      (e: unknown) => e,
    );
    if (state === 'retired') {
      expect(res).toBeInstanceOf(Error);
      expect((res as Error).message).toContain("'retired'");
    } else if (state === 'active') {
      expect(res).toBe('ok');
    } else {
      expect(res).toBe('ok');
      const noteText = written.join('');
      expect(noteText).toContain(`'${state}'`);
      expect(noteText).toContain('allowInactive');
      note.mockRestore();
    }
  });

  it('runs any valid read-only flow with no registry', async () => {
    const dir = await makeDir({ 'a.flow.json5': flow('free_flow') });
    expect(await runFlow({ dir, flow: 'free_flow' })).toEqual({ text: 'ran free_flow' });
  });

  it('uses own-property registry lookups: an inherited name does not count', async () => {
    // 'constructor' is a valid snake_case flow name; without an entry it must
    // look unlisted even though Object.prototype has that property.
    const dir = await makeDir({
      'a.flow.json5': flow('constructor'),
      [REGISTRY_FILE]: `{}`,
    });
    const err = await runFlow({ dir, flow: 'constructor' }).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/not listed/);
  });

  it('checkRegistryCoverage is own-property directed for inherited names', async () => {
    // No entry at all: 'constructor' must be reported as unlisted.
    expect(() => checkRegistryCoverage({}, ['constructor'])).toThrow(/not listed/);
    // A real own entry is accepted, and an own entry for an unloaded flow is
    // still refused.
    const own = { constructor: { state: 'active' as const } };
    expect(() => checkRegistryCoverage(own, ['constructor'])).not.toThrow();
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
describe('runFlow directory validation', () => {
  it('refuses a selected flow when an invalid sibling flow is present', async () => {
    const dir = await makeDir({
      'a.flow.json5': flow('good'),
      'b.flow.json5': `{ name: 'broken', steps: [] }`,
    });
    await expect(runFlow({ dir, flow: 'good' })).rejects.toThrow(/broken|invalid/);
  });

  it('refuses a selected flow when a sibling calls an unknown server', async () => {
    const dir = await makeDir({
      'a.flow.json5': flow('good'),
      'b.flow.json5': JSON.stringify({
        name: 'orphan',
        description: 'WHEN TO USE: sibling.',
        input: {},
        steps: [{ id: 'c', kind: 'mcp_call', server: 'ghost', tool: 't' }],
        output: '{{steps.c}}',
      }),
    });
    await expect(runFlow({ dir, flow: 'good' })).rejects.toThrow(/unknown MCP server 'ghost'/);
  });

  it('refuses a selected flow when servers.json5 is invalid', async () => {
    const dir = await makeDir({
      'a.flow.json5': flow('good'),
      'servers.json5': `{ bad: { command: 42 } }`,
    });
    await expect(runFlow({ dir, flow: 'good' })).rejects.toThrow(/servers\.json5: invalid/);
  });

  it('refuses a selected flow when an absence declaration is invalid', async () => {
    const dir = await makeDir({
      'a.flow.json5': flow('good'),
      'b.flow.json5': JSON.stringify({
        name: 'bad_absent',
        description: 'WHEN TO USE: sibling.',
        input: {},
        steps: [{ id: 'p', kind: 'http_request', method: 'POST', url: 'http://x.test/w', absent: [404] }],
        output: '{{steps.w}}',
      }),
      'c.flow.json5': flow('good2'),
    });
    // The POST step is also write-capable; the absence check runs first.
    await expect(runFlow({ dir, flow: 'good' })).rejects.toThrow(/absent.*only for reads/);
  });

  it('refuses a selected flow when registry coverage is incomplete', async () => {
    const dir = await makeDir({
      'a.flow.json5': flow('good'),
      'b.flow.json5': flow('unlisted'),
      [REGISTRY_FILE]: `{ good: { state: 'active' } }`,
    });
    await expect(runFlow({ dir, flow: 'good' })).rejects.toThrow(/not listed/);
  });

  it('refuses a selected flow when registry.json5 is a directory (read error)', async () => {
    const dir = await makeDir({ 'a.flow.json5': flow('good') });
    await mkdir(join(dir, REGISTRY_FILE));
    const err = await runFlow({ dir, flow: 'good' }).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as NodeJS.ErrnoException).code).toBe('EISDIR');
  });
});

// ---------------------------------------------------------------------------
// Write refusal, including maps and both branch arms
// ---------------------------------------------------------------------------
describe('runFlow write refusal', () => {
  const writeFlows: Record<string, string> = {
    direct_post: JSON.stringify({
      name: 'direct_post',
      description: 'WHEN TO USE: write.',
      input: {},
      steps: [
        { id: 'read', kind: 'template', template: 'read first' },
        { id: 'w', kind: 'http_request', method: 'POST', url: 'http://x.test/w' },
      ],
      output: '{{steps.read}}',
    }),
    map_post: JSON.stringify({
      name: 'map_post',
      description: 'WHEN TO USE: write.',
      input: {},
      steps: [
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
    branch_then: JSON.stringify({
      name: 'branch_then',
      description: 'WHEN TO USE: write.',
      input: {},
      steps: [
        {
          id: 'br',
          kind: 'branch',
          if: 'true',
          then: [{ id: 'w', kind: 'http_request', method: 'POST', url: 'http://x.test/w' }],
          else: [{ id: 'r', kind: 'template', template: 'read' }],
        },
      ],
      output: '{{steps.br.taken}}',
    }),
    branch_else: JSON.stringify({
      name: 'branch_else',
      description: 'WHEN TO USE: write.',
      input: {},
      steps: [
        {
          id: 'br',
          kind: 'branch',
          if: 'false',
          then: [{ id: 'r', kind: 'template', template: 'read' }],
          else: [{ id: 'w', kind: 'http_request', method: 'POST', url: 'http://x.test/w' }],
        },
      ],
      output: '{{steps.br.taken}}',
    }),
    map_allowlisted: JSON.stringify({
      name: 'map_allowlisted',
      description: 'WHEN TO USE: write.',
      input: {},
      steps: [
        { id: 'read', kind: 'template', template: 'read first' },
        {
          id: 'm',
          kind: 'map',
          over: 'steps.read',
          as: 'n',
          step: { kind: 'mcp_call', server: 'm', tool: 'write_it' },
        },
      ],
      output: '{{steps.m}}',
    }),
    branch_allowlisted: JSON.stringify({
      name: 'branch_allowlisted',
      description: 'WHEN TO USE: write.',
      input: {},
      steps: [
        { id: 'read', kind: 'template', template: 'read first' },
        {
          id: 'br',
          kind: 'branch',
          if: 'false',
          then: [{ id: 'r', kind: 'template', template: 'read' }],
          else: [{ id: 'w', kind: 'mcp_call', server: 'm', tool: 'write_it' }],
        },
      ],
      output: '{{steps.read}}',
    }),
  };

  const serversWithAllow = `{ m: { command: 'node', allow: ['write_it'] } }`;

  for (const [name, text] of Object.entries(writeFlows)) {
    it(`refuses ${name} before any step`, async () => {
      fetchMock.mockResolvedValue(new Response('ok'));
      const dir = await makeDir({
        'a.flow.json5': text,
      });
      if (name.endsWith('allowlisted')) {
        await writeFile(join(dir, 'servers.json5'), serversWithAllow);
      }
      await expect(runFlow({ dir, flow: name })).rejects.toThrow(/write-capable.*flowmcp serve/);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mocks.factory).not.toHaveBeenCalled();
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
  // A mocked downstream that lists a read-annotated tool, an unannotated tool,
  // and records every call it receives. It never spawns anything. Each
  // instance carries its own call/close log; connect() counts as "opened".
  interface MockClient {
    calls: string[];
    opened: () => number;
    closed: () => number;
    listTools: ReturnType<typeof vi.fn>;
    callTool: ReturnType<typeof vi.fn>;
  }

  function mockClient(): MockClient {
    const state = { calls: [] as string[], opened: 0, closed: 0 };
    return {
      calls: state.calls,
      opened: () => state.opened,
      closed: () => state.closed,
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
    expect(client.closed()).toBeGreaterThan(0);
  });

  it('calls a read-annotated tool through the pool and closes it', async () => {
    const client = mockClient();
    mocks.factory.mockReturnValueOnce(client);
    const dir = await makeDir({
      'a.flow.json5': mcpFlow('echo'),
      'servers.json5': `{ m: { command: 'node' } }`,
    });
    expect(await runFlow({ dir, flow: 'mcp_flow' })).toEqual({ text: 'echoed' });
    expect(client.calls).toEqual(['echo']);
    expect(client.closed()).toBeGreaterThan(0);
  });

  it('passes baseDir = dir to the pool (relative paths anchor to the flows dir)', async () => {
    const client = mockClient();
    mocks.factory.mockReturnValueOnce(client);
    const dir = await makeDir({
      'a.flow.json5': mcpFlow('echo'),
      'servers.json5': `{ m: { command: 'node', args: ['relative/server.ts'] } }`,
    });
    const written: string[] = [];
    const note = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    await runFlow({ dir, flow: 'mcp_flow' });
    const target = mocks.factory.mock.calls[0]![1] as { cwd?: string };
    expect(target.cwd).toBe(dir);
    // The pool warns about the missing relative path against that baseDir.
    expect(written.join('')).toContain(`relative to ${dir}`);
    note.mockRestore();
  });

  it('awaits closeAll on success, failure and an unexpected pending result', async () => {
    // Success
    {
      const client = mockClient();
      mocks.factory.mockReturnValueOnce(client);
      const dir = await makeDir({
        'a.flow.json5': mcpFlow('echo'),
        'servers.json5': `{ m: { command: 'node' } }`,
      });
      await runFlow({ dir, flow: 'mcp_flow' });
      expect(client.closed()).toBeGreaterThan(0);
    }
    // Failure: the mock rejects the call, and close still runs
    {
      const client = mockClient();
      client.callTool.mockImplementation(async () => {
        throw new Error('downstream exploded');
      });
      mocks.factory.mockReturnValueOnce(client);
      const dir = await makeDir({
        'a.flow.json5': mcpFlow('echo'),
        'servers.json5': `{ m: { command: 'node' } }`,
      });
      await expect(runFlow({ dir, flow: 'mcp_flow' })).rejects.toThrow(/downstream exploded/);
      expect(client.closed()).toBeGreaterThan(0);
    }
    // Unexpected pending: a simulated gate pauses executeFlow, and the pool
    // created by runFlow is still closed in finally.
    {
      const client = mockClient();
      mocks.factory.mockReturnValueOnce(client);
      const dir = await makeDir({
        'a.flow.json5': mcpFlow('echo'),
        'servers.json5': `{ m: { command: 'node' } }`,
      });
      __simulateWriteGate('mcp_flow', ['out']);
      try {
        await expect(runFlow({ dir, flow: 'mcp_flow' })).rejects.toThrow(/paused unexpectedly/);
        // The gate paused after the call, but the client the pool opened
        // lazily must still be closed by closeAll.
        expect(client.calls).toEqual(['echo']);
        expect(client.closed()).toBeGreaterThan(0);
      } finally {
        __clearWriteGate('mcp_flow');
      }
    }
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

  it('does not read an inherited value for a declared parameter', async () => {
    const f = flowWithInput({
      a: { type: 'string', description: 'a' },
      constructor: { type: 'string', description: 'c' },
    });
    // An own 'constructor' key (from JSON.parse) is accepted; the declared
    // 'a' must not pick a value off the prototype chain.
    const args = JSON.parse('{"constructor": "ok"}') as Record<string, unknown>;
    const run = await executeFlow(f, args);
    expect(run.status).toBe('complete');
    expect((run as { text: string }).text).toBe('');
  });

  it('lets an own supplied value win over a default and applies a default otherwise', async () => {
    const f = flowWithInput({
      a: { type: 'string', description: 'a', default: 'dflt' },
    });
    expect(await executeFlow(f, {})).toMatchObject({ status: 'complete', text: 'dflt' });
    expect(await executeFlow(f, { a: 'own' })).toMatchObject({ status: 'complete', text: 'own' });
  });
});

