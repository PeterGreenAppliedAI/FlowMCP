// OpenAPI downstream: a plain REST API behind the same DownstreamClient
// interface as an MCP server. Each operation in the spec becomes a tool, so
// the pool's governance — read-only by default, attestation, allow-listed
// writes, attestHash drift pins, author introspection — applies to HTTP APIs
// unchanged. No MCP session exists: connect() loads and indexes the spec.
//
// Read/write is DERIVED from HTTP method semantics (RFC 9110 safe methods),
// the same rule flowEffects already applies to http_request steps: GET/HEAD
// are annotated readOnlyHint; everything else is a write until the operator
// attests it (e.g. a POST /search) or allow-lists it.
//
// Scope (fail-closed): OpenAPI 3.x JSON only; local $refs only; JSON and
// form-urlencoded request bodies only. Anything else refuses loudly.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import JSON5 from 'json5';
import { interpolate } from './interpolate.js';
import type { DownstreamClient, DownstreamTool, McpResult } from './downstream.js';

export interface OpenApiTarget {
  /** Spec location: http(s) URL or a path (relative to cwd). May use {{env.X}}. */
  openapi: string;
  /** Overrides the spec's servers[0].url. May use {{env.X}}. */
  baseUrl?: string;
  /** Sent on every request (auth). Values may use {{env.X}}. */
  headers: Record<string, string>;
  /** Added to every request's query string (API-key-in-query auth). */
  query: Record<string, string>;
  cwd?: string;
}

const METHODS = ['get', 'head', 'options', 'post', 'put', 'patch', 'delete'] as const;
const SAFE = new Set(['get', 'head', 'options']);
// OpenAPI: header parameters with these names are ignored (owned by the spec).
const IGNORED_HEADERS = new Set(['accept', 'content-type', 'authorization']);
const MAX_SPEC_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 3;

type Json = Record<string, unknown>;

interface ParamPlan { name: string; key: string; in: 'path' | 'query' | 'header'; required: boolean }

interface Operation {
  tool: DownstreamTool;
  method: string;
  path: string;
  params: ParamPlan[];
  bodyKey?: string;
  bodyType?: 'json' | 'form';
  bodyRequired: boolean;
  /** Set when the operation is listed but cannot be called (fail-closed). */
  unsupported?: string;
}

export class OpenApiDownstreamClient implements DownstreamClient {
  onClose?: (reason: string) => void;
  private ops = new Map<string, Operation>();
  private base?: URL;
  private headers: Record<string, string> = {};
  private query: Record<string, string> = {};
  private secrets: string[] = [];

  constructor(private readonly name: string, private readonly target: OpenApiTarget) {}

  private redact(message: string): string {
    let out = message;
    for (const s of this.secrets) out = out.split(s).join('[REDACTED]');
    return out;
  }

  async connect(deadline: number): Promise<void> {
    const env = { env: process.env };
    this.headers = Object.fromEntries(Object.entries(this.target.headers).map(([k, v]) => [k, interpolate(v, env)]));
    this.query = Object.fromEntries(Object.entries(this.target.query).map(([k, v]) => [k, interpolate(v, env)]));
    // whole values plus their inner tokens: a reflected 'Bearer abc' may come
    // back as the bare 'abc'
    this.secrets = [...Object.values(this.headers), ...Object.values(this.query)]
      .flatMap((v) => [v, ...v.split(/\s+/).filter((t) => t.length >= 8)])
      .filter((s) => s.length >= 4);

    const location = interpolate(this.target.openapi, env);
    let spec: Json;
    try {
      spec = await this.loadSpec(location, deadline);
    } catch (e) {
      throw new Error(`server '${this.name}': ${this.redact(e instanceof Error ? e.message : String(e))}`);
    }
    if (typeof spec.swagger === 'string') {
      throw new Error(`server '${this.name}': Swagger ${spec.swagger} specs are not supported — convert to OpenAPI 3.x`);
    }
    if (typeof spec.openapi !== 'string' || !spec.openapi.startsWith('3.')) {
      throw new Error(`server '${this.name}': not an OpenAPI 3.x document (missing or unsupported 'openapi' version)`);
    }

    const baseRaw = this.target.baseUrl !== undefined ? interpolate(this.target.baseUrl, env) : serverUrl(spec);
    if (!baseRaw) {
      throw new Error(`server '${this.name}': spec declares no servers[] — set baseUrl in servers.json5`);
    }
    const specIsUrl = /^https?:\/\//i.test(location);
    let base: URL;
    try {
      base = specIsUrl ? new URL(baseRaw, location) : new URL(baseRaw);
    } catch {
      throw new Error(`server '${this.name}': base URL '${this.redact(baseRaw)}' is not absolute — set baseUrl in servers.json5`);
    }
    if (base.protocol !== 'http:' && base.protocol !== 'https:') {
      throw new Error(`server '${this.name}': base URL must be http(s), got ${base.protocol}`);
    }
    if (base.password) this.secrets.push(base.password);
    this.base = base;
    this.ops = indexOperations(spec);
  }

