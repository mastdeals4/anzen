import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { FileText, Download, Calendar, TrendingUp, TrendingDown } from 'lucide-react';

interface InputPPNRecord {
  month: string;
  expense_date: string;
  container_ref: string;
  supplier: string;
  import_invoice_value: number;
  ppn_amount: number;
  description: string;
}

interface OutputPPNRecord {
  month: string;
  invoice_date: string;
  invoice_number: string;
  customer: string;
  customer_npwp: string;
  subtotal: number;
  ppn_amount: number;
  total_amount: number;
  payment_status: string;
}

interface MonthlySummary {
  month: string;
  input_ppn_paid: number;
  output_ppn_collected: number;
  net_ppn_payable: number;
}

export function TaxReports() {
  const [inputPPN, setInputPPN] = useState<InputPPNRecord[]>([]);
  const [outputPPN, setOutputPPN] = useState<OutputPPNRecord[]>([]);
  const [monthlySummary, setMonthlySummary] = useState<MonthlySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'summary' | 'input' | 'output'>('summary');
  const [selectedMonth, setSelectedMonth] = useState<string>('');

  useEffect(() => {
    loadReports();
  }, []);

  const loadReports = async () => {
    try {
      setLoading(true);

      const [summaryRes, inputRes, outputRes] = await Promise.all([
        supabase.from('vw_monthly_tax_summary').select('*').order('month', { ascending: false }),
        supabase.from('vw_input_ppn_report').select('*'),
        supabase.from('vw_output_ppn_report').select('*'),
      ]);

      if (summaryRes.error) throw summaryRes.error;
      if (inputRes.error) throw inputRes.error;
      if (outputRes.error) throw outputRes.error;

      setMonthlySummary(summaryRes.data || []);
      setInputPPN(inputRes.data || []);
      setOutputPPN(outputRes.data || []);
    } catch (error: any) {
      console.error('Error loading tax reports:', error.message);
      alert('Failed to load tax reports');
    } finally {
      setLoading(false);
    }
  };

  const formatCurrency = (amount: number) => {
    return `Rp ${amount?.toLocaleString('id-ID')}`;
  };

  const formatMonth = (monthStr: string) => {
    if (!monthStr) return '-';
    const date = new Date(monthStr);
    return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
  };

  const filteredInput = selectedMonth
    ? inputPPN.filter((record) => record.month === selectedMonth)
    : inputPPN;

  const filteredOutput = selectedMonth
    ? outputPPN.filter((record) => record.month === selectedMonth)
    : outputPPN;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Tax Reports (PPN)</h2>
          <p className="text-sm text-gray-600">
            Monthly Input PPN, Output PPN, and Net PPN Payable for tax filing
          </p>
        </div>
        <button
          onClick={() => window.print()}
          className="flex items-center gap-2 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
        >
          <Download className="w-4 h-4" />
          Print Report
        </button>
      </div>

      <div className="flex gap-2 border-b border-gray-200">
        {[
          { value: 'summary', label: 'Monthly Summary', icon: Calendar },
          { value: 'input', label: 'Input PPN (Paid)', icon: TrendingDown },
          { value: 'output', label: 'Output PPN (Collected)', icon: TrendingUp },
        ].map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.value}
              onClick={() => setActiveTab(tab.value as any)}
              className={`flex items-center gap-2 px-4 py-2 font-medium transition-colors ${
                activeTab === tab.value
                  ? 'text-blue-600 border-b-2 border-blue-600'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              <Icon className="w-4 h-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading tax reports...</div>
      ) : (
        <>
          {activeTab === 'summary' && (
            <div className="bg-white rounded-lg shadow overflow-hidden">
              <div className="px-6 py-4 bg-gray-50 border-b border-gray-200">
                <h3 className="text-lg font-medium text-gray-900">Monthly Tax Summary</h3>
                <p className="text-sm text-gray-600">Net PPN = Output PPN - Input PPN</p>
              </div>
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                      Month
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                      Input PPN (Paid)
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                      Output PPN (Collected)
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                      Net PPN Payable
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {monthlySummary.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-6 py-8 text-center text-gray-500">
                        No tax data available
                      </td>
                    </tr>
                  ) : (
                    monthlySummary.map((summary, index) => (
                      <tr key={index} className="hover:bg-gray-50">
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="text-sm font-medium text-gray-900">
                            {formatMonth(summary.month)}
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-right">
                          <div className="text-sm text-blue-600 font-medium">
                            {formatCurrency(summary.input_ppn_paid)}
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-right">
                          <div className="text-sm text-green-600 font-medium">
                            {formatCurrency(summary.output_ppn_collected)}
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-right">
                          <div
                            className={`text-sm font-bold ${
                              summary.net_ppn_payable > 0
                                ? 'text-red-600'
                                : summary.net_ppn_payable < 0
                                ? 'text-blue-600'
                                : 'text-gray-600'
                            }`}
                          >
                            {formatCurrency(summary.net_ppn_payable)}
                          </div>
                          <div className="text-xs text-gray-500">
                            {summary.net_ppn_payable > 0
                              ? 'Pay to tax office'
                              : summary.net_ppn_payable < 0
                              ? 'Carry forward / Refund'
                              : 'Balanced'}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}

          {activeTab === 'input' && (
            <div className="bg-white rounded-lg shadow overflow-hidden">
              <div className="px-6 py-4 bg-blue-50 border-b border-blue-200">
                <h3 className="text-lg font-medium text-blue-900">Input PPN Report</h3>
                <p className="text-sm text-blue-700">
                  PPN paid on imports - can be claimed as tax credit
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                        Date
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                        Container
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                        Supplier
                      </th>
                      <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                        Invoice Value
                      </th>
                      <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                        PPN Amount (11%)
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {filteredInput.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-6 py-8 text-center text-gray-500">
                          No input PPN records
                        </td>
                      </tr>
                    ) : (
                      filteredInput.map((record, index) => (
                        <tr key={index} className="hover:bg-gray-50">
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                            {new Date(record.expense_date).toLocaleDateString()}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                            {record.container_ref}
                          </td>
                          <td className="px-6 py-4 text-sm text-gray-700">{record.supplier}</td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-900">
                            {formatCurrency(record.import_invoice_value)}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-right font-medium text-blue-600">
                            {formatCurrency(record.ppn_amount)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeTab === 'output' && (
            <div className="bg-white rounded-lg shadow overflow-hidden">
              <div className="px-6 py-4 bg-green-50 border-b border-green-200">
                <h3 className="text-lg font-medium text-green-900">Output PPN Report</h3>
                <p className="text-sm text-green-700 mb-2">
                  PPN collected from customers - must be paid to tax office
                </p>
                <p className="text-sm font-semibold text-red-700">
                  ⚠️ Tax is payable based on INVOICE DATE, not payment status!
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                        Date
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                        Invoice #
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                        Customer
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                        NPWP
                      </th>
                      <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                        Subtotal
                      </th>
                      <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                        PPN Amount (11%)
                      </th>
                      <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase">
                        Payment Status
                        <div className="text-xs font-normal text-gray-500 normal-case">
                          (For info only - tax due regardless)
                        </div>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {filteredOutput.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="px-6 py-8 text-center text-gray-500">
                          No output PPN records
                        </td>
                      </tr>
                    ) : (
                      filteredOutput.map((record, index) => (
                        <tr key={index} className="hover:bg-gray-50">
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                            {new Date(record.invoice_date).toLocaleDateString()}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                            {record.invoice_number}
                          </td>
                          <td className="px-6 py-4 text-sm text-gray-700">{record.customer}</td>
                          <td className="px-6 py-4 text-sm text-gray-600">
                            {record.customer_npwp || '-'}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-900">
                            {formatCurrency(record.subtotal)}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-right font-medium text-green-600">
                            {formatCurrency(record.ppn_amount)}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-center">
                            <span
                              className={`inline-flex px-2 py-1 text-xs font-medium rounded ${
                                record.payment_status === 'paid'
                                  ? 'bg-green-100 text-green-800'
                                  : record.payment_status === 'partial'
                                  ? 'bg-yellow-100 text-yellow-800'
                                  : 'bg-gray-100 text-gray-800'
                              }`}
                            >
                              {record.payment_status}
                            </span>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      <div className="bg-red-50 border border-red-300 rounded-lg p-4 mb-4">
        <h4 className="text-sm font-semibold text-red-900 mb-2">⚠️ CRITICAL: Indonesian PPN Tax Rule</h4>
        <div className="text-sm text-red-800 space-y-2">
          <p className="font-semibold">PPN is payable based on INVOICE DATE, NOT payment date!</p>
          <ul className="list-disc list-inside space-y-1 ml-2">
            <li>When you issue an invoice → PPN is immediately owed to tax office</li>
            <li>Payment status (Pending/Paid) does NOT matter for tax</li>
            <li>You must pay PPN to government even if customer hasn't paid you yet</li>
            <li>All invoices in a month = PPN payable for that month</li>
            <li>Deadline: Pay by month-end regardless of customer payment</li>
          </ul>
        </div>
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h4 className="text-sm font-semibold text-blue-900 mb-2">📋 Tax Filing Guide</h4>
        <ul className="text-sm text-blue-800 space-y-1">
          <li>• <strong>Input PPN</strong>: PPN paid on imports (can be claimed back)</li>
          <li>• <strong>Output PPN</strong>: PPN collected from customers (must pay to tax office)</li>
          <li>• <strong>Net PPN Payable</strong>: Output PPN - Input PPN</li>
          <li>• If positive: Pay to tax office by month-end</li>
          <li>• If negative: Carry forward to next month or claim refund</li>
          <li>• <strong>PPN Rate</strong>: 11% (as per Indonesian tax law)</li>
        </ul>
      </div>
    </div>
  );
}
