import { X, AlertCircle } from 'lucide-react';

// Rendered in place of a business document header when the document's
// company_snapshot is null / incomplete. Documents MUST NOT silently
// substitute FALLBACK_COMPANY — that would misrepresent the document
// and misprint on the customer's copy. Instead we refuse to render the
// document and prompt the operator to run the backfill migration or
// contact an admin.
export function SnapshotMissingError({
  documentType,
  documentNumber,
  onClose,
}: {
  documentType: string;
  documentNumber: string;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-gray-900 bg-opacity-75">
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="relative w-full max-w-lg rounded-xl bg-white shadow-2xl">
          <div className="flex items-center justify-between border-b px-5 py-3">
            <h2 className="flex items-center gap-2 text-base font-semibold text-red-700">
              <AlertCircle className="h-5 w-5" />
              {documentType} cannot be rendered
            </h2>
            <button
              onClick={onClose}
              className="rounded-lg bg-gray-100 p-1.5 text-gray-600 hover:bg-gray-200"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="space-y-3 px-5 py-4 text-sm text-gray-700">
            <p>
              <span className="font-mono font-semibold">{documentNumber}</span> has no{' '}
              <code className="rounded bg-gray-100 px-1 py-0.5 text-xs">company_snapshot</code>{' '}
              on record, so the printable header, tax details and logo cannot be
              reconstructed accurately.
            </p>
            <p>
              Print and PDF export are disabled to prevent the document from
              being issued with placeholder company details.
            </p>
            <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              Ask an admin to apply the snapshot backfill migration
              (<code>20260714210000_backfill_missing_company_snapshots.sql</code>) or,
              if this document is a one-off legacy row, stamp its
              <code className="mx-1">company_snapshot</code> manually from the
              current Company Profile.
            </div>
          </div>
          <div className="flex justify-end border-t px-5 py-3">
            <button
              onClick={onClose}
              className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
