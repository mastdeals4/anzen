// Neutralises spreadsheet formula-injection payloads by prefixing cells whose
// string starts with =, +, -, @, TAB, or CR with a single quote. Excel treats
// leading ' as a literal indicator and does not evaluate the cell.
const FORMULA_TRIGGER_RE = /^[=+\-@\t\r]/;

export function sanitizeCsvCell(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  const s = String(value);
  if (FORMULA_TRIGGER_RE.test(s)) return `'${s}`;
  return s;
}

export function sanitizeExportRows<T extends Record<string, unknown>>(rows: T[]): T[] {
  return rows.map(row => {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(row)) {
      out[key] = sanitizeCsvCell(row[key]);
    }
    return out as T;
  });
}
