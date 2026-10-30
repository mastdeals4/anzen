-- ==============================================================================
-- Migration: 20261030180000_sales_and_credit_note_final_completion.sql
-- Module: Final Sales Invoice Aggregation, Concurrency & Credit Note Completion
--
-- Key Capabilities Delivered:
-- 1. SO-to-DC-to-Invoice Status View: Counts distinct invoice headers (not line items)
--    and sums invoice line quantities independently in separate CTEs.
-- 2. Credit Note intra-document item quantity cumulative validation:
--    Aggregates duplicate source invoice items and prevents over-returns across both
--    distinct credit notes and multiple lines within the same credit note.
-- 3. Production Schema Compatibility:
--    Ensures Account 5190 (Inventory Impairment Loss) exists with expense type & debit balance.
--    Updates validate_coa_account to treat Account 4300 as valid contra-revenue.
--    Ensures payment_vouchers and voucher_allocations schema compatibility.
-- 4. Safe Privileged Grants and SECURITY DEFINER search path guarantees.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. Production Schema Adjustments & Chart of Accounts Verification
-- ------------------------------------------------------------------------------

-- Ensure payment_vouchers compatibility columns
ALTER TABLE public.payment_vouchers ADD COLUMN IF NOT EXISTS payment_type text DEFAULT 'payment';
ALTER TABLE public.payment_vouchers ADD COLUMN IF NOT EXISTS status text DEFAULT 'approved';

-- Ensure voucher_allocations compatibility column
ALTER TABLE public.voucher_allocations ADD COLUMN IF NOT EXISTS status text DEFAULT 'approved';

-- Ensure credit_note_items compatibility column
ALTER TABLE public.credit_note_items ADD COLUMN IF NOT EXISTS notes text;

-- Ensure Chart of Accounts entry for Account 5190 (Inventory Impairment & Damage Loss)
INSERT INTO public.chart_of_accounts (code, name, account_type, normal_balance, is_active)
VALUES ('5190', 'Inventory Impairment & Damage Loss', 'expense', 'debit', true)
ON CONFLICT (code) DO UPDATE
SET normal_balance = COALESCE(public.chart_of_accounts.normal_balance, 'debit'),
    is_active = true;

-- Update CoA account validation function to support contra-revenue semantics for Account 4300
CREATE OR REPLACE FUNCTION public.validate_coa_account(
  p_code text,
  p_expected_type text,
  p_expected_balance text
)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rec record;
  v_is_type_valid boolean := false;
BEGIN
  SELECT id, code, name, account_type, normal_balance, is_active
  INTO v_rec
  FROM public.chart_of_accounts
  WHERE code = p_code;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Chart of Accounts validation failed: account % does not exist', p_code;
  END IF;

  IF NOT v_rec.is_active THEN
    RAISE EXCEPTION 'Chart of Accounts validation failed: account % (%) is inactive', p_code, v_rec.name;
  END IF;

  -- Flexible account type check supporting contra-revenue (such as Account 4300 Sales Returns)
  IF p_code = '4300' THEN
    v_is_type_valid := (v_rec.account_type IN ('contra', 'revenue', 'contra_revenue'));
  ELSE
    v_is_type_valid := (v_rec.account_type = p_expected_type OR v_rec.account_type LIKE '%' || p_expected_type || '%');
  END IF;

  IF NOT v_is_type_valid THEN
    RAISE EXCEPTION 'Chart of Accounts validation failed: account % expected type %, found %',
      p_code, p_expected_type, v_rec.account_type;
  END IF;

  IF v_rec.normal_balance IS NOT NULL AND LOWER(v_rec.normal_balance) <> LOWER(p_expected_balance) THEN
    RAISE EXCEPTION 'Chart of Accounts validation failed: account % expected normal balance %, found %',
      p_code, p_expected_balance, v_rec.normal_balance;
  END IF;

  RETURN v_rec.id;
END;
$$;

-- ------------------------------------------------------------------------------
-- 2. Fixed Credit Note Item Quantity Validator (Cumulative & Intra-Document)
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.validate_credit_note_item_quantities()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_cn public.credit_notes%ROWTYPE;
  v_sii public.sales_invoice_items%ROWTYPE;
  v_already_returned numeric(18,3) := 0;
  v_remaining_returnable numeric(18,3) := 0;
