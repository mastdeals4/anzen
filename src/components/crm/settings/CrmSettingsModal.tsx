import { useState } from 'react';
import { X, Mail, MessageSquare, SlidersHorizontal, Activity, CheckCircle2, AlertTriangle, ShieldCheck } from 'lucide-react';
import { GmailSettings } from '../GmailSettings';
import { WhatsAppSettings } from './WhatsAppSettings';
import { EnquiryControlCenter } from '../enquiry-control-center';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  canManage?: boolean;
}

export function CrmSettingsModal({ isOpen, onClose, canManage = true }: Props) {
  const [activeTab, setActiveTab] = useState<'connections' | 'control_center'>('connections');

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-hidden bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-4xl h-[85vh] flex flex-col border border-gray-200 overflow-hidden animate-in fade-in duration-150">
        
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-gray-200 bg-slate-50 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="w-5 h-5 text-gray-700" />
            <h2 className="text-base font-bold text-gray-900">CRM Settings & Integration Health</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Switcher */}
        <div className="flex border-b border-gray-200 bg-white px-6 gap-6 text-xs font-semibold">
          <button
            onClick={() => setActiveTab('connections')}
            className={`py-3 border-b-2 uppercase tracking-wider transition ${
              activeTab === 'connections'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-800'
            }`}
          >
            Integration Health (Gmail & WhatsApp)
          </button>
          <button
            onClick={() => setActiveTab('control_center')}
            className={`py-3 border-b-2 uppercase tracking-wider transition ${
              activeTab === 'control_center'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-800'
            }`}
          >
            Enquiry Control Center
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-6 bg-slate-50/50">
          {activeTab === 'connections' && (
            <div className="space-y-6 max-w-2xl mx-auto">
              <div className="bg-white rounded-lg border border-gray-200 p-5 shadow-sm space-y-4">
                <div className="flex items-center justify-between pb-3 border-b border-gray-100">
                  <div className="flex items-center gap-2 font-bold text-sm text-gray-900">
                    <Mail className="w-4 h-4 text-blue-600" />
                    Gmail Connection
                  </div>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 font-semibold border border-emerald-200 flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" />
                    Active
                  </span>
                </div>
                <GmailSettings />
              </div>

              <WhatsAppSettings />
            </div>
          )}

          {activeTab === 'control_center' && (
            <div className="bg-white rounded-lg border border-gray-200 p-4 shadow-sm">
              <EnquiryControlCenter canManage={canManage} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
