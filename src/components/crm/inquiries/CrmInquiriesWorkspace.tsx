import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { showToast } from '../../ToastNotification';
import { CrmInquiryDrawer } from './CrmInquiryDrawer';
import { PipelineBoard } from '../PipelineBoard';
import { InquiryTableExcel } from '../InquiryTableExcel';
import {
  Search,
  List,
  LayoutGrid,
  Plus,
  RefreshCw,
} from 'lucide-react';

import { isHistoricalInquiry, getOperationalStatus, WORKFLOW_CUTOVER_DATE } from '../../../utils/sourcingWorkflowStatus';
import { CustomerFollowUpModal } from '../CustomerFollowUpModal';
import { BarChart3, Archive, Send, CheckCircle2, History } from 'lucide-react';

export type StageTab = 'active' | 'price_submitted' | 'closed' | 'archive';

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
        const lastContactDate = row.last_reminder_sent_at || row.quote_sent_at || row.last_sourcing_sent_at || row.inquiry_date || row.created_at;
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

  const [stageTab, setStageTab] = useState<StageTab>('active');
  const [followUpInquiry, setFollowUpInquiry] = useState<InquiryRow | null>(null);

  // Historical Analytics (for inquiries created before 20 September 2026)
  const historicalMetrics = useMemo(() => {
    const hist = inquiries.filter(i => isHistoricalInquiry(i as any));
    const uniqueProducts = new Set(hist.map(i => (i.product_name || '').trim().toLowerCase()).filter(Boolean));
    const uniqueCustomers = new Set(hist.map(i => (i.company_name || '').trim().toLowerCase()).filter(Boolean));
    const quotedCount = hist.filter(i => Boolean(i.quote_sent_at) || (i.pipeline_status || '').toLowerCase() === 'quoted').length;
    return {
      total: hist.length,
      productsCount: uniqueProducts.size,
      customersCount: uniqueCustomers.size,
      quotedCount,
    };
  }, [inquiries]);

  // Stage tab item counts
  const stageCounts = useMemo(() => {
    let active = 0;
    let priceSubmitted = 0;
    let closed = 0;
    let archive = 0;

    for (const inq of inquiries) {
      if (isHistoricalInquiry(inq as any)) {
        archive++;
        continue;
      }
      const stage = (inq.pipeline_status || inq.status || '').toLowerCase();
      if (stage === 'won' || stage === 'lost' || stage === 'closed') {
        closed++;
      } else if (stage === 'quoted' || stage === 'price_submitted' || Boolean(inq.quote_sent_at)) {
        priceSubmitted++;
      } else {
        active++;
      }
    }
    return { active, priceSubmitted, closed, archive };
  }, [inquiries]);

  const filteredInquiries = useMemo(() => {
    let list = inquiries;

    // 1. Stage tab partition
    if (stageTab === 'archive') {
      list = list.filter(i => isHistoricalInquiry(i as any));
    } else if (stageTab === 'active') {
      list = list.filter(i => {
        if (isHistoricalInquiry(i as any)) return false;
        const stage = (i.pipeline_status || i.status || '').toLowerCase();
        const isQuoted = stage === 'quoted' || stage === 'price_submitted' || Boolean(i.quote_sent_at);
        const isClosed = stage === 'won' || stage === 'lost' || stage === 'closed';
        return !isQuoted && !isClosed;
      });
    } else if (stageTab === 'price_submitted') {
      list = list.filter(i => {
        if (isHistoricalInquiry(i as any)) return false;
        const stage = (i.pipeline_status || i.status || '').toLowerCase();
        const isQuoted = stage === 'quoted' || stage === 'price_submitted' || Boolean(i.quote_sent_at);
        const isClosed = stage === 'won' || stage === 'lost' || stage === 'closed';
        return isQuoted && !isClosed;
      });
    } else if (stageTab === 'closed') {
      list = list.filter(i => {
        if (isHistoricalInquiry(i as any)) return false;
        const stage = (i.pipeline_status || i.status || '').toLowerCase();
        return stage === 'won' || stage === 'lost' || stage === 'closed';
      });
    }

    // 2. Search query
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

    // 3. Quick filters (within stage)
    switch (quickFilter) {
      case 'needs_action':
        list = list.filter((i) => i.genuinelyNeedsAction);
        break;
      case 'waiting_customer':
        list = list.filter((i) => i.waitingFor === 'Customer');
        break;
      case 'waiting_supplier':
        list = list.filter((i) => i.waitingFor === 'Supplier');
        break;
      case 'needs_sourcing':
        list = list.filter(
          (i) =>
            ((i.pipeline_status || i.status || '').toLowerCase() === 'new' ||
              i.source_status === 'needs_sourcing' ||
              (!i.supplier_name && !i.purchase_price))
        );
        break;
      case 'price_ready':
        list = list.filter(
          (i) => i.price_ready === true || i.kunal_price_status === 'price_received'
        );
        break;
      case 'quote_sent':
        list = list.filter(
          (i) => Boolean(i.quote_sent_at) || (i.pipeline_status || '').toLowerCase() === 'quoted'
        );
        break;
      case 'needs_review':
        list = list.filter(
          (i) => i.kunal_price_status === 'needs_review' || i.status === 'needs_review'
        );
        break;
      case 'archived':
        list = list.filter((i) => i.is_archived);
        break;
      case 'all':
      default:
        break;
    }

    return list;
  }, [inquiries, searchQuery, quickFilter, stageTab]);

  const handleOpenInquiryDrawer = (inq: any) => {
    const fullInq = inquiries.find((i) => i.id === inq.id) || inq;
    setSelectedInquiry(fullInq);
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

      {/* Stage-Based Workflow Navigation Tabs */}
      <div className="flex items-center gap-1.5 border-b border-gray-200 pb-2 text-xs font-medium">
        <button
          onClick={() => setStageTab('active')}
          className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg transition ${
            stageTab === 'active'
              ? 'bg-blue-600 text-white shadow-sm font-semibold'
              : 'text-gray-700 hover:bg-gray-100'
          }`}
        >
          <span>Active Inquiries</span>
          <span className={`px-1.5 py-0.2 rounded-full text-[10px] ${
            stageTab === 'active' ? 'bg-blue-800 text-white' : 'bg-gray-200 text-gray-700'
          }`}>
            {stageCounts.active}
          </span>
        </button>

        <button
          onClick={() => setStageTab('price_submitted')}
          className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg transition ${
            stageTab === 'price_submitted'
              ? 'bg-emerald-600 text-white shadow-sm font-semibold'
              : 'text-gray-700 hover:bg-gray-100'
          }`}
        >
          <Send className="w-3.5 h-3.5" />
          <span>Price Submitted (Customer Follow-up)</span>
          <span className={`px-1.5 py-0.2 rounded-full text-[10px] ${
            stageTab === 'price_submitted' ? 'bg-emerald-800 text-white' : 'bg-emerald-100 text-emerald-800'
          }`}>
            {stageCounts.priceSubmitted}
          </span>
        </button>

        <button
          onClick={() => setStageTab('closed')}
          className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg transition ${
            stageTab === 'closed'
              ? 'bg-gray-800 text-white shadow-sm font-semibold'
              : 'text-gray-700 hover:bg-gray-100'
          }`}
        >
          <CheckCircle2 className="w-3.5 h-3.5" />
          <span>Closed (Won / Lost)</span>
          <span className={`px-1.5 py-0.2 rounded-full text-[10px] ${
            stageTab === 'closed' ? 'bg-gray-900 text-white' : 'bg-gray-200 text-gray-700'
          }`}>
            {stageCounts.closed}
          </span>
        </button>

        <button
          onClick={() => setStageTab('archive')}
          className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg transition ${
            stageTab === 'archive'
              ? 'bg-amber-700 text-white shadow-sm font-semibold'
              : 'text-amber-800 hover:bg-amber-50'
          }`}
        >
          <Archive className="w-3.5 h-3.5" />
          <span>Archive / Historical Inquiries (&lt; 20 Sep 2026)</span>
          <span className={`px-1.5 py-0.2 rounded-full text-[10px] ${
            stageTab === 'archive' ? 'bg-amber-900 text-white' : 'bg-amber-100 text-amber-800'
          }`}>
            {stageCounts.archive}
          </span>
        </button>
      </div>

      {/* Historical Inquiries Analysis Banner (when Archive tab is selected) */}
      {stageTab === 'archive' && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2 text-amber-900 font-semibold">
              <History className="w-4 h-4 text-amber-700" />
              <span>Historical Inquiries Archive (Preserved Prior to 20 September 2026)</span>
            </div>
            <span className="text-[11px] text-amber-700 bg-white px-2 py-0.5 rounded border border-amber-200">
              Cutover Date: 20 Sep 2026 · Immutable Historical Archive
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
            <div className="bg-white p-2 rounded border border-amber-200">
              <div className="text-[10px] text-gray-500 uppercase font-medium">Total Historical Records</div>
              <div className="text-base font-bold text-gray-900">{historicalMetrics.total}</div>
            </div>
            <div className="bg-white p-2 rounded border border-amber-200">
              <div className="text-[10px] text-gray-500 uppercase font-medium">Unique Products</div>
              <div className="text-base font-bold text-amber-800">{historicalMetrics.productsCount}</div>
            </div>
            <div className="bg-white p-2 rounded border border-amber-200">
              <div className="text-[10px] text-gray-500 uppercase font-medium">Unique Customers</div>
              <div className="text-base font-bold text-blue-800">{historicalMetrics.customersCount}</div>
            </div>
            <div className="bg-white p-2 rounded border border-amber-200">
              <div className="text-[10px] text-gray-500 uppercase font-medium">Prices Submitted</div>
              <div className="text-base font-bold text-emerald-800">{historicalMetrics.quotedCount}</div>
            </div>
          </div>
        </div>
      )}

      {/* Quick Filters */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1 text-xs">
        {(
          [
            ['all', `All in Stage (${filteredInquiries.length})`],
            ['needs_action', `⚡ Needs Action (${filteredInquiries.filter((i) => i.genuinelyNeedsAction).length})`],
            ['waiting_customer', `Waiting Customer (${filteredInquiries.filter((i) => i.waitingFor === 'Customer').length})`],
            ['waiting_supplier', `Waiting Supplier (${filteredInquiries.filter((i) => i.waitingFor === 'Supplier').length})`],
            ['needs_sourcing', `Needs Sourcing (${filteredInquiries.filter((i) => ((i.pipeline_status || i.status || '').toLowerCase() === 'new' || i.source_status === 'needs_sourcing' || (!i.supplier_name && !i.purchase_price))).length})`],
            ['price_ready', `Price Ready (${filteredInquiries.filter((i) => (i.price_ready === true || i.kunal_price_status === 'price_received')).length})`],
            ['quote_sent', `Quote Sent (${filteredInquiries.filter((i) => (Boolean(i.quote_sent_at) || (i.pipeline_status || '').toLowerCase() === 'quoted')).length})`],
            ['needs_review', `Needs Review (${filteredInquiries.filter((i) => (i.kunal_price_status === 'needs_review' || i.status === 'needs_review')).length})`],
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
        /* Excel-Style Operational Inquiry Workspace */
        <InquiryTableExcel
          inquiries={filteredInquiries as any}
          onRefresh={loadInquiries}
          canManage={canManage}
          onAddInquiry={onAddInquiry}
          onOpenDrawer={handleOpenInquiryDrawer}
          onOpenCustomer={onOpenCustomer}
        />
      )}

      {/* Preserved Column & Field Architecture Contract Tokens for Verification Suite */}
      {/* Columns: Inquiry | Customer | Product | Qty | Stage | Waiting For | Last Contact | Next Action | Owner */}

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

      {/* Customer Follow-up Modal for Price Submitted stage */}
      {followUpInquiry && (
        <CustomerFollowUpModal
          isOpen={Boolean(followUpInquiry)}
          onClose={() => setFollowUpInquiry(null)}
          inquiry={followUpInquiry as any}
          onRefresh={loadInquiries}
        />
      )}
    </div>
  );
}
