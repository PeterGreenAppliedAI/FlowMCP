// `flowmcp infer-spec` — an OpenAPI 3 spec inferred from recorded traffic,
// for APIs that publish none.
//
//   flowmcp infer-spec <capture.har> [--origin <https://api.host>] [--out <spec.json>]
//
// Record the API being used (browser devtools "Save all as HAR", mitmproxy,
// Charles, …), infer a spec, then wrap it like any other: `flowmcp discover
// spec.json` → review → servers.json5. The spec is a HYPOTHESIS for human
// review, and its provenance says so (info.x-flowmcp-inferred).
//
// Captures are full of credentials and personal data, so the spec carries
// SHAPE ONLY: no header values, cookies, query values, bodies, or examples
// are ever written. Auth-looking query parameters are dropped from the spec
// and reported, with the auth headers seen, as configuration to supply via
// servers.json5 `headers`/`query` with {{env.X}}.
//
// Heuristics (stated, reviewable): id-like path segments (numeric, UUID, long
// hex, digit-bearing tokens ≥ 6 chars, or anything that is not a plain word ≤
// 32 chars) become path parameters; query
// parameters are optional; a JSON body field is required iff every observed
// request carried it; only JSON (or form) exchanges are kept — static assets,
// HTML, and other origins are skipped and counted.

import { readFileSync, writeFileSync } from 'node:fs';

type Json = Record<string, unknown>;

interface HarEntry {
  request: {
    method: string; url: string;
    headers?: Array<{ name: string; value: string }>;
    postData?: { mimeType?: string; text?: string; params?: Array<{ name: string }> };
  };
  response: { status: number; content?: { mimeType?: string; text?: string; encoding?: string } };
}

export interface InferReport {
  origin: string;
  operations: number;
  used: number;
  skipped: Record<string, number>;
  authHeaders: string[];
  authQueryParams: string[];
  otherOrigins: Record<string, number>;
}

const STATIC = /\.(?:js|mjs|css|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|html?|txt|mp4|webm)$/i;
const AUTH_HEADERS = /^(?:authorization|proxy-authorization|cookie|x-api-key|api-key|x-auth-token|x-access-token|x-csrf-token|x-xsrf-token)$/i;
const AUTH_QUERY = /^(?:api[_-]?key|apikey|key|token|access[_-]?token|auth|sig|signature|secret|client[_-]?secret|password|session)$/i;
const MAX_SCHEMA_DEPTH = 5;

// Also: anything that is not a plain word (emails, dotted names, encoded
// text, long tokens) — a literal path segment is written into the spec, so a
// username or email in a path must never survive as one.
const isIdLike = (seg: string): boolean =>
  !/^[A-Za-z0-9_-]{1,32}$/.test(seg) ||
  /^\d+$/.test(seg) ||
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) ||
  /^[0-9a-f]{12,}$/i.test(seg) ||
  (seg.length >= 6 && /\d/.test(seg) && /^[A-Za-z0-9_-]+$/.test(seg) && !/^v\d+$/i.test(seg));

const singular = (w: string) => (w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const camel = (s: string) => s.replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ''));

function templatePath(pathname: string): { template: string; params: string[] } {
  const segs = pathname.split('/');
  const params: string[] = [];
  const out = segs.map((seg, i) => {
    let decoded = seg;
    try { decoded = decodeURIComponent(seg); } catch { /* malformed escape: judge it raw */ }
    if (!seg || !isIdLike(decoded)) return seg;
    const prev = segs.slice(0, i).reverse().find((s) => s && !isIdLike(s));
    let name = prev ? `${camel(singular(prev))}Id` : 'id';
    name = name.charAt(0).toLowerCase() + name.slice(1);
    while (params.includes(name)) name = `${name}2`;
    params.push(name);
    return `{${name}}`;
  });
  return { template: out.join('/') || '/', params };
}

// ---- schema inference: types only, merged across samples, never values
function inferSchema(value: unknown, depth = 0): Json {
  if (value === null) return { nullable: true };
  if (Array.isArray(value)) {
    const items = value.slice(0, 20).map((v) => inferSchema(v, depth + 1));
    return { type: 'array', items: items.length ? items.reduce((a, b) => mergeSchema(a, b, false)) : {} };
  }
  switch (typeof value) {
    case 'string': return { type: 'string' };
    case 'number': return { type: Number.isInteger(value) ? 'integer' : 'number' };
    case 'boolean': return { type: 'boolean' };
    case 'object': {
      if (depth >= MAX_SCHEMA_DEPTH) return { type: 'object' };
      const properties: Json = {};
      for (const [k, v] of Object.entries(value as Json)) properties[k] = inferSchema(v, depth + 1);
      return { type: 'object', properties, required: Object.keys(properties) };
    }
  }
  return {};
}

