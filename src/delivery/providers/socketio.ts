import type { Emitter } from '@socket.io/redis-emitter';
import type {
  DeliveryProvider,
  DeliveryRequest,
  DeliveryResult,
  ProviderQuota,
  ProviderStatus,
  RecipientValidation,
} from './provider';

export const userRoom = (userId: string): string => `user:${userId}`;

/**
 * In-app delivery over Socket.IO. The notification is already persisted before
 * this runs, so disconnected users fetch it via GET /notifications later. The
 * Redis emitter lets worker processes reach sockets held by API instances.
 * SENT means "emitted"; DELIVERED is only recorded when the client acks.
 */
export class SocketIoInAppProvider implements DeliveryProvider {
  readonly channel = 'inapp' as const;
  constructor(
    readonly name: string,
    private readonly emitter: Pick<Emitter, 'to'>,
  ) {}

  send(req: DeliveryRequest): Promise<DeliveryResult> {
    this.emitter.to(userRoom(req.userId)).emit('notification', {
      id: req.notificationId,
      title: req.content.title ?? null,
      body: req.content.body,
      priority: req.priority,
      locale: req.content.locale,
    });
    return Promise.resolve({
      providerMessageId: req.notificationId,
      status: 'ACCEPTED',
      costMicros: 0,
    });
  }

  getStatus(providerMessageId: string): Promise<ProviderStatus> {
    return Promise.resolve({ providerMessageId, status: 'UNKNOWN' });
  }

  validateRecipient(recipient: string): RecipientValidation {
    return /^[0-9a-f-]{36}$/i.test(recipient)
      ? { valid: true }
      : { valid: false, reason: 'in-app recipient must be a user id' };
  }

  getQuota(): Promise<ProviderQuota> {
    return Promise.resolve({
      limitPerMinute: null,
      remaining: null,
      resetAt: null,
      source: 'unlimited',
    });
  }
}
