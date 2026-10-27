import { useEffect, useState } from 'react';
import { getSignedUrlCached, resolveStorageUrlCached } from './signedUrlCache';

// Single source of truth for turning the value stored on
// company_snapshot.company_logo_url into something an <img src> can render.
//
// Accepted inputs:
//   * null / '' / undefined       → returns null (view should show the
//                                    document's fallback SVG mark)
//   * data:… / blob:… / http(s):// → returns as-is
//   * https://…/storage/v1/object/… → re-signs via resolveStorageUrlCached
//   * bare storage path (e.g.       → mints a signed URL from the
//     "logo/<uuid>.svg")              company-assets bucket
//
// Callers get {url, ready}. `ready` is true the moment the resolver
// finishes (success or failure). Views MUST wait for ready === true
// before triggering Print/PDF capture so html2canvas doesn't rasterise
// an empty <img>. Buttons should be disabled while !ready.
export async function resolveCompanyLogoUrl(
  logoUrl: string | null | undefined,
): Promise<string | null> {
  if (!logoUrl) return null;
  if (/^(data:|blob:|https?:\/\/)/i.test(logoUrl)) {
    if (/\/storage\/v1\/object\//.test(logoUrl)) {
      return resolveStorageUrlCached(logoUrl, 3600);
    }
    return logoUrl;
  }
  return getSignedUrlCached('company-assets', logoUrl, 3600);
}

export interface ResolvedCompanyLogo {
  url: string | null;
  ready: boolean;
}

export function useResolvedCompanyLogo(
  logoUrl: string | null | undefined,
): ResolvedCompanyLogo {
  const [state, setState] = useState<ResolvedCompanyLogo>({
    url: null,
    ready: !logoUrl, // no logo to load → ready immediately
  });

  useEffect(() => {
    let cancelled = false;

    if (!logoUrl) {
      setState({ url: null, ready: true });
      return;
    }

    setState({ url: null, ready: false });

    resolveCompanyLogoUrl(logoUrl)
      .then((url) => {
        if (!cancelled) setState({ url, ready: true });
      })
      .catch(() => {
        if (!cancelled) setState({ url: null, ready: true });
      });

    return () => {
      cancelled = true;
    };
  }, [logoUrl]);

  return state;
}

// Waits until every <img> descendant inside `root` has either finished
// loading (complete && naturalWidth > 0) OR fired 'error'. Bounded by
// timeoutMs (default 5s) so a broken image can never wedge Print/PDF.
//
// Used by every printable document component before window.print() and
// before html2canvas capture, so the header logo is never rasterised
// as a broken <img> or captured mid-load.
export async function waitForImages(
  root: HTMLElement | null,
  timeoutMs = 5000,
): Promise<void> {
  if (!root) return;
  const imgs = Array.from(root.querySelectorAll('img'));
  if (imgs.length === 0) return;

  const pending = imgs
    .filter((img) => !(img.complete && img.naturalWidth > 0))
    .map(
      (img) =>
        new Promise<void>((resolve) => {
          const done = () => resolve();
          img.addEventListener('load', done, { once: true });
          img.addEventListener('error', done, { once: true });
        }),
    );
  if (pending.length === 0) return;

  await Promise.race([
    Promise.all(pending).then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
