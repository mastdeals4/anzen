-- linked_challan_ids is text[] in the existing schema. Keep the UUID values
-- as their textual representation at the RPC boundary; casting the ARRAY to
-- uuid[] makes the CASE expression fail before the journal replacement runs.

CREATE OR REPLACE FUNCTION public.update_sales_invoice_atomic(
  p_invoice_id uuid,
  p_invoice_updates jsonb,
  p_new_items jsonb[]
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_old_je_id uuid;
  v_result uuid;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'accounts', 'sales', 'manager') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot update sales invoices', v_role;
  END IF;

  SELECT journal_entry_id INTO v_old_je_id
  FROM sales_invoices
  WHERE id = p_invoice_id;

  IF v_old_je_id IS NOT NULL THEN
    UPDATE sales_invoices SET journal_entry_id = NULL WHERE id = p_invoice_id;
    DELETE FROM journal_entry_lines WHERE journal_entry_id = v_old_je_id;
    DELETE FROM journal_entries WHERE id = v_old_je_id;
  END IF;

  DELETE FROM sales_invoice_items WHERE invoice_id = p_invoice_id;

  -- Suppress the posting trigger during the intermediate header update. The
  -- final trigger pass below must see the replacement invoice lines so COGS
  -- is derived from the complete invoice.
  PERFORM set_config('app.sales_invoice_rebuild', 'true', true);

  UPDATE sales_invoices
  SET
    invoice_date       = COALESCE((p_invoice_updates->>'invoice_date')::date, invoice_date),
    due_date           = COALESCE((p_invoice_updates->>'due_date')::date, due_date),
    customer_id        = COALESCE((p_invoice_updates->>'customer_id')::uuid, customer_id),
    subtotal           = COALESCE((p_invoice_updates->>'subtotal')::numeric, subtotal),
    tax_amount         = COALESCE((p_invoice_updates->>'tax_amount')::numeric, tax_amount),
    total_amount       = COALESCE((p_invoice_updates->>'total_amount')::numeric, total_amount),
    discount_amount    = COALESCE((p_invoice_updates->>'discount_amount')::numeric, discount_amount),
    stamp_duty_amount  = COALESCE((p_invoice_updates->>'stamp_duty_amount')::numeric, stamp_duty_amount),
    po_number          = COALESCE(p_invoice_updates->>'po_number', po_number),
    payment_terms_days = COALESCE((p_invoice_updates->>'payment_terms_days')::integer, payment_terms_days),
    notes              = COALESCE(p_invoice_updates->>'notes', notes),
    linked_challan_ids = CASE
      WHEN p_invoice_updates ? 'linked_challan_ids' THEN
        CASE
          WHEN p_invoice_updates->'linked_challan_ids' IS NULL
            OR p_invoice_updates->'linked_challan_ids' = 'null'::jsonb THEN NULL
          ELSE ARRAY(SELECT jsonb_array_elements_text(p_invoice_updates->'linked_challan_ids'))::text[]
        END
      ELSE linked_challan_ids
    END,
    updated_at = now()
  WHERE id = p_invoice_id
  RETURNING id INTO v_result;

  INSERT INTO sales_invoice_items (
    invoice_id, product_id, batch_id, quantity, unit_price, tax_rate, delivery_challan_item_id
  )
  SELECT
    p_invoice_id,
    (unique_items.item->>'product_id')::uuid,
    NULLIF(unique_items.item->>'batch_id', '')::uuid,
    (unique_items.item->>'quantity')::numeric,
    (unique_items.item->>'unit_price')::numeric,
    (unique_items.item->>'tax_rate')::numeric,
    NULLIF(unique_items.item->>'delivery_challan_item_id', '')::uuid
  FROM (
    SELECT DISTINCT ON (
      COALESCE(NULLIF(item->>'delivery_challan_item_id', ''), '__manual_' || ord::text)
    ) item
    FROM unnest(p_new_items) WITH ORDINALITY AS payload(item, ord)
    ORDER BY COALESCE(NULLIF(item->>'delivery_challan_item_id', ''), '__manual_' || ord::text)
  ) AS unique_items;

  PERFORM set_config('app.sales_invoice_rebuild', 'false', true);

  -- Fire the posting trigger after all replacement lines exist so COGS is
  -- calculated from the final invoice contents. The table has no status
  -- column; updated_at is the harmless write used for this trigger pass.
  UPDATE sales_invoices SET updated_at = now()
  WHERE id = p_invoice_id AND journal_entry_id IS NULL;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.update_sales_invoice_atomic(uuid, jsonb, jsonb[])
IS 'Atomically replaces invoice lines and journal while preserving delivery-challan links as text[]';

