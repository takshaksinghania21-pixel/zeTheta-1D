import { z } from 'zod';
import type { Container } from '../../container';
import { ForbiddenError, ValidationError } from '../../common/errors';
import { maskContact } from '../../common/pii';
import { CHANNELS, CONSENT_PURPOSES, SEGMENTS, type Channel } from '../../domain/types';
import { hasPermission, type Permission } from '../../modules/auth/permissions';
import type { Principal } from '../../modules/auth/service';
import { isValidTimezone, resolvePreferences } from '../../modules/preferences/resolver';
import {
  categoryPrefsSchema,
  channelPrefsSchema,
  digestPrefsSchema,
  quietHoursSchema,
  type UserPreferences,
} from '../../modules/preferences/types';
import { validateQuietWindow } from '../../modules/scheduling/quiet-hours';
import type { Api } from '../http';
import { camel } from '../mappers';
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
      .object({ capHits: z.number(), suggestedFrequency: z.string(), suggestedAt: z.string() })
      .nullable(),
    hierarchy: z.array(z.string()),
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

export function registerUserRoutes(api: Api, c: Container): void {
  const prefsResponse = async (userId: string): Promise<Record<string, unknown>> => {
    const user = await c.users().require(userId);
    const { version, preferences } = await c.users().getPreferences(userId);
    const suggestion = (await c
      .db()('digest_suggestions')
      .where({ user_id: userId })
      .whereNull('dismissed_at')
      .first()) as
      | { cap_hits: number; suggested_frequency: string; suggested_at: Date }
      | undefined;
    return {
      userId,
      version,
      explicit: preferences,
      effective: resolvePreferences(c.policy, user.segment, preferences, {
        timezone: user.timezone,
        locale: user.locale,
      }),
      digestSuggestion: suggestion
        ? {
            capHits: suggestion.cap_hits,
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