  private async loadSpec(location: string, deadline: number): Promise<Json> {
    let text: string;
    if (/^https?:\/\//i.test(location)) {
      // Auth headers go to the spec host only when it is the configured API
      // origin — a spec on a public host must never receive the credential.
      let sameOrigin = false;
      try {
        sameOrigin = this.target.baseUrl !== undefined &&
          new URL(interpolate(this.target.baseUrl, { env: process.env })).origin === new URL(location).origin;
      } catch {
        // unparseable baseUrl: connect() reports it
      }
      const res = await fetch(location, {
        headers: sameOrigin ? this.headers : {},
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
      if (!res.ok) throw new Error(`spec fetch failed: HTTP ${res.status} from ${location}`);
      text = await res.text();
    } else {
      text = await readFile(resolve(this.target.cwd ?? process.cwd(), location), 'utf8');
    }
    if (text.length > MAX_SPEC_BYTES) throw new Error(`spec exceeds ${MAX_SPEC_BYTES} bytes`);
    try {
      const parsed = JSON5.parse(text) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Json;
    } catch {
      // fall through
    }
    throw new Error('spec is not a JSON document (YAML specs are not supported yet — convert to JSON)');
  }

  async listTools(): Promise<DownstreamTool[]> {
    if (!this.base) throw new Error(`server '${this.name}': not connected`);
    return [...this.ops.values()].map((o) => o.tool);
  }

  async callTool(name: string, args: Record<string, unknown>, deadline: number): Promise<McpResult> {
    if (!this.base) throw new Error(`server '${this.name}': not connected`);
    const op = this.ops.get(name);
    if (!op) return errorResult(`unknown operation '${name}'`);
    if (op.unsupported) return errorResult(`operation '${name}' cannot be called: ${op.unsupported}`);

    // ---- build the request; invalid arguments are tool errors, not crashes
    let path = op.path;
    const url = new URL(this.base.href.replace(/\/$/, '') + '/');
    const search = new URLSearchParams();
    const headers: Record<string, string> = { accept: 'application/json', ...this.headers };
    for (const p of op.params) {
      const value = args[p.key];
      if (value === undefined || value === null || value === '') {
        if (p.required) return errorResult(`missing required parameter '${p.key}'`);
        continue;
      }
      if (typeof value === 'object' && !Array.isArray(value)) {
        return errorResult(`parameter '${p.key}' must be a scalar or array, got an object`);
      }
      if (p.in === 'path') {
        const s = String(value);
        // '.'/'..' survive encodeURIComponent and would be resolved away by URL
        // normalization — a path parameter must never walk the API's path.
        if (s === '.' || s === '..') return errorResult(`path parameter '${p.key}' may not be '${s}'`);
        path = path.split(`{${p.name}}`).join(encodeURIComponent(s));
      } else if (p.in === 'query') {
        for (const v of Array.isArray(value) ? value : [value]) search.append(p.name, String(v));
      } else {
        headers[p.name] = Array.isArray(value) ? value.join(',') : String(value);
      }
    }
    for (const [k, v] of Object.entries(this.query)) search.set(k, v);
    const target = new URL(url.href + path.replace(/^\//, ''));
    // Operations are confined to the configured base: a spec path cannot
    // escape it (e.g. through '..' segments in the spec itself).
    if (target.origin !== this.base.origin || !target.pathname.startsWith(url.pathname)) {
      return errorResult(`operation '${name}' resolves outside the configured base URL`);
    }
    target.search = search.toString();

    let body: string | undefined;
    if (op.bodyKey) {
      const value = args[op.bodyKey];
      if (value === undefined) {
        if (op.bodyRequired) return errorResult(`missing required parameter '${op.bodyKey}'`);
      } else if (op.bodyType === 'form') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          return errorResult(`'${op.bodyKey}' must be an object for a form-encoded body`);
        }
        body = new URLSearchParams(Object.entries(value).map(([k, v]) => [k, String(v)])).toString();
        headers['content-type'] = 'application/x-www-form-urlencoded';
      } else {
        body = JSON.stringify(value);
        headers['content-type'] = 'application/json';
      }
    }

    // ---- send; redirects followed manually and only within the same origin,
    // because configured auth may be a custom header fetch would forward.
    let res: Response;
    try {
      let current = target;
      let method = op.method.toUpperCase();
      for (let hop = 0; ; hop++) {
        res = await fetch(current, {
          method,
          headers,
          body: method === 'GET' || method === 'HEAD' ? undefined : body,
          redirect: 'manual',
          signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        });
        const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
        if (!location) break;
        const next = new URL(location, current);
        if (next.origin !== this.base.origin) {
          return errorResult(`HTTP ${res.status} redirect to another origin (${next.origin}) not followed`);
        }
        if (hop + 1 >= MAX_REDIRECTS) return errorResult(`too many redirects`);
        if (res.status === 303) { method = 'GET'; body = undefined; }
        current = next;
      }
    } catch (e) {
      throw new Error(`server '${this.name}': ${op.method.toUpperCase()} ${op.path} failed: ${this.redact(e instanceof Error ? e.message : String(e))}`);
    }

    const text = await res.text();
    if (!res.ok) {
      return errorResult(`HTTP ${res.status} ${res.statusText}: ${this.redact(text.slice(0, 500)) || '(empty body)'}`);
    }
    const isJson = /\bjson\b/i.test(res.headers.get('content-type') ?? '');
    if (isJson && text.length) {
      try {
        const data = JSON.parse(text) as unknown;
        // MCP structuredContent must be an object; arrays/scalars stay as
        // JSON text, which the engine parses back.
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          return { content: [{ type: 'text', text }], structuredContent: data };
        }
      } catch {
        // malformed JSON — hand back the text
      }
    }
    return { content: [{ type: 'text', text }] };
  }

  close(): void {
    this.ops.clear();
    this.base = undefined;
  }
}

function errorResult(message: string): McpResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// servers[0].url with server variables replaced by their defaults.
function serverUrl(spec: Json): string | undefined {
  const servers = spec.servers as Array<{ url?: string; variables?: Record<string, { default?: string }> }> | undefined;
  const first = servers?.[0];
  if (!first?.url) return undefined;
  return first.url.replace(/\{([^}]+)\}/g, (m, v: string) => first.variables?.[v]?.default ?? m);
}

