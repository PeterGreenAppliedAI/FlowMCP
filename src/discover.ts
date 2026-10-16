// `flowmcp discover` — point at an endpoint, get a governed servers.json5 draft.
//
//   flowmcp discover <url | spec-file> [--name <server>] [--header 'K: V' ...]
//     [--type mcp|openapi|graphql] [--json]
//   flowmcp discover --stdio <command> [args...] [--name <server>] [--json]
//
// Detection probes only with operations that cannot write: GETs for an
// OpenAPI/Swagger spec (the URL itself, then well-known paths), an MCP
// `initialize` handshake, and a GraphQL `{ __typename }` query. The detected
// endpoint is then connected through the SAME DownstreamClient the runtime
// uses, so the catalog shows exactly what flows would see.
//
// The draft is FAIL-CLOSED: attestReadOnly and allow are empty. Reads the
// endpoint itself declares (readOnlyHint / safe HTTP method / GraphQL Query)
// are callable; every other tool is listed in a comment as refused until a
// human attests or allow-lists it. Discovery proposes; review decides.

import { resolve } from 'node:path';
import { createDownstreamClient, type DownstreamTool } from './downstream.js';
import { interpolate } from './interpolate.js';
import { fetchWithCredentialScope, parseSpecText } from './openapi.js';

export type Transport = 'mcp' | 'stdio' | 'openapi' | 'graphql';

export interface CatalogEntry { name: string; access: 'read' | 'write'; description: string }

export interface Discovery {
  transport: Transport;
  /** The servers.json5 entry, exactly as it would be written (templates intact). */
  entry: Record<string, unknown>;
  tools: CatalogEntry[];
  /** Probe log: what was tried, in order. */
  probes: string[];
}

export interface DiscoverOptions {
  headers?: Record<string, string>;
  type?: 'mcp' | 'openapi' | 'graphql';
  stdio?: { command: string; args: string[] };
  timeoutMs?: number;
}

const SPEC_PATHS = [
  'openapi.json', 'openapi.yaml', 'swagger.json', 'swagger.yaml', 'v3/api-docs',
  'api-docs', 'swagger/v1/swagger.json', '.well-known/openapi.json', 'docs/openapi.json',
];

export async function discover(target: string, opts: DiscoverOptions = {}): Promise<Discovery> {
  const headers = opts.headers ?? {};
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const probes: string[] = [];
  const live = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, interpolate(v, { env: process.env })]));

  if (opts.stdio) {
    const entry = { command: opts.stdio.command, args: opts.stdio.args };
    probes.push(`stdio: ${opts.stdio.command} ${opts.stdio.args.join(' ')}`);
    const tools = await catalog({ transport: 'stdio', ...entry, env: {}, inheritEnv: false, shell: false }, timeoutMs);
    return { transport: 'stdio', entry, tools, probes };
  }

  const isUrl = /^https?:\/\//i.test(target);
  if (!isUrl) {
    // a local spec file
    const path = resolve(target);
    probes.push(`file: ${path}`);
    const entry = { openapi: path, ...(Object.keys(headers).length ? { headers } : {}) };
    return { transport: 'openapi', entry, tools: await catalog({ transport: 'openapi', openapi: path, headers, query: {} }, timeoutMs), probes };
  }

  const url = new URL(target);
  const tryOpenapi = async (): Promise<Discovery | undefined> => {
    const candidates = [url.href];
    const bases = new Set([new URL('/', url).href]);
    if (url.pathname !== '/') bases.add(url.href.replace(/\/?$/, '/'));
    for (const b of bases) for (const p of SPEC_PATHS) candidates.push(new URL(p, b).href);
    for (const c of [...new Set(candidates)]) {
      probes.push(`GET ${c}`);
      // credentials only ever reach the origin the operator pointed us at —
      // on the probe itself AND on every redirect hop
      const spec = await fetchSpec(c, live, url.origin, timeoutMs);
      if (!spec) continue;
      const entry: Record<string, unknown> = { openapi: c, ...(Object.keys(headers).length ? { headers } : {}) };
      // A spec with no servers[] (or a relative one) still needs an API base;
      // default to the probed URL's origin and say so in the draft.
      const servers = spec.servers as Array<{ url?: string }> | undefined;
      const hasBase = typeof spec.host === 'string' || typeof spec.basePath === 'string' || Boolean(servers?.[0]?.url);
      if (!hasBase) entry.baseUrl = url.origin;
      const tools = await catalog({ transport: 'openapi', openapi: c, baseUrl: entry.baseUrl as string | undefined, headers, query: {} }, timeoutMs);
      return { transport: 'openapi', entry, tools, probes };
    }
    return undefined;
  };
  const tryMcp = async (): Promise<Discovery | undefined> => {
    probes.push(`MCP initialize ${url.href}`);
    try {
      const tools = await catalog({ transport: 'http', url: url.href, headers }, timeoutMs);
      return { transport: 'mcp', entry: { url: url.href, ...(Object.keys(headers).length ? { headers } : {}) }, tools, probes };
    } catch {
      return undefined;
    }
  };
  const tryGraphql = async (): Promise<Discovery | undefined> => {
    const candidates = [url.href];
    if (!/graphql\/?$/i.test(url.pathname)) candidates.push(new URL('graphql', url.href.replace(/\/?$/, '/')).href);
    for (const c of candidates) {
      probes.push(`GraphQL { __typename } ${c}`);
      if (!(await isGraphql(c, live, timeoutMs))) continue;
      const entry = { graphql: c, ...(Object.keys(headers).length ? { headers } : {}) };
      return { transport: 'graphql', entry, tools: await catalog({ transport: 'graphql', graphql: c, headers }, timeoutMs), probes };
    }
    return undefined;
  };

  const order = opts.type === 'openapi' ? [tryOpenapi]
    : opts.type === 'mcp' ? [tryMcp]
    : opts.type === 'graphql' ? [tryGraphql]
    : [tryOpenapi, tryMcp, tryGraphql];
  for (const attempt of order) {
    const found = await attempt();
    if (found) return found;
  }
  throw new Error(`no MCP server, OpenAPI/Swagger spec, or GraphQL endpoint found at ${target}\n  tried:\n    ${probes.join('\n    ')}`);
}

