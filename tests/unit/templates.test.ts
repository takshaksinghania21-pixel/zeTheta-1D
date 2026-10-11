import { TemplateEngine, TemplateRenderError } from '../../src/modules/templates/engine';
import {
  FileTemplateStore,
  loadTemplateSources,
  DIGEST_EVENT_TYPE,
} from '../../src/modules/templates/source';
import { EventTaxonomy } from '../../src/modules/taxonomy/taxonomy';
import { SAMPLE_DIGEST, SAMPLE_PAYLOADS } from '../../src/modules/taxonomy/fixtures';
import { CHANNELS, LOCALES, type Channel, type Locale } from '../../src/domain/types';

const taxonomy = EventTaxonomy.load();
const store = new FileTemplateStore();
const engine = new TemplateEngine(store, { fallbackLocale: 'en', smsMaxSegments: 4 });
const base = { timezone: 'Asia/Kolkata', user: { name: 'Asha' } };

function payload(code: string): Record<string, unknown> {
  const res = taxonomy.validatePayload(code, SAMPLE_PAYLOADS[code]);
  if (!res.ok) throw new Error('fixture invalid');
  return res.payload;
}

describe('template sources', () => {
  const sources = loadTemplateSources();
  it.each(LOCALES)('locale %s has a template for every event type and the digest', (locale) => {
    const codes = sources.filter((s) => s.locale === locale).map((s) => s.eventType);
    for (const def of taxonomy.list()) expect(codes).toContain(def.code);
    expect(codes).toContain(DIGEST_EVENT_TYPE);
  });

  it('every source string passes validation against the event variables', () => {
    for (const s of sources) {
      const def = taxonomy.get(s.eventType);
      const vars = def ? Object.keys(def.fields) : [];
      for (const src of [s.title, s.short, s.long]) {
        const v = engine.validate(src, vars);
        if (!v.valid) throw new Error(`${s.locale}/${s.eventType}: ${JSON.stringify(v.errors)}`);
      }
    }
  });
});

