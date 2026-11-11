import React, { useState, useEffect, useMemo } from 'react';
import {
  Search,
  Filter,
  Plus,
  RefreshCw,
  Eye,
  Edit2,
  Layers,
  Link as LinkIcon,
  Download,
  Archive,
  CheckCircle,
  Clock,
  AlertTriangle,
  FileText,
  Package,
  Building,
  Calendar,
  ShieldAlert,
  Loader2,
  Trash2,
} from 'lucide-react';
import { supabase } from '../../lib/supabase.ts';
import {
  UniversalDocumentRecord,
  UniversalDocumentFilters,
  UniversalDocumentStats,
  UniversalLifecycleStatus,
  UniversalDocumentType,
  ALL_DOCUMENT_TYPES,
  getUniversalDocuments,
  getUniversalDocumentStats,
  resolveDocumentViewUrl,
  safeArchiveOrDeleteDocument,
} from '../../services/documents/universalDocumentBankService.ts';
import { UniversalDocumentModalPreview } from './UniversalDocumentModalPreview.tsx';
import { UniversalDocumentReviewModal } from './UniversalDocumentReviewModal.tsx';
import { UniversalDocumentVersionHistoryModal } from './UniversalDocumentVersionHistoryModal.tsx';
import { UniversalDocumentLinksModal } from './UniversalDocumentLinksModal.tsx';
import { UniversalDocumentUploadModal } from './UniversalDocumentUploadModal.tsx';

interface ProductOption {
  id: string;
  product_name: string;
}

