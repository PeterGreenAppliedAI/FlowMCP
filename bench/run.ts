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
import { PRIMITIVE_TOOLS, executePrimitiveTool, PRIMITIVE_TOOL_NAMES, RECIPE_TEXT, type OpenAiTool } from './primitive-tools.js';

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

type Condition = 'A' | 'B' | 'C' | 'D' | 'R';

interface Task {
  id: string;
  prompt: string;
  expectedFlowTool: string | null; // ground truth for façade tool selection (null: no flow applies)
  conditions: Condition[];
  score: (finalText: string) => boolean;
}

const briefScore = (text: string) =>
  text.includes('30.1') && text.includes('20.2') && STORY_TITLES.filter((t) => text.includes(t)).length >= 3;
const hnScore = (text: string) => STORY_TITLES.filter((t) => text.includes(t)).length >= 3;

const TASKS: Task[] = [
  { id: 'brief_city', prompt: 'Give me a morning brief for Lisbon.', expectedFlowTool: 'morning_brief', conditions: ['A', 'B', 'C', 'D', 'R'], score: briefScore },
  { id: 'hn_now', prompt: 'What is on Hacker News right now?', expectedFlowTool: 'hn_top', conditions: ['A', 'B', 'C', 'D', 'R'], score: hnScore },
  { id: 'brief_default', prompt: 'Morning brief, please.', expectedFlowTool: 'morning_brief', conditions: ['A', 'B', 'C', 'D', 'R'], score: briefScore },
  // D only: the right answer is a flow PLUS one primitive call.
  {
    id: 'partial_match',
    prompt: 'Give me a morning brief for Lisbon, and include the current EUR to USD exchange rate.',
    expectedFlowTool: 'morning_brief',
    conditions: ['D'],
    score: (text) => briefScore(text) && text.includes('1.0842'),
  },
  // D only: no flow applies — the model must decline the façade and use a primitive.
  {
    id: 'decline',
    prompt: 'What is the current moon phase?',
    expectedFlowTool: null,
    conditions: ['D'],
    score: (text) => text.toLowerCase().includes('waxing gibbous'),
  },
];

const SYSTEM_PROMPT =
  'You are a helpful assistant with access to tools. Use the tools to get real data — never invent values. ' +
  'When you have what you need, reply with a final text answer that includes the concrete data you retrieved.';

// Condition R: same 35 primitives as B, but the specification and intended
// sequence are supplied in text. Execution stays with the model. Separates
// specification-supply (B vs R) from deterministic execution (R vs A).
const RECIPE_PROMPT = SYSTEM_PROMPT + '\n\n' + RECIPE_TEXT;

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
  condition: Condition;
  task: string;
  trial: number;
  success: boolean;
  rightFirstTool: boolean | null; // façade conditions only
  rounds: number;
  toolCalls: number;
  badCalls: number; // unknown tool or malformed arguments
  usedTools: string[];
  promptTokens: number;
  completionTokens: number;
  ms: number;
  note: string;
}

interface Transcript {
  model: string;
  condition: Condition;
  task: string;
  trial: number;
  messages: ChatMessage[];
}

// Optional per-request generation cap (--max-tokens N): bounds runaway
// generations (e.g. a reasoning model deliberating instead of calling a tool)
// without gateway-side clamping.
const maxTokensArg = process.argv.indexOf('--max-tokens');
const MAX_TOKENS = maxTokensArg !== -1 ? Number(process.argv[maxTokensArg + 1]) : undefined;

