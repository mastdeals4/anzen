import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { showToast } from '../../ToastNotification';
import { CrmInquiryDrawer } from './CrmInquiryDrawer';
import { PipelineBoard } from '../PipelineBoard';
import { PipelineStatusBadge } from '../PipelineStatusBadge';
import {
  Search,
  Filter,
  List,
  LayoutGrid,
  Plus,
  RefreshCw,
  Clock,
  AlertTriangle,
  Building,
  User,
  ArrowUpDown,
  ExternalLink,
  CheckCircle2,
  Calendar,
  DollarSign,
  Tag,
  AlertCircle,
  HelpCircle,
} from 'lucide-react';

export type InquiryFilter =
  | 'all'
  | 'needs_action'
  | 'waiting_customer'
  | 'waiting_supplier'
  | 'needs_sourcing'
  | 'price_ready'
  | 'quote_sent'
  | 'needs_review'
  | 'archived';

interface InquiryRow {
  id: string;
  inquiry_number: string;
  inquiry_date: string;
  product_name: string;
  specification?: string | null;
  quantity?: string | null;
  company_name: string;
  contact_person?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  supplier_name?: string | null;
  supplier_country?: string | null;
  requested_make?: string | null;
  offered_make?: string | null;
  status: string;
  pipeline_status?: string | null;
  priority?: string | null;
  purchase_price?: number | null;
  purchase_price_currency?: string | null;
  offered_price?: number | null;
  offered_price_currency?: string | null;
  delivery_date?: string | null;
  delivery_terms?: string | null;
  remarks?: string | null;
  internal_notes?: string | null;
  assigned_to?: string | null;
  created_at: string;
  next_follow_up?: string | null;
  price_ready?: boolean | null;
  source_status?: string | null;
  quote_status?: string | null;
  quote_sent_at?: string | null;
  last_sourcing_sent_at?: string | null;
  last_reminder_sent_at?: string | null;
  kunal_price_status?: string | null;
  is_archived?: boolean | null;
  user_profiles?: {
    full_name: string;
  };
  // Computed fields
  waitingFor: 'Customer' | 'Supplier' | 'Internal' | 'Pricing' | 'None';
  lastContact: string;
  nextAction: string;
  genuinelyNeedsAction: boolean;
}

interface Props {
  canManage?: boolean;
  onAddInquiry?: () => void;
  onOpenCustomer?: (customerId: string) => void;
  initialInquiryId?: string | null;
}

