import{j as e}from"./index-Am3NB057.js";import{C as o}from"./CompanyLogo-aTpN9PGk.js";function p({co:t,title:i,titleClassName:s=""}){var a,n;return e.jsxs("div",{className:"mb-3 border-2 border-black p-3 print:mb-2 print:p-2",children:[e.jsxs("div",{className:"mb-2 flex items-start justify-between gap-4",children:[e.jsxs("div",{className:"flex min-w-0 items-start gap-3",children:[e.jsx("div",{className:"flex items-center justify-center",style:{width:"80px",height:"80px",flexShrink:0,backgroundColor:"#fff"},children:e.jsx(o,{logoUrl:t.company_logo_url,alt:t.company_name,style:{maxWidth:"100%",maxHeight:"100%",width:"auto",height:"auto",objectFit:"contain"}})}),e.jsxs("div",{className:"min-w-0",style:{maxWidth:"340px"},children:[e.jsx("h1",{className:"text-base font-bold print:text-sm",style:{overflowWrap:"anywhere"},children:t.company_name}),t.company_address&&e.jsx("p",{className:"text-xs print:text-[10px]",style:{overflowWrap:"anywhere",whiteSpace:"normal"},children:t.company_address}),t.company_phone&&e.jsxs("p",{className:"text-xs print:text-[10px]",children:["Telp: ",t.company_phone]})]})]}),e.jsx("div",{className:"flex-shrink-0 text-right",children:e.jsx("h2",{className:`text-3xl font-bold print:text-2xl ${s}`,children:i})})]}),e.jsxs("div",{className:"text-xs space-y-0.5 print:text-[10px] print:space-y-0",children:[e.jsxs("div",{children:[e.jsx("span",{className:"font-semibold",children:"No izin PBF"}),e.jsxs("span",{className:"ml-16",children:[": ",((a=t.pbf_license)==null?void 0:a.replace(/^No izin PBF:\s*/i,""))??"—"]})]}),e.jsxs("div",{children:[e.jsx("span",{className:"font-semibold",children:"No Sertifikasi CDOB"}),e.jsxs("span",{className:"ml-4",children:[": ",((n=t.cdob_certificate)==null?void 0:n.replace(/^No Sertifikasi CDOB:\s*/i,""))??"—"]})]})]})]})}function d({contentId:t}){const i=`
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
      body *:not(:has(#${t})):not(#${t}):not(#${t} *) {
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
      #${t} {
        position: static !important;
        width: 100% !important;
        padding: 0 !important;
        transform: none !important;
      }

      /* Keep structural blocks intact; let long tables paginate cleanly. */
      #${t} > div {
        page-break-inside: avoid;
        break-inside: avoid;
      }
      #${t} table {
        page-break-inside: auto;
        break-inside: auto;
      }
      #${t} tr {
        page-break-inside: avoid;
        break-inside: avoid;
      }
      #${t} thead {
        display: table-header-group;
      }
      #${t} tfoot {
        display: table-footer-group;
      }

      /* Screen-only and print-hidden element suppression */
      .printHidden,
      .screenOnly,
      .no-print,
      [data-screen-only="true"] {
        display: none !important;
      }
    }
  `;return e.jsx("style",{children:i})}export{p as D,d as a};
