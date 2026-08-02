// `flowmcp compile-graphql` — compile recurring GraphQL operations from a
// query log into candidate flows.
//
//   flowmcp compile-graphql <query-log.jsonl> --server <name> --tool <toolname>
//     [--out <dir>] [--min-runs N] [--min-success R]
//     [--fold var=value ...] [--default var=value ...] [--scalar Name=type ...]
//     [--include-mutations] [--include-observed-values]
//
// GraphQL logs are the compiler's cleanest input: the query document is the
// contract, the variables object is the input surface, and repeated
// executions are the evidence — no variant differencing needed. The failure
// mode this module is engineered against is SILENT wrongness:
//   - observed invariance is NOT semantic constancy: a variable that was
//     always "EMEA" in this log window (a tenantId, a region) is never folded
//     to a constant automatically — it becomes an input, flagged as a
//     candidate constant; folding requires an explicit --fold var=value.
//   - observed values are never used as executable defaults: the precedence
//     is GraphQL declaration default → explicit --default → none (required
//     per nullability). Observed statistics go to provenance, redacted.
//   - everything ambiguous refuses, and the refusal RATE by reason is a
//     first-class output — coverage honesty, not a log line.
//
// Log contract (open JSONL; any gateway/host can emit it):
//   {"query":"query GetOrders($region: String!){...}","variables":{"region":"EMEA"},
//    "operationName":"GetOrders","success":true}
// `success` means the operation completed WITHOUT GraphQL execution errors —
// HTTP 200 with a top-level `errors` array is a failure. Absent `success`,
// a non-empty `errors` field marks failure; otherwise the run counts as ok.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

// ------------------------------------------------------------------ lexer
// Minimal GraphQL lexer: enough lexical correctness that normalization can
// never mutate a string literal or misidentify an operation. Not an AST.
interface Token { kind: 'name' | 'punct' | 'string' | 'block' | 'int' | 'float'; raw: string }

