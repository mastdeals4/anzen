-- Close the remaining proven SAPJ stabilization findings.
--
-- 1. SAPJ-26-028 is linked to its existing approved DC item. The invoice and
--    DC historically posted separate physical movements for the same 30 units;
--    retain the invoice movement as history but mark it superseded.
-- 2. inventory_engine_certification remains readable to authenticated users
--    and the existing inventory RPCs, but is no longer anonymously readable or
--    client-writable.

BEGIN;

DO $$
DECLARE
  v_invoice_id uuid := '9cc2582a-92f6-44e9-a3b5-61ecf9c62e4a';
  v_invoice_item_id uuid := 'a5cf9318-b7d7-4546-ac57-151932f0da71';
  v_dc_id uuid := 'd00c7b63-6e16-4951-b86f-41f78fd65e5c';
  v_dc_item_id uuid := 'ad2e4603-96e8-4ee2-b633-f9ffecacf141';
  v_invoice_movement_id uuid := '7fc5f381-a6ef-4109-9e48-41ef4364c221';
  v_invoice_before jsonb;
  v_batch_before jsonb;
  v_journals_before jsonb;
  v_allocations_before jsonb;
  v_bank_links_before bigint;
BEGIN
  SELECT to_jsonb(si) - ARRAY[
    'linked_challan_ids', 'delivery_challan_number', 'updated_at'
  ]
    INTO v_invoice_before
    FROM public.sales_invoices si
   WHERE si.id = v_invoice_id;

  SELECT to_jsonb(b)
    INTO v_batch_before
    FROM public.batches b
   WHERE b.id = (
     SELECT batch_id
       FROM public.sales_invoice_items
      WHERE id = v_invoice_item_id
   );

  SELECT COALESCE(jsonb_agg(to_jsonb(j) ORDER BY j.id), '[]'::jsonb)
    INTO v_journals_before
    FROM (
      SELECT je.*
        FROM public.journal_entries je
       WHERE je.reference_id = v_invoice_id
    ) j;

  SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.id), '[]'::jsonb)
    INTO v_allocations_before
    FROM (
      SELECT va.*
        FROM public.voucher_allocations va
       WHERE va.sales_invoice_id = v_invoice_id
    ) a;

  SELECT count(*)
    INTO v_bank_links_before
    FROM public.bank_reconciliation_items bri
    JOIN public.journal_entries je ON je.id = bri.journal_entry_id
   WHERE je.reference_id = v_invoice_id;

  IF NOT EXISTS (
    SELECT 1
      FROM public.sales_invoices si
      JOIN public.sales_invoice_items sii ON sii.invoice_id = si.id
      JOIN public.delivery_challans dc
        ON dc.id = v_dc_id
       AND dc.sales_order_id = si.sales_order_id
       AND dc.approval_status::text = 'approved'
      JOIN public.delivery_challan_items dci
        ON dci.id = v_dc_item_id
       AND dci.challan_id = dc.id
       AND dci.product_id = sii.product_id
       AND dci.batch_id IS NOT DISTINCT FROM sii.batch_id
       AND dci.quantity = sii.quantity
     WHERE si.id = v_invoice_id
       AND si.invoice_number = 'SAPJ-26-028'
       AND sii.id = v_invoice_item_id
       AND sii.delivery_challan_item_id IS NULL
       AND dc.challan_number = 'DO-26-0029'
  ) THEN
    RAISE EXCEPTION 'SAPJ-26-028 no longer matches the audited approved DC item';
  END IF;

  -- Item-level DC linkage is authoritative under Inventory V1. This update is
  -- validation-only and does not post or reverse physical stock.
  UPDATE public.sales_invoice_items
     SET delivery_challan_item_id = v_dc_item_id
   WHERE id = v_invoice_item_id;

  -- Header metadata is maintained for search, display, material returns and
  -- historical compatibility. Existing invoice financial fields are untouched.
  UPDATE public.sales_invoices
     SET linked_challan_ids = ARRAY[v_dc_id::text],
         delivery_challan_number = 'DO-26-0029'
   WHERE id = v_invoice_id;

  -- The approved DC owns the physical dispatch. Preserve the older manual
  -- invoice movement, but exclude it from canonical movement calculations.
  PERFORM set_config('app.canonical_stock_engine', 'on', true);

  UPDATE public.inventory_transactions
     SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
       'superseded', true,
       'superseded_at', clock_timestamp(),
       'superseded_reason',
         'Invoice SAPJ-26-028 linked to approved DC DO-26-0029; duplicate manual invoice movement retained for history',
       'superseded_by_migration',
         '20260812130000_close_sales_link_and_inventory_certification_access',
       'canonical_dc_id', v_dc_id,
       'canonical_dc_item_id', v_dc_item_id,
       'canonical_movement_id',
         '9892d5e5-7d4c-4baa-a274-160e780cf879'::uuid
     )
   WHERE id = v_invoice_movement_id
     AND reference_id = v_invoice_item_id
     AND quantity = -30
     AND COALESCE((metadata->>'superseded')::boolean, false) = false;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SAPJ-26-028 historical manual movement was not found in its audited state';
  END IF;

  PERFORM set_config('app.canonical_stock_engine', '', true);

  IF (SELECT to_jsonb(si) - ARRAY[
        'linked_challan_ids', 'delivery_challan_number', 'updated_at'
      ]
        FROM public.sales_invoices si
       WHERE si.id = v_invoice_id) IS DISTINCT FROM v_invoice_before THEN
    RAISE EXCEPTION 'SAPJ-26-028 financial or business fields changed unexpectedly';
  END IF;

  IF (SELECT to_jsonb(b)
        FROM public.batches b
       WHERE b.id = (
         SELECT batch_id
           FROM public.sales_invoice_items
          WHERE id = v_invoice_item_id
       )) IS DISTINCT FROM v_batch_before THEN
    RAISE EXCEPTION 'SAPJ-26-028 batch stock changed unexpectedly';
  END IF;

  IF (SELECT COALESCE(jsonb_agg(to_jsonb(j) ORDER BY j.id), '[]'::jsonb)
        FROM (
          SELECT je.*
            FROM public.journal_entries je
           WHERE je.reference_id = v_invoice_id
        ) j) IS DISTINCT FROM v_journals_before THEN
    RAISE EXCEPTION 'SAPJ-26-028 journals changed unexpectedly';
  END IF;

  IF (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.id), '[]'::jsonb)
        FROM (
          SELECT va.*
            FROM public.voucher_allocations va
           WHERE va.sales_invoice_id = v_invoice_id
        ) a) IS DISTINCT FROM v_allocations_before THEN
    RAISE EXCEPTION 'SAPJ-26-028 payment allocations changed unexpectedly';
  END IF;

  IF (SELECT count(*)
        FROM public.bank_reconciliation_items bri
        JOIN public.journal_entries je ON je.id = bri.journal_entry_id
       WHERE je.reference_id = v_invoice_id) IS DISTINCT FROM v_bank_links_before THEN
    RAISE EXCEPTION 'SAPJ-26-028 bank reconciliation links changed unexpectedly';
  END IF;
