import { useEffect, useState, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { Upload, RefreshCw, CheckCircle2, AlertCircle, XCircle, Plus, Calendar, Landmark } from 'lucide-react';
import * as XLSX from 'xlsx';

interface BankAccount {
  id: string;
  account_name: string;
  bank_name: string;
  account_number: string;
}

interface StatementLine {
  id: string;
  date: string;
  description: string;
  reference: string;
  debit: number;
  credit: number;
  balance: number;
  status: 'matched' | 'suggested' | 'unmatched' | 'created';
  matchedEntry?: string;
}

interface BankReconciliationProps {
  canManage: boolean;
}

export function BankReconciliation({ canManage }: BankReconciliationProps) {
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [selectedBank, setSelectedBank] = useState<string>('');
  const [statementLines, setStatementLines] = useState<StatementLine[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [activeFilter, setActiveFilter] = useState<'all' | 'matched' | 'suggested' | 'unmatched'>('all');
  const [dateRange, setDateRange] = useState({
    start: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0],
    end: new Date().toISOString().split('T')[0],
  });
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadBankAccounts();
  }, []);

  useEffect(() => {
    if (selectedBank) {
      loadStatementLines();
    }
  }, [selectedBank, dateRange]);

  const loadBankAccounts = async () => {
    try {
      const { data, error } = await supabase
        .from('bank_accounts')
        .select('id, account_name, bank_name, account_number')
        .order('account_name');
      if (error) throw error;
      setBankAccounts(data || []);
      if (data && data.length > 0) {
        setSelectedBank(data[0].id);
      }
    } catch (err) {
      console.error('Error loading bank accounts:', err);
    }
  };

  const loadStatementLines = async () => {
    if (!selectedBank) return;
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('bank_statement_lines')
        .select('*')
        .eq('bank_account_id', selectedBank)
        .gte('transaction_date', dateRange.start)
        .lte('transaction_date', dateRange.end)
        .order('transaction_date', { ascending: false });
      
      if (error) throw error;
      
      const lines: StatementLine[] = (data || []).map(row => ({
        id: row.id,
        date: row.transaction_date,
        description: row.description || '',
        reference: row.reference || '',
        debit: row.debit_amount || 0,
        credit: row.credit_amount || 0,
        balance: row.running_balance || 0,
        status: row.reconciliation_status || 'unmatched',
        matchedEntry: row.matched_entry_id,
      }));
      setStatementLines(lines);
    } catch (err) {
      console.error('Error loading statement lines:', err);
      setStatementLines([]);
    } finally {
      setLoading(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !selectedBank) return;

    setUploading(true);
    try {
      const reader = new FileReader();
      reader.onload = async (event) => {
        try {
          const data = event.target?.result;
          const workbook = XLSX.read(data, { type: 'binary' });
          const sheetName = workbook.SheetNames[0];
          const worksheet = workbook.Sheets[sheetName];
          const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as any[][];

          const lines = parseStatementData(jsonData);
          
          if (lines.length === 0) {
            alert('No valid transactions found in the file. Please check the format.');
            return;
          }

          const { data: { user } } = await supabase.auth.getUser();
          
          const insertData = lines.map(line => ({
            bank_account_id: selectedBank,
            transaction_date: line.date,
            description: line.description,
            reference: line.reference,
            debit_amount: line.debit,
            credit_amount: line.credit,
            running_balance: line.balance,
            reconciliation_status: 'unmatched',
            created_by: user?.id,
          }));

          const { error } = await supabase
            .from('bank_statement_lines')
            .insert(insertData);

          if (error) throw error;

          await autoMatchTransactions();
          loadStatementLines();
          alert(`Successfully imported ${lines.length} transactions`);
        } catch (err: any) {
          console.error('Error parsing file:', err);
          alert('Failed to parse file: ' + err.message);
        }
      };
      reader.readAsBinaryString(file);
    } finally {
      setUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const parseStatementData = (rows: any[][]): StatementLine[] => {
    const lines: StatementLine[] = [];
    const headerRow = rows[0] || [];
    
    let dateCol = -1, descCol = -1, refCol = -1, debitCol = -1, creditCol = -1, balanceCol = -1;
    
    headerRow.forEach((cell: any, idx: number) => {
      const cellStr = String(cell || '').toLowerCase();
      if (cellStr.includes('date') || cellStr.includes('tanggal')) dateCol = idx;
      if (cellStr.includes('description') || cellStr.includes('keterangan') || cellStr.includes('uraian')) descCol = idx;
      if (cellStr.includes('ref') || cellStr.includes('no.')) refCol = idx;
      if (cellStr.includes('debit') || cellStr.includes('keluar')) debitCol = idx;
      if (cellStr.includes('credit') || cellStr.includes('kredit') || cellStr.includes('masuk')) creditCol = idx;
      if (cellStr.includes('balance') || cellStr.includes('saldo')) balanceCol = idx;
    });

    if (dateCol === -1) dateCol = 0;
    if (descCol === -1) descCol = 1;
    if (debitCol === -1) debitCol = 2;
    if (creditCol === -1) creditCol = 3;
    if (balanceCol === -1) balanceCol = 4;

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length === 0) continue;

      const dateVal = row[dateCol];
      let parsedDate = '';
      
      if (typeof dateVal === 'number') {
        const excelDate = new Date((dateVal - 25569) * 86400 * 1000);
        parsedDate = excelDate.toISOString().split('T')[0];
      } else if (dateVal) {
        const dateStr = String(dateVal);
        const parts = dateStr.split(/[\/\-\.]/);
        if (parts.length === 3) {
          if (parts[0].length === 4) {
            parsedDate = `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
          } else {
            parsedDate = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
          }
        }
      }

      if (!parsedDate) continue;

      const parseAmount = (val: any): number => {
        if (!val) return 0;
        const str = String(val).replace(/[^\d.-]/g, '');
        return parseFloat(str) || 0;
      };

      lines.push({
        id: `temp-${i}`,
        date: parsedDate,
        description: String(row[descCol] || ''),
        reference: refCol >= 0 ? String(row[refCol] || '') : '',
        debit: parseAmount(row[debitCol]),
        credit: parseAmount(row[creditCol]),
        balance: parseAmount(row[balanceCol]),
        status: 'unmatched',
      });
    }

    return lines;
  };

  const autoMatchTransactions = async () => {
    try {
      const { data: unmatched, error: fetchError } = await supabase
        .from('bank_statement_lines')
        .select('*')
        .eq('bank_account_id', selectedBank)
        .eq('reconciliation_status', 'unmatched');

      if (fetchError) throw fetchError;
      if (!unmatched || unmatched.length === 0) return;

      const { data: journalEntries } = await supabase
        .from('journal_entries')
        .select('id, entry_number, entry_date, description, total_debit')
        .eq('is_posted', true)
        .gte('entry_date', dateRange.start)
        .lte('entry_date', dateRange.end);

      const entries = journalEntries || [];

      for (const line of unmatched) {
        const amount = line.debit_amount || line.credit_amount;
        const lineDate = new Date(line.transaction_date);

        const match = entries.find(entry => {
          const entryDate = new Date(entry.entry_date);
          const dateDiff = Math.abs(lineDate.getTime() - entryDate.getTime()) / (1000 * 60 * 60 * 24);
          const amountMatch = Math.abs(entry.total_debit - amount) < 10000;
          
          return dateDiff <= 3 && amountMatch;
        });

        if (match) {
          await supabase
            .from('bank_statement_lines')
            .update({
              reconciliation_status: 'suggested',
              matched_entry_id: match.id,
            })
            .eq('id', line.id);
        }
      }
    } catch (err) {
      console.error('Error auto-matching:', err);
    }
  };

  const confirmMatch = async (lineId: string) => {
    try {
      await supabase
        .from('bank_statement_lines')
        .update({ reconciliation_status: 'matched' })
        .eq('id', lineId);
      loadStatementLines();
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
      loadStatementLines();
    } catch (err) {
      console.error('Error rejecting match:', err);
    }
  };

  const filteredLines = statementLines.filter(line => {
    if (activeFilter === 'all') return true;
    return line.status === activeFilter;
  });

  const stats = {
    total: statementLines.length,
    matched: statementLines.filter(l => l.status === 'matched').length,
    suggested: statementLines.filter(l => l.status === 'suggested').length,
    unmatched: statementLines.filter(l => l.status === 'unmatched').length,
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <select
            value={selectedBank}
            onChange={(e) => setSelectedBank(e.target.value)}
            className="px-3 py-1.5 text-sm border rounded-lg focus:ring-2 focus:ring-blue-500"
          >
            {bankAccounts.map(bank => (
              <option key={bank.id} value={bank.id}>
                {bank.bank_name} - {bank.account_number}
              </option>
            ))}
          </select>
          <div className="flex items-center gap-2 text-sm">
            <Calendar className="w-4 h-4 text-gray-400" />
            <input
              type="date"
              value={dateRange.start}
              onChange={(e) => setDateRange({ ...dateRange, start: e.target.value })}
              className="px-2 py-1 border rounded text-sm"
            />
            <span className="text-gray-400">to</span>
            <input
              type="date"
              value={dateRange.end}
              onChange={(e) => setDateRange({ ...dateRange, end: e.target.value })}
              className="px-2 py-1 border rounded text-sm"
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { autoMatchTransactions(); loadStatementLines(); }}
            className="flex items-center gap-1 px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200"
          >
            <RefreshCw className="w-4 h-4" />
            Auto-Match
          </button>
          {canManage && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={handleFileUpload}
                className="hidden"
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading || !selectedBank}
                className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                <Upload className="w-4 h-4" />
                {uploading ? 'Uploading...' : 'Upload Statement'}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="grid grid-cols-4 gap-3">
        <button
          onClick={() => setActiveFilter('all')}
          className={`p-3 rounded-lg text-left transition ${
            activeFilter === 'all' ? 'bg-blue-50 border-2 border-blue-500' : 'bg-gray-50 border border-gray-200'
          }`}
        >
          <div className="text-2xl font-bold text-gray-900">{stats.total}</div>
          <div className="text-xs text-gray-500">Total Transactions</div>
        </button>
        <button
          onClick={() => setActiveFilter('matched')}
          className={`p-3 rounded-lg text-left transition ${
            activeFilter === 'matched' ? 'bg-green-50 border-2 border-green-500' : 'bg-gray-50 border border-gray-200'
          }`}
        >
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-5 h-5 text-green-600" />
            <span className="text-2xl font-bold text-green-700">{stats.matched}</span>
          </div>
          <div className="text-xs text-gray-500">Matched</div>
        </button>
        <button
          onClick={() => setActiveFilter('suggested')}
          className={`p-3 rounded-lg text-left transition ${
            activeFilter === 'suggested' ? 'bg-yellow-50 border-2 border-yellow-500' : 'bg-gray-50 border border-gray-200'
          }`}
        >
          <div className="flex items-center gap-2">
            <AlertCircle className="w-5 h-5 text-yellow-600" />
            <span className="text-2xl font-bold text-yellow-700">{stats.suggested}</span>
          </div>
          <div className="text-xs text-gray-500">Suggested Match</div>
        </button>
        <button
          onClick={() => setActiveFilter('unmatched')}
          className={`p-3 rounded-lg text-left transition ${
            activeFilter === 'unmatched' ? 'bg-red-50 border-2 border-red-500' : 'bg-gray-50 border border-gray-200'
          }`}
        >
          <div className="flex items-center gap-2">
            <XCircle className="w-5 h-5 text-red-600" />
            <span className="text-2xl font-bold text-red-700">{stats.unmatched}</span>
          </div>
          <div className="text-xs text-gray-500">Unmatched</div>
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="w-6 h-6 animate-spin text-blue-600" />
        </div>
      ) : filteredLines.length === 0 ? (
        <div className="text-center py-12 bg-gray-50 rounded-lg border-2 border-dashed">
          <Landmark className="w-12 h-12 text-gray-300 mx-auto mb-3" />
          <h3 className="text-lg font-medium text-gray-600 mb-1">No Bank Transactions</h3>
          <p className="text-sm text-gray-500 mb-4">
            Upload a bank statement (Excel/CSV) to start reconciling
          </p>
          {canManage && (
            <button
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              <Upload className="w-4 h-4" />
              Upload BCA Statement
            </button>
          )}
        </div>
      ) : (
        <div className="bg-white border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-gray-600">Date</th>
                <th className="px-3 py-2 text-left font-medium text-gray-600">Description</th>
                <th className="px-3 py-2 text-left font-medium text-gray-600">Reference</th>
                <th className="px-3 py-2 text-right font-medium text-gray-600">Debit</th>
                <th className="px-3 py-2 text-right font-medium text-gray-600">Credit</th>
                <th className="px-3 py-2 text-center font-medium text-gray-600">Status</th>
                <th className="px-3 py-2 text-center font-medium text-gray-600">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filteredLines.map(line => (
                <tr key={line.id} className="hover:bg-gray-50">
                  <td className="px-3 py-2 text-gray-700">
                    {new Date(line.date).toLocaleDateString('id-ID')}
                  </td>
                  <td className="px-3 py-2 text-gray-700 max-w-xs truncate">{line.description}</td>
                  <td className="px-3 py-2 text-gray-500 font-mono text-xs">{line.reference || '-'}</td>
                  <td className="px-3 py-2 text-right text-red-600 font-medium">
                    {line.debit > 0 ? `Rp ${line.debit.toLocaleString('id-ID')}` : '-'}
                  </td>
                  <td className="px-3 py-2 text-right text-green-600 font-medium">
                    {line.credit > 0 ? `Rp ${line.credit.toLocaleString('id-ID')}` : '-'}
                  </td>
                  <td className="px-3 py-2 text-center">
                    {line.status === 'matched' && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
                        <CheckCircle2 className="w-3 h-3" /> Matched
                      </span>
                    )}
                    {line.status === 'suggested' && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-700">
                        <AlertCircle className="w-3 h-3" /> Review
                      </span>
                    )}
                    {line.status === 'unmatched' && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">
                        <XCircle className="w-3 h-3" /> Unmatched
                      </span>
                    )}
                    {line.status === 'created' && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">
                        <Plus className="w-3 h-3" /> Created
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-center">
                    {line.status === 'suggested' && (
                      <div className="flex items-center justify-center gap-1">
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
                      </div>
                    )}
                    {line.status === 'unmatched' && canManage && (
                      <button
                        className="flex items-center gap-1 px-2 py-1 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200"
                        title="Create Entry"
                      >
                        <Plus className="w-3 h-3" />
                        Create
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
