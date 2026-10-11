import type { Knex } from 'knex';
import { blindIndex, type FieldEncryptor } from '../../common/crypto';
import { ConflictError, NotFoundError } from '../../common/errors';
import { maskContact } from '../../common/pii';
import type { Locale } from '../../domain/types';
import type { ContactSummary } from '../routing/routing-engine';
import type { UserPreferences } from '../preferences/types';
import { normaliseContact, type ContactChannel } from './contacts';

export interface UserRow {
  id: string;
  external_ref: string | null;
  display_name: string | null;
  segment: string;
  locale: Locale;
  timezone: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'ANONYMIZED';
  created_at: Date;
  updated_at: Date;
  anonymized_at: Date | null;
}

export interface ContactRow {
  id: string;
  user_id: string;
  channel: ContactChannel;
  value_ciphertext: string;
  value_hash: string;
  value_masked: string;
  verified: boolean;
  status: 'ACTIVE' | 'INVALID' | 'REMOVED';
  invalid_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface NewUser {
  externalRef?: string;
  displayName?: string;
  segment?: string;
  locale?: Locale;
  timezone?: string;
  contacts?: { channel: ContactChannel; value: string; verified?: boolean }[];
}

export interface PublicContact {
  id: string;
  channel: ContactChannel;
  masked: string;
  verified: boolean;
  status: string;
}

export class UserRepository {
  constructor(
    private readonly db: Knex,
    private readonly encryptor: FieldEncryptor,
    private readonly hashKey: string,
  ) {}

  hashContact(channel: ContactChannel, value: string): string {
    return blindIndex(
      this.hashKey,
      `${channel === 'whatsapp' ? 'sms' : channel}:${normaliseContact(channel, value)}`,
    );
  }

  /** Blind index used for DND lookups; sms and whatsapp share the phone hash. */
  phoneHash(phone: string): string {
    return this.hashContact('sms', phone);
  }

  async create(input: NewUser, trx: Knex | Knex.Transaction = this.db): Promise<UserRow> {
    const run = async (t: Knex.Transaction): Promise<UserRow> => {
      const [user] = (await t('users')
        .insert({
          external_ref: input.externalRef ?? null,
          display_name: input.displayName ?? null,
          segment: input.segment ?? 'RETAIL',
          locale: input.locale ?? 'en',
          timezone: input.timezone ?? 'Asia/Kolkata',
        })
        .returning('*')) as UserRow[];
      if (!user) throw new Error('user insert failed');
      await t('user_preferences').insert({
        user_id: user.id,
        preferences: JSON.stringify({}),
        version: 1,
        updated_by: 'system',
      });
      for (const c of input.contacts ?? [])
        await this.addContact(user.id, c.channel, c.value, c.verified ?? false, t);
      return user;
    };
    try {
      return 'commit' in trx ? await run(trx) : await this.db.transaction(run);
    } catch (err) {
      if ((err as { code?: string }).code === '23505')
        throw new ConflictError('A user with this external reference already exists');
      throw err;
    }
  }

  async get(id: string): Promise<UserRow | undefined> {
    return (await this.db('users').where({ id }).first()) as UserRow | undefined;
  }

  async require(id: string): Promise<UserRow> {
    const u = await this.get(id);
    if (!u) throw new NotFoundError('User', id);
    return u;
  }

  async addContact(
    userId: string,
    channel: ContactChannel,
    rawValue: string,
    verified = false,
    trx: Knex | Knex.Transaction = this.db,
  ): Promise<PublicContact> {
    const value = normaliseContact(channel, rawValue);
    const hash = this.hashContact(channel, value);
    const [row] = (await trx('user_contacts')
      .insert({
        user_id: userId,
        channel,
        value_ciphertext: this.encryptor.encrypt(value),
        value_hash: hash,
        value_masked: maskContact(channel, value),
        verified,
      })
      .onConflict(['user_id', 'channel', 'value_hash'])
      .merge({ status: 'ACTIVE', invalid_reason: null, verified, updated_at: trx.fn.now() })
      .returning('*')) as ContactRow[];
    if (!row) throw new Error('contact insert failed');
    return toPublicContact(row);
  }

