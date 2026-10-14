import { readFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import {
  CATEGORIES,
  CHANNELS,
  PRIORITIES,
  type Category,
  type Channel,
  type Priority,
  type RegulatoryClass,
} from '../../utils/types';
import type { ErrorDetail } from '../../utils/errors';
import {
  compileField,
  fieldSpecSchema,
  resolveField,
  type FieldDefinition,
} from '../validators/payload';

const channelEnum = z.enum(CHANNELS);

const rawEventSchema = z.strictObject({
  code: z.string().regex(/^[A-Z]{4}-\d{3}$/, 'event code must look like ABCD-123'),
  name: z.string().min(1),
  category: z.enum(CATEGORIES),
  priority: z.enum(PRIORITIES),
  // PDF §A6.1: every notification is TRANSACTIONAL or PROMOTIONAL.
  regulatoryClass: z.enum(['TRANSACTIONAL', 'PROMOTIONAL']),
  permittedChannels: z.array(channelEnum).min(1),
  defaultChannels: z.array(channelEnum).min(1),
  fallbackChannels: z.array(channelEnum).default([]),
  mandatoryChannels: z.array(channelEnum).default([]),
  latencyObjectiveMs: z.number().int().positive(),
  quietHours: z.enum(['DEFER', 'BYPASS']),
  frequencyCapExempt: z.boolean(),
  idempotencyKeyFields: z.array(z.string()).min(1),
  /** Buckets occurredAt into this window in derived keys (storm dedup, PDF §B2.4). */
  idempotencyWindowSeconds: z.number().int().positive().optional(),
  cooldownKeyFields: z.array(z.string()).default([]),
  /** Overrides the policy's same-type cooldown for this event (e.g. price alerts). */
  cooldownSeconds: z.number().int().min(0).optional(),
  payload: z.record(z.string(), fieldSpecSchema),
});

const rawTaxonomySchema = z.object({
  version: z.number().int(),
  provenance: z.record(z.string(), z.enum(['ASSIGNMENT', 'DEFAULT'])),
  categories: z.record(
    z.enum(CATEGORIES),
    z.object({ prefix: z.string().length(4), name: z.string() }),
  ),
  fieldLibrary: z.record(z.string(), fieldSpecSchema).default({}),
  events: z.array(rawEventSchema).min(1),
});

export interface EventDefinition {
  code: string;
  name: string;
  category: Category;
  priority: Priority;
  regulatoryClass: RegulatoryClass;
  permittedChannels: Channel[];
  defaultChannels: Channel[];
  fallbackChannels: Channel[];
  mandatoryChannels: Channel[];
  latencyObjectiveMs: number;
  quietHours: 'DEFER' | 'BYPASS';
  frequencyCapExempt: boolean;
  idempotencyKeyFields: string[];
  idempotencyWindowSeconds?: number;
  cooldownKeyFields: string[];
  cooldownSeconds?: number;
  fields: Record<string, FieldDefinition>;
  /** Compiled strict payload validator (rejects unknown fields, applies defaults). */
  schema: z.ZodType<Record<string, unknown>>;
}

export type PayloadValidation =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; errors: ErrorDetail[] };

function subset(a: Channel[], b: Channel[]): boolean {
  return a.every((c) => b.includes(c));
}

export class EventTaxonomy {
  private readonly byCode: Map<string, EventDefinition>;

  constructor(
    readonly version: number,
    definitions: EventDefinition[],
    readonly categoryNames: Record<Category, string>,
  ) {
    this.byCode = new Map(definitions.map((d) => [d.code, d]));
  }

