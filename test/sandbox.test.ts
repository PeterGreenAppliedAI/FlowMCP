// Model-generated authoring scripts run isolated (src/sandbox.ts). Regression
// for the 2026-10-16 review finding: the runner used to execute generated
// code with `new Function` in its own process — environment, filesystem,
// network and subprocesses all reachable. Every probe here must fail, and the
// tool bridge must still work.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectRoot } from './helpers.js';
import { runSandboxed } from '../src/sandbox.js';

const echo = async (name: string, args: Record<string, unknown>) => ({ tool: name, got: args });

describe('authoring sandbox', () => {
  it('runs a benign script against the bridge, forwarding console output', async () => {
    const logs: string[] = [];
    const result = await runSandboxed(
      `async function main(tools) {
         const a = await tools.search({ q: 'x', n: 2 });
         console.log('got', a);
         return a.got.q + a.got.n;
       }`,
      ['search'],
      echo,
      { onLog: (l) => logs.push(l) },
    );
    expect(result).toBe('x2');
    expect(logs).toEqual(['got {"tool":"search","got":{"q":"x","n":2}}']);
  });

  it('passes input as a frozen object of the script realm, main(tools, input)', async () => {
    const script = `async function main(tools, input) {
      'use strict';
      let frozen = false; try { input.repo = 'x'; } catch { frozen = true; }
      return [input.repo, frozen, Object.getPrototypeOf(input) === Object.prototype].join(',');
    }`;
    expect(await runSandboxed(script, [], echo, { input: { repo: 'widgets' } })).toBe('widgets,true,true');
    expect(await runSandboxed('async function main(tools, input) { return JSON.stringify(input); }', [], echo)).toBe('{}');
  });

  it('supports the module.exports form', async () => {
    expect(await runSandboxed(`module.exports = async (tools) => 'ok';`, [], echo)).toBe('ok');
  });

  it('blocks every escape route the review and the usual vm escapes use', async () => {
    process.env.FLOWMCP_SANDBOX_CANARY = 'canary-secret-value';
    const marker = join(mkdtempSync(join(tmpdir(), 'flowmcp-sbx-')), 'written.txt');
    const probes = {
      control: `1 + 1`,
      env: `process.env.FLOWMCP_SANDBOX_CANARY`,
      require: `require('fs')`,
      globalProcess: `globalThis.process.env`,
      ctorEscape: `this.constructor.constructor('return process')().env`,
      toolCtorEscape: `tools.search.constructor('return process')()`,
      promiseCtorEscape: `tools.search({}).constructor.constructor('return process')()`,
      eval: `eval('1 + 1')`,
      dynamicImport: `await import('node:fs')`,
      fetch: `typeof fetch === 'function' ? 'present' : undefinedName`,
      webSocket: `typeof WebSocket === 'function' ? 'present' : undefinedName`,
      wasm: `await WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0]))`,
      unknownTool: `await tools.nope()`,
    };
    const script = `async function main(tools) {
      const out = {};
      ${Object.entries(probes).map(([k, expr]) => `
      try { const v = ${expr}; out[${JSON.stringify(k)}] = 'OPEN: ' + String(v).slice(0, 80); }
      catch (e) { out[${JSON.stringify(k)}] = 'blocked'; }`).join('')}
      return JSON.stringify(out);
    }`;
    try {
      const out = JSON.parse(await runSandboxed(script, ['search'], echo)) as Record<string, string>;
      for (const k of Object.keys(probes)) if (k !== 'control') expect(out[k], k).toBe('blocked');
      expect(out.control).toBe('OPEN: 2'); // the harness can see an escape
      expect(JSON.stringify(out)).not.toContain('canary-secret-value');
    } finally {
      delete process.env.FLOWMCP_SANDBOX_CANARY;
    }
    expect(existsSync(marker)).toBe(false);
  });

  it('only forwards tool names the broker granted', async () => {
    const calls: string[] = [];
    await expect(runSandboxed(`async function main(t) { return Object.keys(t).join(','); }`, ['a'], async (n) => calls.push(n))).resolves.toBe('a');
    expect(calls).toEqual([]);
  });

  it('kills a runaway script at the deadline', async () => {
    const t0 = Date.now();
    await expect(runSandboxed(`async function main() { for (;;) {} }`, [], echo, { timeoutMs: 1_500 })).rejects.toThrow(/exceeded 1500ms/);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it('reports load errors and a missing main', async () => {
    await expect(runSandboxed(`this is not js`, [], echo)).rejects.toThrow(/failed to load/);
    await expect(runSandboxed(`const x = 1;`, [], echo)).rejects.toThrow(/did not define async function main/);
  });

  it('author-runner replay executes the generated script through the sandbox', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flowmcp-runner-'));
    writeFileSync(join(dir, 'cassette.json'), JSON.stringify({ 'search|{"q":"x"}': { hits: ['h1'] } }));
    writeFileSync(join(dir, 'script.js'),
      `async function main(tools) { const r = await tools.search({ q: 'x' }); return r.hits[0] + ':' + typeof process; }`);
    const proc = spawnSync(process.execPath,
      ['--import', 'tsx', 'src/author-runner.ts', join(dir, 'script.js'), 'replay', join(dir, 'cassette.json'), '--variant', '0'],
      { cwd: projectRoot, encoding: 'utf8', timeout: 30_000 });
    expect(proc.status, proc.stderr).toBe(0);
    const out = JSON.parse(proc.stdout) as { result: string; trace: Array<{ name: string }> };
    expect(out.result).toBe('h1:undefined');
    expect(out.trace.map((t) => t.name)).toEqual(['search']);
  });
});
