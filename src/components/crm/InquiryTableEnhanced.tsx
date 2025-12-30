import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { Edit, Trash2, FileText, Mail, Phone, Calendar, CheckCircle, XCircle, Clock, Flame, ArrowUp, Minus, Filter, X, Search } from 'lucide-react';
import { Modal } from '../Modal';

interface Inquiry {
  id: string;
  inquiry_number: string;
  inquiry_date: string;
  product_name: string;
  specification?: string | null;
  quantity: string;
  supplier_name: string | null;
  supplier_country: string | null;
  company_name: string;
  contact_person: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  email_subject: string | null;
  status: string;
  priority: string;
  coa_sent: boolean;
  coa_sent_date: string | null;
  msds_sent: boolean;
  msds_sent_date: string | null;
  sample_sent: boolean;
  sample_sent_date: string | null;
  price_quoted: boolean;
  price_quoted_date: string | null;
  remarks: string | null;
  internal_notes: string | null;
  created_at: string;
  user_profiles?: {
    full_name: string;
  };
}

interface InquiryTableProps {
  inquiries: Inquiry[];
  onEdit: (inquiry: Inquiry) => void;
  onDelete: (id: string) => void;
  onRefresh: () => void;
  canManage: boolean;
}

interface Filters {
  search: string;
  status: string[];
  priority: string[];
  dateFrom: string;
  dateTo: string;
}

