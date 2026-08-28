import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, RefreshCw, Search, SlidersHorizontal, Save } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { BankTransactionLinkField } from './BankTransactionLinkField';
import type { BankTransactionLine } from './bankTransactionLinking';
import { FinancePage } from './FinancePage';
import { FinanceBadge, FinanceButton } from './FinanceUI';
import { useExpenseCategories } from './useExpenseCategories';

interface ExceptionRow {
  row_id: string;
  exception_id: number | null;
  document_type: string;
  document_id: string;
  date: string | null;
  voucher_number: string | null;
  journal_number: string | null;
  amount: number | null;
  currency: string | null;
  bank: string | null;
  customer_supplier: string | null;
  current_category: string | null;
  current_gl_account: string | null;
  status: string;
  problem: string;
  reason?: string | null;
  why_not_automatic: string;
  recommended_action: string;
  current_bank_account_id: string | null;
  journal_entry_id: string | null;
  journal_line_id: string | null;
  current_reference: string | null;
  current_supplier_id: string | null;
  current_customer_id: string | null;
  from_bank_account_id: string | null;
  to_bank_account_id: string | null;
  from_bank_alias: string | null;
  to_bank_alias: string | null;
  bank_alias: string | null;
  bank_statement_line_id: string | null;
  current_subcategory: string | null;
  current_source_document: string | null;
  current_account_id?: string | null;
  current_tax_code_id?: string | null;
  current_payment_type?: string | null;
  current_document_classification?: string | null;
  current_faktur_pajak_number?: string | null;
  current_finance_classification?: string | null;
}

interface RepairEdit { [key: string]: string | undefined }
interface CoaOption { id: string; code: string; name: string; account_type: string; account_group: string | null }
interface BankOption { id: string; bank_name: string; account_name: string; account_number: string; alias: string | null; currency: string }
interface TaxOption { id: string; code: string; name: string; tax_type: string; rate: number }
interface PartyOption { id: string; company_name: string }

const humanize = (value: string | null | undefined) => value
  ? value.replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase()) : '—';
const formatAmount = (amount: number | null, currency: string | null) => amount == null
  ? '—' : `${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount)} ${currency || ''}`;
const bankLabel = (bank: BankOption) => bank.alias || bank.account_name || `${bank.bank_name} ${bank.currency}`;
const problemMatches = (row: ExceptionRow, terms: string[]) => {
  const text = `${row.reason || ''} ${row.problem} ${row.why_not_automatic} ${row.recommended_action}`.toLowerCase();
  return terms.some(term => text.includes(term));
};
const transactionDirection = (row: ExceptionRow): 'debit' | 'credit' | 'both' =>
  row.document_type === 'receipt' ? 'credit' : row.document_type === 'expense' || row.document_type === 'payment' ? 'debit' : 'both';

