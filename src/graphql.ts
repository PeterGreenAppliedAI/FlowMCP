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
  possibleTypes?: Array<{ name: string }> | null;
}

/** A selection tree: a field (optionally with children), or an inline
 *  fragment (`name: '...'`, `on: TypeName`). Every document FlowMCP sends is
 *  PRINTED from one of these — generated from the schema or parsed from a
 *  caller's `select` and validated — never concatenated from caller text. */
export interface SelNode { name: string; on?: string; children?: SelNode[] }

interface Operation {
  tool: DownstreamTool; kind: 'query' | 'mutation'; field: Field; returnsComposite: boolean;
  /** Default selection; pruned in place when the server reports fields this
   *  credential may not read, so later calls don't repeat the failure. */
  tree?: SelNode[];
}

interface GqlError { message?: string; path?: Array<string | number>; locations?: Array<{ line: number; column: number }> }
interface Span { start: number; end: number; node: SelNode }

const TYPE_REF = 'kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } }';
export const INTROSPECTION_QUERY = `query FlowMcpIntrospection {
  __schema {
    queryType { name } mutationType { name }
    types {
      kind name description
      fields(includeDeprecated: false) { name description isDeprecated args { name description defaultValue type { ${TYPE_REF} } } type { ${TYPE_REF} } }
      inputFields { name description defaultValue type { ${TYPE_REF} } }
      enumValues(includeDeprecated: false) { name }
      possibleTypes { name }
    }
  }
}`;

const SELECTION_DEPTH = 2;
const UNION_FIELDS_PER_TYPE = 5;
// Fields that identify an object — preferred when a union's member types
// are sampled for the default selection.
const IDENTIFYING = ['id', 'name', 'title', 'login', 'nameWithOwner', 'number', 'url', 'state', 'createdAt'];
const MAX_SELECTION_FIELDS = 60;
const SELECT_ALLOWED = /^[A-Za-z0-9_\s{},.]*$/;
const MAX_SELECT_DEPTH = 6;


