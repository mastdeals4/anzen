/**
 * Normalize the two historical representations of an expense/bank link.
 *
 * bank_statement_allocations is authoritative whenever it exists.  Legacy
 * matched_expense_id rows are retained only for statement lines that have no
 * canonical allocation.  Grouping by the physical statement-line id (rather
 * than amount) is intentional: a legacy row contains the full bank amount,
 * while a canonical row may be a partial allocation.
 */
export interface ExpenseBankLink {
  id: string;
  raw_line_id?: string | null;
  allocation_id?: string | null;
  allocation_amount?: number | null;
  debit_amount?: number | null;
  credit_amount?: number | null;
}

export function normalizeExpenseBankLinks<T extends ExpenseBankLink>(rows: T[]): T[] {
  const groups = new Map<string, { legacy?: T; canonical: T[] }>();

  for (const row of rows) {
    const lineId = String(row.raw_line_id || row.id);
    const group = groups.get(lineId) || { canonical: [] };
    if (row.allocation_id) group.canonical.push(row);
    else if (!group.legacy) group.legacy = row;
    groups.set(lineId, group);
  }

  const normalized: T[] = [];
  for (const [lineId, group] of groups) {
    if (group.canonical.length === 0) {
      if (group.legacy) normalized.push(group.legacy);
      continue;
    }

    const first = group.canonical[0];
    const allocated = group.canonical.reduce(
      (sum, row) => sum + Number(row.allocation_amount || 0),
      0,
    );
    normalized.push({
      ...first,
      id: group.canonical.length === 1 ? first.id : `${lineId}_allocations`,
      raw_line_id: lineId,
      allocation_amount: allocated,
      allocation_id: first.allocation_id,
    } as T);
  }
  return normalized;
}
