import { OpenAPIRegistry, type RouteConfig } from '@asteasolutions/zod-to-openapi';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { currentCorrelationId } from '../common/context';
import {
  ForbiddenError,
  RateLimitedError,
  UnauthenticatedError,
  ValidationError,
} from '../common/errors';
import { metrics } from '../common/metrics';
import type { RateLimiter } from '../common/rate-limiter';
import { hasPermission, type Permission } from '../modules/auth/permissions';
import type { AuthService, Principal } from '../modules/auth/service';
import { ErrorSchema } from './schemas';

export type AuthRequirement =
  | { permission: Permission }
  | { anyOf: Permission[] }
  | 'public'
  | 'authenticated'
  | 'webhook';
export type RateScope = 'standard' | 'preferences' | 'auth' | 'webhook';

export interface RouteResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Pre-serialised non-JSON body (e.g. text/plain challenge). */
  raw?: string;
}

export interface RouteContext<P, Q, B> {
  params: P;
  query: Q;
  body: B;
  principal: Principal | null;
  /** The authenticated principal; throws for public/webhook routes. */
  readonly actor: Principal;
  req: Request;
  correlationId: string;
}

export interface RouteDef<P extends z.ZodType, Q extends z.ZodType, B extends z.ZodType> {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  operationId: string;
  summary: string;
  description?: string;
  tags: string[];
  auth: AuthRequirement;
  rateLimit?: RateScope;
  params?: P;
  query?: Q;
  body?: B;
  /**
   * Alternative request shape (PDF Appendix A contract). When `when(rawBody)` holds the
   * body is parsed with `schema` and errors use the PDF envelope (res.locals.contract).
   */
  altBody?: { when: (raw: unknown) => boolean; schema: z.ZodType };
  /** Handler receives the raw Buffer body (webhooks verify signatures over raw bytes). */
  rawBody?: boolean;
  contentType?: string;
  responses: Record<number, { description: string; schema?: z.ZodType }>;
  handler: (ctx: RouteContext<z.infer<P>, z.infer<Q>, z.infer<B>>) => Promise<RouteResult>;
}

/** Dependencies are resolved lazily so the spec can be generated without infrastructure. */
export interface ApiDeps {
  auth: () => AuthService;
  rateLimiter: () => RateLimiter;
  limits: Record<RateScope, number>;
  validateResponses: boolean;
}

const STANDARD_ERRORS: Record<number, string> = {
  400: 'Malformed request or validation failure',
  401: 'Missing, invalid or expired credentials',
  403: 'Authenticated but not authorised',
  429: 'Rate limit exceeded',
  500: 'Internal error (details are never exposed)',
};

function issues(
  err: z.ZodError,
  prefix: string,
): { path: string; message: string; code: string }[] {
  return err.issues.map((i) => ({
    path: [prefix, ...i.path.map(String)].join('.'),
    message: i.message,
    code: i.code,
  }));
}

export function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

/** Applies a Redis sliding-window limit and sets RateLimit-* headers. */
export async function enforceRateLimit(
  rl: RateLimiter,
  res: Response,
  key: string,
  limit: number,
  scope: string,
): Promise<void> {
  const r = await rl.consume(key, limit, 60000);
  res.setHeader('RateLimit-Limit', String(limit));
  res.setHeader('RateLimit-Remaining', String(r.remaining));
  res.setHeader('RateLimit-Reset', String(Math.ceil(r.resetMs / 1000)));
  if (!r.allowed) {
    metrics.rateLimited.inc({ scope });
    res.setHeader('Retry-After', String(Math.ceil(r.retryAfterMs / 1000)));
    throw new RateLimitedError(Math.ceil(r.retryAfterMs / 1000));
  }
}

/**
 * Declarative route builder: one definition registers the Express handler AND
 * its OpenAPI 3.0 operation, so the published spec cannot drift from the code.
 * In test mode every response body is validated against its declared schema.
 */
export class Api {
  readonly router: Router = express.Router();
  readonly registry = new OpenAPIRegistry();
  readonly routes: { method: string; path: string }[] = [];

  constructor(
    private readonly deps: ApiDeps,
    private readonly basePath = '/api/v1',
  ) {
    this.registry.registerComponent('securitySchemes', 'bearerAuth', {
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    });
    this.registry.register('Error', ErrorSchema);
  }

