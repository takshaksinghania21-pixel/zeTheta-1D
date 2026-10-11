import type { Request } from 'express';
import { z } from 'zod';
import type { Container } from '../../container';
import { AppError, UnauthenticatedError, ValidationError } from '../../common/errors';
import { metrics } from '../../common/metrics';
import { safeEqual } from '../../common/crypto';
import { mapTwilioStatus } from '../../infrastructure/providers/twilio';
import type { DeliveryReceipt, ReceiptStatus } from '../../modules/webhooks/service';
import {
  verifyGeneric,
  verifyMeta,
  verifySharedSecret,
  verifyTwilio,
  type SignatureCheck,
} from '../../modules/webhooks/signatures';
import type { Api } from '../http';

const genericBody = z.strictObject({
  provider: z.string().min(1).max(64).optional(),
  events: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(255),
        providerMessageId: z.string().min(1).max(255),
        status: z.enum(['SENT', 'DELIVERED', 'READ', 'FAILED', 'BOUNCED']),
        occurredAt: z.iso.datetime({ offset: true }).optional(),
        errorCode: z.string().max(64).optional(),
      }),
    )
    .min(1)
    .max(500),
});

const ResultSchema = z
  .object({
    received: z.number(),
    applied: z.number(),
    duplicates: z.number(),
    unknown: z.number(),
    stale: z.number(),
  })
  .meta({ id: 'WebhookResult' });

function raw(req: Request): string {
  return Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ValidationError('Webhook body must be valid JSON');
  }
}