export function lexGraphql(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') { i++; continue; }
    if (c === '#') { while (i < n && src[i] !== '\n') i++; continue; }
    if (src.startsWith('"""', i)) {
      let j = i + 3;
      while (j < n && !(src.startsWith('"""', j) && src[j - 1] !== '\\')) j++;
      if (j >= n) throw new Error('unterminated block string');
      tokens.push({ kind: 'block', raw: src.slice(i, j + 3) });
      i = j + 3;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== '"') { if (src[j] === '\\') j++; j++; }
      if (j >= n) throw new Error('unterminated string');
      tokens.push({ kind: 'string', raw: src.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    if (/[_A-Za-z]/.test(c)) {
      let j = i + 1;
      while (j < n && /[_0-9A-Za-z]/.test(src[j]!)) j++;
      tokens.push({ kind: 'name', raw: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i + 1;
      let float = false;
      while (j < n && /[0-9.eE+-]/.test(src[j]!)) {
        if (src[j] === '.' || src[j] === 'e' || src[j] === 'E') float = true;
        if ((src[j] === '+' || src[j] === '-') && !/[eE]/.test(src[j - 1]!)) break;
        j++;
      }
      tokens.push({ kind: float ? 'float' : 'int', raw: src.slice(i, j) });
      i = j;
      continue;
    }
    if (src.startsWith('...', i)) { tokens.push({ kind: 'punct', raw: '...' }); i += 3; continue; }
    if ('!$():=@[]{}|&'.includes(c)) { tokens.push({ kind: 'punct', raw: c }); i++; continue; }
    throw new Error(`unexpected character '${c}' at offset ${i}`);
  }
  return tokens;
}

// Canonical text: tokens joined by single spaces — whitespace/comment
// insensitive, string-literal safe. Masked variant replaces literal tokens
// for inline-literal-variance detection across clusters.
const joinTokens = (tokens: Token[], mask: boolean): string =>
  tokens.map((t) => (mask && (t.kind === 'string' || t.kind === 'int' || t.kind === 'float') ? '◊' : t.raw)).join(' ');

// ------------------------------------------------------- operation parsing
export interface VarDef {
  name: string;
  typeName: string;
  isList: boolean;
  required: boolean; // outermost `!` and no declared default
  defaultValue?: string | number | boolean | null;
  hasDefault: boolean;
  malformed?: string;
}
export interface Operation {
  type: 'query' | 'mutation' | 'subscription';
  name?: string;
  varDefs: VarDef[];
}

export function parseOperations(tokens: Token[]): Operation[] {
  const ops: Operation[] = [];
  let i = 0;
  const skipBlock = () => {
    // caller sits ON the '{'
    let depth = 0;
    do {
      const t = tokens[i++];
      if (!t) throw new Error('unbalanced braces');
      if (t.kind === 'punct' && t.raw === '{') depth++;
      if (t.kind === 'punct' && t.raw === '}') depth--;
    } while (depth > 0);
  };
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (t.kind === 'name' && t.raw === 'fragment') {
      i++; // fragment
      while (i < tokens.length && !(tokens[i]!.kind === 'punct' && tokens[i]!.raw === '{')) i++;
      skipBlock();
      continue;
    }
    if (t.kind === 'name' && (t.raw === 'query' || t.raw === 'mutation' || t.raw === 'subscription')) {
      const op: Operation = { type: t.raw as Operation['type'], varDefs: [] };
      i++;
      if (tokens[i]?.kind === 'name') { op.name = tokens[i]!.raw; i++; }
      if (tokens[i]?.kind === 'punct' && tokens[i]!.raw === '(') {
        i++;
        while (i < tokens.length && !(tokens[i]!.kind === 'punct' && tokens[i]!.raw === ')')) {
          op.varDefs.push(parseVarDef());
        }
        i++; // ')'
      }
      // skip directives up to the selection set
      while (i < tokens.length && !(tokens[i]!.kind === 'punct' && tokens[i]!.raw === '{')) i++;
      skipBlock();
      ops.push(op);
      continue;
    }
    if (t.kind === 'punct' && t.raw === '{') {
      skipBlock();
      ops.push({ type: 'query', varDefs: [] }); // anonymous shorthand
      continue;
    }
    throw new Error(`unexpected token '${t.raw}' at top level`);
  }
  return ops;

  function parseVarDef(): VarDef {
    const bad = (why: string): VarDef => {
      // resync to next '$' or ')'
      while (i < tokens.length && !(tokens[i]!.kind === 'punct' && (tokens[i]!.raw === '$' || tokens[i]!.raw === ')'))) i++;
      return { name: '?', typeName: '?', isList: false, required: false, hasDefault: false, malformed: why };
    };
    if (!(tokens[i]?.kind === 'punct' && tokens[i]!.raw === '$')) return bad(`expected '$', got '${tokens[i]?.raw}'`);
    i++;
    if (tokens[i]?.kind !== 'name') return bad('expected variable name');
    const name = tokens[i]!.raw;
    i++;
    if (!(tokens[i]?.kind === 'punct' && tokens[i]!.raw === ':')) return bad(`variable '$${name}' missing ':'`);
    i++;
    let isList = false;
    let depth = 0;
    while (tokens[i]?.kind === 'punct' && tokens[i]!.raw === '[') { isList = true; depth++; i++; }
    if (tokens[i]?.kind !== 'name') return bad(`variable '$${name}' missing type name`);
    const typeName = tokens[i]!.raw;
    i++;
    if (depth > 0 && tokens[i]?.kind === 'punct' && tokens[i]!.raw === '!') i++; // inner non-null of a list element
    while (depth > 0) {
      if (!(tokens[i]?.kind === 'punct' && tokens[i]!.raw === ']')) return bad(`variable '$${name}' unbalanced list type`);
      i++;
      depth--;
    }
    let required = false;
    if (tokens[i]?.kind === 'punct' && tokens[i]!.raw === '!') { required = true; i++; }
    let hasDefault = false;
    let defaultValue: VarDef['defaultValue'];
    if (tokens[i]?.kind === 'punct' && tokens[i]!.raw === '=') {
      i++;
      hasDefault = true;
      const v = tokens[i];
      if (!v) return bad(`variable '$${name}' missing default value`);
      if (v.kind === 'string') defaultValue = JSON.parse(v.raw) as string;
      else if (v.kind === 'int' || v.kind === 'float') defaultValue = Number(v.raw);
      else if (v.kind === 'name' && (v.raw === 'true' || v.raw === 'false')) defaultValue = v.raw === 'true';
      else if (v.kind === 'name' && v.raw === 'null') defaultValue = null;
      else if (v.kind === 'name') defaultValue = v.raw; // enum value → string
      else return bad(`variable '$${name}' has a composite default`);
      i++;
    }
    return { name, typeName, isList, required: required && !hasDefault, hasDefault, defaultValue };
  }
}

// ------------------------------------------------------------- the pipeline
export interface QueryLogRecord {
  query?: string;
  variables?: Record<string, unknown>;
  operationName?: string;
  success?: boolean;
  errors?: unknown[];
}

export interface GraphqlCompileOpts {
  server: string;
  tool: string;
  minRuns?: number;
  minSuccess?: number;
  fold?: Record<string, string>;      // var -> raw value (typed by declaration)
  cliDefaults?: Record<string, string>;
  scalarMap?: Record<string, 'string' | 'number' | 'boolean'>;
  includeMutations?: boolean;
  includeObservedValues?: boolean;
}

export type RefusalReason =
  | 'malformed-line' | 'missing-query' | 'lex-error' | 'multi-op-no-name' | 'op-not-found'
  | 'subscription' | 'mutation-skipped' | 'unmapped-type' | 'list-variable'
  | 'too-many-inputs' | 'declared-var-never-observed' | 'credential-like-variable'
  | 'below-threshold' | 'inline-literal-variance' | 'malformed-variable-declaration';

export interface EmittedFlow {
  flowName: string;
  operationName?: string;
  flow: string; // .flow.json5 text
  provenance: Record<string, unknown>;
  runs: number;
}
export interface CompileSummary {
  scanned: number;
  clusters: number;
  emitted: EmittedFlow[];
  refused: Array<{ reason: RefusalReason; operation: string; runs: number; detail?: string }>;
  coverage: { emittedRuns: number; totalRuns: number };
}

const BUILTIN_SCALARS: Record<string, 'string' | 'number' | 'boolean'> = {
  String: 'string', ID: 'string', Int: 'number', Float: 'number', Boolean: 'boolean',
};
// Credential detection is WORD-boundary based, not substring: 'authToken'
// and 'api_key' refuse; 'authorId' (contains "auth") and 'monkeyLimit'
// (contains "key") do not. A substring match would over-refuse innocent
// variables and a match-anything would under-refuse — both erode trust in
// the refusal table. Value side: JWT and sk_live/pk_test shapes.
const CREDENTIAL_WORDS = new Set([
  'token', 'secret', 'password', 'passwd', 'bearer', 'credential', 'credentials', 'session', 'auth', 'apikey',
]);
function isCredentialName(name: string): boolean {
  const words = (name.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+/g) ?? []).map((w) => w.toLowerCase());
  if (words.some((w) => CREDENTIAL_WORDS.has(w))) return true;
  return name.toLowerCase().replace(/[_-]/g, '').includes('apikey');
}
const CREDENTIAL_VALUE = /^(eyJ[A-Za-z0-9_-]{10,}|(sk|pk)[-_](live|test)[-_A-Za-z0-9]+)/;
const hash8 = (v: unknown) => createHash('sha256').update(JSON.stringify(v) ?? 'undefined').digest('hex').slice(0, 8);

const snake = (s: string) =>
  s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^[^a-z]+/, '') || 'flow';

