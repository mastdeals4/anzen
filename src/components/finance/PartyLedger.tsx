import { useState, useEffect, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { type CompanySnapshot, FALLBACK_COMPANY } from '../../types/company';
import { CompanyLogo } from '../CompanyLogo';
import { Users, Building2, Download, Mail, RefreshCw } from 'lucide-react';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';
import { useFinance } from '../../contexts/FinanceContext';
import { FINANCE_RECONCILIATION_REFRESH_EVENT } from './bankTransactionLinking';
import { formatCurrency } from '../../utils/currency';
import { calculateCanonicalCashPayable } from '../../utils/taxCalculations';
import { getEffectiveExpensePostingStates, isEffectiveExpensePosting } from '../../services/expensePostingLifecycle';

interface Party {
  id: string;
  name: string;
  type: 'customer' | 'supplier' | 'staff';
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  npwp?: string;
}

interface LedgerEntry {
  id: string;
  entry_date: string;
  particulars: string;
  reference: string;
  debit: number;
  credit: number;
  running_balance: number;
  type: 'invoice' | 'payment' | 'receipt' | 'opening';
}

export default function PartyLedger() {
  const { dateRange: globalDateRange } = useFinance();
  const printRef = useRef<HTMLDivElement>(null);
  const [partyType, setPartyType] = useState<'customer' | 'supplier' | 'staff'>('customer');
  const [parties, setParties] = useState<Party[]>([]);
  const [selectedParty, setSelectedParty] = useState<string>('');
  const [ledgerEntries, setLedgerEntries] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [openingBalance, setOpeningBalance] = useState(0);
  const [sendingEmail, setSendingEmail] = useState(false);
  const [co, setCo] = useState<CompanySnapshot>(FALLBACK_COMPANY);

  useEffect(() => {
    supabase
      .from('company_profiles')
      .select('company_name, company_address, company_phone, company_email, company_tax_id, company_logo_url, pbf_license, cdob_certificate')
      .lte('effective_from', new Date().toISOString().split('T')[0])
      .order('effective_from', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => { if (data) setCo(data as CompanySnapshot); });
  }, []);

  useEffect(() => {
    loadParties();
  }, [partyType]);

  useEffect(() => {
    if (selectedParty) {
      loadLedgerEntries();
    } else {
      setLedgerEntries([]);
      setOpeningBalance(0);
    }
  }, [selectedParty, globalDateRange.startDate, globalDateRange.endDate]);

  useEffect(() => {
    const refresh = () => {
      if (selectedParty) void loadLedgerEntries();
    };
    window.addEventListener(FINANCE_RECONCILIATION_REFRESH_EVENT, refresh);
    return () => window.removeEventListener(FINANCE_RECONCILIATION_REFRESH_EVENT, refresh);
  });

  const loadParties = async () => {
    if (partyType === 'staff') {
      const { data } = await supabase
        .from('finance_staff_master')
        .select('id, full_name, employee_code, department, npwp')
        .order('full_name');
      if (data) {
        setParties(data.map(p => ({
          id: p.id,
          name: p.employee_code ? `${p.full_name} (${p.employee_code})` : p.full_name,
          type: 'staff' as const,
          address: p.department || undefined,
          npwp: p.npwp || undefined,
        })));
      }
      setSelectedParty('');
      return;
    }

    const tableName = partyType === 'customer' ? 'customers' : 'suppliers';

    const { data } = await supabase
      .from(tableName)
      .select('id, company_name, email, phone, address, city, npwp')
      .order('company_name');

    if (data) {
      setParties(data.map(p => ({
        ...p,
        name: p.company_name,
        type: partyType
      })));
    }
    setSelectedParty('');
  };

  // Fetch ledger entries for [fromDate, toDate]. fromDate null = from the
  // beginning of time (used to compute the opening balance before the period).
  const fetchEntries = async (fromDate: string | null, toDate: string): Promise<LedgerEntry[]> => {
    const entries: LedgerEntry[] = [];
    const toFunctionalIDR = (amount: number, currency?: string | null, rate?: number | null) =>
      currency === 'USD' ? (rate && rate > 0 ? amount * rate : 0) : amount;
    const currencyDetail = (amount: number, currency?: string | null, rate?: number | null) =>
      currency === 'USD'
        ? ` (${formatCurrency(amount, 'USD')}${rate && rate > 0 ? ` @ ${formatCurrency(rate, 'IDR')}/USD` : ' — exchange rate missing'})`
        : '';
    const dateRange = <T,>(q: T, col: string): T => {
      let qq = (q as any).lte(col, toDate);
      if (fromDate) qq = qq.gte(col, fromDate);
      return qq;
    };
    const onlyEffectiveExpenses = async <T extends { id: string }>(rows: T[] | null): Promise<T[]> => {
      if (!rows?.length) return [];
      const states = await getEffectiveExpensePostingStates(rows.map(row => row.id));
      return rows.filter(row => isEffectiveExpensePosting(states.get(row.id)?.effective_posting_state));
    };

    if (partyType === 'customer') {
      const { data: invoices } = await dateRange(
        supabase
          .from('sales_invoices')
          .select('id, invoice_date, invoice_number, total_amount, payment_status')
          .eq('customer_id', selectedParty),
        'invoice_date',
      ).order('invoice_date');

      if (invoices) {
        invoices.forEach(inv => {
          entries.push({
            id: inv.id,
            entry_date: inv.invoice_date,
            particulars: `Sales Invoice - ${inv.payment_status || 'Unpaid'}`,
            reference: inv.invoice_number,
            debit: inv.total_amount,
            credit: 0,
            running_balance: 0,
            type: 'invoice',
          });
        });
      }

      const { data: receipts } = await dateRange(
        supabase
          .from('receipt_vouchers')
          .select('id, voucher_date, voucher_number, amount, description, transaction_currency, currency_code, exchange_rate')
          .eq('customer_id', selectedParty)
          .eq('is_posted', true),
        'voucher_date',
      ).order('voucher_date');

      if (receipts) {
        receipts.forEach(rec => {
          const currency = rec.transaction_currency || rec.currency_code || 'IDR';
          entries.push({
            id: rec.id,
            entry_date: rec.voucher_date,
            particulars: `${rec.description || 'Receipt'}${currencyDetail(rec.amount, currency, rec.exchange_rate)}`,
            reference: rec.voucher_number,
            debit: 0,
            credit: toFunctionalIDR(rec.amount, currency, rec.exchange_rate),
            running_balance: 0,
            type: 'receipt',
          });
        });
      }

      const { data: creditNotes } = await dateRange(
        supabase
          .from('credit_notes')
          .select('id, credit_note_date, credit_note_number, total_amount')
          .eq('customer_id', selectedParty)
          .eq('status', 'approved'),
        'credit_note_date',
      ).order('credit_note_date');

      if (creditNotes) {
        creditNotes.forEach(cn => {
          entries.push({
            id: cn.id,
            entry_date: cn.credit_note_date,
            particulars: 'Credit Note',
            reference: cn.credit_note_number,
            debit: 0,
            credit: cn.total_amount,
            running_balance: 0,
            type: 'receipt',
          });
        });
      }
    } else if (partyType === 'supplier') {
      const { data: invoices } = await dateRange(
        supabase
          .from('purchase_invoices')
          .select('id, invoice_date, invoice_number, total_amount, status, currency, exchange_rate')
          .eq('supplier_id', selectedParty),
        'invoice_date',
      ).order('invoice_date');

      if (invoices) {
        invoices.forEach(inv => {
          const functionalAmount = toFunctionalIDR(inv.total_amount, inv.currency, inv.exchange_rate);
          entries.push({
            id: inv.id,
            entry_date: inv.invoice_date,
            particulars: `Purchase Invoice - ${inv.status || 'Unpaid'}${currencyDetail(inv.total_amount, inv.currency, inv.exchange_rate)}`,
            reference: inv.invoice_number,
            debit: 0,
            credit: functionalAmount,
            running_balance: 0,
            type: 'invoice',
          });
        });
      }

      // Expense bills (A/P): approved outstanding-type expenses booked
      // against this supplier. Settlement vouchers already appear via
      // payment_vouchers below — without these credits the statement
      // would show payments with no matching bill.
      const { data: expenseBills } = await dateRange(
        supabase
          .from('finance_expenses')
          .select('id, expense_date, invoice_number, voucher_number, amount, expense_category, ppn_amount, pph_amount, stamp_duty_amount, bank_charges_amount, broker_items, paid_amount, transaction_currency, currency_code, exchange_rate')
          .eq('supplier_id', selectedParty)
          .neq('expense_category', 'import_broker')
          .is('payment_method', null)
          .eq('approval_status', 'approved'),
        'expense_date',
      ).order('expense_date');

      const effectiveExpenseBills = await onlyEffectiveExpenses(expenseBills);
      if (effectiveExpenseBills.length) {
        effectiveExpenseBills.forEach(bill => {
          const payable = calculateCanonicalCashPayable(bill);
          const outstanding = payable - (bill.paid_amount ?? 0);
          const currency = bill.transaction_currency || bill.currency_code || 'IDR';
          entries.push({
            id: bill.id,
            entry_date: bill.expense_date,
            particulars: `Expense Bill - ${(bill.expense_category || '').replace(/_/g, ' ')}${outstanding <= 0.01 ? ' (Paid)' : ''}${currencyDetail(payable, currency, bill.exchange_rate)}`,
            reference: bill.invoice_number || bill.voucher_number || '',
            debit: 0,
            credit: toFunctionalIDR(payable, currency, bill.exchange_rate),
            running_balance: 0,
            type: 'invoice',
          });
        });
      }

      // Customs broker ledgers are sourced from the canonical journal lines.
      // Expense/Input-PPN lines retain source-supplier provenance, while the
      // combined AP/cash credit belongs to the customs broker paid by the
      // Payment Voucher. Raw finance_expenses.amount is not used here.
      const brokerLinesQuery = supabase
        .from('journal_entry_lines')
        .select('id, entry_date:journal_entries!inner(entry_date), debit, credit, description, journal_entry_id, journal_entries!inner(reference_number, transaction_category, is_posted, is_reversed)')
        .eq('supplier_id', selectedParty)
        .eq('journal_entries.transaction_category', 'import_broker')
        .eq('journal_entries.is_posted', true)
        .eq('journal_entries.is_reversed', false);
      const brokerLines = await dateRange(brokerLinesQuery, 'journal_entries.entry_date');
      if (brokerLines.data) {
        brokerLines.data.forEach((line: any) => {
          const entryDate = line.entry_date?.entry_date || line.journal_entries?.entry_date;
          entries.push({
            id: `${line.journal_entry_id}:${line.id}`,
            entry_date: entryDate,
            particulars: line.description || 'Customs Broker Invoice',
            reference: line.journal_entries?.reference_number || '',
            debit: Number(line.debit || 0),
            credit: Number(line.credit || 0),
            running_balance: 0,
            type: line.credit > 0 ? 'payment' : 'invoice',
          });
        });
      }

      const { data: payments } = await dateRange(
        supabase
          .from('payment_vouchers')
          .select('id, voucher_date, voucher_number, amount, description, transaction_currency, payment_currency, currency_code, exchange_rate')
          .eq('supplier_id', selectedParty)
          .eq('is_posted', true),
        'voucher_date',
      ).order('voucher_date');

      if (payments) {
        payments.forEach(pay => {
          const currency = pay.transaction_currency || pay.payment_currency || pay.currency_code || 'IDR';
          entries.push({
            id: pay.id,
            entry_date: pay.voucher_date,
            particulars: `${pay.description || 'Payment'}${currencyDetail(pay.amount, currency, pay.exchange_rate)}`,
            reference: pay.voucher_number,
            debit: toFunctionalIDR(pay.amount, currency, pay.exchange_rate),
            credit: 0,
            running_balance: 0,
            type: 'payment',
          });
        });
      }
    } else {
      // Staff ledger — one running account per staff member:
      //   Cr  salary / staff bills recorded as outstanding (company owes staff)
      //   Dr  salary advance applications and final payments
      // Salary Advance issuance is an asset movement, not a reduction of the
      // employee salary payable, so it is omitted from this payable ledger.
      const { data: bills } = await dateRange(
        supabase
          .from('finance_expenses')
          .select('id, expense_date, invoice_number, voucher_number, amount, expense_category, ppn_amount, pph_amount, stamp_duty_amount, bank_charges_amount, broker_items, paid_amount, transaction_currency, currency_code, exchange_rate')
          .eq('staff_id', selectedParty)
          .neq('expense_category', 'staff_advance')
          .is('payment_method', null)
          .eq('approval_status', 'approved'),
        'expense_date',
      ).order('expense_date');

      const effectiveBills = await onlyEffectiveExpenses(bills);
      if (effectiveBills.length) {
        effectiveBills.forEach(bill => {
          const payable = calculateCanonicalCashPayable(bill);
          const outstanding = payable - (bill.paid_amount ?? 0);
          const currency = bill.transaction_currency || bill.currency_code || 'IDR';
          entries.push({
            id: bill.id,
            entry_date: bill.expense_date,
            particulars: `${(bill.expense_category || '').replace(/_/g, ' ')} Bill${outstanding <= 0.01 ? ' (Paid)' : ''}${currencyDetail(payable, currency, bill.exchange_rate)}`,
            reference: bill.invoice_number || bill.voucher_number || '',
            debit: 0,
            credit: toFunctionalIDR(payable, currency, bill.exchange_rate),
            running_balance: 0,
            type: 'invoice',
          });
        });
      }

      const { data: advances } = await dateRange(
        supabase
          .from('finance_expenses')
          .select('id, expense_date, invoice_number, voucher_number, amount, transaction_currency, currency_code, exchange_rate')
          .eq('staff_id', selectedParty)
          .eq('expense_category', 'staff_advance')
          .not('payment_method', 'is', null)
          .eq('approval_status', 'approved'),
        'expense_date',
      ).order('expense_date');

      const effectiveAdvances = await onlyEffectiveExpenses(advances);
      if (effectiveAdvances.length) {
        effectiveAdvances.forEach(adv => {
          const currency = adv.transaction_currency || adv.currency_code || 'IDR';
          entries.push({
            id: adv.id,
            entry_date: adv.expense_date,
            particulars: `Staff Advance Given${currencyDetail(adv.amount, currency, adv.exchange_rate)}`,
            reference: adv.invoice_number || adv.voucher_number || '',
            debit: toFunctionalIDR(adv.amount, currency, adv.exchange_rate),
            credit: 0,
            running_balance: 0,
            type: 'payment',
          });
        });
      }

      const { data: vouchers } = await dateRange(
        supabase
          .from('payment_vouchers')
          .select('id, voucher_date, voucher_number, amount, description, payment_method, payment_purpose, transaction_currency, payment_currency, currency_code, exchange_rate')
          .eq('staff_id', selectedParty)
          .eq('is_posted', true),
        'voucher_date',
      ).order('voucher_date');

      if (vouchers) {
        vouchers.forEach(pv => {
          const isAdjustment = pv.payment_method === 'advance_adjustment';
          if (pv.payment_purpose === 'salary_advance') return;
          const currency = pv.transaction_currency || pv.payment_currency || pv.currency_code || 'IDR';
          const functionalAmount = toFunctionalIDR(pv.amount, currency, pv.exchange_rate);
          entries.push({
            id: pv.id,
            entry_date: pv.voucher_date,
            particulars: isAdjustment
              ? `Less Salary Advance${currencyDetail(pv.amount, currency, pv.exchange_rate)}`
              : `${pv.description || 'Payment to Staff'}${currencyDetail(pv.amount, currency, pv.exchange_rate)}`,
            reference: pv.voucher_number,
            debit: functionalAmount,
            credit: 0,
            running_balance: 0,
            type: 'payment',
          });
        });
      }
    }

    entries.sort((a, b) => new Date(a.entry_date).getTime() - new Date(b.entry_date).getTime());
    return entries;
  };

  const loadLedgerEntries = async () => {
    if (!selectedParty) return;

    setLoading(true);
    try {
      // Opening balance = net of all transactions before the period start.
      const before = new Date(globalDateRange.startDate);
      before.setDate(before.getDate() - 1);
      const priorEntries = await fetchEntries(null, before.toISOString().split('T')[0]);
      const opening = priorEntries.reduce((s, e) => s + e.debit - e.credit, 0);
      setOpeningBalance(opening);

      const entries = await fetchEntries(globalDateRange.startDate, globalDateRange.endDate);

      let runningBalance = opening;
      entries.forEach(entry => {
        runningBalance += entry.debit - entry.credit;
        entry.running_balance = runningBalance;
      });

      setLedgerEntries(entries);
    } catch (err) {
      console.error('Error loading ledger:', err);
      alert('Failed to load ledger data. Please check console for details.');
    } finally {
      setLoading(false);
    }
  };

  const formatAmount = (amount: number) => {
    return formatCurrency(amount, 'IDR', { zeroAsDash: true });
  };

  const formatBalance = (balance: number) => {
    const absBalance = Math.abs(balance);
    const label = balance >= 0 ? 'Dr' : 'Cr';
    return `${formatAmount(absBalance)} ${label}`;
  };

  const totalDebit = ledgerEntries.reduce((sum, e) => sum + e.debit, 0);
  const totalCredit = ledgerEntries.reduce((sum, e) => sum + e.credit, 0);
  const closingBalance = openingBalance + totalDebit - totalCredit;
  const outstanding = Math.abs(closingBalance);

  const exportToPDF = async () => {
    if (!printRef.current) return;

    try {
      const canvas = await html2canvas(printRef.current, {
        scale: 2,
        useCORS: true,
        allowTaint: true,
        logging: false,
        backgroundColor: '#ffffff',
      });

      const imgData = canvas.toDataURL('image/png', 1.0);
      const pdf = new jsPDF('p', 'mm', 'a4');

      const pdfWidth = pdf.internal.pageSize.getWidth();
      const pdfHeight = pdf.internal.pageSize.getHeight();
      const imgWidth = canvas.width;
      const imgHeight = canvas.height;
      const ratio = pdfWidth / imgWidth;
      const scaledHeight = imgHeight * ratio;

      if (scaledHeight > pdfHeight) {
        let position = 0;
        let remainingHeight = scaledHeight;

        while (remainingHeight > 0) {
          pdf.addImage(imgData, 'PNG', 0, position, pdfWidth, scaledHeight);
          remainingHeight -= pdfHeight;
          position -= pdfHeight;

          if (remainingHeight > 0) {
            pdf.addPage();
          }
        }
      } else {
        pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, scaledHeight);
      }

      const selectedPartyData = parties.find(p => p.id === selectedParty);
      pdf.save(`${partyType}_Ledger_${selectedPartyData?.name.replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.pdf`);
    } catch (error) {
      console.error('Error generating PDF:', error);
      alert('Failed to generate PDF. Please try again.');
    }
  };

  const sendStatementOfAccount = async () => {
    const selectedPartyData = parties.find(p => p.id === selectedParty);
    if (!selectedPartyData || !selectedPartyData.email) {
      alert('No email address found for this party');
      return;
    }

    if (!confirm(`Send Statement of Account to ${selectedPartyData.email}?`)) {
      return;
    }

    setSendingEmail(true);
    await exportToPDF();
    alert(`PDF downloaded. Please attach and send to ${selectedPartyData.email}`);
    setSendingEmail(false);
  };

  const selectedPartyData = parties.find(p => p.id === selectedParty);

  return (
    <div className="flex flex-col gap-1.5">
      {/* Shared title strip — matches every other Finance page */}
      <div className="flex items-center justify-between h-8 px-2 bg-white border border-gray-200 rounded">
        <div className="flex items-baseline gap-2 min-w-0">
          <h1 className="text-xs font-bold text-gray-900 truncate flex items-center gap-1.5">
            {partyType === 'customer'
              ? <Users className="w-3 h-3 text-blue-600" />
              : <Building2 className="w-3 h-3 text-purple-600" />}
            {partyType === 'customer' ? 'Customer' : partyType === 'supplier' ? 'Supplier' : 'Staff'} Ledger
          </h1>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={loadLedgerEntries}
            disabled={!selectedParty || loading}
            className="inline-flex items-center gap-1 h-7 px-2 bg-blue-600 text-white rounded text-xs font-semibold hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            onClick={exportToPDF}
            disabled={!selectedParty || ledgerEntries.length === 0}
            className="inline-flex items-center gap-1 h-7 px-2 bg-green-600 text-white rounded text-xs font-semibold hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Download className="w-3 h-3" />
            Export PDF
          </button>
          <button
            onClick={sendStatementOfAccount}
            disabled={!selectedParty || ledgerEntries.length === 0 || sendingEmail}
            className="inline-flex items-center gap-1 h-7 px-2 bg-purple-600 text-white rounded text-xs font-semibold hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Mail className="w-3 h-3" />
            {sendingEmail ? 'Sending...' : 'Email SOA'}
          </button>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-sm p-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Party Type</label>
            <select
              value={partyType}
              onChange={(e) => {
                setPartyType(e.target.value as 'customer' | 'supplier' | 'staff');
                setSelectedParty('');
              }}
              className="w-full px-3 py-2 border rounded-lg"
            >
              <option value="customer">Customer (Debtor)</option>
              <option value="supplier">Supplier (Creditor)</option>
              <option value="staff">Staff (Employee)</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Select {partyType === 'customer' ? 'Customer' : partyType === 'supplier' ? 'Supplier' : 'Staff Member'}
            </label>
            <select
              value={selectedParty}
              onChange={(e) => setSelectedParty(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg"
            >
              <option value="">Select Party</option>
              {parties.map(party => (
                <option key={party.id} value={party.id}>
                  {party.name}
                </option>
              ))}
            </select>
          </div>
          <div className="col-span-2">
            <p className="text-xs text-gray-500 mt-6">Period is controlled by global date range at top</p>
          </div>
        </div>

        {selectedPartyData && ledgerEntries.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 p-4 bg-gradient-to-r from-blue-50 to-purple-50 rounded-lg">
            <div>
              <p className="text-xs font-medium text-gray-600 uppercase">Opening Balance</p>
              <p className="text-lg font-bold text-gray-900">{formatBalance(openingBalance)}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-gray-600 uppercase">Total Debit</p>
              <p className="text-lg font-bold text-red-600">{formatAmount(totalDebit)}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-gray-600 uppercase">Total Credit</p>
              <p className="text-lg font-bold text-green-600">{formatAmount(totalCredit)}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-gray-600 uppercase">Outstanding</p>
              <p className="text-lg font-bold text-orange-600">{formatAmount(outstanding)}</p>
            </div>
          </div>
        )}
      </div>

      {selectedParty && (
        <>
          {/* Screen View */}
          <div className="bg-white rounded-lg shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-1.5 py-1 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                      Date
                    </th>
                    <th className="px-1.5 py-1 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                      Particulars
                    </th>
                    <th className="px-1.5 py-1 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                      Ref No
                    </th>
                    <th className="px-1.5 py-1 text-right text-xs font-medium text-gray-700 uppercase tracking-wider">
                      Debit (Dr)
                    </th>
                    <th className="px-1.5 py-1 text-right text-xs font-medium text-gray-700 uppercase tracking-wider">
                      Credit (Cr)
                    </th>
                    <th className="px-1.5 py-1 text-right text-xs font-medium text-gray-700 uppercase tracking-wider">
                      Balance
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  <tr className="bg-blue-50 font-semibold">
                    <td className="px-2 py-1 whitespace-nowrap text-xs text-gray-900" colSpan={3}>
                      Opening Balance
                    </td>
                    <td className="px-2 py-1 whitespace-nowrap text-xs text-gray-900 text-right">-</td>
                    <td className="px-2 py-1 whitespace-nowrap text-xs text-gray-900 text-right">-</td>
                    <td className="px-2 py-1 whitespace-nowrap text-xs text-gray-900 text-right font-bold">
                      {formatBalance(openingBalance)}
                    </td>
                  </tr>

                  {loading ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                        Loading entries...
                      </td>
                    </tr>
                  ) : ledgerEntries.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                        No transactions found for this period
                      </td>
                    </tr>
                  ) : (
                    ledgerEntries.map(entry => (
                      <tr key={entry.id} className="hover:bg-gray-50">
                        <td className="px-2 py-1 whitespace-nowrap text-xs text-gray-900">
                          {new Date(entry.entry_date).toLocaleDateString('id-ID')}
                        </td>
                        <td className="px-2 py-1 text-xs text-gray-900">
                          {entry.particulars}
                        </td>
                        <td className="px-2 py-1 text-xs text-gray-600 font-mono">
                          {entry.reference}
                        </td>
                        <td className="px-2 py-1 whitespace-nowrap text-xs text-red-600 text-right font-medium">
                          {entry.debit > 0 ? formatAmount(entry.debit) : '-'}
                        </td>
                        <td className="px-2 py-1 whitespace-nowrap text-xs text-green-600 text-right font-medium">
                          {entry.credit > 0 ? formatAmount(entry.credit) : '-'}
                        </td>
                        <td className="px-2 py-1 whitespace-nowrap text-xs text-gray-900 text-right font-semibold">
                          {formatBalance(entry.running_balance)}
                        </td>
                      </tr>
                    ))
                  )}

                  {ledgerEntries.length > 0 && (
                    <tr className="bg-gray-100 font-semibold border-t-2 border-gray-300">
                      <td className="px-2 py-1 whitespace-nowrap text-xs text-gray-900" colSpan={3}>
                        Closing Balance
                      </td>
                      <td className="px-2 py-1 whitespace-nowrap text-xs text-red-600 text-right font-bold">
                        {formatAmount(totalDebit)}
                      </td>
                      <td className="px-2 py-1 whitespace-nowrap text-xs text-green-600 text-right font-bold">
                        {formatAmount(totalCredit)}
                      </td>
                      <td className="px-2 py-1 whitespace-nowrap text-xs text-gray-900 text-right font-bold">
                        {formatBalance(closingBalance)}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* PDF Print Content - Hidden */}
          {selectedPartyData && ledgerEntries.length > 0 && (
            <div style={{ position: 'absolute', left: '-9999px', top: 0 }}>
              <div ref={printRef} style={{ width: '210mm', padding: '20mm', backgroundColor: '#ffffff' }}>
                {/* Header with Company Logo */}
                <div style={{ marginBottom: '15px', borderWidth: '2px', borderColor: '#000', borderStyle: 'solid', padding: '15px' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '15px' }}>
                      <div style={{ width: '60px', height: '60px', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' }}>
                        <CompanyLogo logoUrl={co.company_logo_url} alt={co.company_name} className="w-full h-full" />
                      </div>
                      <div>
                        <h1 style={{ fontSize: '16px', fontWeight: 'bold', marginBottom: '5px' }}>{co.company_name}</h1>
                        {co.company_address && <p style={{ fontSize: '11px', margin: '2px 0' }}>{co.company_address}</p>}
                        {co.company_phone && <p style={{ fontSize: '11px', margin: '2px 0' }}>Telp: {co.company_phone}</p>}
                        {co.company_tax_id && <p style={{ fontSize: '11px', margin: '2px 0' }}>NPWP: {co.company_tax_id}</p>}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Document Title */}
                <div style={{ textAlign: 'center', marginBottom: '20px' }}>
                  <h2 style={{ fontSize: '18px', fontWeight: 'bold', marginBottom: '5px' }}>
                    STATEMENT OF ACCOUNT
                  </h2>
                  <p style={{ fontSize: '12px', color: '#666' }}>
                    Period: {new Date(globalDateRange.startDate).toLocaleDateString('id-ID')} to {new Date(globalDateRange.endDate).toLocaleDateString('id-ID')}
                  </p>
                </div>

                {/* Party Details */}
                <div style={{ marginBottom: '20px', padding: '12px', backgroundColor: '#f3f4f6', borderRadius: '8px' }}>
                  <p style={{ fontSize: '13px', fontWeight: 'bold', marginBottom: '5px' }}>
                    {partyType === 'customer' ? 'Customer:' : partyType === 'supplier' ? 'Supplier:' : 'Staff:'} {selectedPartyData.name}
                  </p>
                  {selectedPartyData.address && (
                    <p style={{ fontSize: '11px', margin: '2px 0' }}>{selectedPartyData.address}</p>
                  )}
                  {selectedPartyData.city && (
                    <p style={{ fontSize: '11px', margin: '2px 0' }}>{selectedPartyData.city}</p>
                  )}
                  {selectedPartyData.phone && (
                    <p style={{ fontSize: '11px', margin: '2px 0' }}>Phone: {selectedPartyData.phone}</p>
                  )}
                  {selectedPartyData.npwp && (
                    <p style={{ fontSize: '11px', margin: '2px 0' }}>NPWP: {selectedPartyData.npwp}</p>
                  )}
                </div>

                {/* Summary */}
                <div style={{ marginBottom: '15px', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px' }}>
                  <div style={{ padding: '10px', backgroundColor: '#eff6ff', borderRadius: '6px' }}>
                    <p style={{ fontSize: '10px', fontWeight: '600', color: '#666', marginBottom: '3px' }}>OPENING BALANCE</p>
                    <p style={{ fontSize: '13px', fontWeight: 'bold' }}>{formatBalance(openingBalance)}</p>
                  </div>
                  <div style={{ padding: '10px', backgroundColor: '#fef2f2', borderRadius: '6px' }}>
                    <p style={{ fontSize: '10px', fontWeight: '600', color: '#666', marginBottom: '3px' }}>TOTAL DEBIT</p>
                    <p style={{ fontSize: '13px', fontWeight: 'bold', color: '#dc2626' }}>{formatAmount(totalDebit)}</p>
                  </div>
                  <div style={{ padding: '10px', backgroundColor: '#f0fdf4', borderRadius: '6px' }}>
                    <p style={{ fontSize: '10px', fontWeight: '600', color: '#666', marginBottom: '3px' }}>TOTAL CREDIT</p>
                    <p style={{ fontSize: '13px', fontWeight: 'bold', color: '#16a34a' }}>{formatAmount(totalCredit)}</p>
                  </div>
                  <div style={{ padding: '10px', backgroundColor: '#fff7ed', borderRadius: '6px' }}>
                    <p style={{ fontSize: '10px', fontWeight: '600', color: '#666', marginBottom: '3px' }}>OUTSTANDING</p>
                    <p style={{ fontSize: '13px', fontWeight: 'bold', color: '#ea580c' }}>{formatAmount(outstanding)}</p>
                  </div>
                </div>

                {/* Ledger Table */}
                <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '20px' }}>
                  <thead>
                    <tr style={{ backgroundColor: '#f9fafb', borderBottom: '2px solid #000' }}>
                      <th style={{ padding: '8px', textAlign: 'left', fontSize: '10px', fontWeight: '600', borderRight: '1px solid #e5e7eb' }}>Date</th>
                      <th style={{ padding: '8px', textAlign: 'left', fontSize: '10px', fontWeight: '600', borderRight: '1px solid #e5e7eb' }}>Particulars</th>
                      <th style={{ padding: '8px', textAlign: 'left', fontSize: '10px', fontWeight: '600', borderRight: '1px solid #e5e7eb' }}>Ref No</th>
                      <th style={{ padding: '8px', textAlign: 'right', fontSize: '10px', fontWeight: '600', borderRight: '1px solid #e5e7eb' }}>Debit (Dr)</th>
                      <th style={{ padding: '8px', textAlign: 'right', fontSize: '10px', fontWeight: '600', borderRight: '1px solid #e5e7eb' }}>Credit (Cr)</th>
                      <th style={{ padding: '8px', textAlign: 'right', fontSize: '10px', fontWeight: '600' }}>Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr style={{ backgroundColor: '#eff6ff', borderBottom: '1px solid #e5e7eb' }}>
                      <td colSpan={3} style={{ padding: '6px 8px', fontSize: '11px', fontWeight: '600' }}>Opening Balance</td>
                      <td style={{ padding: '6px 8px', textAlign: 'right', fontSize: '11px' }}>-</td>
                      <td style={{ padding: '6px 8px', textAlign: 'right', fontSize: '11px' }}>-</td>
                      <td style={{ padding: '6px 8px', textAlign: 'right', fontSize: '11px', fontWeight: 'bold' }}>{formatBalance(openingBalance)}</td>
                    </tr>
                    {ledgerEntries.map(entry => (
                      <tr key={entry.id} style={{ borderBottom: '1px solid #e5e7eb' }}>
                        <td style={{ padding: '6px 8px', fontSize: '10px' }}>{new Date(entry.entry_date).toLocaleDateString('id-ID')}</td>
                        <td style={{ padding: '6px 8px', fontSize: '10px' }}>{entry.particulars}</td>
                        <td style={{ padding: '6px 8px', fontSize: '10px', fontFamily: 'monospace' }}>{entry.reference}</td>
                        <td style={{ padding: '6px 8px', textAlign: 'right', fontSize: '10px', color: entry.debit > 0 ? '#dc2626' : '#000' }}>
                          {entry.debit > 0 ? formatAmount(entry.debit) : '-'}
                        </td>
                        <td style={{ padding: '6px 8px', textAlign: 'right', fontSize: '10px', color: entry.credit > 0 ? '#16a34a' : '#000' }}>
                          {entry.credit > 0 ? formatAmount(entry.credit) : '-'}
                        </td>
                        <td style={{ padding: '6px 8px', textAlign: 'right', fontSize: '10px', fontWeight: '600' }}>{formatBalance(entry.running_balance)}</td>
                      </tr>
                    ))}
                    <tr style={{ backgroundColor: '#f3f4f6', borderTop: '2px solid #000', borderBottom: '2px solid #000' }}>
                      <td colSpan={3} style={{ padding: '8px', fontSize: '11px', fontWeight: 'bold' }}>Closing Balance</td>
                      <td style={{ padding: '8px', textAlign: 'right', fontSize: '11px', fontWeight: 'bold', color: '#dc2626' }}>{formatAmount(totalDebit)}</td>
                      <td style={{ padding: '8px', textAlign: 'right', fontSize: '11px', fontWeight: 'bold', color: '#16a34a' }}>{formatAmount(totalCredit)}</td>
                      <td style={{ padding: '8px', textAlign: 'right', fontSize: '11px', fontWeight: 'bold' }}>{formatBalance(closingBalance)}</td>
                    </tr>
                  </tbody>
                </table>

                {/* Footer Note */}
                <div style={{ marginTop: '30px', padding: '12px', backgroundColor: '#f9fafb', borderRadius: '8px' }}>
                  <p style={{ fontSize: '11px', color: '#666', marginBottom: '8px' }}>
                    <strong>Note:</strong> This is a computer-generated statement of account.
                  </p>
                  <p style={{ fontSize: '11px', color: '#666' }}>
                    Please review the above transactions and confirm. If you have any questions or discrepancies, please contact us immediately.
                  </p>
                </div>

                {/* Footer */}
                <div style={{ marginTop: '20px', textAlign: 'center', borderTop: '1px solid #e5e7eb', paddingTop: '10px' }}>
                  <p style={{ fontSize: '10px', color: '#999' }}>Generated on {new Date().toLocaleString('id-ID')}</p>
                  <p style={{ fontSize: '10px', color: '#999' }}>{co.company_name}</p>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
