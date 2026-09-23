import React, { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { History, TrendingUp, Tag, ArrowUpRight, CheckCircle2 } from 'lucide-react';
import { formatCurrency } from '../../utils/currency';

export interface PriceHistoryRecord {
  history_type: 'customer' | 'benchmark';
  ref_type: string;
  ref_number: string;
  ref_id: string;
  doc_date: string;
  currency: string;
  unit_price: number;
  quantity: number;
  customer_name: string;
}

interface Props {
  customerId?: string | null;
  productId?: string | null;
  currentCurrency?: string;
  onApplyPrice?: (price: number) => void;
  compact?: boolean;
}

export const CustomerPriceHistoryCard: React.FC<Props> = ({
  customerId,
  productId,
  currentCurrency = 'IDR',
  onApplyPrice,
  compact = false,
}) => {
  const [history, setHistory] = useState<PriceHistoryRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!productId) {
      setHistory([]);
      return;
    }

    let isMounted = true;
    const fetchHistory = async () => {
      setLoading(true);
      setError(null);
      try {
        const { data, error: rpcError } = await supabase.rpc('get_customer_product_price_history', {
          p_customer_id: customerId || null,
          p_product_id: productId,
        });

        if (rpcError) throw rpcError;
        if (isMounted) {
          setHistory(
            (data || []).map((row: any) => ({
              ...row,
              unit_price: Number(row.unit_price) || 0,
              quantity: Number(row.quantity) || 0,
            }))
          );
        }
      } catch (err: any) {
        if (isMounted) {
          console.error('Error fetching price history:', err.message);
          setError(err.message);
        }
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    fetchHistory();

    return () => {
      isMounted = false;
    };
  }, [customerId, productId]);

  if (!productId) return null;

  const customerRecords = history.filter(h => h.history_type === 'customer');
  const benchmarkRecords = history.filter(h => h.history_type === 'benchmark');

  if (loading) {
    return (
      <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-500 flex items-center gap-2 animate-pulse">
        <History className="w-4 h-4 animate-spin text-slate-400" />
        <span>Loading price history & rate card benchmarks...</span>
      </div>
    );
  }

  if (error) {
    return null; // Silently degrade so it never breaks order creation
  }

  if (history.length === 0) {
    return (
      <div className="p-2.5 bg-slate-50 border border-dashed border-slate-200 rounded-lg text-[11px] text-slate-500 flex items-center gap-1.5">
        <Tag className="w-3.5 h-3.5 text-slate-400" />
        <span>No historical transactions found for this product.</span>
      </div>
    );
  }

  return (
    <div className={`bg-gradient-to-br from-slate-50 to-blue-50/40 border border-blue-100 rounded-lg p-3 ${compact ? 'text-xs' : 'text-sm'} shadow-sm`}>
      <div className="flex items-center justify-between pb-2 mb-2 border-b border-blue-100">
        <div className="flex items-center gap-1.5">
          <History className="w-4 h-4 text-blue-600" />
          <span className="font-semibold text-slate-800 text-xs uppercase tracking-wide">
            Historical Pricing & Rate Card
          </span>
        </div>
        {customerRecords.length > 0 && (
          <span className="text-[10px] bg-blue-100 text-blue-800 font-medium px-2 py-0.5 rounded-full">
            {customerRecords.length} past order{customerRecords.length > 1 ? 's' : ''} to this customer
          </span>
        )}
      </div>

      {/* Customer Specific History */}
      {customerRecords.length > 0 ? (
        <div className="space-y-1.5 mb-2.5">
          <div className="text-[11px] font-semibold text-slate-600 flex items-center gap-1">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
            <span>Previous Customer Selling Prices:</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {customerRecords.slice(0, 4).map((rec, i) => (
              <div
                key={i}
                className="bg-white p-2 rounded border border-blue-200/80 hover:border-blue-400 transition shadow-xs flex items-center justify-between gap-2"
              >
                <div>
                  <div className="flex items-center gap-1.5 text-[10px] text-slate-500">
                    <span className="font-mono font-medium text-slate-700">{rec.ref_number}</span>
                    <span>•</span>
                    <span>{new Date(rec.doc_date).toLocaleDateString('en-GB')}</span>
                    <span>•</span>
                    <span>Qty: {rec.quantity.toLocaleString()}</span>
                  </div>
                  <div className="text-xs font-bold font-mono text-blue-900 mt-0.5">
                    {formatCurrency(rec.unit_price, rec.currency || currentCurrency)}
                  </div>
                </div>
                {onApplyPrice && (
                  <button
                    type="button"
                    onClick={() => onApplyPrice(rec.unit_price)}
                    className="px-2 py-1 text-[11px] bg-blue-50 hover:bg-blue-600 hover:text-white text-blue-700 font-medium rounded transition flex items-center gap-0.5"
                    title="Apply this historical price to order line"
                  >
                    Apply <ArrowUpRight className="w-3 h-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="mb-2 text-[11px] text-amber-700 bg-amber-50/80 border border-amber-200 rounded px-2.5 py-1">
          No previous sales to this customer yet. Refer to market benchmarks below.
        </div>
      )}

      {/* Benchmark / Rate Card History */}
      {benchmarkRecords.length > 0 && (
        <div>
          <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1 flex items-center gap-1">
            <TrendingUp className="w-3 h-3 text-slate-400" />
            <span>Market Benchmark / Rate Card (Other Customers)</span>
          </div>
          <div className="space-y-1">
            {benchmarkRecords.slice(0, 3).map((rec, i) => (
              <div
                key={i}
                className="bg-white/70 p-1.5 rounded border border-slate-200 text-[11px] flex items-center justify-between"
              >
                <div className="flex items-center gap-2 truncate max-w-[70%]">
                  <span className="font-mono text-slate-600 text-[10px]">{rec.ref_number}</span>
                  <span className="text-slate-500 truncate text-[10px]">{rec.customer_name}</span>
                  <span className="text-slate-400 text-[10px]">{new Date(rec.doc_date).toLocaleDateString('en-GB')}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-mono font-semibold text-slate-800 text-xs">
                    {formatCurrency(rec.unit_price, rec.currency || currentCurrency)}
                  </span>
                  {onApplyPrice && (
                    <button
                      type="button"
                      onClick={() => onApplyPrice(rec.unit_price)}
                      className="text-[10px] text-slate-600 hover:text-blue-700 font-medium hover:underline"
                    >
                      Use
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
