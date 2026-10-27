import { supabase } from '../lib/supabase';

/**
 * Thin client for ai-email-assistant Edge Function. The function only ever
 * improves wording — it must not change numbers, codes, or anything in the
 * caller's `protectedTokens` list. The result is a *suggestion*; the
 * frontend should diff/preview and require the user to accept.
 */

export type AiEmailPurpose =
  | 'sourcing_request'
  | 'sourcing_reminder'
  | 'customer_quote'
  | 'crm_bulk_email';

export interface AiEmailAssistRequest {
  purpose: AiEmailPurpose;
  subject: string;
  body: string;
  protectedTokens?: string[];
  tone?: 'professional' | 'friendly' | 'firm';
}

export interface AiEmailAssistResult {
  success: boolean;
  subject?: string;
  body?: string;
  notes?: string;
  warnings?: string[];
  error?: string;
  code?: string;
}

export async function aiImproveEmail(req: AiEmailAssistRequest): Promise<AiEmailAssistResult> {
  const { data: session } = await supabase.auth.getSession();
  if (!session.session) {
    return { success: false, error: 'Not signed in', code: 'NO_SESSION' };
  }
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ai-email-assistant`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.session.access_token}` },
      body: JSON.stringify(req),
    });
    const data = await resp.json();
    if (!resp.ok) {
      return { success: false, error: data?.error || `HTTP ${resp.status}`, code: data?.code };
    }
    return data as AiEmailAssistResult;
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Network error', code: 'NETWORK' };
  }
}

/**
 * Heuristic: pull tokens out of a draft body that must NOT be changed.
 * Captures: AC ERP#, inquiry numbers (INQ-...), currency+amount tokens
 * (₹ 1,250 / USD 12.50 / INR 100), and any line that looks like a product
 * table row (bullet + dash + qty unit). The result is sent to the Edge
 * Function as `protectedTokens` so the model is told verbatim what to
 * preserve.
 */
export function extractProtectedTokens(body: string): string[] {
  const tokens = new Set<string>();
  const lines = body.split(/\r?\n/);

  const acerpRe = /\bAC\s*ERP#?\s*[:\-]?\s*\S+/gi;
  const inqRe = /\bINQ-?[A-Z0-9-]+\.?\d*\b/gi;
  const currencyRe = /(?:₹|Rs\.?|INR|USD|CNY|IDR|EUR|GBP|\$)\s*[\d,]+(?:\.\d+)?/gi;
  const numericQtyRe = /\b\d+(?:[.,]\d+)?\s*(?:kg|kgs|g|gm|ton|tons|lt|ltr|nos|pcs|bags|drums)\b/gi;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    [acerpRe, inqRe, currencyRe, numericQtyRe].forEach(re => {
      const matches = line.match(re);
      if (matches) matches.forEach(m => tokens.add(m.trim()));
    });

    // Treat bullet/dash table rows as protected verbatim
    if (/^[•\-*]\s+/.test(line) && line.length < 200) {
      tokens.add(line);
    }
  }

  return Array.from(tokens).slice(0, 50);
}
