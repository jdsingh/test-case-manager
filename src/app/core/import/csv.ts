// CSV / TSV reading and writing. Google Sheets copies cells to the clipboard as TSV,
// quoting cells that contain tabs, newlines or quotes; File › Download gives CSV.

export type Delimiter = ',' | '\t' | ';';

/** Picks the delimiter that splits the first line into the most columns. */
export function detectDelimiter(text: string): Delimiter {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const count = (d: string) => first.split(d).length - 1;
  const candidates: Delimiter[] = ['\t', ',', ';'];
  return candidates.reduce((best, d) => (count(d) > count(best) ? d : best), ',' as Delimiter);
}

/** RFC 4180-style parser: quoted fields, doubled quotes, newlines inside quotes. */
export function parseDelimited(text: string, delimiter: Delimiter = detectDelimiter(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') {
      quoted = true;
    } else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  // Drop fully empty lines (trailing newlines, blank rows between data).
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

/**
 * Writes CSV. Cells that a spreadsheet would run as a formula (=, +, -, @) get a leading
 * apostrophe so exported test text can't execute in Excel or Sheets.
 */
export function toCsv(rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
