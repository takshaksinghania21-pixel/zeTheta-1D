import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { hashSecret, randomToken, sha256Hex, verifySecret } from '../../common/crypto';
import { NotFoundError, UnauthenticatedError } from '../../common/errors';
import { ROLES, type Role } from '../../domain/types';

export interface Principal {
  id: string;
  username: string;
  roles: Role[];
  /** Linked end-user id for USER tokens. */
  userId: string | null;
}

export interface TokenPair {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  refreshToken?: string;
  refreshExpiresIn?: number;
}

const claimsSchema = z.object({
  sub: z.string(),
  usr: z.string(),
  roles: z.array(z.enum(ROLES)).min(1),
  uid: z.string().nullable().optional(),
  typ: z.literal('access'),
});

interface PrincipalRow {
  id: string;
  kind: 'HUMAN' | 'SERVICE';
  username: string;
  secret_hash: string;
  roles: Role[];
  user_id: string | null;
  status: 'ACTIVE' | 'DISABLED';
}

interface RefreshRow {
  id: string;
  principal_id: string;
  family_id: string;
  expires_at: Date;
  revoked_at: Date | null;
}

export interface AuthOptions {
  secret: string;
  issuer: string;
  audience: string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
}

/**
 * JWT (HS256) access tokens with short TTLs, opaque refresh tokens stored as
 * SHA-256 hashes, rotation on every use and family revocation on reuse.
 */
export class AuthService {
  constructor(
    private readonly db: Knex,
    private readonly opts: AuthOptions,
  ) {}

  async createPrincipal(input: {
    kind: 'HUMAN' | 'SERVICE';
    username: string;
    secret: string;
    roles: Role[];
    userId?: string | null;
  }): Promise<Principal> {
    const [row] = (await this.db('principals')
      .insert({
        kind: input.kind,
        username: input.username,
        secret_hash: await hashSecret(input.secret),
        roles: input.roles,
        user_id: input.userId ?? null,
      })
      .onConflict('username')
      .merge(['secret_hash', 'roles', 'user_id', 'kind'])
      .returning('*')) as PrincipalRow[];
    if (!row) throw new Error('principal upsert failed');
    return toPrincipal(row);
  }

  private sign(p: Principal): string {
    return jwt.sign(
      { usr: p.username, roles: p.roles, uid: p.userId, typ: 'access' },
      this.opts.secret,
      {
        algorithm: 'HS256',
        subject: p.id,
        issuer: this.opts.issuer,
        audience: this.opts.audience,
        expiresIn: this.opts.accessTtlSeconds,
        jwtid: randomUUID(),
      },
    );
  }

  verifyAccessToken(token: string): Principal {
    let decoded: unknown;
    try {
      decoded = jwt.verify(token, this.opts.secret, {
        algorithms: ['HS256'],
        issuer: this.opts.issuer,
        audience: this.opts.audience,
      });
    } catch (err) {
      throw new UnauthenticatedError(
        err instanceof jwt.TokenExpiredError ? 'Access token expired' : 'Invalid access token',
      );
    }
    const parsed = claimsSchema.safeParse(decoded);
    if (!parsed.success) throw new UnauthenticatedError('Invalid access token claims');
    return {
      id: parsed.data.sub,
      username: parsed.data.usr,
      roles: parsed.data.roles,
      userId: parsed.data.uid ?? null,
    };
  }

