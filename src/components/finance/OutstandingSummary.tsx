import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { Users, Building2, Download, AlertCircle, TrendingUp } from 'lucide-react';
import { useLanguage } from '../../contexts/LanguageContext';

interface OutstandingParty {
  id: string;
  name: string;
  email?: string;
  total_outstanding: number;
  age_0_30: number;
  age_31_60: number;
  age_61_90: number;
  age_90_plus: number;
  oldest_invoice_date?: string;
}

export default function OutstandingSummary() {
  const { t } = useLanguage();
  const [partyType, setPartyType] = useState<'customer' | 'supplier'>('customer');
  const [outstandingParties, setOutstandingParties] = useState<OutstandingParty[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadOutstanding();
  }, [partyType]);

  const loadOutstanding = async () => {
    setLoading(true);
    try {
      const rpcName = partyType === 'customer'
        ? 'get_customer_outstanding_summary'
        : 'get_supplier_outstanding_summary';

      const { data, error } = await supabase.rpc(rpcName);

      if (error) throw error;

      setOutstandingParties((data || []).map((row: any) => ({
        id: row.id,
        name: row.name,
        email: row.email,
        total_outstanding: Number(row.total_outstanding) || 0,
        age_0_30: Number(row.age_0_30) || 0,
        age_31_60: Number(row.age_31_60) || 0,
        age_61_90: Number(row.age_61_90) || 0,
        age_90_plus: Number(row.age_90_plus) || 0,
        oldest_invoice_date: row.oldest_invoice_date,
      })));
    } catch (err) {
      console.error('Error loading outstanding:', err);
    } finally {
      setLoading(false);
    }
  };

  const formatAmount = (amount: number) => {
    return `Rp ${amount.toLocaleString('id-ID', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  };

  const exportToCSV = () => {
    const headers = ['Party', 'Email', 'Total Outstanding', '0-30 Days', '31-60 Days', '61-90 Days', '>90 Days', 'Oldest Invoice'];
    const rows = outstandingParties.map(party => [
      party.name,
      party.email || '',
      formatAmount(party.total_outstanding),
      formatAmount(party.age_0_30),
      formatAmount(party.age_31_60),
      formatAmount(party.age_61_90),
      formatAmount(party.age_90_plus),
      party.oldest_invoice_date ? new Date(party.oldest_invoice_date).toLocaleDateString('id-ID') : '',
    ]);

    const csv = [
      `${partyType === 'customer' ? 'Customer' : 'Supplier'} Outstanding Summary`,
      `Generated: ${new Date().toLocaleString('id-ID')}`,
      '',
      headers.join(','),
      ...rows.map(row => row.join(',')),
    ].join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `outstanding_${partyType}_${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
  };

  const totalOutstanding = outstandingParties.reduce((sum, p) => sum + p.total_outstanding, 0);
  const total0_30 = outstandingParties.reduce((sum, p) => sum + p.age_0_30, 0);
  const total31_60 = outstandingParties.reduce((sum, p) => sum + p.age_31_60, 0);
  const total61_90 = outstandingParties.reduce((sum, p) => sum + p.age_61_90, 0);
  const total90_plus = outstandingParties.reduce((sum, p) => sum + p.age_90_plus, 0);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between bg-white p-2 rounded-lg shadow-sm">
        <div className="flex items-center gap-1.5">
          {partyType === 'customer' ? (
            <TrendingUp className="w-4 h-4 text-orange-600" />
          ) : (
            <AlertCircle className="w-4 h-4 text-red-600" />
          )}
          <h2 className="text-sm font-semibold text-gray-800">
            {partyType === 'customer' ? t('finance.receivables') || 'Receivables' : t('finance.payables') || 'Payables'} {t('finance.outstanding') || 'Outstanding'}
          </h2>
        </div>
        <button
          onClick={exportToCSV}
          disabled={outstandingParties.length === 0}
          className="flex items-center gap-1.5 px-2.5 py-1.5 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed text-xs"
        >
          <Download className="w-3.5 h-3.5" />
          {t('common.export') || 'Export'}
        </button>
      </div>

      <div className="bg-white rounded-lg shadow-sm p-2">
        <div className="flex items-center gap-2 mb-2">
          <label className="block text-xs font-medium text-gray-700">{t('finance.partyType') || 'Party Type'}:</label>
          <div className="flex gap-1.5">
            <button
              onClick={() => setPartyType('customer')}
              className={`px-2.5 py-1.5 rounded-lg font-medium text-xs ${
                partyType === 'customer'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              <Users className="w-3.5 h-3.5 inline mr-1" />
              {t('finance.customers') || 'Customers'}
            </button>
            <button
              onClick={() => setPartyType('supplier')}
              className={`px-2.5 py-1.5 rounded-lg font-medium text-xs ${
                partyType === 'supplier'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              <Building2 className="w-3.5 h-3.5 inline mr-1" />
              {t('finance.suppliers') || 'Suppliers'}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-5 gap-2 p-2 bg-gradient-to-r from-orange-50 to-red-50 rounded-lg">
          <div>
            <p className="text-[10px] font-medium text-gray-600 uppercase">{t('finance.totalOutstanding') || 'Total Outstanding'}</p>
            <p className="text-sm font-bold text-orange-600">{formatAmount(totalOutstanding)}</p>
          </div>
          <div>
            <p className="text-[10px] font-medium text-gray-600 uppercase">0-30 {t('finance.days') || 'Days'}</p>
            <p className="text-sm font-bold text-green-600">{formatAmount(total0_30)}</p>
          </div>
          <div>
            <p className="text-[10px] font-medium text-gray-600 uppercase">31-60 {t('finance.days') || 'Days'}</p>
            <p className="text-sm font-bold text-yellow-600">{formatAmount(total31_60)}</p>
          </div>
          <div>
            <p className="text-[10px] font-medium text-gray-600 uppercase">61-90 {t('finance.days') || 'Days'}</p>
            <p className="text-sm font-bold text-orange-600">{formatAmount(total61_90)}</p>
          </div>
          <div>
            <p className="text-[10px] font-medium text-gray-600 uppercase">&gt;90 {t('finance.days') || 'Days'}</p>
            <p className="text-sm font-bold text-red-600">{formatAmount(total90_plus)}</p>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-2 py-1.5 text-left text-[10px] font-medium text-gray-700 uppercase tracking-wider">
                  {partyType === 'customer' ? t('common.customer') || 'Customer' : t('common.supplier') || 'Supplier'}
                </th>
                <th className="px-2 py-1.5 text-left text-[10px] font-medium text-gray-700 uppercase tracking-wider">
                  {t('common.email') || 'Email'}
                </th>
                <th className="px-2 py-1.5 text-right text-[10px] font-medium text-gray-700 uppercase tracking-wider">
                  {t('finance.totalOutstanding') || 'Total'}
                </th>
                <th className="px-2 py-1.5 text-right text-[10px] font-medium text-gray-700 uppercase tracking-wider">
                  0-30
                </th>
                <th className="px-2 py-1.5 text-right text-[10px] font-medium text-gray-700 uppercase tracking-wider">
                  31-60
                </th>
                <th className="px-2 py-1.5 text-right text-[10px] font-medium text-gray-700 uppercase tracking-wider">
                  61-90
                </th>
                <th className="px-2 py-1.5 text-right text-[10px] font-medium text-gray-700 uppercase tracking-wider">
                  &gt;90
                </th>
                <th className="px-2 py-1.5 text-left text-[10px] font-medium text-gray-700 uppercase tracking-wider">
                  {t('finance.oldestInvoice') || 'Oldest'}
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {loading ? (
                <tr>
                  <td colSpan={8} className="px-2 py-4 text-center text-gray-500 text-xs">
                    {t('common.loading') || 'Loading outstanding data...'}
                  </td>
                </tr>
              ) : outstandingParties.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-2 py-4 text-center text-gray-500 text-xs">
                    {t('finance.noOutstanding') || 'No outstanding amounts found'}
                  </td>
                </tr>
              ) : (
                outstandingParties.map(party => (
                  <tr key={party.id} className="hover:bg-gray-50">
                    <td className="px-2 py-1 text-xs font-medium text-gray-900">
                      {party.name}
                    </td>
                    <td className="px-2 py-1 text-xs text-gray-600">
                      {party.email || '-'}
                    </td>
                    <td className="px-2 py-1 whitespace-nowrap text-xs text-orange-600 text-right font-bold">
                      {formatAmount(party.total_outstanding)}
                    </td>
                    <td className="px-2 py-1 whitespace-nowrap text-xs text-green-600 text-right">
                      {party.age_0_30 > 0 ? formatAmount(party.age_0_30) : '-'}
                    </td>
                    <td className="px-2 py-1 whitespace-nowrap text-xs text-yellow-600 text-right">
                      {party.age_31_60 > 0 ? formatAmount(party.age_31_60) : '-'}
                    </td>
                    <td className="px-2 py-1 whitespace-nowrap text-xs text-orange-600 text-right">
                      {party.age_61_90 > 0 ? formatAmount(party.age_61_90) : '-'}
                    </td>
                    <td className="px-2 py-1 whitespace-nowrap text-xs text-red-600 text-right font-semibold">
                      {party.age_90_plus > 0 ? formatAmount(party.age_90_plus) : '-'}
                    </td>
                    <td className="px-2 py-1 whitespace-nowrap text-xs text-gray-600">
                      {party.oldest_invoice_date
                        ? new Date(party.oldest_invoice_date).toLocaleDateString('id-ID')
                        : '-'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
