import { useState, useEffect, useRef } from 'react';
import { Upload, Trash2, FileText, ExternalLink, Download, Image as ImageIcon } from 'lucide-react';
import { supabase } from '../../../lib/supabase';

type AttachmentTable = 'tax_payment_files' | 'faktur_pajak_files';

export const TAX_ATTACHMENT_BUCKET = 'documents';

interface Attachment {
  id: string;
  file_url: string;
  file_name: string;
  file_type: string | null;
  file_size: number | null;
  kind: string | null;
  uploaded_at: string;
  uploaded_by: string | null;
}

function showAttachmentDiagnostic(
  bucketName: string,
  storedPath: string,
  attemptedPath: string,
  message: string,
) {
  alert(`Attachment could not be opened.\n\nBucket: ${bucketName}\nStored path: ${storedPath}\nAttempted path: ${attemptedPath}\n\n${message}`);
}

async function verifyStoredAttachment(bucketName: string, storedPath: string): Promise<boolean> {
  const attemptedPath = storedPath;
  const { error } = await supabase.storage.from(bucketName).download(attemptedPath);
  if (error) {
    showAttachmentDiagnostic(bucketName, storedPath, attemptedPath, error.message);
    return false;
  }
  return true;
}

export async function openStoredAttachment(fileUrl: string, bucketName = TAX_ATTACHMENT_BUCKET): Promise<void> {
  const attemptedPath = fileUrl;
  if (!await verifyStoredAttachment(bucketName, attemptedPath)) return;
  const { data, error } = await supabase.storage
    .from(bucketName)
    .createSignedUrl(attemptedPath, 60 * 5);
  if (error || !data?.signedUrl) {
    showAttachmentDiagnostic(bucketName, fileUrl, attemptedPath, error?.message ?? 'Signed URL was not returned.');
    return;
  }
  window.open(data.signedUrl, '_blank', 'noopener');
}

interface Props {
  table: AttachmentTable;
  parentId: string;
  storagePrefix: string;
  allowedKinds: readonly { value: string; label: string }[];
  disabled?: boolean;
  showUploader?: boolean;
  allowDelete?: boolean;
}

const MAX_SIZE = 10 * 1024 * 1024;
const ALLOWED_MIME = [
  'application/pdf',
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp',
];

/**
 * Attachment component for Tax Compliance rows.
 *
 * Storage model mirrors petty_cash_files / expense docs:
 * - Files live in the shared "documents" Supabase storage bucket.
 * - Metadata rows live in tax_payment_files / faktur_pajak_files.
 * - Signed URLs are minted on demand (5-minute TTL) for preview/download.
 */
