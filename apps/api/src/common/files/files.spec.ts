import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { parseCsv, safeCell, toCsv } from './csv';
import { readXlsxFirstSheet, writeXlsx } from './xlsx';
import { readZip, writeZip, ZipLimitError } from './zip';

const LIMITS = { maxEntries: 100, maxUnpackedBytes: 10_000_000 };

describe('CSV', () => {
  it('reads quotes, doubled quotes, commas and line breaks in cells, CRLF and a BOM', () => {
    const text = '﻿শিরোনাম,দাম\r\n"চাল, মিনিকেট",1500\r\n"বলে ""ভালো""","দুই\nলাইন"\n';
    expect(parseCsv(text)).toEqual([
      ['শিরোনাম', 'দাম'],
      ['চাল, মিনিকেট', '1500'],
      ['বলে "ভালো"', 'দুই\nলাইন'],
    ]);
  });

  it('writes what it reads, and never a live formula', () => {
    const rows = [
      ['a,b', '=HYPERLINK("x")', 'plain'],
      ['-1', '"q"', ''],
    ];
    const csv = toCsv(rows);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(parseCsv(csv)).toEqual([
      ['a,b', `'=HYPERLINK("x")`, 'plain'],
      ["'-1", '"q"', ''],
    ]);
    expect(safeCell('@SUM(A1)')).toBe("'@SUM(A1)");
  });
});

describe('ZIP', () => {
  it('round-trips files, Bengali names included', () => {
    const zip = writeZip([
      { name: 'ছবি/১.txt', data: Buffer.from('এক') },
      { name: 'b.bin', data: Buffer.alloc(5000, 7) },
    ]);
    const entries = readZip(zip, LIMITS);
    expect(entries.map((e) => [e.name, e.read().toString('utf8').slice(0, 2)])).toEqual([
      ['ছবি/১.txt', 'এক'],
      ['b.bin', '\u0007\u0007'],
    ]);
  });

  it('refuses archives over the entry or size limit before inflating', () => {
    const zip = writeZip([
      { name: 'a', data: Buffer.alloc(10) },
      { name: 'b', data: Buffer.alloc(10) },
    ]);
    expect(() => readZip(zip, { maxEntries: 1, maxUnpackedBytes: 1000 })).toThrow(ZipLimitError);
    expect(() => readZip(zip, { maxEntries: 10, maxUnpackedBytes: 15 })).toThrow(ZipLimitError);
  });

  it('a lying size header is caught when the entry is read', () => {
    const zip = writeZip([{ name: 'bomb', data: Buffer.alloc(100) }]);
    // Declare 10 bytes in the central directory: inflating more must fail, not grow.
    const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt32LE(10, central + 24);
    expect(() => readZip(zip, LIMITS)[0]!.read()).toThrow();
    expect(deflateRawSync(Buffer.alloc(1)).length).toBeGreaterThan(0);
  });
});

describe('XLSX', () => {
  it('reads a workbook another tool wrote (openpyxl): text, numbers, booleans, gaps', () => {
    const file = readFileSync(
      join(__dirname, '../../../test/fixtures/import/openpyxl-sample.xlsx'),
    );
    expect(readXlsxFirstSheet(file, LIMITS)).toEqual([
      ['শিরোনাম', 'দাম', 'অবস্থা', 'হোম ডেলিভারি'],
      ['স্যামসাং A15 মোবাইল', '15000', 'নতুন', 'TRUE'],
      ['পুরনো ফ্রিজ "ওয়ালটন"', '8500.5', 'পুরাতন', 'FALSE'],
      [],
      ['ফাঁকা সারির পরে', '', 'নতুন'],
    ]);
  });

  it('reads back what it writes', () => {
    const rows = [
      ['শিরোনাম *', 'দাম (৳) *'],
      ['স্যামসাং <A15> & "নতুন"', '15000'],
    ];
    expect(readXlsxFirstSheet(writeXlsx('টেমপ্লেট', rows), LIMITS)).toEqual(rows);
  });
});
