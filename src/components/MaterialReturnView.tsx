import { useRef, useEffect } from 'react';
import { X, Printer, Download } from 'lucide-react';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';
import { type CompanySnapshot } from '../types/company';
import { useResolvedCompanyLogo, waitForImages } from '../utils/companyLogoUrl';
import { SnapshotMissingError } from './SnapshotMissingError';

import { DocumentHeader } from './DocumentHeader';
import { DocumentPrintStyles } from './DocumentPrintStyles';
interface ReturnItem {
  id?: string;
  product_id: string;
  batch_id: string | null;
  quantity_returned: number;
  original_quantity: number;
  unit_price: number;
  condition: string;
  disposition: string;
  notes?: string;
  products?: {
    product_name: string;
    product_code: string;
  };
  batches?: {
    batch_number: string;
  };
}

interface MaterialReturnViewProps {
  materialReturn: {
    id: string;
    return_number: string;
    return_date: string;
    return_type: string;
    return_reason: string;
    status: string;
    notes?: string;
    financial_impact?: number;
    customers?: {
      company_name: string;
      address: string;
      city: string;
      phone: string;
    };
    delivery_challans?: {
      challan_number: string;
    };
  };
  items: ReturnItem[];
  onClose: () => void;
  companyProfile?: CompanySnapshot | null;
}

