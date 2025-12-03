import { useState, useEffect, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import * as XLSX from 'xlsx';
import {
  ChevronDown, X, Mail, Phone, FileText, Calendar,
  Flame, ArrowUp, Minus, Send, MessageSquare, CheckSquare,
  Download, FileSpreadsheet, ArrowUpDown, ArrowDown, Check, XCircle, Plus
} from 'lucide-react';
import { Modal } from '../Modal';
import { GmailLikeComposer } from './GmailLikeComposer';
import { TaskFormModal } from '../tasks/TaskFormModal';
import { OurSideChips } from './OurSideChips';
import { PipelineStatusBadge, pipelineStatusOptions } from './PipelineStatusBadge';
import { LostReasonModal } from './LostReasonModal';
import { useAuth } from '../../contexts/AuthContext';

interface Inquiry {
  id: string;
  inquiry_number: string;
  inquiry_date: string;
  product_name: string;
  specification?: string | null;
  quantity: string;
  supplier_name: string | null;
  supplier_country: string | null;
  company_name: string;
  contact_person: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  email_subject?: string | null;
  mail_subject?: string | null;
  status: string;
  pipeline_status?: string;
  priority: string;
  coa_sent: boolean;
  msds_sent: boolean;
  sample_sent: boolean;
  price_quoted: boolean;
  price_required?: boolean;
  coa_required?: boolean;
  sample_required?: boolean;
  agency_letter_required?: boolean;
  others_required?: boolean;
  price_sent_at?: string | null;
  coa_sent_at?: string | null;
  sample_sent_at?: string | null;
  agency_letter_sent_at?: string | null;
  aceerp_no?: string | null;
  purchase_price?: number | null;
  purchase_price_currency?: string;
  offered_price?: number | null;
  offered_price_currency?: string;
  delivery_date?: string | null;
  delivery_terms?: string | null;
  remarks: string | null;
}

interface ColumnFilter {
  column: string;
  values: string[];
}

interface InquiryTableProps {
  inquiries: Inquiry[];
  onRefresh: () => void;
  canManage: boolean;
  onAddInquiry?: () => void;
}

export function InquiryTableExcel({ inquiries, onRefresh, canManage, onAddInquiry }: InquiryTableProps) {
  const { profile } = useAuth();
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState<ColumnFilter[]>([]);
  const [openFilter, setOpenFilter] = useState<string | null>(null);
  const [filteredData, setFilteredData] = useState<Inquiry[]>(inquiries);
  const [sortConfig, setSortConfig] = useState<{ column: string; direction: 'asc' | 'desc' | null }>({ column: 'inquiry_date', direction: 'desc' });
  const [editingCell, setEditingCell] = useState<{ id: string; field: string } | null>(null);
  const [editValue, setEditValue] = useState('');
  const [emailModalOpen, setEmailModalOpen] = useState(false);
  const [selectedInquiryForEmail, setSelectedInquiryForEmail] = useState<Inquiry | null>(null);
  const [logCallModalOpen, setLogCallModalOpen] = useState(false);
  const [callNotes, setCallNotes] = useState('');
  const [followUpModalOpen, setFollowUpModalOpen] = useState(false);
  const [followUpDate, setFollowUpDate] = useState('');
  const [followUpNotes, setFollowUpNotes] = useState('');
  const [createTaskModalOpen, setCreateTaskModalOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [lostReasonModalOpen, setLostReasonModalOpen] = useState(false);
  const [inquiryToMarkLost, setInquiryToMarkLost] = useState<Inquiry | null>(null);
  const [offeredPriceModalOpen, setOfferedPriceModalOpen] = useState(false);
  const [inquiryForOfferedPrice, setInquiryForOfferedPrice] = useState<Inquiry | null>(null);
  const [offeredPriceInput, setOfferedPriceInput] = useState('');
  const [editRequirementsModalOpen, setEditRequirementsModalOpen] = useState(false);
  const [requirementsForm, setRequirementsForm] = useState({
    price_required: false,
    coa_required: false,
    sample_required: false,
    agency_letter_required: false,
    others_required: false,
  });
  const filterRef = useRef<HTMLDivElement>(null);

  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({
    checkbox: 50,
    inquiry_number: 120,
    inquiry_date: 120,
    product_name: 200,
    specification: 200,
    quantity: 100,
    supplier_name: 150,
    company_name: 180,
    mail_subject: 200,
    aceerp_no: 120,
    status: 130,
    pipeline_status: 130,
    our_side: 130,
    purchase_price: 100,
    offered_price: 100,
    delivery_date: 120,
    priority: 100,
    remarks: 200,
  });
  const [resizing, setResizing] = useState<{ column: string; startX: number; startWidth: number } | null>(null);

  const statusOptions = [
    { value: 'new', label: 'New' },
    { value: 'price_quoted', label: 'Price Quoted' },
    { value: 'coa_pending', label: 'COA Pending' },
    { value: 'sample_sent', label: 'Sample Sent' },
    { value: 'negotiation', label: 'Negotiation' },
    { value: 'po_received', label: 'PO Received' },
    { value: 'won', label: 'Won' },
    { value: 'lost', label: 'Lost' },
    { value: 'on_hold', label: 'On Hold' },
  ];

  const priorityOptions = [
    { value: 'urgent', label: 'Urgent', icon: <Flame className="w-3 h-3 text-red-600" /> },
    { value: 'high', label: 'High', icon: <ArrowUp className="w-3 h-3 text-orange-600" /> },
    { value: 'medium', label: 'Medium', icon: <Minus className="w-3 h-3 text-gray-400" /> },
    { value: 'low', label: 'Low', icon: <Minus className="w-3 h-3 text-gray-300" /> },
  ];

  useEffect(() => {
    applyFiltersAndSort();
  }, [inquiries, filters, sortConfig]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (filterRef.current && !filterRef.current.contains(event.target as Node)) {
        setOpenFilter(null);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!resizing) return;
      const delta = e.clientX - resizing.startX;
      const newWidth = Math.max(50, resizing.startWidth + delta);
      setColumnWidths(prev => ({ ...prev, [resizing.column]: newWidth }));
    };

    const handleMouseUp = () => {
      setResizing(null);
    };

    if (resizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [resizing]);

  const handleResizeStart = (column: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setResizing({
      column,
      startX: e.clientX,
      startWidth: columnWidths[column] || 150,
    });
  };

  const ResizableHeader = ({
    column,
    label,
    sortable = true,
    className = ''
  }: {
    column: string;
    label: string;
    sortable?: boolean;
    className?: string;
  }) => (
    <th
      style={{ width: columnWidths[column], minWidth: columnWidths[column] }}
      className={`relative px-3 py-2 text-left font-semibold text-gray-700 border-r border-gray-300 ${sortable ? 'cursor-pointer hover:bg-gray-100 select-none' : ''} ${className}`}
      onClick={sortable ? () => handleSort(column) : undefined}
    >
      <div className="flex items-center gap-1">
        <span className="truncate">{label}</span>
        {sortable && getSortIcon(column)}
      </div>
      <div
        className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-blue-400 group"
        onMouseDown={(e) => handleResizeStart(column, e)}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="absolute top-0 right-0 w-1 h-full bg-transparent group-hover:bg-blue-400" />
      </div>
    </th>
  );

  const applyFiltersAndSort = () => {
    let result = [...inquiries];

    // Apply filters
    filters.forEach(filter => {
      if (filter.values.length > 0) {
        result = result.filter(row => {
          const value = row[filter.column as keyof Inquiry];
          return filter.values.includes(String(value || ''));
        });
      }
    });

    // Apply sorting
    if (sortConfig.column && sortConfig.direction) {
      result.sort((a, b) => {
        const aValue = a[sortConfig.column as keyof Inquiry];
        const bValue = b[sortConfig.column as keyof Inquiry];

        // Handle null/undefined values
        if (aValue == null && bValue == null) return 0;
        if (aValue == null) return sortConfig.direction === 'asc' ? 1 : -1;
        if (bValue == null) return sortConfig.direction === 'asc' ? -1 : 1;

        // Convert to strings for comparison
        const aStr = String(aValue).toLowerCase();
        const bStr = String(bValue).toLowerCase();

        if (sortConfig.direction === 'asc') {
          return aStr > bStr ? 1 : aStr < bStr ? -1 : 0;
        } else {
          return aStr < bStr ? 1 : aStr > bStr ? -1 : 0;
        }
      });
    }

    setFilteredData(result);
  };

  const handleSort = (column: string) => {
    let direction: 'asc' | 'desc' | null = 'asc';

    if (sortConfig.column === column) {
      if (sortConfig.direction === 'asc') {
        direction = 'desc';
      } else if (sortConfig.direction === 'desc') {
        direction = null;
      }
    }

    setSortConfig({ column, direction });
  };

  const getSortIcon = (column: string) => {
    if (sortConfig.column !== column) {
      return <ArrowUpDown className="w-3 h-3 text-gray-400" />;
    }
    if (sortConfig.direction === 'asc') {
      return <ArrowUp className="w-3 h-3 text-blue-600" />;
    }
    if (sortConfig.direction === 'desc') {
      return <ArrowDown className="w-3 h-3 text-blue-600" />;
    }
    return <ArrowUpDown className="w-3 h-3 text-gray-400" />;
  };

  const exportToExcel = () => {
    setExporting(true);

    try {
      const exportData = filteredData.map(inquiry => ({
        'No.': inquiry.inquiry_number,
        'Date': new Date(inquiry.inquiry_date).toLocaleDateString('en-GB', {
          day: '2-digit',
          month: 'short',
          year: 'numeric'
        }),
        'Product': inquiry.product_name,
        'Specification': inquiry.specification || '-',
        'Qty': inquiry.quantity,
        'Supplier': inquiry.supplier_name || '-',
        'Country': inquiry.supplier_country || '-',
        'Company': inquiry.company_name,
        'Mail Subject': inquiry.mail_subject || '-',
        'ACE ERP#': inquiry.aceerp_no || '-',
        'Pipeline': pipelineStatusOptions.find(p => p.value === inquiry.pipeline_status)?.label || '-',
        'Price Needed': inquiry.price_required ? 'Yes' : 'No',
        'COA Needed': inquiry.coa_required ? 'Yes' : 'No',
        'Sample Needed': inquiry.sample_required ? 'Yes' : 'No',
        'Agency Letter Needed': inquiry.agency_letter_required ? 'Yes' : 'No',
        'Others Needed': inquiry.others_required ? 'Yes' : 'No',
        'Price Sent': inquiry.price_sent_at ? 'Yes' : 'No',
        'COA Sent': inquiry.coa_sent_at ? 'Yes' : 'No',
        'Sample Sent': inquiry.sample_sent_at ? 'Yes' : 'No',
        'Agency Letter Sent': inquiry.agency_letter_sent_at ? 'Yes' : 'No',
        'Purchase Price': inquiry.purchase_price ? `${inquiry.purchase_price} ${inquiry.purchase_price_currency || 'USD'}` : '-',
        'Offered Price': inquiry.offered_price ? `${inquiry.offered_price} ${inquiry.offered_price_currency || 'USD'}` : '-',
        'Delivery Date': inquiry.delivery_date ? new Date(inquiry.delivery_date).toLocaleDateString('en-GB') : '-',
        'Delivery Terms': inquiry.delivery_terms || '-',
        'Priority': priorityOptions.find(p => p.value === inquiry.priority)?.label || inquiry.priority,
        'Remarks': inquiry.remarks || '-',
      }));

      const ws = XLSX.utils.json_to_sheet(exportData);

      // Set column widths
      ws['!cols'] = [
        { wch: 15 },  // No.
        { wch: 12 },  // Date
        { wch: 30 },  // Product
        { wch: 20 },  // Specification
        { wch: 10 },  // Qty
        { wch: 20 },  // Supplier
        { wch: 12 },  // Country
        { wch: 25 },  // Company
        { wch: 30 },  // Mail Subject
        { wch: 12 },  // ACE ERP#
        { wch: 15 },  // Pipeline
        { wch: 13 },  // Price Needed
        { wch: 12 },  // COA Needed
        { wch: 15 },  // Sample Needed
        { wch: 20 },  // Agency Letter Needed
        { wch: 12 },  // Price Sent
        { wch: 11 },  // COA Sent
        { wch: 13 },  // Sample Sent
        { wch: 19 },  // Agency Letter Sent
        { wch: 18 },  // Purchase Price
        { wch: 18 },  // Offered Price
        { wch: 15 },  // Delivery Date
        { wch: 18 },  // Delivery Terms
        { wch: 10 },  // Priority
        { wch: 30 },  // Remarks
      ];

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'CRM Inquiries');

      const fileName = `CRM-Inquiries-${new Date().toISOString().split('T')[0]}.xlsx`;
      XLSX.writeFile(wb, fileName);

      alert(`Exported ${exportData.length} inquiries to ${fileName}`);
    } catch (error) {
      console.error('Export error:', error);
      alert('Failed to export data. Please try again.');
    } finally {
      setExporting(false);
    }
  };

  const exportToCSV = () => {
    setExporting(true);

    try {
      const exportData = filteredData.map(inquiry => ({
        'No.': inquiry.inquiry_number,
        'Date': new Date(inquiry.inquiry_date).toLocaleDateString('en-GB', {
          day: '2-digit',
          month: 'short',
          year: 'numeric'
        }),
        'Product': inquiry.product_name,
        'Specification': inquiry.specification || '-',
        'Qty': inquiry.quantity,
        'Supplier': inquiry.supplier_name || '-',
        'Country': inquiry.supplier_country || '-',
        'Company': inquiry.company_name,
        'Mail Subject': inquiry.mail_subject || '-',
        'ACE ERP#': inquiry.aceerp_no || '-',
        'Pipeline': pipelineStatusOptions.find(p => p.value === inquiry.pipeline_status)?.label || '-',
        'Price Needed': inquiry.price_required ? 'Yes' : 'No',
        'COA Needed': inquiry.coa_required ? 'Yes' : 'No',
        'Sample Needed': inquiry.sample_required ? 'Yes' : 'No',
        'Agency Letter Needed': inquiry.agency_letter_required ? 'Yes' : 'No',
        'Others Needed': inquiry.others_required ? 'Yes' : 'No',
        'Price Sent': inquiry.price_sent_at ? 'Yes' : 'No',
        'COA Sent': inquiry.coa_sent_at ? 'Yes' : 'No',
        'Sample Sent': inquiry.sample_sent_at ? 'Yes' : 'No',
        'Agency Letter Sent': inquiry.agency_letter_sent_at ? 'Yes' : 'No',
        'Purchase Price': inquiry.purchase_price ? `${inquiry.purchase_price} ${inquiry.purchase_price_currency || 'USD'}` : '-',
        'Offered Price': inquiry.offered_price ? `${inquiry.offered_price} ${inquiry.offered_price_currency || 'USD'}` : '-',
        'Delivery Date': inquiry.delivery_date ? new Date(inquiry.delivery_date).toLocaleDateString('en-GB') : '-',
        'Delivery Terms': inquiry.delivery_terms || '-',
        'Priority': priorityOptions.find(p => p.value === inquiry.priority)?.label || inquiry.priority,
        'Remarks': inquiry.remarks || '-',
      }));

      const ws = XLSX.utils.json_to_sheet(exportData);
      const csv = XLSX.utils.sheet_to_csv(ws);

      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      const url = URL.createObjectURL(blob);

      link.setAttribute('href', url);
      link.setAttribute('download', `CRM-Inquiries-${new Date().toISOString().split('T')[0]}.csv`);
      link.style.visibility = 'hidden';

      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      alert(`Exported ${exportData.length} inquiries to CSV. You can import this file to Google Sheets.`);
    } catch (error) {
      console.error('Export error:', error);
      alert('Failed to export data. Please try again.');
    } finally {
      setExporting(false);
    }
  };

  const downloadImportTemplate = () => {
    const templateData = [{
      'Date': '02-12-2024',
      'Product': 'Example Product Name',
      'Specification': 'BP / USP / EP',
      'Qty': '500 KG',
      'Supplier': 'Manufacturer Name',
      'Country': 'Japan',
      'Company': 'Customer Company Name',
      'Mail Subject': 'Inquiry for Product',
      'ACE ERP#': 'ACE-123',
      'Price Needed': 'Yes',
      'COA Needed': 'Yes',
      'Sample Needed': 'No',
      'Agency Letter Needed': 'No',
      'Others Needed': 'No',
      'Purchase Price': '100',
      'Purchase Price Currency': 'USD',
      'Offered Price': '150',
      'Offered Price Currency': 'USD',
      'Delivery Date': '2025-12-31',
      'Delivery Terms': 'FOB Shanghai',
      'Priority': 'Medium',
      'Remarks': 'Additional notes',
    }];

    const ws = XLSX.utils.json_to_sheet(templateData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Import Template');

    XLSX.writeFile(wb, 'CRM-Import-Template.xlsx');
    alert('Template downloaded! Fill in your data and use the Import button to upload.');
  };

  const handleImportFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });
        const worksheet = workbook.Sheets[workbook.SheetNames[0]];
        const jsonData = XLSX.utils.sheet_to_json(worksheet);

        if (jsonData.length === 0) {
          alert('No data found in the file');
          return;
        }

        const { data: { user } } = await supabase.auth.getUser();
        if (!user) throw new Error('Not authenticated');

        const parseDate = (dateStr: any) => {
          if (!dateStr) return new Date().toISOString().split('T')[0];

          // Handle Excel serial date numbers (e.g., 45261)
          if (typeof dateStr === 'number') {
            // Excel epoch starts on January 1, 1900 (but Excel incorrectly treats 1900 as a leap year)
            const excelEpoch = new Date(1899, 11, 30); // December 30, 1899
            const date = new Date(excelEpoch.getTime() + dateStr * 86400000);
            const year = date.getFullYear();
            const month = (date.getMonth() + 1).toString().padStart(2, '0');
            const day = date.getDate().toString().padStart(2, '0');
            return `${year}-${month}-${day}`;
          }

          // Handle string formats
          const str = dateStr.toString().trim();

          // D/M/YY or DD/MM/YY format (e.g., 4/10/25, 10/11/25)
          const twoDigitYear = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
          if (twoDigitYear) {
            let [, day, month, year] = twoDigitYear;
            // Convert 2-digit year to 4-digit (00-29 = 2000s, 30-99 = 1900s)
            const fullYear = parseInt(year) < 30 ? `20${year}` : `19${year}`;
            return `${fullYear}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
          }

          // DD-MM-YYYY format
          const ddmmyyyy1 = str.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
          if (ddmmyyyy1) {
            const [, day, month, year] = ddmmyyyy1;
            return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
          }

          // DD/MM/YYYY format
          const ddmmyyyy2 = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
          if (ddmmyyyy2) {
            const [, day, month, year] = ddmmyyyy2;
            return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
          }

          // YYYY-MM-DD format
          const yyyymmdd = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
          if (yyyymmdd) {
            const [, year, month, day] = yyyymmdd;
            return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
          }

          return new Date().toISOString().split('T')[0];
        };

        const inquiriesToInsert = jsonData.map((row: any) => ({
          product_name: row['Product'] || '',
          specification: row['Specification'] || null,
          quantity: row['Qty'] || '',
          supplier_name: row['Supplier'] || null,
          supplier_country: row['Country'] || null,
          company_name: row['Company'] || '',
          mail_subject: row['Mail Subject'] || null,
          aceerp_no: row['ACE ERP#'] || null,
          price_required: (row['Price Needed'] || '').toLowerCase() === 'yes',
          coa_required: (row['COA Needed'] || '').toLowerCase() === 'yes',
          sample_required: (row['Sample Needed'] || '').toLowerCase() === 'yes',
          agency_letter_required: (row['Agency Letter Needed'] || '').toLowerCase() === 'yes',
          others_required: (row['Others Needed'] || '').toLowerCase() === 'yes',
          purchase_price: row['Purchase Price'] ? parseFloat(row['Purchase Price']) : null,
          purchase_price_currency: row['Purchase Price Currency'] || 'USD',
          offered_price: row['Offered Price'] ? parseFloat(row['Offered Price']) : null,
          offered_price_currency: row['Offered Price Currency'] || 'USD',
          delivery_date: row['Delivery Date'] || null,
          delivery_terms: row['Delivery Terms'] || null,
          priority: (row['Priority'] || 'medium').toLowerCase(),
          remarks: row['Remarks'] || null,
          inquiry_date: parseDate(row['Date']),
          pipeline_status: 'new',
          status: 'new',
          inquiry_source: 'other',
          assigned_to: user.id,
          created_by: user.id,
        }));

        const { error } = await supabase
          .from('crm_inquiries')
          .insert(inquiriesToInsert);

        if (error) throw error;

        alert(`Successfully imported ${inquiriesToInsert.length} inquiries!`);
        onRefresh();

        event.target.value = '';
      } catch (error) {
        console.error('Import error:', error);
        alert('Failed to import data. Please check the file format and try again.');
        event.target.value = '';
      }
    };

    reader.readAsArrayBuffer(file);
  };

  const toggleFilter = (column: string, value: string) => {
    setFilters(prev => {
      const existing = prev.find(f => f.column === column);
      if (existing) {
        const newValues = existing.values.includes(value)
          ? existing.values.filter(v => v !== value)
          : [...existing.values, value];

        if (newValues.length === 0) {
          return prev.filter(f => f.column !== column);
        }
        return prev.map(f => f.column === column ? { ...f, values: newValues } : f);
      }
      return [...prev, { column, values: [value] }];
    });
  };

  const clearColumnFilter = (column: string) => {
    setFilters(prev => prev.filter(f => f.column !== column));
  };

  const getUniqueValues = (column: keyof Inquiry) => {
    const values = inquiries.map(i => i[column]);
    return [...new Set(values)].filter(Boolean).sort();
  };

  const isColumnFiltered = (column: string) => {
    return filters.some(f => f.column === column && f.values.length > 0);
  };

  const toggleRowSelection = (id: string) => {
    setSelectedRows(prev => {
      const newSet = new Set(prev);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id); // Allow multiple selections
      }
      return newSet;
    });
  };

  const toggleSelectAll = () => {
    if (selectedRows.size === filteredData.length) {
      setSelectedRows(new Set());
    } else {
      setSelectedRows(new Set(filteredData.map(i => i.id)));
    }
  };

  const startEditing = (inquiry: Inquiry, field: keyof Inquiry) => {
    if (!canManage) return;
    setEditingCell({ id: inquiry.id, field: field as string });
    setEditValue(String(inquiry[field] || ''));
  };

  const saveEdit = async () => {
    if (!editingCell) return;

    try {
      const { error } = await supabase
        .from('crm_inquiries')
        .update({ [editingCell.field]: editValue || null })
        .eq('id', editingCell.id);

      if (error) throw error;
      setEditingCell(null);
      onRefresh();
    } catch (error) {
      console.error('Error updating field:', error);
      alert('Failed to update. Please try again.');
    }
  };

  const updateStatus = async (inquiry: Inquiry, newStatus: string) => {
    try {
      const { error } = await supabase
        .from('crm_inquiries')
        .update({ status: newStatus })
        .eq('id', inquiry.id);

      if (error) throw error;
      onRefresh();
    } catch (error) {
      console.error('Error updating status:', error);
    }
  };

  const updatePriority = async (inquiry: Inquiry, newPriority: string) => {
    try {
      const { error } = await supabase
        .from('crm_inquiries')
        .update({ priority: newPriority })
        .eq('id', inquiry.id);

      if (error) throw error;
      onRefresh();
    } catch (error) {
      console.error('Error updating priority:', error);
    }
  };

  const updatePipelineStatus = async (inquiry: Inquiry, newStatus: string) => {
    if (newStatus === 'lost') {
      setInquiryToMarkLost(inquiry);
      setLostReasonModalOpen(true);
      return;
    }

    try {
      const { error } = await supabase
        .from('crm_inquiries')
        .update({ pipeline_status: newStatus })
        .eq('id', inquiry.id);

      if (error) throw error;
      onRefresh();
    } catch (error) {
      console.error('Error updating pipeline status:', error);
    }
  };

  const markRequirementSent = async (inquiry: Inquiry, requirementType: 'price' | 'coa' | 'sample' | 'agency_letter' | 'others') => {
    const sentAtField = `${requirementType}_sent_at` as keyof Inquiry;
    const isSent = inquiry[sentAtField];

    if (isSent) {
      if (!confirm(`Are you sure you want to unmark ${requirementType.toUpperCase()} as sent?`)) {
        return;
      }

      try {
        const updateData = { [sentAtField]: null };
        const { error } = await supabase
          .from('crm_inquiries')
          .update(updateData)
          .eq('id', inquiry.id);

        if (error) throw error;
        onRefresh();
        alert(`${requirementType.toUpperCase()} unmarked!`);
      } catch (error) {
        console.error('Error unmarking requirement:', error);
        alert('Failed to unmark. Please try again.');
      }
      return;
    }

    if (requirementType === 'price') {
      setInquiryForOfferedPrice(inquiry);
      setOfferedPriceInput(inquiry.offered_price?.toString() || '');
      setOfferedPriceModalOpen(true);
      return;
    }

    try {
      const { error } = await supabase.rpc('mark_requirement_sent', {
        inquiry_id: inquiry.id,
        requirement_type: requirementType
      });

      if (error) throw error;
      onRefresh();
      alert(`${requirementType.toUpperCase()} marked as sent!`);
    } catch (error) {
      console.error('Error marking requirement as sent:', error);
      alert('Failed to mark as sent. Please try again.');
    }
  };

  const saveOfferedPriceAndMarkSent = async () => {
    if (!inquiryForOfferedPrice) return;

    const price = offeredPriceInput.trim() ? parseFloat(offeredPriceInput) : null;

    try {
      const { error: updateError } = await supabase
        .from('crm_inquiries')
        .update({ offered_price: price })
        .eq('id', inquiryForOfferedPrice.id);

      if (updateError) throw updateError;

      const { error: markError } = await supabase.rpc('mark_requirement_sent', {
        inquiry_id: inquiryForOfferedPrice.id,
        requirement_type: 'price'
      });

      if (markError) throw markError;

      setOfferedPriceModalOpen(false);
      setInquiryForOfferedPrice(null);
      setOfferedPriceInput('');
      onRefresh();
      alert('Price marked as sent with offered price updated!');
    } catch (error) {
      console.error('Error saving offered price and marking sent:', error);
      alert('Failed to save. Please try again.');
    }
  };

  const handleSendQuote = () => {
    const selectedInquiry = filteredData.find(i => selectedRows.has(i.id));
    if (selectedInquiry) {
      setSelectedInquiryForEmail(selectedInquiry);
      setEmailModalOpen(true);
    }
  };

  const handleSendCOAMSDS = async () => {
    const selectedInquiry = filteredData.find(i => selectedRows.has(i.id));
    if (!selectedInquiry) return;

    setSelectedInquiryForEmail(selectedInquiry);
    setEmailModalOpen(true);
  };

  const handleLogCall = () => {
    setLogCallModalOpen(true);
  };

  const saveLogCall = async () => {
    const selectedInquiry = filteredData.find(i => selectedRows.has(i.id));
    if (!selectedInquiry) return;

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      await supabase.from('crm_activities').insert({
        inquiry_id: selectedInquiry.id,
        activity_type: 'call',
        description: callNotes,
        activity_date: new Date().toISOString().split('T')[0],
        is_completed: true,
        created_by: user.id,
      });

      setLogCallModalOpen(false);
      setCallNotes('');
      alert('Call logged successfully!');
      onRefresh();
    } catch (error) {
      console.error('Error logging call:', error);
      alert('Failed to log call. Please try again.');
    }
  };

  const handleDeleteSelected = async () => {
    if (selectedRows.size === 0) return;

    const count = selectedRows.size;
    if (!confirm(`Are you sure you want to delete ${count} selected ${count === 1 ? 'inquiry' : 'inquiries'}? This action cannot be undone.`)) {
      return;
    }

    try {
      const idsToDelete = Array.from(selectedRows);
      const { error } = await supabase
        .from('crm_inquiries')
        .delete()
        .in('id', idsToDelete);

      if (error) throw error;

      setSelectedRows(new Set());
      alert(`Successfully deleted ${count} ${count === 1 ? 'inquiry' : 'inquiries'}`);
      onRefresh();
    } catch (error) {
      console.error('Error deleting inquiries:', error);
      alert('Failed to delete inquiries. Please try again.');
    }
  };

  const handleScheduleFollowUp = () => {
    setFollowUpModalOpen(true);
  };

  const saveFollowUp = async () => {
    const selectedInquiry = filteredData.find(i => selectedRows.has(i.id));
    if (!selectedInquiry) return;

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      await supabase.from('crm_activities').insert({
        inquiry_id: selectedInquiry.id,
        activity_type: 'follow_up',
        description: followUpNotes,
        activity_date: new Date().toISOString().split('T')[0],
        follow_up_date: followUpDate,
        is_completed: false,
        created_by: user.id,
      });

      setFollowUpModalOpen(false);
      setFollowUpDate('');
      setFollowUpNotes('');
      alert('Follow-up scheduled successfully!');
      onRefresh();
    } catch (error) {
      console.error('Error scheduling follow-up:', error);
      alert('Failed to schedule follow-up. Please try again.');
    }
  };

  const handleEditRequirements = () => {
    const selectedInquiry = filteredData.find(i => selectedRows.has(i.id));
    if (!selectedInquiry) return;

    setRequirementsForm({
      price_required: selectedInquiry.price_required ?? false,
      coa_required: selectedInquiry.coa_required ?? false,
      sample_required: selectedInquiry.sample_required ?? false,
      agency_letter_required: selectedInquiry.agency_letter_required ?? false,
      others_required: selectedInquiry.others_required ?? false,
    });
    setEditRequirementsModalOpen(true);
  };

  const saveRequirements = async () => {
    const selectedInquiry = filteredData.find(i => selectedRows.has(i.id));
    if (!selectedInquiry) return;

    try {
      const { error } = await supabase
        .from('crm_inquiries')
        .update(requirementsForm)
        .eq('id', selectedInquiry.id);

      if (error) throw error;

      setEditRequirementsModalOpen(false);
      alert('Customer requirements updated successfully!');
      onRefresh();
    } catch (error) {
      console.error('Error updating requirements:', error);
      alert('Failed to update requirements. Please try again.');
    }
  };

  const selectedInquiry = filteredData.find(i => selectedRows.has(i.id));

  return (
    <div className="space-y-4">
      {/* Export/Import Buttons */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            onClick={exportToExcel}
            disabled={exporting || filteredData.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition disabled:opacity-50 disabled:cursor-not-allowed"
            title="Export to Excel (.xlsx)"
          >
            <FileSpreadsheet className="w-3.5 h-3.5" />
            {exporting ? 'Exporting...' : 'Export Excel'}
          </button>
          <button
            onClick={exportToCSV}
            disabled={exporting || filteredData.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition disabled:opacity-50 disabled:cursor-not-allowed"
            title="Export to CSV for Google Sheets"
          >
            <Download className="w-3.5 h-3.5" />
            {exporting ? 'Exporting...' : 'Export CSV'}
          </button>

          {canManage && (
            <>
              <div className="w-px h-8 bg-gray-300 mx-2" />
              <button
                onClick={downloadImportTemplate}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition"
                title="Download Excel template for bulk import"
              >
                <Download className="w-3.5 h-3.5" />
                Download Template
              </button>
              <label className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition cursor-pointer">
                <FileSpreadsheet className="w-3.5 h-3.5" />
                Import Excel
                <input
                  type="file"
                  accept=".xlsx,.xls"
                  onChange={handleImportFile}
                  className="hidden"
                />
              </label>
              {onAddInquiry && (
                <>
                  <div className="w-px h-8 bg-gray-300 mx-2" />
                  <button
                    onClick={onAddInquiry}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-md hover:bg-blue-100 transition"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Add Inquiry
                  </button>
                </>
              )}
            </>
          )}

          <div className="text-sm text-gray-600 ml-2">
            {filteredData.length} {filteredData.length === 1 ? 'inquiry' : 'inquiries'}
            {filters.length > 0 && ' (filtered)'}
            {sortConfig.direction && ' (sorted)'}
          </div>
        </div>
      </div>
      {/* Quick Actions Bar */}
      {selectedRows.size > 0 && canManage && selectedInquiry && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="text-sm font-medium text-blue-900">
                Selected: <span className="font-bold">{selectedInquiry.inquiry_number}</span> - {selectedInquiry.product_name}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleSendQuote}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-md hover:bg-blue-100 transition"
              >
                <Send className="w-3.5 h-3.5" />
                Send Price
              </button>
              <button
                onClick={handleSendCOAMSDS}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded-md hover:bg-green-100 transition"
              >
                <FileText className="w-3.5 h-3.5" />
                Send COA/MSDS
              </button>
              <button
                onClick={handleLogCall}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition"
              >
                <Phone className="w-3.5 h-3.5" />
                Log Call
              </button>
              <button
                onClick={handleScheduleFollowUp}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition"
              >
                <Calendar className="w-3.5 h-3.5" />
                Schedule Follow-up
              </button>
              <button
                onClick={() => setCreateTaskModalOpen(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition"
              >
                <CheckSquare className="w-3.5 h-3.5" />
                Create Task
              </button>
              <button
                onClick={handleEditRequirements}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-purple-700 bg-purple-50 border border-purple-200 rounded-md hover:bg-purple-100 transition"
                title="Edit Customer Requirements"
              >
                <CheckSquare className="w-3.5 h-3.5" />
                Edit Requirements
              </button>
              <button
                onClick={handleDeleteSelected}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-md hover:bg-red-100 transition"
                title="Delete Selected"
              >
                <X className="w-3.5 h-3.5" />
                Delete
              </button>
              <button
                onClick={() => setSelectedRows(new Set())}
                className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-md transition"
                title="Deselect"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Excel-like Table */}
      <div className="bg-white rounded-lg shadow overflow-hidden border border-gray-200">
        <div className="overflow-x-auto overflow-y-auto" style={{ maxHeight: 'calc(100vh - 280px)' }}>
          <table className="w-full text-sm border-collapse">
            <thead className="bg-gray-50">
              <tr className="border-b border-gray-300">
                <th className="px-3 py-2 border-r border-gray-300">
                  <input
                    type="checkbox"
                    checked={selectedRows.size === filteredData.length && filteredData.length > 0}
                    onChange={toggleSelectAll}
                    className="rounded border-gray-300"
                  />
                </th>

                <ResizableHeader column="inquiry_number" label="No." className="whitespace-nowrap" />

                <ResizableHeader column="inquiry_date" label="Date" className="whitespace-nowrap" />

                <ResizableHeader column="product_name" label="Product" />

                <ResizableHeader column="specification" label="Specification" />

                <ResizableHeader column="quantity" label="Qty" />

                <ResizableHeader column="supplier_name" label="Supplier" />

                {/* Company - Sortable with Filter */}
                <th className="px-3 py-2 text-left font-semibold text-gray-700 border-r border-gray-300 min-w-[150px] relative">
                  <div className="flex items-center justify-between gap-2">
                    <span>Company</span>
                    <button
                      onClick={() => setOpenFilter(openFilter === 'company_name' ? null : 'company_name')}
                      className={`p-0.5 rounded hover:bg-gray-200 ${isColumnFiltered('company_name') ? 'text-blue-600' : ''}`}
                    >
                      <ChevronDown className="w-4 h-4" />
                    </button>
                  </div>
                  {openFilter === 'company_name' && (
                    <div ref={filterRef} className="absolute top-full left-0 mt-1 bg-white border border-gray-300 rounded-lg shadow-lg z-50 w-64">
                      <div className="p-2 border-b border-gray-200 flex items-center justify-between">
                        <span className="text-xs font-medium">Filter Company</span>
                        {isColumnFiltered('company_name') && (
                          <button
                            onClick={() => clearColumnFilter('company_name')}
                            className="text-xs text-blue-600 hover:text-blue-700"
                          >
                            Clear
                          </button>
                        )}
                      </div>
                      <div className="p-2 max-h-64 overflow-y-auto">
                        {getUniqueValues('company_name').map(company => {
                          const isSelected = filters.find(f => f.column === 'company_name')?.values.includes(String(company));
                          return (
                            <label key={String(company)} className="flex items-center gap-2 p-1.5 hover:bg-gray-50 rounded cursor-pointer">
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleFilter('company_name', String(company))}
                                className="rounded border-gray-300"
                              />
                              <span className="text-sm">{String(company)}</span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </th>

                <ResizableHeader column="mail_subject" label="Mail Subject" />

                <ResizableHeader column="aceerp_no" label="ACE ERP#" />

                {/* Pipeline Status with filter */}
                <th className="px-3 py-2 text-left font-semibold text-gray-700 border-r border-gray-300 relative min-w-[130px]">
                  <div className="flex items-center justify-between gap-2">
                    <span>Pipeline</span>
                    <button
                      onClick={() => setOpenFilter(openFilter === 'pipeline_status' ? null : 'pipeline_status')}
                      className={`p-0.5 rounded hover:bg-gray-200 ${isColumnFiltered('pipeline_status') ? 'text-blue-600' : ''}`}
                    >
                      <ChevronDown className="w-4 h-4" />
                    </button>
                  </div>
                  {openFilter === 'pipeline_status' && (
                    <div ref={filterRef} className="absolute top-full left-0 mt-1 bg-white border border-gray-300 rounded-lg shadow-lg z-50 w-56">
                      <div className="p-2 border-b border-gray-200 flex items-center justify-between">
                        <span className="text-xs font-medium">Filter Pipeline</span>
                        {isColumnFiltered('pipeline_status') && (
                          <button
                            onClick={() => clearColumnFilter('pipeline_status')}
                            className="text-xs text-blue-600 hover:text-blue-700"
                          >
                            Clear
                          </button>
                        )}
                      </div>
                      <div className="p-2 max-h-64 overflow-y-auto">
                        {pipelineStatusOptions.map(option => {
                          const isSelected = filters.find(f => f.column === 'pipeline_status')?.values.includes(option.value);
                          return (
                            <label key={option.value} className="flex items-center gap-2 p-1.5 hover:bg-gray-50 rounded cursor-pointer">
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleFilter('pipeline_status', option.value)}
                                className="rounded border-gray-300"
                              />
                              <span className="text-sm">{option.label}</span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </th>

                {/* Our Side */}
                <th className="px-3 py-2 text-left font-semibold text-gray-700 border-r border-gray-300 min-w-[120px] relative">
                  <div className="flex items-center justify-between gap-2">
                    <span>Our Side</span>
                    <button
                      onClick={() => setOpenFilter(openFilter === 'our_side' ? null : 'our_side')}
                      className={`p-0.5 rounded hover:bg-gray-200 ${isColumnFiltered('our_side') ? 'text-blue-600' : ''}`}
                    >
                      <ChevronDown className="w-4 h-4" />
                    </button>
                  </div>
                  {openFilter === 'our_side' && (
                    <div ref={filterRef} className="absolute top-full left-0 mt-1 bg-white border border-gray-300 rounded-lg shadow-lg z-50 w-56">
                      <div className="p-2 border-b border-gray-200 flex items-center justify-between">
                        <span className="text-xs font-medium">Filter Our Side</span>
                        {isColumnFiltered('our_side') && (
                          <button
                            onClick={() => clearColumnFilter('our_side')}
                            className="text-xs text-blue-600 hover:text-blue-700"
                          >
                            Clear
                          </button>
                        )}
                      </div>
                      <div className="p-2 space-y-1">
                        <button
                          onClick={() => {
                            const pricePendingInquiries = inquiries.filter(i =>
                              (i.price_required ?? true) && !i.price_sent_at
                            );
                            setFilteredData(pricePendingInquiries);
                            setOpenFilter(null);
                          }}
                          className="w-full flex items-center gap-2 p-2 hover:bg-red-50 rounded text-left text-sm"
                        >
                          <span className="w-5 h-5 rounded bg-red-100 text-red-700 flex items-center justify-center font-bold text-xs">P</span>
                          <span>Price Pending</span>
                        </button>
                        <button
                          onClick={() => {
                            const coaPendingInquiries = inquiries.filter(i =>
                              (i.coa_required ?? true) && !i.coa_sent_at
                            );
                            setFilteredData(coaPendingInquiries);
                            setOpenFilter(null);
                          }}
                          className="w-full flex items-center gap-2 p-2 hover:bg-red-50 rounded text-left text-sm"
                        >
                          <span className="w-5 h-5 rounded bg-red-100 text-red-700 flex items-center justify-center font-bold text-xs">C</span>
                          <span>COA Pending</span>
                        </button>
                        <button
                          onClick={() => {
                            const priceSentInquiries = inquiries.filter(i =>
                              (i.price_required ?? true) && i.price_sent_at
                            );
                            setFilteredData(priceSentInquiries);
                            setOpenFilter(null);
                          }}
                          className="w-full flex items-center gap-2 p-2 hover:bg-green-50 rounded text-left text-sm"
                        >
                          <span className="w-5 h-5 rounded bg-green-100 text-green-700 flex items-center justify-center font-bold text-xs">P</span>
                          <span>Price Sent</span>
                        </button>
                        <button
                          onClick={() => {
                            const coaSentInquiries = inquiries.filter(i =>
                              (i.coa_required ?? true) && i.coa_sent_at
                            );
                            setFilteredData(coaSentInquiries);
                            setOpenFilter(null);
                          }}
                          className="w-full flex items-center gap-2 p-2 hover:bg-green-50 rounded text-left text-sm"
                        >
                          <span className="w-5 h-5 rounded bg-green-100 text-green-700 flex items-center justify-center font-bold text-xs">C</span>
                          <span>COA Sent</span>
                        </button>
                      </div>
                    </div>
                  )}
                </th>

                {profile?.role === 'admin' && (
                  <th
                    style={{ width: columnWidths.purchase_price, minWidth: columnWidths.purchase_price }}
                    className="relative px-3 py-2 text-left font-semibold text-gray-700 border-r border-gray-300"
                  >
                    <span>P.Price</span>
                    <div
                      className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-blue-400"
                      onMouseDown={(e) => handleResizeStart('purchase_price', e)}
                    />
                  </th>
                )}

                <th
                  style={{ width: columnWidths.offered_price, minWidth: columnWidths.offered_price }}
                  className="relative px-3 py-2 text-left font-semibold text-gray-700 border-r border-gray-300"
                >
                  <span>O.Price</span>
                  <div
                    className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-blue-400"
                    onMouseDown={(e) => handleResizeStart('offered_price', e)}
                  />
                </th>

                <th
                  style={{ width: columnWidths.delivery_date, minWidth: columnWidths.delivery_date }}
                  className="relative px-3 py-2 text-left font-semibold text-gray-700 border-r border-gray-300"
                >
                  <span>Delivery</span>
                  <div
                    className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-blue-400"
                    onMouseDown={(e) => handleResizeStart('delivery_date', e)}
                  />
                </th>

                {/* Priority with filter */}
                <th className="px-3 py-2 text-left font-semibold text-gray-700 border-r border-gray-300 relative">
                  <div className="flex items-center justify-between gap-2">
                    <span>Priority</span>
                    <button
                      onClick={() => setOpenFilter(openFilter === 'priority' ? null : 'priority')}
                      className={`p-0.5 rounded hover:bg-gray-200 ${isColumnFiltered('priority') ? 'text-blue-600' : ''}`}
                    >
                      <ChevronDown className="w-4 h-4" />
                    </button>
                  </div>
                  {openFilter === 'priority' && (
                    <div ref={filterRef} className="absolute top-full left-0 mt-1 bg-white border border-gray-300 rounded-lg shadow-lg z-50 w-48">
                      <div className="p-2 border-b border-gray-200 flex items-center justify-between">
                        <span className="text-xs font-medium">Filter Priority</span>
                        {isColumnFiltered('priority') && (
                          <button
                            onClick={() => clearColumnFilter('priority')}
                            className="text-xs text-blue-600 hover:text-blue-700"
                          >
                            Clear
                          </button>
                        )}
                      </div>
                      <div className="p-2">
                        {priorityOptions.map(option => {
                          const isSelected = filters.find(f => f.column === 'priority')?.values.includes(option.value);
                          return (
                            <label key={option.value} className="flex items-center gap-2 p-1.5 hover:bg-gray-50 rounded cursor-pointer">
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleFilter('priority', option.value)}
                                className="rounded border-gray-300"
                              />
                              {option.icon}
                              <span className="text-sm">{option.label}</span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </th>

                <ResizableHeader column="remarks" label="Remarks" />
              </tr>
            </thead>
            <tbody>
              {filteredData.length === 0 ? (
                <tr>
                  <td colSpan={18} className="px-3 py-8 text-center text-gray-500">
                    No inquiries found
                  </td>
                </tr>
              ) : (
                filteredData.map((inquiry) => (
                  <tr
                    key={inquiry.id}
                    className={`border-b border-gray-200 hover:bg-blue-50 transition ${
                      selectedRows.has(inquiry.id) ? 'bg-blue-100' : ''
                    }`}
                  >
                    <td className="px-3 py-2 border-r border-gray-200">
                      <input
                        type="checkbox"
                        checked={selectedRows.has(inquiry.id)}
                        onChange={() => toggleRowSelection(inquiry.id)}
                        className="rounded border-gray-300"
                      />
                    </td>

                    <td className="px-3 py-2 border-r border-gray-200 font-medium text-blue-600">
                      {inquiry.inquiry_number}
                    </td>

                    <td className="px-3 py-2 border-r border-gray-200 text-gray-600 whitespace-nowrap">
                      {new Date(inquiry.inquiry_date).toLocaleDateString('en-GB', {
                        day: '2-digit',
                        month: 'short',
                        year: 'numeric'
                      })}
                    </td>

                    <td className="px-3 py-2 border-r border-gray-200">
                      {editingCell?.id === inquiry.id && editingCell?.field === 'product_name' ? (
                        <input
                          type="text"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={saveEdit}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveEdit();
                            if (e.key === 'Escape') setEditingCell(null);
                          }}
                          className="w-full px-2 py-1 border-2 border-blue-500 rounded focus:outline-none"
                          autoFocus
                        />
                      ) : (
                        <div
                          onDoubleClick={() => startEditing(inquiry, 'product_name')}
                          className="cursor-text hover:bg-yellow-50 px-2 py-1 rounded"
                        >
                          {inquiry.product_name}
                        </div>
                      )}
                    </td>

                    <td className="px-3 py-2 border-r border-gray-200 text-gray-600 text-xs">
                      {editingCell?.id === inquiry.id && editingCell?.field === 'specification' ? (
                        <input
                          type="text"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={saveEdit}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveEdit();
                            if (e.key === 'Escape') setEditingCell(null);
                          }}
                          className="w-full px-2 py-1 border-2 border-blue-500 rounded focus:outline-none text-xs"
                          autoFocus
                        />
                      ) : (
                        <div
                          onDoubleClick={() => startEditing(inquiry, 'specification')}
                          className="cursor-text hover:bg-yellow-50 px-2 py-1 rounded"
                        >
                          {inquiry.specification || '-'}
                        </div>
                      )}
                    </td>

                    <td className="px-3 py-2 border-r border-gray-200">
                      {editingCell?.id === inquiry.id && editingCell?.field === 'quantity' ? (
                        <input
                          type="text"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={saveEdit}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveEdit();
                            if (e.key === 'Escape') setEditingCell(null);
                          }}
                          className="w-full px-2 py-1 border-2 border-blue-500 rounded focus:outline-none"
                          autoFocus
                        />
                      ) : (
                        <div
                          onDoubleClick={() => startEditing(inquiry, 'quantity')}
                          className="cursor-text hover:bg-yellow-50 px-2 py-1 rounded"
                        >
                          {inquiry.quantity}
                        </div>
                      )}
                    </td>

                    <td className="px-3 py-2 border-r border-gray-200">
                      {editingCell?.id === inquiry.id && editingCell?.field === 'supplier_name' ? (
                        <input
                          type="text"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={saveEdit}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveEdit();
                            if (e.key === 'Escape') setEditingCell(null);
                          }}
                          className="w-full px-2 py-1 border-2 border-blue-500 rounded focus:outline-none"
                          autoFocus
                        />
                      ) : (
                        <div
                          onDoubleClick={() => startEditing(inquiry, 'supplier_name')}
                          className="cursor-text hover:bg-yellow-50 px-2 py-1 rounded"
                        >
                          <div>{inquiry.supplier_name || '-'}</div>
                          {inquiry.supplier_country && (
                            <div className="text-xs text-gray-500">{inquiry.supplier_country}</div>
                          )}
                        </div>
                      )}
                    </td>

                    {/* Company */}
                    <td className="px-3 py-2 border-r border-gray-200">
                      <div className="font-medium">{inquiry.company_name}</div>
                    </td>

                    {/* Mail Subject */}
                    <td className="px-3 py-2 border-r border-gray-200">
                      {editingCell?.id === inquiry.id && editingCell?.field === 'mail_subject' ? (
                        <input
                          type="text"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={saveEdit}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveEdit();
                            if (e.key === 'Escape') setEditingCell(null);
                          }}
                          className="w-full px-2 py-1 border-2 border-blue-500 rounded focus:outline-none text-xs"
                          autoFocus
                        />
                      ) : (
                        <div
                          onDoubleClick={() => startEditing(inquiry, 'mail_subject')}
                          className="cursor-text hover:bg-yellow-50 px-2 py-1 rounded text-xs"
                          title={inquiry.mail_subject || ''}
                        >
                          {inquiry.mail_subject ? (
                            <div className="line-clamp-2">{inquiry.mail_subject}</div>
                          ) : (
                            <span className="text-gray-400">-</span>
                          )}
                        </div>
                      )}
                    </td>

                    {/* ACE ERP No */}
                    <td className="px-3 py-2 border-r border-gray-200">
                      {editingCell?.id === inquiry.id && editingCell?.field === 'aceerp_no' ? (
                        <input
                          type="text"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={saveEdit}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveEdit();
                            if (e.key === 'Escape') setEditingCell(null);
                          }}
                          className="w-full px-2 py-1 border-2 border-blue-500 rounded focus:outline-none"
                          autoFocus
                        />
                      ) : (
                        <div
                          onDoubleClick={() => canManage && startEditing(inquiry, 'aceerp_no')}
                          className={canManage ? "cursor-text hover:bg-yellow-50 px-2 py-1 rounded" : "px-2 py-1"}
                        >
                          {inquiry.aceerp_no || (canManage ? <span className="text-gray-400 text-xs">Click to add</span> : '-')}
                        </div>
                      )}
                    </td>

                    {/* Pipeline Status */}
                    <td className="px-3 py-2 border-r border-gray-200">
                      <select
                        value={inquiry.pipeline_status || 'new'}
                        onChange={(e) => updatePipelineStatus(inquiry, e.target.value)}
                        disabled={!canManage}
                        className="w-full px-2 py-1 border border-gray-300 rounded text-xs focus:border-blue-500 focus:outline-none cursor-pointer bg-white"
                      >
                        {pipelineStatusOptions.map(opt => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                    </td>

                    {/* Our Side */}
                    <td className="px-3 py-2 border-r border-gray-200">
                      <div className="flex items-center justify-center">
                        <OurSideChips
                          inquiry={inquiry}
                          onMarkSent={canManage ? (type) => markRequirementSent(inquiry, type) : undefined}
                        />
                      </div>
                    </td>

                    {/* Purchase Price (Admin Only) */}
                    {profile?.role === 'admin' && (
                      <td className="px-3 py-2 border-r border-gray-200">
                        {editingCell?.id === inquiry.id && editingCell?.field === 'purchase_price' ? (
                          <input
                            type="text"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={saveEdit}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') saveEdit();
                              if (e.key === 'Escape') setEditingCell(null);
                            }}
                            className="w-full px-2 py-1 border-2 border-blue-500 rounded focus:outline-none text-xs"
                            autoFocus
                            placeholder="Click to add"
                          />
                        ) : (
                          <div
                            onDoubleClick={() => startEditing(inquiry, 'purchase_price')}
                            className="cursor-text hover:bg-yellow-50 px-2 py-1 rounded text-xs"
                          >
                            {inquiry.purchase_price ?
                              `$${inquiry.purchase_price.toLocaleString('en-US', { minimumFractionDigits: 2 })}` :
                              <span className="text-gray-400">Click to add</span>
                            }
                          </div>
                        )}
                      </td>
                    )}

                    {/* Offered Price */}
                    <td className="px-3 py-2 border-r border-gray-200">
                      {editingCell?.id === inquiry.id && editingCell?.field === 'offered_price' ? (
                        <input
                          type="text"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={saveEdit}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveEdit();
                            if (e.key === 'Escape') setEditingCell(null);
                          }}
                          className="w-full px-2 py-1 border-2 border-blue-500 rounded focus:outline-none text-xs"
                          autoFocus
                          placeholder="Click to add"
                        />
                      ) : (
                        <div
                          onDoubleClick={() => canManage && startEditing(inquiry, 'offered_price')}
                          className={canManage ? "cursor-text hover:bg-yellow-50 px-2 py-1 rounded text-xs" : "px-2 py-1 text-xs"}
                        >
                          {inquiry.offered_price ?
                            `$${inquiry.offered_price.toLocaleString('en-US', { minimumFractionDigits: 2 })}` :
                            (canManage ? <span className="text-gray-400">Click to add</span> : '-')
                          }
                        </div>
                      )}
                    </td>

                    {/* Delivery Date */}
                    <td className="px-3 py-2 border-r border-gray-200">
                      {editingCell?.id === inquiry.id && editingCell?.field === 'delivery_date' ? (
                        <input
                          type="date"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={saveEdit}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveEdit();
                            if (e.key === 'Escape') setEditingCell(null);
                          }}
                          className="w-full px-2 py-1 border-2 border-blue-500 rounded focus:outline-none text-xs"
                          autoFocus
                        />
                      ) : (
                        <div
                          onDoubleClick={() => canManage && startEditing(inquiry, 'delivery_date')}
                          className={canManage ? "cursor-text hover:bg-yellow-50 px-2 py-1 rounded text-xs whitespace-nowrap" : "px-2 py-1 text-xs whitespace-nowrap"}
                        >
                          {inquiry.delivery_date ?
                            new Date(inquiry.delivery_date).toLocaleDateString('en-GB', {
                              day: '2-digit',
                              month: 'short',
                              year: 'numeric'
                            }) :
                            (canManage ? <span className="text-gray-400">Click to add</span> : '-')
                          }
                        </div>
                      )}
                    </td>

                    {/* Priority */}
                    <td className="px-3 py-2 border-r border-gray-200">
                      <select
                        value={inquiry.priority}
                        onChange={(e) => updatePriority(inquiry, e.target.value)}
                        disabled={!canManage}
                        className="w-full px-2 py-1 border border-gray-300 rounded text-xs focus:border-blue-500 focus:outline-none cursor-pointer"
                      >
                        {priorityOptions.map(opt => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                    </td>

                    {/* Remarks */}
                    <td className="px-3 py-2 border-r border-gray-200">
                      {editingCell?.id === inquiry.id && editingCell?.field === 'remarks' ? (
                        <input
                          type="text"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={saveEdit}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveEdit();
                            if (e.key === 'Escape') setEditingCell(null);
                          }}
                          className="w-full px-2 py-1 border-2 border-blue-500 rounded focus:outline-none"
                          autoFocus
                        />
                      ) : (
                        <div
                          onDoubleClick={() => startEditing(inquiry, 'remarks')}
                          className="cursor-text hover:bg-yellow-50 px-2 py-1 rounded text-gray-600"
                        >
                          {inquiry.remarks || '-'}
                        </div>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Gmail-like Email Composer Modal */}
      {emailModalOpen && selectedInquiryForEmail && (
        <GmailLikeComposer
          isOpen={emailModalOpen}
          onClose={() => {
            setEmailModalOpen(false);
            setSelectedInquiryForEmail(null);
            onRefresh();
          }}
          inquiry={selectedInquiryForEmail}
        />
      )}

      {/* Log Call Modal */}
      <Modal
        isOpen={logCallModalOpen}
        onClose={() => {
          setLogCallModalOpen(false);
          setCallNotes('');
        }}
        title="Log Phone Call"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Call Notes *
            </label>
            <textarea
              value={callNotes}
              onChange={(e) => setCallNotes(e.target.value)}
              rows={4}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              placeholder="What was discussed during the call?"
              required
            />
          </div>
          <div className="flex justify-end gap-3">
            <button
              onClick={() => {
                setLogCallModalOpen(false);
                setCallNotes('');
              }}
              className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={saveLogCall}
              disabled={!callNotes.trim()}
              className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50"
            >
              Save Call Log
            </button>
          </div>
        </div>
      </Modal>

      {/* Schedule Follow-up Modal */}
      <Modal
        isOpen={followUpModalOpen}
        onClose={() => {
          setFollowUpModalOpen(false);
          setFollowUpDate('');
          setFollowUpNotes('');
        }}
        title="Schedule Follow-up"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Follow-up Date *
            </label>
            <input
              type="date"
              value={followUpDate}
              onChange={(e) => setFollowUpDate(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Notes
            </label>
            <textarea
              value={followUpNotes}
              onChange={(e) => setFollowUpNotes(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              placeholder="What needs to be followed up?"
            />
          </div>
          <div className="flex justify-end gap-3">
            <button
              onClick={() => {
                setFollowUpModalOpen(false);
                setFollowUpDate('');
                setFollowUpNotes('');
              }}
              className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={saveFollowUp}
              disabled={!followUpDate}
              className="px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 disabled:opacity-50"
            >
              Schedule Follow-up
            </button>
          </div>
        </div>
      </Modal>

      {/* Create Task Modal */}
      {createTaskModalOpen && selectedInquiry && (
        <TaskFormModal
          isOpen={createTaskModalOpen}
          onClose={() => setCreateTaskModalOpen(false)}
          onSuccess={() => {
            setCreateTaskModalOpen(false);
            onRefresh();
          }}
          initialData={{
            inquiry_id: selectedInquiry.id
          }}
        />
      )}

      {/* Lost Reason Modal */}
      {inquiryToMarkLost && (
        <LostReasonModal
          isOpen={lostReasonModalOpen}
          onClose={() => {
            setLostReasonModalOpen(false);
            setInquiryToMarkLost(null);
          }}
          inquiryId={inquiryToMarkLost.id}
          inquiryNumber={inquiryToMarkLost.inquiry_number}
          onSuccess={() => {
            onRefresh();
            setInquiryToMarkLost(null);
          }}
        />
      )}

      {/* Offered Price Modal */}
      <Modal
        isOpen={offeredPriceModalOpen}
        onClose={() => {
          setOfferedPriceModalOpen(false);
          setInquiryForOfferedPrice(null);
          setOfferedPriceInput('');
        }}
        title="Enter Offered Price"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Inquiry: {inquiryForOfferedPrice?.inquiry_number || '-'}
            </label>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Product: {inquiryForOfferedPrice?.product_name || '-'}
            </label>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Offered Price (O.Price) *
            </label>
            <input
              type="number"
              value={offeredPriceInput}
              onChange={(e) => setOfferedPriceInput(e.target.value)}
              placeholder="Enter offered price"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              step="0.01"
              min="0"
            />
            <p className="mt-1 text-xs text-gray-500">
              Enter the price you offered to the customer
            </p>
          </div>

          <div className="flex justify-end gap-3 mt-6">
            <button
              onClick={() => {
                setOfferedPriceModalOpen(false);
                setInquiryForOfferedPrice(null);
                setOfferedPriceInput('');
              }}
              className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200"
            >
              Cancel
            </button>
            <button
              onClick={saveOfferedPriceAndMarkSent}
              className="px-4 py-2 text-white bg-blue-600 rounded-lg hover:bg-blue-700"
            >
              Save & Mark Price as Sent
            </button>
          </div>
        </div>
      </Modal>

      {/* Edit Requirements Modal */}
      <Modal
        isOpen={editRequirementsModalOpen}
        onClose={() => setEditRequirementsModalOpen(false)}
        title="Edit Customer Requirements"
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            Check what the customer has requested:
          </p>
          <div className="space-y-3">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={requirementsForm.price_required}
                onChange={(e) => setRequirementsForm({ ...requirementsForm, price_required: e.target.checked })}
                className="w-5 h-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm font-medium text-gray-700">Price</span>
            </label>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={requirementsForm.coa_required}
                onChange={(e) => setRequirementsForm({ ...requirementsForm, coa_required: e.target.checked })}
                className="w-5 h-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm font-medium text-gray-700">COA</span>
            </label>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={requirementsForm.sample_required}
                onChange={(e) => setRequirementsForm({ ...requirementsForm, sample_required: e.target.checked })}
                className="w-5 h-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm font-medium text-gray-700">Sample</span>
            </label>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={requirementsForm.agency_letter_required}
                onChange={(e) => setRequirementsForm({ ...requirementsForm, agency_letter_required: e.target.checked })}
                className="w-5 h-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm font-medium text-gray-700">Agency Letter</span>
            </label>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={requirementsForm.others_required}
                onChange={(e) => setRequirementsForm({ ...requirementsForm, others_required: e.target.checked })}
                className="w-5 h-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm font-medium text-gray-700">Others</span>
            </label>
          </div>
          <div className="flex justify-end gap-2 mt-6 pt-4 border-t">
            <button
              onClick={() => setEditRequirementsModalOpen(false)}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition"
            >
              Cancel
            </button>
            <button
              onClick={saveRequirements}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 transition"
            >
              Save Requirements
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

