import { useRef } from 'react';
import { X, Printer, Download } from 'lucide-react';
import { useLanguage } from '../contexts/LanguageContext';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';

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
}

export function CreditNoteView({ creditNote, items, onClose }: CreditNoteViewProps) {
  const printRef = useRef<HTMLDivElement>(null);
  const { language } = useLanguage();

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

  const handlePrint = () => {
    window.print();
  };

  const handleDownloadPDF = async () => {
    if (!printRef.current) return;

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

      const imgData = canvas.toDataURL('image/png', 1.0);
      const pdf = new jsPDF('p', 'mm', 'a4');

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
          pdf.addImage(imgData, 'PNG', 0, position, pdfWidth, scaledHeight);
          remainingHeight -= pdfHeight;
          position -= pdfHeight;

          if (remainingHeight > 0) {
            pdf.addPage();
          }
        }
      } else {
        pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, scaledHeight);
      }

      pdf.save(`CreditNote-${creditNote.credit_note_number}.pdf`);
    } catch (error) {
      console.error('Error generating PDF:', error);
      alert('Failed to generate PDF. Please try again.');
    }
  };

  const customer = creditNote.customers;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-gray-900 bg-opacity-75 print:static print:bg-white print:overflow-visible">
      <div className="flex min-h-screen items-start justify-center p-4 pt-10 print:p-0 print:min-h-0 print:block">
        <div className="relative w-full max-w-5xl bg-white shadow-xl print:shadow-none print:max-w-full">
          <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-white px-6 py-4" style={{ printColorAdjust: 'exact', WebkitPrintColorAdjust: 'exact' }}>
            <h2 className="text-xl font-bold text-gray-900">
              {language === 'id' ? 'Nota Kredit' : 'Credit Note'} {creditNote.credit_note_number}
            </h2>
            <div className="flex gap-2">
              <button
                onClick={handlePrint}
                className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
              >
                <Printer className="h-4 w-4" />
                {language === 'id' ? 'Cetak' : 'Print'}
              </button>
              <button
                onClick={handleDownloadPDF}
                className="flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-white hover:bg-green-700"
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
            <div className="mb-3 border-2 border-black p-3 print:mb-2 print:p-2">
              <div className="mb-2 flex items-start justify-between">
                <div className="flex items-start gap-3">
                  <div className="h-16 w-16 flex items-center justify-center print:h-12 print:w-12" style={{backgroundColor: '#fff'}}>
                    <svg xmlns="http://www.w3.org/2000/svg" xmlSpace="preserve" width="100%" height="100%" viewBox="0 0 15686.55 15480.24" style={{shapeRendering: 'geometricPrecision', fillRule: 'evenodd', clipRule: 'evenodd'}}>
                      <g>
                        <path fill="#FDB763" d="M69.94 10438.12l10353.39 0 0 -1798.67 1665.92 0 0 1868.6 0 320.44 0 4552.28c0,38.48 -31.45,69.94 -69.94,69.94l-11949.38 0c-38.48,0 -69.94,-31.45 -69.94,-69.94l0 -4872.72c0,-38.48 31.45,-69.94 69.94,-69.94zm1605.9 1710.15l8737.57 0c13.58,0 24.68,11.11 24.68,24.68l0 1719.84c0,13.58 -11.11,24.68 -24.68,24.68l-8737.57 0c-13.58,0 -24.68,-11.11 -24.68,-24.68l0 -1719.84c0,-13.58 11.11,-24.68 24.68,-24.68z"/>
                        <path fill="#FDB763" d="M15587.15 5136.67l-10353.49 0 0 1822.07 -1665.92 0 0 -1892.9 0 -324.61 0 -4611.43c0,-39 31.45,-70.87 69.94,-70.87l11949.47 0c38.48,0 69.94,31.87 69.94,70.87l0 4936.04c0,39 -31.45,70.83 -69.94,70.83zm-1605.9 -1732.36l-8737.67 0c-13.58,0 -24.68,-11.27 -24.68,-25l0 -1742.21c0,-13.74 11.11,-25 24.68,-25l8737.67 0c13.58,0 24.68,11.27 24.68,25l0 1742.21c0,13.74 -11.11,25 -24.68,25z"/>
                        <polygon fill="#FD6D26" points="-0,0 1651.16,0 1651.16,6929.27 15657.09,6929.27 15657.09,6958.74 15686.55,6958.74 15686.55,15480.24 14022.85,15480.24 14022.85,8639.45 1651.16,8639.45 -0,8639.45 -0,6929.27"/>
                      </g>
                    </svg>
                  </div>
                  <div>
                    <h1 className="text-base font-bold print:text-sm">PT. SHUBHAM ANZEN PHARMA JAYA</h1>
                    <p className="text-xs print:text-[10px]">Komplek Ruko Metro Sunter Blok A1 NO.15, Jl. Metro Indah Raya,</p>
                    <p className="text-xs print:text-[10px]">Kelurahan Papanggo, Kec. Tanjung Priok, Jakarta Utara - 14340</p>
                    <p className="text-xs print:text-[10px]">Telp: (+62 21) 65832426</p>
                  </div>
                </div>

                <div className="text-right">
                  <h2 className="text-3xl font-bold text-red-600 print:text-2xl">{language === 'id' ? 'CREDIT NOTE' : 'CREDIT NOTE'}</h2>
                </div>
              </div>

              <div className="text-xs space-y-0.5 print:text-[10px] print:space-y-0">
                <div>
                  <span className="font-semibold">No izin PBF</span>
                  <span className="ml-16">: 27092400534390007</span>
                </div>
                <div>
                  <span className="font-semibold">No Sertifikasi CDOB</span>
                  <span className="ml-4">: 270924005343900070001</span>
                </div>
              </div>
            </div>

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
                  <p className="font-semibold mb-10 print:mb-8">PT. SHUBHAM ANZEN PHARMA JAYA</p>
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

      <style>{`
        @media print {
          @page {
            size: A4 portrait;
            margin: 8mm;
          }

          .sticky {
            display: none !important;
          }

          body {
            margin: 0;
            padding: 0;
          }

          body * {
            visibility: hidden;
          }

          #credit-note-print-content,
          #credit-note-print-content * {
            visibility: visible;
          }

          #credit-note-print-content {
            position: absolute;
            left: 0;
            top: 0;
            width: 100%;
            page-break-inside: avoid;
            page-break-after: auto;
          }

          #credit-note-print-content > div {
            page-break-inside: avoid;
          }

          table {
            page-break-inside: auto;
          }

          tr {
            page-break-inside: avoid;
            page-break-after: auto;
          }

          thead {
            display: table-header-group;
          }

          tfoot {
            display: table-footer-group;
          }
        }
      `}</style>
    </div>
  );
}
