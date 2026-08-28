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
interface CreditNoteItem {
  id?: string;
  product_id: string;
  batch_id: string;
  quantity: number;
  unit_price: number;
  products?: {
    product_name: string;
    product_code: string;
  };
  batches?: {
    batch_number: string;
  };
}

interface CreditNoteViewProps {
  creditNote: {
    id: string;
    credit_note_number: string;
    credit_note_date: string;
    customer_id: string;
    original_invoice_number?: string;
    reason: string;
    notes?: string;
    currency: string;
    subtotal: number;
    tax_amount: number;
    total_amount: number;
    customers?: {
      company_name: string;
      address: string;
      city: string;
      phone: string;
      npwp: string;
      pharmacy_license: string;
    };
  };
  items: CreditNoteItem[];
  onClose: () => void;
  companyProfile?: CompanySnapshot | null;
}

export function CreditNoteView({ creditNote, items, onClose, companyProfile }: CreditNoteViewProps) {
  const printRef = useRef<HTMLDivElement>(null);
  const { language } = useLanguage();
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
        documentType={"Credit Note"}
        documentNumber={'—'}
        onClose={onClose}
      />
    );
  }
  const co = companyProfile;

  const formatCurrency = (amount: number | undefined | null) => {
    if (amount === undefined || amount === null) return 'Rp 0,00';
    // Always show 2 decimal places in Indonesian format (Rp 136.125.000,00)
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
        windowWidth: printRef.current.scrollWidth,
        windowHeight: printRef.current.scrollHeight,
        onclone: (clonedDoc) => {
          const clonedElement = clonedDoc.getElementById('credit-note-print-content');
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

      pdf.save(`CreditNote-${creditNote.credit_note_number}.pdf`);
    } catch (error) {
      console.error('Error generating PDF:', error);
      alert('Failed to generate PDF. Please try again.');
    }
  };

  const customer = creditNote.customers;

  return (
    <div className="doc-print-root fixed inset-0 z-50 overflow-y-auto bg-gray-900 bg-opacity-75 print:static print:bg-white print:overflow-visible">
      <div className="doc-print-scroll flex min-h-screen items-start justify-center p-4 pt-10 print:p-0 print:min-h-0 print:block">
        <div className="doc-print-sheet relative w-full max-w-5xl bg-white shadow-xl print:shadow-none print:max-w-full">
          <div className="doc-print-hide sticky top-0 z-10 flex items-center justify-between border-b bg-white px-6 py-4" style={{ printColorAdjust: 'exact', WebkitPrintColorAdjust: 'exact' }}>
            <h2 className="text-xl font-bold text-gray-900">
              {language === 'id' ? 'Nota Kredit' : 'Credit Note'} {creditNote.credit_note_number}
            </h2>
            <div className="flex gap-2">
              <button
                onClick={handlePrint}
                disabled={!logoReady}
                title={logoReady ? undefined : "Loading company logo…"}
                className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-wait"
              >
                <Printer className="h-4 w-4" />
                {language === 'id' ? 'Cetak' : 'Print'}
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

          <div id="credit-note-print-content" ref={printRef} className="p-8">
            <DocumentHeader co={co} title={language === 'id' ? 'CREDIT NOTE' : 'CREDIT NOTE'} titleClassName="text-red-600" />

            <div className="mb-3 border-2 border-black p-3 print:mb-2 print:p-2">
              <div className="flex justify-between">
                <div className="space-y-1 text-xs print:text-[10px] print:space-y-0 flex-1">
                  <div>
                    <span className="font-bold">{language === 'id' ? 'Company Name:' : 'Company Name:'}</span>
                    <span className="font-semibold"> {customer?.company_name || ''}</span>
                  </div>

                  <div className="pt-1 flex">
                    <span className="font-bold" style={{minWidth: '72px'}}>{language === 'id' ? 'Address:' : 'Address:'}</span>
                    <div>
                      <p>{customer?.address || ''}</p>
                      <p>{customer?.city || ''}</p>
                    </div>
                  </div>
                  <div className="flex pt-1">
                    <span className="font-bold" style={{minWidth: '72px'}}>{language === 'id' ? 'Phone:' : 'Phone:'}</span>
                    <span>{customer?.phone || ''}</span>
                  </div>
                  <div className="flex">
                    <span className="font-bold" style={{minWidth: '72px'}}>NPWP:</span>
                    <span>{customer?.npwp || ''}</span>
                  </div>
                </div>

                <div className="space-y-1 text-xs print:text-[10px] print:space-y-0 text-right" style={{minWidth: '200px'}}>
                  <div>
                    <span className="font-bold">{language === 'id' ? 'Credit Note No:' : 'Credit Note No:'}</span>
                    <span className="ml-2">{creditNote.credit_note_number}</span>
                  </div>
                  <div>
                    <span className="font-bold">{language === 'id' ? 'Date:' : 'Date:'}</span>
                    <span className="ml-2">{formatDate(creditNote.credit_note_date)}</span>
                  </div>
                  {creditNote.original_invoice_number && (
                    <div className="pt-1">
                      <span className="font-bold">{language === 'id' ? 'Original Invoice:' : 'Original Invoice:'}</span>
                      <span className="ml-2">{creditNote.original_invoice_number}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div>
              <table className="w-full border-2 border-black text-xs print:text-[10px]">
                <thead>
                  <tr className="border-b-2 border-black bg-white">
                    <th className="border-r border-black p-1.5 text-center font-bold print:p-1">No.</th>
                    <th className="border-r border-black p-1.5 text-left font-bold print:p-1">{language === 'id' ? 'Product Name' : 'Product Name'}</th>
                    <th className="border-r border-black p-1.5 text-center font-bold print:p-1">Batch No.</th>
                    <th className="border-r border-black p-1.5 text-center font-bold print:p-1">{language === 'id' ? 'Quantity' : 'Quantity'}</th>
                    <th className="border-r border-black p-1.5 text-right font-bold print:p-1">{language === 'id' ? 'Unit Price (IDR)' : 'Unit Price (IDR)'}</th>
                    <th className="p-1.5 text-right font-bold print:p-1">{language === 'id' ? 'Sub Total (IDR)' : 'Sub Total (IDR)'}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, index) => {
                    const quantity = item.quantity || 0;
                    const unitPrice = item.unit_price || 0;
                    const itemSubtotal = quantity * unitPrice;

                    return (
                      <tr key={item.id || index} className="border-b border-black">
                        <td className="border-r border-black p-1.5 text-center print:p-1">{index + 1}</td>
                        <td className="border-r border-black p-1.5 print:p-1">{item.products?.product_name || 'Unknown Product'}</td>
                        <td className="border-r border-black p-1.5 text-center print:p-1">{item.batches?.batch_number || 'N/A'}</td>
                        <td className="border-r border-black p-1.5 text-center print:p-1">{quantity.toLocaleString()}</td>
                        <td className="border-r border-black p-1.5 text-right print:p-1">{formatCurrency(unitPrice)}</td>
                        <td className="p-1.5 text-right print:p-1">{formatCurrency(itemSubtotal)}</td>
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
                      <td className="p-1.5 print:p-1">&nbsp;</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="border-2 border-black border-t-0">
              <div className="flex items-stretch border-b-2 border-black">
                <div className="flex-1 p-2 border-r-2 border-black print:p-1.5">
                  <p className="text-xs font-bold print:text-[10px]">{language === 'id' ? 'Amount In words:' : 'Amount in words:'}</p>
                  <p className="text-xs mt-0.5 font-bold uppercase print:text-[10px] print:mt-0">
                    IDR {numberToWords(Math.round(creditNote.total_amount))} RUPIAH
                  </p>
                </div>

                <div className="w-80 text-xs p-2 print:text-[10px] print:p-1.5">
                  <div className="flex justify-between py-1 print:py-0.5">
                    <span className="font-bold">{language === 'id' ? 'Sub Total' : 'Sub Total'}</span>
                    <span className="font-bold">{formatCurrency(creditNote.subtotal)}</span>
                  </div>
                  <div className="flex justify-between border-t border-black py-1 print:py-0.5">
                    <span className="font-bold">VAT (PPN) 11%</span>
                    <span className="font-bold">{formatCurrency(creditNote.tax_amount)}</span>
                  </div>
                  <div className="flex justify-between border-t-2 border-black py-1 print:py-0.5">
                    <span className="font-bold">{language === 'id' ? 'Total Credit' : 'Total Credit'}</span>
                    <span className="font-bold text-sm text-red-600 print:text-xs">{formatCurrency(creditNote.total_amount)}</span>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-0 text-xs print:text-[10px]">
                <div className="p-3 border-r-2 border-black print:p-2">
                  <p className="font-semibold mb-2 print:mb-1">{language === 'id' ? 'Reason for Credit:' : 'Reason for Credit:'}</p>
                  <p className="text-sm">{creditNote.reason}</p>
                </div>

                <div className="p-3 print:p-2">
                  <p className="font-semibold mb-1">{language === 'id' ? 'Authorized Signatory:' : 'Authorized Signatory:'}</p>
                  <p className="font-semibold mb-10 print:mb-8">{co.company_name}</p>
                  <div className="w-4/5 border-t border-black pt-1">{language === 'id' ? 'Pharmacist' : 'Pharmacist'}</div>
                </div>
              </div>
            </div>

            {creditNote.notes && (
              <div className="mt-3 border-2 border-black p-2 print:mt-2 print:p-1.5">
                <p className="text-xs print:text-[10px]">
                  <span className="font-bold">{language === 'id' ? 'Notes: ' : 'Notes: '}</span>
                  <span>{creditNote.notes}</span>
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      <DocumentPrintStyles contentId="credit-note-print-content" />
    </div>
  );
}
