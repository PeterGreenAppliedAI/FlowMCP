// Code mode (condition E): the model writes a Node.js program against the same
// 35-primitive API instead of driving an agentic tool loop.
//
//   E0 — one-shot code, no recipe (does code mode help infer the contract?)
//   E1 — one-shot code + the R recipe (contract + plan supplied)
//   E2 — iterative code + recipe: execution errors return for up to 3 attempts
//
// Each attempt executes in a disposable child process (see code-runner.ts):
// minimal env, empty temp cwd, wall-clock timeout with tree-kill, capped
// output, capped API calls. Successful scripts are saved and re-executed once
// to measure compile-once reuse (zero model tokens on the second run).
//
//   npx tsx bench/code-mode.ts [--models a,b] [--variants E0,E1,E2] [--trials N]

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectRoot } from '../test/helpers.js';
import { PRIMITIVE_TOOLS, RECIPE_TEXT, executePrimitiveTool } from './primitive-tools.js';

const GATEWAY = process.env.GATEWAY ?? 'http://10.0.0.20:8001';
const REQUEST_TIMEOUT_MS = 240_000;
const EXEC_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3; // E2 only; E0/E1 use 1
const STORY_TITLES = ['Story 101', 'Story 102', 'Story 103', 'Story 104', 'Story 105'];

const DEFAULT_MODELS = [
  'gpu-node/qwen2.5:7b',
  'gpu-node-3060/mistral:7b-instruct',
  'gpu-node/llama3.1:8b',
  'gpu-node/qwen3.5:9b',
  'gpu-node/gemma4:12b',
  'gpu-node/gpt-oss:20b',
  'dgx-spark-1/qwen3.6:35b',
  'dgx-spark2-vllm/deepseek-v4-flash',
];

const briefScore = (t: string) =>
  t.includes('30.1') && t.includes('20.2') && STORY_TITLES.filter((s) => t.includes(s)).length >= 3;
const TASKS = [
  { id: 'brief_city', prompt: 'Give me a morning brief for Lisbon.', score: briefScore },
  { id: 'hn_now', prompt: 'What is on Hacker News right now?', score: (t: string) => STORY_TITLES.filter((s) => t.includes(s)).length >= 3 },
  { id: 'brief_default', prompt: 'Morning brief, please.', score: briefScore },
];

// Example return values are generated from the mocks themselves, so the doc's
// response shapes are truthful. Without them, one-shot code must guess schemas
// blind — an unfairness the agentic loop doesn't have (it sees every result).
const SAMPLE_ARGS: Record<string, Record<string, unknown>> = {
  search_locations: { query: 'Lisbon' },
  hn_get_item: { id: 101 },
  get_exchange_rate: { base: 'EUR', quote: 'USD' },
};
const API_DOC = PRIMITIVE_TOOLS.map((t) => {
  const props = Object.keys((t.function.parameters as { properties?: Record<string, unknown> }).properties ?? {});
  const example = executePrimitiveTool(t.function.name, SAMPLE_ARGS[t.function.name] ?? { latitude: 1.5, longitude: 2.5 });
  return `tools.${t.function.name}({${props.join(', ')}}) — ${t.function.description}\n  returns e.g. ${example.slice(0, 140)}`;
}).join('\n');

const CODE_INSTRUCTIONS =
  'You write a Node.js program to complete the user\'s task.\n' +
  'Reply with ONLY JavaScript code (a ```javascript fence is fine) defining `async function main(tools)`.\n' +
  '`tools` is an object of async functions (call each with a single object argument; each returns parsed JSON).\n' +
  'main(tools) must RETURN the final answer as a string containing the concrete retrieved data.\n' +
  'No imports, no require, no network, no filesystem — only the provided tools.\n\nAvailable tools:\n' + API_DOC;

type Variant = 'E0' | 'E1' | 'E2';

interface CodeRun {
  variant: Variant; model: string; task: string; trial: number;
  success: boolean; attempts: number; modelTokens: number; apiCalls: number;
  execMs: number; failure: string; reuseSuccess: boolean | null;
}

async function chat(model: string, messages: Array<{ role: string; content: string }>) {
  const res = await fetch(`${GATEWAY}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages, temperature: 0, max_tokens: 2048 }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`gateway HTTP ${res.status}`);
  const data = (await res.json()) as {
    choices: [{ message: { content: string | null } }];
    usage?: { prompt_tokens: number; completion_tokens: number };
  };
  return {
    text: data.choices[0].message.content ?? '',
    tokens: (data.usage?.prompt_tokens ?? 0) + (data.usage?.completion_tokens ?? 0),
  };
}

function extractCode(text: string): string | null {
  const fence = /```(?:javascript|js)?\s*\n([\s\S]*?)```/.exec(text);
  // Strip stray/asymmetric fences (models sometimes emit only a closing one).
  const code = (fence ? fence[1]! : text).replace(/^```(?:javascript|js)?\s*$/gm, '');
  return /function\s+main|main\s*=/.test(code) ? code : null;
}

interface ExecResult { ok: boolean; result: string; apiCalls: number; ms: number; error: string }

