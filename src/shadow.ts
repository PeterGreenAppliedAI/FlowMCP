// `flowmcp shadow` — the shadow-replay harness for retirement's hardest case:
// stale-but-well-formed output, the rot no structural check can see.
//
//   flowmcp shadow <flow> --flows <dir> --agent '<cmd>' [--judge '<cmd>']
//     [--task "<text>"] [--input k=v] [--timeout-ms N]
//
// Protocol (the host supplies ALL judgment; FlowMCP never calls a model):
//   1. Run the flow deterministically (READ-ONLY flows only — shadowing a
//      write flow would perform the write twice; refused).
//   2. Run the host's agent command: it receives {task, inputs} as JSON on
//      stdin and prints its own independent answer to stdout. The task comes
//      from --task, else the flow's provenance intent, else its description.
//   3. If --judge is given: the judge command receives
//      {task, flowOutput, agentOutput} on stdin and prints {"ok": bool,
//      "note": "..."} — its verdict is appended to registry-log.jsonl as a
//      {kind:'shadow'} record. Without --judge, both outputs are printed for
//      human comparison and NOTHING is recorded: no judgment, no verdict.
//
// Cadence guidance: schedule shadow runs slower than the flow's call
// frequency — affordable by construction, since detection only nominates
// high-frequency procedures in the first place.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkServerRefs, flowEffects, loadFlows, loadServers } from './loader.js';
import { executeFlow } from './engine.js';
import { McpPool } from './mcp-pool.js';
import { appendLog, loadRegistry } from './registry.js';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
function flags(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => { if (a === name && process.argv[i + 1]) out.push(process.argv[i + 1]!); });
  return out;
}

function runCommand(cmd: string, stdinJson: unknown, timeoutMs: number, label: string): string {
  const proc = spawnSync(cmd, {
    shell: true, // operator-supplied command string — same trust as our own argv
    input: JSON.stringify(stdinJson),
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (proc.error) throw new Error(`${label} command failed to start: ${proc.error.message}`);
  if (proc.status !== 0) {
    throw new Error(`${label} command exited ${proc.status}: ${(proc.stderr?.toString() ?? '').slice(0, 300)}`);
  }
  return proc.stdout?.toString() ?? '';
}

export async function shadowCli(): Promise<void> {
  const flowName = process.argv[2];
  const agentCmd = flag('--agent');
  if (!flowName || flowName.startsWith('--') || !agentCmd) {
    console.error(
      "usage: flowmcp shadow <flow> --flows <dir> --agent '<cmd>' [--judge '<cmd>']\n" +
        '         [--task "<text>"] [--input k=v] [--timeout-ms N]\n' +
        'agent cmd: reads {task, inputs} JSON on stdin, prints its answer to stdout.\n' +
        'judge cmd: reads {task, flowOutput, agentOutput} on stdin, prints {"ok":bool,"note":"..."}.\n' +
        'Without --judge nothing is recorded — no judgment, no verdict.',
    );
    process.exit(1);
  }
  const dir = resolve(flag('--flows') ?? process.env.FLOWMCP_FLOWS_DIR ?? 'flows');
  const judgeCmd = flag('--judge');
  const timeoutMs = Number(flag('--timeout-ms') ?? 300_000);
  const inputs: Record<string, string> = {};
  for (const kv of flags('--input')) {
    const [k, v] = kv.split('=', 2);
    inputs[k!] = v ?? '';
  }

  const flows = await loadFlows(dir);
  const servers = await loadServers(dir);
  checkServerRefs(flows, new Set(Object.keys(servers)));
  const flow = flows.find((f) => f.name === flowName);
  if (!flow) throw new Error(`no flow named '${flowName}' in ${dir}`);
  if (!flowEffects(flow, servers).readOnly) {
    throw new Error(`'${flowName}' is write-capable — shadowing would perform its writes a second time; refused`);
  }

  // Task text: explicit flag → provenance intent (authored flows) → description.
  let task = flag('--task');
  if (!task) {
    try {
      const prov = JSON.parse(readFileSync(join(dir, `${flowName}.provenance.json`), 'utf8')) as { intent?: string };
      task = prov.intent;
    } catch { /* no provenance file — fall through */ }
  }
  task ??= flow.description.replace(/^WHEN TO USE:\s*/i, '');

  console.error(`[shadow] running flow '${flowName}' ...`);
  const pool = new McpPool(servers, { baseDir: dir });
  let flowOutput: string;
  try {
    const run = await executeFlow(flow, inputs, { mcp: pool });
    if (run.status !== 'complete') throw new Error('flow paused unexpectedly');
    flowOutput = run.text;
  } finally {
    await pool.closeAll();
  }
  console.error(`[shadow] flow produced ${flowOutput.length} chars; running host agent ...`);

  const agentOutput = runCommand(agentCmd, { task, inputs }, timeoutMs, 'agent').trim();
  console.error(`[shadow] agent produced ${agentOutput.length} chars`);

  if (!judgeCmd) {
    console.log(JSON.stringify({ task, flowOutput, agentOutput }, null, 2));
    console.error('[shadow] no --judge given: printed both outputs for human comparison; nothing recorded');
    return;
  }

  const verdictRaw = runCommand(judgeCmd, { task, flowOutput, agentOutput }, timeoutMs, 'judge').trim();
  let verdict: { ok: boolean; note?: string };
  try {
    const parsed = JSON.parse(verdictRaw) as { ok?: unknown; note?: unknown };
    if (typeof parsed.ok !== 'boolean') throw new Error('missing boolean "ok"');
    verdict = { ok: parsed.ok, note: typeof parsed.note === 'string' ? parsed.note : undefined };
  } catch (e) {
    throw new Error(`judge output is not {"ok":bool,...}: ${e instanceof Error ? e.message : e} — got: ${verdictRaw.slice(0, 200)}`);
  }

  const registry = await loadRegistry(dir);
  if (registry) {
    await appendLog(dir, {
      ts: new Date().toISOString(),
      flow: flowName,
      kind: 'shadow',
      ok: verdict.ok,
      ...(verdict.note ? { note: verdict.note } : {}),
    });
    console.error(`[shadow] verdict recorded to registry-log.jsonl`);
  } else {
    console.error(`[shadow] no registry.json5 in ${dir} — verdict NOT recorded (add a registry to track health)`);
  }
  console.log(JSON.stringify({ flow: flowName, ok: verdict.ok, note: verdict.note ?? null }));
  if (!verdict.ok) process.exitCode = 3; // diverged — distinct from usage (1) and refusal (2)
}

if (process.argv[1]?.endsWith('shadow.ts') || process.argv[1]?.endsWith('shadow.js')) {
  shadowCli().catch((e) => { console.error(`SHADOW FAILED: ${e instanceof Error ? e.message : e}`); process.exit(1); });
}
