-- ==============================================================================
-- Migration: 20261030140000_sales_lifecycle_terminal_cancellation_and_concurrency_hardening.sql
-- Description: Sales invoice lifecycle terminal cancellation, DC concurrency locking,
--              item-level DC invoicing quantity rollup, hardened authorization guards,
--              and production-compatible view contracts.
-- ==============================================================================

BEGIN;

-- ==============================================================================
-- 1. Lifecycle Trigger & Column Default Hardening
-- ==============================================================================

-- Remove default on document_status so the BEFORE INSERT trigger can distinguish
-- an omitted status from a status explicitly supplied by legacy or modern callers.
ALTER TABLE public.sales_invoices ALTER COLUMN document_status DROP DEFAULT;

CREATE OR REPLACE FUNCTION public.trg_sync_sales_invoice_document_status()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_status_changed boolean := false;
  v_draft_changed boolean := false;
  v_is_cancelled boolean := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- If document_status was explicitly provided:
    IF NEW.document_status IS NOT NULL THEN
      IF NEW.document_status = 'draft' THEN
        NEW.is_draft := true;
      ELSIF NEW.document_status IN ('posted', 'cancelled') THEN
        NEW.is_draft := false;
      END IF;
    -- If document_status was omitted (NULL), infer status from is_draft and legacy cancellation notes:
    ELSE
      IF NEW.is_draft = true THEN
        NEW.document_status := 'draft';
      ELSIF (COALESCE(NEW.notes, '') LIKE '[CANCELLED%' OR LOWER(COALESCE(NEW.notes, '')) LIKE 'cancelled%') THEN
        NEW.document_status := 'cancelled';
        NEW.is_draft := false;
      ELSE
        NEW.document_status := 'posted';
        NEW.is_draft := false;
      END IF;
    END IF;

    IF NEW.document_status = 'cancelled' AND NEW.cancelled_at IS NULL THEN
      NEW.cancelled_at := now();
    END IF;

    RETURN NEW;
  END IF;

  -- TG_OP = 'UPDATE'
  v_status_changed := (NEW.document_status IS DISTINCT FROM OLD.document_status);
  v_draft_changed  := (NEW.is_draft IS DISTINCT FROM OLD.is_draft);
  v_is_cancelled   := (OLD.document_status = 'cancelled' OR OLD.notes LIKE '[CANCELLED%' OR LOWER(OLD.notes) LIKE 'cancelled%');

  -- TERMINAL CANCELLATION ENFORCEMENT:
  -- If an invoice is currently cancelled, cancellation is terminal.
  -- An update must NEVER silently change a cancelled invoice back to posted or draft.
  IF v_is_cancelled THEN
    IF NEW.document_status IS DISTINCT FROM 'cancelled' THEN
      RAISE EXCEPTION 'Cannot update or reopen cancelled sales invoice %: cancellation is terminal', OLD.invoice_number;
    END IF;
    NEW.document_status := 'cancelled';
    NEW.is_draft := false;
    IF NEW.cancelled_at IS NULL THEN
      NEW.cancelled_at := COALESCE(OLD.cancelled_at, now());
    END IF;
    RETURN NEW;
  END IF;

  -- PRECEDENCE & CONFLICT RESOLUTION RULE FOR UNCANCELLED INVOICES:
  -- 1. If document_status was explicitly changed, explicit document_status takes absolute precedence over is_draft.
  IF v_status_changed THEN
    IF NEW.document_status = 'draft' THEN
      NEW.is_draft := true;
    ELSIF NEW.document_status IN ('posted', 'cancelled') THEN
      NEW.is_draft := false;
    END IF;
  ELSIF v_draft_changed THEN
    -- 2. Only is_draft was changed on an uncancelled invoice (legacy update path):
    IF NEW.is_draft = true THEN
      NEW.document_status := 'draft';
    ELSE
      NEW.document_status := 'posted';
    END IF;
  ELSE
    -- 3. Routine update without explicit status or draft change:
    IF NEW.document_status IS NULL THEN
      IF NEW.is_draft = true THEN
        NEW.document_status := 'draft';
      ELSE
        NEW.document_status := 'posted';
      END IF;
    ELSIF NEW.document_status = 'draft' THEN
      NEW.is_draft := true;
    ELSIF NEW.document_status IN ('posted', 'cancelled') THEN
      NEW.is_draft := false;
    END IF;
  END IF;

  IF NEW.document_status = 'cancelled' AND NEW.cancelled_at IS NULL THEN
    NEW.cancelled_at := COALESCE(OLD.cancelled_at, now());
  END IF;

  RETURN NEW;
END;
$$;

