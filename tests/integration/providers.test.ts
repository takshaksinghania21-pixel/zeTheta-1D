import { generateKeyPairSync, createVerify } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { SMTPServer } from 'smtp-server';
import { FcmPushProvider } from '../../src/infrastructure/providers/fcm';
import { Msg91SmsProvider } from '../../src/infrastructure/providers/msg91';
import { SmtpEmailProvider, classifySmtpError } from '../../src/infrastructure/providers/smtp';
import { mapTwilioStatus, TwilioSmsProvider } from '../../src/infrastructure/providers/twilio';
import { WhatsAppCloudProvider } from '../../src/infrastructure/providers/whatsapp';
import { ProviderError, type DeliveryRequest } from '../../src/modules/delivery/provider';
import { buildProviders } from '../../src/modules/delivery/registry';
import { loadPolicy } from '../../src/config/policy';
import { InMemoryMockBehaviorStore } from '../../src/infrastructure/providers/mock';
import { testConfig } from '../helpers/env';

interface Captured {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}
type Responder = (req: Captured) => {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
};

/** Minimal local HTTP stub standing in for provider APIs (no network access). */
async function stub(
  responder: Responder,
): Promise<{ url: string; requests: Captured[]; close: () => Promise<void> }> {
  const requests: Captured[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d: Buffer) => (body += d.toString()));
    req.on('end', () => {
      const cap = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body };
      requests.push(cap);
      const r = responder(cap);
      setTimeout(() => {
        res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers ?? {}) });
        res.end(r.body === undefined ? '' : JSON.stringify(r.body));
      }, r.delayMs ?? 0);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

const req = (over: Partial<DeliveryRequest> = {}): DeliveryRequest => ({
  notificationId: '11111111-1111-4111-8111-111111111111',
  channel: 'sms',
  recipient: '+919812345678',
  content: {
    channel: 'sms',
    locale: 'en',
    requestedLocale: 'en',
    templateVersion: 1,
    body: 'Hello',
    title: 'T',
    subject: 'S',
    html: '<p>Hello</p>',
    missingVariables: [],
  },
  priority: 'HIGH',
  correlationId: 'corr-provider-1',
  userId: '22222222-2222-4222-8222-222222222222',
  ...over,
});
const signal = () => AbortSignal.timeout(2000);

async function expectKind(p: Promise<unknown>, kind: string, code?: RegExp): Promise<void> {
  try {
    await p;
    throw new Error('expected failure');
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe(kind);
    if (code) expect((err as ProviderError).code).toMatch(code);
  }
}

describe('Twilio SMS adapter', () => {
  it('sends form-encoded requests with basic auth and parses the SID', async () => {
    const s = await stub(() => ({ status: 201, body: { sid: 'SM123', status: 'queued' } }));
    const p = new TwilioSmsProvider('twilio', {
      accountSid: 'ACtest',
      authToken: 'tok',
      fromNumber: '+15005550006',
      baseUrl: s.url,
      statusCallbackUrl: 'https://cb.example.test/webhooks/twilio',
      costMicros: 180000,
    });
    const r = await p.send(req(), signal());
    expect(r).toEqual({ providerMessageId: 'SM123', status: 'ACCEPTED', costMicros: 180000 });
    const captured = s.requests[0]!;
    expect(captured.url).toBe('/2010-04-01/Accounts/ACtest/Messages.json');
    expect(captured.headers.authorization).toBe(
      `Basic ${Buffer.from('ACtest:tok').toString('base64')}`,
    );
    const form = new URLSearchParams(captured.body);
    expect(form.get('To')).toBe('+919812345678');
    expect(form.get('StatusCallback')).toBe('https://cb.example.test/webhooks/twilio');
    await s.close();
  });

  it('classifies invalid numbers, unsubscribed recipients, rate limits and outages', async () => {
    const answers = [
      { status: 400, body: { code: 21211, message: 'Invalid To' } },
      { status: 400, body: { code: 21610, message: 'Unsubscribed' } },
      { status: 429, body: { code: 20429 }, headers: { 'retry-after': '3' } },
      { status: 503, body: {} },
      { status: 401, body: { code: 20003 } },
    ];
    let i = 0;
    const s = await stub(() => answers[i++]!);
    const p = new TwilioSmsProvider('twilio', {
      accountSid: 'AC',
      authToken: 't',
      fromNumber: '+1',
      baseUrl: s.url,
      costMicros: 0,
    });
    await expectKind(p.send(req(), signal()), 'INVALID_RECIPIENT', /21211/);
    await expectKind(p.send(req(), signal()), 'PERMANENT', /21610/);
    try {
      await p.send(req(), signal());
    } catch (err) {
      expect((err as ProviderError).kind).toBe('RATE_LIMITED');
      expect((err as ProviderError).options.retryAfterMs).toBe(3000);
    }
    await expectKind(p.send(req(), signal()), 'TRANSIENT');
    await expectKind(p.send(req(), signal()), 'AUTH');
    await s.close();
  });

  it('times out slow responses and maps statuses', async () => {
    const s = await stub(() => ({ status: 200, body: { sid: 'x' }, delayMs: 500 }));
    const p = new TwilioSmsProvider('twilio', {
      accountSid: 'AC',
      authToken: 't',
      fromNumber: '+1',
      baseUrl: s.url,
      costMicros: 0,
    });
    await expectKind(p.send(req(), AbortSignal.timeout(50)), 'TIMEOUT');
    expect(mapTwilioStatus('delivered')).toBe('DELIVERED');
    expect(mapTwilioStatus('undelivered')).toBe('FAILED');
    expect(mapTwilioStatus('weird')).toBe('UNKNOWN');
    expect(p.validateRecipient('12345').valid).toBe(false);
    await s.close();
  });

  it('queries message status', async () => {
    const s = await stub(() => ({ status: 200, body: { sid: 'SM1', status: 'delivered' } }));
    const p = new TwilioSmsProvider('twilio', {
      accountSid: 'AC',
      authToken: 't',
      fromNumber: '+1',
      baseUrl: s.url,
      costMicros: 0,
    });
    expect(await p.getStatus('SM1')).toEqual({ providerMessageId: 'SM1', status: 'DELIVERED' });
    await s.close();
  });
});

