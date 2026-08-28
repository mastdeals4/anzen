import { useRef, useEffect } from 'react';
import { X, Printer, Download } from 'lucide-react';
import { useLanguage } from '../contexts/LanguageContext';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';
import { type CompanySnapshot } from '../types/company';
import { useResolvedCompanyLogo, waitForImages } from '../utils/companyLogoUrl';
import { SnapshotMissingError } from './SnapshotMissingError';

import { DocumentHeader } from './DocumentHeader';
import { DocumentPrintStyles } from './DocumentPrintStyles';
interface POItem {
  id?: string;
  product_id: string;
  quantity: number;
  unit: string;
  unit_price: number;
  discount_percent: number;
  line_total: number;
  coa_code?: string;
  specification?: string;
  products?: {
    product_name: string;
    product_code: string;
  };
}

interface PurchaseOrderViewProps {
  purchaseOrder: {
    id: string;
    po_number: string;
    po_date: string;
    supplier_id: string;
    expected_delivery_date?: string;
    delivery_address?: string;
    currency: string;
    subtotal: number;
    tax_amount: number;
    total_amount: number;
    payment_terms?: string;
    notes?: string;
    terms_conditions?: string;
    status: string;
    suppliers?: {
      company_name: string;
      contact_person?: string;
      phone?: string;
      email?: string;
      address?: string;
      city?: string;
      npwp?: string;
    };
  };
  items: POItem[];
  onClose: () => void;
  companyProfile?: CompanySnapshot | null;
}