describe('template rendering', () => {
  it('renders all 25 events in all 5 locales on all 5 channels within SMS limits', async () => {
    let rendered = 0;
    for (const def of taxonomy.list()) {
      for (const locale of LOCALES) {
        for (const channel of CHANNELS) {
          const out = await engine.render({
            ...base,
            eventType: def.code,
            channel,
            locale,
            data: payload(def.code),
            requiredFields: Object.keys(def.fields).filter((f) => def.fields[f]?.required),
          });
          expect(out.body.length).toBeGreaterThan(0);
          expect(out.locale).toBe(locale);
          expect(out.body).not.toMatch(/\{\{|\}\}/);
          if (channel === 'sms') {
            expect(out.sms?.segments).toBeLessThanOrEqual(4);
            expect(out.sms?.truncated).toBe(false);
          }
          rendered++;
        }
      }
    }
    expect(rendered).toBe(25 * 5 * 5);
  });

  it('interpolates variables and formats INR currency (Rs. for SMS to stay GSM-7)', async () => {
    const sms = await engine.render({
      ...base,
      eventType: 'RISK-001',
      channel: 'sms',
      locale: 'en',
      data: payload('RISK-001'),
    });
    expect(sms.body).toContain('Rs.1,25,000.00');
    expect(sms.sms?.encoding).toBe('GSM-7');
    const push = await engine.render({
      ...base,
      eventType: 'RISK-001',
      channel: 'push',
      locale: 'en',
      data: payload('RISK-001'),
    });
    expect(push.body).toContain('₹1,25,000.00');
    expect(push.title).toBe('URGENT: Margin call');
  });

  it('formats dates in the user timezone', async () => {
    const email = await engine.render({
      ...base,
      timezone: 'America/New_York',
      eventType: 'TXNX-001',
      channel: 'email',
      locale: 'en',
      data: payload('TXNX-001'),
    });
    // 09:20 IST = 22:50 previous day in New York (EST)
    expect(email.body).toMatch(/14 Jan 2026/);
    expect(email.body).toMatch(/10:50/);
  });

  it('applies conditional rendering', async () => {
    const buy = await engine.render({
      ...base,
      eventType: 'TXNX-003',
      channel: 'sms',
      locale: 'en',
      data: payload('TXNX-003'),
    });
    expect(buy.body).toContain('buy order');
    const sell = await engine.render({
      ...base,
      eventType: 'TXNX-003',
      channel: 'sms',
      locale: 'en',
      data: { ...payload('TXNX-003'), side: 'SELL' },
    });
    expect(sell.body).toContain('sell order');
    const withoutBalance = { ...payload('TXNX-005') };
    delete withoutBalance.availableBalance;
    const out = await engine.render({
      ...base,
      eventType: 'TXNX-005',
      channel: 'sms',
      locale: 'en',
      data: withoutBalance,
    });
    expect(out.body).not.toContain('Available balance');
  });

  it('falls back to English for an unsupported locale template', async () => {
    const sparse = new TemplateEngine(
      { getActive: (e, c, l) => (l === 'en' ? store.getActive(e, c, l) : Promise.resolve(null)) },
      { fallbackLocale: 'en', smsMaxSegments: 4 },
    );
    const out = await sparse.render({
      ...base,
      eventType: 'SIPX-003',
      channel: 'push',
      locale: 'ta',
      data: payload('SIPX-003'),
    });
    expect(out.locale).toBe('en');
    expect(out.requestedLocale).toBe('ta');
    expect(out.title).toContain('SIP failed');
  });

  it('uses defaults for the user name and optional fields', async () => {
    const out = await engine.render({
      ...base,
      user: { name: null },
      eventType: 'REGX-001',
      channel: 'email',
      locale: 'en',
      data: payload('REGX-001'),
    });
    expect(out.body).toContain('Hi Investor');
  });

  it('fails clearly when a required variable is missing', async () => {
    const data = payload('TXNX-001');
    delete data.symbol;
    await expect(
      engine.render({
        ...base,
        eventType: 'TXNX-001',
        channel: 'sms',
        locale: 'en',
        data,
        requiredFields: ['symbol', 'orderId'],
      }),
    ).rejects.toBeInstanceOf(TemplateRenderError);
  });

  it('reports missing optional variables without failing', async () => {
    const data = payload('SIPX-003');
    delete data.nextAttemptDate;
    const out = await engine.render({
      ...base,
      eventType: 'SIPX-003',
      channel: 'sms',
      locale: 'en',
      data,
      requiredFields: ['sipId'],
    });
    expect(out.missingVariables).toContain('nextAttemptDate');
  });

  it('HTML-escapes untrusted content in email HTML but keeps plain text readable', async () => {
    const data = { ...payload('TXNX-003'), reason: '<script>alert("x")</script> & co' };
    const email = await engine.render({
      ...base,
      eventType: 'TXNX-003',
      channel: 'email',
      locale: 'en',
      data,
    });
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
    expect(email.body).toContain('& co');
    const sms = await engine.render({
      ...base,
      eventType: 'RISK-003',
      channel: 'sms',
      locale: 'en',
      data: payload('RISK-003'),
    });
    expect(sms.body).toContain('P&L');
  });

  it('strips CR/LF from email subjects (header injection)', async () => {
    const out = engine.renderTemplate(
      { version: 1, subject: 'Hello {{policyTitle}}', body: 'x' },
      {
        ...base,
        eventType: 'REGX-005',
        channel: 'email',
        locale: 'en',
        data: { policyTitle: 'A\r\nBcc: evil@example.test' },
      },
      'en',
    );
    expect(out.subject).not.toMatch(/[\r\n]/);
  });

  it('renders the digest template with a list', async () => {
    const out = await engine.render({
      ...base,
      eventType: DIGEST_EVENT_TYPE,
      channel: 'email',
      locale: 'hi',
      data: SAMPLE_DIGEST,
    });
    expect(out.body).toContain('SIP due on 20 Jan 2026');
    expect(out.subject).toContain('3');
  });

  it('enforces push limits', async () => {
    const out = engine.renderTemplate(
      { version: 1, title: 'T'.repeat(100), body: 'B'.repeat(500) },
      { ...base, eventType: 'X', channel: 'push', locale: 'en', data: {} },
      'en',
    );
    expect(Array.from(out.title ?? '').length).toBe(65);
    expect(Array.from(out.body).length).toBe(240);
  });

  it('truncates SMS bodies beyond the segment budget', () => {
    const out = engine.renderTemplate(
      { version: 1, body: 'A'.repeat(1000) },
      { ...base, eventType: 'X', channel: 'sms', locale: 'en', data: {} },
      'en',
    );
    expect(out.sms?.truncated).toBe(true);
    expect(out.sms?.segments).toBe(4);
  });
});

describe('template validation (security)', () => {
  const vars = ['symbol', 'amount'];
  const cases: [string, string][] = [
    ['{{> partial}}', 'partials'],
    ['{{{symbol}}}', 'triple-stash'],
    ['{{lookup this "constructor"}}', 'unknown helper'],
    ['{{#each items}}{{../secret}}{{/each}}', 'parent scope'],
    ['{{constructor.constructor}}', 'unknown variable'],
    ['{{evilHelper symbol}}', 'unknown helper'],
    ['{{#custom}}x{{/custom}}', 'block helper'],
    ['{{#if}}', 'syntax'],
    ['{{process.env.SECRET}}', 'unknown variable'],
  ];
  it.each(cases)('rejects %s (%s)', (src) => {
    expect(engine.validate(src, vars).valid).toBe(false);
  });

  it('accepts safe templates and reports referenced variables', () => {
    const v = engine.validate('Hi {{user.name}}, {{currency amount}} for {{symbol}}', vars);
    expect(v.valid).toBe(true);
    expect(v.variables.sort()).toEqual(['amount', 'symbol', 'user']);
  });

  it('does not allow prototype access at runtime', () => {
    const out = engine.renderTemplate(
      { version: 1, body: '{{symbol.constructor}}|{{__proto__}}' },
      {
        ...base,
        eventType: 'X',
        channel: 'inapp' as Channel,
        locale: 'en' as Locale,
        data: { symbol: 'X' },
      },
      'en',
    );
    expect(out.body).toBe('|');
  });
});
