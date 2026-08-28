import { useResolvedCompanyLogo } from '../utils/companyLogoUrl';

// Single source of truth for the "no logo on the snapshot" fallback.
// This is the same orange mark that was hardcoded into every document
// template before Company Profile Versioning added a company_logo_url
// column. Rendering it when a snapshot has no logo preserves the exact
// historical appearance of pre-versioning documents.
function LegacyDefaultLogo({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      xmlSpace="preserve"
      width="100%"
      height="100%"
      viewBox="0 0 15686.55 15480.24"
      className={className}
      style={{ shapeRendering: 'geometricPrecision', fillRule: 'evenodd', clipRule: 'evenodd', ...style }}
    >
      <g>
        <path fill="#FDB763" d="M69.94 10438.12l10353.39 0 0 -1798.67 1665.92 0 0 1868.6 0 320.44 0 4552.28c0,38.48 -31.45,69.94 -69.94,69.94l-11949.38 0c-38.48,0 -69.94,-31.45 -69.94,-69.94l0 -4872.72c0,-38.48 31.45,-69.94 69.94,-69.94zm1605.9 1710.15l8737.57 0c13.58,0 24.68,11.11 24.68,24.68l0 1719.84c0,13.58 -11.11,24.68 -24.68,24.68l-8737.57 0c-13.58,0 -24.68,-11.11 -24.68,-24.68l0 -1719.84c0,-13.58 11.11,-24.68 24.68,-24.68z" />
        <path fill="#FDB763" d="M15587.15 5136.67l-10353.49 0 0 1822.07 -1665.92 0 0 -1892.9 0 -324.61 0 -4611.43c0,-39 31.45,-70.87 69.94,-70.87l11949.47 0c38.48,0 69.94,31.87 69.94,70.87l0 4936.04c0,39 -31.45,70.83 -69.94,70.83zm-1605.9 -1732.36l-8737.67 0c-13.58,0 -24.68,-11.27 -24.68,-25l0 -1742.21c0,-13.74 11.11,-25 24.68,-25l8737.67 0c13.58,0 24.68,11.27 24.68,25l0 1742.21c0,13.74 -11.11,25 -24.68,25z" />
        <polygon fill="#FD6D26" points="-0,0 1651.16,0 1651.16,6929.27 15657.09,6929.27 15657.09,6958.74 15686.55,6958.74 15686.55,15480.24 14022.85,15480.24 14022.85,8639.45 1651.16,8639.45 -0,8639.45 -0,6929.27" />
      </g>
    </svg>
  );
}

interface CompanyLogoProps {
  // Value stored on the document's immutable company_snapshot.
  // May be null (older documents), a storage path ("logo/<uuid>.svg"), or
  // a fully-qualified URL (data:, http, https).
  //
  // Views should also call useResolvedCompanyLogo(logoUrl) themselves to
  // know when the async signed URL is ready, and gate Print/PDF buttons
  // on that readiness. Otherwise html2canvas can rasterise the fallback
  // SVG mark instead of the real logo.
  logoUrl?: string | null;
  alt?: string;
  className?: string;
  style?: React.CSSProperties;
}

// Renders a business document's company logo strictly from the document's
// own snapshot. Never reads global settings or FALLBACK_COMPANY, never
// imports an application-branding asset. If the snapshot has no logo URL
// (or the signed URL fails), the legacy default mark is used so
// historical documents keep their original appearance byte-for-byte.
export function CompanyLogo({ logoUrl, alt = 'Company logo', className, style }: CompanyLogoProps) {
  const { url, ready } = useResolvedCompanyLogo(logoUrl);

  if (!logoUrl || !ready || !url) {
    return <LegacyDefaultLogo className={className} style={style} />;
  }

  return (
    <img
      src={url}
      alt={alt}
      className={className}
      style={{ objectFit: 'contain', ...style }}
      crossOrigin="anonymous"
      // If the signed URL 404s or CORS-fails, fall back to legacy mark
      // rather than a broken image icon in the printed PDF.
      onError={(e) => {
        const target = e.currentTarget;
        target.style.display = 'none';
      }}
    />
  );
}
