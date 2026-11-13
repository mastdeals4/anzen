import React, { useState, useEffect, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { Download, Upload, Trash2, Send, UserCheck, ChevronUp, ChevronDown, ChevronRight, ChevronsUpDown, Filter, X, Users, Mail, Phone, Archive, RotateCcw, ShieldAlert, CheckCircle2 } from 'lucide-react';
import { Modal } from '../Modal';
import { BulkEmailComposer } from './BulkEmailComposer';
import { showToast } from '../ToastNotification';
import { showConfirm } from '../ConfirmDialog';
import { getUserDisplayMap, resolveUserDisplayName, formatUserDisplay } from '../../services/crm/userResolver';
import {
  batchEvaluateCustomersForDeletion,
  batchArchiveCustomers,
  restoreCustomer,
  deleteCustomerPermanent,
  CustomerDependencyReport,
} from '../../services/crm/customerDeletionService';

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
  created_by?: string | null;
  created_by_name?: string | null;
  updated_at?: string | null;
  updated_by?: string | null;
  updated_by_name?: string | null;
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

export interface CustomerDatabaseExcelProps {
  externalSearch?: string;
  hideToolbarSearchAndAdd?: boolean;
  refreshTrigger?: number;
}

export function CustomerDatabaseExcel({
  externalSearch = '',
  refreshTrigger,
}: CustomerDatabaseExcelProps = {}) {
  const { profile } = useAuth();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingCell, setEditingCell] = useState<EditingCell | null>(null);
  const [editValue, setEditValue] = useState('');
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState<'active' | 'archived' | 'all'>('active');
  const [deleting, setDeleting] = useState(false);
  const [deleteConflictModal, setDeleteConflictModal] = useState<{
    mustArchive: Array<{ id: string; company_name: string; report: CustomerDependencyReport }>;
    safeToDelete: Array<{ id: string; company_name: string }>;
  } | null>(null);
  const [bulkEmailModalOpen, setBulkEmailModalOpen] = useState(false);
  const [sortCol, setSortCol] = useState<string | null>('updated_at');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [columnFilters, setColumnFilters] = useState<Record<string, ColumnFilter>>({});
  const [openFilterCol, setOpenFilterCol] = useState<string | null>(null);
  const [tempFilterSearch, setTempFilterSearch] = useState('');
  const [tempFilterValues, setTempFilterValues] = useState<Set<string>>(new Set());
  const [expandedContactRows, setExpandedContactRows] = useState<Set<string>>(new Set());
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({
    company_name: 240,
    status: 80,
    customer_type: 130,
    city: 110,
    contact_person: 140,
    designation: 120,
    email: 180,
    mobile: 140,
    landline: 120,
    phone: 120,
    assigned_sales: 135,
    notes: 180,
    created_at: 95,
    created_by_name: 140,
    updated_at: 125,
    updated_by_name: 140,
    country: 100,
    address: 180,
    website: 130,
    actions: 80,
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
  }, [refreshTrigger]);

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
      const [contactsRes, assignmentsRes, userMap] = await Promise.all([
        supabase.from('crm_contacts').select('*').order('company_name'),
        supabase.from('customer_assignments')
          .select('crm_contact_id, sales_member_id, sales_team_members(name)')
          .eq('is_active', true)
          .not('crm_contact_id', 'is', null),
        getUserDisplayMap(),
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
        created_by_name: resolveUserDisplayName(c.created_by, userMap),
        updated_by_name: resolveUserDisplayName(c.updated_by, userMap),
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
      const now = new Date().toISOString();
      const actorId = profile?.id || null;
      const { error } = await supabase.from('customer_assignments').upsert({
        crm_contact_id: assignModal.contactId,
        sales_member_id: selectedSalesMember,
        is_active: true,
      }, { onConflict: 'crm_contact_id,sales_member_id' });
      if (error) throw error;

      // Update audit timestamp on customer contact
      await supabase.from('crm_contacts').update({
        updated_at: now,
        updated_by: actorId,
      }).eq('id', assignModal.contactId);

      showToast({ type: 'success', title: 'Assigned', message: 'Salesperson assigned successfully' });
      setAssignModal(null);
      setSelectedSalesMember('');
      loadCustomers();
    } catch (err: any) {
      showToast({ type: 'error', title: 'Error', message: err.message });
    }
  };

  const handleCellDoubleClick = (customer: Customer, field: string) => {
    if (
      field === 'assigned_sales' ||
      field === 'created_at' ||
      field === 'created_by_name' ||
      field === 'updated_at' ||
      field === 'updated_by_name' ||
      field === 'status' ||
      field === 'actions'
    ) return;
    setEditingCell({ rowId: customer.id, field });
    setEditValue((customer[field as keyof Customer] as string) || '');
  };

  const handleCellBlur = async () => {
    if (!editingCell) return;
    try {
      const now = new Date().toISOString();
      const actorId = profile?.id || null;
      const { error } = await supabase
        .from('crm_contacts')
        .update({
          [editingCell.field]: editValue || null,
          updated_at: now,
          updated_by: actorId,
        })
        .eq('id', editingCell.rowId);
      if (error) throw error;

      const actorName = profile ? formatUserDisplay(profile) : 'You';
      setCustomers(prev =>
        prev.map(c =>
          c.id === editingCell.rowId
            ? {
                ...c,
                [editingCell.field]: editValue || null,
                updated_at: now,
                updated_by: actorId,
                updated_by_name: actorName,
              }
            : c
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

  const handleDeleteSelected = async () => {
    if (selectedRows.size === 0 || deleting) return;
    setDeleting(true);
    try {
      const targets = customers
        .filter(c => selectedRows.has(c.id))
        .map(c => ({ id: c.id, company_name: c.company_name }));

      const evaluation = await batchEvaluateCustomersForDeletion(targets);

      if (evaluation.mustArchive.length > 0) {
        setDeleteConflictModal(evaluation);
      } else {
        const confirmed = await showConfirm({
          title: 'Permanent Customer Deletion',
          message: `Permanently delete ${evaluation.safeToDelete.length} customer(s)? These records have NO historical inquiries, emails, or transactions. This action cannot be undone.`,
          variant: 'danger',
          confirmLabel: 'Delete Permanently',
        });
        if (!confirmed) return;

        for (const item of evaluation.safeToDelete) {
          const res = await deleteCustomerPermanent(item.id, item.company_name);
          if (!res.success) throw new Error(res.error);
        }

        setCustomers(prev => prev.filter(c => !selectedRows.has(c.id)));
        setSelectedRows(new Set());
        showToast({
          type: 'success',
          title: 'Deleted',
          message: `Successfully deleted ${evaluation.safeToDelete.length} customer(s).`,
        });
      }
    } catch (error: any) {
      console.error('Error during customer deletion:', error);
      showToast({
        type: 'error',
        title: 'Deletion Error',
        message: error.message || 'Failed to delete selected customer(s).',
      });
    } finally {
      setDeleting(false);
    }
  };

  const handleArchiveConflictConfirm = async () => {
    if (!deleteConflictModal || deleting) return;
    setDeleting(true);
    try {
      const idsToArchive = deleteConflictModal.mustArchive.map(m => m.id);
      const res = await batchArchiveCustomers(idsToArchive, profile?.id);
      if (!res.success) throw new Error(res.error);

      if (deleteConflictModal.safeToDelete.length > 0) {
        for (const item of deleteConflictModal.safeToDelete) {
          await deleteCustomerPermanent(item.id, item.company_name);
        }
      }

      showToast({
        type: 'success',
        title: 'Customer Records Preserved',
        message: `Archived ${idsToArchive.length} customer(s) to protect historical CRM records.${deleteConflictModal.safeToDelete.length > 0 ? ` (${deleteConflictModal.safeToDelete.length} unused records deleted)` : ''}`,
      });

      setDeleteConflictModal(null);
      setSelectedRows(new Set());
      loadCustomers();
    } catch (err: any) {
      showToast({ type: 'error', title: 'Archive Error', message: err.message || 'Failed to archive customer(s).' });
    } finally {
      setDeleting(false);
    }
  };

  const handleRestoreCustomer = async (customer: Customer, e?: React.MouseEvent) => {
    e?.stopPropagation();
    try {
      const res = await restoreCustomer(customer.id, profile?.id);
      if (!res.success) throw new Error(res.error);

      showToast({
        type: 'success',
        title: 'Customer Restored',
        message: `"${customer.company_name}" has been restored to active status.`,
      });
      loadCustomers();
    } catch (err: any) {
      showToast({ type: 'error', title: 'Restore Error', message: err.message || 'Failed to restore customer.' });
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

  const formatDate = (dateString?: string | null) => {
    if (!dateString) return '—';
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return '—';
    const day = date.getDate().toString().padStart(2, '0');
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const year = date.getFullYear();
    return `${day}-${month}-${year}`;
  };

  const formatDateTime = (dateString?: string | null) => {
    if (!dateString) return '—';
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return '—';
    const day = date.getDate().toString().padStart(2, '0');
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const year = date.getFullYear();
    const hours = date.getHours().toString().padStart(2, '0');
    const mins = date.getMinutes().toString().padStart(2, '0');
    return `${day}-${month}-${year} ${hours}:${mins}`;
  };

  const COLUMNS = [
    { key: 'company_name', label: 'Company Name' },
    { key: 'status', label: 'Status' },
    { key: 'customer_type', label: 'Type' },
    { key: 'city', label: 'City' },
    { key: 'contact_person', label: 'Contact Person' },
    { key: 'designation', label: 'Designation' },
    { key: 'email', label: 'Email' },
    { key: 'mobile', label: 'Mobile / WhatsApp' },
    { key: 'landline', label: 'Landline' },
    { key: 'phone', label: 'Phone' },
    { key: 'assigned_sales', label: 'Sales Person' },
    { key: 'updated_at', label: 'Last Updated' },
    { key: 'updated_by_name', label: 'Updated By' },
    { key: 'created_at', label: 'Created Date' },
    { key: 'created_by_name', label: 'Created By' },
    { key: 'notes', label: 'Notes' },
    { key: 'country', label: 'Country' },
    { key: 'address', label: 'Address' },
    { key: 'website', label: 'Website' },
    { key: 'actions', label: 'Actions' },
  ];

  const getColValue = (c: Customer, key: string): string => {
    if (key === 'status') return c.is_active !== false ? 'Active' : 'Archived';
    if (key === 'created_at') return formatDate(c.created_at);
    if (key === 'created_by_name') return c.created_by_name || '';
    if (key === 'updated_at') return c.updated_at ? formatDateTime(c.updated_at) : '';
    if (key === 'updated_by_name') return c.updated_by_name || '';
    if (key === 'assigned_sales') return c.assigned_sales || '';
    if (key === 'actions') return '';
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
    if (key === 'actions') return;
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

    // Status filter (Active / Archived / All)
    if (statusFilter === 'active') {
      result = result.filter(c => c.is_active !== false);
    } else if (statusFilter === 'archived') {
      result = result.filter(c => c.is_active === false);
    }

    const activeSearch = (externalSearch || '').trim();

    if (activeSearch) {
      const norm = normalizeForSearch(activeSearch);
      result = result.filter(c =>
        normalizeForSearch(c.company_name || '').includes(norm) ||
        (c.contact_person?.toLowerCase().includes(norm)) ||
        (c.email?.toLowerCase().includes(norm)) ||
        (c.phone?.includes(norm) || c.mobile?.includes(norm) || c.landline?.includes(norm)) ||
        (c.city?.toLowerCase().includes(norm)) ||
        (c.assigned_sales?.toLowerCase().includes(norm)) ||
        (c.created_by_name?.toLowerCase().includes(norm)) ||
        (c.updated_by_name?.toLowerCase().includes(norm))
      );
    }

    Object.entries(columnFilters).forEach(([key, filter]) => {
      if (filter.values.size > 0) {
        result = result.filter(c => filter.values.has(getColValue(c, key)));
      }
    });

    if (sortCol && sortDir) {
      result.sort((a, b) => {
        if (sortCol === 'updated_at' || sortCol === 'created_at') {
          const aVal = a[sortCol];
          const bVal = b[sortCol];
          const aTime = aVal ? new Date(aVal).getTime() : 0;
          const bTime = bVal ? new Date(bVal).getTime() : 0;
          return sortDir === 'asc' ? aTime - bTime : bTime - aTime;
        }
        const av = getColValue(a, sortCol).toLowerCase();
        const bv = getColValue(b, sortCol).toLowerCase();
        const cmp = av.localeCompare(bv, undefined, { numeric: true });
        return sortDir === 'asc' ? cmp : -cmp;
      });
    }

    return result;
  })();

  const parseCustomerContacts = (c: Customer) => {
    const list: Array<{ name: string; designation: string; email: string; phone: string; isPrimary: boolean }> = [];
    list.push({
      name: c.contact_person || 'Primary Contact',
      designation: c.designation || 'Purchasing / Commercial',
      email: c.email || '',
      phone: c.mobile || c.phone || '',
      isPrimary: true,
    });

    if (c.email && (c.email.includes(';') || c.email.includes(',') || c.email.includes('/'))) {
      const extraEmails = c.email.split(/[;,/]/).map(s => s.trim()).filter(Boolean);
      if (extraEmails.length > 1) {
        extraEmails.slice(1).forEach((em, idx) => {
          list.push({
            name: `Contact Person ${idx + 2}`,
            designation: idx === 0 ? 'Import & Regulatory' : 'Quality Assurance',
            email: em,
            phone: c.landline || c.phone || '',
            isPrimary: false,
          });
        });
      }
    }
    return list;
  };

  const renderCell = (customer: Customer, field: keyof Customer) => {
    const isEditing = editingCell?.rowId === customer.id && editingCell?.field === field;
    const value = customer[field];

    if (field === ('status' as any)) {
      return (
        <div className="px-2 py-0 h-full flex items-center">
          <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border ${
            customer.is_active !== false
              ? 'bg-emerald-50 text-emerald-700 border-emerald-200/70'
              : 'bg-slate-100 text-slate-600 border-slate-300'
          }`}>
            {customer.is_active !== false ? 'Active' : 'Archived'}
          </span>
        </div>
      );
    }

    if (field === 'created_at') {
      return (
        <div className="px-2 py-0 h-full flex items-center" title={customer.created_at ? new Date(customer.created_at).toLocaleString() : ''}>
          <span className="truncate text-[10.5px] text-slate-500 font-mono">{formatDate(customer.created_at)}</span>
        </div>
      );
    }

    if (field === ('created_by_name' as any)) {
      return (
        <div className="px-2 py-0 h-full flex items-center" title={`Created by: ${customer.created_by_name || 'System'}`}>
          <span className="truncate text-[11px] text-slate-700">{customer.created_by_name || '—'}</span>
        </div>
      );
    }

    if (field === ('updated_at' as any)) {
      return (
        <div className="px-2 py-0 h-full flex items-center" title={customer.updated_at ? new Date(customer.updated_at).toLocaleString() : ''}>
          <span className="truncate text-[10.5px] text-slate-600 font-mono">{formatDateTime(customer.updated_at)}</span>
        </div>
      );
    }

    if (field === ('updated_by_name' as any)) {
      return (
        <div className="px-2 py-0 h-full flex items-center" title={`Last updated by: ${customer.updated_by_name || '—'}`}>
          <span className="truncate text-[11px] text-slate-700">{customer.updated_by_name || '—'}</span>
        </div>
      );
    }

    if (field === ('actions' as any)) {
      return (
        <div className="px-1 py-0 h-full flex items-center gap-1">
          {customer.is_active === false ? (
            <button
              type="button"
              onClick={(e) => handleRestoreCustomer(customer, e)}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 transition"
              title="Restore to active customer list"
            >
              <RotateCcw className="w-2.5 h-2.5" />
              Restore
            </button>
          ) : (
            <button
              type="button"
              onClick={async (e) => {
                e.stopPropagation();
                setSelectedRows(new Set([customer.id]));
                setDeleting(true);
                try {
                  const evalRes = await batchEvaluateCustomersForDeletion([{ id: customer.id, company_name: customer.company_name }]);
                  if (evalRes.mustArchive.length > 0) {
                    setDeleteConflictModal(evalRes);
                  } else {
                    const confirmed = await showConfirm({
                      title: 'Permanent Deletion',
                      message: `Permanently delete "${customer.company_name}"? This record has NO historical activities or inquiries. This cannot be undone.`,
                      variant: 'danger',
                      confirmLabel: 'Delete Permanently',
                    });
                    if (confirmed) {
                      const res = await deleteCustomerPermanent(customer.id, customer.company_name);
                      if (!res.success) throw new Error(res.error);
                      showToast({ type: 'success', title: 'Deleted', message: `Deleted ${customer.company_name}` });
                      setCustomers(prev => prev.filter(c => c.id !== customer.id));
                    }
                  }
                } catch (err: any) {
                  showToast({ type: 'error', title: 'Error', message: err.message });
                } finally {
                  setDeleting(false);
                }
              }}
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 transition"
              title="Review deletion / archive"
            >
              <Trash2 className="w-2.5 h-2.5" />
              Delete
            </button>
          )}
        </div>
      );
    }

    if (field === 'assigned_sales') {
      return (
        <div
          onClick={(e) => {
            e.stopPropagation();
            setAssignModal({ contactId: customer.id, contactName: customer.company_name });
            setSelectedSalesMember('');
          }}
          className="cursor-pointer group flex items-center h-full w-full px-2 py-0"
          title="Click to assign salesperson"
        >
          {customer.assigned_sales ? (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-indigo-50 text-indigo-700 border border-indigo-200/70 rounded text-[10px] font-semibold truncate">
              <UserCheck className="w-2.5 h-2.5 flex-shrink-0" />
              <span className="truncate">{customer.assigned_sales}</span>
            </span>
          ) : (
            <span className="flex items-center gap-1 text-slate-400 text-[10px] group-hover:text-blue-600">
              <UserCheck className="w-3 h-3" />
              Assign
            </span>
          )}
        </div>
      );
    }

    if (field === 'mobile') {
      const mob = customer.mobile;
      if (isEditing) {
        return (
          <input name="value" aria-label="Value"
            type="text"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={handleCellBlur}
            onKeyDown={handleKeyDown}
            autoFocus
            className="w-full h-full px-2 py-0 border-2 border-blue-500 focus:outline-none bg-white text-[11px]"
          />
        );
      }
      return (
        <div
          onDoubleClick={() => handleCellDoubleClick(customer, 'mobile')}
          className="flex items-center justify-between gap-1 h-full w-full px-2 py-0 group cursor-cell"
          title="Double-click to edit • WhatsApp quick-action"
        >
          <span className="truncate font-mono text-[11px] text-slate-800">{mob || '—'}</span>
          {mob && (
            <a
              href={`https://wa.me/${mob.replace(/\D/g, '')}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="p-0.5 rounded text-emerald-600 hover:bg-emerald-50 transition flex-shrink-0"
              title={`Chat via WhatsApp with ${customer.company_name} (${mob})`}
            >
              <Phone className="w-3 h-3 text-emerald-600 fill-emerald-600/20" />
            </a>
          )}
        </div>
      );
    }

    if (field === 'email') {
      const email = customer.email;
      if (isEditing) {
        return (
          <input name="value" aria-label="Value"
            type="text"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={handleCellBlur}
            onKeyDown={handleKeyDown}
            autoFocus
            className="w-full h-full px-2 py-0 border-2 border-blue-500 focus:outline-none bg-white text-[11px]"
          />
        );
      }
      return (
        <div
          onDoubleClick={() => handleCellDoubleClick(customer, 'email')}
          className="flex items-center justify-between gap-1 h-full w-full px-2 py-0 group cursor-cell"
          title="Double-click to edit • Click mailto"
        >
          <span className="truncate font-mono text-[11px] text-blue-700 hover:underline">{email || '—'}</span>
          {email && (
            <a
              href={`mailto:${email}`}
              onClick={(e) => e.stopPropagation()}
              className="p-0.5 rounded text-slate-400 hover:text-blue-600 transition flex-shrink-0 opacity-0 group-hover:opacity-100"
              title={`Send email to ${email}`}
            >
              <Mail className="w-3 h-3" />
            </a>
          )}
        </div>
      );
    }

    if (field === 'customer_type') {
      const val = customer.customer_type;
      if (!val) return <div className="px-2 py-0 text-slate-400 text-[11px]">—</div>;
      const lower = val.toLowerCase();
      const badgeClass = lower.includes('pharma')
        ? 'bg-blue-50 text-blue-700 border-blue-200/70'
        : lower.includes('api')
        ? 'bg-purple-50 text-purple-700 border-purple-200/70'
        : lower.includes('dist')
        ? 'bg-amber-50 text-amber-700 border-amber-200/70'
        : 'bg-emerald-50 text-emerald-700 border-emerald-200/70';
      return (
        <div
          onDoubleClick={() => handleCellDoubleClick(customer, 'customer_type')}
          className="px-2 py-0 h-full flex items-center cursor-cell"
          title="Double-click to edit classification"
        >
          <span className={`inline-block px-1.5 py-0.2 rounded text-[10px] font-semibold border ${badgeClass} truncate`}>
            {val}
          </span>
        </div>
      );
    }

    if (field === 'company_name') {
      const isExpanded = expandedContactRows.has(customer.id);
      if (isEditing) {
        return (
          <input name="value" aria-label="Value"
            type="text"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={handleCellBlur}
            onKeyDown={handleKeyDown}
            autoFocus
            className="w-full h-full px-2 py-0 border-2 border-blue-500 focus:outline-none bg-white text-xs font-semibold"
          />
        );
      }
      return (
        <div
          onDoubleClick={() => handleCellDoubleClick(customer, field as string)}
          className="px-2 py-0 cursor-cell hover:bg-slate-50 h-full flex items-center justify-between gap-1.5"
          title="Double-click to edit • Click arrow to view multi-contact cards"
        >
          <span className="truncate font-semibold text-slate-900 text-[11.5px]">{value?.toString() || '-'}</span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setExpandedContactRows(prev => {
                const next = new Set(prev);
                if (next.has(customer.id)) next.delete(customer.id);
                else next.add(customer.id);
                return next;
              });
            }}
            className="p-0.5 rounded text-slate-400 hover:text-blue-600 hover:bg-slate-100 transition flex-shrink-0"
            title={isExpanded ? "Collapse contacts" : "Expand structured contacts (Purchasing, Import, QA)"}
          >
            {isExpanded ? (
              <ChevronDown className="w-3.5 h-3.5 text-blue-600" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      );
    }

    if (isEditing) {
      return (
        <input name="value" aria-label="Value"
          type="text"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={handleCellBlur}
          onKeyDown={handleKeyDown}
          autoFocus
          className="w-full h-full px-2 py-0 border-2 border-blue-500 focus:outline-none bg-white text-[11px]"
        />
      );
    }

    return (
      <div
        onDoubleClick={() => handleCellDoubleClick(customer, field as string)}
        className="px-2 py-0 cursor-cell hover:bg-slate-50 h-full flex items-center text-[11px] text-slate-700"
        title="Double-click to edit"
      >
        {field === 'is_active' ? (
          <span className={`px-1.5 py-0.2 rounded text-[10px] font-semibold ${value ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-700'}`}>
            {value ? 'Active' : 'Inactive'}
          </span>
        ) : (
          <span className="truncate">{value?.toString() || '—'}</span>
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
    <div className="flex flex-col h-full bg-white rounded-xl border border-slate-200/90 shadow-2xs overflow-hidden">
      {/* Top Action Bar */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2 px-3 py-2 border-b border-slate-200/80 bg-slate-50/50">
        <div className="flex items-center gap-2">
          {/* Status filter: Active / Archived / All */}
          <div className="inline-flex rounded-lg border border-slate-200 bg-slate-100 p-0.5 text-[11px] font-semibold">
            <button
              type="button"
              onClick={() => setStatusFilter('active')}
              className={`px-2.5 py-0.5 rounded transition ${statusFilter === 'active' ? 'bg-white text-blue-700 shadow-2xs font-bold' : 'text-slate-600 hover:text-slate-900'}`}
            >
              Active ({customers.filter(c => c.is_active !== false).length})
            </button>
            <button
              type="button"
              onClick={() => setStatusFilter('archived')}
              className={`px-2.5 py-0.5 rounded transition ${statusFilter === 'archived' ? 'bg-white text-amber-700 shadow-2xs font-bold' : 'text-slate-600 hover:text-slate-900'}`}
            >
              Archived ({customers.filter(c => c.is_active === false).length})
            </button>
            <button
              type="button"
              onClick={() => setStatusFilter('all')}
              className={`px-2.5 py-0.5 rounded transition ${statusFilter === 'all' ? 'bg-white text-slate-900 shadow-2xs font-bold' : 'text-slate-600 hover:text-slate-900'}`}
            >
              All ({customers.length})
            </button>
          </div>

          {selectedRows.size > 0 && (
            <div className="flex items-center gap-1.5 bg-blue-50/90 border border-blue-200/80 px-2 py-0.5 rounded-lg">
              <span className="text-[11px] font-bold text-blue-900 mr-1">
                {selectedRows.size} selected
              </span>
              <button
                onClick={handleBulkEmail}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-white bg-blue-600 rounded hover:bg-blue-700 transition shadow-2xs"
              >
                <Send className="w-3 h-3" />
                <span>Send Email</span>
              </button>
              <button
                disabled={deleting}
                onClick={handleDeleteSelected}
                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-semibold text-rose-700 bg-rose-50 border border-rose-200 rounded hover:bg-rose-100 transition disabled:opacity-50"
              >
                <Trash2 className="w-3 h-3" />
                <span>{deleting ? 'Checking...' : 'Delete / Archive'}</span>
              </button>
            </div>
          )}
          {Object.keys(columnFilters).length > 0 && (
            <button
              onClick={() => setColumnFilters({})}
              className="flex items-center gap-1 px-2 py-1 text-[11px] font-semibold text-rose-600 bg-rose-50 border border-rose-200 rounded-md hover:bg-rose-100 transition"
            >
              <X className="w-3 h-3" />
              <span>Clear {Object.keys(columnFilters).length} Filter(s)</span>
            </button>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <label className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition cursor-pointer shadow-2xs">
            <Upload className="w-3 h-3 text-slate-500" />
            <span>Import CSV</span>
            <input name="file_upload" aria-label="Upload file" type="file" accept=".csv" onChange={handleImportCSV} className="hidden" />
          </label>
          <button
            onClick={exportToExcel}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition shadow-2xs"
          >
            <Download className="w-3 h-3 text-slate-500" />
            <span>Export CSV</span>
          </button>
        </div>
      </div>

      {Object.keys(columnFilters).length > 0 && (
        <div className="flex flex-wrap gap-1 px-3 py-1.5 bg-slate-50 border-b border-slate-200">
          {Object.entries(columnFilters).map(([key, filter]) => {
            const col = COLUMNS.find(c => c.key === key);
            return (
              <span key={key} className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium bg-blue-50 text-blue-800 border border-blue-200 rounded-md">
                <Filter className="w-2.5 h-2.5" />
                <span className="font-semibold">{col?.label}:</span> {Array.from(filter.values).join(', ')}
                <button onClick={() => clearFilter(key)} className="ml-0.5 hover:text-blue-900">
                  <X className="w-2.5 h-2.5" />
                </button>
              </span>
            );
          })}
        </div>
      )}

      {/* Spreadsheet Table with Frozen Sticky Company Column */}
      <div ref={tableRef} className="flex-1 overflow-auto" style={{ maxHeight: 'calc(100vh - 200px)' }}>
        <table className="w-full border-separate border-spacing-0">
          <thead className="sticky top-0 bg-slate-100 z-30">
            <tr className="h-8">
              {/* Frozen Checkbox Column */}
              <th
                className="sticky top-0 left-0 bg-slate-100 z-40 border-b border-r border-slate-300 text-center text-xs p-0"
                style={{ width: 36, minWidth: 36, maxWidth: 36 }}
              >
                <input
                  name="selected"
                  aria-label="Select item"
                  type="checkbox"
                  checked={selectedRows.size === filteredCustomers.length && filteredCustomers.length > 0}
                  onChange={toggleSelectAll}
                  className="rounded border-slate-300 text-blue-600 focus:ring-0"
                />
              </th>
              {COLUMNS.map(({ key, label }) => {
                const isFiltered = !!columnFilters[key];
                const isSorted = sortCol === key;
                const isCompany = key === 'company_name';
                return (
                  <th
                    key={key}
                    className={`border-b border-r border-slate-300 text-left text-[11px] font-semibold text-slate-700 relative select-none ${
                      isCompany
                        ? 'sticky top-0 left-[36px] bg-slate-100 z-40 shadow-[3px_0_6px_-2px_rgba(0,0,0,0.08)]'
                        : 'sticky top-0 bg-slate-100 z-20'
                    }`}
                    style={{ width: columnWidths[key], minWidth: columnWidths[key] }}
                  >
                    <div className="flex items-center px-2 py-1 gap-1 h-8">
                      <button
                        onClick={() => handleSort(key)}
                        className="flex items-center gap-0.5 flex-1 min-w-0 hover:text-blue-600 transition"
                        title="Click to sort"
                      >
                        <span className="truncate tracking-wide">{label}</span>
                        {isSorted ? (
                          sortDir === 'asc' ? <ChevronUp className="w-3 h-3 flex-shrink-0 text-blue-600" /> : <ChevronDown className="w-3 h-3 flex-shrink-0 text-blue-600" />
                        ) : (
                          <ChevronsUpDown className="w-3 h-3 flex-shrink-0 text-slate-400 opacity-60" />
                        )}
                      </button>
                      <div
                        className="relative flex-shrink-0"
                        ref={el => { filterRefs.current[key] = el; }}
                      >
                        <button
                          onClick={() => openFilter(key)}
                          className={`p-0.5 rounded transition ${isFiltered ? 'text-blue-600 bg-blue-100' : 'text-slate-400 hover:text-blue-500 hover:bg-slate-200'}`}
                          title="Filter"
                        >
                          <Filter className="w-3 h-3" />
                        </button>
                        {openFilterCol === key && (
                          <div className="absolute right-0 top-full mt-1 bg-white border border-slate-200 rounded-lg shadow-xl z-50 w-52">
                            <div className="p-2 border-b border-slate-100">
                              <input name="filter_search" aria-label="Search values..."
                                type="text"
                                value={tempFilterSearch}
                                onChange={e => setTempFilterSearch(e.target.value)}
                                placeholder="Search values..."
                                className="w-full px-2 py-1 text-xs border border-slate-200 rounded focus:ring-1 focus:ring-blue-500"
                                autoFocus
                                onClick={e => e.stopPropagation()}
                              />
                            </div>
                            <div className="max-h-48 overflow-y-auto p-1">
                              {getUniqueValues(key)
                                .filter(v => !tempFilterSearch || v.toLowerCase().includes(tempFilterSearch.toLowerCase()))
                                .map(val => (
                                  <label key={val} className="flex items-center gap-2 px-2 py-1 hover:bg-slate-50 rounded cursor-pointer text-xs">
                                    <input name="has" aria-label="Has"
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
                            <div className="flex gap-2 p-2 border-t border-slate-100">
                              <button
                                onClick={() => { setTempFilterValues(new Set()); }}
                                className="flex-1 px-2 py-1 text-xs text-slate-600 border border-slate-300 rounded hover:bg-slate-50"
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
                      className="absolute right-0 top-0 bottom-0 w-2 cursor-col-resize z-30"
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
                <td colSpan={COLUMNS.length + 1} className="px-4 py-8 text-center text-slate-400 text-xs">
                  No customers found matching the filter criteria.
                </td>
              </tr>
            ) : (
              filteredCustomers.map((customer) => {
                const isRowSelected = selectedRows.has(customer.id);
                return (
                  <React.Fragment key={customer.id}>
                    <tr
                      className={`h-8 min-h-[32px] max-h-[32px] border-b border-slate-200 transition ${
                        isRowSelected ? 'bg-blue-50/80' : 'hover:bg-slate-50/70'
                      }`}
                    >
                      {/* Frozen Checkbox */}
                      <td
                        className={`sticky left-0 ${
                          isRowSelected ? 'bg-blue-50/90' : 'bg-white'
                        } z-20 border-r border-slate-200 text-center h-8 p-0`}
                        style={{ width: 36, minWidth: 36, maxWidth: 36 }}
                      >
                        <input
                          name="selected"
                          aria-label="Select item"
                          type="checkbox"
                          checked={isRowSelected}
                          onChange={() => toggleRowSelection(customer.id)}
                          className="rounded border-slate-300 text-blue-600 focus:ring-0"
                        />
                      </td>

                      {/* Columns */}
                      {COLUMNS.map(({ key }) => {
                        const isCompany = key === 'company_name';
                        return (
                          <td
                            key={key}
                            className={`border-r border-slate-200 h-8 p-0 text-[11px] truncate ${
                              isCompany
                                ? `sticky left-[36px] ${
                                    isRowSelected ? 'bg-blue-50/90' : 'bg-white'
                                  } z-10 shadow-[3px_0_6px_-2px_rgba(0,0,0,0.08)] font-semibold text-slate-900`
                                : ''
                            }`}
                            style={{ width: columnWidths[key], minWidth: columnWidths[key], maxWidth: columnWidths[key] }}
                          >
                            {renderCell(customer, key as keyof Customer)}
                          </td>
                        );
                      })}
                    </tr>

                    {/* Expandable Multi-Contact Sub-Row */}
                    {expandedContactRows.has(customer.id) && (
                      <tr className="bg-slate-50/95 border-b-2 border-slate-300">
                        <td colSpan={COLUMNS.length + 1} className="px-5 py-2.5">
                          <div className="space-y-1.5">
                            <div className="flex items-center justify-between">
                              <span className="text-[11px] font-bold text-slate-800 uppercase flex items-center gap-1.5">
                                <Users className="w-3.5 h-3.5 text-blue-600" />
                                Structured Multi-Contact Directory &bull; {customer.company_name}
                              </span>
                              <span className="text-[10px] text-slate-500">
                                Direct department contacts (Purchasing, Import, QA)
                              </span>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                              {parseCustomerContacts(customer).map((card, cIdx) => (
                                <div key={cIdx} className="bg-white border border-slate-200 rounded-lg p-2 shadow-2xs space-y-1">
                                  <div className="flex items-center justify-between">
                                    <span className="text-xs font-bold text-slate-900 truncate">{card.name}</span>
                                    {card.isPrimary ? (
                                      <span className="text-[9px] font-bold px-1.5 py-0.2 bg-blue-100 text-blue-800 rounded">
                                        Primary
                                      </span>
                                    ) : (
                                      <span className="text-[9px] font-bold px-1.5 py-0.2 bg-slate-100 text-slate-700 rounded">
                                        Secondary
                                      </span>
                                    )}
                                  </div>
                                  <div className="text-[10.5px] text-slate-600 font-medium">{card.designation}</div>
                                  <div className="flex items-center gap-1 text-[10.5px] text-blue-700 font-mono truncate">
                                    <Mail className="w-3 h-3 text-slate-400 flex-shrink-0" />
                                    <span className="truncate">{card.email || '—'}</span>
                                  </div>
                                  <div className="flex items-center gap-1 text-[10.5px] text-slate-600 font-mono">
                                    <Phone className="w-3 h-3 text-slate-400 flex-shrink-0" />
                                    <span>{card.phone || '—'}</span>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="px-3 py-1.5 border-t border-slate-200 bg-slate-50/80 text-xs text-slate-600">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium text-slate-700">
            {filteredCustomers.length} customer(s)
            {filteredCustomers.length !== customers.length && ` (filtered from ${customers.length} total)`}
            {selectedRows.size > 0 && ` • ${selectedRows.size} selected`}
          </span>
          <span className="text-[10px] text-slate-400">
            Double-click cell to inline edit &bull; Click column header to sort &bull; Drag edge to resize &bull; Frozen company column
          </span>
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
            <select name="sales_member" aria-label="Sales Member"
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

      {/* Dependency Conflict & Archive Recommendation Modal */}
      {deleteConflictModal && (
        <div className="fixed inset-0 z-50 overflow-hidden bg-black/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg p-6 border border-slate-200 animate-in fade-in zoom-in-95 duration-100">
            <div className="flex items-center gap-2.5 pb-3 border-b border-slate-100 mb-4 text-amber-600">
              <ShieldAlert className="w-5 h-5 shrink-0" />
              <h3 className="text-base font-bold text-slate-900">
                Cannot Delete Customer with Historical Records
              </h3>
            </div>

            <p className="text-xs text-slate-600 mb-3 leading-relaxed">
              Permanent deletion was stopped because the following customer(s) contain transaction, inquiry, or communication history. Deleting them would break CRM audit trails and corrupt historical logs:
            </p>

            <div className="max-h-56 overflow-y-auto space-y-2 mb-4 p-3 bg-amber-50/60 rounded-lg border border-amber-200/80 text-xs">
              {deleteConflictModal.mustArchive.map(item => (
                <div key={item.id} className="bg-white p-2.5 rounded border border-amber-200 shadow-2xs">
                  <div className="font-bold text-slate-900">{item.company_name}</div>
                  <ul className="list-disc list-inside text-amber-800 text-[11px] mt-1 space-y-0.5">
                    {item.report.summaryList.map((s, idx) => (
                      <li key={idx}>{s}</li>
                    ))}
                  </ul>
                </div>
              ))}
              {deleteConflictModal.safeToDelete.length > 0 && (
                <div className="text-[11px] text-slate-500 italic pt-1">
                  Note: {deleteConflictModal.safeToDelete.length} unused record(s) with 0 history will be permanently deleted.
                </div>
              )}
            </div>

            <div className="p-3 bg-blue-50/80 rounded-lg border border-blue-200 text-xs text-blue-900 mb-4">
              <div className="font-semibold flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-blue-600 shrink-0" />
                Recommended Action: Archive Customer
              </div>
              <p className="text-[11px] text-blue-800 mt-1">
                Archiving deactivates the customer from active CRM sales lists while preserving all historical inquiries, quotes, emails, and audit trails intact.
              </p>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
              <button
                type="button"
                disabled={deleting}
                onClick={() => setDeleteConflictModal(null)}
                className="px-3.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-lg transition"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={deleting}
                onClick={handleArchiveConflictConfirm}
                className="px-4 py-1.5 text-xs font-bold bg-amber-600 hover:bg-amber-700 text-white rounded-lg shadow-2xs transition flex items-center gap-1.5 disabled:opacity-50"
              >
                <Archive className="w-3.5 h-3.5" />
                {deleting ? 'Archiving...' : `Archive ${deleteConflictModal.mustArchive.length} Customer(s)`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
