import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { formatDate } from '../utils/dateFormat';
import { X, Package, AlertTriangle, ChevronDown, ChevronUp, ShoppingCart, Calendar, Layers } from 'lucide-react';

interface StockSummary {
  product_id: string;
  product_name: string;
  product_code: string;
  unit: string;
  category: string;
  total_current_stock: number;
  reserved_stock: number;
  available_quantity: number;
  active_batch_count: number;
  expired_batch_count: number;
  nearest_expiry_date: string | null;
}

interface BatchDetail {
  id: string;
  batch_number: string;
  current_stock: number;
  reserved_stock: number;
  available_quantity: number;
  import_quantity: number;
  import_date: string;
  expiry_date: string | null;
  import_price: number | null;
  import_price_usd: number | null;
  cost_per_unit: number | null;
  landed_cost_per_unit: number | null;
  per_pack_weight: number | null;
  pack_type: string | null;
  warehouse_location: string | null;
  supplier_name: string | null;
}

interface Reservation {
  id: string;
  batch_id: string;
  reserved_quantity: number;
  reserved_at: string;
  status: string;
  so_number: string | null;
  so_status: string | null;
  so_date: string | null;
  customer_name: string | null;
}

interface Props {
  product: StockSummary;
  onClose: () => void;
}

const isExpired = (d: string | null) => !!d && new Date(d) < new Date();
const isNearExpiry = (d: string | null) => {
  if (!d) return false;
  const soon = new Date();
  soon.setDate(soon.getDate() + 30);
  return new Date(d) <= soon && !isExpired(d);
};

