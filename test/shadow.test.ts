import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { projectRoot } from './helpers.js';

// The shadow harness: FlowMCP runs the flow and orchestrates; ALL judgment is
// injected as host-supplied commands. Fake agent/judge commands are node
// one-liners so the tests stay hermetic.

const FLOW = `{
  name: 'shadow_me',
  description: 'WHEN TO USE: produce the standard greeting.',
  input: {},
  steps: [{ id: 't', kind: 'template', template: 'hello from the flow' }],
  output: '{{steps.t}}',
}`;

const WRITE_FLOW = `{
  name: 'shadow_write',
  description: 'WHEN TO USE: never shadow this.',
  input: {},
  steps: [{ id: 'w', kind: 'http_request', method: 'POST', url: 'http://127.0.0.1:1/x' }],
  output: 'done',
}`;

// agent: echoes a fixed independent answer. judge: verdict depends on JUDGE_OK.
const AGENT_CMD = `node -e "process.stdin.resume(); process.stdin.on('data',()=>{}); process.stdin.on('end',()=>console.log('hello from the agent'))"`;
const judgeCmd = (ok: boolean) =>
  `node -e "process.stdin.resume(); let b=''; process.stdin.on('data',c=>b+=c); process.stdin.on('end',()=>{const j=JSON.parse(b); console.log(JSON.stringify({ok:${ok},note:'saw '+j.flowOutput.length+' flow chars'}))})"`;

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function makeDir(withRegistry: boolean): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'flowmcp-shadow-'));
  dirs.push(dir);
  await writeFile(join(dir, 'a.flow.json5'), FLOW);
  await writeFile(join(dir, 'b.flow.json5'), WRITE_FLOW);
  if (withRegistry) {
    await writeFile(join(dir, 'registry.json5'), `{ shadow_me: { state: 'active' }, shadow_write: { state: 'active' } }`);
  }
  return dir;
}

function runShadow(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'shadow', ...args], {
      cwd: projectRoot,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('flowmcp shadow', () => {
  it('records an ok verdict from the injected judge', async () => {
    const dir = await makeDir(true);
    const res = await runShadow(['shadow_me', '--flows', dir, '--agent', AGENT_CMD, '--judge', judgeCmd(true)]);
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout.trim())).toMatchObject({ flow: 'shadow_me', ok: true });
    const log = await readFile(join(dir, 'registry-log.jsonl'), 'utf8');
    const rec = JSON.parse(log.trim().split('\n').pop()!) as Record<string, unknown>;
    expect(rec).toMatchObject({ flow: 'shadow_me', kind: 'shadow', ok: true });
    expect(String(rec.note)).toContain('flow chars');
  });

  it('a diverged verdict records ok:false and exits 3', async () => {
    const dir = await makeDir(true);
    const res = await runShadow(['shadow_me', '--flows', dir, '--agent', AGENT_CMD, '--judge', judgeCmd(false)]);
    expect(res.code).toBe(3);
    const log = await readFile(join(dir, 'registry-log.jsonl'), 'utf8');
    expect(JSON.parse(log.trim())).toMatchObject({ kind: 'shadow', ok: false });
  });

  it('without --judge prints both outputs and records nothing', async () => {
    const dir = await makeDir(true);
    const res = await runShadow(['shadow_me', '--flows', dir, '--agent', AGENT_CMD]);
    expect(res.code).toBe(0);
    const printed = JSON.parse(res.stdout) as { flowOutput: string; agentOutput: string };
    expect(printed.flowOutput).toBe('hello from the flow');
    expect(printed.agentOutput).toBe('hello from the agent');
    expect(res.stderr).toContain('nothing recorded');
    await expect(readFile(join(dir, 'registry-log.jsonl'), 'utf8')).rejects.toThrow();
  });

  it('refuses to shadow a write-capable flow', async () => {
    const dir = await makeDir(true);
    const res = await runShadow(['shadow_write', '--flows', dir, '--agent', AGENT_CMD, '--judge', judgeCmd(true)]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('write-capable');
    expect(res.stderr).toContain('refused');
  });

  it('the agent receives the task derived from the flow description', async () => {
    const dir = await makeDir(false);
    const echoTask = `node -e "let b=''; process.stdin.on('data',c=>b+=c); process.stdin.on('end',()=>console.log(JSON.parse(b).task))"`;
    const res = await runShadow(['shadow_me', '--flows', dir, '--agent', echoTask]);
    expect(res.code).toBe(0);
    const printed = JSON.parse(res.stdout) as { agentOutput: string };
    expect(printed.agentOutput).toBe('produce the standard greeting.');
  });
});
