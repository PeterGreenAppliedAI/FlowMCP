// `flowmcp run <flow> …` — one read-only flow, from the terminal.
//
//   flowmcp run <flow> [--flows <dir>] [--input k=v]… [--json] [--allow-inactive]
//
// The parse is small on purpose; everything else is the protected runner:
// whole-directory validation, write refusal, registry admission, schema
// conversion, execution, run logging and pool cleanup all live in runFlow
// (run-core.ts) and are NOT repeated here. This module parses the
// invocation, resolves the flow directory, calls runFlow once, and renders
// one terminal result.
//
// Import of this module has no side effects: runCli is exported and the CLI
// invokes it. process.argv, stdin/stdout/stderr writes and process.exitCode
// are used only inside runCli.
//
// Output contract (owner decisions Q2/Q3/Q6):
//   - text success:  stdout gets the flow's text plus '\n'; exit 0.
//   - text failure:  stdout stays EMPTY. Diagnostics go to stderr only
//                    (including the core's notes and downstream diagnostics).
//   - --json success: stdout gets ONE compact object plus '\n':
//                    {"flow":"<requested>","ok":true,"output":"<text>"}
//   - --json failure: stdout gets ONE compact object plus '\n':
//                    {"flow":"<requested>"|null,"ok":false,
//                     "error":{"step":"<step id>"|null,"message":"<diagnosis>"}}
//                    The diagnosis still goes to stderr too. A usage failure
//                    before a flow is known has flow: null.
//   - --help:        text usage on stdout, exit 0, no flows loaded or run —
//                    even with --json.
//   - every unsuccessful invocation exits 1; completion/help exit 0.
//   - the runner's settlement is awaited before the exit code is set, so
//     cleanup and run logging finish, and the outer CLI never prints a second
//     copy of a failure (runCli owns its diagnostics).

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { runFlow } from './run-core.js';
import { FlowError } from './engine.js';

export const RUN_USAGE = `flowmcp run — run one read-only flow locally

  flowmcp run <flow> [--flows <dir>] [--input k=v]… [--json] [--allow-inactive]

  <flow>            the flow's declared name (required)
  --flows <dir>     flows directory; overrides FLOWMCP_FLOWS_DIR
  --input k=v       one input pair (repeatable); strings verbatim, numbers and
                    booleans converted per the flow's input schema
  --json            one compact JSON result object on stdout (text otherwise)
  --allow-inactive  with a registry, also run a 'candidate'/'reviewed' flow
                    (a state note is written to stderr); 'retired' never runs

Flow directory: --flows, or a nonempty FLOWMCP_FLOWS_DIR, or the package's
own ./flows directory. Writes need the approval gate: serve write-capable
flows with 'flowmcp serve' instead.
`;

interface ParsedRun {
  dir?: string;
  flow?: string;
  inputPairs: string[];
  json: boolean;
  allowInactive: boolean;
  help: boolean;
  usageError?: string;
}

