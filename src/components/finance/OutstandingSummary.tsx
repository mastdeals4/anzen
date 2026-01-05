import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { Users, Building2, Download, AlertCircle, TrendingUp } from 'lucide-react';

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
  const [partyType, setPartyType] = useState<'customer' | 'supplier'>('customer');
  const [outstandingParties, setOutstandingParties] = useState<OutstandingParty[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadOutstanding();
  }, [partyType]);

  const loadOutstanding = async () => {
    setLoading(true);
    try {
      const today = new Date();
      const parties: OutstandingParty[] = [];

      if (partyType === 'customer') {
        const { data: customers } = await supabase
          .from('customers')
          .select('id, name, email')
          .order('name');

        if (!customers) return;

        for (const customer of customers) {
          const { data: invoices } = await supabase
            .from('sales_invoices')
            .select('id, invoice_date, total_amount, payment_status')
            .eq('customer_id', customer.id)
            .in('payment_status', ['pending', 'partial']);

          const { data: receipts } = await supabase
            .from('finance_receipt_vouchers')
            .select('amount')
            .eq('customer_id', customer.id);

          const { data: creditNotes } = await supabase
            .from('credit_notes')
            .select('total_amount')
            .eq('customer_id', customer.id);

          const totalInvoiced = invoices?.reduce((sum, inv) => sum + inv.total_amount, 0) || 0;
          const totalReceived = receipts?.reduce((sum, rec) => sum + rec.amount, 0) || 0;
          const totalCreditNotes = creditNotes?.reduce((sum, cn) => sum + cn.total_amount, 0) || 0;
          const outstanding = totalInvoiced - totalReceived - totalCreditNotes;

          if (outstanding > 0) {
            const aging = {
              age_0_30: 0,
              age_31_60: 0,
              age_61_90: 0,
              age_90_plus: 0,
            };

            let oldestDate: Date | null = null;

            invoices?.forEach(inv => {
              if (inv.payment_status === 'pending' || inv.payment_status === 'partial') {
                const invDate = new Date(inv.invoice_date);
                const daysOld = Math.floor((today.getTime() - invDate.getTime()) / (1000 * 60 * 60 * 24));

                if (!oldestDate || invDate < oldestDate) {
                  oldestDate = invDate;
                }

                if (daysOld <= 30) {
                  aging.age_0_30 += inv.total_amount;
                } else if (daysOld <= 60) {
                  aging.age_31_60 += inv.total_amount;
                } else if (daysOld <= 90) {
                  aging.age_61_90 += inv.total_amount;
                } else {
                  aging.age_90_plus += inv.total_amount;
                }
              }
            });

            parties.push({
              id: customer.id,
              name: customer.name,
              email: customer.email,
              total_outstanding: outstanding,
              oldest_invoice_date: oldestDate?.toISOString(),
              ...aging,
            });
          }
        }
      } else {
        const { data: suppliers } = await supabase
          .from('suppliers')
          .select('id, name, email')
          .order('name');

        if (!suppliers) return;

        for (const supplier of suppliers) {
          const { data: invoices } = await supabase
            .from('finance_purchase_invoices')
            .select('id, invoice_date, total_amount, payment_status')
            .eq('supplier_id', supplier.id)
            .in('payment_status', ['pending', 'partial']);

          const { data: payments } = await supabase
            .from('finance_payment_vouchers')
            .select('amount')
            .eq('supplier_id', supplier.id);

          const totalInvoiced = invoices?.reduce((sum, inv) => sum + inv.total_amount, 0) || 0;
          const totalPaid = payments?.reduce((sum, pay) => sum + pay.amount, 0) || 0;
          const outstanding = totalInvoiced - totalPaid;

          if (outstanding > 0) {
            const aging = {
              age_0_30: 0,
              age_31_60: 0,
              age_61_90: 0,
              age_90_plus: 0,
            };

            let oldestDate: Date | null = null;

            invoices?.forEach(inv => {
              if (inv.payment_status === 'pending' || inv.payment_status === 'partial') {
                const invDate = new Date(inv.invoice_date);
                const daysOld = Math.floor((today.getTime() - invDate.getTime()) / (1000 * 60 * 60 * 24));

                if (!oldestDate || invDate < oldestDate) {
                  oldestDate = invDate;
                }

                if (daysOld <= 30) {
                  aging.age_0_30 += inv.total_amount;
                } else if (daysOld <= 60) {
                  aging.age_31_60 += inv.total_amount;
                } else if (daysOld <= 90) {
                  aging.age_61_90 += inv.total_amount;
                } else {
                  aging.age_90_plus += inv.total_amount;
                }
              }
            });

            parties.push({
              id: supplier.id,
              name: supplier.name,
              email: supplier.email,
              total_outstanding: outstanding,
              oldest_invoice_date: oldestDate?.toISOString(),
              ...aging,
            });
          }
        }
      }

      parties.sort((a, b) => b.total_outstanding - a.total_outstanding);
      setOutstandingParties(parties);
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
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {partyType === 'customer' ? (
            <TrendingUp className="w-5 h-5 text-orange-600" />
          ) : (
            <AlertCircle className="w-5 h-5 text-red-600" />
          )}
          <h2 className="text-xl font-semibold text-gray-800">
            {partyType === 'customer' ? 'Receivables' : 'Payables'} Outstanding Summary
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={exportToCSV}
            disabled={outstandingParties.length === 0}
            className="flex items-center gap-2 px-3 py-1.5 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Download className="w-4 h-4" />
            Export
          </button>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-sm p-4">
        <div className="flex items-center gap-4 mb-4">
          <label className="block text-sm font-medium text-gray-700">Party Type:</label>
          <div className="flex gap-2">
            <button
              onClick={() => setPartyType('customer')}
              className={`px-4 py-2 rounded-lg font-medium ${
                partyType === 'customer'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              <Users className="w-4 h-4 inline mr-1" />
              Customers (Receivables)
            </button>
            <button
              onClick={() => setPartyType('supplier')}
              className={`px-4 py-2 rounded-lg font-medium ${
                partyType === 'supplier'
                  ? 'bg-purple-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              <Building2 className="w-4 h-4 inline mr-1" />
              Suppliers (Payables)
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-5 gap-4 p-4 bg-gradient-to-r from-orange-50 to-red-50 rounded-lg">
          <div>
            <p className="text-xs font-medium text-gray-600 uppercase">Total Outstanding</p>
            <p className="text-lg font-bold text-orange-600">{formatAmount(totalOutstanding)}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-gray-600 uppercase">0-30 Days</p>
            <p className="text-lg font-bold text-green-600">{formatAmount(total0_30)}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-gray-600 uppercase">31-60 Days</p>
            <p className="text-lg font-bold text-yellow-600">{formatAmount(total31_60)}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-gray-600 uppercase">61-90 Days</p>
            <p className="text-lg font-bold text-orange-600">{formatAmount(total61_90)}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-gray-600 uppercase">&gt;90 Days</p>
            <p className="text-lg font-bold text-red-600">{formatAmount(total90_plus)}</p>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-3 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                  {partyType === 'customer' ? 'Customer' : 'Supplier'}
                </th>
                <th className="px-3 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                  Email
                </th>
                <th className="px-3 py-3 text-right text-xs font-medium text-gray-700 uppercase tracking-wider">
                  Total Outstanding
                </th>
                <th className="px-3 py-3 text-right text-xs font-medium text-gray-700 uppercase tracking-wider">
                  0-30 Days
                </th>
                <th className="px-3 py-3 text-right text-xs font-medium text-gray-700 uppercase tracking-wider">
                  31-60 Days
                </th>
                <th className="px-3 py-3 text-right text-xs font-medium text-gray-700 uppercase tracking-wider">
                  61-90 Days
                </th>
                <th className="px-3 py-3 text-right text-xs font-medium text-gray-700 uppercase tracking-wider">
                  &gt;90 Days
                </th>
                <th className="px-3 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                  Oldest Invoice
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {loading ? (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center text-gray-500">
                    Loading outstanding data...
                  </td>
                </tr>
              ) : outstandingParties.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center text-gray-500">
                    No outstanding amounts found
                  </td>
                </tr>
              ) : (
                outstandingParties.map(party => (
                  <tr key={party.id} className="hover:bg-gray-50">
                    <td className="px-3 py-2 text-sm font-medium text-gray-900">
                      {party.name}
                    </td>
                    <td className="px-3 py-2 text-sm text-gray-600">
                      {party.email || '-'}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-sm text-orange-600 text-right font-bold">
                      {formatAmount(party.total_outstanding)}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-sm text-green-600 text-right">
                      {party.age_0_30 > 0 ? formatAmount(party.age_0_30) : '-'}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-sm text-yellow-600 text-right">
                      {party.age_31_60 > 0 ? formatAmount(party.age_31_60) : '-'}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-sm text-orange-600 text-right">
                      {party.age_61_90 > 0 ? formatAmount(party.age_61_90) : '-'}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-sm text-red-600 text-right font-semibold">
                      {party.age_90_plus > 0 ? formatAmount(party.age_90_plus) : '-'}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-600">
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