// Resolve local JSON pointers (#/components/...). Cycles and external refs
// collapse to an empty schema — a doc gap, never an infinite expansion.
function deref(spec: Json, node: unknown, seen: string[] = []): unknown {
  if (Array.isArray(node)) return node.map((n) => deref(spec, n, seen));
  if (!node || typeof node !== 'object') return node;
  const ref = (node as Json).$ref;
  if (typeof ref === 'string') {
    if (!ref.startsWith('#/') || seen.includes(ref) || seen.length > 32) return {};
    let target: unknown = spec;
    for (const part of ref.slice(2).split('/')) {
      const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
      target = target && typeof target === 'object' ? (target as Json)[key] : undefined;
    }
    return target === undefined ? {} : deref(spec, target, [...seen, ref]);
  }
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, deref(spec, v, seen)]));
}

function toolName(operationId: unknown, method: string, path: string): string {
  if (typeof operationId === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(operationId)) return operationId;
  const raw = typeof operationId === 'string' && operationId ? operationId : `${method}_${path}`;
  return raw.replace(/[{}]/g, '').replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '').slice(0, 128) || method;
}

function indexOperations(spec: Json): Map<string, Operation> {
  const ops = new Map<string, Operation>();
  const paths = (spec.paths ?? {}) as Record<string, Json>;
  for (const [path, rawItem] of Object.entries(paths)) {
    const item = deref(spec, rawItem) as Json;
    const shared = (item.parameters ?? []) as Json[];
    for (const method of METHODS) {
      const opRaw = item[method] as Json | undefined;
      if (!opRaw) continue;
      const op = opRaw;
      let name = toolName(op.operationId, method, path);
      for (let n = 2; ops.has(name); n++) name = `${toolName(op.operationId, method, path)}_${n}`;

      // Operation-level parameters override path-level ones (same name + in).
      const byKey = new Map<string, Json>();
      for (const p of [...shared, ...((op.parameters ?? []) as Json[])]) byKey.set(`${p.in}:${p.name}`, p);

      const properties: Json = {};
      const required: string[] = [];
      const params: ParamPlan[] = [];
      let unsupported: string | undefined;
      for (const p of byKey.values()) {
        const pname = String(p.name);
        if (p.in === 'cookie') {
          if (p.required) unsupported = `required cookie parameter '${pname}' is not supported`;
          continue;
        }
        if (p.in === 'header' && IGNORED_HEADERS.has(pname.toLowerCase())) continue;
        if (p.in !== 'path' && p.in !== 'query' && p.in !== 'header') continue;
        let key = pname;
        if (key in properties) key = `${p.in}_${pname}`;
        const isRequired = p.in === 'path' || p.required === true;
        params.push({ name: pname, key, in: p.in, required: isRequired });
        properties[key] = {
          ...((p.schema as Json | undefined) ?? { type: 'string' }),
          ...(p.description ? { description: p.description } : {}),
        };
        if (isRequired) required.push(key);
      }

      let bodyKey: string | undefined;
      let bodyType: 'json' | 'form' | undefined;
      let bodyRequired = false;
      const requestBody = op.requestBody as Json | undefined;
      if (requestBody) {
        const content = (requestBody.content ?? {}) as Record<string, Json>;
        const types = Object.keys(content);
        const jsonType = types.find((t) => /^application\/(?:[\w.+-]+\+)?json\b/i.test(t));
        const formType = types.find((t) => /^application\/x-www-form-urlencoded\b/i.test(t));
        const chosen = jsonType ?? formType;
        bodyKey = 'body' in properties ? 'request_body' : 'body';
        bodyRequired = requestBody.required === true;
        if (chosen) {
          bodyType = jsonType ? 'json' : 'form';
          properties[bodyKey] = {
            ...((content[chosen]!.schema as Json | undefined) ?? {}),
            description: (requestBody.description as string | undefined) ?? `request body (${chosen})`,
          };
          if (bodyRequired) required.push(bodyKey);
        } else {
          if (bodyRequired) unsupported = `request body type(s) ${types.join(', ') || '(none)'} not supported`;
          bodyKey = undefined;
        }
      }

      const summary = [op.summary, op.description].filter((s) => typeof s === 'string' && s).join(' — ');
      const tool: DownstreamTool = {
        name,
        description: `${method.toUpperCase()} ${path}${summary ? ` — ${summary}` : ''}`.slice(0, 1000),
        inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) },
        // Derived from method semantics; non-safe methods carry no hint, so
        // the pool refuses them unless attested or allow-listed.
        ...(SAFE.has(method) ? { annotations: { readOnlyHint: true } } : {}),
      };
      ops.set(name, { tool, method, path, params, bodyKey, bodyType, bodyRequired, unsupported });
    }
  }
  return ops;
}
