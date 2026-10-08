import { useState, useEffect, useMemo } from 'react';
import {
  FileText, Plus, RefreshCw, Eye, Edit, CheckCircle, XCircle,
  Clock, AlertCircle, ArrowUpRight, ShieldCheck, Download
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { supabase } from '../../../lib/supabase';
import { StatCard, StatCardGrid, SectionCard, EmptyState } from './TaxUI';
import { FinanceActionButton, FinanceBadge, FinanceButton, FinanceSelect, type FinanceStatus } from '../FinanceUI';
import { FinanceTable } from '../FinanceTable';
import { showToast } from '../../ToastNotification';
import { showConfirm } from '../../ConfirmDialog';
import { type NotaRetur, type NotaReturItem, type NotaReturStatus } from '../../../types/notaRetur';
import { NotaReturModal } from './NotaReturModal';
import { NotaReturView } from './NotaReturView';
import { sanitizeExportRows } from '../../../utils/csvSafe';

export function NotaReturPanel() {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<NotaRetur[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [selectedNotaRetur, setSelectedNotaRetur] = useState<NotaRetur | null>(null);
  const [viewItems, setViewItems] = useState<NotaReturItem[]>([]);
  const [isViewOpen, setIsViewOpen] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingRow, setEditingRow] = useState<NotaRetur | null>(null);
  const [originatingReturnId, setOriginatingReturnId] = useState<string | null>(null);

  useEffect(() => {
    // Check if user came from Material Returns page with an originating return
    const pendingReturnId = sessionStorage.getItem('anzen_originating_return_nr_id');
    if (pendingReturnId) {
      sessionStorage.removeItem('anzen_originating_return_nr_id');
      setOriginatingReturnId(pendingReturnId);
      setIsModalOpen(true);
    }
    void loadData();
  }, []);

  async function loadData() {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('nota_retur')
        .select(`
          id,
          nota_retur_number,
          return_date,
          customer_id,
          customer_name,
          customer_npwp,
          customer_address,
          seller_name,
          seller_npwp,
          seller_address,
          sales_invoice_id,
          sales_invoice_number,
          original_faktur_pajak_number,
          original_faktur_pajak_date,
          material_return_id,
          material_return_number,
          credit_note_id,
          credit_note_number,
          dpp_amount,
          ppn_amount,
          total_amount,
          status,
          coretax_reference_number,
          coretax_submission_date,
          coretax_status,
          coretax_response_notes,
          tax_period_id,
          notes,
          created_by,
          approved_by,
          approved_at,
          created_at,
          updated_at,
          customers:customer_id(company_name, npwp, address),
          sales_invoices:sales_invoice_id(invoice_number, invoice_date, faktur_pajak_number),
          material_returns:material_return_id(return_number, return_date, status),
          credit_notes:credit_note_id(credit_note_number, credit_note_date, status)
        `)
        .order('return_date', { ascending: false });

      if (error) throw error;

      const typedRows: NotaRetur[] = (data || []).map((r: any) => ({
        ...r,
        customers: Array.isArray(r.customers) ? r.customers[0] : r.customers,
        sales_invoices: Array.isArray(r.sales_invoices) ? r.sales_invoices[0] : r.sales_invoices,
        material_returns: Array.isArray(r.material_returns) ? r.material_returns[0] : r.material_returns,
        credit_notes: Array.isArray(r.credit_notes) ? r.credit_notes[0] : r.credit_notes,
      }));

      setRows(typedRows);
    } catch (err: any) {
      console.error('Failed to load Nota Retur data:', err);
      showToast({ type: 'error', title: 'Error', message: err.message || 'Failed to load Nota Retur' });
    } finally {
      setLoading(false);
    }
  }

  async function openView(nr: NotaRetur) {
    setSelectedNotaRetur(nr);
    try {
      const { data: itemsData, error } = await supabase
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
        .eq('nota_retur_id', nr.id);

      if (error) throw error;

      const mappedItems: NotaReturItem[] = (itemsData || []).map((it: any) => ({
        id: it.id,
        nota_retur_id: it.nota_retur_id,
        product_id: it.product_id,
        batch_id: it.batch_id,
        material_return_item_id: it.material_return_item_id,
        product_name: it.products?.product_name || 'BKP',
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

      setViewItems(mappedItems);
      setIsViewOpen(true);
    } catch (err: any) {
      console.error('Failed to load Nota Retur items for view:', err);
      showToast({ type: 'error', title: 'Error', message: 'Could not load line items' });
    }
  }

  async function handleApprove(nr: NotaRetur) {
    const confirmed = await showConfirm({
      title: 'Approve Nota Retur',
      message: `Approve ${nr.nota_retur_number}? This will officially apply the Output PPN deduction for tax period reporting.`,
      confirmLabel: 'Approve',
      cancelLabel: 'Cancel',
    });

    if (!confirmed) return;

    try {
      const { error } = await supabase
        .from('nota_retur')
        .update({
          status: 'approved',
          approved_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', nr.id);

      if (error) throw error;

      showToast({ type: 'success', title: 'Nota Retur', message: `Nota Retur ${nr.nota_retur_number} approved` });
      void loadData();
    } catch (err: any) {
      showToast({ type: 'error', title: 'Error', message: err.message || 'Approval failed' });
    }
  }

  const filteredRows = useMemo(() => {
    if (statusFilter === 'all') return rows;
    return rows.filter(r => r.status === statusFilter);
  }, [rows, statusFilter]);

  // Statistics
  const stats = useMemo(() => {
    const totalCount = rows.length;
    const approvedRows = rows.filter(r => r.status === 'approved');
    const totalDpp = approvedRows.reduce((sum, r) => sum + Number(r.dpp_amount || 0), 0);
    const totalPpn = approvedRows.reduce((sum, r) => sum + Number(r.ppn_amount || 0), 0);
    const pendingCoretax = rows.filter(r => r.status === 'submitted' || r.coretax_status === 'submitted').length;

    return { totalCount, totalDpp, totalPpn, pendingCoretax };
  }, [rows]);

  function exportToExcel() {
    const dataToExport = filteredRows.map(r => ({
      'Nota Retur Number': r.nota_retur_number,
      'Return Date': r.return_date,
      'Customer': r.customer_name || r.customers?.company_name || '—',
      'Customer NPWP': r.customer_npwp || r.customers?.npwp || '—',
      'Original Invoice': r.sales_invoice_number || r.sales_invoices?.invoice_number || '—',
      'Original Faktur Pajak': r.original_faktur_pajak_number || '—',
      'Material Return #': r.material_return_number || r.material_returns?.return_number || '—',
      'Credit Note #': r.credit_note_number || r.credit_notes?.credit_note_number || '—',
      'Returned DPP': r.dpp_amount,
      'Returned PPN': r.ppn_amount,
      'Total Return Amount': r.total_amount,
      'Status': r.status,
      'Coretax Status': r.coretax_status || 'draft',
      'Coretax Reference': r.coretax_reference_number || '—',
      'Coretax Submission Date': r.coretax_submission_date || '—',
    }));

    const safeData = sanitizeExportRows(dataToExport);
    const ws = XLSX.utils.json_to_sheet(safeData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Nota Retur Register');
    XLSX.writeFile(wb, `Nota_Retur_Register_${new Date().toISOString().split('T')[0]}.xlsx`);
  }

  const formatCurrency = (val: number) => `Rp ${Number(val).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <div className="space-y-4">
      {/* KPI Cards */}
      <StatCardGrid cols={4}>
        <StatCard
          label="Total Nota Retur"
          value={stats.totalCount}
          money={false}
          hint="Tax return documents issued"
          tone="blue"
        />
        <StatCard
          label="Returned DPP (Approved)"
          value={stats.totalDpp}
          money
          hint="Taxable revenue reduction"
          tone="purple"
        />
        <StatCard
          label="Output PPN Reduced"
          value={stats.totalPpn}
          money
          hint="Net VAT reduction"
          tone="green"
        />
        <StatCard
          label="Pending Coretax"
          value={stats.pendingCoretax}
          money={false}
          hint="Under DJP review / upload"
          tone="orange"
        />
      </StatCardGrid>

      {/* Main Panel Content */}
      <SectionCard
        title="Nota Retur Register (Indonesian PPN / Coretax)"
        subtitle="Manage official tax return documents reducing Output PPN pursuant to PMK 65 and DJP Coretax guidelines"
        actions={
          <div className="flex items-center gap-2">
            <FinanceSelect
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value)}
              className="text-xs py-1"
            >
              <option value="all">All Statuses</option>
              <option value="draft">Draft</option>
              <option value="ready_for_review">Ready for Review</option>
              <option value="submitted">Submitted</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
              <option value="cancelled">Cancelled</option>
            </FinanceSelect>

            <FinanceButton
              variant="secondary"
              onClick={exportToExcel}
              className="text-xs py-1 px-2.5 flex items-center gap-1"
              title="Export Register to Excel"
            >
              <Download className="w-3.5 h-3.5" /> Export
            </FinanceButton>

            <FinanceButton
              variant="secondary"
              onClick={() => void loadData()}
              className="text-xs py-1 px-2.5 flex items-center gap-1"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
            </FinanceButton>

            <FinanceButton
              variant="primary"
              onClick={() => {
                setEditingRow(null);
                setOriginatingReturnId(null);
                setIsModalOpen(true);
              }}
              className="text-xs py-1 px-3 flex items-center gap-1"
            >
              <Plus className="w-3.5 h-3.5" /> New Nota Retur
            </FinanceButton>
          </div>
        }
      >
        <div className="overflow-x-auto">
          <FinanceTable<NotaRetur>
            columns={[
              {
                header: 'Nota Retur #',
                cell: (r: NotaRetur) => <span className="font-mono font-semibold text-slate-900">{r.nota_retur_number}</span>,
              },
              {
                header: 'Return Date',
                cell: (r: NotaRetur) => <span className="text-xs text-slate-600">{r.return_date}</span>,
              },
              {
                header: 'Customer',
                cell: (r: NotaRetur) => (
                  <div>
                    <div className="font-medium text-slate-900">{r.customer_name || r.customers?.company_name || '—'}</div>
                    <div className="text-[10px] font-mono text-slate-500">{r.customer_npwp || r.customers?.npwp || 'NPWP: —'}</div>
                  </div>
                ),
              },
              {
                header: 'Tax & Sales Linkage',
                cell: (r: NotaRetur) => (
                  <div className="text-[11px] space-y-0.5">
                    <div>
                      <span className="text-slate-400">FP: </span>
                      <span className="font-mono font-medium text-slate-800">{r.original_faktur_pajak_number || 'No NSFP'}</span>
                    </div>
                    <div>
                      <span className="text-slate-400">Inv: </span>
                      <span className="font-mono text-slate-600">{r.sales_invoice_number || r.sales_invoices?.invoice_number || '—'}</span>
                    </div>
                  </div>
                ),
              },
              {
                header: 'Returned DPP',
                align: 'right',
                cell: (r: NotaRetur) => <span className="font-mono font-medium text-slate-800">{formatCurrency(r.dpp_amount)}</span>,
              },
              {
                header: 'Returned PPN',
                align: 'right',
                cell: (r: NotaRetur) => (
                  <span className="font-mono font-bold text-emerald-700">
                    {formatCurrency(r.ppn_amount)}
                  </span>
                ),
              },
              {
                header: 'Status',
                align: 'center',
                cell: (r: NotaRetur) => {
                  const statusMap: Record<NotaReturStatus, FinanceStatus> = {
                    draft: 'draft',
                    ready_for_review: 'pending',
                    submitted: 'waiting',
                    approved: 'approved',
                    rejected: 'rejected',
                    cancelled: 'cancelled',
                  };
                  return <FinanceBadge status={statusMap[r.status] || 'info'}>{r.status.replace('_', ' ')}</FinanceBadge>;
                },
              },
              {
                header: 'Coretax DJP',
                cell: (r: NotaRetur) => (
                  <div className="text-[10px]">
                    <div className="font-mono font-medium text-blue-800">
                      {r.coretax_reference_number ? r.coretax_reference_number : 'Not Submitted'}
                    </div>
                    <div className="text-slate-500 capitalize">
                      {r.coretax_status ? `Status: ${r.coretax_status}` : '—'}
                    </div>
                  </div>
                ),
              },
              {
                header: 'Actions',
                align: 'center',
                cell: (r: NotaRetur) => (
                  <div className="flex items-center gap-1 justify-end">
                    <FinanceActionButton
                      action="view"
                      onClick={() => void openView(r)}
                      label="View Official Nota Retur Document"
                    />
                    <FinanceActionButton
                      action="edit"
                      onClick={() => {
                        setEditingRow(r);
                        setOriginatingReturnId(null);
                        setIsModalOpen(true);
                      }}
                      label="Update Nota Retur / Coretax Reference"
                    />
                    {r.status !== 'approved' && (
                      <FinanceActionButton
                        action="approve"
                        onClick={() => void handleApprove(r)}
                        label="Approve Nota Retur (Post Tax Deduction)"
                      />
                    )}
                  </div>
                ),
              },
            ]}
            rows={filteredRows}
            rowKey={(r: NotaRetur) => r.id}
            empty={<EmptyState title="No Nota Retur records found" hint="Click 'New Nota Retur' to issue a tax return document." />}
          />
        </div>
      </SectionCard>

      {/* Creation and Edit Modal */}
      {isModalOpen && (
        <NotaReturModal
          isOpen={isModalOpen}
          onClose={() => {
            setIsModalOpen(false);
            setEditingRow(null);
            setOriginatingReturnId(null);
          }}
          onSuccess={() => void loadData()}
          existingNotaRetur={editingRow}
          originatingReturnId={originatingReturnId}
        />
      )}

      {/* Official Document Printable View */}
      {isViewOpen && selectedNotaRetur && (
        <NotaReturView
          notaRetur={selectedNotaRetur}
          items={viewItems}
          onClose={() => {
            setIsViewOpen(false);
            setSelectedNotaRetur(null);
            setViewItems([]);
          }}
        />
      )}
    </div>
  );
}
