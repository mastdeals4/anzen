// makeSuggestions — read-only make/manufacturer typeahead source (Part 6).
//
// When the "Preferred Make" cell is blank, we suggest brands the business has
// already worked with, derived from data that already exists — NO new table:
//   • crm_inquiries.supplier_name        (who we buy from)
//   • crm_inquiry_pricing_options.offered_make (brands previously offered)
//   • pricing_ledger.preferred_make / offered_make (historically quoted makes)
//
// A newly-typed make needs no migration: it persists through the existing
// crm_inquiry_pricing_options.offered_make column the grid already writes.

import { supabase } from '../lib/supabase';

let cache: string[] | null = null;
let inflight: Promise<string[]> | null = null;

function collect(values: (string | null | undefined)[], into: Map<string, string>) {
  for (const raw of values) {
    if (!raw) continue;
    const trimmed = String(raw).trim();
    if (trimmed.length < 2) continue;
    const key = trimmed.toLowerCase();
    if (!into.has(key)) into.set(key, trimmed); // keep first-seen casing
  }
}

/**
 * Loads the distinct set of makes/suppliers seen across the CRM. Cached for the
 * session; failures degrade to an empty list (typeahead simply shows nothing).
 */
export async function loadMakeSuggestions(): Promise<string[]> {
  if (cache) return cache;
  if (inflight) return inflight;

  inflight = (async () => {
    const seen = new Map<string, string>();
    try {
      const [inquiries, options, ledger] = await Promise.all([
        supabase.from('crm_inquiries').select('supplier_name').limit(2000),
        supabase.from('crm_inquiry_pricing_options').select('offered_make').limit(2000),
        supabase.from('pricing_ledger').select('preferred_make,offered_make').limit(2000),
      ]);
      collect((inquiries.data || []).map((r: any) => r.supplier_name), seen);
      collect((options.data || []).map((r: any) => r.offered_make), seen);
      collect((ledger.data || []).flatMap((r: any) => [r.preferred_make, r.offered_make]), seen);
    } catch {
      // ignore — return whatever we collected (possibly empty)
    }
    cache = Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
    return cache;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/** Invalidate the cache after a new make is entered so it appears next time. */
export function resetMakeSuggestions() {
  cache = null;
}