export function TaxAttachments({ table, parentId, storagePrefix, allowedKinds, disabled, showUploader = true, allowDelete = true }: Props) {
  const [items, setItems] = useState<Attachment[]>([]);
  const [uploaderNames, setUploaderNames] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState(false);
  const [kind, setKind] = useState<string>(allowedKinds[0]?.value ?? 'other');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const parentColumn = table === 'tax_payment_files' ? 'tax_payment_id' : 'faktur_pajak_id';

  useEffect(() => {
    if (!parentId) return;
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parentId, table]);

  async function refresh() {
    const { data, error } = await supabase
      .from(table)
      .select('id, file_url, file_name, file_type, file_size, kind, uploaded_at, uploaded_by')
      .eq(parentColumn, parentId)
      .order('uploaded_at', { ascending: false });
    if (error || !data) return;
    const attachments = data as Attachment[];
    setItems(attachments);
    const uploaderIds = [...new Set(attachments.map(a => a.uploaded_by).filter((id): id is string => Boolean(id)))];
    if (!uploaderIds.length) {
      setUploaderNames({});
      return;
    }
    const { data: profiles } = await supabase
      .from('user_profiles')
      .select('id, full_name, username, email')
      .in('id', uploaderIds);
    setUploaderNames(Object.fromEntries(((profiles as Array<{ id: string; full_name: string | null; username: string | null; email: string | null }> | null) ?? []).map(profile => [
      profile.id,
      profile.full_name || profile.username || profile.email || profile.id,
    ])));
  }

  async function upload(files: File[]) {
    if (!files.length) return;
    setUploading(true);
    try {
      for (const file of files) {
        if (!ALLOWED_MIME.includes(file.type)) {
          alert(`Skipping ${file.name}: only PDF / JPEG / PNG / WEBP are allowed.`);
          continue;
        }
        if (file.size > MAX_SIZE) {
          alert(`Skipping ${file.name}: max 10 MB.`);
          continue;
        }
        const path = `${storagePrefix}/${parentId}/${Date.now()}-${file.name.replace(/[^\w.-]/g, '_')}`;
        const { error: upErr } = await supabase.storage
          .from(TAX_ATTACHMENT_BUCKET)
          .upload(path, file, { upsert: false, contentType: file.type });
        if (upErr) throw upErr;

        const { error: insErr } = await supabase.from(table).insert({
          [parentColumn]: parentId,
          file_url: path,
          file_name: file.name,
          file_type: file.type,
          file_size: file.size,
          kind,
        });
        if (insErr) throw insErr;
      }
      await refresh();
    } catch (err) {
      alert('Upload failed: ' + (err as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function handlePaste(e: React.ClipboardEvent) {
    const imageItems = Array.from(e.clipboardData.items).filter(i => i.type.startsWith('image/'));
    if (!imageItems.length) return;
    e.preventDefault();
    const files: File[] = [];
    for (const item of imageItems) {
      const blob = item.getAsFile();
      if (blob) files.push(new File([blob], `pasted-${Date.now()}.png`, { type: blob.type }));
    }
    await upload(files);
  }

  async function preview(a: Attachment) {
    await openStoredAttachment(a.file_url);
  }

  async function download(a: Attachment) {
    const attemptedPath = a.file_url;
    if (!await verifyStoredAttachment(TAX_ATTACHMENT_BUCKET, attemptedPath)) return;
    const { data, error } = await supabase.storage
      .from(TAX_ATTACHMENT_BUCKET)
      .createSignedUrl(attemptedPath, 60 * 5, { download: a.file_name || true });
    if (error || !data?.signedUrl) {
      showAttachmentDiagnostic(TAX_ATTACHMENT_BUCKET, a.file_url, attemptedPath, error?.message ?? 'Signed URL was not returned.');
      return;
    }
    const link = document.createElement('a');
    link.href = data.signedUrl;
    link.download = a.file_name || 'faktur-pajak-document';
    link.target = '_blank';
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  async function remove(a: Attachment) {
    if (!confirm(`Delete ${a.file_name}?`)) return;
    await supabase.storage.from(TAX_ATTACHMENT_BUCKET).remove([a.file_url]);
    await supabase.from(table).delete().eq('id', a.id);
    await refresh();
  }

  return (
    <div className="space-y-2" onPaste={showUploader ? handlePaste : undefined}>
      {showUploader && <div className="flex items-center gap-2 flex-wrap">
        <select
          value={kind}
          onChange={e => setKind(e.target.value)}
          className="text-sm border rounded px-2 py-1 bg-white"
          disabled={disabled || uploading}
        >
          {allowedKinds.map(k => (
            <option key={k.value} value={k.value}>{k.label}</option>
          ))}
        </select>
        <label className="inline-flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded cursor-pointer hover:bg-blue-700 disabled:opacity-50">
          <Upload className="w-4 h-4" />
          {uploading ? 'Uploading…' : 'Upload'}
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            accept=".pdf,.jpg,.jpeg,.png,.webp"
            disabled={disabled || uploading}
            onChange={async (e) => {
              const list = Array.from(e.target.files ?? []);
              await upload(list);
              if (inputRef.current) inputRef.current.value = '';
            }}
          />
        </label>
        <span className="text-xs text-gray-500">or paste an image directly</span>
      </div>}

      {items.length === 0 ? (
        <p className="text-xs text-gray-500">No attachments yet.</p>
      ) : (
        <ul className="divide-y border rounded">
          {items.map(a => {
            const isImage = a.file_type?.startsWith('image/') ?? false;
            return (
              <li key={a.id} className="flex items-center gap-2 px-2 py-1.5 text-sm">
                {isImage
                  ? <ImageIcon className="w-4 h-4 text-blue-500 shrink-0" />
                  : <FileText className="w-4 h-4 text-red-500 shrink-0" />}
                <span className="flex-1 truncate">{a.file_name}</span>
                <span className="text-xs text-gray-500 shrink-0 px-1.5 py-0.5 bg-gray-100 rounded">
                  {allowedKinds.find(k => k.value === a.kind)?.label ?? a.kind ?? '—'}
                </span>
                <span className="text-xs text-gray-400 shrink-0">
                  {((a.file_size ?? 0) / 1024).toFixed(0)} KB
                </span>
                <span className="text-xs text-gray-400 shrink-0" title="Uploaded by">
                  {uploaderNames[a.uploaded_by ?? ''] ?? a.uploaded_by ?? 'Unknown user'}
                </span>
                <span className="text-xs text-gray-400 shrink-0" title="Upload date and time">
                  {new Date(a.uploaded_at).toLocaleString('id-ID')}
                </span>
                <button
                  type="button"
                  onClick={() => void preview(a)}
                  className="p-1 hover:bg-gray-100 rounded"
                  title="Preview"
                >
                  <ExternalLink className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => void download(a)}
                  className="p-1 hover:bg-gray-100 rounded"
                  title="Download"
                >
                  <Download className="w-4 h-4" />
                </button>
                {!disabled && allowDelete && (
                  <button
                    type="button"
                    onClick={() => void remove(a)}
                    className="p-1 hover:bg-red-50 text-red-600 rounded"
                    title="Delete"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
