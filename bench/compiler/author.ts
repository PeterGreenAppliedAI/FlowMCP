// `flowmcp author` v0 — the one-command authoring loop.
//
//   npx tsx bench/compiler/author.ts \
//     --servers-dir <dir containing servers.json5> \
//     --name <flow_name> --model <gateway model id> \
//     [--input name=value] [--probe 'tool:{"q":"test"}'] [--out <dir>] \
//     "<intent — what the flow should do>"
//
// Pipeline: introspect connected MCP servers (read-only tools only) → build a
// truthful tool doc (explicit probes supply example returns) → a model writes
// main(tools) → sandboxed record run against the REAL servers (cassette) →
// repair loop fed with the actually-recorded results on failure → replay v0/v1
// → compile to a candidate flow with provenance → --validate. Review remains
// human. Env: GATEWAY (model endpoint), plus whatever the servers need.

import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { loadServers } from '../../src/loader.js';
import { createDownstreamClient } from '../../src/downstream.js';
import { compile } from './compile.js';
import { projectRoot } from '../../test/helpers.js';

const GATEWAY = process.env.GATEWAY ?? 'http://10.0.0.20:8001';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
function flags(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => { if (a === name && process.argv[i + 1]) out.push(process.argv[i + 1]!); });
  return out;
}

const serversDir = flag('--servers-dir')!;
const flowName = flag('--name') ?? 'authored_flow';
const model = flag('--model') ?? 'dgx-spark2-vllm/deepseek-v4-flash';
const outDir = flag('--out') ?? join(projectRoot, 'bench/compiler/authored', flowName);
const intent = process.argv[process.argv.length - 1]!;
const inputHints: Record<string, string[]> = {};
for (const kv of flags('--input')) {
  const [k, v] = kv.split('=', 2);
  inputHints[k!] = v!.split(',');
}
const probes: Array<{ tool: string; args: Record<string, unknown> }> = flags('--probe').map((p) => {
  const idx = p.indexOf(':');
  return { tool: p.slice(0, idx), args: JSON.parse(p.slice(idx + 1)) as Record<string, unknown> };
});

// ---- introspection via the shared DownstreamClient (read-only tools only) ----
interface ToolDoc { name: string; server: string; description: string; params: string[]; example?: string }

async function introspect(): Promise<ToolDoc[]> {
  const configs = await loadServers(serversDir);
  const docs: ToolDoc[] = [];
  const dl = () => Date.now() + 30_000;
  for (const [serverName, config] of Object.entries(configs)) {
    const client = createDownstreamClient(serverName, config.transport === 'http' ? config : { ...config, cwd: serversDir });
    await client.connect(dl());
    const listed = await client.listTools(dl());
    for (const t of listed) {
      if (t.annotations?.readOnlyHint !== true && !config.attestReadOnly.includes(t.name)) continue;
      const doc: ToolDoc = {
        name: t.name,
        server: serverName,
        description: t.description ?? '',
        params: Object.keys((t.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}),
      };
      const probe = probes.find((p) => p.tool === t.name);
      if (probe) {
        const res = await client.callTool(t.name, probe.args, dl());
        const text = (res.content ?? []).map((c) => c.text ?? '').join('');
        doc.example = text.slice(0, 400);
      }
      docs.push(doc);
    }
    client.close();
  }
  return docs;
}

async function chat(messages: Array<{ role: string; content: string }>): Promise<{ text: string; tokens: number }> {
  const res = await fetch(`${GATEWAY}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages, temperature: 0, max_tokens: 2048 }),
    signal: AbortSignal.timeout(240_000),
  });
  if (!res.ok) throw new Error(`gateway HTTP ${res.status}`);
  const d = (await res.json()) as { choices: [{ message: { content: string | null } }]; usage?: { prompt_tokens: number; completion_tokens: number } };
  return { text: d.choices[0].message.content ?? '', tokens: (d.usage?.prompt_tokens ?? 0) + (d.usage?.completion_tokens ?? 0) };
}

function extractCode(text: string): string | null {
  const fence = /```(?:javascript|js)?\s*\n([\s\S]*?)```/.exec(text);
  const code = (fence ? fence[1]! : text).replace(/^```(?:javascript|js)?\s*$/gm, '');
  return /function\s+main|main\s*=/.test(code) ? code : null;
}

interface RunOut { variant: number; result?: string; error?: string; trace: Array<{ seq: number; name: string; args: unknown; result: unknown }> }

