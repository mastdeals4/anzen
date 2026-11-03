-- ==============================================================================
-- MIGRATION: 20261102030000_credit_note_reporting_consistency_and_rls_security.sql
-- Description: 1. Harmonize get_sales_profit_summary to deduct approved credit notes (qty, revenue, and COGS)
--                 with strict server-side authorization check (admin, accounts, auditor_ca only)
--              2. Enable Row-Level Security (RLS) and Role-Based Policies on:
--                 - public.customs_ndpbm_declarations
--                 - public.credit_note_allocations
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. FUNCTION: get_sales_profit_summary
-- Harmonized to deduct approved customer credit notes at product level
-- Protected by explicit server-side authorization check (admin, accounts, auditor_ca only)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_sales_profit_summary(p_start_date date, p_end_date date)
 RETURNS TABLE(
   product_id uuid,
   product_name text,
   product_code text,
   product_unit text,
   total_qty_sold numeric,
   total_revenue numeric,
   costed_revenue numeric,
   total_cogs numeric,
   total_profit numeric,
   profit_pct numeric,
   costed_lines bigint,
   total_lines bigint,
   no_cost boolean
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- 1. Server-side authorization check: admin, accounts, auditor_ca, or service_role
  IF auth.role() = 'service_role' THEN
    -- service_role has administrative access
    NULL;
  ELSIF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  ELSIF NOT EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE id = auth.uid()
      AND is_active = true
      AND role = ANY (ARRAY['admin'::text, 'accounts'::text, 'auditor_ca'::text])
  ) THEN
    RAISE EXCEPTION 'Permission denied: unauthorized to access sales profitability reports';
  END IF;

  -- 2. Query execution with credit note deductions
  RETURN QUERY
  WITH reportable_lines AS (
    SELECT
      ar.line_id,
      ar.invoice_id,
      ar.product_id,
      p.product_name,
      COALESCE(p.product_code, '') AS product_code,
      COALESCE(p.unit, 'kg') AS product_unit,
      ar.quantity,
      sii.unit_price,
      ROUND(ar.quantity * sii.unit_price, 2) AS line_gross_sales,
      ar.authoritative_cogs,
      (ar.authoritative_cogs IS NOT NULL) AS is_costed
    FROM public.get_authoritative_sales_line_cogs(p_start_date, p_end_date) ar
    JOIN public.sales_invoice_items sii ON sii.id = ar.line_id
    JOIN public.sales_invoices si ON si.id = ar.invoice_id
    JOIN public.products p ON p.id = ar.product_id
    WHERE public.is_reportable_sales_invoice(si.document_status, si.is_draft, si.notes)
  ),
  prod_returns AS (
    SELECT 
      cni.product_id,
      COALESCE(SUM(cni.total_price), 0) AS return_revenue,
      COALESCE(SUM(cni.quantity), 0) AS return_qty,
      COALESCE(SUM(public.get_credit_note_item_fifo_cogs(cni.id)), 0) AS return_cogs
    FROM public.credit_notes cn
    JOIN public.credit_note_items cni ON cni.credit_note_id = cn.id
    WHERE cn.status = 'approved'
      AND cn.credit_note_date BETWEEN p_start_date AND p_end_date
    GROUP BY cni.product_id
  ),
  grouped AS (
    SELECT
      l.product_id,
      l.product_name,
      l.product_code,
      l.product_unit,
      SUM(l.quantity) - COALESCE(MAX(pr.return_qty), 0) AS total_qty_sold,
      SUM(l.line_gross_sales) - COALESCE(MAX(pr.return_revenue), 0) AS total_revenue,
      SUM(l.line_gross_sales) FILTER (WHERE l.is_costed) - COALESCE(MAX(pr.return_revenue), 0) AS costed_revenue,
      COALESCE(SUM(l.authoritative_cogs) FILTER (WHERE l.is_costed), 0) - COALESCE(MAX(pr.return_cogs), 0) AS total_cogs,
      COUNT(*) FILTER (WHERE l.is_costed) AS costed_lines,
      COUNT(*) AS total_lines
    FROM reportable_lines l
    LEFT JOIN prod_returns pr ON pr.product_id = l.product_id
    GROUP BY l.product_id, l.product_name, l.product_code, l.product_unit
  )
  SELECT
    g.product_id,
    g.product_name,
    g.product_code,
    g.product_unit,
    ROUND(g.total_qty_sold, 3) AS total_qty_sold,
    ROUND(g.total_revenue, 2) AS total_revenue,
    ROUND(COALESCE(g.costed_revenue, 0), 2) AS costed_revenue,
    ROUND(g.total_cogs, 2) AS total_cogs,
    ROUND(COALESCE(g.costed_revenue, 0) - g.total_cogs, 2) AS total_profit,
    CASE WHEN COALESCE(g.costed_revenue, 0) = 0 THEN NULL
      ELSE ROUND((g.costed_revenue - g.total_cogs) / g.costed_revenue * 100, 2) END AS profit_pct,
    g.costed_lines,
    g.total_lines,
    g.costed_lines = 0 AS no_cost
  FROM grouped g
  ORDER BY (COALESCE(g.costed_revenue, 0) - g.total_cogs) DESC NULLS LAST;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_sales_profit_summary(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_sales_profit_summary(date, date) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 2. SECURITY: Enable RLS and Role-Based Policies on customs_ndpbm_declarations
-- ------------------------------------------------------------------------------
REVOKE ALL ON public.customs_ndpbm_declarations FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.customs_ndpbm_declarations TO authenticated, service_role;

ALTER TABLE public.customs_ndpbm_declarations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cnd_select_authorized_roles" ON public.customs_ndpbm_declarations;
DROP POLICY IF EXISTS "cnd_insert_finance_roles" ON public.customs_ndpbm_declarations;
DROP POLICY IF EXISTS "cnd_update_finance_roles" ON public.customs_ndpbm_declarations;
DROP POLICY IF EXISTS "cnd_delete_admin_role" ON public.customs_ndpbm_declarations;

CREATE POLICY "cnd_select_authorized_roles" ON public.customs_ndpbm_declarations
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE user_profiles.id = (SELECT auth.uid())
      AND user_profiles.is_active = true
      AND user_profiles.role = ANY (ARRAY['admin'::text, 'accounts'::text, 'auditor_ca'::text])
  )
);

