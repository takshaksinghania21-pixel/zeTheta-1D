import type { Channel } from '../../utils/types';
import { ValidationError } from '../../utils/errors';

export type ContactChannel = Exclude<Channel, 'inapp'>;

const E164 = /^\+[1-9]\d{7,14}$/;
const EMAIL =
  /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const PUSH_TOKEN = /^[A-Za-z0-9:_\-.]{20,4096}$/;

/** Normalises and validates a contact value; the result feeds encryption and the blind index. */
export function normaliseContact(channel: ContactChannel, raw: string): string {
  const v = raw.trim();
  switch (channel) {
    case 'sms':
    case 'whatsapp': {
      const phone = v.replace(/[\s()-]/g, '');
      if (!E164.test(phone))
        throw new ValidationError('Phone numbers must be in E.164 format', [
          { path: 'value', message: 'expected +<country><number>' },
        ]);
      return phone;
    }
    case 'email': {
      const email = v.toLowerCase();
      if (email.length > 254 || !EMAIL.test(email))
        throw new ValidationError('Invalid email address', [
          { path: 'value', message: 'invalid email' },
        ]);
      return email;
    }
    case 'push':
      if (!PUSH_TOKEN.test(v))
        throw new ValidationError('Invalid push token', [
          { path: 'value', message: 'invalid token format' },
        ]);
      return v;
  }
}

export function validateRecipientFormat(channel: Channel, value: string): boolean {
  try {
    if (channel === 'inapp') return value.length > 0;
    normaliseContact(channel, value);
    return true;
  } catch {
    return false;
  }
}
