import { useEffect, useMemo, useState } from 'react';
import { Calendar, AlertCircle, CheckCircle2, Clock, RefreshCw, FileWarning } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { formatFinancePeriodValue } from '../../../utils/financePeriod';
import { useFinance } from '../../../contexts/FinanceContext';
import { formatDate } from '../../../utils/dateFormat';
import { StatCard, StatCardGrid, SectionCard, EmptyState, paymentStatusLabel } from './TaxUI';

interface PeriodStatus {
  id: string;
  fiscal_year: number;
  period_month: number;
  tax_type: string;
  status: string;
  filing_status: string;
  payment_due_date: string | null;
  filing_due_date: string | null;
  net_ppn: number | null;
  pph_total: number | null;
  reconciled_payments_count: number;
  unreconciled_payments_count: number;
  missing_faktur_count: number;
  // Derived by the engine (vw_tax_period_status), shared with Register / Period Close.
  paid_amount: number | null;
  outstanding_amount: number | null;
  payment_status: string | null;
  payment_source: string | null;
}

function statusChip(period: PeriodStatus): { color: string; icon: JSX.Element; label: string } {
  // Single derived status from the engine — Calendar now matches Register /
  // Period Close / Dashboard exactly (no re-deriving overdue from stale status).
  const label = paymentStatusLabel(period.payment_status ?? 'open');
  switch (period.payment_status) {
    case 'closed':          return { color: 'bg-green-100 text-green-800', icon: <CheckCircle2 className="w-3 h-3" />, label };
    case 'filed':           return { color: 'bg-green-100 text-green-700', icon: <CheckCircle2 className="w-3 h-3" />, label };
    case 'paid':            return { color: 'bg-green-50 text-green-700',  icon: <CheckCircle2 className="w-3 h-3" />, label };
    case 'overpaid':        return { color: 'bg-purple-100 text-purple-800', icon: <CheckCircle2 className="w-3 h-3" />, label };
    case 'overdue':         return { color: 'bg-red-100 text-red-800',     icon: <AlertCircle className="w-3 h-3" />, label };
    case 'payment_pending': return { color: 'bg-yellow-100 text-yellow-800', icon: <Clock className="w-3 h-3" />, label };
    default:                return { color: 'bg-gray-100 text-gray-700',   icon: <Clock className="w-3 h-3" />, label: 'Open' };
  }
}

