import { Fragment, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { formatFinancePeriod } from '../../../utils/financePeriod';
import { useFinance } from '../../../contexts/FinanceContext';
import { StatCard, StatCardGrid, SectionCard, StatusChip, EmptyState, taxPaymentBusinessStatus } from './TaxUI';
import { getEffectiveExpensePostingStates, isEffectiveExpensePosting } from '../../../services/expensePostingLifecycle';

type PphType = 'PPh21' | 'PPh22' | 'PPh23' | 'PPh4(2)' | 'PPh_Unifikasi';

const TABS: PphType[] = ['PPh21','PPh22','PPh23','PPh4(2)','PPh_Unifikasi'];
const CONSOLIDATED_TYPES: PphType[] = ['PPh21','PPh22','PPh23','PPh4(2)'];

function pphTabLabel(t: PphType): string {
  if (t === 'PPh21') return 'PPh21';
  if (t === 'PPh_Unifikasi') return 'All Types (Consolidated)';
  return t;
}

interface Row {
  tax_period_id: string;
  fiscal_year: number;
  period_month: number;
  tax_type: string;
  pph_total: number;
  pph_paid_total: number;
  pph_outstanding: number;
  pph_overpaid: number;
  status: string;
  payment_due_date: string | null;
  filing_due_date: string | null;
  // Derived by the engine (vw_pph_by_period_type), shared with Calendar / Period Close.
  payment_status: string | null;
  payment_source: string | null;
}

interface SourceLine {
  module: 'expense' | 'import';
  id: string;
  doc_number: string;
  doc_date: string;
  period_date: string;
  party: string;
  description: string | null;
  pph_code: string | null;
  pph_amount: number;
  payment_method: string | null;
  recon_status: string | null;
  journal_reference: string | null;
  journal_id: string | null;
  posting_date: string | null;
  journal_status: string | null;
  tax_type: string;
  source_status: string;
  is_official: boolean;
  tax_period_id: string | null;
}

interface TaxPeriodOption {
  id: string;
  fiscal_year: number;
  period_month: number;
  tax_type: string;
  status: string;
  filing_status: string;
}

function fmt(n: number) {
  return Number(n).toLocaleString('id-ID');
}
function fmtDate(s: string) {
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

async function loadExpensePaymentDates(expenseIds: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (expenseIds.length === 0) return result;
  const [allocRes, legacyRes] = await Promise.all([
    supabase
      .from('bank_statement_allocations')
      .select('document_id, bank_statement_line_id')
      .eq('document_type', 'expense')
      .eq('payment_kind', 'supplier')
      .in('document_id', expenseIds),
    supabase
      .from('bank_statement_lines')
      .select('matched_expense_id, transaction_date')
      .in('matched_expense_id', expenseIds)
      .eq('payment_kind', 'supplier'),
  ]);
  const lineIds: string[] = [];
  for (const a of (allocRes.data ?? []) as any[]) {
    if (a.bank_statement_line_id) lineIds.push(a.bank_statement_line_id);
  }
  const lineDates = new Map<string, string>();
  if (lineIds.length > 0) {
    const { data } = await supabase
      .from('bank_statement_lines')
      .select('id, transaction_date')
      .in('id', lineIds);
    for (const l of (data ?? []) as any[]) {
      lineDates.set(l.id, l.transaction_date);
    }
  }
  for (const a of (allocRes.data ?? []) as any[]) {
    const date = lineDates.get(a.bank_statement_line_id);
    if (date) {
      const existing = result.get(a.document_id);
      if (!existing || date > existing) result.set(a.document_id, date);
    }
  }
  for (const l of (legacyRes.data ?? []) as any[]) {
    if (!l.matched_expense_id || !l.transaction_date) continue;
    const existing = result.get(l.matched_expense_id);
    if (!existing || l.transaction_date > existing) result.set(l.matched_expense_id, l.transaction_date);
  }
  return result;
}

async function loadPphDetail(row: Row): Promise<SourceLine[]> {
  const yr = row.fiscal_year;
  const mo = row.period_month;
  const startDate = `${yr}-${String(mo).padStart(2,'0')}-01`;
  // Last day of the calendar month. new Date(yr, mo, 0) is correct locally
  // (mo is 1-indexed here; day 0 rolls back to the previous month's last
  // day), but toISOString() converts to UTC and drops a day in +XX
  // timezones, so we construct the string directly to stay TZ-safe.
  const lastDay = new Date(yr, mo, 0).getDate();
  const endDate = `${yr}-${String(mo).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;

  const [feRes, importRes] = await Promise.all([
    supabase
      .from('finance_expenses')
      .select('id, voucher_number, expense_date, due_date, pph_amount, tax_period_id, pph_tax_period_id, description, payment_method, expense_category, approval_status, pph_code:pph_code_id(code, tax_type), suppliers:supplier_id(company_name), staff:staff_id(full_name)')
      .gt('pph_amount', 0),
    // Import PPh 22: pib_import (pib_pph_amount) + pph_import (whole amount).
    // Mirrors compute_period_ppn's import branch. Always PPh22.
    supabase
      .from('finance_expenses')
      .select('id, voucher_number, expense_date, due_date, amount, pib_pph_amount, tax_period_id, pph_tax_period_id, description, expense_category, approval_status, suppliers:supplier_id(company_name)')
      .in('expense_category', ['pib_import', 'pph_import']),
  ]);

  // The view (vw_canonical_tax_period_amounts) uses two date logics:
  // - When paid_amount > 0.01 OR status in paid/filed/closed → stored pph_total,
  //   which was computed by compute_period_ppn using get_expense_pph_period_date
  //   (bank payment date → due_date → expense_date).
  // - When open and unpaid → computed expense_pph using COALESCE(due_date, expense_date).
  // The drill-down must use the SAME date logic as the view for each period.
  const usesStoredTotal =
    Number(row.pph_paid_total || 0) > 0.01 ||
    ['paid', 'filed', 'closed'].includes(row.status);
  const allExpenseIds = [
    ...((feRes.data ?? []) as any[]).map(e => e.id),
    ...((importRes.data ?? []) as any[]).map(e => e.id),
  ];
  const paymentDateMap = usesStoredTotal
    ? await loadExpensePaymentDates(allExpenseIds)
    : new Map<string, string>();
  const periodDate = (expense: any): string =>
    usesStoredTotal
      ? (paymentDateMap.get(expense.id) ?? expense.due_date ?? expense.expense_date)
      : (expense.due_date ?? expense.expense_date);
  const isSelectedPeriod = (expense: any): boolean => {
    if (row.tax_type !== 'PPh_Unifikasi' && expense.pph_tax_period_id) return expense.pph_tax_period_id === row.tax_period_id;
    const date = periodDate(expense);
    return date >= startDate && date <= endDate;
  };

  const allExpenseSources = [
    ...((feRes.data ?? []) as any[]),
    ...((importRes.data ?? []) as any[]),
  ];
  const expenseStates = await getEffectiveExpensePostingStates(allExpenseSources.map(expense => expense.id));
  const isEffectiveExpense = (expense: any) =>
    isEffectiveExpensePosting(expenseStates.get(expense.id)?.effective_posting_state);
  const expenseData = ((feRes.data ?? []) as any[]).filter(isEffectiveExpense).filter(isSelectedPeriod);
  const importData = ((importRes.data ?? []) as any[]).filter(isEffectiveExpense).filter(isSelectedPeriod);

  const sourceRows = [...expenseData, ...importData];
  const sourceIds = [...new Set(sourceRows.map(r => r.id).filter(Boolean))];
  const journalRes = sourceIds.length
    ? await supabase
      .from('journal_entries')
      .select('id, reference_id, entry_number, entry_date, is_posted, is_reversed')
      .eq('is_posted', true)
      .eq('is_reversed', false)
      .in('reference_id', sourceIds)
    : { data: [] as any[] };
  const journals = new Map<string, any>(((journalRes.data ?? []) as any[]).map(j => [j.reference_id, j]));
  const journalFields = (id: string) => {
    const journal = journals.get(id);
    return {
      journal_reference: journal?.entry_number ?? null,
      journal_id: journal?.id ?? null,
      posting_date: journal?.entry_date ?? null,
      journal_status: journal
        ? (journal.is_reversed ? 'Reversed' : journal.is_posted ? 'Posted' : 'Draft')
        : 'Not posted',
    };
  };

  const pphType = row.tax_type;

  const expenses: SourceLine[] = expenseData
    .filter(r => {
      // Import categories are handled by the import branch below; exclude here
      // to avoid double-counting (matches the engine's NOT IN import guard).
      if (r.expense_category === 'pib_import' || r.expense_category === 'pph_import') return false;
      const codeType = r.pph_code?.tax_type ?? null;
      return pphType === 'PPh_Unifikasi' || codeType === pphType;
    })
    .map(r => ({
      module: 'expense' as const,
      id: r.id,
      doc_number: r.voucher_number ?? '—',
      doc_date: r.expense_date,
      period_date: periodDate(r),
      party: r.suppliers?.company_name ?? r.staff?.full_name ?? '—',
      description: r.description,
      pph_code: r.pph_code?.code ?? null,
      pph_amount: Number(r.pph_amount),
      tax_type: r.pph_code?.tax_type ?? pphType,
      source_status: r.approval_status === 'approved' ? 'Approved' : 'Pending Approval',
      is_official: r.approval_status === 'approved',
      tax_period_id: r.pph_tax_period_id ?? null,
      payment_method: r.payment_method,
      recon_status: null,
      ...journalFields(r.id),
    }));

  // Import PPh 22 — only relevant to the PPh22 and consolidated tabs.
  const imports: SourceLine[] = (pphType === 'PPh22' || pphType === 'PPh_Unifikasi')
    ? importData
        .map(r => {
          const amt = r.expense_category === 'pib_import'
            ? Number(r.pib_pph_amount ?? 0)
            : Number(r.amount ?? 0);
          return { r, amt };
        })
        .filter(({ amt }) => amt > 0)
        .map(({ r, amt }) => ({
          module: 'import' as const,
          id: r.id,
          doc_number: r.voucher_number ?? '—',
          doc_date: r.expense_date,
          period_date: periodDate(r),
          party: r.suppliers?.company_name ?? '—',
          description: r.description,
          pph_code: 'PPh22 Import',
          pph_amount: amt,
          tax_type: 'PPh22',
          source_status: r.approval_status === 'approved' ? 'Approved' : 'Pending Approval',
          is_official: r.approval_status === 'approved',
          tax_period_id: r.pph_tax_period_id ?? null,
          payment_method: null,
          recon_status: null,
          ...journalFields(r.id),
        }))
    : [];

  return [...expenses, ...imports].sort((a, b) =>
    a.period_date.localeCompare(b.period_date) || a.doc_date.localeCompare(b.doc_date),
  );
}

function consolidateRows(rows: Row[]): Row[] {
  const grouped = new Map<string, Row>();
  for (const row of rows) {
    const key = `${row.fiscal_year}-${row.period_month}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, { ...row, tax_period_id: key, tax_type: 'PPh_Unifikasi' });
      continue;
    }
    existing.pph_total += Number(row.pph_total || 0);
    existing.pph_paid_total += Number(row.pph_paid_total || 0);
    existing.pph_outstanding += Number(row.pph_outstanding || 0);
    existing.pph_overpaid += Number(row.pph_overpaid || 0);
    if (row.payment_status === 'overdue') existing.payment_status = 'overdue';
  }
  return [...grouped.values()].sort((a, b) => b.fiscal_year - a.fiscal_year || b.period_month - a.period_month);
}