interface Cluster {
  key: string;
  normalized: string;
  masked: string;
  op: Operation;
  records: Array<{ variables: Record<string, unknown>; ok: boolean }>;
}

export function compileGraphqlLog(records: QueryLogRecord[], opts: GraphqlCompileOpts): CompileSummary {
  const minRuns = opts.minRuns ?? 3;
  const minSuccess = opts.minSuccess ?? 0.8;
  const scalarMap = { ...BUILTIN_SCALARS, ...(opts.scalarMap ?? {}) };
  const refused: CompileSummary['refused'] = [];
  const clusters = new Map<string, Cluster>();
  let totalRuns = 0;

  const recordRefusal = (reason: RefusalReason, operation: string, runs: number, detail?: string) => {
    refused.push({ reason, operation, runs, ...(detail ? { detail } : {}) });
  };

  // 1. cluster records by canonical operation text
  const singles = new Map<string, number>(); // per-record refusals aggregated
  const bumpSingle = (reason: string) => singles.set(reason, (singles.get(reason) ?? 0) + 1);
  for (const rec of records) {
    totalRuns++;
    if (typeof rec.query !== 'string' || !rec.query.trim()) { bumpSingle('missing-query'); continue; }
    let tokens: Token[];
    let ops: Operation[];
    try {
      tokens = lexGraphql(rec.query);
      ops = parseOperations(tokens);
    } catch (e) {
      bumpSingle(`lex-error: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    let op: Operation | undefined;
    if (ops.length === 1) op = ops[0];
    else if (rec.operationName) op = ops.find((o) => o.name === rec.operationName);
    if (!op) {
      bumpSingle(ops.length > 1 && !rec.operationName ? 'multi-op-no-name' : 'op-not-found');
      continue;
    }
    const normalized = joinTokens(tokens, false);
    const key = `${op.type}|${op.name ?? ''}|${normalized}`;
    if (!clusters.has(key)) {
      clusters.set(key, { key, normalized, masked: joinTokens(tokens, true), op, records: [] });
    }
    const ok = rec.success !== undefined ? rec.success === true : !(Array.isArray(rec.errors) && rec.errors.length > 0);
    clusters.get(key)!.records.push({ variables: rec.variables ?? {}, ok });
  }
  for (const [reason, count] of singles) {
    const base = reason.startsWith('lex-error') ? 'lex-error' : (reason as RefusalReason);
    recordRefusal(base, '(per-record)', count, reason.startsWith('lex-error') ? reason : undefined);
  }

  // 2. inline-literal variance: distinct clusters sharing a masked signature
  //    are the same operation with inlined (non-variable) literals — refuse
  //    them all rather than emit one arbitrary instance as "the" contract.
  const byMasked = new Map<string, Cluster[]>();
  for (const c of clusters.values()) {
    if (!byMasked.has(c.masked)) byMasked.set(c.masked, []);
    byMasked.get(c.masked)!.push(c);
  }
  const varianceRefused = new Set<string>();
  for (const group of byMasked.values()) {
    if (group.length > 1) {
      for (const c of group) {
        varianceRefused.add(c.key);
        recordRefusal('inline-literal-variance', c.op.name ?? '(anonymous)', c.records.length,
          `${group.length} query variants differ only in inline literals — use GraphQL variables`);
      }
    }
  }

  // 3. per-cluster classification and emission
  const emitted: EmittedFlow[] = [];
  const usedNames = new Set<string>();
  for (const c of clusters.values()) {
    if (varianceRefused.has(c.key)) continue;
    const label = c.op.name ?? '(anonymous)';
    const runs = c.records.length;
    if (c.op.type === 'subscription') { recordRefusal('subscription', label, runs); continue; }
    if (c.op.type === 'mutation' && !opts.includeMutations) {
      recordRefusal('mutation-skipped', label, runs, 'compiling writes from logs crosses the promotion boundary; --include-mutations to opt in');
      continue;
    }
    const okRuns = c.records.filter((r) => r.ok);
    const successRate = runs ? okRuns.length / runs : 0;
    if (runs < minRuns || successRate < minSuccess) {
      recordRefusal('below-threshold', label, runs, `${runs} runs, ${Math.round(successRate * 100)}% success (need ≥${minRuns} at ≥${Math.round(minSuccess * 100)}%)`);
      continue;
    }
    const malformed = c.op.varDefs.find((v) => v.malformed);
    if (malformed) { recordRefusal('malformed-variable-declaration', label, runs, malformed.malformed); continue; }

    // variable analysis over SUCCESSFUL runs
    let refusedThis = false;
    interface VarInfo { def: VarDef; flowType: 'string' | 'number' | 'boolean'; observed: unknown[]; distinct: number }
    const vars: VarInfo[] = [];
    for (const def of c.op.varDefs) {
      if (def.isList) { recordRefusal('list-variable', label, runs, `$${def.name}: [${def.typeName}]`); refusedThis = true; break; }
      const flowType = scalarMap[def.typeName];
      if (!flowType) {
        recordRefusal('unmapped-type', label, runs, `$${def.name}: ${def.typeName} — custom scalar or input object; map scalars with --scalar ${def.typeName}=<type>`);
        refusedThis = true;
        break;
      }
      const observed = okRuns.map((r) => r.variables[def.name]).filter((v) => v !== undefined);
      if (observed.length === 0 && !def.hasDefault) {
        recordRefusal('declared-var-never-observed', label, runs, `$${def.name} has no declared default and never appears in observed variables`);
        refusedThis = true;
        break;
      }
      if (isCredentialName(def.name) || observed.some((v) => typeof v === 'string' && CREDENTIAL_VALUE.test(v))) {
        recordRefusal('credential-like-variable', label, runs, `$${def.name} — credentials belong in server config ({{env.X}} headers), never in flow traffic`);
        refusedThis = true;
        break;
      }
      vars.push({ def, flowType, observed, distinct: new Set(observed.map((v) => JSON.stringify(v))).size });
    }
    if (refusedThis) continue;

    // folding is EXPLICIT only: observed invariance is not semantic constancy
    const folded: Record<string, unknown> = {};
    const inputs: VarInfo[] = [];
    for (const v of vars) {
      const foldRaw = opts.fold?.[v.def.name];
      if (foldRaw !== undefined) {
        folded[v.def.name] = v.flowType === 'number' ? Number(foldRaw) : v.flowType === 'boolean' ? foldRaw === 'true' : foldRaw;
      } else {
        inputs.push(v);
      }
    }
    if (inputs.length > 3) {
      const candidates = inputs.filter((v) => v.distinct <= 1).map((v) => `$${v.def.name}`);
      recordRefusal('too-many-inputs', label, runs,
        `${inputs.length} inputs exceed the 3-parameter limit${candidates.length ? `; observed-invariant candidates for explicit --fold: ${candidates.join(', ')}` : '; split the operation'}`);
      continue;
    }

    // defaults: declaration default → --default → none. Never observed values.
    const flowName = (() => {
      let base = c.op.name ? snake(c.op.name) : `${snake(c.normalized.match(/\{ (\w+)/)?.[1] ?? 'anonymous')}_query`;
      let name = base;
      for (let k = 2; usedNames.has(name); k++) name = `${base}_${k}`;
      usedNames.add(name);
      return name;
    })();
    const inputLines = inputs.map((v) => {
      const cliDefault = opts.cliDefaults?.[v.def.name];
      const def = v.def.hasDefault && v.def.defaultValue !== null
        ? v.def.defaultValue
        : cliDefault !== undefined
          ? (v.flowType === 'number' ? Number(cliDefault) : v.flowType === 'boolean' ? cliDefault === 'true' : cliDefault)
          : undefined;
      const desc = `GraphQL variable $${v.def.name}: ${v.def.typeName}${v.def.required ? '!' : ''}`;
      return `    ${v.def.name}: { type: '${v.flowType}', description: ${JSON.stringify(desc)}${v.def.required ? ', required: true' : ''}${def !== undefined ? `, default: ${JSON.stringify(def)}` : ''} },`;
    });
    const varLines = [
      ...inputs.map((v) => `          ${v.def.name}: '{{input.${v.def.name}}}',`),
      ...Object.entries(folded).map(([k, v]) => `          ${k}: ${JSON.stringify(v)},`),
    ];
    const description = `WHEN TO USE: [REVIEW: replace with task-selection guidance before promotion] Runs GraphQL ${c.op.type} ${c.op.name ?? '(anonymous)'}(${inputs.map((v) => v.def.name).join(', ')}).`;
    const flow = `// COMPILED FLOW — generated by flowmcp compile-graphql from a query log.
// Contract: the query document is a constant; only variables are inputs.
// Review before promotion; see the .provenance.json beside this file.
{
  name: '${flowName}',
  description: ${JSON.stringify(description.slice(0, 300))},
  input: {${inputLines.length ? `\n${inputLines.join('\n')}\n  ` : ''}},
  steps: [
    { id: 'q', kind: 'mcp_call', server: '${opts.server}', tool: '${opts.tool}',
      args: {
        query: ${JSON.stringify(c.normalized)},
        variables: {${varLines.length ? `\n${varLines.join('\n')}\n        ` : ''}},
      } },
  ],
  output: '{{steps.q}}',
}
`;
    // provenance: redacted by default — GraphQL variables carry business data
    const provenance: Record<string, unknown> = {
      source: 'graphql-query-log',
      operationName: c.op.name ?? null,
      operationType: c.op.type,
      runs,
      successRate: Math.round(successRate * 100) / 100,
      inputs: Object.fromEntries(inputs.map((v) => [v.def.name, {
        declaredType: `${v.def.typeName}${v.def.required ? '!' : ''}`,
        required: v.def.required,
        observations: v.observed.length,
        distinctCount: v.distinct,
        nullCount: v.observed.filter((x) => x === null).length,
        typeConsistent: v.observed.every((x) => x === null || typeof x === v.flowType),
        ...(opts.includeObservedValues
          ? { observedValues: [...new Set(v.observed.map((x) => JSON.stringify(x)))].slice(0, 10) }
          : { valueHashes: [...new Set(v.observed.map(hash8))].slice(0, 10) }),
      }])),
      candidateConstants: inputs.filter((v) => v.distinct <= 1).map((v) => ({
        name: v.def.name,
        note: `observed-invariant across ${v.observed.length} runs — fold ONLY if semantically constant: --fold ${v.def.name}=<value>`,
        valueHash: hash8(v.observed[0]),
      })),
      folded,
      ...(c.op.type === 'mutation' ? { includeMutations: true, warning: 'write-capable: serving gates apply; promote deliberately' } : {}),
      warnings: [
        'description is a placeholder — a flow description does the model\'s selection work; replace before promotion',
        ...inputs.filter((v) => !v.observed.every((x) => x === null || typeof x === v.flowType)).map((v) => `$${v.def.name}: observed value types inconsistent with declared ${v.def.typeName}`),
      ],
    };
    emitted.push({ flowName, operationName: c.op.name, flow, provenance, runs });
  }

  return {
    scanned: totalRuns,
    clusters: clusters.size,
    emitted,
    refused,
    coverage: { emittedRuns: emitted.reduce((s, e) => s + e.runs, 0), totalRuns },
  };
}

// ------------------------------------------------------------------- CLI
function flagVal(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
function flagPairs(name: string): Record<string, string> {
  const out: Record<string, string> = {};
  process.argv.forEach((a, i) => {
    if (a === name && process.argv[i + 1]?.includes('=')) {
      const [k, ...rest] = process.argv[i + 1]!.split('=');
      out[k!] = rest.join('=');
    }
  });
  return out;
}

export function compileGraphqlCli(): void {
  const logPath = process.argv[2];
  const server = flagVal('--server');
  const tool = flagVal('--tool');
  if (!logPath || logPath.startsWith('--') || !server || !tool) {
    console.error(
      'usage: flowmcp compile-graphql <query-log.jsonl> --server <name> --tool <toolname>\n' +
        '         [--out <dir>] [--min-runs N] [--min-success R]\n' +
        '         [--fold var=value ...] [--default var=value ...] [--scalar Name=string|number|boolean ...]\n' +
        '         [--include-mutations] [--include-observed-values]',
    );
    process.exit(1);
  }
  const outDir = resolve(flagVal('--out') ?? 'graphql-flows');
  const lines = readFileSync(logPath, 'utf8').split('\n').filter((l) => l.trim());
  const records: QueryLogRecord[] = [];
  let malformedLines = 0;
  for (const line of lines) {
    try { records.push(JSON.parse(line) as QueryLogRecord); } catch { malformedLines++; }
  }
  const scalarMap: Record<string, 'string' | 'number' | 'boolean'> = {};
  for (const [k, v] of Object.entries(flagPairs('--scalar'))) {
    if (v !== 'string' && v !== 'number' && v !== 'boolean') {
      console.error(`--scalar ${k}=${v}: type must be string|number|boolean`);
      process.exit(1);
    }
    scalarMap[k] = v;
  }
  const summary = compileGraphqlLog(records, {
    server, tool,
    minRuns: flagVal('--min-runs') ? Number(flagVal('--min-runs')) : undefined,
    minSuccess: flagVal('--min-success') ? Number(flagVal('--min-success')) : undefined,
    fold: flagPairs('--fold'),
    cliDefaults: flagPairs('--default'),
    scalarMap,
    includeMutations: process.argv.includes('--include-mutations'),
    includeObservedValues: process.argv.includes('--include-observed-values'),
  });

  mkdirSync(outDir, { recursive: true });
  for (const e of summary.emitted) {
    writeFileSync(join(outDir, `${e.flowName}.flow.json5`), e.flow);
    writeFileSync(join(outDir, `${e.flowName}.provenance.json`), JSON.stringify(e.provenance, null, 2));
  }

  // refusal-rate table: coverage honesty as a first-class output
  const byReason = new Map<string, { clusters: number; runs: number }>();
  for (const r of summary.refused) {
    const cur = byReason.get(r.reason) ?? { clusters: 0, runs: 0 };
    byReason.set(r.reason, { clusters: cur.clusters + 1, runs: cur.runs + r.runs });
  }
  console.error(`\ncompile-graphql: ${summary.scanned} records (${malformedLines} malformed lines skipped), ${summary.clusters} operation clusters`);
  console.error(`emitted ${summary.emitted.length} flow(s) covering ${summary.coverage.emittedRuns}/${summary.coverage.totalRuns} logged runs (${summary.coverage.totalRuns ? Math.round((summary.coverage.emittedRuns / summary.coverage.totalRuns) * 100) : 0}%)`);
  if (byReason.size) {
    console.error('refusals by reason:');
    for (const [reason, { clusters, runs }] of [...byReason].sort((a, b) => b[1].runs - a[1].runs)) {
      console.error(`  ${reason.padEnd(32)} ${String(clusters).padStart(4)} cluster(s) ${String(runs).padStart(6)} run(s)`);
    }
    for (const r of summary.refused.filter((x) => x.detail).slice(0, 12)) {
      console.error(`  - [${r.reason}] ${r.operation}: ${r.detail}`);
    }
  }
  if (summary.emitted.length) {
    console.error('\nregistry.json5 candidates (paste beside the flows):');
    for (const e of summary.emitted) console.error(`  ${e.flowName}: { state: 'candidate', provenance: { source: '${e.flowName}.provenance.json' } },`);
  }
  console.log(JSON.stringify({
    scanned: summary.scanned,
    malformedLines,
    clusters: summary.clusters,
    emitted: summary.emitted.map((e) => e.flowName),
    refusals: Object.fromEntries([...byReason].map(([k, v]) => [k, v])),
    coverage: summary.coverage,
    outDir,
  }, null, 2));
}

if (process.argv[1]?.endsWith('compile-graphql.ts') || process.argv[1]?.endsWith('compile-graphql.js')) {
  compileGraphqlCli();
}
