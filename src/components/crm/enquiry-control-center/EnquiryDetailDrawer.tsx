import React, { useState, useEffect, useCallback } from 'react';
import {
  X,
  Layers,
  CheckCircle2,
  AlertTriangle,
  Clock,
  User,
  Building,
  Mail,
  Phone,
  FileText,
  MessageSquare,
  Paperclip,
  CheckSquare,
  Plus,
  Loader2,
  Calendar,
} from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { EnquiryControlCenterRow } from '../../../types/enquiry/controlCenter.types.ts';
import { PipelineStatusBadge } from '../PipelineStatusBadge';
import { RequestCard, LinkedTaskItem, RequestLinkedDocumentItem, RequestLinkedMessageItem } from './RequestCard';
import { CreateEnquiryRequestModal } from './CreateEnquiryRequestModal';
import { TaskDetailModal } from '../../tasks/TaskDetailModal';
import { EnquiryControlCenterService } from '../../../services/enquiry/EnquiryControlCenterService';
import {
  ConversationTimeline,
  CanonicalConversationSummary,
  CanonicalMessageItem,
} from './ConversationTimeline';
import { DocumentsList, EnquiryDocumentItem } from './DocumentsList';
import { AiUnderstandingCard } from './AiUnderstandingCard';
import { AiProposal } from '../../../types/enquiry';

interface EnquiryDetailDrawerProps {
  enquiry: EnquiryControlCenterRow | null;
  onClose: () => void;
  onRefresh: () => void;
  canManage?: boolean;
}

type ActiveTab = 'requests' | 'conversation' | 'documents';

