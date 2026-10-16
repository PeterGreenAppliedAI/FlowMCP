// Isolated execution for MODEL-GENERATED authoring scripts.
//
// The script never runs in a process that holds anything worth taking. It
// runs in a separate Node child that is:
//   - started with an EMPTY environment (no tokens, no SEARXNG_URL, nothing),
//   - under the Node permission model with NO grants: no filesystem read or
//     write, no child processes, no worker threads, no addons, no WASI,
//   - started with --disallow-code-generation-from-strings, so the child's
//     own realm cannot eval/new Function,
// and inside that child the script runs in a fresh vm context with string
// and wasm code generation disabled, holding only JS builtins plus `tools`
// and `console`. Only PRIMITIVES cross the bridge (tool name + JSON strings),
// so the script never gets a reference to a host-realm object — the realm
// where fetch/import() exist. The broker (the caller of runSandboxed) keeps
// the downstream connections and decides which tool names are callable.
//
// Stated limit: Node 20/22's permission model has no network control. The
// network is reachable only from the child's host realm, which the script
// cannot reference and in which fetch/WebSocket are also deleted before the
// script loads; an escape from vm + disabled codegen would still need a
// network-capable primitive. For hostile-model threat models, run authoring
// inside an OS-level sandbox (container, no-egress network namespace) too.

import { spawn } from 'node:child_process';

// The child program, run via `node -e` so it needs no filesystem read grant.
const CHILD = String.raw`
import vm from 'node:vm';

// Host-realm reductions BEFORE any untrusted code exists: nothing below is
// reachable from the context, but an escape should find as little as possible.
for (const k of ['fetch', 'WebSocket', 'EventSource', 'Request', 'Response', 'Headers']) delete globalThis[k];
const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const pending = new Map();
let nextId = 0;
let started = false;

// Host-side callables. Each receives and returns primitives only.
const hostCall = (name, argsJson, done) => {
  const id = nextId++;
  pending.set(id, done);
  write({ type: 'call', id, name: String(name), args: String(argsJson) });
};
const hostLog = (line) => write({ type: 'log', line: String(line).slice(0, 4000) });

function start(code, names) {
  const context = vm.createContext({}, { name: 'flowmcp-author', codeGeneration: { strings: false, wasm: false } });
  context.__host = hostCall;
  context.__log = hostLog;
  context.__names = JSON.stringify(names);
  // Bootstrap: capture the host callables in closures and delete the
  // globals, so untrusted code can never name a host-realm function.
  const run = new vm.Script(
    "'use strict';(() => {" +
    "  const host = globalThis.__host, log = globalThis.__log, names = JSON.parse(globalThis.__names);" +
    "  delete globalThis.__host; delete globalThis.__log; delete globalThis.__names;" +
    "  const parse = JSON.parse, stringify = JSON.stringify, P = Promise, E = Error, S = String;" +
    "  const tools = {};" +
    "  for (const n of names) tools[n] = (args) => new P((res, rej) => host(n, stringify(args === undefined ? {} : args)," +
    "    (ok, json) => ok ? res(parse(json)) : rej(new E(json))));" +
    "  globalThis.tools = Object.freeze(tools);" +
    "  const fmt = (...a) => log(a.map((x) => typeof x === 'string' ? x : (() => { try { return stringify(x); } catch { return S(x); } })()).join(' '));" +
    "  globalThis.console = Object.freeze({ log: fmt, info: fmt, warn: fmt, error: fmt, debug: fmt });" +
    "  globalThis.module = { exports: {} }; globalThis.exports = globalThis.module.exports;" +
    "  return (main, finish) => P.resolve().then(() => main(tools)).then(" +
    "    (r) => finish(true, S(r))," +
    "    (e) => finish(false, S(e && typeof e === 'object' && 'message' in e ? e.message : e)));" +
    "})()",
    { filename: 'flowmcp-bootstrap.js' },
  ).runInContext(context);

  let main;
  try {
    main = new vm.Script(
      code + "\n;(typeof main === 'function' ? main : (typeof module === 'object' && module && typeof module.exports === 'function' ? module.exports : null))",
      { filename: 'generated-script.js' },
    ).runInContext(context, { timeout: 5000 });
  } catch (e) {
    write({ type: 'done', ok: false, value: 'script failed to load: ' + String(e && e.message || e) });
    return;
  }
  if (typeof main !== 'function') {
    write({ type: 'done', ok: false, value: 'script did not define async function main(tools)' });
    return;
  }
  run(main, (ok, value) => write({ type: 'done', ok: Boolean(ok), value: String(value) }));
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.type === 'start' && !started) { started = true; start(msg.code, msg.names); }
    else if (msg.type === 'result') {
      const done = pending.get(msg.id);
      pending.delete(msg.id);
      if (done) done(msg.ok, msg.value);
    }
  }
});
`;