function mergeSchema(a: Json, b: Json, trackRequired = true): Json {
  if (!a.type) return { ...b, ...(a.nullable ? { nullable: true } : {}) };
  if (!b.type) return { ...a, ...(b.nullable ? { nullable: true } : {}) };
  if (a.type !== b.type) {
    const nums = new Set(['integer', 'number']);
    if (nums.has(a.type as string) && nums.has(b.type as string)) return { type: 'number' };
    return {}; // conflicting shapes: any
  }
  if (a.type === 'array') return { type: 'array', items: mergeSchema((a.items ?? {}) as Json, (b.items ?? {}) as Json, false) };
  if (a.type === 'object') {
    const pa = (a.properties ?? {}) as Json;
    const pb = (b.properties ?? {}) as Json;
    const properties: Json = {};
    for (const k of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
      properties[k] = k in pa && k in pb ? mergeSchema(pa[k] as Json, pb[k] as Json, trackRequired) : ((pa[k] ?? pb[k]) as Json);
    }
    const ra = new Set((a.required as string[] | undefined) ?? []);
    const required = trackRequired ? ((b.required as string[] | undefined) ?? []).filter((k) => ra.has(k)) : [];
    return { type: 'object', properties, ...(required.length ? { required } : {}) };
  }
  return a;
}

const scalarType = (values: string[]): Json =>
  values.every((v) => /^-?\d+$/.test(v)) ? { type: 'integer' }
    : values.every((v) => /^-?\d+(?:\.\d+)?$/.test(v)) ? { type: 'number' }
    : values.every((v) => v === 'true' || v === 'false') ? { type: 'boolean' }
    : { type: 'string' };

function parseJson(text: string | undefined, encoding?: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(encoding === 'base64' ? Buffer.from(text, 'base64').toString('utf8') : text);
  } catch {
    return undefined;
  }
}

interface OpAcc {
  method: string; template: string; params: string[]; count: number;
  query: Map<string, string[]>;
  body?: Json; bodyType?: 'json' | 'form';
  response?: Json; statuses: Set<number>;
}

export function inferSpec(har: unknown, opts: { origin?: string; source?: string } = {}): { spec: Json; report: InferReport } {
  const entries = ((har as { log?: { entries?: HarEntry[] } })?.log?.entries ?? []) as HarEntry[];
  if (!entries.length) throw new Error('not a HAR capture (no log.entries)');

  const byOrigin = new Map<string, number>();
  for (const e of entries) {
    try { const o = new URL(e.request.url).origin; byOrigin.set(o, (byOrigin.get(o) ?? 0) + 1); } catch { /* skip */ }
  }
  const origin = opts.origin ? new URL(opts.origin).origin : [...byOrigin.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!origin) throw new Error('no requests with absolute URLs in the capture');

  const skipped: Record<string, number> = {};
  const skip = (why: string) => (skipped[why] = (skipped[why] ?? 0) + 1);
  const authHeaders = new Set<string>();
  const authQuery = new Set<string>();
  const ops = new Map<string, OpAcc>();
  let used = 0;

  for (const e of entries) {
    let url: URL;
    try { url = new URL(e.request.url); } catch { skip('unparseable URL'); continue; }
    if (url.origin !== origin) continue;
    const method = e.request.method.toLowerCase();
    if (!['get', 'head', 'post', 'put', 'patch', 'delete'].includes(method)) { skip(`method ${method.toUpperCase()}`); continue; }
    if (STATIC.test(url.pathname)) { skip('static asset'); continue; }
    const resType = e.response.content?.mimeType ?? '';
    const reqType = e.request.postData?.mimeType ?? '';
    const jsonRes = /\bjson\b/i.test(resType);
    const jsonReq = /\bjson\b/i.test(reqType);
    const formReq = /x-www-form-urlencoded/i.test(reqType);
    if (!jsonRes && !jsonReq && !formReq && !(e.response.status === 204 && method !== 'get')) { skip('non-JSON exchange'); continue; }
    used++;

    for (const h of e.request.headers ?? []) if (AUTH_HEADERS.test(h.name)) authHeaders.add(h.name.toLowerCase());
    const { template, params } = templatePath(url.pathname);
    const key = `${method} ${template}`;
    const op: OpAcc = ops.get(key) ?? { method, template, params, count: 0, query: new Map(), statuses: new Set<number>() };
    op.count++;
    op.statuses.add(e.response.status);
    for (const [k, v] of url.searchParams) {
      if (AUTH_QUERY.test(k)) { authQuery.add(k); continue; }
      op.query.set(k, [...(op.query.get(k) ?? []), v]);
    }
    if (jsonReq) {
      const body = parseJson(e.request.postData?.text);
      if (body !== undefined) {
        const s = inferSchema(body);
        op.body = op.body ? mergeSchema(op.body, s) : s;
        op.bodyType = 'json';
      }
    } else if (formReq) {
      const names = e.request.postData?.params?.map((p) => p.name)
        ?? [...new URLSearchParams(e.request.postData?.text ?? '').keys()];
      const props = Object.fromEntries(names.filter((n) => !AUTH_QUERY.test(n)).map((n) => [n, { type: 'string' }]));
      const s = { type: 'object', properties: props, required: Object.keys(props) };
      op.body = op.body ? mergeSchema(op.body, s) : s;
      op.bodyType = 'form';
    }
    if (jsonRes && e.response.status >= 200 && e.response.status < 300) {
      const data = parseJson(e.response.content?.text, e.response.content?.encoding);
      if (data !== undefined) {
        // responses document shape only; required-ness is meaningless here
        const s = inferSchema(data);
        op.response = op.response ? mergeSchema(op.response, s, false) : stripRequired(s);
      }
    }
    ops.set(key, op);
  }
  const otherOrigins = Object.fromEntries([...byOrigin].filter(([o]) => o !== origin));
  if (!ops.size) throw new Error(`no JSON API traffic to ${origin} in the capture (skipped: ${JSON.stringify(skipped)})`);

  const paths: Json = {};
  const usedIds = new Set<string>();
  for (const op of [...ops.values()].sort((a, b) => a.template.localeCompare(b.template))) {
    const words = op.template.split('/').filter((s) => s && !s.startsWith('{')).map((w) => w.replace(/[^A-Za-z0-9]+/g, '_'));
    const lastIsParam = /\}$/.test(op.template);
    let id = `${op.method}_${words.join('_') || 'root'}${lastIsParam ? `_by_${op.params.at(-1)}` : ''}`.replace(/_+/g, '_');
    for (let n = 2; usedIds.has(id); n++) id = `${id}_${n}`;
    usedIds.add(id);
    const parameters = [
      ...op.params.map((p) => ({ name: p, in: 'path', required: true, schema: { type: 'string' } })),
      ...[...op.query].map(([name, values]) => ({ name, in: 'query', required: false, schema: scalarType(values) })),
    ];
    const ok = [...op.statuses].find((s) => s >= 200 && s < 300) ?? 200;
    const operation: Json = {
      operationId: id,
      summary: `Inferred from ${op.count} observed request${op.count === 1 ? '' : 's'}`,
      ...(parameters.length ? { parameters } : {}),
      ...(op.body
        ? { requestBody: { required: true, content: { [op.bodyType === 'form' ? 'application/x-www-form-urlencoded' : 'application/json']: { schema: op.body } } } }
        : {}),
      responses: {
        [String(ok)]: {
          description: 'observed',
          ...(op.response ? { content: { 'application/json': { schema: op.response } } } : {}),
        },
      },
    };
    paths[op.template] = { ...((paths[op.template] as Json | undefined) ?? {}), [op.method]: operation };
  }

  const report: InferReport = {
    origin,
    operations: ops.size,
    used,
    skipped,
    authHeaders: [...authHeaders].sort(),
    authQueryParams: [...authQuery].sort(),
    otherOrigins,
  };
  const spec: Json = {
    openapi: '3.0.3',
    info: {
      title: `Inferred API for ${origin}`,
      version: '0.0.0-inferred',
      'x-flowmcp-inferred': {
        source: opts.source ?? 'har',
        requests: used,
        note: 'Shape inferred from recorded traffic — a hypothesis for review, not the API contract. No observed values are included.',
      },
    },
    servers: [{ url: origin }],
    paths,
  };
  return { spec, report };
}

