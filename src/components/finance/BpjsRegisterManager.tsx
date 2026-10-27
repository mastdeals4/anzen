import { useEffect, useState, useMemo } from 'react';
import { supabase } from '../../lib/supabase';
import {
  FileText, Download, RefreshCw, UploadCloud,
  Link2, Trash2, ExternalLink, ShieldCheck,
  Check, Search, X, CheckCircle2
} from 'lucide-react';
import { FinancePage } from './FinancePage';
import { FinanceTable } from './FinanceTable';
import { FinanceButton, FinanceBadge } from './FinanceUI';
import { FinanceModal } from './FinanceModal';
import { MoneyInput } from '../MoneyInput';
import { showToast } from '../ToastNotification';
import { showConfirm } from '../ConfirmDialog';
import { uploadFinanceDocuments } from './FinanceDocumentAttachments';
import { openStorageDocument, downloadStorageDocument } from '../../utils/signedUrlCache';
import * as XLSX from 'xlsx';
import { FloatingField, FLOAT_INPUT } from './FloatingField';
import { SapRow } from './SapLayout';

interface BpjsRegister {
  id: string;
  period_month: number;
  period_year: number;
  npp: string;
  company_name: string;
  status: 'draft' | 'reviewed' | 'approved' | 'posted' | 'reconciled' | 'cancelled';
  total_reported_wages: number;
  total_employee_jht: number;
  total_employee_jp: number;
  total_employee_deductions: number;
  total_employer_jht: number;
  total_employer_jkk: number;
  total_employer_jkm: number;
  total_employer_jp: number;
  total_employer_expenses: number;
  total_contribution_payable: number;
  official_billed_amount: number | null;
  actual_paid_amount: number;
  payment_status: 'unpaid' | 'partially_paid' | 'paid';
  reconciliation_status: 'unreconciled' | 'reconciled' | 'variance';
  journal_entry_id?: string | null;
  payment_journal_entry_id?: string | null;
  bank_statement_line_id?: string | null;
  payment_reference?: string | null;
  notes?: string | null;
  document_urls?: string[] | null;
  created_at: string;
  posted_at?: string | null;
}

interface BpjsRegisterItem {
  id: string;
  register_id: string;
  staff_id: string;
  staff_name: string;
  employee_code: string | null;
  kpj_number: string | null;
  department: string | null;
  monthly_salary: number;
  wage_basis: number;
  is_wage_discrepant: boolean;
  program_jht: boolean;
  program_jkk: boolean;
  program_jkm: boolean;
  program_jp: boolean;
  jht_employee_rate: number;
  jht_employer_rate: number;
  jkk_employer_rate: number;
  jkm_employer_rate: number;
  jp_employee_rate: number;
  jp_employer_rate: number;
  employee_jht_amount: number;
  employee_jp_amount: number;
  total_employee_deduction: number;
  employer_jht_amount: number;
  employer_jkk_amount: number;
  employer_jkm_amount: number;
  employer_jp_amount: number;
  total_employer_expense: number;
  total_payable: number;
}

interface BankLine {
  id: string;
  bank_account_id?: string;
  transaction_date: string;
  debit_amount: number;
  credit_amount: number;
  description: string;
  reference: string | null;
  reconciliation_status: string;
  matching_status: string;
  matched_entry_id: string | null;
  bank_accounts?: {
    id?: string;
    bank_name?: string;
    account_name?: string;
    account_number?: string;
    alias?: string | null;
    currency?: string;
  } | null;
}