export function TaxCalendarPanel() {
  const { dateRange } = useFinance();
  const [rows, setRows] = useState<PeriodStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  async function refresh() {
    setLoading(true);
    const { data } = await supabase
      .from('vw_tax_period_status')
      .select('*')
      .order('fiscal_year', { ascending: false })
      .order('period_month', { ascending: false })
      .order('tax_type', { ascending: true })
      .limit(240);
    setRows((data as PeriodStatus[] | null) ?? []);
    setLoading(false);
  }

  useEffect(() => { void refresh(); }, []);

  const filtered = useMemo(() => {
    if (!dateRange?.startDate || !dateRange?.endDate) return rows;
    const start = new Date(dateRange.startDate);
    const end = new Date(dateRange.endDate);
    return rows.filter(r => {
      const first = new Date(r.fiscal_year, r.period_month - 1, 1);
      const last  = new Date(r.fiscal_year, r.period_month, 0);
      return last >= start && first <= end;
    });
  }, [rows, dateRange]);

  const grouped = useMemo(() => {
    const byPeriod = new Map<string, PeriodStatus[]>();
    for (const r of filtered) {
      const key = `${r.fiscal_year}-${String(r.period_month).padStart(2,'0')}`;
      const arr = byPeriod.get(key) ?? [];
      arr.push(r);
      byPeriod.set(key, arr);
    }
    return Array.from(byPeriod.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  }, [filtered]);

  const summary = useMemo(() => {
    const today = new Date();
    let overdue = 0, dueSoon = 0, missingFaktur = 0;
    for (const r of filtered) {
      // Use the engine's derived payment_status so Calendar counts match the
      // chips (and the Register / Dashboard) instead of the manual status.
      if (r.payment_status === 'overdue') {
        overdue++;
      } else if (!['paid', 'closed', 'filed'].includes(r.payment_status ?? '')) {
        const due = r.payment_due_date ? new Date(r.payment_due_date) : null;
        if (due && due >= today && (due.getTime() - today.getTime()) / 86400000 <= 7) dueSoon++;
      }
      missingFaktur += Number(r.missing_faktur_count || 0);
    }
    return { overdue, dueSoon, missingFaktur, periods: filtered.length };
  }, [filtered]);

  async function generateNotifications() {
    setRefreshing(true);
    try {
      const { error } = await supabase.rpc('generate_tax_notifications');
      if (error) throw error;
      await refresh();
    } catch (err) {
      alert('Failed to refresh notifications: ' + (err as Error).message);
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Calendar className="w-4 h-4 text-gray-500" />
          <span className="text-xs text-gray-500 hidden md:inline">
            {dateRange?.startDate ?? '—'} → {dateRange?.endDate ?? '—'}
          </span>
        </div>
        <button
          onClick={() => void generateNotifications()}
          disabled={refreshing}
          title="Push overdue / due-soon / waiting-for-Faktur items into the Dashboard notification stream"
          className="text-xs px-2 py-1 border border-gray-200 rounded-md hover:bg-gray-50 inline-flex items-center gap-1"
        >
          <RefreshCw className={`w-3 h-3 ${refreshing ? 'animate-spin' : ''}`} />
          Sync notifications
        </button>
      </div>

      {!loading && filtered.length > 0 && (
        <StatCardGrid cols={4}>
          <StatCard label="Overdue" value={summary.overdue} money={false} tone={summary.overdue > 0 ? 'red' : 'gray'} icon={<AlertCircle className="w-4 h-4" />} hint="Past payment due, unsettled" />
          <StatCard label="Due within 7 days" value={summary.dueSoon} money={false} tone={summary.dueSoon > 0 ? 'orange' : 'gray'} icon={<Clock className="w-4 h-4" />} />
            <StatCard label="Waiting for Faktur" value={summary.missingFaktur} money={false} tone={summary.missingFaktur > 0 ? 'orange' : 'gray'} icon={<FileWarning className="w-4 h-4" />} />
          <StatCard label="Periods in range" value={summary.periods} money={false} tone="blue" />
        </StatCardGrid>
      )}

      {loading ? (
        <p className="text-gray-500">Loading…</p>
      ) : grouped.length === 0 ? (
        <SectionCard>
          <EmptyState
            title="No tax periods yet"
            hint="Create a Sales Invoice, Purchase Invoice or Expense with a tax amount — the matching PPN period plus companion PPh periods will appear here automatically."
          />
        </SectionCard>
      ) : (
        <div className="space-y-2">
          {grouped.map(([periodKey, items]) => (
            <SectionCard key={periodKey} className="overflow-hidden">
              <div className="bg-gray-50 px-3 py-1.5 text-xs font-semibold text-gray-700 flex items-center justify-between border-b border-gray-100">
                <span>Period {formatFinancePeriodValue(periodKey)}</span>
                <span className="text-gray-500">{items.length} tax type(s)</span>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-xs">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="text-left px-2.5 py-1.5">Type</th>
                      <th className="text-left px-2.5 py-1.5">Status</th>
                      <th className="text-right px-2.5 py-1.5">Amount</th>
                      <th className="text-left px-2.5 py-1.5">Payment Due</th>
                      <th className="text-left px-2.5 py-1.5">Filing Due</th>
                      <th className="text-right px-2.5 py-1.5">Faktur</th>
                      <th className="text-right px-2.5 py-1.5">Reconciled</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map(r => {
                      const chip = statusChip(r);
                      const amount = r.tax_type === 'PPN' ? (r.net_ppn ?? 0) : (r.pph_total ?? 0);
                      return (
                        <tr key={r.id} className="border-t">
                          <td className="px-2.5 py-1.5 font-medium">{r.tax_type}</td>
                          <td className="px-2.5 py-1.5">
                            <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] ${chip.color}`}>
                              {chip.icon}{chip.label}
                            </span>
                          </td>
                          <td className="px-2.5 py-1.5 text-right tabular-nums">Rp {Number(amount ?? 0).toLocaleString('id-ID')}</td>
                          <td className="px-2.5 py-1.5 whitespace-nowrap">{r.payment_due_date ? formatDate(r.payment_due_date) : '—'}</td>
                          <td className="px-2.5 py-1.5 whitespace-nowrap">{r.filing_due_date ? formatDate(r.filing_due_date) : '—'}</td>
                          <td className="px-2.5 py-1.5 text-right">
                            {r.missing_faktur_count > 0
                              ? <span className="text-yellow-700 font-medium">{r.missing_faktur_count}</span>
                              : <span className="text-gray-400">0</span>}
                          </td>
                          <td className="px-2.5 py-1.5 text-right tabular-nums">{r.reconciled_payments_count}/{r.reconciled_payments_count + r.unreconciled_payments_count}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </SectionCard>
          ))}
        </div>
      )}
    </div>
  );
}
