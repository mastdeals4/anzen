import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';
import * as XLSX from 'xlsx';
import {
  Search, XCircle, Eye, RotateCcw, Download, Calendar,
  DollarSign, Building, Package, User, AlertCircle
} from 'lucide-react';
import { Modal } from '../Modal';
import { PipelineStatusBadge } from './PipelineStatusBadge';

interface ArchivedInquiry {
  id: string;
  inquiry_number: string;
  inquiry_date: string;
  product_name: string;
  quantity: string;
  company_name: string;
  supplier_name: string | null;
  offered_price: number | null;
  offered_price_currency: string;
  lost_reason: string | null;
  lost_at: string | null;
  competitor_name: string | null;
  competitor_price: number | null;
  remarks: string | null;
  pipeline_status: string;
}

interface ArchiveViewProps {
  canManage: boolean;
  onRefresh: () => void;
}

export function ArchiveView({ canManage, onRefresh }: ArchiveViewProps) {
  const { profile } = useAuth();
  const [archivedInquiries, setArchivedInquiries] = useState<ArchivedInquiry[]>([]);
  const [filteredInquiries, setFilteredInquiries] = useState<ArchivedInquiry[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedInquiry, setSelectedInquiry] = useState<ArchivedInquiry | null>(null);
  const [detailModalOpen, setDetailModalOpen] = useState(false);

  useEffect(() => {
    loadArchivedInquiries();
  }, []);

  useEffect(() => {
    if (searchTerm) {
      const filtered = archivedInquiries.filter(inq =>
        inq.inquiry_number.toLowerCase().includes(searchTerm.toLowerCase()) ||
        inq.company_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        inq.product_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (inq.lost_reason && inq.lost_reason.toLowerCase().includes(searchTerm.toLowerCase()))
      );
      setFilteredInquiries(filtered);
    } else {
      setFilteredInquiries(archivedInquiries);
    }
  }, [searchTerm, archivedInquiries]);

  const loadArchivedInquiries = async () => {
    try {
      const { data, error } = await supabase
        .from('crm_inquiries')
        .select('*')
        .eq('pipeline_status', 'lost')
        .order('lost_at', { ascending: false });

      if (error) throw error;
      setArchivedInquiries(data || []);
      setFilteredInquiries(data || []);
    } catch (error) {
      console.error('Error loading archived inquiries:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleReopen = async (inquiry: ArchivedInquiry) => {
    if (!confirm(`Reopen inquiry #${inquiry.inquiry_number} and move it back to active deals?`)) {
      return;
    }

    try {
      const { error } = await supabase
        .from('crm_inquiries')
        .update({
          pipeline_status: 'in_progress',
          lost_reason: null,
          lost_at: null,
          competitor_name: null,
          competitor_price: null,
        })
        .eq('id', inquiry.id);

      if (error) throw error;

      alert('Inquiry reopened and moved to active deals!');
      loadArchivedInquiries();
      onRefresh();
    } catch (error) {
      console.error('Error reopening inquiry:', error);
      alert('Failed to reopen inquiry. Please try again.');
    }
  };

  const exportToExcel = () => {
    try {
      const exportData = filteredInquiries.map(inq => ({
        'Inquiry No.': inq.inquiry_number,
        'Date': new Date(inq.inquiry_date).toLocaleDateString('en-GB'),
        'Company': inq.company_name,
        'Product': inq.product_name,
        'Qty': inq.quantity,
        'Offered Price': inq.offered_price ? `${inq.offered_price} ${inq.offered_price_currency}` : '-',
        'Supplier': inq.supplier_name || '-',
        'Lost Reason': inq.lost_reason || '-',
        'Competitor': inq.competitor_name || '-',
        'Competitor Price': inq.competitor_price ? `$${inq.competitor_price}` : '-',
        'Lost Date': inq.lost_at ? new Date(inq.lost_at).toLocaleDateString('en-GB') : '-',
        'Remarks': inq.remarks || '-',
      }));

      const ws = XLSX.utils.json_to_sheet(exportData);
      ws['!cols'] = [
        { wch: 12 },
        { wch: 12 },
        { wch: 25 },
        { wch: 30 },
        { wch: 12 },
        { wch: 15 },
        { wch: 20 },
        { wch: 40 },
        { wch: 20 },
        { wch: 15 },
        { wch: 12 },
        { wch: 30 },
      ];

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Lost Deals Archive');

      const fileName = `Archive-Lost-Deals-${new Date().toISOString().split('T')[0]}.xlsx`;
      XLSX.writeFile(wb, fileName);

      alert(`Exported ${exportData.length} archived inquiries to ${fileName}`);
    } catch (error) {
      console.error('Export error:', error);
      alert('Failed to export data. Please try again.');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            <XCircle className="w-6 h-6 text-red-600" />
            Lost Deals Archive
          </h2>
          <p className="text-sm text-gray-600 mt-1">
            View history of lost inquiries and analyze reasons for improvement
          </p>
        </div>
        <button
          onClick={exportToExcel}
          className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition"
        >
          <Download className="w-4 h-4" />
          Export to Excel
        </button>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <div className="flex items-center gap-4">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search by inquiry no, company, product, or lost reason..."
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          <div className="text-sm text-gray-600">
            <span className="font-semibold">{filteredInquiries.length}</span> archived inquiries
          </div>
        </div>
      </div>

      {filteredInquiries.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-12 text-center">
          <XCircle className="w-12 h-12 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-500">
            {searchTerm ? 'No archived inquiries match your search.' : 'No archived inquiries yet.'}
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">No.</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Company</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Product</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Qty</th>
                  {(profile?.role === 'admin') && (
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Offered</th>
                  )}
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Supplier</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Lost Reason</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Lost Date</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {filteredInquiries.map(inquiry => (
                  <tr key={inquiry.id} className="hover:bg-gray-50 transition">
                    <td className="px-4 py-3 text-sm font-medium text-gray-900">{inquiry.inquiry_number}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">
                      {new Date(inquiry.inquiry_date).toLocaleDateString('en-GB', {
                        day: '2-digit',
                        month: 'short',
                        year: 'numeric'
                      })}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-900">{inquiry.company_name}</td>
                    <td className="px-4 py-3 text-sm text-gray-900">{inquiry.product_name}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">{inquiry.quantity}</td>
                    {(profile?.role === 'admin') && (
                      <td className="px-4 py-3 text-sm text-gray-900">
                        {inquiry.offered_price
                          ? `$${inquiry.offered_price.toLocaleString('en-US', { minimumFractionDigits: 2 })}`
                          : '-'}
                      </td>
                    )}
                    <td className="px-4 py-3 text-sm text-gray-600">{inquiry.supplier_name || '-'}</td>
                    <td className="px-4 py-3 text-sm">
                      <div className="max-w-xs">
                        <p className="text-gray-900 line-clamp-2">{inquiry.lost_reason || '-'}</p>
                        {inquiry.competitor_name && (
                          <p className="text-xs text-gray-500 mt-1">
                            Competitor: {inquiry.competitor_name}
                            {inquiry.competitor_price && ` ($${inquiry.competitor_price})`}
                          </p>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">
                      {inquiry.lost_at
                        ? new Date(inquiry.lost_at).toLocaleDateString('en-GB', {
                            day: '2-digit',
                            month: 'short',
                            year: 'numeric'
                          })
                        : '-'}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => {
                            setSelectedInquiry(inquiry);
                            setDetailModalOpen(true);
                          }}
                          className="p-1 text-blue-600 hover:bg-blue-50 rounded transition"
                          title="View Details"
                        >
                          <Eye className="w-4 h-4" />
                        </button>
                        {canManage && (
                          <button
                            onClick={() => handleReopen(inquiry)}
                            className="p-1 text-green-600 hover:bg-green-50 rounded transition"
                            title="Reopen Deal"
                          >
                            <RotateCcw className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {selectedInquiry && (
        <Modal
          isOpen={detailModalOpen}
          onClose={() => {
            setDetailModalOpen(false);
            setSelectedInquiry(null);
          }}
          title={`Inquiry #${selectedInquiry.inquiry_number} - Details`}
        >
          <div className="space-y-4">
            <div className="flex items-center gap-2 pb-4 border-b">
              <PipelineStatusBadge status="lost" />
              <span className="text-sm text-gray-500">
                Lost on {selectedInquiry.lost_at ? new Date(selectedInquiry.lost_at).toLocaleDateString('en-GB') : 'N/A'}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Company</label>
                <p className="text-sm text-gray-900">{selectedInquiry.company_name}</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Product</label>
                <p className="text-sm text-gray-900">{selectedInquiry.product_name}</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Quantity</label>
                <p className="text-sm text-gray-900">{selectedInquiry.quantity}</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Supplier</label>
                <p className="text-sm text-gray-900">{selectedInquiry.supplier_name || '-'}</p>
              </div>
              {(profile?.role === 'admin' && selectedInquiry.offered_price) && (
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Offered Price</label>
                  <p className="text-sm text-gray-900">
                    ${selectedInquiry.offered_price.toLocaleString('en-US', { minimumFractionDigits: 2 })} {selectedInquiry.offered_price_currency}
                  </p>
                </div>
              )}
            </div>

            <div className="bg-red-50 border border-red-200 rounded-lg p-4">
              <div className="flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <h4 className="text-sm font-medium text-red-900 mb-1">Lost Reason</h4>
                  <p className="text-sm text-red-800">{selectedInquiry.lost_reason || 'No reason provided'}</p>

                  {selectedInquiry.competitor_name && (
                    <div className="mt-3 pt-3 border-t border-red-200">
                      <p className="text-xs font-medium text-red-900 mb-1">Competitor Information</p>
                      <p className="text-sm text-red-800">
                        {selectedInquiry.competitor_name}
                        {selectedInquiry.competitor_price && ` - $${selectedInquiry.competitor_price.toLocaleString('en-US', { minimumFractionDigits: 2 })}`}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {selectedInquiry.remarks && (
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Remarks</label>
                <p className="text-sm text-gray-900 bg-gray-50 rounded p-3">{selectedInquiry.remarks}</p>
              </div>
            )}

            {canManage && (
              <div className="flex justify-end pt-4 border-t">
                <button
                  onClick={() => {
                    handleReopen(selectedInquiry);
                    setDetailModalOpen(false);
                  }}
                  className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition"
                >
                  <RotateCcw className="w-4 h-4" />
                  Reopen This Deal
                </button>
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
