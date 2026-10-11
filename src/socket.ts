import type http from 'node:http';
import { createAdapter } from '@socket.io/redis-adapter';
import { Server } from 'socket.io';
import { z } from 'zod';
import { runWithContext } from './common/context';
import type { Container } from './container';
import { userRoom } from './infrastructure/providers/socketio';

const ackSchema = z.object({ id: z.uuid() });

/**
 * Socket.IO for in-app notifications. Clients authenticate with a USER access
 * token in the handshake and join their private room; the Redis adapter lets
 * worker processes (via the Redis emitter) reach sockets on any API instance.
 */
export function attachSocketIo(server: http.Server, c: Container): Server {
  const pub = c.redis().duplicate();
  const sub = c.redis().duplicate();
  const io = new Server(server, {
    path: '/socket.io',
    cors: { origin: c.config.CORS_ORIGINS, credentials: false },
    adapter: createAdapter(pub, sub),
    serveClient: false,
  });

  io.use((socket, next) => {
    const token = (socket.handshake.auth as { token?: unknown }).token;
    if (typeof token !== 'string') {
      next(new Error('unauthorized'));
      return;
    }
    try {
      const principal = c.auth().verifyAccessToken(token);
      if (!principal.roles.includes('USER') || !principal.userId)
        throw new Error('USER token required');
      (socket.data as { userId?: string }).userId = principal.userId;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const userId = (socket.data as { userId: string }).userId;
    void socket.join(userRoom(userId));
    const handle = (event: string, fn: (id: string, correlationId: string) => Promise<unknown>) => {
      socket.on(event, (payload: unknown, ack?: (r: { ok: boolean; error?: string }) => void) => {
        const parsed = ackSchema.safeParse(payload);
        if (!parsed.success) {
          ack?.({ ok: false, error: 'invalid payload' });
          return;
        }
        const correlationId = `ws-${socket.id}-${Date.now()}`;
        runWithContext({ correlationId }, () => fn(parsed.data.id, correlationId))
          .then(() => ack?.({ ok: true }))
          .catch(() => ack?.({ ok: false, error: 'not found or not allowed' }));
      });
    };
    handle('notification:ack', (id, cid) => c.notificationService().acknowledge(userId, id, cid));
    handle('notification:read', (id, cid) => c.notificationService().markRead(userId, id, cid));
  });

  return io;
}
