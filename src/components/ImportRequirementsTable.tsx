import { useState, useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { CheckSquare, Calendar, AlertTriangle, Package, TrendingUp, Edit2 } from 'lucide-react';

interface ImportRequirement {
  id: string;
  product_id: string;
  sales_order_id: string;
  customer_id: string;
  required_quantity: number;
  shortage_quantity: number;
  required_delivery_date: string;
  priority: 'high' | 'medium' | 'low';
  status: 'pending' | 'ordered' | 'partially_received' | 'received' | 'cancelled';
  lead_time_days: number;
  notes?: string;
  products?: { product_name: string; product_code: string };
  sales_orders?: { so_number: string };
  customers?: { company_name: string };
}

interface ImportRequirementsTableProps {
  requirements: ImportRequirement[];
  onRefresh: () => void;
  canEdit: boolean;
}

export function ImportRequirementsTable({ requirements, onRefresh, canEdit }: ImportRequirementsTableProps) {
  const [editingCell, setEditingCell] = useState<{ id: string; field: string } | null>(null);
  const [editValue, setEditValue] = useState<any>('');
  const inputRef = useRef<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(null);

  const priorityOptions = [
    { value: 'high', label: 'High', color: 'text-red-600', bgColor: 'bg-red-50' },
    { value: 'medium', label: 'Medium', color: 'text-orange-600', bgColor: 'bg-orange-50' },
    { value: 'low', label: 'Low', color: 'text-green-600', bgColor: 'bg-green-50' },
  ];

  const statusOptions = [
    { value: 'pending', label: 'Pending', color: 'text-gray-600', bgColor: 'bg-gray-50' },
    { value: 'ordered', label: 'Ordered', color: 'text-blue-600', bgColor: 'bg-blue-50' },
    { value: 'partially_received', label: 'Partially Received', color: 'text-yellow-600', bgColor: 'bg-yellow-50' },
    { value: 'received', label: 'Received', color: 'text-green-600', bgColor: 'bg-green-50' },
    { value: 'cancelled', label: 'Cancelled', color: 'text-red-600', bgColor: 'bg-red-50' },
  ];

  useEffect(() => {
    if (editingCell && inputRef.current) {
      inputRef.current.focus();
    }
  }, [editingCell]);

  const startEditing = (id: string, field: string, currentValue: any) => {
    console.log('startEditing called:', { id, field, currentValue, canEdit });
    if (!canEdit) {
      console.log('Cannot edit - canEdit is false');
      return;
    }
    setEditingCell({ id, field });
    setEditValue(currentValue || '');
    console.log('Editing cell set:', { id, field });
  };

  const cancelEditing = () => {
    setEditingCell(null);
    setEditValue('');
  };

  const saveEdit = async (id: string, field: string) => {
    try {
      const updateData: any = {};

      if (field === 'required_quantity' || field === 'shortage_quantity' || field === 'lead_time_days') {
        updateData[field] = Number(editValue);
      } else {
        updateData[field] = editValue;
      }

      const { error } = await supabase
        .from('import_requirements')
        .update(updateData)
        .eq('id', id);

      if (error) throw error;

      onRefresh();
      cancelEditing();
    } catch (error) {
      console.error('Error updating import requirement:', error);
      alert('Failed to update');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent, id: string, field: string) => {
    if (e.key === 'Enter') {
      saveEdit(id, field);
    } else if (e.key === 'Escape') {
      cancelEditing();
    }
  };

  const getPriorityStyle = (priority: string) => {
    const option = priorityOptions.find(o => o.value === priority);
    return option || priorityOptions[1];
  };

  const getStatusStyle = (status: string) => {
    const option = statusOptions.find(o => o.value === status);
    return option || statusOptions[0];
  };

  const getDaysUntilDelivery = (date: string) => {
    const today = new Date();
    const deliveryDate = new Date(date);
    const diffTime = deliveryDate.getTime() - today.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return diffDays;
  };

  const getDeliveryColor = (days: number) => {
    if (days < 0) return 'text-red-700 font-bold';
    if (days <= 7) return 'text-red-600 font-semibold';
    if (days <= 30) return 'text-orange-600';
    return 'text-gray-600';
  };

  return (
    <div className="overflow-x-auto border border-gray-200 rounded-lg">
      <table className="w-full">
        <thead className="bg-gray-50 border-b border-gray-200">
          <tr>
            <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Product</th>
            <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Sales Order</th>
            <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Customer</th>
            <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Required Qty</th>
            <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Shortage Qty</th>
            <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Delivery Date</th>
            <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Priority</th>
            <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Status</th>
            <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Lead Time</th>
            <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Notes</th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {requirements.map((req) => {
            const daysUntil = getDaysUntilDelivery(req.required_delivery_date);
            const priorityStyle = getPriorityStyle(req.priority);
            const statusStyle = getStatusStyle(req.status);

            return (
              <tr key={req.id} className="hover:bg-gray-50">
                <td className="px-4 py-3">
                  <div className="text-sm font-medium text-gray-900">{req.products?.product_name}</div>
                  <div className="text-xs text-gray-500">{req.products?.product_code}</div>
                </td>
                <td className="px-4 py-3 text-sm text-gray-900">{req.sales_orders?.so_number}</td>
                <td className="px-4 py-3 text-sm text-gray-900">{req.customers?.company_name}</td>

                <td className="px-4 py-3">
                  {editingCell?.id === req.id && editingCell.field === 'required_quantity' ? (
                    <input
                      ref={inputRef as React.RefObject<HTMLInputElement>}
                      type="number"
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onBlur={() => saveEdit(req.id, 'required_quantity')}
                      onKeyDown={(e) => handleKeyDown(e, req.id, 'required_quantity')}
                      className="w-full px-2 py-1 border border-blue-400 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  ) : (
                    <div
                      onClick={() => startEditing(req.id, 'required_quantity', req.required_quantity)}
                      className={`text-sm ${canEdit ? 'cursor-pointer hover:bg-gray-100 px-2 py-1 rounded' : ''}`}
                    >
                      {req.required_quantity.toLocaleString()}
                    </div>
                  )}
                </td>

                <td className="px-4 py-3 text-sm text-red-600 font-semibold">{req.shortage_quantity.toLocaleString()}</td>

                <td className="px-4 py-3">
                  {editingCell?.id === req.id && editingCell.field === 'required_delivery_date' ? (
                    <input
                      ref={inputRef as React.RefObject<HTMLInputElement>}
                      type="date"
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onBlur={() => saveEdit(req.id, 'required_delivery_date')}
                      onKeyDown={(e) => handleKeyDown(e, req.id, 'required_delivery_date')}
                      className="w-full px-2 py-1 border border-blue-400 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  ) : (
                    <div
                      onClick={() => startEditing(req.id, 'required_delivery_date', req.required_delivery_date)}
                      className={`${canEdit ? 'cursor-pointer hover:bg-gray-100 px-2 py-1 rounded' : ''}`}
                    >
                      <div className="text-sm">{new Date(req.required_delivery_date).toLocaleDateString()}</div>
                      <div className={`text-xs ${getDeliveryColor(daysUntil)}`}>
                        {daysUntil < 0 ? `${Math.abs(daysUntil)} days overdue` : `${daysUntil} days`}
                      </div>
                    </div>
                  )}
                </td>

                <td className="px-4 py-3">
                  {editingCell?.id === req.id && editingCell.field === 'priority' ? (
                    <select
                      ref={inputRef as React.RefObject<HTMLSelectElement>}
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onBlur={() => saveEdit(req.id, 'priority')}
                      className="w-full px-2 py-1 border border-blue-400 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      {priorityOptions.map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  ) : (
                    <div
                      onClick={() => startEditing(req.id, 'priority', req.priority)}
                      className={`inline-flex px-3 py-1 text-xs font-semibold rounded-full ${priorityStyle.color} ${priorityStyle.bgColor} ${canEdit ? 'cursor-pointer hover:opacity-80' : ''}`}
                    >
                      {priorityStyle.label}
                    </div>
                  )}
                </td>

                <td className="px-4 py-3">
                  {editingCell?.id === req.id && editingCell.field === 'status' ? (
                    <select
                      ref={inputRef as React.RefObject<HTMLSelectElement>}
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onBlur={() => saveEdit(req.id, 'status')}
                      className="w-full px-2 py-1 border border-blue-400 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      {statusOptions.map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  ) : (
                    <div
                      onClick={() => startEditing(req.id, 'status', req.status)}
                      className={`inline-flex px-3 py-1 text-xs font-semibold rounded-full ${statusStyle.color} ${statusStyle.bgColor} ${canEdit ? 'cursor-pointer hover:opacity-80' : ''}`}
                    >
                      {statusStyle.label}
                    </div>
                  )}
                </td>

                <td className="px-4 py-3">
                  {editingCell?.id === req.id && editingCell.field === 'lead_time_days' ? (
                    <input
                      ref={inputRef as React.RefObject<HTMLInputElement>}
                      type="number"
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onBlur={() => saveEdit(req.id, 'lead_time_days')}
                      onKeyDown={(e) => handleKeyDown(e, req.id, 'lead_time_days')}
                      className="w-full px-2 py-1 border border-blue-400 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  ) : (
                    <div
                      onClick={() => startEditing(req.id, 'lead_time_days', req.lead_time_days)}
                      className={`text-sm ${canEdit ? 'cursor-pointer hover:bg-gray-100 px-2 py-1 rounded' : ''}`}
                    >
                      {req.lead_time_days} days
                    </div>
                  )}
                </td>

                <td className="px-4 py-3">
                  {editingCell?.id === req.id && editingCell.field === 'notes' ? (
                    <textarea
                      ref={inputRef as React.RefObject<HTMLTextAreaElement>}
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onBlur={() => saveEdit(req.id, 'notes')}
                      rows={2}
                      className="w-full px-2 py-1 border border-blue-400 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  ) : (
                    <div
                      onClick={() => startEditing(req.id, 'notes', req.notes)}
                      className={`text-sm text-gray-600 max-w-xs truncate ${canEdit ? 'cursor-pointer hover:bg-gray-100 px-2 py-1 rounded' : ''}`}
                      title={req.notes || 'Click to add notes'}
                    >
                      {req.notes || '-'}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {requirements.length === 0 && (
        <div className="text-center py-8 text-gray-500">
          No import requirements found
        </div>
      )}
    </div>
  );
}
