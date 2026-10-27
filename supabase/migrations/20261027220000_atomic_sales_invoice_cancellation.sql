-- ==============================================================================
-- Atomic Sales Invoice Cancellation and GL Reversal Architecture
-- ==============================================================================
-- Ensures that when a sales invoice is cancelled:
-- 1. General Ledger postings (commercial revenue, AR, tax, and COGS) are reversed
--    using the established is_reversed = true double-entry pattern.
-- 2. reversed_by_id is kept NULL (foreign key points to journal_entries.id).
-- 3. The Delivery Challan and its physical inventory deduction remain intact
--    (single-owner invariant: DC owns physical stock movements).
-- 4. Delivery Challan items are released so the DC is unbilled for re-invoicing.
-- 5. Cancellation is idempotent and protected against partial failure.
-- ==============================================================================

-- 1. Update trg_sales_invoice_item_inventory to support invoice cancellation unlinking
CREATE OR REPLACE FUNCTION public.trg_sales_invoice_item_inventory()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_dc_item public.delivery_challan_items%ROWTYPE;
  v_dc_status text;
  v_invoiced_quantity numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  -- Allow unlinking delivery_challan_item_id during controlled invoice cancellation
  IF current_setting('app.sales_invoice_cancel', true) = 'true' THEN
    RETURN NEW;
  END IF;

  IF NEW.delivery_challan_item_id IS NULL THEN
    -- If invoice has been cancelled or is being cancelled, allow null link
    IF EXISTS (
      SELECT 1 FROM public.sales_invoices si
      WHERE si.id = NEW.invoice_id
        AND (si.notes LIKE '[CANCELLED%' OR LOWER(si.notes) LIKE 'cancelled%')
    ) THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'Sales Invoice item must reference an approved Delivery Challan item';
  END IF;

  SELECT dci.*
  INTO v_dc_item
  FROM public.delivery_challan_items dci
  WHERE dci.id = NEW.delivery_challan_item_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales Invoice item references a missing Delivery Challan item';
  END IF;

  SELECT dc.approval_status::text
  INTO v_dc_status
  FROM public.delivery_challans dc
  WHERE dc.id = v_dc_item.challan_id;

  IF NOT FOUND OR v_dc_status <> 'approved' THEN
    RAISE EXCEPTION 'Sales Invoice item references a non-approved Delivery Challan item';
  END IF;

  IF NEW.product_id IS DISTINCT FROM v_dc_item.product_id
     OR NEW.batch_id IS DISTINCT FROM v_dc_item.batch_id THEN
    RAISE EXCEPTION 'Sales Invoice product/batch must match its Delivery Challan item';
  END IF;

  SELECT COALESCE(SUM(sii.quantity), 0)
  INTO v_invoiced_quantity
  FROM public.sales_invoice_items sii
  JOIN public.sales_invoices si ON si.id = sii.invoice_id
  WHERE sii.delivery_challan_item_id = NEW.delivery_challan_item_id
    AND sii.id IS DISTINCT FROM NEW.id
    AND NOT (si.notes LIKE '[CANCELLED%' OR LOWER(si.notes) LIKE 'cancelled%');

  IF v_invoiced_quantity + NEW.quantity > v_dc_item.quantity THEN
    RAISE EXCEPTION 'Sales Invoice quantity exceeds approved Delivery Challan quantity';
  END IF;

  RETURN NEW;
END;
$$;

-- 2. Update dc_invoicing_summary to exclude cancelled invoices
CREATE OR REPLACE VIEW public.dc_invoicing_summary WITH (security_invoker = true) AS
 SELECT dc.id AS challan_id,
    dc.challan_number,
    dc.customer_id,
    dc.challan_date,
    dc.approval_status,
    count(DISTINCT dci.id) AS total_items,
    count(DISTINCT
        CASE
            WHEN sii.id IS NULL THEN dci.id
            ELSE NULL::uuid
        END) AS not_invoiced_items,
    count(DISTINCT
        CASE
            WHEN sii.id IS NOT NULL THEN dci.id
            ELSE NULL::uuid
        END) AS invoiced_items,
    COALESCE(sum(dci.quantity), 0::numeric) AS total_quantity,
    COALESCE(sum(
        CASE
            WHEN sii.id IS NULL THEN dci.quantity
            ELSE 0::numeric
        END), 0::numeric) AS total_remaining_quantity,
    CASE
        WHEN count(DISTINCT sii.id) = 0 THEN 'not_invoiced'::text
        WHEN count(DISTINCT sii.id) < count(DISTINCT dci.id) THEN 'partially_invoiced'::text
        ELSE 'fully_invoiced'::text
    END AS dc_status,
    COALESCE(array_agg(DISTINCT si.invoice_number) FILTER (WHERE si.invoice_number IS NOT NULL), ARRAY[]::text[]) AS linked_invoices
   FROM public.delivery_challans dc
     LEFT JOIN public.delivery_challan_items dci ON dc.id = dci.challan_id
     LEFT JOIN (
       public.sales_invoice_items sii
       JOIN public.sales_invoices si ON si.id = sii.invoice_id
         AND NOT (si.notes LIKE '[CANCELLED%' OR LOWER(si.notes) LIKE 'cancelled%')
     ) ON sii.delivery_challan_item_id = dci.id
  WHERE dc.approval_status = 'approved'::public.dc_approval_status
  GROUP BY dc.id, dc.challan_number, dc.customer_id, dc.challan_date, dc.approval_status;

