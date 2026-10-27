import * as XLSX from 'xlsx';
import { supabase } from '../../lib/supabase';
import { getEffectiveExpensePostingStates } from '../../services/expensePostingLifecycle';

/**
 * A common, accountant-facing workbook for operational finance exports.
 * The summary deliberately remains at document level, while the second sheet
 * keeps every posted journal line intact for direct GL/TB reconciliation.
 */
export interface ReconciliationSummaryRow {
  'Source Module': string;
  'Document Type': string;
  'Document Number': string;
  'Document Date': string;
  'Posting Date': string;
  'Journal Number': string;
  'Journal Status': string;
  'Approval Status': string;
  'Payment Status': string;
  'Reconciliation Status': string;
  'Party Type': string;
  'Party Name': string;
  'Category Parent': string;
  'Leaf Category': string;
  'Currency': string;
  'Exchange Rate': number | '';
  'Gross Amount': number | '';
  'Discount': number | '';
  'DPP / Tax Base': number | '';
  'PPN': number | '';
  'PPh21': number | '';
  'PPh22': number | '';
  'PPh23': number | '';
  'PPh4(2)': number | '';
  'Other Taxes': number | '';
  'Bank Charges': number | '';
  'Salary Advance': number | '';
  'Other Deductions': number | '';
  'Net Settlement Amount': number | '';
  'Actual Bank Amount': number | '';
  'Settlement Difference': number | '';
  'Primary COA Code': string;
  'Primary COA Name': string;
  'Bank Account': string;
  'Bank Statement Reference': string;
  'Tax Period': string;
  'Tax Reference / NTPN (where applicable)': string;
  'Remarks': string;
}

export interface ReconciliationJournalLine {
  'Source Module': string;
  'Document Number': string;
  'Journal Number': string;
  'Journal Date': string;
  'Journal Status': string;
  'Line Number': number;
  'COA Code': string;
  'COA Name': string;
  'Debit': number;
  'Credit': number;
  'Tax Code': string;
  'Tax Period': string;
  'Party': string;
  'Bank Account': string;
  'Description': string;
}

export interface PostedJournal {
  documentId: string;
  number: string;
  date: string;
  status: string;
  lines: ReconciliationJournalLine[];
}

const summaryHeaders: (keyof ReconciliationSummaryRow)[] = [
  'Source Module', 'Document Type', 'Document Number', 'Document Date', 'Posting Date', 'Journal Number', 'Journal Status', 'Approval Status', 'Payment Status', 'Reconciliation Status', 'Party Type', 'Party Name', 'Category Parent', 'Leaf Category', 'Currency', 'Exchange Rate', 'Gross Amount', 'Discount', 'DPP / Tax Base', 'PPN', 'PPh21', 'PPh22', 'PPh23', 'PPh4(2)', 'Other Taxes', 'Bank Charges', 'Salary Advance', 'Other Deductions', 'Net Settlement Amount', 'Actual Bank Amount', 'Settlement Difference', 'Primary COA Code', 'Primary COA Name', 'Bank Account', 'Bank Statement Reference', 'Tax Period', 'Tax Reference / NTPN (where applicable)', 'Remarks',
];

const journalHeaders: (keyof ReconciliationJournalLine)[] = [
  'Source Module', 'Document Number', 'Journal Number', 'Journal Date', 'Journal Status', 'Line Number', 'COA Code', 'COA Name', 'Debit', 'Credit', 'Tax Code', 'Tax Period', 'Party', 'Bank Account', 'Description',
];

const asNumber = (value: unknown) => Number(value || 0);
const first = <T,>(value: T | T[] | null | undefined): T | null => Array.isArray(value) ? value[0] || null : value || null;

