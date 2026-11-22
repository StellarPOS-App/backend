/** Minimal RFC 4180 CSV writer used by the streaming report endpoint. */

/**
 * Escapes one cell. String cells beginning with a spreadsheet formula trigger
 * (=, +, -, @) are prefixed with an apostrophe so a merchant name cannot turn
 * into a formula when the export is opened in Excel or Sheets.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'string' ? value : String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One CRLF-terminated CSV record. */
export function csvLine(cells: unknown[]): string {
  return `${cells.map(csvCell).join(',')}\r\n`;
}
