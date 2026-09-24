/**
 * Serialises already-visible, already-filtered rows. Hand-rolled because a CSV
 * writer for known-shaped strings is a few lines, and a dependency for it would
 * be a dependency to keep updated.
 */
export function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers, ...rows].map((row) => row.map(escapeCell).join(',')).join('\r\n');
}

function escapeCell(value: unknown): string {
  const text = stringify(value);
  // A leading =, +, - or @ is interpreted as a formula by spreadsheet apps, so
  // it gets a quote prefix; quotes and separators force quoting.
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /["\n\r,]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value.toString();
  }
  return JSON.stringify(value) ?? '';
}

// Excel only reads a CSV as UTF-8 when it starts with a byte-order mark;
// without it, Bengali text arrives as mojibake.
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

export function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([`${BYTE_ORDER_MARK}${content}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
