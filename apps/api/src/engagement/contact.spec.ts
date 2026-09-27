import { contactMessage } from './contact-message.templates';
import { contactHref, LEAD_CHANNEL, offeredChannels } from './contact-payload';
import { randomShortCode, SHORT_CODE_ALPHABET } from './share.service';
import { viewerKey } from './viewer-key';

describe('contact payload', () => {
  const phone = '+8801712345678';
  const message = contactMessage('আইফোন ১৩', 'https://mirpur.amarelaka.com/s/abcd2345');

  it('writes a Bengali message naming the app, the listing and its link', () => {
    expect(message).toContain('"আমার এলাকা"');
    expect(message).toContain('"আইফোন ১৩"');
    expect(message.endsWith('\nhttps://mirpur.amarelaka.com/s/abcd2345')).toBe(true);
    expect(contactMessage('Bike', null, 'en')).toBe(
      'Hello! I saw your listing "Bike" on Amar Elaka. Is it still available?',
    );
  });

  it('builds tel:, sms: and wa.me links, the message URL-encoded', () => {
    expect(contactHref('call', phone, message)).toBe('tel:+8801712345678');
    const sms = contactHref('sms', phone, message);
    expect(sms.startsWith('sms:+8801712345678?body=')).toBe(true);
    expect(decodeURIComponent(sms.split('?body=')[1]!)).toBe(message);
    const wa = new URL(contactHref('whatsapp', phone, message));
    expect(wa.origin + wa.pathname).toBe('https://wa.me/8801712345678');
    expect(wa.searchParams.get('text')).toBe(message);
  });

  it('offers calls and SMS with showPhone, WhatsApp only with both toggles, nothing without a number', () => {
    expect(offeredChannels({ hasPhone: true, showPhone: true, showWhatsapp: false })).toEqual([
      'call',
      'sms',
    ]);
    expect(offeredChannels({ hasPhone: true, showPhone: true, showWhatsapp: true })).toEqual([
      'call',
      'whatsapp',
      'sms',
    ]);
    expect(offeredChannels({ hasPhone: true, showPhone: false, showWhatsapp: true })).toEqual([]);
    expect(offeredChannels({ hasPhone: false, showPhone: true, showWhatsapp: true })).toEqual([]);
  });

  it('records each channel under its lead_channels code', () => {
    expect(LEAD_CHANNEL).toEqual({
      call: 'call_click',
      whatsapp: 'whatsapp_click',
      sms: 'sms_click',
    });
  });
});

describe('viewerKey', () => {
  const secret = 'test-secret-0123456789';
  const base = { userId: undefined, installId: undefined, ip: '203.0.113.7', userAgent: 'UA' };

  it('is stable for one viewer and differs between viewers', () => {
    expect(viewerKey(secret, base)).toBe(viewerKey(secret, base));
    expect(viewerKey(secret, base)).not.toBe(viewerKey(secret, { ...base, ip: '203.0.113.8' }));
    expect(viewerKey(secret, { ...base, installId: 'install-aaaa' })).not.toBe(
      viewerKey(secret, { ...base, installId: 'install-bbbb' }),
    );
  });

  it('prefers the user, then the install id, over the network address', () => {
    const user = '0191e3a0-0000-7000-8000-000000000001';
    // A signed-in user is one viewer on any network or device.
    expect(viewerKey(secret, { ...base, userId: user })).toBe(
      viewerKey(secret, { ...base, userId: user, ip: '198.51.100.1', installId: 'install-cccc' }),
    );
    // An install id survives a network change.
    expect(viewerKey(secret, { ...base, installId: 'install-aaaa' })).toBe(
      viewerKey(secret, { ...base, installId: 'install-aaaa', ip: '198.51.100.1' }),
    );
  });

  it('ignores a malformed install id rather than trusting it', () => {
    expect(viewerKey(secret, { ...base, installId: 'x' })).toBe(viewerKey(secret, base));
    expect(viewerKey(secret, { ...base, installId: 'a b c d e f g h' })).toBe(
      viewerKey(secret, base),
    );
  });

  it("is keyed: the raw identity can't be read back or recomputed without the secret", () => {
    const user = '0191e3a0-0000-7000-8000-000000000001';
    const key = viewerKey(secret, { ...base, userId: user });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain(user);
    expect(viewerKey('another-secret-012345', { ...base, userId: user })).not.toBe(key);
  });
});

describe('randomShortCode', () => {
  it('uses only unambiguous lowercase letters and digits, at the asked length', () => {
    for (let i = 0; i < 50; i++) {
      const code = randomShortCode(8);
      expect(code).toHaveLength(8);
      expect([...code].every((c) => SHORT_CODE_ALPHABET.includes(c))).toBe(true);
    }
    expect(SHORT_CODE_ALPHABET).not.toMatch(/[01ilo]/);
  });
});
