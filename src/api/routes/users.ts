import { z } from 'zod';
import type { Container } from '../../container';
import { ForbiddenError, ValidationError } from '../../common/errors';
import { maskContact } from '../../common/pii';
import {
  CATEGORIES,
  CHANNELS,
  CONSENT_PURPOSES,
  SEGMENTS,
  type Category,
  type Channel,
} from '../../domain/types';
import { hasPermission, type Permission } from '../../modules/auth/permissions';
import type { Principal } from '../../modules/auth/service';
import { isValidTimezone, resolvePreferences } from '../../modules/preferences/resolver';
import {
  categoryPrefsSchema,
  channelPrefsSchema,
  digestPrefsSchema,
  quietHoursSchema,
  type EffectivePreferences,
  type UserPreferences,
} from '../../modules/preferences/types';
import { validateQuietWindow } from '../../modules/scheduling/quiet-hours';
import type { Api } from '../http';
import { camel } from '../mappers';
import { pdfChannel } from '../pdf-contract';
import { LocaleEnum, UserIdParam, UuidParam } from '../schemas';

const ContactInput = z.strictObject({
  channel: z.enum(['sms', 'email', 'push', 'whatsapp']),
  value: z.string().min(3).max(4096),
  verified: z.boolean().optional(),
});
const ContactSchema = z
  .object({
    id: z.uuid(),
    channel: z.string(),
    masked: z.string(),
    verified: z.boolean(),
    status: z.string(),
  })
  .meta({ id: 'Contact' });
const UserSchema = z
  .object({
    id: z.uuid(),
    externalRef: z.string().nullable(),
    displayName: z.string().nullable(),
    segment: z.string(),
    locale: z.string(),
    timezone: z.string(),
    status: z.string(),
    createdAt: z.string(),
    contacts: z.array(ContactSchema),
  })
  .meta({ id: 'User' });
const PreferencesResponse = z
  .object({
    userId: z.uuid(),
    version: z.number(),
    explicit: z.record(z.string(), z.unknown()),
    effective: z.object({
      channels: z.record(z.string(), z.boolean()),
      categories: z.record(
        z.string(),
        z.object({ enabled: z.boolean(), channels: z.array(z.string()).nullable() }),
      ),
      digest: z.object({
        enabled: z.boolean(),
        frequency: z.string(),
        deliveryTime: z.string(),
        categories: z.array(z.string()),
      }),
      quietHours: z.object({ enabled: z.boolean(), start: z.string(), end: z.string() }),
      timezone: z.string(),
      locale: z.string(),
      sources: z.record(z.string(), z.string()),
    }),
    digestSuggestion: z
      .object({
        notificationsInWindow: z.number(),
        suggestedFrequency: z.string(),
        suggestedAt: z.string(),
      })
      .nullable(),
    hierarchy: z.array(z.string()),
    // PDF Appendix A (p.62–63) view of the same preferences.
    user_id: z.string(),
    global_preferences: z.object({
      quiet_hours: z.object({ start: z.string(), end: z.string(), timezone: z.string() }),
      language: z.string(),
      digest_mode: z.string(),
    }),
    category_preferences: z.array(
      z.object({
        category: z.string(),
        channels: z.record(z.string(), z.boolean()),
        digest_mode: z.string(),
      }),
    ),
    regulatory_overrides: z.array(
      z.object({
        event_type: z.string(),
        channels: z.array(z.string()),
        cannot_disable: z.boolean(),
      }),
    ),
    updated_at: z.string(),
  })
  .meta({ id: 'Preferences' });
const ConsentSchema = z
  .object({
    id: z.uuid(),
    channel: z.string(),
    purpose: z.string(),
    status: z.string(),
    source: z.string(),
    evidence: z.record(z.string(), z.unknown()),
    recordedBy: z.string(),
    recordedAt: z.string(),
  })
  .meta({ id: 'ConsentRecord' });

/** Self-access for USER tokens, or the given permission for staff/service principals. */
export function assertUserAccess(
  principal: Principal,
  userId: string,
  permission: Permission,
): void {
  if (hasPermission(principal.roles, permission)) return;
  if (principal.userId === userId) return;
  throw new ForbiddenError();
}

const ifMatch = z.strictObject({ 'if-match': z.string().regex(/^\d+$/).optional() });

const DIGEST_MODES = ['immediate', 'hourly', 'daily'] as const;

