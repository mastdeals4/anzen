import { useRef } from 'react';
import { X, Printer, Download } from 'lucide-react';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';

interface ChallanItem {
  id: string;
  product_id: string;
  batch_id: string;
  quantity: number;
  pack_size: number | null;
  pack_type: string | null;
  number_of_packs: number | null;
  products?: {
    product_name: string;
    product_code: string;
    unit: string;
  };
  batches?: {
    batch_number: string;
    expiry_date: string | null;
    packaging_details: string | null;
  };
}

interface DeliveryChallanViewProps {
  challan: {
    id: string;
    challan_number: string;
    customer_id: string;
    challan_date: string;
    delivery_address: string;
    vehicle_number: string | null;
    driver_name: string | null;
    status: string;
    notes: string | null;
    customers?: {
      company_name: string;
      address: string;
      city: string;
      phone: string;
      pbf_license: string;
    };
  };
  items: ChallanItem[];
  onClose: () => void;
  companySettings?: {
    company_name: string;
    address: string;
    city: string;
    phone: string;
    email: string;
    website: string;
    npwp: string;
    logo_url: string | null;
  } | null;
}

export function DeliveryChallanView({ challan, items, onClose }: DeliveryChallanViewProps) {
  const printRef = useRef<HTMLDivElement>(null);

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
          const clonedElement = clonedDoc.getElementById('challan-print-content');
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

      pdf.save(`Delivery-Challan-${challan.challan_number}.pdf`);
    } catch (error) {
      console.error('Error generating PDF:', error);
      alert('Failed to generate PDF. Please try again.');
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const day = date.getDate();
    const month = date.getMonth() + 1;
    const year = date.getFullYear();
    return `${day.toString().padStart(2, '0')}-${month.toString().padStart(2, '0')}-${year}`;
  };

  const formatExpiryDate = (dateString: string) => {
    const date = new Date(dateString);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = months[date.getMonth()];
    const year = date.getFullYear();
    return `${month} ${year}`;
  };

  const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
  const firstItemUnit = items[0]?.products?.unit || 'kg';

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-gray-900 bg-opacity-75 print:static print:bg-white print:overflow-visible">
      <div className="flex min-h-screen items-start justify-center p-4 pt-10 print:p-0 print:min-h-0 print:block">
        <div className="relative w-full max-w-5xl bg-white shadow-xl print:shadow-none print:max-w-full">
          {/* Action Buttons - Hidden on print */}
          <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-white px-6 py-4 print:hidden">
            <h2 className="text-xl font-bold text-gray-900">
              Surat Jalan {challan.challan_number}
            </h2>
            <div className="flex gap-2">
              <button
                onClick={handlePrint}
                className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
              >
                <Printer className="h-4 w-4" />
                Cetak
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

          {/* Challan Content */}
          <div id="challan-print-content" ref={printRef} className="p-8">
            {/* Header Section - Company Details */}
            <div className="mb-3 border-2 border-black p-3 print:mb-2 print:p-2">
              <div className="mb-2 flex items-start justify-between">
                {/* Company Logo and Info */}
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

                {/* SURAT JALAN Title */}
                <div className="text-right">
                  <h2 className="text-3xl font-bold print:text-2xl">SURAT JALAN</h2>
                </div>
              </div>

              {/* Company Licenses */}
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

            {/* Customer and Challan Details */}
            <div className="mb-3 border-2 border-black p-3 print:mb-2 print:p-2">
              <div className="flex justify-between">
                {/* Left - Customer Details */}
                <div className="space-y-1 text-xs print:text-[10px] print:space-y-0 flex-1">
                  <div className="mb-1">
                    <span className="font-bold">Company Name:</span>
                  </div>
                  <div className="ml-4 mb-2">
                    <p className="font-semibold">{challan.customers?.company_name || ''}</p>
                  </div>
                  <div className="mb-1">
                    <span className="font-bold">Address:</span>
                  </div>
                  <div className="ml-4 mb-2">
                    <p>{challan.delivery_address || ''}</p>
                    <p>{challan.customers?.city || ''}</p>
                  </div>
                  <div className="mb-1">
                    <span className="font-bold">Phone:</span>
                    <span className="ml-2">{challan.customers?.phone || '-'}</span>
                  </div>
                  <div>
                    <span className="font-bold">No.Izin PBF:</span>
                    <span className="ml-2">{challan.customers?.pbf_license || '-'}</span>
                  </div>
                </div>

                {/* Right - Challan Details */}
                <div className="space-y-1 text-xs print:text-[10px] print:space-y-0 text-right w-64">
                  <div className="mb-1">
                    <span className="font-bold">Challan No: </span>
                    <span>{challan.challan_number}</span>
                  </div>
                  <div className="mb-1">
                    <span className="font-bold">Challan Date: </span>
                    <span>{formatDate(challan.challan_date)}</span>
                  </div>
                  {challan.vehicle_number && (
                    <div>
                      <span className="font-bold">Vehicle No: </span>
                      <span>{challan.vehicle_number}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Items Table */}
            <div className="mb-3 border-2 border-black print:mb-2">
              <table className="w-full border-collapse text-xs print:text-[10px]">
                <thead>
                  <tr className="border-b-2 border-black">
                    <th className="border-r border-black p-2 text-center font-bold print:p-1" style={{ width: '5%' }}>No</th>
                    <th className="border-r border-black p-2 text-left font-bold print:p-1" style={{ width: '30%' }}>Nama Produk<br/>Product Name</th>
                    <th className="border-r border-black p-2 text-center font-bold print:p-1" style={{ width: '12%' }}>No Batch<br/>Batch No</th>
                    <th className="border-r border-black p-2 text-center font-bold print:p-1" style={{ width: '12%' }}>Exp. Date</th>
                    <th className="border-r border-black p-2 text-center font-bold print:p-1" style={{ width: '18%' }}>Kemasan<br/>Packaging</th>
                    <th className="border-r border-black p-2 text-center font-bold print:p-1" style={{ width: '8%' }}>Jumlah<br/>Packs</th>
                    <th className="p-2 text-center font-bold print:p-1" style={{ width: '15%' }}>Kuantitas<br/>Quantity</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, index) => (
                    <tr key={item.id} className="border-b border-black">
                      <td className="border-r border-black p-2 text-center print:p-1">{index + 1}</td>
                      <td className="border-r border-black p-2 print:p-1">{item.products?.product_name}</td>
                      <td className="border-r border-black p-2 text-center print:p-1">{item.batches?.batch_number}</td>
                      <td className="border-r border-black p-2 text-center print:p-1">
                        {item.batches?.expiry_date ? formatExpiryDate(item.batches.expiry_date) : '-'}
                      </td>
                      <td className="border-r border-black p-2 text-center print:p-1">
                        {item.pack_type && item.pack_size && item.number_of_packs
                          ? `${item.pack_size} ${item.products?.unit || 'kg'}/${item.pack_type}`
                          : item.pack_type && item.pack_size
                          ? `${item.pack_size} ${item.pack_type}`
                          : '-'}
                      </td>
                      <td className="border-r border-black p-2 text-center print:p-1">
                        {item.number_of_packs || '-'}
                      </td>
                      <td className="p-2 text-center print:p-1">{item.quantity.toLocaleString()} {item.products?.unit || firstItemUnit}</td>
                    </tr>
                  ))}
                  <tr className="border-t-2 border-black bg-gray-50 font-bold">
                    <td colSpan={6} className="border-r border-black p-2 text-right print:p-1">
                      Total Kuantitas / Total Quantity:
                    </td>
                    <td className="p-2 text-center print:p-1">
                      {totalQuantity.toLocaleString()} {firstItemUnit}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Notes Section */}
            <div className="mb-3 p-2 print:mb-2 print:p-1.5">
              <p className="text-xs font-semibold print:text-[10px]">Catatan / Notes:</p>
              {challan.notes ? (
                <p className="text-xs print:text-[10px] mt-1">{challan.notes}</p>
              ) : (
                <p className="text-xs print:text-[10px] mt-1">Produk dikirim dalam kondisi sesuai persyaratan penyimpanan / Goods are delivered under controlled storage conditions.</p>
              )}
            </div>

            {/* Signature Section */}
            <div className="grid grid-cols-4 gap-3 print:gap-2">
              <div className="border-2 border-black p-2 text-center print:p-1.5">
                <div className="mb-2 text-xs font-semibold print:mb-1 print:text-[10px]">
                  Disiapkan Oleh<br/>Prepared By
                </div>
                <div className="mb-10 print:mb-8">
                  <div className="h-12 print:h-10"></div>
                </div>
                <div className="border-t-2 border-black pt-2 print:pt-1">
                  <p className="text-xs print:text-[10px]">Tanda Tangan & Tanggal</p>
                  <p className="text-xs print:text-[10px]">Signature & Date</p>
                  <p className="text-[10px] font-semibold mt-1 print:text-[8px] print:mt-0.5">PT. SHUBHAM ANZEN PHARMA JAYA</p>
                </div>
              </div>
              <div className="border-2 border-black p-2 text-center print:p-1.5">
                <div className="mb-2 text-xs font-semibold print:mb-1 print:text-[10px]">
                  Dikirim Oleh<br/>Delivered By
                </div>
                <div className="mb-10 print:mb-8">
                  <div className="h-12 print:h-10"></div>
                </div>
                <div className="border-t-2 border-black pt-2 print:pt-1">
                  <p className="text-xs print:text-[10px]">Tanda Tangan & Tanggal</p>
                  <p className="text-xs print:text-[10px]">Signature & Date</p>
                  <p className="text-[10px] font-semibold mt-1 print:text-[8px] print:mt-0.5">PT. SHUBHAM ANZEN PHARMA JAYA</p>
                </div>
              </div>
              <div className="border-2 border-black p-2 text-center print:p-1.5">
                <div className="mb-2 text-xs font-semibold print:mb-1 print:text-[10px]">
                  Farmasi<br/>Pharmacist
                </div>
                <div className="mb-10 print:mb-8">
                  <div className="h-12 print:h-10"></div>
                </div>
                <div className="border-t-2 border-black pt-2 print:pt-1">
                  <p className="text-xs print:text-[10px]">Tanda Tangan & Tanggal</p>
                  <p className="text-xs print:text-[10px]">Signature & Date</p>
                  <p className="text-[10px] font-semibold mt-1 print:text-[8px] print:mt-0.5">PT. SHUBHAM ANZEN PHARMA JAYA</p>
                </div>
              </div>
              <div className="border-2 border-black p-2 text-center print:p-1.5">
                <div className="mb-2 text-xs font-semibold print:mb-1 print:text-[10px]">
                  Diterima Oleh<br/>Received By
                </div>
                <div className="mb-10 print:mb-8">
                  <div className="h-12 print:h-10"></div>
                </div>
                <div className="border-t-2 border-black pt-2 print:pt-1">
                  <p className="text-xs print:text-[10px]">Tanda Tangan & Tanggal</p>
                  <p className="text-xs print:text-[10px]">Signature & Date</p>
                  <p className="text-[10px] font-semibold mt-1 print:text-[8px] print:mt-0.5">{challan.customers?.company_name || ''}</p>
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

          #challan-print-content,
          #challan-print-content * {
            visibility: visible;
          }

          #challan-print-content {
            position: absolute;
            left: 0;
            top: 0;
            width: 100%;
            page-break-inside: avoid;
            page-break-after: auto;
          }

          #challan-print-content > div {
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
