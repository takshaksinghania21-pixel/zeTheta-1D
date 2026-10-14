/**
 * Development seed: templates (all events × channels × locales), principals,
 * synthetic users with contacts/preferences/consents and DND fixtures.
 * Synthetic data only. Generated credentials are written to
 * .local/seed-credentials.json (git-ignored, mode 0600) — never printed.
 */
import 'dotenv/config';
import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomToken } from '../../utils/crypto';
import { loadConfig } from '../../config/env';
import { Container } from '../../container';
import type { Role } from '../../utils/types';
import { loadTemplateSources } from '../../templates/definitions/source';
import { LANGUAGE_WEIGHTS, prng, quota, syntheticUser } from './synthetic';

interface Credentials {
  admin: { username: string; password: string };
  operator: { username: string; password: string };
  service: { clientId: string; clientSecret: string };
  demoUser: { username: string; password: string; userId: string };
}

export const SEED_USERS = [
  {
    externalRef: 'seed-asha',
    displayName: 'Asha Rao',
    segment: 'RETAIL',
    locale: 'en',
    timezone: 'Asia/Kolkata',
    phone: '+919800000001',
    email: 'asha@example.test',
    push: 'fcm-test-token-asha-0000000000000001',
  },
  {
    externalRef: 'seed-vikram',
    displayName: 'Vikram Shah',
    segment: 'HNI',
    locale: 'hi',
    timezone: 'Asia/Kolkata',
    phone: '+919800000002',
    email: 'vikram@example.test',
    push: 'fcm-test-token-vikram-000000000000002',
  },
  {
    externalRef: 'seed-meera',
    displayName: 'Meera Iyer',
    segment: 'NEW_INVESTOR',
    locale: 'ta',
    timezone: 'Asia/Kolkata',
    phone: '+919800000003',
    email: 'meera@example.test',
    push: 'fcm-test-token-meera-0000000000000003',
  },
  {
    externalRef: 'seed-ravi',
    displayName: 'Ravi Kulkarni',
    segment: 'RETAIL',
    locale: 'mr',
    timezone: 'Asia/Kolkata',
    phone: '+919800000004',
    email: 'ravi@example.test',
    push: 'fcm-test-token-ravi-00000000000000004',
  },
  {
    externalRef: 'seed-lakshmi',
    displayName: 'Lakshmi Reddy',
    segment: 'DORMANT',
    locale: 'te',
    timezone: 'Asia/Kolkata',
    phone: '+919800000005',
    email: 'lakshmi@example.test',
    push: 'fcm-test-token-lakshmi-000000000000005',
  },
  {
    externalRef: 'seed-nyc',
    displayName: 'Sam Patel',
    segment: 'RETAIL',
    locale: 'en',
    timezone: 'America/New_York',
    phone: '+12025550106',
    email: 'sam@example.test',
    push: 'fcm-test-token-sam-000000000000000006',
  },
] as const;