// PDF Appendix A (p.63–64): one category's channels + digest mode per request.
const PdfPreferenceUpdate = z
  .strictObject({
    category: z.string().regex(/^[A-Z]{4}$/),
    channels: z.strictObject(
      Object.fromEntries(CHANNELS.map((ch) => [pdfChannel(ch), z.boolean().optional()])),
    ),
    digest_mode: z.enum(DIGEST_MODES).optional(),
  })
  .meta({ id: 'PdfPreferenceUpdate' });

/** Category prefix used by the PDF (TXNX, RISK, SIPX, MKTX, REGX). */
function categoryPrefix(c: Container, category: Category): string {
  return (
    c.taxonomy
      .list()
      .find((d) => d.category === category)
      ?.code.slice(0, 4) ?? category
  );
}

/** PDF Appendix A view of effective preferences (p.62–63). */
function pdfPreferences(
  c: Container,
  userId: string,
  e: EffectivePreferences,
  updatedAt: Date,
): Record<string, unknown> {
  const digestMode = (cat: Category): string =>
    e.digest.enabled && e.digest.categories.includes(cat)
      ? e.digest.frequency.toLowerCase()
      : 'immediate';
  return {
    user_id: userId,
    global_preferences: {
      quiet_hours: { start: e.quietHours.start, end: e.quietHours.end, timezone: e.timezone },
      language: e.locale,
      digest_mode: e.digest.enabled ? e.digest.frequency.toLowerCase() : 'none',
    },
    category_preferences: CATEGORIES.map((cat) => {
      const pref = e.categories[cat];
      return {
        category: categoryPrefix(c, cat),
        channels: Object.fromEntries(
          CHANNELS.map((ch) => [
            pdfChannel(ch),
            pref.enabled && e.channels[ch] && (pref.channels ?? CHANNELS).includes(ch),
          ]),
        ),
        digest_mode: digestMode(cat),
      };
    }),
    regulatory_overrides: c.taxonomy
      .list()
      .filter((d) => d.mandatoryChannels.length > 0)
      .map((d) => ({
        event_type: d.code,
        channels: d.mandatoryChannels.map(pdfChannel),
        cannot_disable: true,
      })),
    updated_at: new Date(updatedAt).toISOString(),
  };
}

