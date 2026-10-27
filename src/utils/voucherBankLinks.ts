export interface BankStatementLineDetails {
  id: string;
  transaction_date?: string | null;
  description?: string | null;
  reference?: string | null;
  debit_amount?: number | null;
  credit_amount?: number | null;
  bank_account_id?: string | null;
}

export interface CanonicalAllocationDetail {
  id?: string;
  bank_statement_line_id: string;
  allocation_amount: number;
  document_id: string;
  document_type: string;
  bank_statement_lines?: BankStatementLineDetails | null;
}

export interface LegacyLinkDetail {
  bank_statement_line_id: string;
  debit_amount?: number | null;
  credit_amount?: number | null;
  transaction_date?: string | null;
  description?: string | null;
  reference?: string | null;
  bank_account_id?: string | null;
  manually_unlinked?: boolean | null;
}

export type VoucherBankLinkStatus = 'linked' | 'partial' | 'unlinked' | 'needs_review';

export interface VoucherBankLinkEvaluation {
  status: VoucherBankLinkStatus;
  statusLabel: string;
  canonicalAmount: number;
  expectedAmount: number;
  currency: string;
  allocations: CanonicalAllocationDetail[];
  legacyLinks: LegacyLinkDetail[];
  hasConflict: boolean;
  conflictReason?: string;
}

export const BANK_LINK_EPSILON = 0.01;

/**
 * Authoritative evaluation of a voucher's bank-reconciliation link status.
 *
 * Rules:
 * - Uses canonical bank_statement_allocations as the sole source of truth.
 * - Does not rely on stale legacy flags (e.g. manually_unlinked on bank_statement_lines).
 * - Green (linked): Valid canonical allocations cover the full voucher amount.
 * - Yellow (partial): Valid canonical allocations cover part of the voucher amount.
 * - Muted/red (unlinked): No valid bank allocation exists.
 * - Amber (needs_review): Genuine data-integrity problem exists (missing statement line,
 *   invalid reference, duplicate allocation, or over-allocation).
 * - A posted voucher is not assumed to be bank-linked. Invoice allocation or selected
 *   bank account is not proof of bank reconciliation.
 */
export function evaluateVoucherBankLink({
  expectedAmount,
  canonicalAllocations,
  legacyLinks,
  currency = 'IDR',
  isInternalSettlement = false,
  isCash = false,
}: {
  expectedAmount: number;
  canonicalAllocations?: CanonicalAllocationDetail[] | null;
  legacyLinks?: LegacyLinkDetail[] | null;
  currency?: string;
  isInternalSettlement?: boolean;
  isCash?: boolean;
}): VoucherBankLinkEvaluation {
  const expected = Math.max(0, Number(expectedAmount || 0));
  const rawCanonical = canonicalAllocations || [];
  const legacy = legacyLinks || [];

  // Filter valid allocations
  const canonical = rawCanonical.filter(a => Number(a.allocation_amount || 0) > 0);
  const canonicalAmount = canonical.reduce((sum, a) => sum + Number(a.allocation_amount || 0), 0);

  // If internal settlement (salary advance deduction) or cash, no bank statement transaction expected
  if (isInternalSettlement || isCash) {
    return {
      status: 'unlinked',
      statusLabel: isInternalSettlement ? 'Internal Settlement' : 'Cash (No Bank Link)',
      canonicalAmount: 0,
      expectedAmount: expected,
      currency,
      allocations: [],
      legacyLinks: [],
      hasConflict: false,
    };
  }

  // 1. Check for genuine data-integrity problems
  let integrityIssue: string | undefined;

  // A. Over-allocation against voucher expected amount
  if (expected > BANK_LINK_EPSILON && canonicalAmount > expected + BANK_LINK_EPSILON) {
    integrityIssue = `Over-allocated: Bank allocation (${canonicalAmount.toLocaleString()}) exceeds voucher amount (${expected.toLocaleString()}).`;
  }

  // B. Validate individual allocation records
  if (!integrityIssue) {
    for (const alloc of rawCanonical) {
      const amt = Number(alloc.allocation_amount);
      if (isNaN(amt) || amt < 0) {
        integrityIssue = `Invalid allocation amount: ${alloc.allocation_amount}.`;
        break;
      }
      if (!alloc.bank_statement_line_id) {
        integrityIssue = `Invalid reference: Allocation record is missing bank statement line ID.`;
        break;
      }
      // Missing statement line: allocation references a statement line that is null / does not exist
      if (alloc.bank_statement_lines === null && alloc.bank_statement_line_id) {
        integrityIssue = `Missing statement line: Statement line ${alloc.bank_statement_line_id} could not be found.`;
        break;
      }
      // Statement line over-allocation
      if (alloc.bank_statement_lines) {
        const lineTotal = Math.max(
          Number(alloc.bank_statement_lines.debit_amount || 0),
          Number(alloc.bank_statement_lines.credit_amount || 0)
        );
        if (lineTotal > 0 && amt > lineTotal + BANK_LINK_EPSILON) {
          integrityIssue = `Over-allocated statement line: Allocation (${amt.toLocaleString()}) exceeds bank statement line total (${lineTotal.toLocaleString()}).`;
          break;
        }
      }
    }
  }

  // C. Duplicate allocation detection on the same statement line
  if (!integrityIssue && canonical.length > 1) {
    const lineAllocationCounts = new Map<string, number>();
    for (const alloc of canonical) {
      const count = (lineAllocationCounts.get(alloc.bank_statement_line_id) || 0) + 1;
      lineAllocationCounts.set(alloc.bank_statement_line_id, count);
      if (count > 1) {
        integrityIssue = `Duplicate allocation: Multiple canonical allocations detected for statement line ${alloc.bank_statement_line_id}.`;
        break;
      }
    }
  }

  // If a genuine data-integrity problem exists -> Amber AlertTriangle
  if (integrityIssue) {
    return {
      status: 'needs_review',
      statusLabel: 'Data Integrity Issue',
      canonicalAmount,
      expectedAmount: expected,
      currency,
      allocations: canonical,
      legacyLinks: legacy,
      hasConflict: true,
      conflictReason: integrityIssue,
    };
  }

  // 2. Unlinked -> Muted / Red Unlink
  if (canonicalAmount <= BANK_LINK_EPSILON) {
    return {
      status: 'unlinked',
      statusLabel: 'Unlinked',
      canonicalAmount: 0,
      expectedAmount: expected,
      currency,
      allocations: [],
      legacyLinks: legacy,
      hasConflict: false,
    };
  }

  // 3. Fully Linked -> Green Link2
  if (expected > BANK_LINK_EPSILON && canonicalAmount >= expected - BANK_LINK_EPSILON) {
    return {
      status: 'linked',
      statusLabel: 'Linked / Reconciled',
      canonicalAmount,
      expectedAmount: expected,
      currency,
      allocations: canonical,
      legacyLinks: legacy,
      hasConflict: false,
    };
  }

  // 4. Partially Linked -> Yellow Link2
  return {
    status: 'partial',
    statusLabel: 'Partially Linked',
    canonicalAmount,
    expectedAmount: expected,
    currency,
    allocations: canonical,
    legacyLinks: legacy,
    hasConflict: false,
  };
}