async function chat(model: string, messages: ChatMessage[], tools: OpenAiTool[]) {
  const res = await fetch(`${GATEWAY}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      tools,
      temperature: 0,
      ...(MAX_TOKENS ? { max_tokens: MAX_TOKENS } : {}),
    }),
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
  condition: Condition,
  task: Task,
  trial: number,
  tools: OpenAiTool[],
  execute: ToolExecutor,
  transcripts: Transcript[],
  flowToolNames: Set<string>,
): Promise<RunResult> {
  const messages: ChatMessage[] = [
    { role: 'system', content: condition === 'R' ? RECIPE_PROMPT : SYSTEM_PROMPT },
    { role: 'user', content: task.prompt },
  ];
  const started = Date.now();
  let rounds = 0;
  let toolCalls = 0;
  let badCalls = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  const facade = condition === 'A' || condition === 'D';
  let rightFirstTool: boolean | null = facade && task.expectedFlowTool !== null ? false : null;
  const usedTools: string[] = [];
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
      if (facade && task.expectedFlowTool !== null && toolCalls === 0 && calls[0]) {
        rightFirstTool = calls[0].function.name === task.expectedFlowTool;
      }
      messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: calls });
      for (const call of calls) {
        toolCalls++;
        usedTools.push(call.function.name);
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

  // decline task: calling any flow tool is a façade misuse worth flagging.
  if (task.expectedFlowTool === null && usedTools.some((t) => flowToolNames.has(t))) {
    note = (note ? note + '; ' : '') + 'façade misuse: called a flow on a no-flow task';
  }
  transcripts.push({ model, condition, task: task.id, trial, messages });
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
    usedTools,
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
  const conditions = (parseListArg('--conditions') ?? ['A', 'B']) as Condition[];
  const allTasks = taskIds ? TASKS.filter((t) => taskIds.includes(t.id)) : TASKS;

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

  // Condition C: tool-search — the surface is two meta-tools; definitions load on demand.
  const searchTools: OpenAiTool[] = [
    {
      type: 'function',
      function: {
        name: 'search_tools',
        description: 'Search the tool catalog by keywords. Returns matching tool definitions you can then invoke with call_tool.',
        parameters: { type: 'object', properties: { query: { type: 'string', description: 'Keywords to search for' } }, required: ['query'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'call_tool',
        description: 'Invoke a tool from the catalog by name, with its arguments. Find tools first with search_tools.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Tool name from search results' },
            arguments: { type: 'object', description: 'Arguments for the tool' },
          },
          required: ['name'],
        },
      },
    },
  ];

  const executeC: ToolExecutor = async (name, args) => {
    if (name === 'search_tools') {
      const words = String(args.query ?? '').toLowerCase().split(/\W+/).filter(Boolean);
      const scored = PRIMITIVE_TOOLS.map((t) => {
        const hay = `${t.function.name} ${t.function.description}`.toLowerCase();
        return { t, score: words.filter((w) => hay.includes(w)).length };
      })
        .filter((s) => s.score > 0)
        .sort((x, y) => y.score - x.score)
        .slice(0, 5)
        .map((s) => s.t.function);
      return { text: JSON.stringify({ matches: scored }), bad: false };
    }
    if (name === 'call_tool') {
      const toolName = String(args.name ?? '');
      if (!PRIMITIVE_TOOL_NAMES.has(toolName)) {
        return { text: `ERROR: no tool named '${toolName}' — use search_tools first`, bad: true };
      }
      return { text: executePrimitiveTool(toolName, (args.arguments ?? {}) as Record<string, unknown>), bad: false };
    }
    return { text: `ERROR: unknown tool '${name}'`, bad: true };
  };

  // Condition D: the mixed surface — flows and primitives side by side.
  const mixedTools: OpenAiTool[] = [...flowTools, ...PRIMITIVE_TOOLS];
  const executeD: ToolExecutor = async (name, args) => {
    if (flowToolNames.has(name)) return executeA(name, args);
    return executeB(name, args);
  };

  const surfaces: Record<Condition, { tools: OpenAiTool[]; execute: ToolExecutor }> = {
    A: { tools: flowTools, execute: executeA },
    B: { tools: PRIMITIVE_TOOLS, execute: executeB },
    C: { tools: searchTools, execute: executeC },
    D: { tools: mixedTools, execute: executeD },
    R: { tools: PRIMITIVE_TOOLS, execute: executeB },
  };

  const results: RunResult[] = [];
  const transcripts: Transcript[] = [];
  const total = models.length * conditions.reduce(
    (sum, c) => sum + allTasks.filter((t) => t.conditions.includes(c)).length * trials, 0);
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
      const { tools, execute } = surfaces[condition];
      for (const task of allTasks.filter((t) => t.conditions.includes(condition))) {
        for (let trial = 1; trial <= trials; trial++) {
          const r = await runOnce(model, condition, task, trial, tools, execute, transcripts, flowToolNames);
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
  const transcriptPath = join(projectRoot, `bench/results/transcripts-${stamp}.json`);
  await writeFile(transcriptPath, JSON.stringify(transcripts, null, 2));
  console.error(`\nwrote ${outPath}\nwrote ${transcriptPath}\n`);

  // Summary table: per model × condition, aggregated over tasks and trials.
  const rows: string[] = ['| model | cond | success | right tool | avg calls | avg tokens | avg s |', '|---|---|---|---|---|---|---|'];
  for (const model of models) {
    for (const condition of conditions) {
      const rs = results.filter((r) => r.model === model && r.condition === condition);
      if (!rs.length) continue;
      const pct = (n: number) => `${Math.round((n / rs.length) * 100)}%`;
      const avg = (f: (r: RunResult) => number) => (rs.reduce((s, r) => s + f(r), 0) / rs.length).toFixed(1);
      const scored = rs.filter((r) => r.rightFirstTool !== null);
      const right = scored.length
        ? `${Math.round((scored.filter((r) => r.rightFirstTool).length / scored.length) * 100)}%`
        : '—';
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
