import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CalendarDays, CheckCircle2, ChevronRight, ClipboardList, RefreshCw, Truck } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useNavigation } from '../../contexts/NavigationContext';
import {
  fetchWarehouseDeliveryQueue,
  type WarehouseDeliveryOrder,
  type WarehouseDeliveryPriority,
} from '../../utils/salesOrderDeliveryAlerts';

const priorities: Array<{ key: WarehouseDeliveryPriority; title: string; empty: string; tone: string }> = [
  { key: 'overdue', title: 'Overdue', empty: 'No overdue customer deliveries', tone: 'red' },
  { key: 'today', title: 'Due Today', empty: 'No customer deliveries due today', tone: 'orange' },
  { key: 'tomorrow', title: 'Due Tomorrow', empty: 'No customer deliveries due tomorrow', tone: 'yellow' },
  { key: 'upcoming', title: 'Upcoming — next 7 days', empty: 'No upcoming customer deliveries', tone: 'blue' },
];

const dateLabel = (value: string) => new Date(`${value}T00:00:00`).toLocaleDateString('en-GB', {
  day: '2-digit', month: 'short', year: 'numeric',
});

export function WarehouseDeliveryDashboard() {
  const { profile } = useAuth();
  const { setCurrentPage, setNavigationData } = useNavigation();
  const [orders, setOrders] = useState<WarehouseDeliveryOrder[]>([]);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (initial = false) => {
    if (initial) setLoading(true); else setRefreshing(true);
    try {
      setError(null);
      setOrders(await fetchWarehouseDeliveryQueue());
    } catch (err) {
      console.error('[WarehouseDeliveryDashboard] load error', err);
      setError('Unable to load delivery commitments. Please try again.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { load(true); }, []);

  const ordersByPriority = useMemo(() => priorities.reduce((groups, priority) => ({
    ...groups,
    [priority.key]: orders.filter((order) => order.priority === priority.key),
  }), {} as Record<WarehouseDeliveryPriority, WarehouseDeliveryOrder[]>), [orders]);
  const dates = useMemo(() => Array.from(new Set(orders.map((order) => order.expectedDeliveryDate))).sort(), [orders]);
  const visibleOrders = selectedDate ? orders.filter((order) => order.expectedDeliveryDate === selectedDate) : orders;

  const openSalesOrder = (order: WarehouseDeliveryOrder) => {
    setNavigationData({ salesOrderId: order.soId });
    setCurrentPage('sales-orders');
  };

  const card = (order: WarehouseDeliveryOrder) => (
    <button
      key={order.soId}
      type="button"
      onClick={() => openSalesOrder(order)}
      className="w-full text-left rounded-lg border border-gray-200 bg-white p-3 hover:border-blue-300 hover:bg-blue-50/30 transition"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-xs font-semibold text-blue-700">{order.soNumber}</p>
          <p className="mt-0.5 text-sm font-semibold text-gray-900 truncate">{order.customerName}</p>
        </div>
        <span className="shrink-0 text-xs text-gray-600">{dateLabel(order.expectedDeliveryDate)}</span>
      </div>
      <div className="mt-2 space-y-1.5">
        {order.items.map((item) => (
          <div key={item.productId} className="text-xs text-gray-600">
            <span className="font-medium text-gray-800">{item.productName}</span>
            <span className="ml-1">— ordered {item.orderedQuantity} {item.unit}; delivered {item.deliveredQuantity}; remaining <strong>{item.remainingQuantity}</strong></span>
            {item.itemDeliveryDate && item.itemDeliveryDate !== order.expectedDeliveryDate && (
              <span className="ml-1 text-gray-400">(item due {dateLabel(item.itemDeliveryDate)})</span>
            )}
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center justify-between gap-2 text-xs">
        <span className={`rounded-full px-2 py-0.5 font-medium ${order.status === 'partial' ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-700'}`}>
          {order.status === 'partial' ? 'Partial delivery' : 'Pending delivery'}
        </span>
        <span className="flex items-center gap-1 text-gray-500">
          {order.deliveryChallanNumbers.length ? `Approved DC: ${order.deliveryChallanNumbers.join(', ')}` : 'Create or prepare DC'}
          <ChevronRight className="h-3.5 w-3.5" />
        </span>
      </div>
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-blue-100 bg-gradient-to-r from-blue-50 to-indigo-50 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Warehouse Delivery Queue</h1>
            <p className="mt-1 text-sm text-gray-600">Outbound customer Sales Order commitments — prepare delivery challans and deliveries.</p>
            <p className="mt-1 text-xs text-gray-500">Welcome, {profile?.full_name || profile?.username || 'Warehouse'}.</p>
          </div>
          <button onClick={() => load(false)} disabled={refreshing} className="flex shrink-0 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50">
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>
      </div>

      {error ? <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div> : loading ? (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">{[...Array(4)].map((_, index) => <div key={index} className="h-40 animate-pulse rounded-xl border border-gray-100 bg-white" />)}</div>
      ) : <>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {priorities.map((priority) => (
            <div key={priority.key} className="rounded-xl border border-gray-100 bg-white p-3">
              <p className="text-xs font-medium text-gray-500">{priority.title}</p>
              <p className="mt-1 text-2xl font-bold text-gray-900">{ordersByPriority[priority.key].length}</p>
            </div>
          ))}
        </div>

        <div className="rounded-xl border border-gray-100 bg-white p-4">
          <div className="mb-3 flex items-center gap-2"><CalendarDays className="h-4 w-4 text-blue-600" /><h2 className="text-sm font-semibold text-gray-900">Delivery dates</h2></div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setSelectedDate(null)} className={`rounded-lg px-3 py-1.5 text-xs font-medium ${selectedDate === null ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}>All ({orders.length})</button>
            {dates.map((date) => <button key={date} onClick={() => setSelectedDate(date)} className={`rounded-lg px-3 py-1.5 text-xs font-medium ${selectedDate === date ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}>{dateLabel(date)} ({orders.filter((order) => order.expectedDeliveryDate === date).length})</button>)}
          </div>
        </div>

        {selectedDate ? (
          <section className="space-y-2"><h2 className="text-sm font-semibold text-gray-900">Due {dateLabel(selectedDate)}</h2>{visibleOrders.map(card)}</section>
        ) : priorities.map((priority) => (
          <section key={priority.key} className="rounded-xl border border-gray-100 bg-white">
            <div className="flex items-center gap-2 border-b border-gray-100 px-4 py-3">
              {priority.key === 'overdue' ? <AlertTriangle className="h-4 w-4 text-red-500" /> : priority.key === 'today' ? <Truck className="h-4 w-4 text-orange-500" /> : <ClipboardList className="h-4 w-4 text-blue-500" />}
              <h2 className="text-sm font-semibold text-gray-900">{priority.title}</h2>
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-bold text-gray-600">{ordersByPriority[priority.key].length}</span>
            </div>
            <div className="space-y-2 p-3">
              {ordersByPriority[priority.key].length ? ordersByPriority[priority.key].map(card) : <div className="flex items-center gap-2 py-2 text-sm text-gray-400"><CheckCircle2 className="h-4 w-4 text-green-500" />{priority.empty}</div>}
            </div>
          </section>
        ))}
      </>}
    </div>
  );
}