export function StockDrillDownModal({ product, onClose }: Props) {
  const [batches, setBatches] = useState<BatchDetail[]>([]);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedBatch, setExpandedBatch] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'batches' | 'reservations'>('batches');

  useEffect(() => {
    loadData();
  }, [product.product_id]);

  const loadData = async () => {
    setLoading(true);
    await Promise.all([loadBatches(), loadReservations()]);
    setLoading(false);
  };

  const loadBatches = async () => {
    const { data } = await supabase
      .from('batches')
      .select(`
        id, batch_number, current_stock, reserved_stock, import_quantity,
        import_date, expiry_date, import_price, import_price_usd,
        cost_per_unit, landed_cost_per_unit, per_pack_weight, pack_type,
        warehouse_location, is_active,
        suppliers(company_name)
      `)
      .eq('product_id', product.product_id)
      .eq('is_active', true)
      .order('expiry_date', { ascending: true, nullsFirst: false });

    setBatches((data || []).map((b: any) => ({
      ...b,
      available_quantity: b.current_stock - (b.reserved_stock || 0),
      supplier_name: b.suppliers?.company_name || null,
    })));
  };

  const loadReservations = async () => {
    const { data } = await supabase
      .from('stock_reservations')
      .select(`
        id, batch_id, reserved_quantity, reserved_at, status,
        sales_orders(so_number, status, so_date,
          customers(company_name)
        )
      `)
      .eq('product_id', product.product_id)
      .eq('status', 'active')
      .order('reserved_at', { ascending: false });

    setReservations((data || []).map((r: any) => ({
      id: r.id,
      batch_id: r.batch_id,
      reserved_quantity: r.reserved_quantity,
      reserved_at: r.reserved_at,
      status: r.status,
      so_number: r.sales_orders?.so_number || null,
      so_status: r.sales_orders?.status || null,
      so_date: r.sales_orders?.so_date || null,
      customer_name: r.sales_orders?.customers?.company_name || null,
    })));
  };

  const reservationsByBatch = reservations.reduce((acc, r) => {
    if (!acc[r.batch_id]) acc[r.batch_id] = [];
    acc[r.batch_id].push(r);
    return acc;
  }, {} as Record<string, Reservation[]>);

  const totalImported = batches.reduce((s, b) => s + b.import_quantity, 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col">

        {/* Header */}
        <div className="flex items-start justify-between px-5 py-4 border-b">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-100 rounded-lg">
              <Package className="w-5 h-5 text-blue-600" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">{product.product_name}</h2>
              <div className="flex items-center gap-3 mt-0.5">
                {product.product_code && (
                  <span className="text-xs text-gray-400 font-mono">{product.product_code}</span>
                )}
                <span className="text-xs text-gray-400 capitalize">{product.category}</span>
                <span className="text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded font-medium">{product.unit}</span>
              </div>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors p-1 rounded">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-4 gap-3 px-5 py-3 border-b bg-gray-50">
          <div className="bg-white rounded-lg p-3 border border-gray-200">
            <p className="text-xs text-gray-500">Total Stock</p>
            <p className="text-xl font-bold text-gray-900">{product.total_current_stock.toLocaleString()}</p>
            <p className="text-xs text-gray-400">{product.unit}</p>
          </div>
          <div className="bg-white rounded-lg p-3 border border-orange-200">
            <p className="text-xs text-orange-600">Reserved</p>
            <p className={`text-xl font-bold ${product.reserved_stock > 0 ? 'text-orange-600' : 'text-gray-400'}`}>
              {product.reserved_stock.toLocaleString()}
            </p>
            <p className="text-xs text-gray-400">{product.unit}</p>
          </div>
          <div className="bg-white rounded-lg p-3 border border-green-200">
            <p className="text-xs text-green-600">Available</p>
            <p className={`text-xl font-bold ${product.available_quantity > 0 ? 'text-green-600' : 'text-red-600'}`}>
              {product.available_quantity.toLocaleString()}
            </p>
            <p className="text-xs text-gray-400">{product.unit}</p>
          </div>
          <div className="bg-white rounded-lg p-3 border border-blue-200">
            <p className="text-xs text-blue-600">Active Batches</p>
            <p className="text-xl font-bold text-blue-600">{product.active_batch_count}</p>
            {product.expired_batch_count > 0 && (
              <p className="text-xs text-red-500">{product.expired_batch_count} expired</p>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b px-5">
          <button
            onClick={() => setActiveTab('batches')}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${activeTab === 'batches' ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
          >
            <Layers className="w-3.5 h-3.5 inline mr-1.5" />
            Batches ({batches.length})
          </button>
          <button
            onClick={() => setActiveTab('reservations')}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${activeTab === 'reservations' ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
          >
            <ShoppingCart className="w-3.5 h-3.5 inline mr-1.5" />
            Reservations ({reservations.length})
            {reservations.length > 0 && (
              <span className="ml-1.5 bg-orange-100 text-orange-700 text-xs px-1.5 py-0.5 rounded-full font-semibold">
                {reservations.reduce((s, r) => s + Number(r.reserved_quantity), 0).toLocaleString()} {product.unit}
              </span>
            )}
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
            </div>
          ) : activeTab === 'batches' ? (

            <div className="divide-y">
              {batches.length === 0 ? (
                <div className="py-12 text-center text-gray-400">
                  <Package className="w-10 h-10 mx-auto mb-2 text-gray-300" />
                  <p className="text-sm">No active batches</p>
                </div>
              ) : batches.map(batch => {
                const batchReservations = reservationsByBatch[batch.id] || [];
                const isExpanded = expandedBatch === batch.id;
                const availPct = batch.import_quantity > 0
                  ? Math.round((batch.current_stock / batch.import_quantity) * 100)
                  : 0;

                return (
                  <div key={batch.id} className={`${isExpired(batch.expiry_date) ? 'bg-red-50' : isNearExpiry(batch.expiry_date) ? 'bg-orange-50' : ''}`}>
                    <div
                      className="px-5 py-3 cursor-pointer hover:bg-gray-50 transition-colors"
                      onClick={() => setExpandedBatch(isExpanded ? null : batch.id)}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          {isExpanded ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
                          <span className="font-mono text-sm font-semibold text-gray-800">{batch.batch_number}</span>
                          {isExpired(batch.expiry_date) && (
                            <span className="text-xs bg-red-100 text-red-700 px-1.5 py-0.5 rounded font-medium">EXPIRED</span>
                          )}
                          {isNearExpiry(batch.expiry_date) && (
                            <span className="text-xs bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded font-medium flex items-center gap-1">
                              <AlertTriangle className="w-3 h-3" />NEAR EXPIRY
                            </span>
                          )}
                          {batchReservations.length > 0 && (
                            <span className="text-xs bg-orange-50 border border-orange-200 text-orange-700 px-1.5 py-0.5 rounded">
                              {batchReservations.reduce((s, r) => s + Number(r.reserved_quantity), 0).toLocaleString()} reserved
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-6 text-sm">
                          <div className="text-right">
                            <p className="text-xs text-gray-400">Stock</p>
                            <p className="font-bold text-gray-800">{Number(batch.current_stock).toLocaleString()} <span className="text-xs font-normal text-gray-400">{product.unit}</span></p>
                          </div>
                          <div className="text-right">
                            <p className="text-xs text-orange-500">Reserved</p>
                            <p className="font-bold text-orange-600">{Number(batch.reserved_stock || 0).toLocaleString()} <span className="text-xs font-normal text-gray-400">{product.unit}</span></p>
                          </div>
                          <div className="text-right">
                            <p className="text-xs text-green-500">Available</p>
                            <p className={`font-bold ${batch.available_quantity > 0 ? 'text-green-600' : 'text-red-600'}`}>
                              {Number(batch.available_quantity).toLocaleString()} <span className="text-xs font-normal text-gray-400">{product.unit}</span>
                            </p>
                          </div>
                        </div>
                      </div>

                      {/* Progress bar */}
                      <div className="mt-2 ml-7">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-green-500 rounded-full transition-all"
                              style={{ width: `${Math.min(availPct, 100)}%` }}
                            />
                          </div>
                          <span className="text-xs text-gray-400 w-12 text-right">{availPct}% left</span>
                        </div>
                        <div className="flex items-center gap-4 mt-1 text-xs text-gray-400">
                          <span>Imported: {Number(batch.import_quantity).toLocaleString()} {product.unit}</span>
                          <span>Consumed: {(Number(batch.import_quantity) - Number(batch.current_stock)).toLocaleString()} {product.unit}</span>
                        </div>
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="px-5 pb-4 bg-gray-50 border-t border-gray-100">
                        <div className="grid grid-cols-2 gap-4 pt-3">
                          <div className="space-y-2">
                            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Batch Info</h4>
                            <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100">
                              <div className="flex justify-between px-3 py-1.5 text-sm">
                                <span className="text-gray-500">Batch No.</span>
                                <span className="font-mono font-semibold">{batch.batch_number}</span>
                              </div>
                              <div className="flex justify-between px-3 py-1.5 text-sm">
                                <span className="text-gray-500 flex items-center gap-1"><Calendar className="w-3 h-3" />Import Date</span>
                                <span>{formatDate(batch.import_date)}</span>
                              </div>
                              <div className="flex justify-between px-3 py-1.5 text-sm">
                                <span className="text-gray-500 flex items-center gap-1"><Calendar className="w-3 h-3" />Expiry Date</span>
                                <span className={isExpired(batch.expiry_date) ? 'text-red-600 font-semibold' : isNearExpiry(batch.expiry_date) ? 'text-orange-600 font-semibold' : ''}>
                                  {batch.expiry_date ? formatDate(batch.expiry_date) : '-'}
                                </span>
                              </div>
                              {batch.supplier_name && (
                                <div className="flex justify-between px-3 py-1.5 text-sm">
                                  <span className="text-gray-500">Supplier</span>
                                  <span className="font-medium text-right max-w-[180px]">{batch.supplier_name}</span>
                                </div>
                              )}
                              {batch.warehouse_location && (
                                <div className="flex justify-between px-3 py-1.5 text-sm">
                                  <span className="text-gray-500">Location</span>
                                  <span>{batch.warehouse_location}</span>
                                </div>
                              )}
                              {batch.pack_type && batch.per_pack_weight && (
                                <div className="flex justify-between px-3 py-1.5 text-sm">
                                  <span className="text-gray-500">Pack Size</span>
                                  <span>{batch.per_pack_weight} {product.unit}/{batch.pack_type}</span>
                                </div>
                              )}
                            </div>
                          </div>
                          <div className="space-y-2">
                            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Costing</h4>
                            <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100">
                              {batch.import_price_usd != null && batch.import_price_usd > 0 && (
                                <div className="flex justify-between px-3 py-1.5 text-sm">
                                  <span className="text-gray-500">Import Price (USD)</span>
                                  <span className="font-semibold">$ {Number(batch.import_price_usd).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                                </div>
                              )}
                              {batch.import_price != null && batch.import_price > 0 && (
                                <div className="flex justify-between px-3 py-1.5 text-sm">
                                  <span className="text-gray-500">Import Price (IDR)</span>
                                  <span>Rp {Number(batch.import_price).toLocaleString()}</span>
                                </div>
                              )}
                              {batch.cost_per_unit != null && batch.cost_per_unit > 0 && (
                                <div className="flex justify-between px-3 py-1.5 text-sm">
                                  <span className="text-gray-500">Cost/Unit</span>
                                  <span>Rp {Number(batch.cost_per_unit).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                                </div>
                              )}
                              {batch.landed_cost_per_unit != null && batch.landed_cost_per_unit > 0 && (
                                <div className="flex justify-between px-3 py-1.5 text-sm">
                                  <span className="text-gray-500">Landed Cost/Unit</span>
                                  <span className="font-semibold text-blue-600">Rp {Number(batch.landed_cost_per_unit).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>

                        {batchReservations.length > 0 && (
                          <div className="mt-3">
                            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
                              Active Reservations on this Batch
                            </h4>
                            <table className="w-full text-xs bg-white rounded-lg border border-orange-200 overflow-hidden">
                              <thead className="bg-orange-50">
                                <tr>
                                  <th className="text-left px-3 py-1.5 font-medium text-orange-700">Sales Order</th>
                                  <th className="text-left px-3 py-1.5 font-medium text-orange-700">Customer</th>
                                  <th className="text-left px-3 py-1.5 font-medium text-orange-700">SO Date</th>
                                  <th className="text-left px-3 py-1.5 font-medium text-orange-700">SO Status</th>
                                  <th className="text-right px-3 py-1.5 font-medium text-orange-700">Reserved Qty</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-orange-100">
                                {batchReservations.map(r => (
                                  <tr key={r.id}>
                                    <td className="px-3 py-1.5 font-mono font-semibold text-blue-600">{r.so_number || '-'}</td>
                                    <td className="px-3 py-1.5 text-gray-600">{r.customer_name || '-'}</td>
                                    <td className="px-3 py-1.5 text-gray-500">{r.so_date ? formatDate(r.so_date) : '-'}</td>
                                    <td className="px-3 py-1.5">
                                      <span className={`px-1.5 py-0.5 rounded text-xs font-medium capitalize ${
                                        r.so_status === 'shortage' ? 'bg-red-100 text-red-700' :
                                        r.so_status === 'stock_reserved' ? 'bg-orange-100 text-orange-700' :
                                        r.so_status === 'approved' ? 'bg-green-100 text-green-700' :
                                        'bg-gray-100 text-gray-600'
                                      }`}>{r.so_status?.replace(/_/g,' ') || '-'}</span>
                                    </td>
                                    <td className="px-3 py-1.5 text-right font-bold text-orange-600">
                                      {Number(r.reserved_quantity).toLocaleString()} {product.unit}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

          ) : (
            /* Reservations Tab */
            <div className="p-5">
              {reservations.length === 0 ? (
                <div className="py-12 text-center text-gray-400">
                  <ShoppingCart className="w-10 h-10 mx-auto mb-2 text-gray-300" />
                  <p className="text-sm">No active reservations</p>
                </div>
              ) : (
                <>
                  <div className="mb-3 px-3 py-2 bg-orange-50 border border-orange-200 rounded-lg text-sm text-orange-800 flex items-center gap-2">
                    <ShoppingCart className="w-4 h-4 text-orange-500 flex-shrink-0" />
                    <span>
                      <strong>{reservations.reduce((s, r) => s + Number(r.reserved_quantity), 0).toLocaleString()} {product.unit}</strong> reserved across <strong>{reservations.length}</strong> active reservation(s)
                    </span>
                  </div>
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b">
                      <tr>
                        <th className="text-left px-3 py-2 font-medium text-gray-500 text-xs uppercase">Sales Order</th>
                        <th className="text-left px-3 py-2 font-medium text-gray-500 text-xs uppercase">Customer</th>
                        <th className="text-left px-3 py-2 font-medium text-gray-500 text-xs uppercase">Batch</th>
                        <th className="text-left px-3 py-2 font-medium text-gray-500 text-xs uppercase">SO Date</th>
                        <th className="text-left px-3 py-2 font-medium text-gray-500 text-xs uppercase">SO Status</th>
                        <th className="text-right px-3 py-2 font-medium text-gray-500 text-xs uppercase">Reserved</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {reservations.map(r => {
                        const batch = batches.find(b => b.id === r.batch_id);
                        return (
                          <tr key={r.id} className="hover:bg-gray-50">
                            <td className="px-3 py-2 font-mono font-semibold text-blue-600">{r.so_number || '-'}</td>
                            <td className="px-3 py-2 text-gray-600">{r.customer_name || '-'}</td>
                            <td className="px-3 py-2 font-mono text-gray-600 text-xs">{batch?.batch_number || r.batch_id.slice(0,8)}</td>
                            <td className="px-3 py-2 text-gray-500 text-xs">{r.so_date ? formatDate(r.so_date) : '-'}</td>
                            <td className="px-3 py-2">
                              <span className={`px-1.5 py-0.5 rounded text-xs font-medium capitalize ${
                                r.so_status === 'shortage' ? 'bg-red-100 text-red-700' :
                                r.so_status === 'stock_reserved' ? 'bg-orange-100 text-orange-700' :
                                r.so_status === 'approved' ? 'bg-green-100 text-green-700' :
                                'bg-gray-100 text-gray-600'
                              }`}>{r.so_status?.replace(/_/g,' ') || '-'}</span>
                            </td>
                            <td className="px-3 py-2 text-right font-bold text-orange-600">
                              {Number(r.reserved_quantity).toLocaleString()} {product.unit}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot className="border-t-2 border-gray-200 bg-gray-50">
                      <tr>
                        <td colSpan={5} className="px-3 py-2 text-sm font-semibold text-gray-600">Total Reserved</td>
                        <td className="px-3 py-2 text-right font-bold text-orange-600">
                          {reservations.reduce((s, r) => s + Number(r.reserved_quantity), 0).toLocaleString()} {product.unit}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t bg-gray-50 flex items-center justify-between text-xs text-gray-400 rounded-b-xl">
          <span>Total imported: {totalImported.toLocaleString()} {product.unit} across {batches.length} active batch{batches.length !== 1 ? 'es' : ''}</span>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700 font-medium">Close</button>
        </div>
      </div>
    </div>
  );
}
