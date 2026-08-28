import { useEffect, useState, useRef, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { useFinance } from '../../contexts/FinanceContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { saveFinanceJournal } from '../../services/financeCommands';
import {
  Plus, Trash2, Search, Eye, BookOpen, FileText,
  ChevronDown, X, Loader2, Save, RotateCcw
} from 'lucide-react';
import { showToast } from '../ToastNotification';
import { FinanceModal as Modal } from './FinanceModal';
import { SapRow, SapField, SAP_INPUT } from './SapLayout';
import { MoneyInput } from '../MoneyInput';

interface Account {
  id: string;
  code: string;
  name: string;
  account_type: string;
  normal_balance: string;
}

interface JournalLine {
  key: string;
  account_id: string;
  account_code: string;
  account_name: string;
  description: string;
  debit: number;
  credit: number;
}

interface JournalEntry {
  id: string;
  entry_number: string;
  entry_date: string;
  description: string;
  source_module: string;
  total_debit: number;
  total_credit: number;
  is_posted: boolean;
  created_at: string;
}

interface JournalEntryDetail extends JournalEntry {
  lines: {
    line_number: number;
    account_id: string;
    description: string;
    debit: number;
    credit: number;
    chart_of_accounts: { code: string; name: string } | null;
  }[];
}

interface Template {
  name: string;
  description: string;
  lines: { accountCode: string; side: 'debit' | 'credit'; label: string }[];
}

interface GeneralJournalEntryProps {
  canManage: boolean;
  onNavigateToLedger: () => void;
  initialEditEntryId?: string | null;
  onEditComplete?: () => void;
}

const TEMPLATES: Template[] = [
  {
    name: 'Loan Received',
    description: 'Bank loan received into account',
    lines: [
      { accountCode: '111101', side: 'debit', label: 'Bank BCA - IDR' },
      { accountCode: '2210', side: 'credit', label: 'Bank Loans' },
    ],
  },
  {
    name: 'Loan Repayment',
    description: 'Repay bank loan from account',
    lines: [
      { accountCode: '2210', side: 'debit', label: 'Bank Loans' },
      { accountCode: '111101', side: 'credit', label: 'Bank BCA - IDR' },
    ],
  },
  {
    name: 'Loan Given',
    description: 'Loan given to external party',
    lines: [
      { accountCode: '1310', side: 'debit', label: 'Loan Receivable' },
      { accountCode: '111101', side: 'credit', label: 'Bank BCA - IDR' },
    ],
  },
  {
    name: 'Director Loan',
    description: 'Loan from director/owner',
    lines: [
      { accountCode: '111101', side: 'debit', label: 'Bank BCA - IDR' },
      { accountCode: '2220', side: 'credit', label: 'Loan from Vijay Lunkad' },
    ],
  },
  {
    name: 'Owner Contribution',
    description: 'Capital injected by owner into the business bank account',
    lines: [
      { accountCode: '111101', side: 'debit', label: 'Bank BCA - IDR' },
      { accountCode: '3100', side: 'credit', label: 'Owner Capital' },
    ],
  },
  {
    name: 'Staff Advance',
    description: 'Advance given to staff',
    lines: [
      { accountCode: '1160', side: 'debit', label: 'Staff Advances & Loans' },
      { accountCode: '1102', side: 'credit', label: 'Petty Cash' },
    ],
  },
  {
    name: 'Advance Recovery',
    description: 'Recover advance from staff salary',
    lines: [
      { accountCode: '6100', side: 'debit', label: 'Salaries & Wages' },
      { accountCode: '1160', side: 'credit', label: 'Staff Advances & Loans' },
    ],
  },
  {
    name: 'Salary Adjustment',
    description: 'Adjust salary or bonus entries',
    lines: [
      { accountCode: '6100', side: 'debit', label: 'Salaries & Wages' },
      { accountCode: '111101', side: 'credit', label: 'Bank BCA - IDR' },
    ],
  },
  {
    name: 'Interest Payment',
    description: 'Pay interest on loan',
    lines: [
      { accountCode: '7200', side: 'debit', label: 'Interest Expense' },
      { accountCode: '111101', side: 'credit', label: 'Bank BCA - IDR' },
    ],
  },
];

function createEmptyLine(): JournalLine {
  return {
    key: crypto.randomUUID(),
    account_id: '',
    account_code: '',
    account_name: '',
    description: '',
    debit: 0,
    credit: 0,
  };
}

export function GeneralJournalEntry({ canManage, onNavigateToLedger, initialEditEntryId, onEditComplete }: GeneralJournalEntryProps) {
  const { dateRange, triggerRefresh, refreshTrigger } = useFinance();
  const { t } = useLanguage();

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [entryDate, setEntryDate] = useState(new Date().toISOString().split('T')[0]);
  const [narration, setNarration] = useState('');
  const [lines, setLines] = useState<JournalLine[]>([createEmptyLine(), createEmptyLine()]);

  const [searchOpen, setSearchOpen] = useState<number | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const searchRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const [viewEntry, setViewEntry] = useState<JournalEntryDetail | null>(null);
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);

  const [templateOpen, setTemplateOpen] = useState(false);
  const templateRef = useRef<HTMLDivElement>(null);

  const totalDebit = lines.reduce((s, l) => s + (l.debit || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (l.credit || 0), 0);
  const isBalanced = totalDebit > 0 && Math.abs(totalDebit - totalCredit) < 0.01;
  const hasAccounts = lines.filter(l => l.account_id).length >= 2;

  const loadAccounts = useCallback(async () => {
    const { data } = await supabase
      .from('chart_of_accounts')
      .select('id, code, name, account_type, normal_balance')
      .eq('is_header', false)
      .eq('is_active', true)
      .order('code');
    if (data) setAccounts(data);
  }, []);

  const loadEntries = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from('journal_entries')
      .select('id, entry_number, entry_date, description, source_module, total_debit, total_credit, is_posted, created_at')
      .eq('source_module', 'manual')
      .gte('entry_date', dateRange.startDate)
      .lte('entry_date', dateRange.endDate)
      .order('created_at', { ascending: false });
    if (data) setEntries(data);
    setLoading(false);
  }, [dateRange]);

  useEffect(() => { loadAccounts(); }, [loadAccounts]);
  useEffect(() => { loadEntries(); }, [loadEntries, refreshTrigger]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setSearchOpen(null);
      }
      if (templateRef.current && !templateRef.current.contains(e.target as Node)) {
        setTemplateOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (searchOpen !== null && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [searchOpen]);

  const filteredAccounts = accounts.filter(a => {
    if (!searchTerm) return true;
    const q = searchTerm.toLowerCase();
    return a.code.toLowerCase().includes(q) || a.name.toLowerCase().includes(q);
  });

  const updateLine = (index: number, field: keyof JournalLine, value: string | number) => {
    setLines(prev => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      if (field === 'debit' && (value as number) > 0) {
        updated[index].credit = 0;
      } else if (field === 'credit' && (value as number) > 0) {
        updated[index].debit = 0;
      }
      return updated;
    });
  };

  const selectAccount = (index: number, account: Account) => {
    setLines(prev => {
      const updated = [...prev];
      updated[index] = {
        ...updated[index],
        account_id: account.id,
        account_code: account.code,
        account_name: account.name,
      };
      return updated;
    });
    setSearchOpen(null);
    setSearchTerm('');
  };

  const removeLine = (index: number) => {
    if (lines.length <= 2) return;
    setLines(prev => prev.filter((_, i) => i !== index));
  };

  const addLine = () => {
    setLines(prev => [...prev, createEmptyLine()]);
  };

  const resetForm = () => {
    setEntryDate(new Date().toISOString().split('T')[0]);
    setNarration('');
    setLines([createEmptyLine(), createEmptyLine()]);
    setEditingEntryId(null);
  };

  const applyTemplate = (template: Template) => {
    const newLines: JournalLine[] = template.lines.map(tl => {
      const acc = accounts.find(a => a.code === tl.accountCode);
      return {
        key: crypto.randomUUID(),
        account_id: acc?.id || '',
        account_code: acc?.code || tl.accountCode,
        account_name: acc?.name || tl.label,
        description: '',
        debit: tl.side === 'debit' ? 0 : 0,
        credit: tl.side === 'credit' ? 0 : 0,
      };
    });
    setNarration(template.description);
    setLines(newLines);
    setTemplateOpen(false);
  };

  const validateBeforePost = (): string | null => {
    if (!hasAccounts) return 'Please select an account for each journal line with an amount';
    if (totalDebit <= 0 && totalCredit <= 0) return 'Please enter at least one debit/credit amount';
    if (!isBalanced) return `Journal is unbalanced. Debit ${formatCurrency(totalDebit)} must equal Credit ${formatCurrency(totalCredit)}`;
    return null;
  };

  const handlePost = async () => {
    const validationError = validateBeforePost();
    if (validationError) {
      showToast({ type: 'error', title: 'Validation Failed', message: validationError });
      return;
    }

    setSaving(true);

    try {
      const entryId = await saveFinanceJournal(
        editingEntryId,
        entryDate,
        narration || null,
        lines
          .filter(l => l.account_id && (l.debit > 0 || l.credit > 0))
          .map(l => ({
            account_id: l.account_id,
            description: l.description || null,
            debit: l.debit || 0,
            credit: l.credit || 0,
          })),
        'IDR',
        1,
      );

      const { data: savedEntry } = await supabase
        .from('journal_entries')
        .select('entry_number')
        .eq('id', entryId)
        .single();
      showToast({
        type: 'success',
        title: editingEntryId ? 'Journal Updated' : 'Journal Posted',
        message: editingEntryId ? 'Entry updated successfully' : `Entry ${savedEntry?.entry_number || ''} posted successfully`,
      });
      resetForm();
      triggerRefresh();
    } catch (err: any) {
      showToast({ type: 'error', title: 'Posting Failed', message: err.message || 'Could not post journal entry' });
    } finally {
      setSaving(false);
    }
  };

  const viewEntryDetail = async (entry: JournalEntry) => {
    const { data } = await supabase
      .from('journal_entry_lines')
      .select('line_number, account_id, description, debit, credit, chart_of_accounts(code, name)')
      .eq('journal_entry_id', entry.id)
      .order('line_number');

    setViewEntry({ ...entry, lines: (data || []) as any });
    setViewModalOpen(true);
  };

  const handleEditEntry = async (entry: JournalEntry) => {
    const { data: lineData } = await supabase
      .from('journal_entry_lines')
      .select('line_number, account_id, description, debit, credit, chart_of_accounts(code, name)')
      .eq('journal_entry_id', entry.id)
      .order('line_number');

    if (lineData && lineData.length > 0) {
      setEntryDate(entry.entry_date);
      setNarration(entry.description || '');
      setLines(lineData.map((l: any) => ({
        key: crypto.randomUUID(),
        account_id: l.account_id,
        account_code: l.chart_of_accounts?.code || '',
        account_name: l.chart_of_accounts?.name || '',
        description: l.description || '',
        debit: l.debit || 0,
        credit: l.credit || 0,
      })));
      setEditingEntryId(entry.id);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  useEffect(() => {
    if (initialEditEntryId && entries.length > 0) {
      const entry = entries.find(e => e.id === initialEditEntryId);
      if (entry) {
        handleEditEntry(entry);
        onEditComplete?.();
      }
    }
  }, [initialEditEntryId, entries]);

  const handleDeleteEntry = async (entryId: string) => {
    const { showConfirm } = await import('../ConfirmDialog');
    const confirmed = await showConfirm({
      title: 'Delete Journal Entry',
      message: 'Are you sure you want to delete this manual journal entry? This cannot be undone.',
      confirmLabel: 'Delete',
      variant: 'danger',
    });
    if (!confirmed) return;

    try {
      const { data: bankLinks } = await supabase
        .from('bank_statement_lines')
        .select('id')
        .eq('matched_entry_id', entryId)
        .limit(1);

      if (bankLinks && bankLinks.length > 0) {
        showToast({ type: 'error', title: 'Cannot Delete', message: 'This entry is linked to a bank statement. Unlink it first from Bank Reconciliation.' });
        return;
      }

      const { error: linesError } = await supabase
        .from('journal_entry_lines')
        .delete()
        .eq('journal_entry_id', entryId);
      if (linesError) throw linesError;

      const { error: entryError } = await supabase
        .from('journal_entries')
        .delete()
        .eq('id', entryId)
        .eq('source_module', 'manual');
      if (entryError) throw entryError;

      showToast({ type: 'success', title: 'Journal Deleted', message: 'Journal entry deleted successfully' });
      loadEntries();
    } catch (error: any) {
      showToast({ type: 'error', title: 'Delete Failed', message: error.message });
    }
  };

  const formatCurrency = (val: number) => {
    if (!val) return '-';
    return new Intl.NumberFormat('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(val);
  };

  return (
    <div className="flex flex-col gap-1.5">
      {/* Shared title strip — matches every other Finance page */}
      <div className="flex items-center justify-between h-8 px-2 bg-white border border-gray-200 rounded">
        <div className="flex items-baseline gap-2 min-w-0">
          <h1 className="text-xs font-bold text-gray-900 truncate">Journal Voucher</h1>
          <span className="text-[10px] text-gray-400 truncate">Manual double-entry journal posting</span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <div className="relative" ref={templateRef}>
            <button
              onClick={() => setTemplateOpen(!templateOpen)}
              className="inline-flex items-center gap-1 h-7 px-2 text-xs bg-white hover:bg-gray-50 text-gray-700 rounded border border-gray-300"
            >
              <FileText className="w-3 h-3" />
              Templates
              <ChevronDown className="w-3 h-3" />
            </button>
            {templateOpen && (
              <div className="absolute right-0 top-full mt-1 w-72 bg-white rounded-lg shadow-xl border border-gray-200 z-50 py-1 max-h-80 overflow-y-auto">
                {TEMPLATES.map(t => (
                  <button
                    key={t.name}
                    onClick={() => applyTemplate(t)}
                    className="w-full text-left px-2 py-1.5 hover:bg-blue-50 transition-colors"
                  >
                    <div className="text-xs font-medium text-gray-900">{t.name}</div>
                    <div className="text-[10px] text-gray-500">{t.description}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {canManage && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
          {/* Entry header — SAP B1 layout */}
          <div className="p-2 border-b border-gray-100">
            <SapRow>
              <SapField label="Date" required span={4}>
                <input type="date" value={entryDate}
                  onChange={e => setEntryDate(e.target.value)}
                  className={SAP_INPUT} />
              </SapField>
              <SapField label="Narration" span={8}>
                <input type="text" value={narration}
                  onChange={e => setNarration(e.target.value)}
                  placeholder={t.finance.journalNarrationPlaceholder}
                  className={SAP_INPUT} />
              </SapField>
            </SapRow>
          </div>

          {/* Journal lines grid */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-gray-600">
                  <th className="text-left px-2 py-1.5 font-medium w-10">#</th>
                  <th className="text-left px-2 py-1.5 font-medium min-w-[280px]">Account</th>
                  <th className="text-left px-2 py-1.5 font-medium min-w-[160px]">Line Narration</th>
                  <th className="text-right px-2 py-1.5 font-medium w-36">Debit</th>
                  <th className="text-right px-2 py-1.5 font-medium w-36">Credit</th>
                  <th className="text-center px-2 py-2.5 font-medium w-20">Actions</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line, idx) => (
                  <tr key={line.key} className="border-t border-gray-100 hover:bg-gray-50/50">
                    <td className="px-4 py-2 text-gray-400 text-xs">{idx + 1}</td>
                    <td className="px-4 py-2 relative">
                      {searchOpen === idx ? (
                        <div ref={searchRef} className="relative">
                          <div className="flex items-center border border-blue-400 rounded-lg bg-white shadow-sm">
                            <Search className="w-4 h-4 text-gray-400 ml-2 shrink-0" />
                            <input
                              ref={searchInputRef}
                              type="text"
                              value={searchTerm}
                              onChange={e => setSearchTerm(e.target.value)}
                              placeholder="Search account..."
                              className="w-full px-2 py-1.5 text-sm border-0 focus:ring-0 focus:outline-none"
                            />
                            <button onClick={() => { setSearchOpen(null); setSearchTerm(''); }} className="p-1 mr-1">
                              <X className="w-4 h-4 text-gray-400" />
                            </button>
                          </div>
                          <div className="absolute left-0 top-full mt-1 w-full bg-white rounded-lg shadow-xl border border-gray-200 z-50 max-h-48 overflow-y-auto">
                            {filteredAccounts.length === 0 ? (
                              <div className="px-2 py-1.5 text-sm text-gray-400">No accounts found</div>
                            ) : (
                              filteredAccounts.map(acc => (
                                <button
                                  key={acc.id}
                                  onClick={() => selectAccount(idx, acc)}
                                  className="w-full text-left px-3 py-2 hover:bg-blue-50 flex items-center gap-2 transition-colors"
                                >
                                  <span className="text-xs font-mono text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded">{acc.code}</span>
                                  <span className="text-sm text-gray-800 truncate">{acc.name}</span>
                                  <span className="text-xs text-gray-400 ml-auto shrink-0">{acc.account_type}</span>
                                </button>
                              ))
                            )}
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => { setSearchOpen(idx); setSearchTerm(''); }}
                            className={`flex-1 text-left px-3 py-1.5 rounded-lg border transition-colors text-sm ${
                              line.account_id
                                ? 'border-gray-200 bg-white hover:border-gray-300'
                                : 'border-dashed border-gray-300 text-gray-400 hover:border-blue-400 hover:text-blue-500'
                            }`}
                          >
                            {line.account_id ? (
                              <span>
                                <span className="font-mono text-blue-600 mr-1.5">{line.account_code}</span>
                                {line.account_name}
                              </span>
                            ) : (
                              'Select account...'
                            )}
                          </button>
                          {line.account_id && (
                            <button
                              onClick={onNavigateToLedger}
                              title="View Ledger"
                              className="p-1 text-gray-400 hover:text-blue-600 transition-colors"
                            >
                              <BookOpen className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <input
                        type="text"
                        value={line.description}
                        onChange={e => updateLine(idx, 'description', e.target.value)}
                        placeholder="Optional"
                        className="w-full px-2.5 py-1.5 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      />
                    </td>
                    <td className="px-4 py-2">
                      <MoneyInput
                        decimal
                        value={line.debit}
                        onChange={amount => updateLine(idx, 'debit', amount)}
                        placeholder="0"
                        className="w-full px-2.5 py-1.5 text-sm text-right border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 tabular-nums"
                      />
                    </td>
                    <td className="px-4 py-2">
                      <MoneyInput
                        decimal
                        value={line.credit}
                        onChange={amount => updateLine(idx, 'credit', amount)}
                        placeholder="0"
                        className="w-full px-2.5 py-1.5 text-sm text-right border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 tabular-nums"
                      />
                    </td>
                    <td className="px-2 py-2 text-center">
                      <button
                        onClick={() => removeLine(idx)}
                        disabled={lines.length <= 2}
                        className="p-1 text-gray-400 hover:text-red-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-gray-300 bg-gray-50 font-semibold">
                  <td className="px-2 py-1.5" colSpan={3}>
                    <button
                      onClick={addLine}
                      className="flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-800 transition-colors"
                    >
                      <Plus className="w-4 h-4" /> Add Row
                    </button>
                  </td>
                  <td className={`px-2 py-1.5 text-right tabular-nums ${totalDebit !== totalCredit ? 'text-red-600' : 'text-gray-900'}`}>
                    {formatCurrency(totalDebit)}
                  </td>
                  <td className={`px-2 py-1.5 text-right tabular-nums ${totalDebit !== totalCredit ? 'text-red-600' : 'text-gray-900'}`}>
                    {formatCurrency(totalCredit)}
                  </td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Difference indicator + actions */}
          <div className="p-4 border-t border-gray-100 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
            <div>
              {totalDebit > 0 && !isBalanced && (
                <span className="text-sm text-red-600 font-medium">
                  Difference: {formatCurrency(Math.abs(totalDebit - totalCredit))} {totalDebit > totalCredit ? '(Debit excess)' : '(Credit excess)'}
                </span>
              )}
              {isBalanced && hasAccounts && !editingEntryId && (
                <span className="text-sm text-green-600 font-medium">Balanced - ready to post</span>
              )}
              {editingEntryId && (
                <span className="text-sm text-orange-600 font-medium">Editing mode - make changes and click Update Journal</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={resetForm}
                className="flex items-center gap-1.5 px-4 py-2 text-sm text-gray-600 hover:text-gray-800 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                <RotateCcw className="w-4 h-4" /> Clear
              </button>
              <button
                onClick={handlePost}
                disabled={!isBalanced || !hasAccounts || saving}
                className="flex items-center gap-1.5 px-5 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                {saving ? (editingEntryId ? 'Updating...' : 'Posting...') : (editingEntryId ? 'Update Journal' : 'Post Journal')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Existing entries list */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
        <div className="px-2 py-1.5 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-700">{t.finance.journalEntry}</h3>
        </div>
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
          </div>
        ) : entries.length === 0 ? (
          <div className="text-center py-12 text-gray-400 text-sm">
            No manual journal entries in selected date range
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-gray-600 text-xs uppercase">
                  <th className="text-left px-2 py-1.5 font-medium">Entry #</th>
                  <th className="text-left px-2 py-1.5 font-medium">Date</th>
                  <th className="text-left px-2 py-1.5 font-medium">Description</th>
                  <th className="text-right px-2 py-1.5 font-medium">Debit</th>
                  <th className="text-right px-2 py-1.5 font-medium">Credit</th>
                  <th className="text-center px-2 py-1.5 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {entries.map(e => (
                  <tr key={e.id} className="border-t border-gray-100 hover:bg-gray-50/80 transition-colors">
                    <td className="px-2 py-1.5 font-mono text-blue-700 font-medium">{e.entry_number}</td>
                    <td className="px-2 py-1.5 text-gray-600">{new Date(e.entry_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</td>
                    <td className="px-2 py-1.5 text-gray-800 max-w-xs truncate">{e.description || '-'}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{formatCurrency(e.total_debit)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{formatCurrency(e.total_credit)}</td>
                    <td className="px-2 py-1.5 text-center">
                      <div className="flex items-center justify-center gap-1.5">
                        <button
                          onClick={() => viewEntryDetail(e)}
                          className="p-1 text-gray-400 hover:text-blue-600 transition-colors"
                          title="View"
                        >
                          <Eye className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleEditEntry(e)}
                          className="p-1 text-gray-400 hover:text-gray-700 transition-colors"
                          title="Edit"
                        >
                          <BookOpen className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDeleteEntry(e.id)}
                          className="p-1 text-gray-400 hover:text-red-600 transition-colors"
                          title="Delete"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* View detail modal */}
      {viewEntry && (
        <Modal isOpen={viewModalOpen} title={`Journal Entry: ${viewEntry.entry_number}`} onClose={() => setViewModalOpen(false)} size="lg">
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-gray-500">Date:</span>{' '}
                <span className="font-medium">{new Date(viewEntry.entry_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</span>
              </div>
              <div>
                <span className="text-gray-500">Status:</span>{' '}
                <span className={`inline-flex px-2 py-0.5 text-xs rounded-full font-medium ${viewEntry.is_posted ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}`}>
                  {viewEntry.is_posted ? 'Posted' : 'Draft'}
                </span>
              </div>
            </div>
            {viewEntry.description && (
              <div className="text-sm">
                <span className="text-gray-500">Description:</span>{' '}
                <span className="text-gray-800">{viewEntry.description}</span>
              </div>
            )}
            <table className="w-full text-sm border border-gray-200 rounded-lg overflow-hidden">
              <thead>
                <tr className="bg-gray-50 text-gray-600">
                  <th className="text-left px-4 py-2 font-medium">#</th>
                  <th className="text-left px-4 py-2 font-medium">Account</th>
                  <th className="text-left px-4 py-2 font-medium">Description</th>
                  <th className="text-right px-4 py-2 font-medium">Debit</th>
                  <th className="text-right px-4 py-2 font-medium">Credit</th>
                </tr>
              </thead>
              <tbody>
                {viewEntry.lines.map(l => (
                  <tr key={l.line_number} className="border-t border-gray-100">
                    <td className="px-4 py-2 text-gray-400">{l.line_number}</td>
                    <td className="px-4 py-2">
                      <span className="font-mono text-blue-600 mr-1">{l.chart_of_accounts?.code}</span>
                      {l.chart_of_accounts?.name}
                    </td>
                    <td className="px-4 py-2 text-gray-600">{l.description || '-'}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{l.debit > 0 ? formatCurrency(l.debit) : '-'}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{l.credit > 0 ? formatCurrency(l.credit) : '-'}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-gray-300 bg-gray-50 font-semibold">
                  <td colSpan={3} className="px-4 py-2 text-right">Total</td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatCurrency(viewEntry.total_debit)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatCurrency(viewEntry.total_credit)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Modal>
      )}
    </div>
  );
}