// Parse the arguments after `flowmcp run`. Option values are never taken from
// the next token: an option followed by another flag (or by nothing) is a
// missing-value error, so a misplaced `--json` can never be read as a
// directory. `--` ends option parsing; after it every token is positional.
//
// A usage error is recorded but parsing continues, so --json given anywhere
// before `--` is still honored (the JSON envelope is a usage-failure output
// too). The first problem in argv order wins; later tokens are only scanned
// for --json/--allow-inactive and positionals.
function parseRunArgs(argv: string[]): ParsedRun {
  const parsed: ParsedRun = {
    inputPairs: [],
    json: false,
    allowInactive: false,
    help: false,
  };
  const positionals: string[] = [];
  let dir: string | undefined;
  let options = true;
  const fail = (message: string): void => {
    if (parsed.usageError === undefined) parsed.usageError = message;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (options && arg === '--') {
      options = false;
      continue;
    }
    if (options && arg === '--help') {
      parsed.help = true;
      continue;
    }
    if (options && (arg === '--json' || arg === '--allow-inactive')) {
      if (arg === '--json') parsed.json = true;
      else parsed.allowInactive = true;
      continue;
    }
    if (options && (arg === '--flows' || arg === '--input')) {
      const label = arg === '--flows' ? '--flows' : '--input';
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) {
        fail(`option '${label}' requires a value`);
        continue;
      }
      i++;
      if (arg === '--flows') {
        if (dir !== undefined) fail('option \'--flows\' was given more than once');
        else if (value === '') fail('option \'--flows\' requires a nonempty directory');
        else dir = value;
      } else {
        parsed.inputPairs.push(value);
      }
      continue;
    }
    if (options && arg.startsWith('-') && arg !== '-') {
      fail(`unknown option '${arg}'`);
      continue;
    }
    positionals.push(arg);
  }

  if (parsed.help) return parsed;
  if (positionals.length === 0) fail('missing flow name');
  else if (positionals.length > 1) fail(`unexpected extra argument '${positionals[1]}'`);
  if (parsed.usageError !== undefined) return parsed;

  parsed.flow = positionals[0];
  if (dir !== undefined) parsed.dir = dir;
  return parsed;
}

// --flows > nonempty FLOWMCP_FLOWS_DIR > the package's own ../flows folder.
// Relative paths resolve against the process cwd; the fallback is relative to
// this module, like the server's.
function resolveDir(explicit: string | undefined, env: NodeJS.ProcessEnv): string {
  if (explicit !== undefined) return resolve(explicit);
  const fromEnv = env.FLOWMCP_FLOWS_DIR;
  if (fromEnv !== undefined && fromEnv !== '') return resolve(fromEnv);
  return fileURLToPath(new URL('../flows', import.meta.url));
}

interface Failure {
  step: string | null;
  message: string;
}

// A FlowError keeps its step id ('input' for input errors) and its cause. Any
// other error has no attributable step. Every diagnosis names the requested
// flow, the attributable step when there is one, and the cause (which itself
// names the directory contents where that is what went wrong).
function describeFailure(flow: string, e: unknown): Failure {
  const cause = e instanceof Error ? e.message : String(e);
  const step = stepOf(e);
  const where = step === null ? '' : ` (step '${step}')`;
  return { step, message: `flow '${flow}'${where}: ${cause}` };
}

function stepOf(e: unknown): string | null {
  return e instanceof FlowError && typeof e.stepId === 'string' ? e.stepId : null;
}

export async function runCli(argv: string[] = process.argv.slice(3)): Promise<void> {
  const parsed = parseRunArgs(argv);

  // Help never loads a directory, never runs a flow, and is plain text even
  // when --json was also given.
  if (parsed.help) {
    process.stdout.write(RUN_USAGE);
    process.exitCode = 0;
    return;
  }

  if (parsed.usageError !== undefined) {
    const diagnostic = `flowmcp run: ${parsed.usageError}\n\n${RUN_USAGE}`;
    process.stderr.write(diagnostic);
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify({ flow: parsed.flow ?? null, ok: false, error: { step: null, message: parsed.usageError } })}\n`);
    }
    process.exitCode = 1;
    return;
  }

  const flow = parsed.flow!;
  const dir = resolveDir(parsed.dir, process.env);

  let result: { text: string };
  try {
    result = await runFlow({
      dir,
      flow,
      inputPairs: parsed.inputPairs,
      allowInactive: parsed.allowInactive,
    });
  } catch (e) {
    const failure = describeFailure(flow, e);
    process.stderr.write(`flowmcp run: ${failure.message}\n`);
    if (parsed.json) {
      process.stdout.write(
        `${JSON.stringify({ flow, ok: false, error: { step: failure.step, message: failure.message } })}\n`,
      );
    }
    process.exitCode = 1;
    return;
  }

  // The text is passed through untouched (it may itself be JSON); only the
  // final newline is added.
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify({ flow, ok: true, output: result.text })}\n`);
  } else {
    process.stdout.write(`${result.text}\n`);
  }
  process.exitCode = 0;
}
