import type { NotificationPolicy } from '../../config/policy';
import { NotFoundError } from '../../utils/errors';
import type { ConsentState } from '../../compliance/consent';
import type { ConsentRepository } from '../../compliance/consent-repository';
import { resolvePreferences } from '../../preferences/resolver';
import type { EffectivePreferences } from '../../preferences/types';
import type { ContactSummary } from '../routing/routing-engine';
import type { UserRepository, UserRow } from '../../database/models/user-repository';

export interface UserContext {
  user: UserRow;
  preferences: EffectivePreferences;
  preferenceVersion: number;
  contacts: ContactSummary[];
  consents: ConsentState[];
}

/** Enrichment step: everything routing needs about a user, loaded in parallel. */
export class UserContextService {
  constructor(
    private readonly users: UserRepository,
    private readonly consents: ConsentRepository,
    private readonly policy: NotificationPolicy,
  ) {}

  /** `fresh` reads preferences from PostgreSQL, bypassing the cache (dispatch re-checks). */
  async load(userId: string, options: { fresh?: boolean } = {}): Promise<UserContext> {
    const [user, prefs, contacts, consents] = await Promise.all([
      this.users.get(userId),
      this.users.getPreferences(userId, options),
      this.users.contactSummaries(userId),
      this.consents.states(userId),
    ]);
    if (!user) throw new NotFoundError('User', userId);
    return {
      user,
      preferences: resolvePreferences(this.policy, user.segment, prefs.preferences, {
        timezone: user.timezone,
        locale: user.locale,
      }),
      preferenceVersion: prefs.version,
      contacts,
      consents,
    };
  }
}
