import { useEffect, useMemo, useState } from 'react';
import { Lock, Unlock, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { formatFinancePeriod } from '../../../utils/financePeriod';
import { SectionCard, StatusChip, StatCard, StatCardGrid, EmptyState } from './TaxUI';

interface PeriodStatus {
  id: string;
  fiscal_year: number;
  period_month: number;
  tax_type: string;
  status: string;
  filing_status: string;
  missing_faktur_count: number;
  unreconciled_payments_count: number;
  reconciled_payments_count: number;
  net_ppn: number | null;
  pph_total: number | null;
  // Derived by the engine (vw_tax_period_status) — shown in the chip so the
  // Close screen reads the same Paid/Overdue as Calendar and Register.
  payment_status: string | null;
  outstanding_amount: number | null;
}
interface OutstandingRow { tax_period_id: string; outstanding_amount: number; }

export function PeriodClosePanel() {
  const [periods, setPeriods] = useState<PeriodStatus[]>([]);
  const [outstanding, setOutstanding] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reopenPrompt, setReopenPrompt] = useState<{ id: string; reason: string } | null>(null);

  async function refresh() {
    setLoading(true);
    const [ps, os] = await Promise.all([
      supabase.from('vw_tax_period_status').select('*').order('fiscal_year', { ascending: false }).order('period_month', { ascending: false }).limit(48),
      supabase.from('vw_outstanding_tax').select('tax_period_id, outstanding_amount'),
    ]);
    setPeriods((ps.data as PeriodStatus[] | null) ?? []);
    setOutstanding(Object.fromEntries(((os.data as OutstandingRow[] | null) ?? []).map(r => [r.tax_period_id, Number(r.outstanding_amount ?? 0)])));
    setLoading(false);
  }
  useEffect(() => { void refresh(); }, []);

  const summary = useMemo(() => {
    let ready = 0, closed = 0, blocked = 0;
    for (const p of periods) {
      if (p.status === 'closed') { closed++; continue; }
      const out = outstanding[p.id] ?? 0;
      const isBlocked = p.missing_faktur_count > 0 || p.unreconciled_payments_count > 0 || out > 0;
      if (isBlocked) blocked++; else ready++;
    }
    return { ready, closed, blocked };
  }, [periods, outstanding]);

  async function close(id: string) {
    setBusyId(id);
    try {
      const { error } = await supabase.rpc('close_tax_period', { p_period_id: id });
      if (error) throw error;
      await refresh();
    } catch (err) {
      alert('Cannot close period: ' + (err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function reopen() {
    if (!reopenPrompt) return;
    setBusyId(reopenPrompt.id);
    try {
      const { error } = await supabase.rpc('reopen_tax_period', {
        p_period_id: reopenPrompt.id,
        p_reason: reopenPrompt.reason,
      });
      if (error) throw error;
      setReopenPrompt(null);
      await refresh();
    } catch (err) {
      alert('Cannot reopen period: ' + (err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-2">
      {!loading && periods.length > 0 && (
        <StatCardGrid cols={3}>
          <StatCard label="Ready to close" value={summary.ready} money={false} tone={summary.ready > 0 ? 'green' : 'gray'} icon={<CheckCircle2 className="w-3.5 h-3.5" />} />
          <StatCard label="Blocked" value={summary.blocked} money={false} tone={summary.blocked > 0 ? 'red' : 'gray'} icon={<AlertTriangle className="w-3.5 h-3.5" />} hint="Faktur / reconcile / outstanding" />
          <StatCard label="Closed" value={summary.closed} money={false} tone="blue" icon={<Lock className="w-3.5 h-3.5" />} />
        </StatCardGrid>
      )}

      {loading ? (
        <p className="text-gray-500">Loading…</p>
      ) : periods.length === 0 ? (
        <SectionCard><EmptyState title="No tax periods to close" hint="Periods appear here once tax documents are posted." /></SectionCard>
      ) : (
        <SectionCard>
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left px-2.5 py-1.5">Period</th>
                <th className="text-left px-2.5 py-1.5">Type</th>
                <th className="text-left px-2.5 py-1.5">Status</th>
                <th className="text-right px-2.5 py-1.5">Amount</th>
                <th className="text-right px-2.5 py-1.5">Outstanding</th>
                <th className="text-left px-2.5 py-1.5">Blockers</th>
                <th className="px-2.5 py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {periods.map(p => {
                const amount = p.tax_type === 'PPN' ? (p.net_ppn ?? 0) : (p.pph_total ?? 0);
                const out = outstanding[p.id] ?? 0;
                const blockers: string[] = [];
                if (p.missing_faktur_count > 0) blockers.push(`${p.missing_faktur_count} Waiting for Faktur`);
                if (p.unreconciled_payments_count > 0) blockers.push(`${p.unreconciled_payments_count} unreconciled`);
                if (out > 0) blockers.push(`Rp ${out.toLocaleString('id-ID')} outstanding`);
                const canClose = p.status !== 'closed' && blockers.length === 0;
                return (
                  <tr key={p.id} className="border-t">
                    <td className="px-2.5 py-1.5 font-medium">{formatFinancePeriod(p.fiscal_year, p.period_month)}</td>
                    <td className="px-2.5 py-1.5">{p.tax_type}</td>
                    <td className="px-2.5 py-1.5"><StatusChip status={p.payment_status ?? p.status} /></td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums">Rp {Number(amount).toLocaleString('id-ID')}</td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums">{out > 0 ? <span className="text-red-700">Rp {out.toLocaleString('id-ID')}</span> : 'Rp 0'}</td>
                    <td className="px-2.5 py-1.5 text-[11px]">
                      {blockers.length === 0 ? (
                        <span className="text-green-700">Ready</span>
                      ) : (
                        <span className="text-red-700 inline-flex items-center gap-1"><AlertTriangle className="w-3 h-3" />{blockers.join(' · ')}</span>
                      )}
                    </td>
                    <td className="px-2.5 py-1.5 text-right">
                      {p.status === 'closed' ? (
                        <button
                          onClick={() => setReopenPrompt({ id: p.id, reason: '' })}
                          disabled={busyId === p.id}
                          className="text-[11px] px-1.5 py-0.5 border rounded hover:bg-gray-50 inline-flex items-center gap-1"
                        >
                          <Unlock className="w-3 h-3" /> Reopen
                        </button>
                      ) : (
                        <button
                          onClick={() => void close(p.id)}
                          disabled={!canClose || busyId === p.id}
                          className="text-[11px] px-1.5 py-0.5 border rounded hover:bg-gray-50 disabled:opacity-50 inline-flex items-center gap-1"
                        >
                          <Lock className="w-3 h-3" /> Close
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        </SectionCard>
      )}

      {reopenPrompt && (
        <div className="border rounded p-4 bg-yellow-50 space-y-2">
          <p className="text-sm font-medium">Reopen closed period — admin only</p>
          <textarea
            value={reopenPrompt.reason}
            onChange={e => setReopenPrompt(v => v ? { ...v, reason: e.target.value } : v)}
            placeholder="Reason for reopening (required, kept in audit log)"
            className="w-full border rounded px-2 py-1.5 text-sm"
            rows={3}
          />
          <div className="flex justify-end gap-2">
            <button onClick={() => setReopenPrompt(null)} className="px-3 py-1.5 text-sm border rounded">Cancel</button>
            <button
              onClick={() => void reopen()}
              disabled={!reopenPrompt.reason.trim()}
              className="px-3 py-1.5 text-sm bg-yellow-600 text-white rounded hover:bg-yellow-700 disabled:opacity-50"
            >
              Confirm Reopen
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
