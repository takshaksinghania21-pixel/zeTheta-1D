import Handlebars from 'handlebars';
import { DateTime } from 'luxon';
import type { Channel, Locale } from '../../domain/types';
import { AppError, type ErrorDetail } from '../../common/errors';
import { smsInfo, truncateSms } from './sms';

/** Channel template as stored (one row per event type × channel × locale × version). */
export interface ChannelTemplate {
  templateId?: string;
  version: number;
  subject?: string | null;
  title?: string | null;
  body: string;
}

export interface TemplateStore {
  /** Active template for an exact (eventType, channel, locale), or null. */
  getActive(eventType: string, channel: Channel, locale: Locale): Promise<ChannelTemplate | null>;
}

export interface RenderInput {
  eventType: string;
  channel: Channel;
  locale: Locale;
  timezone: string;
  data: Record<string, unknown>;
  user: { name?: string | null };
  /** Payload fields that are required by the event schema. */
  requiredFields?: string[];
}

export interface RenderedContent {
  channel: Channel;
  locale: Locale;
  requestedLocale: Locale;
  templateId?: string;
  templateVersion: number;
  subject?: string;
  title?: string;
  body: string;
  html?: string;
  sms?: { encoding: 'GSM-7' | 'UCS-2'; segments: number; truncated: boolean };
  missingVariables: string[];
}

export class TemplateRenderError extends AppError {
  constructor(message: string, details: ErrorDetail[] = []) {
    super('TEMPLATE_INVALID', 422, message, details);
  }
}

const LOCALE_TAGS: Record<Locale, string> = {
  en: 'en-IN',
  hi: 'hi-IN',
  mr: 'mr-IN',
  ta: 'ta-IN',
  te: 'te-IN',
};
const KNOWN_HELPERS = [
  'currency',
  'number',
  'percent',
  'date',
  'default',
  'eq',
  'gt',
  'humanize',
  'if',
  'unless',
  'each',
  'with',
] as const;
const LIMITS = {
  pushTitle: 65,
  pushBody: 240,
  inappTitle: 120,
  inappBody: 1000,
  whatsapp: 4096,
  emailSubject: 200,
};

interface HelperData {
  locale: Locale;
  timezone: string;
  channel: Channel;
}

