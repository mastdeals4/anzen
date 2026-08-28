import { Fragment, useState } from 'react';
import { ChevronDown, ChevronRight, Package, ExternalLink, Box } from 'lucide-react';
import { formatDate } from '../utils/dateFormat';
import { type ImportRequirement, STATUS_OPTIONS } from './ImportRequirementsTable';
import { type ImportContainer } from '../pages/ImportRequirements';
import { useNavigation } from '../contexts/NavigationContext';
import { supabase } from '../lib/supabase';
import { SearchableSelect } from './SearchableSelect';
import { showToast } from './ToastNotification';

interface ProductSummaryRow {
  product_id: string;
  product_name: string;
  product_code: string;
  so_count: number;
  total_required_qty: number;
  total_ordered_qty: number;
  total_allocated_qty: number;
  total_received_qty: number;
  total_remaining_qty: number;
  procurement_summary_status: 'pending' | 'partial' | 'fully_ordered' | 'fully_received';
  earliest_delivery_date: string;
  highest_priority: 'high' | 'medium' | 'low';
}

interface Props {
  summaryRows: ProductSummaryRow[];
  detailRows: ImportRequirement[];
  containers: ImportContainer[];
  loading: boolean;
  onRefresh: () => void;
}

export function ImportRequirementsProductSummary({
  summaryRows,
  detailRows,
  containers,
  loading,
  onRefresh,
}: Props) {
  const { setCurrentPage } = useNavigation();
  const [expandedProducts, setExpandedProducts] = useState<Set<string>>(new Set());
  const [savingCell, setSavingCell] = useState<string | null>(null);

  const toggleExpand = (productId: string) => {
    setExpandedProducts(prev => {
      const next = new Set(prev);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });
  };

  // Sort children by delivery date ascending
  const getChildRows = (productId: string) =>
    detailRows
      .filter(r => r.product_id === productId)
      .sort((a, b) =>
        new Date(a.required_delivery_date).getTime() - new Date(b.required_delivery_date).getTime()
      );

  const getStatusStyle = (status: string) =>
    STATUS_OPTIONS.find(o => o.value === status) ?? STATUS_OPTIONS[0];

  const getContainerRef = (containerId: string | null | undefined) =>
    containerId ? containers.find(c => c.id === containerId)?.container_ref ?? null : null;

  const containerOptions = [
    { value: '', label: '— No container —' },
    ...containers.map(c => ({ value: c.id, label: c.container_ref })),
  ];

  const saveContainerForRow = async (reqId: string, containerId: string) => {
    setSavingCell(reqId);
    try {
      const { error } = await supabase
        .from('import_requirements')
        .update({ import_container_id: containerId || null })
        .eq('id', reqId);
      if (error) throw error;
      onRefresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      showToast({ type: 'error', title: 'Error', message: 'Failed to update container: ' + msg });
    } finally {
      setSavingCell(null);
    }
  };

  const saveOrderedQtyForRow = async (reqId: string, value: string) => {
    const qty = Number(value);
    if (isNaN(qty) || qty < 0) return;
    setSavingCell(reqId + '_qty');
    try {
      const { error } = await supabase
        .from('import_requirements')
        .update({ ordered_qty: qty })
        .eq('id', reqId);
      if (error) throw error;
      onRefresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      showToast({ type: 'error', title: 'Error', message: 'Failed to update ordered qty: ' + msg });
    } finally {
      setSavingCell(null);
    }
  };

  if (loading) {
    return <div className="p-10 text-center text-gray-400 text-sm">Loading…</div>;
  }

  if (summaryRows.length === 0) {
    return (
      <div className="p-10 text-center text-gray-400 text-sm">
        No active import requirements
      </div>
    );
  }

  // Sort alphabetically by product name (A-Z) — client-side, leaves DB view sort untouched
  const sortedRows = [...summaryRows].sort((a, b) =>
    a.product_name.localeCompare(b.product_name)
  );

  // Columns: expand | Product | Required | Ordered | Remaining | Containers | SOs | Earliest Delivery
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 border-b border-gray-200">
          <tr>
            <th className="w-8"></th>
            <th className="px-3 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Product</th>
            <th className="px-3 py-2.5 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Required Qty</th>
            <th className="px-3 py-2.5 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Ordered Qty</th>
            <th className="px-3 py-2.5 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Remaining Qty</th>
            <th className="px-3 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Containers</th>
            <th className="px-3 py-2.5 text-center text-xs font-semibold text-gray-500 uppercase tracking-wider">SOs</th>
            <th className="px-3 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Earliest Delivery</th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-100">
          {sortedRows.map((row) => {
            const isExpanded = expandedProducts.has(row.product_id);
            const children = getChildRows(row.product_id);

            // Distinct containers allocated across all child SOs for this product
            const allocatedContainerIds = new Set(
              children.map(c => c.import_container_id).filter(Boolean)
            );
            const containerCount = allocatedContainerIds.size;

            return (
              <Fragment key={row.product_id}>
                {/* Summary row — click anywhere to expand */}
                <tr
                  className="hover:bg-gray-50 cursor-pointer transition-colors"
                  onClick={() => toggleExpand(row.product_id)}
                >
                  <td className="pl-3 pr-1 py-3 text-center">
                    {isExpanded
                      ? <ChevronDown className="w-4 h-4 text-gray-400 mx-auto" />
                      : <ChevronRight className="w-4 h-4 text-gray-300 mx-auto" />}
                  </td>

                  {/* Product name + code */}
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-2">
                      <Package className="w-3.5 h-3.5 text-blue-400 flex-shrink-0" />
                      <div>
                        <div className="font-semibold text-gray-900 text-sm leading-tight">{row.product_name}</div>
                        <div className="text-xs text-gray-400 font-mono mt-0.5">{row.product_code}</div>
                      </div>
                    </div>
                  </td>

                  {/* Required */}
                  <td className="px-3 py-3 text-right">
                    <span className="text-sm font-semibold text-gray-800">{row.total_required_qty.toLocaleString()}</span>
                  </td>

                  {/* Ordered */}
                  <td className="px-3 py-3 text-right">
                    <span className="text-sm font-semibold text-indigo-700">{row.total_ordered_qty.toLocaleString()}</span>
                  </td>

                  {/* Remaining — red when > 0 */}
                  <td className="px-3 py-3 text-right">
                    <span className={`text-sm font-semibold ${row.total_remaining_qty > 0 ? 'text-red-600' : 'text-green-600'}`}>
                      {row.total_remaining_qty.toLocaleString()}
                    </span>
                  </td>

                  {/* Containers allocated */}
                  <td className="px-3 py-3">
                    {containerCount > 0 ? (
                      <span className="inline-flex items-center gap-1 text-xs text-teal-700 font-medium">
                        <Box className="w-3.5 h-3.5" />
                        {containerCount} container{containerCount !== 1 ? 's' : ''}
                      </span>
                    ) : (
                      <span className="text-xs text-gray-300">—</span>
                    )}
                  </td>

                  {/* SO count */}
                  <td className="px-3 py-3 text-center">
                    <span className="inline-flex items-center justify-center w-5 h-5 bg-gray-100 text-gray-600 text-xs font-semibold rounded-full">
                      {row.so_count}
                    </span>
                  </td>

                  {/* Earliest delivery */}
                  <td className="px-3 py-3 text-xs text-gray-500">
                    {row.earliest_delivery_date ? formatDate(row.earliest_delivery_date) : '—'}
                  </td>
                </tr>

                {/* Expanded child rows — sorted by delivery date (earliest first) */}
                {isExpanded && children.map((child) => {
                  const childStatus = getStatusStyle(child.status);
                  const childOrdered = child.ordered_qty ?? 0;
                  const childRemaining = Math.max(child.required_quantity - childOrdered, 0);
                  const containerRef = getContainerRef(child.import_container_id);

                  return (
                    <tr
                      key={child.id}
                      className="bg-blue-50/30 border-l-2 border-l-blue-200"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {/* indent */}
                      <td className="pl-3 pr-1 py-2"></td>

                      {/* SO number + customer */}
                      <td className="px-3 py-2 pl-7">
                        <div className="flex flex-col gap-0.5">
                          <span className="font-mono text-xs text-blue-700 bg-blue-100 px-1.5 py-0.5 rounded w-fit">
                            {child.sales_orders?.so_number}
                          </span>
                          <span className="text-xs text-gray-400">{child.customers?.company_name}</span>
                        </div>
                      </td>

                      {/* Required qty */}
                      <td className="px-3 py-2 text-right text-xs text-gray-600">
                        {child.required_quantity.toLocaleString()}
                      </td>

                      {/* Ordered qty — inline editable */}
                      <td className="px-3 py-2 text-right">
                        <input
                          type="number"
                          min="0"
                          defaultValue={childOrdered}
                          onBlur={(e) => {
                            const val = e.target.value;
                            if (Number(val) !== childOrdered) saveOrderedQtyForRow(child.id, val);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                          }}
                          disabled={savingCell === child.id + '_qty'}
                          className="w-20 text-right px-1.5 py-0.5 text-xs border border-gray-200 rounded focus:border-blue-400 focus:ring-1 focus:ring-blue-400 outline-none text-indigo-700 font-medium disabled:opacity-50"
                        />
                      </td>

                      {/* Remaining — computed */}
                      <td className="px-3 py-2 text-right">
                        <span className={`text-xs font-semibold ${childRemaining > 0 ? 'text-red-600' : 'text-green-600'}`}>
                          {childRemaining.toLocaleString()}
                        </span>
                      </td>

                      {/* Container selector + link — spans last 3 cols (Containers + SOs + Earliest Delivery) */}
                      <td className="px-3 py-2" colSpan={3}>
                        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                          {/* Status badge — compact, before container */}
                          <span className={`inline-flex px-1.5 py-0.5 text-xs font-medium rounded-full flex-shrink-0 ${childStatus.color} ${childStatus.bgColor}`}>
                            {childStatus.label}
                          </span>
                          <div className="w-44">
                            <SearchableSelect
                              value={child.import_container_id ?? ''}
                              onChange={(val) => saveContainerForRow(child.id, val)}
                              options={containerOptions}
                              placeholder="Assign container…"
                              className="text-xs py-0.5 border-gray-200"
                              disabled={savingCell === child.id}
                            />
                          </div>
                          {containerRef && (
                            <button
                              type="button"
                              onClick={() => setCurrentPage('import-containers')}
                              className="inline-flex items-center gap-1 text-xs text-teal-600 hover:text-teal-800 hover:underline flex-shrink-0"
                              title="Open Import Containers"
                            >
                              <ExternalLink className="w-3 h-3" />
                              {containerRef}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