interface Props {
  onOpenExpense?: (id: string) => void;
  onOpenPayment?: (id: string) => void;
  onOpenJournal?: (id: string) => void;
}

export function PphRegisterPanel({ onOpenExpense, onOpenPayment, onOpenJournal }: Props) {
  const { dateRange } = useFinance();
  const [active, setActive] = useState<PphType>('PPh21');
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SourceLine[] | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [periods, setPeriods] = useState<TaxPeriodOption[]>([]);
  const [editingPeriodId, setEditingPeriodId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setExpandedId(null);
    setDetail(null);
    (async () => {
      setLoading(true);
      let query = supabase
        .from('vw_pph_by_period_type')
        .select('*')
        .order('fiscal_year', { ascending: false })
        .order('period_month', { ascending: false })
        .limit(active === 'PPh_Unifikasi' ? 240 : 60);
      query = active === 'PPh_Unifikasi'
        ? query.in('tax_type', CONSOLIDATED_TYPES)
        : query.eq('tax_type', active);
      const { data } = await query;
      if (!cancelled) {
        const sourceRows = (data as Row[] | null) ?? [];
        setRows(active === 'PPh_Unifikasi' ? consolidateRows(sourceRows) : sourceRows);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [active, reloadKey]);

  useEffect(() => {
    void (async () => {
      const { data } = await supabase.from('tax_periods')
        .select('id, fiscal_year, period_month, tax_type, status, filing_status')
        .neq('tax_type', 'PPN')
        .order('fiscal_year', { ascending: false })
        .order('period_month', { ascending: false });
      setPeriods((data as TaxPeriodOption[] | null) ?? []);
    })();
  }, []);

  const filtered = useMemo(() => {
    if (!dateRange?.startDate || !dateRange?.endDate) return rows;
    const start = new Date(dateRange.startDate);
    const end = new Date(dateRange.endDate);
    return rows.filter(r => {
      const first = new Date(r.fiscal_year, r.period_month - 1, 1);
      const last  = new Date(r.fiscal_year, r.period_month, 0);
      return last >= start && first <= end;
    });
  }, [rows, dateRange]);

  const totals = useMemo(() => filtered.reduce(
    (a, r) => ({
      total: a.total + Number(r.pph_total || 0),
      paid: a.paid + Number(r.pph_paid_total || 0),
      outstanding: a.outstanding + Number(r.pph_outstanding || 0),
      overpaid: a.overpaid + Number(r.pph_overpaid || 0),
    }),
    { total: 0, paid: 0, outstanding: 0, overpaid: 0 },
  ), [filtered]);

  async function saveDocumentPeriod(line: SourceLine, periodId: string) {
    const source = 'finance_expense_pph';
    setEditingPeriodId(line.id);
    try {
      const { error } = await supabase.rpc('reassign_tax_document_period', {
        p_source: source,
        p_document_id: line.id,
        p_tax_period_id: periodId,
      });
      if (error) throw error;
      setReloadKey(key => key + 1);
      setExpandedId(null);
      setDetail(null);
    } catch (error) {
      alert('Tax period update failed: ' + (error as Error).message);
    } finally {
      setEditingPeriodId(null);
    }
  }

  async function toggleExpand(row: Row) {
    if (expandedId === row.tax_period_id) {
      setExpandedId(null);
      setDetail(null);
      return;
    }
    setExpandedId(row.tax_period_id);
    setDetail(null);
    setDetailLoading(true);
    try {
      const lines = await loadPphDetail(row);
      setDetail(lines);
    } finally {
      setDetailLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-1.5 flex-wrap">
        {TABS.map(t => (
          <button
            key={t}
            onClick={() => setActive(t)}
            className={`px-2.5 py-1 text-xs font-medium rounded-md border transition ${active === t ? 'bg-blue-600 text-white border-blue-600' : 'bg-white hover:bg-gray-50 border-gray-200'}`}
          >
            {pphTabLabel(t)}
          </button>
        ))}
      </div>

      {!loading && filtered.length > 0 && (
        <StatCardGrid cols={4}>
          <StatCard label={`Total ${pphTabLabel(active)} Withheld`} value={totals.total} tone="orange" hint="Across periods in range" />
          <StatCard label="Paid to Tax Office" value={totals.paid} tone="green" />
          <StatCard label="Outstanding" value={totals.outstanding} tone="red" hint="Not yet remitted" />
          <StatCard label="Overpaid / Credit" value={totals.overpaid} tone="blue" hint="Not allocated to another period" />
        </StatCardGrid>
      )}

      {loading ? (
        <p className="text-gray-500">Loading…</p>
      ) : filtered.length === 0 ? (
        <SectionCard>
          <EmptyState
            title={`No ${active} periods in the selected date range`}
            hint="PPh periods are created automatically once expenses, vouchers, or imports with PPh are approved. Try widening the date range."
          />
        </SectionCard>
      ) : (
        <SectionCard>
          <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-50">
              <tr>
                <th className="w-6 px-2 py-1.5"></th>
                <th className="text-left px-2.5 py-1.5">Period</th>
                <th className="text-left px-2.5 py-1.5">Status</th>
                <th className="text-right px-2.5 py-1.5">Total PPh</th>
                <th className="text-right px-2.5 py-1.5">Paid</th>
                <th className="text-right px-2.5 py-1.5">Outstanding</th>
                <th className="text-right px-2.5 py-1.5">Overpaid / Credit</th>
                <th className="text-left px-2.5 py-1.5">Payment Due</th>
                <th className="text-left px-2.5 py-1.5">Filing Due</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => {
                const isOpen = expandedId === r.tax_period_id;
                const businessStatus = taxPaymentBusinessStatus({
                  paymentStatus: r.payment_status,
                  totalAmount: r.pph_total,
                  paidAmount: r.pph_paid_total,
                  outstandingAmount: r.pph_outstanding,
                });
                const officialDetail = isOpen && detail ? detail.filter(line => line.is_official) : [];
                const pendingDetail = isOpen && detail ? detail.filter(line => !line.is_official) : [];
                const missingJournalDetail = officialDetail.filter(line => !line.journal_id);
                const detailTotal = officialDetail.reduce((sum, line) => sum + line.pph_amount, 0);
                const traceDifference = detailTotal - Number(r.pph_total || 0);
                return (
                  <Fragment key={r.tax_period_id}>
                    <tr
                      key={r.tax_period_id}
                      className={`border-t cursor-pointer select-none ${isOpen ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
                      onClick={() => void toggleExpand(r)}
                    >
                      <td className="px-2 py-1.5 text-gray-400">
                        {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                      </td>
                      <td className="px-2.5 py-1.5 font-medium">{formatFinancePeriod(r.fiscal_year, r.period_month)}</td>
                      <td className="px-2.5 py-1.5">
                        <StatusChip status={businessStatus} />
                      </td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums">{fmt(r.pph_total)}</td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums text-green-700">{fmt(r.pph_paid_total)}</td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums font-semibold text-orange-700">
                        {fmt(r.pph_outstanding)}
                      </td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums font-semibold text-blue-700">{fmt(r.pph_overpaid)}</td>
                      <td className="px-2.5 py-1.5 whitespace-nowrap">{r.payment_due_date ?? '—'}</td>
                      <td className="px-2.5 py-1.5 whitespace-nowrap">{r.filing_due_date ?? '—'}</td>
                    </tr>
                    {isOpen && (
                      <tr key={`${r.tax_period_id}-detail`} className="bg-blue-50/30">
                        <td colSpan={11} className="px-6 pb-4 pt-2">
                          <h4 className="text-xs font-semibold text-gray-600 mb-2 uppercase tracking-wide">
                            Source Documents — {pphTabLabel(active)} withheld in {formatFinancePeriod(r.fiscal_year, r.period_month)}
                          </h4>
                          {detailLoading ? (
                            <p className="text-xs text-gray-500">Loading source documents…</p>
                          ) : officialDetail.length === 0 && Number(r.pph_total || 0) > 0 ? (
                            <div className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
                              <p className="font-medium">No source expense was found for this registered withholding amount.</p>
                              <p className="mt-0.5">PPh {pphTabLabel(active)} · {formatFinancePeriod(r.fiscal_year, r.period_month)} · Rp {fmt(r.pph_total)}</p>
                              <p className="mt-0.5 text-[11px]">No synthetic source or tax-payment document is shown. Review the underlying expense/source-document records before reposting.</p>
                            </div>
                          ) : officialDetail.length > 0 ? (
                            <>
                            {missingJournalDetail.length > 0 && (
                              <div className="mb-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
                                Accounting warning: {missingJournalDetail.length} approved source document{missingJournalDetail.length === 1 ? '' : 's'} {missingJournalDetail.length === 1 ? 'has' : 'have'} no active posted journal. The withholding remains in the official Register; open the document to correct its journal lifecycle.
                              </div>
                            )}
                            {Math.abs(traceDifference) > 0.01 && (
                              <p className="mb-2 text-xs font-medium text-red-700">
                                Audit trace mismatch: source documents total Rp {fmt(detailTotal)}, Register total Rp {fmt(r.pph_total)}.
                              </p>
                            )}
                            <table className="w-full text-xs border-collapse">
                              <thead>
                                <tr className="text-gray-500 border-b">
                                  <th className="text-left py-1 pr-3">Module</th>
                                  <th className="text-left py-1 pr-3">Tax Type</th>
                                  <th className="text-left py-1 pr-3">Document</th>
                                  <th className="text-left py-1 pr-3">Document Date</th>
                                  <th className="text-left py-1 pr-3">PPh Period Date</th>
                                  <th className="text-left py-1 pr-3">Tax Period</th>
                                  <th className="text-left py-1 pr-3">Employee / Supplier</th>
                                  <th className="text-left py-1 pr-3">Description</th>
                                  <th className="text-left py-1 pr-3">PPh Code</th>
                                  <th className="text-left py-1 pr-3">Posting Date</th>
                                  <th className="text-left py-1 pr-3">Journal Ref</th>
                                  <th className="text-left py-1 pr-3">Status</th>
                                  <th className="text-right py-1">PPh Withheld</th>
                                </tr>
                              </thead>
                              <tbody>
                                {officialDetail.map(l => (
                                  <tr key={l.id} className="border-b border-gray-100 hover:bg-white">
                                    <td className="py-1.5 pr-3">
                                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                                        l.module === 'expense' ? 'bg-orange-100 text-orange-700'
                                          : 'bg-blue-100 text-blue-700'
                                      }`}>
                                        {l.module === 'expense' ? 'Expense'
                                          : 'Import PPh22'}
                                      </span>
                                    </td>
                                    <td className="py-1.5 pr-3 font-semibold">{l.tax_type}</td>
                                    <td className="py-1.5 pr-3 font-mono font-semibold">
                                      <button type="button" className="text-blue-700 hover:underline" onClick={() => onOpenExpense?.(l.id)}>{l.doc_number}</button>
                                    </td>
                                    <td className="py-1.5 pr-3 whitespace-nowrap">{fmtDate(l.doc_date)}</td>
                                    <td className="py-1.5 pr-3 whitespace-nowrap font-medium text-blue-700">{fmtDate(l.period_date)}</td>
                                    <td className="py-1.5 pr-3" onClick={event => event.stopPropagation()}>
                                      {l.module === 'import' ? (
                                        <span className="text-gray-400">Derived import period</span>
                                      ) : (
                                        <select
                                          aria-label={`Tax period for ${l.doc_number}`}
                                          value={l.tax_period_id ?? r.tax_period_id}
                                          disabled={editingPeriodId === l.id || r.status === 'closed' || r.status === 'filed'}
                                          onChange={event => void saveDocumentPeriod(l, event.target.value)}
                                          className="max-w-28 rounded border border-gray-300 bg-white px-1 py-0.5 text-[11px] disabled:opacity-50"
                                        >
                                          {periods.filter(period => period.tax_type === l.tax_type).map(period => (
                                            <option key={period.id} value={period.id} disabled={period.status === 'closed' || period.status === 'filed' || period.filing_status === 'filed'}>
                                              {formatFinancePeriod(period.fiscal_year, period.period_month)}{period.status === 'closed' || period.status === 'filed' || period.filing_status === 'filed' ? ' (locked)' : ''}
                                            </option>
                                          ))}
                                        </select>
                                      )}
                                    </td>
                                    <td className="py-1.5 pr-3 max-w-[140px] truncate text-gray-700" title={l.party}>{l.party}</td>
                                    <td className="py-1.5 pr-3 max-w-[180px] truncate text-gray-500" title={l.description ?? undefined}>{l.description ?? '—'}</td>
                                    <td className="py-1.5 pr-3">
                                      {l.pph_code
                                        ? <span className="font-mono text-blue-700">{l.pph_code}</span>
                                        : <span className="text-orange-500 italic">⚠ No code</span>}
                                    </td>
                                    <td className="py-1.5 pr-3 whitespace-nowrap">{l.posting_date ? fmtDate(l.posting_date) : '—'}</td>
                                    <td className="py-1.5 pr-3 font-mono">
                                      {l.journal_id
                                        ? <button type="button" className="text-blue-700 hover:underline" onClick={() => onOpenJournal?.(l.journal_id!)}>{l.journal_reference}</button>
                                        : '—'}
                                    </td>
                                    <td className="py-1.5 pr-3" title={`Journal: ${l.journal_status ?? '—'}`}>
                                      <StatusChip status={businessStatus} />
                                      <div className="mt-0.5 text-[10px] text-gray-500">{l.source_status}</div>
                                    </td>
                                    <td className="py-1.5 text-right font-mono font-semibold text-orange-700">
                                      Rp {fmt(l.pph_amount)}
                                    </td>
                                  </tr>
                                ))}
                                <tr className="font-semibold border-t-2 border-gray-300 bg-gray-50">
                                  <td colSpan={12} className="py-1.5 pr-3 text-right text-xs text-gray-500">Total {pphTabLabel(active)} Withheld</td>
                                  <td className="py-1.5 text-right font-mono text-orange-700">
                                    Rp {fmt(detailTotal)}
                                  </td>
                                </tr>
                              </tbody>
                            </table>
                            </>
                          ) : null}

                          {!detailLoading && pendingDetail.length > 0 && (
                            <div className="mt-4 rounded border border-amber-200 bg-amber-50 p-3">
                              <h5 className="text-xs font-semibold text-amber-900">Pending Approval / Not Posted</h5>
                              <p className="mb-2 text-[11px] text-amber-800">
                                These transactions are not approved and are excluded from the official Register until approval.
                              </p>
                              <table className="w-full text-xs border-collapse bg-white">
                                <thead>
                                  <tr className="border-b text-gray-500">
                                    <th className="p-1.5 text-left">Document No.</th>
                                    <th className="p-1.5 text-left">Module</th>
                                    <th className="p-1.5 text-left">Employee / Supplier</th>
                                    <th className="p-1.5 text-left">Tax Type</th>
                                    <th className="p-1.5 text-right">Tax Amount</th>
                                    <th className="p-1.5 text-left">Status</th>
                                    <th className="p-1.5 text-left">Expected Posting Date</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {pendingDetail.map(line => (
                                    <tr key={`pending-${line.module}-${line.id}`} className="border-b border-gray-100">
                                      <td className="p-1.5 font-mono font-semibold">
                                        <button type="button" className="text-blue-700 hover:underline" onClick={() => {
                                          onOpenExpense?.(line.id);
                                        }}>{line.doc_number}</button>
                                      </td>
                                      <td className="p-1.5">{line.module === 'import' ? 'Import PPh22' : 'Expense'}</td>
                                      <td className="p-1.5">{line.party}</td>
                                      <td className="p-1.5 font-medium">{line.tax_type}</td>
                                      <td className="p-1.5 text-right font-mono">Rp {fmt(line.pph_amount)}</td>
                                      <td className="p-1.5">{line.source_status}</td>
                                      <td className="p-1.5 whitespace-nowrap">{fmtDate(line.doc_date)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          </div>
        </SectionCard>
      )}
    </div>
  );
}
