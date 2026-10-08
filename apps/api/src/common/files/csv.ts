/**
 * CSV (RFC 4180) without a dependency (ADR 056): quoted fields, doubled
 * quotes, commas and line breaks inside quotes, CRLF or LF, a UTF-8 BOM.
 */

const BOM = '﻿';

/** Rows of cells. A trailing empty line is not a row. */
export function parseCsv(text: string): string[][] {
  const input = text.startsWith(BOM) ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }
    if (ch === '"' && cell === '') {
      quoted = true;
      i++;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
      i++;
    } else if (ch === '\r' || ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += ch === '\r' && input[i + 1] === '\n' ? 2 : 1;
    } else {
      cell += ch;
      i++;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/**
 * A cell a spreadsheet would run as a formula (=, +, -, @, tab, CR) gets a
 * leading apostrophe: a report or export must never execute what a seller
 * or buyer typed (CSV injection).
 */
export function safeCell(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function quote(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** CSV text with a BOM (so Excel reads UTF-8 Bengali right) and CRLF line ends. */
export function toCsv(rows: readonly (readonly (string | number | null | undefined)[])[]): string {
  return (
    BOM +
    rows
      .map((row) =>
        row
          .map((cell) => quote(safeCell(cell === null || cell === undefined ? '' : String(cell))))
          .join(','),
      )
      .join('\r\n') +
    '\r\n'
  );
}
