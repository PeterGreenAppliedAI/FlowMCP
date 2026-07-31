import { z } from 'zod';

const IDENT = /^[a-z][a-z0-9_]*$/;
const RESERVED = new Set(['input', 'steps', 'env']);

const paramSchema = z
  .object({
    type: z.enum(['string', 'number', 'boolean']),
    description: z.string().min(1).max(200),
    required: z.boolean().default(false),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  })
  .strict();

const httpFields = {
  method: z.enum(['GET', 'POST']).default('GET'),
  url: z.string().min(1),
  headers: z.record(z.string()).optional(),
  body: z.unknown().optional(),
  timeoutMs: z.number().int().positive().max(60_000).default(15_000),
};

// Leaf steps carry no id — they appear inside `map`.
const leafHttp = z.object({ kind: z.literal('http_request'), ...httpFields }).strict();
const leafTransform = z.object({ kind: z.literal('transform'), expr: z.string().min(1) }).strict();
const leafTemplate = z.object({ kind: z.literal('template'), template: z.string().min(1) }).strict();

// Composition: call one tool on a downstream MCP server from servers.json5.
// timeoutMs covers spawn + handshake + call as one unit.
const leafMcpCall = z
  .object({
    kind: z.literal('mcp_call'),
    server: z.string().regex(IDENT),
    tool: z.string().min(1),
    args: z.record(z.unknown()).default({}),
    timeoutMs: z.number().int().positive().max(60_000).default(30_000),
    maxResultChars: z.number().int().positive().max(1_000_000).default(8_000),
  })
  .strict();

const leafStepSchema = z.discriminatedUnion('kind', [leafHttp, leafTransform, leafTemplate, leafMcpCall]);

const idField = { id: z.string().regex(IDENT, 'step id must be snake_case') };

const namedHttp = leafHttp.extend(idField);
const namedTransform = leafTransform.extend(idField);
const namedTemplate = leafTemplate.extend(idField);
const namedMcpCall = leafMcpCall.extend(idField);

const mapStep = z
  .object({
    ...idField,
    kind: z.literal('map'),
    over: z.string().min(1),
    as: z
      .string()
      .regex(IDENT)
      .refine((s) => !RESERVED.has(s), 'binding name is reserved')
      .default('item'),
    step: leafStepSchema,
  })
  .strict();

// branch bodies allow every kind except another branch — no recursion in v1.
const branchBodyStep = z.discriminatedUnion('kind', [
  namedHttp,
  namedTransform,
  namedTemplate,
  namedMcpCall,
  mapStep,
]);

const branchStep = z
  .object({
    ...idField,
    kind: z.literal('branch'),
    if: z.string().min(1),
    then: z.array(branchBodyStep).min(1),
    else: z.array(branchBodyStep).optional(),
  })
  .strict();

export const stepSchema = z.discriminatedUnion('kind', [
  namedHttp,
  namedTransform,
  namedTemplate,
  namedMcpCall,
  mapStep,
  branchStep,
]);

export const flowSchema = z
  .object({
    name: z.string().regex(IDENT, 'flow name must be snake_case (it becomes the MCP tool name)'),
    description: z.string().min(1).max(300),
    input: z
      .record(z.string().regex(IDENT), paramSchema)
      .default({})
      .refine((p) => Object.keys(p).length <= 3, 'flows take at most 3 input parameters')
      .refine((p) => Object.keys(p).every((k) => !RESERVED.has(k)), 'parameter name is reserved'),
    steps: z.array(stepSchema).min(1),
    output: z.string().min(1),
  })
  .strict();

export type Flow = z.infer<typeof flowSchema>;
export type Step = z.infer<typeof stepSchema>;
export type LeafStep = z.infer<typeof leafStepSchema>;
export type HttpStep = z.infer<typeof leafHttp>;
export type McpCallStep = z.infer<typeof leafMcpCall>;
export type Param = z.infer<typeof paramSchema>;
