import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import {
  Upload, ChevronUp, ChevronDown,
  ChevronsUpDown, X, RefreshCw, AlertCircle, FileSpreadsheet, Loader2, Plus, Trash2, Search,
} from 'lucide-react';
import * as XLSX from 'xlsx';

interface ImportRow {
  id: string;
  date: string | null;
  hs_code: string;
  product_name: string;
  quantity: number;
  unit: string;
  unit_rate: number;
  currency: string;
  total_usd: number;
  origin: string;
  destination: string;
  exporter: string;
  importer: string;
  type: string;
}

type SortField = keyof Omit<ImportRow, 'id'>;
type SortDir = 'asc' | 'desc';

interface ColDef {
  key: SortField;
  label: string;
  defaultWidth: number;
  numeric?: boolean;
  dimHeader?: boolean;
}

const COLS: ColDef[] = [
  { key: 'date',        label: 'DATE',      defaultWidth: 90,  dimHeader: true },
  { key: 'hs_code',     label: 'HS CODE',   defaultWidth: 95,  dimHeader: true },
  { key: 'product_name',label: 'PRODUCT',   defaultWidth: 210 },
  { key: 'quantity',    label: 'QTY',       defaultWidth: 70,  numeric: true },
  { key: 'unit',        label: 'UNIT',      defaultWidth: 68,  dimHeader: true },
  { key: 'unit_rate',   label: 'RATE',      defaultWidth: 88,  numeric: true },
  { key: 'currency',    label: 'CCY',       defaultWidth: 58,  dimHeader: true },
  { key: 'total_usd',   label: 'TOTAL USD', defaultWidth: 105, numeric: true },
  { key: 'origin',      label: 'ORIGIN',    defaultWidth: 125 },
  { key: 'destination', label: 'DEST.',     defaultWidth: 105 },
  { key: 'exporter',    label: 'EXPORTER',  defaultWidth: 180 },
  { key: 'importer',    label: 'IMPORTER',  defaultWidth: 180 },
  { key: 'type',        label: 'TYPE',      defaultWidth: 125 },
];

const FILTER_FIELDS: { value: SortField; label: string }[] = [
  { value: 'product_name', label: 'Product' },
  { value: 'importer',     label: 'Importer' },
  { value: 'exporter',     label: 'Exporter' },
  { value: 'origin',       label: 'Origin' },
  { value: 'destination',  label: 'Destination' },
  { value: 'hs_code',      label: 'HS Code' },
  { value: 'type',         label: 'Type' },
  { value: 'currency',     label: 'Currency' },
];

interface FilterRow {
  id: number;
  field: SortField;
  value: string;
}

let filterIdCounter = 0;
function newFilter(field: SortField = 'product_name'): FilterRow {
  return { id: ++filterIdCounter, field, value: '' };
}

const PAGE_SIZE = 200;

const TYPE_COLORS: Record<string, string> = {
  'API': 'bg-blue-100 text-blue-800',
  'Finished Product': 'bg-green-100 text-green-800',
  'Excipient': 'bg-amber-100 text-amber-800',
  'Flavor / Fragrance': 'bg-pink-100 text-pink-800',
  'Agrochemical': 'bg-lime-100 text-lime-800',
  'Medical Device / Dental': 'bg-cyan-100 text-cyan-800',
};

function getTypeColor(t: string) { return TYPE_COLORS[t] || 'bg-gray-100 text-gray-700'; }

