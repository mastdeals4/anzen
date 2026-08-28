interface DocumentPrintStylesProps {
  /** id of the print-content root (e.g. "invoice-print-content"). */
  contentId: string;
}

// Single source of truth for print CSS shared by every printable business
// document. Rendered once per document view. Guarantees that View, Print
// Preview, Print and PDF Export produce an identical A4 layout in Chrome,
// Safari and Edge.
//
// What it does during @media print:
//   • Neutralises the on-screen modal shell — the fixed/inset overlay, the
//     min-h-screen flex centering wrapper, scroll containers and any
//     transforms — all of which otherwise corrupt pagination (blank pages,
//     shifted content, clipped edges).
//   • Isolates the print-content subtree via the visibility technique so
//     only the document prints, then re-anchors it at the page origin at a
//     true A4 width.
//   • Prevents page splitting inside header/summary blocks while still
//     allowing long item tables to break across pages with repeated header
//     rows — so a one-page document reliably prints as exactly one page.
export function DocumentPrintStyles({ contentId }: DocumentPrintStylesProps) {
  const css = `
    @media print {
      @page {
        size: A4 portrait;
        margin: 8mm;
      }

      html, body {
        margin: 0 !important;
        padding: 0 !important;
        background: #ffffff !important;
        height: auto !important;
        overflow: visible !important;
      }

      /* Print-content isolation by REMOVAL, not visibility.
         The document renders inside the app shell (a min-h-screen Layout
         plus the page's list), so the modal is preceded in normal flow by
         a tall dashboard. The old visibility:hidden technique hid that
         dashboard but left its full height in the layout, so the printed
         document spanned as many pages as the list behind it — producing
         trailing blank pages.
         Instead, drop from layout every element that is NOT the document,
         NOT inside it, and does NOT contain it. Its ancestor chain is kept
         via :has() so the document survives; every sibling subtree (the
         dashboard, action bar, other panels) collapses to zero height, so
         page count is driven solely by the document's own height. */
      body *:not(:has(#${contentId})):not(#${contentId}):not(#${contentId} *) {
        display: none !important;
      }

      /* Flatten the modal shell wrappers so the document sits at the page
         origin in normal flow — no fixed positioning, viewport heights,
         scroll containers, flex centering or transforms to corrupt
         pagination. Markers: .doc-print-root / -scroll / -sheet. */
      .doc-print-root,
      .doc-print-scroll,
      .doc-print-sheet {
        position: static !important;
        inset: auto !important;
        display: block !important;
        min-height: 0 !important;
        height: auto !important;
        width: auto !important;
        max-width: 100% !important;
        margin: 0 !important;
        padding: 0 !important;
        overflow: visible !important;
        background: #ffffff !important;
        box-shadow: none !important;
        transform: none !important;
      }

      /* The document flows normally (not absolutely positioned) so long
         invoices paginate correctly and short ones occupy exactly one page. */
      #${contentId} {
        position: static !important;
        width: 100% !important;
        padding: 0 !important;
        transform: none !important;
      }

      /* Keep structural blocks intact; let long tables paginate cleanly. */
      #${contentId} > div {
        page-break-inside: avoid;
        break-inside: avoid;
      }
      #${contentId} table {
        page-break-inside: auto;
        break-inside: auto;
      }
      #${contentId} tr {
        page-break-inside: avoid;
        break-inside: avoid;
      }
      #${contentId} thead {
        display: table-header-group;
      }
      #${contentId} tfoot {
        display: table-footer-group;
      }
    }
  `;
  return <style>{css}</style>;
}
