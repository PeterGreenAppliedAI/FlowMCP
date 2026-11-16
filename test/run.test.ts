import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// runCli is exercised with the runner boundary mocked: src/run-core.js's
// runFlow is the single call runCli makes, so every test here sees exactly one
// invocation and controls its settlement. stdout/stderr writes are captured
// per test; process.exitCode is reset around each test so tests never leak a
// failure code into the vitest process.
// ---------------------------------------------------------------------------
const runner = vi.hoisted(() => ({ runFlow: vi.fn() }));

vi.mock('../src/run-core.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/run-core.js')>();
  return { ...actual, runFlow: runner.runFlow };
});

import { runCli, RUN_USAGE } from '../src/run.js';
import { FlowError } from '../src/engine.js';

const spies: Array<{ mockRestore: () => void }> = [];

interface Captured {
  stdout: string;
  stderr: string;
}

// Replace stdout/stderr writes for one test; returns live getters.
function capture(): Captured {
  const out: Captured = { stdout: '', stderr: '' };
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out.stdout += String(chunk);
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    out.stderr += String(chunk);
    return true;
  });
  spies.push(stdoutSpy, stderrSpy);
  return out;
}

let savedExitCode: number | string | undefined;
let savedEnv: string | undefined;

beforeEach(() => {
  runner.runFlow.mockReset();
  savedExitCode = process.exitCode;
  savedEnv = process.env.FLOWMCP_FLOWS_DIR;
  delete process.env.FLOWMCP_FLOWS_DIR;
  process.exitCode = undefined;
});

afterEach(() => {
  while (spies.length) spies.pop()!.mockRestore();
  process.exitCode = savedExitCode;
  if (savedEnv === undefined) delete process.env.FLOWMCP_FLOWS_DIR;
  else process.env.FLOWMCP_FLOWS_DIR = savedEnv;
});

// ---------------------------------------------------------------------------
// Text success and failure
// ---------------------------------------------------------------------------
describe('runCli text mode', () => {
  it('writes the flow text plus one newline on success and exits 0', async () => {
    runner.runFlow.mockResolvedValue({ text: 'hello world' });
    const got = capture();
    await runCli(['greet', '--flows', '/fixtures']);
    expect(got.stdout).toBe('hello world\n');
    expect(got.stderr).toBe('');
    expect(process.exitCode).toBe(0);
    expect(runner.runFlow).toHaveBeenCalledTimes(1);
  });

  it('leaves stdout empty on a step failure and diagnoses stderr, exit 1', async () => {
    runner.runFlow.mockRejectedValue(new FlowError('fetch', 'HTTP 500 boom'));
    const got = capture();
    await runCli(['greet']);
    expect(got.stdout).toBe('');
    expect(got.stderr).toContain("flow 'greet'");
    expect(got.stderr).toContain('HTTP 500 boom');
    expect(process.exitCode).toBe(1);
    expect(runner.runFlow).toHaveBeenCalledTimes(1);
  });

  it('keeps the text untouched even when it contains JSON', async () => {
    const text = '{"a":1,"b":[2,3]}\ntrailing';
    runner.runFlow.mockResolvedValue({ text });
    const got = capture();
    await runCli(['j']);
    expect(got.stdout).toBe(text + '\n');
  });
});

