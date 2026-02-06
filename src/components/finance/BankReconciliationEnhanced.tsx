import { useEffect, useState, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { Upload, RefreshCw, CheckCircle2, AlertCircle, XCircle, Plus, Calendar, Landmark, FileText, Edit } from 'lucide-react';
import * as XLSX from 'xlsx';
import { Modal } from '../Modal';
import { useFinance } from '../../contexts/FinanceContext';

interface BankAccount {
  id: string;
  account_name: string;
  bank_name: string;
  account_number: string;
  currency: string;
}

interface StatementLine {
  id: string;
  date: string;
  description: string;
  reference: string;
  debit: number;
  credit: number;
  balance: number;
  currency: string;
  status: 'matched' | 'suggested' | 'unmatched' | 'recorded';
  matchedEntry?: string;
  matchedExpenseId?: string;
  matchedReceiptId?: string;
  matchedFundTransferId?: string;
  matchedExpense?: {
    id: string;
    expense_category: string;
    amount: number;
    description: string;
    expense_date: string;
    voucher_number?: string;
  } | null;
  matchedReceipt?: {
    id: string;
    amount: number;
    payment_date: string;
    payment_number: string;
    customer_name?: string;
  } | null;
  matchedFundTransfer?: {
    id: string;
    transfer_number: string;
    amount: number;
    description: string;
    transfer_date: string;
    from_account_type: string;
    to_account_type: string;
  } | null;
  notes?: string;
}

interface BankReconciliationEnhancedProps {
  canManage: boolean;
}

export function BankReconciliationEnhanced({ canManage }: BankReconciliationEnhancedProps) {
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [selectedBank, setSelectedBank] = useState<string>('');
  const [selectedAccount, setSelectedAccount] = useState<BankAccount | null>(null);
  const [statementLines, setStatementLines] = useState<StatementLine[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [activeFilter, setActiveFilter] = useState<'all' | 'matched' | 'suggested' | 'unmatched'>('unmatched');
  const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'asc' | 'desc' } | null>(null);

  // Use master date range from Finance context
  const { dateRange: financeDateRange } = useFinance();
  const dateRange = {
    start: financeDateRange.startDate,
    end: financeDateRange.endDate,
  };
  const [recordingLine, setRecordingLine] = useState<StatementLine | null>(null);
  const [recordModal, setRecordModal] = useState(false);
  const [expenses, setExpenses] = useState<any[]>([]);
  const [linkToExpense, setLinkToExpense] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [ocrError, setOcrError] = useState<{message: string; canUseOCR: boolean; suggestions: string[]} | null>(null);
  const [ocrPreview, setOcrPreview] = useState<any | null>(null);
  const [lastUploadedFile, setLastUploadedFile] = useState<File | null>(null);
  const [editingLine, setEditingLine] = useState<StatementLine | null>(null);
  const [editModal, setEditModal] = useState(false);
  const [editFormData, setEditFormData] = useState({
    debit: 0,
    credit: 0,
    description: '',
  });
  const [deletePreview, setDeletePreview] = useState<any>(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [customers, setCustomers] = useState<Array<{ id: string; company_name: string }>>([]);

  const expenseCategories = [
    {
      value: 'duty_customs',
      label: 'Duty & Customs (BM)',
      type: 'import',
      requiresContainer: true,
      group: 'Import Costs'
    },
    {
      value: 'ppn_import',
      label: 'PPN Import',
      type: 'operations',
      requiresContainer: false,
      group: 'Operations'
    },
    {
      value: 'pph_import',
      label: 'PPh Import',
      type: 'import',
      requiresContainer: true,
      group: 'Import Costs'
    },
    {
      value: 'freight_import',
      label: 'Freight (Import)',
      type: 'import',
      requiresContainer: true,
      group: 'Import Costs'
    },
    {
      value: 'clearing_forwarding',
      label: 'Clearing & Forwarding',
      type: 'import',
      requiresContainer: true,
      group: 'Import Costs'
    },
    {
      value: 'port_charges',
      label: 'Port Charges',
      type: 'import',
      requiresContainer: true,
      group: 'Import Costs'
    },
    {
      value: 'container_handling',
      label: 'Container Handling',
      type: 'import',
      requiresContainer: true,
      group: 'Import Costs'
    },
    {
      value: 'transport_import',
      label: 'Transportation (Import)',
      type: 'import',
      requiresContainer: true,
      group: 'Import Costs'
    },
    {
      value: 'loading_import',
      label: 'Loading / Unloading (Import)',
      type: 'import',
      requiresContainer: true,
      group: 'Import Costs'
    },
    {
      value: 'bpom_ski_fees',
      label: 'BPOM / SKI Fees',
      type: 'import',
      requiresContainer: true,
      group: 'Import Costs'
    },
    {
      value: 'other_import',
      label: 'Other (Import)',
      type: 'import',
      requiresContainer: true,
      group: 'Import Costs'
    },
    {
      value: 'delivery_sales',
      label: 'Delivery / Dispatch (Sales)',
      type: 'sales',
      requiresContainer: false,
      group: 'Sales & Distribution'
    },
    {
      value: 'loading_sales',
      label: 'Loading / Unloading (Sales)',
      type: 'sales',
      requiresContainer: false,
      group: 'Sales & Distribution'
    },
    {
      value: 'other_sales',
      label: 'Other (Sales)',
      type: 'sales',
      requiresContainer: false,
      group: 'Sales & Distribution'
    },
    {
      value: 'salary',
      label: 'Salary',
      type: 'staff',
      requiresContainer: false,
      group: 'Staff Costs'
    },
    {
      value: 'staff_overtime',
      label: 'Staff Overtime',
      type: 'staff',
      requiresContainer: false,
      group: 'Staff Costs'
    },
    {
      value: 'staff_welfare',
      label: 'Staff Welfare / Allowances',
      type: 'staff',
      requiresContainer: false,
      group: 'Staff Costs'
    },
    {
      value: 'travel_conveyance',
      label: 'Travel & Conveyance',
      type: 'staff',
      requiresContainer: false,
      group: 'Staff Costs'
    },
    {
      value: 'warehouse_rent',
      label: 'Warehouse Rent',
      type: 'operations',
      requiresContainer: false,
      group: 'Operations'
    },
    {
      value: 'utilities',
      label: 'Utilities',
      type: 'operations',
      requiresContainer: false,
      group: 'Operations'
    },
    {
      value: 'bank_charges',
      label: 'Bank Charges',
      type: 'operations',
      requiresContainer: false,
      group: 'Operations'
    },
    {
      value: 'office_admin',
      label: 'Office & Admin',
      type: 'admin',
      requiresContainer: false,
      group: 'Administrative'
    },
    {
      value: 'office_shifting_renovation',
      label: 'Office Shifting & Renovation',
      type: 'admin',
      requiresContainer: false,
      group: 'Administrative'
    },
    {
      value: 'other',
      label: 'Other',
      type: 'admin',
      requiresContainer: false,
      group: 'Administrative'
    },
  ];

  useEffect(() => {
    loadBankAccounts();
    loadExpenses();
    loadCustomers();

    // Set up realtime subscriptions for bank statements and related changes
    const bankStatementSubscription = supabase
      .channel('bank-statement-recon-changes')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'bank_statement_lines' },
        () => {
          if (selectedBank) {
            loadStatementLines();
          }
        }
      )
      .subscribe();

    const expenseSubscription = supabase
      .channel('expense-recon-changes')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'finance_expenses' },
        () => {
          loadExpenses();
          if (selectedBank) {
            loadStatementLines();
          }
        }
      )
      .subscribe();

    return () => {
      bankStatementSubscription.unsubscribe();
      expenseSubscription.unsubscribe();
    };
  }, []);

  const loadCustomers = async () => {
    const { data } = await supabase.from('customers').select('id, company_name').order('company_name');
    if (data) setCustomers(data);
  };

  useEffect(() => {
    if (selectedBank) {
      const account = bankAccounts.find(b => b.id === selectedBank);
      setSelectedAccount(account || null);
      loadStatementLines();
    }
  }, [selectedBank, financeDateRange]);

  const loadBankAccounts = async () => {
    try {
      const { data, error } = await supabase
        .from('bank_accounts')
        .select('id, account_name, bank_name, account_number, currency')
        .eq('is_active', true)
        .order('account_name');
      if (error) throw error;
      setBankAccounts(data || []);
      if (data && data.length > 0) {
        const bcaAccount = data.find(
          acc => acc.bank_name === 'BCA Bank' &&
                 acc.account_number === '0930 2010 22' &&
                 acc.currency === 'IDR'
        );
        setSelectedBank(bcaAccount?.id || data[0].id);
      }
    } catch (err) {
      console.error('Error loading bank accounts:', err);
    }
  };

  const loadExpenses = async () => {
    try {
      // First, get all expenses (removed limit to show all expenses)
      const { data: allExpenses, error } = await supabase
        .from('finance_expenses')
        .select(`
          id,
          expense_date,
          description,
          amount,
          expense_category,
          voucher_number
        `)
        .order('expense_date', { ascending: false });

      if (error) throw error;

      // Then get all bank statement lines that have matched expenses
      const { data: linkedStatements } = await supabase
        .from('bank_statement_lines')
        .select('matched_expense_id')
        .not('matched_expense_id', 'is', null);

      // Create a Set of linked expense IDs for fast lookup
      const linkedExpenseIds = new Set(
        (linkedStatements || []).map(stmt => stmt.matched_expense_id)
      );

      // Filter to only show unlinked expenses
      const unlinkedExpenses = (allExpenses || []).filter(
        expense => !linkedExpenseIds.has(expense.id)
      );

      setExpenses(unlinkedExpenses);
    } catch (err) {
      console.error('Error loading expenses:', err);
    }
  };

  const loadStatementLines = async () => {
    if (!selectedBank) return;
    setLoading(true);
    try {
      // Calculate next day for inclusive end date filtering
      const endDatePlusOne = new Date(dateRange.end);
      endDatePlusOne.setDate(endDatePlusOne.getDate() + 1);
      const endDateStr = endDatePlusOne.toISOString().split('T')[0];

      const { data, error } = await supabase
        .from('bank_statement_lines')
        .select('*')
        .eq('bank_account_id', selectedBank)
        .gte('transaction_date', dateRange.start)
        .lt('transaction_date', endDateStr)
        .order('transaction_date', { ascending: false });

      if (error) throw error;

      // HARDENING FIX #5: Batch load all matched records to eliminate N+1 queries
      // Collect all IDs (Note: Petty cash is NOT reconciled with bank - per user's finance rules)
      const expenseIds = (data || []).map(r => r.matched_expense_id).filter(Boolean);
      const receiptIds = (data || []).map(r => r.matched_receipt_id).filter(Boolean);
      const fundTransferIds = (data || []).map(r => r.matched_fund_transfer_id).filter(Boolean);

      // Batch load all expenses
      const expenseMap = new Map();
      if (expenseIds.length > 0) {
        const { data: expenses } = await supabase
          .from('finance_expenses')
          .select('id, expense_category, amount, description, expense_date, voucher_number')
          .in('id', expenseIds);
        expenses?.forEach(e => expenseMap.set(e.id, e));
      }

      // Batch load all receipts with customers
      const receiptMap = new Map();
      if (receiptIds.length > 0) {
        const { data: receipts } = await supabase
          .from('receipt_vouchers')
          .select('id, amount, voucher_date, voucher_number, customer_id, customers(company_name)')
          .in('id', receiptIds);
        receipts?.forEach(r => {
          receiptMap.set(r.id, {
            id: r.id,
            amount: r.amount,
            payment_date: r.voucher_date,
            payment_number: r.voucher_number,
            customer_name: (r.customers as any)?.company_name
          });
        });
      }

      // Batch load all fund transfers
      const fundTransferMap = new Map();
      if (fundTransferIds.length > 0) {
        const { data: fundTransfers } = await supabase
          .from('fund_transfers')
          .select('id, transfer_number, amount, description, transfer_date, from_account_type, to_account_type')
          .in('id', fundTransferIds);
        fundTransfers?.forEach(f => fundTransferMap.set(f.id, f));
      }

      // Map lines with pre-loaded data (NO MORE QUERIES!)
      const lines: StatementLine[] = (data || []).map(row => {
        return {
          id: row.id,
          date: row.transaction_date,
          description: row.description || '',
          reference: row.reference || '',
          debit: row.debit_amount || 0,
          credit: row.credit_amount || 0,
          balance: row.running_balance || 0,
          currency: row.currency || 'IDR',
          status: row.reconciliation_status || 'unmatched',
          matchedEntry: row.matched_entry_id,
          matchedExpenseId: row.matched_expense_id,
          matchedReceiptId: row.matched_receipt_id,
          matchedFundTransferId: row.matched_fund_transfer_id,
          matchedExpense: row.matched_expense_id ? expenseMap.get(row.matched_expense_id) : null,
          matchedReceipt: row.matched_receipt_id ? receiptMap.get(row.matched_receipt_id) : null,
          matchedFundTransfer: row.matched_fund_transfer_id ? fundTransferMap.get(row.matched_fund_transfer_id) : null,
          notes: row.notes,
        };
      });

      setStatementLines(lines);
    } catch (err) {
      console.error('Error loading statement lines:', err);
      setStatementLines([]);
    } finally {
      setLoading(false);
    }
  };

  const parseIndonesianNumber = (str: string): number => {
    if (!str) return 0;
    const cleaned = str.replace(/[^\d,\.]/g, '');
    if (cleaned.includes(',') && cleaned.includes('.')) {
      const lastComma = cleaned.lastIndexOf(',');
      const lastDot = cleaned.lastIndexOf('.');
      if (lastComma > lastDot) {
        return parseFloat(cleaned.replace(/\./g, '').replace(/,/g, '.')) || 0;
      } else {
        return parseFloat(cleaned.replace(/,/g, '')) || 0;
      }
    } else if (cleaned.includes(',')) {
      return parseFloat(cleaned.replace(/,/g, '.')) || 0;
    } else {
      return parseFloat(cleaned.replace(/,/g, '')) || 0;
    }
  };

  const parseCSVLine = (line: string, delimiter: string = ';'): string[] => {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];

      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === delimiter && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }

    result.push(current.trim());
    return result;
  };

  const handleCSVUpload = async (file: File) => {
    try {
      const reader = new FileReader();
      reader.onload = async (event) => {
        try {
          const text = event.target?.result as string;

          // Auto-detect delimiter by checking first few lines
          const firstLines = text.split('\n').slice(0, 5).join('\n');
          const commaCount = (firstLines.match(/,/g) || []).length;
          const semicolonCount = (firstLines.match(/;/g) || []).length;
          const detectedDelimiter = commaCount > semicolonCount ? ',' : ';';

          console.log(`📊 Detected delimiter: "${detectedDelimiter}" (commas: ${commaCount}, semicolons: ${semicolonCount})`);

          const rows: any[][] = [];
          let currentLine = '';
          let inQuotes = false;

          for (let i = 0; i < text.length; i++) {
            const char = text[i];

            if (char === '"') {
              inQuotes = !inQuotes;
              currentLine += char;
            } else if (char === '\n' && !inQuotes) {
              if (currentLine.trim()) {
                const cells = parseCSVLine(currentLine, detectedDelimiter);
                rows.push(cells);
              }
              currentLine = '';
            } else if (char !== '\r') {
              currentLine += char;
            }
          }

          if (currentLine.trim()) {
            const cells = parseCSVLine(currentLine, detectedDelimiter);
            rows.push(cells);
          }

          console.log('📊 CSV rows parsed:', rows.length);
          console.log('📋 First 10 rows:');
          rows.slice(0, 10).forEach((row, i) => {
            console.log(`Row ${i}:`, row);
          });

          // Ask user for the year since CSV only has dd/MM format
          const currentYear = new Date().getFullYear();
          const userYear = prompt(`CSV contains dates without year (e.g., 01/12).\nWhich year is this statement for?`, String(currentYear - 1));
          if (!userYear) {
            alert('❌ Year is required to process the CSV');
            return;
          }
          const statementYear = parseInt(userYear);
          if (isNaN(statementYear) || statementYear < 2000 || statementYear > 2100) {
            alert('❌ Invalid year provided');
            return;
          }

          const { lines: parsedLines, metadata } = parseStatementDataWithMetadata(rows, statementYear);

          console.log('✅ Parsed lines:', parsedLines.length);
          console.log('📈 Metadata:', metadata);

          if (parsedLines.length === 0) {
            alert('❌ No transactions found in the CSV file. Check browser console for details.');
            return;
          }

          const { data: uploadRecord, error: uploadError } = await supabase
            .from('bank_statement_uploads')
            .insert({
              bank_account_id: selectedBank,
              statement_period: metadata.period || `${new Date().toLocaleString('default', { month: 'long' })} ${new Date().getFullYear()}`,
              statement_start_date: metadata.startDate || dateRange.start,
              statement_end_date: metadata.endDate || dateRange.end,
              currency: selectedAccount?.currency || 'IDR',
              opening_balance: metadata.openingBalance || 0,
              closing_balance: metadata.closingBalance || parsedLines[parsedLines.length - 1]?.balance || 0,
              total_debits: metadata.totalDebits || parsedLines.reduce((sum, l) => sum + l.debit, 0),
              total_credits: metadata.totalCredits || parsedLines.reduce((sum, l) => sum + l.credit, 0),
              transaction_count: parsedLines.length,
              status: 'completed',
            })
            .select()
            .single();

          if (uploadError) throw uploadError;

          const { data: { user } } = await supabase.auth.getUser();

          const insertData = parsedLines.map(line => ({
            upload_id: uploadRecord.id,
            bank_account_id: selectedBank,
            transaction_date: line.date,
            description: line.description,
            reference: line.reference,
            debit_amount: line.debit,
            credit_amount: line.credit,
            running_balance: line.balance,
            statement_balance: line.balance,
            currency: selectedAccount?.currency || 'IDR',
            reconciliation_status: 'unmatched',
            created_by: user?.id,
          }));

          // Check for potential duplicates first
          const { data: existingLines } = await supabase
            .from('bank_statement_lines')
            .select('transaction_date, description, debit_amount, credit_amount, running_balance')
            .eq('bank_account_id', selectedBank);

          // Find duplicates by matching date, amounts, and description
          const duplicates = insertData.filter(newLine =>
            existingLines?.some(existing =>
              existing.transaction_date === newLine.transaction_date &&
              existing.description === newLine.description &&
              existing.debit_amount === newLine.debit_amount &&
              existing.credit_amount === newLine.credit_amount &&
              existing.running_balance === newLine.running_balance
            )
          );

          let finalInsertData = insertData;

          if (duplicates.length > 0) {
            // Show duplicates to user
            let dupMessage = `⚠️ Found ${duplicates.length} potential duplicate transaction(s):\n\n`;
            duplicates.slice(0, 5).forEach((dup, idx) => {
              const date = new Date(dup.transaction_date).toLocaleDateString('en-GB');
              const amt = dup.debit_amount || dup.credit_amount;
              dupMessage += `${idx + 1}. ${date} - ${dup.description.substring(0, 40)} - Rp ${amt.toLocaleString()}\n`;
            });
            if (duplicates.length > 5) {
              dupMessage += `... and ${duplicates.length - 5} more\n`;
            }
            dupMessage += `\nDo you want to ADD them anyway?\n(Click OK to add, Cancel to skip duplicates)`;

            const userWantsToAdd = confirm(dupMessage);

            if (!userWantsToAdd) {
              // Filter out duplicates
              finalInsertData = insertData.filter(newLine =>
                !existingLines?.some(existing =>
                  existing.transaction_date === newLine.transaction_date &&
                  existing.description === newLine.description &&
                  existing.debit_amount === newLine.debit_amount &&
                  existing.credit_amount === newLine.credit_amount &&
                  existing.running_balance === newLine.running_balance
                )
              );
            }
          }

          if (finalInsertData.length === 0) {
            alert('ℹ️ No new transactions to import (all were duplicates and skipped)');
            return;
          }

          const { data: inserted, error: insertError } = await supabase
            .from('bank_statement_lines')
            .insert(finalInsertData)
            .select();

          if (insertError) {
            console.error('Insert error:', insertError);
            throw insertError;
          }

          const insertedCount = inserted?.length || 0;
          const skippedCount = insertData.length - finalInsertData.length;

          let message = `✅ CSV Import complete!\n`;
          message += `   Total processed: ${insertData.length} transaction(s)\n`;
          message += `   New transactions added: ${insertedCount}\n`;
          if (skippedCount > 0) {
            message += `   Duplicates skipped: ${skippedCount}`;
          }
          alert(message);

          try {
            await loadStatementLines();
          } catch (loadError) {
            console.error('Load statement lines error:', loadError);
          }

          if (insertedCount > 0) {
            try {
              await autoMatchTransactions();
            } catch (matchError) {
              console.error('Auto-match error:', matchError);
            }
          }
        } catch (err: any) {
          console.error('CSV parsing error:', err);
          alert(`❌ Error parsing CSV: ${err.message}`);
        }
      };
      reader.onerror = () => {
        console.error('FileReader error');
        alert('❌ Failed to read CSV file');
      };
      reader.readAsText(file);
    } catch (error: any) {
      console.error('CSV upload error:', error);
      alert(`❌ Failed to read CSV: ${error.message}`);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !selectedBank || !selectedAccount) return;

    setUploading(true);
    try {
      const isPDF = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
      const isImage = file.type.startsWith('image/') || file.name.match(/\.(png|jpg|jpeg)$/i);
      const isCSV = file.name.toLowerCase().endsWith('.csv');

      if (isPDF) {
        await handlePDFUpload(file);
      } else if (isImage) {
        await handlePDFUpload(file, true);
      } else if (isCSV) {
        await handleCSVUpload(file);
      } else {
        await handleExcelUpload(file);
      }
    } catch (uploadError) {
      console.error('File upload error:', uploadError);
    } finally {
      setUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handlePDFUpload = async (file: File, useOCR = false, previewOnly = false) => {
    try {
      setUploading(true);
      setOcrError(null);

      const formData = new FormData();
      formData.append('file', file);
      formData.append('bankAccountId', selectedBank);
      if (useOCR) {
        formData.append('useOCR', 'true');
      }
      if (previewOnly) {
        formData.append('previewOnly', 'true');
      }

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/parse-bca-statement`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${session.access_token}`,
          },
          body: formData,
        }
      );

      const result = await response.json();

      if (!response.ok) {
        if (result.canUseOCR) {
          setOcrError({
            message: result.error,
            canUseOCR: true,
            suggestions: result.suggestions
          });
          setLastUploadedFile(file);
        } else {
          throw new Error(result.error || 'Failed to parse PDF');
        }
        return;
      }

      if (result.preview) {
        setOcrPreview(result);
        return;
      }

      const ocrUsed = result.usedOCR ? ' (via OCR)' : '';
      let message = `✅ Import complete from ${result.period}${ocrUsed}\n`;
      message += `   Imported: ${result.insertedCount || result.transactionCount} transaction(s)`;
      if (result.duplicateCount > 0) {
        message += `\n   Skipped (duplicates): ${result.duplicateCount} transaction(s)`;
      }
      alert(message);
      setOcrError(null);
      setLastUploadedFile(null);

      try {
        await loadStatementLines();
      } catch (loadError) {
        console.error('Load statement lines error:', loadError);
      }

      const insertedCount = result.insertedCount || result.transactionCount || 0;
      if (insertedCount > 0) {
        try {
          await autoMatchTransactions();
        } catch (matchError) {
          console.error('Auto-match error:', matchError);
        }
      }
    } catch (error: any) {
      console.error('PDF upload error:', error);
      alert(`❌ Failed to parse PDF: ${error.message}`);
    } finally {
      setUploading(false);
    }
  };

  const handleRunOCR = async () => {
    if (!lastUploadedFile) return;
    setUploading(true);
    setOcrError(null);
    try {
      await handlePDFUpload(lastUploadedFile, true, true);
    } catch (error: any) {
      alert(`❌ OCR failed: ${error.message}`);
      setUploading(false);
    }
  };

  const handleConfirmOCRPreview = async () => {
    if (!lastUploadedFile) return;
    setOcrPreview(null);
    setUploading(true);
    try {
      await handlePDFUpload(lastUploadedFile, true, false);
    } catch (error: any) {
      alert(`❌ Failed to save: ${error.message}`);
    } finally {
      setUploading(false);
    }
  };

  const handleExcelUpload = async (file: File) => {
    try {
      const reader = new FileReader();
      reader.onload = async (event) => {
        try {
          const data = event.target?.result;
          const workbook = XLSX.read(data, { type: 'binary' });
          const sheetName = workbook.SheetNames[0];
          const worksheet = workbook.Sheets[sheetName];
          const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as any[][];

          console.log('📊 Raw Excel data rows:', jsonData.length);
          console.log('📋 First 10 rows:');
          jsonData.slice(0, 10).forEach((row, i) => {
            console.log(`Row ${i}:`, row);
          });

          const { lines, metadata } = parseStatementDataWithMetadata(jsonData);

          console.log('✅ Parsed lines:', lines.length);
          console.log('📈 Metadata:', metadata);
          if (lines.length > 0) {
            console.log('🔍 First 3 transactions:', lines.slice(0, 3));
          }

          if (lines.length === 0) {
            alert('❌ No valid transactions found in the file. Check browser console (F12) for details.');
            return;
          }

          const { data: uploadRecord, error: uploadError } = await supabase
            .from('bank_statement_uploads')
            .insert({
              bank_account_id: selectedBank,
              statement_period: metadata.period || `${new Date().toLocaleString('default', { month: 'long' })} ${new Date().getFullYear()}`,
              statement_start_date: metadata.startDate || dateRange.start,
              statement_end_date: metadata.endDate || dateRange.end,
              currency: selectedAccount?.currency || 'IDR',
              opening_balance: metadata.openingBalance || 0,
              closing_balance: metadata.closingBalance || lines[lines.length - 1]?.balance || 0,
              total_debits: metadata.totalDebits || lines.reduce((sum, l) => sum + l.debit, 0),
              total_credits: metadata.totalCredits || lines.reduce((sum, l) => sum + l.credit, 0),
              transaction_count: lines.length,
              status: 'completed',
            })
            .select()
            .single();

          if (uploadError) throw uploadError;

          const { data: { user } } = await supabase.auth.getUser();

          const insertData = lines.map(line => ({
            upload_id: uploadRecord.id,
            bank_account_id: selectedBank,
            transaction_date: line.date,
            description: line.description,
            reference: line.reference,
            debit_amount: line.debit,
            credit_amount: line.credit,
            running_balance: line.balance,
            statement_balance: line.balance,
            currency: selectedAccount?.currency || 'IDR',
            reconciliation_status: 'unmatched',
            created_by: user?.id,
          }));

          // Check for potential duplicates first
          const { data: existingLines } = await supabase
            .from('bank_statement_lines')
            .select('transaction_date, description, debit_amount, credit_amount, running_balance')
            .eq('bank_account_id', selectedBank);

          // Find duplicates by matching date, amounts, and description
          const duplicates = insertData.filter(newLine =>
            existingLines?.some(existing =>
              existing.transaction_date === newLine.transaction_date &&
              existing.description === newLine.description &&
              existing.debit_amount === newLine.debit_amount &&
              existing.credit_amount === newLine.credit_amount &&
              existing.running_balance === newLine.running_balance
            )
          );

          let finalInsertData = insertData;

          if (duplicates.length > 0) {
            // Show duplicates to user
            let dupMessage = `⚠️ Found ${duplicates.length} potential duplicate transaction(s):\n\n`;
            duplicates.slice(0, 5).forEach((dup, idx) => {
              const date = new Date(dup.transaction_date).toLocaleDateString('en-GB');
              const amt = dup.debit_amount || dup.credit_amount;
              dupMessage += `${idx + 1}. ${date} - ${dup.description.substring(0, 40)} - Rp ${amt.toLocaleString()}\n`;
            });
            if (duplicates.length > 5) {
              dupMessage += `... and ${duplicates.length - 5} more\n`;
            }
            dupMessage += `\nDo you want to ADD them anyway?\n(Click OK to add, Cancel to skip duplicates)`;

            const userWantsToAdd = confirm(dupMessage);

            if (!userWantsToAdd) {
              // Filter out duplicates
              finalInsertData = insertData.filter(newLine =>
                !existingLines?.some(existing =>
                  existing.transaction_date === newLine.transaction_date &&
                  existing.description === newLine.description &&
                  existing.debit_amount === newLine.debit_amount &&
                  existing.credit_amount === newLine.credit_amount &&
                  existing.running_balance === newLine.running_balance
                )
              );
            }
          }

          if (finalInsertData.length === 0) {
            alert('ℹ️ No new transactions to import (all were duplicates and skipped)');
            return;
          }

          const { data: inserted, error: insertError } = await supabase
            .from('bank_statement_lines')
            .insert(finalInsertData)
            .select();

          if (insertError) {
            console.error('Insert error:', insertError);
            throw insertError;
          }

          const insertedCount = inserted?.length || 0;
          const skippedCount = insertData.length - finalInsertData.length;

          let message = `✅ Excel Import complete!\n`;
          message += `   Total processed: ${insertData.length} transaction(s)\n`;
          message += `   New transactions added: ${insertedCount}\n`;
          if (skippedCount > 0) {
            message += `   Duplicates skipped: ${skippedCount}`;
          }
          alert(message);

          try {
            await loadStatementLines();
          } catch (loadError) {
            console.error('Load statement lines error:', loadError);
          }

          if (insertedCount > 0) {
            try {
              await autoMatchTransactions();
            } catch (matchError) {
              console.error('Auto-match error:', matchError);
            }
          }
        } catch (err: any) {
          console.error('Error parsing file:', err);
          alert('❌ Failed to parse file: ' + err.message);
        }
      };
      reader.readAsBinaryString(file);
    } catch (error: any) {
      console.error('Excel upload error:', error);
      alert(`❌ Failed to process file: ${error.message}`);
    }
  };

  const parseStatementDataWithMetadata = (rows: any[][], providedYear?: number): { lines: StatementLine[]; metadata: any } => {
    const lines: StatementLine[] = [];
    const metadata: any = {
      period: '',
      startDate: '',
      endDate: '',
      openingBalance: 0,
      closingBalance: 0,
      totalDebits: 0,
      totalCredits: 0,
    };

    let year = providedYear || new Date().getFullYear();
    let _month = new Date().getMonth() + 1;

    for (let i = 0; i < Math.min(10, rows.length); i++) {
      const row = rows[i];
      if (!row || row.length === 0) continue;

      const firstCell = String(row[0] || '');
      if (firstCell.includes('Periode')) {
        const periodeMatch = firstCell.match(/(\d{2})\/(\d{2})\/(\d{4})\s*-\s*(\d{2})\/(\d{2})\/(\d{4})/);
        if (periodeMatch) {
          const startDay = parseInt(periodeMatch[1]);
          const startMonth = parseInt(periodeMatch[2]);
          const startYear = parseInt(periodeMatch[3]);
          const endDay = parseInt(periodeMatch[4]);
          const endMonth = parseInt(periodeMatch[5]);
          const endYear = parseInt(periodeMatch[6]);

          year = startYear;
          _month = startMonth;

          metadata.startDate = `${startYear}-${String(startMonth).padStart(2, '0')}-${String(startDay).padStart(2, '0')}`;
          metadata.endDate = `${endYear}-${String(endMonth).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`;

          const monthNames = ['', 'JANUARI', 'FEBRUARI', 'MARET', 'APRIL', 'MEI', 'JUNI', 'JULI', 'AGUSTUS', 'SEPTEMBER', 'OKTOBER', 'NOVEMBER', 'DESEMBER'];
          metadata.period = `${monthNames[startMonth]} ${startYear}`;
        }
      }
    }

    let headerRowIdx = -1;
    for (let i = 0; i < Math.min(20, rows.length); i++) {
      const row = rows[i];
      if (!row || row.length === 0) continue;

      const rowStr = row.map((c: any) => String(c || '').toLowerCase()).join('|');

      if ((rowStr.includes('tanggal') || rowStr.includes('date') || rowStr.includes('tgl')) &&
          (rowStr.includes('keterangan') || rowStr.includes('description') || rowStr.includes('desc') ||
           rowStr.includes('mutasi') || rowStr.includes('amount') || rowStr.includes('saldo') || rowStr.includes('balance'))) {
        headerRowIdx = i;
        console.log(`✅ Found header at row ${i}:`, row);
        break;
      }
    }

    console.log('🔍 Header row index:', headerRowIdx);

    if (headerRowIdx === -1) {
      console.error('❌ Could not find column headers');
      console.log('📋 All rows checked:');
      rows.slice(0, 20).forEach((r, i) => {
        console.log(`  Row ${i}:`, r);
      });
      return { lines, metadata };
    }

    const headerRow = rows[headerRowIdx];
    let dateCol = -1, descCol = -1, branchCol = -1, amountCol = -1, balanceCol = -1;
    let debitCol = -1, creditCol = -1;

    headerRow.forEach((cell: any, idx: number) => {
      const cellStr = String(cell || '').toLowerCase();
      if (cellStr.includes('tanggal') || cellStr.includes('date') || cellStr.includes('tgl')) dateCol = idx;
      if (cellStr.includes('keterangan') || cellStr.includes('description') || cellStr.includes('desc')) descCol = idx;
      if (cellStr.includes('cabang') || cellStr.includes('branch')) branchCol = idx;
      if (cellStr.includes('mutasi') && !cellStr.includes('debet') && !cellStr.includes('kredit')) amountCol = idx;
      if (cellStr.includes('debet') || cellStr.includes('debit') || cellStr.includes('db')) debitCol = idx;
      if (cellStr.includes('kredit') || cellStr.includes('credit') || cellStr.includes('cr')) creditCol = idx;
      if (cellStr.includes('saldo') || cellStr.includes('balance')) balanceCol = idx;
    });

    console.log('📍 Column positions:', { dateCol, descCol, branchCol, amountCol, debitCol, creditCol, balanceCol });
    console.log('📋 Header row cells:', headerRow.map((cell, idx) => `[${idx}]: "${cell}"`));

    if (dateCol === -1) {
      console.error('❌ Missing date column');
      console.log('📋 Header row:', headerRow);
      return { lines, metadata };
    }

    let processedCount = 0;
    let skippedCount = 0;

    for (let i = headerRowIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length === 0) {
        skippedCount++;
        continue;
      }

      const firstCell = String(row[0] || '');

      if (firstCell.includes('Saldo Awal') ||
          firstCell.includes('Mutasi Debet') ||
          firstCell.includes('Mutasi Kredit') ||
          firstCell.includes('Saldo Akhir')) {
        console.log(`⏹️ Stopped at footer row ${i}: ${firstCell}`);
        break;
      }

      const dateVal = row[dateCol];
      if (!dateVal) {
        skippedCount++;
        if (i < headerRowIdx + 5) console.log(`⏭️ Row ${i}: No date value`);
        continue;
      }

      let parsedDate = '';

      if (typeof dateVal === 'number') {
        const excelEpoch = new Date(1900, 0, 1);
        const daysOffset = dateVal - 2;
        const jsDate = new Date(excelEpoch.getTime() + daysOffset * 24 * 60 * 60 * 1000);
        parsedDate = `${jsDate.getFullYear()}-${String(jsDate.getMonth() + 1).padStart(2, '0')}-${String(jsDate.getDate()).padStart(2, '0')}`;

        if (i < headerRowIdx + 5) console.log(`✅ Row ${i}: Excel serial ${dateVal} → ${parsedDate}`);
        processedCount++;
      } else {
        const dateStr = String(dateVal).trim();
        const dateMatch = dateStr.match(/^(\d{1,2})\/(\d{1,2})$/);
        if (!dateMatch) {
          skippedCount++;
          if (i < headerRowIdx + 5) console.log(`⏭️ Row ${i}: Date doesn't match pattern: "${dateStr}"`);
          continue;
        }

        const day = parseInt(dateMatch[1]);
        const mon = parseInt(dateMatch[2]);

        if (day < 1 || day > 31 || mon < 1 || mon > 12) {
          skippedCount++;
          continue;
        }

        parsedDate = `${year}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        processedCount++;
      }

      let debit = 0, credit = 0;

      if (debitCol >= 0 && creditCol >= 0) {
        const debitStr = String(row[debitCol] || '').trim();
        const creditStr = String(row[creditCol] || '').trim();
        debit = parseIndonesianNumber(debitStr);
        credit = parseIndonesianNumber(creditStr);
      } else if (amountCol >= 0) {
        const amountStr = String(row[amountCol] || '').trim();
        const dbCrIndicator = row[amountCol + 1] ? String(row[amountCol + 1]).trim().toUpperCase() : '';
        const isCR = dbCrIndicator === 'CR' || amountStr.includes(' CR');
        const isDB = dbCrIndicator === 'DB' || amountStr.includes(' DB');
        const amount = parseIndonesianNumber(amountStr);

        if (i < headerRowIdx + 3) {
          console.log(`💰 Row ${i} amount parsing:`, {
            amountStr,
            dbCrIndicator,
            isCR,
            isDB,
            amount
          });
        }

        if (isCR) {
          credit = amount;
        } else if (isDB || amount > 0) {
          debit = amount;
        }
      }

      let balance = 0;
      if (balanceCol >= 0) {
        const balanceStr = String(row[balanceCol] || '').trim();
        balance = parseIndonesianNumber(balanceStr);
      }

      let description = '';
      if (descCol >= 0) {
        const type = String(row[descCol] || '').trim();
        const details = String(row[descCol + 1] || '').trim();
        description = type + (details ? '; ' + details : '');
      }
      const branch = branchCol >= 0 ? String(row[branchCol] || '').trim() : '';

      if (i < headerRowIdx + 3) {
        console.log(`🔍 Row ${i} parsed:`, {
          date: parsedDate,
          debit,
          credit,
          balance,
          description: description.substring(0, 50)
        });
      }

      lines.push({
        id: `temp-${i}`,
        date: parsedDate,
        description: description,
        reference: branch,
        debit: debit,
        credit: credit,
        balance: balance,
        currency: selectedAccount?.currency || 'IDR',
        status: 'unmatched',
      });
    }

    console.log(`✅ Parsing complete: ${lines.length} transactions, ${skippedCount} rows skipped`);

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length === 0) continue;

      const firstCell = String(row[0] || '');

      if (firstCell.includes('Saldo Awal') || firstCell.includes('SALDO AWAL')) {
        for (let j = 0; j < row.length; j++) {
          const cell = String(row[j] || '');
          if (cell && /[\d,\.]+/.test(cell)) {
            metadata.openingBalance = parseIndonesianNumber(cell);
            break;
          }
        }
      }

      if (firstCell.includes('Mutasi Debet') || firstCell.includes('MUTASI DB') || firstCell.includes('Mutasi DB')) {
        for (let j = 0; j < row.length; j++) {
          const cell = String(row[j] || '');
          if (cell && /[\d,\.]+/.test(cell)) {
            metadata.totalDebits = parseIndonesianNumber(cell);
            break;
          }
        }
      }

      if (firstCell.includes('Mutasi Kredit') || firstCell.includes('MUTASI CR') || firstCell.includes('Mutasi CR')) {
        for (let j = 0; j < row.length; j++) {
          const cell = String(row[j] || '');
          if (cell && /[\d,\.]+/.test(cell)) {
            metadata.totalCredits = parseIndonesianNumber(cell);
            break;
          }
        }
      }

      if (firstCell.includes('Saldo Akhir') || firstCell.includes('SALDO AKHIR')) {
        for (let j = 0; j < row.length; j++) {
          const cell = String(row[j] || '');
          if (cell && /[\d,\.]+/.test(cell)) {
            metadata.closingBalance = parseIndonesianNumber(cell);
            break;
          }
        }
      }
    }

    return { lines, metadata };
  };

  const autoMatchTransactions = async () => {
    if (!selectedBank) return;

    try {
      // Use the database function that enforces 7-day date tolerance
      const { data, error } = await supabase.rpc('auto_match_smart');

      if (error) throw error;

      const result = data?.[0];
      const matchedCount = result?.matched_count || 0;
      const suggestedCount = result?.suggested_count || 0;
      const skippedCount = result?.skipped_count || 0;

      await loadStatementLines();

      let message = `✅ Auto-match complete!\n\n`;
      message += `✓ Matched (85%+ confidence): ${matchedCount}\n`;
      message += `⚠ Needs Review (70-84%): ${suggestedCount}\n`;
      if (skippedCount > 0) {
        message += `⏭ Skipped (already matched): ${skippedCount}\n`;
      }
      message += `\n🔒 Date tolerance: ±7 days maximum`;

      alert(message);
    } catch (err: any) {
      console.error('Error auto-matching:', err);
      alert('❌ Auto-match failed: ' + err.message);
    }
  };

  const previewClearData = async () => {
    if (!selectedBank) return;

    try {
      const { data, error } = await supabase.rpc('preview_bank_statement_delete', {
        p_bank_account_id: selectedBank,
        p_start_date: dateRange.start,
        p_end_date: dateRange.end,
      });

      if (error) throw error;

      setDeletePreview(data);
      setShowDeleteModal(true);
    } catch (err: any) {
      console.error('Error previewing delete:', err);
      alert('❌ Failed to preview: ' + err.message);
    }
  };

  const executeClearData = async () => {
    if (!selectedBank || !deletePreview) return;

    try {
      const { data, error } = await supabase.rpc('safe_delete_bank_statement_lines', {
        p_bank_account_id: selectedBank,
        p_start_date: dateRange.start,
        p_end_date: dateRange.end,
      });

      if (error) throw error;

      if (data.success) {
        alert(`✅ Successfully deleted ${data.deleted_count} unmatched transaction(s)`);
        setShowDeleteModal(false);
        setDeletePreview(null);
        await loadStatementLines();
      } else {
        alert(`❌ ${data.error}`);
      }
    } catch (err: any) {
      console.error('Error clearing data:', err);
      alert('❌ Failed to clear data: ' + err.message);
    }
  };

  const confirmMatch = async (lineId: string) => {
    try {
      await supabase
        .from('bank_statement_lines')
        .update({ reconciliation_status: 'matched' })
        .eq('id', lineId);

      // Update in local state
      setStatementLines(prev => prev.map(line =>
        line.id === lineId ? { ...line, status: 'matched' } : line
      ));
    } catch (err) {
      console.error('Error confirming match:', err);
    }
  };

  const rejectMatch = async (lineId: string) => {
    try {
      await supabase
        .from('bank_statement_lines')
        .update({
          reconciliation_status: 'unmatched',
          matched_entry_id: null
        })
        .eq('id', lineId);

      // Update in local state
      setStatementLines(prev => prev.map(line =>
        line.id === lineId ? { ...line, status: 'unmatched', matchedEntry: undefined, matched_entry_id: undefined } : line
      ));
    } catch (err) {
      console.error('Error rejecting match:', err);
    }
  };

  const openRecordModal = (line: StatementLine) => {
    setRecordingLine(line);
    setRecordModal(true);
  };

  const handleRecordExpense = async (line: StatementLine, category: string, description: string) => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // Record as expense
      const { data: expense, error: expenseError } = await supabase
        .from('finance_expenses')
        .insert({
          expense_category: category,
          amount: line.debit,
          expense_date: line.date,
          description: description || line.description,
          created_by: user.id,
        })
        .select()
        .single();

      if (expenseError) throw expenseError;

      const { error: updateError } = await supabase
        .from('bank_statement_lines')
        .update({
          reconciliation_status: 'recorded',
          matched_expense_id: expense.id,
          matched_at: new Date().toISOString(),
          matched_by: user.id,
        })
        .eq('id', line.id)
        .select()
        .single();

      if (updateError) throw updateError;

      setRecordModal(false);
      setRecordingLine(null);
      await loadStatementLines();
      alert('✅ Expense recorded and linked successfully');
    } catch (error: any) {
      console.error('Error recording expense:', error);
      alert('❌ ' + error.message);
    }
  };

  const handleLinkToExpense = async (line: StatementLine, expenseId: string) => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { error: updateError } = await supabase
        .from('bank_statement_lines')
        .update({
          reconciliation_status: 'matched',
          matched_expense_id: expenseId,
          matched_at: new Date().toISOString(),
          matched_by: user.id,
        })
        .eq('id', line.id)
        .select()
        .single();

      if (updateError) throw updateError;

      setRecordModal(false);
      setRecordingLine(null);
      setLinkToExpense(false);
      await loadStatementLines();
      alert('✅ Linked to expense successfully');
    } catch (error: any) {
      console.error('Error linking to expense:', error);
      alert('❌ ' + error.message);
    }
  };

  const handleRecordReceipt = async (line: StatementLine, type: string, customerId: string, description: string) => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      if (type === 'customer_payment') {
        if (!customerId) throw new Error('Please select a customer');

        // Generate voucher number
        const { data: voucherNum, error: voucherError } = await supabase.rpc('generate_voucher_number', { p_prefix: 'RV' });
        if (voucherError) throw voucherError;

        // Create receipt voucher
        const { data: receipt, error: receiptError } = await supabase
          .from('receipt_vouchers')
          .insert({
            voucher_number: voucherNum,
            voucher_date: line.date,
            customer_id: customerId,
            payment_method: 'bank_transfer',
            bank_account_id: selectedBank,
            reference_number: line.reference,
            amount: line.credit,
            description: description || line.description,
            created_by: user.id,
          })
          .select()
          .single();

        if (receiptError) throw receiptError;

        // Link to bank statement
        const { error: updateError } = await supabase
          .from('bank_statement_lines')
          .update({
            reconciliation_status: 'recorded',
            matched_receipt_id: receipt.id,
            matched_at: new Date().toISOString(),
            matched_by: user.id,
          })
          .eq('id', line.id);

        if (updateError) throw updateError;

        alert(`✅ Receipt Voucher ${voucherNum} created successfully`);
      } else {
        // For non-customer payment types, just record the transaction
        const { error: updateError } = await supabase
          .from('bank_statement_lines')
          .update({
            reconciliation_status: 'recorded',
            notes: `${type}: ${description}`,
            matched_at: new Date().toISOString(),
            matched_by: user.id,
          })
          .eq('id', line.id);

        if (updateError) throw updateError;

        alert('✅ Receipt recorded successfully');
      }

      setRecordModal(false);
      setRecordingLine(null);
      loadStatementLines();
    } catch (error: any) {
      console.error('Error recording receipt:', error);
      alert('❌ ' + error.message);
    }
  };

  const filteredLines = statementLines.filter(line => {
    if (activeFilter === 'all') return true;
    return line.status === activeFilter;
  });

  // Sorting function
  const handleSort = (key: string) => {
    let direction: 'asc' | 'desc' = 'asc';
    if (sortConfig && sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    }
    setSortConfig({ key, direction });
  };

  const sortedLines = [...filteredLines].sort((a, b) => {
    if (!sortConfig) return 0;

    const { key, direction } = sortConfig;
    let aValue: any = a[key as keyof StatementLine];
    let bValue: any = b[key as keyof StatementLine];

    // Handle date sorting
    if (key === 'date') {
      aValue = new Date(aValue).getTime();
      bValue = new Date(bValue).getTime();
    }

    // Handle numeric sorting for debit/credit
    if (key === 'debit' || key === 'credit') {
      aValue = Number(aValue) || 0;
      bValue = Number(bValue) || 0;
    }

    // Handle string sorting
    if (typeof aValue === 'string') {
      aValue = aValue.toLowerCase();
      bValue = bValue.toLowerCase();
    }

    if (aValue < bValue) return direction === 'asc' ? -1 : 1;
    if (aValue > bValue) return direction === 'asc' ? 1 : -1;
    return 0;
  });

  const stats = {
    total: statementLines.length,
    matched: statementLines.filter(l => l.status === 'matched' || l.status === 'recorded').length,
    suggested: statementLines.filter(l => l.status === 'suggested').length,
    unmatched: statementLines.filter(l => l.status === 'unmatched').length,
  };

  const getCurrencySymbol = (currency: string) => {
    return currency === 'USD' ? '$' : 'Rp';
  };

  const openEditModal = (line: StatementLine) => {
    setEditingLine(line);
    setEditFormData({
      debit: line.debit,
      credit: line.credit,
      description: line.description,
    });
    setEditModal(true);
  };

  const handleUpdateLine = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingLine) return;

    try {
      const { error } = await supabase
        .from('bank_statement_lines')
        .update({
          debit_amount: editFormData.debit,
          credit_amount: editFormData.credit,
          description: editFormData.description,
        })
        .eq('id', editingLine.id);

      if (error) throw error;

      // Update in local state
      setStatementLines(prev => prev.map(line =>
        line.id === editingLine.id ? {
          ...line,
          debit: editFormData.debit,
          credit: editFormData.credit,
          description: editFormData.description
        } : line
      ));

      setEditModal(false);
      setEditingLine(null);
      alert('✅ Bank statement line updated successfully');
    } catch (error: any) {
      console.error('Error updating line:', error);
      alert('❌ ' + error.message);
    }
  };

  const handleUnlinkTransaction = async () => {
    if (!editingLine) return;

    const confirmUnlink = window.confirm(
      'Are you sure you want to unlink this transaction?\n\n' +
      'This will set its status back to "Unmatched" and remove the link to the expense/receipt.'
    );

    if (!confirmUnlink) return;

    try {
      const { error } = await supabase
        .from('bank_statement_lines')
        .update({
          matched_expense_id: null,
          matched_receipt_id: null,
          matched_fund_transfer_id: null,
          matched_entry_id: null,
          reconciliation_status: 'unmatched',
          matched_at: null,
          matched_by: null,
          notes: null,
        })
        .eq('id', editingLine.id);

      if (error) throw error;

      // Update in local state
      setStatementLines(prev => prev.map(line =>
        line.id === editingLine.id ? {
          ...line,
          status: 'unmatched',
          matchedExpenseId: undefined,
          matchedReceiptId: undefined,
          matchedFundTransferId: undefined,
          matchedExpense: null,
          matchedReceipt: null,
          matchedFundTransfer: null,
          notes: undefined
        } : line
      ));

      setEditModal(false);
      setEditingLine(null);
      alert('✅ Transaction unlinked successfully');
    } catch (error: any) {
      console.error('Error unlinking transaction:', error);
      alert('❌ ' + error.message);
    }
  };

  return (
    <div className="space-y-4">
      {/* Compact Header with Bank Selection and Actions */}
      <div className="bg-gradient-to-r from-slate-700 to-slate-800 rounded-lg p-2.5 text-white shadow-md">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-bold">Bank Reconciliation</h3>
            {selectedAccount && (
              <span className="text-slate-300 text-xs">
                {selectedAccount.bank_name} - {selectedAccount.account_number}
              </span>
            )}
            <div className="flex gap-2">
              <div className="bg-white/20 rounded px-2.5 py-1">
                <div className="text-slate-200 text-[9px] leading-tight">Matched</div>
                <div className="text-xs font-bold text-green-400">{stats.matched}</div>
              </div>
              <div className="bg-white/20 rounded px-2.5 py-1">
                <div className="text-slate-200 text-[9px] leading-tight">Unmatched</div>
                <div className="text-xs font-bold text-red-400">{stats.unmatched}</div>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => { autoMatchTransactions(); }}
              disabled={!selectedBank}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 font-medium shadow-sm"
              title="Auto-match"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Match
            </button>
            {canManage && (
              <>
                <button
                  onClick={previewClearData}
                  disabled={!selectedBank}
                  className="p-1.5 bg-white/20 rounded hover:bg-white/30 disabled:opacity-50"
                  title="Clear"
                >
                  <XCircle className="w-3.5 h-3.5" />
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.xlsx,.xls,.csv,.png,.jpg,.jpeg"
                  onChange={handleFileUpload}
                  className="hidden"
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading || !selectedBank}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs bg-white text-slate-700 rounded hover:bg-slate-50 disabled:opacity-50 font-medium shadow-sm"
                  title="Upload"
                >
                  <Upload className="w-3.5 h-3.5" />
                  {uploading ? 'Uploading' : 'Upload'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Compact Filter Bar */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-2">
        <div className="flex items-center gap-3 flex-wrap">
          {/* Bank Account Selector */}
          <select
            value={selectedBank}
            onChange={(e) => setSelectedBank(e.target.value)}
            className="px-3 py-1.5 border border-gray-300 rounded-md text-xs font-medium"
          >
            {bankAccounts.map(bank => (
              <option key={bank.id} value={bank.id}>
                {bank.bank_name} - {bank.account_number}
              </option>
            ))}
          </select>

          <div className="h-6 w-px bg-gray-300"></div>

          {/* Date range controlled by master filter at top */}
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <Calendar className="w-3 h-3" />
            <span>{new Date(dateRange.start).toLocaleDateString('en-GB')} → {new Date(dateRange.end).toLocaleDateString('en-GB')}</span>
          </div>

          <div className="h-6 w-px bg-gray-300"></div>

          {/* Status Filter Pills */}
          <div className="flex gap-1">
            <button
              onClick={() => setActiveFilter('all')}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                activeFilter === 'all'
                  ? 'bg-slate-700 text-white shadow-sm'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              All ({stats.total})
            </button>
            <button
              onClick={() => setActiveFilter('matched')}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                activeFilter === 'matched'
                  ? 'bg-green-600 text-white shadow-sm'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              ✓ Matched ({stats.matched})
            </button>
            <button
              onClick={() => setActiveFilter('suggested')}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                activeFilter === 'suggested'
                  ? 'bg-yellow-600 text-white shadow-sm'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              ⚠ Review ({stats.suggested})
            </button>
            <button
              onClick={() => setActiveFilter('unmatched')}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                activeFilter === 'unmatched'
                  ? 'bg-red-600 text-white shadow-sm'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              ✕ Unmatched ({stats.unmatched})
            </button>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12 bg-white rounded-lg">
          <RefreshCw className="w-6 h-6 animate-spin text-blue-600" />
        </div>
      ) : filteredLines.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-lg border-2 border-dashed">
          <Landmark className="w-12 h-12 text-gray-300 mx-auto mb-3" />
          <h3 className="text-lg font-medium text-gray-600 mb-1">No Bank Transactions</h3>
          <p className="text-sm text-gray-500 mb-4">
            Upload a BCA PDF statement or Excel/CSV file to start reconciling
          </p>
          {canManage && (
            <button
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              <Upload className="w-4 h-4" />
              Upload Statement
            </button>
          )}
        </div>
      ) : (
        <div className="bg-white border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th
                  onClick={() => handleSort('date')}
                  className="px-3 py-2 text-left font-medium text-gray-600 cursor-pointer hover:bg-gray-100 select-none"
                >
                  <div className="flex items-center gap-1">
                    Date
                    {sortConfig?.key === 'date' && (
                      <span className="text-blue-600">{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </div>
                </th>
                <th
                  onClick={() => handleSort('description')}
                  className="px-3 py-2 text-left font-medium text-gray-600 cursor-pointer hover:bg-gray-100 select-none"
                >
                  <div className="flex items-center gap-1">
                    Description
                    {sortConfig?.key === 'description' && (
                      <span className="text-blue-600">{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </div>
                </th>
                <th
                  onClick={() => handleSort('debit')}
                  className="px-3 py-2 text-right font-medium text-gray-600 cursor-pointer hover:bg-gray-100 select-none"
                >
                  <div className="flex items-center justify-end gap-1">
                    Debit
                    {sortConfig?.key === 'debit' && (
                      <span className="text-blue-600">{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </div>
                </th>
                <th
                  onClick={() => handleSort('credit')}
                  className="px-3 py-2 text-right font-medium text-gray-600 cursor-pointer hover:bg-gray-100 select-none"
                >
                  <div className="flex items-center justify-end gap-1">
                    Credit
                    {sortConfig?.key === 'credit' && (
                      <span className="text-blue-600">{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </div>
                </th>
                <th
                  onClick={() => handleSort('status')}
                  className="px-3 py-2 text-center font-medium text-gray-600 cursor-pointer hover:bg-gray-100 select-none"
                >
                  <div className="flex items-center justify-center gap-1">
                    Status
                    {sortConfig?.key === 'status' && (
                      <span className="text-blue-600">{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </div>
                </th>
                <th className="px-3 py-2 text-center font-medium text-gray-600">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {sortedLines.map(line => (
                <tr key={line.id} className="hover:bg-gray-50">
                  <td className="px-3 py-2 text-gray-700 whitespace-nowrap">
                    {new Date(line.date).toLocaleDateString('id-ID')}
                  </td>
                  <td className="px-3 py-2 text-gray-700 max-w-md">
                    <div className="whitespace-pre-wrap text-sm leading-tight">{line.description}</div>
                    {line.reference && (
                      <div className="text-xs text-gray-500 font-mono mt-1">{line.reference}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right text-red-600 font-medium whitespace-nowrap">
                    {line.debit > 0 ? `${getCurrencySymbol(line.currency)} ${line.debit.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '-'}
                  </td>
                  <td className="px-3 py-2 text-right text-green-600 font-medium whitespace-nowrap">
                    {line.credit > 0 ? `${getCurrencySymbol(line.currency)} ${line.credit.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '-'}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-col gap-1">
                      {(line.status === 'matched' || line.status === 'recorded') && (
                        <>
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
                            <CheckCircle2 className="w-3 h-3" /> Recorded
                          </span>
                          {/* Show what it's linked to */}
                          {line.matchedExpense && (
                            <span className="text-xs text-gray-600">
                              → Expense: {line.matchedExpense.expense_category}
                            </span>
                          )}
                          {line.matchedReceipt && (
                            <span className="text-xs text-gray-600">
                              → Receipt: {line.matchedReceipt.customer_name || 'Customer'}
                            </span>
                          )}
                          {line.matchedFundTransfer && (
                            <span className="text-xs text-gray-600">
                              → Fund Transfer: {line.matchedFundTransfer.from_account_type} → {line.matchedFundTransfer.to_account_type}
                            </span>
                          )}
                          {/* Warn if no actual link */}
                          {!line.matchedExpense && !line.matchedReceipt && !line.matchedFundTransfer && !line.matchedEntry && (
                            <span className="text-xs text-orange-600 font-medium">
                              ⚠️ No link found
                            </span>
                          )}
                        </>
                      )}
                      {line.status === 'suggested' && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-700">
                          <AlertCircle className="w-3 h-3" /> Review
                        </span>
                      )}
                      {line.status === 'unmatched' && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">
                          <XCircle className="w-3 h-3" /> Unrecorded
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-center">
                    <div className="flex items-center justify-center gap-1">
                      {line.status === 'suggested' && (
                        <>
                          <button
                            onClick={() => confirmMatch(line.id)}
                            className="p-1 text-green-600 hover:bg-green-50 rounded"
                            title="Confirm Match"
                          >
                            <CheckCircle2 className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => rejectMatch(line.id)}
                            className="p-1 text-red-600 hover:bg-red-50 rounded"
                            title="Reject Match"
                          >
                            <XCircle className="w-4 h-4" />
                          </button>
                        </>
                      )}
                      {line.status === 'unmatched' && canManage && (
                        <button
                          onClick={() => openRecordModal(line)}
                          className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
                          title="Record transaction"
                        >
                          <Plus className="w-3 h-3" />
                          Record
                        </button>
                      )}
                      {canManage && (
                        <button
                          onClick={() => openEditModal(line)}
                          className="p-1 text-gray-600 hover:bg-gray-100 rounded"
                          title="Edit debit/credit"
                        >
                          <Edit className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {/* Totals Row */}
              <tr className="bg-blue-50 border-t-2 border-blue-200 font-bold">
                <td colSpan={2} className="px-3 py-3 text-right text-gray-900">
                  TOTAL ({sortedLines.length} transactions):
                </td>
                <td className="px-3 py-3 text-right text-red-700 font-bold whitespace-nowrap">
                  {getCurrencySymbol(selectedAccount?.currency || 'IDR')} {sortedLines.reduce((sum, line) => sum + line.debit, 0).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </td>
                <td className="px-3 py-3 text-right text-green-700 font-bold whitespace-nowrap">
                  {getCurrencySymbol(selectedAccount?.currency || 'IDR')} {sortedLines.reduce((sum, line) => sum + line.credit, 0).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </td>
                <td colSpan={2} className="px-3 py-3 text-center text-gray-600 text-sm">
                  Net: {getCurrencySymbol(selectedAccount?.currency || 'IDR')} {(sortedLines.reduce((sum, line) => sum + line.credit, 0) - sortedLines.reduce((sum, line) => sum + line.debit, 0)).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* Recording Modal */}
      <Modal isOpen={recordModal} onClose={() => { setRecordModal(false); setRecordingLine(null); setLinkToExpense(false); }} title="Record Transaction">
        {recordingLine && (
          <div className="space-y-4">
            <div className="p-3 bg-gray-50 rounded-lg">
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-600">Date:</span>
                <span className="font-medium">{new Date(recordingLine.date).toLocaleDateString('id-ID')}</span>
              </div>
              <div className="mt-2 text-sm">
                <span className="text-gray-600">Description:</span>
                <p className="font-medium mt-1">{recordingLine.description}</p>
              </div>
              {recordingLine.debit > 0 && (
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-sm text-gray-600">Amount:</span>
                  <span className="text-lg font-bold text-red-600">
                    {getCurrencySymbol(recordingLine.currency)} {recordingLine.debit.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                </div>
              )}
              {recordingLine.credit > 0 && (
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-sm text-gray-600">Amount:</span>
                  <span className="text-lg font-bold text-green-600">
                    {getCurrencySymbol(recordingLine.currency)} {recordingLine.credit.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                </div>
              )}
            </div>

            {recordingLine.debit > 0 && (
              <div>
                <div className="flex gap-2 mb-3">
                  <button
                    onClick={() => setLinkToExpense(false)}
                    className={`flex-1 py-2 px-3 rounded-lg text-sm font-medium ${!linkToExpense ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700'}`}
                  >
                    Create New Expense
                  </button>
                  <button
                    onClick={() => setLinkToExpense(true)}
                    className={`flex-1 py-2 px-3 rounded-lg text-sm font-medium ${linkToExpense ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700'}`}
                  >
                    Link to Existing Expense
                  </button>
                </div>

                {!linkToExpense ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const formData = new FormData(e.currentTarget);
                      const category = formData.get('category') as string;
                      const description = formData.get('description') as string;
                      handleRecordExpense(recordingLine, category, description);
                    }}
                    className="space-y-3"
                  >
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Category *</label>
                      <select
                        name="category"
                        required
                        className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                      >
                        <option value="">Select category...</option>

                        <optgroup label="═══ IMPORT COSTS (Capitalized to Inventory) ═══">
                          {expenseCategories.filter(c => c.group === 'Import Costs').map((cat) => (
                            <option key={cat.value} value={cat.value}>
                              {cat.label}
                            </option>
                          ))}
                        </optgroup>

                        <optgroup label="═══ SALES & DISTRIBUTION (P&L Expense) ═══">
                          {expenseCategories.filter(c => c.group === 'Sales & Distribution').map((cat) => (
                            <option key={cat.value} value={cat.value}>
                              {cat.label}
                            </option>
                          ))}
                        </optgroup>

                        <optgroup label="═══ STAFF COSTS (P&L Expense) ═══">
                          {expenseCategories.filter(c => c.group === 'Staff Costs').map((cat) => (
                            <option key={cat.value} value={cat.value}>
                              {cat.label}
                            </option>
                          ))}
                        </optgroup>

                        <optgroup label="═══ OPERATIONS (P&L Expense) ═══">
                          {expenseCategories.filter(c => c.group === 'Operations').map((cat) => (
                            <option key={cat.value} value={cat.value}>
                              {cat.label}
                            </option>
                          ))}
                        </optgroup>

                        <optgroup label="═══ ADMINISTRATIVE (P&L Expense) ═══">
                          {expenseCategories.filter(c => c.group === 'Administrative').map((cat) => (
                            <option key={cat.value} value={cat.value}>
                              {cat.label}
                            </option>
                          ))}
                        </optgroup>
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                      <input
                        type="text"
                        name="description"
                        defaultValue={recordingLine.description}
                        className="w-full px-3 py-2 border rounded-lg"
                        placeholder="Optional: Override description"
                      />
                    </div>
                    <button
                      type="submit"
                      className="w-full py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                    >
                      Create & Link Expense
                    </button>
                  </form>
                ) : (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const formData = new FormData(e.currentTarget);
                      const expenseId = formData.get('expense_id') as string;
                      if (!expenseId) {
                        alert('Please select an expense');
                        return;
                      }
                      handleLinkToExpense(recordingLine, expenseId);
                    }}
                    className="space-y-3"
                  >
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Select Expense *</label>
                      <select
                        name="expense_id"
                        required
                        className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
                        disabled={expenses.length === 0}
                      >
                        <option value="">
                          {expenses.length === 0 ? 'No expenses found' : 'Choose an expense...'}
                        </option>
                        {expenses.map(expense => {
                          // Format date as DD/MM/YY
                          const date = new Date(expense.expense_date);
                          const dd = String(date.getDate()).padStart(2, '0');
                          const mm = String(date.getMonth() + 1).padStart(2, '0');
                          const yy = String(date.getFullYear()).slice(-2);
                          const formattedDate = `${dd}/${mm}/${yy}`;

                          return (
                            <option key={expense.id} value={expense.id}>
                              {formattedDate} - {expense.voucher_number ? `[${expense.voucher_number}] ` : ''}
                              {expense.description} -
                              Rp {expense.amount.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </option>
                          );
                        })}
                      </select>
                      <p className="text-xs text-gray-500 mt-1">
                        Showing {expenses.length} unlinked expense{expenses.length !== 1 ? 's' : ''}. Match by voucher number or amount.
                      </p>
                    </div>
                    <button
                      type="submit"
                      className="w-full py-2 bg-green-600 text-white rounded-lg hover:bg-green-700"
                    >
                      Link to Expense
                    </button>
                  </form>
                )}
              </div>
            )}

            {recordingLine.credit > 0 && (
              <div>
                <h4 className="font-medium mb-2">Record as Receipt</h4>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const formData = new FormData(e.currentTarget);
                    const type = formData.get('type') as string;
                    const customerId = formData.get('customer_id') as string;
                    const description = formData.get('description') as string;
                    handleRecordReceipt(recordingLine, type, customerId, description);
                  }}
                  className="space-y-3"
                >
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Type *</label>
                    <select
                      name="type"
                      id="receiptType"
                      required
                      className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                      onChange={(e) => {
                        const customerField = document.getElementById('customerField');
                        if (customerField) {
                          customerField.style.display = e.target.value === 'customer_payment' ? 'block' : 'none';
                        }
                      }}
                    >
                      <option value="">Select type...</option>
                      <option value="customer_payment">Customer Payment</option>
                      <option value="capital">Capital Injection</option>
                      <option value="other_income">Other Income</option>
                      <option value="loan">Loan/Financing</option>
                    </select>
                  </div>
                  <div id="customerField" style={{ display: 'none' }}>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Customer *</label>
                    <select
                      name="customer_id"
                      className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">Select customer...</option>
                      {customers.map(c => (
                        <option key={c.id} value={c.id}>{c.company_name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                    <input
                      type="text"
                      name="description"
                      defaultValue={recordingLine.description}
                      className="w-full px-3 py-2 border rounded-lg"
                      placeholder="Optional: Override description"
                    />
                  </div>
                  <button
                    type="submit"
                    className="w-full py-2 bg-green-600 text-white rounded-lg hover:bg-green-700"
                  >
                    Record Receipt
                  </button>
                </form>
              </div>
            )}
          </div>
        )}
      </Modal>

      {ocrError && (
        <Modal
          isOpen={true}
          onClose={() => {
            setOcrError(null);
            setLastUploadedFile(null);
          }}
          title="PDF Extraction Failed"
        >
          <div className="space-y-4">
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
              <p className="text-yellow-800 text-sm font-medium mb-2">{ocrError.message}</p>
              <div className="space-y-2">
                <p className="text-sm text-yellow-700 font-medium">Recommended options:</p>
                <ul className="list-disc list-inside space-y-1 text-sm text-yellow-700">
                  {ocrError.suggestions.map((suggestion, idx) => (
                    <li key={idx}>{suggestion}</li>
                  ))}
                </ul>
              </div>
            </div>

            {ocrError.canUseOCR && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <p className="text-blue-800 text-sm font-medium mb-2">Advanced Option: OCR Processing</p>
                <p className="text-blue-700 text-xs mb-3">
                  Optical Character Recognition (OCR) can extract text from image-based or encrypted PDFs.
                  This process takes 30-60 seconds and requires Google Vision API configuration.
                  You'll be able to preview the results before saving.
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={handleRunOCR}
                    disabled={uploading}
                    className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium"
                  >
                    {uploading ? 'Processing with OCR...' : 'Run OCR Anyway'}
                  </button>
                  <button
                    onClick={() => {
                      setOcrError(null);
                      setLastUploadedFile(null);
                    }}
                    className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 text-sm font-medium"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </Modal>
      )}

      {ocrPreview && (
        <Modal
          isOpen={true}
          onClose={() => setOcrPreview(null)}
          title="OCR Preview - Confirm Before Saving"
        >
          <div className="space-y-4">
            <div className="bg-green-50 border border-green-200 rounded-lg p-4">
              <p className="text-green-800 text-sm font-medium mb-2">
                ✅ OCR extracted {ocrPreview.transactionCount} transactions
              </p>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <span className="text-gray-600">Period:</span>
                  <span className="ml-2 font-medium text-gray-900">{ocrPreview.period}</span>
                </div>
                <div>
                  <span className="text-gray-600">Opening Balance:</span>
                  <span className="ml-2 font-medium text-gray-900">
                    {selectedAccount?.currency} {ocrPreview.openingBalance.toLocaleString()}
                  </span>
                </div>
                <div>
                  <span className="text-gray-600">Closing Balance:</span>
                  <span className="ml-2 font-medium text-gray-900">
                    {selectedAccount?.currency} {ocrPreview.closingBalance.toLocaleString()}
                  </span>
                </div>
                <div>
                  <span className="text-gray-600">Transactions:</span>
                  <span className="ml-2 font-medium text-gray-900">{ocrPreview.transactionCount}</span>
                </div>
              </div>
            </div>

            <div>
              <h4 className="text-sm font-medium text-gray-900 mb-2">Sample Transactions (First 10):</h4>
              <div className="border rounded-lg overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-2 py-1 text-left">Date</th>
                      <th className="px-2 py-1 text-left">Description</th>
                      <th className="px-2 py-1 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ocrPreview.transactions.map((txn: any, idx: number) => (
                      <tr key={idx} className="border-t">
                        <td className="px-2 py-1">{txn.date}</td>
                        <td className="px-2 py-1 truncate max-w-xs">{txn.description}</td>
                        <td className="px-2 py-1 text-right">
                          {selectedAccount?.currency} {(txn.debitAmount || txn.creditAmount).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
              <p className="text-yellow-800 text-xs">
                ⚠️ Please verify the extracted data looks correct before confirming.
                OCR may have minor errors in dates, amounts, or descriptions.
              </p>
            </div>

            <div className="flex gap-2">
              <button
                onClick={handleConfirmOCRPreview}
                disabled={uploading}
                className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 font-medium"
              >
                {uploading ? 'Saving...' : 'Confirm & Save'}
              </button>
              <button
                onClick={() => setOcrPreview(null)}
                className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 font-medium"
              >
                Cancel
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Delete Confirmation Modal */}
      <Modal
        isOpen={showDeleteModal}
        onClose={() => {
          setShowDeleteModal(false);
          setDeletePreview(null);
        }}
        title="Confirm Clear Data"
      >
        {deletePreview && (
          <div className="space-y-4">
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
              <h4 className="font-medium text-yellow-900 mb-2">Warning: Data Deletion</h4>
              <p className="text-sm text-yellow-800">
                You are about to clear bank statement data. This action cannot be undone.
              </p>
            </div>

            <div className="bg-gray-50 border rounded-lg p-4 space-y-3">
              <div>
                <div className="text-xs text-gray-600 mb-1">Bank Account</div>
                <div className="font-medium text-gray-900">
                  {deletePreview.bank_info?.bank_name} - {deletePreview.bank_info?.account_number}
                  <span className="ml-2 px-2 py-0.5 bg-blue-100 text-blue-700 rounded text-xs">
                    {deletePreview.bank_info?.currency}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="text-xs text-gray-600 mb-1">Date Range</div>
                  <div className="text-sm font-medium text-gray-900">
                    {new Date(deletePreview.start_date).toLocaleDateString('id-ID')} -
                    {' '}{new Date(deletePreview.end_date).toLocaleDateString('id-ID')}
                  </div>
                </div>

                <div>
                  <div className="text-xs text-gray-600 mb-1">Total Transactions</div>
                  <div className="text-2xl font-bold text-gray-900">
                    {deletePreview.total_count}
                  </div>
                </div>
              </div>

              <div className="border-t pt-3 grid grid-cols-2 gap-4">
                <div>
                  <div className="text-xs text-red-600 font-medium mb-1">Reconciled (Protected)</div>
                  <div className="text-lg font-bold text-red-600">
                    {deletePreview.reconciled_count}
                  </div>
                  <div className="text-xs text-gray-500">Cannot be deleted</div>
                </div>

                <div>
                  <div className="text-xs text-gray-600 font-medium mb-1">Unmatched (Deletable)</div>
                  <div className="text-lg font-bold text-gray-900">
                    {deletePreview.unmatched_count}
                  </div>
                  <div className="text-xs text-gray-500">Will be deleted</div>
                </div>
              </div>
            </div>

            {deletePreview.warning && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                <p className="text-sm text-red-800 font-medium">
                  {deletePreview.warning}
                </p>
              </div>
            )}

            <div className="flex justify-end gap-3 pt-4">
              <button
                type="button"
                onClick={() => {
                  setShowDeleteModal(false);
                  setDeletePreview(null);
                }}
                className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={executeClearData}
                disabled={!deletePreview.can_delete}
                className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {deletePreview.can_delete ? `Delete ${deletePreview.unmatched_count} Transaction(s)` : 'Cannot Delete'}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Edit Bank Statement Line Modal */}
      <Modal
        isOpen={editModal}
        onClose={() => {
          setEditModal(false);
          setEditingLine(null);
        }}
        title="Edit Bank Statement Line"
      >
        {editingLine && (
          <form onSubmit={handleUpdateLine} className="space-y-4">
            <div className="p-3 bg-gray-50 rounded-lg">
              <div className="text-sm text-gray-600 mb-1">Date:</div>
              <div className="font-medium">{new Date(editingLine.date).toLocaleDateString('id-ID')}</div>
              {editingLine.reference && (
                <>
                  <div className="text-sm text-gray-600 mt-2 mb-1">Reference:</div>
                  <div className="font-medium font-mono text-sm">{editingLine.reference}</div>
                </>
              )}
              <div className="text-sm text-gray-600 mt-2 mb-1">Status:</div>
              <div className="inline-flex items-center gap-1.5">
                {editingLine.status === 'matched' && (
                  <>
                    <CheckCircle2 className="w-4 h-4 text-green-600" />
                    <span className="text-green-700 font-medium">Matched</span>
                  </>
                )}
                {editingLine.status === 'recorded' && (
                  <>
                    <CheckCircle2 className="w-4 h-4 text-green-600" />
                    <span className="text-green-700 font-medium">Recorded</span>
                  </>
                )}
                {editingLine.status === 'suggested' && (
                  <>
                    <AlertCircle className="w-4 h-4 text-yellow-600" />
                    <span className="text-yellow-700 font-medium">Suggested</span>
                  </>
                )}
                {editingLine.status === 'unmatched' && (
                  <>
                    <XCircle className="w-4 h-4 text-gray-400" />
                    <span className="text-gray-600 font-medium">Unmatched</span>
                  </>
                )}
              </div>
            </div>

            {(editingLine.matchedExpense || editingLine.matchedReceipt || editingLine.matchedFundTransfer) && (
              <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <FileText className="w-5 h-5 text-blue-600" />
                    <h4 className="font-semibold text-blue-900">Linked Transaction</h4>
                  </div>
                  {canManage && (
                    <button
                      type="button"
                      onClick={handleUnlinkTransaction}
                      className="text-sm text-red-600 hover:text-red-700 font-medium"
                    >
                      Unlink
                    </button>
                  )}
                </div>

                {editingLine.matchedExpense && (
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-gray-600">Type:</span>
                      <span className="font-medium text-gray-900">Expense</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">Category:</span>
                      <span className="font-medium text-gray-900">
                        {expenseCategories.find(c => c.value === editingLine.matchedExpense?.expense_category)?.label || editingLine.matchedExpense.expense_category}
                      </span>
                    </div>
                    {editingLine.matchedExpense.voucher_number && (
                      <div className="flex justify-between">
                        <span className="text-gray-600">Voucher:</span>
                        <span className="font-medium text-gray-900 font-mono">{editingLine.matchedExpense.voucher_number}</span>
                      </div>
                    )}
                    <div className="flex justify-between">
                      <span className="text-gray-600">Amount:</span>
                      <span className="font-medium text-gray-900">
                        {editingLine.currency === 'USD' ? '$' : 'Rp'} {editingLine.matchedExpense.amount.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">Date:</span>
                      <span className="font-medium text-gray-900">
                        {new Date(editingLine.matchedExpense.expense_date).toLocaleDateString('id-ID')}
                      </span>
                    </div>
                    {editingLine.matchedExpense.description && (
                      <div className="pt-2 border-t border-blue-200">
                        <div className="text-gray-600 mb-1">Description:</div>
                        <div className="text-gray-900">{editingLine.matchedExpense.description}</div>
                      </div>
                    )}
                  </div>
                )}

                {editingLine.matchedReceipt && (
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-gray-600">Type:</span>
                      <span className="font-medium text-gray-900">Receipt</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">Payment Number:</span>
                      <span className="font-medium text-gray-900 font-mono">{editingLine.matchedReceipt.payment_number}</span>
                    </div>
                    {editingLine.matchedReceipt.customer_name && (
                      <div className="flex justify-between">
                        <span className="text-gray-600">Customer:</span>
                        <span className="font-medium text-gray-900">{editingLine.matchedReceipt.customer_name}</span>
                      </div>
                    )}
                    <div className="flex justify-between">
                      <span className="text-gray-600">Amount:</span>
                      <span className="font-medium text-gray-900">
                        {editingLine.currency === 'USD' ? '$' : 'Rp'} {editingLine.matchedReceipt.amount.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">Date:</span>
                      <span className="font-medium text-gray-900">
                        {new Date(editingLine.matchedReceipt.payment_date).toLocaleDateString('id-ID')}
                      </span>
                    </div>
                  </div>
                )}

                {editingLine.matchedFundTransfer && (
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-gray-600">Type:</span>
                      <span className="font-medium text-gray-900">Fund Transfer</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">Transfer No:</span>
                      <span className="font-medium text-gray-900 font-mono">{editingLine.matchedFundTransfer.transfer_number}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">From:</span>
                      <span className="font-medium text-gray-900">{editingLine.matchedFundTransfer.from_account_type}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">To:</span>
                      <span className="font-medium text-gray-900">{editingLine.matchedFundTransfer.to_account_type}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">Amount:</span>
                      <span className="font-medium text-gray-900">
                        {editingLine.currency === 'USD' ? '$' : 'Rp'} {editingLine.matchedFundTransfer.amount.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">Date:</span>
                      <span className="font-medium text-gray-900">
                        {new Date(editingLine.matchedFundTransfer.transfer_date).toLocaleDateString('id-ID')}
                      </span>
                    </div>
                    {editingLine.matchedFundTransfer.description && (
                      <div className="pt-2 border-t border-blue-200">
                        <div className="text-gray-600 mb-1">Description:</div>
                        <div className="text-gray-900">{editingLine.matchedFundTransfer.description}</div>
                      </div>
                    )}
                  </div>
                )}

                {editingLine.notes && (
                  <div className="mt-3 pt-3 border-t border-blue-200">
                    <div className="text-xs text-gray-600 mb-1">Match Notes:</div>
                    <div className="text-sm text-gray-700 italic">{editingLine.notes}</div>
                  </div>
                )}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Description
              </label>
              <textarea
                value={editFormData.description}
                onChange={(e) => setEditFormData({ ...editFormData, description: e.target.value })}
                rows={3}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-red-700 mb-1">
                  Debit Amount
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={editFormData.debit}
                  onChange={(e) => setEditFormData({ ...editFormData, debit: parseFloat(e.target.value) || 0, credit: 0 })}
                  className="w-full px-3 py-2 border border-red-300 rounded-lg"
                />
                <p className="text-xs text-gray-500 mt-1">Money OUT (expenses)</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-green-700 mb-1">
                  Credit Amount
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={editFormData.credit}
                  onChange={(e) => setEditFormData({ ...editFormData, credit: parseFloat(e.target.value) || 0, debit: 0 })}
                  className="w-full px-3 py-2 border border-green-300 rounded-lg"
                />
                <p className="text-xs text-gray-500 mt-1">Money IN (receipts)</p>
              </div>
            </div>

            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
              <p className="text-xs text-yellow-800">
                ⚠️ <strong>Note:</strong> Each transaction should have either a Debit OR a Credit amount, not both.
                When you enter one, the other will be cleared.
              </p>
            </div>

            <div className="flex justify-end gap-3 pt-4">
              <button
                type="button"
                onClick={() => {
                  setEditModal(false);
                  setEditingLine(null);
                }}
                className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
              >
                Update
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
