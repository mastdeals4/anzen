-- Migration: 20260922220000_final_workflow_and_security_stabilization.sql
-- Description: Final workflow stabilization for Sales Returns, Multi-SO Expense Allocation,
--              Import Container PI linking, and security/RPC lint resolution.

BEGIN;

-- ============================================================================
-- 1. SALES RETURN HARDENING & CANONICAL INVENTORY V1 SAFEGUARDS
-- ============================================================================

-- A. Deprecate and neutralize legacy bypass functions
CREATE OR REPLACE FUNCTION public.handle_material_return_approval()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'handle_material_return_approval is deprecated and disabled. All material return stock movements are canonically processed by trg_material_return_inventory_v1.';
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_material_return_item_stock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'trg_material_return_item_stock is deprecated and disabled. All material return stock movements are canonically processed by trg_material_return_inventory_v1.';
END;
$$;

-- B. Validate return items against source document (Delivery Challan or Sales Invoice)
CREATE OR REPLACE FUNCTION public.validate_material_return_item()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_return public.material_returns%ROWTYPE;
  v_original_qty numeric;
  v_found boolean := false;
BEGIN
  IF NEW.quantity_returned IS NULL OR NEW.quantity_returned <= 0 THEN
    RAISE EXCEPTION 'Returned quantity must be greater than 0';
  END IF;

  SELECT * INTO v_return FROM public.material_returns WHERE id = NEW.return_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Referenced material return % does not exist', NEW.return_id;
  END IF;

  -- 1. Sourced from Delivery Challan
  IF v_return.original_dc_id IS NOT NULL THEN
    SELECT true, dci.quantity
    INTO v_found, v_original_qty
    FROM public.delivery_challan_items dci
    WHERE dci.challan_id = v_return.original_dc_id
      AND dci.product_id = NEW.product_id
      AND (NEW.batch_id IS NULL OR dci.batch_id = NEW.batch_id)
    LIMIT 1;

    IF NOT COALESCE(v_found, false) THEN
      RAISE EXCEPTION 'Item (Product %, Batch %) was not part of original Delivery Challan %',
        NEW.product_id, NEW.batch_id, v_return.original_dc_id;
    END IF;

    IF NEW.quantity_returned > v_original_qty THEN
      RAISE EXCEPTION 'Return quantity (%) exceeds original delivered quantity (%) for product %',
        NEW.quantity_returned, v_original_qty, NEW.product_id;
    END IF;

    NEW.original_quantity := COALESCE(NEW.original_quantity, v_original_qty);

  -- 2. Sourced from Sales Invoice
  ELSIF v_return.original_invoice_id IS NOT NULL THEN
    SELECT true, sii.quantity
    INTO v_found, v_original_qty
    FROM public.sales_invoice_items sii
    WHERE sii.invoice_id = v_return.original_invoice_id
      AND sii.product_id = NEW.product_id
      AND (NEW.batch_id IS NULL OR sii.batch_id = NEW.batch_id)
    LIMIT 1;

    IF NOT COALESCE(v_found, false) THEN
      RAISE EXCEPTION 'Item (Product %, Batch %) was not part of original Sales Invoice %',
        NEW.product_id, NEW.batch_id, v_return.original_invoice_id;
    END IF;

    IF NEW.quantity_returned > v_original_qty THEN
      RAISE EXCEPTION 'Return quantity (%) exceeds original invoiced quantity (%) for product %',
        NEW.quantity_returned, v_original_qty, NEW.product_id;
    END IF;

    NEW.original_quantity := COALESCE(NEW.original_quantity, v_original_qty);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_material_return_item ON public.material_return_items;
CREATE TRIGGER trg_validate_material_return_item
  BEFORE INSERT OR UPDATE ON public.material_return_items
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_material_return_item();


-- ============================================================================
-- 2. SALES EXPENSE MULTI-SO ALLOCATION & PROFITABILITY REPORTING
-- ============================================================================