// ---------------------------------------------------------------------------
// JSON success and failure (exact envelopes)
// ---------------------------------------------------------------------------
describe('runCli --json mode', () => {
  it('writes exactly one compact success envelope plus newline', async () => {
    runner.runFlow.mockResolvedValue({ text: 'the output' });
    const got = capture();
    await runCli(['greet', '--json']);
    expect(got.stdout).toBe('{"flow":"greet","ok":true,"output":"the output"}\n');
    expect(got.stderr).toBe('');
    expect(process.exitCode).toBe(0);
  });

  it('preserves a JSON-looking output string inside the success envelope', async () => {
    const text = '{"nested":true}';
    runner.runFlow.mockResolvedValue({ text });
    const got = capture();
    await runCli(['j', '--json']);
    expect(got.stdout).toBe(`${JSON.stringify({ flow: 'j', ok: true, output: text })}\n`);
    expect(JSON.parse(got.stdout)).toEqual({ flow: 'j', ok: true, output: text });
  });

  it('writes a FlowError failure envelope naming the step and the cause, exit 1', async () => {
    runner.runFlow.mockRejectedValue(new FlowError('input', 'missing required parameter \'x\''));
    const got = capture();
    await runCli(['typed', '--json']);
    expect(got.stdout).toBe(
      `${JSON.stringify({ flow: 'typed', ok: false, error: { step: 'input', message: "flow 'typed' (step 'input'): missing required parameter 'x'" } })}\n`,
    );
    expect(got.stderr).toContain("flow 'typed'");
    expect(process.exitCode).toBe(1);
  });

  it('writes a failure envelope with a null step for a generic error', async () => {
    runner.runFlow.mockRejectedValue(new Error('no flow named \'ghost\' in /fixtures'));
    const got = capture();
    await runCli(['ghost', '--json']);
    const parsed = JSON.parse(got.stdout) as Record<string, unknown>;
    expect(parsed.flow).toBe('ghost');
    expect(parsed.ok).toBe(false);
    expect((parsed.error as { step: unknown }).step).toBeNull();
    expect((parsed.error as { message: string }).message).toContain('no flow named');
    expect(got.stdout.endsWith('\n')).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it('uses a null flow for missing flow name', async () => {
    const got = capture();
    await runCli(['--json']);
    expect(got.stdout).toBe(
      '{"flow":null,"ok":false,"error":{"step":null,"message":"missing flow name"}}\n',
    );
    expect(runner.runFlow).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('honors --json for an unknown option, wherever it sits', async () => {
    for (const argv of [['--bogus', '--json'], ['--json', '--bogus'], ['greet', '--bogus', '--json']]) {
      const got = capture();
      await runCli(argv);
      const parsed = JSON.parse(got.stdout) as Record<string, unknown>;
      // A supplied flow is preserved in the envelope; only a missing flow is null.
      expect(parsed.flow).toBe(argv[0] === 'greet' ? 'greet' : null);
      expect((parsed.error as { message: string }).message).toContain("unknown option '--bogus'");
      expect(process.exitCode).toBe(1);
      spyRestore();
    }
  });
});

// Restore the spies made inside a loop so the next iteration captures afresh.
function spyRestore(): void {
  while (spies.length) spies.pop()!.mockRestore();
}

// ---------------------------------------------------------------------------
// Usage errors
// ---------------------------------------------------------------------------
describe('runCli usage errors', () => {
  it('rejects an option with a missing value', async () => {
    for (const argv of [['greet', '--flows'], ['greet', '--flows', '--json'], ['greet', '--input'], ['--input', '--json']]) {
      const got = capture();
      await runCli(argv);
      expect(got.stderr).toContain('requires a value');
      // Text usage failures leave stdout empty; with --json the envelope is
      // the one permitted stdout write.
      if (argv.includes('--json')) {
        const option = argv.includes('--flows') ? '--flows' : '--input';
        const message = `option '${option}' requires a value`;
        expect(got.stdout).toBe(
          `${JSON.stringify({ flow: argv[0] === 'greet' ? 'greet' : null, ok: false, error: { step: null, message: argv[0] === 'greet' ? `flow 'greet': ${message}` : message } })}\n`,
        );
        // The stderr diagnosis names the requested flow too.
        if (argv[0] === 'greet') expect(got.stderr).toContain("flow 'greet'");
      } else {
        expect(got.stdout).toBe('');
      }
      expect(process.exitCode).toBe(1);
      spyRestore();
    }
    expect(runner.runFlow).not.toHaveBeenCalled();
  });

  it('rejects an empty --flows directory and a repeated --flows', async () => {
    const got = capture();
    await runCli(['greet', '--flows', '', '--json']);
    expect(JSON.parse(got.stdout)).toEqual({ flow: 'greet', ok: false, error: { step: null, message: "flow 'greet': option '--flows' requires a nonempty directory" } });
    expect(got.stderr).toContain("flow 'greet'");
    spyRestore();
    const got2 = capture();
    await runCli(['greet', '--flows', 'a', '--flows', 'b', '--json']);
    expect((JSON.parse(got2.stdout) as { flow: unknown; error: { message: string } }).flow).toBe('greet');
    expect((JSON.parse(got2.stdout) as { error: { message: string } }).error.message).toContain('more than once');
    expect(runner.runFlow).not.toHaveBeenCalled();
  });

  it('rejects unsupported options', async () => {
    const got = capture();
    await runCli(['greet', '--write', '--json']);
    expect(JSON.parse(got.stdout)).toEqual({ flow: 'greet', ok: false, error: { step: null, message: "flow 'greet': unknown option '--write'" } });
    expect(got.stderr).toContain("flow 'greet'");
    expect(runner.runFlow).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('rejects extra positionals', async () => {
    const got = capture();
    await runCli(['one', 'two', '--json']);
    expect(JSON.parse(got.stdout)).toEqual({ flow: 'one', ok: false, error: { step: null, message: "flow 'one': unexpected extra argument 'two'" } });
    expect(got.stderr).toContain("flow 'one'");
    expect(runner.runFlow).not.toHaveBeenCalled();
  });

  it('treats "--" as an unsupported option rather than end-of-options', async () => {
    // Only the requested options exist: '--' is not one, and it does not make
    // later flag-looking tokens positionals.
    const got = capture();
    await runCli(['--', '--flows', '--json']);
    expect(got.stdout).toBe(
      `${JSON.stringify({ flow: null, ok: false, error: { step: null, message: "unknown option '--'" } })}\n`,
    );
    expect(runner.runFlow).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Input-token preservation and forwarding to the runner
// ---------------------------------------------------------------------------
describe('runCli input forwarding', () => {
  it('forwards input tokens unchanged, in order, with the exact option values', async () => {
    runner.runFlow.mockResolvedValue({ text: 'ok' });
    capture();
    await runCli([
      'typed',
      '--input',
      's=a=b=c,d,, e',
      '--input',
      's2=',
      '--input',
      'n=1e3',
      '--flows',
      '/some/dir',
      '--allow-inactive',
    ]);
    expect(runner.runFlow).toHaveBeenCalledTimes(1);
    expect(runner.runFlow).toHaveBeenCalledWith({
      dir: expect.any(String),
      flow: 'typed',
      inputPairs: ['s=a=b=c,d,, e', 's2=', 'n=1e3'],
      allowInactive: true,
    });
  });

  it('passes input pairs with a no-= token through, letting the runner reject pair syntax', async () => {
    // runCli does not validate pairs; runFlow does. Forward 'novalue' verbatim
    // and prove the runner receives it rather than runCli inventing an error.
    runner.runFlow.mockRejectedValue(new FlowError('input', "input 'novalue' has no '=' — expected key=value"));
    const got = capture();
    await runCli(['typed', '--input', 'novalue', '--json']);
    expect(runner.runFlow).toHaveBeenCalledWith(expect.objectContaining({ inputPairs: ['novalue'] }));
    expect((JSON.parse(got.stdout) as { error: { step: unknown } }).error.step).toBe('input');
  });

  it('does not pass allowInactive when the flag is absent', async () => {
    runner.runFlow.mockResolvedValue({ text: 'ok' });
    capture();
    await runCli(['typed']);
    expect(runner.runFlow).toHaveBeenCalledWith(
      expect.objectContaining({ allowInactive: false }),
    );
  });
});

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------
describe('runCli help', () => {
  it('prints text usage and exits 0 without invoking the runner', async () => {
    const got = capture();
    await runCli(['--help']);
    expect(got.stdout).toBe(RUN_USAGE);
    expect(runner.runFlow).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it('prints text usage (not JSON) even with --json and no flow', async () => {
    const got = capture();
    await runCli(['--json', '--help']);
    expect(got.stdout).toBe(RUN_USAGE);
    expect(got.stderr).toBe('');
    expect(runner.runFlow).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it('help wins over a flow name and over a usage error', async () => {
    for (const argv of [['greet', '--help', '--json'], ['--bogus', '--help']]) {
      const got = capture();
      await runCli(argv);
      expect(got.stdout).toBe(RUN_USAGE);
      expect(runner.runFlow).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(0);
      spyRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Directory precedence
// ---------------------------------------------------------------------------
describe('runCli directory precedence', () => {
  it('prefers --flows over FLOWMCP_FLOWS_DIR', async () => {
    runner.runFlow.mockResolvedValue({ text: 'ok' });
    capture();
    process.env.FLOWMCP_FLOWS_DIR = '/from-env';
    await runCli(['greet', '--flows', '/from-flag']);
    expect(runner.runFlow.mock.calls[0]![0].dir).toBe('/from-flag');
  });

  it('falls back to a nonempty FLOWMCP_FLOWS_DIR', async () => {
    runner.runFlow.mockResolvedValue({ text: 'ok' });
    capture();
    process.env.FLOWMCP_FLOWS_DIR = '/from-env';
    await runCli(['greet']);
    expect(runner.runFlow.mock.calls[0]![0].dir).toBe('/from-env');
  });

  it('falls back to the package ../flows dir when the env var is empty', async () => {
    runner.runFlow.mockResolvedValue({ text: 'ok' });
    capture();
    process.env.FLOWMCP_FLOWS_DIR = '';
    await runCli(['greet']);
    const dir = runner.runFlow.mock.calls[0]![0].dir as string;
    expect(dir.endsWith('/flows')).toBe(true);
    expect(dir.includes('node_modules')).toBe(false);
  });
});
