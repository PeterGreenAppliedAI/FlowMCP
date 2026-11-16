import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { projectRoot } from './helpers.js';

// ---------------------------------------------------------------------------
// The REAL CLI, spawned as a child with stdin closed: dispatch, runCli, the
// protected runner and the output contract are exercised together. Network is
// local only: one fixture HTTP server on 127.0.0.1 serves downstream reads and
// records POSTs so a write refusal can be proven not to have written.
// ---------------------------------------------------------------------------
let server: Server;
let baseUrl = '';
let postHits = 0;
// Absolute path to tsx's loader, so a spawned MCP child (whose cwd is the
// flows dir, not the repo) can still resolve it without a network install.
const tsxLoader = join(dirname(createRequire(import.meta.url).resolve('tsx')), 'loader.mjs');
// Node's --import expects a module specifier or URL; on Windows an absolute
// path with backslashes is not a valid specifier, so hand it a file URL.
const tsxLoaderUrl = pathToFileURL(tsxLoader).href;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'POST') {
      postHits++;
      res.end('posted');
      return;
    }
    if (url.pathname === '/ok') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ value: url.searchParams.get('q') ?? 'none' }));
      return;
    }
    res.statusCode = 500;
    res.end('boom');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function makeDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'flowmcp-cli-run-'));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return dir;
}

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

// Spawn the real CLI with stdin closed (child.stdin is ended immediately) so a
// command that waits on stdin would hang, not pass.
function runCli(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', tsxLoaderUrl, join(projectRoot, 'src/cli.ts'), ...args], {
      cwd: opts.cwd ?? projectRoot,
      env: { ...process.env, ...opts.env },
    });
    child.stdin.end();
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

// A read-only flow that fetches the local server and renders its value.
function readFlow(name: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name,
    description: `WHEN TO USE: local read flow '${name}'.`,
    input: { q: { type: 'string', description: 'query', required: false, default: 'dflt' } },
    env: ['FIXTURE_BASE'],
    steps: [{ id: 'r', kind: 'http_request', url: '{{env.FIXTURE_BASE}}/ok?q={{input.q}}' }],
    output: 'value={{steps.r.value}}',
    ...extra,
  });
}

// A step failure after a successful-looking start.
const failingFlow = (name: string): string =>
  JSON.stringify({
    name,
    description: `WHEN TO USE: failing flow '${name}'.`,
    input: {},
    env: ['FIXTURE_BASE'],
    steps: [{ id: 'boom', kind: 'http_request', url: '{{env.FIXTURE_BASE}}/fail' }],
    output: '{{steps.boom}}',
  });

const writeFlow = (name: string): string =>
  JSON.stringify({
    name,
    description: `WHEN TO USE: write flow '${name}'.`,
    input: {},
    env: ['FIXTURE_BASE'],
    steps: [{ id: 'w', kind: 'http_request', method: 'POST', url: '{{env.FIXTURE_BASE}}/write' }],
    output: '{{steps.w}}',
  });

describe('flowmcp CLI', () => {
  it('help lists every subcommand and exits 0', async () => {
    const res = await runCli(['help']);
    expect(res.code).toBe(0);
    for (const cmd of ['serve', 'run', 'validate', 'status', 'explain', 'author', 'compile', 'detect']) {
      expect(res.stdout).toContain(`flowmcp ${cmd}`);
    }
  });

  it('--version prints the package.json version and exits 0', async () => {
    const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as { version: string };
    const res = await runCli(['--version']);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe(`${pkg.version}\n`);
    expect(res.stderr).toBe('');
  });

  it('validate subcommand checks a flows directory and exits 0', async () => {
    const res = await runCli(['validate', '--flows', join(projectRoot, 'flows')]);
    expect(res.code).toBe(0);
    expect(res.stderr).toContain('flows valid');
  });

  it('legacy flag style still works: no subcommand + --validate', async () => {
    const res = await runCli(['--flows', join(projectRoot, 'flows'), '--validate']);
    expect(res.code).toBe(0);
    expect(res.stderr).toContain('flows valid');
  });

  it('unknown subcommand fails loudly with usage', async () => {
    const res = await runCli(['bogus']);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain(`unknown command 'bogus'`);
    expect(res.stderr).toContain('flowmcp serve');
  });

  it('author without required flags prints usage and exits 1', async () => {
    const res = await runCli(['author']);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('--gateway');
  });
});