export function MaterialReturnView({ materialReturn, items, onClose, companyProfile }: MaterialReturnViewProps) {
  const printRef = useRef<HTMLDivElement>(null);
  const { ready: logoReady } = useResolvedCompanyLogo(companyProfile?.company_logo_url);
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  // Refuse to render with FALLBACK_COMPANY — misprinting a
  // customer document with placeholder company header would
  // misrepresent it. Backfill migration 20260714210000 restores
  // NULL snapshots in bulk; one-off legacy rows must be repaired manually.
  if (!companyProfile) {
    return (
      <SnapshotMissingError
        documentType={"Material Return"}
        documentNumber={'—'}
        onClose={onClose}
      />
    );
  }
  const co = companyProfile;

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const day = date.getDate();
    const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getMonth()];
    const year = date.getFullYear();
    return `${day} ${month} ${year}`;
  };

  const formatCurrency = (amount: number | undefined | null) => {
    if (amount === undefined || amount === null) return 'Rp 0,00';
    // Always show 2 decimal places in Indonesian format (Rp 136.125.000,00)
    return `Rp ${amount.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const handlePrint = async () => {


    if (printRef.current) await waitForImages(printRef.current);


    window.print();


  };

  const handleDownloadPDF = async () => {
    if (!printRef.current) return;
    await waitForImages(printRef.current);
    try {
      const canvas = await html2canvas(printRef.current, {
        scale: 2,
        useCORS: true,
        allowTaint: true,
        logging: false,
        backgroundColor: '#ffffff',
        windowWidth: printRef.current.scrollWidth,
        windowHeight: printRef.current.scrollHeight,
        onclone: (clonedDoc) => {
          const clonedElement = clonedDoc.getElementById('return-print-content');
          if (clonedElement) {
            clonedElement.style.width = '210mm';
          }
        }
      });

      const imgData = canvas.toDataURL('image/jpeg', 0.85);
      const pdf = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4', compress: true });

      const pdfWidth = pdf.internal.pageSize.getWidth();
      const pdfHeight = pdf.internal.pageSize.getHeight();
      const imgWidth = canvas.width;
      const imgHeight = canvas.height;
      const ratio = pdfWidth / imgWidth;
      const scaledHeight = imgHeight * ratio;

      if (scaledHeight > pdfHeight) {
        let position = 0;
        let remainingHeight = scaledHeight;

        while (remainingHeight > 0) {
          pdf.addImage(imgData, 'JPEG', 0, position, pdfWidth, scaledHeight);
          remainingHeight -= pdfHeight;
          position -= pdfHeight;

          if (remainingHeight > 0) {
            pdf.addPage();
          }
        }
      } else {
        pdf.addImage(imgData, 'JPEG', 0, 0, pdfWidth, scaledHeight);
      }

      pdf.save(`MaterialReturn-${materialReturn.return_number}.pdf`);
    } catch (error) {
      console.error('Error generating PDF:', error);
      alert('Failed to generate PDF. Please try again.');
    }
  };

  const customer = materialReturn.customers;

  return (
    <div className="doc-print-root fixed inset-0 z-50 overflow-y-auto bg-gray-900 bg-opacity-75 print:static print:bg-white print:overflow-visible">
      <div className="doc-print-scroll flex min-h-screen items-start justify-center p-4 pt-10 print:p-0 print:min-h-0 print:block">
        <div className="doc-print-sheet relative w-full max-w-5xl bg-white shadow-xl print:shadow-none print:max-w-full">
          <div className="doc-print-hide sticky top-0 z-10 flex items-center justify-between border-b bg-white px-6 py-4 print:hidden">
            <h2 className="text-xl font-bold text-gray-900">
              Material Return {materialReturn.return_number}
            </h2>
            <div className="flex gap-2">
              <button
                onClick={handlePrint}
                disabled={!logoReady}
                title={logoReady ? undefined : "Loading company logo…"}
                className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-wait"
              >
                <Printer className="h-4 w-4" />
                Print
              </button>
              <button
                onClick={handleDownloadPDF}
                disabled={!logoReady}
                title={logoReady ? undefined : "Loading company logo…"}
                className="flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-white hover:bg-green-700 disabled:opacity-50 disabled:cursor-wait"
              >
                <Download className="h-4 w-4" />
                PDF
              </button>
              <button
                onClick={onClose}
                className="rounded-lg bg-gray-100 p-2 text-gray-600 hover:bg-gray-200"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>

          <div id="return-print-content" ref={printRef} className="p-8">
            <DocumentHeader co={co} title="MATERIAL RETURN" titleClassName="text-orange-600" />

            <div className="mb-3 border-2 border-black p-3 print:mb-2 print:p-2">
              <div className="flex justify-between">
                <div className="space-y-1 text-xs print:text-[10px] print:space-y-0 flex-1">
                  <div>
                    <span className="font-bold">Customer:</span>
                    <span className="font-semibold"> {customer?.company_name || ''}</span>
                  </div>

                  <div className="pt-1 flex">
                    <span className="font-bold" style={{minWidth: '72px'}}>Address:</span>
                    <div>
                      <p>{customer?.address || ''}</p>
                      <p>{customer?.city || ''}</p>
                    </div>
                  </div>
                  <div className="flex pt-1">
                    <span className="font-bold" style={{minWidth: '72px'}}>Phone:</span>
                    <span>{customer?.phone || ''}</span>
                  </div>
                </div>

                <div className="space-y-1 text-xs print:text-[10px] print:space-y-0 text-right" style={{minWidth: '220px'}}>
                  <div>
                    <span className="font-bold">Return No:</span>
                    <span className="ml-2">{materialReturn.return_number}</span>
                  </div>
                  <div>
                    <span className="font-bold">Return Date:</span>
                    <span className="ml-2">{formatDate(materialReturn.return_date)}</span>
                  </div>
                  {materialReturn.delivery_challans && (
                    <div className="pt-1">
                      <span className="font-bold">Original DC:</span>
                      <span className="ml-2">{materialReturn.delivery_challans.challan_number}</span>
                    </div>
                  )}
                  <div className="pt-1">
                    <span className="font-bold">Return Type:</span>
                    <span className="ml-2">{materialReturn.return_type.replace('_', ' ').toUpperCase()}</span>
                  </div>
                  <div>
                    <span className="font-bold">Status:</span>
                    <span className={`ml-2 px-2 py-0.5 rounded text-xs font-semibold ${
                      materialReturn.status === 'approved' ? 'bg-green-100 text-green-800' :
                      materialReturn.status === 'rejected' ? 'bg-red-100 text-red-800' :
                      'bg-yellow-100 text-yellow-800'
                    }`}>
                      {materialReturn.status.replace('_', ' ').toUpperCase()}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <div>
              <table className="w-full border-2 border-black text-xs print:text-[10px]">
                <thead>
                  <tr className="border-b-2 border-black bg-white">
                    <th className="border-r border-black p-1.5 text-center font-bold print:p-1">No.</th>
                    <th className="border-r border-black p-1.5 text-left font-bold print:p-1">Product Name</th>
                    <th className="border-r border-black p-1.5 text-center font-bold print:p-1">Batch No.</th>
                    <th className="border-r border-black p-1.5 text-center font-bold print:p-1">Original Qty</th>
                    <th className="border-r border-black p-1.5 text-center font-bold print:p-1">Return Qty</th>
                    <th className="border-r border-black p-1.5 text-center font-bold print:p-1">Condition</th>
                    <th className="border-r border-black p-1.5 text-right font-bold print:p-1">Unit Price</th>
                    <th className="p-1.5 text-right font-bold print:p-1">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, index) => {
                    const totalPrice = item.quantity_returned * item.unit_price;

                    return (
                      <tr key={item.id || index} className="border-b border-black">
                        <td className="border-r border-black p-1.5 text-center print:p-1">{index + 1}</td>
                        <td className="border-r border-black p-1.5 print:p-1">{item.products?.product_name || 'Unknown Product'}</td>
                        <td className="border-r border-black p-1.5 text-center print:p-1">{item.batches?.batch_number || 'N/A'}</td>
                        <td className="border-r border-black p-1.5 text-center print:p-1">{item.original_quantity.toLocaleString()}</td>
                        <td className="border-r border-black p-1.5 text-center print:p-1">{item.quantity_returned.toLocaleString()}</td>
                        <td className="border-r border-black p-1.5 text-center print:p-1">{item.condition.toUpperCase()}</td>
                        <td className="border-r border-black p-1.5 text-right print:p-1">{formatCurrency(item.unit_price)}</td>
                        <td className="p-1.5 text-right print:p-1">{formatCurrency(totalPrice)}</td>
                      </tr>
                    );
                  })}

                  {items.length < 2 && Array.from({ length: 2 - items.length }).map((_, i) => (
                    <tr key={`empty-${i}`} className="border-b border-black">
                      <td className="border-r border-black p-1.5 text-center print:p-1">&nbsp;</td>
                      <td className="border-r border-black p-1.5 print:p-1">&nbsp;</td>
                      <td className="border-r border-black p-1.5 print:p-1">&nbsp;</td>
                      <td className="border-r border-black p-1.5 print:p-1">&nbsp;</td>
                      <td className="border-r border-black p-1.5 print:p-1">&nbsp;</td>
                      <td className="border-r border-black p-1.5 print:p-1">&nbsp;</td>
                      <td className="border-r border-black p-1.5 print:p-1">&nbsp;</td>
                      <td className="p-1.5 print:p-1">&nbsp;</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="border-2 border-black border-t-0">
              <div className="flex items-stretch border-b-2 border-black">
                <div className="flex-1 p-2 border-r-2 border-black print:p-1.5">
                  <p className="text-xs font-bold print:text-[10px]">Return Reason:</p>
                  <p className="text-xs mt-0.5 print:text-[10px] print:mt-0">
                    {materialReturn.return_reason}
                  </p>
                </div>

                <div className="w-64 text-xs p-2 print:text-[10px] print:p-1.5">
                  <div className="flex justify-between border-t-2 border-black py-1 print:py-0.5">
                    <span className="font-bold">Total Value</span>
                    <span className="font-bold text-sm text-orange-600 print:text-xs">{formatCurrency(materialReturn.financial_impact || 0)}</span>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-0 text-xs print:text-[10px]">
                <div className="p-3 border-r-2 border-black print:p-2 text-center">
                  <p className="font-semibold mb-12 print:mb-10">Prepared By</p>
                  <div className="border-t border-black pt-1 mx-4">Name & Signature</div>
                </div>

                <div className="p-3 border-r-2 border-black print:p-2 text-center">
                  <p className="font-semibold mb-12 print:mb-10">Checked By</p>
                  <div className="border-t border-black pt-1 mx-4">QC / Manager</div>
                </div>

                <div className="p-3 print:p-2 text-center">
                  <p className="font-semibold mb-1">Approved By</p>
                  <p className="font-semibold mb-9 print:mb-7">{co.company_name}</p>
                  <div className="border-t border-black pt-1 mx-4">Pharmacist</div>
                </div>
              </div>
            </div>

            {materialReturn.notes && (
              <div className="mt-3 border-2 border-black p-2 print:mt-2 print:p-1.5">
                <p className="text-xs print:text-[10px]">
                  <span className="font-bold">Additional Notes: </span>
                  <span>{materialReturn.notes}</span>
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      <DocumentPrintStyles contentId="return-print-content" />
    </div>
  );
}