END;
$$;

ALTER TABLE public.inventory_engine_certification ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.inventory_engine_certification
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.inventory_engine_certification TO authenticated;

DROP POLICY IF EXISTS inventory_engine_certification_authenticated_read
  ON public.inventory_engine_certification;
CREATE POLICY inventory_engine_certification_authenticated_read
  ON public.inventory_engine_certification
  FOR SELECT
  TO authenticated
  USING (true);

COMMENT ON POLICY inventory_engine_certification_authenticated_read
  ON public.inventory_engine_certification IS
  'Authenticated ERP users may read the Inventory V1 enforcement boundary; only migrations/service_role may modify certification state.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.sales_invoice_items
     WHERE id = 'a5cf9318-b7d7-4546-ac57-151932f0da71'::uuid
       AND delivery_challan_item_id = 'ad2e4603-96e8-4ee2-b633-f9ffecacf141'::uuid
  ) THEN RAISE EXCEPTION 'SAPJ-26-028 item/DC link verification failed'; END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.inventory_transactions
     WHERE id = '7fc5f381-a6ef-4109-9e48-41ef4364c221'::uuid
       AND (metadata->>'superseded')::boolean
  ) THEN RAISE EXCEPTION 'SAPJ-26-028 duplicate movement was not archived'; END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.sales_invoices
     WHERE id = '9cc2582a-92f6-44e9-a3b5-61ecf9c62e4a'::uuid
       AND linked_challan_ids = ARRAY[
         'd00c7b63-6e16-4951-b86f-41f78fd65e5c'
       ]::text[]
       AND delivery_challan_number = 'DO-26-0029'
  ) THEN RAISE EXCEPTION 'SAPJ-26-028 header/DC link verification failed'; END IF;
END;
$$;

COMMIT;
