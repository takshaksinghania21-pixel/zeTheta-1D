import { OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';
import cors from 'cors';
import express, { type ErrorRequestHandler, type Express, type RequestHandler } from 'express';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { Api } from './api/http';
import { registerAuthAndEventRoutes } from './api/routes/auth-events';
import { registerComplianceAndTemplateRoutes } from './api/routes/compliance-templates';
import { registerNotificationRoutes } from './api/routes/notifications';
import { registerOpsRoutes } from './api/routes/ops';
import { registerUserRoutes } from './api/routes/users';
import { registerWebhookRoutes } from './api/routes/webhooks';
import { CORRELATION_HEADER, normaliseCorrelationId, runWithContext } from './common/context';
import { AppError, RateLimitedError } from './common/errors';
import { metrics, registry } from './common/metrics';
import type { Container } from './container';
import { redisHealthy } from './infrastructure/redis/redis';

export interface ReadinessCheck {
  name: string;
  check: () => Promise<boolean>;
}

const PKG_VERSION = '1.0.0';

export function buildOpenApi(api: Api, serverUrl = '/'): object {
  return new OpenApiGeneratorV3(api.registry.definitions).generateDocument({
    openapi: '3.0.3',
    info: {
      title: 'Zetheta Notification Engine API',
      version: PKG_VERSION,
      description:
        'Event-driven financial notification engine (BE-6B). All endpoints are versioned under /api/v1. Errors use the `Error` schema and carry the request correlation id (`X-Correlation-Id`).',
    },
    servers: [{ url: serverUrl }],
    tags: [
      'Auth',
      'Events',
      'Taxonomy',
      'Notifications',
      'Delivery',
      'Users',
      'Preferences',
      'Consent',
      'Compliance',
      'Templates',
      'Webhooks',
      'DLQ',
      'Operations',
      'Analytics',
      'Security',
    ].map((name) => ({ name })),
  });
}

export function createApi(c: Container): Api {
  const api = new Api({
    auth: () => c.auth(),
    rateLimiter: () => c.rateLimiter(),
    limits: {
      standard: c.config.RATE_LIMIT_STANDARD_PER_MIN,
      preferences: c.config.RATE_LIMIT_PREFERENCES_PER_MIN,
      webhook: c.config.RATE_LIMIT_WEBHOOK_PER_MIN,
      auth: Math.max(10, Math.floor(c.config.RATE_LIMIT_STANDARD_PER_MIN / 5)),
    },
    validateResponses: c.config.NODE_ENV !== 'production',
  });
  registerAuthAndEventRoutes(api, c);
  registerNotificationRoutes(api, c);
  registerUserRoutes(api, c);
  registerComplianceAndTemplateRoutes(api, c);
  registerWebhookRoutes(api, c);
  registerOpsRoutes(api, c);
  return api;
}

export function readinessChecks(c: Container): ReadinessCheck[] {
  return [
    { name: 'postgres', check: async () => (await c.db().raw('select 1 as ok')) !== undefined },
    { name: 'redis', check: () => redisHealthy(c.redis()) },
    {
      name: 'rabbitmq',
      check: async () => {
        await c.rabbit().connect();
        return c.rabbit().connected;
      },
    },
    {
      name: 'kafka',
      check: async () => {
        const admin = c.kafka().admin();
        try {
          await admin.connect();
          await admin.describeCluster();
          return true;
        } finally {
          await admin.disconnect().catch(() => undefined);
        }
      },
    },
  ];
}

async function runChecks(
  checks: ReadinessCheck[],
): Promise<{ ok: boolean; results: Record<string, string> }> {
  const results: Record<string, string> = {};
  await Promise.all(
    checks.map(async (ch) => {
      try {
        const ok = await Promise.race([
          ch.check(),
          new Promise<boolean>((r) =>
            setTimeout(() => {
              r(false);
            }, 3000).unref(),
          ),
        ]);
        results[ch.name] = ok ? 'up' : 'down';
      } catch {
        results[ch.name] = 'down';
      }
    }),
  );
  return { ok: Object.values(results).every((v) => v === 'up'), results };
}

const correlation: RequestHandler = (req, res, next) => {
  const id = normaliseCorrelationId(req.header(CORRELATION_HEADER));
  res.setHeader('X-Correlation-Id', id);
  runWithContext({ correlationId: id }, next);
};

export function createApp(
  c: Container,
  options: { readiness?: ReadinessCheck[]; isShuttingDown?: () => boolean } = {},
): { app: Express; api: Api } {
  const app = express();
  const log = c.logger.child({ component: 'http' });
  const tp = c.config.TRUST_PROXY;
  app.set(
    'trust proxy',
    tp === 'true' ? true : tp === 'false' ? false : /^\d+$/.test(tp) ? Number(tp) : tp,
  );
  app.disable('x-powered-by');
  app.use(correlation);
  app.use((req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const route = (req.route as { path?: string } | undefined)?.path ?? 'unmatched';
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      metrics.httpRequests.inc({ method: req.method, route, status: String(res.statusCode) });
      metrics.httpDuration.observe({ method: req.method, route }, seconds);
      if (req.path !== '/health/live' && req.path !== '/metrics') {
        log.info(
          {
            method: req.method,
            path: req.path,
            status: res.statusCode,
            durationMs: Math.round(seconds * 1000),
          },
          'http request',
        );
      }
    });
    next();
  });
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(
    cors({
      origin: (origin, cb) => {
        cb(null, !origin || c.config.CORS_ORIGINS.includes(origin));
      },
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['Authorization', 'Content-Type', 'If-Match', 'X-Correlation-Id'],
      exposedHeaders: [
        'X-Correlation-Id',
        'RateLimit-Limit',
        'RateLimit-Remaining',
        'RateLimit-Reset',
        'Retry-After',
        'ETag',
        'Location',
      ],
      maxAge: 600,
    }),
  );
  // Webhooks need the exact raw bytes for signature verification.
  app.use('/api/v1/webhooks', express.raw({ type: '*/*', limit: '256kb' }));
  app.use(express.json({ limit: '1mb', strict: true }));

  const checks = options.readiness ?? readinessChecks(c);
  app.get('/health/live', (_req, res) => {
    res.json({
      status: 'ok',
      service: c.config.SERVICE_NAME,
      uptimeSeconds: Math.round(process.uptime()),
    });
  });
  const ready: RequestHandler = (_req, res, next) => {
    if (options.isShuttingDown?.()) {
      res.status(503).json({ status: 'shutting_down' });
      return;
    }
    runChecks(checks)
      .then((r) =>
        res
          .status(r.ok ? 200 : 503)
          .json({ status: r.ok ? 'ready' : 'not_ready', checks: r.results }),
      )
      .catch(next);
  };
  app.get('/health/ready', ready);
  app.get('/api/v1/health/ready', ready);
  app.get('/metrics', (_req, res, next) => {
    registry
      .metrics()
      .then((body) => res.type(registry.contentType).send(body))
      .catch(next);
  });

  const api = createApi(c);
  const spec = buildOpenApi(api);
  app.get('/api/v1/openapi.json', (_req, res) => {
    res.json(spec);
  });
  app.use(
    '/api/docs',
    swaggerUi.serve,
    swaggerUi.setup(spec, { customSiteTitle: 'Zetheta Notification Engine API' }),
  );
  app.use('/api/v1', api.router);

  app.use((req, res) => {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: `Route ${req.method} ${req.path} not found`,
        correlationId: res.getHeader('X-Correlation-Id'),
      },
    });
  });

  const errorHandler: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
    const correlationId = res.getHeader('X-Correlation-Id');
    if (err instanceof AppError && err.expose) {
      if (err instanceof RateLimitedError)
        res.setHeader('Retry-After', String(err.retryAfterSeconds));
      res.status(err.httpStatus).json({
        error: {
          code: err.code,
          message: err.message,
          ...(err.details.length ? { details: err.details } : {}),
          correlationId,
        },
      });
      return;
    }
    const e = err as { type?: string; status?: number };
    if (e.type === 'entity.parse.failed') {
      res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Malformed JSON body', correlationId },
      });
      return;
    }
    if (e.type === 'entity.too.large') {
      res.status(413).json({
        error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large', correlationId },
      });
      return;
    }
    log.error({ err }, 'unhandled request error');
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'An internal error occurred', correlationId },
    });
  };
  app.use(errorHandler);
  return { app, api };
}
