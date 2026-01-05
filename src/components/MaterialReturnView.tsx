import { useRef } from 'react';
import { X, Printer, Download } from 'lucide-react';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';

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
}

export function MaterialReturnView({ materialReturn, items, onClose }: MaterialReturnViewProps) {
  const printRef = useRef<HTMLDivElement>(null);

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
          const clonedElement = clonedDoc.getElementById('return-print-content');
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

      pdf.save(`MaterialReturn-${materialReturn.return_number}.pdf`);
    } catch (error) {
      console.error('Error generating PDF:', error);
      alert('Failed to generate PDF. Please try again.');
    }
  };

  const customer = materialReturn.customers;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-gray-900 bg-opacity-75 print:static print:bg-white print:overflow-visible">
      <div className="flex min-h-screen items-start justify-center p-4 pt-10 print:p-0 print:min-h-0 print:block">
        <div className="relative w-full max-w-5xl bg-white shadow-xl print:shadow-none print:max-w-full">
          <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-white px-6 py-4 print:hidden">
            <h2 className="text-xl font-bold text-gray-900">
              Material Return {materialReturn.return_number}
            </h2>
            <div className="flex gap-2">
              <button
                onClick={handlePrint}
                className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
              >
                <Printer className="h-4 w-4" />
                Print
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

          <div id="return-print-content" ref={printRef} className="p-8">
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
                  <h2 className="text-3xl font-bold text-orange-600 print:text-2xl">MATERIAL RETURN</h2>
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
                  <p className="font-semibold mb-9 print:mb-7">PT. SHUBHAM ANZEN PHARMA JAYA</p>
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

          #return-print-content,
          #return-print-content * {
            visibility: visible;
          }

          #return-print-content {
            position: absolute;
            left: 0;
            top: 0;
            width: 100%;
            page-break-inside: avoid;
            page-break-after: auto;
          }

          #return-print-content > div {
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