-- ==============================================================================
-- 2. Deterministic Row-Locking Invoice Creation RPC
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.create_sales_invoice_atomic(
  p_invoice jsonb,
  p_items jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_role text;
  v_invoice_id uuid;
  v_subtotal numeric := 0;
  v_tax numeric := 0;
  v_total numeric := 0;
  v_discount numeric := COALESCE((p_invoice->>'discount_amount')::numeric, 0);
  v_stamp numeric := COALESCE((p_invoice->>'stamp_duty_amount')::numeric, 0);
  v_count integer := jsonb_array_length(p_items);
  v_item jsonb;
  v_product uuid;
  v_batch uuid;
  v_dc_item uuid;
  v_qty numeric;
  v_price numeric;
  v_rate numeric;
  v_dc record;
  v_linked_challans uuid[];
  v_invoice_so_id uuid := NULLIF(p_invoice->>'sales_order_id','')::uuid;
  v_doc_status text := p_invoice->>'document_status';
  v_already_invoiced numeric;
  v_requested_dc_qty numeric;
BEGIN
  SELECT role INTO v_role FROM public.user_profiles WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('admin', 'accounts', 'sales', 'warehouse') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot create sales invoices', COALESCE(v_role, 'none');
  END IF;
  IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Sales invoice requires at least one product line';
  END IF;
  IF NULLIF(p_invoice->>'invoice_number','') IS NULL OR NULLIF(p_invoice->>'customer_id','') IS NULL THEN
    RAISE EXCEPTION 'Invoice number and customer are required';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sales_invoices WHERE invoice_number = p_invoice->>'invoice_number') THEN
    RAISE EXCEPTION 'Invoice number already exists';
  END IF;

  -- 1. Deterministic Lock Step A: Lock parent delivery_challans in ASC order
  PERFORM dc.id
  FROM public.delivery_challans dc
  WHERE dc.id IN (
    SELECT DISTINCT dci.challan_id
    FROM public.delivery_challan_items dci
    WHERE dci.id IN (
      SELECT DISTINCT (val->>'delivery_challan_item_id')::uuid
      FROM jsonb_array_elements(p_items) val
      WHERE NULLIF(val->>'delivery_challan_item_id', '') IS NOT NULL
    )
  )
  ORDER BY dc.id ASC
  FOR UPDATE;

  -- 1. Deterministic Lock Step B: Lock child delivery_challan_items in ASC order
  PERFORM dci.id
  FROM public.delivery_challan_items dci
  WHERE dci.id IN (
    SELECT DISTINCT (val->>'delivery_challan_item_id')::uuid
    FROM jsonb_array_elements(p_items) val
    WHERE NULLIF(val->>'delivery_challan_item_id', '') IS NOT NULL
  )
  ORDER BY dci.id ASC
  FOR UPDATE;

  -- 2. Process and validate each invoice line item against locked DC items
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items)
  LOOP
    v_product := NULLIF(v_item->>'product_id','')::uuid;
    v_batch := NULLIF(v_item->>'batch_id','')::uuid;
    v_dc_item := NULLIF(v_item->>'delivery_challan_item_id','')::uuid;
    v_qty := (v_item->>'quantity')::numeric;
    v_price := (v_item->>'unit_price')::numeric;
    v_rate := COALESCE((v_item->>'tax_rate')::numeric, 0);

    IF v_product IS NULL OR v_dc_item IS NULL OR COALESCE(v_qty,0) <= 0 OR COALESCE(v_price,0) < 0 THEN
      RAISE EXCEPTION 'Every invoice line must have a source Delivery Challan item, product, quantity, and price';
    END IF;

    SELECT dci.product_id, dci.batch_id, dci.quantity, dc.customer_id, dc.approval_status, dc.sales_order_id
      INTO v_dc
    FROM public.delivery_challan_items dci
    JOIN public.delivery_challans dc ON dc.id = dci.challan_id
    WHERE dci.id = v_dc_item;

    IF NOT FOUND OR v_dc.product_id IS DISTINCT FROM v_product OR v_dc.batch_id IS DISTINCT FROM v_batch
       OR v_dc.customer_id IS DISTINCT FROM (p_invoice->>'customer_id')::uuid
       OR v_dc.approval_status::text <> 'approved' THEN
      RAISE EXCEPTION 'Invoice line source Delivery Challan is invalid or not approved';
    END IF;

    IF v_invoice_so_id IS NOT NULL AND v_dc.sales_order_id IS DISTINCT FROM v_invoice_so_id THEN
      RAISE EXCEPTION 'Invoice Sales Order does not match its Delivery Challan source';
    END IF;

    -- Recalculate remaining invoiceable quantity for this DC item across all reportable invoices
    SELECT COALESCE(SUM(sii.quantity), 0)
    INTO v_already_invoiced
    FROM public.sales_invoice_items sii
    JOIN public.sales_invoices si ON si.id = sii.invoice_id
    WHERE sii.delivery_challan_item_id = v_dc_item
      AND public.is_reportable_sales_invoice(si.document_status, si.is_draft, si.notes);

    -- Calculate total quantity requested in current invoice items payload for this DC item (intra-request summation)
    SELECT COALESCE(SUM((val->>'quantity')::numeric), 0)
    INTO v_requested_dc_qty
    FROM jsonb_array_elements(p_items) val
    WHERE (val->>'delivery_challan_item_id')::uuid = v_dc_item;

    IF (v_already_invoiced + v_requested_dc_qty) > v_dc.quantity THEN
      RAISE EXCEPTION 'Invoice quantity % exceeds remaining Delivery Challan quantity % (DC total %, already invoiced %)',
        v_requested_dc_qty, (v_dc.quantity - v_already_invoiced), v_dc.quantity, v_already_invoiced;
    END IF;

    v_subtotal := v_subtotal + (v_qty * v_price);
    v_tax := v_tax + ROUND(v_qty * v_price * (v_rate / 100.0), 2);
  END LOOP;

  v_total := v_subtotal + v_tax - v_discount + v_stamp;

  SELECT array_agg(DISTINCT dc.id)
  INTO v_linked_challans
  FROM public.delivery_challan_items dci
  JOIN public.delivery_challans dc ON dc.id = dci.challan_id
  WHERE dci.id IN (
    SELECT DISTINCT (val->>'delivery_challan_item_id')::uuid
    FROM jsonb_array_elements(p_items) val
    WHERE NULLIF(val->>'delivery_challan_item_id', '') IS NOT NULL
  );

  INSERT INTO public.sales_invoices (
    invoice_number, customer_id, sales_order_id, invoice_date, due_date, discount_amount,
    delivery_challan_number, po_number, payment_terms_days, notes, subtotal, tax_amount,
    stamp_duty_amount, total_amount, payment_status, created_by, linked_challan_ids, document_status
  ) VALUES (
    p_invoice->>'invoice_number', (p_invoice->>'customer_id')::uuid, v_invoice_so_id,
    COALESCE((p_invoice->>'invoice_date')::date, CURRENT_DATE), (p_invoice->>'due_date')::date, v_discount,
    NULL, p_invoice->>'po_number', (p_invoice->>'payment_terms_days')::integer, p_invoice->>'notes',
    v_subtotal, v_tax, v_stamp, v_total, 'pending', COALESCE(NULLIF(p_invoice->>'created_by','')::uuid, auth.uid()),
    COALESCE(v_linked_challans, CASE WHEN jsonb_typeof(p_invoice->'linked_challan_ids')='array' THEN
      ARRAY(SELECT jsonb_array_elements_text(p_invoice->'linked_challan_ids')::uuid) ELSE NULL END),
    v_doc_status
  ) RETURNING id INTO v_invoice_id;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items)
  LOOP
    INSERT INTO public.sales_invoice_items
      (invoice_id, product_id, batch_id, quantity, unit_price, tax_rate, delivery_challan_item_id)
    VALUES (v_invoice_id, (v_item->>'product_id')::uuid, NULLIF(v_item->>'batch_id','')::uuid,
      (v_item->>'quantity')::numeric, (v_item->>'unit_price')::numeric,
      COALESCE((v_item->>'tax_rate')::numeric,0), (v_item->>'delivery_challan_item_id')::uuid);
  END LOOP;

  IF (SELECT count(*) FROM public.sales_invoice_items WHERE invoice_id = v_invoice_id) <> v_count THEN
    RAISE EXCEPTION 'Invoice line count verification failed';
  END IF;

  RETURN v_invoice_id;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.create_sales_invoice_atomic(jsonb, jsonb) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_sales_invoice_atomic(jsonb, jsonb) TO authenticated, service_role;

