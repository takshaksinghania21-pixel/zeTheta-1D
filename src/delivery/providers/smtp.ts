import nodemailer, { type Transporter } from 'nodemailer';
import {
  ProviderError,
  type DeliveryProvider,
  type DeliveryRequest,
  type DeliveryResult,
  type ProviderQuota,
  type ProviderStatus,
  type RecipientValidation,
} from './provider';
import { validateRecipientFormat } from '../../database/models/contacts';

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string | undefined;
  pass?: string | undefined;
  from: string;
  costMicros: number;
  timeoutMs: number;
}

interface SmtpError {
  code?: string;
  responseCode?: number;
  message?: string;
}

export function classifySmtpError(err: SmtpError): ProviderError {
  const rc = err.responseCode;
  const code = err.code ?? 'SMTP_ERROR';
  if (code === 'EAUTH') return new ProviderError('AUTH', code, 'SMTP authentication failed');
  if (rc === 550 || rc === 551 || rc === 553 || code === 'EENVELOPE')
    return new ProviderError(
      'INVALID_RECIPIENT',
      `SMTP_${rc ?? code}`,
      'Recipient rejected by SMTP server',
    );
  if (rc !== undefined && rc >= 500)
    return new ProviderError('PERMANENT', `SMTP_${rc}`, 'SMTP permanent failure');
  if (rc !== undefined && rc >= 400)
    return new ProviderError('TRANSIENT', `SMTP_${rc}`, 'SMTP temporary failure');
  return new ProviderError(
    'TRANSIENT',
    code,
    `SMTP transport error: ${(err.message ?? '').slice(0, 120)}`,
  );
}

/** Nodemailer adapter: Ethereal (sandbox), a local test SMTP server, or a real relay. */
export class SmtpEmailProvider implements DeliveryProvider {
  readonly channel = 'email' as const;
  private readonly transport: Transporter;

  constructor(
    readonly name: string,
    private readonly cfg: SmtpConfig,
  ) {
    this.transport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      ...(cfg.user && cfg.pass ? { auth: { user: cfg.user, pass: cfg.pass } } : {}),
      connectionTimeout: cfg.timeoutMs,
      greetingTimeout: cfg.timeoutMs,
      socketTimeout: cfg.timeoutMs,
      // Local test servers commonly lack TLS; real relays should use secure/STARTTLS.
      ignoreTLS: !cfg.secure && (cfg.host === 'localhost' || cfg.host === '127.0.0.1'),
    });
  }

  async send(req: DeliveryRequest, signal: AbortSignal): Promise<DeliveryResult> {
    const mail = this.transport.sendMail({
      from: this.cfg.from,
      to: req.recipient,
      subject: req.content.subject ?? '',
      text: req.content.body,
      ...(req.content.html ? { html: req.content.html } : {}),
      messageId: `<${req.notificationId}@notify.zetheta.local>`,
      headers: { 'X-Notification-Id': req.notificationId, 'X-Correlation-Id': req.correlationId },
    });
    const aborted = new Promise<never>((_, reject) => {
      signal.addEventListener(
        'abort',
        () => {
          reject(new ProviderError('TIMEOUT', 'TIMEOUT', 'SMTP send timed out'));
        },
        { once: true },
      );
    });
    let info: { messageId: string; rejected: (string | { address: string })[] };
    try {
      info = (await Promise.race([mail, aborted])) as typeof info;
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw classifySmtpError(err as SmtpError);
    }
    if (info.rejected.length > 0)
      throw new ProviderError(
        'INVALID_RECIPIENT',
        'SMTP_REJECTED',
        'Recipient rejected by SMTP server',
      );
    return {
      providerMessageId: info.messageId,
      status: 'ACCEPTED',
      costMicros: this.cfg.costMicros,
    };
  }

  getStatus(providerMessageId: string): Promise<ProviderStatus> {
    // SMTP has no status API; bounces/deliveries arrive via webhook relays.
    return Promise.resolve({ providerMessageId, status: 'UNKNOWN' });
  }

  validateRecipient(recipient: string): RecipientValidation {
    return validateRecipientFormat('email', recipient)
      ? { valid: true }
      : { valid: false, reason: 'invalid email address' };
  }

  getQuota(): Promise<ProviderQuota> {
    return Promise.resolve({
      limitPerMinute: null,
      remaining: null,
      resetAt: null,
      source: 'local-rate-limiter',
    });
  }

  async verify(): Promise<boolean> {
    return this.transport.verify();
  }

  close(): void {
    this.transport.close();
  }
}
