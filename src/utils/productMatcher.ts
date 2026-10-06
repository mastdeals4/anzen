/**
 * Pure product matching helper that handles common variations, salt forms, pharmacopeia suffixes, etc.
 * Has no external dependencies so it can be imported in both browser and Node test environments.
 */
export function isProductMatch(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  const cleanA = a.toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const cleanB = b.toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleanA === cleanB) return true;
  const strip = (s: string) =>
    s
      .replace(/\b(USP|BP|IP|EP|JP|NF|FCC|MICRONIZED|PHARMA|GRADE|FOOD|FEED|TECHNICAL)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  const sa = strip(cleanA);
  const sb = strip(cleanB);
  if (sa && sb && (sa === sb || sa.includes(sb) || sb.includes(sa))) return true;
  const firstA = cleanA.split(/\s+/).slice(0, 2).join(' ');
  const firstB = cleanB.split(/\s+/).slice(0, 2).join(' ');
  if (firstA.length >= 4 && firstB.length >= 4 && (cleanB.includes(firstA) || cleanA.includes(firstB))) {
    return true;
  }
  return false;
}
