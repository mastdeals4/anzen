import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { Calendar, RefreshCw } from 'lucide-react';

interface TrialBalanceRow {
  code: string;
  name: string;
  name_id: string | null;
  account_type: string;
  account_group: string | null;
  normal_balance: string;
  total_debit: number;
  total_credit: number;
  balance: number;
}

type ReportType = 'trial_balance' | 'pnl' | 'balance_sheet';

interface FinancialReportsProps {
  initialReport?: ReportType;
}

export function FinancialReports({ initialReport = 'trial_balance' }: FinancialReportsProps) {
  const [reportType, setReportType] = useState<ReportType>(initialReport);
  const [loading, setLoading] = useState(false);
  const [trialBalance, setTrialBalance] = useState<TrialBalanceRow[]>([]);
  const [dateRange, setDateRange] = useState({
    start: new Date(new Date().getFullYear(), 0, 1).toISOString().split('T')[0],
    end: new Date().toISOString().split('T')[0],
  });

  useEffect(() => {
    loadReport();
  }, [reportType, dateRange]);

  const loadReport = async () => {
    setLoading(true);
    try {
      // Try to use the RPC function with date range
      const { data: rpcData, error: rpcError } = await supabase.rpc('get_trial_balance', {
        p_start_date: dateRange.start,
        p_end_date: dateRange.end,
      });

      if (!rpcError && rpcData) {
        setTrialBalance(rpcData);
      } else {
        // Fallback to view if function not available yet
        const { data, error } = await supabase
          .from('trial_balance_view')
          .select('*')
          .order('code');

        if (error) throw error;
        setTrialBalance(data || []);
      }
    } catch (error) {
      console.error('Error loading report:', error);
    } finally {
      setLoading(false);
    }
  };

  const totals = trialBalance.reduce((acc, row) => ({
    debit: acc.debit + row.total_debit,
    credit: acc.credit + row.total_credit,
  }), { debit: 0, credit: 0 });

  const revenue = trialBalance.filter(r => r.account_type === 'revenue').reduce((sum, r) => sum + Math.abs(r.balance), 0);
  const expenses = trialBalance.filter(r => r.account_type === 'expense').reduce((sum, r) => sum + Math.abs(r.balance), 0);
  const netIncome = revenue - expenses;

  const assets = trialBalance.filter(r => r.account_type === 'asset').reduce((sum, r) => sum + r.balance, 0);
  const contraAssets = trialBalance.filter(r => r.account_type === 'contra' && r.account_group?.includes('Assets')).reduce((sum, r) => sum + Math.abs(r.balance), 0);
  const liabilities = trialBalance.filter(r => r.account_type === 'liability').reduce((sum, r) => sum + Math.abs(r.balance), 0);
  const equity = trialBalance.filter(r => r.account_type === 'equity').reduce((sum, r) => sum + Math.abs(r.balance), 0);

  const reportTabs = [
    { id: 'trial_balance', label: 'Trial Balance' },
    { id: 'pnl', label: 'Profit & Loss' },
    { id: 'balance_sheet', label: 'Balance Sheet' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex gap-2">
          {reportTabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setReportType(tab.id as ReportType)}
              className={`px-4 py-2 rounded-lg font-medium transition ${
                reportType === tab.id
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-gray-500" />
            <input
              type="date"
              value={dateRange.start}
              onChange={(e) => setDateRange({ ...dateRange, start: e.target.value })}
              className="px-3 py-2 border border-gray-300 rounded-lg"
            />
            <span className="text-gray-500">to</span>
            <input
              type="date"
              value={dateRange.end}
              onChange={(e) => setDateRange({ ...dateRange, end: e.target.value })}
              className="px-3 py-2 border border-gray-300 rounded-lg"
            />
          </div>
          <button
            onClick={loadReport}
            className="flex items-center gap-2 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200"
          >
            <RefreshCw className="w-4 h-4" />
            Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        </div>
      ) : (
        <>
          {reportType === 'trial_balance' && (
            <div className="bg-white rounded-lg shadow overflow-hidden">
              <div className="p-4 border-b bg-gray-50">
                <h3 className="font-semibold text-lg">Trial Balance</h3>
                <p className="text-sm text-gray-500">As of {new Date(dateRange.end).toLocaleDateString('id-ID')}</p>
              </div>
              <table className="w-full">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Code</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Account Name</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Debit</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Credit</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {trialBalance.map(row => (
                    <tr key={row.code} className="hover:bg-gray-50">
                      <td className="px-4 py-2 font-mono text-sm">{row.code}</td>
                      <td className="px-4 py-2">
                        <div>{row.name}</div>
                        {row.name_id && <div className="text-sm text-gray-500">{row.name_id}</div>}
                      </td>
                      <td className="px-4 py-2 text-right text-blue-600">
                        {row.balance > 0 ? `Rp ${row.balance.toLocaleString('id-ID')}` : ''}
                      </td>
                      <td className="px-4 py-2 text-right text-green-600">
                        {row.balance < 0 ? `Rp ${Math.abs(row.balance).toLocaleString('id-ID')}` : ''}
                      </td>
                    </tr>
                  ))}
                  {trialBalance.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-4 py-8 text-center text-gray-500">
                        No transactions found
                      </td>
                    </tr>
                  )}
                </tbody>
                <tfoot className="bg-gray-100 font-bold">
                  <tr>
                    <td colSpan={2} className="px-4 py-3 text-right">Total:</td>
                    <td className="px-4 py-3 text-right text-blue-700">Rp {totals.debit.toLocaleString('id-ID')}</td>
                    <td className="px-4 py-3 text-right text-green-700">Rp {totals.credit.toLocaleString('id-ID')}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {reportType === 'pnl' && (
            <div className="bg-white rounded-lg shadow overflow-hidden">
              <div className="p-4 border-b bg-gray-50">
                <h3 className="font-semibold text-lg">Profit & Loss Statement</h3>
                <p className="text-sm text-gray-500">
                  Period: {new Date(dateRange.start).toLocaleDateString('id-ID')} - {new Date(dateRange.end).toLocaleDateString('id-ID')}
                </p>
                <p className="text-xs text-amber-600 mt-1 italic">
                  Note: Costs may change as import expenses are updated
                </p>
              </div>
              
              <div className="p-4">
                <div className="mb-6">
                  <h4 className="font-semibold text-green-700 mb-2 border-b pb-2">Revenue (Pendapatan)</h4>
                  <table className="w-full">
                    <tbody>
                      {trialBalance.filter(r => r.account_type === 'revenue').map(row => (
                        <tr key={row.code}>
                          <td className="py-1 font-mono text-sm text-gray-500">{row.code}</td>
                          <td className="py-1">{row.name}</td>
                          <td className="py-1 text-right text-green-600">Rp {Math.abs(row.balance).toLocaleString('id-ID')}</td>
                        </tr>
                      ))}
                      <tr className="font-semibold border-t">
                        <td colSpan={2} className="py-2">Total Revenue</td>
                        <td className="py-2 text-right text-green-700">Rp {revenue.toLocaleString('id-ID')}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <div className="mb-6">
                  <h4 className="font-semibold text-red-700 mb-2 border-b pb-2">Expenses (Beban)</h4>
                  <table className="w-full">
                    <tbody>
                      {trialBalance.filter(r => r.account_type === 'expense').map(row => (
                        <tr key={row.code}>
                          <td className="py-1 font-mono text-sm text-gray-500">{row.code}</td>
                          <td className="py-1">{row.name}</td>
                          <td className="py-1 text-right text-red-600">Rp {Math.abs(row.balance).toLocaleString('id-ID')}</td>
                        </tr>
                      ))}
                      <tr className="font-semibold border-t">
                        <td colSpan={2} className="py-2">Total Expenses</td>
                        <td className="py-2 text-right text-red-700">Rp {expenses.toLocaleString('id-ID')}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <div className={`p-4 rounded-lg ${netIncome >= 0 ? 'bg-green-50' : 'bg-red-50'}`}>
                  <div className="flex justify-between items-center">
                    <span className="font-bold text-lg">Net Income <span className="text-sm font-normal italic">(Provisional)</span></span>
                    <span className={`font-bold text-2xl ${netIncome >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                      Rp {netIncome.toLocaleString('id-ID')}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {reportType === 'balance_sheet' && (
            <div className="bg-white rounded-lg shadow overflow-hidden">
              <div className="p-4 border-b bg-gray-50">
                <h3 className="font-semibold text-lg">Balance Sheet (Neraca)</h3>
                <p className="text-sm text-gray-500">As of {new Date(dateRange.end).toLocaleDateString('id-ID')}</p>
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4">
                <div>
                  <h4 className="font-semibold text-blue-700 mb-2 border-b pb-2">Assets (Aset)</h4>
                  <table className="w-full">
                    <tbody>
                      {trialBalance.filter(r => r.account_type === 'asset').map(row => (
                        <tr key={row.code}>
                          <td className="py-1">
                            <span className="font-mono text-xs text-gray-500 mr-2">{row.code}</span>
                            {row.name}
                          </td>
                          <td className="py-1 text-right text-blue-600">Rp {row.balance.toLocaleString('id-ID')}</td>
                        </tr>
                      ))}
                      {trialBalance.filter(r => r.account_type === 'contra' && r.account_group?.includes('Assets')).map(row => (
                        <tr key={row.code} className="text-gray-500">
                          <td className="py-1">
                            <span className="font-mono text-xs mr-2">{row.code}</span>
                            {row.name}
                          </td>
                          <td className="py-1 text-right">({Math.abs(row.balance).toLocaleString('id-ID')})</td>
                        </tr>
                      ))}
                      <tr className="font-semibold border-t-2">
                        <td className="py-2">Total Assets</td>
                        <td className="py-2 text-right text-blue-700">Rp {(assets - contraAssets).toLocaleString('id-ID')}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <div>
                  <h4 className="font-semibold text-red-700 mb-2 border-b pb-2">Liabilities (Kewajiban)</h4>
                  <table className="w-full">
                    <tbody>
                      {trialBalance.filter(r => r.account_type === 'liability').map(row => (
                        <tr key={row.code}>
                          <td className="py-1">
                            <span className="font-mono text-xs text-gray-500 mr-2">{row.code}</span>
                            {row.name}
                          </td>
                          <td className="py-1 text-right text-red-600">Rp {Math.abs(row.balance).toLocaleString('id-ID')}</td>
                        </tr>
                      ))}
                      <tr className="font-semibold border-t">
                        <td className="py-2">Total Liabilities</td>
                        <td className="py-2 text-right text-red-700">Rp {liabilities.toLocaleString('id-ID')}</td>
                      </tr>
                    </tbody>
                  </table>

                  <h4 className="font-semibold text-purple-700 mb-2 border-b pb-2 mt-6">Equity (Modal)</h4>
                  <table className="w-full">
                    <tbody>
                      {trialBalance.filter(r => r.account_type === 'equity').map(row => (
                        <tr key={row.code}>
                          <td className="py-1">
                            <span className="font-mono text-xs text-gray-500 mr-2">{row.code}</span>
                            {row.name}
                          </td>
                          <td className="py-1 text-right text-purple-600">Rp {Math.abs(row.balance).toLocaleString('id-ID')}</td>
                        </tr>
                      ))}
                      <tr>
                        <td className="py-1">Current Year Earnings</td>
                        <td className={`py-1 text-right ${netIncome >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                          Rp {netIncome.toLocaleString('id-ID')}
                        </td>
                      </tr>
                      <tr className="font-semibold border-t">
                        <td className="py-2">Total Equity</td>
                        <td className="py-2 text-right text-purple-700">Rp {(equity + netIncome).toLocaleString('id-ID')}</td>
                      </tr>
                    </tbody>
                  </table>

                  <div className="mt-4 p-3 bg-gray-100 rounded-lg">
                    <div className="flex justify-between font-bold">
                      <span>Total Liabilities + Equity</span>
                      <span>Rp {(liabilities + equity + netIncome).toLocaleString('id-ID')}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
