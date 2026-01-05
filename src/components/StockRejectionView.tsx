import { useRef } from 'react';
import { X, Printer, Download, Image as ImageIcon } from 'lucide-react';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';

interface StockRejectionViewProps {
  rejection: {
    id: string;
    rejection_number: string;
    rejection_date: string;
    quantity_rejected: number;
    rejection_reason: string;
    rejection_details: string;
    status: string;
    financial_loss: number;
    disposition: string;
    inspection_report?: string;
    unit_cost: number;
    photos?: any[];
    product: {
      product_name: string;
      product_code: string;
      unit: string;
    };
    batch: {
      batch_number: string;
      current_stock: number;
    };
  };
  onClose: () => void;
}

export function StockRejectionView({ rejection, onClose }: StockRejectionViewProps) {
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
          const clonedElement = clonedDoc.getElementById('rejection-print-content');
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

      pdf.save(`StockRejection-${rejection.rejection_number}.pdf`);
    } catch (error) {
      console.error('Error generating PDF:', error);
      alert('Failed to generate PDF. Please try again.');
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-gray-900 bg-opacity-75 print:static print:bg-white print:overflow-visible">
      <div className="flex min-h-screen items-start justify-center p-4 pt-10 print:p-0 print:min-h-0 print:block">
        <div className="relative w-full max-w-5xl bg-white shadow-xl print:shadow-none print:max-w-full">
          <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-white px-6 py-4 print:hidden">
            <h2 className="text-xl font-bold text-gray-900">
              Stock Rejection {rejection.rejection_number}
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

          <div id="rejection-print-content" ref={printRef} className="p-8">
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
                  <h2 className="text-3xl font-bold text-red-600 print:text-2xl">STOCK REJECTION</h2>
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
                    <span className="font-bold">Product:</span>
                    <span className="font-semibold"> {rejection.product.product_name}</span>
                  </div>
                  <div>
                    <span className="font-bold">Product Code:</span>
                    <span className="ml-2">{rejection.product.product_code}</span>
                  </div>
                  <div className="pt-1">
                    <span className="font-bold">Batch Number:</span>
                    <span className="ml-2">{rejection.batch.batch_number}</span>
                  </div>
                  <div>
                    <span className="font-bold">Batch Stock:</span>
                    <span className="ml-2">{rejection.batch.current_stock.toLocaleString()} {rejection.product.unit}</span>
                  </div>
                </div>

                <div className="space-y-1 text-xs print:text-[10px] print:space-y-0 text-right" style={{minWidth: '220px'}}>
                  <div>
                    <span className="font-bold">Rejection No:</span>
                    <span className="ml-2">{rejection.rejection_number}</span>
                  </div>
                  <div>
                    <span className="font-bold">Date:</span>
                    <span className="ml-2">{formatDate(rejection.rejection_date)}</span>
                  </div>
                  <div className="pt-1">
                    <span className="font-bold">Qty Rejected:</span>
                    <span className="ml-2 text-red-600 font-semibold">{rejection.quantity_rejected.toLocaleString()} {rejection.product.unit}</span>
                  </div>
                  <div>
                    <span className="font-bold">Status:</span>
                    <span className={`ml-2 px-2 py-0.5 rounded text-xs font-semibold ${
                      rejection.status === 'approved' ? 'bg-green-100 text-green-800' :
                      rejection.status === 'rejected' ? 'bg-red-100 text-red-800' :
                      rejection.status === 'disposed' ? 'bg-gray-100 text-gray-800' :
                      'bg-yellow-100 text-yellow-800'
                    }`}>
                      {rejection.status.replace('_', ' ').toUpperCase()}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <div className="mb-3 border-2 border-black print:mb-2">
              <table className="w-full text-xs print:text-[10px]">
                <thead>
                  <tr className="border-b-2 border-black bg-white">
                    <th className="border-r border-black p-2 text-left font-bold print:p-1">Rejection Details</th>
                    <th className="p-2 text-left font-bold print:p-1">Financial Impact</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="border-r border-black p-2 print:p-1 align-top">
                      <div className="space-y-2">
                        <div>
                          <span className="font-bold">Reason: </span>
                          <span className="uppercase">{rejection.rejection_reason.replace('_', ' ')}</span>
                        </div>
                        <div>
                          <span className="font-bold">Details: </span>
                          <p className="mt-1">{rejection.rejection_details}</p>
                        </div>
                        {rejection.inspection_report && (
                          <div>
                            <span className="font-bold">Inspection Report: </span>
                            <p className="mt-1">{rejection.inspection_report}</p>
                          </div>
                        )}
                        <div>
                          <span className="font-bold">Disposition: </span>
                          <span className="uppercase">{rejection.disposition.replace('_', ' ')}</span>
                        </div>
                      </div>
                    </td>
                    <td className="p-2 print:p-1 align-top">
                      <div className="space-y-1">
                        <div className="flex justify-between">
                          <span>Unit Cost:</span>
                          <span className="font-semibold">{formatCurrency(rejection.unit_cost)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>Quantity:</span>
                          <span className="font-semibold">{rejection.quantity_rejected.toLocaleString()} {rejection.product.unit}</span>
                        </div>
                        <div className="flex justify-between pt-1 border-t-2 border-black">
                          <span className="font-bold">Total Loss:</span>
                          <span className="font-bold text-red-600">{formatCurrency(rejection.financial_loss)}</span>
                        </div>
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            {rejection.photos && rejection.photos.length > 0 && (
              <div className="mb-3 border-2 border-black p-3 print:mb-2 print:p-2 print:hidden">
                <h3 className="text-sm font-bold mb-2">Rejection Photos</h3>
                <div className="grid grid-cols-3 gap-2">
                  {rejection.photos.map((photo: any, index: number) => (
                    <div key={index} className="border border-gray-300 rounded overflow-hidden">
                      <img
                        src={photo.url}
                        alt={`Rejection photo ${index + 1}`}
                        className="w-full h-32 object-cover"
                      />
                      <div className="text-xs p-1 bg-gray-50 text-center">
                        Photo {index + 1}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="border-2 border-black">
              <div className="grid grid-cols-3 gap-0 text-xs print:text-[10px]">
                <div className="p-3 border-r-2 border-black print:p-2 text-center">
                  <p className="font-semibold mb-12 print:mb-10">Inspected By</p>
                  <div className="border-t border-black pt-1 mx-4">QC Inspector</div>
                </div>

                <div className="p-3 border-r-2 border-black print:p-2 text-center">
                  <p className="font-semibold mb-12 print:mb-10">Reviewed By</p>
                  <div className="border-t border-black pt-1 mx-4">QC Manager</div>
                </div>

                <div className="p-3 print:p-2 text-center">
                  <p className="font-semibold mb-1">Approved By</p>
                  <p className="font-semibold mb-9 print:mb-7">PT. SHUBHAM ANZEN PHARMA JAYA</p>
                  <div className="border-t border-black pt-1 mx-4">Management</div>
                </div>
              </div>
            </div>
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

          #rejection-print-content,
          #rejection-print-content * {
            visibility: visible;
          }

          #rejection-print-content {
            position: absolute;
            left: 0;
            top: 0;
            width: 100%;
            page-break-inside: avoid;
            page-break-after: auto;
          }

          #rejection-print-content > div {
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