export function PurchaseOrderView({ purchaseOrder: po, items, onClose, companyProfile }: PurchaseOrderViewProps) {
  const printRef = useRef<HTMLDivElement>(null);
  const { ready: logoReady } = useResolvedCompanyLogo(companyProfile?.company_logo_url);
  const { t, language } = useLanguage();

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
        documentType={"Purchase Order"}
        documentNumber={'—'}
        onClose={onClose}
      />
    );
  }
  const co = companyProfile;

  const formatCurrency = (amount: number | undefined | null) => {
    if (amount === undefined || amount === null) return po.currency === 'USD' ? '$ 0.00' : 'Rp 0';
    if (po.currency === 'USD') {
      return `$ ${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
    return `Rp ${amount.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const months = language === 'id'
      ? ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agt', 'Sep', 'Okt', 'Nov', 'Des']
      : ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    const day = date.getDate();
    const month = months[date.getMonth()];
    const year = date.getFullYear();

    return `${day} ${month} ${year}`;
  };

  const numberToWords = (num: number): string => {
    if (language === 'id') {
      return numberToWordsIndonesian(num);
    } else {
      return numberToWordsEnglish(num);
    }
  };

  const numberToWordsIndonesian = (num: number): string => {
    if (num === 0) return 'Nol';

    const ones = ['', 'Satu', 'Dua', 'Tiga', 'Empat', 'Lima', 'Enam', 'Tujuh', 'Delapan', 'Sembilan'];
    const teens = ['Sepuluh', 'Sebelas', 'Dua Belas', 'Tiga Belas', 'Empat Belas', 'Lima Belas', 'Enam Belas', 'Tujuh Belas', 'Delapan Belas', 'Sembilan Belas'];
    const tens = ['', '', 'Dua Puluh', 'Tiga Puluh', 'Empat Puluh', 'Lima Puluh', 'Enam Puluh', 'Tujuh Puluh', 'Delapan Puluh', 'Sembilan Puluh'];

    const convertLessThanThousand = (n: number): string => {
      if (n === 0) return '';
      if (n < 10) return ones[n];
      if (n >= 10 && n < 20) return teens[n - 10];
      if (n < 100) {
        const ten = Math.floor(n / 10);
        const one = n % 10;
        return tens[ten] + (one > 0 ? ' ' + ones[one] : '');
      }
      const hundred = Math.floor(n / 100);
      const rest = n % 100;
      const hundredWord = hundred === 1 ? 'Seratus' : ones[hundred] + ' Ratus';
      return hundredWord + (rest > 0 ? ' ' + convertLessThanThousand(rest) : '');
    };

    if (num < 1000) return convertLessThanThousand(num);
    if (num < 1000000) {
      const thousands = Math.floor(num / 1000);
      const rest = num % 1000;
      const thousandWord = thousands === 1 ? 'Seribu' : convertLessThanThousand(thousands) + ' Ribu';
      return thousandWord + (rest > 0 ? ' ' + convertLessThanThousand(rest) : '');
    }
    if (num < 1000000000) {
      const millions = Math.floor(num / 1000000);
      const rest = num % 1000000;
      const millionWord = convertLessThanThousand(millions) + ' Juta';
      const restWord = rest >= 1000
        ? (Math.floor(rest / 1000) === 1 ? 'Seribu' : convertLessThanThousand(Math.floor(rest / 1000)) + ' Ribu') + (rest % 1000 > 0 ? ' ' + convertLessThanThousand(rest % 1000) : '')
        : (rest > 0 ? convertLessThanThousand(rest) : '');
      return millionWord + (restWord ? ' ' + restWord : '');
    }
    return num.toString();
  };

  const numberToWordsEnglish = (num: number): string => {
    if (num === 0) return 'Zero';

    const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
    const teens = ['Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
    const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

    const convertLessThanThousand = (n: number): string => {
      if (n === 0) return '';
      if (n < 10) return ones[n];
      if (n >= 10 && n < 20) return teens[n - 10];
      if (n < 100) {
        const ten = Math.floor(n / 10);
        const one = n % 10;
        return tens[ten] + (one > 0 ? ' ' + ones[one] : '');
      }
      const hundred = Math.floor(n / 100);
      const rest = n % 100;
      return ones[hundred] + ' Hundred' + (rest > 0 ? ' ' + convertLessThanThousand(rest) : '');
    };

    if (num < 1000) return convertLessThanThousand(num);
    if (num < 1000000) {
      const thousands = Math.floor(num / 1000);
      const rest = num % 1000;
      return convertLessThanThousand(thousands) + ' Thousand' + (rest > 0 ? ' ' + convertLessThanThousand(rest) : '');
    }
    if (num < 1000000000) {
      const millions = Math.floor(num / 1000000);
      const rest = num % 1000000;
      const restWord = rest >= 1000
        ? convertLessThanThousand(Math.floor(rest / 1000)) + ' Thousand' + (rest % 1000 > 0 ? ' ' + convertLessThanThousand(rest % 1000) : '')
        : (rest > 0 ? convertLessThanThousand(rest) : '');
      return convertLessThanThousand(millions) + ' Million' + (restWord ? ' ' + restWord : '');
    }
    return num.toString();
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

      pdf.save(`PO-${po.po_number}.pdf`);
    } catch (error) {
      console.error('Error generating PDF:', error);
      alert('Failed to generate PDF. Please try again.');
    }
  };

  const supplier = po.suppliers;
  const currencyLabel = po.currency === 'USD' ? 'USD' : 'IDR';

  return (
    <div className="doc-print-root fixed inset-0 z-50 overflow-y-auto bg-gray-900 bg-opacity-75 print:static print:bg-white print:overflow-visible">
      <div className="doc-print-scroll flex min-h-screen items-start justify-center p-4 pt-10 print:p-0 print:min-h-0 print:block">
        <div className="doc-print-sheet relative w-full max-w-5xl bg-white shadow-xl print:shadow-none print:max-w-full">
          <div className="doc-print-hide sticky top-0 z-10 flex items-center justify-between border-b bg-white px-6 py-4 print:hidden">
            <h2 className="text-xl font-bold text-gray-900">
              Purchase Order {po.po_number}
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

          <div id="po-print-content" ref={printRef} className="p-8">
            <DocumentHeader co={co} title="PURCHASE ORDER" />

            <div className="mb-3 border-2 border-black p-3 print:mb-2 print:p-2">
              <div className="flex justify-between">
                <div className="space-y-1 text-xs print:text-[10px] print:space-y-0 flex-1">
                  <div>
                    <span className="font-bold">Supplier:</span>
                    <span className="font-semibold"> {supplier?.company_name || ''}</span>
                  </div>

                  <div className="pt-1 flex">
                    <span className="font-bold" style={{minWidth: '72px'}}>Address:</span>
                    <div>
                      <p>{supplier?.address || ''}</p>
                      <p>{supplier?.city || ''}</p>
                    </div>
                  </div>
                  <div className="flex pt-1">
                    <span className="font-bold" style={{minWidth: '72px'}}>Phone:</span>
                    <span>{supplier?.phone || ''}</span>
                  </div>
                  <div className="flex">
                    <span className="font-bold" style={{minWidth: '72px'}}>Contact:</span>
                    <span>{supplier?.contact_person || ''}</span>
                  </div>
                </div>

                <div className="space-y-1 text-xs print:text-[10px] print:space-y-0 text-right" style={{minWidth: '200px'}}>
                  <div>
                    <span className="font-bold">PO No:</span>
                    <span className="ml-2">{po.po_number}</span>
                  </div>
                  <div>
                    <span className="font-bold">PO Date:</span>
                    <span className="ml-2">{formatDate(po.po_date)}</span>
                  </div>
                  <div className="pt-1">
                    <span className="font-bold">Expected Delivery:</span>
                    <span className="ml-2">{po.expected_delivery_date ? formatDate(po.expected_delivery_date) : 'N/A'}</span>
                  </div>
                  <div>
                    <span className="font-bold">Payment Terms:</span>
                    <span className="ml-2">{po.payment_terms || 'N/A'}</span>
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
                    <th className="border-r border-black p-1.5 text-left font-bold print:p-1">Specification</th>
                    <th className="border-r border-black p-1.5 text-center font-bold print:p-1">COA No.</th>
                    <th className="border-r border-black p-1.5 text-center font-bold print:p-1">Quantity</th>
                    <th className="border-r border-black p-1.5 text-center font-bold print:p-1">UOM</th>
                    <th className="border-r border-black p-1.5 text-right font-bold print:p-1">Unit Price ({currencyLabel})</th>
                    <th className="border-r border-black p-1.5 text-center font-bold print:p-1">Disc%</th>
                    <th className="p-1.5 text-right font-bold print:p-1">Sub Total ({currencyLabel})</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, index) => (
                    <tr key={item.id || index} className="border-b border-black">
                      <td className="border-r border-black p-1.5 text-center print:p-1">{index + 1}</td>
                      <td className="border-r border-black p-1.5 print:p-1">{item.products?.product_name || 'Unknown Product'}</td>
                      <td className="border-r border-black p-1.5 print:p-1">{item.specification || '-'}</td>
                      <td className="border-r border-black p-1.5 text-center print:p-1">{item.coa_code || '-'}</td>
                      <td className="border-r border-black p-1.5 text-center print:p-1">{item.quantity.toLocaleString()}</td>
                      <td className="border-r border-black p-1.5 text-center print:p-1">{item.unit}</td>
                      <td className="border-r border-black p-1.5 text-right print:p-1">{formatCurrency(item.unit_price)}</td>
                      <td className="border-r border-black p-1.5 text-center print:p-1">{item.discount_percent}%</td>
                      <td className="p-1.5 text-right print:p-1">{formatCurrency(item.line_total)}</td>
                    </tr>
                  ))}

                  {items.length < 2 && Array.from({ length: 2 - items.length }).map((_, i) => (
                    <tr key={`empty-${i}`} className="border-b border-black">
                      <td className="border-r border-black p-1.5 text-center print:p-1">&nbsp;</td>
                      <td className="border-r border-black p-1.5 print:p-1">&nbsp;</td>
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
                  <p className="text-xs font-bold print:text-[10px]">Amount in words:</p>
                  <p className="text-xs mt-0.5 font-bold uppercase print:text-[10px] print:mt-0">
                    {currencyLabel} {numberToWords(Math.round(po.total_amount))} {po.currency === 'USD' ? 'DOLLARS' : 'RUPIAH'}
                  </p>
                </div>

                <div className="w-80 text-xs p-2 print:text-[10px] print:p-1.5">
                  <div className="flex justify-between border-t-2 border-black py-1 print:py-0.5">
                    <span className="font-bold">Total Amount</span>
                    <span className="font-bold text-sm print:text-xs">{formatCurrency(po.total_amount)}</span>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-0 text-xs print:text-[10px]">
                <div className="p-3 border-r-2 border-black print:p-2">
                  <p className="font-semibold mb-1">Delivery Address:</p>
                  <p className="whitespace-pre-line">{po.delivery_address || 'Same as company address'}</p>
                </div>

                <div className="p-3 print:p-2">
                  <p className="font-semibold mb-1">Authorized By:</p>
                  <p className="font-semibold mb-10 print:mb-8">{co.company_name}</p>
                  <div className="w-4/5 border-t border-black pt-1">Authorized Signatory</div>
                </div>
              </div>
            </div>

            {(po.notes || po.terms_conditions) && (
              <div className="mt-3 border-2 border-black p-2 print:mt-2 print:p-1.5">
                {po.notes && (
                  <div className="mb-2">
                    <p className="text-xs print:text-[10px]">
                      <span className="font-bold">Notes: </span>
                      <span>{po.notes}</span>
                    </p>
                  </div>
                )}
                {po.terms_conditions && (
                  <div>
                    <p className="text-xs print:text-[10px]">
                      <span className="font-bold">Terms & Conditions: </span>
                      <span>{po.terms_conditions}</span>
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <DocumentPrintStyles contentId="po-print-content" />
    </div>
  );
}
