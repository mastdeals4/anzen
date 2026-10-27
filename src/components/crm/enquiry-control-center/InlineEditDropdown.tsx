import React, { useState, useRef, useEffect } from 'react';
import { supabase } from '../../../lib/supabase';
import { ChevronDown, Check, Loader2 } from 'lucide-react';
import { showToast } from '../../ToastNotification';

export interface DropdownOption {
  value: string;
  label: string;
  colorClass?: string;
}

interface InlineEditDropdownProps {
  inquiryId: string;
  field: 'assigned_to' | 'pipeline_status' | 'priority';
  currentValue: string | null;
  displayLabel: string;
  options: DropdownOption[];
  onUpdated: (newValue: string) => void;
  canManage?: boolean;
}

export const InlineEditDropdown: React.FC<InlineEditDropdownProps> = ({
  inquiryId,
  field,
  currentValue,
  displayLabel,
  options,
  onUpdated,
  canManage = true,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const handleSelect = async (newValue: string) => {
    if (newValue === currentValue) {
      setIsOpen(false);
      return;
    }

    setIsSaving(true);
    try {
      const updatePayload: Record<string, unknown> = {
        [field]: newValue === 'unassigned' ? null : newValue,
        updated_at: new Date().toISOString(),
      };

      const { error } = await supabase
        .from('crm_inquiries')
        .update(updatePayload)
        .eq('id', inquiryId);

      if (error) throw error;

      onUpdated(newValue);
      showToast({
        type: 'success',
        title: 'Updated',
        message: `${field.replace('_', ' ')} updated successfully.`,
      });
    } catch (err: any) {
      console.error(`Error updating ${field}:`, err);
      showToast({
        type: 'error',
        title: 'Update failed',
        message: err.message || 'Failed to update field.',
      });
    } finally {
      setIsSaving(false);
      setIsOpen(false);
    }
  };

  if (!canManage) {
    return <span className="text-xs text-gray-700">{displayLabel}</span>;
  }

  return (
    <div className="relative inline-block text-left" ref={dropdownRef}>
      <button
        type="button"
        disabled={isSaving}
        onClick={e => {
          e.stopPropagation();
          setIsOpen(!isOpen);
        }}
        className="group inline-flex items-center gap-1 hover:bg-gray-100 px-1.5 py-0.5 rounded text-xs text-gray-700 font-medium transition cursor-pointer border border-transparent hover:border-gray-200"
      >
        {isSaving ? (
          <Loader2 className="w-3 h-3 animate-spin text-blue-500" />
        ) : (
          <span>{displayLabel}</span>
        )}
        <ChevronDown className="w-3 h-3 text-gray-400 group-hover:text-gray-600 opacity-60" />
      </button>

      {isOpen && (
        <div className="absolute left-0 mt-1 w-44 rounded-md shadow-lg bg-white ring-1 ring-black ring-opacity-5 z-50 py-1 text-xs divide-y divide-gray-100">
          <div className="py-1">
            {options.map(opt => {
              const isSelected = opt.value === currentValue || (!currentValue && opt.value === 'unassigned');
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={e => {
                    e.stopPropagation();
                    handleSelect(opt.value);
                  }}
                  className={`w-full text-left px-3 py-1.5 flex items-center justify-between hover:bg-blue-50 transition ${
                    isSelected ? 'bg-blue-50/50 font-semibold text-blue-700' : 'text-gray-700'
                  }`}
                >
                  <span className={opt.colorClass || ''}>{opt.label}</span>
                  {isSelected && <Check className="w-3.5 h-3.5 text-blue-600" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
