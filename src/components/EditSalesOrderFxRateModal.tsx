import React, { useState, useEffect } from 'react';
import { DollarSign, AlertCircle, Save, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Modal } from './Modal';
import { showToast } from './ToastNotification';

export interface SalesOrderFxTarget {
  id: string;
  so_number: string;
  currency: string;
  total_amount: number;
  commercial_usd_to_idr_rate?: number | null;
}

interface EditSalesOrderFxRateModalProps {
  isOpen: boolean;
  onClose: () => void;
  salesOrder: SalesOrderFxTarget | null;
  onSuccess: (soId: string, newRate: number | null) => void;
}

export function EditSalesOrderFxRateModal({
  isOpen,
  onClose,
  salesOrder,
  onSuccess,
}: EditSalesOrderFxRateModalProps) {
  const [rateInput, setRateInput] = useState('');
  const [reasonInput, setReasonInput] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (salesOrder) {
      setRateInput(
        salesOrder.commercial_usd_to_idr_rate != null
          ? String(salesOrder.commercial_usd_to_idr_rate)
          : ''
      );
      setReasonInput('');
    }
  }, [salesOrder]);

  if (!salesOrder) return null;

  const currentRate = salesOrder.commercial_usd_to_idr_rate ?? null;
  const isUSD = salesOrder.currency === 'USD';
  const numericRate = rateInput.trim() === '' ? null : parseFloat(rateInput.replace(/,/g, ''));

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();

    if (rateInput.trim() !== '' && (isNaN(numericRate!) || numericRate! <= 0)) {
      showToast({
        type: 'error',
        title: 'Invalid Rate',
        message: 'Please enter a valid positive exchange rate (e.g. 17735)',
      });
      return;
    }

    setSaving(true);
    try {
      const reason = reasonInput.trim() || 'Commercial FX rate updated';

      const { data, error } = await supabase.rpc('update_sales_order_commercial_rate', {
        p_so_id: salesOrder.id,
        p_new_rate: numericRate,
        p_reason: reason,
      });

      if (error) throw error;
      if (data && data.success === false) {
        throw new Error(data.error || 'Failed to update exchange rate');
      }

      showToast({
        type: 'success',
        title: 'Exchange Rate Updated',
        message: numericRate
          ? `Commercial FX rate for ${salesOrder.so_number} set to Rp ${numericRate.toLocaleString('id-ID')} / USD.`
          : `Commercial FX rate for ${salesOrder.so_number} cleared.`,
      });

      onSuccess(salesOrder.id, numericRate);
      onClose();
    } catch (err: any) {
      console.error('Error updating exchange rate:', err);
      showToast({
        type: 'error',
        title: 'Update Failed',
        message: err.message || 'Failed to update exchange rate',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Edit Commercial FX Rate: ${salesOrder.so_number}`}
      size="sm"
    >
      <form onSubmit={handleSave} className="space-y-4">
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-900 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
          <div className="space-y-1">
            <p className="font-semibold">Commercial Reference Only</p>
            <p className="text-amber-800 leading-relaxed">
              This rate is used for commercial quotation and profitability analysis.
              Changing this rate will update commercial views and the FX Dashboard, but will{' '}
              <strong>never</strong> alter issued delivery challans, invoices, tax, or accounting journals.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 bg-gray-50 p-3 rounded-lg text-xs">
          <div>
            <span className="text-gray-500 block">SO Currency:</span>
            <span className="font-bold text-gray-900">{salesOrder.currency || 'IDR'}</span>
          </div>
          <div>
            <span className="text-gray-500 block">SO Amount:</span>
            <span className="font-bold text-gray-900">
              {salesOrder.currency === 'USD' ? '$' : 'Rp'}{' '}
              {Number(salesOrder.total_amount).toLocaleString(
                salesOrder.currency === 'USD' ? 'en-US' : 'id-ID',
                { minimumFractionDigits: 2 }
              )}
            </span>
          </div>
          <div className="col-span-2 border-t border-gray-200 pt-2 flex justify-between items-center">
            <span className="text-gray-500">Current Saved Rate:</span>
            <span className="font-semibold text-gray-800">
              {currentRate != null
                ? `Rp ${Number(currentRate).toLocaleString('id-ID', { maximumFractionDigits: 2 })} / USD`
                : 'Not Set'}
            </span>
          </div>
        </div>

        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1">
            New Commercial Exchange Rate (USD → IDR)
          </label>
          <div className="relative rounded-md shadow-sm">
            <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
              <span className="text-gray-500 sm:text-xs">Rp</span>
            </div>
            <input
              type="number"
              step="any"
              min="0"
              placeholder="e.g. 17735"
              value={rateInput}
              onChange={(e) => setRateInput(e.target.value)}
              className="block w-full rounded-md border-gray-300 pl-10 pr-16 py-2 text-sm focus:border-blue-500 focus:ring-blue-500"
              autoFocus
            />
            <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3">
              <span className="text-gray-500 sm:text-xs">/ USD</span>
            </div>
          </div>
          <p className="text-[11px] text-gray-500 mt-1">
            Leave blank to clear the rate.
          </p>
        </div>

        {isUSD && numericRate && numericRate > 0 && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-2.5 text-xs text-blue-900">
            <div className="flex justify-between font-medium">
              <span>Commercial IDR Equivalent:</span>
              <span className="font-bold">
                Rp{' '}
                {(salesOrder.total_amount * numericRate).toLocaleString('id-ID', {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </span>
            </div>
            <p className="text-[10px] text-blue-700 mt-0.5">
              ${salesOrder.total_amount.toLocaleString('en-US', { minimumFractionDigits: 2 })} × Rp{' '}
              {numericRate.toLocaleString('id-ID')}
            </p>
          </div>
        )}

        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1">
            Reason for Update (Audit Trail)
          </label>
          <input
            type="text"
            placeholder="e.g. Historical rate backfill / Agreed quotation rate"
            value={reasonInput}
            onChange={(e) => setReasonInput(e.target.value)}
            className="block w-full rounded-md border-gray-300 py-2 px-3 text-sm focus:border-blue-500 focus:ring-blue-500"
          />
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-3 py-1.5 border border-gray-300 rounded-md text-xs font-medium text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-md text-xs font-semibold shadow-sm disabled:opacity-50"
          >
            <Save className="w-3.5 h-3.5" />
            {saving ? 'Saving...' : 'Save Exchange Rate'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
