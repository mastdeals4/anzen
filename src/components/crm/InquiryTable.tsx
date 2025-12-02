import { useState } from 'react';
import { supabase } from '../../lib/supabase';
import { Edit, Trash2, FileText, Calendar, CheckCircle, XCircle, Clock, Flame, ArrowUp, Minus } from 'lucide-react';
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

export function InquiryTable({ inquiries, onEdit, onDelete, onRefresh, canManage }: InquiryTableProps) {
  const [selectedInquiry, setSelectedInquiry] = useState<Inquiry | null>(null);
  const [detailModalOpen, setDetailModalOpen] = useState(false);
  const [updatingDocument, setUpdatingDocument] = useState(false);

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

  const priorityConfig = {
    urgent: { label: 'URGENT', color: 'bg-red-100 text-red-800' },
    high: { label: 'HIGH', color: 'bg-orange-100 text-orange-800' },
    medium: { label: 'MED', color: 'bg-yellow-100 text-yellow-800' },
    low: { label: 'LOW', color: 'bg-gray-100 text-gray-800' },
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
      alert('Failed to update document status');
    } finally {
      setUpdatingDocument(false);
    }
  };

  const viewDetails = (inquiry: Inquiry) => {
    setSelectedInquiry(inquiry);
    setDetailModalOpen(true);
  };

  return (
    <>
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
                {canManage && <th className="px-3 py-2 text-center font-semibold text-gray-700">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {inquiries.length === 0 ? (
                <tr>
                  <td colSpan={canManage ? 12 : 11} className="px-3 py-8 text-center text-gray-500">
                    No inquiries found
                  </td>
                </tr>
              ) : (
                inquiries.map((inquiry) => (
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
                      <div className="truncate" title={inquiry.product_name}>
                        {inquiry.product_name}
                      </div>
                    </td>
                    <td className="px-3 py-2 max-w-xs">
                      <div className="truncate text-gray-600 text-xs" title={inquiry.specification || ''}>
                        {inquiry.specification || '-'}
                      </div>
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
                      <div className="truncate text-gray-600" title={inquiry.remarks || ''}>
                        {inquiry.remarks || '-'}
                      </div>
                    </td>
                    {canManage && (
                      <td className="px-3 py-2">
                        <div className="flex gap-1 justify-center">
                          <button
                            onClick={() => onEdit(inquiry)}
                            className="p-1 text-blue-600 hover:bg-blue-50 rounded"
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

      <Modal
        isOpen={detailModalOpen}
        onClose={() => {
          setDetailModalOpen(false);
          setSelectedInquiry(null);
        }}
        title={`Inquiry Details - ${selectedInquiry?.inquiry_number}`}
      >
        {selectedInquiry && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium text-gray-700">Date</label>
                <p className="text-gray-900">{new Date(selectedInquiry.inquiry_date).toLocaleDateString('en-GB')}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700">Priority</label>
                <p>
                  <span className={`inline-block px-2 py-1 rounded-full text-xs font-medium ${priorityConfig[selectedInquiry.priority as keyof typeof priorityConfig]?.color}`}>
                    {priorityConfig[selectedInquiry.priority as keyof typeof priorityConfig]?.label}
                  </span>
                </p>
              </div>
            </div>

            <div>
              <label className="text-sm font-medium text-gray-700">Product</label>
              <p className="text-gray-900">{selectedInquiry.product_name}</p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium text-gray-700">Quantity</label>
                <p className="text-gray-900">{selectedInquiry.quantity}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700">Status</label>
                <p>
                  <span className={`inline-block px-2 py-1 rounded-full text-xs font-medium ${statusConfig[selectedInquiry.status as keyof typeof statusConfig]?.color}`}>
                    {statusConfig[selectedInquiry.status as keyof typeof statusConfig]?.label}
                  </span>
                </p>
              </div>
            </div>

            {(selectedInquiry.supplier_name || selectedInquiry.supplier_country) && (
              <div className="grid grid-cols-2 gap-4">
                {selectedInquiry.supplier_name && (
                  <div>
                    <label className="text-sm font-medium text-gray-700">Supplier</label>
                    <p className="text-gray-900">{selectedInquiry.supplier_name}</p>
                  </div>
                )}
                {selectedInquiry.supplier_country && (
                  <div>
                    <label className="text-sm font-medium text-gray-700">Country</label>
                    <p className="text-gray-900">{selectedInquiry.supplier_country}</p>
                  </div>
                )}
              </div>
            )}

            <div className="border-t pt-4">
              <label className="text-sm font-medium text-gray-700 mb-2 block">Company & Contact</label>
              <div className="space-y-2">
                <p className="text-gray-900 font-medium">{selectedInquiry.company_name}</p>
                {selectedInquiry.contact_person && (
                  <p className="text-sm text-gray-600">Contact: {selectedInquiry.contact_person}</p>
                )}
                {selectedInquiry.contact_email && (
                  <p className="text-sm text-gray-600">Email: {selectedInquiry.contact_email}</p>
                )}
                {selectedInquiry.contact_phone && (
                  <p className="text-sm text-gray-600">Phone: {selectedInquiry.contact_phone}</p>
                )}
              </div>
            </div>

            <div className="border-t pt-4">
              <label className="text-sm font-medium text-gray-700 mb-2 block">Documents Status</label>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex items-center gap-2">
                  {selectedInquiry.coa_sent ? (
                    <CheckCircle className="w-5 h-5 text-green-600" />
                  ) : (
                    <XCircle className="w-5 h-5 text-gray-400" />
                  )}
                  <div>
                    <p className="text-sm font-medium">COA</p>
                    {selectedInquiry.coa_sent_date && (
                      <p className="text-xs text-gray-500">Sent: {new Date(selectedInquiry.coa_sent_date).toLocaleDateString('en-GB')}</p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {selectedInquiry.msds_sent ? (
                    <CheckCircle className="w-5 h-5 text-green-600" />
                  ) : (
                    <XCircle className="w-5 h-5 text-gray-400" />
                  )}
                  <div>
                    <p className="text-sm font-medium">MSDS</p>
                    {selectedInquiry.msds_sent_date && (
                      <p className="text-xs text-gray-500">Sent: {new Date(selectedInquiry.msds_sent_date).toLocaleDateString('en-GB')}</p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {selectedInquiry.sample_sent ? (
                    <CheckCircle className="w-5 h-5 text-green-600" />
                  ) : (
                    <XCircle className="w-5 h-5 text-gray-400" />
                  )}
                  <div>
                    <p className="text-sm font-medium">Sample</p>
                    {selectedInquiry.sample_sent_date && (
                      <p className="text-xs text-gray-500">Sent: {new Date(selectedInquiry.sample_sent_date).toLocaleDateString('en-GB')}</p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {selectedInquiry.price_quoted ? (
                    <CheckCircle className="w-5 h-5 text-green-600" />
                  ) : (
                    <XCircle className="w-5 h-5 text-gray-400" />
                  )}
                  <div>
                    <p className="text-sm font-medium">Price Quote</p>
                    {selectedInquiry.price_quoted_date && (
                      <p className="text-xs text-gray-500">Sent: {new Date(selectedInquiry.price_quoted_date).toLocaleDateString('en-GB')}</p>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {selectedInquiry.email_subject && (
              <div className="border-t pt-4">
                <label className="text-sm font-medium text-gray-700">Original Email Subject</label>
                <p className="text-sm text-gray-600 mt-1">{selectedInquiry.email_subject}</p>
              </div>
            )}

            {selectedInquiry.remarks && (
              <div className="border-t pt-4">
                <label className="text-sm font-medium text-gray-700">Remarks</label>
                <p className="text-sm text-gray-600 mt-1">{selectedInquiry.remarks}</p>
              </div>
            )}

            {selectedInquiry.internal_notes && (
              <div className="border-t pt-4">
                <label className="text-sm font-medium text-gray-700">Internal Notes</label>
                <p className="text-sm text-gray-600 mt-1">{selectedInquiry.internal_notes}</p>
              </div>
            )}

            <div className="flex justify-end gap-3 pt-4 border-t">
              <button
                onClick={() => {
                  setDetailModalOpen(false);
                  setSelectedInquiry(null);
                }}
                className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition"
              >
                Close
              </button>
              {canManage && (
                <button
                  onClick={() => {
                    setDetailModalOpen(false);
                    onEdit(selectedInquiry);
                  }}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
                >
                  Edit Inquiry
                </button>
              )}
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