export function registerWebhookRoutes(api: Api, c: Container): void {
  const cfg = c.config;

  const reject = (provider: string, check: SignatureCheck): never => {
    metrics.webhooks.inc({ provider, outcome: 'rejected_signature' });
    c.logger.warn(
      { provider, reason: check.valid ? 'n/a' : check.reason },
      'webhook signature rejected',
    );
    throw new AppError('WEBHOOK_SIGNATURE_INVALID', 401, 'Invalid webhook signature');
  };

  /** Verification is mandatory unless explicitly disabled outside production. */
  const verify = (
    provider: string,
    secret: string | undefined,
    check: (secret: string) => SignatureCheck,
  ): void => {
    if (!secret) {
      if (cfg.WEBHOOK_SIGNATURE_REQUIRED)
        throw new UnauthenticatedError(`Webhook verification for ${provider} is not configured`);
      c.logger.warn(
        { provider },
        'webhook signature verification skipped (WEBHOOK_SIGNATURE_REQUIRED=false)',
      );
      return;
    }
    const result = check(secret);
    if (!result.valid) {
      if (cfg.WEBHOOK_SIGNATURE_REQUIRED) reject(provider, result);
      c.logger.warn(
        { provider },
        'invalid webhook signature accepted because verification is disabled',
      );
    }
  };

  const respond = (
    counts: Awaited<ReturnType<ReturnType<Container['webhooks']>['apply']>>,
    received: number,
  ) => ({
    status: 200,
    body: {
      received,
      applied: counts.APPLIED,
      duplicates: counts.DUPLICATE,
      unknown: counts.UNKNOWN_MESSAGE,
      stale: counts.STALE + counts.NO_CHANGE,
    },
  });

  for (const provider of ['mock', 'email'] as const) {
    api.route({
      method: 'post',
      path: `/webhooks/${provider}`,
      operationId: `${provider}Webhook`,
      summary:
        provider === 'mock'
          ? 'Delivery receipts from mock/sandbox providers (HMAC-signed)'
          : 'Delivery/bounce receipts from the SMTP relay (HMAC-signed)',
      description:
        'Header `X-Zetheta-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<rawBody>")>`; timestamps outside the tolerance window are rejected. Duplicate event ids are ignored.',
      tags: ['Webhooks'],
      auth: 'webhook',
      rateLimit: 'webhook',
      rawBody: true,
      body: genericBody,
      responses: {
        200: { description: 'Processed', schema: ResultSchema },
        401: { description: 'Missing/invalid signature' },
      },
      handler: async ({ req }) => {
        const text = raw(req);
        verify(provider, cfg.WEBHOOK_SIGNING_SECRET, (s) =>
          verifyGeneric(s, text, req.header('x-zetheta-signature'), cfg.WEBHOOK_TOLERANCE_SECONDS),
        );
        const parsed = genericBody.safeParse(parseJson(text));
        if (!parsed.success)
          throw new ValidationError(
            'Invalid webhook payload',
            parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          );
        const receipts: DeliveryReceipt[] = parsed.data.events.map((e) => ({
          providerEventId: e.id,
          providerMessageId: e.providerMessageId,
          status: e.status,
          ...(e.occurredAt ? { occurredAt: e.occurredAt } : {}),
          ...(e.errorCode ? { errorCode: e.errorCode } : {}),
        }));
        return respond(
          await c.webhooks().apply(parsed.data.provider ?? provider, receipts, text),
          receipts.length,
        );
      },
    });
  }

  api.route({
    method: 'post',
    path: '/webhooks/twilio',
    operationId: 'twilioWebhook',
    summary: 'Twilio message status callback (X-Twilio-Signature verified)',
    tags: ['Webhooks'],
    auth: 'webhook',
    rateLimit: 'webhook',
    rawBody: true,
    contentType: 'application/x-www-form-urlencoded',
    body: z.object({
      MessageSid: z.string(),
      MessageStatus: z.string(),
      ErrorCode: z.string().optional(),
    }),
    responses: {
      200: { description: 'Processed', schema: ResultSchema },
      401: { description: 'Invalid signature' },
    },
    handler: async ({ req }) => {
      const text = raw(req);
      const params = Object.fromEntries(new URLSearchParams(text).entries());
      verify('twilio', cfg.TWILIO_AUTH_TOKEN, (s) =>
        verifyTwilio(
          s,
          `${cfg.PUBLIC_BASE_URL}${req.originalUrl}`,
          params,
          req.header('x-twilio-signature'),
        ),
      );
      const sid = params.MessageSid;
      const status = mapTwilioStatus(params.MessageStatus ?? '');
      if (!sid || !['SENT', 'DELIVERED', 'READ', 'FAILED'].includes(status))
        return respond({ APPLIED: 0, DUPLICATE: 0, UNKNOWN_MESSAGE: 0, STALE: 0, NO_CHANGE: 1 }, 1);
      const receipt: DeliveryReceipt = {
        providerEventId: `${sid}:${params.MessageStatus}`,
        providerMessageId: sid,
        status: status as ReceiptStatus,
        ...(params.ErrorCode ? { errorCode: `TWILIO_${params.ErrorCode}` } : {}),
      };
      return respond(await c.webhooks().apply('twilio', [receipt], text), 1);
    },
  });

  api.route({
    method: 'post',
    path: '/webhooks/msg91',
    operationId: 'msg91Webhook',
    summary: 'MSG91 delivery reports (shared-secret header X-Webhook-Secret)',
    tags: ['Webhooks'],
    auth: 'webhook',
    rateLimit: 'webhook',
    rawBody: true,
    body: z.array(
      z.object({
        requestId: z.string(),
        report: z.array(z.object({ status: z.string(), date: z.string().optional() })),
      }),
    ),
    responses: {
      200: { description: 'Processed', schema: ResultSchema },
      401: { description: 'Invalid secret' },
    },
    handler: async ({ req }) => {
      const text = raw(req);
      verify('msg91', cfg.MSG91_WEBHOOK_SECRET, (s) =>
        verifySharedSecret(s, req.header('x-webhook-secret')),
      );
      const body = z
        .array(
          z.object({
            requestId: z.string(),
            report: z.array(z.object({ status: z.string(), date: z.string().optional() })),
          }),
        )
        .safeParse(parseJson(text));
      if (!body.success) throw new ValidationError('Invalid MSG91 payload');
      const receipts: DeliveryReceipt[] = body.data.flatMap((r) =>
        r.report.map((rep) => ({
          providerEventId: `${r.requestId}:${rep.status}:${rep.date ?? ''}`,
          providerMessageId: r.requestId,
          status: rep.status === '1' ? ('DELIVERED' as const) : ('FAILED' as const),
          ...(rep.status === '1' ? {} : { errorCode: `MSG91_${rep.status}` }),
        })),
      );
      return respond(await c.webhooks().apply('msg91', receipts, text), receipts.length);
    },
  });

  api.route({
    method: 'get',
    path: '/webhooks/whatsapp',
    operationId: 'whatsappWebhookVerify',
    summary: 'Meta webhook verification handshake',
    tags: ['Webhooks'],
    auth: 'webhook',
    rateLimit: 'webhook',
    query: z.object({
      'hub.mode': z.string(),
      'hub.verify_token': z.string(),
      'hub.challenge': z.string().max(200),
    }),
    responses: {
      200: { description: 'Echoes hub.challenge' },
      401: { description: 'Verify token mismatch' },
    },
    handler: ({ query }) => {
      if (
        !cfg.WHATSAPP_VERIFY_TOKEN ||
        query['hub.mode'] !== 'subscribe' ||
        !safeEqual(query['hub.verify_token'], cfg.WHATSAPP_VERIFY_TOKEN)
      ) {
        throw new UnauthenticatedError('Webhook verification failed');
      }
      return Promise.resolve({ status: 200, raw: query['hub.challenge'] });
    },
  });

  const waStatus = z.object({
    id: z.string(),
    status: z.string(),
    timestamp: z.string().optional(),
    errors: z.array(z.object({ code: z.number() })).optional(),
  });
  const waBody = z
    .object({
      entry: z.array(
        z.object({
          changes: z.array(
            z.object({ value: z.object({ statuses: z.array(waStatus).optional() }).loose() }),
          ),
        }),
      ),
    })
    .loose();

  api.route({
    method: 'post',
    path: '/webhooks/whatsapp',
    operationId: 'whatsappWebhook',
    summary: 'WhatsApp Cloud API status updates (X-Hub-Signature-256 verified)',
    tags: ['Webhooks'],
    auth: 'webhook',
    rateLimit: 'webhook',
    rawBody: true,
    body: waBody,
    responses: {
      200: { description: 'Processed', schema: ResultSchema },
      401: { description: 'Invalid signature' },
    },
    handler: async ({ req }) => {
      const text = raw(req);
      verify('whatsapp', cfg.WHATSAPP_APP_SECRET, (s) =>
        verifyMeta(s, text, req.header('x-hub-signature-256')),
      );
      const parsed = waBody.safeParse(parseJson(text));
      if (!parsed.success) throw new ValidationError('Invalid WhatsApp payload');
      const map: Record<string, ReceiptStatus> = {
        sent: 'SENT',
        delivered: 'DELIVERED',
        read: 'READ',
        failed: 'FAILED',
      };
      const receipts: DeliveryReceipt[] = [];
      for (const e of parsed.data.entry)
        for (const ch of e.changes)
          for (const s of ch.value.statuses ?? []) {
            const status = map[s.status];
            if (!status) continue;
            receipts.push({
              providerEventId: `${s.id}:${s.status}`,
              providerMessageId: s.id,
              status,
              ...(s.timestamp
                ? { occurredAt: new Date(Number(s.timestamp) * 1000).toISOString() }
                : {}),
              ...(s.errors?.[0] ? { errorCode: `WA_${s.errors[0].code}` } : {}),
            });
          }
      return respond(await c.webhooks().apply('whatsapp', receipts, text), receipts.length);
    },
  });
}
