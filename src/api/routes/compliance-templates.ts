import { z } from 'zod';
import type { Container } from '../../container';
import { AppError, ValidationError } from '../../utils/errors';
import { CHANNELS, LOCALES } from '../../utils/types';
import { evaluateDnd } from '../../compliance/dnd/dnd';
import { normaliseContact } from '../../database/models/contacts';
import { DIGEST_EVENT_TYPE } from '../../templates/definitions/source';
import { SAMPLE_DIGEST, SAMPLE_PAYLOADS } from '../../events/models/fixtures';
import type { Api } from '../middleware/http';
import { camel } from '../mappers';
import {
  ChannelEnum,
  LocaleEnum,
  PolicyDecisionSchema,
  RenderedContentSchema,
  UuidParam,
} from '../validators/schemas';

const TemplateSchema = z
  .object({
    id: z.uuid(),
    eventType: z.string(),
    channel: z.string(),
    locale: z.string(),
    activeVersion: z.number().nullable(),
    experimentVersion: z.number().nullable(),
    experimentPercent: z.number(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: 'Template' });
const TemplateVersionSchema = z
  .object({
    id: z.uuid(),
    templateId: z.uuid(),
    version: z.number(),
    subject: z.string().nullable(),
    title: z.string().nullable(),
    body: z.string(),
    checksum: z.string(),
    status: z.string(),
    createdBy: z.string(),
    createdAt: z.string(),
  })
  .meta({ id: 'TemplateVersion' });

export function registerComplianceAndTemplateRoutes(api: Api, c: Container): void {
  api.route({
    method: 'get',
    path: '/compliance/decisions',
    operationId: 'listPolicyDecisions',
    summary:
      'Inspect auditable policy decisions (consent, DND, quiet hours, caps, overrides, fallbacks)',
    tags: ['Compliance'],
    auth: { permission: 'compliance:read' },
    query: z.strictObject({
      eventId: z.uuid().optional(),
      notificationId: z.uuid().optional(),
      userId: z.uuid().optional(),
      rule: z.string().max(64).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }),
    responses: {
      200: {
        description: 'Decisions (newest first)',
        schema: z.object({ items: z.array(PolicyDecisionSchema) }),
      },
    },
    handler: async ({ query }) => {
      if (!query.eventId && !query.notificationId && !query.userId && !query.rule)
        throw new ValidationError('Provide at least one filter', [
          { path: 'query', message: 'eventId, notificationId, userId or rule is required' },
        ]);
      const rows = await c.decisions().list({ ...query });
      return { status: 200, body: { items: rows.map(camel) } };
    },
  });

  api.route({
    method: 'post',
    path: '/compliance/evaluate',
    operationId: 'evaluatePolicy',
    summary:
      'Dry-run the routing/compliance pipeline for a user and event type (nothing is sent or consumed)',
    description:
      'Use to verify that promotional and transactional messages follow their respective rules for a given user (consent, DND, quiet hours, caps, overrides).',
    tags: ['Compliance'],
    auth: { permission: 'compliance:read' },
    body: z.strictObject({
      userId: z.uuid(),
      eventType: z.string().regex(/^[A-Z]{4}-\d{3}$/),
      payload: z.record(z.string(), z.unknown()).optional(),
    }),
    responses: {
      200: {
        description: 'Routing plan and decisions',
        schema: z.object({
          eventType: z.string(),
          regulatoryClass: z.string(),
          priority: z.string(),
          plans: z.array(
            z.object({
              channel: z.string(),
              action: z.string(),
              viaOverride: z.boolean(),
              fallbackFor: z.string().optional(),
              releaseAt: z.string().optional(),
              reason: z.string().optional(),
              quietBypassed: z.boolean().optional(),
            }),
          ),
          decisions: z.array(
            z.object({
              channel: z.string().nullable(),
              rule: z.string(),
              outcome: z.string(),
              explanation: z.string(),
              metadata: z.record(z.string(), z.unknown()).optional(),
            }),
          ),
        }),
      },
      422: { description: 'Unknown event type or invalid payload' },
    },
    handler: async ({ body }) => {
      const def = c.taxonomy.get(body.eventType);
      if (!def)
        throw new ValidationError(
          'Unknown event type',
          [{ path: 'eventType', message: 'not registered' }],
          'UNKNOWN_EVENT_TYPE',
        );
      const payloadInput = body.payload ?? SAMPLE_PAYLOADS[def.code] ?? {};
      const v = c.taxonomy.validatePayload(def.code, payloadInput);
      if (!v.ok) throw new ValidationError('Invalid payload', v.errors, 'EVENT_SCHEMA_INVALID');
      const ctx = await c.userContext().load(body.userId);
      const plan = await c.routing().route(
        {
          eventId: `dry-run-${Date.now()}`,
          def,
          cooldownSubject: c.taxonomy.cooldownSubject(def, v.payload),
          userId: body.userId,
          userStatus: ctx.user.status,
          preferences: ctx.preferences,
          contacts: ctx.contacts,
          consents: ctx.consents,
        },
        { dryRun: true },
      );
      return {
        status: 200,
        body: {
          eventType: def.code,
          regulatoryClass: def.regulatoryClass,
          priority: def.priority,
          plans: plan.plans.map((p) => ({
            ...p,
            ...(p.releaseAt ? { releaseAt: p.releaseAt.toISOString() } : {}),
          })),
          decisions: plan.decisions,
        },
      };
    },
  });

  api.route({
    method: 'post',
    path: '/compliance/dnd/imports',
    operationId: 'importDndRegistry',
    summary:
      'Import authorised DND registry data or synthetic test fixtures (numbers are hashed, never stored)',
    tags: ['Compliance'],
    auth: { permission: 'dnd:import' },
    body: z.strictObject({
      source: z.string().min(3).max(100),
      registrySnapshotAt: z.iso.datetime({ offset: true }),
      entries: z
        .array(
          z.strictObject({
            phone: z.string().min(8).max(20),
            status: z.enum(['FULLY_BLOCKED', 'PARTIALLY_BLOCKED', 'NOT_REGISTERED']),
            blockedCategories: z.array(z.string().max(64)).max(20).default([]),
          }),
        )
        .min(1)
        .max(10000),
    }),
    responses: {
      201: { description: 'Imported', schema: z.object({ importId: z.uuid(), count: z.number() }) },
    },
    handler: async ({ body, actor }) => {
      const entries = body.entries.map((e) => ({
        phoneHash: c.users().phoneHash(normaliseContact('sms', e.phone)),
        status: e.status,
        blockedCategories: e.blockedCategories,
      }));
      const r = await c.dndSource().import({
        source: body.source,
        snapshotAt: new Date(body.registrySnapshotAt),
        importedBy: actor.id,
        entries,
      });
      await c.dndCache().invalidateAll();
      await c.audit().record({
        actorId: actor.id,
        actorRole: actor.roles.join(','),
        action: 'DND_REGISTRY_IMPORT',
        targetType: 'dnd_registry',
        targetId: r.importId,
        metadata: { source: body.source, count: r.count },
      });
      return { status: 201, body: r };
    },
  });

  api.route({
    method: 'post',
    path: '/compliance/dnd/lookup',
    operationId: 'lookupDnd',
    summary:
      'Look up the DND classification of a number (POST so the number never appears in URLs/logs)',
    tags: ['Compliance'],
    auth: { permission: 'dnd:lookup' },
    body: z.strictObject({
      phone: z.string().min(8).max(20),
      regulatoryClass: z.enum(['TRANSACTIONAL', 'SERVICE', 'PROMOTIONAL']).default('PROMOTIONAL'),
    }),
    responses: {
      200: {
        description: 'Lookup result and resulting decision',
        schema: z.object({
          status: z.string(),
          blockedCategories: z.array(z.string()),
          registryUpdatedAt: z.string().nullable(),
          stale: z.boolean(),
          cached: z.boolean(),
          source: z.string(),
          decision: z.object({ rule: z.string(), outcome: z.string(), explanation: z.string() }),
        }),
      },
    },
    handler: async ({ body }) => {
      const hash = c.users().phoneHash(normaliseContact('sms', body.phone));
      const r = await c.dnd().lookup(hash);
      const d = evaluateDnd(r, body.regulatoryClass, 'sms', c.policy.dnd);
      return {
        status: 200,
        body: {
          status: r.status,
          blockedCategories: r.blockedCategories,
          registryUpdatedAt: r.registryUpdatedAt?.toISOString() ?? null,
          stale: r.stale,
          cached: r.cached,
          source: r.source,
          decision: { rule: d.rule, outcome: d.outcome, explanation: d.explanation },
        },
      };
    },
  });

  // ---- templates -------------------------------------------------------------
  api.route({
    method: 'get',
    path: '/templates',
    operationId: 'listTemplates',
    summary: 'List templates (one per event type × channel × locale)',
    tags: ['Templates'],
    auth: { permission: 'templates:read' },
    query: z.strictObject({
      eventType: z.string().max(16).optional(),
      channel: ChannelEnum.optional(),
      locale: LocaleEnum.optional(),
    }),
    responses: {
      200: {
        description: 'Templates',
        schema: z.object({
          items: z.array(TemplateSchema),
          supportedLocales: z.array(z.string()),
          channels: z.array(z.string()),
        }),
      },
    },
    handler: async ({ query }) => ({
      status: 200,
      body: {
        items: (await c.templateRepo().list(query)).map(camel),
        supportedLocales: [...LOCALES],
        channels: [...CHANNELS],
      },
    }),
  });

  api.route({
    method: 'get',
    path: '/templates/:id/versions',
    operationId: 'listTemplateVersions',
    summary: 'All versions of a template (newest first)',
    tags: ['Templates'],
    auth: { permission: 'templates:read' },
    params: UuidParam,
    responses: {
      200: {
        description: 'Versions',
        schema: z.object({ template: TemplateSchema, versions: z.array(TemplateVersionSchema) }),
      },
      404: { description: 'Not found' },
    },
    handler: async ({ params }) => ({
      status: 200,
      body: {
        template: camel(await c.templateRepo().get(params.id)),
        versions: (await c.templateRepo().versions(params.id)).map(camel),
      },
    }),
  });

  const previewBody = z.strictObject({
    eventType: z.string().regex(/^([A-Z]{4}-\d{3}|SYS-DIGEST)$/),
    channel: ChannelEnum,
    locale: LocaleEnum.default('en'),
    timezone: z.string().default('Asia/Kolkata'),
    payload: z.record(z.string(), z.unknown()).optional(),
    userName: z.string().max(100).optional(),
    draft: z
      .strictObject({
        subject: z.string().max(500).optional(),
        title: z.string().max(500).optional(),
        body: z.string().min(1).max(5000),
      })
      .optional(),
  });

  api.route({
    method: 'post',
    path: '/templates/preview',
    operationId: 'previewTemplate',
    summary: 'Render the active template (or a draft) with sample or supplied data',
    tags: ['Templates'],
    auth: { permission: 'templates:read' },
    body: previewBody,
    responses: {
      200: { description: 'Rendered content', schema: RenderedContentSchema },
      422: { description: 'Invalid payload or template' },
    },
    handler: async ({ body }) => {
      const def = c.taxonomy.get(body.eventType);
      let data: Record<string, unknown> =
        body.eventType === DIGEST_EVENT_TYPE
          ? (body.payload ?? SAMPLE_DIGEST)
          : (body.payload ?? SAMPLE_PAYLOADS[body.eventType] ?? {});
      if (def) {
        const v = c.taxonomy.validatePayload(def.code, data);
        if (!v.ok)
          throw new ValidationError('Invalid preview payload', v.errors, 'EVENT_SCHEMA_INVALID');
        data = v.payload;
      }
      const input = {
        eventType: body.eventType,
        channel: body.channel,
        locale: body.locale,
        timezone: body.timezone,
        data,
        user: { name: body.userName ?? 'Asha' },
      };
      if (body.draft) {
        const vars = def ? Object.keys(def.fields) : ['count', 'items'];
        for (const src of [body.draft.body, body.draft.title ?? '', body.draft.subject ?? '']) {
          const check = c.templates().validate(src, vars);
          if (!check.valid)
            throw new AppError('TEMPLATE_INVALID', 422, 'Draft template is invalid', check.errors);
        }
        return {
          status: 200,
          body: c.templates().renderTemplate(
            {
              version: 0,
              subject: body.draft.subject ?? null,
              title: body.draft.title ?? null,
              body: body.draft.body,
            },
            input,
            input.locale,
          ),
        };
      }
      return { status: 200, body: await c.templates().render(input) };
    },
  });

  api.route({
    method: 'post',
    path: '/templates',
    operationId: 'createTemplateVersion',
    summary: 'Create a new template version (validated; optionally activated)',
    description:
      'Templates are validated for syntax, forbidden constructs (partials, triple-stash, unknown helpers, parent-scope access), declared variables, and SMS segment limits using sample data.',
    tags: ['Templates'],
    auth: { permission: 'templates:write' },
    body: z.strictObject({
      eventType: z.string().regex(/^([A-Z]{4}-\d{3}|SYS-DIGEST)$/),
      channel: ChannelEnum,
      locale: LocaleEnum,
      subject: z.string().max(500).optional(),
      title: z.string().max(500).optional(),
      body: z.string().min(1).max(5000),
      activate: z.boolean().default(false),
    }),
    responses: {
      201: {
        description: 'Created',
        schema: z.object({ template: TemplateSchema, version: TemplateVersionSchema }),
      },
      422: { description: 'Template invalid' },
    },
    handler: async ({ body, actor }) => {
      const def = c.taxonomy.get(body.eventType);
      if (!def && body.eventType !== DIGEST_EVENT_TYPE)
        throw new ValidationError(
          'Unknown event type',
          [{ path: 'eventType', message: 'not registered' }],
          'UNKNOWN_EVENT_TYPE',
        );
      const vars = def ? Object.keys(def.fields) : ['count', 'items'];
      const errors = [body.body, body.title ?? '', body.subject ?? ''].flatMap(
        (src) => c.templates().validate(src, vars).errors,
      );
      if (errors.length > 0)
        throw new AppError('TEMPLATE_INVALID', 422, 'Template is invalid', errors);
      if (body.channel === 'sms') {
        const sample = def ? c.taxonomy.validatePayload(def.code, SAMPLE_PAYLOADS[def.code]) : null;
        const rendered = c.templates().renderTemplate(
          { version: 0, body: body.body },
          {
            eventType: body.eventType,
            channel: 'sms',
            locale: body.locale,
            timezone: 'Asia/Kolkata',
            data: sample?.ok ? sample.payload : SAMPLE_DIGEST,
            user: { name: 'Investor' },
          },
          body.locale,
        );
        if (rendered.sms?.truncated)
          throw new AppError(
            'TEMPLATE_INVALID',
            422,
            `SMS exceeds ${c.policy.templates.smsMaxChars} characters with sample data`,
          );
      }
      const r = await c.templateRepo().createVersion({
        eventType: body.eventType,
        channel: body.channel,
        locale: body.locale,
        subject: body.subject ?? null,
        title: body.title ?? null,
        body: body.body,
        activate: body.activate,
        createdBy: actor.id,
      });
      await c.audit().record({
        actorId: actor.id,
        actorRole: actor.roles.join(','),
        action: 'TEMPLATE_VERSION_CREATED',
        targetType: 'template',
        targetId: r.template.id,
        metadata: { version: r.version.version, activated: body.activate },
      });
      return { status: 201, body: { template: camel(r.template), version: camel(r.version) } };
    },
  });

  api.route({
    method: 'post',
    path: '/templates/:id/versions/:version/activate',
    operationId: 'activateTemplateVersion',
    summary: 'Activate a template version (previous active version is retired)',
    tags: ['Templates'],
    auth: { permission: 'templates:write' },
    params: UuidParam.extend({ version: z.coerce.number().int().min(1) }),
    responses: {
      200: { description: 'Activated', schema: TemplateSchema },
      404: { description: 'Not found' },
    },
    handler: async ({ params, actor }) => {
      await c.templateRepo().activate(params.id, params.version);
      await c.audit().record({
        actorId: actor.id,
        actorRole: actor.roles.join(','),
        action: 'TEMPLATE_VERSION_ACTIVATED',
        targetType: 'template',
        targetId: params.id,
        metadata: { version: params.version },
      });
      return { status: 200, body: camel(await c.templateRepo().get(params.id)) };
    },
  });

  api.route({
    method: 'post',
    path: '/templates/:id/experiment',
    operationId: 'setTemplateExperiment',
    summary: 'Start or stop an A/B test: `percent` of users get `version` (0 stops it)',
    description:
      'Assignment is deterministic per user (hash of template id and user id), so a user always sees the same variant. The variant used is recorded on each notification (`template_version`); compare variants with GET /analytics/template-variants.',
    tags: ['Templates'],
    auth: { permission: 'templates:write' },
    params: UuidParam,
    body: z.strictObject({
      version: z.number().int().min(1).nullable(),
      percent: z.number().int().min(0).max(100),
    }),
    responses: {
      200: { description: 'Updated', schema: TemplateSchema },
      404: { description: 'Template or version not found' },
    },
    handler: async ({ params, body, actor }) => {
      await c.templateRepo().setExperiment(params.id, body.version, body.percent);
      await c.audit().record({
        actorId: actor.id,
        actorRole: actor.roles.join(','),
        action: body.percent > 0 ? 'TEMPLATE_EXPERIMENT_STARTED' : 'TEMPLATE_EXPERIMENT_STOPPED',
        targetType: 'template',
        targetId: params.id,
        metadata: body,
      });
      return { status: 200, body: camel(await c.templateRepo().get(params.id)) };
    },
  });
}