interface Props {
  canManage: boolean;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

export function BpjsRegisterManager({ canManage }: Props) {
  const [selectedYear, setSelectedYear] = useState<number>(2026);
  const [selectedMonth, setSelectedMonth] = useState<number>(9); // Default to Sept 2026 (reference month)
  const [register, setRegister] = useState<BpjsRegister | null>(null);
  const [items, setItems] = useState<BpjsRegisterItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [departmentFilter, setDepartmentFilter] = useState<string>('all');

  // Modals
  const [officialBillModalOpen, setOfficialBillModalOpen] = useState<boolean>(false);
  const [officialBillInput, setOfficialBillInput] = useState<number>(767520);
  const [linkBankModalOpen, setLinkBankModalOpen] = useState<boolean>(false);
  const [candidateBankLines, setCandidateBankLines] = useState<BankLine[]>([]);
  const [loadingBankLines, setLoadingBankLines] = useState<boolean>(false);
  const [selectedBankLineId, setSelectedBankLineId] = useState<string>('');
  const [paymentRefInput, setPaymentRefInput] = useState<string>('');
  const [bankAccounts, setBankAccounts] = useState<any[]>([]);
  const [selectedBankAccountId, setSelectedBankAccountId] = useState<string>('all');
  const [bankLineSearch, setBankLineSearch] = useState<string>('');
  const [bankLineStartDate, setBankLineStartDate] = useState<string>('');
  const [bankLineEndDate, setBankLineEndDate] = useState<string>('');
  const [unlinkedOnly, setUnlinkedOnly] = useState<boolean>(true);
  const [uploadModalOpen, setUploadModalOpen] = useState<boolean>(false);
  const [pendingDocs, setPendingDocs] = useState<File[]>([]);
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [journalModalOpen, setJournalModalOpen] = useState<boolean>(false);
  const [journalLines, setJournalLines] = useState<any[]>([]);

  useEffect(() => {
    loadRegister(selectedYear, selectedMonth);
  }, [selectedYear, selectedMonth]);

  const loadRegister = async (year: number, month: number) => {
    setLoading(true);
    try {
      const { data: regData, error: regError } = await supabase
        .from('bpjs_monthly_registers')
        .select('*')
        .eq('period_year', year)
        .eq('period_month', month)
        .maybeSingle();

      if (regError) {
        showToast({ type: 'error', title: 'Load failed', message: regError.message });
        setLoading(false);
        return;
      }

      if (!regData) {
        setRegister(null);
        setItems([]);
        setLoading(false);
        return;
      }

      setRegister(regData);
      setOfficialBillInput(Number(regData.official_billed_amount || regData.total_contribution_payable || 0));

      const { data: itemsData, error: itemsError } = await supabase
        .from('bpjs_monthly_register_items')
        .select('*')
        .eq('register_id', regData.id)
        .order('employee_code', { ascending: true, nullsFirst: false });

      if (itemsError) {
        showToast({ type: 'error', title: 'Items load failed', message: itemsError.message });
      } else {
        setItems(itemsData || []);
      }
    } catch (err: any) {
      showToast({ type: 'error', title: 'Unexpected error', message: err.message });
    } finally {
      setLoading(false);
    }
  };

  const handleGenerateRegister = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.rpc('generate_bpjs_monthly_register', {
        p_year: selectedYear,
        p_month: selectedMonth,
        p_official_bill: officialBillInput || null,
      });

      if (error) {
        showToast({ type: 'error', title: 'Generate failed', message: error.message });
        return;
      }

      showToast({
        type: 'success',
        title: 'BPJS Register Generated',
        message: `${MONTH_NAMES[selectedMonth - 1]} ${selectedYear}: Total Payable Rp ${Number(data.total_contribution_payable).toLocaleString('id-ID')}`
      });

      await loadRegister(selectedYear, selectedMonth);
    } catch (err: any) {
      showToast({ type: 'error', title: 'Error', message: err.message });
    } finally {
      setLoading(false);
    }
  };

  const handleApproveRegister = async () => {
    if (!register) return;
    const ok = await showConfirm({
      title: 'Approve BPJS Register?',
      message: `Approve BPJS register for ${MONTH_NAMES[selectedMonth - 1]} ${selectedYear} with total payable of Rp ${Number(register.total_contribution_payable).toLocaleString('id-ID')}?`,
      confirmLabel: 'Approve',
      variant: 'info',
    });
    if (!ok) return;

    const { error } = await supabase
      .from('bpjs_monthly_registers')
      .update({
        status: 'approved',
        approved_at: new Date().toISOString(),
      })
      .eq('id', register.id);

    if (error) {
      showToast({ type: 'error', title: 'Approval failed', message: error.message });
    } else {
      showToast({ type: 'success', title: 'Register Approved', message: 'Ready for accounting journal posting.' });
      loadRegister(selectedYear, selectedMonth);
    }
  };

  const handlePostRegister = async () => {
    if (!register) return;
    const ok = await showConfirm({
      title: 'Post to Accounting Ledger?',
      message: `Post employer BPJS expenses (Rp ${Number(register.total_employer_expenses).toLocaleString('id-ID')}) to GL 6115 (BPJS Expense) and GL 2134 (BPJS Payable)? This creates an immutable journal entry.`,
      confirmLabel: 'Post Entry',
      variant: 'info',
    });
    if (!ok) return;

    setLoading(true);
    try {
      const { data, error } = await supabase.rpc('post_bpjs_monthly_register', {
        p_register_id: register.id,
      });

      if (error) {
        showToast({ type: 'error', title: 'Posting failed', message: error.message });
        return;
      }

      showToast({
        type: 'success',
        title: 'Accounting Entry Posted',
        message: `Journal ${data.entry_number} created for Rp ${Number(data.total_posted).toLocaleString('id-ID')}.`
      });

      await loadRegister(selectedYear, selectedMonth);
    } catch (err: any) {
      showToast({ type: 'error', title: 'Posting error', message: err.message });
    } finally {
      setLoading(false);
    }
  };

  const fetchCandidateBankLines = async (start?: string, end?: string, accountId?: string) => {
    setLoadingBankLines(true);
    try {
      let query = supabase
        .from('bank_statement_lines')
        .select(`
          id,
          bank_account_id,
          transaction_date,
          debit_amount,
          credit_amount,
          description,
          reference,
          reconciliation_status,
          matching_status,
          matched_entry_id,
          bank_accounts:bank_account_id(id, bank_name, account_name, account_number, alias, currency)
        `)
        .gt('debit_amount', 0);

      const startDate = start !== undefined ? start : bankLineStartDate;
      const endDate = end !== undefined ? end : bankLineEndDate;
      const acct = accountId !== undefined ? accountId : selectedBankAccountId;

      if (acct && acct !== 'all') {
        query = query.eq('bank_account_id', acct);
      }
      if (startDate) query = query.gte('transaction_date', startDate);
      if (endDate) query = query.lte('transaction_date', endDate);

      const { data, error } = await query
        .order('transaction_date', { ascending: false })
        .limit(100);

      if (error) {
        showToast({ type: 'error', title: 'Bank lines load failed', message: error.message });
      } else {
        const rawLines = (data || []) as any[];
        const lines: BankLine[] = rawLines.map(l => ({
          ...l,
          bank_accounts: Array.isArray(l.bank_accounts) ? l.bank_accounts[0] : l.bank_accounts
        }));
        setCandidateBankLines(lines);

        // Auto-select ONLY if there is a STRONG match:
        // Matches exact contribution payable AND description has BPJS/NPP, AND NOT already reconciled!
        const targetAmount = Number(register?.official_billed_amount || register?.total_contribution_payable || 0);
        const strongMatch = lines.find(l => {
          const isNotSettled = l.reconciliation_status === 'matched' && !l.matched_entry_id;
          const isAmtMatch = Math.abs(Number(l.debit_amount) - targetAmount) < 0.01;
          const isBpjsDesc = /BPJS|26719331|42671933/i.test(l.description || '');
          return isNotSettled && isAmtMatch && isBpjsDesc;
        });

        if (strongMatch) {
          setSelectedBankLineId(strongMatch.id);
          setPaymentRefInput(strongMatch.reference || strongMatch.description);
        } else {
          setSelectedBankLineId('');
        }
      }
    } catch (err: any) {
      showToast({ type: 'error', title: 'Bank lines error', message: err.message });
    } finally {
      setLoadingBankLines(false);
    }
  };

  const openBankReconciliationModal = async () => {
    setLinkBankModalOpen(true);
    setSelectedBankLineId('');
    setBankLineSearch('');
    setUnlinkedOnly(true);

    // Load active bank accounts if not loaded yet
    let accounts = bankAccounts;
    if (accounts.length === 0) {
      const { data: acctData } = await supabase
        .from('bank_accounts')
        .select('id, bank_name, account_name, account_number, alias, currency')
        .eq('is_active', true)
        .order('bank_name');
      if (acctData) {
        setBankAccounts(acctData);
        accounts = acctData;
      }
    }

    // Default to BCA IDR if available, else 'all'
    const bca = accounts.find(a => (a.bank_name || '').toUpperCase().includes('BCA') && (a.currency === 'IDR' || !a.currency));
    const initialAccountId = bca ? bca.id : 'all';
    setSelectedBankAccountId(initialAccountId);

    // Contextual settlement window: start of contribution month to end of subsequent month
    const targetMonthStr = String(selectedMonth).padStart(2, '0');
    const startCandidate = `${selectedYear}-${targetMonthStr}-01`;
    const nextMonth = selectedMonth === 12 ? 1 : selectedMonth + 1;
    const nextYear = selectedMonth === 12 ? selectedYear + 1 : selectedYear;
    const lastDayNextMonth = new Date(nextYear, nextMonth, 0).getDate();
    const endCandidate = `${nextYear}-${String(nextMonth).padStart(2, '0')}-${String(lastDayNextMonth).padStart(2, '0')}`;

    setBankLineStartDate(startCandidate);
    setBankLineEndDate(endCandidate);
    await fetchCandidateBankLines(startCandidate, endCandidate, initialAccountId);
  };

  const handleLinkBankPayment = async () => {
    if (!register || !selectedBankLineId) {
      showToast({ type: 'error', title: 'Select transaction', message: 'Please select a bank statement transaction line.' });
      return;
    }

    setLoading(true);
    try {
      const { data, error } = await supabase.rpc('reconcile_bpjs_register_payment', {
        p_register_id: register.id,
        p_bank_line_id: selectedBankLineId,
        p_payment_reference: paymentRefInput.trim() || null,
      });

      if (error) {
        showToast({ type: 'error', title: 'Payment reconciliation failed', message: error.message });
        return;
      }

      showToast({
        type: 'success',
        title: 'Reconciliation Successful',
        message: `Settled Rp ${Number(data.actual_paid_amount).toLocaleString('id-ID')} against bank ledger. Status: ${data.reconciliation_status}.`
      });

      setLinkBankModalOpen(false);
      await loadRegister(selectedYear, selectedMonth);
    } catch (err: any) {
      showToast({ type: 'error', title: 'Reconciliation error', message: err.message });
    } finally {
      setLoading(false);
    }
  };

  const handleReverseRegister = async () => {
    if (!register) return;
    const ok = await showConfirm({
      title: 'Reverse BPJS Register?',
      message: `Reverse this register and its posted accounting entries? Any matched bank statement line will be unlinked and reopened.`,
      confirmLabel: 'Reverse',
      variant: 'danger',
    });
    if (!ok) return;

    setLoading(true);
    try {
      const { error } = await supabase.rpc('reverse_bpjs_monthly_register', {
        p_register_id: register.id,
        p_reason: 'User requested reversal from BPJS Register',
      });

      if (error) {
        showToast({ type: 'error', title: 'Reversal failed', message: error.message });
        return;
      }

      showToast({
        type: 'success',
        title: 'Register Reversed',
        message: 'Journals marked reversed and register cancelled.',
      });

      await loadRegister(selectedYear, selectedMonth);
    } catch (err: any) {
      showToast({ type: 'error', title: 'Reversal error', message: err.message });
    } finally {
      setLoading(false);
    }
  };

  const handleSaveOfficialBill = async () => {
    if (!register) return;
    try {
      const { error } = await supabase
        .from('bpjs_monthly_registers')
        .update({
          official_billed_amount: officialBillInput,
          updated_at: new Date().toISOString(),
        })
        .eq('id', register.id);

      if (error) {
        showToast({ type: 'error', title: 'Save failed', message: error.message });
      } else {
        showToast({ type: 'success', title: 'Official Bill Saved', message: `Rp ${Number(officialBillInput).toLocaleString('id-ID')}` });
        setOfficialBillModalOpen(false);
        loadRegister(selectedYear, selectedMonth);
      }
    } catch (err: any) {
      showToast({ type: 'error', title: 'Save error', message: err.message });
    }
  };

  const handleUploadDocuments = async () => {
    if (!register || pendingDocs.length === 0) return;
    setIsUploading(true);
    try {
      const urls = await uploadFinanceDocuments(pendingDocs, 'bpjs_register');
      const updatedUrls = [...(register.document_urls || []), ...urls];

      const { error } = await supabase
        .from('bpjs_monthly_registers')
        .update({
          document_urls: updatedUrls,
          updated_at: new Date().toISOString(),
        })
        .eq('id', register.id);

      if (error) {
        showToast({ type: 'error', title: 'Update failed', message: error.message });
      } else {
        showToast({ type: 'success', title: 'Documents uploaded', message: `${urls.length} document(s) attached.` });
        setPendingDocs([]);
        setUploadModalOpen(false);
        loadRegister(selectedYear, selectedMonth);
      }
    } catch (err: any) {
      showToast({ type: 'error', title: 'Upload error', message: err.message });
    } finally {
      setIsUploading(false);
    }
  };

  const handleExportExcel = () => {
    if (!register || items.length === 0) {
      showToast({ type: 'info', title: 'Nothing to export', message: 'No register items available.' });
      return;
    }

    const summaryData = [
      ['PT AVIRA PARAMA FARMA - BPJS KETENAGAKERJAAN REGISTER'],
      ['NPP:', register.npp, 'Period:', `${MONTH_NAMES[selectedMonth - 1]} ${selectedYear}`],
      ['Status:', register.status.toUpperCase(), 'Payment Status:', register.payment_status.toUpperCase()],
      ['Total Reported Wages:', Number(register.total_reported_wages)],
      ['Total Employee Deductions (2%):', Number(register.total_employee_deductions)],
      ['Total Employer Contributions (4.24%):', Number(register.total_employer_expenses)],
      ['Total Contribution Payable:', Number(register.total_contribution_payable)],
      ['Official Billed Amount:', Number(register.official_billed_amount || register.total_contribution_payable)],
      ['Actual Paid Amount:', Number(register.actual_paid_amount)],
      [],
    ];

    const itemsHeaders = [
      'Emp Code', 'Staff Name', 'KPJ Number', 'Department', 'Master Salary', 'BPJS Wage Basis',
      'Wage Discrepant', 'JHT Emp (2%)', 'JHT Er (3.7%)', 'JKK Er (0.24%)', 'JKM Er (0.30%)',
      'Total Employee Deduction', 'Total Employer Expense', 'Total Payable'
    ];

    const itemsRows = items.map(item => [
      item.employee_code || '',
      item.staff_name,
      item.kpj_number || '',
      item.department || '',
      Number(item.monthly_salary),
      Number(item.wage_basis),
      item.is_wage_discrepant ? 'YES' : 'NO',
      Number(item.employee_jht_amount),
      Number(item.employer_jht_amount),
      Number(item.employer_jkk_amount),
      Number(item.employer_jkm_amount),
      Number(item.total_employee_deduction),
      Number(item.total_employer_expense),
      Number(item.total_payable),
    ]);

    const worksheet = XLSX.utils.aoa_to_sheet([...summaryData, itemsHeaders, ...itemsRows]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, `BPJS_${selectedYear}_${selectedMonth}`);

    const filename = `BPJS_Ketenagakerjaan_${selectedYear}_${String(selectedMonth).padStart(2, '0')}.xlsx`;
    XLSX.writeFile(workbook, filename);
    showToast({ type: 'success', title: 'Export Complete', message: `Saved ${filename}` });
  };

  const handleViewJournal = async (journalId: string) => {
    try {
      const { data, error } = await supabase
        .from('journal_entry_lines')
        .select('*, account:chart_of_accounts(code, name)')
        .eq('journal_entry_id', journalId)
        .order('line_number');

      if (error) {
        showToast({ type: 'error', title: 'Journal load failed', message: error.message });
      } else {
        setJournalLines(data || []);
        setJournalModalOpen(true);
      }
    } catch (err: any) {
      showToast({ type: 'error', title: 'Error', message: err.message });
    }
  };

  const departments = useMemo(() => {
    const set = new Set<string>();
    items.forEach(i => { if (i.department) set.add(i.department); });
    return Array.from(set);
  }, [items]);

  const filteredItems = useMemo(() => {
    return items.filter(item => {
      const matchesSearch = !searchTerm ||
        item.staff_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (item.employee_code || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
        (item.kpj_number || '').toLowerCase().includes(searchTerm.toLowerCase());
      const matchesDept = departmentFilter === 'all' || item.department === departmentFilter;
      return matchesSearch && matchesDept;
    });
  }, [items, searchTerm, departmentFilter]);

  const variance = register
    ? Number(register.actual_paid_amount) - Number(register.official_billed_amount || register.total_contribution_payable)
    : 0;

  return (
    <FinancePage
      customHeader={(
        <div className="bg-white border border-gray-200 rounded-lg px-3.5 py-3 sm:px-4 sm:py-3.5 flex flex-col gap-2.5">
          {/* Row 1 — Page title and period controls */}
          <div className="flex flex-wrap items-center justify-between gap-3 min-h-[34px]">
            {/* Left: BPJS Register title and subtitle on one compact line */}
            <div className="flex items-center gap-2 min-w-0">
              <h1 className="text-sm font-semibold text-gray-900 whitespace-nowrap">BPJS Register</h1>
              <span className="text-xs text-gray-500 truncate hidden lg:inline">
                BPJS Ketenagakerjaan Monthly Contributions &amp; Bank Reconciliation (PT Avira Parama Farma — NPP: 26719331)
              </span>
            </div>

            {/* Right: Period month selector, year selector, and Draft/Unpaid status badges */}
            <div className="flex items-center gap-2 flex-wrap shrink-0">
              <span className="text-xs font-semibold text-gray-700">Period:</span>
              <select
                value={selectedMonth}
                onChange={e => setSelectedMonth(Number(e.target.value))}
                className="h-[34px] px-2.5 text-xs border border-gray-300 rounded font-medium bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                {MONTH_NAMES.map((name, idx) => (
                  <option key={name} value={idx + 1}>{name}</option>
                ))}
              </select>
              <select
                value={selectedYear}
                onChange={e => setSelectedYear(Number(e.target.value))}
                className="h-[34px] px-2.5 text-xs border border-gray-300 rounded font-medium bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                {[2024, 2025, 2026, 2027].map(y => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>

              {register && (
                <FinanceBadge
                  status={
                    register.status === 'reconciled' ? 'approved' :
                    register.status === 'posted' ? 'posted' :
                    register.status === 'approved' ? 'approved' :
                    register.status === 'cancelled' ? 'cancelled' : 'draft'
                  }
                  className="!h-[30px] !text-xs !px-2.5 !py-0 flex items-center"
                >
                  {register.status.toUpperCase()}
                </FinanceBadge>
              )}

              {register && (
                <span className={`text-[11px] font-semibold px-2.5 h-[30px] inline-flex items-center rounded-full border ${
                  register.payment_status === 'paid' ? 'bg-emerald-50 text-emerald-800 border-emerald-200' :
                  register.payment_status === 'partially_paid' ? 'bg-amber-50 text-amber-800 border-amber-200' :
                  'bg-gray-100 text-gray-700 border-gray-200'
                }`}>
                  {register.payment_status === 'paid' ? 'PAID' :
                   register.payment_status === 'partially_paid' ? 'PARTIALLY PAID' : 'UNPAID'}
                </span>
              )}
            </div>
          </div>

          {/* Row 2 — Filters and actions */}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-2.5 border-t border-gray-100">
            {/* Left: Department dropdown and staff/KPJ search field */}
            <div className="flex items-center gap-2 flex-wrap min-w-0">
              <select
                value={departmentFilter}
                onChange={e => setDepartmentFilter(e.target.value)}
                className="h-[34px] px-2.5 text-xs border border-gray-300 rounded bg-white min-w-[140px] focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="all">All Departments</option>
                {departments.map(d => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>

              <div className="relative w-52 sm:w-64">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                <input
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                  placeholder="Search staff / KPJ..."
                  className="w-full h-[34px] pl-8 pr-2.5 text-xs border border-gray-300 rounded bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            </div>

            {/* Right: Export Excel, Review & Approve, and Recalculate Draft buttons */}
            <div className="flex items-center gap-2 flex-wrap shrink-0">
              <FinanceButton variant="secondary" onClick={handleExportExcel} disabled={!register || items.length === 0} className="!h-[34px]">
                <Download className="w-3.5 h-3.5" /> Export Excel
              </FinanceButton>

              {register && register.status === 'draft' && canManage && (
                <FinanceButton variant="secondary" onClick={handleApproveRegister} className="!h-[34px]">
                  <Check className="w-3.5 h-3.5" /> Review &amp; Approve
                </FinanceButton>
              )}

              {register && register.status === 'approved' && canManage && (
                <FinanceButton variant="primary" onClick={handlePostRegister} className="!h-[34px]">
                  <FileText className="w-3.5 h-3.5" /> Post Accounting Entry
                </FinanceButton>
              )}

              {register && (register.status === 'posted' || (register.status === 'approved' && !register.journal_entry_id)) && canManage && (
                <FinanceButton variant="primary" onClick={openBankReconciliationModal} className="!h-[34px]">
                  <Link2 className="w-3.5 h-3.5" /> Link Bank Payment
                </FinanceButton>
              )}

              {register && (register.status === 'posted' || register.status === 'reconciled') && canManage && (
                <FinanceButton variant="secondary" onClick={handleReverseRegister} className="!h-[34px] !text-red-700 hover:!bg-red-50">
                  <RefreshCw className="w-3.5 h-3.5" /> Reversal
                </FinanceButton>
              )}

              <FinanceButton variant="primary" onClick={handleGenerateRegister} className="!h-[34px]">
                <RefreshCw className="w-3.5 h-3.5" /> {register ? 'Recalculate Draft' : 'Generate Register'}
              </FinanceButton>
            </div>
          </div>
        </div>
      )}
    >
      <div className="space-y-4">
        {/* KPI Summary Cards */}
        {register ? (
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
            <div className="bg-white p-3 rounded-xl border border-gray-200 shadow-xs">
              <div className="text-[10px] uppercase font-bold text-gray-500">Reported Wages</div>
              <div className="text-sm font-bold font-mono text-gray-900 mt-1">
                Rp {Number(register.total_reported_wages).toLocaleString('id-ID')}
              </div>
              <div className="text-[10px] text-gray-400 mt-0.5">{items.length} employee(s)</div>
            </div>

            <div className="bg-blue-50/60 p-3 rounded-xl border border-blue-200 shadow-xs">
              <div className="text-[10px] uppercase font-bold text-blue-700">Employee JHT (2%)</div>
              <div className="text-sm font-bold font-mono text-blue-900 mt-1">
                Rp {Number(register.total_employee_deductions).toLocaleString('id-ID')}
              </div>
              <div className="text-[10px] text-blue-600 mt-0.5">Deducted from salary</div>
            </div>

            <div className="bg-purple-50/60 p-3 rounded-xl border border-purple-200 shadow-xs">
              <div className="text-[10px] uppercase font-bold text-purple-700">Employer Expense</div>
              <div className="text-sm font-bold font-mono text-purple-900 mt-1">
                Rp {Number(register.total_employer_expenses).toLocaleString('id-ID')}
              </div>
              <div className="text-[10px] text-purple-600 mt-0.5">Company cost (4.24%)</div>
            </div>

            <div className="bg-emerald-50/70 p-3 rounded-xl border border-emerald-200 shadow-xs">
              <div className="text-[10px] uppercase font-bold text-emerald-800">Total Contribution</div>
              <div className="text-sm font-bold font-mono text-emerald-900 mt-1">
                Rp {Number(register.total_contribution_payable).toLocaleString('id-ID')}
              </div>
              <div className="text-[10px] text-emerald-700 mt-0.5">Calculated payable</div>
            </div>

            <div className="bg-white p-3 rounded-xl border border-gray-200 shadow-xs relative">
              <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase font-bold text-gray-500">Official Bill</span>
                <button
                  type="button"
                  onClick={() => setOfficialBillModalOpen(true)}
                  className="text-[10px] text-indigo-600 hover:underline"
                >
                  Edit
                </button>
              </div>
              <div className="text-sm font-bold font-mono text-gray-900 mt-1">
                Rp {Number(register.official_billed_amount || register.total_contribution_payable).toLocaleString('id-ID')}
              </div>
              <div className="text-[10px] text-gray-400 mt-0.5">Avira Determination</div>
            </div>

            <div className="bg-white p-3 rounded-xl border border-gray-200 shadow-xs">
              <div className="text-[10px] uppercase font-bold text-gray-500">Actual Paid</div>
              <div className="text-sm font-bold font-mono text-gray-900 mt-1">
                Rp {Number(register.actual_paid_amount).toLocaleString('id-ID')}
              </div>
              <div className="text-[10px] text-gray-400 mt-0.5">
                {register.bank_statement_line_id ? 'Linked to BCA' : 'Not linked'}
              </div>
            </div>

            <div className={`p-3 rounded-xl border shadow-xs ${
              Math.abs(variance) < 0.01
                ? 'bg-emerald-50/50 border-emerald-200 text-emerald-900'
                : 'bg-amber-50/50 border-amber-200 text-amber-900'
            }`}>
              <div className="text-[10px] uppercase font-bold">Variance / Diff</div>
              <div className="text-sm font-bold font-mono mt-1">
                Rp {variance.toLocaleString('id-ID')}
              </div>
              <div className="text-[10px] mt-0.5">
                {Math.abs(variance) < 0.01 ? 'Fully balanced (Rp 0)' : 'Variance review'}
              </div>
            </div>
          </div>
        ) : (
          <div className="bg-white p-6 rounded-xl border border-dashed border-gray-300 text-center space-y-3">
            <ShieldCheck className="w-10 h-10 text-emerald-600 mx-auto" />
            <div>
              <h3 className="text-sm font-bold text-gray-900">No BPJS Register for {MONTH_NAMES[selectedMonth - 1]} {selectedYear}</h3>
              <p className="text-xs text-gray-500 mt-0.5">
                Click Generate Register to calculate contributions based on active Staff Master BPJS enrollments.
              </p>
            </div>
            <FinanceButton variant="primary" onClick={handleGenerateRegister}>
              <RefreshCw className="w-3.5 h-3.5" /> Generate Register for {MONTH_NAMES[selectedMonth - 1]} {selectedYear}
            </FinanceButton>
          </div>
        )}

        {/* Audit & Linked Accounting Bar */}
        {register && (
          <div className="flex items-center justify-between bg-white px-3 py-2 rounded-lg border border-gray-200 text-xs">
            <div className="flex items-center gap-4 flex-wrap">
              {register.journal_entry_id && (
                <div className="flex items-center gap-1.5">
                  <span className="text-gray-500">Posting Journal:</span>
                  <button
                    type="button"
                    onClick={() => handleViewJournal(register.journal_entry_id!)}
                    className="font-mono font-medium text-indigo-600 hover:underline flex items-center gap-1"
                  >
                    View Entry <ExternalLink className="w-3 h-3" />
                  </button>
                </div>
              )}

              {register.payment_journal_entry_id && (
                <div className="flex items-center gap-1.5">
                  <span className="text-gray-500">Settlement Journal:</span>
                  <button
                    type="button"
                    onClick={() => handleViewJournal(register.payment_journal_entry_id!)}
                    className="font-mono font-medium text-emerald-600 hover:underline flex items-center gap-1"
                  >
                    View Settlement <ExternalLink className="w-3 h-3" />
                  </button>
                </div>
              )}

              {register.payment_reference && (
                <div className="flex items-center gap-1.5">
                  <span className="text-gray-500">Payment Ref:</span>
                  <span className="font-mono text-gray-800">{register.payment_reference}</span>
                </div>
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setUploadModalOpen(true)}
                className="text-indigo-600 hover:underline font-medium flex items-center gap-1"
              >
                <UploadCloud className="w-3.5 h-3.5" />
                Attachments ({register.document_urls?.length || 0})
              </button>
            </div>
          </div>
        )}

        {/* Register Table */}
        <FinanceTable
          rows={filteredItems}
          rowKey={(r) => r.id}
          loading={loading}
          empty={`No BPJS contribution items for ${MONTH_NAMES[selectedMonth - 1]} ${selectedYear}.`}
          columns={[
            {
              header: 'Staff Member',
              cell: (r) => (
                <div>
                  <div className="font-medium text-gray-900">{r.staff_name}</div>
                  <div className="font-mono text-[10px] text-gray-500">{r.employee_code || '—'}</div>
                </div>
              ),
            },
            {
              header: 'KPJ Number',
              cell: (r) => (
                <span className="font-mono text-xs text-gray-700 bg-gray-100 px-1.5 py-0.5 rounded">
                  {r.kpj_number || '—'}
                </span>
              ),
            },
            { header: 'Department', cell: (r) => r.department || '—' },
            {
              header: 'Salary vs Wage Basis',
              align: 'right',
              cell: (r) => (
                <div className="text-right">
                  <div className="font-mono font-medium text-gray-900">
                    Rp {Number(r.wage_basis).toLocaleString('id-ID')}
                  </div>
                  {r.is_wage_discrepant ? (
                    <div className="text-[10px] font-bold text-amber-700 bg-amber-50 px-1 rounded inline-block">
                      Differs (Sal: Rp {Number(r.monthly_salary).toLocaleString('id-ID')})
                    </div>
                  ) : (
                    <div className="text-[10px] text-gray-400">Matches Salary</div>
                  )}
                </div>
              ),
            },
            {
              header: 'Employee JHT (2%)',
              align: 'right',
              cell: (r) => (
                <span className="font-mono text-blue-700 font-semibold">
                  Rp {Number(r.employee_jht_amount).toLocaleString('id-ID')}
                </span>
              ),
            },
            {
              header: 'Employer JHT (3.7%)',
              align: 'right',
              cell: (r) => (
                <span className="font-mono text-gray-700">
                  Rp {Number(r.employer_jht_amount).toLocaleString('id-ID')}
                </span>
              ),
            },
            {
              header: 'JKK (0.24%)',
              align: 'right',
              cell: (r) => (
                <span className="font-mono text-gray-700">
                  Rp {Number(r.employer_jkk_amount).toLocaleString('id-ID')}
                </span>
              ),
            },
            {
              header: 'JKM (0.30%)',
              align: 'right',
              cell: (r) => (
                <span className="font-mono text-gray-700">
                  Rp {Number(r.employer_jkm_amount).toLocaleString('id-ID')}
                </span>
              ),
            },
            {
              header: 'Total Employer (4.24%)',
              align: 'right',
              cell: (r) => (
                <span className="font-mono font-semibold text-purple-700">
                  Rp {Number(r.total_employer_expense).toLocaleString('id-ID')}
                </span>
              ),
            },
            {
              header: 'Total Payable',
              align: 'right',
              cell: (r) => (
                <span className="font-mono font-bold text-emerald-800">
                  Rp {Number(r.total_payable).toLocaleString('id-ID')}
                </span>
              ),
            },
          ]}
        />
      </div>

      {/* Official Bill Modal */}
      {officialBillModalOpen && (
        <FinanceModal
          isOpen={officialBillModalOpen}
          onClose={() => setOfficialBillModalOpen(false)}
          title="Update Official Billed Amount"
          size="sm"
          footer={(
            <>
              <FinanceButton variant="secondary" onClick={() => setOfficialBillModalOpen(false)}>Cancel</FinanceButton>
              <FinanceButton variant="primary" onClick={handleSaveOfficialBill}>Save Bill Amount</FinanceButton>
            </>
          )}
        >
          <div className="space-y-3">
            <p className="text-xs text-gray-600">
              Enter the official amount billed by BPJS Ketenagakerjaan for this period. Any discrepancy against the system calculation will be tracked for review.
            </p>
            <SapRow>
              <FloatingField label="Official Billed Amount (Rp)" span={12} filled={!!officialBillInput}>
                <MoneyInput
                  value={officialBillInput}
                  onChange={setOfficialBillInput}
                  className={`${FLOAT_INPUT} text-right`}
                />
              </FloatingField>
            </SapRow>
          </div>
        </FinanceModal>
      )}

      {/* Link Bank Payment Modal */}
      {linkBankModalOpen && (
        <FinanceModal
          isOpen={linkBankModalOpen}
          onClose={() => setLinkBankModalOpen(false)}
          title={`Link Bank Statement Payment Line — ${MONTH_NAMES[selectedMonth - 1]} ${selectedYear}`}
          size="lg"
          footer={(
            <>
              <FinanceButton variant="secondary" onClick={() => setLinkBankModalOpen(false)}>Cancel</FinanceButton>
              <FinanceButton
                variant="primary"
                onClick={handleLinkBankPayment}
                disabled={!selectedBankLineId || candidateBankLines.find(l => l.id === selectedBankLineId)?.reconciliation_status === 'matched'}
              >
                Reconcile & Settle Payment
              </FinanceButton>
            </>
          )}
        >
          <div className="space-y-4">
            {/* Context Summary Header */}
            <div className="p-3 bg-indigo-50/60 border border-indigo-100 rounded-lg flex flex-wrap items-center justify-between gap-3 text-xs">
              <div>
                <span className="text-gray-500 block text-[11px] font-medium uppercase tracking-wider">BPJS Period Payable</span>
                <span className="font-mono font-bold text-sm text-indigo-950">
                  Rp {Number(register?.official_billed_amount || register?.total_contribution_payable || 0).toLocaleString('id-ID')}
                </span>
                <span className="text-[11px] text-gray-500 ml-2">
                  (Bill: Rp {Number(register?.official_billed_amount || 0).toLocaleString('id-ID')} • Calc: Rp {Number(register?.total_contribution_payable || 0).toLocaleString('id-ID')})
                </span>
              </div>
              <div className="text-right">
                <span className="text-gray-500 block text-[11px] font-medium uppercase tracking-wider">Settlement Ledger</span>
                <span className="font-mono font-medium text-gray-700">Dr 2134 BPJS Payable • Cr Bank Ledger</span>
              </div>
            </div>

            {/* Filter Bar */}
            <div className="space-y-2 pt-1 border-t border-gray-100">
              <SapRow>
                {/* Search */}
                <FloatingField
                  label="Search"
                  span={5}
                  filled={!!bankLineSearch}
                  prefix={<Search className="w-3.5 h-3.5 text-gray-400" />}
                  right={bankLineSearch ? (
                    <button
                      type="button"
                      onClick={() => setBankLineSearch('')}
                      className="text-gray-400 hover:text-gray-600"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  ) : undefined}
                >
                  <input
                    type="text"
                    value={bankLineSearch}
                    onChange={e => setBankLineSearch(e.target.value)}
                    placeholder="Search desc, ref, amount (767520), date..."
                    className={FLOAT_INPUT}
                  />
                </FloatingField>

                {/* Bank Account */}
                <FloatingField label="Bank Account" span={3} filled={!!selectedBankAccountId}>
                  <select
                    value={selectedBankAccountId}
                    onChange={e => {
                      const newAcct = e.target.value;
                      setSelectedBankAccountId(newAcct);
                      fetchCandidateBankLines(bankLineStartDate, bankLineEndDate, newAcct);
                    }}
                    className={FLOAT_INPUT}
                  >
                    <option value="all">All Bank Accounts</option>
                    {bankAccounts.map(b => (
                      <option key={b.id} value={b.id}>
                        {b.alias || b.bank_name} {b.account_number ? `(${b.account_number})` : ''}
                      </option>
                    ))}
                  </select>
                </FloatingField>

                {/* Date Range Controls */}
                <FloatingField label="From Date" span={2} filled={!!bankLineStartDate}>
                  <input
                    type="date"
                    value={bankLineStartDate}
                    onChange={e => setBankLineStartDate(e.target.value)}
                    className={FLOAT_INPUT}
                    title="From Date"
                  />
                </FloatingField>
                <FloatingField label="To Date" span={2} filled={!!bankLineEndDate}>
                  <input
                    type="date"
                    value={bankLineEndDate}
                    onChange={e => setBankLineEndDate(e.target.value)}
                    className={FLOAT_INPUT}
                    title="To Date"
                  />
                </FloatingField>
              </SapRow>

              {/* Unlinked only toggle */}
              <div className="flex items-center justify-between text-xs text-gray-600 px-1">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={unlinkedOnly}
                    onChange={e => setUnlinkedOnly(e.target.checked)}
                    className="rounded text-indigo-600 focus:ring-0"
                  />
                  <span>Hide settled / already reconciled transactions</span>
                </label>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-gray-400">
                    {candidateBankLines.length} candidates loaded
                  </span>
                  <button
                    type="button"
                    onClick={() => fetchCandidateBankLines(bankLineStartDate, bankLineEndDate, selectedBankAccountId)}
                    className="h-7 px-2.5 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded text-xs flex items-center gap-1 shrink-0 transition-colors"
                    title="Refresh transactions"
                  >
                    <RefreshCw className="w-3 h-3" />
                  </button>
                </div>
              </div>
            </div>

            {/* Candidate List */}
            <div className="max-h-72 overflow-y-auto border border-gray-200 rounded-lg divide-y divide-gray-100">
              {loadingBankLines ? (
                <div className="p-8 text-center text-xs text-gray-500 flex flex-col items-center gap-2">
                  <RefreshCw className="w-4 h-4 animate-spin text-indigo-600" />
                  <span>Loading bank transactions...</span>
                </div>
              ) : (() => {
                const targetAmt = Number(register?.official_billed_amount || register?.total_contribution_payable || 0);
                const filtered = candidateBankLines.filter(line => {
                  const isSettled = line.reconciliation_status === 'matched' || !!line.matched_entry_id;
                  if (unlinkedOnly && isSettled) return false;
                  if (!bankLineSearch.trim()) return true;

                  const term = bankLineSearch.trim().toLowerCase();
                  const rawAmt = String(Number(line.debit_amount || 0));
                  const formattedAmt = Number(line.debit_amount || 0).toLocaleString('id-ID');
                  const desc = (line.description || '').toLowerCase();
                  const ref = (line.reference || '').toLowerCase();
                  const dt = (line.transaction_date || '').toLowerCase();
                  return desc.includes(term) || ref.includes(term) || dt.includes(term) || rawAmt.includes(term) || formattedAmt.includes(term);
                });

                if (filtered.length === 0) {
                  return (
                    <div className="p-8 text-center text-xs text-gray-500 space-y-1">
                      <p className="font-medium text-gray-700">No bank statement lines match the selected filters.</p>
                      <p className="text-[11px] text-gray-400">Try widening the date range, changing bank account, or clearing the search keyword.</p>
                    </div>
                  );
                }

                return filtered.map(line => {
                  const isSelected = selectedBankLineId === line.id;
                  const isSettled = line.reconciliation_status === 'matched' || !!line.matched_entry_id;
                  const isAmtMatch = Math.abs(Number(line.debit_amount) - targetAmt) < 0.01;
                  const isBpjsDesc = /BPJS|26719331|42671933/i.test(line.description || '');
                  const isStrongMatch = !isSettled && isAmtMatch && isBpjsDesc;

                  // Format Indonesian date DD/MM/YYYY
                  const [y, m, d] = (line.transaction_date || '').split('-');
                  const formattedDate = y && m && d ? `${d}/${m}/${y}` : line.transaction_date;

                  return (
                    <div
                      key={line.id}
                      onClick={() => {
                        if (isSettled) {
                          showToast({ type: 'warning', title: 'Cannot Select Settled Line', message: 'This transaction is already reconciled to another entry.' });
                          return;
                        }
                        setSelectedBankLineId(line.id);
                        setPaymentRefInput(line.reference || line.description);
                      }}
                      className={`p-3 flex items-start justify-between transition-colors ${
                        isSettled
                          ? 'bg-gray-50/70 opacity-60 cursor-not-allowed'
                          : isSelected
                          ? 'bg-indigo-50 border-l-4 border-l-indigo-600 cursor-pointer'
                          : 'hover:bg-gray-50 cursor-pointer'
                      }`}
                    >
                      <div className="space-y-1 pr-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <input
                            type="radio"
                            checked={isSelected}
                            disabled={isSettled}
                            readOnly
                            className="text-indigo-600 focus:ring-0 mt-0.5"
                          />
                          <span className="font-mono text-xs font-bold text-gray-900">
                            {formattedDate}
                          </span>
                          {line.bank_accounts && (
                            <span className="text-[10px] font-medium text-gray-600 bg-gray-100 px-1.5 py-0.5 rounded">
                              {line.bank_accounts.alias || line.bank_accounts.bank_name}
                            </span>
                          )}
                          {isSettled ? (
                            <span className="text-[10px] font-semibold text-gray-600 bg-gray-200 px-1.5 py-0.5 rounded">
                              Already Settled / Reconciled
                            </span>
                          ) : isStrongMatch ? (
                            <span className="text-[10px] font-bold text-emerald-800 bg-emerald-100 px-2 py-0.5 rounded border border-emerald-300 flex items-center gap-1">
                              <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                              Exact Amount & BPJS Keyword Match
                            </span>
                          ) : isAmtMatch ? (
                            <span className="text-[10px] font-semibold text-blue-800 bg-blue-100 px-1.5 py-0.5 rounded border border-blue-200">
                              Amount Match (Rp {targetAmt.toLocaleString('id-ID')})
                            </span>
                          ) : isBpjsDesc ? (
                            <span className="text-[10px] font-semibold text-purple-800 bg-purple-100 px-1.5 py-0.5 rounded border border-purple-200">
                              BPJS Keyword
                            </span>
                          ) : null}
                        </div>

                        <div className="text-xs text-gray-800 font-mono break-all" title={line.description}>
                          {line.description}
                        </div>
                        {line.reference && (
                          <div className="text-[11px] text-gray-500 font-mono">
                            Ref: {line.reference}
                          </div>
                        )}
                      </div>

                      <div className="text-right shrink-0">
                        <div className="font-mono font-bold text-xs text-gray-900">
                          Rp {Number(line.debit_amount).toLocaleString('id-ID')}
                        </div>
                        <div className="text-[10px] text-gray-400 font-mono mt-0.5 capitalize">
                          {line.reconciliation_status} • {line.matching_status}
                        </div>
                      </div>
                    </div>
                  );
                });
              })()}
            </div>

            {/* Selected Transaction Summary Banner */}
            {selectedBankLineId && (() => {
              const selectedLine = candidateBankLines.find(l => l.id === selectedBankLineId);
              if (!selectedLine) return null;
              const targetAmt = Number(register?.official_billed_amount || register?.total_contribution_payable || 0);
              const selectedAmt = Number(selectedLine.debit_amount || 0);
              const variance = selectedAmt - targetAmt;

              return (
                <div className="p-2.5 bg-blue-50/70 border border-blue-200 rounded-md text-xs flex items-center justify-between">
                  <div className="space-y-0.5">
                    <span className="font-semibold text-blue-900">Selected Transaction:</span>
                    <div className="text-blue-800 font-mono text-[11px]">
                      {selectedLine.transaction_date} • Rp {selectedAmt.toLocaleString('id-ID')}
                    </div>
                  </div>
                  <div className="text-right">
                    {Math.abs(variance) < 0.01 ? (
                      <span className="font-bold text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded text-[11px]">
                        Exact Match (Variance Rp 0)
                      </span>
                    ) : (
                      <span className="font-bold text-amber-800 bg-amber-100 px-2 py-0.5 rounded text-[11px]">
                        Variance: Rp {variance.toLocaleString('id-ID')}
                      </span>
                    )}
                  </div>
                </div>
              );
            })()}

            <SapRow>
              <FloatingField label="Payment Reference / Notes" span={12} filled={!!paymentRefInput}>
                <input
                  value={paymentRefInput}
                  onChange={e => setPaymentRefInput(e.target.value)}
                  placeholder="e.g. NPP 26719331 - TRSF E-BANKING DB 0110/FTFVA"
                  className={FLOAT_INPUT}
                />
              </FloatingField>
            </SapRow>
          </div>
        </FinanceModal>
      )}

      {/* Upload Attachments Modal */}
      {uploadModalOpen && register && (
        <FinanceModal
          isOpen={uploadModalOpen}
          onClose={() => setUploadModalOpen(false)}
          title={`BPJS Documents — ${MONTH_NAMES[selectedMonth - 1]} ${selectedYear}`}
          size="md"
          footer={(
            <>
              <FinanceButton variant="secondary" onClick={() => setUploadModalOpen(false)}>Close</FinanceButton>
              {pendingDocs.length > 0 && (
                <FinanceButton variant="primary" onClick={handleUploadDocuments} disabled={isUploading}>
                  {isUploading ? 'Uploading...' : `Upload (${pendingDocs.length})`}
                </FinanceButton>
              )}
            </>
          )}
        >
          <div className="space-y-3">
            <p className="text-xs text-gray-600">
              Attach official BPJS contribution determination letters, statement bills, or bank payment slips.
            </p>

            <div className="flex items-center gap-2">
              <input
                type="file"
                id="reg-doc-upload"
                multiple
                accept="image/*,.pdf,.doc,.docx"
                className="hidden"
                onChange={(e) => {
                  const files = Array.from(e.target.files || []);
                  if (files.length > 0) setPendingDocs(prev => [...prev, ...files]);
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                onClick={() => document.getElementById('reg-doc-upload')?.click()}
                className="px-3 py-1.5 text-xs font-medium text-indigo-700 bg-indigo-50 hover:bg-indigo-100 rounded-lg border border-indigo-200 flex items-center gap-1.5"
              >
                <UploadCloud className="w-4 h-4" /> Browse or Drag Documents
              </button>
            </div>

            {/* Existing Documents */}
            <div className="space-y-1.5 pt-2">
              <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Attached Files</div>
              {(!register.document_urls || register.document_urls.length === 0) && pendingDocs.length === 0 ? (
                <div className="text-xs text-gray-400 italic">No attachments yet.</div>
              ) : (
                <div className="divide-y divide-gray-100 border border-gray-200 rounded-lg">
                  {register.document_urls?.map((url, idx) => {
                    const filename = url.split('/').pop()?.split('?')[0] || `Document ${idx + 1}`;
                    return (
                      <div key={url} className="p-2 flex items-center justify-between text-xs bg-white">
                        <span className="truncate max-w-[240px] font-medium text-gray-800" title={filename}>{filename}</span>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => openStorageDocument(url)}
                            className="p-1 text-gray-400 hover:text-indigo-600"
                            title="Open"
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => downloadStorageDocument(url, filename)}
                            className="p-1 text-gray-400 hover:text-emerald-600"
                            title="Download"
                          >
                            <Download className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                  {pendingDocs.map((file, idx) => (
                    <div key={`${file.name}-${idx}`} className="p-2 flex items-center justify-between text-xs bg-indigo-50/50">
                      <span className="truncate max-w-[240px] font-medium text-indigo-900">{file.name}</span>
                      <button
                        type="button"
                        onClick={() => setPendingDocs(prev => prev.filter((_, i) => i !== idx))}
                        className="p-1 text-gray-400 hover:text-red-600"
                        title="Cancel"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </FinanceModal>
      )}

      {/* Journal Entry Lines Modal */}
      {journalModalOpen && (
        <FinanceModal
          isOpen={journalModalOpen}
          onClose={() => setJournalModalOpen(false)}
          title="Journal Entry Breakdown"
          size="lg"
          footer={<FinanceButton variant="secondary" onClick={() => setJournalModalOpen(false)}>Close</FinanceButton>}
        >
          <div className="space-y-3">
            <div className="border border-gray-200 rounded-lg overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 border-b border-gray-200 text-gray-600">
                  <tr>
                    <th className="py-1.5 px-3 text-left">Line</th>
                    <th className="py-1.5 px-3 text-left">Account</th>
                    <th className="py-1.5 px-3 text-left">Description</th>
                    <th className="py-1.5 px-3 text-right">Debit</th>
                    <th className="py-1.5 px-3 text-right">Credit</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 font-mono">
                  {journalLines.map(line => (
                    <tr key={line.id} className="hover:bg-gray-50/60">
                      <td className="py-1.5 px-3">{line.line_number}</td>
                      <td className="py-1.5 px-3">
                        {line.account?.code} — {line.account?.name}
                      </td>
                      <td className="py-1.5 px-3 text-gray-700">{line.description}</td>
                      <td className="py-1.5 px-3 text-right text-gray-900">
                        {Number(line.debit || 0) > 0 ? `Rp ${Number(line.debit).toLocaleString('id-ID')}` : '—'}
                      </td>
                      <td className="py-1.5 px-3 text-right text-gray-900">
                        {Number(line.credit || 0) > 0 ? `Rp ${Number(line.credit).toLocaleString('id-ID')}` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </FinanceModal>
      )}
    </FinancePage>
  );
}
