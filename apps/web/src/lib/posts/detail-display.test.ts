import { describe, expect, it } from 'vitest';
import { detailFieldValue, priceLine } from './detail-display';

const words = {
  free: 'ফ্রি',
  onRequest: 'দাম জানতে যোগাযোগ করুন',
  negotiable: 'আলোচনা সাপেক্ষে',
  perMonth: '/মাস',
};
const yesNo = { yes: 'হ্যাঁ', no: 'না' };
const label = { bn: 'লেবেল', en: 'Label' };

describe('priceLine', () => {
  it('groups the amount in Bengali digits and adds the price type', () => {
    expect(priceLine({ price: '12500.00', priceType: 'fixed' }, words)).toBe('৳ ১২,৫০০');
    expect(priceLine({ price: '12500.00', priceType: 'negotiable' }, words)).toBe(
      '৳ ১২,৫০০ (আলোচনা সাপেক্ষে)',
    );
    expect(priceLine({ price: '8000.00', priceType: 'per_month' }, words)).toBe('৳ ৮,০০০/মাস');
  });

  it('says free, or asks to get in touch, when there is no amount', () => {
    expect(priceLine({ price: null, priceType: 'free' }, words)).toBe('ফ্রি');
    expect(priceLine({ price: null, priceType: 'on_request' }, words)).toBe(
      'দাম জানতে যোগাযোগ করুন',
    );
  });
});

describe('detailFieldValue', () => {
  it("shows options by the labels of the post's own schema version", () => {
    expect(
      detailFieldValue(
        {
          key: 'condition',
          type: 'select',
          label,
          value: 'used',
          optionLabels: [{ bn: 'পুরনো', en: 'Used' }],
        },
        yesNo,
      ),
    ).toBe('পুরনো');
    expect(
      detailFieldValue(
        {
          key: 'features',
          type: 'multiselect',
          label,
          value: ['ac', 'lift'],
          optionLabels: [
            { bn: 'এসি', en: 'AC' },
            { bn: 'লিফট', en: 'Lift' },
          ],
        },
        yesNo,
      ),
    ).toBe('এসি, লিফট');
  });

  it('writes numbers, money and yes/no the Bengali way, and skips empty values', () => {
    expect(detailFieldValue({ key: 'rooms', type: 'number', label, value: 3 }, yesNo)).toBe('৩');
    expect(
      detailFieldValue({ key: 'deposit', type: 'money', label, value: '50000.00' }, yesNo),
    ).toBe('৳ ৫০,০০০');
    expect(detailFieldValue({ key: 'gas', type: 'bool', label, value: false }, yesNo)).toBe('না');
    expect(detailFieldValue({ key: 'note', type: 'text', label, value: '' }, yesNo)).toBeNull();
  });
});