  static fromYaml(text: string): EventTaxonomy {
    const raw = rawTaxonomySchema.parse(YAML.parse(text));
    const seen = new Set<string>();
    const defs = raw.events.map((e) => {
      if (seen.has(e.code)) throw new Error(`Duplicate event code ${e.code}`);
      seen.add(e.code);
      const prefix = raw.categories[e.category].prefix;
      if (!e.code.startsWith(`${prefix}-`))
        throw new Error(`${e.code}: code prefix must be ${prefix} for ${e.category}`);
      if (!subset(e.defaultChannels, e.permittedChannels))
        throw new Error(`${e.code}: defaultChannels must be permitted`);
      if (!subset(e.fallbackChannels, e.permittedChannels))
        throw new Error(`${e.code}: fallbackChannels must be permitted`);
      if (!subset(e.mandatoryChannels, e.permittedChannels))
        throw new Error(`${e.code}: mandatoryChannels must be permitted`);
      // Guard rails: overrides are never blanket. Promotional traffic cannot be
      // mandatory, bypass quiet hours or skip caps; only CRITICAL may bypass quiet hours.
      if (
        e.regulatoryClass === 'PROMOTIONAL' &&
        (e.mandatoryChannels.length > 0 || e.quietHours === 'BYPASS' || e.frequencyCapExempt)
      ) {
        throw new Error(`${e.code}: promotional events cannot carry regulatory overrides`);
      }
      if (e.quietHours === 'BYPASS' && e.priority !== 'CRITICAL') {
        throw new Error(`${e.code}: only CRITICAL events may bypass quiet hours`);
      }
      const fields: Record<string, FieldDefinition> = {};
      for (const [name, spec] of Object.entries(e.payload)) {
        fields[name] = resolveField(name, spec, raw.fieldLibrary, e.code);
      }
      for (const k of [...e.idempotencyKeyFields, ...e.cooldownKeyFields]) {
        const f = fields[k];
        if (!f) throw new Error(`${e.code}: key field '${k}' is not in payload`);
        if (!f.required) throw new Error(`${e.code}: key field '${k}' must be required`);
      }
      const shape: Record<string, z.ZodType> = {};
      for (const [name, def] of Object.entries(fields)) shape[name] = compileField(def);
      const schema = z.strictObject(shape) as unknown as z.ZodType<Record<string, unknown>>;
      const def: EventDefinition = {
        code: e.code,
        name: e.name,
        category: e.category,
        priority: e.priority,
        regulatoryClass: e.regulatoryClass,
        permittedChannels: e.permittedChannels,
        defaultChannels: e.defaultChannels,
        fallbackChannels: e.fallbackChannels,
        mandatoryChannels: e.mandatoryChannels,
        latencyObjectiveMs: e.latencyObjectiveMs,
        quietHours: e.quietHours,
        frequencyCapExempt: e.frequencyCapExempt,
        idempotencyKeyFields: e.idempotencyKeyFields,
        ...(e.idempotencyWindowSeconds
          ? { idempotencyWindowSeconds: e.idempotencyWindowSeconds }
          : {}),
        cooldownKeyFields: e.cooldownKeyFields,
        ...(e.cooldownSeconds !== undefined ? { cooldownSeconds: e.cooldownSeconds } : {}),
        fields,
        schema,
      };
      return def;
    });
    const names = Object.fromEntries(
      Object.entries(raw.categories).map(([k, v]) => [k, v.name]),
    ) as Record<Category, string>;
    return new EventTaxonomy(raw.version, defs, names);
  }

  static load(
    file = path.resolve(__dirname, '../../../config/event-taxonomy.yaml'),
  ): EventTaxonomy {
    return EventTaxonomy.fromYaml(readFileSync(file, 'utf8'));
  }

  get(code: string): EventDefinition | undefined {
    return this.byCode.get(code);
  }

  list(): EventDefinition[] {
    return [...this.byCode.values()];
  }

  get size(): number {
    return this.byCode.size;
  }

  validatePayload(code: string, payload: unknown): PayloadValidation {
    const def = this.byCode.get(code);
    if (!def)
      return {
        ok: false,
        errors: [
          {
            path: 'eventType',
            message: `Unknown event type '${code}'`,
            code: 'UNKNOWN_EVENT_TYPE',
          },
        ],
      };
    const result = def.schema.safeParse(payload);
    if (result.success) return { ok: true, payload: result.data };
    return {
      ok: false,
      errors: result.error.issues.map((i) => ({
        path: ['payload', ...i.path.map(String)].join('.'),
        message: i.message,
        code: i.code,
      })),
    };
  }

  /** Deterministic idempotency key derived from the event's declared key fields. */
  deriveIdempotencyKey(
    code: string,
    userId: string,
    payload: Record<string, unknown>,
    occurredAt?: string,
  ): string {
    const def = this.byCode.get(code);
    if (!def) throw new Error(`Unknown event type ${code}`);
    const parts = def.idempotencyKeyFields.map((f) => String(payload[f]));
    // (event_type + entity + timestamp window): one notification per user/entity/window.
    if (def.idempotencyWindowSeconds && occurredAt) {
      const windowMs = def.idempotencyWindowSeconds * 1000;
      parts.push(`w${Math.floor(new Date(occurredAt).getTime() / windowMs)}`);
    }
    return `${code}:${userId}:${parts.join('|')}`;
  }

  cooldownSubject(def: EventDefinition, payload: Record<string, unknown>): string {
    if (def.cooldownKeyFields.length === 0) return def.code;
    return `${def.code}:${def.cooldownKeyFields.map((f) => String(payload[f])).join('|')}`;
  }
}