// ---------------------------------------------------------------------------
// flowmcp run — text and JSON success/failure through the real CLI
// ---------------------------------------------------------------------------
describe('flowmcp run end to end', () => {
  it('text success writes the rendered text plus newline, exit 0', async () => {
    const dir = await makeDir({ 'a.flow.json5': readFlow('greet') });
    const res = await runCli(['run', 'greet', '--flows', dir, '--input', 'q=hi'], {
      env: { FIXTURE_BASE: baseUrl },
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('value=hi\n');
  });

  it('--json success writes exactly one compact envelope plus newline', async () => {
    const dir = await makeDir({ 'a.flow.json5': readFlow('greet') });
    const res = await runCli(['run', 'greet', '--flows', dir, '--input', 'q=hi', '--json'], {
      env: { FIXTURE_BASE: baseUrl },
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('{"flow":"greet","ok":true,"output":"value=hi"}\n');
    expect(res.stdout.trim().split('\n')).toHaveLength(1);
  });

  it('a step failure leaves stdout empty in text mode and diagnoses stderr, exit 1', async () => {
    const dir = await makeDir({ 'a.flow.json5': failingFlow('flaky') });
    const res = await runCli(['run', 'flaky', '--flows', dir], { env: { FIXTURE_BASE: baseUrl } });
    expect(res.code).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain("flow 'flaky'");
    expect(res.stderr).toContain("(step 'boom')");
  });

  it('a step failure in --json names the step and cause, exit 1', async () => {
    const dir = await makeDir({ 'a.flow.json5': failingFlow('flaky') });
    const res = await runCli(['run', 'flaky', '--flows', dir, '--json'], { env: { FIXTURE_BASE: baseUrl } });
    expect(res.code).toBe(1);
    const parsed = JSON.parse(res.stdout) as {
      flow: string;
      ok: boolean;
      error: { step: string | null; message: string };
    };
    expect(parsed.flow).toBe('flaky');
    expect(parsed.ok).toBe(false);
    expect(parsed.error.step).toBe('boom');
    expect(parsed.error.message).toContain("flow 'flaky'");
    expect(parsed.error.message).toContain("(step 'boom')");
    expect(parsed.error.message).toContain('HTTP 500');
    // Diagnostics also on stderr.
    expect(res.stderr).toContain("flow 'flaky'");
  });

  it('an unknown flow is diagnosed with the requested name and available dir, exit 1', async () => {
    const dir = await makeDir({ 'a.flow.json5': readFlow('greet') });
    const res = await runCli(['run', 'ghost', '--flows', dir, '--json']);
    expect(res.code).toBe(1);
    const parsed = JSON.parse(res.stdout) as { flow: string; error: { step: unknown; message: string } };
    expect(parsed.flow).toBe('ghost');
    expect(parsed.error.step).toBeNull();
    expect(parsed.error.message).toContain("no flow named 'ghost'");
    expect(res.stderr).toContain("flow 'ghost'");
  });

  it('input errors report step "input" and exit 1', async () => {
    const dir = await makeDir({ 'a.flow.json5': readFlow('greet') });
    const res = await runCli(['run', 'greet', '--flows', dir, '--input', 'bogus=1', '--json']);
    expect(res.code).toBe(1);
    const parsed = JSON.parse(res.stdout) as { error: { step: string; message: string } };
    expect(parsed.error.step).toBe('input');
    expect(parsed.error.message).toContain("unknown parameter 'bogus'");
  });

  it('a write-capable flow is refused and nothing is written, exit 1', async () => {
    postHits = 0;
    const dir = await makeDir({ 'a.flow.json5': writeFlow('writer') });
    const res = await runCli(['run', 'writer', '--flows', dir, '--json'], { env: { FIXTURE_BASE: baseUrl } });
    expect(res.code).toBe(1);
    const parsed = JSON.parse(res.stdout) as { flow: string; ok: boolean; error: { step: unknown; message: string } };
    expect(parsed.flow).toBe('writer');
    expect(parsed.ok).toBe(false);
    expect(parsed.error.step).toBeNull();
    expect(parsed.error.message).toContain('flowmcp serve');
    expect(res.stderr).toContain('flowmcp serve');
    // The write was refused before any step: the server saw no POST.
    expect(postHits).toBe(0);
  });

  it('a write-capable flow refusal in text mode leaves stdout empty', async () => {
    postHits = 0;
    const dir = await makeDir({ 'a.flow.json5': writeFlow('writer') });
    const res = await runCli(['run', 'writer', '--flows', dir], { env: { FIXTURE_BASE: baseUrl } });
    expect(res.code).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('flowmcp serve');
    expect(postHits).toBe(0);
  });

  it('--allow-inactive runs a reviewed flow with a state note on stderr', async () => {
    const dir = await makeDir({
      'a.flow.json5': readFlow('reviewed_flow'),
      'registry.json5': "{ reviewed_flow: { state: 'reviewed' } }",
    });
    const res = await runCli(['run', 'reviewed_flow', '--flows', dir, '--allow-inactive', '--json'], {
      env: { FIXTURE_BASE: baseUrl },
    });
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({
      flow: 'reviewed_flow',
      ok: true,
      output: 'value=dflt',
    });
    expect(res.stderr).toContain("'reviewed'");
    expect(res.stderr).toContain('allowInactive');
  });

  it('without --allow-inactive a reviewed flow is refused, exit 1', async () => {
    const dir = await makeDir({
      'a.flow.json5': readFlow('reviewed_flow'),
      'registry.json5': "{ reviewed_flow: { state: 'reviewed' } }",
    });
    const res = await runCli(['run', 'reviewed_flow', '--flows', dir], { env: { FIXTURE_BASE: baseUrl } });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("'reviewed'");
  });

  it('a governed run appends exactly one run record with the rendered output not logged', async () => {
    const dir = await makeDir({
      'a.flow.json5': readFlow('logged_flow'),
      'registry.json5': "{ logged_flow: { state: 'active' } }",
    });
    const res = await runCli(['run', 'logged_flow', '--flows', dir, '--input', 'q=secret-value'], {
      env: { FIXTURE_BASE: baseUrl },
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('value=secret-value\n');
    // The runner's logging is awaited before exit: the record exists now.
    const log = await readFile(join(dir, 'registry-log.jsonl'), 'utf8');
    const lines = log.split('\n').filter((l) => l.trim());
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(record.flow).toBe('logged_flow');
    expect(record.kind).toBe('run');
    expect(record.ok).toBe(true);
    // Execution text/input is not in the record.
    expect(log).not.toContain('secret-value');
  });

  it('a failed governed run logs one failure record naming step and cause', async () => {
    const dir = await makeDir({
      'a.flow.json5': failingFlow('logged_fail'),
      'registry.json5': "{ logged_fail: { state: 'active' } }",
    });
    const res = await runCli(['run', 'logged_fail', '--flows', dir, '--json'], { env: { FIXTURE_BASE: baseUrl } });
    expect(res.code).toBe(1);
    const log = await readFile(join(dir, 'registry-log.jsonl'), 'utf8');
    const records = log.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(records).toHaveLength(1);
    expect(records[0]!.ok).toBe(false);
    expect(String(records[0]!.error)).toContain("step 'boom'");
  });

  it('runs a config-relative downstream MCP path from another cwd', async () => {
    // servers.json5 names the downstream script by a path RELATIVE to the
    // flows dir; the flow calls it. Run from an unrelated cwd: success proves
    // the child was spawned with the flows dir as its cwd and resolved the
    // script against it, not against the process cwd (where it does not exist).
    const dir = await makeDir({});
    await mkdir(join(dir, 'bin'), { recursive: true });
    await writeFile(join(dir, 'bin', 'mock-mcp.ts'), await readFile(join(projectRoot, 'test/fixtures/mock-mcp.ts')));
    await writeFile(
      join(dir, 'servers.json5'),
      `{ mock: { command: 'node', args: ['--import', '${tsxLoaderUrl}', './bin/mock-mcp.ts'] } }`,
    );
    await writeFile(
      join(dir, 'a.flow.json5'),
      JSON.stringify({
        name: 'echoer',
        description: 'WHEN TO USE: echo through a downstream server.',
        input: { msg: { type: 'string', description: 'msg', required: true } },
        steps: [{ id: 'c', kind: 'mcp_call', server: 'mock', tool: 'echo', args: { msg: '{{input.msg}}' } }],
        output: 'echo={{steps.c.echoed.msg}}',
      }),
    );
    const otherCwd = await makeDir({});
    const res = await runCli(['run', 'echoer', '--flows', dir, '--input', 'msg=hello', '--json'], {
      cwd: otherCwd,
    });
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({ flow: 'echoer', ok: true, output: 'echo=hello' });
    // The pool found the config-relative path (no stale-path warning).
    expect(res.stderr).not.toContain('does not exist relative to');
  });
});

// ---------------------------------------------------------------------------
// flowmcp run — help and invalid directories must not load or execute
// ---------------------------------------------------------------------------
describe('flowmcp run help and invalid dirs', () => {
  it('--help with --json prints text usage and exits 0 without loading anything', async () => {
    // An invalid --flows directory would fail the run; help must not touch it.
    const res = await runCli(['run', 'greet', '--flows', '/definitely/not/a/dir', '--json', '--help']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('flowmcp run — run one read-only flow locally');
    expect(res.stdout.trim().startsWith('{')).toBe(false);
    expect(res.stderr).toBe('');
  });

  it('an invalid flows directory fails with exit 1 and empty text stdout', async () => {
    const res = await runCli(['run', 'greet', '--flows', '/definitely/not/a/dir']);
    expect(res.code).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('flows directory not found');
  });

  it('an invalid flows directory under --json yields a failure envelope', async () => {
    const res = await runCli(['run', 'greet', '--flows', '/definitely/not/a/dir', '--json']);
    expect(res.code).toBe(1);
    const parsed = JSON.parse(res.stdout) as { flow: string; error: { step: unknown; message: string } };
    expect(parsed.flow).toBe('greet');
    expect(parsed.error.step).toBeNull();
    expect(parsed.error.message).toContain('flows directory not found');
  });
});

// ---------------------------------------------------------------------------
// flowmcp run — directory precedence through the CLI
// ---------------------------------------------------------------------------
describe('flowmcp run directory precedence', () => {
  it('--flows wins over FLOWMCP_FLOWS_DIR', async () => {
    const dir = await makeDir({ 'a.flow.json5': readFlow('greet') });
    const envDir = await makeDir({ 'a.flow.json5': readFlow('greet', { steps: [{ id: 'r', kind: 'template', template: 'from-env' }], output: '{{steps.r}}' }) });
    const res = await runCli(['run', 'greet', '--flows', dir, '--json'], {
      env: { FLOWMCP_FLOWS_DIR: envDir, FIXTURE_BASE: baseUrl },
    });
    expect(JSON.parse(res.stdout)).toEqual({ flow: 'greet', ok: true, output: 'value=dflt' });
  });

  it('nonempty FLOWMCP_FLOWS_DIR is used when --flows is absent', async () => {
    const envDir = await makeDir({ 'a.flow.json5': JSON.stringify({ name: 'envflow', description: 'WHEN TO USE: env.', input: {}, steps: [{ id: 'o', kind: 'template', template: 'from-env' }], output: '{{steps.o}}' }) });
    const res = await runCli(['run', 'envflow', '--json'], { env: { FLOWMCP_FLOWS_DIR: envDir } });
    expect(JSON.parse(res.stdout)).toEqual({ flow: 'envflow', ok: true, output: 'from-env' });
  });

  it('empty FLOWMCP_FLOWS_DIR falls back to the package-relative ../flows', async () => {
    // The repo's own flows/ dir holds hn_top and morning_brief; running one
    // proves the fallback resolves relative to the CLI module, not cwd.
    const otherCwd = await makeDir({});
    const res = await runCli(['run', 'definitely_not_a_flow', '--json'], {
      cwd: otherCwd,
      env: { FLOWMCP_FLOWS_DIR: '' },
    });
    expect(res.code).toBe(1);
    const parsed = JSON.parse(res.stdout) as { error: { message: string } };
    // The diagnostic names the package's flows dir, not the temp cwd.
    expect(parsed.error.message).toContain(`${projectRoot.replace(/[/\\]$/, '')}${sep}flows`);
    expect(parsed.error.message).not.toContain(otherCwd);
  });
});

// ---------------------------------------------------------------------------
// flowmcp run — usage failures through the real CLI
// ---------------------------------------------------------------------------
describe('flowmcp run usage failures', () => {
  it('missing option values, unknown options and extra positionals exit 1 with --json honored', async () => {
    const cases: Array<{ argv: string[]; flow: string | null; message: string }> = [
      { argv: ['run', 'greet', '--flows', '--json'], flow: 'greet', message: "flow 'greet': option '--flows' requires a value" },
      { argv: ['run', 'greet', '--nope', '--json'], flow: 'greet', message: "flow 'greet': unknown option '--nope'" },
      { argv: ['run', 'a', 'b', '--json'], flow: 'a', message: "flow 'a': unexpected extra argument 'b'" },
      { argv: ['run', '--json'], flow: null, message: 'missing flow name' },
    ];
    for (const { argv, flow, message } of cases) {
      const res = await runCli(argv);
      expect(res.code).toBe(1);
      expect(JSON.parse(res.stdout)).toEqual({ flow, ok: false, error: { step: null, message } });
    }
  });

  it('text usage failure leaves stdout empty, exit 1', async () => {
    const res = await runCli(['run', 'greet', '--nope']);
    expect(res.code).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain("unknown option '--nope'");
  });
});

// ---------------------------------------------------------------------------
// Input-token preservation through the real CLI (splitting stays in the core)
// ---------------------------------------------------------------------------
describe('flowmcp run input tokens', () => {
  it('passes a value containing = and commas through to the engine intact', async () => {
    const dir = await makeDir({ 'a.flow.json5': readFlow('greet') });
    const res = await runCli(['run', 'greet', '--flows', dir, '--json', '--input', 'q=a=b,c'], {
      env: { FIXTURE_BASE: baseUrl },
    });
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({ flow: 'greet', ok: true, output: 'value=a=b,c' });
  });
});
