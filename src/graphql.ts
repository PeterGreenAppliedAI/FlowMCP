// GraphQL downstream: a GraphQL endpoint behind the DownstreamClient
// interface. connect() runs schema introspection; every root Query field
// becomes a read tool (readOnlyHint) and every root Mutation field a write
// tool (no hint — refused unless attested or allow-listed), so the pool's
// governance applies unchanged. Subscriptions are not exposed.
//
// The operation document is GENERATED, never accepted from the caller: tool
// arguments become typed variables, and the selection set is derived from the
// schema (scalars plus nested objects to a bounded depth, skipping fields
// that need arguments). An optional `select` argument narrows/extends the
// selection, restricted to bare field names and braces — no arguments,
// aliases, fragments or directives can be smuggled in through it.

import { interpolate } from './interpolate.js';
import type { DownstreamClient, DownstreamTool, McpResult } from './downstream.js';

export interface GraphqlTarget {
  /** Endpoint URL. May use {{env.X}}. */
  graphql: string;
  /** Sent on every request (auth). Values may use {{env.X}}. */
  headers: Record<string, string>;
}

type Json = Record<string, unknown>;

interface TypeRef { kind: string; name?: string | null; ofType?: TypeRef | null }
interface InputValue { name: string; description?: string | null; type: TypeRef; defaultValue?: string | null }
interface Field { name: string; description?: string | null; args: InputValue[]; type: TypeRef; isDeprecated?: boolean }
interface FullType {
  kind: string; name: string; description?: string | null;
  fields?: Field[] | null; inputFields?: InputValue[] | null; enumValues?: Array<{ name: string }> | null;
}

interface Operation { tool: DownstreamTool; kind: 'query' | 'mutation'; field: Field; selection: string; returnsComposite: boolean }

const TYPE_REF = 'kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } }';
export const INTROSPECTION_QUERY = `query FlowMcpIntrospection {
  __schema {
    queryType { name } mutationType { name }
    types {
      kind name description
      fields(includeDeprecated: false) { name description isDeprecated args { name description defaultValue type { ${TYPE_REF} } } type { ${TYPE_REF} } }
      inputFields { name description defaultValue type { ${TYPE_REF} } }
      enumValues(includeDeprecated: false) { name }
    }
  }
}`;

const SELECTION_DEPTH = 2;
const MAX_SELECTION_FIELDS = 60;
const SELECT_ALLOWED = /^[A-Za-z0-9_\s{},]*$/;
const MAX_SELECT_DEPTH = 6;

interface SelNode { name: string; children?: SelNode[] }

// Parse a caller-supplied selection into a tree: EXACTLY one selection set
// (outer braces optional), fields with optional nested sets, nothing else.
// The query text is then PRINTED from the tree — the caller's characters
// never reach the document, so a trailing sibling (`{ id } otherMutation`)
// cannot become a second root field.
export function parseSelection(src: string): SelNode[] | { error: string } {
  if (!SELECT_ALLOWED.test(src)) return { error: 'only field names, braces and commas are allowed' };
  const tokens = src.match(/[A-Za-z_][A-Za-z0-9_]*|[{}]|\S/g) ?? [];
  if (tokens.some((t) => !/^[A-Za-z_][A-Za-z0-9_]*$|^[{}]$/.test(t) && t !== ',')) return { error: 'unexpected token' };
  const toks = tokens.filter((t) => t !== ',');
  let i = 0;
  const set = (depth: number): SelNode[] | { error: string } => {
    if (depth > MAX_SELECT_DEPTH) return { error: `nested deeper than ${MAX_SELECT_DEPTH}` };
    if (toks[i] !== '{') return { error: "expected '{'" };
    i++;
    const nodes: SelNode[] = [];
    while (i < toks.length && toks[i] !== '}') {
      const name = toks[i]!;
      if (name === '{') return { error: "a selection set must follow a field name" };
      i++;
      const node: SelNode = { name };
      if (toks[i] === '{') {
        const children = set(depth + 1);
        if (!Array.isArray(children)) return children;
        node.children = children;
      }
      nodes.push(node);
    }
    if (toks[i] !== '}') return { error: "unbalanced braces: missing '}'" };
    i++;
    if (!nodes.length) return { error: 'empty selection set' };
    return nodes;
  };
  const wrapped = toks[0] === '{' ? toks : ['{', ...toks, '}'];
  toks.splice(0, toks.length, ...wrapped);
  const root = set(1);
  if (!Array.isArray(root)) return root;
  if (i !== toks.length) return { error: 'exactly one selection set is allowed — found content after it' };
  return root;
}

