/**
 * documentBankService.ts
 *
 * Safe operations and storage calculation service for ANZEN CRM Document Bank.
 * Handles deletion planning, protection guards, shared storage path detection,
 * and coordinated storage object + metadata record removal.
 */

import { supabase } from '../../lib/supabase.ts';
import { invalidateSignedUrl } from '../../utils/signedUrlCache.ts';

export interface CrmProductDocumentRecord {
  id: string;
  inquiry_id: string | null;
  product_name: string | null;
  make: string | null;
  document_type: string;
  specification: string | null;
  is_permanent: boolean;
  pricing_option_id: string | null;
  original_file_name: string | null;
  display_file_name: string | null;
  storage_bucket?: string | null;
  storage_path: string;
  uploaded_by: string | null;
  source_gmail_message_id: string | null;
  source_email_subject?: string | null;
  file_size?: number | null;
  mime_type?: string | null;
  created_at: string;
  enquiry_request_id?: string | null;
  crm_inquiries?: { inquiry_number: string }[] | null;
}

export interface DocumentBankStats {
  total_documents: number;
  total_document_bytes: number;
  bucket_total_objects: number;
  bucket_total_bytes: number;
  unlinked_objects_count: number;
  unlinked_objects_bytes: number;
  junk_other_count: number;
  junk_other_bytes: number;
  permanent_count: number;
  linked_inquiry_count: number;
  linked_pricing_option_count: number;
}

export interface UnlinkedStorageObject {
  id: string;
  name: string;
  size_bytes: number;
  mime_type: string;
  created_at: string;
  folder: string;
  detected_reference: string;
}

export interface ProtectedDocumentItem {
  doc: CrmProductDocumentRecord;
  reason: string;
}

export interface EligibleDeletionItem {
  doc: CrmProductDocumentRecord;
  isSharedStorage: boolean;
  sharedCount: number;
}

export interface DeletionPlan {
  totalSelected: number;
  eligible: EligibleDeletionItem[];
  protected: ProtectedDocumentItem[];
  reclaimableBytes: number;
  filesToDeleteCount: number;
  recordsToDeleteCount: number;
}

export interface DeletionExecutionResult {
  success: boolean;
  dryRun: boolean;
  deletedRecordIds: string[];
  deletedStoragePaths: string[];
  failedItems: { id: string; filename: string; error: string }[];
  reclaimedBytes: number;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || isNaN(bytes) || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const val = bytes / Math.pow(k, i);
  return `${val.toFixed(i === 0 ? 0 : 2)} ${sizes[i]}`;
}

/**
 * Evaluates selected documents and builds a safe deletion plan,
 * guaranteeing all permanent and referenced documents are protected.
 */
export function buildDeletionPlan(
  selectedDocs: CrmProductDocumentRecord[],
  allDocs: CrmProductDocumentRecord[]
): DeletionPlan {
  const protectedItems: ProtectedDocumentItem[] = [];
  const eligibleItems: EligibleDeletionItem[] = [];

  // Count usage of each storage_path across ALL documents in the database
  const storagePathUsage = new Map<string, number>();
  for (const d of allDocs) {
    if (d.storage_path) {
      storagePathUsage.set(d.storage_path, (storagePathUsage.get(d.storage_path) || 0) + 1);
    }
  }

  // Set of selected doc IDs
  const selectedIds = new Set(selectedDocs.map(d => d.id));

  // Count how many documents with this storage_path are NOT selected for deletion
  const unselectedStoragePathCount = new Map<string, number>();
  for (const d of allDocs) {
    if (d.storage_path && !selectedIds.has(d.id)) {
      unselectedStoragePathCount.set(
        d.storage_path,
        (unselectedStoragePathCount.get(d.storage_path) || 0) + 1
      );
    }
  }

  let reclaimableBytes = 0;
  const accountedStoragePaths = new Set<string>();

  for (const doc of selectedDocs) {
    // 1. Permanent status check
    if (doc.is_permanent) {
      protectedItems.push({
        doc,
        reason: 'Marked as Permanent / Banked document.',
      });
      continue;
    }

    // 2. Inquiry reference check
    if (doc.inquiry_id) {
      const inqNum = doc.crm_inquiries?.[0]?.inquiry_number || doc.inquiry_id;
      protectedItems.push({
        doc,
        reason: `Linked to CRM Inquiry ${inqNum}.`,
      });
      continue;
    }

    // 3. Pricing option reference check
    if (doc.pricing_option_id) {
      protectedItems.push({
        doc,
        reason: 'Linked to Sourcing Pricing Option.',
      });
      continue;
    }

    // 4. Enquiry request reference check
    if (doc.enquiry_request_id) {
      protectedItems.push({
        doc,
        reason: 'Linked to Enquiry Request.',
      });
      continue;
    }

    // Eligible for deletion
    const totalUsage = storagePathUsage.get(doc.storage_path) || 1;
    const remainingUsage = unselectedStoragePathCount.get(doc.storage_path) || 0;
    const isSharedWithOtherDocs = remainingUsage > 0;

    eligibleItems.push({
      doc,
      isSharedStorage: isSharedWithOtherDocs,
      sharedCount: totalUsage,
    });

    // Reclaim storage bytes only if physical file will be removed and not already accounted
    if (!isSharedWithOtherDocs && !accountedStoragePaths.has(doc.storage_path)) {
      reclaimableBytes += doc.file_size || 0;
      accountedStoragePaths.add(doc.storage_path);
    }
  }

  return {
    totalSelected: selectedDocs.length,
    eligible: eligibleItems,
    protected: protectedItems,
    reclaimableBytes,
    filesToDeleteCount: accountedStoragePaths.size,
    recordsToDeleteCount: eligibleItems.length,
  };
}

