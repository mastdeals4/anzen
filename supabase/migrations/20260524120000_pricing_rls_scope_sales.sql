/*
  # Scope sales pricing access to owned/assigned records

  Tightens the role-based pricing RLS so that:
    * admin/manager retain full management rights on pricing tables
    * sales can update price_requests only when they are the creator or
      the assigned salesperson — not globally
    * sales can update price_request_items only on price_requests they
      created / are assigned to — and never the final_quote_* columns
      (the existing enforce_final_quote_write_restriction trigger remains
      the second gate)
    * pricing_ledger write stays admin/manager only (unchanged)
    * sourcing_parser_results is restricted to admin/manager only —
      raw email snippets and supplier prices are not safe to surface to
      the sales role generally

  Safe to re-run. Idempotent.
*/

-- ────────────────────────────────────────────────────────────────────────────
-- price_requests — sales update gated to owned/assigned rows
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "pricing_request_update_sales" ON price_requests;

CREATE POLICY "pricing_request_update_sales" ON price_requests
  FOR UPDATE TO authenticated
  USING (
    current_user_has_pricing_role(ARRAY['sales'])
    AND (created_by = auth.uid() OR assigned_to = auth.uid())
  )
  WITH CHECK (
    current_user_has_pricing_role(ARRAY['sales'])
    AND (created_by = auth.uid() OR assigned_to = auth.uid())
  );

-- ────────────────────────────────────────────────────────────────────────────
-- price_request_items — sales update gated to items belonging to a PR they
-- created or are assigned to. final_quote_* is additionally blocked by the
-- existing enforce_final_quote_write_restriction trigger.
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "pricing_items_update_sales" ON price_request_items;

CREATE POLICY "pricing_items_update_sales" ON price_request_items
  FOR UPDATE TO authenticated
  USING (
    current_user_has_pricing_role(ARRAY['sales'])
    AND EXISTS (
      SELECT 1 FROM price_requests pr
       WHERE pr.id = price_request_items.price_request_id
         AND (pr.created_by = auth.uid() OR pr.assigned_to = auth.uid())
    )
  )
  WITH CHECK (
    current_user_has_pricing_role(ARRAY['sales'])
    AND EXISTS (
      SELECT 1 FROM price_requests pr
       WHERE pr.id = price_request_items.price_request_id
         AND (pr.created_by = auth.uid() OR pr.assigned_to = auth.uid())
    )
  );

-- ────────────────────────────────────────────────────────────────────────────
-- pricing_ledger — write stays admin/manager only. Re-asserted defensively.
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "pricing_ledger_insert" ON pricing_ledger;
DROP POLICY IF EXISTS "pricing_ledger_update" ON pricing_ledger;

CREATE POLICY "pricing_ledger_insert" ON pricing_ledger
  FOR INSERT TO authenticated
  WITH CHECK (current_user_has_pricing_role(ARRAY['admin','manager']));

CREATE POLICY "pricing_ledger_update" ON pricing_ledger
  FOR UPDATE TO authenticated
  USING      (current_user_has_pricing_role(ARRAY['admin','manager']))
  WITH CHECK (current_user_has_pricing_role(ARRAY['admin','manager']));

-- ────────────────────────────────────────────────────────────────────────────
-- sourcing_parser_results — restrict to admin/manager only.
-- Sensitive: contains raw email snippets and supplier prices.
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.sourcing_parser_results') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "parser_results_read"   ON sourcing_parser_results';
    EXECUTE 'DROP POLICY IF EXISTS "parser_results_insert" ON sourcing_parser_results';
    EXECUTE 'DROP POLICY IF EXISTS "parser_results_update" ON sourcing_parser_results';

    EXECUTE $POL$
      CREATE POLICY "parser_results_read" ON sourcing_parser_results
        FOR SELECT TO authenticated
        USING (current_user_has_pricing_role(ARRAY['admin','manager']))
    $POL$;

    EXECUTE $POL$
      CREATE POLICY "parser_results_insert" ON sourcing_parser_results
        FOR INSERT TO authenticated
        WITH CHECK (current_user_has_pricing_role(ARRAY['admin','manager']))
    $POL$;

    EXECUTE $POL$
      CREATE POLICY "parser_results_update" ON sourcing_parser_results
        FOR UPDATE TO authenticated
        USING      (current_user_has_pricing_role(ARRAY['admin','manager']))
        WITH CHECK (current_user_has_pricing_role(ARRAY['admin','manager']))
    $POL$;
  END IF;
END $$;