export interface SandboxOptions {
  /** Whole-run budget; the child is killed when it elapses. */
  timeoutMs?: number;
  onLog?: (line: string) => void;
}

/** Run untrusted `code` defining `async function main(tools)`. `call` is the
 *  broker's tool bridge — it decides what each name may do. Resolves with the
 *  stringified result; rejects with the script's error. */
export function runSandboxed(
  code: string,
  names: string[],
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  opts: SandboxOptions = {},
): Promise<string> {
  const permission = process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission' : '--experimental-permission';
  // An empty environment; Windows needs SYSTEMROOT for the runtime to start.
  const env: Record<string, string> = {};
  if (process.platform === 'win32' && process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
  const child = spawn(
    process.execPath,
    [permission, '--disallow-code-generation-from-strings', '--no-warnings', '--input-type=module', '-e', CHILD],
    { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  );
  const allowed = new Set(names);

  return new Promise((resolve, reject) => {
    let settled = false;
    let stderr = '';
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`script exceeded ${opts.timeoutMs ?? 60_000}ms`))),
      opts.timeoutMs ?? 60_000,
    );
    const send = (msg: unknown) => {
      if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(msg) + '\n');
    };
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()).length > 8000 && (stderr = stderr.slice(-8000)));
    child.on('error', (e) => finish(() => reject(e)));
    child.on('exit', (code) => finish(() => reject(new Error(`sandbox exited (${code}) before finishing: ${stderr.trim().slice(0, 500)}`))));

    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
      let i;
      while ((i = out.indexOf('\n')) !== -1) {
        const line = out.slice(0, i);
        out = out.slice(i + 1);
        let msg: { type: string; id?: number; name?: string; args?: string; line?: string; ok?: boolean; value?: string };
        try {
          msg = JSON.parse(line) as typeof msg;
        } catch {
          continue; // the protocol is JSON lines; anything else is noise
        }
        if (msg.type === 'log') opts.onLog?.(String(msg.line));
        else if (msg.type === 'done') {
          const value = String(msg.value);
          finish(() => (msg.ok ? resolve(value) : reject(new Error(value))));
        } else if (msg.type === 'call') {
          const id = msg.id;
          const name = String(msg.name);
          if (!allowed.has(name)) {
            send({ type: 'result', id, ok: false, value: `tool '${name}' is not available` });
            continue;
          }
          let args: unknown;
          try {
            args = JSON.parse(String(msg.args));
          } catch {
            send({ type: 'result', id, ok: false, value: 'arguments were not JSON' });
            continue;
          }
          if (!args || typeof args !== 'object' || Array.isArray(args)) {
            send({ type: 'result', id, ok: false, value: 'arguments must be an object' });
            continue;
          }
          call(name, args as Record<string, unknown>).then(
            (r) => send({ type: 'result', id, ok: true, value: JSON.stringify(r ?? null) }),
            (e: unknown) => send({ type: 'result', id, ok: false, value: e instanceof Error ? e.message : String(e) }),
          );
        }
      }
    });
    send({ type: 'start', code, names });
  });
}
