import { formatTaka, renderTemplate } from './template-renderer';

describe('renderTemplate (ADR 059)', () => {
  it('writes counts in Bengali numerals for bn, ASCII for en', () => {
    expect(renderTemplate('{{count|number}}টি নতুন মেসেজ', { count: '4' }, 'bn')).toBe(
      '৪টি নতুন মেসেজ',
    );
    expect(renderTemplate('{{count|number}} new messages', { count: '4' }, 'en')).toBe(
      '4 new messages',
    );
    expect(renderTemplate('{{n|number}}', { n: '1240' }, 'bn')).toBe('১,২৪০');
    expect(renderTemplate('{{n|number}}', { n: '1234567' }, 'bn')).toBe('১২,৩৪,৫৬৭');
  });

  it('never re-digits a plain value (a title with numbers stays as written)', () => {
    expect(renderTemplate('"{{postTitle}}"', { postTitle: 'iPhone 12 Pro' }, 'bn')).toBe(
      '"iPhone 12 Pro"',
    );
  });

  it('formats money as taka', () => {
    expect(formatTaka('12000.00', 'bn')).toBe('৳১২,০০০');
    expect(formatTaka('99.5', 'bn')).toBe('৳৯৯.৫০');
    expect(formatTaka('12000.00', 'en')).toBe('Tk 12,000');
    expect(
      renderTemplate('{{from|taka}} থেকে {{to|taka}}', { from: '15000.00', to: '12500.00' }, 'bn'),
    ).toBe('৳১৫,০০০ থেকে ৳১২,৫০০');
  });

  it('formats a date in Asia/Dhaka, with Bengali digits for bn', () => {
    // 18:30 UTC on 11 Oct is already 12 Oct in Dhaka.
    expect(renderTemplate('{{at|date}}', { at: '2026-10-11T18:30:00Z' }, 'bn')).toBe('১২ অক্টোবর');
    expect(renderTemplate('{{at|date}}', { at: '2026-10-11T18:30:00Z' }, 'en')).toBe('12 October');
  });

  it('shows a section only when its value is there, an inverted one only when not', () => {
    const tpl =
      '"{{t}}" সরানো হয়েছে।{{#reason}} কারণ: {{reason}}।{{/reason}}{{^reason}} বিস্তারিত অ্যাপে।{{/reason}}';
    expect(renderTemplate(tpl, { t: 'ফোন', reason: 'স্প্যাম' }, 'bn')).toBe(
      '"ফোন" সরানো হয়েছে। কারণ: স্প্যাম।',
    );
    expect(renderTemplate(tpl, { t: 'ফোন', reason: null }, 'bn')).toBe(
      '"ফোন" সরানো হয়েছে। বিস্তারিত অ্যাপে।',
    );
    expect(
      renderTemplate('{{#failed}}{{failed|number}}টি হয়নি{{/failed}}', { failed: '0' }, 'bn'),
    ).toBe('');
    expect(
      renderTemplate('{{#failed}}{{failed|number}}টি হয়নি{{/failed}}', { failed: '3' }, 'bn'),
    ).toBe('৩টি হয়নি');
  });

  it('renders nested sections', () => {
    const tpl =
      '{{^bad}}{{n|number}}টি যোগ হয়েছে।{{#failed}} {{failed|number}}টি হয়নি।{{/failed}}{{/bad}}{{#bad}}হয়নি।{{/bad}}';
    expect(renderTemplate(tpl, { n: '48', failed: '2' }, 'bn')).toBe('৪৮টি যোগ হয়েছে। ২টি হয়নি।');
    expect(renderTemplate(tpl, { n: '48', failed: '0' }, 'bn')).toBe('৪৮টি যোগ হয়েছে।');
    expect(renderTemplate(tpl, { bad: 'true' }, 'bn')).toBe('হয়নি।');
  });

  it('renders a missing variable as nothing', () => {
    expect(renderTemplate('[{{nope}}]', {}, 'bn')).toBe('[]');
  });
});
