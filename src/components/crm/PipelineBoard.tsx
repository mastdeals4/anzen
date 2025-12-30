import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { Building, Package, Calendar, DollarSign, User, AlertCircle } from 'lucide-react';

interface Inquiry {
  id: string;
  inquiry_number: string;
  inquiry_date: string;
  product_name: string;
  quantity: string;
  company_name: string;
  status: string;
  priority: string;
  estimated_value: number | null;
  created_at: string;
}

interface PipelineStage {
  id: string;
  stage_name: string;
  stage_order: number;
  color: string;
  is_active: boolean;
}

interface PipelineBoardProps {
  canManage: boolean;
  onInquiryClick?: (inquiry: Inquiry) => void;
}

export function PipelineBoard({ canManage, onInquiryClick }: PipelineBoardProps) {
  const [inquiries, setInquiries] = useState<Inquiry[]>([]);
  const [stages, setStages] = useState<PipelineStage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draggedInquiry, setDraggedInquiry] = useState<Inquiry | null>(null);

  useEffect(() => {
    loadStages();
    loadInquiries();
  }, []);

  const loadStages = async () => {
    try {
      setError(null);
      const { data, error } = await supabase
        .from('crm_pipeline_stages')
        .select('*')
        .eq('is_active', true)
        .order('stage_order', { ascending: true });

      if (error) {
        console.error('Database error loading stages:', error);
        throw new Error(error.message || 'Failed to load pipeline stages');
      }
      setStages(data || []);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to load pipeline stages';
      console.error('Error loading stages:', error);
      setError(errorMessage);
      setStages([]);
    }
  };

  const loadInquiries = async () => {
    try {
      setError(null);
      const { data, error } = await supabase
        .from('crm_inquiries')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) {
        console.error('Database error loading inquiries:', error);
        throw new Error(error.message || 'Failed to load inquiries');
      }
      setInquiries(data || []);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to load inquiries';
      console.error('Error loading inquiries:', error);
      setError(errorMessage);
      setInquiries([]);
    } finally {
      setLoading(false);
    }
  };

  const statusToStageMap: Record<string, string> = {
    'new': 'New Inquiry',
    'price_quoted': 'Price Quoted',
    'coa_pending': 'COA Pending',
    'sample_sent': 'Sample Sent',
    'negotiation': 'Negotiation',
    'po_received': 'PO Received',
    'won': 'Won',
    'lost': 'Lost',
  };

  const stageToStatusMap: Record<string, string> = {
    'New Inquiry': 'new',
    'Price Quoted': 'price_quoted',
    'COA Pending': 'coa_pending',
    'Sample Sent': 'sample_sent',
    'Negotiation': 'negotiation',
    'PO Received': 'po_received',
    'Won': 'won',
    'Lost': 'lost',
  };

  const getInquiriesForStage = (stageName: string) => {
    const status = stageToStatusMap[stageName];
    return inquiries.filter(i => i.status === status);
  };

  const handleDragStart = (inquiry: Inquiry) => {
    if (canManage) {
      setDraggedInquiry(inquiry);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = async (stageName: string) => {
    if (!draggedInquiry || !canManage) return;

    const newStatus = stageToStatusMap[stageName];
    if (draggedInquiry.status === newStatus) {
      setDraggedInquiry(null);
      return;
    }

    try {
      const { error } = await supabase
        .from('crm_inquiries')
        .update({ status: newStatus })
        .eq('id', draggedInquiry.id);

      if (error) throw error;

      loadInquiries();
    } catch (error) {
      console.error('Error updating inquiry status:', error);
      alert('Failed to update inquiry status');
    } finally {
      setDraggedInquiry(null);
    }
  };

  const getDaysInStage = (inquiry: Inquiry) => {
    const createdDate = new Date(inquiry.created_at);
    const today = new Date();
    const diffTime = Math.abs(today.getTime() - createdDate.getTime());
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return diffDays;
  };

  const priorityColors = {
    urgent: 'border-l-4 border-red-500',
    high: 'border-l-4 border-orange-500',
    medium: 'border-l-4 border-yellow-500',
    low: 'border-l-4 border-gray-400',
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-4">
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <div className="text-red-600 mt-0.5">
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
              </svg>
            </div>
            <div className="flex-1">
              <p className="text-sm font-medium text-red-900">Error Loading Pipeline</p>
              <p className="text-sm text-red-700 mt-1">{error}</p>
              <button
                onClick={() => {
                  loadStages();
                  loadInquiries();
                }}
                className="mt-3 text-sm font-medium text-red-700 hover:text-red-800 underline"
              >
                Try Again
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Pipeline View</h3>
        <div className="text-sm text-gray-600">
          Total: {inquiries.length} inquiries
        </div>
      </div>

      <div className="flex gap-4 overflow-x-auto pb-4">
        {stages.map((stage) => {
          const stageInquiries = getInquiriesForStage(stage.stage_name);
          const stageValue = stageInquiries.reduce((sum, i) => sum + (i.estimated_value || 0), 0);

          return (
            <div
              key={stage.id}
              className="flex-shrink-0 w-80 bg-gray-50 rounded-lg"
              onDragOver={handleDragOver}
              onDrop={() => handleDrop(stage.stage_name)}
            >
              <div
                className="p-4 rounded-t-lg"
                style={{ backgroundColor: stage.color + '20' }}
              >
                <div className="flex items-center justify-between mb-2">
                  <h4 className="font-semibold text-gray-900">{stage.stage_name}</h4>
                  <span className="text-sm font-medium text-gray-600">
                    {stageInquiries.length}
                  </span>
                </div>
                {stageValue > 0 && (
                  <div className="text-xs text-gray-600">
                    Value: Rp {stageValue.toLocaleString('id-ID')}
                  </div>
                )}
              </div>

              <div className="p-2 space-y-2 max-h-[600px] overflow-y-auto">
                {stageInquiries.length === 0 ? (
                  <div className="text-center py-8 text-gray-400 text-sm">
                    No inquiries
                  </div>
                ) : (
                  stageInquiries.map((inquiry) => (
                    <div
                      key={inquiry.id}
                      draggable={canManage}
                      onDragStart={() => handleDragStart(inquiry)}
                      onClick={() => onInquiryClick && onInquiryClick(inquiry)}
                      className={`bg-white rounded-lg p-3 shadow-sm hover:shadow-md transition cursor-pointer ${
                        priorityColors[inquiry.priority as keyof typeof priorityColors] || ''
                      } ${canManage ? 'cursor-move' : ''}`}
                    >
                      <div className="flex items-start justify-between mb-2">
                        <span className="text-xs font-semibold text-blue-600">
                          #{inquiry.inquiry_number}
                        </span>
                        <span className="text-xs text-gray-500">
                          {getDaysInStage(inquiry)}d
                        </span>
                      </div>

                      <div className="space-y-2">
                        <div className="flex items-start gap-2">
                          <Building className="w-4 h-4 text-gray-400 flex-shrink-0 mt-0.5" />
                          <p className="text-sm font-medium text-gray-900 line-clamp-2">
                            {inquiry.company_name}
                          </p>
                        </div>

                        <div className="flex items-start gap-2">
                          <Package className="w-4 h-4 text-gray-400 flex-shrink-0 mt-0.5" />
                          <p className="text-xs text-gray-600 line-clamp-2">
                            {inquiry.product_name}
                          </p>
                        </div>

                        <div className="flex items-center justify-between text-xs text-gray-500">
                          <span>{inquiry.quantity}</span>
                          <span>{new Date(inquiry.inquiry_date).toLocaleDateString('en-GB')}</span>
                        </div>

                        {inquiry.priority === 'urgent' && (
                          <div className="flex items-center gap-1 text-xs text-red-600">
                            <AlertCircle className="w-3 h-3" />
                            <span className="font-medium">URGENT</span>
                          </div>
                        )}

                        {inquiry.estimated_value && inquiry.estimated_value > 0 && (
                          <div className="flex items-center gap-1 text-xs text-green-600 font-medium">
                            <DollarSign className="w-3 h-3" />
                            <span>Rp {inquiry.estimated_value.toLocaleString('id-ID')}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>

      {!canManage && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 flex items-start gap-2">
          <AlertCircle className="w-5 h-5 text-yellow-600 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-yellow-800">
            You have view-only access to the pipeline. Contact admin to manage inquiries.
          </p>
        </div>
      )}
    </div>
  );
}
