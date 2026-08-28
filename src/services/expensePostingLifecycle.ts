import { supabase } from '../lib/supabase';

export type ExpensePostingState =
  | 'ACTIVE'
  | 'REVERSED'
  | 'REPLACED'
  | 'REJECTED'
  | 'PENDING'
  | 'AMBIGUOUS';

export interface EffectiveExpensePostingState {
  expense_id: string;
  voucher_number: string | null;
  document_approval_status: string;
  effective_posting_state: ExpensePostingState;
  effective_journal_id: string | null;
  effective_journal_number: string | null;
  effective_journal_date: string | null;
  active_journal_id: string | null;
  active_journal_number: string | null;
  original_journal_id: string | null;
  original_journal_number: string | null;
  reversal_journal_id: string | null;
  replacement_journal_id: string | null;
  replacement_journal_number: string | null;
  replacement_reference: string | null;
  replacement_source_module: string | null;
  active_original_count: number;
  reversed_original_count: number;
  active_replacement_count: number;
  ambiguity_reason: string | null;
}

const READ_BATCH_SIZE = 75;

type ExpenseDocumentRow = {
  id: string;
  voucher_number: string | null;
  approval_status: string;
};

type ExpenseJournalRow = {
  id: string;
  entry_number: string | null;
  entry_date: string | null;
  source_module: string | null;
  reference_id: string | null;
  reference_number: string | null;
  created_at: string | null;
  is_posted: boolean | null;
  is_reversed: boolean | null;
  reversed_by_id: string | null;
};

// Production can deploy the UI before the lifecycle view migration. Keep the
// canonical view path opt-in until that migration is deliberately enabled.
// If an enabled environment is nevertheless missing the view, remember that
// result so one PGRST205 cannot turn into a request loop.
const LIFECYCLE_VIEW_ENABLED =
  import.meta.env.VITE_EFFECTIVE_EXPENSE_LIFECYCLE_VIEW_ENABLED === 'true';
let lifecycleViewAvailability: 'unknown' | 'available' | 'missing' =
  LIFECYCLE_VIEW_ENABLED ? 'unknown' : 'missing';

const isMissingLifecycleViewError = (error: { code?: string; message?: string } | null): boolean =>
  error?.code === 'PGRST205'
  || error?.code === '42P01'
  || Boolean(error?.message?.includes("effective_expense_posting_state"));

const newestFirst = (a: ExpenseJournalRow, b: ExpenseJournalRow): number =>
  `${b.created_at || ''}:${b.id}`.localeCompare(`${a.created_at || ''}:${a.id}`);

function resolveFallbackState(
  expense: ExpenseDocumentRow,
  journals: ExpenseJournalRow[],
): EffectiveExpensePostingState {
  const originals = journals.filter(journal =>
    journal.is_posted === true && ['expense', 'expenses'].includes(journal.source_module || ''),
  );
  const replacements = journals.filter(journal =>
    journal.is_posted === true
    && !journal.is_reversed
    && (
      journal.source_module === 'historical_salary_advance_repair'
      || (journal.source_module === 'historical_repair'
        && (journal.reference_number?.startsWith('HR-AP-')
          || journal.reference_number?.startsWith('HR-CASH-')))
    ),
  );
  const activeOriginals = originals.filter(journal => !journal.is_reversed).sort(newestFirst);
  const reversedOriginals = originals.filter(journal => journal.is_reversed).sort(newestFirst);
  const activeReplacements = replacements.sort(newestFirst);
  const activeOriginal = activeOriginals[0] || null;
  const reversedOriginal = reversedOriginals[0] || null;
  const replacement = activeReplacements[0] || null;

  let effectivePostingState: ExpensePostingState;
  let ambiguityReason: string | null = null;
  if (activeOriginals.length > 1) {
    effectivePostingState = 'AMBIGUOUS';
    ambiguityReason = 'multiple_active_original_journals';
  } else if (activeReplacements.length > 1) {
    effectivePostingState = 'AMBIGUOUS';
    ambiguityReason = 'multiple_active_replacement_journals';
  } else if (activeOriginals.length > 0 && activeReplacements.length > 0) {
    effectivePostingState = 'AMBIGUOUS';
    ambiguityReason = 'active_original_and_replacement_coexist';
  } else if (expense.approval_status !== 'approved' && (activeOriginal || replacement)) {
    effectivePostingState = 'AMBIGUOUS';
    ambiguityReason = 'unapproved_document_with_active_accounting_path';
  } else if (activeOriginal) {
    effectivePostingState = 'ACTIVE';
  } else if (reversedOriginal && replacement) {
    effectivePostingState = 'REPLACED';
  } else if (reversedOriginal) {
    effectivePostingState = 'REVERSED';
  } else if (expense.approval_status === 'rejected') {
    effectivePostingState = 'REJECTED';
  } else if (expense.approval_status === 'pending_approval') {
    effectivePostingState = 'PENDING';
  } else {
    effectivePostingState = 'AMBIGUOUS';
    ambiguityReason = 'approved_without_visible_posted_journal_evidence';
  }

  const effectiveJournal = activeOriginal || replacement;
  return {
    expense_id: expense.id,
    voucher_number: expense.voucher_number,
    document_approval_status: expense.approval_status,
    effective_posting_state: effectivePostingState,
    effective_journal_id: effectiveJournal?.id || null,
    effective_journal_number: effectiveJournal?.entry_number || null,
    effective_journal_date: effectiveJournal?.entry_date || null,
    active_journal_id: activeOriginal?.id || null,
    active_journal_number: activeOriginal?.entry_number || null,
    original_journal_id: reversedOriginal?.id || null,
    original_journal_number: reversedOriginal?.entry_number || null,
    reversal_journal_id: reversedOriginal?.reversed_by_id || null,
    replacement_journal_id: replacement?.id || null,
    replacement_journal_number: replacement?.entry_number || null,
    replacement_reference: replacement?.reference_number || null,
    replacement_source_module: replacement?.source_module || null,
    active_original_count: activeOriginals.length,
    reversed_original_count: reversedOriginals.length,
    active_replacement_count: activeReplacements.length,
    ambiguity_reason: ambiguityReason,
  };
}