async function main(): Promise<void> {
  const c = new Container(loadConfig());
  const db = c.db();
  const credsPath = path.resolve(process.cwd(), '.local/seed-credentials.json');
  try {
    const templates = await c.templateRepo().seed(loadTemplateSources());
    await c.registry().sync();

    const existing: Partial<Credentials> = existsSync(credsPath)
      ? (JSON.parse(readFileSync(credsPath, 'utf8')) as Partial<Credentials>)
      : {};
    // Explicit SEED_* environment values win (containers); otherwise reuse or generate.
    const env = process.env;
    const creds: Credentials = {
      admin: {
        username: 'admin',
        password: env.SEED_ADMIN_PASSWORD || existing.admin?.password || randomToken(18),
      },
      operator: {
        username: 'operator',
        password: env.SEED_OPERATOR_PASSWORD || existing.operator?.password || randomToken(18),
      },
      service: {
        clientId: 'trading-platform',
        clientSecret: env.SEED_SERVICE_SECRET || existing.service?.clientSecret || randomToken(24),
      },
      demoUser: {
        username: 'asha',
        password: env.SEED_DEMO_USER_PASSWORD || existing.demoUser?.password || randomToken(18),
        userId: '',
      },
    };
    const principal = (
      kind: 'HUMAN' | 'SERVICE',
      username: string,
      secret: string,
      roles: Role[],
      userId?: string,
    ) => c.auth().createPrincipal({ kind, username, secret, roles, ...(userId ? { userId } : {}) });
    await principal('HUMAN', creds.admin.username, creds.admin.password, ['ADMIN']);
    await principal('HUMAN', creds.operator.username, creds.operator.password, ['OPERATOR']);
    await principal('SERVICE', creds.service.clientId, creds.service.clientSecret, ['SERVICE']);

    let created = 0;
    const ids: Record<string, string> = {};
    for (const u of SEED_USERS) {
      let row = (await db('users').where({ external_ref: u.externalRef }).first('id')) as
        | { id: string }
        | undefined;
      if (!row) {
        row = await c.users().create({
          externalRef: u.externalRef,
          displayName: u.displayName,
          segment: u.segment,
          locale: u.locale,
          timezone: u.timezone,
          contacts: [
            { channel: 'sms', value: u.phone, verified: true },
            { channel: 'whatsapp', value: u.phone, verified: true },
            { channel: 'email', value: u.email, verified: true },
            { channel: 'push', value: u.push, verified: true },
          ],
        });
        created++;
        // HNI users opt in to WhatsApp; Asha opts in to promotional push/email.
        if (u.segment === 'HNI') {
          await c.consents().record({
            userId: row.id,
            channel: 'whatsapp',
            purpose: 'TRANSACTIONAL',
            status: 'GRANTED',
            source: 'APP',
            recordedBy: 'seed',
          });
        }
        if (u.externalRef === 'seed-asha') {
          for (const channel of ['push', 'email', 'sms'] as const) {
            await c.consents().record({
              userId: row.id,
              channel,
              purpose: 'PROMOTIONAL',
              status: 'GRANTED',
              source: 'APP',
              recordedBy: 'seed',
            });
          }
        }
      }
      ids[u.externalRef] = row.id;
    }
    creds.demoUser.userId = ids['seed-asha'] ?? '';
    await principal(
      'HUMAN',
      creds.demoUser.username,
      creds.demoUser.password,
      ['USER'],
      creds.demoUser.userId,
    );

    // PDF Day 2: 1 000 synthetic users with varied preferences (SEED_BULK_USERS overrides).
    const bulk = Number(env.SEED_BULK_USERS ?? 1000);
    const rand = prng(42);
    const locales = quota(bulk, LANGUAGE_WEIGHTS, rand);
    const dndBulk: string[] = [];
    let bulkCreated = 0;
    for (const [i, locale] of locales.entries()) {
      const u = syntheticUser(i + 1, locale, rand);
      if (i % 10 < 3) dndBulk.push(u.phone); // 30% DND-registered, as in the §B4 dataset
      const externalRef = `seed-bulk-${u.index}`;
      if (await db('users').where({ external_ref: externalRef }).first('id')) continue;
      const user = await c.users().create({
        externalRef,
        displayName: u.name,
        segment: u.segment,
        locale: u.locale,
        timezone: 'Asia/Kolkata',
        contacts: [
          { channel: 'sms', value: u.phone, verified: true },
          { channel: 'email', value: u.email, verified: true },
          { channel: 'push', value: u.pushToken, verified: true },
        ],
      });
      await c.users().updatePreferences(
        user.id,
        (p) => ({
          ...p,
          quietHours: u.quietHours,
          channels: Object.fromEntries(u.channelsOff.map((ch) => [ch, false])),
          ...(u.disabledCategory
            ? { categories: { [u.disabledCategory]: { enabled: false } } }
            : {}),
          ...(u.digest
            ? {
                digest: {
                  enabled: true,
                  frequency: 'DAILY',
                  deliveryTime: '08:00',
                  categories: ['MARKET'],
                },
              }
            : {}),
        }),
        'seed',
      );
      bulkCreated++;
    }
    created += bulkCreated;

    // Synthetic DND fixture: Ravi's number is fully registered; Meera blocks the financial category;
    // 30% of the bulk users are registered.
    const dnd = await c.dndSource().import({
      source: 'synthetic-fixture',
      snapshotAt: new Date(),
      importedBy: 'seed',
      entries: [
        ...dndBulk.map((phone) => ({
          phoneHash: c.users().phoneHash(phone),
          status: 'FULLY_BLOCKED' as const,
          blockedCategories: [],
        })),
        {
          phoneHash: c.users().phoneHash('+919800000004'),
          status: 'FULLY_BLOCKED',
          blockedCategories: [],
        },
        {
          phoneHash: c.users().phoneHash('+919800000003'),
          status: 'PARTIALLY_BLOCKED',
          blockedCategories: ['BANKING_INSURANCE_FINANCIAL'],
        },
      ],
    });
    await c
      .dndCache()
      .invalidateAll()
      .catch(() => undefined);

    mkdirSync(path.dirname(credsPath), { recursive: true });
    writeFileSync(credsPath, JSON.stringify({ ...creds, users: ids }, null, 2));
    chmodSync(credsPath, 0o600);
    process.stdout.write(
      `seed complete: templates created=${templates}, users created=${created}, dnd entries=${dnd.count}\ncredentials written to ${credsPath}\n`,
    );
  } finally {
    await c.close();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    process.stderr.write(`seed failed: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}