BEGIN
  IF NEW.quantity <= 0 THEN
    RAISE EXCEPTION 'Credit note item quantity must be strictly positive (got %)', NEW.quantity;
  END IF;

  IF NEW.unit_price < 0 THEN
    RAISE EXCEPTION 'Credit note item unit price cannot be negative (got %)', NEW.unit_price;
  END IF;

  SELECT * INTO v_cn FROM public.credit_notes WHERE id = NEW.credit_note_id;

  -- If credit note is tied to an original invoice, lock rows and validate returnable limit
  IF v_cn.original_invoice_id IS NOT NULL THEN
    -- Deterministic row locking on sales invoice and invoice items
    PERFORM 1 FROM public.sales_invoices WHERE id = v_cn.original_invoice_id FOR UPDATE;

    IF NEW.sales_invoice_item_id IS NOT NULL THEN
      SELECT * INTO v_sii
      FROM public.sales_invoice_items
      WHERE id = NEW.sales_invoice_item_id
        AND invoice_id = v_cn.original_invoice_id
      FOR UPDATE;
    ELSE
      SELECT * INTO v_sii
      FROM public.sales_invoice_items
      WHERE invoice_id = v_cn.original_invoice_id
        AND product_id = NEW.product_id
        AND (batch_id = NEW.batch_id OR (batch_id IS NULL AND NEW.batch_id IS NULL))
      ORDER BY id
      LIMIT 1
      FOR UPDATE;
    END IF;

    IF v_sii.id IS NOT NULL THEN
      -- Calculate already returned in active credit notes
      -- Cumulative rule: Include other active credit notes, PLUS any earlier lines in the current credit note.
      -- On UPDATE, exclude only the current row being updated (cni.id = OLD.id).
      SELECT COALESCE(SUM(cni.quantity), 0)
        INTO v_already_returned
        FROM public.credit_note_items cni
        JOIN public.credit_notes existing_cn ON existing_cn.id = cni.credit_note_id
       WHERE existing_cn.original_invoice_id = v_cn.original_invoice_id
         AND (
           (cni.sales_invoice_item_id IS NOT NULL AND cni.sales_invoice_item_id = v_sii.id)
           OR (cni.sales_invoice_item_id IS NULL AND cni.product_id = v_sii.product_id AND (cni.batch_id = v_sii.batch_id OR (cni.batch_id IS NULL AND v_sii.batch_id IS NULL)))
         )
         AND existing_cn.status IN ('pending_approval', 'approved')
         AND (
           existing_cn.id <> v_cn.id
           OR (existing_cn.id = v_cn.id AND (TG_OP = 'INSERT' OR cni.id <> OLD.id))
         );

      v_remaining_returnable := GREATEST(0, v_sii.quantity - v_already_returned);

      IF NEW.quantity > (v_remaining_returnable + 0.0001) THEN
        RAISE EXCEPTION 'Return quantity % exceeds remaining returnable quantity % (Invoiced: %, Already Credited: %) for product %',
          NEW.quantity, v_remaining_returnable, v_sii.quantity, v_already_returned, v_sii.product_id;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_credit_note_item_quantities ON public.credit_note_items;
CREATE TRIGGER trg_validate_credit_note_item_quantities
  BEFORE INSERT OR UPDATE ON public.credit_note_items
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_credit_note_item_quantities();