function runChild(scriptPath: string, mode: string, cassettePath: string, extra: string[] = []): { out: RunOut; toolMap: Record<string, string> } {
  const proc = spawnSync(process.execPath,
    ['--import', 'tsx', 'bench/compiler/author-runner.ts', scriptPath, mode, cassettePath, serversDir, ...extra],
    { cwd: projectRoot, timeout: 120_000 });
  const stdout = proc.stdout?.toString() ?? '';
  const stderr = proc.stderr?.toString() ?? '';
  const toolMap: Record<string, string> = {};
  for (const m of stderr.matchAll(/^TOOLMAP (\S+) (\S+)$/gm)) toolMap[m[1]!] = m[2]!;
  try {
    return { out: JSON.parse(stdout) as RunOut, toolMap };
  } catch {
    return { out: { variant: -1, error: (stderr || stdout || 'no output').slice(0, 300), trace: [] }, toolMap };
  }
}

(async () => {
  console.error(`[author] introspecting servers in ${serversDir} ...`);
  const docs = await introspect();
  if (!docs.length) throw new Error('no read-only tools found on the configured servers');
  const docText = docs.map((d) =>
    `tools.${d.name}({${d.params.join(', ')}}) — ${d.description} [server: ${d.server}]` +
    (d.example ? `\n  returns e.g. ${d.example}` : '')).join('\n');
  console.error(`[author] ${docs.length} read-only tool(s) available`);

  const system =
    'You write a Node.js program to complete the task.\n' +
    'Reply with ONLY JavaScript code defining `async function main(tools)`.\n' +
    '`tools` functions are async, take one object argument, return parsed JSON.\n' +
    'main must RETURN the final answer as a markdown string built from the retrieved data.\n' +
    'No imports, no network, no filesystem — only the provided tools.\n\nAvailable tools:\n' + docText;
  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: system },
    { role: 'user', content: intent },
  ];

  mkdirSync(outDir, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'flowmcp-author-'));
  const cassettePath = join(outDir, 'cassette.json');
  let modelTokens = 0;
  let record: RunOut | null = null;
  let toolMap: Record<string, string> = {};
  let script = '';

  for (let attempt = 1; attempt <= 3; attempt++) {
    console.error(`[author] generation attempt ${attempt} (${model}) ...`);
    const gen = await chat(messages);
    modelTokens += gen.tokens;
    const code = extractCode(gen.text);
    if (!code) {
      messages.push({ role: 'assistant', content: gen.text }, { role: 'user', content: 'Reply with ONLY the JavaScript defining async function main(tools).' });
      continue;
    }
    script = code;
    const scriptPath = join(work, `attempt-${attempt}.js`);
    writeFileSync(scriptPath, code);
    const r = runChild(scriptPath, 'record', cassettePath);
    toolMap = { ...toolMap, ...r.toolMap };
    if (!r.out.error) { record = r.out; break; }
    console.error(`[author] attempt ${attempt} failed: ${r.out.error}`);
    const evidence = r.out.trace.slice(0, 3).map((t) => `${t.name}(${JSON.stringify(t.args)}) returned: ${JSON.stringify(t.result).slice(0, 300)}`).join('\n');
    messages.push({ role: 'assistant', content: gen.text },
      { role: 'user', content: `Execution failed: ${r.out.error}\nActual tool results recorded:\n${evidence || '(none)'}\nReply with ONLY the corrected script.` });
  }
  if (!record) throw new Error('authoring failed after 3 attempts');
  console.error(`[author] recorded ${record.trace.length} real tool call(s); model spend ${modelTokens} tokens`);

  const scriptPath = join(outDir, 'source-script.js');
  writeFileSync(scriptPath, script);
  const v0 = runChild(scriptPath, 'replay', cassettePath, ['--variant', '0']).out;
  const v1 = runChild(scriptPath, 'replay', cassettePath, ['--variant', '1']).out;
  if (v0.error || v1.error) throw new Error(`replay failed: ${v0.error ?? v1.error}`);

  const { flow, provenance } = compile(
    v0 as never, v1 as never, flowName, 'authored from intent',
    { server: toolMap, inputHints, description: `WHEN TO USE: ${intent}` },
  );
  writeFileSync(join(outDir, `${flowName}.flow.json5`), flow);
  writeFileSync(join(outDir, `${flowName}.provenance.json`), JSON.stringify({ ...provenance, intent, model, modelTokens, toolMap }, null, 2));
  copyFileSync(join(serversDir, 'servers.json5'), join(outDir, 'servers.json5'));

  const validate = execFileSync(process.execPath, ['--import', 'tsx', 'src/server.ts', '--flows', outDir, '--validate'],
    { cwd: projectRoot, env: { ...process.env }, timeout: 60_000 }).toString() +
    ' (see stderr)';
  console.error(`[author] candidate written to ${outDir}`);
  console.log(flow);
})().catch((e) => { console.error(`AUTHOR FAILED: ${e instanceof Error ? e.message : e}`); process.exit(1); });