function stripRequired(s: Json): Json {
  const out: Json = { ...s };
  delete out.required;
  if (out.properties) out.properties = Object.fromEntries(Object.entries(out.properties as Json).map(([k, v]) => [k, stripRequired(v as Json)]));
  if (out.items) out.items = stripRequired(out.items as Json);
  return out;
}

export function inferSpecCli(): void {
  const argv = process.argv.slice(2);
  const value = (n: string) => { const i = argv.indexOf(n); return i === -1 ? undefined : argv[i + 1]; };
  const file = argv.find((a, i) => !a.startsWith('--') && !['--origin', '--out'].includes(argv[i - 1] ?? ''));
  if (!file) {
    process.stderr.write('usage: flowmcp infer-spec <capture.har> [--origin <https://api.host>] [--out <spec.json>]\n');
    process.exit(1);
  }
  const { spec, report } = inferSpec(JSON.parse(readFileSync(file, 'utf8')), { origin: value('--origin'), source: file });
  const text = JSON.stringify(spec, null, 2) + '\n';
  const out = value('--out');
  if (out) writeFileSync(out, text);
  else process.stdout.write(text);
  const log = (s: string) => process.stderr.write(`flowmcp: ${s}\n`);
  log(`inferred ${report.operations} operations for ${report.origin} from ${report.used} requests${out ? ` → ${out}` : ''}`);
  const skippedList = Object.entries(report.skipped).map(([k, n]) => `${n} ${k}`).join(', ');
  if (skippedList) log(`skipped: ${skippedList}`);
  const others = Object.entries(report.otherOrigins).map(([o, n]) => `${o} (${n})`).join(', ');
  if (others) log(`other origins ignored (use --origin to pick one): ${others}`);
  if (report.authHeaders.length) log(`requests carried auth headers: ${report.authHeaders.join(', ')} — configure them in servers.json5 'headers' with {{env.X}}`);
  if (report.authQueryParams.length) log(`auth-like query params dropped from the spec: ${report.authQueryParams.join(', ')} — configure them in servers.json5 'query' with {{env.X}}`);
  log(`next: flowmcp discover ${out ?? '<spec.json>'} --name <server>  (review the inferred spec first)`);
}