/** Fetches the immutable posted journal detail only when an export is requested. */
export async function getPostedJournalsForExport(
  documentIds: string[],
  sourceModules: string[],
  documentNumbers: Record<string, string>,
  sourceModuleLabel: string,
  bankAccounts: Record<string, string> = {},
  taxPeriods: Record<string, string> = {},
): Promise<Map<string, PostedJournal>> {
  if (!documentIds.length) return new Map();

  const isExpenseExport = sourceModules.length > 0
    && sourceModules.every(module => module === 'expense' || module === 'expenses');
  const journalDocumentIds = new Map<string, string>();
  let effectiveJournalIds: string[] = [];
  if (isExpenseExport) {
    const states = await getEffectiveExpensePostingStates(documentIds);
    for (const documentId of documentIds) {
      const journalId = states.get(documentId)?.effective_journal_id;
      if (journalId) journalDocumentIds.set(journalId, documentId);
    }
    effectiveJournalIds = [...journalDocumentIds.keys()];
    if (!effectiveJournalIds.length) return new Map();
  }

  let journalQuery = supabase
    .from('journal_entries')
    .select('id, reference_id, entry_number, entry_date, is_posted, is_reversed, journal_entry_lines(line_number, description, debit, credit, tax_code_id, customer_id, supplier_id, chart_of_accounts(code,name), tax_codes(code), customers(company_name), suppliers(company_name))')
    .eq('is_posted', true)
    .order('entry_date', { ascending: true });
  journalQuery = isExpenseExport
    ? journalQuery.in('id', effectiveJournalIds)
    : journalQuery.in('reference_id', documentIds).in('source_module', sourceModules);
  const { data, error } = await journalQuery;
  if (error) throw error;

  const result = new Map<string, PostedJournal>();
  for (const entry of (data || []) as any[]) {
    const documentId = journalDocumentIds.get(entry.id) || entry.reference_id as string;
    // A document can have historical/reversed entries; retain the current posted one.
    if (!documentId || entry.is_reversed || result.has(documentId)) continue;
    const lines = ((entry.journal_entry_lines || []) as any[])
      .sort((a, b) => asNumber(a.line_number) - asNumber(b.line_number))
      .map((line) => {
        const account = first<{ code: string; name: string }>(line.chart_of_accounts);
        const tax = first<{ code: string }>(line.tax_codes);
        const customer = first<{ company_name: string }>(line.customers);
        const supplier = first<{ company_name: string }>(line.suppliers);
        return {
          'Source Module': sourceModuleLabel,
          'Document Number': documentNumbers[documentId] || '',
          'Journal Number': entry.entry_number || '',
          'Journal Date': entry.entry_date || '',
          'Journal Status': entry.is_posted ? 'Posted' : 'Draft',
          'Line Number': asNumber(line.line_number),
          'COA Code': account?.code || '',
          'COA Name': account?.name || '',
          Debit: asNumber(line.debit),
          Credit: asNumber(line.credit),
          'Tax Code': tax?.code || '',
          'Tax Period': taxPeriods[documentId] || '',
          Party: customer?.company_name || supplier?.company_name || '',
          'Bank Account': bankAccounts[documentId] || '',
          Description: line.description || '',
        } satisfies ReconciliationJournalLine;
      });
    result.set(documentId, {
      documentId,
      number: entry.entry_number || '',
      date: entry.entry_date || '',
      status: entry.is_posted ? 'Posted' : 'Draft',
      lines,
    });
  }
  return result;
}

/** Same immutable journal-line export for modules that store journal_entry_id directly. */
export async function getPostedJournalLinesByEntryIds(
  journalIds: string[],
  sourceModuleLabel: string,
  documentNumbers: Record<string, string>,
  bankAccounts: Record<string, string> = {},
  taxPeriods: Record<string, string> = {},
): Promise<ReconciliationJournalLine[]> {
  if (!journalIds.length) return [];
  const { data, error } = await supabase
    .from('journal_entries')
    .select('id, entry_number, entry_date, is_posted, journal_entry_lines(line_number, description, debit, credit, chart_of_accounts(code,name), tax_codes(code), customers(company_name), suppliers(company_name))')
    .in('id', journalIds)
    .eq('is_posted', true);
  if (error) throw error;
  return ((data || []) as any[]).flatMap((entry) => ((entry.journal_entry_lines || []) as any[])
    .sort((a, b) => asNumber(a.line_number) - asNumber(b.line_number))
    .map((line) => {
      const account = first<{ code: string; name: string }>(line.chart_of_accounts);
      const tax = first<{ code: string }>(line.tax_codes);
      const customer = first<{ company_name: string }>(line.customers);
      const supplier = first<{ company_name: string }>(line.suppliers);
      return {
        'Source Module': sourceModuleLabel,
        'Document Number': documentNumbers[entry.id] || '',
        'Journal Number': entry.entry_number || '',
        'Journal Date': entry.entry_date || '',
        'Journal Status': 'Posted',
        'Line Number': asNumber(line.line_number),
        'COA Code': account?.code || '',
        'COA Name': account?.name || '',
        Debit: asNumber(line.debit), Credit: asNumber(line.credit),
        'Tax Code': tax?.code || '', 'Tax Period': taxPeriods[entry.id] || '',
        Party: customer?.company_name || supplier?.company_name || '',
        'Bank Account': bankAccounts[entry.id] || '', Description: line.description || '',
      } satisfies ReconciliationJournalLine;
    }));
}

export function writeReconciliationWorkbook(
  summaryRows: ReconciliationSummaryRow[],
  journalLines: ReconciliationJournalLine[],
  filename: string,
): void {
  const workbook = XLSX.utils.book_new();
  const summarySheet = XLSX.utils.json_to_sheet(summaryRows, { header: summaryHeaders });
  const journalSheet = XLSX.utils.json_to_sheet(journalLines, { header: journalHeaders });
  summarySheet['!freeze'] = { xSplit: 0, ySplit: 1 };
  journalSheet['!freeze'] = { xSplit: 0, ySplit: 1 };
  summarySheet['!autofilter'] = { ref: `A1:AL${Math.max(1, summaryRows.length + 1)}` };
  journalSheet['!autofilter'] = { ref: `A1:O${Math.max(1, journalLines.length + 1)}` };
  summarySheet['!cols'] = summaryHeaders.map((header) => ({ wch: Math.max(12, Math.min(34, header.length + 2)) }));
  journalSheet['!cols'] = journalHeaders.map((header) => ({ wch: Math.max(12, Math.min(28, header.length + 2)) }));
  XLSX.utils.book_append_sheet(workbook, summarySheet, 'Transaction Summary');
  XLSX.utils.book_append_sheet(workbook, journalSheet, 'Journal Lines');
  XLSX.writeFile(workbook, filename);
}
