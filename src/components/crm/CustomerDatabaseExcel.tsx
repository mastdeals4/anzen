import { useState, useEffect, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { Plus, Download, Upload, Trash2, Send, Search, UserCheck, ChevronUp, ChevronDown, ChevronsUpDown, Filter, X } from 'lucide-react';
import { Modal } from '../Modal';
import { BulkEmailComposer } from './BulkEmailComposer';
import { showToast } from '../ToastNotification';
import { showConfirm } from '../ConfirmDialog';

interface SalesMember {
  id: string;
  name: string;
}

interface Customer {
  id: string;
  company_name: string;
  contact_person: string | null;
  designation: string | null;
  email: string | null;
  mobile: string | null;
  landline: string | null;
  phone: string | null;
  country: string | null;
  city: string | null;
  address: string | null;
  website: string | null;
  customer_type: string | null;
  notes: string | null;
  is_active: boolean;
  created_at: string;
  assigned_sales?: string | null;
  assigned_sales_ids?: string[];
}

interface EditingCell {
  rowId: string;
  field: string;
}

type SortDir = 'asc' | 'desc' | null;

interface ColumnFilter {
  values: Set<string>;
}

const COMPANY_PREFIXES = ['pt ', 'cv ', 'ud ', 'pt. ', 'cv. ', 'ud. ', 'pt.', 'cv.', 'ud.'];

function normalizeForSearch(text: string): string {
  let s = text.toLowerCase().trim();
  for (const prefix of COMPANY_PREFIXES) {
    if (s.startsWith(prefix)) {
      s = s.slice(prefix.length).trim();
      break;
    }
  }
  return s;
}

export function CustomerDatabaseExcel() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingCell, setEditingCell] = useState<EditingCell | null>(null);
  const [editValue, setEditValue] = useState('');
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const [bulkEmailModalOpen, setBulkEmailModalOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>(null);
  const [columnFilters, setColumnFilters] = useState<Record<string, ColumnFilter>>({});
  const [openFilterCol, setOpenFilterCol] = useState<string | null>(null);
  const [tempFilterSearch, setTempFilterSearch] = useState('');
  const [tempFilterValues, setTempFilterValues] = useState<Set<string>>(new Set());
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({
    assigned_sales: 140,
    created_at: 110,
    company_name: 220,
    contact_person: 150,
    designation: 120,
    email: 190,
    mobile: 130,
    landline: 130,
    phone: 130,
    country: 120,
    city: 120,
    address: 200,
    website: 150,
    customer_type: 120,
    notes: 200,
  });
  const [resizing, setResizing] = useState<{ column: string; startX: number; startWidth: number } | null>(null);
  const [salesMembers, setSalesMembers] = useState<SalesMember[]>([]);
  const [assignModal, setAssignModal] = useState<{ contactId: string; contactName: string } | null>(null);
  const [selectedSalesMember, setSelectedSalesMember] = useState('');
  const tableRef = useRef<HTMLDivElement>(null);
  const filterRefs = useRef<Record<string, HTMLDivElement | null>>({});

  useEffect(() => {
    loadCustomers();
    loadSalesMembers();
  }, []);

  useEffect(() => {
    if (resizing) {
      const handleMouseMove = (e: MouseEvent) => {
        const diff = e.clientX - resizing.startX;
        const newWidth = Math.max(80, resizing.startWidth + diff);
        setColumnWidths(prev => ({ ...prev, [resizing.column]: newWidth }));
      };
      const handleMouseUp = () => setResizing(null);
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [resizing]);

  useEffect(() => {
    if (!openFilterCol) return;
    const handleClick = (e: MouseEvent) => {
      const ref = filterRefs.current[openFilterCol];
      if (ref && !ref.contains(e.target as Node)) {
        setOpenFilterCol(null);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [openFilterCol]);

  const loadCustomers = async () => {
    try {
      const [contactsRes, assignmentsRes] = await Promise.all([
        supabase.from('crm_contacts').select('*').order('company_name'),
        supabase.from('customer_assignments')
          .select('crm_contact_id, sales_member_id, sales_team_members(name)')
          .eq('is_active', true)
          .not('crm_contact_id', 'is', null),
      ]);

      if (contactsRes.error) throw contactsRes.error;

      const assignmentMap: Record<string, { names: string[]; ids: string[] }> = {};
      (assignmentsRes.data || []).forEach((a: any) => {
        if (a.crm_contact_id && a.sales_team_members?.name) {
          if (!assignmentMap[a.crm_contact_id]) {
            assignmentMap[a.crm_contact_id] = { names: [], ids: [] };
          }
          assignmentMap[a.crm_contact_id].names.push(a.sales_team_members.name);
          assignmentMap[a.crm_contact_id].ids.push(a.sales_member_id);
        }
      });

      const enriched = (contactsRes.data || []).map((c: any) => ({
        ...c,
        assigned_sales: assignmentMap[c.id]?.names.join(', ') || null,
        assigned_sales_ids: assignmentMap[c.id]?.ids || [],
      }));

      setCustomers(enriched);
    } catch (error) {
      console.error('Error loading customers:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadSalesMembers = async () => {
    const { data } = await supabase
      .from('sales_team_members')
      .select('id, name')
      .eq('is_active', true)
      .order('name');
    setSalesMembers(data || []);
  };

  const handleAssignSalesMember = async () => {
    if (!assignModal || !selectedSalesMember) return;
    try {
      const { error } = await supabase.from('customer_assignments').upsert({
        crm_contact_id: assignModal.contactId,
        sales_member_id: selectedSalesMember,
        is_active: true,
      }, { onConflict: 'crm_contact_id,sales_member_id' });
      if (error) throw error;
      showToast({ type: 'success', title: 'Assigned', message: 'Salesperson assigned successfully' });
      setAssignModal(null);
      setSelectedSalesMember('');
      loadCustomers();
    } catch (err: any) {
      showToast({ type: 'error', title: 'Error', message: err.message });
    }
  };

  const handleCellDoubleClick = (customer: Customer, field: string) => {
    if (field === 'assigned_sales' || field === 'created_at') return;
    setEditingCell({ rowId: customer.id, field });
    setEditValue((customer[field as keyof Customer] as string) || '');
  };

  const handleCellBlur = async () => {
    if (!editingCell) return;
    try {
      const { error } = await supabase
        .from('crm_contacts')
        .update({ [editingCell.field]: editValue || null })
        .eq('id', editingCell.rowId);
      if (error) throw error;
      setCustomers(prev =>
        prev.map(c =>
          c.id === editingCell.rowId ? { ...c, [editingCell.field]: editValue || null } : c
        )
      );
    } catch (error) {
      console.error('Error updating customer:', error);
      showToast({ type: 'error', title: 'Error', message: 'Failed to update customer' });
    } finally {
      setEditingCell(null);
      setEditValue('');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); handleCellBlur(); }
    else if (e.key === 'Escape') { setEditingCell(null); setEditValue(''); }
  };

  const handleAddRow = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');
      const { data, error } = await supabase
        .from('crm_contacts')
        .insert({ company_name: `New Customer ${Date.now()}`, is_active: true, created_by: user.id })
        .select()
        .single();
      if (error) throw error;
      setCustomers(prev => [{ ...data, assigned_sales: null, assigned_sales_ids: [] }, ...prev]);
    } catch (error) {
      console.error('Error adding customer:', error);
      showToast({ type: 'error', title: 'Error', message: 'Failed to add customer' });
    }
  };

  const handleDeleteSelected = async () => {
    if (selectedRows.size === 0) return;
    if (!await showConfirm({ title: 'Confirm', message: `Delete ${selectedRows.size} customer(s)?`, variant: 'danger', confirmLabel: 'Delete' })) return;
    try {
      const { error } = await supabase.from('crm_contacts').delete().in('id', Array.from(selectedRows));
      if (error) throw error;
      setCustomers(prev => prev.filter(c => !selectedRows.has(c.id)));
      setSelectedRows(new Set());
    } catch (error) {
      console.error('Error deleting customers:', error);
      showToast({ type: 'error', title: 'Error', message: 'Failed to delete customers' });
    }
  };

  const toggleRowSelection = (id: string) => {
    setSelectedRows(prev => {
      const newSet = new Set(prev);
      if (newSet.has(id)) newSet.delete(id); else newSet.add(id);
      return newSet;
    });
  };

  const toggleSelectAll = () => {
    if (selectedRows.size === filteredCustomers.length) {
      setSelectedRows(new Set());
    } else {
      setSelectedRows(new Set(filteredCustomers.map(c => c.id)));
    }
  };

  const formatDateForExport = (dateString: string) => {
    const date = new Date(dateString);
    const day = date.getDate().toString().padStart(2, '0');
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const year = date.getFullYear();
    return `${day}-${month}-${year}`;
  };

  const exportToExcel = () => {
    const headers = ['Sales Person', 'Date', 'Company Name', 'Contact Person', 'Designation', 'Email', 'Mobile', 'Landline', 'Phone', 'Country', 'City', 'Address', 'Website', 'Customer Type', 'Notes'];
    const rows = customers.map(c => [
      c.assigned_sales || '',
      formatDateForExport(c.created_at),
      c.company_name,
      c.contact_person || '',
      c.designation || '',
      c.email || '',
      c.mobile || '',
      c.landline || '',
      c.phone || '',
      c.country || '',
      c.city || '',
      c.address || '',
      c.website || '',
      c.customer_type || '',
      c.notes || '',
    ]);
    const csv = [headers, ...rows].map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `customers_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const parseCSVLine = (line: string) => {
    const values: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
        else inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current.trim());
    return values;
  };

  const parseDate = (dateStr: string) => {
    if (!dateStr) return new Date().toISOString();
    const cleaned = dateStr.split(',')[0].trim();
    const formats = [
      /^(\d{1,2})-(\d{1,2})-(\d{4})$/,
      /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
    ];
    for (const format of formats) {
      const match = cleaned.match(format);
      if (match) {
        const [, day, month, year] = match;
        return new Date(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`).toISOString();
      }
    }
    const isoMatch = cleaned.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (isoMatch) return new Date(cleaned).toISOString();
    return new Date().toISOString();
  };

  const handleImportCSV = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const text = await file.text();
      const lines = text.split('\n').filter(line => line.trim());
      if (lines.length < 2) {
        showToast({ type: 'error', title: 'Error', message: 'CSV file is empty or invalid' });
        return;
      }

      const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim().toLowerCase());
      const idx = (name: string) => headers.findIndex(h => h === name);

      const salesPersonIdx = idx('sales person');
      const dateIdx = idx('date');
      const companyIdx = idx('company name');
      const contactIdx = idx('contact person');
      const designationIdx = idx('designation');
      const emailIdx = idx('email');
      const mobileIdx = idx('mobile');
      const landlineIdx = idx('landline');
      const phoneIdx = idx('phone');
      const countryIdx = idx('country');
      const cityIdx = idx('city');
      const addressIdx = idx('address');
      const websiteIdx = idx('website');
      const typeIdx = idx('customer type');
      const notesIdx = idx('notes');

      if (companyIdx === -1) {
        showToast({ type: 'error', title: 'Error', message: 'CSV must have a "Company Name" column' });
        return;
      }

      const salesMembersData = salesMembers.length ? salesMembers : (await supabase.from('sales_team_members').select('id, name').eq('is_active', true)).data || [];

      const toInsert = lines.slice(1).map(line => {
        const v = parseCSVLine(line);
        const companyName = v[companyIdx]?.replace(/"/g, '').trim();
        if (!companyName) return null;
        return {
          company_name: companyName,
          contact_person: contactIdx !== -1 ? v[contactIdx]?.replace(/"/g, '').trim() || null : null,
          designation: designationIdx !== -1 ? v[designationIdx]?.replace(/"/g, '').trim() || null : null,
          email: emailIdx !== -1 ? v[emailIdx]?.replace(/"/g, '').trim() || null : null,
          mobile: mobileIdx !== -1 ? v[mobileIdx]?.replace(/"/g, '').trim() || null : null,
          landline: landlineIdx !== -1 ? v[landlineIdx]?.replace(/"/g, '').trim() || null : null,
          phone: phoneIdx !== -1 ? v[phoneIdx]?.replace(/"/g, '').trim() || null : null,
          country: countryIdx !== -1 ? v[countryIdx]?.replace(/"/g, '').trim() || null : null,
          city: cityIdx !== -1 ? v[cityIdx]?.replace(/"/g, '').trim() || null : null,
          address: addressIdx !== -1 ? v[addressIdx]?.replace(/"/g, '').trim() || null : null,
          website: websiteIdx !== -1 ? v[websiteIdx]?.replace(/"/g, '').trim() || null : null,
          customer_type: typeIdx !== -1 ? v[typeIdx]?.replace(/"/g, '').trim() || null : null,
          notes: notesIdx !== -1 ? v[notesIdx]?.replace(/"/g, '').trim() || null : null,
          is_active: true,
          created_by: user.id,
          created_at: dateIdx !== -1 ? parseDate(v[dateIdx]?.replace(/"/g, '').trim()) : new Date().toISOString(),
          _sales_person: salesPersonIdx !== -1 ? v[salesPersonIdx]?.replace(/"/g, '').trim() || null : null,
        };
      }).filter(Boolean) as any[];

      if (toInsert.length === 0) {
        showToast({ type: 'error', title: 'Error', message: 'No valid customer data found in CSV' });
        return;
      }

      const salesPersonValues = toInsert.map(r => r._sales_person);
      const insertData = toInsert.map(({ _sales_person: _sp, ...rest }) => rest);

      const deduped = new Map<string, any>();
      const dedupedSalesPersons: string[] = [];
      insertData.forEach((row, i) => {
        const key = (row.company_name || '').toLowerCase().trim();
        if (!deduped.has(key)) {
          deduped.set(key, row);
          dedupedSalesPersons.push(salesPersonValues[i]);
        }
      });
      const uniqueData = Array.from(deduped.values());

      const CHUNK = 200;
      let allInserted: any[] = [];
      for (let i = 0; i < uniqueData.length; i += CHUNK) {
        const chunk = uniqueData.slice(i, i + CHUNK);
        const { data: upserted, error } = await supabase
          .from('crm_contacts')
          .upsert(chunk, { onConflict: 'company_name', ignoreDuplicates: false })
          .select();
        if (error) throw error;
        allInserted = allInserted.concat(upserted || []);
      }

      const assignmentsToCreate = allInserted.flatMap((contact: any, i: number) => {
        const spName = dedupedSalesPersons[i];
        if (!spName) return [];
        const member = (salesMembersData as SalesMember[]).find(m => m.name.toLowerCase() === spName.toLowerCase());
        if (!member) return [];
        return [{ crm_contact_id: contact.id, sales_member_id: member.id, is_active: true }];
      });

      if (assignmentsToCreate.length > 0) {
        await supabase.from('customer_assignments').upsert(assignmentsToCreate, { onConflict: 'crm_contact_id,sales_member_id' });
      }

      showToast({ type: 'success', title: 'Success', message: `Imported ${uniqueData.length} customer(s)${assignmentsToCreate.length ? `, assigned ${assignmentsToCreate.length} salesperson(s)` : ''}` });
      loadCustomers();
    } catch (error) {
      console.error('Error importing CSV:', error);
      showToast({ type: 'error', title: 'Error', message: 'Failed to import CSV. Please check the file format.' });
    }
    e.target.value = '';
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const day = date.getDate().toString().padStart(2, '0');
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const year = date.getFullYear();
    return `${day}-${month}-${year}`;
  };

  const COLUMNS = [
    { key: 'assigned_sales', label: 'Sales Person' },
    { key: 'created_at', label: 'Date' },
    { key: 'company_name', label: 'Company Name' },
    { key: 'contact_person', label: 'Contact Person' },
    { key: 'designation', label: 'Designation' },
    { key: 'email', label: 'Email' },
    { key: 'mobile', label: 'Mobile' },
    { key: 'landline', label: 'Landline' },
    { key: 'phone', label: 'Phone' },
    { key: 'country', label: 'Country' },
    { key: 'city', label: 'City' },
    { key: 'address', label: 'Address' },
    { key: 'website', label: 'Website' },
    { key: 'customer_type', label: 'Type' },
    { key: 'notes', label: 'Notes' },
  ];

  const getColValue = (c: Customer, key: string): string => {
    if (key === 'created_at') return formatDate(c.created_at);
    if (key === 'assigned_sales') return c.assigned_sales || '';
    return (c[key as keyof Customer] as string) || '';
  };

  const getUniqueValues = (key: string): string[] => {
    const vals = Array.from(new Set(customers.map(c => getColValue(c, key)).filter(Boolean)));
    return vals.sort();
  };

  const openFilter = (key: string) => {
    const existing = columnFilters[key]?.values || new Set<string>();
    setTempFilterValues(new Set(existing));
    setTempFilterSearch('');
    setOpenFilterCol(key);
  };

  const applyFilter = (key: string) => {
    setColumnFilters(prev => {
      const next = { ...prev };
      if (tempFilterValues.size === 0) {
        delete next[key];
      } else {
        next[key] = { values: new Set(tempFilterValues) };
      }
      return next;
    });
    setOpenFilterCol(null);
  };

  const clearFilter = (key: string) => {
    setColumnFilters(prev => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const handleSort = (key: string) => {
    if (sortCol === key) {
      if (sortDir === 'asc') setSortDir('desc');
      else if (sortDir === 'desc') { setSortCol(null); setSortDir(null); }
      else setSortDir('asc');
    } else {
      setSortCol(key);
      setSortDir('asc');
    }
  };

  const filteredCustomers = (() => {
    let result = [...customers];

    if (searchTerm.trim()) {
      const norm = normalizeForSearch(searchTerm);
      result = result.filter(c =>
        normalizeForSearch(c.company_name || '').includes(norm) ||
        (c.contact_person?.toLowerCase().includes(norm)) ||
        (c.email?.toLowerCase().includes(norm)) ||
        (c.city?.toLowerCase().includes(norm)) ||
        (c.assigned_sales?.toLowerCase().includes(norm))
      );
    }

    Object.entries(columnFilters).forEach(([key, filter]) => {
      if (filter.values.size > 0) {
        result = result.filter(c => filter.values.has(getColValue(c, key)));
      }
    });

    if (sortCol && sortDir) {
      result.sort((a, b) => {
        const av = getColValue(a, sortCol).toLowerCase();
        const bv = getColValue(b, sortCol).toLowerCase();
        const cmp = av.localeCompare(bv, undefined, { numeric: true });
        return sortDir === 'asc' ? cmp : -cmp;
      });
    }

    return result;
  })();

  const hasActiveFilters = searchTerm || Object.keys(columnFilters).length > 0;

  const renderCell = (customer: Customer, field: keyof Customer) => {
    const isEditing = editingCell?.rowId === customer.id && editingCell?.field === field;
    const value = customer[field];

    if (field === 'created_at') {
      return (
        <div className="px-2 py-1 h-full flex items-center">
          <span className="truncate text-xs">{formatDate(customer.created_at)}</span>
        </div>
      );
    }

    if (isEditing) {
      return (
        <input
          type="text"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={handleCellBlur}
          onKeyDown={handleKeyDown}
          autoFocus
          className="w-full h-full px-2 py-1 border-2 border-blue-500 focus:outline-none bg-white"
        />
      );
    }

    return (
      <div
        onDoubleClick={() => handleCellDoubleClick(customer, field as string)}
        className="px-2 py-1 cursor-cell hover:bg-gray-50 h-full flex items-center"
        title="Double-click to edit"
      >
        {field === 'is_active' ? (
          <span className={`px-2 py-0.5 rounded text-xs ${value ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-700'}`}>
            {value ? 'Active' : 'Inactive'}
          </span>
        ) : field === 'customer_type' && value ? (
          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
            value === 'active' ? 'bg-green-100 text-green-700' :
            value === 'vip' ? 'bg-amber-100 text-amber-700' :
            value === 'inactive' ? 'bg-red-100 text-red-700' :
            'bg-gray-100 text-gray-700'
          }`}>
            {String(value)}
          </span>
        ) : (
          <span className="truncate">{value?.toString() || '-'}</span>
        )}
      </div>
    );
  };

  const startResize = (e: React.MouseEvent, column: string) => {
    e.preventDefault();
    setResizing({ column, startX: e.clientX, startWidth: columnWidths[column] });
  };

  const handleBulkEmail = () => {
    const contactsWithEmail = Array.from(selectedRows)
      .map(id => customers.find(c => c.id === id))
      .filter((c): c is Customer => !!c && !!c.email);
    if (contactsWithEmail.length === 0) {
      showToast({ type: 'warning', title: 'Warning', message: 'Please select customers with email addresses' });
      return;
    }
    setBulkEmailModalOpen(true);
  };

  const getSelectedCustomersForEmail = () => {
    return Array.from(selectedRows)
      .map(id => customers.find(c => c.id === id))
      .filter((c): c is Customer => !!c && !!c.email)
      .map(c => ({ id: c.id, company_name: c.company_name, email: c.email!, contact_person: c.contact_person }));
  };

  if (loading) {
    return <div className="flex items-center justify-center h-64">Loading customers...</div>;
  }

  return (
    <div className="flex flex-col h-full bg-white rounded-lg shadow">
      <div className="flex flex-col gap-3 px-4 py-3 border-b border-gray-200">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              onClick={handleAddRow}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-md hover:bg-blue-100 transition"
            >
              <Plus className="w-3.5 h-3.5" />
              Add Customer
            </button>
            {selectedRows.size > 0 && (
              <>
                <button
                  onClick={handleBulkEmail}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-green-600 border border-green-700 rounded-md hover:bg-green-700 transition"
                >
                  <Send className="w-3.5 h-3.5" />
                  Send Email ({selectedRows.size})
                </button>
                <button
                  onClick={handleDeleteSelected}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-md hover:bg-red-100 transition"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Delete ({selectedRows.size})
                </button>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition cursor-pointer">
              <Upload className="w-3.5 h-3.5" />
              Import CSV
              <input type="file" accept=".csv" onChange={handleImportCSV} className="hidden" />
            </label>
            <button
              onClick={exportToExcel}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition"
            >
              <Download className="w-3.5 h-3.5" />
              Export CSV
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex-1 relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search by company (PT/CV skipped), contact, email, city..."
              className="w-full pl-10 pr-3 py-2 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          {hasActiveFilters && (
            <button
              onClick={() => { setSearchTerm(''); setColumnFilters({}); }}
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-red-600 bg-red-50 border border-red-200 rounded-md hover:bg-red-100 transition"
            >
              <X className="w-3.5 h-3.5" />
              Clear All Filters
            </button>
          )}
        </div>

        {Object.keys(columnFilters).length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(columnFilters).map(([key, filter]) => {
              const col = COLUMNS.find(c => c.key === key);
              return (
                <span key={key} className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-blue-100 text-blue-800 rounded-full">
                  <Filter className="w-3 h-3" />
                  {col?.label}: {Array.from(filter.values).join(', ')}
                  <button onClick={() => clearFilter(key)} className="ml-0.5 hover:text-blue-900">
                    <X className="w-3 h-3" />
                  </button>
                </span>
              );
            })}
          </div>
        )}
      </div>

      <div ref={tableRef} className="flex-1 overflow-auto" style={{ maxHeight: 'calc(100vh - 260px)' }}>
        <table className="w-full border-collapse">
          <thead className="sticky top-0 bg-gray-50 z-10">
            <tr>
              <th className="border border-gray-300 px-2 py-2 bg-gray-100 w-10">
                <input
                  type="checkbox"
                  checked={selectedRows.size === filteredCustomers.length && filteredCustomers.length > 0}
                  onChange={toggleSelectAll}
                  className="rounded"
                />
              </th>
              {COLUMNS.map(({ key, label }) => {
                const isFiltered = !!columnFilters[key];
                const isSorted = sortCol === key;
                return (
                  <th
                    key={key}
                    className="border border-gray-300 bg-gray-100 text-left text-xs font-semibold text-gray-700 relative"
                    style={{ width: columnWidths[key], minWidth: columnWidths[key] }}
                  >
                    <div className="flex items-center px-2 py-1.5 gap-1">
                      <button
                        onClick={() => handleSort(key)}
                        className="flex items-center gap-0.5 flex-1 min-w-0 hover:text-blue-600 transition"
                        title="Click to sort"
                      >
                        <span className="truncate">{label}</span>
                        {isSorted ? (
                          sortDir === 'asc' ? <ChevronUp className="w-3 h-3 flex-shrink-0 text-blue-600" /> : <ChevronDown className="w-3 h-3 flex-shrink-0 text-blue-600" />
                        ) : (
                          <ChevronsUpDown className="w-3 h-3 flex-shrink-0 text-gray-400" />
                        )}
                      </button>
                      <div
                        className="relative flex-shrink-0"
                        ref={el => { filterRefs.current[key] = el; }}
                      >
                        <button
                          onClick={() => openFilter(key)}
                          className={`p-0.5 rounded transition ${isFiltered ? 'text-blue-600 bg-blue-100' : 'text-gray-400 hover:text-blue-500 hover:bg-gray-200'}`}
                          title="Filter"
                        >
                          <Filter className="w-3 h-3" />
                        </button>
                        {openFilterCol === key && (
                          <div className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-xl z-50 w-52">
                            <div className="p-2 border-b border-gray-100">
                              <input
                                type="text"
                                value={tempFilterSearch}
                                onChange={e => setTempFilterSearch(e.target.value)}
                                placeholder="Search values..."
                                className="w-full px-2 py-1 text-xs border border-gray-200 rounded focus:ring-1 focus:ring-blue-500"
                                autoFocus
                                onClick={e => e.stopPropagation()}
                              />
                            </div>
                            <div className="max-h-48 overflow-y-auto p-1">
                              {getUniqueValues(key)
                                .filter(v => !tempFilterSearch || v.toLowerCase().includes(tempFilterSearch.toLowerCase()))
                                .map(val => (
                                  <label key={val} className="flex items-center gap-2 px-2 py-1 hover:bg-gray-50 rounded cursor-pointer text-xs">
                                    <input
                                      type="checkbox"
                                      checked={tempFilterValues.has(val)}
                                      onChange={e => {
                                        const next = new Set(tempFilterValues);
                                        if (e.target.checked) next.add(val); else next.delete(val);
                                        setTempFilterValues(next);
                                      }}
                                      className="rounded"
                                    />
                                    <span className="truncate">{val || '(empty)'}</span>
                                  </label>
                                ))}
                            </div>
                            <div className="flex gap-2 p-2 border-t border-gray-100">
                              <button
                                onClick={() => { setTempFilterValues(new Set()); }}
                                className="flex-1 px-2 py-1 text-xs text-gray-600 border border-gray-300 rounded hover:bg-gray-50"
                              >
                                Clear
                              </button>
                              <button
                                onClick={() => applyFilter(key)}
                                className="flex-1 px-2 py-1 text-xs text-white bg-blue-600 rounded hover:bg-blue-700"
                              >
                                Apply
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                    <div
                      onMouseDown={(e) => { e.stopPropagation(); startResize(e, key); }}
                      className="absolute right-0 top-0 bottom-0 w-2 cursor-col-resize z-20"
                      style={{ touchAction: 'none', background: 'transparent' }}
                    >
                      <div className="absolute right-0 top-0 bottom-0 w-0.5 hover:w-1 hover:bg-blue-500 transition-all" />
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {filteredCustomers.length === 0 ? (
              <tr>
                <td colSpan={COLUMNS.length + 1} className="px-4 py-8 text-center text-gray-500 text-sm">
                  No customers found
                </td>
              </tr>
            ) : (
              filteredCustomers.map((customer) => (
                <tr
                  key={customer.id}
                  className={`${selectedRows.has(customer.id) ? 'bg-blue-50' : 'hover:bg-gray-50'} transition`}
                >
                  <td className="border border-gray-300 px-2 py-1 text-center">
                    <input
                      type="checkbox"
                      checked={selectedRows.has(customer.id)}
                      onChange={() => toggleRowSelection(customer.id)}
                      className="rounded"
                    />
                  </td>
                  <td
                    className="border border-gray-300 h-8 px-2 py-1 cursor-pointer hover:bg-blue-50 group"
                    style={{ width: columnWidths.assigned_sales }}
                    onClick={() => { setAssignModal({ contactId: customer.id, contactName: customer.company_name }); setSelectedSalesMember(''); }}
                    title="Click to assign salesperson"
                  >
                    {customer.assigned_sales ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-50 text-blue-700 rounded-full text-xs font-medium">
                        {customer.assigned_sales}
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-gray-400 text-xs group-hover:text-blue-500">
                        <UserCheck className="w-3 h-3" />
                        Assign
                      </span>
                    )}
                  </td>
                  <td className="border border-gray-300 h-8" style={{ width: columnWidths.created_at }}>
                    {renderCell(customer, 'created_at')}
                  </td>
                  <td className="border border-gray-300 h-8" style={{ width: columnWidths.company_name }}>
                    {renderCell(customer, 'company_name')}
                  </td>
                  <td className="border border-gray-300 h-8" style={{ width: columnWidths.contact_person }}>
                    {renderCell(customer, 'contact_person')}
                  </td>
                  <td className="border border-gray-300 h-8" style={{ width: columnWidths.designation }}>
                    {renderCell(customer, 'designation')}
                  </td>
                  <td className="border border-gray-300 h-8" style={{ width: columnWidths.email }}>
                    {renderCell(customer, 'email')}
                  </td>
                  <td className="border border-gray-300 h-8" style={{ width: columnWidths.mobile }}>
                    {renderCell(customer, 'mobile')}
                  </td>
                  <td className="border border-gray-300 h-8" style={{ width: columnWidths.landline }}>
                    {renderCell(customer, 'landline')}
                  </td>
                  <td className="border border-gray-300 h-8" style={{ width: columnWidths.phone }}>
                    {renderCell(customer, 'phone')}
                  </td>
                  <td className="border border-gray-300 h-8" style={{ width: columnWidths.country }}>
                    {renderCell(customer, 'country')}
                  </td>
                  <td className="border border-gray-300 h-8" style={{ width: columnWidths.city }}>
                    {renderCell(customer, 'city')}
                  </td>
                  <td className="border border-gray-300 h-8" style={{ width: columnWidths.address }}>
                    {renderCell(customer, 'address')}
                  </td>
                  <td className="border border-gray-300 h-8" style={{ width: columnWidths.website }}>
                    {renderCell(customer, 'website')}
                  </td>
                  <td className="border border-gray-300 h-8" style={{ width: columnWidths.customer_type }}>
                    {renderCell(customer, 'customer_type')}
                  </td>
                  <td className="border border-gray-300 h-8" style={{ width: columnWidths.notes }}>
                    {renderCell(customer, 'notes')}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="px-4 py-2 border-t border-gray-200 bg-gray-50 text-sm text-gray-600">
        <div className="flex items-center justify-between">
          <span>
            {filteredCustomers.length} customer(s)
            {filteredCustomers.length !== customers.length && ` (filtered from ${customers.length} total)`}
            {selectedRows.size > 0 && ` • ${selectedRows.size} selected`}
          </span>
          <span className="text-xs text-gray-500">Double-click any cell to edit • Click column header to sort • Filter icon to filter</span>
        </div>
      </div>

      <Modal
        isOpen={bulkEmailModalOpen}
        onClose={() => { setBulkEmailModalOpen(false); setSelectedRows(new Set()); }}
        title="Bulk Email"
        size="xl"
        noPadding
      >
        <BulkEmailComposer
          selectedCustomers={getSelectedCustomersForEmail()}
          onClose={() => { setBulkEmailModalOpen(false); setSelectedRows(new Set()); }}
          onComplete={() => { setBulkEmailModalOpen(false); setSelectedRows(new Set()); loadCustomers(); }}
        />
      </Modal>

      {assignModal && (
        <div className="fixed inset-0 bg-black bg-opacity-40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl p-6 max-w-sm w-full">
            <h3 className="text-base font-semibold text-gray-900 mb-1">Assign Salesperson</h3>
            <p className="text-sm text-gray-500 mb-4">{assignModal.contactName}</p>
            <select
              value={selectedSalesMember}
              onChange={e => setSelectedSalesMember(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 mb-4"
            >
              <option value="">Select salesperson...</option>
              {salesMembers.map(m => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setAssignModal(null)}
                className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleAssignSalesMember}
                disabled={!selectedSalesMember}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                Assign
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
