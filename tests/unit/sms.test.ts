import { isGsm7, smsInfo, truncateSms } from '../../src/modules/templates/sms';

describe('SMS length rules', () => {
  it('detects GSM-7 vs UCS-2', () => {
    expect(isGsm7('Hello Rs.100 @ 5%')).toBe(true);
    expect(isGsm7('₹100')).toBe(false);
    expect(isGsm7('नमस्ते')).toBe(false);
  });
  it('counts single and multipart segments', () => {
    expect(smsInfo('a'.repeat(160)).segments).toBe(1);
    expect(smsInfo('a'.repeat(161)).segments).toBe(2);
    expect(smsInfo('a'.repeat(306)).segments).toBe(2);
    expect(smsInfo('a'.repeat(307)).segments).toBe(3);
    expect(smsInfo('न'.repeat(70)).segments).toBe(1);
    expect(smsInfo('न'.repeat(71)).segments).toBe(2);
  });
  it('counts extension characters as two septets', () => {
    expect(smsInfo('{'.repeat(80)).units).toBe(160);
    expect(smsInfo('{'.repeat(81)).segments).toBe(2);
  });
  it('truncates without splitting surrogate pairs', () => {
    const t = truncateSms('😀'.repeat(200), 70);
    expect(t.truncated).toBe(true);
    expect(smsInfo(t.text).units).toBeLessThanOrEqual(70);
    expect(t.text.endsWith('...')).toBe(true);
    expect(t.text.replace('...', '')).toMatch(/^(😀)+$/u);
  });
  it('leaves short messages untouched', () => {
    expect(truncateSms('ok', 160)).toEqual({ text: 'ok', truncated: false });
  });
  it('fits 160 characters with an ellipsis and keeps a trailing link (PDF §A4.3)', () => {
    const link = 'https://zetheta.example/kyc';
    const t = truncateSms(
      `${'Your KYC documents expire soon, please update them. '.repeat(5)}${link}`,
      160,
    );
    expect(t.truncated).toBe(true);
    expect(smsInfo(t.text).units).toBeLessThanOrEqual(160);
    expect(t.text.endsWith(`... ${link}`)).toBe(true);
    const plain = truncateSms('x'.repeat(300), 160);
    expect(plain.text).toHaveLength(160);
    expect(plain.text.endsWith('...')).toBe(true);
  });
});
