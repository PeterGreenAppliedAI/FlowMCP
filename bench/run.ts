// FlowMCP benchmark — workflow façade (A) vs. primitive 35-tool surface (B).
//
// Both conditions run the same tasks against the same gateway models and are
// scored against identical fixture ground truth. Condition A executes tool
// calls through a REAL spawned FlowMCP server (fixture flows + fixture HTTP);
// condition B executes against mocked primitive tools returning the same data.
//
//   npx tsx bench/run.ts [--models a,b] [--trials N] [--tasks 1,2,3] [--conditions A,B]
//
// Env: GATEWAY (default http://10.0.0.20:8001)

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { projectRoot, RpcClient, spawnServer, startFixtureServer } from '../test/helpers.js';
import { PRIMITIVE_TOOLS, executePrimitiveTool, PRIMITIVE_TOOL_NAMES, type OpenAiTool } from './primitive-tools.js';

const GATEWAY = process.env.GATEWAY ?? 'http://10.0.0.20:8001';
const MAX_ROUNDS = 12;
const REQUEST_TIMEOUT_MS = 240_000;

const DEFAULT_MODELS = [
  'gpu-node-3060/gemma3:4b',
  'gpu-node/qwen2.5:7b',
  'gpu-node/llama3.1:8b',
  'gpu-node/phi4:14b',
  'gpu-node/gpt-oss:20b',
  'dgx-spark-1/qwen3.6:35b',
];

const STORY_TITLES = ['Story 101', 'Story 102', 'Story 103', 'Story 104', 'Story 105'];

interface Task {
  id: string;
  prompt: string;
  expectedFlowTool: string; // ground truth for condition A tool selection
  score: (finalText: string) => boolean;
}

const briefScore = (text: string) =>
  text.includes('30.1') && text.includes('20.2') && STORY_TITLES.filter((t) => text.includes(t)).length >= 3;
const hnScore = (text: string) => STORY_TITLES.filter((t) => text.includes(t)).length >= 3;

const TASKS: Task[] = [
  { id: 'brief_city', prompt: 'Give me a morning brief for Lisbon.', expectedFlowTool: 'morning_brief', score: briefScore },
  { id: 'hn_now', prompt: 'What is on Hacker News right now?', expectedFlowTool: 'hn_top', score: hnScore },
  { id: 'brief_default', prompt: 'Morning brief, please.', expectedFlowTool: 'morning_brief', score: briefScore },
];

const SYSTEM_PROMPT =
  'You are a helpful assistant with access to tools. Use the tools to get real data — never invent values. ' +
  'When you have what you need, reply with a final text answer that includes the concrete data you retrieved.';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface RunResult {
  model: string;
  condition: 'A' | 'B';
  task: string;
  trial: number;
  success: boolean;
  rightFirstTool: boolean | null; // condition A only
  rounds: number;
  toolCalls: number;
  badCalls: number; // unknown tool or malformed arguments
  promptTokens: number;
  completionTokens: number;
  ms: number;
  note: string;
}

async function chat(model: string, messages: ChatMessage[], tools: OpenAiTool[]) {
  const res = await fetch(`${GATEWAY}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages, tools, temperature: 0 }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`gateway HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as {
    choices: [{ message: ChatMessage; finish_reason: string }];
    usage?: { prompt_tokens: number; completion_tokens: number };
  };
}

type ToolExecutor = (name: string, args: Record<string, unknown>) => Promise<{ text: string; bad: boolean }>;

async function runOnce(
  model: string,
  condition: 'A' | 'B',
  task: Task,
  trial: number,
  tools: OpenAiTool[],
  execute: ToolExecutor,
): Promise<RunResult> {
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: task.prompt },
  ];
  const started = Date.now();
  let rounds = 0;
  let toolCalls = 0;
  let badCalls = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let rightFirstTool: boolean | null = condition === 'A' ? false : null;
  let finalText = '';
  let note = '';

  try {
    while (rounds < MAX_ROUNDS) {
      rounds++;
      const res = await chat(model, messages, tools);
      promptTokens += res.usage?.prompt_tokens ?? 0;
      completionTokens += res.usage?.completion_tokens ?? 0;
      const msg = res.choices[0].message;
      const calls = msg.tool_calls ?? [];
      if (calls.length === 0) {
        finalText = msg.content ?? '';
        break;
      }
      if (condition === 'A' && toolCalls === 0 && calls[0]) {
        rightFirstTool = calls[0].function.name === task.expectedFlowTool;
      }
      messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: calls });
      for (const call of calls) {
        toolCalls++;
        let args: Record<string, unknown> = {};
        let bad = false;
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          bad = true;
        }
        const executed = bad
          ? { text: 'ERROR: arguments were not valid JSON', bad: true }
          : await execute(call.function.name, args);
        if (executed.bad) badCalls++;
        messages.push({ role: 'tool', content: executed.text, tool_call_id: call.id });
      }
    }
    if (rounds >= MAX_ROUNDS && !finalText) note = 'hit round limit';
    if (toolCalls === 0) note = note || 'never called a tool';
  } catch (e) {
    note = `error: ${e instanceof Error ? e.message : e}`.slice(0, 120);
  }

  return {
    model,
    condition,
    task: task.id,
    trial,
    success: task.score(finalText),
    rightFirstTool,
    rounds,
    toolCalls,
    badCalls,
    promptTokens,
    completionTokens,
    ms: Date.now() - started,
    note,
  };
}