COMMENT ON VIEW public.dc_invoicing_summary IS 'Summary of delivery challans with invoicing status and remaining quantities for approved DCs only, excluding cancelled invoices';

-- 3. Transactional cancellation RPC
CREATE OR REPLACE FUNCTION public.cancel_sales_invoice(
  p_invoice_id uuid,
  p_reason text DEFAULT NULL,
  p_actor uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_caller uuid := COALESCE(auth.uid(), p_actor);
  v_role text;
  v_inv record;
  v_alloc_paid numeric := 0;
  v_adj_paid numeric := 0;
  v_reason text;
  v_rev_count int := 0;
  v_cogs_count int := 0;
  v_updated_notes text;
  v_je record;
  v_period_id uuid;
  v_rev_entry text;
  v_reversal_id uuid;
BEGIN
  -- Permission check: only admin and accounts can cancel financially posted invoices
  IF v_caller IS NOT NULL THEN
    SELECT role INTO v_role FROM public.user_profiles WHERE id = v_caller;
    IF v_role NOT IN ('admin', 'accounts') THEN
      RAISE EXCEPTION 'Permission denied: role % cannot cancel sales invoices', v_role;
    END IF;
  END IF;

  -- Lock invoice row
  SELECT * INTO v_inv
  FROM public.sales_invoices
  WHERE id = p_invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales invoice % not found', p_invoice_id;
  END IF;

  -- Payment guard: check allocated receipts and adjustments
  SELECT COALESCE(SUM(allocated_amount), 0) INTO v_alloc_paid
  FROM public.voucher_allocations
  WHERE sales_invoice_id = p_invoice_id AND voucher_type = 'receipt';

  SELECT COALESCE(SUM(adjustment_amount), 0) INTO v_adj_paid
  FROM public.invoice_rounding_adjustments
  WHERE sales_invoice_id = p_invoice_id;

  IF (COALESCE(v_inv.paid_amount, 0) > 0.01 OR v_alloc_paid > 0.01 OR v_adj_paid > 0.01) THEN
    RAISE EXCEPTION 'Cannot cancel invoice %: payments of Rp % are allocated. Unallocate payments first.',
      v_inv.invoice_number, (COALESCE(v_inv.paid_amount, 0) + v_alloc_paid + v_adj_paid);
  END IF;

  v_reason := COALESCE(p_reason, '[CANCELLED on ' || CURRENT_DATE::text || ' by ' || COALESCE(v_role, 'Admin') || ']');

  -- 1. Reverse Revenue Journal Entries (Commercial AR, Sales, VAT Output, Stamp Duty)
  FOR v_je IN
    SELECT *
    FROM public.journal_entries
    WHERE is_posted = true
      AND COALESCE(is_reversed, false) = false
      AND (
        id = v_inv.journal_entry_id
        OR (reference_id = p_invoice_id AND source_module IN ('sales_invoice', 'sales', 'sales_invoices'))
        OR (reference_number = v_inv.invoice_number AND source_module IN ('sales_invoice', 'sales', 'sales_invoices'))
      )
    FOR UPDATE
  LOOP
    SELECT id INTO v_period_id
    FROM public.accounting_periods
    WHERE CURRENT_DATE BETWEEN start_date AND end_date
      AND status = 'open'
    LIMIT 1;
    IF v_period_id IS NULL THEN v_period_id := v_je.period_id; END IF;

    v_rev_entry := public.next_journal_entry_number();

    INSERT INTO public.journal_entries (
      entry_number, entry_date, period_id, source_module, reference_id,
      reference_number, description, total_debit, total_credit,
      is_posted, is_reversed, posted_by, posted_at, created_by, created_at,
      transaction_category, transaction_currency, functional_currency, exchange_rate, amounts_are_functional
    ) VALUES (
      v_rev_entry, CURRENT_DATE, v_period_id, v_je.source_module || '_cancellation', p_invoice_id,
      'CANCEL-' || v_inv.invoice_number,
      'Cancellation reversal of ' || v_je.entry_number || ': ' || v_reason,
      v_je.total_credit, v_je.total_debit,
      true, true, v_caller, now(), v_caller, now(),
      v_je.transaction_category, v_je.transaction_currency, v_je.functional_currency, v_je.exchange_rate, v_je.amounts_are_functional
    ) RETURNING id INTO v_reversal_id;

    INSERT INTO public.journal_entry_lines (
      journal_entry_id, line_number, account_id, description, debit, credit,
      tax_code_id, customer_id, supplier_id, batch_id, transaction_currency,
      transaction_debit, transaction_credit, functional_currency, exchange_rate, sales_invoice_item_id
    )
    SELECT
      v_reversal_id, line_number, account_id, 'CANCEL: ' || COALESCE(description, ''),
      credit, debit, tax_code_id, customer_id, supplier_id, batch_id, transaction_currency,
      transaction_credit, transaction_debit, functional_currency, exchange_rate, sales_invoice_item_id
    FROM public.journal_entry_lines
    WHERE journal_entry_id = v_je.id
    ORDER BY line_number;

    UPDATE public.journal_entries
    SET is_reversed = true,
        reversed_by_id = v_reversal_id,
        description = v_reason || ' ' || COALESCE(description, '')
    WHERE id = v_je.id;

    v_rev_count := v_rev_count + 1;
  END LOOP;

  -- 2. Reverse COGS Journal Entries (COGS Dr 5100, Inventory Cr 1130)
  FOR v_je IN
    SELECT *
    FROM public.journal_entries
    WHERE is_posted = true
      AND COALESCE(is_reversed, false) = false
      AND source_module = 'sales_invoice_cogs'
      AND (reference_id = p_invoice_id OR reference_number = v_inv.invoice_number)
    FOR UPDATE
  LOOP
    SELECT id INTO v_period_id
    FROM public.accounting_periods
    WHERE CURRENT_DATE BETWEEN start_date AND end_date
      AND status = 'open'
    LIMIT 1;
    IF v_period_id IS NULL THEN v_period_id := v_je.period_id; END IF;

    v_rev_entry := public.next_journal_entry_number();

    INSERT INTO public.journal_entries (
      entry_number, entry_date, period_id, source_module, reference_id,
      reference_number, description, total_debit, total_credit,
      is_posted, is_reversed, posted_by, posted_at, created_by, created_at,
      transaction_category, transaction_currency, functional_currency, exchange_rate, amounts_are_functional
    ) VALUES (
      v_rev_entry, CURRENT_DATE, v_period_id, 'sales_invoice_cogs_cancellation', p_invoice_id,
      'CANCEL-' || v_inv.invoice_number || '-COGS',
      'Cancellation reversal of COGS ' || v_je.entry_number || ': ' || v_reason,
      v_je.total_credit, v_je.total_debit,
      true, true, v_caller, now(), v_caller, now(),
      v_je.transaction_category, v_je.transaction_currency, v_je.functional_currency, v_je.exchange_rate, v_je.amounts_are_functional
    ) RETURNING id INTO v_reversal_id;

    INSERT INTO public.journal_entry_lines (
      journal_entry_id, line_number, account_id, description, debit, credit,
      tax_code_id, customer_id, supplier_id, batch_id, transaction_currency,
      transaction_debit, transaction_credit, functional_currency, exchange_rate, sales_invoice_item_id
    )
    SELECT
      v_reversal_id, line_number, account_id, 'CANCEL: ' || COALESCE(description, ''),
      credit, debit, tax_code_id, customer_id, supplier_id, batch_id, transaction_currency,
      transaction_credit, transaction_debit, functional_currency, exchange_rate, sales_invoice_item_id
    FROM public.journal_entry_lines
    WHERE journal_entry_id = v_je.id
    ORDER BY line_number;

    UPDATE public.journal_entries
    SET is_reversed = true,
        reversed_by_id = v_reversal_id,
        description = v_reason || ' ' || COALESCE(description, '') || ' COGS'
    WHERE id = v_je.id;

    v_cogs_count := v_cogs_count + 1;
  END LOOP;

  -- 3. Release Delivery Challan link while preserving invoice line items for viewing
  PERFORM set_config('app.sales_invoice_cancel', 'true', true);
  UPDATE public.sales_invoice_items
  SET delivery_challan_item_id = NULL
  WHERE invoice_id = p_invoice_id;
  PERFORM set_config('app.sales_invoice_cancel', 'false', true);

  -- 4. Update sales invoice header
  v_updated_notes := CASE
    WHEN v_inv.notes IS NULL OR v_inv.notes = '' THEN v_reason
    WHEN v_inv.notes LIKE '[CANCELLED%' THEN v_inv.notes
    ELSE v_reason || E'\n' || v_inv.notes
  END;

  UPDATE public.sales_invoices
  SET notes = v_updated_notes,
      balance_amount = 0,
      updated_at = now()
  WHERE id = p_invoice_id;

  -- 5. Cancel Faktur Pajak if exists
  UPDATE public.faktur_pajak
  SET status = 'cancelled',
      notes = v_reason || ' Sales Invoice cancelled',
      updated_at = now()
  WHERE sales_invoice_id = p_invoice_id
    AND status <> 'cancelled';

  -- 6. Record audit log
  INSERT INTO public.audit_logs (table_name, record_id, action_type, user_id, new_values)
  VALUES (
    'sales_invoices',
    p_invoice_id,
    'update',
    v_caller,
    jsonb_build_object(
      '_action', 'INVOICE_CANCELLED',
      'invoice_number', v_inv.invoice_number,
      'reason', v_reason,
      'revenue_journals_reversed', v_rev_count,
      'cogs_journals_reversed', v_cogs_count
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'invoice_number', v_inv.invoice_number,
    'revenue_journals_reversed', v_rev_count,
    'cogs_journals_reversed', v_cogs_count
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.cancel_sales_invoice(uuid, text, uuid) TO authenticated;

