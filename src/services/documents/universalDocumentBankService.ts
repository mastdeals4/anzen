/**
 * universalDocumentBankService.ts
 *
 * Core service for the ANZEN Universal Document Bank.
 * Implements: ONE PHYSICAL FILE -> ONE CENTRAL DOCUMENT RECORD -> MULTIPLE AUTHORISED REFERENCES.
 *
 * Supports:
 * - 4-state document lifecycle (TEMP -> REVIEWED -> BANKED -> ARCHIVED)
 * - Multi-version management (revisions with history, non-destructive)
 * - SHA-256 duplicate detection & safe physical file reuse
 * - Product + Make (product_sources) + Specification (grade) + Batch linkages
 * - Cross-module search & auto-surfacing for CRM, Pricing, Products, Batches
 */

import { supabase } from '../../lib/supabase.ts';
import { uploadOptimizedFile } from '../storage/uploadOptimizationService.ts';
import { getSignedUrlCached, invalidateSignedUrl } from '../../utils/signedUrlCache.ts';

export type UniversalLifecycleStatus = 'TEMP' | 'REVIEWED' | 'BANKED' | 'ARCHIVED';

export type UniversalDocumentType =
  | 'COA'
  | 'MSDS'
  | 'GMP'
  | 'HALAL'
  | 'SPECIFICATION'
  | 'TDS'
  | 'DMF'
  | 'MANUFACTURING LICENCE'
  | 'PRODUCT CATALOGUE'
  | 'PURCHASE ORDER'
  | 'SALES INVOICE'
  | 'EXPENSE RECEIPT'
  | 'OTHER TECHNICAL'
  | 'OTHER';

export const ALL_DOCUMENT_TYPES: UniversalDocumentType[] = [
  'COA',
  'MSDS',
  'GMP',
  'HALAL',
  'SPECIFICATION',
  'TDS',
  'DMF',
  'MANUFACTURING LICENCE',
  'PRODUCT CATALOGUE',
  'PURCHASE ORDER',
  'SALES INVOICE',
  'EXPENSE RECEIPT',
  'OTHER TECHNICAL',
  'OTHER',
];

export interface UniversalDocumentRecord {
  id: string;
  title: string;
  document_type: UniversalDocumentType;
  specification: string | null;
  document_date: string | null;
  valid_until: string | null;
  lifecycle_status: UniversalLifecycleStatus;
  source_module: string;
  notes: string | null;
  is_confidential: boolean;
  primary_product_id: string | null;
  primary_product_source_id: string | null;
  primary_batch_id: string | null;
  batch_number: string | null;
  current_version_id: string | null;
  legacy_source_table?: string | null;
  legacy_source_id?: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;

  // Joined from view vw_universal_document_bank
  product_name: string | null;
  product_category: string | null;
  hsn_code: string | null;
  make_name: string | null;
  make_grade: string | null;
  make_country: string | null;
  linked_batch_number: string | null;
  version_number: number | null;
  storage_bucket: string | null;
  storage_path: string | null;
  file_url: string | null;
  original_file_name: string | null;
  file_size: number | null;
  mime_type: string | null;
  sha256: string | null;
  change_summary: string | null;
  version_count: number;
  link_count: number;
  is_expired: boolean;
}

export interface UniversalDocumentVersion {
  id: string;
  document_id: string;
  version_number: number;
  storage_bucket: string;
  storage_path: string;
  file_url: string | null;
  original_file_name: string;
  file_size: number;
  mime_type: string | null;
  sha256: string | null;
  change_summary: string | null;
  is_current: boolean;
  uploaded_by: string | null;
  created_at: string;
}

export interface UniversalDocumentLink {
  id: string;
  document_id: string;
  document_version_id: string | null;
  entity_type: string;
  entity_id: string;
  product_id: string | null;
  product_source_id: string | null;
  batch_id: string | null;
  batch_number: string | null;
  notes: string | null;
  is_primary: boolean;
  created_by: string | null;
  created_at: string;

  // Joined details
  products?: { id: string; product_name: string } | null;
  product_sources?: { id: string; supplier_name: string; grade?: string } | null;
  batches?: { id: string; batch_number: string } | null;
}

