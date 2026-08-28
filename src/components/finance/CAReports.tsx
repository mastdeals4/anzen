import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { Download, FileText, TrendingUp, Package, Building2 } from 'lucide-react';
import * as XLSX from 'xlsx';
import { useAuth } from '../../contexts/AuthContext';
import { useFinance } from '../../contexts/FinanceContext';
import { sanitizeCsvCell } from '../../utils/csvSafe';
import { FinancialReports } from './FinancialReports';
import { TaxReportsPanel } from './tax/TaxReportsPanel';

type ReportType =
  | 'coa'
  | 'cash_ledger'
  | 'bank_ledger'
  | 'sales_register'
  | 'purchase_register'
  | 'inventory_movement'
  | 'stock_report'
  | 'journal_register'
  | 'general_ledger'
  | 'trial_balance'
  | 'profit_and_loss'
  | 'balance_sheet'
  | 'tax_compliance'
  | 'fixed_assets';

interface DateRange {
  from: string;
  to: string;
}

interface CAReportsProps {
  onOpenJournal?: (journalEntryId: string) => void;
  onDrillDown?: (code: string, name: string) => void;
}

export function CAReports({ onOpenJournal, onDrillDown }: CAReportsProps) {
  const { profile } = useAuth();
  const { dateRange: contextDateRange } = useFinance();
  const [selectedReport, setSelectedReport] = useState<ReportType>('inventory_movement');
  const [loading, setLoading] = useState(false);
  const [reportData, setReportData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [bankAccounts, setBankAccounts] = useState<any[]>([]);
  const [selectedBankAccount, setSelectedBankAccount] = useState<string>('');

  // Use date range from context (master date picker)
  const dateRange: DateRange = {
    from: contextDateRange.startDate,
    to: contextDateRange.endDate
  };

  const reports = [
    { id: 'coa' as const, name: 'Chart of Accounts', icon: FileText, description: 'Complete COA list' },
    { id: 'cash_ledger' as const, name: 'Cash Ledger', icon: FileText, description: 'Cash on Hand & Petty Cash' },
    { id: 'bank_ledger' as const, name: 'Bank Ledger', icon: Building2, description: 'All bank accounts' },
    { id: 'sales_register' as const, name: 'Sales Register', icon: TrendingUp, description: 'All sales invoices' },
    { id: 'purchase_register' as const, name: 'Purchase Register', icon: FileText, description: 'All purchase invoices' },
    { id: 'inventory_movement' as const, name: 'Inventory Movement', icon: Package, description: 'Stock Opening + In + Out + Closing', highlight: true },
    { id: 'stock_report' as const, name: 'Stock Report', icon: Package, description: 'Current stock quantity and inventory valuation', highlight: true },
    { id: 'journal_register' as const, name: 'Journal Register', icon: FileText, description: 'All journal entries' },
    { id: 'general_ledger' as const, name: 'General Ledger', icon: FileText, description: 'All account ledgers combined' },
    { id: 'trial_balance' as const, name: 'Trial Balance', icon: FileText, description: 'Debit/Credit summary' },
    { id: 'profit_and_loss' as const, name: 'Profit & Loss', icon: TrendingUp, description: 'Canonical journal-native P&L' },
    { id: 'balance_sheet' as const, name: 'Balance Sheet', icon: Building2, description: 'Canonical journal-native balance sheet' },
    { id: 'tax_compliance' as const, name: 'Tax Reports', icon: FileText, description: 'Canonical PPN, PPh, payments, Faktur and audit exports' },
    { id: 'fixed_assets' as const, name: 'Fixed Asset Register', icon: Building2, description: 'Assets with depreciation' }
  ];

  useEffect(() => {
    loadBankAccounts();
  }, []);

  useEffect(() => {
    if (selectedReport) {
      loadReportData();
    }
  }, [selectedReport, contextDateRange.startDate, contextDateRange.endDate, selectedBankAccount]);

  const loadBankAccounts = async () => {
    const { data, error } = await supabase
      .from('bank_accounts')
      .select('id, bank_name, account_number, currency, coa_id')
      .order('bank_name');

    if (!error && data) {
      setBankAccounts(data);
    }
  };

  const loadReportData = async () => {
    if (selectedReport === 'trial_balance' || selectedReport === 'profit_and_loss' || selectedReport === 'balance_sheet' || selectedReport === 'tax_compliance') {
      setReportData(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      let data = null;

      switch (selectedReport) {
        case 'coa':
          data = await loadChartOfAccounts();
          break;
        case 'cash_ledger':
          data = await loadCashLedger();
          break;
        case 'bank_ledger':
          data = await loadBankLedger();
          break;
        case 'sales_register':
          data = await loadSalesRegister();
          break;
        case 'purchase_register':
          data = await loadPurchaseRegister();
          break;
        case 'inventory_movement':
          data = await loadInventoryMovement();
          break;
        case 'stock_report':
          data = await loadStockReport();
          break;
        case 'journal_register':
          data = await loadJournalRegister();
          break;
        case 'general_ledger':
          data = await loadGeneralLedger();
          break;
        case 'fixed_assets':
          data = await loadFixedAssets();
          break;
      }

      setReportData(data);
    } catch (error) {
      console.error('Error loading report:', error);
      setError((error as any).message || 'Failed to load report');
    } finally {
      setLoading(false);
    }
  };

  const loadChartOfAccounts = async () => {
    const { data, error } = await supabase
      .from('chart_of_accounts')
      .select('code, name, account_type')
      .order('code');

    if (error) throw error;
    return data || [];
  };

  const loadCashLedger = async () => {
    const { data: cashAccounts } = await supabase
      .from('chart_of_accounts')
      .select('id, code, name')
      .in('code', ['1101', '1102']);

    if (!cashAccounts || cashAccounts.length === 0) return [];

    const accountIds = cashAccounts.map(a => a.id);
    const accountMap = new Map(cashAccounts.map(a => [a.id, a]));

    const { data: lines, error } = await supabase.rpc('ca_report_journal_lines', {
      p_date_from: dateRange.from,
      p_date_to: dateRange.to,
      p_account_ids: accountIds
    });

    if (error) throw error;

    return (lines || []).map((line: any) => ({
      journal_entry_id: line.journal_entry_id,
      date: line.entry_date,
      voucher_no: line.entry_number,
      account_name: accountMap.get(line.line_account_id)?.name,
      debit: line.debit,
      credit: line.credit,
      narration: line.line_description
    }));
  };

  const loadBankLedger = async () => {
    let accountIds: string[] = [];

    if (selectedBankAccount) {
      const selectedBank = bankAccounts.find(b => b.id === selectedBankAccount);
      if (selectedBank && selectedBank.coa_id) {
        accountIds = [selectedBank.coa_id];
      }
    } else {
      const { data: mappedBankAccounts, error: bankMappingError } = await supabase
        .from('bank_accounts')
        .select('coa_id')
        .eq('is_active', true)
        .not('coa_id', 'is', null);

      if (bankMappingError) throw bankMappingError;
      accountIds = Array.from(new Set((mappedBankAccounts || [])
        .map(account => account.coa_id)
        .filter((coaId): coaId is string => Boolean(coaId))));
      if (accountIds.length === 0) return [];
    }

    if (accountIds.length === 0) return [];

    const { data: coaAccounts } = await supabase
      .from('chart_of_accounts')
      .select('id, name')
      .in('id', accountIds);

    const accountMap = new Map(coaAccounts?.map(a => [a.id, a]) || []);

    const { data: lines, error } = await supabase.rpc('ca_report_journal_lines', {
      p_date_from: '2025-01-01',
      p_date_to: dateRange.to,
      p_account_ids: accountIds
    });

    if (error) throw error;
    const journalIds = Array.from(new Set((lines || []).map((line: any) => line.journal_entry_id).filter(Boolean)));
    const { data: allocations, error: allocationError } = journalIds.length
      ? await supabase.from('bank_statement_allocations')
          .select('journal_entry_id, bank_statement_line_id, allocation_amount')
          .in('journal_entry_id', journalIds)
      : { data: [], error: null };
    if (allocationError) throw allocationError;
    const statementIds = Array.from(new Set((allocations || []).map((a: any) => a.bank_statement_line_id).filter(Boolean)));
    const { data: statements, error: statementError } = statementIds.length
      ? await supabase.from('bank_statement_lines').select('id, transaction_date, transaction_hash, debit_amount, credit_amount').in('id', statementIds)
      : { data: [], error: null };
    if (statementError) throw statementError;
    const statementMap = new Map((statements || []).map((s: any) => [s.id, s]));
    const reportingDates = new Map<string, string>();
    const canonicalMovement = new Map<string, { debit: number; credit: number }>();
    (allocations || []).forEach((allocation: any) => {
      const statement = statementMap.get(allocation.bank_statement_line_id);
      const date = statement?.transaction_date;
      if (!date) return;
      const current = reportingDates.get(allocation.journal_entry_id);
      if (!current || date < current) reportingDates.set(allocation.journal_entry_id, date);
      const amount = Number(allocation.allocation_amount || 0);
      const statementTotal = Number(statement?.debit_amount || statement?.credit_amount || 0);
      const signed = statement?.credit_amount > 0 ? amount : -amount;
      const movement = canonicalMovement.get(allocation.journal_entry_id) || { debit: 0, credit: 0 };
      if (signed >= 0) movement.credit += Math.min(amount, statementTotal);
      else movement.debit += Math.min(amount, statementTotal);
      canonicalMovement.set(allocation.journal_entry_id, movement);
    });

    const emittedCanonical = new Set<string>();
    return (lines || []).filter((line: any) => {
      const reportDate = reportingDates.get(line.journal_entry_id) || line.entry_date;
      return reportDate >= dateRange.from && reportDate <= dateRange.to;
    }).map((line: any) => {
      const reportDate = reportingDates.get(line.journal_entry_id) || line.entry_date;
      const canonical = canonicalMovement.get(line.journal_entry_id);
      const isFirstCanonicalLine = canonical && !emittedCanonical.has(line.journal_entry_id);
      if (isFirstCanonicalLine) emittedCanonical.add(line.journal_entry_id);
      return {
      journal_entry_id: line.journal_entry_id,
      date: reportDate,
      voucher_no: line.entry_number,
      account_name: accountMap.get(line.line_account_id)?.name,
      debit: isFirstCanonicalLine ? canonical.debit : (canonical ? 0 : line.debit),
      credit: isFirstCanonicalLine ? canonical.credit : (canonical ? 0 : line.credit),
      narration: line.line_description || line.reference_number || '',
      canonical_statement_date: reportingDates.get(line.journal_entry_id) || null,
      reconciliation_status: reportingDates.has(line.journal_entry_id) ? 'allocated' : 'unallocated'
    };
    });
  };

  const loadSalesRegister = async () => {
    const { data, error } = await supabase
      .from('sales_invoices')
      .select(`
        id,
        invoice_number,
        invoice_date,
        due_date,
        customer_id,
        subtotal,
        tax_amount,
        stamp_duty_amount,
        total_amount,
        payment_status,
        customers(company_name)
      `)
      .gte('invoice_date', dateRange.from)
      .lte('invoice_date', dateRange.to)
      .order('invoice_date', { ascending: true });

    if (error) throw error;

    // Bulk fetch payment dates: replicate get_invoice_latest_payment_date =
    // MAX(receipt_vouchers.voucher_date) for voucher_allocations where sales_invoice_id in (...) AND voucher_type='receipt'.
    const invoiceIds = (data || []).map((inv) => inv.id);
    const latestByInvoice = new Map<string, string>();
    if (invoiceIds.length > 0) {
      const CHUNK = 50;
      const allAllocs: any[] = [];
      for (let i = 0; i < invoiceIds.length; i += CHUNK) {
        const chunk = invoiceIds.slice(i, i + CHUNK);
        const { data: allocs } = await supabase
          .from('voucher_allocations')
          .select('sales_invoice_id, receipt_vouchers(voucher_date)')
          .in('sales_invoice_id', chunk)
          .eq('voucher_type', 'receipt');
        if (allocs) allAllocs.push(...allocs);
      }
      for (const a of allAllocs) {
        const d = a.receipt_vouchers?.voucher_date;
        if (!d) continue;
        const prev = latestByInvoice.get(a.sales_invoice_id);
        if (!prev || d > prev) {
          latestByInvoice.set(a.sales_invoice_id, d);
        }
      }
    }

    const invoicesWithPaymentData = (data || []).map((inv) => ({
      invoice_date: inv.invoice_date,
      invoice_number: inv.invoice_number,
      customer_name: (inv.customers as any)?.company_name,
      due_date: inv.due_date,
      payment_receipt: latestByInvoice.get(inv.id) || null,
      payment_status: inv.payment_status,
      net_amount: inv.subtotal,
      ppn: inv.tax_amount,
      total_amount: inv.total_amount,
      stamp_duty: inv.stamp_duty_amount,
    }));

    return invoicesWithPaymentData;
  };

  const loadPurchaseRegister = async () => {
    const { data, error } = await supabase
      .from('purchase_invoices')
      .select(`
        invoice_number,
        invoice_date,
        supplier_id,
        subtotal,
        tax_amount,
        stamp_duty_amount,
        total_amount,
        currency,
        suppliers(company_name)
      `)
      .gte('invoice_date', dateRange.from)
      .lte('invoice_date', dateRange.to)
      .order('invoice_date', { ascending: true });

    if (error) throw error;

    return data?.map(po => ({
      invoice_date: po.invoice_date,
      invoice_number: po.invoice_number,
      supplier_name: (po.suppliers as any)?.company_name,
      net_amount: po.subtotal,
      ppn: po.tax_amount,
      total_amount: po.total_amount,
      stamp_duty: po.stamp_duty_amount,
      currency: po.currency
    })) || [];
  };

  const loadInventoryMovement = async () => {
    const { data, error } = await supabase.rpc(
      'inventory_v1_movement_report',
      {
        p_date_from: dateRange.from,
        p_date_to: dateRange.to,
      },
    );

    if (error) throw error;
    return data || [];
  };

  const loadStockReport = async () => {
    const { data, error } = await supabase
      .from('batches')
      .select('product_id, current_stock, landed_cost_per_unit, cost_per_unit, import_price, products(product_code, product_name, category, unit)')
      .eq('is_active', true)
      .gt('current_stock', 0);
    if (error) throw error;
    const grouped = new Map<string, any>();
    (data || []).forEach((batch: any) => {
      const p = Array.isArray(batch.products) ? batch.products[0] : batch.products;
      const qty = Number(batch.current_stock || 0);
      const cost = Number(batch.landed_cost_per_unit ?? batch.cost_per_unit ?? batch.import_price ?? 0);
      const row = grouped.get(batch.product_id) || { product_id: batch.product_id, product_code: p?.product_code || '', product_name: p?.product_name || '', category: p?.category || '', unit: p?.unit || '', quantity_on_hand: 0, stock_value: 0 };
      row.quantity_on_hand += qty; row.stock_value += qty * cost; grouped.set(batch.product_id, row);
    });
    return [...grouped.values()].map(r => ({ ...r, average_landed_cost: r.quantity_on_hand ? r.stock_value / r.quantity_on_hand : 0 }));
  };

  const loadJournalRegister = async () => {
    const { data: lines, error } = await supabase.rpc('ca_report_journal_lines', {
      p_date_from: dateRange.from,
      p_date_to: dateRange.to,
      p_account_ids: null
    });

    if (error) throw error;
    if (!lines || lines.length === 0) return [];

    const { data: accounts } = await supabase
      .from('chart_of_accounts')
      .select('id, code, name');

    const accountMap = new Map(accounts?.map(a => [a.id, a]) || []);

    return lines.map((line: any) => {
      const account = accountMap.get(line.line_account_id);
      return {
        journal_entry_id: line.journal_entry_id,
        entry_date: line.entry_date,
        entry_number: line.entry_number,
        voucher_type: line.source_module,
        account_code: account?.code,
        account_name: account?.name,
        debit: line.debit,
        credit: line.credit,
        narration: line.line_description || line.entry_description
      };
    });
  };

  const loadGeneralLedger = async () => {
    const { data: lines, error } = await supabase.rpc('ca_report_journal_lines', {
      p_date_from: dateRange.from,
      p_date_to: dateRange.to,
      p_account_ids: null
    });

    if (error) throw error;
    if (!lines || lines.length === 0) return [];

    const { data: accounts } = await supabase
      .from('chart_of_accounts')
      .select('id, code, name, account_type');

    const accountMap = new Map(accounts?.map(a => [a.id, a]) || []);

    const result = lines.map((line: any) => {
      const account = accountMap.get(line.line_account_id);
      return {
        journal_entry_id: line.journal_entry_id,
        account_code: account?.code,
        account_name: account?.name,
        entry_date: line.entry_date,
        voucher_number: line.entry_number,
        debit: line.debit,
        credit: line.credit,
        description: line.line_description
      };
    });

    return result.sort((a: any, b: any) => {
      if (a.account_code !== b.account_code) {
        return (a.account_code || '').localeCompare(b.account_code || '');
      }
      return (a.entry_date || '').localeCompare(b.entry_date || '');
    });
  };

  const loadFixedAssets = async () => {
    // Fixed asset accounts live under 1200–1399:
    //   asset accounts (1201, 1203, 1210…) carry cost as debits
    //   contra accounts (1202, 1211…) carry accumulated depreciation as credits
    const { data: coaRows, error: coaErr } = await supabase
      .from('chart_of_accounts')
      .select('id, code, name, account_type')
      .gte('code', '1200')
      .lt('code', '1400')
      .not('code', 'eq', '1200')
      .order('code');

    if (coaErr) throw coaErr;
    if (!coaRows || coaRows.length === 0) return [];

    const assetIds = coaRows.map(a => a.id);

    // Fetch all posted journal lines for these accounts (no date filter — fixed assets are cumulative)
    const { data: lines, error: lineErr } = await supabase.rpc('ca_report_journal_lines', {
      p_date_from: '2000-01-01',
      p_date_to: dateRange.to,
      p_account_ids: assetIds
    });

    if (lineErr) throw lineErr;

    // Aggregate by account
    const balances = new Map<string, { debit: number; credit: number; first_date: string }>();
    for (const line of (lines || []) as any[]) {
      const prev = balances.get(line.line_account_id) || { debit: 0, credit: 0, first_date: line.entry_date };
      balances.set(line.line_account_id, {
        debit: prev.debit + parseFloat(line.debit || 0),
        credit: prev.credit + parseFloat(line.credit || 0),
        first_date: line.entry_date < prev.first_date ? line.entry_date : prev.first_date
      });
    }

    // Build a paired list: for each asset account find its contra (next code ending in 2)
    const assetRows = coaRows.filter(r => r.account_type === 'asset');
    const contraRows = coaRows.filter(r => r.account_type === 'contra');

    // Map contra by name heuristic: "Accumulated Depreciation - X" pairs with asset "X"
    const contraByAssetId = new Map<string, typeof coaRows[0]>();
    for (const contra of contraRows) {
      const stripped = contra.name.replace(/accumulated depreciation\s*[-–]\s*/i, '').toLowerCase().trim();
      const matched = assetRows.find(a => a.name.toLowerCase().trim() === stripped);
      if (matched) contraByAssetId.set(matched.id, contra);
    }

    const result = assetRows.map(asset => {
      const assetBal = balances.get(asset.id);
      const contra = contraByAssetId.get(asset.id);
      const contraBal = contra ? balances.get(contra.id) : null;

      const cost = assetBal ? (assetBal.debit - assetBal.credit) : 0;
      const accDep = contraBal ? (contraBal.credit - contraBal.debit) : 0;
      const nbv = cost - accDep;

      return {
        asset_code: asset.code,
        asset_name: asset.name,
        acquisition_date: assetBal?.first_date || '',
        cost,
        accumulated_depreciation: accDep,
        net_book_value: nbv
      };
    });

    // Only return assets that have any cost recorded, or all if none do (so list isn't empty)
    const withData = result.filter(r => r.cost !== 0);
    return withData.length > 0 ? withData : result;
  };

  const exportToExcel = async () => {
    if (!reportData || reportData.length === 0) {
      alert('No data to export');
      return;
    }

    const { data: settings } = await supabase
      .from('app_settings')
      .select('company_name')
      .limit(1)
      .maybeSingle();

    const companyName = settings?.company_name || 'Your Company Name';

    let worksheetData: any[] = [];
    let filename = '';
    let reportTitle = '';
    let hasDateRange = false;

    switch (selectedReport) {
      case 'coa':
        reportTitle = 'CHART OF ACCOUNTS';
        worksheetData = reportData.map((row: any) => ({
          'Account Code': row.code,
          'Account Name': row.name,
          'Account Type': row.account_type
        }));
        filename = 'Chart_of_Accounts.xlsx';
        break;

      case 'inventory_movement':
        reportTitle = 'INVENTORY MOVEMENT REPORT';
        hasDateRange = true;
        worksheetData = reportData.map((row: any) => ({
          'Product Code': row.product_code,
          'Product Name': row.product_name,
          'Unit': row.unit,
          'Opening Qty': row.opening,
          'Qty In': row.in_qty,
          'Qty Out': row.out_qty,
          'Closing Qty': row.closing,
          'Reserved Qty': row.reserved_qty
        }));
        filename = `Inventory_Movement_${dateRange.from}_to_${dateRange.to}.xlsx`;
        break;
      case 'stock_report':
        reportTitle = 'STOCK VALUATION REPORT';
        worksheetData = reportData.map((row: any) => ({ 'Product Code': row.product_code, 'Product Name': row.product_name, Category: row.category, Unit: row.unit, 'Quantity on Hand': row.quantity_on_hand, 'Landed Cost per Unit': row.average_landed_cost, 'Stock Value (IDR)': row.stock_value }));
        worksheetData.push({ 'Product Code': '', 'Product Name': 'TOTAL', 'Quantity on Hand': worksheetData.reduce((s: number, r: any) => s + Number(r['Quantity on Hand'] || 0), 0), 'Stock Value (IDR)': worksheetData.reduce((s: number, r: any) => s + Number(r['Stock Value (IDR)'] || 0), 0) });
        filename = `Stock_Report_As_Of_${dateRange.to}.xlsx`;
        break;

      case 'sales_register':
        reportTitle = 'SALES REGISTER';
        hasDateRange = true;
        worksheetData = reportData.map((row: any) => ({
          'Date': row.invoice_date,
          'Invoice No': row.invoice_number,
          'Customer': row.customer_name,
          'Due Date': row.payment_status === 'paid' ? '-' : row.due_date,
          'Payment Receipt': row.payment_receipt || '-',
          'Net Amount': row.net_amount,
          'PPN': row.ppn,
          'Stamp Duty': Number(row.stamp_duty || 0),
          'Total': row.total_amount
        }));
        filename = `Sales_Register_${dateRange.from}_to_${dateRange.to}.xlsx`;
        break;

      case 'purchase_register':
        reportTitle = 'PURCHASE REGISTER';
        hasDateRange = true;
        worksheetData = reportData.map((row: any) => ({
          'Date': row.invoice_date,
          'Invoice Number': row.invoice_number,
          'Supplier': row.supplier_name,
          'Net Amount': row.net_amount,
          'PPN': row.ppn,
          'Stamp Duty': Number(row.stamp_duty || 0),
          'Total': row.total_amount,
          'Currency': row.currency
        }));
        filename = `Purchase_Register_${dateRange.from}_to_${dateRange.to}.xlsx`;
        break;

      case 'journal_register':
        reportTitle = 'JOURNAL REGISTER';
        hasDateRange = true;
        worksheetData = reportData.map((row: any) => ({
          'Date': row.entry_date,
          'Entry No': row.entry_number,
          'Voucher Type': row.voucher_type,
          'Account Code': row.account_code,
          'Account Name': row.account_name,
          'Currency': 'IDR',
          'Debit': row.debit,
          'Credit': row.credit,
          'Narration': row.narration
        }));
        filename = `Journal_Register_${dateRange.from}_to_${dateRange.to}.xlsx`;
        break;

      case 'general_ledger':
        reportTitle = 'GENERAL LEDGER';
        hasDateRange = true;
        worksheetData = reportData.map((row: any) => ({
          'Account Code': row.account_code,
          'Account Name': row.account_name,
          'Date': row.entry_date,
          'Voucher No': row.voucher_number,
          'Currency': 'IDR',
          'Debit': row.debit,
          'Credit': row.credit,
          'Description': row.description
        }));
        filename = `General_Ledger_${dateRange.from}_to_${dateRange.to}.xlsx`;
        break;

      case 'trial_balance':
        reportTitle = 'TRIAL BALANCE';
        hasDateRange = true;
        worksheetData = reportData.map((row: any) => ({
          'Account Code': row.code,
          'Account Name': row.name,
          'Debit': row.debit,
          'Credit': row.credit
        }));
        filename = `Trial_Balance_${dateRange.from}_to_${dateRange.to}.xlsx`;
        break;

      case 'cash_ledger':
        reportTitle = 'CASH LEDGER';
        hasDateRange = true;
        worksheetData = reportData.map((row: any) => ({
          'Date': row.date,
          'Voucher No': row.voucher_no,
          'Account': row.account_name,
          'Debit': row.debit,
          'Credit': row.credit,
          'Narration': row.narration
        }));
        filename = `Cash_Ledger_${dateRange.from}_to_${dateRange.to}.xlsx`;
        break;

      case 'bank_ledger':
        reportTitle = 'BANK LEDGER';
        hasDateRange = true;
        worksheetData = reportData.map((row: any) => ({
          'Date': row.date,
          'Voucher No': row.voucher_no,
          'Bank Account': row.account_name,
          'Currency': row.currency || 'IDR',
          'Debit': row.debit,
          'Credit': row.credit,
          'Narration': row.narration
        }));
        filename = `Bank_Ledger_${dateRange.from}_to_${dateRange.to}.xlsx`;
        break;

      case 'fixed_assets':
        reportTitle = 'FIXED ASSET REGISTER';
        worksheetData = reportData.map((row: any) => ({
          'Asset Code': row.asset_code,
          'Asset Name': row.asset_name,
          'Acquisition Date': row.acquisition_date,
          'Cost': row.cost,
          'Accumulated Depreciation': row.accumulated_depreciation,
          'Net Book Value': row.net_book_value
        }));
        filename = 'Fixed_Asset_Register.xlsx';
        break;
    }

    const headerRows: any[][] = [
      [companyName],
      [reportTitle]
    ];

    if (hasDateRange) {
      const formattedFromDate = new Date(dateRange.from).toLocaleDateString('en-GB');
      const formattedToDate = new Date(dateRange.to).toLocaleDateString('en-GB');
      headerRows.push([`Period: ${formattedFromDate} to ${formattedToDate}`]);
    }

    headerRows.push([]);

    const dataKeys = Object.keys(worksheetData[0] || {});
    const dataRows = worksheetData.map(row => dataKeys.map(key => row[key]));

    const finalData = [
      ...headerRows,
      dataKeys,
      ...dataRows
    ];

    const worksheet = XLSX.utils.aoa_to_sheet(finalData.map(row => row.map(sanitizeCsvCell)));

    worksheet['!cols'] = dataKeys.map(() => ({ wch: 15 }));

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Report');
    XLSX.writeFile(workbook, filename);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-slate-900">CA Reports - Tax Consultant Excel Exports</h2>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {reports.map((report) => {
          const Icon = report.icon;
          return (
            <button
              key={report.id}
              onClick={() => setSelectedReport(report.id)}
              className={`finance-card-button p-3 rounded border text-left transition-all ${
                selectedReport === report.id
                  ? 'border-emerald-500 bg-emerald-50'
                  : report.highlight
                  ? 'border-amber-500 bg-amber-50 hover:border-amber-600'
                  : 'border-slate-200 bg-white hover:border-slate-300'
              }`}
            >
              <Icon className={`w-6 h-6 mb-2 ${
                selectedReport === report.id
                  ? 'text-emerald-600'
                  : report.highlight
                  ? 'text-amber-600'
                  : 'text-slate-600'
              }`} />
              <h3 className="font-semibold text-sm text-slate-900">{report.name}</h3>
              <p className="text-xs text-slate-500 mt-1">{report.description}</p>
            </button>
          );
        })}
      </div>

      {selectedReport === 'trial_balance' && <FinancialReports initialReport="trial_balance" onDrillDown={onDrillDown} />}
      {selectedReport === 'profit_and_loss' && <FinancialReports initialReport="pnl" onDrillDown={onDrillDown} />}
      {selectedReport === 'balance_sheet' && <FinancialReports initialReport="balance_sheet" onDrillDown={onDrillDown} />}
      {selectedReport === 'tax_compliance' && <TaxReportsPanel />}

      {!['trial_balance', 'profit_and_loss', 'balance_sheet', 'tax_compliance'].includes(selectedReport) && <div className="bg-white rounded-lg border border-slate-200 p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-slate-900">
            {reports.find(r => r.id === selectedReport)?.name}
          </h3>
          <button
            onClick={exportToExcel}
            disabled={loading || !reportData || reportData.length === 0}
            className="px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            <Download className="w-4 h-4" />
            Export to Excel
          </button>
        </div>

        {selectedReport === 'bank_ledger' && (
          <div className="mb-4 flex items-center gap-2">
            <label className="text-sm font-medium text-slate-700">Bank Account:</label>
            <select
              value={selectedBankAccount}
              onChange={(e) => setSelectedBankAccount(e.target.value)}
              className="px-1.5 py-1 border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
            >
              <option value="">All Bank Accounts</option>
              {bankAccounts.map((bank) => (
                <option key={bank.id} value={bank.id}>
                  {bank.bank_name} - {bank.account_number} ({bank.currency})
                </option>
              ))}
            </select>
          </div>
        )}

        {loading ? (
          <div className="text-center py-12 text-slate-500">Loading report...</div>
        ) : error ? (
          <div className="text-center py-12">
            <div className="text-red-600 font-semibold mb-2">Error Loading Report</div>
            <div className="text-slate-600">{error}</div>
            <button
              onClick={loadReportData}
              className="mt-4 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              Retry
            </button>
          </div>
        ) : !reportData || reportData.length === 0 ? (
          <div className="text-center py-12 text-slate-500">No data available for selected period</div>
        ) : (
          <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
            <div className="text-sm text-slate-600 mb-2">
              {reportData.length} record(s) found
            </div>
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 sticky top-0">
                <tr>
                  {selectedReport === 'inventory_movement' && (
                    <>
                      <th className="px-1.5 py-1 text-left font-medium text-slate-700">Product Code</th>
                      <th className="px-1.5 py-1 text-left font-medium text-slate-700">Product Name</th>
                      <th className="px-1.5 py-1 text-left font-medium text-slate-700">Unit</th>
                      <th className="px-1.5 py-1 text-right font-medium text-slate-700">Opening</th>
                      <th className="px-1.5 py-1 text-right font-medium text-slate-700 bg-green-50">In</th>
                      <th className="px-1.5 py-1 text-right font-medium text-slate-700 bg-red-50">Out</th>
                      <th className="px-1.5 py-1 text-right font-medium text-slate-700 bg-blue-50">Closing</th>
                      <th className="px-1.5 py-1 text-right font-medium text-slate-700 bg-amber-50">Reserved</th>
                    </>
                  )}
                  {selectedReport === 'stock_report' && (<>
                    {['Product Code','Product Name','Category','Unit','Quantity on Hand','Average Landed Cost','Stock Value (IDR)','Reserved Quantity','Available Quantity'].map(h => <th key={h} className="px-1.5 py-1 text-left font-medium text-slate-700">{h}</th>)}
                  </>)}
                  {selectedReport === 'coa' && (
                    <>
                      <th className="px-1.5 py-1 text-left font-medium text-slate-700">Code</th>
                      <th className="px-1.5 py-1 text-left font-medium text-slate-700">Account Name</th>
                      <th className="px-1.5 py-1 text-left font-medium text-slate-700">Type</th>
                    </>
                  )}
                  {selectedReport === 'sales_register' && (
                    <>
                      <th className="px-1.5 py-1 text-left font-medium text-slate-700">Date</th>
                      <th className="px-1.5 py-1 text-left font-medium text-slate-700">Invoice No</th>
                      <th className="px-1.5 py-1 text-left font-medium text-slate-700">Customer</th>
                      <th className="px-1.5 py-1 text-left font-medium text-slate-700">Due Date</th>
                      <th className="px-1.5 py-1 text-left font-medium text-slate-700">Payment Receipt</th>
                      <th className="px-1.5 py-1 text-right font-medium text-slate-700">Net</th>
                      <th className="px-1.5 py-1 text-right font-medium text-slate-700">PPN</th>
                      <th className="px-1.5 py-1 text-right font-medium text-slate-700">Total</th>
                    </>
                  )}
                  {selectedReport === 'purchase_register' && (
                    <>
                      <th className="px-1.5 py-1 text-left font-medium text-slate-700">Date</th>
                      <th className="px-1.5 py-1 text-left font-medium text-slate-700">Invoice No</th>
                      <th className="px-1.5 py-1 text-left font-medium text-slate-700">Supplier</th>
                      <th className="px-1.5 py-1 text-right font-medium text-slate-700">Net</th>
                      <th className="px-1.5 py-1 text-right font-medium text-slate-700">PPN</th>
                      <th className="px-1.5 py-1 text-right font-medium text-slate-700">Total</th>
                      <th className="px-1.5 py-1 text-left font-medium text-slate-700">Currency</th>
                    </>
                  )}
                  {selectedReport === 'cash_ledger' && (
                    <>
                      <th className="px-1.5 py-1 text-left font-medium text-slate-700">Date</th>
                      <th className="px-1.5 py-1 text-left font-medium text-slate-700">Voucher No</th>
                      <th className="px-1.5 py-1 text-left font-medium text-slate-700">Account</th>
                      <th className="px-1.5 py-1 text-right font-medium text-slate-700">Debit</th>
                      <th className="px-1.5 py-1 text-right font-medium text-slate-700">Credit</th>
                      <th className="px-1.5 py-1 text-left font-medium text-slate-700">Narration</th>
                    </>
                  )}
                  {selectedReport === 'bank_ledger' && (
                    <>
                      <th className="px-1.5 py-1 text-left font-medium text-slate-700">Date</th>
                      <th className="px-1.5 py-1 text-left font-medium text-slate-700">Voucher No</th>
                      <th className="px-1.5 py-1 text-left font-medium text-slate-700">Bank Account</th>
                      <th className="px-1.5 py-1 text-right font-medium text-slate-700">Debit</th>
                      <th className="px-1.5 py-1 text-right font-medium text-slate-700">Credit</th>
                      <th className="px-1.5 py-1 text-left font-medium text-slate-700">Narration</th>
                    </>
                  )}
                  {selectedReport === 'journal_register' && (
                    <>
                      <th className="px-1.5 py-1 text-left font-medium text-slate-700">Date</th>
                      <th className="px-1.5 py-1 text-left font-medium text-slate-700">Entry No</th>
                      <th className="px-1.5 py-1 text-left font-medium text-slate-700">Voucher Type</th>
                      <th className="px-1.5 py-1 text-left font-medium text-slate-700">Account Code</th>
                      <th className="px-1.5 py-1 text-left font-medium text-slate-700">Account Name</th>
                      <th className="px-1.5 py-1 text-right font-medium text-slate-700">Debit</th>
                      <th className="px-1.5 py-1 text-right font-medium text-slate-700">Credit</th>
                      <th className="px-1.5 py-1 text-left font-medium text-slate-700">Narration</th>
                    </>
                  )}
                  {selectedReport === 'general_ledger' && (
                    <>
                      <th className="px-1.5 py-1 text-left font-medium text-slate-700">Account Code</th>
                      <th className="px-1.5 py-1 text-left font-medium text-slate-700">Account Name</th>
                      <th className="px-1.5 py-1 text-left font-medium text-slate-700">Date</th>
                      <th className="px-1.5 py-1 text-left font-medium text-slate-700">Voucher No</th>
                      <th className="px-1.5 py-1 text-right font-medium text-slate-700">Debit</th>
                      <th className="px-1.5 py-1 text-right font-medium text-slate-700">Credit</th>
                      <th className="px-1.5 py-1 text-left font-medium text-slate-700">Description</th>
                    </>
                  )}
                  {selectedReport === 'trial_balance' && (
                    <>
                      <th className="px-1.5 py-1 text-left font-medium text-slate-700">Code</th>
                      <th className="px-1.5 py-1 text-left font-medium text-slate-700">Account Name</th>
                      <th className="px-1.5 py-1 text-right font-medium text-slate-700">Debit</th>
                      <th className="px-1.5 py-1 text-right font-medium text-slate-700">Credit</th>
                    </>
                  )}
                  {selectedReport === 'fixed_assets' && (
                    <>
                      <th className="px-1.5 py-1 text-left font-medium text-slate-700">Asset Code</th>
                      <th className="px-1.5 py-1 text-left font-medium text-slate-700">Asset Name</th>
                      <th className="px-1.5 py-1 text-left font-medium text-slate-700">Acquisition Date</th>
                      <th className="px-1.5 py-1 text-right font-medium text-slate-700">Cost</th>
                      <th className="px-1.5 py-1 text-right font-medium text-slate-700">Acc. Depreciation</th>
                      <th className="px-1.5 py-1 text-right font-medium text-slate-700">Net Book Value</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-slate-200">
                {selectedReport === 'inventory_movement' && reportData.slice(0, 200).map((row: any, idx: number) => (
                  <tr key={idx} className={`hover:bg-slate-50 ${row.closing < 0 ? 'bg-red-50' : ''}`}>
                    <td className="px-1.5 py-1 text-slate-900 font-mono text-xs">{row.product_code}</td>
                    <td className="px-1.5 py-1 text-slate-900">{row.product_name}</td>
                    <td className="px-1.5 py-1 text-slate-600">{row.unit}</td>
                    <td className="px-1.5 py-1 text-right text-slate-900">{row.opening % 1 === 0 ? row.opening : parseFloat(row.opening).toFixed(3)}</td>
                    <td className="px-1.5 py-1 text-right text-green-700 font-medium bg-green-50">{row.in_qty % 1 === 0 ? row.in_qty : parseFloat(row.in_qty).toFixed(3)}</td>
                    <td className="px-1.5 py-1 text-right text-red-600 font-medium bg-red-50">{row.out_qty % 1 === 0 ? row.out_qty : parseFloat(row.out_qty).toFixed(3)}</td>
                    <td className={`px-2 py-1.5 text-right font-semibold bg-blue-50 ${row.closing < 0 ? 'text-red-700' : 'text-blue-700'}`}>
                      {row.closing % 1 === 0 ? row.closing : parseFloat(row.closing).toFixed(3)}
                    </td>
                    <td className="px-1.5 py-1 text-right text-amber-700 bg-amber-50">
                      {row.reserved_qty > 0 ? (row.reserved_qty % 1 === 0 ? row.reserved_qty : parseFloat(row.reserved_qty).toFixed(3)) : '-'}
                    </td>
                  </tr>
                ))}
                {selectedReport === 'stock_report' && reportData.map((row: any, idx: number) => (<tr key={idx} className="border-t"><td className="px-1.5 py-1">{row.product_code}</td><td className="px-1.5 py-1">{row.product_name}</td><td className="px-1.5 py-1">{row.category}</td><td className="px-1.5 py-1">{row.unit}</td><td className="px-1.5 py-1 text-right">{Number(row.quantity_on_hand).toFixed(3)}</td><td className="px-1.5 py-1 text-right">{Number(row.average_landed_cost).toLocaleString('id-ID')}</td><td className="px-1.5 py-1 text-right font-semibold">{Number(row.stock_value).toLocaleString('id-ID')}</td></tr>))}
                {selectedReport === 'coa' && reportData.map((row: any, idx: number) => (
                  <tr key={idx} className="hover:bg-slate-50">
                    <td className="px-1.5 py-1 text-slate-900 font-mono">{row.code}</td>
                    <td className="px-1.5 py-1 text-slate-900">{row.name}</td>
                    <td className="px-1.5 py-1 text-slate-600">{row.account_type}</td>
                  </tr>
                ))}
                {selectedReport === 'sales_register' && reportData.slice(0, 100).map((row: any, idx: number) => (
                  <tr key={idx} className="hover:bg-slate-50">
                    <td className="px-1.5 py-1 text-slate-900">{row.invoice_date}</td>
                    <td className="px-1.5 py-1 text-slate-900">{row.invoice_number}</td>
                    <td className="px-1.5 py-1 text-slate-900">{row.customer_name}</td>
                    <td className="px-1.5 py-1">
                      {row.payment_status === 'paid' ? (
                        <span className="text-slate-400">-</span>
                      ) : (
                        <span className={`${new Date(row.due_date) < new Date() ? 'text-red-600 font-medium' : 'text-slate-700'}`}>
                          {row.due_date}
                        </span>
                      )}
                    </td>
                    <td className="px-1.5 py-1">
                      {row.payment_receipt ? (
                        <span className="text-green-600 font-medium">{row.payment_receipt}</span>
                      ) : (
                        <span className="text-slate-400">-</span>
                      )}
                    </td>
                    <td className="px-1.5 py-1 text-right text-slate-900">{parseFloat(row.net_amount || 0).toFixed(2)}</td>
                    <td className="px-1.5 py-1 text-right text-slate-900">{parseFloat(row.ppn || 0).toFixed(2)}</td>
                    <td className="px-1.5 py-1 text-right font-semibold text-slate-900">{parseFloat(row.total_amount || 0).toFixed(2)}</td>
                  </tr>
                ))}
                {selectedReport === 'purchase_register' && reportData.slice(0, 100).map((row: any, idx: number) => (
                  <tr key={idx} className="hover:bg-slate-50">
                    <td className="px-1.5 py-1 text-slate-900">{row.invoice_date}</td>
                    <td className="px-1.5 py-1 text-slate-900">{row.invoice_number}</td>
                    <td className="px-1.5 py-1 text-slate-900">{row.supplier_name}</td>
                    <td className="px-1.5 py-1 text-right text-slate-900">{parseFloat(row.net_amount || 0).toFixed(2)}</td>
                    <td className="px-1.5 py-1 text-right text-slate-900">{parseFloat(row.ppn || 0).toFixed(2)}</td>
                    <td className="px-1.5 py-1 text-right font-semibold text-slate-900">{parseFloat(row.total_amount || 0).toFixed(2)}</td>
                    <td className="px-1.5 py-1 text-slate-600">{row.currency}</td>
                  </tr>
                ))}
                {selectedReport === 'cash_ledger' && reportData.map((row: any, idx: number) => (
                  <tr key={idx} className="hover:bg-slate-50">
                    <td className="px-1.5 py-1 text-slate-900">{row.date}</td>
                    <td className="px-1.5 py-1 text-slate-900">
                      <button type="button" onClick={() => row.journal_entry_id && onOpenJournal?.(row.journal_entry_id)} className="font-mono text-blue-700 hover:underline">
                        {row.voucher_no}
                      </button>
                    </td>
                    <td className="px-1.5 py-1 text-slate-900">{row.account_name}</td>
                    <td className="px-1.5 py-1 text-right text-slate-900">{parseFloat(row.debit || 0).toFixed(2)}</td>
                    <td className="px-1.5 py-1 text-right text-slate-900">{parseFloat(row.credit || 0).toFixed(2)}</td>
                    <td className="px-1.5 py-1 text-slate-600">{row.narration}</td>
                  </tr>
                ))}
                {selectedReport === 'bank_ledger' && reportData.map((row: any, idx: number) => (
                  <tr key={idx} className="hover:bg-slate-50">
                    <td className="px-1.5 py-1 text-slate-900">{row.date}</td>
                    <td className="px-1.5 py-1 text-slate-900">
                      <button type="button" onClick={() => row.journal_entry_id && onOpenJournal?.(row.journal_entry_id)} className="font-mono text-blue-700 hover:underline">
                        {row.voucher_no}
                      </button>
                    </td>
                    <td className="px-1.5 py-1 text-slate-900">{row.account_name}</td>
                    <td className="px-1.5 py-1 text-right text-slate-900">{parseFloat(row.debit || 0).toFixed(2)}</td>
                    <td className="px-1.5 py-1 text-right text-slate-900">{parseFloat(row.credit || 0).toFixed(2)}</td>
                    <td className="px-1.5 py-1 text-slate-600">{row.narration}</td>
                  </tr>
                ))}
                {selectedReport === 'journal_register' && reportData.map((row: any, idx: number) => (
                  <tr key={idx} className="hover:bg-slate-50">
                    <td className="px-1.5 py-1 text-slate-900">{row.entry_date}</td>
                    <td className="px-1.5 py-1 text-slate-900">
                      <button type="button" onClick={() => row.journal_entry_id && onOpenJournal?.(row.journal_entry_id)}
                        className="font-mono text-blue-700 hover:underline">
                        {row.entry_number}
                      </button>
                    </td>
                    <td className="px-1.5 py-1 text-slate-600">{row.voucher_type}</td>
                    <td className="px-1.5 py-1 text-slate-900 font-mono">{row.account_code}</td>
                    <td className="px-1.5 py-1 text-slate-900">{row.account_name}</td>
                    <td className="px-1.5 py-1 text-right text-slate-900">{parseFloat(row.debit || 0).toFixed(2)}</td>
                    <td className="px-1.5 py-1 text-right text-slate-900">{parseFloat(row.credit || 0).toFixed(2)}</td>
                    <td className="px-1.5 py-1 text-slate-600">{row.narration}</td>
                  </tr>
                ))}
                {selectedReport === 'general_ledger' && reportData.map((row: any, idx: number) => (
                  <tr key={idx} className="hover:bg-slate-50">
                    <td className="px-1.5 py-1 text-slate-900 font-mono">{row.account_code}</td>
                    <td className="px-1.5 py-1 text-slate-900">{row.account_name}</td>
                    <td className="px-1.5 py-1 text-slate-900">{row.entry_date}</td>
                    <td className="px-1.5 py-1 text-slate-900">
                      <button type="button" onClick={() => row.journal_entry_id && onOpenJournal?.(row.journal_entry_id)} className="font-mono text-blue-700 hover:underline">
                        {row.voucher_number}
                      </button>
                    </td>
                    <td className="px-1.5 py-1 text-right text-slate-900">{parseFloat(row.debit || 0).toFixed(2)}</td>
                    <td className="px-1.5 py-1 text-right text-slate-900">{parseFloat(row.credit || 0).toFixed(2)}</td>
                    <td className="px-1.5 py-1 text-slate-600">{row.description}</td>
                  </tr>
                ))}
                {selectedReport === 'trial_balance' && reportData.slice(0, 100).map((row: any, idx: number) => (
                  <tr key={idx} className="hover:bg-slate-50">
                    <td className="px-1.5 py-1 text-slate-900 font-mono">{row.code}</td>
                    <td className="px-1.5 py-1 text-slate-900">{row.name}</td>
                    <td className="px-1.5 py-1 text-right text-slate-900">{parseFloat(row.debit || 0).toFixed(2)}</td>
                    <td className="px-1.5 py-1 text-right text-slate-900">{parseFloat(row.credit || 0).toFixed(2)}</td>
                  </tr>
                ))}
                {selectedReport === 'fixed_assets' && reportData.slice(0, 100).map((row: any, idx: number) => (
                  <tr key={idx} className="hover:bg-slate-50">
                    <td className="px-1.5 py-1 text-slate-900 font-mono">{row.asset_code}</td>
                    <td className="px-1.5 py-1 text-slate-900">{row.asset_name}</td>
                    <td className="px-1.5 py-1 text-slate-900">{row.acquisition_date}</td>
                    <td className="px-1.5 py-1 text-right text-slate-900">{row.cost}</td>
                    <td className="px-1.5 py-1 text-right text-slate-900">{row.accumulated_depreciation}</td>
                    <td className="px-1.5 py-1 text-right text-slate-900">{row.net_book_value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {reportData.length > 100 && (
              <div className="text-center py-4 text-slate-500 text-sm">
                {['cash_ledger', 'bank_ledger', 'general_ledger'].includes(selectedReport)
                  ? `Showing all ${reportData.length} records.`
                  : `Showing first 100 records. Export to Excel to see all ${reportData.length} records.`}
              </div>
            )}
          </div>
        )}
      </div>}
    </div>
  );
}
