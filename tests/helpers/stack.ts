import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server as IoServer } from 'socket.io';
import { createApp } from '../../src/app';
import type { AppConfig } from '../../src/config/env';
import { Container, type ContainerOverrides } from '../../src/container';
import type { Role } from '../../src/domain/types';
import { loadTemplateSources } from '../../src/modules/templates/source';
import type { NewUser } from '../../src/modules/users/repository';
import { attachSocketIo } from '../../src/socket';
import { ensureInfrastructure } from '../../src/workers/bootstrap';
import { migrate, truncateAll } from './db';
import { testConfig } from './env';

export interface Stack {
  c: Container;
  config: AppConfig;
  server: http.Server;
  io: IoServer;
  baseUrl: string;
  close(): Promise<void>;
}

/** Boots API (HTTP + Socket.IO) against real infrastructure with a clean DB. */
export async function freePort(): Promise<number> {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

export async function startStack(
  overrides: Partial<Record<string, string>> = {},
  containerOverrides: ContainerOverrides = {},
  listenPort = 0,
): Promise<Stack> {
  const config = testConfig(overrides);
  const c = new Container(config, containerOverrides);
  await migrate(c.db());
  await truncateAll(c.db());
  await c.templateRepo().seed(loadTemplateSources());
  await ensureInfrastructure(c);
  const { app } = createApp(c);
  const server = http.createServer(app);
  const io = attachSocketIo(server, c);
  await new Promise<void>((r) => server.listen(listenPort, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    c,
    config,
    server,
    io,
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      await io.close();
      await c.close();
    },
  };
}

export async function principalToken(
  c: Container,
  roles: Role[],
  opts: { username?: string; userId?: string } = {},
): Promise<string> {
  const username =
    opts.username ?? `${roles.join('-').toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`;
  const kind = roles.includes('SERVICE') ? 'SERVICE' : 'HUMAN';
  await c.auth().createPrincipal({
    kind,
    username,
    secret: 'test-password-123',
    roles,
    ...(opts.userId ? { userId: opts.userId } : {}),
  });
  const pair =
    kind === 'SERVICE'
      ? await c.auth().clientCredentials(username, 'test-password-123')
      : await c.auth().passwordGrant(username, 'test-password-123');
  return pair.accessToken;
}

export async function waitFor<T>(
  fn: () => Promise<T>,
  done: (v: T) => boolean,
  timeoutMs = 15000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let v = await fn();
  while (!done(v)) {
    if (Date.now() > deadline)
      throw new Error(`waitFor timed out; last value: ${JSON.stringify(v).slice(0, 500)}`);
    await new Promise((r) => setTimeout(r, intervalMs));
    v = await fn();
  }
  return v;
}

export const PHONE = '+919812345678';
export async function createUser(c: Container, over: Partial<NewUser> = {}): Promise<string> {
  const u = await c.users().create({
    displayName: 'Test User',
    segment: 'RETAIL',
    locale: 'en',
    timezone: 'UTC',
    contacts: [
      { channel: 'sms', value: PHONE },
      { channel: 'whatsapp', value: PHONE },
      { channel: 'email', value: `user-${Math.random().toString(36).slice(2)}@example.test` },
      { channel: 'push', value: `fcm-token-${Math.random().toString(36).slice(2)}-0000000000` },
    ],
    ...over,
  });
  // Tests run at arbitrary times: disable quiet hours unless a test opts in.
  await c
    .users()
    .updatePreferences(
      u.id,
      (p) => ({ ...p, quietHours: { enabled: false, start: '21:00', end: '08:00' } }),
      'test',
    );
  return u.id;
}