-- ------------------------------------------------------------------------------
-- 3. Atomic Credit Note Creation RPC with Intra-Request Item Aggregation
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_credit_note_atomic(
  p_credit_note jsonb,
  p_items jsonb,
  p_actor uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_role text;
  v_cn_id uuid;
  v_cn_number text;
  v_orig_inv_id uuid;
  v_orig_inv public.sales_invoices%ROWTYPE;
  v_subtotal numeric(15,2) := 0;
  v_tax numeric(15,2) := 0;
  v_total numeric(15,2) := 0;
  v_tax_rate numeric(8,4) := 0.1100;
  v_cust_id uuid;
  v_item jsonb;
  v_line_qty numeric;
  v_line_price numeric;
  v_line_subtotal numeric;
  v_grr_id uuid;
  v_grr_number text;
  v_bc text;
  v_type text;
  v_disp text;
  v_godown text;
  v_currency text;
  v_reason text;
  v_notes text;
  v_date date;
  v_mr_id uuid;
  v_check_item record;
  v_sii public.sales_invoice_items%ROWTYPE;
  v_existing_ret numeric;
BEGIN
  -- Strict Authentication & Authorization check (prevent caller spoofing)
  IF v_caller IS NULL THEN
    IF current_user = 'service_role' OR session_user = 'postgres' OR (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) OR (COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), '')) = 'service_role' THEN
      v_caller := p_actor;
    ELSE
      RAISE EXCEPTION 'Authentication required: no active session';
    END IF;
  END IF;

  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required: valid actor identity missing';
  END IF;

  SELECT role INTO v_role FROM public.user_profiles WHERE id = v_caller;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'accounts', 'sales', 'warehouse', 'manager') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot create credit notes', COALESCE(v_role, 'none');
  END IF;

  v_cust_id := (p_credit_note->>'customer_id')::uuid;
  IF v_cust_id IS NULL THEN
    RAISE EXCEPTION 'Customer is required for credit note creation';
  END IF;

  v_reason := NULLIF(TRIM(p_credit_note->>'reason'), '');
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'Reason is required for credit note creation';
  END IF;

  v_date := COALESCE((p_credit_note->>'credit_note_date')::date, CURRENT_DATE);
  v_currency := COALESCE(p_credit_note->>'currency', 'IDR');
  v_bc := COALESCE(p_credit_note->>'business_case', 'full_physical_return');
  v_type := COALESCE(p_credit_note->>'credit_note_type', 'physical_return');
  v_disp := COALESCE(p_credit_note->>'stock_disposition', 'saleable');
  v_godown := COALESCE(p_credit_note->>'godown', 'Main Warehouse');
  v_notes := p_credit_note->>'notes';
  v_mr_id := (p_credit_note->>'material_return_id')::uuid;

  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Credit note must contain at least one line item';
  END IF;

  -- Original invoice verification and row locking
  IF p_credit_note->>'original_invoice_id' IS NOT NULL AND (p_credit_note->>'original_invoice_id') <> '' THEN
    v_orig_inv_id := (p_credit_note->>'original_invoice_id')::uuid;

    SELECT * INTO v_orig_inv
    FROM public.sales_invoices
    WHERE id = v_orig_inv_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Original sales invoice % not found', v_orig_inv_id;
    END IF;

    IF NOT public.is_reportable_sales_invoice(v_orig_inv.document_status, v_orig_inv.is_draft, v_orig_inv.notes) THEN
      RAISE EXCEPTION 'Cannot issue credit note against cancelled or draft sales invoice %', v_orig_inv.invoice_number;
    END IF;

    IF v_orig_inv.customer_id <> v_cust_id THEN
      RAISE EXCEPTION 'Customer mismatch: Credit Note customer does not match original invoice customer';
    END IF;

    -- Lock invoice items deterministically in ascending primary-key order
    PERFORM 1 FROM public.sales_invoice_items WHERE invoice_id = v_orig_inv_id ORDER BY id ASC FOR UPDATE;

    -- Authoritative Tax Rate derivation from original invoice
    IF v_orig_inv.subtotal > 0 AND v_orig_inv.tax_amount > 0 THEN
      v_tax_rate := ROUND(v_orig_inv.tax_amount / v_orig_inv.subtotal, 4);
    ELSIF v_orig_inv.tax_amount = 0 THEN
      v_tax_rate := 0.0000;
    ELSE
      v_tax_rate := 0.1100;
    END IF;

    -- Intra-request cumulative validation by source invoice item:
    FOR v_check_item IN
      SELECT 
        (val->>'sales_invoice_item_id')::uuid AS sii_id,
        (val->>'product_id')::uuid AS prod_id,
        NULLIF(val->>'batch_id', '')::uuid AS b_id,
        SUM((val->>'quantity')::numeric) AS req_qty
      FROM jsonb_array_elements(p_items) val
      GROUP BY (val->>'sales_invoice_item_id')::uuid, (val->>'product_id')::uuid, NULLIF(val->>'batch_id', '')::uuid
    LOOP
      IF v_check_item.sii_id IS NOT NULL THEN
        SELECT * INTO v_sii FROM public.sales_invoice_items WHERE id = v_check_item.sii_id;
      ELSE
        SELECT * INTO v_sii FROM public.sales_invoice_items
        WHERE invoice_id = v_orig_inv_id
          AND product_id = v_check_item.prod_id
          AND (batch_id = v_check_item.b_id OR (batch_id IS NULL AND v_check_item.b_id IS NULL))
        ORDER BY id
        LIMIT 1;
      END IF;

      IF v_sii.id IS NOT NULL THEN
        SELECT COALESCE(SUM(cni.quantity), 0)
        INTO v_existing_ret
        FROM public.credit_note_items cni
        JOIN public.credit_notes cn ON cn.id = cni.credit_note_id
        WHERE cn.original_invoice_id = v_orig_inv_id
          AND cn.status IN ('pending_approval', 'approved')
          AND (
            (cni.sales_invoice_item_id IS NOT NULL AND cni.sales_invoice_item_id = v_sii.id)
            OR (cni.sales_invoice_item_id IS NULL AND cni.product_id = v_sii.product_id AND (cni.batch_id = v_sii.batch_id OR (cni.batch_id IS NULL AND v_sii.batch_id IS NULL)))
          );

        IF (v_existing_ret + v_check_item.req_qty) > (v_sii.quantity + 0.0001) THEN
          RAISE EXCEPTION 'Return quantity % exceeds remaining returnable quantity % (Invoiced: %, Already Credited: %) for product %',
            v_check_item.req_qty, (v_sii.quantity - v_existing_ret), v_sii.quantity, v_existing_ret, v_sii.product_id;
        END IF;
      END IF;
    END LOOP;
  ELSE
    IF p_credit_note ? 'tax_rate' THEN
      v_tax_rate := (p_credit_note->>'tax_rate')::numeric;
    END IF;
  END IF;

  -- Calculate Totals from Items
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_line_qty := (v_item->>'quantity')::numeric;
    v_line_price := (v_item->>'unit_price')::numeric;

    IF v_line_qty IS NULL OR v_line_qty <= 0 THEN
      RAISE EXCEPTION 'Line item quantity must be positive';
    END IF;
    IF v_line_price IS NULL OR v_line_price < 0 THEN
      RAISE EXCEPTION 'Line item price cannot be negative';
    END IF;

    v_line_subtotal := ROUND(v_line_qty * v_line_price, 2);
    v_subtotal := v_subtotal + v_line_subtotal;
  END LOOP;

  v_tax := ROUND(v_subtotal * v_tax_rate, 2);
  v_total := v_subtotal + v_tax;

  -- Number generation
  v_cn_number := NULLIF(TRIM(p_credit_note->>'credit_note_number'), '');
  IF v_cn_number IS NULL THEN
    v_cn_number := public.generate_credit_note_number();
  END IF;

  -- 1. Insert Credit Note Header
  INSERT INTO public.credit_notes (
    credit_note_number,
    credit_note_date,
    customer_id,
    original_invoice_id,
    original_invoice_number,
    reason,
    notes,
    currency,
    credit_note_type,
    business_case,
    stock_disposition,
    godown,
    subtotal,
    tax_amount,
    total_amount,
    material_return_id,
    status,
    created_by
  ) VALUES (
    v_cn_number,
    v_date,
    v_cust_id,
    v_orig_inv_id,
    v_orig_inv.invoice_number,
    v_reason,
    v_notes,
    v_currency,
    v_type,
    v_bc,
    v_disp,
    v_godown,
    v_subtotal,
    v_tax,
    v_total,
    v_mr_id,
    'pending_approval',
    v_caller
  ) RETURNING id INTO v_cn_id;

  -- 2. Insert Credit Note Items
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    INSERT INTO public.credit_note_items (
      credit_note_id,
      sales_invoice_item_id,
      delivery_challan_item_id,
      product_id,
      batch_id,
      quantity,
      unit_price,
      condition,
      disposition,
      notes
    ) VALUES (
      v_cn_id,
      NULLIF(v_item->>'sales_invoice_item_id', '')::uuid,
      NULLIF(v_item->>'delivery_challan_item_id', '')::uuid,
      (v_item->>'product_id')::uuid,
      NULLIF(v_item->>'batch_id', '')::uuid,
      (v_item->>'quantity')::numeric,
      (v_item->>'unit_price')::numeric,
      COALESCE(v_item->>'condition', 'good'),
      COALESCE(v_item->>'disposition', v_disp),
      v_item->>'notes'
    );
  END LOOP;

  -- 3. If physical return and no existing material return linked, generate linked Goods Return Receipt
  IF v_type = 'physical_return' AND v_mr_id IS NULL THEN
    v_grr_number := 'GRR-' || v_cn_number;
    INSERT INTO public.material_returns (
      return_number,
      original_invoice_id,
      customer_id,
      return_date,
      return_type,
      return_reason,
      status,
      credit_note_id,
      credit_note_issued,
      credit_note_number,
      credit_note_amount,
      restocked,
      notes,
      created_by
    ) VALUES (
      v_grr_number,
      v_orig_inv_id,
      v_cust_id,
      v_date,
      'credit_note_return',
      'Goods Return Receipt for ' || v_cn_number,
      'pending_approval',
      v_cn_id,
      true,
      v_cn_number,
      v_total,
      false,
      'Auto-generated Goods Return Receipt awaiting warehouse physical inspection',
      v_caller
    ) RETURNING id INTO v_grr_id;

    -- Insert items into material_return_items
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
      INSERT INTO public.material_return_items (
        return_id,
        product_id,
        batch_id,
        quantity_returned,
        unit_price,
        condition,
        disposition,
        notes
      ) VALUES (
        v_grr_id,
        (v_item->>'product_id')::uuid,
        (v_item->>'batch_id')::uuid,
        (v_item->>'quantity')::numeric,
        (v_item->>'unit_price')::numeric,
        COALESCE(v_item->>'condition', 'good'),
        CASE WHEN COALESCE(v_item->>'disposition', v_disp) = 'saleable' THEN 'restock' ELSE 'quarantine' END,
        'Expected physical return for ' || v_cn_number
      );
    END LOOP;

    -- Link back to credit note
    UPDATE public.credit_notes
       SET goods_return_receipt_id = v_grr_id,
           material_return_id = v_grr_id
     WHERE id = v_cn_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'credit_note_id', v_cn_id,
    'credit_note_number', v_cn_number,
    'subtotal', v_subtotal,
    'tax_amount', v_tax,
    'total_amount', v_total,
    'tax_rate', v_tax_rate,
    'goods_return_receipt_id', v_grr_id,
    'status', 'pending_approval'
  );
