-- Migration: 20261008040000_nota_retur_coretax_workflow.sql
-- Description: Implement Indonesian Nota Retur (Tax Return Note) schema, Coretax compliance fields,
--              linkages with Material Returns, Credit Notes, Sales Invoices, and PPN period integration.

BEGIN;

-- ============================================================================
-- 1. NOTA RETUR SEQUENCE
-- ============================================================================
CREATE SEQUENCE IF NOT EXISTS public.nota_retur_number_seq
  START WITH 1
  INCREMENT BY 1
  NO MINVALUE
  NO MAXVALUE
  CACHE 1;

-- ============================================================================
-- 2. CREATE NOTA_RETUR TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.nota_retur (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nota_retur_number TEXT NOT NULL UNIQUE,
  return_date DATE NOT NULL DEFAULT CURRENT_DATE,
  material_return_id UUID REFERENCES public.material_returns(id) ON DELETE SET NULL,
  credit_note_id UUID REFERENCES public.credit_notes(id) ON DELETE SET NULL,
  sales_invoice_id UUID NOT NULL REFERENCES public.sales_invoices(id) ON DELETE RESTRICT,
  original_invoice_number TEXT NOT NULL,
  sales_invoice_number TEXT,
  original_faktur_pajak_number TEXT,
  original_faktur_pajak_date DATE,
  customer_id UUID NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  customer_name TEXT NOT NULL,
  customer_npwp TEXT,
  customer_address TEXT,
  seller_name TEXT NOT NULL DEFAULT 'PT. Sinar Anzen Prima Jaya',
  seller_npwp TEXT DEFAULT '00.000.000.0-000.000',
  seller_address TEXT,
  currency TEXT NOT NULL DEFAULT 'IDR',
  dpp_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
  tax_rate NUMERIC(5,4) NOT NULL DEFAULT 0.1100 CHECK (tax_rate >= 0 AND tax_rate <= 1),
  ppn_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
  total_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
  tax_period_id UUID REFERENCES public.tax_periods(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready_for_review', 'submitted', 'approved', 'rejected', 'cancelled')),
  coretax_status TEXT NOT NULL DEFAULT 'draft' CHECK (coretax_status IN ('draft', 'ready_for_review', 'submitted', 'approved', 'rejected')),
  coretax_reference_number TEXT,
  coretax_submission_date TIMESTAMPTZ,
  coretax_response_notes TEXT,
  approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  approval_date TIMESTAMPTZ,
  rejection_reason TEXT,
  notes TEXT,
  document_url TEXT,
  company_snapshot JSONB,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for fast lookup by sales_invoice_id, customer_id, tax_period_id
CREATE INDEX IF NOT EXISTS idx_nota_retur_sales_invoice_id ON public.nota_retur(sales_invoice_id);
CREATE INDEX IF NOT EXISTS idx_nota_retur_customer_id ON public.nota_retur(customer_id);
CREATE INDEX IF NOT EXISTS idx_nota_retur_tax_period_id ON public.nota_retur(tax_period_id);
CREATE INDEX IF NOT EXISTS idx_nota_retur_material_return_id ON public.nota_retur(material_return_id);
CREATE INDEX IF NOT EXISTS idx_nota_retur_credit_note_id ON public.nota_retur(credit_note_id);
CREATE INDEX IF NOT EXISTS idx_nota_retur_status ON public.nota_retur(status);
CREATE INDEX IF NOT EXISTS idx_nota_retur_date ON public.nota_retur(return_date);

-- Enforce rule: only 1 active Nota Retur per Material Return (prevent duplicate tax claims)
CREATE UNIQUE INDEX IF NOT EXISTS uq_nota_retur_material_return_active
ON public.nota_retur(material_return_id)
WHERE material_return_id IS NOT NULL AND status NOT IN ('cancelled', 'rejected');

-- ============================================================================
-- 3. CREATE NOTA_RETUR_ITEMS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.nota_retur_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nota_retur_id UUID NOT NULL REFERENCES public.nota_retur(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  batch_id UUID REFERENCES public.batches(id) ON DELETE SET NULL,
  material_return_item_id UUID REFERENCES public.material_return_items(id) ON DELETE SET NULL,
  item_name TEXT NOT NULL,
  quantity NUMERIC(12,3) NOT NULL CHECK (quantity > 0),
  unit_of_measure TEXT NOT NULL DEFAULT 'kg',
  unit_price NUMERIC(15,2) NOT NULL CHECK (unit_price >= 0),
  dpp_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
  tax_rate NUMERIC(5,2) NOT NULL DEFAULT 11.00,
  ppn_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
  total_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_nota_retur_items_nota_retur_id ON public.nota_retur_items(nota_retur_id);
CREATE INDEX IF NOT EXISTS idx_nota_retur_items_product_id ON public.nota_retur_items(product_id);

-- ============================================================================
-- 4. ADD LINKAGE COLUMNS TO MATERIAL_RETURNS & CREDIT_NOTES
-- ============================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'material_returns' AND column_name = 'nota_retur_id'
  ) THEN
    ALTER TABLE public.material_returns ADD COLUMN nota_retur_id UUID REFERENCES public.nota_retur(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'credit_notes' AND column_name = 'nota_retur_id'
  ) THEN
    ALTER TABLE public.credit_notes ADD COLUMN nota_retur_id UUID REFERENCES public.nota_retur(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ============================================================================
-- 5. FUNCTION: GENERATE NOTA RETUR NUMBER
-- ============================================================================
CREATE OR REPLACE FUNCTION public.generate_nota_retur_number(p_date DATE DEFAULT CURRENT_DATE)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_year TEXT;
  v_month TEXT;
  v_seq INTEGER;
  v_number TEXT;
BEGIN
  v_year := to_char(p_date, 'YYYY');
  v_month := to_char(p_date, 'MM');
  v_seq := nextval('public.nota_retur_number_seq');
  v_number := 'NR/' || v_year || '/' || v_month || '/' || lpad(v_seq::text, 4, '0');
  RETURN v_number;
END;
$$;

ALTER TABLE public.nota_retur
  ALTER COLUMN nota_retur_number SET DEFAULT public.generate_nota_retur_number();

-- ============================================================================
-- 6. BIDIRECTIONAL SYNC TRIGGER BETWEEN NOTA_RETUR AND MATERIAL_RETURNS/CREDIT_NOTES
-- ============================================================================
CREATE OR REPLACE FUNCTION public.trg_sync_nota_retur_linkages()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  -- Sync link to material_returns if present
  IF NEW.material_return_id IS NOT NULL THEN
    UPDATE public.material_returns
    SET nota_retur_id = NEW.id
    WHERE id = NEW.material_return_id;
  END IF;

  -- Sync link to credit_notes if present
  IF NEW.credit_note_id IS NOT NULL THEN
    UPDATE public.credit_notes
    SET nota_retur_id = NEW.id
    WHERE id = NEW.credit_note_id;
  END IF;

  -- If status changed to cancelled or rejected, unlink from material return if appropriate
  IF NEW.status IN ('cancelled', 'rejected') AND OLD.status NOT IN ('cancelled', 'rejected') THEN
    IF NEW.material_return_id IS NOT NULL THEN
      UPDATE public.material_returns
      SET nota_retur_id = NULL
      WHERE id = NEW.material_return_id AND nota_retur_id = NEW.id;
    END IF;
    IF NEW.credit_note_id IS NOT NULL THEN
      UPDATE public.credit_notes
      SET nota_retur_id = NULL
      WHERE id = NEW.credit_note_id AND nota_retur_id = NEW.id;
    END IF;
  END IF;

  -- Trigger tax period PPN recalculation if tax_period_id is set
  IF NEW.tax_period_id IS NOT NULL THEN
    PERFORM public.compute_period_ppn(NEW.tax_period_id);
  END IF;
  IF OLD.tax_period_id IS NOT NULL AND OLD.tax_period_id IS DISTINCT FROM NEW.tax_period_id THEN
    PERFORM public.compute_period_ppn(OLD.tax_period_id);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_nota_retur_linkages ON public.nota_retur;
CREATE TRIGGER trg_nota_retur_linkages
AFTER INSERT OR UPDATE ON public.nota_retur
FOR EACH ROW EXECUTE FUNCTION public.trg_sync_nota_retur_linkages();

-- ============================================================================
-- 7. REFRESH COMPUTE_PERIOD_PPN_PRE_POSTED_REGISTER TO INCLUDE NOTA RETUR
-- ============================================================================
CREATE OR REPLACE FUNCTION public.compute_period_ppn_pre_posted_register(p_period_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_period       tax_periods%ROWTYPE;
  v_input        numeric(18,2);
  v_output_gross numeric(18,2);
  v_output_nr    numeric(18,2);
  v_output_cn    numeric(18,2);
  v_output       numeric(18,2);
  v_prior_cf     numeric(18,2);
BEGIN
  SELECT * INTO v_period FROM tax_periods WHERE id = p_period_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tax period % not found', p_period_id;
  END IF;

  IF v_period.tax_type = 'PPN' THEN
    -- Input PPN sum
    SELECT
      COALESCE((
        SELECT SUM(tax_amount) FROM purchase_invoices
         WHERE tax_period_id = p_period_id AND tax_amount > 0
      ), 0)
      +
      COALESCE((
        SELECT SUM(fe.ppn_amount)
          FROM finance_expenses fe
         WHERE fe.tax_period_id = p_period_id
           AND fe.ppn_amount > 0
           AND NOT EXISTS (
             SELECT 1
               FROM jsonb_array_elements(COALESCE(fe.broker_items, '[]'::jsonb)) item
              WHERE COALESCE((item->>'ppn_amount')::numeric, 0) > 0
           )
      ), 0)
      +
      COALESCE((
        SELECT SUM(COALESCE((item->>'ppn_amount')::numeric, 0))
          FROM finance_expenses fe
          CROSS JOIN LATERAL jsonb_array_elements(COALESCE(fe.broker_items, '[]'::jsonb)) item
         WHERE fe.tax_period_id = p_period_id
           AND COALESCE((item->>'ppn_amount')::numeric, 0) > 0
      ), 0)
      +
      COALESCE((
        SELECT SUM(pib_ppn_amount) FROM finance_expenses
         WHERE tax_period_id = p_period_id AND pib_ppn_amount > 0
      ), 0)
    INTO v_input;

    -- Output PPN Gross from Sales Invoices
    SELECT COALESCE(SUM(tax_amount), 0) INTO v_output_gross
      FROM sales_invoices
     WHERE tax_period_id = p_period_id AND tax_amount > 0;

    -- Approved Nota Retur assigned to this tax period (tax instrument for return)
    SELECT COALESCE(SUM(ppn_amount), 0) INTO v_output_nr
      FROM public.nota_retur
     WHERE tax_period_id = p_period_id
       AND status = 'approved'
       AND ppn_amount > 0;

    -- Approved Credit Notes that are NOT already represented by an approved Nota Retur in this period
    -- (Prevents double counting between commercial CN and tax Nota Retur)
    SELECT COALESCE(SUM(cn.tax_amount), 0) INTO v_output_cn
      FROM public.credit_notes cn
     WHERE cn.tax_period_id = p_period_id
       AND cn.status = 'approved'
       AND cn.tax_amount > 0
       AND NOT EXISTS (
         SELECT 1 FROM public.nota_retur nr
          WHERE (nr.credit_note_id = cn.id OR nr.material_return_id = cn.material_return_id)
            AND nr.status = 'approved'
            AND nr.tax_period_id = p_period_id
       );

    -- Net Output PPN
    v_output := GREATEST(v_output_gross - (v_output_nr + v_output_cn), 0);

    -- Prior Carry-forward
    SELECT COALESCE(carry_forward_out, 0) INTO v_prior_cf
      FROM tax_periods
     WHERE tax_type = 'PPN'
       AND (fiscal_year, period_month) < (v_period.fiscal_year, v_period.period_month)
     ORDER BY fiscal_year DESC, period_month DESC
     LIMIT 1;
    v_prior_cf := COALESCE(v_prior_cf, 0);

    UPDATE tax_periods SET
      input_ppn_total   = v_input,
      output_ppn_total  = v_output,
      carry_forward_in  = v_prior_cf,
      net_ppn           = GREATEST(v_output - v_input - v_prior_cf, 0),
      carry_forward_out = GREATEST(v_input + v_prior_cf - v_output, 0),
      updated_at        = now()
    WHERE id = p_period_id;
  END IF;
END;
$$;

-- ============================================================================
-- 8. ROW LEVEL SECURITY & PERMISSIONS
-- ============================================================================
ALTER TABLE public.nota_retur ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nota_retur_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users full access to nota_retur" ON public.nota_retur;
CREATE POLICY "Authenticated users full access to nota_retur"
  ON public.nota_retur FOR ALL
  TO authenticated, service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Authenticated users full access to nota_retur_items" ON public.nota_retur_items;
CREATE POLICY "Authenticated users full access to nota_retur_items"
  ON public.nota_retur_items FOR ALL
  TO authenticated, service_role
  USING (true)
  WITH CHECK (true);

GRANT ALL ON public.nota_retur TO authenticated, service_role;
GRANT ALL ON public.nota_retur_items TO authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE public.nota_retur_number_seq TO authenticated, service_role;

COMMIT;
