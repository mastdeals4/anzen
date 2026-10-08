import { useState, useEffect, useMemo, FormEvent } from 'react';
import { supabase } from '../../../lib/supabase';
import { FinanceModal } from '../FinanceModal';
import { FinanceButton, FinanceInput, FinanceSelect } from '../FinanceUI';
import { F_LABEL, F_TEXTAREA } from '../FinanceForm';
import { showToast } from '../../ToastNotification';
import { type NotaRetur, type NotaReturItem, type NotaReturStatus, type CoretaxStatus } from '../../../types/notaRetur';
import { AlertCircle, CheckCircle, Info, ShieldCheck } from 'lucide-react';

interface MaterialReturnOption {
  id: string;
  return_number: string;
  return_date: string;
  customer_id: string;
  original_invoice_id: string | null;
  status: string;
  credit_note_number: string | null;
  customers?: {
    company_name: string;
    npwp: string | null;
    address: string | null;
  } | null;
  sales_invoices?: {
    id: string;
    invoice_number: string;
    invoice_date: string;
    faktur_pajak_number: string | null;
    total_amount: number;
  } | null;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  existingNotaRetur?: NotaRetur | null;
  originatingReturnId?: string | null;
}

export function NotaReturModal({
  isOpen,
  onClose,
  onSuccess,
  existingNotaRetur,
  originatingReturnId,
}: Props) {
  const [loading, setLoading] = useState(false);
  const [approvedReturns, setApprovedReturns] = useState<MaterialReturnOption[]>([]);
  const [selectedReturnId, setSelectedReturnId] = useState<string>('');

  // Form states
  const [returnDate, setReturnDate] = useState<string>(new Date().toISOString().split('T')[0]);
  const [customerId, setCustomerId] = useState<string>('');
  const [customerName, setCustomerName] = useState<string>('');
  const [customerNpwp, setCustomerNpwp] = useState<string>('');
  const [customerAddress, setCustomerAddress] = useState<string>('');

  const [salesInvoiceId, setSalesInvoiceId] = useState<string>('');
  const [salesInvoiceNumber, setSalesInvoiceNumber] = useState<string>('');
  const [originalFakturPajakNumber, setOriginalFakturPajakNumber] = useState<string>('');
  const [creditNoteId, setCreditNoteId] = useState<string>('');
  const [creditNoteNumber, setCreditNoteNumber] = useState<string>('');

  const [items, setItems] = useState<NotaReturItem[]>([]);
  const [status, setStatus] = useState<NotaReturStatus>('draft');
  const [coretaxReferenceNumber, setCoretaxReferenceNumber] = useState<string>('');
  const [coretaxSubmissionDate, setCoretaxSubmissionDate] = useState<string>('');
  const [coretaxStatus, setCoretaxStatus] = useState<CoretaxStatus>('draft');
  const [coretaxResponseNotes, setCoretaxResponseNotes] = useState<string>('');
  const [notes, setNotes] = useState<string>('');

  // Error and warnings
  const [error, setError] = useState<string>('');

  // Load candidate approved material returns
  useEffect(() => {
    if (!isOpen) return;

    async function loadReturns() {
      try {
        const { data, error: fetchErr } = await supabase
          .from('material_returns')
          .select(`
            id,
            return_number,
            return_date,
            customer_id,
            original_invoice_id,
            status,
            credit_note_number,
            customers:customer_id(company_name, npwp, address),
            sales_invoices:original_invoice_id(id, invoice_number, invoice_date, faktur_pajak_number, total_amount)
          `)
          .in('status', ['approved', 'completed'])
          .order('return_date', { ascending: false });

        if (fetchErr) throw fetchErr;

        const typedReturns = (data || []).map((r: any) => ({
          id: r.id,
          return_number: r.return_number,
          return_date: r.return_date,
          customer_id: r.customer_id,
          original_invoice_id: r.original_invoice_id,
          status: r.status,
          credit_note_number: r.credit_note_number,
          customers: Array.isArray(r.customers) ? r.customers[0] : r.customers,
          sales_invoices: Array.isArray(r.sales_invoices) ? r.sales_invoices[0] : r.sales_invoices,
        }));

        setApprovedReturns(typedReturns);
      } catch (err: any) {
        console.error('Failed to load approved material returns:', err);
      }
    }

    loadReturns();
  }, [isOpen]);

  // Initialize or populate form
  useEffect(() => {
    if (!isOpen) return;

    if (existingNotaRetur) {
      // Editing existing Nota Retur
      setSelectedReturnId(existingNotaRetur.material_return_id || '');
      setReturnDate(existingNotaRetur.return_date);
      setCustomerId(existingNotaRetur.customer_id);
      setCustomerName(existingNotaRetur.customer_name || existingNotaRetur.customers?.company_name || '');
      setCustomerNpwp(existingNotaRetur.customer_npwp || existingNotaRetur.customers?.npwp || '');
      setCustomerAddress(existingNotaRetur.customer_address || existingNotaRetur.customers?.address || '');
      setSalesInvoiceId(existingNotaRetur.sales_invoice_id || '');
      setSalesInvoiceNumber(existingNotaRetur.sales_invoice_number || existingNotaRetur.sales_invoices?.invoice_number || '');
      setOriginalFakturPajakNumber(existingNotaRetur.original_faktur_pajak_number || existingNotaRetur.sales_invoices?.faktur_pajak_number || '');
      setCreditNoteId(existingNotaRetur.credit_note_id || '');
      setCreditNoteNumber(existingNotaRetur.credit_note_number || existingNotaRetur.credit_notes?.credit_note_number || '');
      setStatus(existingNotaRetur.status);
      setCoretaxReferenceNumber(existingNotaRetur.coretax_reference_number || '');
      setCoretaxSubmissionDate(existingNotaRetur.coretax_submission_date || '');
      setCoretaxStatus(existingNotaRetur.coretax_status || 'draft');
      setCoretaxResponseNotes(existingNotaRetur.coretax_response_notes || '');
      setNotes(existingNotaRetur.notes || '');

      // Load items for existing Nota Retur
      void loadExistingItems(existingNotaRetur.id);
    } else {
      // New Nota Retur
      const targetReturnId = originatingReturnId || '';
      if (targetReturnId) {
        setSelectedReturnId(targetReturnId);
      } else {
        resetForm();
      }
    }
  }, [isOpen, existingNotaRetur, originatingReturnId]);

  // When selectedReturnId changes in new mode, populate form from Material Return
  useEffect(() => {
    if (existingNotaRetur || !selectedReturnId) return;

    const ret = approvedReturns.find(r => r.id === selectedReturnId);
    if (!ret) return;

    setReturnDate(ret.return_date);
    setCustomerId(ret.customer_id);
    setCustomerName(ret.customers?.company_name || '');
    setCustomerNpwp(ret.customers?.npwp || '');
    setCustomerAddress(ret.customers?.address || '');
    setSalesInvoiceId(ret.original_invoice_id || '');
    setSalesInvoiceNumber(ret.sales_invoices?.invoice_number || '');
    setOriginalFakturPajakNumber(ret.sales_invoices?.faktur_pajak_number || '');

    // Look up credit note if already generated for this return
    void lookupCreditNoteForReturn(ret.id);

    // Load items from material return
    void loadReturnItems(ret.id, ret.original_invoice_id);
  }, [selectedReturnId, approvedReturns, existingNotaRetur]);

  async function loadExistingItems(notaReturId: string) {
    try {
      const { data, error: err } = await supabase
        .from('nota_retur_items')
        .select(`
          id,
          nota_retur_id,
          product_id,
          batch_id,
          material_return_item_id,
          quantity,
          unit_price,
          dpp_amount,
          tax_rate,
          ppn_amount,
          total_amount,
          notes,
          products:product_id(product_name, product_code),
          batches:batch_id(batch_number)
        `)
        .eq('nota_retur_id', notaReturId);

      if (err) throw err;

      const loadedItems: NotaReturItem[] = (data || []).map((it: any) => ({
        id: it.id,
        nota_retur_id: it.nota_retur_id,
        product_id: it.product_id,
        batch_id: it.batch_id,
        material_return_item_id: it.material_return_item_id,
        product_name: it.products?.product_name,
        product_code: it.products?.product_code,
        batch_number: it.batches?.batch_number,
        quantity: Number(it.quantity),
        unit_price: Number(it.unit_price),
        dpp_amount: Number(it.dpp_amount),
        tax_rate: Number(it.tax_rate ?? 0.11),
        ppn_amount: Number(it.ppn_amount),
        total_amount: Number(it.total_amount),
        notes: it.notes,
      }));

      setItems(loadedItems);
    } catch (e: any) {
      console.error('Failed to load nota retur items:', e);
    }
  }

  async function lookupCreditNoteForReturn(returnId: string) {
    try {
      const { data } = await supabase
        .from('credit_notes')
        .select('id, credit_note_number')
        .eq('material_return_id', returnId)
        .maybeSingle();

      if (data) {
        setCreditNoteId(data.id);
        setCreditNoteNumber(data.credit_note_number);
      } else {
        setCreditNoteId('');
        setCreditNoteNumber('');
      }
    } catch {
      // Non-critical
    }
  }

  async function loadReturnItems(returnId: string, invoiceId: string | null) {
    try {
      // 1. Fetch material return items
      const { data: retItems, error: retErr } = await supabase
        .from('material_return_items')
        .select(`
          id,
          product_id,
          batch_id,
          quantity_returned,
          original_quantity,
          unit_price,
          products:product_id(product_name, product_code),
          batches:batch_id(batch_number)
        `)
        .eq('material_return_id', returnId);

      if (retErr) throw retErr;

      // 2. Fetch invoice items if invoice is available to double-check unit prices and invoice quantities
      let invoiceMap = new Map<string, { unit_price: number; quantity: number }>();
      if (invoiceId) {
        const { data: invItems } = await supabase
          .from('sales_invoice_items')
          .select('product_id, batch_id, quantity, unit_price')
          .eq('invoice_id', invoiceId);

        (invItems || []).forEach((inv: any) => {
          invoiceMap.set(`${inv.product_id}_${inv.batch_id || ''}`, {
            unit_price: Number(inv.unit_price),
            quantity: Number(inv.quantity),
          });
        });
      }

      // 3. Build items with canonical pricing math
      const constructedItems: NotaReturItem[] = (retItems || []).map((item: any) => {
        const key = `${item.product_id}_${item.batch_id || ''}`;
        const invoiceEntry = invoiceMap.get(key);

        // Effective unit price from material return item or original invoice
        const unitPrice = Number(item.unit_price || invoiceEntry?.unit_price || 0);
        const qty = Number(item.quantity_returned || 0);

        // Accurate rounding (2 decimals for currency)
        const dpp = Math.round(qty * unitPrice * 100) / 100;
        const ppn = Math.round(dpp * 0.11 * 100) / 100;
        const total = Math.round((dpp + ppn) * 100) / 100;

        return {
          product_id: item.product_id,
          batch_id: item.batch_id,
          material_return_item_id: item.id,
          product_name: item.products?.product_name || 'BKP',
          product_code: item.products?.product_code,
          batch_number: item.batches?.batch_number,
          quantity: qty,
          unit_price: unitPrice,
          dpp_amount: dpp,
          tax_rate: 0.11,
          ppn_amount: ppn,
          total_amount: total,
        };
      });

      setItems(constructedItems);
    } catch (err: any) {
      console.error('Failed to load items from material return:', err);
      showToast({ type: 'error', title: 'Error', message: err.message || 'Error loading return items' });
    }
  }

  function resetForm() {
    setSelectedReturnId('');
    setReturnDate(new Date().toISOString().split('T')[0]);
    setCustomerId('');
    setCustomerName('');
    setCustomerNpwp('');
    setCustomerAddress('');
    setSalesInvoiceId('');
    setSalesInvoiceNumber('');
    setOriginalFakturPajakNumber('');
    setCreditNoteId('');
    setCreditNoteNumber('');
    setItems([]);
    setStatus('draft');
    setCoretaxReferenceNumber('');
    setCoretaxSubmissionDate('');
    setCoretaxStatus('draft');
    setCoretaxResponseNotes('');
    setNotes('');
    setError('');
  }

  // Totals calculations
  const totals = useMemo(() => {
    const totalQty = items.reduce((sum, it) => sum + (Number(it.quantity) || 0), 0);
    const totalDpp = items.reduce((sum, it) => sum + (Number(it.dpp_amount) || 0), 0);
    const totalPpn = items.reduce((sum, it) => sum + (Number(it.ppn_amount) || 0), 0);
    const totalAmount = Math.round((totalDpp + totalPpn) * 100) / 100;
    return { totalQty, totalDpp, totalPpn, totalAmount };
  }, [items]);

  const handleItemQtyChange = (index: number, newQty: number) => {
    setItems(prev => {
      const next = [...prev];
      const item = next[index];
      const safeQty = Math.max(0, newQty);
      const dpp = Math.round(safeQty * item.unit_price * 100) / 100;
      const ppn = Math.round(dpp * item.tax_rate * 100) / 100;
      const total = Math.round((dpp + ppn) * 100) / 100;
      next[index] = {
        ...item,
        quantity: safeQty,
        dpp_amount: dpp,
        ppn_amount: ppn,
        total_amount: total,
      };
      return next;
    });
  };

  const handleItemPriceChange = (index: number, newPrice: number) => {
    setItems(prev => {
      const next = [...prev];
      const item = next[index];
      const safePrice = Math.max(0, newPrice);
      const dpp = Math.round(item.quantity * safePrice * 100) / 100;
      const ppn = Math.round(dpp * item.tax_rate * 100) / 100;
      const total = Math.round((dpp + ppn) * 100) / 100;
      next[index] = {
        ...item,
        unit_price: safePrice,
        dpp_amount: dpp,
        ppn_amount: ppn,
        total_amount: total,
      };
      return next;
    });
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    if (!customerId) {
      setError('Please select a customer or material return.');
      return;
    }

    if (items.length === 0 || totals.totalQty <= 0) {
      setError('At least one returned item with quantity > 0 is required.');
      return;
    }

    // Validation against duplicate active Nota Retur for the same material return
    if (!existingNotaRetur && selectedReturnId) {
      const { data: existingDup } = await supabase
        .from('nota_retur')
        .select('id, nota_retur_number, status')
        .eq('material_return_id', selectedReturnId)
        .not('status', 'in', '("cancelled","rejected")')
        .maybeSingle();

      if (existingDup) {
        setError(`An active Nota Retur (${existingDup.nota_retur_number}) already exists for this Material Return.`);
        return;
      }
    }

    setLoading(true);

    try {
      if (existingNotaRetur) {
        // Update existing
        const { error: updateErr } = await supabase
          .from('nota_retur')
          .update({
            return_date: returnDate,
            original_faktur_pajak_number: originalFakturPajakNumber.trim() || null,
            status,
            coretax_reference_number: coretaxReferenceNumber.trim() || null,
            coretax_submission_date: coretaxSubmissionDate || null,
            coretax_status: coretaxStatus || 'draft',
            coretax_response_notes: coretaxResponseNotes.trim() || null,
            notes: notes.trim() || null,
            dpp_amount: totals.totalDpp,
            ppn_amount: totals.totalPpn,
            total_amount: totals.totalAmount,
            updated_at: new Date().toISOString(),
          })
          .eq('id', existingNotaRetur.id);

        if (updateErr) throw updateErr;

        showToast({ type: 'success', title: 'Nota Retur', message: 'Nota Retur updated successfully' });
        onSuccess();
        onClose();
      } else {
        // Create new
        const insertPayload = {
          return_date: returnDate,
          customer_id: customerId,
          customer_name: customerName,
          customer_npwp: customerNpwp || null,
          customer_address: customerAddress || null,
          sales_invoice_id: salesInvoiceId || null,
          sales_invoice_number: salesInvoiceNumber || null,
          original_faktur_pajak_number: originalFakturPajakNumber.trim() || null,
          material_return_id: selectedReturnId || null,
          credit_note_id: creditNoteId || null,
          dpp_amount: totals.totalDpp,
          ppn_amount: totals.totalPpn,
          total_amount: totals.totalAmount,
          status,
          coretax_reference_number: coretaxReferenceNumber.trim() || null,
          coretax_submission_date: coretaxSubmissionDate || null,
          coretax_status: coretaxStatus || 'draft',
          coretax_response_notes: coretaxResponseNotes.trim() || null,
          notes: notes.trim() || null,
        };

        const { data: createdNR, error: insertErr } = await supabase
          .from('nota_retur')
          .insert(insertPayload)
          .select('id, nota_retur_number')
          .single();

        if (insertErr) throw insertErr;

        // Insert items
        const itemRows = items.map(it => ({
          nota_retur_id: createdNR.id,
          product_id: it.product_id,
          batch_id: it.batch_id || null,
          material_return_item_id: it.material_return_item_id || null,
          quantity: it.quantity,
          unit_price: it.unit_price,
          dpp_amount: it.dpp_amount,
          tax_rate: it.tax_rate ?? 0.11,
          ppn_amount: it.ppn_amount,
          total_amount: it.total_amount,
          notes: it.notes || null,
        }));

        const { error: itemsErr } = await supabase
          .from('nota_retur_items')
          .insert(itemRows);

        if (itemsErr) throw itemsErr;

        // Sync link to material_returns if applicable
        if (selectedReturnId) {
          await supabase
            .from('material_returns')
            .update({ nota_retur_id: createdNR.id })
            .eq('id', selectedReturnId);
        }

        // Sync link to credit_notes if applicable
        if (creditNoteId) {
          await supabase
            .from('credit_notes')
            .update({ nota_retur_id: createdNR.id })
            .eq('id', creditNoteId);
        }

        showToast({ type: 'success', title: 'Nota Retur', message: `Nota Retur ${createdNR.nota_retur_number} created successfully` });
        onSuccess();
        onClose();
      }
    } catch (err: any) {
      console.error('Save Nota Retur error:', err);
      setError(err.message || 'Failed to save Nota Retur');
      showToast({ type: 'error', title: 'Error', message: err.message || 'Failed to save Nota Retur' });
    } finally {
      setLoading(false);
    }
  };

  const formatCurrency = (val: number) => `Rp ${val.toLocaleString('id-ID', { minimumFractionDigits: 2 })}`;

  return (
    <FinanceModal
      isOpen={isOpen}
      onClose={onClose}
      title={existingNotaRetur ? `Edit Nota Retur (${existingNotaRetur.nota_retur_number})` : 'New Nota Retur (Coretax Ready)'}
      subtitle="Indonesian PPN Output Reduction Document (PMK 65 / PER-03 / Coretax Compliance)"
      size="xl"
      footer={
        <div className="flex items-center justify-between w-full">
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <ShieldCheck className="w-4 h-4 text-emerald-600" />
            <span>Traceable tax instrument. AR reversal handled by Credit Note.</span>
          </div>
          <div className="flex items-center gap-2">
            <FinanceButton variant="secondary" onClick={onClose} disabled={loading}>
              Cancel
            </FinanceButton>
            <FinanceButton variant="primary" onClick={handleSubmit} disabled={loading}>
              {loading ? 'Saving...' : existingNotaRetur ? 'Update Nota Retur' : 'Generate Nota Retur'}
            </FinanceButton>
          </div>
        </div>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-rose-700 text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Header selection section */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 bg-slate-50 p-3 rounded-lg border border-slate-200">
          {!existingNotaRetur && (
            <div className="md:col-span-1">
              <label className={F_LABEL}>Source Material Return *</label>
              <FinanceSelect
                value={selectedReturnId}
                onChange={e => setSelectedReturnId(e.target.value)}
                disabled={Boolean(existingNotaRetur) || Boolean(originatingReturnId)}
              >
                <option value="">— Select Material Return —</option>
                {approvedReturns.map(r => (
                  <option key={r.id} value={r.id}>
                    {r.return_number} ({r.customers?.company_name || 'Customer'})
                  </option>
                ))}
              </FinanceSelect>
              <span className="text-[10px] text-slate-500">Auto-fills items and unit prices from inspected return.</span>
            </div>
          )}

          <div className={existingNotaRetur ? 'md:col-span-1' : 'md:col-span-1'}>
            <label className={F_LABEL}>Return Date (Actual Goods Return) *</label>
            <FinanceInput
              type="date"
              value={returnDate}
              onChange={e => setReturnDate(e.target.value)}
              required
            />
            <span className="text-[10px] text-slate-500">Must reflect actual date goods were physically returned.</span>
          </div>

          <div className={existingNotaRetur ? 'md:col-span-2' : 'md:col-span-1'}>
            <label className={F_LABEL}>Customer</label>
            <FinanceInput
              type="text"
              value={customerName || '—'}
              disabled
              className="bg-slate-100 font-medium text-slate-700"
            />
            <span className="text-[10px] text-slate-500 font-mono">NPWP: {customerNpwp || 'Unspecified'}</span>
          </div>
        </div>

        {/* Linkages to Commercial & Tax Invoices */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 p-3 bg-amber-50/50 rounded-lg border border-amber-200">
          <div>
            <label className={F_LABEL}>Original Sales Invoice</label>
            <FinanceInput
              type="text"
              value={salesInvoiceNumber || 'None'}
              disabled
              className="bg-amber-100/50 font-mono text-slate-700"
            />
          </div>

          <div>
            <label className={F_LABEL}>Original Faktur Pajak (NSFP)</label>
            <FinanceInput
              type="text"
              value={originalFakturPajakNumber}
              onChange={e => setOriginalFakturPajakNumber(e.target.value)}
              placeholder="e.g. 010.000-26.00000000"
              className="font-mono"
            />
            <span className="text-[10px] text-slate-500">Tax invoice reference being reduced.</span>
          </div>

          <div>
            <label className={F_LABEL}>Linked Credit Note #</label>
            <FinanceInput
              type="text"
              value={creditNoteNumber || 'Pending / None'}
              disabled
              className="bg-amber-100/50 font-mono text-slate-700"
            />
            <span className="text-[10px] text-slate-500">Prevents duplicate accounting entries.</span>
          </div>
        </div>

        {/* Line Items Table */}
        <div className="border border-slate-200 rounded-lg overflow-hidden">
          <div className="bg-slate-100 px-3 py-2 border-b border-slate-200 flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-800 uppercase tracking-wide">
              Barang Kena Pajak (BKP) Dikembalikan
            </span>
            <span className="text-xs text-slate-500">
              Tax Rate: 11% PPN
            </span>
          </div>
          <table className="w-full text-xs text-left">
            <thead className="bg-slate-50 text-slate-600 uppercase text-[10px] border-b border-slate-200">
              <tr>
                <th className="py-2 px-3">Item / Product</th>
                <th className="py-2 px-2">Batch</th>
                <th className="py-2 px-2 text-right w-24">Qty (kg)</th>
                <th className="py-2 px-2 text-right w-28">Harga Satuan</th>
                <th className="py-2 px-2 text-right w-32">DPP Retur</th>
                <th className="py-2 px-2 text-right w-28">PPN (11%)</th>
                <th className="py-2 px-3 text-right w-32">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {items.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-6 text-center text-slate-400">
                    No items selected. Select a Material Return to auto-populate items.
                  </td>
                </tr>
              ) : (
                items.map((it, idx) => (
                  <tr key={idx} className="hover:bg-slate-50/70">
                    <td className="py-2 px-3">
                      <div className="font-medium text-slate-900">{it.product_name}</div>
                      {it.product_code && <div className="text-[10px] text-slate-500">{it.product_code}</div>}
                    </td>
                    <td className="py-2 px-2 font-mono text-[11px] text-slate-600">
                      {it.batch_number || '—'}
                    </td>
                    <td className="py-2 px-2 text-right">
                      <FinanceInput
                        type="number"
                        step="any"
                        value={it.quantity}
                        onChange={e => handleItemQtyChange(idx, parseFloat(e.target.value) || 0)}
                        className="text-right py-1 px-1.5 text-xs font-semibold"
                      />
                    </td>
                    <td className="py-2 px-2 text-right">
                      <FinanceInput
                        type="number"
                        step="any"
                        value={it.unit_price}
                        onChange={e => handleItemPriceChange(idx, parseFloat(e.target.value) || 0)}
                        className="text-right py-1 px-1.5 text-xs font-mono"
                      />
                    </td>
                    <td className="py-2 px-2 text-right font-mono font-medium text-slate-800">
                      {formatCurrency(it.dpp_amount)}
                    </td>
                    <td className="py-2 px-2 text-right font-mono font-medium text-emerald-700">
                      {formatCurrency(it.ppn_amount)}
                    </td>
                    <td className="py-2 px-3 text-right font-mono font-bold text-slate-900">
                      {formatCurrency(it.total_amount)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
            {items.length > 0 && (
              <tfoot className="bg-slate-100/80 border-t border-slate-200 font-semibold text-slate-900">
                <tr>
                  <td colSpan={2} className="py-2 px-3 text-right">Total:</td>
                  <td className="py-2 px-2 text-right font-bold">{totals.totalQty.toLocaleString('id-ID')} kg</td>
                  <td className="py-2 px-2"></td>
                  <td className="py-2 px-2 text-right font-mono font-bold">{formatCurrency(totals.totalDpp)}</td>
                  <td className="py-2 px-2 text-right font-mono font-bold text-emerald-700">{formatCurrency(totals.totalPpn)}</td>
                  <td className="py-2 px-3 text-right font-mono font-bold text-blue-700">{formatCurrency(totals.totalAmount)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        {/* Coretax Submission & Status Section */}
        <div className="p-3 bg-blue-50/50 border border-blue-200 rounded-lg space-y-3">
          <div className="flex items-center gap-2 text-blue-900 font-semibold text-xs uppercase tracking-wide">
            <Info className="w-4 h-4 text-blue-600" /> Coretax DJP Reference & Workflow Status
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 text-xs">
            <div>
              <label className={F_LABEL}>Nota Retur Status</label>
              <FinanceSelect
                value={status}
                onChange={e => setStatus(e.target.value as NotaReturStatus)}
              >
                <option value="draft">Draft</option>
                <option value="ready_for_review">Ready for Review</option>
                <option value="submitted">Submitted / Uploaded</option>
                <option value="approved">Approved</option>
                <option value="rejected">Rejected</option>
                <option value="cancelled">Cancelled</option>
              </FinanceSelect>
            </div>

            <div>
              <label className={F_LABEL}>Coretax Status</label>
              <FinanceSelect
                value={coretaxStatus}
                onChange={e => setCoretaxStatus(e.target.value as CoretaxStatus)}
              >
                <option value="draft">Draft / Not Submitted</option>
                <option value="ready_for_review">Ready for Upload</option>
                <option value="submitted">Submitted to DJP</option>
                <option value="approved">Approved by DJP</option>
                <option value="rejected">Rejected by DJP</option>
              </FinanceSelect>
            </div>

            <div>
              <label className={F_LABEL}>Coretax Reference # (BPE / DJP ID)</label>
              <FinanceInput
                type="text"
                value={coretaxReferenceNumber}
                onChange={e => setCoretaxReferenceNumber(e.target.value)}
                placeholder="e.g. BPE-20261008-00123"
                className="font-mono"
              />
            </div>

            <div>
              <label className={F_LABEL}>Coretax Submission Date</label>
              <FinanceInput
                type="date"
                value={coretaxSubmissionDate}
                onChange={e => setCoretaxSubmissionDate(e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
            <div>
              <label className={F_LABEL}>DJP / Coretax Notes</label>
              <textarea
                value={coretaxResponseNotes}
                onChange={e => setCoretaxResponseNotes(e.target.value)}
                placeholder="Enter DJP response or rejection reason if any..."
                rows={2}
                className={F_TEXTAREA}
              />
            </div>
            <div>
              <label className={F_LABEL}>Internal ERP Notes</label>
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="Internal audit notes..."
                rows={2}
                className={F_TEXTAREA}
              />
            </div>
          </div>
        </div>
      </form>
    </FinanceModal>
  );
}
