import { useEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { ChevronDown, ChevronUp } from 'lucide-react';

interface EmailBodyViewerProps {
  htmlContent: string;
  className?: string;
}

export function EmailBodyViewer({ htmlContent, className = '' }: EmailBodyViewerProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [iframeHeight, setIframeHeight] = useState(500);
  const [quotedSectionsCollapsed, setQuotedSectionsCollapsed] = useState<Record<number, boolean>>({});

  useEffect(() => {
    if (!iframeRef.current || !htmlContent) return;

    const iframe = iframeRef.current;

    // Decode HTML entities to fix encoding issues
    const decodeHTML = (html: string): string => {
      const textarea = document.createElement('textarea');
      textarea.innerHTML = html;
      return textarea.value;
    };

    const decodedHTML = decodeHTML(htmlContent);

    let processedHTML = decodedHTML;

    processedHTML = processedHTML.replace(
      /<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi,
      (match, content, offset) => {
        const id = Math.random().toString(36).substr(2, 9);
        return `<div class="quoted-section" data-quote-id="${id}">
          <div class="quoted-toggle" onclick="toggleQuote('${id}')">
            <span class="toggle-icon">...</span>
          </div>
          <blockquote class="quoted-content" id="quote-${id}" style="display: none;">${content}</blockquote>
        </div>`;
      }
    );

    const sanitizedHTML = DOMPurify.sanitize(processedHTML, {
      ALLOWED_TAGS: [
        'html', 'head', 'body', 'meta', 'title', 'style',
        'p', 'br', 'div', 'span', 'a', 'img',
        'strong', 'em', 'u', 'b', 'i', 's', 'strike',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'ul', 'ol', 'li',
        'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
        'font', 'center', 'blockquote', 'pre', 'code',
        'hr', 'sup', 'sub'
      ],
      ALLOWED_ATTR: [
        'style', 'class', 'id',
        'href', 'target', 'rel',
        'src', 'alt', 'title', 'width', 'height',
        'align', 'valign',
        'border', 'cellpadding', 'cellspacing',
        'bgcolor', 'color', 'face', 'size',
        'data-quote-id', 'onclick'
      ],
      ALLOW_DATA_ATTR: true,
      ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|cid|xmpp|data):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
    });

    const emailStyles = `
      <style>
        * {
          box-sizing: border-box;
        }
        body {
          font-family: Arial, sans-serif;
          font-size: 14px;
          line-height: 1.6;
          color: #202124;
          margin: 0;
          padding: 16px;
          background: white;
          overflow-x: hidden;
          word-wrap: break-word;
        }

        /* Table styling - Gmail style */
        table {
          border-collapse: collapse !important;
          width: auto !important;
          max-width: 100%;
          margin: 12px 0;
          font-size: 13px;
        }

        table, th, td {
          border: 1px solid #000 !important;
        }

        th, td {
          padding: 6px 10px !important;
          text-align: left;
          vertical-align: top;
          word-break: break-word;
        }

        th {
          font-weight: 700 !important;
        }

        /* Preserve inline styles and colors */
        th[bgcolor], td[bgcolor] {
          /* Browser will apply bgcolor attribute */
        }

        /* Common email table colors */
        [bgcolor="#FFFF00"], [bgcolor="yellow"], [style*="background:yellow"], [style*="background-color:yellow"] {
          background-color: #FFFF00 !important;
        }

        [bgcolor="#E6E6FA"], [bgcolor="lavender"], [style*="background:lavender"], [style*="background-color:lavender"] {
          background-color: #E6E6FA !important;
        }

        [style*="color:blue"], [style*="color:#0000FF"] {
          color: #0000FF !important;
        }

        [style*="color:darkblue"], [style*="color:#00008B"] {
          color: #00008B !important;
        }

        /* Typography */
        p {
          margin: 8px 0;
        }

        a {
          color: #1a73e8;
          text-decoration: none;
        }

        a:hover {
          text-decoration: underline;
        }

        strong, b {
          font-weight: 700;
        }

        em, i {
          font-style: italic;
        }

        /* Lists */
        ul, ol {
          margin: 8px 0;
          padding-left: 24px;
        }

        li {
          margin: 4px 0;
        }

        /* Blockquotes */
        blockquote {
          margin: 8px 0;
          padding-left: 16px;
          border-left: 4px solid #ccc;
          color: #666;
        }

        /* Quoted section styling */
        .quoted-section {
          margin: 12px 0;
        }

        .quoted-toggle {
          display: inline-block;
          color: #1a73e8;
          cursor: pointer;
          font-size: 13px;
          padding: 4px 8px;
          border-radius: 4px;
          user-select: none;
        }

        .quoted-toggle:hover {
          background-color: #f0f0f0;
        }

        .toggle-icon {
          display: inline-block;
          font-weight: bold;
        }

        .quoted-content {
          margin-top: 8px;
          padding-left: 16px;
          border-left: 4px solid #ccc;
          color: #666;
        }

        /* Headers */
        h1, h2, h3, h4, h5, h6 {
          margin: 12px 0 8px 0;
          font-weight: 700;
          line-height: 1.3;
        }

        /* Images */
        img {
          max-width: 100%;
          height: auto;
        }

        /* Horizontal rules */
        hr {
          border: none;
          border-top: 1px solid #dadce0;
          margin: 16px 0;
        }

        /* Prevent overflow */
        pre {
          white-space: pre-wrap;
          word-wrap: break-word;
          overflow-x: auto;
        }

        /* Center tag support */
        center {
          text-align: center;
        }
      </style>
    `;

    const fullHTML = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          ${emailStyles}
          <script>
            function toggleQuote(id) {
              const content = document.getElementById('quote-' + id);
              const toggle = content.previousElementSibling.querySelector('.toggle-icon');

              if (content.style.display === 'none') {
                content.style.display = 'block';
                toggle.textContent = '▼';
              } else {
                content.style.display = 'none';
                toggle.textContent = '...';
              }
            }
          </script>
        </head>
        <body>
          ${sanitizedHTML}
        </body>
      </html>
    `;

    // Use Blob with explicit UTF-8 encoding
    const blob = new Blob([fullHTML], { type: 'text/html; charset=UTF-8' });
    const blobURL = URL.createObjectURL(blob);
    iframe.src = blobURL;

    const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
    if (!iframeDoc) return;

    // Wait for iframe to load
    const handleLoad = () => {
      try {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
        if (!iframeDoc) return;

        const measureHeight = () => {
          const body = iframeDoc.body;
          const html = iframeDoc.documentElement;
          const height = Math.max(
            body?.scrollHeight || 0,
            body?.offsetHeight || 0,
            html?.clientHeight || 0,
            html?.scrollHeight || 0,
            html?.offsetHeight || 0
          );
          setIframeHeight(Math.max(height + 20, 100));
        };

        // Initial measurement
        measureHeight();

        // Observe size changes
        const resizeObserver = new ResizeObserver(measureHeight);
        if (iframeDoc.body) {
          resizeObserver.observe(iframeDoc.body);
        }

        // Remeasure after a delay to catch late-loading content
        setTimeout(measureHeight, 150);

        // Store cleanup in iframe data
        (iframe as any).__cleanup = () => {
          resizeObserver.disconnect();
          URL.revokeObjectURL(blobURL);
        };
      } catch (e) {
        console.error('Error measuring iframe height:', e);
      }
    };

    iframe.addEventListener('load', handleLoad);

    return () => {
      iframe.removeEventListener('load', handleLoad);
      if ((iframe as any).__cleanup) {
        (iframe as any).__cleanup();
      }
      URL.revokeObjectURL(blobURL);
    };
  }, [htmlContent]);

  if (!htmlContent || htmlContent.trim() === '') {
    return (
      <div className={`text-gray-500 italic p-4 ${className}`}>
        No email content available
      </div>
    );
  }

  return (
    <iframe
      ref={iframeRef}
      title="Email Content"
      className={`w-full border-0 ${className}`}
      style={{
        height: `${iframeHeight}px`,
        minHeight: '100px',
        maxHeight: '800px',
      }}
      sandbox="allow-same-origin"
      loading="lazy"
    />
  );
}