export const EnquiryDetailDrawer: React.FC<EnquiryDetailDrawerProps> = ({
  enquiry,
  onClose,
  onRefresh,
  canManage = true,
}) => {
  const [activeEnquiry, setActiveEnquiry] = useState<EnquiryControlCenterRow | null>(enquiry);
  const [activeTab, setActiveTab] = useState<ActiveTab>('requests');

  // Tasks state
  const [linkedTasksByRequestId, setLinkedTasksByRequestId] = useState<Record<string, LinkedTaskItem[]>>({});
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [showAddRequestModal, setShowAddRequestModal] = useState(false);
  const [activeTaskIdForModal, setActiveTaskIdForModal] = useState<string | null>(null);

  // Conversations state (Phase 7.4)
  const [conversations, setConversations] = useState<CanonicalConversationSummary[]>([]);
  const [loadingConversations, setLoadingConversations] = useState(false);
  const [totalMessageCount, setTotalMessageCount] = useState<number>(0);

  // Documents state (Phase 7.4)
  const [documents, setDocuments] = useState<EnquiryDocumentItem[]>([]);
  const [loadingDocuments, setLoadingDocuments] = useState(false);
  const [documentsByRequestId, setDocumentsByRequestId] = useState<Record<string, RequestLinkedDocumentItem[]>>({});
  const [messagesByRequestId, setMessagesByRequestId] = useState<Record<string, RequestLinkedMessageItem[]>>({});
  const [pendingAiProposals, setPendingAiProposals] = useState<
    Array<{
      messageId: string;
      proposal: AiProposal;
      channel?: string;
      senderAddress?: string;
      senderName?: string;
    }>
  >([]);

  // Sync prop changes to state
  useEffect(() => {
    setActiveEnquiry(enquiry);
    // Reset tab to requests when switching enquiry
    if (enquiry?.id !== activeEnquiry?.id) {
      setActiveTab('requests');
    }
  }, [enquiry]);

  // Load linked tasks whenever activeEnquiry changes
  const loadLinkedTasks = useCallback(async (reqIds: string[]) => {
    if (!reqIds || reqIds.length === 0) {
      setLinkedTasksByRequestId({});
      return;
    }

    try {
      setLoadingTasks(true);
      const { data, error } = await supabase
        .from('tasks')
        .select(`
          id,
          title,
          description,
          status,
          priority,
          deadline,
          completed_at,
          created_at,
          reference_type,
          reference_id,
          inquiry_id,
          created_by,
          assigned_users,
          task_assignments(
            assigned_user_id,
            user_profiles:assigned_user_id(id, full_name, email)
          ),
          task_comments(id)
        `)
        .eq('reference_type', 'enquiry_request')
        .in('reference_id', reqIds)
        .eq('is_deleted', false)
        .order('created_at', { ascending: false });

      if (error) throw error;

      const grouped: Record<string, LinkedTaskItem[]> = {};
      for (const t of data || []) {
        const refId = t.reference_id;
        if (!refId) continue;
        if (!grouped[refId]) grouped[refId] = [];

        // Extract assignee names
        const names: string[] = [];
        if (t.task_assignments && Array.isArray(t.task_assignments)) {
          for (const a of t.task_assignments) {
            const profile = (a as any).user_profiles;
            if (profile?.full_name) names.push(profile.full_name);
          }
        }

        grouped[refId].push({
          id: t.id,
          title: t.title,
          description: t.description,
          status: t.status,
          priority: t.priority,
          deadline: t.deadline,
          completed_at: t.completed_at,
          created_at: t.created_at,
          reference_type: t.reference_type,
          reference_id: t.reference_id,
          inquiry_id: t.inquiry_id,
          created_by: t.created_by,
          assigned_users: t.assigned_users || [],
          assignee_names: names,
          comment_count: Array.isArray(t.task_comments) ? t.task_comments.length : 0,
        });
      }

      setLinkedTasksByRequestId(grouped);
    } catch (err) {
      console.error('[EnquiryDetailDrawer] Failed to load linked tasks:', err);
    } finally {
      setLoadingTasks(false);
    }
  }, []);

  // Lazy-load canonical conversations & messages (Phase 7.4)
  const loadConversations = useCallback(async (inquiryId: string, reqIds: string[]) => {
    if (!inquiryId) {
      setConversations([]);
      setTotalMessageCount(0);
      return;
    }

    try {
      setLoadingConversations(true);

      // 1. Fetch active conversation links for this enquiry
      const { data: linkRows, error: linkErr } = await supabase
        .from('enquiry_conversation_links')
        .select(`
          conversation_id,
          link_type,
          is_active
        `)
        .eq('inquiry_id', inquiryId)
        .eq('is_active', true);

      if (linkErr) throw linkErr;

      const convIds = (linkRows || []).map(r => r.conversation_id);
      if (convIds.length === 0) {
        setConversations([]);
        setTotalMessageCount(0);
        return;
      }

      // 2. Fetch all linked enquiries for these conversations (multi-enquiry awareness)
      const { data: allLinks, error: allLinksErr } = await supabase
        .from('enquiry_conversation_links')
        .select(`
          conversation_id,
          inquiry_id,
          link_type,
          is_active,
          crm_inquiries(inquiry_number, product_name)
        `)
        .in('conversation_id', convIds)
        .eq('is_active', true);

      if (allLinksErr) throw allLinksErr;

      // Group linked enquiries by conversation_id
      const linkedEnquiriesByConvId: Record<string, any[]> = {};
      for (const al of allLinks || []) {
        if (!linkedEnquiriesByConvId[al.conversation_id]) {
          linkedEnquiriesByConvId[al.conversation_id] = [];
        }
        const inq = (al as any).crm_inquiries;
        linkedEnquiriesByConvId[al.conversation_id].push({
          inquiry_id: al.inquiry_id,
          inquiry_number: inq?.inquiry_number || al.inquiry_id.substring(0, 8),
          product_name: inq?.product_name,
          link_type: al.link_type,
        });
      }

      // 3. Fetch conversation heads
      const { data: convRows, error: convErr } = await supabase
        .from('enquiry_conversations')
        .select('id, channel, title, last_message_at')
        .in('id', convIds)
        .order('last_message_at', { ascending: false });

      if (convErr) throw convErr;

      // 4. Fetch all messages in these conversations
      const { data: msgRows, error: msgErr } = await supabase
        .from('enquiry_conversation_messages')
        .select(`
          id,
          conversation_id,
          channel,
          direction,
          external_message_id,
          sender_address,
          sender_name,
          recipient_addresses,
          subject,
          body_text,
          body_html,
          attachments,
          received_or_sent_at,
          actor_type,
          ai_processed,
          ai_summary,
          ai_proposal,
          ai_reply_draft
        `)
        .in('conversation_id', convIds)
        .order('received_or_sent_at', { ascending: true });

      if (msgErr) throw msgErr;

      // Extract pending AI proposals (Phase 7.6B)
      const pendingAi = (msgRows || [])
        .filter((m: any) => m.ai_proposal && m.ai_proposal.status === 'suggested')
        .map((m: any) => ({
          messageId: m.id,
          proposal: m.ai_proposal as AiProposal,
          channel: m.channel,
          senderAddress: m.sender_address,
          senderName: m.sender_name,
        }));
      setPendingAiProposals(pendingAi);

      // 5. Fetch request-message provenance links (enquiry_request_messages)
      const messageIds = (msgRows || []).map(m => m.id);
      let requestLinksByMessageId: Record<string, any[]> = {};
      const reqMessageMap: Record<string, RequestLinkedMessageItem[]> = {};

      if (messageIds.length > 0) {
        const { data: reqMsgRows, error: reqMsgErr } = await supabase
          .from('enquiry_request_messages')
          .select(`
            request_id,
            message_id,
            relationship,
            enquiry_requests(request_code, title)
          `)
          .in('message_id', messageIds);

        if (!reqMsgErr && reqMsgRows) {
          for (const rm of reqMsgRows) {
            if (!requestLinksByMessageId[rm.message_id]) {
              requestLinksByMessageId[rm.message_id] = [];
            }
            const enqReq = (rm as any).enquiry_requests;
            requestLinksByMessageId[rm.message_id].push({
              request_id: rm.request_id,
              relationship: rm.relationship,
              request_code: enqReq?.request_code,
              request_title: enqReq?.title,
            });

            // Map for request card
            if (!reqMessageMap[rm.request_id]) {
              reqMessageMap[rm.request_id] = [];
            }
            const foundMsg = (msgRows || []).find(m => m.id === rm.message_id);
            reqMessageMap[rm.request_id].push({
              message_id: rm.message_id,
              relationship: rm.relationship,
              sender_address: foundMsg?.sender_address,
              subject: foundMsg?.subject,
              received_or_sent_at: foundMsg?.received_or_sent_at,
            });
          }
        }
      }
      setMessagesByRequestId(reqMessageMap);

      // Assemble summaries
      const assembledSummaries: CanonicalConversationSummary[] = [];
      let totalMsgs = 0;

      for (const c of convRows || []) {
        const convMsgs = (msgRows || [])
          .filter(m => m.conversation_id === c.id)
          .map(m => ({
            ...m,
            linked_requests: requestLinksByMessageId[m.id] || [],
          }));

        totalMsgs += convMsgs.length;

        assembledSummaries.push({
          id: c.id,
          channel: c.channel,
          title: c.title,
          last_message_at: c.last_message_at,
          linked_enquiries: linkedEnquiriesByConvId[c.id] || [],
          messages: convMsgs,
        });
      }

      setConversations(assembledSummaries);
      setTotalMessageCount(totalMsgs);
    } catch (err) {
      console.error('[EnquiryDetailDrawer] Failed to load conversations:', err);
    } finally {
      setLoadingConversations(false);
    }
  }, []);

  // Lazy-load canonical documents (Phase 7.4)
  const loadDocuments = useCallback(async (inquiryId: string, reqIds: string[]) => {
    if (!inquiryId) {
      setDocuments([]);
      setDocumentsByRequestId({});
      return;
    }

    try {
      setLoadingDocuments(true);

      // Query crm_product_documents by inquiry_id OR enquiry_request_id
      let query = supabase
        .from('crm_product_documents')
        .select(`
          id,
          inquiry_id,
          enquiry_request_id,
          product_name,
          make,
          document_type,
          original_file_name,
          display_file_name,
          storage_path,
          uploaded_by,
          created_at,
          ai_extraction,
          enquiry_requests(request_code, title)
        `);

      if (reqIds.length > 0) {
        query = query.or(`inquiry_id.eq.${inquiryId},enquiry_request_id.in.(${reqIds.join(',')})`);
      } else {
        query = query.eq('inquiry_id', inquiryId);
      }

      const { data, error } = await query.order('created_at', { ascending: false });

      if (error) throw error;

      const docList: EnquiryDocumentItem[] = [];
      const reqDocsMap: Record<string, RequestLinkedDocumentItem[]> = {};

      for (const d of data || []) {
        const enqReq = (d as any).enquiry_requests;
        const item: EnquiryDocumentItem = {
          id: d.id,
          inquiry_id: d.inquiry_id,
          enquiry_request_id: d.enquiry_request_id,
          product_name: d.product_name,
          make: d.make,
          document_type: d.document_type,
          original_file_name: d.original_file_name,
          display_file_name: d.display_file_name,
          storage_path: d.storage_path,
          uploaded_by: d.uploaded_by,
          created_at: d.created_at,
          request_code: enqReq?.request_code,
          request_title: enqReq?.title,
          ai_extraction: (d as any).ai_extraction || null,
        };
        docList.push(item);

        if (d.enquiry_request_id) {
          if (!reqDocsMap[d.enquiry_request_id]) {
            reqDocsMap[d.enquiry_request_id] = [];
          }
          reqDocsMap[d.enquiry_request_id].push({
            id: d.id,
            document_type: d.document_type,
            display_file_name: d.display_file_name,
            original_file_name: d.original_file_name,
            storage_path: d.storage_path,
            created_at: d.created_at,
          });
        }
      }

      setDocuments(docList);
      setDocumentsByRequestId(reqDocsMap);
    } catch (err) {
      console.error('[EnquiryDetailDrawer] Failed to load documents:', err);
    } finally {
      setLoadingDocuments(false);
    }
  }, []);

  const refreshEnquiryData = useCallback(async () => {
    if (!activeEnquiry?.id) return;
    try {
      const freshRow = await EnquiryControlCenterService.getControlCenterEnquiryById(activeEnquiry.id);
      if (freshRow) {
        setActiveEnquiry(freshRow);
        const reqIds = freshRow.requests.map(r => r.id);
        await Promise.all([
          loadLinkedTasks(reqIds),
          loadConversations(freshRow.id, reqIds),
          loadDocuments(freshRow.id, reqIds),
        ]);
      }
      onRefresh();
    } catch (err) {
      console.error('[EnquiryDetailDrawer] Refresh error:', err);
    }
  }, [activeEnquiry?.id, loadLinkedTasks, loadConversations, loadDocuments, onRefresh]);

  useEffect(() => {
    if (activeEnquiry?.id) {
      const reqIds = (activeEnquiry.requests || []).map(r => r.id);
      loadLinkedTasks(reqIds);
      loadConversations(activeEnquiry.id, reqIds);
      loadDocuments(activeEnquiry.id, reqIds);
    }
  }, [activeEnquiry?.id, loadLinkedTasks, loadConversations, loadDocuments]);

  if (!activeEnquiry) return null;

  const { customer, operationalSummary, requests, age, due } = activeEnquiry;

  return (
    <div className="fixed inset-y-0 right-0 w-full sm:w-[560px] lg:w-[720px] bg-white shadow-2xl border-l border-gray-200 z-50 flex flex-col transform transition-transform duration-200 ease-in-out">
      {/* Drawer Header */}
      <div className="p-4 border-b border-gray-200 bg-gray-50 flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-bold text-lg text-gray-900">{activeEnquiry.inquiryNumber}</span>
            {activeEnquiry.isMultiProduct && (
              <span className="inline-flex items-center gap-1 text-[11px] bg-blue-100 text-blue-800 px-1.5 py-0.5 rounded font-medium">
                <Layers className="w-3 h-3" /> Multi-product
              </span>
            )}
            {activeEnquiry.priceReady && (
              <span className="inline-flex items-center gap-1 text-[11px] bg-emerald-100 text-emerald-800 px-1.5 py-0.5 rounded font-medium">
                <CheckCircle2 className="w-3 h-3" /> Price Ready
              </span>
            )}
            <PipelineStatusBadge status={activeEnquiry.pipelineStatus} />
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
            <span>Received: {activeEnquiry.inquiryDate}</span>
            <span>·</span>
            <span className="font-medium text-gray-700">{age.label} ago</span>
            <span>·</span>
            <span>
              Enquiry Owner:{' '}
              <strong className="text-gray-800">{activeEnquiry.assignedToName || 'Unassigned'}</strong>
            </span>
          </div>
        </div>

        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-200 transition cursor-pointer"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Drawer Tab Navigation */}
      <div className="flex items-center border-b border-gray-200 bg-white px-4 text-xs font-medium">
        <button
          type="button"
          onClick={() => setActiveTab('requests')}
          className={`py-2.5 px-3 border-b-2 flex items-center gap-1.5 transition cursor-pointer ${
            activeTab === 'requests'
              ? 'border-blue-600 text-blue-700 font-semibold'
              : 'border-transparent text-gray-500 hover:text-gray-800'
          }`}
        >
          <CheckSquare className="w-3.5 h-3.5" />
          <span>Requirements & Tasks</span>
          <span
            className={`px-1.5 py-0.2 rounded-full text-[10px] ${
              activeTab === 'requests' ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-600'
            }`}
          >
            {requests.length}
          </span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('conversation')}
          className={`py-2.5 px-3 border-b-2 flex items-center gap-1.5 transition cursor-pointer ${
            activeTab === 'conversation'
              ? 'border-blue-600 text-blue-700 font-semibold'
              : 'border-transparent text-gray-500 hover:text-gray-800'
          }`}
        >
          <MessageSquare className="w-3.5 h-3.5" />
          <span>Conversation</span>
          <span
            className={`px-1.5 py-0.2 rounded-full text-[10px] ${
              activeTab === 'conversation'
                ? 'bg-blue-100 text-blue-800'
                : 'bg-gray-100 text-gray-600'
            }`}
          >
            {totalMessageCount}
          </span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('documents')}
          className={`py-2.5 px-3 border-b-2 flex items-center gap-1.5 transition cursor-pointer ${
            activeTab === 'documents'
              ? 'border-blue-600 text-blue-700 font-semibold'
              : 'border-transparent text-gray-500 hover:text-gray-800'
          }`}
        >
          <FileText className="w-3.5 h-3.5" />
          <span>Documents</span>
          <span
            className={`px-1.5 py-0.2 rounded-full text-[10px] ${
              activeTab === 'documents'
                ? 'bg-blue-100 text-blue-800'
                : 'bg-gray-100 text-gray-600'
            }`}
          >
            {documents.length}
          </span>
        </button>
      </div>

      {/* Drawer Scrollable Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 text-xs">
        {/* Section A: Customer Info Card (Always Visible) */}
        <div className="bg-white border border-gray-200 rounded-lg p-3 space-y-1.5 shadow-2xs">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 font-semibold text-gray-900 text-sm">
              <Building className="w-4 h-4 text-gray-500" />
              <span>{customer.companyName}</span>
            </div>
            <span
              className={`px-1.5 py-0.5 rounded text-[10px] font-semibold border ${
                customer.isErpCustomer
                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                  : 'bg-amber-50 text-amber-700 border-amber-200'
              }`}
            >
              {customer.isErpCustomer ? 'ERP Customer' : 'CRM Prospect'}
            </span>
          </div>

          {(customer.contactPerson || customer.contactEmail || customer.contactPhone) && (
            <div className="text-gray-600 flex flex-wrap items-center gap-x-3 gap-y-1 pt-1.5 border-t border-gray-100 text-xs">
              {customer.contactPerson && (
                <span className="flex items-center gap-1">
                  <User className="w-3.5 h-3.5 text-gray-400" />
                  {customer.contactPerson}
                </span>
              )}
              {customer.contactEmail && (
                <span className="flex items-center gap-1">
                  <Mail className="w-3.5 h-3.5 text-gray-400" />
                  {customer.contactEmail}
                </span>
              )}
              {customer.contactPhone && (
                <span className="flex items-center gap-1">
                  <Phone className="w-3.5 h-3.5 text-gray-400" />
                  {customer.contactPhone}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Section B: Product & Requirement Summary (Always Visible) */}
        <div className="bg-white border border-gray-200 rounded-lg p-3 space-y-2 shadow-2xs">
          <div className="font-semibold text-gray-900 text-xs flex items-center justify-between">
            <span>Product & Requirement</span>
            {activeEnquiry.priority && (
              <span className="uppercase text-[10px] font-bold text-gray-500">
                Priority: {activeEnquiry.priority}
              </span>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <span className="text-[10px] text-gray-400 block uppercase">Product</span>
              <span className="font-semibold text-gray-900">{activeEnquiry.productName}</span>
            </div>
            <div>
              <span className="text-[10px] text-gray-400 block uppercase">Quantity</span>
              <span className="font-medium text-gray-800">{activeEnquiry.quantity || '—'}</span>
            </div>
          </div>
          {activeEnquiry.specification && (
            <div className="pt-1 border-t border-gray-100">
              <span className="text-[10px] text-gray-400 block uppercase">Specification</span>
              <span className="font-medium text-gray-800">{activeEnquiry.specification}</span>
            </div>
          )}
        </div>

        {/* AI Understanding Section (Phase 7.6B) - Rendered when pending suggested AI proposal exists */}
        {pendingAiProposals.length > 0 && (
          <div className="space-y-3">
            {pendingAiProposals.map((item) => (
              <AiUnderstandingCard
                key={item.messageId}
                proposal={item.proposal}
                messageId={item.messageId}
                inquiryId={activeEnquiry.id}
                channel={item.channel}
                senderAddress={item.senderAddress}
                senderName={item.senderName}
                onRefresh={refreshEnquiryData}
              />
            ))}
          </div>
        )}

        {/* TAB 1: Requirements & Tasks */}
        {activeTab === 'requests' && (
          <div className="space-y-4">
            {/* Operational Work Status & Summary */}
            <div className="bg-gradient-to-br from-gray-50 to-white border border-gray-200 rounded-lg p-3.5 space-y-3 shadow-2xs">
              <div className="font-semibold text-gray-900 text-xs flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <AlertTriangle className="w-4 h-4 text-amber-500" />
                  <span>Operational Work Summary</span>
                </div>
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="text-gray-500">
                    Open: <strong>{operationalSummary.stats.open}</strong>
                  </span>
                  <span className="text-rose-600">
                    Blocked: <strong>{operationalSummary.stats.blocked}</strong>
                  </span>
                  <span className="text-amber-600">
                    Overdue: <strong>{operationalSummary.stats.overdue}</strong>
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="p-2 rounded bg-white border border-gray-100">
                  <span className="text-[10px] text-gray-400 block uppercase font-medium">Waiting For</span>
                  <span className="font-semibold text-purple-700">
                    {operationalSummary.waitingForSummary || 'None'}
                  </span>
                </div>
                <div className="p-2 rounded bg-white border border-gray-100">
                  <span className="text-[10px] text-gray-400 block uppercase font-medium">Due Target</span>
                  <span className={`font-semibold ${due.isOverdue ? 'text-rose-600' : 'text-gray-800'}`}>
                    {due.dueLabel || 'No target set'}
                  </span>
                </div>
              </div>

              {operationalSummary.currentBlocker ? (
                <div className="p-2.5 rounded bg-rose-50 border border-rose-200 text-rose-800 text-xs space-y-0.5">
                  <div className="font-semibold flex items-center gap-1">
                    <span>🛑 Current Blocker:</span>
                  </div>
                  <div className="font-medium">{operationalSummary.currentBlocker}</div>
                </div>
              ) : (
                <div className="text-gray-500 italic text-xs">No active blocker recorded.</div>
              )}

              {operationalSummary.nextAction && (
                <div className="p-2.5 rounded bg-blue-50 border border-blue-200 text-blue-800 text-xs space-y-0.5">
                  <div className="font-semibold flex items-center gap-1">
                    <span>👉 Next Action:</span>
                  </div>
                  <div className="font-medium">{operationalSummary.nextAction}</div>
                </div>
              )}
            </div>

            {/* Customer Requirements & Execution */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="font-semibold text-gray-900 text-xs flex items-center gap-2">
                  <span>Customer Requirements & Execution ({requests.length})</span>
                  {loadingTasks && <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-600" />}
                </div>

                {canManage && (
                  <button
                    type="button"
                    onClick={() => setShowAddRequestModal(true)}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white shadow-2xs transition cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add Requirement</span>
                  </button>
                )}
              </div>

              {requests.length === 0 ? (
                <div className="p-6 text-center rounded-lg border border-dashed border-gray-300 bg-gray-50/50 space-y-2">
                  <p className="text-gray-500 text-xs font-medium">
                    No structured customer requirements recorded yet for this enquiry.
                  </p>
                  {canManage && (
                    <button
                      type="button"
                      onClick={() => setShowAddRequestModal(true)}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-semibold bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 shadow-2xs transition cursor-pointer"
                    >
                      <Plus className="w-3.5 h-3.5 text-blue-600" />
                      <span>Add First Requirement</span>
                    </button>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  {requests.map(req => (
                    <RequestCard
                      key={req.id}
                      request={req}
                      inquiryId={activeEnquiry.id}
                      inquiryNumber={activeEnquiry.inquiryNumber}
                      linkedTasks={linkedTasksByRequestId[req.id] || []}
                      linkedDocuments={documentsByRequestId[req.id] || []}
                      linkedMessages={messagesByRequestId[req.id] || []}
                      onRefresh={refreshEnquiryData}
                      onOpenTaskModal={taskId => setActiveTaskIdForModal(taskId)}
                      canManage={canManage}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 2: Conversation */}
        {activeTab === 'conversation' && (
          <ConversationTimeline
            conversations={conversations}
            currentInquiryId={activeEnquiry.id}
            currentInquiryNumber={activeEnquiry.inquiryNumber}
            loading={loadingConversations}
            onRefresh={refreshEnquiryData}
            onOpenComposer={draft => {
              // Open default mailto as fallback or integration hook
              const subjectEnc = encodeURIComponent(draft.subject || '');
              const bodyEnc = encodeURIComponent(draft.body || '');
              window.open(`mailto:${draft.to}?subject=${subjectEnc}&body=${bodyEnc}`, '_blank');
            }}
          />
        )}

        {/* TAB 3: Documents */}
        {activeTab === 'documents' && (
          <DocumentsList
            documents={documents}
            currentInquiryNumber={activeEnquiry.inquiryNumber}
            loading={loadingDocuments}
          />
        )}
      </div>

      {/* Add Request Modal */}
      {showAddRequestModal && (
        <CreateEnquiryRequestModal
          isOpen={showAddRequestModal}
          onClose={() => setShowAddRequestModal(false)}
          onSuccess={refreshEnquiryData}
          inquiryId={activeEnquiry.id}
          inquiryNumber={activeEnquiry.inquiryNumber}
          existingRequestCount={requests.length}
        />
      )}

      {/* Task Detail Modal (reusing existing Tasks system) */}
      {activeTaskIdForModal && (
        <TaskDetailModal
          isOpen={!!activeTaskIdForModal}
          onClose={() => setActiveTaskIdForModal(null)}
          taskId={activeTaskIdForModal}
          onUpdate={refreshEnquiryData}
        />
      )}
    </div>
  );
};
