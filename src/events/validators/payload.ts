import { z } from 'zod';

/**
 * Payload field validators (PDF Day 2: "Zod validation for all event payloads").
 * The taxonomy declares fields in YAML; these turn each declaration into a strict
 * Zod schema (types, ranges, patterns, future timestamps, arrays of objects).
 */
const FIELD_TYPES = [
  'string',
  'integer',
  'number',
  'decimal',
  'enum',
  'date',
  'datetime',
  'boolean',
  'url',
  'array',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

const itemSpecSchema = z.strictObject({
  $ref: z.string().optional(),
  type: z.enum(FIELD_TYPES).optional(),
  required: z.boolean().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  minLength: z.number().int().min(0).optional(),
  maxLength: z.number().int().min(1).optional(),
  pattern: z.string().optional(),
  values: z.array(z.string()).optional(),
  /** datetime: must be later than the time of validation. */
  future: z.boolean().optional(),
  /** number/decimal: must be > 0. */
  positive: z.boolean().optional(),
});
/** `array` fields hold objects whose fields are declared in `items` (one level deep). */
export const fieldSpecSchema = itemSpecSchema.extend({
  items: z.record(z.string(), itemSpecSchema).optional(),
  maxItems: z.number().int().min(1).optional(),
});
export type RawFieldSpec = z.infer<typeof fieldSpecSchema>;

export interface FieldDefinition {
  type: FieldType;
  required: boolean;
  default?: string | number | boolean;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  values?: string[];
  future?: boolean;
  positive?: boolean;
  items?: Record<string, FieldDefinition>;
  maxItems?: number;
}

const DECIMAL = /^-?\d{1,15}(\.\d{1,6})?$/;

export function compileField(def: FieldDefinition): z.ZodType {
  let schema: z.ZodType;
  switch (def.type) {
    case 'string': {
      let s = z.string();
      if (def.minLength !== undefined) s = s.min(def.minLength);
      if (def.maxLength !== undefined) s = s.max(def.maxLength);
      if (def.pattern) s = s.regex(new RegExp(def.pattern), `must match ${def.pattern}`);
      schema = s;
      break;
    }
    case 'integer':
    case 'number': {
      let n = def.type === 'integer' ? z.number().int() : z.number();
      n = n.refine(Number.isFinite, 'must be finite');
      if (def.min !== undefined) n = n.min(def.min);
      if (def.max !== undefined) n = n.max(def.max);
      if (def.positive) n = n.refine((v) => v > 0, 'must be a positive number');
      schema = n;
      break;
    }
    case 'decimal': {
      // Monetary values: accept numbers or numeric strings, normalise to string
      // so downstream code never does float arithmetic on money.
      const min = def.min;
      const max = def.max;
      schema = z
        .union([z.string(), z.number()])
        .transform((v) => (typeof v === 'number' ? String(v) : v.trim()))
        .refine((v) => DECIMAL.test(v), 'must be a decimal with at most 6 fractional digits')
        .refine((v) => min === undefined || Number(v) >= min, `must be >= ${min}`)
        .refine((v) => max === undefined || Number(v) <= max, `must be <= ${max}`)
        .refine((v) => !def.positive || Number(v) > 0, 'must be a positive number');
      break;
    }
    case 'enum': {
      const values = def.values ?? [];
      schema = z.string().refine((v) => values.includes(v), `must be one of ${values.join(', ')}`);
      break;
    }
    case 'date':
      schema = z.iso.date();
      break;
    case 'datetime': {
      const iso = z.iso.datetime({ offset: true });
      schema = def.future
        ? iso.refine((v) => Date.parse(v) > Date.now(), 'must be a future timestamp')
        : iso;
      break;
    }
    case 'boolean':
      schema = z.boolean();
      break;
    case 'url': {
      let u = z.url({ protocol: /^https$/ });
      if (def.maxLength !== undefined) u = u.max(def.maxLength);
      schema = u;
      break;
    }
    case 'array': {
      const shape: Record<string, z.ZodType> = {};
      for (const [name, item] of Object.entries(def.items ?? {})) shape[name] = compileField(item);
      schema = z.array(z.strictObject(shape)).max(def.maxItems ?? 100);
      break;
    }
  }
  if (!def.required) {
    return def.default !== undefined ? schema.optional().default(def.default) : schema.optional();
  }
  return schema;
}

export function resolveField(
  name: string,
  spec: RawFieldSpec,
  library: Record<string, RawFieldSpec>,
  eventCode: string,
): FieldDefinition {
  let merged: RawFieldSpec = spec;
  if (spec.$ref) {
    const base = library[spec.$ref];
    if (!base) throw new Error(`${eventCode}.${name}: unknown $ref '${spec.$ref}'`);
    const { $ref: _ignored, ...rest } = spec;
    merged = { ...base, ...rest };
  }
  if (!merged.type) throw new Error(`${eventCode}.${name}: field type is required`);
  if (merged.type === 'enum' && (!merged.values || merged.values.length === 0)) {
    throw new Error(`${eventCode}.${name}: enum requires values`);
  }
  if (merged.pattern) new RegExp(merged.pattern); // throws early on invalid patterns
  return {
    type: merged.type,
    required: merged.required ?? false,
    ...(merged.default !== undefined ? { default: merged.default } : {}),
    ...(merged.min !== undefined ? { min: merged.min } : {}),
    ...(merged.max !== undefined ? { max: merged.max } : {}),
    ...(merged.minLength !== undefined ? { minLength: merged.minLength } : {}),
    ...(merged.maxLength !== undefined ? { maxLength: merged.maxLength } : {}),
    ...(merged.pattern !== undefined ? { pattern: merged.pattern } : {}),
    ...(merged.values !== undefined ? { values: merged.values } : {}),
    ...(merged.future ? { future: true } : {}),
    ...(merged.positive ? { positive: true } : {}),
    ...(merged.maxItems !== undefined ? { maxItems: merged.maxItems } : {}),
    ...(merged.type === 'array'
      ? {
          items: Object.fromEntries(
            Object.entries(merged.items ?? {}).map(([k, v]) => [
              k,
              resolveField(`${name}.${k}`, v, library, eventCode),
            ]),
          ),
        }
      : {}),
  };
}