/**
 * Executes or simulates safe bulk deletion.
 * Uses the authenticated Supabase Storage API first, then deletes metadata records.
 */
export async function executeSafeDeletion(
  plan: DeletionPlan,
  options?: {
    dryRun?: boolean;
    onProgress?: (completed: number, total: number, currentItem: string) => void;
  }
): Promise<DeletionExecutionResult> {
  const dryRun = options?.dryRun ?? false;
  const deletedRecordIds: string[] = [];
  const deletedStoragePaths: string[] = [];
  const failedItems: { id: string; filename: string; error: string }[] = [];
  let reclaimedBytes = 0;

  const total = plan.eligible.length;

  if (dryRun) {
    // Pure simulation
    for (let i = 0; i < total; i++) {
      const item = plan.eligible[i];
      options?.onProgress?.(i + 1, total, item.doc.display_file_name || item.doc.storage_path);
      deletedRecordIds.push(item.doc.id);
      if (!item.isSharedStorage && !deletedStoragePaths.includes(item.doc.storage_path)) {
        deletedStoragePaths.push(item.doc.storage_path);
        reclaimedBytes += item.doc.file_size || 0;
      }
    }
    return {
      success: true,
      dryRun: true,
      deletedRecordIds,
      deletedStoragePaths,
      failedItems: [],
      reclaimedBytes,
    };
  }

  // Real deletion execution
  for (let i = 0; i < total; i++) {
    const item = plan.eligible[i];
    const doc = item.doc;
    const displayName = doc.display_file_name || doc.original_file_name || doc.storage_path;
    options?.onProgress?.(i + 1, total, displayName);

    try {
      // Step A: If not shared with other remaining documents, remove physical object via Storage API
      if (!item.isSharedStorage && !deletedStoragePaths.includes(doc.storage_path)) {
        invalidateSignedUrl('crm-documents', doc.storage_path);
        const { error: storageErr } = await supabase.storage
          .from('crm-documents')
          .remove([doc.storage_path]);

        if (storageErr) {
          throw new Error(`Storage remove error: ${storageErr.message}`);
        }
        deletedStoragePaths.push(doc.storage_path);
        reclaimedBytes += doc.file_size || 0;
      }

      // Step B: Only after physical file removed (or confirmed shared), delete metadata record
      const { error: dbErr } = await supabase
        .from('crm_product_documents')
        .delete()
        .eq('id', doc.id);

      if (dbErr) {
        throw new Error(`Database record delete error: ${dbErr.message}`);
      }

      deletedRecordIds.push(doc.id);
    } catch (err: any) {
      console.error(`Failed to delete document ${doc.id} (${displayName}):`, err);
      failedItems.push({
        id: doc.id,
        filename: displayName,
        error: err.message || String(err),
      });
    }
  }

  return {
    success: failedItems.length === 0,
    dryRun: false,
    deletedRecordIds,
    deletedStoragePaths,
    failedItems,
    reclaimedBytes,
  };
}

export async function fetchDocumentBankStats(): Promise<DocumentBankStats | null> {
  try {
    const { data, error } = await supabase.rpc('get_crm_document_bank_stats');
    if (error) {
      console.warn('Document bank stats error:', error);
      return null;
    }
    return data as DocumentBankStats;
  } catch (err) {
    console.error('Failed to fetch Document Bank stats:', err);
    return null;
  }
}

export async function fetchUnlinkedStorageObjects(): Promise<UnlinkedStorageObject[]> {
  try {
    const { data, error } = await supabase.rpc('get_crm_unlinked_storage_objects');
    if (error) {
      console.warn('Unlinked storage objects error:', error);
      return [];
    }
    return (data || []) as UnlinkedStorageObject[];
  } catch (err) {
    console.error('Failed to fetch unlinked storage objects:', err);
    return [];
  }
}

