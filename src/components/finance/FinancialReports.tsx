import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { RefreshCw } from 'lucide-react';
import { useFinance } from '../../contexts/FinanceContext';
import { useLanguage } from '../../contexts/LanguageContext';

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
  const { dateRange } = useFinance();
  const { t } = useLanguage();
  const [reportType, setReportType] = useState<ReportType>(initialReport);
  const [loading, setLoading] = useState(false);
  const [trialBalance, setTrialBalance] = useState<TrialBalanceRow[]>([]);

  useEffect(() => {
    loadReport();
  }, [reportType, dateRange]);

  // Watch for initialReport prop changes to switch reports
  useEffect(() => {
    setReportType(initialReport);
  }, [initialReport]);

  const loadReport = async () => {
    setLoading(true);
    try {
      // Try to use the RPC function with date range
      const { data: rpcData, error: rpcError } = await supabase.rpc('get_trial_balance', {
        p_start_date: dateRange.startDate,
        p_end_date: dateRange.endDate,
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

  return (
    <div>

      {loading ? (
        <div className="flex justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        </div>
      ) : (
        <>
          {reportType === 'trial_balance' && (
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
              <div className="px-4 py-3 border-b bg-gray-50">
                <h3 className="font-bold text-base">Trial Balance as of {new Date(dateRange.endDate).toLocaleDateString('id-ID')}</h3>
                <p className="text-xs text-gray-600 italic">Neraca Saldo per {new Date(dateRange.endDate).toLocaleDateString('id-ID')}</p>
              </div>
              <table className="w-full">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-3 py-2 text-left text-[10px] font-medium text-gray-500 uppercase">{t('code', 'Code')}</th>
                    <th className="px-3 py-2 text-left text-[10px] font-medium text-gray-500 uppercase">{t('account_name', 'Account Name')}</th>
                    <th className="px-3 py-2 text-right text-[10px] font-medium text-gray-500 uppercase">{t('debit', 'Debit')}</th>
                    <th className="px-3 py-2 text-right text-[10px] font-medium text-gray-500 uppercase">{t('credit', 'Credit')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {trialBalance.map(row => (
                    <tr key={row.code} className="hover:bg-gray-50">
                      <td className="px-3 py-1.5 font-mono text-xs">{row.code}</td>
                      <td className="px-3 py-1.5 text-sm">
                        <div>{row.name}</div>
                        {row.name_id && <div className="text-xs text-gray-500">{row.name_id}</div>}
                      </td>
                      <td className="px-3 py-1.5 text-right text-sm text-blue-600">
                        {row.balance > 0 ? `Rp ${row.balance.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : ''}
                      </td>
                      <td className="px-3 py-1.5 text-right text-sm text-green-600">
                        {row.balance < 0 ? `Rp ${Math.abs(row.balance).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : ''}
                      </td>
                    </tr>
                  ))}
                  {trialBalance.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-3 py-6 text-center text-sm text-gray-500">
                        {t('no_data', 'No transactions found')}
                      </td>
                    </tr>
                  )}
                </tbody>
                <tfoot className="bg-gray-100 font-bold">
                  <tr>
                    <td colSpan={2} className="px-3 py-2 text-right text-sm">{t('total', 'Total')}:</td>
                    <td className="px-3 py-2 text-right text-sm text-blue-700">Rp {totals.debit.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                    <td className="px-3 py-2 text-right text-sm text-green-700">Rp {totals.credit.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {reportType === 'pnl' && (
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
              <div className="px-4 py-3 border-b bg-gray-50">
                <h3 className="font-bold text-base">Profit & Loss Statement for period {new Date(dateRange.startDate).toLocaleDateString('id-ID')} - {new Date(dateRange.endDate).toLocaleDateString('id-ID')}</h3>
                <p className="text-xs text-gray-600 italic">Laporan Laba Rugi periode {new Date(dateRange.startDate).toLocaleDateString('id-ID')} - {new Date(dateRange.endDate).toLocaleDateString('id-ID')}</p>
                <p className="text-[10px] text-amber-600 mt-1 italic">
                  {t('pnl_note', 'Note: Costs may change as import expenses are updated')}
                </p>
              </div>

              <div className="p-3">
                <div className="mb-4">
                  <h4 className="font-semibold text-green-700 text-xs mb-1.5 border-b pb-1">{t('revenue', 'Revenue')} (Pendapatan)</h4>
                  <table className="w-full">
                    <tbody>
                      {trialBalance.filter(r => r.account_type === 'revenue').map(row => (
                        <tr key={row.code}>
                          <td className="py-0.5 font-mono text-[10px] text-gray-500">{row.code}</td>
                          <td className="py-0.5 text-xs">{row.name}</td>
                          <td className="py-0.5 text-right text-xs text-green-600">Rp {Math.abs(row.balance).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                        </tr>
                      ))}
                      <tr className="font-semibold border-t">
                        <td colSpan={2} className="py-1.5 text-xs">{t('total_revenue', 'Total Revenue')}</td>
                        <td className="py-1.5 text-right text-xs text-green-700">Rp {revenue.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <div className="mb-4">
                  <h4 className="font-semibold text-red-700 text-xs mb-1.5 border-b pb-1">{t('expenses', 'Expenses')} (Beban)</h4>
                  <table className="w-full">
                    <tbody>
                      {trialBalance.filter(r => r.account_type === 'expense').map(row => (
                        <tr key={row.code}>
                          <td className="py-0.5 font-mono text-[10px] text-gray-500">{row.code}</td>
                          <td className="py-0.5 text-xs">{row.name}</td>
                          <td className="py-0.5 text-right text-xs text-red-600">Rp {Math.abs(row.balance).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                        </tr>
                      ))}
                      <tr className="font-semibold border-t">
                        <td colSpan={2} className="py-1.5 text-xs">{t('total_expenses', 'Total Expenses')}</td>
                        <td className="py-1.5 text-right text-xs text-red-700">Rp {expenses.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <div className={`p-2.5 rounded ${netIncome >= 0 ? 'bg-green-50' : 'bg-red-50'}`}>
                  <div className="flex justify-between items-center">
                    <span className="font-bold text-sm">{t('net_income', 'Net Income')} <span className="text-xs font-normal italic">({t('provisional', 'Provisional')})</span></span>
                    <span className={`font-bold text-base ${netIncome >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                      Rp {netIncome.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {reportType === 'balance_sheet' && (
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
              <div className="px-4 py-3 border-b bg-gray-50">
                <h3 className="font-bold text-base">Balance Sheet as of {new Date(dateRange.endDate).toLocaleDateString('id-ID')}</h3>
                <p className="text-xs text-gray-600 italic">Neraca per {new Date(dateRange.endDate).toLocaleDateString('id-ID')}</p>
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 p-3">
                <div>
                  <h4 className="font-semibold text-blue-700 text-xs mb-1.5 border-b pb-1">{t('assets', 'Assets')} (Aset)</h4>
                  <table className="w-full">
                    <tbody>
                      {trialBalance.filter(r => r.account_type === 'asset').map(row => (
                        <tr key={row.code}>
                          <td className="py-0.5 text-xs">
                            <span className="font-mono text-[10px] text-gray-500 mr-1.5">{row.code}</span>
                            {row.name}
                          </td>
                          <td className="py-0.5 text-right text-xs text-blue-600">Rp {row.balance.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                        </tr>
                      ))}
                      {trialBalance.filter(r => r.account_type === 'contra' && r.account_group?.includes('Assets')).map(row => (
                        <tr key={row.code} className="text-gray-500">
                          <td className="py-0.5 text-xs">
                            <span className="font-mono text-[10px] mr-1.5">{row.code}</span>
                            {row.name}
                          </td>
                          <td className="py-0.5 text-right text-xs">({Math.abs(row.balance).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})</td>
                        </tr>
                      ))}
                      <tr className="font-semibold border-t-2">
                        <td className="py-1.5 text-xs">{t('total_assets', 'Total Assets')}</td>
                        <td className="py-1.5 text-right text-xs text-blue-700">Rp {(assets - contraAssets).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <div>
                  <h4 className="font-semibold text-red-700 text-xs mb-1.5 border-b pb-1">{t('liabilities', 'Liabilities')} (Kewajiban)</h4>
                  <table className="w-full">
                    <tbody>
                      {trialBalance.filter(r => r.account_type === 'liability').map(row => (
                        <tr key={row.code}>
                          <td className="py-0.5 text-xs">
                            <span className="font-mono text-[10px] text-gray-500 mr-1.5">{row.code}</span>
                            {row.name}
                          </td>
                          <td className="py-0.5 text-right text-xs text-red-600">Rp {Math.abs(row.balance).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                        </tr>
                      ))}
                      <tr className="font-semibold border-t">
                        <td className="py-1.5 text-xs">{t('total_liabilities', 'Total Liabilities')}</td>
                        <td className="py-1.5 text-right text-xs text-red-700">Rp {liabilities.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                      </tr>
                    </tbody>
                  </table>

                  <h4 className="font-semibold text-purple-700 text-xs mb-1.5 border-b pb-1 mt-4">{t('equity', 'Equity')} (Modal)</h4>
                  <table className="w-full">
                    <tbody>
                      {trialBalance.filter(r => r.account_type === 'equity').map(row => (
                        <tr key={row.code}>
                          <td className="py-0.5 text-xs">
                            <span className="font-mono text-[10px] text-gray-500 mr-1.5">{row.code}</span>
                            {row.name}
                          </td>
                          <td className="py-0.5 text-right text-xs text-purple-600">Rp {Math.abs(row.balance).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                        </tr>
                      ))}
                      <tr>
                        <td className="py-0.5 text-xs">{t('current_year_earnings', 'Current Year Earnings')}</td>
                        <td className={`py-0.5 text-right text-xs ${netIncome >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                          Rp {netIncome.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </td>
                      </tr>
                      <tr className="font-semibold border-t">
                        <td className="py-1.5 text-xs">{t('total_equity', 'Total Equity')}</td>
                        <td className="py-1.5 text-right text-xs text-purple-700">Rp {(equity + netIncome).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                      </tr>
                    </tbody>
                  </table>

                  <div className="mt-3 p-2 bg-gray-100 rounded">
                    <div className="flex justify-between font-bold text-xs">
                      <span>{t('total_liabilities_equity', 'Total Liabilities + Equity')}</span>
                      <span>Rp {(liabilities + equity + netIncome).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
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