END;
$$;

-- ------------------------------------------------------------------------------
-- 4. Corrected SO Status View (Distinct Invoices, Independent Line Summation)
-- ------------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.so_delivery_invoice_status WITH (security_invoker = true) AS
WITH ordered AS (
  SELECT
    soi.sales_order_id AS so_id,
    COALESCE(SUM(soi.quantity), 0::numeric) AS ordered_qty
  FROM public.sales_order_items soi
  GROUP BY soi.sales_order_id
),
approved_delivery AS (
  SELECT
    dc.sales_order_id AS so_id,
    COALESCE(SUM(dci.quantity), 0::numeric) AS approved_delivered_qty,
    count(DISTINCT dc.id) AS approved_dc_count
  FROM public.delivery_challans dc
  JOIN public.delivery_challan_items dci ON dci.challan_id = dc.id
  WHERE dc.approval_status::text = 'approved'
    AND dc.sales_order_id IS NOT NULL
  GROUP BY dc.sales_order_id
),
so_reportable_invoice_headers AS (
  SELECT DISTINCT
    si.id AS invoice_id,
    COALESCE(si.sales_order_id, dc.sales_order_id) AS so_id
  FROM public.sales_invoices si
  LEFT JOIN public.sales_invoice_items sii ON sii.invoice_id = si.id
  LEFT JOIN public.delivery_challan_items dci ON dci.id = sii.delivery_challan_item_id
  LEFT JOIN public.delivery_challans dc ON dc.id = dci.challan_id
  WHERE public.is_reportable_sales_invoice(si.document_status, si.is_draft, si.notes)
    AND (si.invoice_number NOT ILIKE 'TEST-COGS-%')
    AND COALESCE(si.sales_order_id, dc.sales_order_id) IS NOT NULL
),
so_reportable_invoice_lines AS (
  SELECT
    sii.id AS invoice_item_id,
    COALESCE(si.sales_order_id, dc.sales_order_id) AS so_id,
    sii.quantity
  FROM public.sales_invoice_items sii
  JOIN public.sales_invoices si ON si.id = sii.invoice_id
  LEFT JOIN public.delivery_challan_items dci ON dci.id = sii.delivery_challan_item_id
  LEFT JOIN public.delivery_challans dc ON dc.id = dci.challan_id
  WHERE public.is_reportable_sales_invoice(si.document_status, si.is_draft, si.notes)
    AND (si.invoice_number NOT ILIKE 'TEST-COGS-%')
    AND COALESCE(si.sales_order_id, dc.sales_order_id) IS NOT NULL
),
invoiced_counts AS (
  SELECT
    so_id,
    count(DISTINCT invoice_id) AS invoice_count
  FROM so_reportable_invoice_headers
  GROUP BY so_id
),
invoiced_quantities AS (
  SELECT
    so_id,
    COALESCE(SUM(quantity), 0::numeric) AS invoiced_qty
  FROM so_reportable_invoice_lines
  GROUP BY so_id
)
SELECT
  so.id AS so_id,
  so.so_number,
  so.customer_id,
  so.status AS so_status,
  CASE
    WHEN COALESCE(ad.approved_delivered_qty, 0::numeric) = 0::numeric THEN 'pending'::text
    WHEN COALESCE(ad.approved_delivered_qty, 0::numeric) >= COALESCE(o.ordered_qty, 0::numeric)
         AND COALESCE(o.ordered_qty, 0::numeric) > 0::numeric THEN 'completed'::text
    ELSE 'partial'::text
  END AS delivery_status,
  CASE
    WHEN COALESCE(iq.invoiced_qty, 0::numeric) = 0::numeric THEN 'pending'::text
    WHEN COALESCE(iq.invoiced_qty, 0::numeric) >= COALESCE(o.ordered_qty, 0::numeric)
         AND COALESCE(o.ordered_qty, 0::numeric) > 0::numeric THEN 'completed'::text
    ELSE 'partial'::text
  END AS invoice_status,
  CASE
    WHEN COALESCE(iq.invoiced_qty, 0::numeric) > 0::numeric
         AND COALESCE(ad.approved_delivered_qty, 0::numeric) = 0::numeric THEN 'invoice_done_delivery_pending'::text
    ELSE NULL::text
  END AS special_status,
  COALESCE(ad.approved_dc_count, 0::bigint) AS approved_dc_count,
  COALESCE(ic.invoice_count, 0::bigint) AS invoice_count,
  COALESCE(o.ordered_qty, 0::numeric) AS ordered_qty,
  COALESCE(ad.approved_delivered_qty, 0::numeric) AS approved_delivered_qty,
  COALESCE(iq.invoiced_qty, 0::numeric) AS invoiced_qty
FROM public.sales_orders so
LEFT JOIN ordered o ON o.so_id = so.id
LEFT JOIN approved_delivery ad ON ad.so_id = so.id
LEFT JOIN invoiced_counts ic ON ic.so_id = so.id
LEFT JOIN invoiced_quantities iq ON iq.so_id = so.id;

-- ------------------------------------------------------------------------------
-- 5. Privileged Permissions Lockdown
-- ------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.validate_coa_account(text, text, text) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.validate_coa_account(text, text, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.create_credit_note_atomic(jsonb, jsonb, uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_credit_note_atomic(jsonb, jsonb, uuid) TO authenticated, service_role;

GRANT SELECT ON public.so_delivery_invoice_status TO authenticated, service_role;
