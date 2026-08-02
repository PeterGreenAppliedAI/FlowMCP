import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectRoot } from './helpers.js';

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
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

describe('flowmcp CLI', () => {
  it('help lists every subcommand and exits 0', async () => {
    const res = await runCli(['help']);
    expect(res.code).toBe(0);
    for (const cmd of ['serve', 'validate', 'status', 'explain', 'author', 'compile', 'detect']) {
      expect(res.stdout).toContain(`flowmcp ${cmd}`);
    }
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