  private async authenticate(username: string, secret: string): Promise<PrincipalRow> {
    const row = (await this.db('principals').where({ username }).first()) as
      | PrincipalRow
      | undefined;
    // Verify against a dummy hash when the user is unknown to equalise timing.
    const ok = await verifySecret(
      secret,
      row?.secret_hash ??
        'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    );
    if (!row || !ok || row.status !== 'ACTIVE')
      throw new UnauthenticatedError('Invalid credentials');
    await this.db('principals').where({ id: row.id }).update({ last_login_at: this.db.fn.now() });
    return row;
  }

  /** Human (or end-user) login: returns an access token and a rotating refresh token. */
  async passwordGrant(username: string, password: string): Promise<TokenPair> {
    const row = await this.authenticate(username, password);
    if (row.kind !== 'HUMAN')
      throw new UnauthenticatedError('Use client_credentials for service principals');
    const p = toPrincipal(row);
    return { ...this.accessOnly(p), ...(await this.issueRefresh(p.id, randomUUID())) };
  }

  /** Service-to-service login; no refresh token (clients re-authenticate). */
  async clientCredentials(clientId: string, clientSecret: string): Promise<TokenPair> {
    const row = await this.authenticate(clientId, clientSecret);
    if (row.kind !== 'SERVICE')
      throw new UnauthenticatedError('Use the password grant for human principals');
    return this.accessOnly(toPrincipal(row));
  }

  private accessOnly(p: Principal): TokenPair {
    return {
      accessToken: this.sign(p),
      tokenType: 'Bearer',
      expiresIn: this.opts.accessTtlSeconds,
    };
  }

  private async issueRefresh(
    principalId: string,
    familyId: string,
    trx: Knex | Knex.Transaction = this.db,
  ): Promise<{ refreshToken: string; refreshExpiresIn: number; id: string }> {
    const token = randomToken(32);
    const [row] = (await trx('refresh_tokens')
      .insert({
        principal_id: principalId,
        family_id: familyId,
        token_hash: sha256Hex(token),
        expires_at: new Date(Date.now() + this.opts.refreshTtlSeconds * 1000),
      })
      .returning('id')) as { id: string }[];
    if (!row) throw new Error('refresh token insert failed');
    return { refreshToken: token, refreshExpiresIn: this.opts.refreshTtlSeconds, id: row.id };
  }

  /** Rotates a refresh token. Reusing an already-rotated token revokes the whole family. */
  async refresh(refreshToken: string): Promise<TokenPair> {
    const result = await this.db.transaction(async (trx) => {
      const row = (await trx('refresh_tokens')
        .where({ token_hash: sha256Hex(refreshToken) })
        .forUpdate()
        .first()) as RefreshRow | undefined;
      if (!row) return { error: 'Invalid refresh token' } as const;
      if (row.revoked_at) {
        await trx('refresh_tokens')
          .where({ family_id: row.family_id })
          .whereNull('revoked_at')
          .update({ revoked_at: trx.fn.now() });
        return { error: 'Refresh token reuse detected; session revoked' } as const;
      }
      if (new Date(row.expires_at).getTime() <= Date.now())
        return { error: 'Refresh token expired' } as const;
      const principal = (await trx('principals')
        .where({ id: row.principal_id, status: 'ACTIVE' })
        .first()) as PrincipalRow | undefined;
      if (!principal) return { error: 'Principal disabled' } as const;
      const next = await this.issueRefresh(principal.id, row.family_id, trx);
      await trx('refresh_tokens')
        .where({ id: row.id })
        .update({ revoked_at: trx.fn.now(), replaced_by: next.id });
      const p = toPrincipal(principal);
      return {
        pair: {
          ...this.accessOnly(p),
          refreshToken: next.refreshToken,
          refreshExpiresIn: next.refreshExpiresIn,
        },
      } as const;
    });
    // Errors are thrown after commit so family revocation is persisted.
    if ('error' in result) throw new UnauthenticatedError(result.error);
    return result.pair;
  }

  async revoke(refreshToken: string): Promise<void> {
    const row = (await this.db('refresh_tokens')
      .where({ token_hash: sha256Hex(refreshToken) })
      .first()) as RefreshRow | undefined;
    if (row)
      await this.db('refresh_tokens')
        .where({ family_id: row.family_id })
        .whereNull('revoked_at')
        .update({ revoked_at: this.db.fn.now() });
  }

  /** Short-lived USER token for an end user, minted by a trusted service (the platform's auth gateway). */
  async mintUserToken(userId: string): Promise<TokenPair> {
    const user = (await this.db('users').where({ id: userId, status: 'ACTIVE' }).first('id')) as
      | { id: string }
      | undefined;
    if (!user) throw new NotFoundError('User', userId);
    return this.accessOnly({
      id: `user:${userId}`,
      username: `user:${userId}`,
      roles: ['USER'],
      userId,
    });
  }
}

function toPrincipal(row: PrincipalRow): Principal {
  return { id: row.id, username: row.username, roles: row.roles, userId: row.user_id };
}