function helperData(options: Handlebars.HelperOptions): HelperData {
  const data = options.data as {
    root?: unknown;
    locale?: Locale;
    timezone?: string;
    channel?: Channel;
  };
  return {
    locale: data.locale ?? 'en',
    timezone: data.timezone ?? 'Asia/Kolkata',
    channel: data.channel ?? 'inapp',
  };
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** Normalise spacing characters ICU emits (NBSP / narrow NBSP) so SMS stays GSM-7. */
function plainSpaces(s: string): string {
  return s.replace(/[\u00a0\u202f\u2009]/g, ' ');
}

function createEnvironment(): typeof Handlebars {
  const hb = Handlebars.create();
  // Built-ins that could leak structure or log data are removed.
  hb.unregisterHelper('log');
  hb.unregisterHelper('lookup');

  hb.registerHelper('currency', function (value: unknown, options: Handlebars.HelperOptions) {
    const n = toNumber(value);
    if (n === null) return '';
    const { locale, channel } = helperData(options);
    const formatted = new Intl.NumberFormat(LOCALE_TAGS[locale], {
      style: 'currency',
      currency: 'INR',
      numberingSystem: 'latn',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n);
    // "₹" is outside GSM-7; SMS uses the conventional "Rs." prefix instead.
    return plainSpaces(channel === 'sms' ? formatted.replace('₹', 'Rs.') : formatted);
  });
  hb.registerHelper('number', function (value: unknown, options: Handlebars.HelperOptions) {
    const n = toNumber(value);
    if (n === null) return '';
    const hash = options.hash as Record<string, unknown>;
    const max = typeof hash.decimals === 'number' ? hash.decimals : 4;
    return plainSpaces(
      new Intl.NumberFormat(LOCALE_TAGS[helperData(options).locale], {
        numberingSystem: 'latn',
        maximumFractionDigits: max,
      }).format(n),
    );
  });
  hb.registerHelper('percent', function (value: unknown, options: Handlebars.HelperOptions) {
    const n = toNumber(value);
    if (n === null) return '';
    return `${new Intl.NumberFormat(LOCALE_TAGS[helperData(options).locale], { numberingSystem: 'latn', maximumFractionDigits: 2 }).format(n)}%`;
  });
  hb.registerHelper('date', function (value: unknown, options: Handlebars.HelperOptions) {
    if (typeof value !== 'string' || value === '') return '';
    const { locale, timezone } = helperData(options);
    const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
    const dt = isDateOnly
      ? DateTime.fromISO(value, { zone: timezone })
      : DateTime.fromISO(value, { setZone: true }).setZone(timezone);
    if (!dt.isValid) return value;
    const localised = dt.setLocale(LOCALE_TAGS[locale]).reconfigure({ numberingSystem: 'latn' });
    const hash = options.hash as Record<string, unknown>;
    const format = typeof hash.format === 'string' ? hash.format : 'date';
    const preset =
      format === 'datetime'
        ? DateTime.DATETIME_MED
        : format === 'time'
          ? DateTime.TIME_SIMPLE
          : DateTime.DATE_MED;
    return plainSpaces(localised.toLocaleString(preset));
  });
  hb.registerHelper('default', (value: unknown, fallback: unknown) =>
    value === undefined || value === null || value === '' ? fallback : value,
  );
  hb.registerHelper('eq', (a: unknown, b: unknown) => a === b);
  hb.registerHelper('gt', (a: unknown, b: unknown) => {
    const x = toNumber(a);
    const y = toNumber(b);
    return x !== null && y !== null && x > y;
  });
  hb.registerHelper('humanize', (value: unknown) =>
    typeof value === 'string'
      ? value
          .toLowerCase()
          .split('_')
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(' ')
      : '',
  );
  return hb;
}

const COMPILE_OPTIONS = {
  noEscape: true, // channel bodies are plain text; HTML escaping happens in the email layout
  strict: false,
  knownHelpersOnly: true,
  knownHelpers: Object.fromEntries(KNOWN_HELPERS.map((h) => [h, true])),
} as const;

export interface TemplateValidationResult {
  valid: boolean;
  errors: ErrorDetail[];
  variables: string[];
}

type HbNode = hbs.AST.Node & Record<string, unknown>;

/** Walks a Handlebars AST collecting root variable names and unsafe constructs. */
function inspectAst(source: string): { variables: Set<string>; errors: ErrorDetail[] } {
  const variables = new Set<string>();
  const errors: ErrorDetail[] = [];
  let ast: hbs.AST.Program;
  try {
    ast = Handlebars.parse(source);
  } catch (err) {
    return {
      variables,
      errors: [{ message: `syntax error: ${(err as Error).message.split('\n')[0] ?? ''}` }],
    };
  }
  const blockScoped = new Set<string>();
  const visitPath = (p: hbs.AST.PathExpression, inEach: boolean): void => {
    if (p.data) return; // @index etc.
    if (p.depth > 0 || p.original.includes('../')) {
      errors.push({ message: `parent scope access '${p.original}' is not allowed` });
      return;
    }
    const head = p.parts[0];
    if (p.original === 'this' || p.original.startsWith('this.') || p.original.startsWith('./'))
      return;
    if (head && !inEach && !blockScoped.has(head)) variables.add(head);
  };
  const visit = (node: HbNode | null | undefined, inEach: boolean): void => {
    if (!node) return;
    switch (node.type) {
      case 'Program':
        for (const s of (node as unknown as hbs.AST.Program).body) visit(s as HbNode, inEach);
        break;
      case 'MustacheStatement':
      case 'SubExpression': {
        const m = node as unknown as hbs.AST.MustacheStatement;
        if (node.type === 'MustacheStatement' && !m.escaped) {
          errors.push({ message: 'triple-stash / unescaped output is not allowed' });
        }
        if (m.path.type === 'PathExpression') {
          const name = (m.path as hbs.AST.PathExpression).original;
          const isHelper = (KNOWN_HELPERS as readonly string[]).includes(name);
          if (!isHelper && m.params.length > 0)
            errors.push({ message: `unknown helper '${name}'` });
          if (!isHelper) visitPath(m.path as hbs.AST.PathExpression, inEach);
        }
        for (const p of m.params) visit(p as HbNode, inEach);
        for (const pair of (m.hash as hbs.AST.Hash | undefined)?.pairs ?? [])
          visit(pair.value as HbNode, inEach);
        break;
      }
      case 'BlockStatement': {
        const b = node as unknown as hbs.AST.BlockStatement;
        const name = b.path.original;
        if (!['if', 'unless', 'each', 'with'].includes(name))
          errors.push({ message: `block helper '${name}' is not allowed` });
        for (const p of b.params) visit(p as HbNode, inEach);
        const childInEach = inEach || name === 'each' || name === 'with';
        visit(b.program as unknown as HbNode, childInEach);
        visit(b.inverse as unknown as HbNode, inEach);
        break;
      }
      case 'PathExpression':
        visitPath(node as unknown as hbs.AST.PathExpression, inEach);
        break;
      case 'PartialStatement':
      case 'PartialBlockStatement':
        errors.push({ message: 'partials are not allowed' });
        break;
      case 'DecoratorBlock':
      case 'Decorator':
        errors.push({ message: 'decorators are not allowed' });
        break;
      default:
        break;
    }
  };
  visit(ast as unknown as HbNode, false);
  return { variables, errors };
}

const EMAIL_LAYOUT = `<!doctype html>
<html lang="{{lang}}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{{subject}}</title></head>
<body style="margin:0;padding:24px;background:#f4f6f8;font-family:Arial,Helvetica,sans-serif;color:#1d2733">
<table role="presentation" width="100%" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:8px">
<tr><td style="padding:24px 28px;border-bottom:3px solid #0b5cad"><strong style="font-size:18px">Zetheta</strong></td></tr>
<tr><td style="padding:24px 28px"><h1 style="font-size:20px;margin:0 0 16px">{{subject}}</h1>
<div style="font-size:15px;line-height:1.6;white-space:pre-line">{{body}}</div></td></tr>
<tr><td style="padding:16px 28px;font-size:12px;color:#6b7785">This is an automated message from Zetheta. Notification ID: {{notificationRef}}</td></tr>
</table></body></html>`;

export class TemplateEngine {
  private readonly hb = createEnvironment();
  private readonly compiled = new Map<string, Handlebars.TemplateDelegate>();
  private readonly layout: Handlebars.TemplateDelegate;

  constructor(
    private readonly store: TemplateStore,
    private readonly options: { fallbackLocale: Locale; smsMaxSegments: number },
  ) {
    // The layout is the only HTML context, so it is compiled WITH escaping.
    this.layout = Handlebars.create().compile(EMAIL_LAYOUT, {
      strict: false,
      knownHelpersOnly: true,
    });
  }

  /**
   * Validates a template source: syntax, forbidden constructs (partials,
   * triple-stash, unknown helpers, parent scope access) and that every
   * referenced variable is declared for the event.
   */
  validate(source: string, allowedVariables: readonly string[]): TemplateValidationResult {
    const { variables, errors } = inspectAst(source);
    const allowed = new Set([...allowedVariables, 'user', 'eventName', 'count', 'items']);
    for (const v of variables) {
      if (!allowed.has(v)) errors.push({ path: v, message: `unknown variable '${v}'` });
    }
    if (errors.length === 0) {
      try {
        this.hb.precompile(source, COMPILE_OPTIONS);
      } catch (err) {
        errors.push({ message: (err as Error).message.split('\n')[0] ?? 'compile error' });
      }
    }
    return { valid: errors.length === 0, errors, variables: [...variables] };
  }

  private compile(source: string): Handlebars.TemplateDelegate {
    let fn = this.compiled.get(source);
    if (!fn) {
      fn = this.hb.compile(source, COMPILE_OPTIONS);
      if (this.compiled.size > 5000) this.compiled.clear();
      this.compiled.set(source, fn);
    }
    return fn;
  }

  async resolveTemplate(
    eventType: string,
    channel: Channel,
    locale: Locale,
  ): Promise<{ template: ChannelTemplate; locale: Locale }> {
    const exact = await this.store.getActive(eventType, channel, locale);
    if (exact) return { template: exact, locale };
    if (locale !== this.options.fallbackLocale) {
      const fallback = await this.store.getActive(eventType, channel, this.options.fallbackLocale);
      if (fallback) return { template: fallback, locale: this.options.fallbackLocale };
    }
    throw new AppError(
      'TEMPLATE_NOT_FOUND',
      404,
      `No template for ${eventType}/${channel}/${locale}`,
    );
  }

  async render(input: RenderInput, notificationRef = ''): Promise<RenderedContent> {
    const { template, locale } = await this.resolveTemplate(
      input.eventType,
      input.channel,
      input.locale,
    );
    return this.renderTemplate(template, { ...input, locale }, input.locale, notificationRef);
  }

  renderTemplate(
    template: ChannelTemplate,
    input: RenderInput,
    requestedLocale: Locale,
    notificationRef = '',
  ): RenderedContent {
    const context: Record<string, unknown> = {
      ...input.data,
      user: {
        name: input.user.name && input.user.name.trim() !== '' ? input.user.name : 'Investor',
      },
    };
    const data = { locale: input.locale, timezone: input.timezone, channel: input.channel };

    // Missing variables: required fields that are absent make the output
    // misleading, so rendering fails; optional ones render empty/defaults.
    const referenced = new Set<string>();
    for (const src of [template.body, template.title ?? '', template.subject ?? '']) {
      for (const v of inspectAst(src).variables) referenced.add(v);
    }
    const missing = [...referenced].filter(
      (v) => v !== 'user' && (context[v] === undefined || context[v] === null),
    );
    const missingRequired = missing.filter((v) => input.requiredFields?.includes(v));
    if (missingRequired.length > 0) {
      throw new TemplateRenderError(
        `Missing required template variables: ${missingRequired.join(', ')}`,
        missingRequired.map((v) => ({ path: v, message: 'required variable missing' })),
      );
    }

    const run = (src: string | null | undefined): string | undefined => {
      if (src === undefined || src === null || src === '') return undefined;
      return plainSpaces(this.compile(src)(context, { data })).replaceAll('\u0000', '');
    };
    let body = run(template.body) ?? '';
    let title = run(template.title);
    let subject = run(template.subject);
    const out: RenderedContent = {
      channel: input.channel,
      locale: input.locale,
      requestedLocale,
      ...(template.templateId ? { templateId: template.templateId } : {}),
      templateVersion: template.version,
      body,
      missingVariables: missing,
    };

    switch (input.channel) {
      case 'sms': {
        body = body.replace(/\s+/g, ' ').trim();
        const truncated = truncateSms(body, this.options.smsMaxSegments);
        const info = smsInfo(truncated.text);
        out.body = truncated.text;
        out.sms = {
          encoding: info.encoding,
          segments: info.segments,
          truncated: truncated.truncated,
        };
        break;
      }
      case 'push':
        out.title = clip(title ?? '', LIMITS.pushTitle);
        out.body = clip(body.replace(/\s+/g, ' ').trim(), LIMITS.pushBody);
        break;
      case 'inapp':
        out.title = clip(title ?? '', LIMITS.inappTitle);
        out.body = clip(body.trim(), LIMITS.inappBody);
        break;
      case 'whatsapp':
        out.body = clip(body.trim(), LIMITS.whatsapp);
        break;
      case 'email': {
        // Strip CR/LF to rule out header injection through the subject.
        subject = clip(
          (subject ?? title ?? '').replace(/[\r\n]+/g, ' ').trim(),
          LIMITS.emailSubject,
        );
        title = undefined;
        out.subject = subject;
        out.body = body.trim();
        out.html = this.layout({
          lang: LOCALE_TAGS[input.locale],
          subject,
          body: out.body,
          notificationRef,
        });
        break;
      }
    }
    return out;
  }
}

function clip(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length <= max ? s : `${chars.slice(0, max - 1).join('')}…`;
}