export function CrmInquiriesWorkspace({
  canManage = true,
  onAddInquiry,
  onOpenCustomer,
  initialInquiryId,
}: Props) {
  const [viewMode, setViewMode] = useState<'list' | 'pipeline'>('list');
  const [quickFilter, setQuickFilter] = useState<InquiryFilter>('all');
  const [inquiries, setInquiries] = useState<InquiryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  // Drawer state
  const [selectedInquiry, setSelectedInquiry] = useState<InquiryRow | null>(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);

  useEffect(() => {
    loadInquiries();
  }, []);

  useEffect(() => {
    if (initialInquiryId && inquiries.length > 0) {
      const match = inquiries.find((i) => i.id === initialInquiryId);
      if (match) {
        setSelectedInquiry(match);
        setIsDrawerOpen(true);
      }
    }
  }, [initialInquiryId, inquiries]);

  const loadInquiries = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('crm_inquiries')
        .select(`
          *,
          user_profiles:assigned_to (
            full_name
          )
        `)
        .order('created_at', { ascending: false });

      if (error) throw error;

      const now = Date.now();

      const mapped: InquiryRow[] = (data || []).map((row: any) => {
        const stage = (row.pipeline_status || row.status || 'new').toLowerCase();
        const hasQuoteSent = Boolean(row.quote_sent_at) || row.price_quoted === true || stage === 'quoted' || stage === 'quote_sent';
        const hasSupplierSent = Boolean(row.last_sourcing_sent_at) || row.source_status === 'waiting_supplier' || stage === 'sourcing';
        const isPriceReady = row.price_ready === true || row.kunal_price_status === 'price_received';
        const isNeedsReview = row.kunal_price_status === 'needs_review' || row.status === 'needs_review';
        const isArchived = row.is_archived === true || row.status === 'archived';

        // 1. Determine "Waiting For"
        let waitingFor: 'Customer' | 'Supplier' | 'Internal' | 'Pricing' | 'None' = 'None';
        if (hasQuoteSent && !['won', 'lost', 'closed'].includes(stage)) {
          waitingFor = 'Customer';
        } else if (isPriceReady && !hasQuoteSent) {
          waitingFor = 'Pricing';
        } else if (hasSupplierSent && !isPriceReady) {
          waitingFor = 'Supplier';
        } else if (['new', 'needs_sourcing'].includes(stage)) {
          waitingFor = 'Internal';
        }

        // 2. Determine "Last Contact"
        let lastContactDate = row.last_reminder_sent_at || row.quote_sent_at || row.last_sourcing_sent_at || row.inquiry_date || row.created_at;
        let lastContact = 'None';
        if (lastContactDate) {
          const days = Math.max(0, Math.floor((now - new Date(lastContactDate).getTime()) / 86400000));
          lastContact = days === 0 ? 'Today' : days === 1 ? 'Yesterday' : `${days}d ago`;
        }

        // 3. Determine "Next Action"
        let nextAction = 'Follow-up pending';
        if (isPriceReady && !hasQuoteSent) {
          nextAction = 'Send Quote (Price Ready)';
        } else if (stage === 'new' || (!row.supplier_name && !row.purchase_price)) {
          nextAction = 'Source from Supplier';
        } else if (hasQuoteSent) {
          nextAction = 'Follow up with Customer';
        } else if (waitingFor === 'Supplier') {
          nextAction = 'Supplier Price Follow-up';
        }

        if (row.next_follow_up) {
          const fuDate = new Date(row.next_follow_up);
          const isOverdue = fuDate.getTime() < now;
          nextAction = `${isOverdue ? '⚠️ Overdue: ' : 'Due: '}${fuDate.toLocaleDateString()}`;
        }

        // 4. CRITICAL RULE FOR "NEEDS ACTION":
        // "NEED ACTION must mean: 'I genuinely need to do something now.'
        // Do not put ordinary Waiting Supplier records into Need Action."
        const isOrdinaryWaitingSupplier = waitingFor === 'Supplier' && !row.next_follow_up;
        const hasOverdueFollowUp = row.next_follow_up && new Date(row.next_follow_up).getTime() < now;
        const needsImmediateQuote = isPriceReady && !hasQuoteSent;
        const needsImmediateSourcing = (stage === 'new' || row.source_status === 'needs_sourcing') && !row.supplier_name;
        const isUrgent = (row.priority || '').toLowerCase() === 'urgent';

        const genuinelyNeedsAction =
          !isArchived &&
          !['won', 'lost', 'closed'].includes(stage) &&
          !isOrdinaryWaitingSupplier &&
          (hasOverdueFollowUp || needsImmediateQuote || needsImmediateSourcing || isNeedsReview || isUrgent || stage === 'needs_action');

        return {
          ...row,
          waitingFor,
          lastContact,
          nextAction,
          genuinelyNeedsAction,
          is_archived: isArchived,
        };
      });

      setInquiries(mapped);
    } catch (err: any) {
      console.error('Failed to load inquiries workspace:', err);
      showToast({ type: 'error', title: 'Inquiries Error', message: err.message || 'Unable to load inquiries.' });
    } finally {
      setLoading(false);
    }
  };

  const filteredInquiries = useMemo(() => {
    let list = inquiries;

    // Search query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter(
        (i) =>
          i.inquiry_number.toLowerCase().includes(q) ||
          i.company_name.toLowerCase().includes(q) ||
          i.product_name.toLowerCase().includes(q) ||
          (i.supplier_name && i.supplier_name.toLowerCase().includes(q)) ||
          (i.contact_person && i.contact_person.toLowerCase().includes(q))
      );
    }

    // Quick filters
    switch (quickFilter) {
      case 'needs_action':
        list = list.filter((i) => i.genuinelyNeedsAction);
        break;
      case 'waiting_customer':
        list = list.filter((i) => i.waitingFor === 'Customer' && !i.is_archived);
        break;
      case 'waiting_supplier':
        list = list.filter((i) => i.waitingFor === 'Supplier' && !i.is_archived);
        break;
      case 'needs_sourcing':
        list = list.filter(
          (i) =>
            !i.is_archived &&
            ((i.pipeline_status || i.status || '').toLowerCase() === 'new' ||
              i.source_status === 'needs_sourcing' ||
              (!i.supplier_name && !i.purchase_price))
        );
        break;
      case 'price_ready':
        list = list.filter(
          (i) =>
            !i.is_archived &&
            (i.price_ready === true || i.kunal_price_status === 'price_received')
        );
        break;
      case 'quote_sent':
        list = list.filter(
          (i) =>
            !i.is_archived &&
            (Boolean(i.quote_sent_at) || (i.pipeline_status || '').toLowerCase() === 'quoted')
        );
        break;
      case 'needs_review':
        list = list.filter(
          (i) =>
            !i.is_archived &&
            (i.kunal_price_status === 'needs_review' || i.status === 'needs_review')
        );
        break;
      case 'archived':
        list = list.filter((i) => i.is_archived);
        break;
      case 'all':
      default:
        // Do not show archived in 'all' by default unless explicit filter
        list = list.filter((i) => !i.is_archived);
        break;
    }

    return list;
  }, [inquiries, searchQuery, quickFilter]);

  const handleOpenInquiryDrawer = (inq: InquiryRow) => {
    setSelectedInquiry(inq);
    setIsDrawerOpen(true);
  };

  return (
    <div className="space-y-3">
      {/* Top Workspace Header & View Mode Switcher */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 bg-white p-3.5 rounded-lg border border-gray-200 shadow-sm">
        
        {/* Search & Refresh */}
        <div className="flex items-center gap-2 flex-1 max-w-lg">
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-3 top-2.5 text-gray-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search inquiry #, customer, product, supplier..."
              className="w-full pl-9 pr-3 py-1.5 text-xs bg-slate-50 border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500 focus:bg-white transition"
            />
          </div>

          <button
            onClick={loadInquiries}
            disabled={loading}
            className="p-1.5 text-gray-500 hover:text-gray-800 hover:bg-gray-100 rounded border border-gray-200 transition"
            title="Refresh Inquiries"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* View Mode Toggle [ LIST ] [ PIPELINE ] & New Inquiry Button */}
        <div className="flex items-center gap-2 shrink-0">
          <div className="inline-flex rounded-md border border-gray-200 bg-slate-100 p-0.5 text-xs font-semibold">
            <button
              onClick={() => setViewMode('list')}
              className={`inline-flex items-center gap-1.5 px-3 py-1 rounded transition ${
                viewMode === 'list'
                  ? 'bg-white text-gray-900 shadow-xs'
                  : 'text-gray-500 hover:text-gray-900'
              }`}
            >
              <List className="w-3.5 h-3.5" />
              LIST
            </button>
            <button
              onClick={() => setViewMode('pipeline')}
              className={`inline-flex items-center gap-1.5 px-3 py-1 rounded transition ${
                viewMode === 'pipeline'
                  ? 'bg-white text-gray-900 shadow-xs'
                  : 'text-gray-500 hover:text-gray-900'
              }`}
            >
              <LayoutGrid className="w-3.5 h-3.5" />
              PIPELINE
            </button>
          </div>

          {onAddInquiry && (
            <button
              onClick={onAddInquiry}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-blue-600 text-white rounded-md text-xs font-semibold hover:bg-blue-700 shadow-sm transition"
            >
              <Plus className="w-4 h-4" />
              New Inquiry
            </button>
          )}
        </div>
      </div>

      {/* Quick Filters */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1 text-xs">
        {(
          [
            ['all', `All (${inquiries.filter((i) => !i.is_archived).length})`],
            ['needs_action', `⚡ Needs Action (${inquiries.filter((i) => i.genuinelyNeedsAction).length})`],
            ['waiting_customer', `Waiting Customer (${inquiries.filter((i) => i.waitingFor === 'Customer' && !i.is_archived).length})`],
            ['waiting_supplier', `Waiting Supplier (${inquiries.filter((i) => i.waitingFor === 'Supplier' && !i.is_archived).length})`],
            ['needs_sourcing', `Needs Sourcing (${inquiries.filter((i) => !i.is_archived && ((i.pipeline_status || i.status || '').toLowerCase() === 'new' || i.source_status === 'needs_sourcing' || (!i.supplier_name && !i.purchase_price))).length})`],
            ['price_ready', `Price Ready (${inquiries.filter((i) => !i.is_archived && (i.price_ready === true || i.kunal_price_status === 'price_received')).length})`],
            ['quote_sent', `Quote Sent (${inquiries.filter((i) => !i.is_archived && (Boolean(i.quote_sent_at) || (i.pipeline_status || '').toLowerCase() === 'quoted')).length})`],
            ['needs_review', `Needs Review (${inquiries.filter((i) => !i.is_archived && (i.kunal_price_status === 'needs_review' || i.status === 'needs_review')).length})`],
            ['archived', `Archived (${inquiries.filter((i) => i.is_archived).length})`],
          ] as const
        ).map(([key, label]) => {
          const isSelected = quickFilter === key;
          const isNeedsActionBtn = key === 'needs_action';

          return (
            <button
              key={key}
              onClick={() => setQuickFilter(key)}
              className={`px-3 py-1.5 rounded-full font-medium transition whitespace-nowrap ${
                isSelected
                  ? isNeedsActionBtn
                    ? 'bg-amber-600 text-white shadow-sm'
                    : 'bg-blue-600 text-white shadow-sm'
                  : isNeedsActionBtn && inquiries.some((i) => i.genuinelyNeedsAction)
                  ? 'bg-amber-50 text-amber-900 border border-amber-300 font-semibold hover:bg-amber-100'
                  : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* Main View: [ LIST ] or [ PIPELINE ] */}
      {viewMode === 'pipeline' ? (
        <div className="bg-white rounded-lg border border-gray-200 p-4 shadow-sm">
          <PipelineBoard
            canManage={canManage}
            onInquiryClick={(inq: any) => {
              const fullInq = inquiries.find((i) => i.id === inq.id) || inq;
              handleOpenInquiryDrawer(fullInq);
            }}
          />
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-slate-50 border-b border-gray-200 text-gray-500 font-semibold uppercase tracking-wider">
                  <th className="py-2.5 px-3">Inquiry</th>
                  <th className="py-2.5 px-3">Customer</th>
                  <th className="py-2.5 px-3">Product</th>
                  <th className="py-2.5 px-3">Qty</th>
                  <th className="py-2.5 px-3">Stage</th>
                  <th className="py-2.5 px-3">Waiting For</th>
                  <th className="py-2.5 px-3">Last Contact</th>
                  <th className="py-2.5 px-3">Next Action</th>
                  <th className="py-2.5 px-3">Owner</th>
                  <th className="py-2.5 px-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {loading ? (
                  <tr>
                    <td colSpan={10} className="py-12 text-center text-gray-400">
                      <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2 text-blue-600" />
                      Loading inquiries...
                    </td>
                  </tr>
                ) : filteredInquiries.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="py-12 text-center text-gray-400">
                      No inquiries match current search and quick filters.
                    </td>
                  </tr>
                ) : (
                  filteredInquiries.map((inq) => {
                    return (
                      <tr
                        key={inq.id}
                        onClick={() => handleOpenInquiryDrawer(inq)}
                        className={`hover:bg-blue-50/60 cursor-pointer transition ${
                          inq.genuinelyNeedsAction ? 'bg-amber-50/20' : ''
                        }`}
                      >
                        {/* Inquiry Number */}
                        <td className="py-2.5 px-3 font-bold text-blue-600">
                          <div className="flex items-center gap-1.5">
                            {inq.genuinelyNeedsAction && (
                              <span
                                className="w-2 h-2 rounded-full bg-amber-500 shrink-0"
                                title="Needs Action"
                              />
                            )}
                            <span>{inq.inquiry_number}</span>
                          </div>
                          <div className="text-[11px] font-normal text-gray-400">
                            {new Date(inq.inquiry_date).toLocaleDateString()}
                          </div>
                        </td>

                        {/* Customer */}
                        <td className="py-2.5 px-3 font-semibold text-gray-900 max-w-[180px] truncate">
                          {inq.company_name}
                          {inq.contact_person && (
                            <div className="text-[11px] font-normal text-gray-400 truncate">
                              {inq.contact_person}
                            </div>
                          )}
                        </td>

                        {/* Product */}
                        <td className="py-2.5 px-3 text-gray-800 max-w-[200px] truncate">
                          <div className="font-medium truncate">{inq.product_name}</div>
                          {inq.specification && (
                            <div className="text-[11px] text-gray-400 truncate">
                              {inq.specification}
                            </div>
                          )}
                        </td>

                        {/* Quantity */}
                        <td className="py-2.5 px-3 text-gray-700 whitespace-nowrap">
                          {inq.quantity || '—'}
                        </td>

                        {/* Stage */}
                        <td className="py-2.5 px-3">
                          <PipelineStatusBadge
                            status={inq.pipeline_status || inq.status || 'New'}
                          />
                        </td>

                        {/* Waiting For */}
                        <td className="py-2.5 px-3">
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold ${
                              inq.waitingFor === 'Customer'
                                ? 'bg-purple-100 text-purple-800'
                                : inq.waitingFor === 'Supplier'
                                ? 'bg-blue-100 text-blue-800'
                                : inq.waitingFor === 'Pricing'
                                ? 'bg-emerald-100 text-emerald-800'
                                : inq.waitingFor === 'Internal'
                                ? 'bg-amber-100 text-amber-800'
                                : 'bg-gray-100 text-gray-600'
                            }`}
                          >
                            {inq.waitingFor}
                          </span>
                        </td>

                        {/* Last Contact */}
                        <td className="py-2.5 px-3 text-gray-500 whitespace-nowrap">
                          {inq.lastContact}
                        </td>

                        {/* Next Action */}
                        <td className="py-2.5 px-3 text-gray-700 max-w-[200px] truncate">
                          <span
                            className={`inline-block truncate ${
                              inq.nextAction.includes('Overdue')
                                ? 'font-semibold text-red-600'
                                : inq.nextAction.includes('Price Ready')
                                ? 'font-semibold text-emerald-700'
                                : 'text-gray-600'
                            }`}
                          >
                            {inq.nextAction}
                          </span>
                        </td>

                        {/* Owner */}
                        <td className="py-2.5 px-3 text-gray-600 whitespace-nowrap">
                          {inq.user_profiles?.full_name || 'Unassigned'}
                        </td>

                        {/* Action */}
                        <td className="py-2.5 px-3 text-right">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleOpenInquiryDrawer(inq);
                            }}
                            className="px-2.5 py-1 text-xs font-semibold text-blue-600 hover:bg-blue-100 rounded transition inline-flex items-center gap-1"
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                            Open
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Inquiry Right-Side Drawer Overlay */}
      <CrmInquiryDrawer
        isOpen={isDrawerOpen}
        onClose={() => setIsDrawerOpen(false)}
        inquiry={selectedInquiry as any}
        onRefresh={loadInquiries}
        onOpenCustomer={(cid: string) => {
          setIsDrawerOpen(false);
          onOpenCustomer?.(cid);
        }}
      />
    </div>
  );
}