-- Compatibility adapter for the older jsonb overload. It remains callable for
-- older clients but delegates to the single active implementation, so journal
-- replacement and line de-duplication cannot diverge between overloads.
CREATE OR REPLACE FUNCTION public.update_sales_invoice_atomic(
  p_invoice_id uuid,
  p_invoice_updates jsonb,
  p_items jsonb,
  p_user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result uuid;
BEGIN
  v_result := public.update_sales_invoice_atomic(
    p_invoice_id,
    p_invoice_updates,
    ARRAY(
      SELECT value
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(p_items) = 'array' THEN p_items ELSE '[]'::jsonb END
      )
    )::jsonb[]
  );

  RETURN jsonb_build_object(
    'success', true,
    'invoice_id', p_invoice_id,
    'journal_entry_id', (SELECT journal_entry_id FROM sales_invoices WHERE id = p_invoice_id),
    'result_id', v_result,
    'user_id', p_user_id
  );
END;
$$;

COMMENT ON FUNCTION public.update_sales_invoice_atomic(uuid, jsonb, jsonb, uuid)
IS 'Backward-compatible adapter to the canonical jsonb[] Sales Invoice update implementation';

-- Trigger functions cannot be invoked as ordinary functions. The previous
-- wrapper attempted to call the renamed trigger implementation directly,
-- which raised 0A000 on the final invoice UPDATE. Keep the replacement guard
-- and execute the original posting logic in the live trigger function.
CREATE OR REPLACE FUNCTION public.post_sales_invoice_journal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing_je_id uuid;
  v_je_id uuid;
  v_je_number text;
  v_ar_account_id uuid;
  v_revenue_account_id uuid;
  v_tax_account_id uuid;
  v_bm_expense_id uuid;
  v_line_num integer := 1;
  v_total_debit numeric := 0;
  v_total_credit numeric := 0;
  v_stamp_duty numeric;
BEGIN
  IF current_setting('app.sales_invoice_rebuild', true) = 'true' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.journal_entry_id IS NULL
     AND OLD.journal_entry_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.journal_entry_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_existing_je_id
  FROM journal_entries
  WHERE source_module = 'sales_invoice' AND reference_id = NEW.id
  LIMIT 1;
  IF v_existing_je_id IS NOT NULL THEN
    NEW.journal_entry_id := v_existing_je_id;
    RETURN NEW;
  END IF;

  IF NEW.payment_status NOT IN ('pending', 'partial', 'paid') THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_ar_account_id FROM chart_of_accounts WHERE code = '1120' LIMIT 1;
  SELECT id INTO v_revenue_account_id FROM chart_of_accounts WHERE code = '4100' LIMIT 1;
  SELECT id INTO v_tax_account_id FROM chart_of_accounts WHERE code = '2130' LIMIT 1;
  SELECT id INTO v_bm_expense_id FROM chart_of_accounts WHERE code = '6950' LIMIT 1;
  IF v_ar_account_id IS NULL OR v_revenue_account_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_stamp_duty := COALESCE(NEW.stamp_duty_amount, 0);
  v_je_number := next_journal_entry_number();
  INSERT INTO journal_entries (
    entry_number, entry_date, source_module, reference_id, reference_number,
    description, total_debit, total_credit, is_posted, posted_by, created_by
  ) VALUES (
    v_je_number, NEW.invoice_date, 'sales_invoice', NEW.id, NEW.invoice_number,
    'Sales Invoice: ' || NEW.invoice_number,
    NEW.total_amount, NEW.total_amount, true, NEW.created_by, NEW.created_by
  ) RETURNING id INTO v_je_id;

  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
  VALUES (v_je_id, v_line_num, v_ar_account_id, 'A/R - ' || NEW.invoice_number, NEW.total_amount, 0, NEW.customer_id);
  v_line_num := v_line_num + 1;
  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
  VALUES (v_je_id, v_line_num, v_revenue_account_id, 'Sales - ' || NEW.invoice_number, 0, NEW.subtotal, NEW.customer_id);
  v_line_num := v_line_num + 1;
  IF COALESCE(NEW.tax_amount, 0) > 0 AND v_tax_account_id IS NOT NULL THEN
    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
    VALUES (v_je_id, v_line_num, v_tax_account_id, 'PPN - ' || NEW.invoice_number, 0, NEW.tax_amount, NEW.customer_id);
    v_line_num := v_line_num + 1;
  END IF;
  IF v_stamp_duty > 0 AND v_bm_expense_id IS NOT NULL THEN
    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
    VALUES (v_je_id, v_line_num, v_bm_expense_id, 'Bea Meterai (cost recovery) - ' || NEW.invoice_number, 0, v_stamp_duty, NEW.customer_id);
    v_line_num := v_line_num + 1;
  END IF;

  -- COGS is posted by the existing deferred post_sales_invoice_cogs()
  -- trigger. Keeping it out of this revenue journal avoids double posting.
  v_total_debit := COALESCE(NEW.total_amount, 0);
  v_total_credit := COALESCE(NEW.subtotal, 0) + COALESCE(NEW.tax_amount, 0) + v_stamp_duty;
  IF v_total_debit <> v_total_credit THEN
    RAISE EXCEPTION 'Journal not balanced: debit=% credit=%', v_total_debit, v_total_credit;
  END IF;
  NEW.journal_entry_id := v_je_id;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE LOG 'post_sales_invoice_journal failed for invoice %: %', NEW.id, SQLERRM;
  RAISE;
END;
$$;
