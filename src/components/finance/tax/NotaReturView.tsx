import { useRef, useEffect } from 'react';
import { X, Printer, Download, CheckCircle, Clock, AlertCircle } from 'lucide-react';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';
import { type CompanySnapshot } from '../../../types/company';
import { useResolvedCompanyLogo } from '../../../utils/companyLogoUrl';
import { DocumentHeader } from '../../DocumentHeader';
import { DocumentPrintStyles } from '../../DocumentPrintStyles';
import { type NotaRetur, type NotaReturItem } from '../../../types/notaRetur';

interface NotaReturViewProps {
  notaRetur: NotaRetur;
  items: NotaReturItem[];
  onClose: () => void;
  companyProfile?: CompanySnapshot | null;
}

export function NotaReturView({ notaRetur, items, onClose, companyProfile }: NotaReturViewProps) {
  const printRef = useRef<HTMLDivElement>(null);
  useResolvedCompanyLogo(companyProfile?.company_logo_url);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  const co: CompanySnapshot = companyProfile || {
    company_name: 'PT. SATYA ANUGRAH PHARMA JAYA',
    company_legal_name: 'PT. Satya Anugrah Pharma Jaya',
    company_address: 'Jl. Boulevard Raya Barat Ruko Inkopal Blok F No. 25, Kel. Kelapa Gading Barat, Kec. Kelapa Gading, Jakarta Utara 14240',
    company_phone: '021-45851234',
    company_email: 'finance@sapharmajaya.co.id',
    company_website: null,
    company_tax_id: '01.234.567.8-012.000',
    company_logo_url: '/logo.png',
    company_stamp_url: null,
    pbf_license: 'SIPA-12345/2024',
    cdob_certificate: 'CDOB-12345/2024',
  };

  const formatCurrency = (amount: number | undefined | null) => {
    if (amount === undefined || amount === null) return 'Rp 0,00';
    return `Rp ${amount.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const formatDate = (dateString: string | null | undefined) => {
    if (!dateString) return '—';
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return dateString;
    return date.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
  };

  const handlePrint = async () => {
    if (!printRef.current) return;
    window.print();
  };

  const handleDownloadPDF = async () => {
    if (!printRef.current) return;
    try {
      const canvas = await html2canvas(printRef.current, {
        scale: 2,
        useCORS: true,
        logging: false,
      });
      const imgData = canvas.toDataURL('image/png');
      const pdf = new jsPDF('p', 'mm', 'a4');
      const imgWidth = 210;
      const imgHeight = (canvas.height * imgWidth) / canvas.width;
      pdf.addImage(imgData, 'PNG', 0, 0, imgWidth, imgHeight);
      pdf.save(`Nota-Retur-${notaRetur.nota_retur_number || 'draft'}.pdf`);
    } catch (err) {
      console.error('Error generating PDF:', err);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-xl shadow-2xl max-w-4xl w-full max-h-[92vh] flex flex-col overflow-hidden">
        {/* Top Control Bar */}
        <div className="px-6 py-3.5 bg-slate-900 text-white flex items-center justify-between print:hidden">
          <div className="flex items-center gap-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-300">Indonesian Tax Document</span>
            <span className="text-xs px-2 py-0.5 rounded font-mono font-bold bg-amber-400 text-slate-950">
              {notaRetur.nota_retur_number || 'DRAFT'}
            </span>
            <span className={`text-[11px] px-2 py-0.5 rounded font-medium ${
              notaRetur.status === 'approved' ? 'bg-emerald-600 text-white' :
              notaRetur.status === 'submitted' ? 'bg-blue-600 text-white' :
              notaRetur.status === 'ready_for_review' ? 'bg-amber-600 text-white' :
              'bg-slate-700 text-slate-200'
            }`}>
              {notaRetur.status.toUpperCase().replace('_', ' ')}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handlePrint}
              className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 rounded-lg flex items-center gap-1.5 text-slate-100 transition"
              title="Print official Nota Retur"
            >
              <Printer className="w-3.5 h-3.5" /> Cetak
            </button>
            <button
              onClick={handleDownloadPDF}
              className="px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-500 rounded-lg flex items-center gap-1.5 text-white transition"
              title="Download PDF"
            >
              <Download className="w-3.5 h-3.5" /> PDF
            </button>
            <button
              onClick={onClose}
              className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Document Content */}
        <div className="flex-1 overflow-y-auto p-6 bg-slate-100/50">
          <div
            id="notaretur-print-content"
            ref={printRef}
            className="bg-white mx-auto p-8 shadow-sm border border-gray-300 print:border-none print:shadow-none print:p-0 max-w-[210mm] text-slate-900"
            style={{ fontFamily: "'Inter', sans-serif" }}
          >
            {/* Header */}
            <DocumentHeader
              title="NOTA RETUR"
              co={co}
            />

            <div className="text-center my-3 border-b-2 border-slate-900 pb-2">
              <h2 className="text-base font-bold uppercase tracking-wider">
                NOTA RETUR PENGEMBALIAN BARANG KENA PAJAK
              </h2>
              <p className="text-[11px] text-slate-600">
                (Berdasarkan PMK No. 65/PMK.03/2010 jo. Ketentuan Faktur Pajak Coretax DJP)
              </p>
            </div>

            {/* Buyer & Seller Information */}
            <div className="grid grid-cols-2 gap-4 text-xs my-4 border border-slate-300 p-3 bg-slate-50/50 rounded">
              <div className="space-y-1 pr-3 border-r border-slate-300">
                <p className="font-bold text-slate-800 uppercase tracking-wide text-[11px]">PEMBELI (Penerbit Nota Retur)</p>
                <div>
                  <span className="text-slate-500">Nama: </span>
                  <span className="font-semibold">{notaRetur.customer_name || notaRetur.customers?.company_name || '—'}</span>
                </div>
                <div>
                  <span className="text-slate-500">NPWP: </span>
                  <span className="font-mono font-semibold">{notaRetur.customer_npwp || notaRetur.customers?.npwp || '00.000.000.0-000.000'}</span>
                </div>
                <div>
                  <span className="text-slate-500">Alamat: </span>
                  <span>{notaRetur.customer_address || notaRetur.customers?.address || '—'}</span>
                </div>
              </div>

              <div className="space-y-1 pl-3">
                <p className="font-bold text-slate-800 uppercase tracking-wide text-[11px]">PENJUAL (Penerima Nota Retur)</p>
                <div>
                  <span className="text-slate-500">Nama: </span>
                  <span className="font-semibold">{co.company_name}</span>
                </div>
                <div>
                  <span className="text-slate-500">NPWP: </span>
                  <span className="font-mono font-semibold">{co.company_tax_id || '01.234.567.8-012.000'}</span>
                </div>
                <div>
                  <span className="text-slate-500">Alamat: </span>
                  <span>{co.company_address || '—'}</span>
                </div>
              </div>
            </div>

            {/* Tax and Commercial Document Linkages */}
            <div className="bg-amber-50/60 border border-amber-300 rounded p-3 my-3 text-xs">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div>
                  <span className="text-amber-800 font-medium block text-[10px] uppercase">Rujukan Faktur Pajak</span>
                  <span className="font-mono font-bold text-slate-900 text-xs">
                    {notaRetur.original_faktur_pajak_number || 'Belum Terbit / Non-NSFP'}
                  </span>
                </div>
                <div>
                  <span className="text-amber-800 font-medium block text-[10px] uppercase">Invoice Asli</span>
                  <span className="font-mono font-semibold text-slate-900 text-xs">
                    {notaRetur.sales_invoice_number || notaRetur.sales_invoices?.invoice_number || '—'}
                  </span>
                </div>
                <div>
                  <span className="text-amber-800 font-medium block text-[10px] uppercase">Material Return #</span>
                  <span className="font-mono font-semibold text-slate-900 text-xs">
                    {notaRetur.material_return_number || notaRetur.material_returns?.return_number || '—'}
                  </span>
                </div>
                <div>
                  <span className="text-amber-800 font-medium block text-[10px] uppercase">Credit Note #</span>
                  <span className="font-mono font-semibold text-slate-900 text-xs">
                    {notaRetur.credit_note_number || notaRetur.credit_notes?.credit_note_number || '—'}
                  </span>
                </div>
              </div>
            </div>

            {/* Table of Returned Items */}
            <div className="my-4 border border-slate-300 rounded overflow-hidden">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-100 border-b border-slate-300 text-slate-700 uppercase text-[10px]">
                  <tr>
                    <th className="py-2 px-2 text-center w-8">No</th>
                    <th className="py-2 px-2">Nama Barang Kena Pajak (BKP)</th>
                    <th className="py-2 px-2">Batch #</th>
                    <th className="py-2 px-2 text-right">Qty Retur</th>
                    <th className="py-2 px-2 text-right">Harga Satuan</th>
                    <th className="py-2 px-2 text-right">DPP Dikembalikan</th>
                    <th className="py-2 px-2 text-center w-12">Tarif</th>
                    <th className="py-2 px-2 text-right">PPN Dikembalikan</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {items.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-4 text-center text-slate-400">Tidak ada rincian barang</td>
                    </tr>
                  ) : (
                    items.map((item, idx) => (
                      <tr key={idx} className="hover:bg-slate-50/50">
                        <td className="py-2 px-2 text-center font-mono text-slate-500">{idx + 1}</td>
                        <td className="py-2 px-2 font-medium text-slate-900">{item.product_name || item.product_code || 'BKP'}</td>
                        <td className="py-2 px-2 font-mono text-[11px] text-slate-600">{item.batch_number || '—'}</td>
                        <td className="py-2 px-2 text-right font-semibold">{item.quantity.toLocaleString('id-ID')} kg</td>
                        <td className="py-2 px-2 text-right font-mono">{formatCurrency(item.unit_price)}</td>
                        <td className="py-2 px-2 text-right font-mono font-medium">{formatCurrency(item.dpp_amount)}</td>
                        <td className="py-2 px-2 text-center font-mono">11%</td>
                        <td className="py-2 px-2 text-right font-mono font-medium text-emerald-700">{formatCurrency(item.ppn_amount)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
                <tfoot className="bg-slate-50 border-t-2 border-slate-300 font-semibold text-slate-900">
                  <tr>
                    <td colSpan={5} className="py-2 px-3 text-right">Total DPP Dikembalikan:</td>
                    <td className="py-2 px-2 text-right font-mono font-bold">{formatCurrency(notaRetur.dpp_amount)}</td>
                    <td className="py-2 px-1 text-center font-mono text-xs">Total PPN:</td>
                    <td className="py-2 px-2 text-right font-mono font-bold text-emerald-700">{formatCurrency(notaRetur.ppn_amount)}</td>
                  </tr>
                  <tr className="bg-slate-100 text-slate-950 font-bold border-t border-slate-200">
                    <td colSpan={5} className="py-2 px-3 text-right">TOTAL NILAI RETUR:</td>
                    <td colSpan={3} className="py-2 px-2 text-right font-mono text-sm text-blue-700">
                      {formatCurrency(notaRetur.total_amount)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* Coretax Submission Reference Section */}
            <div className="border border-blue-200 bg-blue-50/40 rounded p-3 my-3 text-xs">
              <div className="flex items-center justify-between mb-2">
                <span className="font-bold text-blue-900 uppercase text-[11px] tracking-wide flex items-center gap-1.5">
                  <CheckCircle className="w-3.5 h-3.5 text-blue-600" /> Coretax DJP Reference & Verification
                </span>
                <span className={`text-[10px] px-2 py-0.5 rounded font-semibold uppercase ${
                  notaRetur.coretax_status === 'approved' ? 'bg-emerald-100 text-emerald-800 border border-emerald-300' :
                  notaRetur.coretax_status === 'submitted' ? 'bg-blue-100 text-blue-800 border border-blue-300' :
                  notaRetur.coretax_status === 'rejected' ? 'bg-rose-100 text-rose-800 border border-rose-300' :
                  'bg-slate-100 text-slate-700 border border-slate-300'
                }`}>
                  Coretax: {notaRetur.coretax_status || 'Draft / Unsubmitted'}
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px]">
                <div>
                  <span className="text-slate-500">Nomor Tanda Terima Coretax: </span>
                  <span className="font-mono font-semibold text-slate-900 block mt-0.5">
                    {notaRetur.coretax_reference_number || 'Belum Diunggah ke DJP'}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500">Tanggal Pengajuan Coretax: </span>
                  <span className="font-semibold text-slate-900 block mt-0.5">
                    {formatDate(notaRetur.coretax_submission_date)}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500">Masa Pajak Pelaporan: </span>
                  <span className="font-semibold text-slate-900 block mt-0.5">
                    {formatDate(notaRetur.return_date).split(' ').slice(1).join(' ')}
                  </span>
                </div>
              </div>
              {notaRetur.coretax_response_notes && (
                <div className="mt-2 pt-2 border-t border-blue-200 text-[11px] text-slate-600">
                  <span className="font-semibold">Catatan DJP / Coretax: </span>
                  <span>{notaRetur.coretax_response_notes}</span>
                </div>
              )}
            </div>

            {/* Accounting Safeguard Notice */}
            <div className="my-2 p-2 rounded bg-slate-50 border border-slate-200 text-[10px] text-slate-500 flex items-start gap-1.5">
              <AlertCircle className="w-3.5 h-3.5 text-slate-400 flex-shrink-0 mt-0.5" />
              <span>
                <strong>Catatan Integrasi Pajak & Akuntansi:</strong> Nota Retur ini merupakan bukti potong/pengurang Pajak Keluaran (PPN) resmi untuk pelaporan SPT Masa PPN / Coretax. Penyesuaian komersial & jurnal piutang/retur penjualan dilakukan melalui Credit Note #{notaRetur.credit_note_number || '—'} untuk mencegah double-posting.
              </span>
            </div>

            {/* Signatures */}
            <div className="grid grid-cols-2 gap-8 text-xs mt-6 pt-4 border-t border-slate-300 text-center">
              <div>
                <p className="font-semibold text-slate-800">Pembeli / Penerbit Nota Retur</p>
                <p className="text-[10px] text-slate-500 mt-0.5">{notaRetur.customer_name || notaRetur.customers?.company_name}</p>
                <div className="h-16 flex items-end justify-center">
                  <div className="border-b border-slate-400 w-44"></div>
                </div>
                <p className="text-[10px] text-slate-500 mt-1">Tanda Tangan & Cap Perusahaan</p>
              </div>

              <div>
                <p className="font-semibold text-slate-800">Penjual / Penerima Nota Retur</p>
                <p className="text-[10px] text-slate-500 mt-0.5">{co.company_name}</p>
                <div className="h-16 flex items-end justify-center">
                  <div className="border-b border-slate-400 w-44"></div>
                </div>
                <p className="text-[10px] text-slate-500 mt-1">Nama Jelas & Cap Perusahaan</p>
              </div>
            </div>
          </div>
        </div>
      </div>
      <DocumentPrintStyles contentId="notaretur-print-content" />
    </div>
  );
}