describe('MSG91 SMS adapter', () => {
  it('calls the Flow API with the auth key and parses the request id', async () => {
    const s = await stub(() => ({ status: 200, body: { type: 'success', message: 'REQ-1' } }));
    const p = new Msg91SmsProvider('msg91', {
      authKey: 'key',
      flowId: 'flow',
      baseUrl: s.url,
      costMicros: 150000,
    });
    expect((await p.send(req(), signal())).providerMessageId).toBe('REQ-1');
    expect(s.requests[0]?.headers.authkey).toBe('key');
    expect(JSON.parse(s.requests[0]!.body)).toMatchObject({
      template_id: 'flow',
      recipients: [{ mobiles: '919812345678', message: 'Hello' }],
    });
    await s.close();
  });

  it('classifies errors', async () => {
    const answers = [
      { status: 200, body: { type: 'error', message: 'Invalid mobile number' } },
      { status: 401, body: { type: 'error', message: 'Authentication failure' } },
      { status: 500, body: {} },
    ];
    let i = 0;
    const s = await stub(() => answers[i++]!);
    const p = new Msg91SmsProvider('msg91', {
      authKey: 'k',
      flowId: 'f',
      baseUrl: s.url,
      costMicros: 0,
    });
    await expectKind(p.send(req(), signal()), 'INVALID_RECIPIENT');
    await expectKind(p.send(req(), signal()), 'AUTH');
    await expectKind(p.send(req(), signal()), 'TRANSIENT');
    await s.close();
  });
});