CREATE POLICY "cnd_insert_finance_roles" ON public.customs_ndpbm_declarations
FOR INSERT TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE user_profiles.id = (SELECT auth.uid())
      AND user_profiles.is_active = true
      AND user_profiles.role = ANY (ARRAY['admin'::text, 'accounts'::text])
  )
);

CREATE POLICY "cnd_update_finance_roles" ON public.customs_ndpbm_declarations
FOR UPDATE TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE user_profiles.id = (SELECT auth.uid())
      AND user_profiles.is_active = true
      AND user_profiles.role = ANY (ARRAY['admin'::text, 'accounts'::text])
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE user_profiles.id = (SELECT auth.uid())
      AND user_profiles.is_active = true
      AND user_profiles.role = ANY (ARRAY['admin'::text, 'accounts'::text])
  )
);

CREATE POLICY "cnd_delete_admin_role" ON public.customs_ndpbm_declarations
FOR DELETE TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE user_profiles.id = (SELECT auth.uid())
      AND user_profiles.is_active = true
      AND user_profiles.role = 'admin'::text
  )
);

-- ------------------------------------------------------------------------------
-- 3. SECURITY: Enable RLS and Role-Based Policies on credit_note_allocations
-- ------------------------------------------------------------------------------
REVOKE ALL ON public.credit_note_allocations FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.credit_note_allocations TO authenticated, service_role;

ALTER TABLE public.credit_note_allocations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cna_select_authorized_roles" ON public.credit_note_allocations;
DROP POLICY IF EXISTS "cna_insert_finance_roles" ON public.credit_note_allocations;
DROP POLICY IF EXISTS "cna_update_finance_roles" ON public.credit_note_allocations;
DROP POLICY IF EXISTS "cna_delete_admin_role" ON public.credit_note_allocations;

CREATE POLICY "cna_select_authorized_roles" ON public.credit_note_allocations
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE user_profiles.id = (SELECT auth.uid())
      AND user_profiles.is_active = true
      AND user_profiles.role = ANY (ARRAY['admin'::text, 'accounts'::text, 'auditor_ca'::text])
  )
);

CREATE POLICY "cna_insert_finance_roles" ON public.credit_note_allocations
FOR INSERT TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE user_profiles.id = (SELECT auth.uid())
      AND user_profiles.is_active = true
      AND user_profiles.role = ANY (ARRAY['admin'::text, 'accounts'::text])
  )
);

CREATE POLICY "cna_update_finance_roles" ON public.credit_note_allocations
FOR UPDATE TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE user_profiles.id = (SELECT auth.uid())
      AND user_profiles.is_active = true
      AND user_profiles.role = ANY (ARRAY['admin'::text, 'accounts'::text])
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE user_profiles.id = (SELECT auth.uid())
      AND user_profiles.is_active = true
      AND user_profiles.role = ANY (ARRAY['admin'::text, 'accounts'::text])
  )
);

CREATE POLICY "cna_delete_admin_role" ON public.credit_note_allocations
FOR DELETE TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE user_profiles.id = (SELECT auth.uid())
      AND user_profiles.is_active = true
      AND user_profiles.role = 'admin'::text
  )
);

-- ------------------------------------------------------------------------------
-- 4. REGISTER MIGRATION
-- ------------------------------------------------------------------------------
INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('20261102030000', 'credit_note_reporting_consistency_and_rls_security')
ON CONFLICT (version) DO NOTHING;
