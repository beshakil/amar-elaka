import type { FieldSchema, UiSchema } from '../../categories/field-schema';
import { importColumns, matchHeaders, moneyFromCell, parseRow, CellError } from './import-columns';
import { fetchImage, ImageSourceError, isBlockedAddress } from './image-source';
import { splitSheet } from './store-import-runner.service';

const schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    price: { 'x-field-type': 'money', type: 'string' },
    condition: { 'x-field-type': 'select', type: 'string', enum: ['new', 'used'] },
    warranty: { 'x-field-type': 'bool', type: 'boolean' },
    colors: {
      'x-field-type': 'multiselect',
      type: 'array',
      items: { type: 'string', enum: ['red', 'blue'] },
      uniqueItems: true,
    },
    year: { 'x-field-type': 'number', type: 'integer', minimum: 1990 },
  },
  required: ['price'],
} as unknown as FieldSchema;
const ui = {
  order: ['price', 'condition', 'warranty', 'colors', 'year'],
  card: [],
  labels: {
    price: { bn: 'দাম', en: 'Price' },
    condition: { bn: 'অবস্থা', en: 'Condition' },
    warranty: { bn: 'ওয়ারেন্টি', en: 'Warranty' },
    colors: { bn: 'রং', en: 'Colors' },
    year: { bn: 'সাল', en: 'Year' },
  },
  options: {
    condition: { new: { bn: 'নতুন', en: 'New' }, used: { bn: 'পুরাতন', en: 'Used' } },
    colors: { red: { bn: 'লাল', en: 'Red' }, blue: { bn: 'নীল', en: 'Blue' } },
  },
} as unknown as UiSchema;

describe('import columns (ADR 056)', () => {
  const columns = importColumns(schema, ui, 2);

  it('the template: Bengali headers, required starred, photo columns', () => {
    expect(columns.map((c) => c.header)).toEqual([
      'শিরোনাম *',
      'বিবরণ',
      'দাম *',
      'অবস্থা',
      'ওয়ারেন্টি',
      'রং',
      'সাল',
      'ছবি ১',
      'ছবি ২',
    ]);
  });

  it('reads a row by header, in any order, Bengali or English, labels or codes, Bengali digits', () => {
    const matched = matchHeaders(
      ['Price', 'Title', 'রং', 'Condition', 'ছবি ১', 'Warranty', 'সাল', 'unknown'],
      columns,
    );
    expect(matched.at(-1)).toBeUndefined();
    const row = parseRow(
      ['৳ ১,৫০০', 'স্যামসাং', 'লাল; Blue', 'used', 'a.jpg', 'হ্যাঁ', '২০২২', 'x'],
      matched,
      ui,
    );
    expect(row).toEqual({
      title: 'স্যামসাং',
      description: undefined,
      fields: {
        price: '1500.00',
        colors: ['red', 'blue'],
        condition: 'used',
        warranty: true,
        year: 2022,
      },
      images: ['a.jpg'],
    });
  });

  it('a bad cell names its column and says why', () => {
    const matched = matchHeaders(['শিরোনাম *', 'অবস্থা'], columns);
    expect(() => parseRow(['ফ্রিজ', 'ভাঙা'], matched, ui)).toThrow(
      /অবস্থা: "ভাঙা" তালিকায় নেই; লিখুন: নতুন, পুরাতন/,
    );
    expect(() => parseRow(['', 'নতুন'], matched, ui)).toThrow(CellError);
  });

  it('money never goes through a float', () => {
    expect(moneyFromCell('1500')).toBe('1500.00');
    expect(moneyFromCell('0.5')).toBe('0.50');
    expect(moneyFromCell('১২,৩৪,৫৬৭.৮')).toBe('1234567.80');
    expect(() => moneyFromCell('1.234')).toThrow(CellError);
    expect(() => moneyFromCell('দাম জানতে কল')).toThrow(CellError);
  });

  it('splits header and data rows, numbered as the spreadsheet numbers them', () => {
    expect(splitSheet([[''], ['h1', 'h2'], ['a'], [''], ['b'], ['', ''], []])).toEqual({
      header: ['h1', 'h2'],
      data: [
        { number: 3, cells: ['a'] },
        { number: 4, cells: [''] },
        { number: 5, cells: ['b'] },
      ],
    });
  });
});

describe('fetching an image URL (SSRF)', () => {
  const publicDns = () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]);

  it('blocks every internal range', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.9',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
    ]) {
      expect([address, isBlockedAddress(address)]).toEqual([address, true]);
    }
    expect(isBlockedAddress('93.184.216.34')).toBe(false);
    expect(isBlockedAddress('2606:4700:4700::1111')).toBe(false);
  });

  it('refuses a name that resolves inside, a literal inside, and a redirect inside', async () => {
    const fetchImpl = jest.fn();
    const options = { timeoutMs: 1000, attempts: 1, maxBytes: 100 };
    await expect(
      fetchImage('http://127.0.0.1/a.jpg', { ...options, fetchImpl }),
    ).rejects.toMatchObject({ reasonCode: 'image_url_blocked' });
    await expect(
      fetchImage('http://intranet.example/a.jpg', {
        ...options,
        fetchImpl,
        lookup: () => Promise.resolve([{ address: '10.0.0.5', family: 4 }]),
      }),
    ).rejects.toMatchObject({ reasonCode: 'image_url_blocked' });
    expect(fetchImpl).not.toHaveBeenCalled();

    const redirecting = jest
      .fn()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } }),
      );
    await expect(
      fetchImage('http://cdn.example/a.jpg', {
        ...options,
        fetchImpl: redirecting,
        lookup: publicDns,
      }),
    ).rejects.toMatchObject({
      reasonCode: 'image_url_blocked',
    });
    await expect(fetchImage('ftp://cdn.example/a.jpg', options)).rejects.toMatchObject({
      reasonCode: 'image_url_invalid',
    });
  });

  it('stops at the byte cap, retries a 5xx, and gives up with a typed error', async () => {
    const big = jest.fn().mockResolvedValue(new Response(new Uint8Array(500)));
    await expect(
      fetchImage('http://cdn.example/a.jpg', {
        timeoutMs: 1000,
        attempts: 1,
        maxBytes: 100,
        fetchImpl: big,
        lookup: publicDns,
      }),
    ).rejects.toMatchObject({ reasonCode: 'image_too_large' });

    const flaky = jest
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));
    const bytes = await fetchImage('http://cdn.example/a.jpg', {
      timeoutMs: 1000,
      attempts: 2,
      maxBytes: 100,
      fetchImpl: flaky,
      lookup: publicDns,
    });
    expect([...bytes]).toEqual([1, 2, 3]);

    const down = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
    await expect(
      fetchImage('http://cdn.example/a.jpg', {
        timeoutMs: 1000,
        attempts: 2,
        maxBytes: 100,
        fetchImpl: down,
        lookup: publicDns,
      }),
    ).rejects.toBeInstanceOf(ImageSourceError);
    expect(down).toHaveBeenCalledTimes(2);
  });
});