describe('FCM HTTP v1 adapter', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  it('obtains an OAuth token with a signed JWT assertion (cached) and sends the message', async () => {
    const s = await stub((r) =>
      r.url === '/token'
        ? { status: 200, body: { access_token: 'ya29.test', expires_in: 3600 } }
        : { status: 200, body: { name: 'projects/p/messages/42' } },
    );
    const p = new FcmPushProvider('fcm', {
      projectId: 'p',
      clientEmail: 'svc@p.iam.gserviceaccount.com',
      privateKeyPem: pem,
      baseUrl: s.url,
      tokenUrl: `${s.url}/token`,
      costMicros: 0,
    });
    const r1 = await p.send(
      req({ channel: 'push', recipient: 'fcm-token-abcdefghijklmnopqrstu', priority: 'CRITICAL' }),
      signal(),
    );
    await p.send(
      req({ channel: 'push', recipient: 'fcm-token-abcdefghijklmnopqrstu', priority: 'LOW' }),
      signal(),
    );
    expect(r1.providerMessageId).toBe('projects/p/messages/42');
    const tokenCalls = s.requests.filter((x) => x.url === '/token');
    expect(tokenCalls).toHaveLength(1); // cached
    const assertion = new URLSearchParams(tokenCalls[0]!.body).get('assertion')!;
    const [h, c, sig] = assertion.split('.');
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${h}.${c}`);
    expect(verifier.verify(publicKey, Buffer.from(sig!, 'base64url'))).toBe(true);
    expect(JSON.parse(Buffer.from(c!, 'base64url').toString())).toMatchObject({
      iss: 'svc@p.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
    });
    const sends = s.requests.filter((x) => x.url.endsWith('messages:send'));
    expect(sends[0]?.headers.authorization).toBe('Bearer ya29.test');
    expect(JSON.parse(sends[0]!.body).message.android.priority).toBe('high');
    expect(JSON.parse(sends[1]!.body).message.android.priority).toBe('normal');
    await s.close();
  });

  it('maps UNREGISTERED tokens to invalid recipient and quota errors to rate limited', async () => {
    const answers = [
      {
        status: 404,
        body: { error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } },
      },
      {
        status: 429,
        body: {
          error: { status: 'RESOURCE_EXHAUSTED', details: [{ errorCode: 'QUOTA_EXCEEDED' }] },
        },
      },
      { status: 503, body: { error: { status: 'UNAVAILABLE' } } },
    ];
    let i = 0;
    const s = await stub((r) =>
      r.url === '/token'
        ? { status: 200, body: { access_token: 't', expires_in: 3600 } }
        : answers[i++]!,
    );
    const p = new FcmPushProvider('fcm', {
      projectId: 'p',
      clientEmail: 'e',
      privateKeyPem: pem,
      baseUrl: s.url,
      tokenUrl: `${s.url}/token`,
      costMicros: 0,
    });
    const push = req({ channel: 'push', recipient: 'fcm-token-abcdefghijklmnopqrstu' });
    await expectKind(p.send(push, signal()), 'INVALID_RECIPIENT', /UNREGISTERED/);
    await expectKind(p.send(push, signal()), 'RATE_LIMITED');
    await expectKind(p.send(push, signal()), 'TRANSIENT');
    await s.close();
  });

  it('surfaces token endpoint failures as AUTH errors', async () => {
    const s = await stub(() => ({ status: 400, body: { error: 'invalid_grant' } }));
    const p = new FcmPushProvider('fcm', {
      projectId: 'p',
      clientEmail: 'e',
      privateKeyPem: pem,
      baseUrl: s.url,
      tokenUrl: `${s.url}/token`,
      costMicros: 0,
    });
    await expectKind(
      p.send(req({ channel: 'push', recipient: 'fcm-token-abcdefghijklmnopqrstu' }), signal()),
      'AUTH',
    );
    await s.close();
  });
});

describe('WhatsApp Cloud API adapter', () => {
  it('posts text messages with a bearer token and parses the message id', async () => {
    const s = await stub(() => ({ status: 200, body: { messages: [{ id: 'wamid.ABC' }] } }));
    const p = new WhatsAppCloudProvider('whatsapp-cloud', {
      phoneNumberId: '1234',
      accessToken: 'EAAG',
      apiVersion: 'v21.0',
      baseUrl: s.url,
      costMicros: 350000,
    });
    expect((await p.send(req({ channel: 'whatsapp' }), signal())).providerMessageId).toBe(
      'wamid.ABC',
    );
    expect(s.requests[0]?.url).toBe('/v21.0/1234/messages');
    expect(s.requests[0]?.headers.authorization).toBe('Bearer EAAG');
    expect(JSON.parse(s.requests[0]!.body)).toMatchObject({
      messaging_product: 'whatsapp',
      to: '919812345678',
      type: 'text',
    });
    await s.close();
  });

  it('classifies Meta error codes', async () => {
    const answers = [
      { status: 400, body: { error: { code: 131026 } } },
      { status: 400, body: { error: { code: 131047 } } },
      { status: 429, body: { error: { code: 130429 } } },
      { status: 401, body: { error: { code: 190 } } },
    ];
    let i = 0;
    const s = await stub(() => answers[i++]!);
    const p = new WhatsAppCloudProvider('wa', {
      phoneNumberId: '1',
      accessToken: 't',
      apiVersion: 'v21.0',
      baseUrl: s.url,
      costMicros: 0,
    });
    await expectKind(p.send(req({ channel: 'whatsapp' }), signal()), 'INVALID_RECIPIENT');
    await expectKind(p.send(req({ channel: 'whatsapp' }), signal()), 'PERMANENT');
    await expectKind(p.send(req({ channel: 'whatsapp' }), signal()), 'RATE_LIMITED');
    await expectKind(p.send(req({ channel: 'whatsapp' }), signal()), 'AUTH');
    await s.close();
  });
});

describe('SMTP (Nodemailer) adapter against a local SMTP server', () => {
  it('delivers a real SMTP message with text + HTML parts and rejects refused recipients', async () => {
    const messages: { to: string[]; data: string }[] = [];
    const server = new SMTPServer({
      authOptional: true,
      disabledCommands: ['STARTTLS'],
      onRcptTo(address, _session, cb) {
        if (address.address.startsWith('bounce'))
          cb(Object.assign(new Error('mailbox unavailable'), { responseCode: 550 }));
        else cb();
      },
      onData(stream, session, cb) {
        let data = '';
        stream.on('data', (d: Buffer) => (data += d.toString()));
        stream.on('end', () => {
          messages.push({ to: session.envelope.rcptTo.map((r) => r.address), data });
          cb();
        });
      },
      logger: false,
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.server.address() as AddressInfo).port;
    const p = new SmtpEmailProvider('smtp', {
      host: '127.0.0.1',
      port,
      secure: false,
      from: 'Zetheta <alerts@example.test>',
      costMicros: 10000,
      timeoutMs: 3000,
    });
    const r = await p.send(req({ channel: 'email', recipient: 'investor@example.test' }), signal());
    expect(r.providerMessageId).toBe('<11111111-1111-4111-8111-111111111111@notify.zetheta.local>');
    expect(messages[0]?.to).toEqual(['investor@example.test']);
    expect(messages[0]?.data).toMatch(/Subject: S/);
    expect(messages[0]?.data).toMatch(/X-Notification-Id: 11111111/i);
    expect(messages[0]?.data).toMatch(/text\/html/);
    await expectKind(
      p.send(req({ channel: 'email', recipient: 'bounce@example.test' }), signal()),
      'INVALID_RECIPIENT',
    );
    p.close();
    await new Promise<void>((res) => server.close(() => res()));
  });

  it('classifies SMTP failure codes', () => {
    expect(classifySmtpError({ code: 'EAUTH' }).kind).toBe('AUTH');
    expect(classifySmtpError({ responseCode: 550 }).kind).toBe('INVALID_RECIPIENT');
    expect(classifySmtpError({ responseCode: 552 }).kind).toBe('PERMANENT');
    expect(classifySmtpError({ responseCode: 421 }).kind).toBe('TRANSIENT');
    expect(classifySmtpError({ code: 'ECONNECTION', message: 'refused' }).kind).toBe('TRANSIENT');
  });

  it('treats an unreachable SMTP server as transient', async () => {
    const p = new SmtpEmailProvider('smtp', {
      host: '127.0.0.1',
      port: 1,
      secure: false,
      from: 'a@example.test',
      costMicros: 0,
      timeoutMs: 500,
    });
    await expectKind(
      p.send(req({ channel: 'email', recipient: 'x@example.test' }), signal()),
      'TRANSIENT',
    );
    p.close();
  });
});

describe('provider factory (fail-safe configuration)', () => {
  const policy = loadPolicy();
  const deps = {
    mockStore: new InMemoryMockBehaviorStore(),
    emitter: { to: () => ({ emit: () => true }) } as never,
  };

  it('builds the configured adapters', () => {
    const cfg = testConfig({
      SMS_PROVIDERS: 'twilio,msg91',
      TWILIO_ACCOUNT_SID: 'AC',
      TWILIO_AUTH_TOKEN: 't',
      TWILIO_FROM_NUMBER: '+1',
      MSG91_AUTH_KEY: 'k',
      MSG91_FLOW_ID: 'f',
      EMAIL_PROVIDERS: 'smtp',
    });
    const names = buildProviders(cfg, policy, deps).map((p) => `${p.channel}:${p.name}`);
    expect(names).toEqual(
      expect.arrayContaining([
        'sms:twilio',
        'sms:msg91',
        'email:smtp',
        'push:mock-push',
        'inapp:socketio',
      ]),
    );
  });

  it('refuses to start a real provider without credentials', () => {
    expect(() => buildProviders(testConfig({ PUSH_PROVIDERS: 'fcm' }), policy, deps)).toThrow(
      /missing credentials: FCM_PROJECT_ID/,
    );
    expect(() =>
      buildProviders(testConfig({ WHATSAPP_PROVIDERS: 'whatsapp-cloud' }), policy, deps),
    ).toThrow(/WHATSAPP_ACCESS_TOKEN/);
    expect(() =>
      buildProviders(testConfig({ SMS_PROVIDERS: 'carrier-pigeon' }), policy, deps),
    ).toThrow(/Unknown provider/);
  });
});