export class GraphqlDownstreamClient implements DownstreamClient {
  onClose?: (reason: string) => void;
  private ops = new Map<string, Operation>();
  private types = new Map<string, FullType>();
  private url?: URL;
  private headers: Record<string, string> = {};
  private secrets: string[] = [];

  constructor(private readonly name: string, private readonly target: GraphqlTarget) {}

  private redact(message: string): string {
    let out = message;
    for (const s of this.secrets) out = out.split(s).join('[REDACTED]');
    return out;
  }

  async connect(deadline: number): Promise<void> {
    const env = { env: process.env };
    this.headers = Object.fromEntries(Object.entries(this.target.headers).map(([k, v]) => [k, interpolate(v, env)]));
    this.secrets = Object.values(this.headers)
      .flatMap((v) => [v, ...v.split(/\s+/).filter((t) => t.length >= 8)])
      .filter((s) => s.length >= 4);
    let url: URL;
    try {
      url = new URL(interpolate(this.target.graphql, env));
    } catch {
      throw new Error(`server '${this.name}': graphql endpoint is not an absolute URL`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`server '${this.name}': graphql endpoint must be http(s), got ${url.protocol}`);
    }
    if (url.password) this.secrets.push(url.password);
    for (const v of url.searchParams.values()) if (v.length >= 4) this.secrets.push(v);
    this.url = url;

    const res = await this.post({ query: INTROSPECTION_QUERY }, deadline);
    if (res.kind === 'error') {
      throw new Error(`server '${this.name}': introspection failed — ${res.message}` +
        (/introspection|__schema/i.test(res.message) ? ' (is introspection disabled on this endpoint?)' : ''));
    }
    const schema = (res.data as { __schema?: Json } | undefined)?.__schema as
      | { queryType?: { name: string } | null; mutationType?: { name: string } | null; types: FullType[] }
      | undefined;
    if (!schema?.types) throw new Error(`server '${this.name}': introspection returned no schema`);
    this.types = new Map(schema.types.map((t) => [t.name, t]));
    this.ops = new Map();
    const roots: Array<['query' | 'mutation', string | undefined]> = [
      ['query', schema.queryType?.name],
      ['mutation', schema.mutationType?.name],
    ];
    for (const [kind, typeName] of roots) {
      const root = typeName ? this.types.get(typeName) : undefined;
      for (const field of root?.fields ?? []) {
        let toolName = field.name;
        if (this.ops.has(toolName)) toolName = `${kind}_${field.name}`;
        this.ops.set(toolName, this.operation(kind, field, toolName));
      }
    }
  }