async function getFallbackExpensePostingStates(
  ids: string[],
): Promise<Map<string, EffectiveExpensePostingState>> {
  const result = new Map<string, EffectiveExpensePostingState>();

  for (let offset = 0; offset < ids.length; offset += READ_BATCH_SIZE) {
    const batch = ids.slice(offset, offset + READ_BATCH_SIZE);
    const references = batch.map(id => `EXP-${id}`);
    const [expensesResult, journalsByIdResult, journalsByReferenceResult] = await Promise.all([
      supabase
        .from('finance_expenses')
        .select('id,voucher_number,approval_status')
        .in('id', batch),
      supabase
        .from('journal_entries')
        .select('id,entry_number,entry_date,source_module,reference_id,reference_number,created_at,is_posted,is_reversed,reversed_by_id')
        .in('reference_id', batch),
      supabase
        .from('journal_entries')
        .select('id,entry_number,entry_date,source_module,reference_id,reference_number,created_at,is_posted,is_reversed,reversed_by_id')
        .in('reference_number', references),
    ]);
    if (expensesResult.error) throw expensesResult.error;
    if (journalsByIdResult.error) throw journalsByIdResult.error;
    if (journalsByReferenceResult.error) throw journalsByReferenceResult.error;

    const journals = new Map<string, ExpenseJournalRow>();
    for (const row of [
      ...(journalsByIdResult.data || []),
      ...(journalsByReferenceResult.data || []),
    ] as ExpenseJournalRow[]) {
      journals.set(row.id, row);
    }

    for (const expense of (expensesResult.data || []) as ExpenseDocumentRow[]) {
      const expenseJournals = [...journals.values()].filter(journal =>
        journal.reference_id === expense.id || journal.reference_number === `EXP-${expense.id}`,
      );
      result.set(expense.id, resolveFallbackState(expense, expenseJournals));
    }
  }

  return result;
}

export async function getEffectiveExpensePostingStates(
  expenseIds: Array<string | null | undefined>,
): Promise<Map<string, EffectiveExpensePostingState>> {
  const ids = [...new Set(expenseIds.filter((id): id is string => Boolean(id)))];
  const result = new Map<string, EffectiveExpensePostingState>();

  if (ids.length === 0) return result;

  if (lifecycleViewAvailability === 'missing') {
    return getFallbackExpensePostingStates(ids);
  }

  for (let offset = 0; offset < ids.length; offset += READ_BATCH_SIZE) {
    const batch = ids.slice(offset, offset + READ_BATCH_SIZE);
    const { data, error } = await supabase
      .from('effective_expense_posting_state')
      .select('*')
      .in('expense_id', batch);
    if (error) {
      if (isMissingLifecycleViewError(error)) {
        lifecycleViewAvailability = 'missing';
        return getFallbackExpensePostingStates(ids);
      }
      throw error;
    }
    lifecycleViewAvailability = 'available';
    for (const row of (data || []) as EffectiveExpensePostingState[]) {
      result.set(row.expense_id, row);
    }
  }

  return result;
}

export async function getEffectiveExpensePostingState(
  expenseId: string,
): Promise<EffectiveExpensePostingState | null> {
  const states = await getEffectiveExpensePostingStates([expenseId]);
  return states.get(expenseId) || null;
}

export const isEffectiveExpensePosting = (state: ExpensePostingState | null | undefined): boolean =>
  state === 'ACTIVE' || state === 'REPLACED';