// Parse a caller-supplied selection into a tree: EXACTLY one selection set
// (outer braces optional) of fields, nested sets, and `... on Type { }`
// inline fragments — nothing else. The query text is then PRINTED from the
// validated tree — the caller's characters never reach the document, so a
// trailing sibling (`{ id } otherMutation`) cannot become a second root field.
export function parseSelection(src: string): SelNode[] | { error: string } {
  if (!SELECT_ALLOWED.test(src)) return { error: "only field names, braces, commas and '... on Type' are allowed" };
  const raw = src.match(/\.\.\.|[A-Za-z_][A-Za-z0-9_]*|[{}]|\S/g) ?? [];
  if (raw.some((t) => !/^[A-Za-z_][A-Za-z0-9_]*$|^[{}]$|^\.\.\.$/.test(t) && t !== ',')) return { error: 'unexpected token' };
  const toks = raw.filter((t) => t !== ',');
  if (toks[0] !== '{') toks.splice(0, toks.length, '{', ...toks, '}');
  let i = 0;
  const ident = (t: string | undefined) => t !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(t);
  const set = (depth: number): SelNode[] | { error: string } => {
    if (depth > MAX_SELECT_DEPTH) return { error: `nested deeper than ${MAX_SELECT_DEPTH}` };
    if (toks[i] !== '{') return { error: "expected '{'" };
    i++;
    const nodes: SelNode[] = [];
    while (i < toks.length && toks[i] !== '}') {
      if (toks[i] === '...') {
        i++;
        if (toks[i] !== 'on' || !ident(toks[i + 1])) return { error: "a fragment must be written '... on TypeName { … }'" };
        const on = toks[i + 1]!;
        i += 2;
        const children = set(depth + 1);
        if (!Array.isArray(children)) return children;
        nodes.push({ name: '...', on, children });
        continue;
      }
      const name = toks[i]!;
      if (!ident(name)) return { error: 'a selection set must follow a field name' };
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
  const root = set(1);
  if (!Array.isArray(root)) return root;
  if (i !== toks.length) return { error: 'exactly one selection set is allowed — found content after it' };
  return root;
}

/** Print a tree, recording each field's character span (for mapping a
 *  server's error `locations` back to the field that caused it). */
export function printTree(nodes: SelNode[], offset = 0): { text: string; spans: Span[] } {
  const spans: Span[] = [];
  let text = '';
  const emit = (list: SelNode[]) => {
    text += '{';
    for (const n of list) {
      text += ' ';
      if (n.name === '...') {
        text += `... on ${n.on} `;
        emit(n.children ?? []);
        continue;
      }
      spans.push({ start: offset + text.length, end: offset + text.length + n.name.length, node: n });
      text += n.name;
      if (n.children) {
        text += ' ';
        emit(n.children);
      }
    }
    text += ' }';
  };
  emit(nodes);
  return { text, spans };
}

function rank(name: string): number {
  const i = IDENTIFYING.indexOf(name);
  return i === -1 ? IDENTIFYING.length : i;
}

/** Remove the given nodes; parents left empty are removed too. */
function prune(nodes: SelNode[], drop: Set<SelNode>): SelNode[] {
  const out: SelNode[] = [];
  for (const n of nodes) {
    if (drop.has(n)) continue;
    if (!n.children) { out.push(n); continue; }
    const kids = prune(n.children, drop);
    if (kids.length) out.push({ ...n, children: kids });
  }
  return out;
}

/** Walk a name path (fragments transparent) to the nodes it reaches. */
function findByPath(nodes: SelNode[], path: string[]): SelNode[] {
  if (!path.length) return [];
  const hits: SelNode[] = [];
  for (const n of nodes) {
    if (n.name === '...') { hits.push(...findByPath(n.children ?? [], path)); continue; }
    if (n.name !== path[0]) continue;
    if (path.length === 1) hits.push(n);
    else hits.push(...findByPath(n.children ?? [], path.slice(1)));
  }
  return hits;
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
    const tree = returnsComposite ? this.defaultTree(leaf.name!, SELECTION_DEPTH, { n: 0 }) : undefined;
    if (tree) {
      const shown = printTree(tree).text;
      properties.select = {
        type: 'string',
        description: `GraphQL selection set: field names, braces, and '... on Type { }' for unions/interfaces. ` +
          `Default: ${shown.length > 180 ? `${shown.slice(0, 180)}…` : shown}`,
      };
    }
    const description = `GraphQL ${kind} ${field.name}${field.description ? ` — ${field.description}` : ''}`.slice(0, 1000);
    return {
      kind, field, tree, returnsComposite,
      tool: {
        name: toolName,
        description,
        inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) },
        ...(kind === 'query' ? { annotations: { readOnlyHint: true } } : {}),
      },
    };
  }

  private kindOf(ref: TypeRef): string {
    const leaf = unwrap(ref);
    return this.types.get(leaf.name ?? '')?.kind ?? leaf.kind;
  }

  // Default selection: scalar/enum fields, plus nested objects/interfaces to a
  // bounded depth, and unions sampled per member type (identifying fields
  // first); fields needing arguments are skipped. Never empty.
  private defaultTree(typeName: string, depth: number, budget: { n: number }): SelNode[] {
    const type = this.types.get(typeName);
    if (type?.kind === 'UNION') return this.unionTree(type, budget);
    const nodes: SelNode[] = [];
    for (const f of type?.fields ?? []) {
      if (budget.n >= MAX_SELECTION_FIELDS) break;
      if (f.args.some((a) => a.type.kind === 'NON_NULL' && a.defaultValue == null)) continue;
      const kind = this.kindOf(f.type);
      if (kind === 'SCALAR' || kind === 'ENUM') {
        nodes.push({ name: f.name });
        budget.n++;
      } else if ((kind === 'OBJECT' || kind === 'INTERFACE' || kind === 'UNION') && depth > 1) {
        const inner = this.defaultTree(unwrap(f.type).name!, depth - 1, budget);
        if (!(inner.length === 1 && inner[0]!.name === '__typename')) nodes.push({ name: f.name, children: inner });
      }
    }
    return nodes.length ? nodes : [{ name: '__typename' }];
  }

  private unionTree(type: FullType, budget: { n: number }): SelNode[] {
    const nodes: SelNode[] = [{ name: '__typename' }];
    for (const member of type.possibleTypes ?? []) {
      const t = this.types.get(member.name);
      const scalars = (t?.fields ?? []).filter((f) =>
        ['SCALAR', 'ENUM'].includes(this.kindOf(f.type)) && !f.args.some((a) => a.type.kind === 'NON_NULL' && a.defaultValue == null));
      scalars.sort((a, b) => rank(a.name) - rank(b.name));
      const picked = scalars.slice(0, UNION_FIELDS_PER_TYPE);
      if (!picked.length || budget.n + picked.length > MAX_SELECTION_FIELDS) continue;
      budget.n += picked.length;
      nodes.push({ name: '...', on: member.name, children: picked.map((f) => ({ name: f.name })) });
    }
    return nodes;
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

  /** Validate a parsed selection against the schema. Every field must exist
   *  on its parent type, must not require arguments, and must carry a
   *  sub-selection exactly when its type is composite; a fragment's type must
   *  be the parent or one of its possible types; union selections hold only
   *  fragments and __typename. */
  private validateTree(nodes: SelNode[], typeName: string): { error: string } | undefined {
    const budget = { n: 0 };
    const check = (list: SelNode[], parent: string, path: string): { error: string } | undefined => {
      const type = this.types.get(parent);
      for (const node of list) {
        if (++budget.n > MAX_SELECTION_FIELDS * 2) return { error: 'too many fields' };
        if (node.name === '...') {
          const target = this.types.get(node.on ?? '');
          const fits = node.on === parent || (type?.possibleTypes ?? []).some((t) => t.name === node.on);
          if (!target || !fits || !['OBJECT', 'INTERFACE'].includes(target.kind)) {
            return { error: `'... on ${node.on}' is not a possible type of ${parent}` };
          }
          const inner = check(node.children ?? [], node.on!, path);
          if (inner) return inner;
          continue;
        }
        const at = path ? `${path}.${node.name}` : node.name;
        if (node.name === '__typename') {
          if (node.children) return { error: `'${at}' has no fields` };
          continue;
        }
        if (type?.kind === 'UNION') return { error: `'${at}': ${parent} is a union — select through '... on Type { }'` };
        const field = type?.fields?.find((f) => f.name === node.name);
        if (!field) return { error: `'${at}' is not a field of ${parent}` };
        if (field.args.some((a) => a.type.kind === 'NON_NULL' && a.defaultValue == null)) {
          return { error: `'${at}' requires arguments and cannot be selected` };
        }
        const kind = this.kindOf(field.type);
        const composite = kind === 'OBJECT' || kind === 'INTERFACE' || kind === 'UNION';
        if (composite && !node.children) return { error: `'${at}' is an object — select its fields with { … }` };
        if (!composite && node.children) return { error: `'${at}' is a ${kind.toLowerCase()} and has no fields` };
        if (node.children) {
          const inner = check(node.children, unwrap(field.type).name!, at);
          if (inner) return inner;
        }
      }
      return undefined;
    };
    return check(nodes, typeName, '');
  }

  async listTools(): Promise<DownstreamTool[]> {
    if (!this.url) throw new Error(`server '${this.name}': not connected`);
    return [...this.ops.values()].map((o) => o.tool);
  }

  async callTool(name: string, args: Record<string, unknown>, deadline: number): Promise<McpResult> {
    if (!this.url) throw new Error(`server '${this.name}': not connected`);
    const op = this.ops.get(name);
    if (!op) return errorResult(`unknown operation '${name}'`);

    let tree = op.tree;
    const custom = op.returnsComposite && typeof args.select === 'string' && args.select.trim() !== '';
    if (custom) {
      const parsed = parseSelection(args.select as string);
      if (!Array.isArray(parsed)) return errorResult(`invalid 'select': ${parsed.error}`);
      const invalid = this.validateTree(parsed, unwrap(op.field.type).name!);
      if (invalid) return errorResult(`invalid 'select': ${invalid.error}`);
      tree = parsed;
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

    // The DEFAULT selection may hit fields this credential cannot read
    // (GitHub: viewer.email without user:email fails the whole query). Map
    // each error to the selected field — by `path`, else by `locations` in
    // the document we printed — drop exactly those fields and retry. Never
    // for a caller's explicit `select` (they asked for those fields). A
    // mutation is retried ONLY when the server rejected it before execution
    // (no `data`): once it executed, a retry could write twice.
    for (let attempt = 0; ; attempt++) {
      const head = `${op.kind} FlowMcp${decls.length ? `(${decls.join(', ')})` : ''} { ${op.field.name}${uses.length ? `(${uses.join(', ')})` : ''}`;
      const printed = tree ? printTree(tree, head.length + 1) : { text: '', spans: [] };
      const query = `${head}${tree ? ` ${printed.text}` : ''} }`;
      const res = await this.post({ query, variables }, deadline);
      if (res.kind === 'ok') {
        if (tree && !custom && tree !== op.tree) op.tree = tree; // remember for later calls
        const value = (res.data as Json | undefined)?.[op.field.name];
        const text = JSON.stringify(value ?? null);
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          return { content: [{ type: 'text', text }], structuredContent: value };
        }
        return { content: [{ type: 'text', text }] };
      }
      if (op.kind === 'mutation' && res.hasData) {
        const value = (res.data as Json | undefined)?.[op.field.name];
        if (value !== null && value !== undefined) {
          // executed; only part of the RESULT failed to resolve — report the
          // write as done rather than inviting a duplicate
          process.stderr.write(`flowmcp: [${this.name}] ${op.field.name}: mutation applied; some result fields failed: ${this.redact(res.message)}\n`);
          const text = JSON.stringify(value);
          return typeof value === 'object' && !Array.isArray(value)
            ? { content: [{ type: 'text', text }], structuredContent: value }
            : { content: [{ type: 'text', text }] };
        }
        return errorResult(`${res.message} (the mutation executed and may have been applied — check before retrying)`);
      }
      const retryable = !custom && tree && attempt < 3 && res.errors?.length && (op.kind === 'query' || !res.hasData);
      const drop = new Set<SelNode>();
      if (retryable) {
        for (const e of res.errors!) {
          let hit: SelNode[] = [];
          if (Array.isArray(e.path) && e.path[0] === op.field.name) {
            hit = findByPath(tree!, e.path.slice(1).filter((x): x is string => typeof x === 'string'));
          } else if (e.locations?.length === 1 && e.locations[0]!.line === 1) {
            const col = e.locations[0]!.column - 1;
            const span = printed.spans.find((sp) => col >= sp.start && col < sp.end);
            if (span) hit = [span.node];
          }
          if (!hit.length) { drop.clear(); break; } // an error we can't attribute: fail as-is
          hit.forEach((n) => drop.add(n));
        }
      }
      if (!drop.size) return errorResult(res.message);
      const pruned = prune(tree!, drop);
      if (!pruned.length) return errorResult(res.message);
      process.stderr.write(
        `flowmcp: [${this.name}] ${op.field.name}: omitting field(s) this credential cannot read: ${[...drop].map((n) => n.name).join(', ')}\n`,
      );
      tree = pruned;
    }
  }

  private async post(body: Json, deadline: number): Promise<{ kind: 'ok'; data: unknown } | { kind: 'error'; message: string; errors?: GqlError[]; data?: unknown; hasData?: boolean }> {
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
    let parsed: { data?: unknown; errors?: GqlError[] } | undefined;
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      // not JSON
    }
    // GraphQL reports execution failure as HTTP 200 + errors[] — a failure.
    if (parsed?.errors?.length) {
      const msgs = parsed.errors.map((e) => e.message ?? JSON.stringify(e)).join('; ');
      // `data` ABSENT means the request failed before execution (GraphQL spec
      // §7.1.2) — nothing ran, even for a mutation. Present means it executed.
      return { kind: 'error', message: this.redact(`GraphQL error: ${msgs}`.slice(0, 800)), errors: parsed.errors, data: parsed.data, hasData: 'data' in parsed };
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
