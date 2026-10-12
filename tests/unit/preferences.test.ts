import { loadPolicy } from '../../src/config/policy';
import { channelsForEvent, resolvePreferences } from '../../src/modules/preferences/resolver';
import { EventTaxonomy } from '../../src/modules/taxonomy/taxonomy';

const policy = loadPolicy();
const taxonomy = EventTaxonomy.load();

describe('preference hierarchy', () => {
  it('layer 1: system defaults apply when nothing else is set', () => {
    const p = resolvePreferences(policy, 'RETAIL', {});
    expect(p.channels).toEqual({
      sms: true,
      email: true,
      push: true,
      whatsapp: false,
      inapp: true,
    });
    expect(p.quietHours).toEqual({ enabled: true, start: '21:00', end: '08:00' });
    expect(p.timezone).toBe('Asia/Kolkata');
    expect(p.sources['channels.sms']).toBe('SYSTEM');
  });

  it('layer 2: segment overrides beat system defaults', () => {
    const p = resolvePreferences(policy, 'HNI', {});
    expect(p.channels.whatsapp).toBe(true);
    expect(p.sources['channels.whatsapp']).toBe('SEGMENT');
    const n = resolvePreferences(policy, 'NEW_INVESTOR', {});
    expect(n.categories.MARKET.enabled).toBe(false);
  });

  it('layer 3: explicit user preferences beat segment overrides', () => {
    const p = resolvePreferences(policy, 'HNI', {
      channels: { whatsapp: false },
      categories: { MARKET: { enabled: true } },
    });
    expect(p.channels.whatsapp).toBe(false);
    expect(p.sources['channels.whatsapp']).toBe('USER');
  });

  it('falls back to the default timezone for invalid IANA zones', () => {
    expect(resolvePreferences(policy, 'RETAIL', { timezone: 'Mars/Olympus' }).timezone).toBe(
      'Asia/Kolkata',
    );
    expect(resolvePreferences(policy, 'RETAIL', { timezone: 'Europe/London' }).timezone).toBe(
      'Europe/London',
    );
  });

  it('unknown segments behave like system defaults', () => {
    expect(resolvePreferences(policy, 'UNKNOWN', {}).channels.sms).toBe(true);
  });

  it('layer 4: regulatory override adds only mandatory channels the user disabled', () => {
    const def = taxonomy.get('RISK-001')!;
    const prefs = resolvePreferences(policy, 'RETAIL', { channels: { sms: false, inapp: false } });
    const sel = channelsForEvent(def, prefs);
    expect(sel.overridden).toEqual(['sms']);
    expect(sel.disabledByUser).toEqual(['inapp']);
    expect(sel.preferred).toEqual(['push']);
  });

  it('category-level disable removes all channels for non-mandatory events', () => {
    const def = taxonomy.get('MKTX-001')!;
    const sel = channelsForEvent(
      def,
      resolvePreferences(policy, 'RETAIL', { categories: { MARKET: { enabled: false } } }),
    );
    expect(sel.preferred).toEqual([]);
    expect(sel.categoryDisabled).toBe(true);
  });

  it('category channel lists are intersected with permitted channels', () => {
    const def = taxonomy.get('MKTX-003')!; // permitted: push, inapp, email
    const sel = channelsForEvent(
      def,
      resolvePreferences(policy, 'RETAIL', {
        categories: { MARKET: { channels: ['sms', 'push'] } },
      }),
    );
    expect(sel.preferred).toEqual(['push']);
  });

  it('never overrides preferences for promotional events', () => {
    const def = taxonomy.get('SIPX-004')!;
    const sel = channelsForEvent(
      def,
      resolvePreferences(policy, 'RETAIL', { channels: { push: false, email: false } }),
    );
    expect(sel.overridden).toEqual([]);
  });
});
