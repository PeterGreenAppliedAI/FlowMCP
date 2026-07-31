// Tiny safe evaluator for transform/branch expressions and {{...}} paths.
//
// Grammar:
//   expr   := value (('=='|'!='|'>='|'<='|'>'|'<') value)?
//   value  := object | array | string | number | true | false | null | path
//   object := '{' (key ':' expr)* '}'          key := ident | string
//   path   := ident ('.' ident | '[' int ']' | '[' int? ':' int? ']' | '[' string ']')*
//
// No function calls, no arithmetic, no assignment, no prototype access —
// paths resolve only against the flow context object passed in.

export class ExprError extends Error {}

export type ExprContext = Record<string, unknown>;

const TOKEN_RE =
  /(==|!=|>=|<=|[><{}\[\]:,.]|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|-?\d+(?:\.\d+)?|[A-Za-z_$][\w$]*)/y;

const COMPARE_OPS = new Set(['==', '!=', '>=', '<=', '>', '<']);

function tokenize(src: string): string[] {
  const tokens: string[] = [];
  let pos = 0;
  while (pos < src.length) {
    while (pos < src.length && /\s/.test(src[pos]!)) pos++;
    if (pos >= src.length) break;
    TOKEN_RE.lastIndex = pos;
    const m = TOKEN_RE.exec(src);
    if (!m || m.index !== pos) {
      throw new ExprError(`unexpected character '${src[pos]}' at position ${pos} in: ${src}`);
    }
    tokens.push(m[0]);
    pos = TOKEN_RE.lastIndex;
  }
  return tokens;
}

function unquote(token: string): string {
  const inner = token.slice(1, -1);
  return inner.replace(/\\(.)/g, (_, ch: string) => {
    if (ch === 'n') return '\n';
    if (ch === 't') return '\t';
    return ch;
  });
}

const isString = (t: string) => t.startsWith('"') || t.startsWith("'");
const isNumber = (t: string) => /^-?\d/.test(t);
const isIdent = (t: string) => /^[A-Za-z_$]/.test(t);

class Parser {
  private pos = 0;
  constructor(
    private tokens: string[],
    private ctx: ExprContext,
    private src: string,
  ) {}

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private next(): string {
    const t = this.tokens[this.pos++];
    if (t === undefined) throw new ExprError(`unexpected end of expression: ${this.src}`);
    return t;
  }

  private expect(t: string): void {
    const got = this.next();
    if (got !== t) throw new ExprError(`expected '${t}' but got '${got}' in: ${this.src}`);
  }

  parse(): unknown {
    const result = this.parseExpr();
    if (this.pos < this.tokens.length) {
      throw new ExprError(`unexpected trailing '${this.peek()}' in: ${this.src}`);
    }
    return result;
  }

  private parseExpr(): unknown {
    const left = this.parseValue();
    const op = this.peek();
    if (op !== undefined && COMPARE_OPS.has(op)) {
      this.next();
      return this.compare(left, op, this.parseValue());
    }
    return left;
  }

  private compare(a: unknown, op: string, b: unknown): boolean {
    if (op === '==') return a === b;
    if (op === '!=') return a !== b;
    if (typeof a !== typeof b || (typeof a !== 'number' && typeof a !== 'string')) {
      throw new ExprError(
        `'${op}' needs two numbers or two strings, got ${typeof a} and ${typeof b} in: ${this.src}`,
      );
    }
    if (op === '>') return (a as never) > (b as never);
    if (op === '>=') return (a as never) >= (b as never);
    if (op === '<') return (a as never) < (b as never);
    return (a as never) <= (b as never);
  }

  private parseValue(): unknown {
    const t = this.peek();
    if (t === undefined) throw new ExprError(`unexpected end of expression: ${this.src}`);
    if (t === '{') return this.parseObject();
    if (t === '[') return this.parseArray();
    if (isString(t)) return unquote(this.next());
    if (isNumber(t)) return Number(this.next());
    if (isIdent(t)) {
      if (t === 'true') return (this.next(), true);
      if (t === 'false') return (this.next(), false);
      if (t === 'null') return (this.next(), null);
      return this.parsePath();
    }
    throw new ExprError(`unexpected '${t}' in: ${this.src}`);
  }

  private parseObject(): Record<string, unknown> {
    this.expect('{');
    const obj: Record<string, unknown> = {};
    while (this.peek() !== '}') {
      const keyTok = this.next();
      const key = isString(keyTok) ? unquote(keyTok) : keyTok;
      if (!isString(keyTok) && !isIdent(keyTok)) {
        throw new ExprError(`invalid object key '${keyTok}' in: ${this.src}`);
      }
      this.expect(':');
      obj[key] = this.parseExpr();
      if (this.peek() === ',') this.next();
      else break;
    }
    this.expect('}');
    return obj;
  }

  private parseArray(): unknown[] {
    this.expect('[');
    const arr: unknown[] = [];
    while (this.peek() !== ']') {
      arr.push(this.parseExpr());
      if (this.peek() === ',') this.next();
      else break;
    }
    this.expect(']');
    return arr;
  }

  private parsePath(): unknown {
    const root = this.next();
    if (!Object.prototype.hasOwnProperty.call(this.ctx, root)) {
      throw new ExprError(
        `unknown name '${root}' (available: ${Object.keys(this.ctx).join(', ')}) in: ${this.src}`,
      );
    }
    let value: unknown = this.ctx[root];
    let trail = root;
    while (this.peek() === '.' || this.peek() === '[') {
      if (this.next() === '.') {
        const key = this.next();
        if (!isIdent(key)) throw new ExprError(`invalid property '${key}' after '${trail}' in: ${this.src}`);
        value = this.access(value, key, trail);
        trail += `.${key}`;
      } else {
        value = this.parseBracket(value, trail);
        trail += '[…]';
      }
    }
    return value;
  }

  // Handles [3], [1:5], [:5], [1:], and ["key"] — '[' already consumed.
  private parseBracket(value: unknown, trail: string): unknown {
    const first = this.peek();
    if (first !== undefined && isString(first)) {
      const key = unquote(this.next());
      this.expect(']');
      return this.access(value, key, trail);
    }
    let start: number | undefined;
    let end: number | undefined;
    let isSlice = false;
    if (this.peek() !== ':') start = this.parseIndex(trail);
    if (this.peek() === ':') {
      isSlice = true;
      this.next();
      if (this.peek() !== ']') end = this.parseIndex(trail);
    }
    this.expect(']');
    if (!isSlice) return this.access(value, start!, trail);
    if (!Array.isArray(value)) {
      throw new ExprError(`cannot slice non-array at '${trail}' in: ${this.src}`);
    }
    return value.slice(start ?? 0, end);
  }

  private parseIndex(trail: string): number {
    const t = this.next();
    if (!/^\d+$/.test(t)) throw new ExprError(`invalid index '${t}' at '${trail}' in: ${this.src}`);
    return Number(t);
  }

  // Missing terminal property → undefined; reading through undefined/null → loud error.
  private access(value: unknown, key: string | number, trail: string): unknown {
    if (value === null || value === undefined) {
      throw new ExprError(`cannot read '${key}' of ${value} at '${trail}' in: ${this.src}`);
    }
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new ExprError(`forbidden property '${key}' in: ${this.src}`);
    }
    if (typeof value !== 'object') return undefined;
    return (value as Record<string | number, unknown>)[key];
  }
}

export function evalExpr(src: string, ctx: ExprContext): unknown {
  return new Parser(tokenize(src), ctx, src).parse();
}