  route<
    P extends z.ZodType = z.ZodObject,
    Q extends z.ZodType = z.ZodObject,
    B extends z.ZodType = z.ZodUnknown,
  >(def: RouteDef<P, Q, B>): void {
    this.routes.push({ method: def.method, path: def.path });
    this.registerOpenApi(def);
    this.router[def.method](def.path, async (req: Request, res: Response, next: NextFunction) => {
      try {
        const principal = await this.authenticate(req, res, def);
        const params = def.params
          ? def.params.safeParse(req.params)
          : { success: true as const, data: {} };
        if (!params.success)
          throw new ValidationError('Invalid path parameters', issues(params.error, 'params'));
        const query = def.query
          ? def.query.safeParse(req.query)
          : { success: true as const, data: {} };
        if (!query.success)
          throw new ValidationError('Invalid query parameters', issues(query.error, 'query'));
        let body: unknown = req.body;
        const alt = def.altBody?.when(req.body) ? def.altBody.schema : undefined;
        if (alt) res.locals.contract = 'pdf';
        const bodySchema = alt ?? def.body;
        if (bodySchema && !def.rawBody) {
          const parsed = bodySchema.safeParse(req.body ?? {});
          if (!parsed.success)
            throw new ValidationError('Invalid request body', issues(parsed.error, 'body'));
          body = parsed.data;
        }
        const result = await def.handler({
          params: params.data as z.infer<P>,
          query: query.data as z.infer<Q>,
          body: body as z.infer<B>,
          principal,
          get actor(): Principal {
            if (!principal) throw new UnauthenticatedError();
            return principal;
          },
          req,
          correlationId: currentCorrelationId() ?? '',
        });
        for (const [k, v] of Object.entries(result.headers ?? {})) res.setHeader(k, v);
        if (result.raw !== undefined) {
          res.status(result.status).type('text/plain').send(result.raw);
          return;
        }
        if (result.body === undefined) {
          res.status(result.status).end();
          return;
        }
        if (this.deps.validateResponses) this.checkResponse(def, result);
        res.status(result.status).json(result.body);
      } catch (err) {
        next(err);
      }
    });
  }

  private checkResponse(def: RouteDef<z.ZodType, z.ZodType, z.ZodType>, result: RouteResult): void {
    const schema = def.responses[result.status]?.schema;
    if (!def.responses[result.status])
      throw new Error(`${def.operationId}: undeclared response status ${result.status}`);
    if (!schema) return;
    const parsed = schema.safeParse(JSON.parse(JSON.stringify(result.body)) as unknown);
    if (!parsed.success) {
      throw new Error(
        `${def.operationId}: response does not match OpenAPI schema: ${JSON.stringify(parsed.error.issues.slice(0, 3))}`,
      );
    }
  }

  private async authenticate(
    req: Request,
    res: Response,
    def: RouteDef<z.ZodType, z.ZodType, z.ZodType>,
  ): Promise<Principal | null> {
    const scope: RateScope = def.rateLimit ?? 'standard';
    if (def.auth === 'public' || def.auth === 'webhook') {
      await enforceRateLimit(
        this.deps.rateLimiter(),
        res,
        `${scope}:ip:${clientIp(req)}`,
        this.deps.limits[scope],
        scope,
      );
      return null;
    }
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthenticatedError();
    const principal = this.deps.auth().verifyAccessToken(header.slice(7).trim());
    await enforceRateLimit(
      this.deps.rateLimiter(),
      res,
      `${scope}:principal:${principal.id}`,
      this.deps.limits[scope],
      scope,
    );
    if (def.auth !== 'authenticated') {
      const perms = 'permission' in def.auth ? [def.auth.permission] : def.auth.anyOf;
      if (!perms.some((p) => hasPermission(principal.roles, p))) throw new ForbiddenError();
    }
    return principal;
  }

  private registerOpenApi(def: RouteDef<z.ZodType, z.ZodType, z.ZodType>): void {
    const responses: RouteConfig['responses'] = {};
    for (const [status, r] of Object.entries(def.responses)) {
      responses[status] = r.schema
        ? { description: r.description, content: { 'application/json': { schema: r.schema } } }
        : { description: r.description };
    }
    const errorStatuses =
      def.auth === 'public' || def.auth === 'webhook' ? [400, 429, 500] : [400, 401, 403, 429, 500];
    for (const s of errorStatuses) {
      responses[String(s)] ??= {
        description: STANDARD_ERRORS[s] ?? 'Error',
        content: { 'application/json': { schema: ErrorSchema } },
      };
    }
    const request: RouteConfig['request'] = {};
    if (def.params) request.params = def.params as z.ZodObject;
    if (def.query) request.query = def.query as z.ZodObject;
    if (def.body)
      request.body = {
        required: true,
        content: {
          [def.contentType ?? 'application/json']: {
            schema: def.altBody ? z.union([def.body, def.altBody.schema]) : def.body,
          },
        },
      };
    const authNote =
      typeof def.auth === 'object'
        ? `\n\n**Required permission:** ${'permission' in def.auth ? def.auth.permission : def.auth.anyOf.join(' or ')}`
        : def.auth === 'webhook'
          ? '\n\n**Authentication:** provider webhook signature'
          : '';
    this.registry.registerPath({
      method: def.method,
      path: `${this.basePath}${def.path.replace(/:([A-Za-z]+)/g, '{$1}')}`,
      operationId: def.operationId,
      summary: def.summary,
      description: `${def.description ?? ''}${authNote}`.trim() || undefined,
      tags: def.tags,
      ...(def.auth === 'public' || def.auth === 'webhook'
        ? {}
        : { security: [{ bearerAuth: [] }] }),
      request,
      responses,
    });
  }
}