-- ==============================================================================
-- 3. Deterministic Row-Locking Invoice Update RPC (Both Overloads)
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.update_sales_invoice_atomic(
  p_invoice_id uuid,
  p_invoice_updates jsonb,
  p_new_items jsonb[]
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_role text;
  v_old_je_id uuid;
  v_result uuid;
  v_existing_invoice public.sales_invoices%ROWTYPE;
  v_old_dc_item_ids uuid[];
  v_new_dc_item_ids uuid[];
  v_all_dc_item_ids uuid[];
  v_all_parent_dc_ids uuid[];
  v_linked_challan_ids text[];
  v_sales_order_ids uuid[];
  v_customer_ids uuid[];
  v_item jsonb;
  v_dc_item uuid;
  v_product uuid;
  v_batch uuid;
  v_qty numeric;
  v_price numeric;
  v_dci_product uuid;
  v_dci_batch uuid;
  v_dci_qty numeric;
  v_other_invoiced numeric;
  v_req_dc_qty numeric;
BEGIN
  SELECT role INTO v_role FROM public.user_profiles WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('admin', 'accounts', 'sales') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot update sales invoices', COALESCE(v_role, 'none');
  END IF;

  -- 1. Fetch and lock existing invoice record
  SELECT * INTO v_existing_invoice
  FROM public.sales_invoices
  WHERE id = p_invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales Invoice % not found', p_invoice_id;
  END IF;

  -- TERMINAL CANCELLATION GUARD: Cancelled invoices cannot be updated
  IF v_existing_invoice.document_status = 'cancelled'
     OR (COALESCE(v_existing_invoice.notes, '') LIKE '[CANCELLED%' OR LOWER(COALESCE(v_existing_invoice.notes, '')) LIKE 'cancelled%') THEN
    RAISE EXCEPTION 'Cannot update cancelled sales invoice %: cancellation is terminal', v_existing_invoice.invoice_number;
  END IF;

  -- 2. Collect old and new DC item IDs
  SELECT array_agg(DISTINCT delivery_challan_item_id)
  INTO v_old_dc_item_ids
  FROM public.sales_invoice_items
  WHERE invoice_id = p_invoice_id AND delivery_challan_item_id IS NOT NULL;

  SELECT array_agg(DISTINCT NULLIF(item->>'delivery_challan_item_id', '')::uuid)
  INTO v_new_dc_item_ids
  FROM unnest(p_new_items) AS item
  WHERE NULLIF(item->>'delivery_challan_item_id', '') IS NOT NULL;

  IF v_new_dc_item_ids IS NULL OR cardinality(v_new_dc_item_ids) = 0 THEN
    RAISE EXCEPTION 'Sales Invoice must contain Delivery Challan-linked items';
  END IF;

  -- Combine for deterministic locking
  SELECT array_agg(DISTINCT dci_id ORDER BY dci_id ASC)
  INTO v_all_dc_item_ids
  FROM (
    SELECT unnest(COALESCE(v_old_dc_item_ids, ARRAY[]::uuid[])) AS dci_id
    UNION
    SELECT unnest(v_new_dc_item_ids) AS dci_id
  ) t;

  -- Collect parent DC IDs
  SELECT array_agg(DISTINCT challan_id ORDER BY challan_id ASC)
  INTO v_all_parent_dc_ids
  FROM public.delivery_challan_items
  WHERE id = ANY(v_all_dc_item_ids);

  -- 3. Deterministic Locking:
  -- Step A: Lock parent delivery_challans in ASC order
  PERFORM dc.id
  FROM public.delivery_challans dc
  WHERE dc.id = ANY(v_all_parent_dc_ids)
  ORDER BY dc.id ASC
  FOR UPDATE;

  -- Step B: Lock child delivery_challan_items in ASC order
  PERFORM dci.id
  FROM public.delivery_challan_items dci
  WHERE dci.id = ANY(v_all_dc_item_ids)
  ORDER BY dci.id ASC
  FOR UPDATE;

  -- 4. Validate Delivery Challan eligibility on new items
  IF cardinality(v_new_dc_item_ids) <> (
    SELECT count(*) FROM public.delivery_challan_items WHERE id = ANY(v_new_dc_item_ids)
  ) THEN
    RAISE EXCEPTION 'Sales Invoice contains a missing Delivery Challan item';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.delivery_challan_items dci
    JOIN public.delivery_challans dc ON dc.id = dci.challan_id
    WHERE dci.id = ANY(v_new_dc_item_ids)
      AND dc.approval_status::text <> 'approved'
  ) THEN
    RAISE EXCEPTION 'All source Delivery Challans must be approved';
  END IF;

  SELECT
    array_agg(DISTINCT dc.id::text ORDER BY dc.id::text),
    array_agg(DISTINCT dc.sales_order_id),
    array_agg(DISTINCT dc.customer_id)
  INTO v_linked_challan_ids, v_sales_order_ids, v_customer_ids
  FROM public.delivery_challan_items dci
  JOIN public.delivery_challans dc ON dc.id = dci.challan_id
  WHERE dci.id = ANY(v_new_dc_item_ids);

  IF cardinality(v_customer_ids) <> 1
     OR (p_invoice_updates ? 'customer_id'
         AND (p_invoice_updates->>'customer_id')::uuid IS DISTINCT FROM v_customer_ids[1]) THEN
    RAISE EXCEPTION 'Invoice customer must match all linked Delivery Challans';
  END IF;

  -- 5. Validate complete requested quantities against available DC capacities
  -- (excluding the invoice currently being updated)
  FOR v_item IN SELECT unnest(p_new_items)
  LOOP
    v_dc_item := NULLIF(v_item->>'delivery_challan_item_id', '')::uuid;
    v_qty := (v_item->>'quantity')::numeric;
    v_product := (v_item->>'product_id')::uuid;
    v_batch := NULLIF(v_item->>'batch_id', '')::uuid;
    v_price := (v_item->>'unit_price')::numeric;

    IF v_product IS NULL OR v_dc_item IS NULL OR COALESCE(v_qty, 0) <= 0 OR COALESCE(v_price, 0) < 0 THEN
      RAISE EXCEPTION 'Every invoice line must have a valid Delivery Challan item, product, and positive quantity';
    END IF;

    SELECT dci.product_id, dci.batch_id, dci.quantity
    INTO v_dci_product, v_dci_batch, v_dci_qty
    FROM public.delivery_challan_items dci
    WHERE dci.id = v_dc_item;

    IF v_dci_product IS DISTINCT FROM v_product OR v_dci_batch IS DISTINCT FROM v_batch THEN
      RAISE EXCEPTION 'Invoice line product or batch does not match source Delivery Challan item';
    END IF;

    -- Calculate already invoiced by other reportable invoices
    SELECT COALESCE(SUM(sii.quantity), 0)
    INTO v_other_invoiced
    FROM public.sales_invoice_items sii
    JOIN public.sales_invoices si ON si.id = sii.invoice_id
    WHERE sii.delivery_challan_item_id = v_dc_item
      AND si.id <> p_invoice_id
      AND public.is_reportable_sales_invoice(si.document_status, si.is_draft, si.notes);

    -- Calculate total requested for this DC item in current payload
    SELECT COALESCE(SUM((val->>'quantity')::numeric), 0)
    INTO v_req_dc_qty
    FROM unnest(p_new_items) val
    WHERE NULLIF(val->>'delivery_challan_item_id', '')::uuid = v_dc_item;

    IF (v_other_invoiced + v_req_dc_qty) > v_dci_qty THEN
      RAISE EXCEPTION 'Invoice quantity % exceeds remaining Delivery Challan quantity % (DC total %, already invoiced by other invoices %)',
        v_req_dc_qty, (v_dci_qty - v_other_invoiced), v_dci_qty, v_other_invoiced;
    END IF;
  END LOOP;

  -- 6. Remove old journal entries
  SELECT journal_entry_id INTO v_old_je_id
  FROM public.sales_invoices
  WHERE id = p_invoice_id;

  IF v_old_je_id IS NOT NULL THEN
    UPDATE public.sales_invoices SET journal_entry_id = NULL WHERE id = p_invoice_id;
    DELETE FROM public.journal_entry_lines WHERE journal_entry_id = v_old_je_id;
    DELETE FROM public.journal_entries WHERE id = v_old_je_id;
  END IF;

  DELETE FROM public.journal_entry_lines
  WHERE journal_entry_id IN (
    SELECT id FROM public.journal_entries
    WHERE source_module = 'sales_invoice_cogs' AND reference_id = p_invoice_id
  );
  DELETE FROM public.journal_entries
  WHERE source_module = 'sales_invoice_cogs' AND reference_id = p_invoice_id;

  -- 7. Replace invoice items atomically
  DELETE FROM public.sales_invoice_items WHERE invoice_id = p_invoice_id;
  PERFORM set_config('app.sales_invoice_rebuild', 'true', true);

  UPDATE public.sales_invoices
  SET
    invoice_date       = COALESCE((p_invoice_updates->>'invoice_date')::date, invoice_date),
    due_date           = COALESCE((p_invoice_updates->>'due_date')::date, due_date),
    customer_id        = v_customer_ids[1],
    sales_order_id     = CASE WHEN cardinality(v_sales_order_ids) = 1 THEN v_sales_order_ids[1] ELSE NULL END,
    subtotal           = COALESCE((p_invoice_updates->>'subtotal')::numeric, subtotal),
    tax_amount         = COALESCE((p_invoice_updates->>'tax_amount')::numeric, tax_amount),
    total_amount       = COALESCE((p_invoice_updates->>'total_amount')::numeric, total_amount),
    discount_amount    = COALESCE((p_invoice_updates->>'discount_amount')::numeric, discount_amount),
    stamp_duty_amount  = COALESCE((p_invoice_updates->>'stamp_duty_amount')::numeric, stamp_duty_amount),
    po_number          = COALESCE(p_invoice_updates->>'po_number', po_number),
    payment_terms_days = COALESCE((p_invoice_updates->>'payment_terms_days')::integer, payment_terms_days),
    notes              = COALESCE(p_invoice_updates->>'notes', notes),
    linked_challan_ids = v_linked_challan_ids,
    document_status    = CASE
                           WHEN p_invoice_updates ? 'document_status'
                           THEN p_invoice_updates->>'document_status'
                           ELSE document_status
                         END,
    updated_at         = now()
  WHERE id = p_invoice_id
  RETURNING id INTO v_result;

  INSERT INTO public.sales_invoice_items (
    invoice_id, product_id, batch_id, quantity, unit_price, tax_rate, delivery_challan_item_id
  )
  SELECT
    p_invoice_id,
    (item->>'product_id')::uuid,
    NULLIF(item->>'batch_id', '')::uuid,
    (item->>'quantity')::numeric,
    (item->>'unit_price')::numeric,
    (item->>'tax_rate')::numeric,
    NULLIF(item->>'delivery_challan_item_id', '')::uuid
  FROM unnest(p_new_items) AS item;

  PERFORM set_config('app.sales_invoice_rebuild', 'false', true);
  UPDATE public.sales_invoices SET updated_at = now()
  WHERE id = p_invoice_id AND journal_entry_id IS NULL;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_sales_invoice_atomic(
  p_invoice_id uuid,
  p_invoice_updates jsonb,
  p_items jsonb,
  p_user_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_result uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_result := public.update_sales_invoice_atomic(
    p_invoice_id,
    p_invoice_updates,
    ARRAY(
      SELECT value
      FROM jsonb_array_elements(
        CASE jsonb_typeof(p_items)
          WHEN 'array' THEN p_items
          ELSE '[]'::jsonb
        END
      )
    )
  );

  RETURN jsonb_build_object('success', true, 'invoice_id', v_result);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.update_sales_invoice_atomic(uuid, jsonb, jsonb[]) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.update_sales_invoice_atomic(uuid, jsonb, jsonb, uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_sales_invoice_atomic(uuid, jsonb, jsonb[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_sales_invoice_atomic(uuid, jsonb, jsonb, uuid) TO authenticated, service_role;

-- ==============================================================================
-- 4. Deterministic Row-Locking Delivery Challan Cancellation Function
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.fn_cancel_delivery_challan(
  p_dc_id uuid,
  p_user uuid,
  p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_role text;
  v_caller uuid := auth.uid();
  v_blocking_invoices text;
BEGIN
  IF v_caller IS NULL THEN
    v_caller := p_user;
  END IF;
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT role INTO v_role FROM public.user_profiles WHERE id = v_caller;
  IF v_role IS NULL OR v_role NOT IN ('admin','accounts','warehouse') THEN
    RAISE EXCEPTION 'Not authorized to cancel delivery challans';
  END IF;

  -- 1. Deterministic Lock Step A: Lock parent delivery_challans
  PERFORM dc.id
  FROM public.delivery_challans dc
  WHERE dc.id = p_dc_id
  FOR UPDATE;

  -- 1. Deterministic Lock Step B: Lock child delivery_challan_items in ASC order
  PERFORM dci.id
  FROM public.delivery_challan_items dci
  WHERE dci.challan_id = p_dc_id
  ORDER BY dci.id ASC
  FOR UPDATE;

  -- 2. Prevent cancellation if any reportable sales invoices exist against this DC
  SELECT string_agg(DISTINCT si.invoice_number, ', ')
  INTO v_blocking_invoices
  FROM public.sales_invoice_items sii
  JOIN public.delivery_challan_items dci ON dci.id = sii.delivery_challan_item_id
  JOIN public.sales_invoices si ON si.id = sii.invoice_id
  WHERE dci.challan_id = p_dc_id
    AND public.is_reportable_sales_invoice(si.document_status, si.is_draft, si.notes);

  IF v_blocking_invoices IS NOT NULL AND v_blocking_invoices <> '' THEN
    RAISE EXCEPTION 'Cannot cancel Delivery Challan %: already invoiced by active sales invoice(s) %; reverse or cancel the invoice(s) first',
      p_dc_id, v_blocking_invoices;
  END IF;

  UPDATE public.delivery_challans
     SET approval_status   = 'cancelled',
         rejection_reason  = COALESCE(p_reason, rejection_reason),
         rejected_by       = v_caller,
         rejected_at       = now(),
         updated_at        = now()
   WHERE id = p_dc_id;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.fn_cancel_delivery_challan(uuid, uuid, text) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_cancel_delivery_challan(uuid, uuid, text) TO authenticated, service_role;

-- ==============================================================================
-- 5. DC Invoicing Summary View (Item-Level Quantity Aggregation, Production Contract)
-- ==============================================================================

CREATE OR REPLACE VIEW public.dc_invoicing_summary WITH (security_invoker = true) AS
WITH dc_item_inv AS (
  SELECT
    dci.id AS dc_item_id,
    dci.challan_id,
    dci.quantity AS approved_quantity,
    COALESCE(SUM(sii.quantity), 0::numeric) AS invoiced_quantity,
    GREATEST(0::numeric, dci.quantity - COALESCE(SUM(sii.quantity), 0::numeric)) AS remaining_quantity
  FROM public.delivery_challan_items dci
  LEFT JOIN (
    public.sales_invoice_items sii
    JOIN public.sales_invoices si ON si.id = sii.invoice_id
      AND public.is_reportable_sales_invoice(si.document_status, si.is_draft, si.notes)
  ) ON sii.delivery_challan_item_id = dci.id
  GROUP BY dci.id, dci.challan_id, dci.quantity
),
dc_item_totals AS (
  SELECT
    challan_id,
    count(*)::bigint AS total_items,
    count(CASE WHEN invoiced_quantity = 0 THEN 1 END)::bigint AS not_invoiced_items,
    count(CASE WHEN invoiced_quantity >= approved_quantity THEN 1 END)::bigint AS invoiced_items,
    count(CASE WHEN invoiced_quantity > 0 AND invoiced_quantity < approved_quantity THEN 1 END)::bigint AS partially_invoiced_items,
    COALESCE(sum(approved_quantity), 0::numeric) AS total_quantity,
    COALESCE(sum(invoiced_quantity), 0::numeric) AS total_invoiced_quantity,
    COALESCE(sum(remaining_quantity), 0::numeric) AS total_remaining_quantity
  FROM dc_item_inv
  GROUP BY challan_id
),
dc_invoices AS (
  SELECT
    dci.challan_id,
    COALESCE(array_agg(DISTINCT si.invoice_number) FILTER (WHERE si.invoice_number IS NOT NULL), ARRAY[]::text[]) AS invoice_numbers
  FROM public.delivery_challan_items dci
  JOIN public.sales_invoice_items sii ON sii.delivery_challan_item_id = dci.id
  JOIN public.sales_invoices si ON si.id = sii.invoice_id
    AND public.is_reportable_sales_invoice(si.document_status, si.is_draft, si.notes)
  GROUP BY dci.challan_id
)
SELECT
  dc.id AS challan_id,
  dc.challan_number,
  dc.customer_id,
  dc.challan_date,
  dc.approval_status,
  COALESCE(t.total_items, 0::bigint) AS total_items,
  COALESCE(t.not_invoiced_items, 0::bigint) AS not_invoiced_items,
  COALESCE(t.invoiced_items, 0::bigint) AS invoiced_items,
  COALESCE(t.total_quantity, 0::numeric) AS total_quantity,
  COALESCE(t.total_remaining_quantity, 0::numeric) AS total_remaining_quantity,
  CASE
    WHEN COALESCE(t.total_invoiced_quantity, 0::numeric) = 0 THEN 'not_invoiced'::text
    WHEN COALESCE(t.total_remaining_quantity, 0::numeric) = 0 THEN 'fully_invoiced'::text
    ELSE 'partially_invoiced'::text
  END AS dc_status,
  COALESCE(inv.invoice_numbers, ARRAY[]::text[]) AS linked_invoices,
  COALESCE(inv.invoice_numbers, ARRAY[]::text[]) AS linked_invoice_numbers
FROM public.delivery_challans dc
LEFT JOIN dc_item_totals t ON t.challan_id = dc.id
LEFT JOIN dc_invoices inv ON inv.challan_id = dc.id;

-- ==============================================================================
-- 6. SO-to-DC-to-Invoice Status View (Production Contract Compatible)
-- ==============================================================================

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
so_reportable_invoices AS (
  SELECT DISTINCT
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
invoiced AS (
  SELECT
    so_id,
    COALESCE(SUM(quantity), 0::numeric) AS invoiced_qty,
    count(DISTINCT invoice_item_id) AS invoice_count
  FROM so_reportable_invoices
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
    WHEN COALESCE(i.invoiced_qty, 0::numeric) = 0::numeric THEN 'pending'::text
    WHEN COALESCE(i.invoiced_qty, 0::numeric) >= COALESCE(o.ordered_qty, 0::numeric)
         AND COALESCE(o.ordered_qty, 0::numeric) > 0::numeric THEN 'completed'::text
    ELSE 'partial'::text
  END AS invoice_status,
  CASE
    WHEN COALESCE(i.invoiced_qty, 0::numeric) > 0::numeric
         AND COALESCE(ad.approved_delivered_qty, 0::numeric) = 0::numeric THEN 'invoice_done_delivery_pending'::text
    ELSE NULL::text
  END AS special_status,
  COALESCE(ad.approved_dc_count, 0::bigint) AS approved_dc_count,
  COALESCE(i.invoice_count, 0::bigint) AS invoice_count,
  COALESCE(o.ordered_qty, 0::numeric) AS ordered_qty,
  COALESCE(ad.approved_delivered_qty, 0::numeric) AS approved_delivered_qty,
  COALESCE(i.invoiced_qty, 0::numeric) AS invoiced_qty
FROM public.sales_orders so
LEFT JOIN ordered o ON o.so_id = so.id
LEFT JOIN approved_delivery ad ON ad.so_id = so.id
LEFT JOIN invoiced i ON i.so_id = so.id;

-- ==============================================================================
-- 7. Versioned Extended Financial Summary Views (Non-breaking additive interfaces)
-- ==============================================================================

CREATE OR REPLACE VIEW public.so_delivery_invoice_financial_summary_v2 WITH (security_invoker = true) AS
WITH dc_agg AS (
  SELECT
    dc.sales_order_id,
    count(DISTINCT dc.id) AS dc_count,
    COALESCE(sum(dci.quantity), 0::numeric) AS total_delivered_qty,
    array_remove(array_agg(DISTINCT dc.challan_number), NULL::text) AS dc_numbers
  FROM public.delivery_challans dc
  JOIN public.delivery_challan_items dci ON dci.challan_id = dc.id
  WHERE dc.approval_status::text = 'approved'
  GROUP BY dc.sales_order_id
),
inv_headers AS (
  SELECT
    si.sales_order_id,
    count(DISTINCT si.id) AS invoice_count,
    COALESCE(sum(si.total_amount), 0::numeric) AS total_invoiced_amount,
    array_remove(array_agg(DISTINCT si.invoice_number), NULL::text) AS invoice_numbers
  FROM public.sales_invoices si
  WHERE si.sales_order_id IS NOT NULL
    AND public.is_reportable_sales_invoice(si.document_status, si.is_draft, si.notes)
  GROUP BY si.sales_order_id
),
inv_lines AS (
  SELECT
    si.sales_order_id,
    COALESCE(sum(sii.quantity), 0::numeric) AS total_invoiced_qty
  FROM public.sales_invoices si
  JOIN public.sales_invoice_items sii ON sii.invoice_id = si.id
  WHERE si.sales_order_id IS NOT NULL
    AND public.is_reportable_sales_invoice(si.document_status, si.is_draft, si.notes)
  GROUP BY si.sales_order_id
)
SELECT
  so.id AS so_id,
  so.so_number,
  so.customer_id,
  so.order_date,
  so.status AS so_status,
  so.total_amount AS so_total_amount,
  COALESCE(dc_agg.dc_count, 0::bigint) AS dc_count,
  COALESCE(dc_agg.total_delivered_qty, 0::numeric) AS total_delivered_qty,
  COALESCE(inv_headers.invoice_count, 0::bigint) AS invoice_count,
  COALESCE(inv_headers.total_invoiced_amount, 0::numeric) AS total_invoiced_amount,
  COALESCE(inv_lines.total_invoiced_qty, 0::numeric) AS total_invoiced_qty,
  CASE
    WHEN COALESCE(inv_headers.invoice_count, 0::bigint) = 0 THEN 'uninvoiced'::text
    WHEN COALESCE(inv_headers.total_invoiced_amount, 0::numeric) >= so.total_amount THEN 'fully_invoiced'::text
    ELSE 'partially_invoiced'::text
  END AS invoice_status,
  COALESCE(inv_headers.invoice_numbers, ARRAY[]::text[]) AS invoice_numbers,
  COALESCE(dc_agg.dc_numbers, ARRAY[]::text[]) AS dc_numbers
FROM public.sales_orders so
LEFT JOIN dc_agg ON dc_agg.sales_order_id = so.id
LEFT JOIN inv_headers ON inv_headers.sales_order_id = so.id
LEFT JOIN inv_lines ON inv_lines.sales_order_id = so.id;

GRANT SELECT ON public.dc_invoicing_summary TO authenticated, service_role;
GRANT SELECT ON public.so_delivery_invoice_status TO authenticated, service_role;
GRANT SELECT ON public.so_delivery_invoice_financial_summary_v2 TO authenticated, service_role;

COMMIT;