export const UniversalDocumentBankTable: React.FC = () => {
  const [documents, setDocuments] = useState<UniversalDocumentRecord[]>([]);
  const [stats, setStats] = useState<UniversalDocumentStats>({
    total: 0,
    banked: 0,
    reviewed: 0,
    temp: 0,
    archived: 0,
    expired: 0,
  });
  const [loading, setLoading] = useState(false);

  // Filters state
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'ALL' | 'BANKED' | 'REVIEWED' | 'TEMP' | 'EXPIRED' | 'ARCHIVED'>('ALL');
  const [selectedDocType, setSelectedDocType] = useState<UniversalDocumentType | 'ALL'>('ALL');
  const [selectedProductId, setSelectedProductId] = useState<string>('ALL');
  const [selectedModule, setSelectedModule] = useState<string>('ALL');

  // Master options
  const [products, setProducts] = useState<ProductOption[]>([]);

  // Modals state
  const [previewDoc, setPreviewDoc] = useState<UniversalDocumentRecord | null>(null);
  const [reviewDoc, setReviewDoc] = useState<UniversalDocumentRecord | null>(null);
  const [versionDoc, setVersionDoc] = useState<UniversalDocumentRecord | null>(null);
  const [linksDoc, setLinksDoc] = useState<UniversalDocumentRecord | null>(null);
  const [showUploadModal, setShowUploadModal] = useState(false);

  // Load master products for filter
  useEffect(() => {
    supabase
      .from('products')
      .select('id, product_name')
      .order('product_name')
      .then(({ data }) => setProducts((data || []) as ProductOption[]));
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);

      const filters: UniversalDocumentFilters = {
        searchQuery: searchQuery.trim() || undefined,
        documentType: selectedDocType !== 'ALL' ? selectedDocType : undefined,
        productId: selectedProductId !== 'ALL' ? selectedProductId : undefined,
        sourceModule: selectedModule !== 'ALL' ? selectedModule : undefined,
      };

      if (activeTab === 'EXPIRED') {
        filters.isExpired = true;
      } else if (activeTab !== 'ALL') {
        filters.lifecycleStatus = activeTab;
      }

      const [docs, s] = await Promise.all([
        getUniversalDocuments(filters),
        getUniversalDocumentStats(),
      ]);

      setDocuments(docs);
      setStats(s);
    } catch (err) {
      console.error('[UniversalDocumentBank] Error loading data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [activeTab, selectedDocType, selectedProductId, selectedModule]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    loadData();
  };

  const handleResetFilters = () => {
    setSearchQuery('');
    setActiveTab('ALL');
    setSelectedDocType('ALL');
    setSelectedProductId('ALL');
    setSelectedModule('ALL');
  };

  const handleDownload = async (doc: UniversalDocumentRecord) => {
    try {
      const url = await resolveDocumentViewUrl(
        doc.storage_bucket || 'documents',
        doc.storage_path || '',
        doc.file_url
      );
      if (url) {
        window.open(url, '_blank');
      }
    } catch (err) {
      console.error('Download error:', err);
    }
  };

  const handleDeleteOrArchive = async (doc: UniversalDocumentRecord) => {
    const isBanked = doc.lifecycle_status === 'BANKED';
    const message = isBanked
      ? `Archive "${doc.title}"? Because this is a BANKED document, it will be safely archived to protect historical references.`
      : `Delete "${doc.title}"?`;

    if (!window.confirm(message)) return;

    try {
      await safeArchiveOrDeleteDocument(doc.id, false);
      await loadData();
    } catch (err: any) {
      alert(`Operation failed: ${err.message}`);
    }
  };

  return (
    <div className="space-y-4">
      {/* 1. KPI Counter Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <div
          onClick={() => setActiveTab('ALL')}
          className={`p-3 rounded-xl border transition cursor-pointer ${
            activeTab === 'ALL'
              ? 'bg-blue-50/80 border-blue-400 shadow-xs'
              : 'bg-white border-slate-200 hover:border-slate-300'
          }`}
        >
          <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">
            All Documents
          </span>
          <span className="text-xl font-black text-slate-900">{stats.total}</span>
        </div>

        <div
          onClick={() => setActiveTab('BANKED')}
          className={`p-3 rounded-xl border transition cursor-pointer ${
            activeTab === 'BANKED'
              ? 'bg-emerald-50/80 border-emerald-400 shadow-xs'
              : 'bg-white border-slate-200 hover:border-slate-300'
          }`}
        >
          <span className="text-[10px] font-bold text-emerald-600 uppercase tracking-wider block flex items-center gap-1">
            <CheckCircle className="w-3 h-3" /> Banked Library
          </span>
          <span className="text-xl font-black text-emerald-700">{stats.banked}</span>
        </div>

        <div
          onClick={() => setActiveTab('REVIEWED')}
          className={`p-3 rounded-xl border transition cursor-pointer ${
            activeTab === 'REVIEWED'
              ? 'bg-purple-50/80 border-purple-400 shadow-xs'
              : 'bg-white border-slate-200 hover:border-slate-300'
          }`}
        >
          <span className="text-[10px] font-bold text-purple-600 uppercase tracking-wider block flex items-center gap-1">
            <Clock className="w-3 h-3" /> Reviewed
          </span>
          <span className="text-xl font-black text-purple-700">{stats.reviewed}</span>
        </div>

        <div
          onClick={() => setActiveTab('TEMP')}
          className={`p-3 rounded-xl border transition cursor-pointer ${
            activeTab === 'TEMP'
              ? 'bg-amber-50/80 border-amber-400 shadow-xs'
              : 'bg-white border-slate-200 hover:border-slate-300'
          }`}
        >
          <span className="text-[10px] font-bold text-amber-600 uppercase tracking-wider block flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" /> Temporary Inbox
          </span>
          <span className="text-xl font-black text-amber-700">{stats.temp}</span>
        </div>

        <div
          onClick={() => setActiveTab('EXPIRED')}
          className={`p-3 rounded-xl border transition cursor-pointer ${
            activeTab === 'EXPIRED'
              ? 'bg-red-50/80 border-red-400 shadow-xs'
              : 'bg-white border-slate-200 hover:border-slate-300'
          }`}
        >
          <span className="text-[10px] font-bold text-red-600 uppercase tracking-wider block flex items-center gap-1">
            <ShieldAlert className="w-3 h-3" /> Expired / Past Date
          </span>
          <span className="text-xl font-black text-red-700">{stats.expired}</span>
        </div>

        <div
          onClick={() => setActiveTab('ARCHIVED')}
          className={`p-3 rounded-xl border transition cursor-pointer ${
            activeTab === 'ARCHIVED'
              ? 'bg-slate-100 border-slate-400 shadow-xs'
              : 'bg-white border-slate-200 hover:border-slate-300'
          }`}
        >
          <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block flex items-center gap-1">
            <Archive className="w-3 h-3" /> Archived
          </span>
          <span className="text-xl font-black text-slate-700">{stats.archived}</span>
        </div>
      </div>

      {/* 2. Top Action & Filter Toolbar */}
      <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-xs space-y-3">
        {/* Row 1: Search, Upload Button, and Refresh */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
          <form onSubmit={handleSearchSubmit} className="relative flex-1 max-w-lg">
            <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search by Product, Make, Specification, Batch number, or File name..."
              className="w-full pl-9 pr-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </form>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={loadData}
              disabled={loading}
              className="p-2 rounded-xl border border-slate-200 hover:bg-slate-100 text-slate-600 transition"
              title="Refresh Bank"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-blue-600' : ''}`} />
            </button>

            <button
              type="button"
              onClick={() => setShowUploadModal(true)}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 shadow transition"
            >
              <Plus className="w-4 h-4" /> Upload Document
            </button>
          </div>
        </div>

        {/* Row 2: Secondary Dropdown Filters */}
        <div className="flex flex-wrap items-center gap-2.5 pt-2 border-t border-slate-100 text-xs">
          <div className="flex items-center gap-1.5 text-slate-500 font-semibold text-[11px]">
            <Filter className="w-3.5 h-3.5 text-slate-400" /> Filters:
          </div>

          {/* Product Filter */}
          <select
            value={selectedProductId}
            onChange={e => setSelectedProductId(e.target.value)}
            className="px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-slate-800 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="ALL">All Products</option>
            {products.map(p => (
              <option key={p.id} value={p.id}>
                {p.product_name}
              </option>
            ))}
          </select>

          {/* Document Type Filter */}
          <select
            value={selectedDocType}
            onChange={e => setSelectedDocType(e.target.value as any)}
            className="px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-slate-800 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="ALL">All Document Types</option>
            {ALL_DOCUMENT_TYPES.map(t => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>

          {/* Source Module Filter */}
          <select
            value={selectedModule}
            onChange={e => setSelectedModule(e.target.value)}
            className="px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-slate-800 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="ALL">All Source Modules</option>
            <option value="products">Products Master</option>
            <option value="batches">Batches & COA</option>
            <option value="crm">CRM & Sourcing</option>
            <option value="purchase">Purchases</option>
            <option value="sales">Sales</option>
            <option value="finance">Finance</option>
          </select>

          {(searchQuery || selectedDocType !== 'ALL' || selectedProductId !== 'ALL' || selectedModule !== 'ALL' || activeTab !== 'ALL') && (
            <button
              type="button"
              onClick={handleResetFilters}
              className="text-[11px] text-blue-600 hover:text-blue-800 font-semibold ml-auto"
            >
              Reset Filters
            </button>
          )}
        </div>
      </div>

      {/* 3. Main Documents Data Table */}
      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-xs">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs text-slate-600">
            <thead className="bg-slate-50/80 border-b border-slate-200 text-[11px] font-bold text-slate-700 uppercase tracking-wider">
              <tr>
                <th className="py-3 px-4">Document Title & File</th>
                <th className="py-3 px-4">Product / Make / Spec</th>
                <th className="py-3 px-3">Batch Number</th>
                <th className="py-3 px-3">Type</th>
                <th className="py-3 px-3">Lifecycle</th>
                <th className="py-3 px-3">Valid Until</th>
                <th className="py-3 px-3 text-center">Version</th>
                <th className="py-3 px-3 text-center">Links</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading && documents.length === 0 && (
                <tr>
                  <td colSpan={9} className="py-12 text-center text-slate-400">
                    <div className="flex flex-col items-center justify-center gap-2">
                      <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
                      <span>Loading documents from Universal Bank...</span>
                    </div>
                  </td>
                </tr>
              )}

              {!loading && documents.length === 0 && (
                <tr>
                  <td colSpan={9} className="py-12 text-center text-slate-500">
                    <FileText className="w-8 h-8 text-slate-300 mx-auto mb-2" />
                    <p className="font-semibold text-slate-700">No documents found matching filters</p>
                    <p className="text-[11px] text-slate-400">
                      Try clearing search parameters or upload a new document to the bank.
                    </p>
                  </td>
                </tr>
              )}

              {documents.map(doc => {
                const isBanked = doc.lifecycle_status === 'BANKED';
                const isReviewed = doc.lifecycle_status === 'REVIEWED';
                const isTemp = doc.lifecycle_status === 'TEMP';
                const isArchived = doc.lifecycle_status === 'ARCHIVED';

                return (
                  <tr key={doc.id} className="hover:bg-slate-50/70 transition">
                    {/* Title & File */}
                    <td className="py-3 px-4 max-w-xs">
                      <div className="font-bold text-slate-900 truncate" title={doc.title}>
                        {doc.title}
                      </div>
                      <div className="text-[11px] text-slate-500 truncate mt-0.5" title={doc.original_file_name || ''}>
                        {doc.original_file_name}
                      </div>
                    </td>

                    {/* Product / Make / Spec */}
                    <td className="py-3 px-4">
                      {doc.product_name ? (
                        <div className="flex items-center gap-1 font-semibold text-slate-800">
                          <Package className="w-3.5 h-3.5 text-blue-600 shrink-0" />
                          <span className="truncate max-w-[180px]">{doc.product_name}</span>
                        </div>
                      ) : (
                        <span className="text-slate-400 italic">Unassigned</span>
                      )}

                      <div className="text-[11px] text-slate-500 flex items-center gap-2 mt-0.5 flex-wrap">
                        {doc.make_name && (
                          <span className="flex items-center gap-1">
                            <Building className="w-3 h-3 text-indigo-500 shrink-0" />
                            {doc.make_name}
                          </span>
                        )}
                        {doc.specification && (
                          <span className="px-1.5 py-0.2 bg-slate-100 rounded text-slate-700 font-medium">
                            {doc.specification}
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Batch Number */}
                    <td className="py-3 px-3">
                      {(doc.batch_number || doc.linked_batch_number) ? (
                        <span className="font-mono text-[11px] font-bold text-amber-800 bg-amber-50 px-2 py-0.5 rounded border border-amber-200">
                          {doc.batch_number || doc.linked_batch_number}
                        </span>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>

                    {/* Type */}
                    <td className="py-3 px-3">
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-100 text-blue-800 uppercase">
                        {doc.document_type}
                      </span>
                    </td>

                    {/* Lifecycle */}
                    <td className="py-3 px-3">
                      {isBanked && (
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 flex items-center gap-1 w-max">
                          <CheckCircle className="w-3 h-3 text-emerald-600" /> Banked
                        </span>
                      )}
                      {isReviewed && (
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-purple-100 text-purple-800 flex items-center gap-1 w-max">
                          <Clock className="w-3 h-3 text-purple-600" /> Reviewed
                        </span>
                      )}
                      {isTemp && (
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 flex items-center gap-1 w-max">
                          <AlertTriangle className="w-3 h-3 text-amber-600" /> Temporary
                        </span>
                      )}
                      {isArchived && (
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-200 text-slate-700 flex items-center gap-1 w-max">
                          <Archive className="w-3 h-3 text-slate-500" /> Archived
                        </span>
                      )}
                    </td>

                    {/* Valid Until / Expiry */}
                    <td className="py-3 px-3 whitespace-nowrap">
                      {doc.valid_until ? (
                        <div
                          className={`flex items-center gap-1 text-[11px] ${
                            doc.is_expired ? 'text-red-600 font-bold' : 'text-slate-600'
                          }`}
                        >
                          <Calendar className="w-3.5 h-3.5" />
                          <span>{doc.valid_until}</span>
                          {doc.is_expired && (
                            <span className="text-[9px] uppercase px-1 rounded bg-red-100 text-red-700 ml-1">
                              Expired
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>

                    {/* Versions count */}
                    <td className="py-3 px-3 text-center">
                      <button
                        type="button"
                        onClick={() => setVersionDoc(doc)}
                        className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-700 hover:text-blue-600 hover:bg-blue-50 px-2 py-0.5 rounded transition"
                        title="Manage version history"
                      >
                        <Layers className="w-3.5 h-3.5 text-blue-500" />
                        <span>v{doc.version_number || 1}</span>
                      </button>
                    </td>

                    {/* Links count */}
                    <td className="py-3 px-3 text-center">
                      <button
                        type="button"
                        onClick={() => setLinksDoc(doc)}
                        className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-700 hover:text-emerald-600 hover:bg-emerald-50 px-2 py-0.5 rounded transition"
                        title="Manage entity associations"
                      >
                        <LinkIcon className="w-3.5 h-3.5 text-emerald-500" />
                        <span>{doc.link_count || 1}</span>
                      </button>
                    </td>

                    {/* Actions */}
                    <td className="py-3 px-4 text-right">
                      <div className="flex items-center justify-end gap-1">
                        {/* Instant centered modal preview */}
                        <button
                          type="button"
                          onClick={() => setPreviewDoc(doc)}
                          className="p-1.5 text-slate-500 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition"
                          title="Instant Centered Lightbox Preview"
                        >
                          <Eye className="w-4 h-4" />
                        </button>

                        {/* Review / Edit details */}
                        <button
                          type="button"
                          onClick={() => setReviewDoc(doc)}
                          className="p-1.5 text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition"
                          title="Review & Edit Master Linkages"
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>

                        {/* Direct Download */}
                        <button
                          type="button"
                          onClick={() => handleDownload(doc)}
                          className="p-1.5 text-slate-500 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition"
                          title="Download File"
                        >
                          <Download className="w-4 h-4" />
                        </button>

                        {/* Archive / Delete */}
                        <button
                          type="button"
                          onClick={() => handleDeleteOrArchive(doc)}
                          className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition"
                          title={isBanked ? 'Archive Document' : 'Delete Document'}
                        >
                          {isBanked ? <Archive className="w-4 h-4" /> : <Trash2 className="w-4 h-4" />}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* 4. Active Modals */}
      {/* Centered Modal Preview */}
      {previewDoc && (
        <UniversalDocumentModalPreview
          document={previewDoc}
          allDocuments={documents}
          onClose={() => setPreviewDoc(null)}
          onNavigate={doc => setPreviewDoc(doc)}
        />
      )}

      {/* Review & Edit Modal */}
      {reviewDoc && (
        <UniversalDocumentReviewModal
          document={reviewDoc}
          onClose={() => setReviewDoc(null)}
          onSaved={loadData}
        />
      )}

      {/* Version History Modal */}
      {versionDoc && (
        <UniversalDocumentVersionHistoryModal
          document={versionDoc}
          onClose={() => setVersionDoc(null)}
          onVersionAdded={loadData}
        />
      )}

      {/* Associations Modal */}
      {linksDoc && (
        <UniversalDocumentLinksModal
          document={linksDoc}
          onClose={() => setLinksDoc(null)}
          onLinksChanged={loadData}
        />
      )}

      {/* Upload Modal */}
      {showUploadModal && (
        <UniversalDocumentUploadModal
          isOpen={showUploadModal}
          onClose={() => setShowUploadModal(false)}
          onUploaded={loadData}
        />
      )}
    </div>
  );
};