async function fetchSpec(url: string, headers: Record<string, string>, origin: string, timeoutMs: number): Promise<Record<string, unknown> | undefined> {
  try {
    const res = await fetchWithCredentialScope(url, headers, origin, Date.now() + timeoutMs);
    if (!res.ok) return undefined;
    const spec = parseSpecText(await res.text());
    return typeof spec.openapi === 'string' || typeof spec.swagger === 'string' ? spec : undefined;
  } catch {
    return undefined;
  }
}

async function isGraphql(url: string, headers: Record<string, string>, timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: JSON.stringify({ query: '{ __typename }' }),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json()) as { data?: { __typename?: unknown } };
    return typeof body.data?.__typename === 'string';
  } catch {
    return false;
  }
}

async function catalog(config: Parameters<typeof createDownstreamClient>[1], timeoutMs: number): Promise<CatalogEntry[]> {
  const client = createDownstreamClient('discover', config);
  const deadline = Date.now() + timeoutMs;
  try {
    await client.connect(deadline);
    const tools = await client.listTools(deadline);
    return tools.map(toEntry);
  } finally {
    await Promise.resolve(client.close()).catch(() => {});
  }
}

function toEntry(t: DownstreamTool): CatalogEntry {
  return {
    name: t.name,
    access: t.annotations?.readOnlyHint === true ? 'read' : 'write',
    description: (t.description ?? '').replace(/\s+/g, ' ').trim(),
  };
}

const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** Render the reviewed-nothing draft as commented JSON5. */
export function renderDraft(name: string, d: Discovery): string {
  const reads = d.tools.filter((t) => t.access === 'read');
  const writes = d.tools.filter((t) => t.access === 'write');
  const lines: string[] = [];
  lines.push(`// ${name}: discovered ${d.transport === 'stdio' ? 'stdio MCP server' : d.transport === 'mcp' ? 'MCP server' : d.transport === 'openapi' ? 'OpenAPI API' : 'GraphQL endpoint'} — ${d.tools.length} tools (${reads.length} declared reads, ${writes.length} other)`);
  lines.push(`// Fail-closed draft: only declared reads are callable. Review before widening:`);
  lines.push(`//   attestReadOnly — tools you have verified only read (security assertion)`);
  lines.push(`//   allow          — writes flows may perform (two-phase confirmation gated)`);
  lines.push(`${name}: {`);
  for (const [k, v] of Object.entries(d.entry)) {
    if (typeof v === 'string') lines.push(`  ${k}: ${q(v)},`);
    else if (Array.isArray(v)) lines.push(`  ${k}: [${v.map((x) => q(String(x))).join(', ')}],`);
    else if (v && typeof v === 'object') {
      lines.push(`  ${k}: { ${Object.entries(v).map(([hk, hv]) => `${q(hk)}: ${q(String(hv))}`).join(', ')} },`);
    }
  }
  if (d.entry.baseUrl !== undefined) lines.push(`  // baseUrl defaulted to the probed origin: the spec declares no servers[]`);
  lines.push(`  attestReadOnly: [],`);
  lines.push(`  allow: [],`);
  const wrap = (label: string, items: CatalogEntry[]) => {
    if (!items.length) return;
    lines.push(`  // ${label}:`);
    let line = '  //  ';
    for (const t of items.map((x) => x.name)) {
      if (line.length + t.length > 96) { lines.push(line.trimEnd()); line = '  //  '; }
      line += ` ${t}`;
    }
    lines.push(line.trimEnd());
  };
  wrap('declared reads (callable now)', reads);
  wrap('refused until attested or allow-listed', writes);
  lines.push(`},`);
  return lines.join('\n') + '\n';
}