function parseListArg(flag: string): string[] | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1]!.split(',') : undefined;
}

async function main() {
  const models = parseListArg('--models') ?? DEFAULT_MODELS;
  const trials = Number(parseListArg('--trials')?.[0] ?? 2);
  const taskIds = parseListArg('--tasks');
  const conditions = (parseListArg('--conditions') ?? ['A', 'B']) as Array<'A' | 'B'>;
  const tasks = taskIds ? TASKS.filter((t) => taskIds.includes(t.id)) : TASKS;

  // Condition A backend: real FlowMCP serving bench/flows (exactly the 2-tool
  // façade), grounded in the same fixture HTTP server as condition B's mocks.
  const fixtures = await startFixtureServer();
  const flowmcp = new RpcClient(
    spawnServer(join(projectRoot, 'bench/flows'), { FIXTURE_BASE: fixtures.baseUrl }),
  );
  await flowmcp.request('initialize', { protocolVersion: '2025-03-26', capabilities: {} });
  flowmcp.notify('notifications/initialized');
  const listed = await flowmcp.request('tools/list');
  const flowTools: OpenAiTool[] = (listed.result!.tools as Array<Record<string, unknown>>).map(
    (t) => ({
      type: 'function' as const,
      function: {
        name: t.name as string,
        description: t.description as string,
        parameters: t.inputSchema as Record<string, unknown>,
      },
    }),
  );
  const flowToolNames = new Set(flowTools.map((t) => t.function.name));

  const executeA: ToolExecutor = async (name, args) => {
    if (!flowToolNames.has(name)) return { text: `ERROR: unknown tool '${name}'`, bad: true };
    const res = await flowmcp.request('tools/call', { name, arguments: args });
    const result = res.result as { content: [{ text: string }]; isError?: boolean } | undefined;
    if (!result) return { text: `ERROR: ${res.error?.message ?? 'call failed'}`, bad: true };
    return { text: result.content[0].text, bad: result.isError === true };
  };

  const executeB: ToolExecutor = async (name, args) => {
    if (!PRIMITIVE_TOOL_NAMES.has(name)) return { text: `ERROR: unknown tool '${name}'`, bad: true };
    return { text: executePrimitiveTool(name, args), bad: false };
  };

  const results: RunResult[] = [];
  const total = models.length * conditions.length * tasks.length * trials;
  let done = 0;
  for (const model of models) {
    // Warm the model first — cold-loading a large model must not eat a trial's timeout.
    try {
      await fetch(`${GATEWAY}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 }),
        signal: AbortSignal.timeout(600_000),
      });
    } catch (e) {
      console.error(`warmup failed for ${model}: ${e instanceof Error ? e.message : e}`);
    }
    for (const condition of conditions) {
      const tools = condition === 'A' ? flowTools : PRIMITIVE_TOOLS;
      const execute = condition === 'A' ? executeA : executeB;
      for (const task of tasks) {
        for (let trial = 1; trial <= trials; trial++) {
          const r = await runOnce(model, condition, task, trial, tools, execute);
          results.push(r);
          done++;
          console.error(
            `[${done}/${total}] ${model} ${condition}/${task.id} #${trial}: ` +
              `${r.success ? 'PASS' : 'fail'} rounds=${r.rounds} calls=${r.toolCalls} ` +
              `tok=${r.promptTokens + r.completionTokens} ${Math.round(r.ms / 1000)}s ${r.note}`,
          );
        }
      }
    }
  }

  await mkdir(join(projectRoot, 'bench/results'), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = join(projectRoot, `bench/results/results-${stamp}.json`);
  await writeFile(outPath, JSON.stringify(results, null, 2));
  console.error(`\nwrote ${outPath}\n`);

  // Summary table: per model × condition, aggregated over tasks and trials.
  const rows: string[] = ['| model | cond | success | right tool | avg calls | avg tokens | avg s |', '|---|---|---|---|---|---|---|'];
  for (const model of models) {
    for (const condition of conditions) {
      const rs = results.filter((r) => r.model === model && r.condition === condition);
      if (!rs.length) continue;
      const pct = (n: number) => `${Math.round((n / rs.length) * 100)}%`;
      const avg = (f: (r: RunResult) => number) => (rs.reduce((s, r) => s + f(r), 0) / rs.length).toFixed(1);
      const right = condition === 'A' ? pct(rs.filter((r) => r.rightFirstTool).length) : '—';
      rows.push(
        `| ${model} | ${condition} | ${pct(rs.filter((r) => r.success).length)} | ${right} | ${avg((r) => r.toolCalls)} | ${avg((r) => r.promptTokens + r.completionTokens)} | ${avg((r) => r.ms / 1000)} |`,
      );
    }
  }
  console.log(rows.join('\n'));

  flowmcp.close();
  await fixtures.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