export interface UniversalDocumentFilters {
  searchQuery?: string;
  lifecycleStatus?: UniversalLifecycleStatus | 'ALL';
  documentType?: UniversalDocumentType | 'ALL';
  productId?: string | null;
  productSourceId?: string | null;
  batchNumber?: string | null;
  sourceModule?: string | 'ALL';
  isExpired?: boolean | null;
  fromDate?: string | null;
  toDate?: string | null;
}

export interface UniversalDocumentStats {
  total: number;
  banked: number;
  reviewed: number;
  temp: number;
  archived: number;
  expired: number;
}

/**
 * Compute SHA-256 checksum of a File or Blob in the browser
 */
export async function computeFileSha256(file: File | Blob): Promise<string> {
  const buffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Fetch list of documents from vw_universal_document_bank with comprehensive filtering
 */
export async function getUniversalDocuments(
  filters: UniversalDocumentFilters = {}
): Promise<UniversalDocumentRecord[]> {
  let query = supabase
    .from('vw_universal_document_bank')
    .select('*')
    .order('created_at', { ascending: false });

  if (filters.lifecycleStatus && filters.lifecycleStatus !== 'ALL') {
    query = query.eq('lifecycle_status', filters.lifecycleStatus);
  }

  if (filters.documentType && filters.documentType !== 'ALL') {
    query = query.eq('document_type', filters.documentType);
  }

  if (filters.productId) {
    query = query.eq('primary_product_id', filters.productId);
  }

  if (filters.productSourceId) {
    query = query.eq('primary_product_source_id', filters.productSourceId);
  }

  if (filters.batchNumber) {
    query = query.ilike('batch_number', `%${filters.batchNumber}%`);
  }

  if (filters.sourceModule && filters.sourceModule !== 'ALL') {
    query = query.eq('source_module', filters.sourceModule);
  }

  if (filters.isExpired === true) {
    query = query.eq('is_expired', true);
  } else if (filters.isExpired === false) {
    query = query.eq('is_expired', false);
  }

  if (filters.fromDate) {
    query = query.gte('document_date', filters.fromDate);
  }

  if (filters.toDate) {
    query = query.lte('document_date', filters.toDate);
  }

  const { data, error } = await query;
  if (error) {
    console.error('[UniversalDocumentBank] Error fetching documents:', error);
    throw error;
  }

  let results = (data || []) as UniversalDocumentRecord[];

  // Client-side text search across multiple joined text fields
  if (filters.searchQuery && filters.searchQuery.trim()) {
    const q = filters.searchQuery.trim().toLowerCase();
    results = results.filter((doc) => {
      const titleMatch = doc.title?.toLowerCase().includes(q);
      const fileMatch = doc.original_file_name?.toLowerCase().includes(q);
      const prodMatch = doc.product_name?.toLowerCase().includes(q);
      const makeMatch = doc.make_name?.toLowerCase().includes(q);
      const batchMatch =
        doc.batch_number?.toLowerCase().includes(q) ||
        doc.linked_batch_number?.toLowerCase().includes(q);
      const specMatch =
        doc.specification?.toLowerCase().includes(q) || doc.make_grade?.toLowerCase().includes(q);
      const docTypeMatch = doc.document_type?.toLowerCase().includes(q);
      return (
        titleMatch || fileMatch || prodMatch || makeMatch || batchMatch || specMatch || docTypeMatch
      );
    });
  }

  return results;
}

/**
 * Fetch summary statistics for tabs and KPI counters
 */
export async function getUniversalDocumentStats(): Promise<UniversalDocumentStats> {
  const { data, error } = await supabase
    .from('vw_universal_document_bank')
    .select('lifecycle_status, is_expired');

  if (error) {
    console.error('[UniversalDocumentBank] Error fetching stats:', error);
    return { total: 0, banked: 0, reviewed: 0, temp: 0, archived: 0, expired: 0 };
  }

  const stats: UniversalDocumentStats = {
    total: data.length,
    banked: 0,
    reviewed: 0,
    temp: 0,
    archived: 0,
    expired: 0,
  };

  for (const row of data) {
    if (row.lifecycle_status === 'BANKED') stats.banked++;
    else if (row.lifecycle_status === 'REVIEWED') stats.reviewed++;
    else if (row.lifecycle_status === 'TEMP') stats.temp++;
    else if (row.lifecycle_status === 'ARCHIVED') stats.archived++;

    if (row.is_expired) stats.expired++;
  }

  return stats;
}

/**
 * Fetch all versions of a document
 */
export async function getDocumentVersions(documentId: string): Promise<UniversalDocumentVersion[]> {
  const { data, error } = await supabase
    .from('universal_document_versions')
    .select('*')
    .eq('document_id', documentId)
    .order('version_number', { ascending: false });

  if (error) {
    console.error('[UniversalDocumentBank] Error fetching versions:', error);
    throw error;
  }

  return (data || []) as UniversalDocumentVersion[];
}

/**
 * Fetch all business entity links of a document
 */
export async function getDocumentLinks(documentId: string): Promise<UniversalDocumentLink[]> {
  const { data, error } = await supabase
    .from('universal_document_links')
    .select(
      `
      *,
      products (id, product_name),
      product_sources (id, supplier_name, grade),
      batches (id, batch_number)
    `
    )
    .eq('document_id', documentId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[UniversalDocumentBank] Error fetching links:', error);
    throw error;
  }

  return (data || []) as UniversalDocumentLink[];
}

/**
 * Find existing identical file by SHA-256 for physical storage deduplication
 */
export async function findExistingFileBySha256(
  sha256: string
): Promise<UniversalDocumentVersion | null> {
  if (!sha256) return null;

  const { data, error } = await supabase
    .from('universal_document_versions')
    .select('*')
    .eq('sha256', sha256)
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  return data as UniversalDocumentVersion;
}

/**
 * Upload a new logical document into the Universal Document Bank
 * Checks for SHA-256 deduplication to reuse physical storage objects safely.
 */
export async function uploadUniversalDocument(params: {
  file: File;
  title?: string;
  documentType: UniversalDocumentType;
  specification?: string | null;
  documentDate?: string | null;
  validUntil?: string | null;
  lifecycleStatus?: UniversalLifecycleStatus; // Default 'TEMP'
  sourceModule?: string;
  productId?: string | null;
  productSourceId?: string | null;
  batchId?: string | null;
  batchNumber?: string | null;
  notes?: string | null;
  isConfidential?: boolean;
  linkTo?: {
    entityType: string;
    entityId: string;
  };
}): Promise<{ documentId: string; versionId: string; reusedStorage: boolean }> {
  const { data: authData } = await supabase.auth.getUser();
  const userId = authData?.user?.id ?? null;

  // 1. Compute SHA-256 hash for deduplication
  const sha256 = await computeFileSha256(params.file);

  // 2. Check if identical content exists in universal_document_versions
  const existingFile = await findExistingFileBySha256(sha256);

  let storageBucket = 'documents';
  let storagePath = '';
  let fileUrl: string | null = null;
  let fileSize = params.file.size;
  let mimeType = params.file.type || 'application/octet-stream';
  let reusedStorage = false;

  if (existingFile) {
    // REUSE existing physical storage object! Zero new storage bytes!
    storageBucket = existingFile.storage_bucket;
    storagePath = existingFile.storage_path;
    fileUrl = existingFile.file_url;
    fileSize = existingFile.file_size;
    mimeType = existingFile.mime_type || mimeType;
    reusedStorage = true;
  } else {
    // Brand new content: optimize and upload
    const cleanFileName = params.file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    storagePath = `${params.sourceModule || 'general'}/${Date.now()}_${cleanFileName}`;

    const { error: uploadError, optimization } = await uploadOptimizedFile(
      supabase,
      storageBucket,
      storagePath,
      params.file
    );

    if (uploadError) {
      console.error('[UniversalDocumentBank] Upload error:', uploadError);
      throw uploadError;
    }

    fileSize = optimization?.optimizedSize ?? params.file.size;
    mimeType = optimization?.mimeType ?? mimeType;

    const { data: pubData } = supabase.storage.from(storageBucket).getPublicUrl(storagePath);
    fileUrl = pubData?.publicUrl || null;
  }

  // 3. Insert Logical Document Record
  const docTitle = params.title?.trim() || params.file.name;
  const status: UniversalLifecycleStatus = params.lifecycleStatus || 'TEMP';

  const { data: docData, error: docError } = await supabase
    .from('universal_documents')
    .insert({
      title: docTitle,
      document_type: params.documentType,
      specification: params.specification || null,
      document_date: params.documentDate || null,
      valid_until: params.validUntil || null,
      lifecycle_status: status,
      source_module: params.sourceModule || 'system',
      notes: params.notes || null,
      is_confidential: Boolean(params.isConfidential),
      primary_product_id: params.productId || null,
      primary_product_source_id: params.productSourceId || null,
      primary_batch_id: params.batchId || null,
      batch_number: params.batchNumber || null,
      created_by: userId,
      reviewed_by: status === 'BANKED' ? userId : null,
      reviewed_at: status === 'BANKED' ? new Date().toISOString() : null,
    })
    .select('id')
    .single();

  if (docError || !docData) {
    throw docError || new Error('Failed to create universal document record');
  }

  const documentId = docData.id;

  // 4. Insert Physical Version Record (v1)
  const { data: verData, error: verError } = await supabase
    .from('universal_document_versions')
    .insert({
      document_id: documentId,
      version_number: 1,
      storage_bucket: storageBucket,
      storage_path: storagePath,
      file_url: fileUrl,
      original_file_name: params.file.name,
      file_size: fileSize,
      mime_type: mimeType,
      sha256: sha256,
      change_summary: reusedStorage ? 'Reused existing verified content' : 'Initial upload',
      is_current: true,
      uploaded_by: userId,
    })
    .select('id')
    .single();

  if (verError || !verData) {
    throw verError || new Error('Failed to create universal document version record');
  }

  const versionId = verData.id;

  // 5. Point current_version_id
  await supabase
    .from('universal_documents')
    .update({ current_version_id: versionId })
    .eq('id', documentId);

  // 6. Create Entity Linkages
  if (params.linkTo) {
    await supabase.from('universal_document_links').insert({
      document_id: documentId,
      document_version_id: versionId,
      entity_type: params.linkTo.entityType,
      entity_id: params.linkTo.entityId,
      product_id: params.productId || null,
      product_source_id: params.productSourceId || null,
      batch_id: params.batchId || null,
      batch_number: params.batchNumber || null,
      is_primary: true,
      created_by: userId,
    });
  } else if (params.productId) {
    await supabase.from('universal_document_links').insert({
      document_id: documentId,
      document_version_id: versionId,
      entity_type: 'product',
      entity_id: params.productId,
      product_id: params.productId,
      product_source_id: params.productSourceId || null,
      is_primary: true,
      created_by: userId,
    });
  }

  return { documentId, versionId, reusedStorage };
}

/**
 * Upload a revised version of an existing document without overwriting previous versions
 */
export async function uploadRevisedDocumentVersion(params: {
  documentId: string;
  file: File;
  changeSummary: string;
}): Promise<{ versionId: string; versionNumber: number; reusedStorage: boolean }> {
  const { data: authData } = await supabase.auth.getUser();
  const userId = authData?.user?.id ?? null;

  // Get current max version number
  const { data: currentVersions, error: fetchErr } = await supabase
    .from('universal_document_versions')
    .select('version_number')
    .eq('document_id', params.documentId)
    .order('version_number', { ascending: false })
    .limit(1);

  if (fetchErr) throw fetchErr;

  const nextVersionNumber = (currentVersions?.[0]?.version_number || 0) + 1;

  // Compute SHA-256 hash
  const sha256 = await computeFileSha256(params.file);
  const existingFile = await findExistingFileBySha256(sha256);

  let storageBucket = 'documents';
  let storagePath = '';
  let fileUrl: string | null = null;
  let fileSize = params.file.size;
  let mimeType = params.file.type || 'application/octet-stream';
  let reusedStorage = false;

  if (existingFile) {
    storageBucket = existingFile.storage_bucket;
    storagePath = existingFile.storage_path;
    fileUrl = existingFile.file_url;
    fileSize = existingFile.file_size;
    mimeType = existingFile.mime_type || mimeType;
    reusedStorage = true;
  } else {
    const cleanFileName = params.file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    storagePath = `revisions/${Date.now()}_v${nextVersionNumber}_${cleanFileName}`;

    const { error: uploadError, optimization } = await uploadOptimizedFile(
      supabase,
      storageBucket,
      storagePath,
      params.file
    );

    if (uploadError) throw uploadError;

    fileSize = optimization?.optimizedSize ?? params.file.size;
    mimeType = optimization?.mimeType ?? mimeType;

    const { data: pubData } = supabase.storage.from(storageBucket).getPublicUrl(storagePath);
    fileUrl = pubData?.publicUrl || null;
  }

  // 1. Mark previous versions as not current
  await supabase
    .from('universal_document_versions')
    .update({ is_current: false })
    .eq('document_id', params.documentId);

  // 2. Insert new version
  const { data: verData, error: verError } = await supabase
    .from('universal_document_versions')
    .insert({
      document_id: params.documentId,
      version_number: nextVersionNumber,
      storage_bucket: storageBucket,
      storage_path: storagePath,
      file_url: fileUrl,
      original_file_name: params.file.name,
      file_size: fileSize,
      mime_type: mimeType,
      sha256: sha256,
      change_summary: params.changeSummary || `Version ${nextVersionNumber}`,
      is_current: true,
      uploaded_by: userId,
    })
    .select('id')
    .single();

  if (verError || !verData) throw verError || new Error('Failed to insert revision');

  // 3. Point document current_version_id to this new version
  await supabase
    .from('universal_documents')
    .update({
      current_version_id: verData.id,
      updated_at: new Date().toISOString(),
    })
    .eq('id', params.documentId);

  return {
    versionId: verData.id,
    versionNumber: nextVersionNumber,
    reusedStorage,
  };
}

/**
 * Update document metadata (Product, Make, Specification, Dates, Notes)
 */
export async function updateUniversalDocumentMetadata(
  documentId: string,
  updates: {
    title?: string;
    documentType?: UniversalDocumentType;
    specification?: string | null;
    documentDate?: string | null;
    validUntil?: string | null;
    primaryProductId?: string | null;
    primaryProductSourceId?: string | null;
    primaryBatchId?: string | null;
    batchNumber?: string | null;
    notes?: string | null;
  }
): Promise<void> {
  const updatePayload: Record<string, any> = {
    updated_at: new Date().toISOString(),
  };

  if (updates.title !== undefined) updatePayload.title = updates.title;
  if (updates.documentType !== undefined) updatePayload.document_type = updates.documentType;
  if (updates.specification !== undefined) updatePayload.specification = updates.specification;
  if (updates.documentDate !== undefined) updatePayload.document_date = updates.documentDate;
  if (updates.validUntil !== undefined) updatePayload.valid_until = updates.validUntil;
  if (updates.primaryProductId !== undefined)
    updatePayload.primary_product_id = updates.primaryProductId;
  if (updates.primaryProductSourceId !== undefined)
    updatePayload.primary_product_source_id = updates.primaryProductSourceId;
  if (updates.primaryBatchId !== undefined) updatePayload.primary_batch_id = updates.primaryBatchId;
  if (updates.batchNumber !== undefined) updatePayload.batch_number = updates.batchNumber;
  if (updates.notes !== undefined) updatePayload.notes = updates.notes;

  const { error } = await supabase
    .from('universal_documents')
    .update(updatePayload)
    .eq('id', documentId);

  if (error) throw error;
}

/**
 * Update document lifecycle (TEMP -> REVIEWED -> BANKED -> ARCHIVED)
 */
export async function updateUniversalDocumentLifecycle(
  documentId: string,
  newStatus: UniversalLifecycleStatus,
  reviewNotes?: string
): Promise<void> {
  const { data: authData } = await supabase.auth.getUser();
  const userId = authData?.user?.id ?? null;

  const payload: Record<string, any> = {
    lifecycle_status: newStatus,
    updated_at: new Date().toISOString(),
    reviewed_by: userId,
    reviewed_at: new Date().toISOString(),
  };

  if (reviewNotes) {
    payload.notes = reviewNotes;
  }

  const { error } = await supabase.from('universal_documents').update(payload).eq('id', documentId);

  if (error) throw error;
}

/**
 * Link an existing universal document to an entity (Product, Make, Batch, Inquiry, Quote, Order)
 * without creating any duplicate file!
 */
export async function linkUniversalDocument(params: {
  documentId: string;
  documentVersionId?: string | null;
  entityType: string;
  entityId: string;
  productId?: string | null;
  productSourceId?: string | null;
  batchId?: string | null;
  batchNumber?: string | null;
  notes?: string | null;
  isPrimary?: boolean;
}): Promise<string> {
  const { data: authData } = await supabase.auth.getUser();
  const userId = authData?.user?.id ?? null;

  const { data, error } = await supabase
    .from('universal_document_links')
    .insert({
      document_id: params.documentId,
      document_version_id: params.documentVersionId || null,
      entity_type: params.entityType,
      entity_id: params.entityId,
      product_id: params.productId || null,
      product_source_id: params.productSourceId || null,
      batch_id: params.batchId || null,
      batch_number: params.batchNumber || null,
      notes: params.notes || null,
      is_primary: Boolean(params.isPrimary),
      created_by: userId,
    })
    .select('id')
    .single();

  if (error || !data) throw error || new Error('Failed to link document');
  return data.id;
}

/**
 * Remove an entity link
 */
export async function unlinkUniversalDocument(linkId: string): Promise<void> {
  const { error } = await supabase.from('universal_document_links').delete().eq('id', linkId);

  if (error) throw error;
}

/**
 * Auto-surface approved BANKED documents matching Product, Make, and/or Batch
 * Used in CRM Inquiries, Customer Quotation Drawer, Pricing Desk, and Batches.
 */
export async function findBankedDocumentsForProductMakeBatch(params: {
  productId?: string | null;
  productSourceId?: string | null;
  batchNumber?: string | null;
  documentTypes?: UniversalDocumentType[];
}): Promise<UniversalDocumentRecord[]> {
  if (!params.productId && !params.productSourceId && !params.batchNumber) {
    return [];
  }

  let query = supabase
    .from('vw_universal_document_bank')
    .select('*')
    .eq('lifecycle_status', 'BANKED');

  if (params.productId) {
    query = query.eq('primary_product_id', params.productId);
  }

  if (params.productSourceId) {
    query = query.eq('primary_product_source_id', params.productSourceId);
  }

  if (params.batchNumber) {
    query = query.ilike('batch_number', `%${params.batchNumber}%`);
  }

  if (params.documentTypes && params.documentTypes.length > 0) {
    query = query.in('document_type', params.documentTypes);
  }

  const { data, error } = await query.order('created_at', { ascending: false });
  if (error) {
    console.error('[UniversalDocumentBank] Error auto-surfacing documents:', error);
    return [];
  }

  return (data || []) as UniversalDocumentRecord[];
}

/**
 * Safe document URL resolver: resolves private Supabase storage path into signed URL with caching
 */
export async function resolveDocumentViewUrl(
  bucket: string,
  path: string,
  fileUrl?: string | null
): Promise<string> {
  if (!bucket || !path) {
    return fileUrl || '';
  }

  try {
    const signed = await getSignedUrlCached(bucket, path, 3600);
    if (signed) return signed;
  } catch (err) {
    console.warn('[UniversalDocumentBank] Error generating signed URL:', err);
  }

  return fileUrl || '';
}

/**
 * Safe deletion / archive:
 * If document is BANKED, archivation is enforced instead of hard deletion to protect history.
 */
export async function safeArchiveOrDeleteDocument(
  documentId: string,
  forceDelete = false
): Promise<{ success: boolean; action: 'DELETED' | 'ARCHIVED' }> {
  // Check lifecycle status
  const { data: doc, error: fetchErr } = await supabase
    .from('universal_documents')
    .select('lifecycle_status, current_version_id')
    .eq('id', documentId)
    .single();

  if (fetchErr || !doc) throw fetchErr || new Error('Document not found');

  if (doc.lifecycle_status === 'BANKED' && !forceDelete) {
    // BANKED documents must be archived to protect historical references
    await updateUniversalDocumentLifecycle(documentId, 'ARCHIVED', 'Archived by user');
    return { success: true, action: 'ARCHIVED' };
  }

  // Hard delete permitted for TEMP / ARCHIVED
  const { error: delError } = await supabase
    .from('universal_documents')
    .delete()
    .eq('id', documentId);

  if (delError) throw delError;

  return { success: true, action: 'DELETED' };
}
