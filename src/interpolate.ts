import { evalExpr, type ExprContext } from './expr.js';

// null/undefined render as '' (mustache-style); arrays join line-per-item.
export function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(stringify).join('\n');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// Replace every {{ path }} in a string with its stringified value.
export function interpolate(template: string, ctx: ExprContext): string {
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, path: string) =>
    stringify(evalExpr(path, ctx)),
  );
}

// URL context: percent-encode every substituted value so 'Foo & Bar' cannot
// break the query string. A placeholder at position 0 stays raw — that is the
// base-URL slot ({{env.FIXTURE_BASE}}/path).
export function interpolateUrl(template: string, ctx: ExprContext): string {
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, path: string, offset: number) => {
    const value = stringify(evalExpr(path, ctx));
    return offset === 0 ? value : encodeURIComponent(value);
  });
}

// A string that is EXACTLY one placeholder passes its value through with its
// type: numbers stay numbers, booleans stay booleans, null stays null, and an
// absent optional value stays undefined — JSON serialization then omits the
// key, which is the correct "don't send this variable" semantics for
// structured args (GraphQL variables, API bodies). Mixed strings interpolate
// to text as before.
const SOLE_PLACEHOLDER = /^\{\{\s*([^{}]+?)\s*\}\}$/;

// Interpolate string leaves of a JSON-ish value (http_request bodies,
// mcp_call args).
export function interpolateDeep(value: unknown, ctx: ExprContext): unknown {
  if (typeof value === 'string') {
    const sole = SOLE_PLACEHOLDER.exec(value);
    if (sole) return evalExpr(sole[1]!, ctx);
    return interpolate(value, ctx);
  }
  if (Array.isArray(value)) return value.map((v) => interpolateDeep(v, ctx));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, interpolateDeep(v, ctx)]),
    );
  }
  return value;
}