-- Add sales_order_allocations JSONB to finance_expenses
ALTER TABLE public.finance_expenses
  ADD COLUMN IF NOT EXISTS sales_order_allocations jsonb DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.finance_expenses.sales_order_allocations IS
  'Array of Sales Order allocations: [{"sales_order_id": uuid, "so_number": text, "allocated_amount": numeric, "allocated_percent": numeric}]';

-- Update get_sales_profitability_line_expenses to honor multi-SO expense allocations
CREATE OR REPLACE FUNCTION public.get_sales_profitability_line_expenses(
  p_start_date date,
  p_end_date date
)
RETURNS TABLE(line_id uuid, sales_expense numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
WITH scoped AS (
  SELECT sii.id AS line_id,
         dci.challan_id AS dc_id,
         si.sales_order_id AS so_id,
         ROUND(sii.quantity * sii.unit_price, 2) AS line_sales,
         sii.quantity
  FROM public.sales_invoice_items sii
  JOIN public.sales_invoices si ON si.id = sii.invoice_id
  LEFT JOIN public.delivery_challan_items dci ON dci.id = sii.delivery_challan_item_id
  WHERE si.invoice_date BETWEEN p_start_date AND p_end_date
    AND NOT COALESCE(si.is_draft, false)
),
-- Delivery Challan totals
dc_totals AS (
  SELECT dci.challan_id AS dc_id,
         SUM(ROUND(sii.quantity * sii.unit_price, 2)) AS total_sales,
         SUM(sii.quantity) AS total_qty
  FROM public.sales_invoice_items sii
  JOIN public.sales_invoices si ON si.id = sii.invoice_id
  JOIN public.delivery_challan_items dci ON dci.id = sii.delivery_challan_item_id
  WHERE NOT COALESCE(si.is_draft, false)
    AND dci.challan_id IN (SELECT DISTINCT dc_id FROM scoped WHERE dc_id IS NOT NULL)
  GROUP BY dci.challan_id
),
-- Expenses linked directly to Delivery Challans
dc_expenses AS (
  SELECT fe.delivery_challan_id AS dc_id, SUM(fe.amount) AS total_expense
  FROM public.finance_expenses fe
  WHERE (
      fe.expense_category IN ('delivery_sales', 'loading_sales', 'marketing_advertising', 'other_sales')
      OR EXISTS (
        SELECT 1 FROM public.expense_categories ec
        WHERE ec.category_key = fe.expense_category
          AND ec.category_type = 'sales'
      )
    )
    AND fe.approval_status = 'approved'
    AND fe.delivery_challan_id IN (SELECT DISTINCT dc_id FROM scoped WHERE dc_id IS NOT NULL)
  GROUP BY fe.delivery_challan_id
),
-- Sales Order totals
so_totals AS (
  SELECT si.sales_order_id AS so_id,
         SUM(ROUND(sii.quantity * sii.unit_price, 2)) AS total_sales,
         SUM(sii.quantity) AS total_qty
  FROM public.sales_invoice_items sii
  JOIN public.sales_invoices si ON si.id = sii.invoice_id
  WHERE NOT COALESCE(si.is_draft, false)
    AND si.sales_order_id IN (SELECT DISTINCT so_id FROM scoped WHERE so_id IS NOT NULL)
  GROUP BY si.sales_order_id
),
-- Expenses allocated via sales_order_allocations JSONB
so_allocated_expenses AS (
  SELECT
    (alloc->>'sales_order_id')::uuid AS so_id,
    SUM(COALESCE((alloc->>'allocated_amount')::numeric, 0)) AS total_allocated_expense
  FROM public.finance_expenses fe,
       jsonb_array_elements(fe.sales_order_allocations) AS alloc
  WHERE (
      fe.expense_category IN ('delivery_sales', 'loading_sales', 'marketing_advertising', 'other_sales')
      OR EXISTS (
        SELECT 1 FROM public.expense_categories ec
        WHERE ec.category_key = fe.expense_category
          AND ec.category_type = 'sales'
      )
    )
    AND fe.approval_status = 'approved'
    AND (alloc->>'sales_order_id') IS NOT NULL
    AND (alloc->>'sales_order_id')::uuid IN (SELECT DISTINCT so_id FROM scoped WHERE so_id IS NOT NULL)
  GROUP BY (alloc->>'sales_order_id')::uuid
)
SELECT s.line_id,
       COALESCE(
         -- Delivery Challan portion
         (CASE
           WHEN d.total_sales > 0 THEN ROUND(e.total_expense * s.line_sales / d.total_sales, 2)
           WHEN d.total_qty > 0 THEN ROUND(e.total_expense * s.quantity / d.total_qty, 2)
           ELSE 0
         END), 0)
       +
       COALESCE(
         -- Sales Order allocated portion
         (CASE
           WHEN sot.total_sales > 0 THEN ROUND(soe.total_allocated_expense * s.line_sales / sot.total_sales, 2)
           WHEN sot.total_qty > 0 THEN ROUND(soe.total_allocated_expense * s.quantity / sot.total_qty, 2)
           ELSE 0
         END), 0)::numeric AS sales_expense
FROM scoped s
LEFT JOIN dc_totals d ON d.dc_id = s.dc_id
LEFT JOIN dc_expenses e ON e.dc_id = s.dc_id
LEFT JOIN so_totals sot ON sot.so_id = s.so_id
LEFT JOIN so_allocated_expenses soe ON soe.so_id = s.so_id;
$$;

GRANT EXECUTE ON FUNCTION public.get_sales_profitability_line_expenses(date, date) TO authenticated;

-- Update save_finance_expense to persist sales_order_allocations
CREATE OR REPLACE FUNCTION public.save_finance_expense(
  p_expense_id uuid DEFAULT NULL::uuid,
  p_payload jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
  v_date date := COALESCE((p_payload->>'expense_date')::date, current_date);
  v_bank_id uuid := NULLIF(p_payload->>'bank_account_id', '')::uuid;
  v_bank_currency text;
  v_currency text;
  v_rate numeric;
  v_docs text[];
BEGIN
  PERFORM public._sec_check_finance_role();
  IF COALESCE((p_payload->>'amount')::numeric, 0) <= 0 THEN
    RAISE EXCEPTION 'Expense amount must be greater than zero';
  END IF;
  IF NULLIF(p_payload->>'expense_category', '') IS NULL THEN
    RAISE EXCEPTION 'Expense category is required';
  END IF;

  SELECT upper(currency) INTO v_bank_currency FROM public.bank_accounts WHERE id = v_bank_id;
  v_currency := upper(COALESCE(NULLIF(p_payload->>'transaction_currency',''), v_bank_currency, 'IDR'));
  IF v_currency NOT IN ('IDR','USD') THEN RAISE EXCEPTION 'Unsupported expense currency %', v_currency; END IF;
  v_rate := COALESCE(NULLIF((p_payload->>'exchange_rate')::numeric, 0), CASE WHEN v_currency = 'IDR' THEN 1 ELSE NULL END);
  IF v_rate IS NULL OR v_rate <= 0 THEN
    RAISE EXCEPTION 'A positive exchange rate is required for % expenses', v_currency;
  END IF;
  IF v_bank_currency IS NOT NULL AND v_bank_currency <> v_currency THEN
    RAISE EXCEPTION 'Expense currency % does not match selected bank currency %', v_currency, v_bank_currency;
  END IF;

  SELECT COALESCE(array_agg(value), ARRAY[]::text[]) INTO v_docs
    FROM jsonb_array_elements_text(COALESCE(p_payload->'document_urls', '[]'::jsonb));

  IF p_expense_id IS NULL THEN
    INSERT INTO public.finance_expenses (
      voucher_number, expense_category, expense_type, amount, expense_date, description,
      batch_id, import_container_id, delivery_challan_id, payment_method, bank_account_id,
      payment_reference, paid_by, document_urls, supplier_id, staff_id, invoice_number,
      due_date, broker_items, pib_bm_amount, pib_ppn_amount, pib_pph_amount, ppn_amount,
      ppn_manual_override, ppn_calc_mode, dpp_amount, ppn_rate, pph_amount, pph_code_id,
      stamp_duty_amount, fixed_asset_account_id, bank_charges_amount, approval_status,
      created_by, currency_code, transaction_currency, functional_currency, exchange_rate,
      bank_account_currency, payment_currency, sales_order_allocations
    ) VALUES (
      public.next_expense_voucher_number(v_date), p_payload->>'expense_category',
      COALESCE(NULLIF(p_payload->>'expense_type',''), 'admin'), (p_payload->>'amount')::numeric,
      v_date, NULLIF(p_payload->>'description',''), NULLIF(p_payload->>'batch_id','')::uuid,
      NULLIF(p_payload->>'import_container_id','')::uuid, NULLIF(p_payload->>'delivery_challan_id','')::uuid,
      NULLIF(p_payload->>'payment_method',''), v_bank_id, NULLIF(p_payload->>'payment_reference',''),
      NULLIF(p_payload->>'paid_by',''), NULLIF(v_docs, ARRAY[]::text[]),
      NULLIF(p_payload->>'supplier_id','')::uuid, NULLIF(p_payload->>'staff_id','')::uuid,
      NULLIF(p_payload->>'invoice_number',''), NULLIF(p_payload->>'due_date','')::date,
      NULLIF(p_payload->'broker_items','null'::jsonb), NULLIF(p_payload->>'pib_bm_amount','')::numeric,
      NULLIF(p_payload->>'pib_ppn_amount','')::numeric, NULLIF(p_payload->>'pib_pph_amount','')::numeric,
      COALESCE(NULLIF(p_payload->>'ppn_amount','')::numeric,0), COALESCE((p_payload->>'ppn_manual_override')::boolean,false),
      COALESCE(NULLIF(p_payload->>'ppn_calc_mode',''),'standard'), NULLIF(p_payload->>'dpp_amount','')::numeric,
      COALESCE(NULLIF(p_payload->>'ppn_rate','')::numeric,11), COALESCE(NULLIF(p_payload->>'pph_amount','')::numeric,0),
      NULLIF(p_payload->>'pph_code_id','')::uuid, COALESCE(NULLIF(p_payload->>'stamp_duty_amount','')::numeric,0),
      NULLIF(p_payload->>'fixed_asset_account_id','')::uuid,
      COALESCE(NULLIF(p_payload->>'bank_charges_amount','')::numeric,0),
      COALESCE(NULLIF(p_payload->>'approval_status',''),'pending_approval'),
      COALESCE(NULLIF(p_payload->>'created_by','')::uuid, auth.uid()),
      v_currency, v_currency, 'IDR', v_rate, COALESCE(v_bank_currency,v_currency), v_currency,
      COALESCE(p_payload->'sales_order_allocations', '[]'::jsonb)
    ) RETURNING id INTO v_id;
  ELSE
    IF EXISTS (SELECT 1 FROM public.finance_expenses WHERE id=p_expense_id AND approval_status='approved') THEN
      RAISE EXCEPTION 'This expense is posted. Cancel Posting first to make changes.';
    END IF;
    UPDATE public.finance_expenses SET
      expense_category=p_payload->>'expense_category', expense_type=COALESCE(NULLIF(p_payload->>'expense_type',''),'admin'),
      amount=(p_payload->>'amount')::numeric, expense_date=v_date, description=NULLIF(p_payload->>'description',''),
      batch_id=NULLIF(p_payload->>'batch_id','')::uuid, import_container_id=NULLIF(p_payload->>'import_container_id','')::uuid,
      delivery_challan_id=NULLIF(p_payload->>'delivery_challan_id','')::uuid,
      payment_method=NULLIF(p_payload->>'payment_method',''), bank_account_id=v_bank_id,
      payment_reference=NULLIF(p_payload->>'payment_reference',''), paid_by=NULLIF(p_payload->>'paid_by',''),
      document_urls=NULLIF(v_docs,ARRAY[]::text[]), supplier_id=NULLIF(p_payload->>'supplier_id','')::uuid,
      staff_id=NULLIF(p_payload->>'staff_id','')::uuid, invoice_number=NULLIF(p_payload->>'invoice_number',''),
      due_date=NULLIF(p_payload->>'due_date','')::date, broker_items=NULLIF(p_payload->'broker_items','null'::jsonb),
      pib_bm_amount=NULLIF(p_payload->>'pib_bm_amount','')::numeric,
      pib_ppn_amount=NULLIF(p_payload->>'pib_ppn_amount','')::numeric,
      pib_pph_amount=NULLIF(p_payload->>'pib_pph_amount','')::numeric,
      ppn_amount=COALESCE(NULLIF(p_payload->>'ppn_amount','')::numeric,0),
      ppn_manual_override=COALESCE((p_payload->>'ppn_manual_override')::boolean,false),
      ppn_calc_mode=COALESCE(NULLIF(p_payload->>'ppn_calc_mode',''),'standard'),
      dpp_amount=NULLIF(p_payload->>'dpp_amount','')::numeric, ppn_rate=COALESCE(NULLIF(p_payload->>'ppn_rate','')::numeric,11),
      pph_amount=COALESCE(NULLIF(p_payload->>'pph_amount','')::numeric,0), pph_code_id=NULLIF(p_payload->>'pph_code_id','')::uuid,
      stamp_duty_amount=COALESCE(NULLIF(p_payload->>'stamp_duty_amount','')::numeric,0),
      fixed_asset_account_id=NULLIF(p_payload->>'fixed_asset_account_id','')::uuid,
      bank_charges_amount=COALESCE(NULLIF(p_payload->>'bank_charges_amount','')::numeric,0),
      currency_code=v_currency, transaction_currency=v_currency, functional_currency='IDR', exchange_rate=v_rate,
      bank_account_currency=COALESCE(v_bank_currency,v_currency), payment_currency=v_currency,
      sales_order_allocations=COALESCE(p_payload->'sales_order_allocations', '[]'::jsonb)
    WHERE id=p_expense_id RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END;
$$;



-- ============================================================================
-- 3. IMPORT CONTAINERS: MULTI-PI LINKING SUPPORT
-- ============================================================================

ALTER TABLE public.import_containers
  ADD COLUMN IF NOT EXISTS purchase_invoice_ids uuid[] DEFAULT '{}'::uuid[];

COMMENT ON COLUMN public.import_containers.purchase_invoice_ids IS
  'Array of purchase_invoices linked to this import container';


-- ============================================================================
-- 4. SECURITY DEFINER & RPC LINT HARDENING
-- ============================================================================

-- Fix ambiguous column reference in get_gmail_connection_secret
CREATE OR REPLACE FUNCTION public.get_gmail_connection_secret(p_connection_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_secret text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.gmail_connections gc
    WHERE gc.id = p_connection_id AND gc.user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Access denied to connection %', p_connection_id;
  END IF;

  SELECT encrypted_tokens INTO v_secret
  FROM public.gmail_connections gc
  WHERE gc.id = p_connection_id;

  RETURN v_secret;
END;
$$;

-- Fix close_tax_period draft invoice check
CREATE OR REPLACE FUNCTION public.close_tax_period(p_period_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_period public.tax_periods%ROWTYPE;
  v_draft_count integer;
BEGIN
  SELECT * INTO v_period FROM public.tax_periods WHERE id = p_period_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tax period % not found', p_period_id;
  END IF;

  IF v_period.status = 'closed' THEN
    RAISE EXCEPTION 'Tax period is already closed';
  END IF;

  -- Check for unfinalized/draft sales invoices in this tax period
  SELECT COUNT(*) INTO v_draft_count
  FROM public.sales_invoices
  WHERE tax_period_id = p_period_id
    AND COALESCE(is_draft, false) = true;

  IF v_draft_count > 0 THEN
    RAISE EXCEPTION 'Cannot close tax period: % draft sales invoices remain', v_draft_count;
  END IF;

  UPDATE public.tax_periods
  SET status = 'closed',
      closed_at = now(),
      closed_by = auth.uid()
  WHERE id = p_period_id;
END;
$$;

COMMIT;