export function InquiryTableEnhanced({ inquiries, onEdit, onDelete, onRefresh, canManage }: InquiryTableProps) {
  const [selectedInquiry, setSelectedInquiry] = useState<Inquiry | null>(null);
  const [detailModalOpen, setDetailModalOpen] = useState(false);
  const [updatingDocument, setUpdatingDocument] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState<Filters>({
    search: '',
    status: [],
    priority: [],
    dateFrom: '',
    dateTo: '',
  });
  const [editingCell, setEditingCell] = useState<{ id: string; field: string } | null>(null);
  const [editValue, setEditValue] = useState('');
  const [filteredInquiries, setFilteredInquiries] = useState<Inquiry[]>(inquiries);

  useEffect(() => {
    applyFilters();
  }, [inquiries, filters]);

  const applyFilters = () => {
    let result = [...inquiries];

    if (filters.search) {
      const searchLower = filters.search.toLowerCase();
      result = result.filter(
        i =>
          i.product_name.toLowerCase().includes(searchLower) ||
          i.company_name.toLowerCase().includes(searchLower) ||
          i.inquiry_number.toLowerCase().includes(searchLower) ||
          (i.specification && i.specification.toLowerCase().includes(searchLower)) ||
          (i.supplier_name && i.supplier_name.toLowerCase().includes(searchLower))
      );
    }

    if (filters.status.length > 0) {
      result = result.filter(i => filters.status.includes(i.status));
    }

    if (filters.priority.length > 0) {
      result = result.filter(i => filters.priority.includes(i.priority));
    }

    if (filters.dateFrom) {
      result = result.filter(i => i.inquiry_date >= filters.dateFrom);
    }

    if (filters.dateTo) {
      result = result.filter(i => i.inquiry_date <= filters.dateTo);
    }

    setFilteredInquiries(result);
  };

  const clearFilters = () => {
    setFilters({
      search: '',
      status: [],
      priority: [],
      dateFrom: '',
      dateTo: '',
    });
  };

  const statusConfig = {
    new: { label: 'New', color: 'bg-gray-100 text-gray-800' },
    price_quoted: { label: 'Price Quoted', color: 'bg-blue-100 text-blue-800' },
    coa_pending: { label: 'COA Pending', color: 'bg-yellow-100 text-yellow-800' },
    sample_sent: { label: 'Sample Sent', color: 'bg-purple-100 text-purple-800' },
    negotiation: { label: 'Negotiation', color: 'bg-orange-100 text-orange-800' },
    po_received: { label: 'PO Received', color: 'bg-green-100 text-green-800' },
    won: { label: 'Won', color: 'bg-green-100 text-green-800' },
    lost: { label: 'Lost', color: 'bg-red-100 text-red-800' },
    on_hold: { label: 'On Hold', color: 'bg-gray-100 text-gray-800' },
  };

  const getPriorityIcon = (priority: string) => {
    switch (priority) {
      case 'urgent':
        return <Flame className="w-4 h-4 text-red-600" title="Urgent" />;
      case 'high':
        return <ArrowUp className="w-4 h-4 text-orange-600" title="High" />;
      case 'medium':
      case 'low':
      default:
        return <Minus className="w-4 h-4 text-gray-400" title={priority === 'low' ? 'Low' : 'Medium'} />;
    }
  };

  const toggleStatusFilter = (status: string) => {
    setFilters(prev => ({
      ...prev,
      status: prev.status.includes(status)
        ? prev.status.filter(s => s !== status)
        : [...prev.status, status],
    }));
  };

  const togglePriorityFilter = (priority: string) => {
    setFilters(prev => ({
      ...prev,
      priority: prev.priority.includes(priority)
        ? prev.priority.filter(p => p !== priority)
        : [...prev.priority, priority],
    }));
  };

  const toggleDocument = async (inquiry: Inquiry, docType: 'coa' | 'msds' | 'sample' | 'price') => {
    setUpdatingDocument(true);
    try {
      const currentValue = inquiry[`${docType}_sent` as keyof Inquiry];
      const updates: any = {
        [`${docType}_sent`]: !currentValue,
      };

      if (!currentValue) {
        updates[`${docType}_sent_date`] = new Date().toISOString().split('T')[0];
      } else {
        updates[`${docType}_sent_date`] = null;
      }

      const { error } = await supabase
        .from('crm_inquiries')
        .update(updates)
        .eq('id', inquiry.id);

      if (error) throw error;
      onRefresh();
    } catch (error) {
      console.error('Error updating document status:', error);
    } finally {
      setUpdatingDocument(false);
    }
  };

  const startEditing = (inquiry: Inquiry, field: string) => {
    if (!canManage) return;
    setEditingCell({ id: inquiry.id, field });
    setEditValue(inquiry[field as keyof Inquiry] as string || '');
  };

  const saveEdit = async () => {
    if (!editingCell) return;

    try {
      const { error } = await supabase
        .from('crm_inquiries')
        .update({ [editingCell.field]: editValue || null })
        .eq('id', editingCell.id);

      if (error) throw error;
      setEditingCell(null);
      onRefresh();
    } catch (error) {
      console.error('Error updating field:', error);
    }
  };

  const cancelEdit = () => {
    setEditingCell(null);
    setEditValue('');
  };

  const sendEmail = (inquiry: Inquiry) => {
    if (inquiry.contact_email) {
      window.location.href = `mailto:${inquiry.contact_email}?subject=Re: ${inquiry.product_name}`;
    }
  };

  const makeCall = (inquiry: Inquiry) => {
    if (inquiry.contact_phone) {
      window.location.href = `tel:${inquiry.contact_phone}`;
    }
  };

  const viewDetails = (inquiry: Inquiry) => {
    setSelectedInquiry(inquiry);
    setDetailModalOpen(true);
  };

  const activeFiltersCount = filters.status.length + filters.priority.length + (filters.search ? 1 : 0) + (filters.dateFrom ? 1 : 0) + (filters.dateTo ? 1 : 0);

  return (
    <>
      <div className="mb-4 space-y-3">
        <div className="flex items-center gap-3">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
            <input
              type="text"
              placeholder="Search product, company, inquiry #..."
              value={filters.search}
              onChange={(e) => setFilters({ ...filters, search: e.target.value })}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`flex items-center gap-2 px-4 py-2 border rounded-lg transition ${
              showFilters ? 'bg-blue-50 border-blue-300 text-blue-700' : 'border-gray-300 text-gray-700 hover:bg-gray-50'
            }`}
          >
            <Filter className="w-5 h-5" />
            Filters
            {activeFiltersCount > 0 && (
              <span className="ml-1 px-2 py-0.5 bg-blue-600 text-white text-xs rounded-full">
                {activeFiltersCount}
              </span>
            )}
          </button>
          {activeFiltersCount > 0 && (
            <button
              onClick={clearFilters}
              className="flex items-center gap-2 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
            >
              <X className="w-4 h-4" />
              Clear
            </button>
          )}
        </div>

        {showFilters && (
          <div className="p-4 border border-gray-200 rounded-lg bg-gray-50 space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Status</label>
              <div className="flex flex-wrap gap-2">
                {Object.entries(statusConfig).map(([key, { label, color }]) => (
                  <button
                    key={key}
                    onClick={() => toggleStatusFilter(key)}
                    className={`px-3 py-1 rounded-full text-xs font-medium transition ${
                      filters.status.includes(key)
                        ? 'ring-2 ring-blue-500 ' + color
                        : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Priority</label>
              <div className="flex flex-wrap gap-2">
                {['urgent', 'high', 'medium', 'low'].map((priority) => (
                  <button
                    key={priority}
                    onClick={() => togglePriorityFilter(priority)}
                    className={`px-3 py-1 rounded-full text-xs font-medium uppercase transition ${
                      filters.priority.includes(priority)
                        ? 'ring-2 ring-blue-500 bg-blue-100 text-blue-800'
                        : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                    }`}
                  >
                    {priority}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Date From</label>
                <input
                  type="date"
                  value={filters.dateFrom}
                  onChange={(e) => setFilters({ ...filters, dateFrom: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Date To</label>
                <input
                  type="date"
                  value={filters.dateTo}
                  onChange={(e) => setFilters({ ...filters, dateTo: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
          </div>
        )}

        <div className="text-sm text-gray-600">
          Showing {filteredInquiries.length} of {inquiries.length} inquiries
        </div>
      </div>

      <div className="bg-white rounded-lg shadow overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-2 py-2 text-center font-semibold text-gray-700" title="Priority">⚡</th>
                <th className="px-3 py-2 text-left font-semibold text-gray-700 whitespace-nowrap">No.</th>
                <th className="px-3 py-2 text-left font-semibold text-gray-700 whitespace-nowrap">Date</th>
                <th className="px-3 py-2 text-left font-semibold text-gray-700">Product</th>
                <th className="px-3 py-2 text-left font-semibold text-gray-700">Specification</th>
                <th className="px-3 py-2 text-left font-semibold text-gray-700">Qty</th>
                <th className="px-3 py-2 text-left font-semibold text-gray-700">Supplier</th>
                <th className="px-3 py-2 text-left font-semibold text-gray-700">Company</th>
                <th className="px-3 py-2 text-left font-semibold text-gray-700">Status</th>
                <th className="px-3 py-2 text-center font-semibold text-gray-700">Docs</th>
                <th className="px-3 py-2 text-left font-semibold text-gray-700">Remarks</th>
                {canManage && <th className="px-3 py-2 text-center font-semibold text-gray-700">Quick Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {filteredInquiries.length === 0 ? (
                <tr>
                  <td colSpan={canManage ? 12 : 11} className="px-3 py-8 text-center text-gray-500">
                    No inquiries found
                  </td>
                </tr>
              ) : (
                filteredInquiries.map((inquiry) => (
                  <tr key={inquiry.id} className="hover:bg-gray-50 transition">
                    <td className="px-2 py-2 text-center">
                      {getPriorityIcon(inquiry.priority)}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <button
                        onClick={() => viewDetails(inquiry)}
                        className="text-blue-600 hover:text-blue-800 font-medium"
                      >
                        {inquiry.inquiry_number}
                      </button>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-gray-600">
                      {new Date(inquiry.inquiry_date).toLocaleDateString('en-GB')}
                    </td>
                    <td className="px-3 py-2 max-w-xs">
                      {editingCell?.id === inquiry.id && editingCell?.field === 'product_name' ? (
                        <input
                          type="text"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={saveEdit}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveEdit();
                            if (e.key === 'Escape') cancelEdit();
                          }}
                          className="w-full px-2 py-1 border border-blue-500 rounded focus:ring-2 focus:ring-blue-500"
                          autoFocus
                        />
                      ) : (
                        <div
                          className="truncate cursor-pointer hover:bg-blue-50"
                          title={inquiry.product_name}
                          onDoubleClick={() => startEditing(inquiry, 'product_name')}
                        >
                          {inquiry.product_name}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 max-w-xs">
                      {editingCell?.id === inquiry.id && editingCell?.field === 'specification' ? (
                        <input
                          type="text"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={saveEdit}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveEdit();
                            if (e.key === 'Escape') cancelEdit();
                          }}
                          className="w-full px-2 py-1 border border-blue-500 rounded focus:ring-2 focus:ring-500"
                          autoFocus
                        />
                      ) : (
                        <div
                          className="truncate text-gray-600 text-xs cursor-pointer hover:bg-blue-50"
                          title={inquiry.specification || ''}
                          onDoubleClick={() => startEditing(inquiry, 'specification')}
                        >
                          {inquiry.specification || '-'}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">{inquiry.quantity}</td>
                    <td className="px-3 py-2">
                      <div className="max-w-xs">
                        {inquiry.supplier_name && (
                          <div className="font-medium truncate">{inquiry.supplier_name}</div>
                        )}
                        {inquiry.supplier_country && (
                          <div className="text-xs text-gray-500">{inquiry.supplier_country}</div>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="max-w-xs truncate" title={inquiry.company_name}>
                        {inquiry.company_name}
                      </div>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className={`inline-block px-2 py-1 rounded-full text-xs font-medium ${statusConfig[inquiry.status as keyof typeof statusConfig]?.color || 'bg-gray-100 text-gray-800'}`}>
                        {statusConfig[inquiry.status as keyof typeof statusConfig]?.label || inquiry.status}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex gap-1 justify-center">
                        <button
                          onClick={() => canManage && toggleDocument(inquiry, 'coa')}
                          disabled={!canManage || updatingDocument}
                          className={`p-1 rounded ${inquiry.coa_sent ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400'} ${canManage ? 'hover:bg-green-200' : 'cursor-default'}`}
                          title={inquiry.coa_sent ? `COA sent on ${inquiry.coa_sent_date}` : 'COA not sent'}
                        >
                          <span className="text-xs font-semibold">C</span>
                        </button>
                        <button
                          onClick={() => canManage && toggleDocument(inquiry, 'msds')}
                          disabled={!canManage || updatingDocument}
                          className={`p-1 rounded ${inquiry.msds_sent ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400'} ${canManage ? 'hover:bg-green-200' : 'cursor-default'}`}
                          title={inquiry.msds_sent ? `MSDS sent on ${inquiry.msds_sent_date}` : 'MSDS not sent'}
                        >
                          <span className="text-xs font-semibold">M</span>
                        </button>
                        <button
                          onClick={() => canManage && toggleDocument(inquiry, 'sample')}
                          disabled={!canManage || updatingDocument}
                          className={`p-1 rounded ${inquiry.sample_sent ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400'} ${canManage ? 'hover:bg-green-200' : 'cursor-default'}`}
                          title={inquiry.sample_sent ? `Sample sent on ${inquiry.sample_sent_date}` : 'Sample not sent'}
                        >
                          <span className="text-xs font-semibold">S</span>
                        </button>
                        <button
                          onClick={() => canManage && toggleDocument(inquiry, 'price')}
                          disabled={!canManage || updatingDocument}
                          className={`p-1 rounded ${inquiry.price_quoted ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400'} ${canManage ? 'hover:bg-green-200' : 'cursor-default'}`}
                          title={inquiry.price_quoted ? `Price quoted on ${inquiry.price_quoted_date}` : 'Price not quoted'}
                        >
                          <span className="text-xs font-semibold">P</span>
                        </button>
                      </div>
                    </td>
                    <td className="px-3 py-2 max-w-xs">
                      {editingCell?.id === inquiry.id && editingCell?.field === 'remarks' ? (
                        <input
                          type="text"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={saveEdit}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveEdit();
                            if (e.key === 'Escape') cancelEdit();
                          }}
                          className="w-full px-2 py-1 border border-blue-500 rounded focus:ring-2 focus:ring-blue-500"
                          autoFocus
                        />
                      ) : (
                        <div
                          className="truncate text-gray-600 cursor-pointer hover:bg-blue-50"
                          title={inquiry.remarks || ''}
                          onDoubleClick={() => startEditing(inquiry, 'remarks')}
                        >
                          {inquiry.remarks || '-'}
                        </div>
                      )}
                    </td>
                    {canManage && (
                      <td className="px-3 py-2">
                        <div className="flex gap-1 justify-center">
                          {inquiry.contact_email && (
                            <button
                              onClick={() => sendEmail(inquiry)}
                              className="p-1 text-blue-600 hover:bg-blue-50 rounded"
                              title="Send Email"
                            >
                              <Mail className="w-4 h-4" />
                            </button>
                          )}
                          {inquiry.contact_phone && (
                            <button
                              onClick={() => makeCall(inquiry)}
                              className="p-1 text-green-600 hover:bg-green-50 rounded"
                              title="Call"
                            >
                              <Phone className="w-4 h-4" />
                            </button>
                          )}
                          <button
                            onClick={() => onEdit(inquiry)}
                            className="p-1 text-gray-600 hover:bg-gray-50 rounded"
                            title="Edit"
                          >
                            <Edit className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => onDelete(inquiry.id)}
                            className="p-1 text-red-600 hover:bg-red-50 rounded"
                            title="Delete"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Detail Modal */}
      {selectedInquiry && (
        <Modal
          isOpen={detailModalOpen}
          onClose={() => setDetailModalOpen(false)}
          title={`Inquiry #${selectedInquiry.inquiry_number}`}
        >
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium text-gray-700">Product</label>
                <p className="text-gray-900">{selectedInquiry.product_name}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700">Specification</label>
                <p className="text-gray-900">{selectedInquiry.specification || '-'}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700">Quantity</label>
                <p className="text-gray-900">{selectedInquiry.quantity}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700">Company</label>
                <p className="text-gray-900">{selectedInquiry.company_name}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700">Contact Person</label>
                <p className="text-gray-900">{selectedInquiry.contact_person || '-'}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700">Contact Email</label>
                <p className="text-gray-900">{selectedInquiry.contact_email || '-'}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700">Contact Phone</label>
                <p className="text-gray-900">{selectedInquiry.contact_phone || '-'}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700">Status</label>
                <p className="text-gray-900">
                  <span className={`inline-block px-2 py-1 rounded-full text-xs font-medium ${statusConfig[selectedInquiry.status as keyof typeof statusConfig]?.color}`}>
                    {statusConfig[selectedInquiry.status as keyof typeof statusConfig]?.label}
                  </span>
                </p>
              </div>
            </div>
            {selectedInquiry.remarks && (
              <div>
                <label className="text-sm font-medium text-gray-700">Remarks</label>
                <p className="text-gray-900">{selectedInquiry.remarks}</p>
              </div>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
