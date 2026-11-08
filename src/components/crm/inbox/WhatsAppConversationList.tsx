// src/components/crm/inbox/WhatsAppConversationList.tsx
//
// Left Pane: WhatsApp-style conversations list with fast search, filters,
// unread counters, and last message previews.

import React from 'react';
import {
  Search,
  MessageSquare,
  Mail,
  Pin,
  Archive,
  Check,
  CheckCheck,
  Filter,
  UserCheck,
  AlertCircle,
  Tag,
} from 'lucide-react';
import { InboxConversation } from './CrmOmnichannelInbox';

interface Props {
  conversations: InboxConversation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  activeFilter: 'all' | 'unread' | 'assigned_me' | 'priority' | 'unassigned';
  onFilterChange: (filter: 'all' | 'unread' | 'assigned_me' | 'priority' | 'unassigned') => void;
  currentUserId?: string | null;
}

export function WhatsAppConversationList({
  conversations,
  selectedId,
  onSelect,
  searchQuery,
  onSearchChange,
  activeFilter,
  onFilterChange,
  currentUserId,
}: Props) {
  const filtered = conversations.filter((c) => {
    // Search query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const match =
        (c.customerName || '').toLowerCase().includes(q) ||
        (c.senderName || '').toLowerCase().includes(q) ||
        (c.senderAddress || '').toLowerCase().includes(q) ||
        (c.snippet || '').toLowerCase().includes(q) ||
        (c.inquiryNumber || '').toLowerCase().includes(q);
      if (!match) return false;
    }

    // Filter tabs
    if (activeFilter === 'unread' && !c.unread && !c.needsAction) return false;
    if (activeFilter === 'priority' && !c.needsAction) return false;
    if (activeFilter === 'unassigned' && c.ownerName) return false;

    return true;
  });

  const formatTime = (iso: string) => {
    if (!iso) return '';
    const date = new Date(iso);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    if (isToday) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    const isThisYear = date.getFullYear() === now.getFullYear();
    if (isThisYear) {
      return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }
    return date.toLocaleDateString([], { month: 'numeric', day: 'numeric', year: '2-digit' });
  };

  return (
    <div className="flex flex-col h-full bg-white border-r border-gray-200">
      {/* Header & Search */}
      <div className="p-3 bg-slate-50 border-b border-gray-200 space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-full bg-emerald-600 text-white flex items-center justify-center font-bold text-xs shadow-sm">
              <MessageSquare className="w-4 h-4" />
            </div>
            <h2 className="text-sm font-bold text-gray-900">Chats</h2>
          </div>
          <span className="text-[11px] font-semibold text-gray-500 bg-gray-200/60 px-2 py-0.5 rounded-full">
            {filtered.length}
          </span>
        </div>

        {/* Search input */}
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search by customer, phone, or text..."
            className="w-full bg-white border border-gray-200 rounded-lg pl-8 pr-3 py-1.5 text-xs text-gray-900 placeholder:text-gray-400 focus:outline-none focus:border-emerald-500 transition"
          />
        </div>

        {/* Filters */}
        <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
          <button
            onClick={() => onFilterChange('all')}
            className={`px-2.5 py-1 rounded-full text-[11px] font-medium shrink-0 transition ${
              activeFilter === 'all'
                ? 'bg-emerald-600 text-white shadow-sm'
                : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-100'
            }`}
          >
            All
          </button>
          <button
            onClick={() => onFilterChange('unread')}
            className={`px-2.5 py-1 rounded-full text-[11px] font-medium shrink-0 transition ${
              activeFilter === 'unread'
                ? 'bg-emerald-600 text-white shadow-sm'
                : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-100'
            }`}
          >
            Unread / Actions
          </button>
          <button
            onClick={() => onFilterChange('priority')}
            className={`px-2.5 py-1 rounded-full text-[11px] font-medium shrink-0 transition ${
              activeFilter === 'priority'
                ? 'bg-emerald-600 text-white shadow-sm'
                : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-100'
            }`}
          >
            Needs Action
          </button>
          <button
            onClick={() => onFilterChange('unassigned')}
            className={`px-2.5 py-1 rounded-full text-[11px] font-medium shrink-0 transition ${
              activeFilter === 'unassigned'
                ? 'bg-emerald-600 text-white shadow-sm'
                : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-100'
            }`}
          >
            Unassigned
          </button>
        </div>
      </div>

      {/* Conversations List */}
      <div className="flex-1 overflow-y-auto divide-y divide-gray-100">
        {filtered.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-xs">
            <MessageSquare className="w-8 h-8 mx-auto mb-2 opacity-30" />
            No conversations match this view
          </div>
        ) : (
          filtered.map((c) => {
            const isSelected = c.id === selectedId;
            const displayName = c.customerName || c.senderName || c.senderAddress || 'Customer';
            const isWhatsApp = c.channel === 'whatsapp';

            return (
              <div
                key={c.id}
                onClick={() => onSelect(c.id)}
                className={`p-3 cursor-pointer transition flex items-start gap-3 relative ${
                  isSelected ? 'bg-emerald-50/80 border-l-4 border-emerald-600' : 'hover:bg-gray-50/80'
                }`}
              >
                {/* Avatar */}
                <div
                  className={`w-9 h-9 rounded-full flex items-center justify-center font-bold text-xs shrink-0 shadow-sm ${
                    isWhatsApp
                      ? 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                      : 'bg-blue-100 text-blue-800 border border-blue-200'
                  }`}
                >
                  {displayName.charAt(0).toUpperCase()}
                </div>

                {/* Details */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between mb-0.5">
                    <h4 className="text-xs font-bold text-gray-900 truncate">{displayName}</h4>
                    <span className="text-[10px] text-gray-400 shrink-0 ml-1">{formatTime(c.timestamp)}</span>
                  </div>

                  {c.customerName && c.senderName && c.customerName !== c.senderName && (
                    <p className="text-[10px] text-gray-500 truncate mb-0.5">{c.senderName}</p>
                  )}

                  <p className="text-[11px] text-gray-600 truncate line-clamp-1 leading-snug">
                    {c.direction === 'outbound' && (
                      <span className="text-gray-400 inline-flex items-center mr-1">
                        <CheckCheck className="w-3 h-3 text-sky-500 inline mr-0.5" />
                        You:{' '}
                      </span>
                    )}
                    {c.snippet}
                  </p>

                  <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                    {isWhatsApp ? (
                      <span className="inline-flex items-center gap-0.5 px-1.5 py-0.2 rounded text-[9px] font-bold bg-emerald-100 text-emerald-800">
                        <MessageSquare className="w-2.5 h-2.5" /> WA
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-0.5 px-1.5 py-0.2 rounded text-[9px] font-bold bg-blue-100 text-blue-800">
                        <Mail className="w-2.5 h-2.5" /> Email
                      </span>
                    )}

                    {c.inquiryNumber && (
                      <span className="px-1.5 py-0.2 rounded text-[9px] font-mono font-bold bg-indigo-50 text-indigo-700 border border-indigo-200">
                        {c.inquiryNumber}
                      </span>
                    )}

                    {c.needsAction && (
                      <span className="px-1.5 py-0.2 rounded text-[9px] font-semibold bg-rose-100 text-rose-700 border border-rose-200 flex items-center gap-0.5">
                        <AlertCircle className="w-2.5 h-2.5" /> Action
                      </span>
                    )}

                    {c.unread && (
                      <span className="w-2 h-2 rounded-full bg-emerald-600 ml-auto" />
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