function abbreviateUnit(u: string): string {
  const map: Record<string, string> = {
    'kilogram': 'KG', 'kilograms': 'KG', 'kg': 'KG',
    'gram': 'G', 'grams': 'G',
    'liter': 'L', 'liters': 'L', 'litre': 'L', 'litres': 'L',
    'milliliter': 'ML', 'milliliters': 'ML', 'ml': 'ML',
    'piece': 'PCS', 'pieces': 'PCS', 'pcs': 'PCS', 'pc': 'PCS',
    'unit': 'PCS', 'units': 'PCS',
    'tablet': 'TAB', 'tablets': 'TAB',
    'capsule': 'CAP', 'capsules': 'CAP',
    'bottle': 'BTL', 'bottles': 'BTL',
    'box': 'BOX', 'boxes': 'BOX',
    'bag': 'BAG', 'bags': 'BAG',
    'drum': 'DRM', 'drums': 'DRM',
    'ton': 'TON', 'tons': 'TON', 'tonne': 'TON', 'tonnes': 'TON', 'mt': 'MT',
    'milligram': 'MG', 'milligrams': 'MG', 'mg': 'MG',
  };
  return map[u.toLowerCase().trim()] || u;
}

function parseDate(val: unknown): string | null {
  if (!val) return null;
  if (typeof val === 'number') {
    const d = XLSX.SSF.parse_date_code(val);
    if (d) return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  if (typeof val === 'string') {
    const c = val.trim();
    const p = c.match(/(\d{1,2})[\/\-\.](\w+)[\/\-\.](\d{2,4})/);
    if (p) {
      const mo: Record<string, string> = { jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12' };
      return `${p[3].length===2?`20${p[3]}`:p[3]}-${mo[p[2].toLowerCase()]||p[2].padStart(2,'0')}-${p[1].padStart(2,'0')}`;
    }
    const d = new Date(c);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return null;
}

function fmtDate(v: string | null) {
  if (!v) return '-';
  const d = new Date(v + 'T00:00:00');
  const m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${d.getDate()}-${m[d.getMonth()]}-${d.getFullYear()}`;
}

function fmtNum(n: number) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function ImportInfo() {
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);

  const [filters, setFilters] = useState<FilterRow[]>([newFilter('product_name')]);
  const [activeFilters, setActiveFilters] = useState<FilterRow[]>([]);

  const [sortField, setSortField] = useState<SortField>('date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const [colWidths, setColWidths] = useState<Record<string, number>>(
    () => Object.fromEntries(COLS.map(c => [c.key, c.defaultWidth]))
  );

  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [showClear, setShowClear] = useState(false);
  const [userRole, setUserRole] = useState('');

  const fileRef = useRef<HTMLInputElement>(null);
  const resizingRef = useRef<{ key: string; startX: number; startW: number } | null>(null);

  useEffect(() => {
    supabase.from('user_profiles').select('role').maybeSingle().then(({ data }) => {
      if (data) setUserRole(data.role || '');
    });
  }, []);

  const fetchPage = useCallback(async (pg: number, af: FilterRow[]) => {
    setLoading(true);
    try {
      let q = supabase
        .from('import_data')
        .select('id,date,hs_code,product_name,quantity,unit,unit_rate,currency,total_usd,origin,destination,exporter,importer,type', { count: 'exact' });

      const active = af.filter(f => f.value.trim() !== '');
      for (const f of active) {
        q = q.ilike(f.field as string, `%${f.value.trim()}%`);
      }

      q = q.order(sortField as string, { ascending: sortDir === 'asc' });
      q = q.range(pg * PAGE_SIZE, (pg + 1) * PAGE_SIZE - 1);

      const { data, count, error } = await q;
      if (error) throw error;
      setRows((data as ImportRow[]) || []);
      setTotal(count || 0);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [sortField, sortDir]);

  useEffect(() => { fetchPage(page, activeFilters); }, [fetchPage, page, activeFilters]);

  function handleSearch() {
    setActiveFilters([...filters]);
    setPage(0);
  }

  function handleReset() {
    const fresh = [newFilter('product_name')];
    setFilters(fresh);
    setActiveFilters([]);
    setPage(0);
  }

  function setFilterField(id: number, field: SortField) {
    setFilters(prev => prev.map(f => f.id === id ? { ...f, field } : f));
  }

  function setFilterValue(id: number, value: string) {
    setFilters(prev => prev.map(f => f.id === id ? { ...f, value } : f));
  }

  function addFilter() {
    const usedFields = filters.map(f => f.field);
    const next = FILTER_FIELDS.find(ff => !usedFields.includes(ff.value));
    setFilters(prev => [...prev, newFilter(next?.value || 'importer')]);
  }

  function removeFilter(id: number) {
    setFilters(prev => prev.length > 1 ? prev.filter(f => f.id !== id) : prev);
  }

  function handleSort(field: SortField) {
    const newDir = sortField === field ? (sortDir === 'asc' ? 'desc' : 'asc') : 'asc';
    setSortField(field);
    setSortDir(newDir);
    setPage(0);
  }

  function onResizeMouseDown(e: React.MouseEvent, key: string) {
    e.preventDefault();
    e.stopPropagation();
    resizingRef.current = { key, startX: e.clientX, startW: colWidths[key] };
    function onMove(ev: MouseEvent) {
      const r = resizingRef.current;
      if (!r) return;
      setColWidths(prev => ({ ...prev, [r.key]: Math.max(36, r.startW + ev.clientX - r.startX) }));
    }
    function onUp() { resizingRef.current = null; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true); setUploadMsg(null);
    try {
      const ab = await file.arrayBuffer();
      const wb = XLSX.read(ab, { type: 'array', cellDates: false });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '' });
      if (!raw.length) { setUploadMsg({ type: 'error', text: 'No data found in file.' }); return; }

      const hmap: Record<string, SortField> = {
        date:'date','hs code':'hs_code',hs_code:'hs_code',hscode:'hs_code',
        product:'product_name','product name':'product_name',product_name:'product_name',
        quantity:'quantity',qty:'quantity',unit:'unit',
        'unit rate':'unit_rate',unit_rate:'unit_rate',unitrate:'unit_rate',rate:'unit_rate',
        currency:'currency','total usd':'total_usd',total_usd:'total_usd',totalusd:'total_usd','total (usd)':'total_usd',
        origin:'origin',destination:'destination',exporter:'exporter',importer:'importer',type:'type',
      };

      const keyMap: Record<string, SortField> = {};
      Object.keys(raw[0]).forEach(k => { const m = hmap[k.toLowerCase().trim()]; if (m) keyMap[k] = m; });

      const batch = raw.map(r => {
        const obj: Record<string, unknown> = {};
        Object.entries(keyMap).forEach(([rk, dk]) => {
          const v = r[rk];
          if (dk === 'date') obj[dk] = parseDate(v);
          else if (dk === 'quantity' || dk === 'unit_rate' || dk === 'total_usd') obj[dk] = parseFloat(String(v).replace(/,/g,'')) || 0;
          else obj[dk] = String(v ?? '').trim();
        });
        return obj;
      });

      let inserted = 0;
      for (let i = 0; i < batch.length; i += 500) {
        const { error } = await supabase.from('import_data').insert(batch.slice(i, i + 500));
        if (error) throw error;
        inserted += Math.min(500, batch.length - i);
      }
      setUploadMsg({ type: 'success', text: `Imported ${inserted.toLocaleString()} records.` });
      handleReset();
    } catch (err) {
      setUploadMsg({ type: 'error', text: err instanceof Error ? err.message : 'Upload failed' });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function handleClear() {
    await supabase.from('import_data').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    setRows([]); setTotal(0); setShowClear(false);
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const hasActiveFilters = activeFilters.some(f => f.value.trim() !== '');
  const tableW = useMemo(() => COLS.reduce((s, c) => s + (colWidths[c.key] || c.defaultWidth), 0), [colWidths]);

  return (
    <div className="flex flex-col" style={{ height: 'calc(100vh - 210px)', minHeight: 480 }}>

      {/* ── Filter Builder ── */}
      <div className="flex flex-col gap-1.5 mb-2 flex-shrink-0 bg-gray-50 border border-gray-200 rounded-lg p-2">
        {/* Filter rows */}
        {filters.map((f) => (
          <div key={f.id} className="flex items-center gap-1.5">
            <select
              value={f.field}
              onChange={e => setFilterField(f.id, e.target.value as SortField)}
              className="w-28 px-1.5 py-1 text-xs border border-gray-300 rounded bg-white focus:outline-none focus:ring-1 focus:ring-blue-400 text-gray-700 font-medium flex-shrink-0"
            >
              {FILTER_FIELDS.map(ff => (
                <option key={ff.value} value={ff.value}>{ff.label}</option>
              ))}
            </select>

            <span className="text-[10px] text-gray-400 select-none flex-shrink-0">contains</span>

            <div className="relative flex-1 min-w-0">
              <input
                type="text"
                value={f.value}
                onChange={e => setFilterValue(f.id, e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleSearch(); }}
                placeholder={`${FILTER_FIELDS.find(ff => ff.value === f.field)?.label ?? f.field}…`}
                className="w-full px-2 py-1 text-xs border border-gray-300 rounded bg-white focus:outline-none focus:ring-1 focus:ring-blue-400 text-gray-800"
              />
              {f.value && (
                <button onClick={() => setFilterValue(f.id, '')} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>

            <button
              onClick={() => removeFilter(f.id)}
              disabled={filters.length === 1}
              className="p-0.5 text-gray-300 hover:text-red-400 disabled:opacity-0 transition-colors flex-shrink-0"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}

        {/* Bottom bar: add condition + actions */}
        <div className="flex items-center gap-2 pt-0.5">
          <button
            onClick={addFilter}
            disabled={filters.length >= FILTER_FIELDS.length}
            className="flex items-center gap-1 text-[11px] text-blue-600 hover:text-blue-700 disabled:opacity-30"
          >
            <Plus className="w-3 h-3" />
            Add condition
          </button>

          <div className="flex-1" />

          <button
            onClick={handleSearch}
            className="flex items-center gap-1 px-3 py-1 text-xs font-medium bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
          >
            <Search className="w-3 h-3" />
            Search
          </button>
          <button
            onClick={handleReset}
            className="px-3 py-1 text-xs font-medium border border-gray-300 bg-white text-gray-600 rounded hover:bg-gray-100 transition-colors"
          >
            Reset
          </button>
          <label className="flex items-center gap-1 px-3 py-1 text-xs font-medium bg-white border border-gray-300 text-gray-600 rounded hover:bg-gray-100 cursor-pointer transition-colors whitespace-nowrap">
            <Upload className="w-3 h-3" />
            {uploading ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Upload'}
            <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" onChange={handleUpload} className="hidden" disabled={uploading} />
          </label>
          {(userRole === 'admin' || userRole === 'manager') && (
            <button onClick={() => setShowClear(true)} className="p-1 text-red-400 hover:text-red-600 transition-colors" title="Clear all data">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Active filter chips */}
      {hasActiveFilters && (
        <div className="flex flex-wrap gap-1.5 mb-2 flex-shrink-0">
          {activeFilters.filter(f => f.value.trim()).map(f => (
            <span key={f.id} className="inline-flex items-center gap-1 px-2 py-0.5 text-[10.5px] bg-blue-100 text-blue-800 rounded-full border border-blue-200">
              <span className="font-semibold">{FILTER_FIELDS.find(ff => ff.value === f.field)?.label}</span>
              <span className="text-blue-500">·</span>
              {f.value}
            </span>
          ))}
          <button onClick={handleReset} className="inline-flex items-center gap-0.5 px-2 py-0.5 text-[10.5px] bg-gray-100 text-gray-500 rounded-full hover:bg-gray-200 border border-gray-200">
            <X className="w-2.5 h-2.5" /> Clear
          </button>
        </div>
      )}

      {/* Upload message */}
      {uploadMsg && (
        <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs mb-2 flex-shrink-0 ${uploadMsg.type === 'success' ? 'bg-green-50 text-green-800 border border-green-200' : 'bg-red-50 text-red-800 border border-red-200'}`}>
          {uploadMsg.type === 'error' && <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />}
          {uploadMsg.text}
          <button onClick={() => setUploadMsg(null)} className="ml-auto"><X className="w-3 h-3" /></button>
        </div>
      )}

      {/* Stats + pagination */}
      <div className="flex items-center gap-3 mb-2 flex-shrink-0 text-xs text-gray-500">
        <span>
          <span className="font-semibold text-gray-700">{total.toLocaleString()}</span>
          {hasActiveFilters ? ' matching' : ' total'} records
          {total > PAGE_SIZE && <span className="text-gray-400"> · page {page + 1} of {totalPages}</span>}
        </span>
        {totalPages > 1 && (
          <div className="flex items-center gap-1 ml-2">
            <button onClick={() => setPage(0)} disabled={page === 0} className="px-1.5 py-0.5 rounded border border-gray-300 disabled:opacity-30 hover:bg-gray-50">«</button>
            <button onClick={() => setPage(p => p - 1)} disabled={page === 0} className="px-1.5 py-0.5 rounded border border-gray-300 disabled:opacity-30 hover:bg-gray-50">‹</button>
            <span className="px-2 py-0.5 rounded bg-blue-600 text-white">{page + 1}</span>
            <button onClick={() => setPage(p => p + 1)} disabled={page >= totalPages - 1} className="px-1.5 py-0.5 rounded border border-gray-300 disabled:opacity-30 hover:bg-gray-50">›</button>
            <button onClick={() => setPage(totalPages - 1)} disabled={page >= totalPages - 1} className="px-1.5 py-0.5 rounded border border-gray-300 disabled:opacity-30 hover:bg-gray-50">»</button>
          </div>
        )}
        <button onClick={() => fetchPage(page, activeFilters)} className="ml-auto flex items-center gap-1 hover:text-gray-700 text-gray-400">
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {/* Table */}
      {total === 0 && !loading ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center py-16 text-gray-400">
          <FileSpreadsheet className="w-12 h-12 mb-3 opacity-30" />
          <p className="font-medium text-gray-500 mb-1">{hasActiveFilters ? 'No records match your filters' : 'No import data yet'}</p>
          {!hasActiveFilters && <p className="text-sm">Upload a CSV or Excel file to get started</p>}
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-auto rounded-lg border border-gray-200 shadow-sm" style={{ opacity: loading ? 0.6 : 1, transition: 'opacity 0.15s' }}>
          <table className="border-collapse" style={{ tableLayout: 'fixed', width: tableW, fontSize: '11px' }}>
            <thead className="sticky top-0 z-20">
              <tr className="bg-gray-700 text-white">
                {COLS.map(col => (
                  <th key={col.key} style={{ width: colWidths[col.key], minWidth: 36, position: 'relative' }}
                    className="px-0 py-0 text-left font-semibold border-r border-gray-600 last:border-r-0 overflow-hidden">
                    <button onClick={() => handleSort(col.key)}
                      className="flex items-center gap-1 px-2 py-1.5 hover:text-blue-300 text-left w-full overflow-hidden" title={col.label}>
                      <span className={`truncate ${col.dimHeader ? 'text-[9.5px] text-gray-300 font-medium tracking-wide' : 'text-[10.5px]'}`}>
                        {col.label}
                      </span>
                      {sortField === col.key
                        ? (sortDir === 'asc' ? <ChevronUp className="w-2.5 h-2.5 flex-shrink-0 text-blue-300" /> : <ChevronDown className="w-2.5 h-2.5 flex-shrink-0 text-blue-300" />)
                        : <ChevronsUpDown className="w-2.5 h-2.5 flex-shrink-0 text-gray-500" />}
                    </button>
                    <div onMouseDown={e => onResizeMouseDown(e, col.key)}
                      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize z-10"
                      style={{ background: 'transparent' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(96,165,250,0.6)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={row.id} className={`border-b border-gray-100 hover:bg-blue-50 transition-colors ${i % 2 === 0 ? 'bg-white' : 'bg-gray-50/60'}`}>
                  <td style={{ width: colWidths.date }} className="px-2 py-1 border-r border-gray-100 overflow-hidden whitespace-nowrap text-gray-500 text-[10.5px]">{fmtDate(row.date)}</td>
                  <td style={{ width: colWidths.hs_code }} className="px-2 py-1 border-r border-gray-100 overflow-hidden whitespace-nowrap font-mono text-gray-500 text-[10px]">{row.hs_code}</td>
                  <td style={{ width: colWidths.product_name }} className="px-2 py-1 border-r border-gray-100 overflow-hidden font-medium text-gray-900 text-[11px]" title={row.product_name}><div className="truncate">{row.product_name}</div></td>
                  <td style={{ width: colWidths.quantity }} className="px-2 py-1 border-r border-gray-100 overflow-hidden text-right whitespace-nowrap text-gray-700 text-[10.5px]">{row.quantity.toLocaleString()}</td>
                  <td style={{ width: colWidths.unit }} className="px-2 py-1 border-r border-gray-100 overflow-hidden whitespace-nowrap text-gray-500 text-[10px] uppercase">{abbreviateUnit(row.unit)}</td>
                  <td style={{ width: colWidths.unit_rate }} className="px-2 py-1 border-r border-gray-100 overflow-hidden text-right whitespace-nowrap font-medium text-emerald-700 text-[10.5px]">{fmtNum(row.unit_rate)}</td>
                  <td style={{ width: colWidths.currency }} className="px-2 py-1 border-r border-gray-100 overflow-hidden whitespace-nowrap text-gray-500 text-[10px] font-mono">{row.currency}</td>
                  <td style={{ width: colWidths.total_usd }} className="px-2 py-1 border-r border-gray-100 overflow-hidden text-right whitespace-nowrap font-medium text-blue-700 text-[10.5px]">{fmtNum(row.total_usd)}</td>
                  <td style={{ width: colWidths.origin }} className="px-2 py-1 border-r border-gray-100 overflow-hidden text-gray-600 text-[10.5px]" title={row.origin}><div className="truncate">{row.origin}</div></td>
                  <td style={{ width: colWidths.destination }} className="px-2 py-1 border-r border-gray-100 overflow-hidden text-gray-600 text-[10.5px]" title={row.destination}><div className="truncate">{row.destination}</div></td>
                  <td style={{ width: colWidths.exporter }} className="px-2 py-1 border-r border-gray-100 overflow-hidden text-gray-700 text-[10.5px]" title={row.exporter}><div className="truncate">{row.exporter}</div></td>
                  <td style={{ width: colWidths.importer }} className="px-2 py-1 border-r border-gray-100 overflow-hidden text-gray-700 text-[10.5px]" title={row.importer}><div className="truncate">{row.importer}</div></td>
                  <td style={{ width: colWidths.type }} className="px-2 py-1 overflow-hidden">
                    {row.type ? <span className={`inline-block px-1.5 py-0.5 rounded-full text-[9px] font-medium whitespace-nowrap ${getTypeColor(row.type)}`}>{row.type}</span> : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Clear confirm */}
      {showClear && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl p-6 max-w-sm w-full mx-4">
            <div className="flex items-center gap-3 mb-4">
              <AlertCircle className="w-6 h-6 text-red-500 flex-shrink-0" />
              <h3 className="font-semibold text-gray-900">Clear all import data?</h3>
            </div>
            <p className="text-sm text-gray-600 mb-5">This permanently deletes all {total.toLocaleString()} records and cannot be undone.</p>
            <div className="flex gap-3">
              <button onClick={() => setShowClear(false)} className="flex-1 px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
              <button onClick={handleClear} className="flex-1 px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700">Delete All</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