async function execScript(code: string): Promise<ExecResult> {
  const dir = await mkdtemp(join(tmpdir(), 'flowmcp-code-'));
  const scriptPath = join(dir, 'script.js');
  await writeFile(scriptPath, code);
  const started = Date.now();
  return await new Promise<ExecResult>((resolve) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'bench/code-runner.ts', scriptPath],
      {
        cwd: projectRoot, // tsx resolution; the runner chdirs to SANDBOX_DIR before model code runs
        env: { PATH: process.env.PATH, HOME: process.env.HOME, SANDBOX_DIR: dir },
        detached: true,
      },
    );
    let out = '';
    let err = '';
    const cap = (s: string, c: string) => (s.length < 65536 ? s + c : s);
    child.stdout.on('data', (c: Buffer) => (out = cap(out, c.toString())));
    child.stderr.on('data', (c: Buffer) => (err = cap(err, c.toString())));
    const timer = setTimeout(() => {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
    }, EXEC_TIMEOUT_MS);
    child.on('exit', () => {
      clearTimeout(timer);
      void rm(dir, { recursive: true, force: true });
      const ms = Date.now() - started;
      const marker = out.indexOf('<<<RESULT>>>');
      if (marker !== -1) {
        try {
          const parsed = JSON.parse(out.slice(marker + 12)) as { result: string; apiCalls: number };
          resolve({ ok: true, result: parsed.result, apiCalls: parsed.apiCalls, ms, error: '' });
          return;
        } catch { /* fall through */ }
      }
      const reason = ms >= EXEC_TIMEOUT_MS ? 'timeout' : (err.trim() || 'no result produced');
      resolve({ ok: false, result: '', apiCalls: 0, ms, error: reason.slice(0, 400) });
    });
  });
}

function parseListArg(flag: string): string[] | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1]!.split(',') : undefined;
}

async function main() {
  const models = parseListArg('--models') ?? DEFAULT_MODELS;
  const variants = (parseListArg('--variants') ?? ['E0', 'E1', 'E2']) as Variant[];
  const trials = Number(parseListArg('--trials')?.[0] ?? 2);
  const results: CodeRun[] = [];
  const scriptsDir = join(projectRoot, 'bench/results/code-scripts');
  await mkdir(scriptsDir, { recursive: true });
  const total = models.length * variants.length * TASKS.length * trials;
  let done = 0;

  for (const model of models) {
    for (const variant of variants) {
      for (const task of TASKS) {
        for (let trial = 1; trial <= trials; trial++) {
          const system =
            variant === 'E0' ? CODE_INSTRUCTIONS : CODE_INSTRUCTIONS + '\n\n' + RECIPE_TEXT;
          const messages = [
            { role: 'system', content: system },
            { role: 'user', content: task.prompt },
          ];
          const maxAttempts = variant === 'E2' ? MAX_ATTEMPTS : 1;
          let attempts = 0;
          let modelTokens = 0;
          let success = false;
          let failure = '';
          let apiCalls = 0;
          let execMs = 0;
          let goodScript: string | null = null;

          try {
            while (attempts < maxAttempts && !success) {
              attempts++;
              const gen = await chat(model, messages);
              modelTokens += gen.tokens;
              const code = extractCode(gen.text);
              if (!code) {
                failure = 'no_code';
                messages.push({ role: 'assistant', content: gen.text });
                messages.push({ role: 'user', content: 'That reply did not contain a script defining async function main(tools). Reply with ONLY the corrected JavaScript.' });
                continue;
              }
              const exec = await execScript(code);
              apiCalls = exec.apiCalls;
              execMs = exec.ms;
              if (!exec.ok) {
                failure = exec.error === 'timeout' ? 'timeout' : 'exec_error';
                messages.push({ role: 'assistant', content: gen.text });
                messages.push({ role: 'user', content: `Execution failed:\n${exec.error}\nReply with ONLY the corrected script.` });
                continue;
              }
              if (task.score(exec.result)) {
                success = true;
                failure = '';
                goodScript = code;
              } else {
                failure = 'wrong_output';
                messages.push({ role: 'assistant', content: gen.text });
                messages.push({ role: 'user', content: `The script ran but the answer was incomplete or wrong:\n${exec.result.slice(0, 600)}\nReply with ONLY the corrected script.` });
              }
            }
          } catch (e) {
            failure = `error: ${e instanceof Error ? e.message : e}`.slice(0, 100);
          }

          // Compile-once reuse: re-execute the successful script (0 model tokens).
          let reuseSuccess: boolean | null = null;
          if (goodScript) {
            const short = model.split('/').pop()!.replace(/[^a-z0-9.]+/gi, '_');
            await writeFile(join(scriptsDir, `${short}-${variant}-${task.id}-${trial}.js`), goodScript);
            const re = await execScript(goodScript);
            reuseSuccess = re.ok && task.score(re.result);
          }

          results.push({ variant, model, task: task.id, trial, success, attempts, modelTokens, apiCalls, execMs, failure, reuseSuccess });
          done++;
          console.error(
            `[${done}/${total}] ${model} ${variant}/${task.id} #${trial}: ${success ? 'PASS' : 'fail'} ` +
              `attempts=${attempts} tok=${modelTokens} api=${apiCalls} ${execMs}ms ${failure} reuse=${reuseSuccess}`,
          );
        }
      }
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = join(projectRoot, `bench/results/code-results-${stamp}.json`);
  await writeFile(outPath, JSON.stringify(results, null, 2));
  console.error(`\nwrote ${outPath}\n`);

  const rows = ['| model | variant | success | avg attempts | avg model tok | reuse ok |', '|---|---|---|---|---|---|'];
  for (const model of models) {
    for (const variant of variants) {
      const rs = results.filter((r) => r.model === model && r.variant === variant);
      if (!rs.length) continue;
      const succ = rs.filter((r) => r.success);
      const avg = (f: (r: CodeRun) => number) => (rs.reduce((s, r) => s + f(r), 0) / rs.length).toFixed(1);
      const reuse = succ.length ? `${succ.filter((r) => r.reuseSuccess).length}/${succ.length}` : '—';
      rows.push(`| ${model} | ${variant} | ${succ.length}/${rs.length} | ${avg((r) => r.attempts)} | ${avg((r) => r.modelTokens)} | ${reuse} |`);
    }
  }
  console.log(rows.join('\n'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