function flagValues(argv: string[], name: string): string[] {
  const out: string[] = [];
  argv.forEach((a, i) => { if (a === name && argv[i + 1] !== undefined) out.push(argv[i + 1]!); });
  return out;
}

export async function discoverCli(): Promise<void> {
  const argv = process.argv.slice(2);
  const stdioAt = argv.indexOf('--stdio');
  const own = stdioAt === -1 ? argv : argv.slice(0, stdioAt);
  const stdioCmd = stdioAt === -1 ? undefined : argv.slice(stdioAt + 1);
  const valued = new Set(['--name', '--header', '--type']);
  const positional = own.filter((a, i) => !a.startsWith('--') && !valued.has(own[i - 1] ?? ''));
  const target = positional[0];
  if ((!target && !stdioCmd?.length) || own.includes('--help')) {
    process.stderr.write(
      'usage: flowmcp discover <url | spec-file> [--name <server>] [--header "K: V" ...] [--type mcp|openapi|graphql] [--json]\n' +
        '       flowmcp discover [--name <server>] [--json] --stdio <command> [args...]\n' +
        'Header values should reference secrets as {{env.NAME}} — the draft is written with them verbatim.\n',
    );
    process.exit(1);
  }
  const headers: Record<string, string> = {};
  for (const h of flagValues(own, '--header')) {
    const i = h.indexOf(':');
    if (i <= 0) throw new Error(`--header must be 'Name: value', got '${h}'`);
    const value = h.slice(i + 1).trim();
    if (!value.includes('{{env.')) {
      process.stderr.write(`flowmcp: warning: header '${h.slice(0, i)}' holds a literal value — it will appear in the draft; prefer {{env.NAME}}\n`);
    }
    headers[h.slice(0, i).trim()] = value;
  }
  const type = flagValues(own, '--type')[0] as DiscoverOptions['type'];
  if (type && !['mcp', 'openapi', 'graphql'].includes(type)) throw new Error(`--type must be mcp, openapi or graphql`);
  const d = await discover(target ?? '', {
    headers,
    type,
    stdio: stdioCmd?.length ? { command: stdioCmd[0]!, args: stdioCmd.slice(1) } : undefined,
  });
  const name = flagValues(own, '--name')[0] ?? defaultName(target, stdioCmd);
  if (own.includes('--json')) {
    process.stdout.write(JSON.stringify({ name, ...d }, null, 2) + '\n');
    return;
  }
  process.stderr.write(`flowmcp: found ${d.transport} at ${d.probes.at(-1)} — ${d.tools.length} tools\n`);
  for (const t of d.tools) {
    process.stderr.write(`  ${t.access === 'read' ? 'R' : 'W'}  ${t.name}${t.description ? `  ${t.description.slice(0, 80)}` : ''}\n`);
  }
  process.stdout.write(renderDraft(name, d));
}

function defaultName(target: string | undefined, stdio: string[] | undefined): string {
  const raw = stdio?.length
    ? (stdio.find((a) => !a.startsWith('-') && a !== stdio[0]) ?? stdio[0]!).split('/').pop()!
    : /^https?:/i.test(target ?? '') ? new URL(target!).hostname.split('.').filter((p) => !['www', 'api'].includes(p))[0] ?? 'api'
    : (target ?? 'api').split('/').pop()!.split('.')[0]!;
  const ident = raw.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^[^a-z]+|_+$/g, '');
  return ident || 'api';
}
