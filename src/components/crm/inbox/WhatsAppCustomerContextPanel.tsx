// src/components/crm/inbox/WhatsAppCustomerContextPanel.tsx
//
// Right Pane: Customer & ERP Context for WhatsApp Conversations.
// Shows recognized company, contact person, active inquiries for this company only,
// quick action triggers, team ownership, and internal notes (never sent to customer).

import React, { useState } from 'react';
import {
  Building,
  User,
  Phone,
  Mail,
  FileText,
  DollarSign,
  Package,
  Clock,
  Plus,
  ExternalLink,
  ChevronRight,
  AlertTriangle,
  CheckCircle2,
  StickyNote,
  Users,
  ShieldCheck,
  X,
  Loader,
} from 'lucide-react';
import { PhoneMatchCandidate } from '../../../services/crm/phoneMatchingService';

interface Props {
  companyName?: string | null;
  contactPerson?: string | null;
  phone: string;
  email?: string | null;
  designation?: string | null;
  customerId?: string | null;
  crmContactId?: string | null;
  matchType: 'exact_single' | 'ambiguous_multiple' | 'none';
  candidates: PhoneMatchCandidate[];
  loadingMatch?: boolean;
  onDisambiguate: () => void;
  inquiries: any[];
  onOpenInquiry?: (inquiryId: string) => void;
  onCreateInquiryPrefilled: () => void;
  onOpenQuotationModal: () => void;
  onOpenDocumentModal: () => void;
  onOpenStockModal: () => void;
  onOpenFollowUpModal: () => void;
  ownerName?: string | null;
  onReassign?: (userId: string) => void;
  internalNotes?: string;
  onSaveInternalNotes?: (notes: string) => void;
  onCloseMobile?: () => void;
}

