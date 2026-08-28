import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, Clock, FileText, CheckCircle2, TrendingUp } from 'lucide-react';
import { supabase } from '../../../lib/supabase';

interface Stats {
  ppnDueSoonPeriods: number;
  ppnDueAmount: number;
  pphOverdueCount: number;
  pphOverdueAmount: number;
  missingFakturCount: number;
  reconciledThisMonth: number;
  billingCodesExpiring: number;
}

const ZERO: Stats = {
  ppnDueSoonPeriods: 0,
  ppnDueAmount: 0,
  pphOverdueCount: 0,
  pphOverdueAmount: 0,
  missingFakturCount: 0,
  reconciledThisMonth: 0,
  billingCodesExpiring: 0,
};

interface Props { variant?: 'grid' | 'compact'; }

export function TaxComplianceDashboardCards({ variant = 'grid' }: Props) {
  const [s, setS] = useState<Stats>(ZERO);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => { void load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const today = new Date().toISOString().slice(0, 10);
      const in7  = new Date(Date.now() + 7*86400000).toISOString().slice(0, 10);
      const monthStart = new Date();
      monthStart.setDate(1);
      const monthStartStr = monthStart.toISOString().slice(0, 10);

      // Outstanding tax + due-date buckets
      const { data: outstanding } = await supabase
        .from('vw_outstanding_tax')
        .select('tax_type, payment_due_date, outstanding_amount');
      const outRows = (outstanding as { tax_type: string; payment_due_date: string | null; outstanding_amount: number }[] | null) ?? [];

      // A period stays in vw_outstanding_tax until its lifecycle status is
      // paid/closed, but settlement (Tax Payment or a reconciled PIB expense)
      // can drive outstanding_amount to 0 first — so gate on a real balance.
      const ppnDueSoon = outRows.filter(r => Number(r.outstanding_amount ?? 0) > 0.01 && r.tax_type === 'PPN' && r.payment_due_date && r.payment_due_date <= in7);
      const pphOverdue = outRows.filter(r => Number(r.outstanding_amount ?? 0) > 0.01 && r.tax_type !== 'PPN' && r.payment_due_date && r.payment_due_date < today);

      // Missing faktur across all open PPN periods
      const { data: status } = await supabase
        .from('vw_tax_period_status')
        .select('tax_type, status, missing_faktur_count');
      const missingFaktur = (status as { tax_type: string; status: string; missing_faktur_count: number }[] | null)
        ?.filter(r => r.tax_type === 'PPN' && r.status !== 'closed')
        .reduce((acc, r) => acc + (r.missing_faktur_count ?? 0), 0) ?? 0;

      // Reconciled this month
      const { count } = await supabase
        .from('tax_payments')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'reconciled')
        .gte('payment_date', monthStartStr);

      setS({
        ppnDueSoonPeriods: ppnDueSoon.length,
        ppnDueAmount: ppnDueSoon.reduce((a, r) => a + Number(r.outstanding_amount ?? 0), 0),
        pphOverdueCount: pphOverdue.length,
        pphOverdueAmount: pphOverdue.reduce((a, r) => a + Number(r.outstanding_amount ?? 0), 0),
        missingFakturCount: missingFaktur,
        reconciledThisMonth: count ?? 0,
        billingCodesExpiring: 0,
      });
    } catch (err) {
      console.error('TaxComplianceDashboardCards load failed', err);
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return <div className="text-xs text-gray-500">Loading tax compliance…</div>;
  }

  const cards = [
    {
      label: 'PPN due (next 7 days)',
      value: s.ppnDueSoonPeriods,
      subtitle: `Rp ${s.ppnDueAmount.toLocaleString('id-ID')}`,
      icon: <TrendingUp className="w-5 h-5" />,
      color: s.ppnDueSoonPeriods > 0 ? 'red' : 'gray',
    },
    {
      label: 'PPh overdue',
      value: s.pphOverdueCount,
      subtitle: `Rp ${s.pphOverdueAmount.toLocaleString('id-ID')}`,
      icon: <AlertCircle className="w-5 h-5" />,
      color: s.pphOverdueCount > 0 ? 'red' : 'gray',
    },
    {
      label: 'Waiting for Faktur',
      value: s.missingFakturCount,
      subtitle: s.missingFakturCount > 0 ? 'Invoices with PPN await the official Faktur' : 'All up to date',
      icon: <FileText className="w-5 h-5" />,
      color: s.missingFakturCount > 0 ? 'yellow' : 'green',
    },
    {
      label: 'Tax payments reconciled',
      value: s.reconciledThisMonth,
      subtitle: 'This month',
      icon: <CheckCircle2 className="w-5 h-5" />,
      color: 'green',
    },
    {
      label: 'Billing codes expiring',
      value: s.billingCodesExpiring,
      subtitle: 'Requires manual tracking',
      icon: <Clock className="w-5 h-5" />,
      color: 'gray',
    },
  ] as const;

  const colorClass = (c: string) => {
    switch (c) {
      case 'red':    return 'border-red-200 bg-red-50 text-red-800';
      case 'yellow': return 'border-yellow-200 bg-yellow-50 text-yellow-800';
      case 'green':  return 'border-green-200 bg-green-50 text-green-800';
      default:       return 'border-gray-200 bg-white text-gray-800';
    }
  };

  const container = variant === 'compact'
    ? 'grid grid-cols-2 lg:grid-cols-5 gap-1.5'
    : 'grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2';

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-700">Tax Compliance</h3>
        <button
          onClick={() => navigate('/finance/tax')}
          className="text-xs text-blue-600 hover:underline"
        >
          Open Tax Compliance Centre →
        </button>
      </div>
      <div className={container}>
        {cards.map(c => (
          <button
            key={c.label}
            onClick={() => navigate('/finance/tax')}
            className={`finance-card-button text-left border rounded-md px-2.5 py-1.5 hover:shadow-sm transition ${colorClass(c.color)}`}
          >
            <div className="flex items-start justify-between">
              <div>
                <p className="text-[11px] opacity-80">{c.label}</p>
                <p className="text-lg font-bold mt-0.5">{c.value}</p>
                <p className="text-[11px] mt-0.5 opacity-70">{c.subtitle}</p>
              </div>
              <div className="opacity-80">{c.icon}</div>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}
