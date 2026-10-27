import { useState } from 'react';
import { DollarSign, FileText, TestTube, Send, Phone, Calendar as CalendarIcon, MessageSquare, CheckCircle2, Clock } from 'lucide-react';
import { Modal } from '../Modal';
import { performQuickAction, logActivity } from '../../services/quickActions';
import type { Inquiry } from '../../types/commandCenter';

interface QuickActionsPanelProps {
  inquiry: Inquiry | null;
  onActionComplete: () => void;
}

export function QuickActionsPanel({ inquiry, onActionComplete }: QuickActionsPanelProps) {
  const [activityModalOpen, setActivityModalOpen] = useState(false);
  const [activityType, setActivityType] = useState<'phone_call' | 'meeting' | 'whatsapp'>('phone_call');
  const [performingAction, setPerformingAction] = useState(false);

  const quickActions = [
    {
      id: 'send_price',
      label: 'Send Price',
      icon: DollarSign,
      color: 'bg-green-50 hover:bg-green-100 text-green-700 border-green-200',
      description: 'Auto-updates status & creates 2-day follow-up',
    },
    {
      id: 'send_coa',
      label: 'Send COA',
      icon: FileText,
      color: 'bg-blue-50 hover:bg-blue-100 text-blue-700 border-blue-200',
      description: 'Auto-updates status & creates 1-day follow-up',
    },
    {
      id: 'send_msds',
      label: 'Send MSDS',
      icon: FileText,
      color: 'bg-orange-50 hover:bg-orange-100 text-orange-700 border-orange-200',
      description: 'Sends MSDS document',
    },
    {
      id: 'send_sample',
      label: 'Send Sample',
      icon: TestTube,
      color: 'bg-purple-50 hover:bg-purple-100 text-purple-700 border-purple-200',
      description: 'Auto-updates status & creates 3-day follow-up',
    },
  ];

  const callOutcomes = [
    { value: 'customer_will_revert', label: 'Customer Will Revert', followUpDays: 2 },
    { value: 'could_not_reach', label: 'Could Not Reach', followUpDays: 1 },
    { value: 'discussed_price', label: 'Discussed Price/COA', followUpDays: 3 },
    { value: 'positive', label: 'Positive Response', followUpDays: 2 },
    { value: 'negative', label: 'Negative Response', followUpDays: 7 },
    { value: 'other', label: 'Other', followUpDays: 3 },
  ];

  const handleQuickAction = async (actionId: string, label: string) => {
    if (!inquiry) return;

    const confirmed = confirm(`Send ${label}?\n\nThis will:\n- Update inquiry status\n- Create automatic follow-up\n- Log the action\n\nContinue?`);
    if (!confirmed) return;

    setPerformingAction(true);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const result = await performQuickAction(
        inquiry.id,
        actionId,
        label,
        user.id,
        {
          emailTo: inquiry.contact_email || undefined,
          emailSubject: `Re: ${inquiry.email_subject || inquiry.product_name}`,
          emailBody: `Dear ${inquiry.contact_person || 'Sir/Madam'},\n\nThank you for your inquiry regarding ${inquiry.product_name}.\n\nPlease find the ${label.toLowerCase()} attached.\n\nBest regards`,
        }
      );

      if (result.success) {
        alert(`${label} sent successfully!\n\nStatus updated & follow-up created automatically.`);
        onActionComplete();
      } else {
        alert(`Failed to send ${label}: ${result.error}`);
      }
    } catch (error) {
      console.error('Error performing quick action:', error);
      alert('Failed to perform action. Please try again.');
    } finally {
      setPerformingAction(false);
    }
  };

  const handleLogActivity = async (outcome: string) => {
    if (!inquiry) return;

    setPerformingAction(true);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const activityTitle = activityType === 'phone_call'
        ? 'Phone Call'
        : activityType === 'meeting'
        ? 'Meeting'
        : 'WhatsApp Message';

      const result = await logActivity(
        inquiry.id,
        activityType,
        activityTitle,
        outcome,
        user.id
      );

      if (result.success) {
        const selectedOutcome = callOutcomes.find(o => o.value === outcome);
        alert(`${activityTitle} logged!\n\nFollow-up automatically created for ${selectedOutcome?.followUpDays} days from now.`);
        setActivityModalOpen(false);
        onActionComplete();
      } else {
        alert(`Failed to log activity: ${result.error}`);
      }
    } catch (error) {
      console.error('Error logging activity:', error);
      alert('Failed to log activity. Please try again.');
    } finally {
      setPerformingAction(false);
    }
  };

  if (!inquiry) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-8 bg-gray-50">
        <Send className="w-20 h-20 text-gray-300 mb-4" />
        <h3 className="text-lg font-semibold text-gray-900 mb-2">Quick Actions</h3>
        <p className="text-gray-600 max-w-md">
          Save an inquiry to see quick action buttons here
        </p>
        <div className="mt-6 text-sm text-gray-500 space-y-1">
          <p>One-click actions include:</p>
          <ul className="list-disc list-inside text-left">
            <li>Send Price Quote</li>
            <li>Send COA/MSDS</li>
            <li>Log Phone Calls</li>
            <li>Schedule Follow-ups</li>
          </ul>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-white border-l border-gray-200">
      <div className="px-4 py-3 border-b border-gray-200 bg-gradient-to-r from-green-50 to-transparent">
        <h2 className="text-lg font-semibold text-gray-900 mb-1">Quick Actions</h2>
        <p className="text-xs text-gray-600">Inquiry #{inquiry.inquiry_number}</p>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-2">
            <Send className="w-4 h-4" />
            Send Documents (1-Click)
          </h3>
          <div className="space-y-2">
            {quickActions.map((action) => (
              <button
                key={action.id}
                onClick={() => handleQuickAction(action.id, action.label)}
                disabled={performingAction}
                className={`w-full p-3 rounded-lg border-2 transition ${action.color} disabled:opacity-50 disabled:cursor-not-allowed text-left`}
              >
                <div className="flex items-center gap-3">
                  <action.icon className="w-5 h-5 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-sm">{action.label}</p>
                    <p className="text-xs opacity-75 truncate">{action.description}</p>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="border-t border-gray-200 pt-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-2">
            <Phone className="w-4 h-4" />
            Log Activity (1-Click)
          </h3>
          <div className="space-y-2">
            <button
              onClick={() => {
                setActivityType('phone_call');
                setActivityModalOpen(true);
              }}
              disabled={performingAction}
              className="w-full p-3 rounded-lg border-2 border-gray-200 hover:bg-gray-50 transition text-left disabled:opacity-50"
            >
              <div className="flex items-center gap-3">
                <Phone className="w-5 h-5 text-blue-600 flex-shrink-0" />
                <div className="flex-1">
                  <p className="font-semibold text-sm text-gray-900">Log Call</p>
                  <p className="text-xs text-gray-600">Quick outcome selection</p>
                </div>
              </div>
            </button>

            <button
              onClick={() => {
                setActivityType('meeting');
                setActivityModalOpen(true);
              }}
              disabled={performingAction}
              className="w-full p-3 rounded-lg border-2 border-gray-200 hover:bg-gray-50 transition text-left disabled:opacity-50"
            >
              <div className="flex items-center gap-3">
                <CalendarIcon className="w-5 h-5 text-purple-600 flex-shrink-0" />
                <div className="flex-1">
                  <p className="font-semibold text-sm text-gray-900">Log Meeting</p>
                  <p className="text-xs text-gray-600">Record meeting outcome</p>
                </div>
              </div>
            </button>

            <button
              onClick={() => {
                setActivityType('whatsapp');
                setActivityModalOpen(true);
              }}
              disabled={performingAction}
              className="w-full p-3 rounded-lg border-2 border-gray-200 hover:bg-gray-50 transition text-left disabled:opacity-50"
            >
              <div className="flex items-center gap-3">
                <MessageSquare className="w-5 h-5 text-green-600 flex-shrink-0" />
                <div className="flex-1">
                  <p className="font-semibold text-sm text-gray-900">Log WhatsApp</p>
                  <p className="text-xs text-gray-600">Log WhatsApp conversation</p>
                </div>
              </div>
            </button>
          </div>
        </div>

        <div className="border-t border-gray-200 pt-4">
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
            <div className="flex items-start gap-2">
              <Clock className="w-4 h-4 text-blue-600 mt-0.5 flex-shrink-0" />
              <div className="text-xs text-blue-800">
                <p className="font-medium mb-1">Auto-Automation Active</p>
                <ul className="space-y-0.5 text-blue-700">
                  <li>• Status updates automatically</li>
                  <li>• Follow-ups created automatically</li>
                  <li>• All actions logged in timeline</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </div>

      <Modal
        isOpen={activityModalOpen}
        onClose={() => setActivityModalOpen(false)}
        title={`Log ${activityType === 'phone_call' ? 'Phone Call' : activityType === 'meeting' ? 'Meeting' : 'WhatsApp'}`}
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            Select the outcome to automatically update follow-up date:
          </p>

          <div className="space-y-2">
            {callOutcomes.map((outcome) => (
              <button
                key={outcome.value}
                onClick={() => handleLogActivity(outcome.value)}
                disabled={performingAction}
                className="w-full p-4 text-left border-2 border-gray-200 rounded-lg hover:border-blue-500 hover:bg-blue-50 transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <CheckCircle2 className="w-5 h-5 text-gray-400" />
                    <span className="font-medium text-gray-900">{outcome.label}</span>
                  </div>
                  <span className="text-xs text-gray-500">+{outcome.followUpDays}d follow-up</span>
                </div>
              </button>
            ))}
          </div>

          <div className="pt-4 border-t border-gray-200">
            <p className="text-xs text-gray-500 text-center">
              Click an outcome to log and auto-create follow-up
            </p>
          </div>
        </div>
      </Modal>
    </div>
  );
}

import { supabase } from '../../lib/supabase';