export function registerUserRoutes(api: Api, c: Container): void {
  const prefsResponse = async (userId: string): Promise<Record<string, unknown>> => {
    const user = await c.users().require(userId);
    const { version, preferences, updatedAt } = await c.users().getPreferences(userId);
    const effective = resolvePreferences(c.policy, user.segment, preferences, {
      timezone: user.timezone,
      locale: user.locale,
    });
    const suggestion = (await c
      .db()('digest_suggestions')
      .where({ user_id: userId })
      .whereNull('dismissed_at')
      .first()) as
      | { notifications_in_window: number; suggested_frequency: string; suggested_at: Date }
      | undefined;
    return {
      userId,
      version,
      explicit: preferences,
      effective,
      digestSuggestion: suggestion
        ? {
            notificationsInWindow: suggestion.notifications_in_window,
            suggestedFrequency: suggestion.suggested_frequency,
            suggestedAt: new Date(suggestion.suggested_at).toISOString(),
          }
        : null,
      hierarchy: [
        'SYSTEM (config/notification-policy.yaml defaults)',
        `SEGMENT (${user.segment})`,
        'USER (explicit preferences)',
        'REGULATORY (per-event mandatory channels, applied at routing)',
      ],
      ...pdfPreferences(c, userId, effective, updatedAt),
    };
  };

  api.route({
    method: 'post',
    path: '/users',
    operationId: 'createUser',
    summary: 'Create a (synthetic) user with contact details (encrypted at rest)',
    tags: ['Users'],
    auth: { permission: 'users:create' },
    body: z.strictObject({
      externalRef: z.string().min(1).max(100).optional(),
      displayName: z.string().min(1).max(100).optional(),
      segment: z.enum(SEGMENTS).optional(),
      locale: LocaleEnum.optional(),
      timezone: z.string().refine(isValidTimezone, 'must be a valid IANA timezone').optional(),
      contacts: z.array(ContactInput).max(10).optional(),
    }),
    responses: {
      201: { description: 'Created', schema: UserSchema },
      409: { description: 'externalRef already exists' },
    },
    handler: async ({ body, actor }) => {
      const u = await c.users().create({
        ...(body.externalRef ? { externalRef: body.externalRef } : {}),
        ...(body.displayName ? { displayName: body.displayName } : {}),
        ...(body.segment ? { segment: body.segment } : {}),
        ...(body.locale ? { locale: body.locale } : {}),
        ...(body.timezone ? { timezone: body.timezone } : {}),
        contacts: (body.contacts ?? []).map((x) => ({
          channel: x.channel,
          value: x.value,
          verified: x.verified ?? false,
        })),
      });
      await c.audit().record({
        actorId: actor.id,
        actorRole: actor.roles.join(','),
        action: 'USER_CREATED',
        targetType: 'user',
        targetId: u.id,
      });
      return {
        status: 201,
        body: {
          ...camel(u as unknown as Record<string, unknown>),
          contacts: await c.users().listContacts(u.id),
        },
        headers: { location: `/api/v1/users/${u.id}` },
      };
    },
  });

  api.route({
    method: 'get',
    path: '/users/:userId',
    operationId: 'getUser',
    summary: 'Get a user (contact values are masked)',
    tags: ['Users'],
    auth: 'authenticated',
    params: UserIdParam,
    responses: {
      200: { description: 'User', schema: UserSchema },
      404: { description: 'Not found' },
    },
    handler: async ({ params, actor }) => {
      assertUserAccess(actor, params.userId, 'users:read');
      const u = await c.users().require(params.userId);
      const {
        anonymized_at: _a,
        updated_at: _u,
        ...rest
      } = u as unknown as Record<string, unknown>;
      return {
        status: 200,
        body: { ...camel(rest), contacts: await c.users().listContacts(u.id) },
      };
    },
  });

  api.route({
    method: 'post',
    path: '/users/:userId/contacts',
    operationId: 'addContact',
    summary: 'Add or re-activate a contact (phone/email/push token)',
    tags: ['Users'],
    auth: 'authenticated',
    params: UserIdParam,
    body: ContactInput,
    responses: { 201: { description: 'Contact', schema: ContactSchema } },
    handler: async ({ params, body, actor }) => {
      assertUserAccess(actor, params.userId, 'users:write');
      await c.users().require(params.userId);
      const contact = await c
        .users()
        .addContact(params.userId, body.channel, body.value, body.verified ?? false);
      await c.audit().record({
        actorId: actor.id,
        actorRole: actor.roles.join(','),
        action: 'CONTACT_ADDED',
        targetType: 'user',
        targetId: params.userId,
        metadata: { channel: body.channel, masked: maskContact(body.channel, body.value) },
      });
      return { status: 201, body: contact };
    },
  });

  api.route({
    method: 'delete',
    path: '/users/:userId/contacts/:id',
    operationId: 'removeContact',
    summary: 'Remove a contact',
    tags: ['Users'],
    auth: 'authenticated',
    params: UserIdParam.extend(UuidParam.shape),
    responses: { 204: { description: 'Removed' }, 404: { description: 'Not found' } },
    handler: async ({ params, actor }) => {
      assertUserAccess(actor, params.userId, 'users:write');
      await c.users().removeContact(params.userId, params.id);
      return { status: 204 };
    },
  });

  api.route({
    method: 'post',
    path: '/users/:userId/anonymize',
    operationId: 'anonymizeUser',
    summary: 'Irreversibly anonymise a user (right to erasure); audited',
    description:
      'Removes name and contact details, scrubs rendered notification content and event payloads, revokes sessions. Delivery metadata (states, timestamps, costs) and the consent ledger are retained for analytics and compliance evidence.',
    tags: ['Users'],
    auth: { permission: 'users:anonymize' },
    params: UserIdParam,
    body: z.strictObject({ reason: z.string().min(3).max(200) }),
    responses: {
      200: {
        description: 'Anonymised',
        schema: z.object({
          userId: z.uuid(),
          anonymizedAt: z.string(),
          scrubbed: z.record(z.string(), z.number()),
        }),
      },
    },
    handler: async ({ params, body, actor }) => {
      const result = await c.db().transaction(async (trx) => {
        const user = (await trx('users').where({ id: params.userId }).forUpdate().first()) as
          | { status: string }
          | undefined;
        if (!user)
          throw new ValidationError('Unknown user', [{ path: 'userId', message: 'not found' }]);
        const now = new Date();
        await trx('users').where({ id: params.userId }).update({
          display_name: null,
          external_ref: null,
          status: 'ANONYMIZED',
          anonymized_at: now,
          updated_at: now,
        });
        const contacts = await trx('user_contacts').where({ user_id: params.userId }).del();
        const notifications = await trx('notifications')
          .where({ user_id: params.userId })
          .update({ content: null, last_error_message: null, scrubbed_at: now });
        const events = await trx('financial_events')
          .where({ user_id: params.userId })
          .update({ payload: JSON.stringify({}), scrubbed_at: now });
        await trx('user_preferences')
          .where({ user_id: params.userId })
          .update({ preferences: JSON.stringify({}), version: trx.raw('version + 1') });
        await trx('principals').where({ user_id: params.userId }).update({ status: 'DISABLED' });
        await trx('scheduled_notifications')
          .where({ user_id: params.userId, status: 'PENDING' })
          .update({ status: 'CANCELLED' });
        await c.audit().record(
          {
            actorId: actor.id,
            actorRole: actor.roles.join(','),
            action: 'USER_ANONYMIZED',
            targetType: 'user',
            targetId: params.userId,
            metadata: { reason: body.reason, contacts, notifications, events },
          },
          trx,
        );
        return { anonymizedAt: now.toISOString(), scrubbed: { contacts, notifications, events } };
      });
      return { status: 200, body: { userId: params.userId, ...result } };
    },
  });

  // ---- preferences ---------------------------------------------------------
  api.route({
    method: 'get',
    path: '/users/:userId/preferences',
    operationId: 'getPreferences',
    summary: 'Explicit and effective (resolved) preferences with the source of each value',
    tags: ['Preferences'],
    auth: 'authenticated',
    params: UserIdParam,
    responses: { 200: { description: 'Preferences', schema: PreferencesResponse } },
    handler: async ({ params, actor }) => {
      assertUserAccess(actor, params.userId, 'preferences:read:any');
      return {
        status: 200,
        body: await prefsResponse(params.userId),
        headers: { etag: String((await c.users().getPreferences(params.userId)).version) },
      };
    },
  });

  api.route({
    method: 'put',
    path: '/users/:userId/preferences',
    operationId: 'updateCategoryPreferencesPdf',
    summary: 'Update one category (PDF Appendix A shape): channels and digest mode',
    description:
      'Mandatory (regulatory) channels cannot be disabled; the response lists warnings for the events the change affects. Rate limited to 10 requests/minute per principal.',
    tags: ['Preferences'],
    auth: 'authenticated',
    rateLimit: 'preferences',
    params: UserIdParam,
    body: PdfPreferenceUpdate,
    responses: {
      200: {
        description: 'Updated',
        schema: z.object({
          status: z.literal('updated'),
          category: z.string(),
          warnings: z.array(z.string()),
          cache_invalidated: z.boolean(),
          updated_at: z.string(),
        }),
      },
    },
    handler: async ({ params, body, actor }) => {
      assertUserAccess(actor, params.userId, 'preferences:write:any');
      const category = CATEGORIES.find((cat) => categoryPrefix(c, cat) === body.category);
      if (!category)
        throw new ValidationError('Unknown category', [
          { path: 'body.category', message: 'must be one of TXNX, RISK, SIPX, MKTX, REGX' },
        ]);
      await c.users().require(params.userId);
      const res = await c.users().updatePreferences(
        params.userId,
        (p) => {
          const current = p.categories?.[category]?.channels ?? null;
          const base = current ?? [...CHANNELS];
          const channels = CHANNELS.filter(
            (ch) => body.channels[pdfChannel(ch)] ?? base.includes(ch),
          );
          const next: UserPreferences = {
            ...p,
            categories: { ...p.categories, [category]: { ...p.categories?.[category], channels } },
          };
          if (body.digest_mode) {
            const d = p.digest ?? c.policy.defaults.digest;
            const cats = d.categories.filter((x) => x !== category);
            next.digest =
              body.digest_mode === 'immediate'
                ? { ...d, categories: cats }
                : {
                    ...d,
                    enabled: true,
                    frequency: body.digest_mode === 'hourly' ? 'HOURLY' : 'DAILY',
                    categories: [...cats, category],
                  };
          }
          return next;
        },
        actor.id,
      );
      const disabled = CHANNELS.filter((ch) => body.channels[pdfChannel(ch)] === false);
      const defs = c.taxonomy.list().filter((d) => d.category === category);
      const warnings = disabled.flatMap((ch) => {
        const affected = defs.filter((d) => d.defaultChannels.includes(ch));
        const label = {
          sms: 'SMS',
          email: 'Email',
          push: 'Push',
          whatsapp: 'WhatsApp',
          inapp: 'In-app',
        }[ch];
        if (affected.length === 0) return [];
        const mandatory = affected.filter((d) => d.mandatoryChannels.includes(ch));
        return [
          `${label} disabled for ${body.category} — you will not receive ${
            affected
              .filter((d) => !mandatory.includes(d))
              .map((d) => `${d.name} (${d.code})`)
              .join(', ') || 'non-mandatory notifications'
          } via ${pdfChannel(ch)}.` +
            (mandatory.length > 0
              ? ` Regulatory notifications (${mandatory.map((d) => d.code).join(', ')}) will still be delivered via mandatory channels.`
              : ''),
        ];
      });
      await c.audit().record({
        actorId: actor.id,
        actorRole: actor.roles.join(','),
        action: 'PREFERENCES_UPDATECATEGORYPREFERENCESPDF',
        targetType: 'user',
        targetId: params.userId,
        metadata: { version: res.version, category: body.category, disabled },
      });
      if (disabled.length > 0)
        await c
          .db()('opt_out_events')
          .insert(
            disabled.map((ch) => ({ user_id: params.userId, channel: ch, source: 'PREFERENCE' })),
          );
      return {
        status: 200,
        body: {
          status: 'updated',
          category: body.category,
          warnings,
          cache_invalidated: res.cacheInvalidated,
          updated_at: res.updatedAt.toISOString(),
        },
        headers: { etag: String(res.version) },
      };
    },
  });

  const update = (
    path: string,
    operationId: string,
    summary: string,
    body: z.ZodType,
    apply: (prefs: UserPreferences, value: never) => UserPreferences,
    validate?: (value: never) => void,
  ): void => {
    api.route({
      method: 'put',
      path: `/users/:userId/preferences/${path}`,
      operationId,
      summary,
      description:
        'Optional `If-Match: <version>` header enables optimistic concurrency (409 on mismatch). Rate limited to 10 requests/minute per principal.',
      tags: ['Preferences'],
      auth: 'authenticated',
      rateLimit: 'preferences',
      params: UserIdParam,
      body,
      responses: {
        200: { description: 'Updated preferences', schema: PreferencesResponse },
        409: { description: 'Version mismatch' },
      },
      handler: async ({ params, body: value, actor, req }) => {
        assertUserAccess(actor, params.userId, 'preferences:write:any');
        validate?.(value as never);
        const header = ifMatch.safeParse({ 'if-match': req.headers['if-match'] });
        const expected =
          header.success && header.data['if-match'] ? Number(header.data['if-match']) : undefined;
        await c.users().require(params.userId);
        const res = await c
          .users()
          .updatePreferences(params.userId, (p) => apply(p, value as never), actor.id, expected);
        // Record opt-outs (channel switched off) for the opt-out analytics.
        const before = res.previous.channels ?? {};
        const after = res.preferences.channels ?? {};
        const optOuts = (Object.keys(after) as Channel[]).filter(
          (ch) => after[ch] === false && before[ch] !== false,
        );
        if (optOuts.length > 0)
          await c
            .db()('opt_out_events')
            .insert(
              optOuts.map((ch) => ({ user_id: params.userId, channel: ch, source: 'PREFERENCE' })),
            );
        await c.audit().record({
          actorId: actor.id,
          actorRole: actor.roles.join(','),
          action: `PREFERENCES_${operationId.toUpperCase()}`,
          targetType: 'user',
          targetId: params.userId,
          metadata: { version: res.version },
        });
        return {
          status: 200,
          body: await prefsResponse(params.userId),
          headers: { etag: String(res.version) },
        };
      },
    });
  };

  update(
    'channels',
    'updateChannelPreferences',
    'Enable/disable delivery channels',
    channelPrefsSchema,
    (p, v: z.infer<typeof channelPrefsSchema>) => ({ ...p, channels: { ...p.channels, ...v } }),
  );
  update(
    'categories',
    'updateCategoryPreferences',
    'Enable/disable event categories and per-category channels',
    categoryPrefsSchema,
    (p, v: z.infer<typeof categoryPrefsSchema>) => ({
      ...p,
      categories: { ...p.categories, ...v },
    }),
  );
  update(
    'digest',
    'updateDigestPreferences',
    'Configure digest batching for low-priority categories',
    digestPrefsSchema,
    (p, v: z.infer<typeof digestPrefsSchema>) => ({ ...p, digest: v }),
  );
  const quietBody = quietHoursSchema.extend({ timezone: z.string().optional() });
  update(
    'quiet-hours',
    'updateQuietHours',
    'Configure quiet hours (minimum 6 hours) and IANA timezone',
    quietBody,
    (p, v: z.infer<typeof quietBody>) => {
      const { timezone, ...window } = v;
      return { ...p, quietHours: window, ...(timezone ? { timezone } : {}) };
    },
    (v: z.infer<typeof quietBody>) => {
      if (v.timezone && !isValidTimezone(v.timezone))
        throw new ValidationError('Invalid timezone', [
          { path: 'body.timezone', message: 'must be a valid IANA timezone' },
        ]);
      const err = validateQuietWindow(v, c.policy.quietHours.minimumWindowMinutes);
      if (err) throw new ValidationError('Invalid quiet hours', [{ path: 'body', message: err }]);
    },
  );
  update(
    'locale',
    'updateLocale',
    'Set the preferred notification language',
    z.strictObject({ locale: LocaleEnum }),
    (p, v: { locale: UserPreferences['locale'] }) => ({
      ...p,
      ...(v.locale ? { locale: v.locale } : {}),
    }),
  );

  // ---- consent ---------------------------------------------------------------
  api.route({
    method: 'get',
    path: '/users/:userId/consents',
    operationId: 'getConsents',
    summary: 'Current consent state per channel/purpose and the full audit history',
    tags: ['Consent'],
    auth: 'authenticated',
    params: UserIdParam,
    responses: {
      200: {
        description: 'Consents',
        schema: z.object({
          current: z.array(
            z.object({
              channel: z.string(),
              purpose: z.string(),
              status: z.string(),
              recordedAt: z.string(),
              source: z.string(),
            }),
          ),
          history: z.array(ConsentSchema),
        }),
      },
    },
    handler: async ({ params, actor }) => {
      assertUserAccess(actor, params.userId, 'consent:read:any');
      const [current, history] = await Promise.all([
        c.consents().states(params.userId),
        c.consents().history(params.userId),
      ]);
      return {
        status: 200,
        body: {
          current: current.map((s) => ({ ...s, recordedAt: s.recordedAt.toISOString() })),
          history: history.map(camel),
        },
      };
    },
  });

  api.route({
    method: 'post',
    path: '/users/:userId/consents',
    operationId: 'recordConsent',
    summary: 'Record a consent change (append-only ledger with timestamp, source and evidence)',
    description:
      'WhatsApp requires its own explicit opt-in (channel=whatsapp). Promotional messages require purpose=PROMOTIONAL consent per channel.',
    tags: ['Consent'],
    auth: 'authenticated',
    params: UserIdParam,
    body: z.strictObject({
      channel: z.enum(CHANNELS),
      purpose: z.enum(CONSENT_PURPOSES),
      status: z.enum(['GRANTED', 'REVOKED']),
      source: z.enum(['APP', 'WEB', 'SMS_REPLY', 'SUPPORT', 'IMPORT', 'API']),
      evidence: z
        .record(z.string(), z.union([z.string().max(500), z.number(), z.boolean()]))
        .optional(),
    }),
    responses: { 201: { description: 'Recorded', schema: ConsentSchema } },
    handler: async ({ params, body, actor }) => {
      assertUserAccess(actor, params.userId, 'consent:write:any');
      await c.users().require(params.userId);
      const row = await c.consents().record({
        userId: params.userId,
        channel: body.channel,
        purpose: body.purpose,
        status: body.status,
        source: body.source,
        evidence: body.evidence ?? {},
        recordedBy: actor.id,
      });
      await c.audit().record({
        actorId: actor.id,
        actorRole: actor.roles.join(','),
        action: `CONSENT_${body.status}`,
        targetType: 'user',
        targetId: params.userId,
        metadata: { channel: body.channel, purpose: body.purpose, source: body.source },
      });
      return { status: 201, body: camel(row as unknown as Record<string, unknown>) };
    },
  });
}