export function WhatsAppCustomerContextPanel({
  companyName,
  contactPerson,
  phone,
  email,
  designation,
  customerId,
  crmContactId,
  matchType,
  candidates,
  loadingMatch = false,
  onDisambiguate,
  inquiries,
  onOpenInquiry,
  onCreateInquiryPrefilled,
  onOpenQuotationModal,
  onOpenDocumentModal,
  onOpenStockModal,
  onOpenFollowUpModal,
  ownerName,
  onReassign,
  internalNotes = '',
  onSaveInternalNotes,
  onCloseMobile,
}: Props) {
  const [activeTab, setActiveTab] = useState<'overview' | 'inquiries' | 'notes'>('overview');
  const [notes, setNotes] = useState(internalNotes);
  const [isSavingNotes, setIsSavingNotes] = useState(false);

  const handleSaveNotes = () => {
    setIsSavingNotes(true);
    if (onSaveInternalNotes) onSaveInternalNotes(notes);
    setTimeout(() => setIsSavingNotes(false), 500);
  };

  return (
    <div className="flex flex-col h-full bg-white border-l border-gray-200 overflow-y-auto">
      {/* Header */}
      <div className="p-3 bg-slate-50 border-b border-gray-200 flex items-center justify-between shrink-0">
        <h3 className="text-xs font-bold text-gray-900 flex items-center gap-1.5">
          <Building className="w-4 h-4 text-emerald-700" />
          Customer & ERP Context
        </h3>
        {onCloseMobile && (
          <button onClick={onCloseMobile} className="p-1 rounded hover:bg-gray-200 text-gray-500">
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-200 text-xs font-semibold bg-gray-50/60">
        <button
          onClick={() => setActiveTab('overview')}
          className={`flex-1 py-2 text-center border-b-2 transition ${
            activeTab === 'overview'
              ? 'border-emerald-600 text-emerald-800 bg-white'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Customer
        </button>
        <button
          onClick={() => setActiveTab('inquiries')}
          className={`flex-1 py-2 text-center border-b-2 transition flex items-center justify-center gap-1 ${
            activeTab === 'inquiries'
              ? 'border-emerald-600 text-emerald-800 bg-white'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Inquiries ({inquiries.length})
        </button>
        <button
          onClick={() => setActiveTab('notes')}
          className={`flex-1 py-2 text-center border-b-2 transition ${
            activeTab === 'notes'
              ? 'border-emerald-600 text-emerald-800 bg-white'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Internal Notes
        </button>
      </div>

      {/* Body Content */}
      <div className="p-4 space-y-4 flex-1">
        {activeTab === 'overview' && (
          <>
            {/* Customer Recognition Banner */}
            {loadingMatch ? (
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg flex items-center gap-2 text-xs text-gray-600">
                <Loader className="w-4 h-4 animate-spin text-emerald-600 shrink-0" />
                <span className="font-medium">Verifying customer recognition in ERP...</span>
              </div>
            ) : matchType === 'exact_single' ? (
              <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg">
                <div className="flex items-center gap-1.5 text-emerald-800 font-bold text-xs mb-1">
                  <ShieldCheck className="w-4 h-4 text-emerald-600" />
                  Recognized ERP Customer
                </div>
                <h4 className="text-xs font-extrabold text-gray-900">{companyName}</h4>
                {contactPerson && (
                  <p className="text-[11px] text-gray-600 mt-0.5">
                    Contact: <span className="font-semibold">{contactPerson}</span>
                    {designation ? ` (${designation})` : ''}
                  </p>
                )}
                <div className="flex items-center gap-2 mt-2 text-[11px] text-gray-500">
                  <Phone className="w-3 h-3 text-gray-400" />
                  <span className="font-mono">{phone}</span>
                </div>
                {email && (
                  <div className="flex items-center gap-2 mt-1 text-[11px] text-gray-500">
                    <Mail className="w-3 h-3 text-gray-400" />
                    <span>{email}</span>
                  </div>
                )}
              </div>
            ) : matchType === 'ambiguous_multiple' ? (
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg">
                <div className="flex items-center gap-1.5 text-amber-800 font-bold text-xs mb-1">
                  <AlertTriangle className="w-4 h-4 text-amber-600" />
                  Multiple Companies Matched
                </div>
                <p className="text-[11px] text-amber-700 mb-2">
                  This phone number matches {candidates.length} distinct records in the database.
                </p>
                <button
                  onClick={onDisambiguate}
                  className="w-full py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded font-semibold text-xs transition"
                >
                  Choose Correct Customer
                </button>
              </div>
            ) : (
              <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg">
                <div className="flex items-center gap-1.5 text-gray-700 font-bold text-xs mb-1">
                  <User className="w-4 h-4 text-gray-500" />
                  Unregistered WhatsApp Contact
                </div>
                <p className="text-[11px] text-gray-500 mb-2">Phone: {phone}</p>
                <button
                  onClick={onCreateInquiryPrefilled}
                  className="w-full py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded font-semibold text-xs transition flex items-center justify-center gap-1"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Create Inquiry & Customer
                </button>
              </div>
            )}

            {/* Quick Actions Panel */}
            <div>
              <h4 className="text-[11px] font-bold uppercase text-gray-400 mb-2">ERP Actions</h4>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={onOpenQuotationModal}
                  className="p-2.5 rounded-lg border border-emerald-200 bg-emerald-50/60 hover:bg-emerald-100/70 text-emerald-900 text-left transition"
                >
                  <DollarSign className="w-4 h-4 text-emerald-600 mb-1" />
                  <p className="font-bold text-xs">Send Quotation</p>
                  <p className="text-[10px] text-emerald-700">Official pricing</p>
                </button>

                <button
                  onClick={onOpenDocumentModal}
                  className="p-2.5 rounded-lg border border-sky-200 bg-sky-50/60 hover:bg-sky-100/70 text-sky-900 text-left transition"
                >
                  <FileText className="w-4 h-4 text-sky-600 mb-1" />
                  <p className="font-bold text-xs">Send COA / Spec</p>
                  <p className="text-[10px] text-sky-700">Batch-linked QA</p>
                </button>

                <button
                  onClick={onOpenStockModal}
                  className="p-2.5 rounded-lg border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-900 text-left transition"
                >
                  <Package className="w-4 h-4 text-slate-600 mb-1" />
                  <p className="font-bold text-xs">Check Stock</p>
                  <p className="text-[10px] text-slate-600">Godown & batch</p>
                </button>

                <button
                  onClick={onOpenFollowUpModal}
                  className="p-2.5 rounded-lg border border-indigo-200 bg-indigo-50/60 hover:bg-indigo-100/70 text-indigo-900 text-left transition"
                >
                  <Clock className="w-4 h-4 text-indigo-600 mb-1" />
                  <p className="font-bold text-xs">Set Follow-Up</p>
                  <p className="text-[10px] text-indigo-700">Durable reminder</p>
                </button>
              </div>
            </div>

            {/* Team Ownership */}
            <div className="pt-2 border-t border-gray-100">
              <h4 className="text-[11px] font-bold uppercase text-gray-400 mb-2">Team Assignment</h4>
              <div className="p-2.5 bg-gray-50 border border-gray-200 rounded flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <Users className="w-4 h-4 text-gray-500" />
                  <span className="font-semibold text-gray-800">
                    {ownerName || 'Unassigned (General Pool)'}
                  </span>
                </div>
                {onReassign && (
                  <button className="text-emerald-700 hover:text-emerald-900 font-semibold text-[11px]">
                    Reassign
                  </button>
                )}
              </div>
            </div>
          </>
        )}

        {activeTab === 'inquiries' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold text-gray-500 uppercase">Company Inquiries</span>
              <button
                onClick={onCreateInquiryPrefilled}
                className="px-2 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-[11px] font-semibold flex items-center gap-1"
              >
                <Plus className="w-3 h-3" /> New Inquiry
              </button>
            </div>

            {inquiries.length === 0 ? (
              <div className="p-6 text-center text-gray-400 text-xs bg-gray-50 border border-gray-200 rounded">
                No active inquiries for {companyName || 'this company'}.
              </div>
            ) : (
              <div className="space-y-2">
                {inquiries.map((inq) => (
                  <div
                    key={inq.id}
                    onClick={() => onOpenInquiry && onOpenInquiry(inq.id)}
                    className="p-3 bg-white hover:bg-emerald-50/50 border border-gray-200 hover:border-emerald-300 rounded-lg cursor-pointer transition shadow-2xs"
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-mono font-bold text-xs text-indigo-700">
                        {inq.inquiry_number}
                      </span>
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-gray-100 text-gray-700 uppercase">
                        {inq.pipeline_status || inq.status}
                      </span>
                    </div>
                    <p className="font-bold text-xs text-gray-900">{inq.product_name}</p>
                    <p className="text-[11px] text-gray-500 mt-0.5">Quantity: {inq.quantity || 'N/A'}</p>
                    {inq.offered_price && (
                      <p className="text-[11px] font-semibold text-emerald-700 mt-1">
                        Offered: {inq.offered_price_currency || 'USD'} {inq.offered_price.toLocaleString()}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === 'notes' && (
          <div className="space-y-3">
            <div className="p-2.5 bg-amber-50 border border-amber-200 rounded text-[11px] text-amber-900 flex items-start gap-1.5">
              <StickyNote className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <span>
                Internal Notes are strictly confidential and visible only to SAPJ employees. They are never sent
                to the customer.
              </span>
            </div>

            <textarea
              rows={8}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Record commercial context, payment promises, negotiation history, or special delivery notes..."
              className="w-full border border-gray-300 rounded-lg p-3 text-xs focus:border-amber-500 outline-none resize-none bg-amber-50/30"
            />

            <button
              onClick={handleSaveNotes}
              disabled={isSavingNotes}
              className="w-full py-2 bg-amber-600 hover:bg-amber-700 text-white rounded font-bold text-xs transition"
            >
              {isSavingNotes ? 'Saving Notes...' : 'Save Internal Notes'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