export function FinanceExceptionCorrectionDashboard({ canManage }: {
  canManage: boolean;
}) {
  const { categories: expenseCategories } = useExpenseCategories();
  const [searchParams, setSearchParams] = useSearchParams();
  const [rows, setRows] = useState<ExceptionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [edits, setEdits] = useState<Record<string, RepairEdit>>({});
  const [savingRow, setSavingRow] = useState<string | null>(null);
  const [coa, setCoa] = useState<CoaOption[]>([]);
  const [banks, setBanks] = useState<BankOption[]>([]);
  const [taxCodes, setTaxCodes] = useState<TaxOption[]>([]);
  const [suppliers, setSuppliers] = useState<PartyOption[]>([]);
  const [customers, setCustomers] = useState<PartyOption[]>([]);
  const [batchRepairAttempted, setBatchRepairAttempted] = useState(false);
  const [repairSummary, setRepairSummary] = useState<{ total_scanned: number; automatically_repaired: number; skipped: number } | null>(null);

  const filter = useCallback((key: string) => searchParams.get(key) || '', [searchParams]);
  const setFilter = useCallback((key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value); else next.delete(key);
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    const [exceptions, coaResult, bankResult, taxResult, supplierResult, customerResult] = await Promise.all([
      supabase.from('finance_exception_correction_dashboard').select('*').order('date', { ascending: true, nullsFirst: false }),
      supabase.from('chart_of_accounts').select('id,code,name,account_type,account_group').eq('is_active', true).eq('is_header', false).order('code'),
      supabase.from('bank_accounts').select('id,bank_name,account_name,account_number,alias,currency').eq('is_active', true).order('bank_name'),
      supabase.from('tax_codes').select('id,code,name,tax_type,rate').eq('is_active', true).order('code'),
      supabase.from('suppliers').select('id,company_name').eq('is_active', true).order('company_name'),
      supabase.from('customers').select('id,company_name').order('company_name'),
    ]);
    const failed = [exceptions, coaResult, bankResult, taxResult, supplierResult, customerResult].find(result => result.error);
    if (failed?.error) setError(failed.error.message);
    else {
      setRows((exceptions.data ?? []) as ExceptionRow[]);
      setCoa((coaResult.data ?? []) as CoaOption[]); setBanks((bankResult.data ?? []) as BankOption[]);
      setTaxCodes((taxResult.data ?? []) as TaxOption[]); setSuppliers((supplierResult.data ?? []) as PartyOption[]);
      setCustomers((customerResult.data ?? []) as PartyOption[]);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!canManage || batchRepairAttempted) return;
    setBatchRepairAttempted(true);
    void supabase.rpc('repair_all_posted_fund_transfers').then(({ data, error: repairError }) => {
      if (repairError) { setError(repairError.message); return; }
      setRepairSummary(data as { total_scanned: number; automatically_repaired: number; skipped: number });
      return load();
    });
  }, [batchRepairAttempted, canManage, load]);

  const filteredRows = useMemo(() => {
    const search = filter('search').toLowerCase();
    return rows.filter(row => {
      if (filter('type') && row.document_type !== filter('type')) return false;
      if (filter('status') && row.status !== filter('status')) return false;
      if (filter('currency') && row.currency !== filter('currency')) return false;
      if (filter('bank') && ![row.current_bank_account_id, row.from_bank_account_id, row.to_bank_account_id].includes(filter('bank'))) return false;
      if (filter('from') && (!row.date || row.date < filter('from'))) return false;
      if (filter('to') && (!row.date || row.date > filter('to'))) return false;
      return !search || [row.voucher_number, row.journal_number, row.customer_supplier, row.problem,
        row.current_gl_account, row.current_category, row.current_subcategory, row.bank_alias,
        row.from_bank_alias, row.to_bank_alias, row.current_reference].filter(Boolean).join(' ').toLowerCase().includes(search);
    });
  }, [filter, rows]);

  const types = useMemo(() => [...new Set(rows.map(row => row.document_type))].sort(), [rows]);
  const currencies = useMemo(() => [...new Set(rows.map(row => row.currency).filter(Boolean) as string[])].sort(), [rows]);
  const statuses = useMemo(() => [...new Set(rows.map(row => row.status))].sort(), [rows]);
  const toggle = (row: ExceptionRow) => setExpanded(current => {
    const next = new Set(current); if (next.has(row.row_id)) next.delete(row.row_id); else next.add(row.row_id); return next;
  });

  const updateEdit = (row: ExceptionRow, field: string, value: string) => {
    setEdits(current => ({ ...current, [row.row_id]: { ...current[row.row_id], [field]: value || undefined } }));
  };

  const saveRepair = async (row: ExceptionRow) => {
    const edit = edits[row.row_id] || {};
    const corrections = [{ row_id: row.row_id, exception_id: row.exception_id, document_type: row.document_type,
      document_id: row.document_id, journal_entry_id: row.journal_entry_id, journal_line_id: row.journal_line_id,
      confirm_resolved: true, ...edit }];
    setSavingRow(row.row_id); setError(null);
    const { data, error: saveError } = await supabase.rpc('save_finance_exception_corrections_v2', { p_corrections: corrections });
    if (saveError) setError(saveError.message);
    else {
      const result = data as { resolved_row_ids?: string[] } | null;
      if (result?.resolved_row_ids?.includes(row.row_id)) setRows(current => current.filter(item => item.row_id !== row.row_id));
      setEdits(current => { const next = { ...current }; delete next[row.row_id]; return next; });
      setExpanded(current => { const next = new Set(current); next.delete(row.row_id); return next; });
      window.dispatchEvent(new CustomEvent('finance-data-changed'));
      await load();
    }
    setSavingRow(null);
  };

  if (loading) return <div className="flex items-center justify-center py-16 text-sm text-gray-500"><RefreshCw className="mr-2 h-4 w-4 animate-spin" />Loading unresolved exceptions…</div>;

  return <FinancePage
    title="Finance Exception Correction"
    subtitle="Correct source documents using their normal Finance workflow"
    actions={<><FinanceBadge status="pending">{filteredRows.length === rows.length ? rows.length : `${filteredRows.length} of ${rows.length}`} unresolved</FinanceBadge><FinanceButton type="button" onClick={() => void load()}><RefreshCw className="h-3.5 w-3.5" />Refresh</FinanceButton></>}
  >
    <div className="space-y-2">
    {error && <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">{error}</div>}
    {repairSummary && <div className="rounded-md border border-blue-200 bg-blue-50 p-2 text-xs text-blue-800">Fund Transfer audit: {repairSummary.total_scanned} scanned · {repairSummary.automatically_repaired} repaired · {repairSummary.skipped} skipped for manual review.</div>}
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-2">
      <div className="mb-2 flex items-center justify-between"><span className="inline-flex items-center gap-1.5 text-xs font-semibold text-gray-700"><SlidersHorizontal className="h-3.5 w-3.5" />Filters</span><button type="button" onClick={() => setSearchParams(new URLSearchParams(), { replace: true })} className="text-xs font-medium text-blue-600 hover:underline">Clear all</button></div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
        <label className="relative xl:col-span-2"><Search className="absolute left-2 top-2 h-3.5 w-3.5 text-gray-400" /><input value={filter('search')} onChange={event => setFilter('search', event.target.value)} placeholder="Search voucher, journal, party, problem…" className="w-full rounded-md border border-gray-300 bg-white py-1.5 pl-7 pr-2 text-xs" /></label>
        <select value={filter('type')} onChange={event => setFilter('type', event.target.value)} className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs"><option value="">All document types</option>{types.map(value => <option key={value} value={value}>{humanize(value)}</option>)}</select>
        <select value={filter('status')} onChange={event => setFilter('status', event.target.value)} className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs"><option value="">All statuses</option>{statuses.map(value => <option key={value} value={value}>{humanize(value)}</option>)}</select>
        <select value={filter('currency')} onChange={event => setFilter('currency', event.target.value)} className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs"><option value="">All currencies</option>{currencies.map(value => <option key={value} value={value}>{value}</option>)}</select>
        <label className="flex items-center gap-1 text-[11px] text-gray-500">From<input type="date" value={filter('from')} onChange={event => setFilter('from', event.target.value)} className="min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs" /></label>
        <label className="flex items-center gap-1 text-[11px] text-gray-500">To<input type="date" value={filter('to')} onChange={event => setFilter('to', event.target.value)} className="min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs" /></label>
      </div>
    </div>
    <div className="overflow-x-auto rounded-lg border border-gray-200"><table className="min-w-[1700px] divide-y divide-gray-200 text-xs"><thead className="bg-gray-50 text-left font-medium uppercase tracking-wide text-gray-500"><tr><th className="w-8 px-2 py-2" />{['Date','Voucher Number','Journal Number','Amount','Bank','From Bank','To Bank','Customer / Supplier','Document Type','Current Category','Current GL Account','Problem','Status','Correction'].map(label => <th key={label} className="px-2 py-2">{label}</th>)}</tr></thead><tbody className="divide-y divide-gray-200 bg-white">
      {filteredRows.map(row => { const isExpanded = expanded.has(row.row_id); const edit = edits[row.row_id] || {};
        const needsCategory = problemMatches(row, ['categor', 'expense head', 'ledger']);
        const needsSupplier = ['expense', 'payment'].includes(row.document_type) && problemMatches(row, ['supplier', 'vendor']);
        const needsCustomer = row.document_type === 'receipt' && problemMatches(row, ['customer', 'party']);
        const needsBank = problemMatches(row, ['bank link', 'linked bank', 'bank account', 'cash account', 'payment account']);
        const needsPayment = problemMatches(row, ['payment method', 'payment type', 'paid by']);
        const needsTax = problemMatches(row, ['tax', 'ppn', 'pph']);
        const needsReference = problemMatches(row, ['reference', 'document number']);
        const needsFx = problemMatches(row, ['exchange', 'currency conversion', 'fx rate']) || (row.document_type === 'fund_transfer' && row.currency === 'USD');
        const needsTransferBanks = problemMatches(row, ['from bank', 'to bank', 'bank account', 'transfer']) || !needsFx;
        const needsGl = row.document_type === 'journal' || problemMatches(row, ['chart of accounts', 'gl account', 'account classification', 'wrong account']);
        return <Fragment key={row.row_id}>
        <tr key={row.row_id}>
          <td className="px-2 py-2 align-top"><button type="button" onClick={() => toggle(row)} aria-label={isExpanded ? 'Collapse exception' : 'Expand exception'} className="rounded p-0.5 hover:bg-gray-100">{isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</button></td>
          <td className="px-2 py-2 align-top">{row.date || '—'}</td><td className="px-2 py-2 align-top font-medium">{row.voucher_number || '—'}</td><td className="px-2 py-2 align-top">{row.journal_number || '—'}</td><td className="px-2 py-2 text-right align-top">{formatAmount(row.amount, row.currency)}</td><td className="px-2 py-2 align-top font-medium">{row.bank_alias || row.bank || '—'}</td><td className="px-2 py-2 align-top">{row.from_bank_alias || '—'}</td><td className="px-2 py-2 align-top">{row.to_bank_alias || '—'}</td><td className="px-2 py-2 align-top">{row.customer_supplier || '—'}</td><td className="px-2 py-2 align-top">{humanize(row.document_type)}</td><td className="px-2 py-2 align-top">{humanize(row.current_category)}</td><td className="px-2 py-2 align-top">{row.current_gl_account || '—'}</td><td className="max-w-80 px-2 py-2 align-top">{row.problem}</td><td className="px-2 py-2 align-top"><FinanceBadge status="pending"><AlertTriangle className="h-3 w-3" />{humanize(row.status)}</FinanceBadge></td><td className="px-2 py-2 align-top"><FinanceButton type="button" variant="primary" onClick={() => toggle(row)}>{isExpanded ? 'Close' : 'Open correction'}</FinanceButton></td>
        </tr>
        {isExpanded && <tr key={`${row.row_id}:details`} className="bg-gray-50/70"><td colSpan={15} className="px-4 py-3"><div className="mb-3 grid gap-2 rounded-md border border-gray-200 bg-white p-3 sm:grid-cols-2 lg:grid-cols-5">{[['Voucher Number',row.voucher_number],['Journal Number',row.journal_number],['Date',row.date],['Amount',formatAmount(row.amount,row.currency)],['Currency',row.currency],['Bank Alias',row.bank_alias || row.bank],['Current GL',row.current_gl_account],['Current Category',humanize(row.current_category)],['Current Subcategory',humanize(row.current_subcategory)],['Source Document',row.current_source_document]].map(([label,value]) => <div key={label}><div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">{label}</div><div className="mt-0.5 break-words text-xs font-medium text-gray-800">{value || '—'}</div></div>)}</div><div className="mb-3 grid gap-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900 md:grid-cols-3"><div><span className="font-semibold">Business problem:</span> {row.problem}</div><div><span className="font-semibold">Why it needs review:</span> {row.why_not_automatic}</div><div><span className="font-semibold">Recommended action:</span> {row.recommended_action}</div></div><div className="grid gap-3 rounded-md border border-blue-200 bg-blue-50/40 p-3 sm:grid-cols-2 lg:grid-cols-4">
          {['expense','petty_cash','capital_contribution'].includes(row.document_type) && needsCategory && <label className="text-xs">Expense Category<select value={edit.expense_category || ''} onChange={event => updateEdit(row,'expense_category',event.target.value)} className="mt-1 w-full rounded border px-2 py-1.5" disabled={!canManage}><option value="">No change</option>{expenseCategories.map(category => <option key={category.id} value={category.value}>{category.group !== category.label ? `${category.group} › ` : ''}{category.label}</option>)}</select></label>}
          {row.document_type === 'expense' && needsCategory && <label className="text-xs">Expense Subcategory<select value={edit.expense_subcategory || ''} onChange={event => updateEdit(row,'expense_subcategory',event.target.value)} className="mt-1 w-full rounded border px-2 py-1.5" disabled={!canManage}><option value="">No change</option><option value={row.current_subcategory || ''}>{humanize(row.current_subcategory)}</option></select></label>}
          {needsSupplier && <label className="text-xs">Supplier<select value={edit.supplier_id || ''} onChange={event => updateEdit(row,'supplier_id',event.target.value)} className="mt-1 w-full rounded border px-2 py-1.5" disabled={!canManage}><option value="">No change</option>{suppliers.map(item => <option key={item.id} value={item.id}>{item.company_name}</option>)}</select></label>}
          {needsCustomer && <label className="text-xs">Customer<select value={edit.customer_id || ''} onChange={event => updateEdit(row,'customer_id',event.target.value)} className="mt-1 w-full rounded border px-2 py-1.5" disabled={!canManage}><option value="">No change</option>{customers.map(item => <option key={item.id} value={item.id}>{item.company_name}</option>)}</select></label>}
          {needsBank && ['expense','receipt','payment','tax_payment'].includes(row.document_type) && <label className="text-xs">Bank Account<select value={edit.bank_account_id || ''} onChange={event => updateEdit(row,'bank_account_id',event.target.value)} className="mt-1 w-full rounded border px-2 py-1.5" disabled={!canManage}><option value="">No change</option>{banks.map(item => <option key={item.id} value={item.id}>{bankLabel(item)}</option>)}</select></label>}
          {row.document_type === 'fund_transfer' && <>{needsTransferBanks && <><label className="text-xs">From Bank<select value={edit.from_bank_account_id || ''} onChange={event => updateEdit(row,'from_bank_account_id',event.target.value)} className="mt-1 w-full rounded border px-2 py-1.5" disabled={!canManage}><option value="">No change</option>{banks.map(item => <option key={item.id} value={item.id}>{bankLabel(item)}</option>)}</select></label><label className="text-xs">To Bank<select value={edit.to_bank_account_id || ''} onChange={event => updateEdit(row,'to_bank_account_id',event.target.value)} className="mt-1 w-full rounded border px-2 py-1.5" disabled={!canManage}><option value="">No change</option>{banks.map(item => <option key={item.id} value={item.id}>{bankLabel(item)}</option>)}</select></label></>}{needsFx && <label className="text-xs">Exchange Rate<input type="number" min="0.000001" step="0.000001" value={edit.exchange_rate || ''} onChange={event => updateEdit(row,'exchange_rate',event.target.value)} placeholder="Required for FX conversion" className="mt-1 w-full rounded border px-2 py-1.5" disabled={!canManage} /></label>}</>}
          {needsGl && <label className="text-xs">Chart of Accounts<select value={edit.account_id || ''} onChange={event => updateEdit(row,'account_id',event.target.value)} className="mt-1 w-full rounded border px-2 py-1.5" disabled={!canManage}><option value="">No change</option>{coa.map(item => <option key={item.id} value={item.id}>{item.code} — {item.name}</option>)}</select></label>}
          {['expense','payment'].includes(row.document_type) && needsPayment && <label className="text-xs">Payment Method<input value={edit.payment_type || ''} onChange={event => updateEdit(row,'payment_type',event.target.value)} placeholder={row.current_payment_type || 'Select payment method'} className="mt-1 w-full rounded border px-2 py-1.5" disabled={!canManage} /></label>}
          {['expense','payment'].includes(row.document_type) && needsTax && <label className="text-xs">Tax Category<select value={edit.tax_code_id || ''} onChange={event => updateEdit(row,'tax_code_id',event.target.value)} className="mt-1 w-full rounded border px-2 py-1.5" disabled={!canManage}><option value="">No change</option>{taxCodes.map(item => <option key={item.id} value={item.id}>{item.code} — {item.name}</option>)}</select></label>}
          {['expense','receipt','payment'].includes(row.document_type) && needsReference && <label className="text-xs">Reference<input value={edit.reference || ''} onChange={event => updateEdit(row,'reference',event.target.value)} placeholder={row.current_reference || 'No change'} className="mt-1 w-full rounded border px-2 py-1.5" disabled={!canManage} /></label>}
          {row.document_type === 'bank_reconciliation' && row.current_bank_account_id && <div className="sm:col-span-2 lg:col-span-3"><BankTransactionLinkField
            bankAccountId={row.current_bank_account_id}
            selectedTransactionId={edit.bank_statement_line_id || row.bank_statement_line_id || ''}
            direction={transactionDirection(row)}
            autoSelectSingle
            candidateFilter={(line: BankTransactionLine) => {
              const lineAmount = Number(line.debit_amount || line.credit_amount || 0);
              const amountMatches = row.amount == null || Math.abs(lineAmount - Number(row.amount)) < 0.01;
              const currencyMatches = !row.currency || !line.bank_accounts?.currency || row.currency === line.bank_accounts.currency;
              const dateMatches = !row.date || Math.abs(new Date(line.transaction_date).getTime() - new Date(row.date).getTime()) <= 8 * 24 * 60 * 60 * 1000;
              return amountMatches && currencyMatches && dateMatches;
            }}
            onSelect={async (line) => updateEdit(row, 'bank_statement_line_id', line.id)}
            disabled={!canManage}
          /></div>}
          {row.document_type === 'journal' && <label className="text-xs">Document Classification<input value={edit.document_classification || ''} onChange={event => updateEdit(row,'document_classification',event.target.value)} placeholder="No change" className="mt-1 w-full rounded border px-2 py-1.5" disabled={!canManage} /></label>}
          {['loan','capital_contribution'].includes(row.document_type) && <label className="text-xs">Finance Classification<input value={edit.finance_classification || ''} onChange={event => updateEdit(row,'finance_classification',event.target.value)} placeholder={row.current_finance_classification || 'No change'} className="mt-1 w-full rounded border px-2 py-1.5" disabled={!canManage} /></label>}
          {['sales_invoice','purchase_invoice'].includes(row.document_type) && <label className="text-xs">Faktur Pajak Number<input value={edit.faktur_pajak_number || ''} onChange={event => updateEdit(row,'faktur_pajak_number',event.target.value)} placeholder={row.current_faktur_pajak_number || 'No change'} className="mt-1 w-full rounded border px-2 py-1.5" disabled={!canManage} /></label>}
          <div className="flex items-end"><FinanceButton type="button" variant="primary" onClick={() => void saveRepair(row)} disabled={!canManage || savingRow === row.row_id || !Object.values(edit).some(Boolean)}><Save className="h-3.5 w-3.5" />{savingRow === row.row_id ? 'Saving…' : 'Save repair'}</FinanceButton></div>
        </div></td></tr>}
      </Fragment>; })}
      {!filteredRows.length && <tr><td colSpan={15} className="px-4 py-16 text-center text-sm text-emerald-700">{rows.length ? 'No exceptions match the current filters.' : 'No unresolved Finance exceptions.'}</td></tr>}
    </tbody></table></div>
    </div>
  </FinancePage>;
}
