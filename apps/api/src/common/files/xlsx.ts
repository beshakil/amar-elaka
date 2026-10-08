import { readZip, writeZip, ZipFormatError, type ZipLimits } from './zip';

/**
 * The first sheet of an .xlsx workbook as rows of text, and a one-sheet
 * workbook from rows of text (ADR 056: no dependency). Covers what Excel,
 * Google Sheets and LibreOffice save: shared strings (rich text joined),
 * inline strings, numbers, booleans, cached formula results. Not covered,
 * on purpose: dates as date serials (cells come back as their number),
 * merged cells, multiple sheets. A cell's text is what the seller typed.
 */

export class XlsxFormatError extends Error {}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function unescapeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, entity: string) =>
    entity.startsWith('#x')
      ? String.fromCodePoint(parseInt(entity.slice(2), 16))
      : entity.startsWith('#')
        ? String.fromCodePoint(parseInt(entity.slice(1), 10))
        : ENTITIES[entity]!,
  );
}

function escapeXml(text: string): string {
  return (
    text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      // XML 1.0 can't carry most control characters (tab, LF and CR it can).
      .replace(/./gsu, (ch) => {
        const code = ch.codePointAt(0)!;
        return code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d ? '' : ch;
      })
  );
}

/** All <t> texts inside an element body, joined (rich text runs). */
function texts(body: string): string {
  return [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
    .map((m) => unescapeXml(m[1]!))
    .join('');
}

// settings-exempt: spreadsheet column letters are base 26
const LETTERS = 26;

/** "A" → 0, "Z" → 25, "AA" → 26. */
function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * LETTERS + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function columnName(index: number): string {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const rest = (n - 1) % LETTERS;
    name = String.fromCharCode(65 + rest) + name;
    n = Math.floor((n - 1) / LETTERS);
  }
  return name;
}

function resolvePath(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const part of target.split('/')) {
    if (part === '..') parts.pop();
    else if (part !== '.') parts.push(part);
  }
  return parts.join('/');
}

export function readXlsxFirstSheet(buffer: Buffer, limits: ZipLimits): string[][] {
  let files: Map<string, () => string>;
  try {
    files = new Map(readZip(buffer, limits).map((e) => [e.name, () => e.read().toString('utf8')]));
  } catch (error) {
    if (error instanceof ZipFormatError)
      throw new XlsxFormatError(`not an .xlsx workbook: ${error.message}`);
    throw error;
  }
  const workbook = files.get('xl/workbook.xml')?.();
  if (!workbook) throw new XlsxFormatError('not an .xlsx workbook: no xl/workbook.xml');
  const firstSheetRel = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook)?.[1];
  const rels = files.get('xl/_rels/workbook.xml.rels')?.() ?? '';
  const target = firstSheetRel
    ? [...rels.matchAll(/<Relationship\b[^>]*>/g)]
        .map((m) => m[0])
        .find((tag) => tag.includes(`Id="${firstSheetRel}"`))
        ?.match(/Target="([^"]+)"/)?.[1]
    : undefined;
  const sheetPath = target ? resolvePath('xl/workbook.xml', target) : 'xl/worksheets/sheet1.xml';
  const sheet = files.get(sheetPath)?.();
  if (!sheet) throw new XlsxFormatError('the workbook has no first sheet');

  const shared = [
    ...(files.get('xl/sharedStrings.xml')?.() ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g),
  ].map((m) => texts(m[1]!));

  const rows: string[][] = [];
  for (const rowMatch of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
    const attributes = rowMatch[1] ?? rowMatch[3] ?? '';
    const rowNumber = Number(/\br="(\d+)"/.exec(attributes)?.[1] ?? rows.length + 1);
    const cells: string[] = [];
    for (const cellMatch of (rowMatch[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const cellAttributes = cellMatch[1]!;
      const body = cellMatch[2] ?? '';
      const ref = /\br="([A-Z]+)\d*"/.exec(cellAttributes)?.[1];
      const index = ref ? columnIndex(ref) : cells.length;
      const type = /\bt="([^"]+)"/.exec(cellAttributes)?.[1];
      const value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let text = '';
      if (type === 's') text = shared[Number(value)] ?? '';
      else if (type === 'inlineStr') text = texts(body);
      else if (type === 'b') text = value === '1' ? 'TRUE' : value === '0' ? 'FALSE' : '';
      else if (value !== undefined) text = unescapeXml(value);
      while (cells.length < index) cells.push('');
      cells[index] = text;
    }
    while (rows.length < rowNumber - 1) rows.push([]);
    rows[rowNumber - 1] = cells;
  }
  return rows;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;
const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
// One bold style (index 1) for the header row.
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

/** A one-sheet workbook; every cell text (inline strings), the first row bold. */
export function writeXlsx(sheetName: string, rows: readonly (readonly string[])[]): Buffer {
  const sheetRows = rows
    .map((row, r) => {
      const cells = row
        .map((value, c) => {
          const style = r === 0 ? ' s="1"' : '';
          return `<c r="${columnName(c)}${r + 1}" t="inlineStr"${style}><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join('');
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  return writeZip([
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES) },
    { name: '_rels/.rels', data: Buffer.from(ROOT_RELS) },
    { name: 'xl/workbook.xml', data: Buffer.from(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(WORKBOOK_RELS) },
    { name: 'xl/styles.xml', data: Buffer.from(STYLES) },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheet) },
  ]);
}