  async listContacts(userId: string): Promise<PublicContact[]> {
    const rows = (await this.db('user_contacts')
      .where({ user_id: userId })
      .whereNot({ status: 'REMOVED' })
      .orderBy('created_at')) as ContactRow[];
    return rows.map(toPublicContact);
  }

  async removeContact(userId: string, contactId: string): Promise<void> {
    const n = await this.db('user_contacts')
      .where({ id: contactId, user_id: userId })
      .update({ status: 'REMOVED', updated_at: this.db.fn.now() });
    if (n === 0) throw new NotFoundError('Contact', contactId);
  }

  async markContactInvalid(
    contactId: string,
    reason: string,
    trx: Knex | Knex.Transaction = this.db,
  ): Promise<void> {
    await trx('user_contacts')
      .where({ id: contactId })
      .update({
        status: 'INVALID',
        invalid_reason: reason.slice(0, 200),
        updated_at: trx.fn.now(),
      });
  }

  /** Routing view of contacts: availability + phone hash, never the raw value. */
  async contactSummaries(userId: string): Promise<ContactSummary[]> {
    const rows = (await this.db('user_contacts')
      .where({ user_id: userId })
      .whereIn('status', ['ACTIVE', 'INVALID'])) as ContactRow[];
    return rows.map((r) => ({
      channel: r.channel,
      status: r.status === 'ACTIVE' ? 'ACTIVE' : 'INVALID',
      ...(r.channel === 'sms' || r.channel === 'whatsapp' ? { phoneHash: r.value_hash } : {}),
    }));
  }

  /** Decrypted active contact for delivery (most recently updated wins). */
  async activeContact(
    userId: string,
    channel: ContactChannel,
  ): Promise<{ id: string; value: string } | null> {
    const row = (await this.db('user_contacts')
      .where({ user_id: userId, channel, status: 'ACTIVE' })
      .orderBy('updated_at', 'desc')
      .first()) as ContactRow | undefined;
    if (!row) return null;
    return { id: row.id, value: this.encryptor.decrypt(row.value_ciphertext) };
  }

  async getPreferences(
    userId: string,
  ): Promise<{ version: number; preferences: UserPreferences; updatedAt: Date }> {
    const row = (await this.db('user_preferences').where({ user_id: userId }).first()) as
      | { version: number; preferences: UserPreferences; updated_at: Date }
      | undefined;
    if (!row) return { version: 0, preferences: {}, updatedAt: new Date(0) };
    return { version: row.version, preferences: row.preferences, updatedAt: row.updated_at };
  }

  /**
   * Read-modify-write under a row lock. `expectedVersion` provides optimistic
   * concurrency for API clients (If-Match); the lock serialises concurrent writers.
   */
  async updatePreferences(
    userId: string,
    mutate: (current: UserPreferences) => UserPreferences,
    actor: string,
    expectedVersion?: number,
  ): Promise<{ version: number; preferences: UserPreferences; previous: UserPreferences }> {
    return this.db.transaction(async (trx) => {
      const row = (await trx('user_preferences').where({ user_id: userId }).forUpdate().first()) as
        | { version: number; preferences: UserPreferences }
        | undefined;
      if (!row) throw new NotFoundError('User preferences', userId);
      if (expectedVersion !== undefined && expectedVersion !== row.version) {
        throw new ConflictError(`Preferences version mismatch (current ${row.version})`);
      }
      const next = mutate(structuredClone(row.preferences));
      const version = row.version + 1;
      await trx('user_preferences')
        .where({ user_id: userId })
        .update({
          preferences: JSON.stringify(next),
          version,
          updated_at: trx.fn.now(),
          updated_by: actor,
        });
      return { version, preferences: next, previous: row.preferences };
    });
  }
}

function toPublicContact(r: ContactRow): PublicContact {
  return {
    id: r.id,
    channel: r.channel,
    masked: r.value_masked,
    verified: r.verified,
    status: r.status,
  };
}
