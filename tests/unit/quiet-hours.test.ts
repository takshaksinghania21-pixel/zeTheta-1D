import {
  evaluateQuietHours,
  nextDigestTime,
  quietWindowMinutes,
  validateQuietWindow,
} from '../../src/modules/scheduling/quiet-hours';

const win = { enabled: true, start: '21:00', end: '08:00' };

describe('quiet hours', () => {
  it('computes window length across midnight', () => {
    expect(quietWindowMinutes('21:00', '08:00')).toBe(660);
    expect(quietWindowMinutes('01:00', '07:00')).toBe(360);
  });

  it('enforces the six-hour minimum window', () => {
    expect(validateQuietWindow({ enabled: true, start: '22:00', end: '03:00' }, 360)).toMatch(
      /at least 6 hours/,
    );
    expect(validateQuietWindow({ enabled: true, start: '22:00', end: '04:00' }, 360)).toBeNull();
    expect(validateQuietWindow({ enabled: true, start: '05:00', end: '05:00' }, 360)).toMatch(
      /differ/,
    );
    expect(validateQuietWindow({ enabled: false, start: '05:00', end: '05:30' }, 360)).toBeNull();
  });

  it('is inside the window late evening in the user timezone (IST)', () => {
    // 16:00 UTC = 21:30 IST
    const r = evaluateQuietHours(new Date('2026-01-15T16:00:00Z'), 'Asia/Kolkata', win);
    expect(r.inQuietHours).toBe(true);
    expect(r.localTime).toBe('21:30');
    // ends 08:00 IST next day = 02:30 UTC
    expect(r.endsAt?.toISOString()).toBe('2026-01-16T02:30:00.000Z');
  });

  it('handles the after-midnight part of a window crossing midnight', () => {
    // 20:00 UTC = 01:30 IST (16th)
    const r = evaluateQuietHours(new Date('2026-01-15T20:00:00Z'), 'Asia/Kolkata', win);
    expect(r.inQuietHours).toBe(true);
    expect(r.endsAt?.toISOString()).toBe('2026-01-16T02:30:00.000Z');
  });

  it('treats the start boundary as inclusive and the end boundary as exclusive', () => {
    expect(
      evaluateQuietHours(new Date('2026-01-15T15:30:00Z'), 'Asia/Kolkata', win).inQuietHours,
    ).toBe(true); // 21:00 IST
    expect(
      evaluateQuietHours(new Date('2026-01-15T15:29:00Z'), 'Asia/Kolkata', win).inQuietHours,
    ).toBe(false); // 20:59
    expect(
      evaluateQuietHours(new Date('2026-01-16T02:30:00Z'), 'Asia/Kolkata', win).inQuietHours,
    ).toBe(false); // 08:00
    expect(
      evaluateQuietHours(new Date('2026-01-16T02:29:00Z'), 'Asia/Kolkata', win).inQuietHours,
    ).toBe(true); // 07:59
  });

  it('supports windows that do not cross midnight', () => {
    const day = { enabled: true, start: '09:00', end: '17:00' };
    expect(
      evaluateQuietHours(new Date('2026-01-15T05:00:00Z'), 'Asia/Kolkata', day).inQuietHours,
    ).toBe(true); // 10:30
    expect(
      evaluateQuietHours(new Date('2026-01-15T12:00:00Z'), 'Asia/Kolkata', day).inQuietHours,
    ).toBe(false); // 17:30
  });

  it('respects disabled quiet hours', () => {
    expect(
      evaluateQuietHours(new Date('2026-01-15T16:00:00Z'), 'Asia/Kolkata', {
        ...win,
        enabled: false,
      }).inQuietHours,
    ).toBe(false);
  });

  it('gives different answers for the same instant in different timezones', () => {
    const t = new Date('2026-01-15T16:00:00Z'); // 21:30 IST, 11:00 New York, 16:00 London
    expect(evaluateQuietHours(t, 'Asia/Kolkata', win).inQuietHours).toBe(true);
    expect(evaluateQuietHours(t, 'America/New_York', win).inQuietHours).toBe(false);
    expect(evaluateQuietHours(t, 'Europe/London', win).inQuietHours).toBe(false);
  });

  it('handles the US spring-forward DST transition (window end after the gap)', () => {
    // 2026-03-08 02:00 EST -> 03:00 EDT. At 01:30 EST (06:30Z) we are in quiet hours;
    // the window ends at 08:00 EDT = 12:00Z (only 5.5 real hours later).
    const r = evaluateQuietHours(new Date('2026-03-08T06:30:00Z'), 'America/New_York', win);
    expect(r.inQuietHours).toBe(true);
    expect(r.endsAt?.toISOString()).toBe('2026-03-08T12:00:00.000Z');
  });

  it('handles an end time that falls inside the spring-forward gap', () => {
    const gapEnd = { enabled: true, start: '20:00', end: '02:30' }; // 02:30 does not exist on 2026-03-08
    const r = evaluateQuietHours(new Date('2026-03-08T05:00:00Z'), 'America/New_York', gapEnd); // 00:00 EST
    expect(r.inQuietHours).toBe(true);
    // Luxon shifts the nonexistent 02:30 forward to 03:30 EDT = 07:30Z
    expect(r.endsAt?.toISOString()).toBe('2026-03-08T07:30:00.000Z');
  });

  it('handles the autumn fall-back transition (repeated hour)', () => {
    // 2026-11-01 02:00 EDT -> 01:00 EST in New York. At 23:00 EDT (03:00Z) the window ends 08:00 EST = 13:00Z.
    const r = evaluateQuietHours(new Date('2026-11-01T03:00:00Z'), 'America/New_York', win);
    expect(r.endsAt?.toISOString()).toBe('2026-11-01T13:00:00.000Z');
  });

  it('handles the UK DST transition', () => {
    // 2026-03-29 01:00 GMT -> 02:00 BST. 22:00 GMT on the 28th; window ends 08:00 BST = 07:00Z
    const r = evaluateQuietHours(new Date('2026-03-28T22:00:00Z'), 'Europe/London', win);
    expect(r.endsAt?.toISOString()).toBe('2026-03-29T07:00:00.000Z');
  });

  it('schedules daily and weekly digests in local time', () => {
    const now = new Date('2026-01-15T05:00:00Z'); // Thu 10:30 IST
    expect(nextDigestTime(now, 'Asia/Kolkata', '08:00', 'DAILY').toISOString()).toBe(
      '2026-01-16T02:30:00.000Z',
    );
    expect(
      nextDigestTime(
        new Date('2026-01-15T01:00:00Z'),
        'Asia/Kolkata',
        '08:00',
        'DAILY',
      ).toISOString(),
    ).toBe('2026-01-15T02:30:00.000Z');
    expect(nextDigestTime(now, 'Asia/Kolkata', '08:00', 'WEEKLY').toISOString()).toBe(
      '2026-01-19T02:30:00.000Z',
    ); // Monday
  });
});