  private operation(kind: 'query' | 'mutation', field: Field, toolName: string): Operation {
    const properties: Json = {};
    const required: string[] = [];
    for (const a of field.args) {
      properties[a.name] = {
        ...this.jsonSchema(a.type, 0),
        ...(a.description ? { description: a.description } : {}),
        ...(a.defaultValue != null ? { default: safeJson(a.defaultValue) } : {}),
      };
      if (a.type.kind === 'NON_NULL' && a.defaultValue == null) required.push(a.name);
    }
    const leaf = unwrap(field.type);
    const returnsComposite = ['OBJECT', 'INTERFACE', 'UNION'].includes(this.types.get(leaf.name ?? '')?.kind ?? leaf.kind);
    const selection = returnsComposite ? this.selection(leaf.name!, SELECTION_DEPTH, { n: 0 }) : '';
    if (returnsComposite) {
      properties.select = {
        type: 'string',
        description: `GraphQL selection set (field names and braces only). Default: { ${selection.slice(2, 200)}… }`,
      };
    }
    const description = `GraphQL ${kind} ${field.name}${field.description ? ` — ${field.description}` : ''}`.slice(0, 1000);
    return {
      kind, field, selection, returnsComposite,
      tool: {
        name: toolName,
        description,
        inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) },
        ...(kind === 'query' ? { annotations: { readOnlyHint: true } } : {}),
      },
    };
  }

  // Default selection: scalar/enum fields, plus nested objects to a bounded
  // depth; fields needing arguments are skipped. Always non-empty for an
  // object type (falls back to __typename).
  private selection(typeName: string, depth: number, budget: { n: number }): string {
    const type = this.types.get(typeName);
    if (!type?.fields) return '{ __typename }';
    const parts: string[] = [];
    for (const f of type.fields) {
      if (budget.n >= MAX_SELECTION_FIELDS) break;
      if (f.args.some((a) => a.type.kind === 'NON_NULL' && a.defaultValue == null)) continue;
      const leaf = unwrap(f.type);
      const kind = this.types.get(leaf.name ?? '')?.kind ?? leaf.kind;
      if (kind === 'SCALAR' || kind === 'ENUM') {
        parts.push(f.name);
        budget.n++;
      } else if (kind === 'OBJECT' && depth > 1) {
        const inner = this.selection(leaf.name!, depth - 1, budget);
        if (inner !== '{ __typename }') parts.push(`${f.name} ${inner}`);
      }
    }
    return `{ ${parts.length ? parts.join(' ') : '__typename'} }`;
  }

  private jsonSchema(ref: TypeRef, depth: number): Json {
    if (ref.kind === 'NON_NULL') return this.jsonSchema(ref.ofType!, depth);
    if (ref.kind === 'LIST') return { type: 'array', items: this.jsonSchema(ref.ofType!, depth) };
    switch (ref.name) {
      case 'Int': return { type: 'integer' };
      case 'Float': return { type: 'number' };
      case 'Boolean': return { type: 'boolean' };
      case 'String': case 'ID': return { type: 'string' };
    }
    const type = this.types.get(ref.name ?? '');
    if (type?.kind === 'ENUM') return { type: 'string', enum: (type.enumValues ?? []).map((e) => e.name) };
    if (type?.kind === 'INPUT_OBJECT' && depth < 4) {
      const properties: Json = {};
      const required: string[] = [];
      for (const f of type.inputFields ?? []) {
        properties[f.name] = this.jsonSchema(f.type, depth + 1);
        if (f.type.kind === 'NON_NULL' && f.defaultValue == null) required.push(f.name);
      }
      return { type: 'object', properties, ...(required.length ? { required } : {}) };
    }
    return {}; // custom scalar or depth-capped input: any JSON
  }

  /** Validate a parsed selection against the schema and print it. Every
   *  field must exist on its parent type, must not require arguments, and
   *  must carry a sub-selection exactly when its type is composite. */
  private buildSelection(src: string, typeName: string): string | { error: string } {
    const tree = parseSelection(src);
    if (!Array.isArray(tree)) return tree;
    const budget = { n: 0 };
    const print = (nodes: SelNode[], parent: string, path: string): string | { error: string } => {
      const type = this.types.get(parent);
      const parts: string[] = [];
      for (const node of nodes) {
        if (++budget.n > MAX_SELECTION_FIELDS * 2) return { error: 'too many fields' };
        const at = path ? `${path}.${node.name}` : node.name;
        if (node.name === '__typename') {
          if (node.children) return { error: `'${at}' has no fields` };
          parts.push('__typename');
          continue;
        }
        const field = type?.fields?.find((f) => f.name === node.name);
        if (!field) return { error: `'${at}' is not a field of ${parent}` };
        if (field.args.some((a) => a.type.kind === 'NON_NULL' && a.defaultValue == null)) {
          return { error: `'${at}' requires arguments and cannot be selected` };
        }
        const leaf = unwrap(field.type);
        const kind = this.types.get(leaf.name ?? '')?.kind ?? leaf.kind;
        const composite = kind === 'OBJECT' || kind === 'INTERFACE' || kind === 'UNION';
        if (composite && !node.children) return { error: `'${at}' is an object — select its fields with { … }` };
        if (!composite && node.children) return { error: `'${at}' is a ${kind.toLowerCase()} and has no fields` };
        if (kind === 'UNION') return { error: `'${at}' is a union — not selectable through 'select'` };
        if (node.children) {
          const inner = print(node.children, leaf.name!, at);
          if (typeof inner !== 'string') return inner;
          parts.push(`${node.name} ${inner}`);
        } else {
          parts.push(node.name);
        }
      }
      return `{ ${parts.join(' ')} }`;
    };
    return print(tree, typeName, '');
  }

  async listTools(): Promise<DownstreamTool[]> {
    if (!this.url) throw new Error(`server '${this.name}': not connected`);
    return [...this.ops.values()].map((o) => o.tool);
  }

  async callTool(name: string, args: Record<string, unknown>, deadline: number): Promise<McpResult> {
    if (!this.url) throw new Error(`server '${this.name}': not connected`);
    const op = this.ops.get(name);
    if (!op) return errorResult(`unknown operation '${name}'`);

    let selection = op.selection;
    if (op.returnsComposite && typeof args.select === 'string' && args.select.trim()) {
      const built = this.buildSelection(args.select, unwrap(op.field.type).name!);
      if (typeof built !== 'string') return errorResult(`invalid 'select': ${built.error}`);
      selection = built;
    }

    const decls: string[] = [];
    const uses: string[] = [];
    const variables: Json = {};
    for (const a of op.field.args) {
      const v = args[a.name];
      if (v === undefined) {
        if (a.type.kind === 'NON_NULL' && a.defaultValue == null) return errorResult(`missing required parameter '${a.name}'`);
        continue;
      }
      decls.push(`$${a.name}: ${printType(a.type)}`);
      uses.push(`${a.name}: $${a.name}`);
      variables[a.name] = v;
    }
    const query = `${op.kind} FlowMcp${decls.length ? `(${decls.join(', ')})` : ''} { ${op.field.name}${uses.length ? `(${uses.join(', ')})` : ''}${selection ? ` ${selection}` : ''} }`;

    const res = await this.post({ query, variables }, deadline);
    if (res.kind === 'error') return errorResult(res.message);
    const value = (res.data as Json | undefined)?.[op.field.name];
    const text = JSON.stringify(value ?? null);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return { content: [{ type: 'text', text }], structuredContent: value };
    }
    return { content: [{ type: 'text', text }] };
  }

  private async post(body: Json, deadline: number): Promise<{ kind: 'ok'; data: unknown } | { kind: 'error'; message: string }> {
    let res: Response;
    try {
      res = await fetch(this.url!, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...this.headers },
        body: JSON.stringify(body),
        // a POST redirect would re-send credentials somewhere unreviewed
        redirect: 'manual',
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
    } catch (e) {
      throw new Error(`server '${this.name}': request failed: ${this.redact(e instanceof Error ? e.message : String(e))}`);
    }
    const text = await res.text();
    if (res.status >= 300 && res.status < 400) return { kind: 'error', message: `HTTP ${res.status} redirect not followed` };
    let parsed: { data?: unknown; errors?: Array<{ message?: string }> } | undefined;
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      // not JSON
    }
    // GraphQL reports execution failure as HTTP 200 + errors[] — a failure.
    if (parsed?.errors?.length) {
      const msgs = parsed.errors.map((e) => e.message ?? JSON.stringify(e)).join('; ');
      return { kind: 'error', message: this.redact(`GraphQL error: ${msgs}`.slice(0, 800)) };
    }
    if (!res.ok) return { kind: 'error', message: this.redact(`HTTP ${res.status}: ${text.slice(0, 500) || '(empty body)'}`) };
    if (!parsed) return { kind: 'error', message: 'response was not JSON' };
    return { kind: 'ok', data: parsed.data };
  }

  close(): void {
    this.ops.clear();
    this.url = undefined;
  }
}

function unwrap(ref: TypeRef): TypeRef {
  let r = ref;
  while ((r.kind === 'NON_NULL' || r.kind === 'LIST') && r.ofType) r = r.ofType;
  return r;
}

function printType(ref: TypeRef): string {
  if (ref.kind === 'NON_NULL') return `${printType(ref.ofType!)}!`;
  if (ref.kind === 'LIST') return `[${printType(ref.ofType!)}]`;
  return ref.name!;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s; // GraphQL literal (enum value, etc.)
  }
}

function errorResult(message: string): McpResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}
