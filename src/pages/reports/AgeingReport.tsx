import { useEffect, useState } from 'react';
import { Layout } from '../../components/Layout';
import { supabase } from '../../lib/supabase';
import { FileDown, Calendar, TrendingUp } from 'lucide-react';

interface AgeingData {
  customer_id: string;
  customer_name: string;
  total_outstanding: number;
  current: number;
  days_1_30: number;
  days_31_60: number;
  days_61_90: number;
  days_90_plus: number;
  invoice_count: number;
}

export function AgeingReport() {
  const [ageingData, setAgeingData] = useState<AgeingData[]>([]);
  const [loading, setLoading] = useState(true);
  const [asOfDate, setAsOfDate] = useState(new Date().toISOString().split('T')[0]);

  useEffect(() => {
    loadAgeingData();
  }, [asOfDate]);

  const loadAgeingData = async () => {
    try {
      setLoading(true);

      // Fetch all unpaid/partial invoices
      const { data: invoices, error } = await supabase
        .from('sales_invoices')
        .select('*, customers(company_name)')
        .in('payment_status', ['pending', 'partial']);

      if (error) throw error;

      // Calculate paid amounts and balances
      const invoicesWithBalances = await Promise.all(
        (invoices || []).map(async (inv) => {
          const { data: paidData } = await supabase
            .rpc('get_invoice_paid_amount', { p_invoice_id: inv.id });

          const paidAmount = paidData || 0;
          const balance = inv.total_amount - paidAmount;

          // Calculate days overdue
          const dueDate = new Date(inv.due_date);
          const today = new Date(asOfDate);
          const daysOverdue = Math.floor((today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));

          return {
            ...inv,
            balance,
            days_overdue: daysOverdue
          };
        })
      );

      // Group by customer
      const customerMap = new Map<string, AgeingData>();

      invoicesWithBalances.forEach(inv => {
        const customerId = inv.customer_id;

        if (!customerMap.has(customerId)) {
          customerMap.set(customerId, {
            customer_id: customerId,
            customer_name: inv.customers?.company_name || 'Unknown',
            total_outstanding: 0,
            current: 0,
            days_1_30: 0,
            days_31_60: 0,
            days_61_90: 0,
            days_90_plus: 0,
            invoice_count: 0
          });
        }

        const data = customerMap.get(customerId)!;
        data.total_outstanding += inv.balance;
        data.invoice_count += 1;

        // Allocate to ageing bucket
        if (inv.days_overdue < 0) {
          data.current += inv.balance;
        } else if (inv.days_overdue <= 30) {
          data.days_1_30 += inv.balance;
        } else if (inv.days_overdue <= 60) {
          data.days_31_60 += inv.balance;
        } else if (inv.days_overdue <= 90) {
          data.days_61_90 += inv.balance;
        } else {
          data.days_90_plus += inv.balance;
        }
      });

      // Sort by total outstanding descending
      const sortedData = Array.from(customerMap.values()).sort((a, b) =>
        b.total_outstanding - a.total_outstanding
      );

      setAgeingData(sortedData);
    } catch (error) {
      console.error('Error loading ageing data:', error);
      alert('Failed to load ageing report');
    } finally {
      setLoading(false);
    }
  };

  const exportToCSV = () => {
    const headers = ['Customer', 'Total Outstanding', 'Current (Not Due)', '1-30 Days', '31-60 Days', '61-90 Days', '90+ Days', 'Invoice Count'];
    const rows = ageingData.map(row => [
      row.customer_name,
      row.total_outstanding,
      row.current,
      row.days_1_30,
      row.days_31_60,
      row.days_61_90,
      row.days_90_plus,
      row.invoice_count
    ]);

    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ageing_report_${asOfDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const totals = ageingData.reduce((acc, row) => ({
    total_outstanding: acc.total_outstanding + row.total_outstanding,
    current: acc.current + row.current,
    days_1_30: acc.days_1_30 + row.days_1_30,
    days_31_60: acc.days_31_60 + row.days_31_60,
    days_61_90: acc.days_61_90 + row.days_61_90,
    days_90_plus: acc.days_90_plus + row.days_90_plus,
    invoice_count: acc.invoice_count + row.invoice_count
  }), {
    total_outstanding: 0,
    current: 0,
    days_1_30: 0,
    days_31_60: 0,
    days_61_90: 0,
    days_90_plus: 0,
    invoice_count: 0
  });

  const overdueTotal = totals.days_1_30 + totals.days_31_60 + totals.days_61_90 + totals.days_90_plus;

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Accounts Receivable Ageing Report</h1>
            <p className="text-gray-600 mt-1">Track overdue invoices by ageing buckets</p>
          </div>
          <button
            onClick={exportToCSV}
            disabled={ageingData.length === 0}
            className="flex items-center gap-2 bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <FileDown className="w-4 h-4" />
            Export CSV
          </button>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600">Total Outstanding</p>
                <p className="text-2xl font-bold text-gray-900 mt-1">
                  Rp {totals.total_outstanding.toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                </p>
                <p className="text-xs text-gray-500 mt-1">{totals.invoice_count} invoices</p>
              </div>
              <TrendingUp className="w-10 h-10 text-gray-400" />
            </div>
          </div>
          <div className="bg-green-50 rounded-lg shadow p-6 border border-green-200">
            <p className="text-sm text-green-700 font-medium">Current (Not Due)</p>
            <p className="text-2xl font-bold text-green-900 mt-1">
              Rp {totals.current.toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
            </p>
            <p className="text-xs text-green-600 mt-1">
              {totals.total_outstanding > 0 ?
                ((totals.current / totals.total_outstanding) * 100).toFixed(1) : 0}% of total
            </p>
          </div>
          <div className="bg-orange-50 rounded-lg shadow p-6 border border-orange-200">
            <p className="text-sm text-orange-700 font-medium">Overdue</p>
            <p className="text-2xl font-bold text-orange-900 mt-1">
              Rp {overdueTotal.toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
            </p>
            <p className="text-xs text-orange-600 mt-1">
              {totals.total_outstanding > 0 ?
                ((overdueTotal / totals.total_outstanding) * 100).toFixed(1) : 0}% of total
            </p>
          </div>
          <div className="bg-red-50 rounded-lg shadow p-6 border border-red-200">
            <p className="text-sm text-red-700 font-medium">90+ Days Critical</p>
            <p className="text-2xl font-bold text-red-900 mt-1">
              Rp {totals.days_90_plus.toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
            </p>
            <p className="text-xs text-red-600 mt-1">Immediate action required</p>
          </div>
        </div>

        {/* Date Filter */}
        <div className="bg-white rounded-lg shadow p-4">
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-gray-500" />
              <span className="font-medium text-gray-700">As of Date:</span>
            </label>
            <input
              type="date"
              value={asOfDate}
              onChange={(e) => setAsOfDate(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
            <span className="text-sm text-gray-500">
              Report generated as of {new Date(asOfDate).toLocaleDateString('id-ID', {
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric'
              })}
            </span>
          </div>
        </div>

        {/* Ageing Table */}
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Customer
                  </th>
                  <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Invoices
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Total Outstanding
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-green-700 uppercase tracking-wider">
                    Current
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-yellow-700 uppercase tracking-wider">
                    1-30 Days
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-orange-700 uppercase tracking-wider">
                    31-60 Days
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-red-700 uppercase tracking-wider">
                    61-90 Days
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-red-900 uppercase tracking-wider">
                    90+ Days
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {loading ? (
                  <tr>
                    <td colSpan={8} className="px-6 py-12 text-center text-gray-500">
                      <div className="flex items-center justify-center">
                        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
                        <span className="ml-3">Loading ageing data...</span>
                      </div>
                    </td>
                  </tr>
                ) : ageingData.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-6 py-12 text-center text-gray-500">
                      <TrendingUp className="w-16 h-16 mx-auto mb-4 text-gray-300" />
                      <p className="text-lg font-medium">No Outstanding Invoices</p>
                      <p className="text-sm mt-2">All invoices are fully paid!</p>
                    </td>
                  </tr>
                ) : (
                  <>
                    {ageingData.map((row) => (
                      <tr key={row.customer_id} className="hover:bg-gray-50 transition">
                        <td className="px-6 py-4">
                          <div className="text-sm font-medium text-gray-900">{row.customer_name}</div>
                        </td>
                        <td className="px-6 py-4 text-center text-sm text-gray-500">{row.invoice_count}</td>
                        <td className="px-6 py-4 text-right text-sm font-bold text-gray-900">
                          Rp {row.total_outstanding.toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                        </td>
                        <td className="px-6 py-4 text-right text-sm">
                          {row.current > 0 ? (
                            <span className="text-green-600 font-medium">
                              Rp {row.current.toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                            </span>
                          ) : (
                            <span className="text-gray-300">-</span>
                          )}
                        </td>
                        <td className="px-6 py-4 text-right text-sm">
                          {row.days_1_30 > 0 ? (
                            <span className="text-yellow-600 font-medium">
                              Rp {row.days_1_30.toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                            </span>
                          ) : (
                            <span className="text-gray-300">-</span>
                          )}
                        </td>
                        <td className="px-6 py-4 text-right text-sm">
                          {row.days_31_60 > 0 ? (
                            <span className="text-orange-600 font-medium">
                              Rp {row.days_31_60.toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                            </span>
                          ) : (
                            <span className="text-gray-300">-</span>
                          )}
                        </td>
                        <td className="px-6 py-4 text-right text-sm">
                          {row.days_61_90 > 0 ? (
                            <span className="text-red-600 font-medium">
                              Rp {row.days_61_90.toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                            </span>
                          ) : (
                            <span className="text-gray-300">-</span>
                          )}
                        </td>
                        <td className="px-6 py-4 text-right text-sm">
                          {row.days_90_plus > 0 ? (
                            <span className="text-red-900 font-bold">
                              Rp {row.days_90_plus.toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                            </span>
                          ) : (
                            <span className="text-gray-300">-</span>
                          )}
                        </td>
                      </tr>
                    ))}
                    {/* Totals Row */}
                    <tr className="bg-gray-100 font-bold border-t-2 border-gray-300">
                      <td className="px-6 py-4 text-sm text-gray-900">TOTAL</td>
                      <td className="px-6 py-4 text-center text-sm text-gray-900">{totals.invoice_count}</td>
                      <td className="px-6 py-4 text-right text-sm text-gray-900">
                        Rp {totals.total_outstanding.toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                      </td>
                      <td className="px-6 py-4 text-right text-sm text-green-700">
                        Rp {totals.current.toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                      </td>
                      <td className="px-6 py-4 text-right text-sm text-yellow-700">
                        Rp {totals.days_1_30.toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                      </td>
                      <td className="px-6 py-4 text-right text-sm text-orange-700">
                        Rp {totals.days_31_60.toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                      </td>
                      <td className="px-6 py-4 text-right text-sm text-red-700">
                        Rp {totals.days_61_90.toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                      </td>
                      <td className="px-6 py-4 text-right text-sm text-red-900">
                        Rp {totals.days_90_plus.toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                      </td>
                    </tr>
                  </>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </Layout>
  );
}
