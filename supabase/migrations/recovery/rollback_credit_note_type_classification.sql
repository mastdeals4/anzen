-- Recovery Script: rollback_credit_note_type_classification.sql
-- Purpose: Restores the exact pre-migration state of credit notes functions, triggers, and schema
-- Captured directly from live PostgreSQL catalog (pg_proc, pg_trigger) on 2026-10-28.

-- 1. Drop the transition guard trigger and function
DROP TRIGGER IF EXISTS trg_guard_credit_note_type_transition ON public.credit_notes;
DROP FUNCTION IF EXISTS public.trg_guard_credit_note_type_transition();

-- 2. Restore exact pre-migration trg_credit_note_inventory_v1
CREATE OR REPLACE FUNCTION public.trg_credit_note_inventory_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_item record;
BEGIN
  -- Authoritative inventory ownership rule:
  -- For ANY Credit Note with material_return_id IS NOT NULL:
  -- The Material Return is the SOLE authoritative physical inventory owner (Material Return -> Inventory V1 -> stock movement).
  -- A Credit Note linked to a return produces financial effects only (AR reduction, Revenue reversal, Output PPN, COGS JE).
  -- It MUST NEVER create or reverse physical inventory movements.
  IF COALESCE(NEW.material_return_id, OLD.material_return_id) IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- ── Standalone Credit Notes (NO material_return_id) ──
  IF NEW.status = 'approved' AND OLD.status IS DISTINCT FROM 'approved' THEN
    IF EXISTS (
      SELECT 1
      FROM public.inventory_transactions
      WHERE reference_type = 'credit_note_reversal'
        AND reference_id = NEW.id
        AND metadata->>'canonical_engine_version' = '1.0'
    ) THEN
      RAISE EXCEPTION 'Reversed Credit Note cannot be re-approved; create a new Credit Note';
    END IF;

    FOR v_item IN
      SELECT *
      FROM public.credit_note_items
      WHERE credit_note_id = NEW.id
      ORDER BY id
    LOOP
      PERFORM public.post_inventory_movement(
        public.uuid_from_text('inventory-v1:credit-note:' || NEW.id || ':' || v_item.id),
        v_item.product_id,
        v_item.batch_id,
        'return',
        v_item.quantity,
        NEW.credit_note_date,
        NEW.credit_note_number,
        'credit_note',
        NEW.id,
        'Canonical Credit Note return: ' || NEW.credit_note_number,
        NEW.approved_by,
        NULL,
        NULL
      );
    END LOOP;

  ELSIF OLD.status = 'approved' AND NEW.status IS DISTINCT FROM 'approved' THEN
    FOR v_item IN
      SELECT *
      FROM public.credit_note_items
      WHERE credit_note_id = NEW.id
      ORDER BY id
    LOOP
      PERFORM public.post_inventory_movement(
        public.uuid_from_text(
          'inventory-v1:credit-note-reversal:' || NEW.id || ':' || v_item.id
        ),
        v_item.product_id,
        v_item.batch_id,
        'adjustment',
        -v_item.quantity,
        CURRENT_DATE,
        NEW.credit_note_number,
        'credit_note_reversal',
        NEW.id,
        'Canonical Credit Note reversal: ' || NEW.credit_note_number,
        COALESCE(NEW.approved_by, auth.uid()),
        NULL,
        NULL
      );
    END LOOP;
  END IF;

  RETURN NEW;
END;
$function$;

-- 3. Restore exact pre-migration _post_credit_note_je
CREATE OR REPLACE FUNCTION public._post_credit_note_je(p_cn credit_notes)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_je_id         uuid;
  v_je_cogs_id    uuid;
  v_je_number     text;
  v_ar_id         uuid;
  v_return_id     uuid;
  v_ppn_id        uuid;
  v_cogs_id       uuid;
  v_inv_id        uuid;
  v_total_cogs    numeric(18,2) := 0;
  v_item          record;
  v_actor         uuid := COALESCE(p_cn.approved_by, p_cn.created_by);
  v_unit_cogs     numeric(18,4);
  v_orig_inv_id   uuid;
BEGIN
  SELECT id INTO v_ar_id     FROM chart_of_accounts WHERE code = '1120';
  SELECT id INTO v_return_id FROM chart_of_accounts WHERE code = '4300';
  SELECT id INTO v_ppn_id    FROM chart_of_accounts WHERE code = '2130';
  SELECT id INTO v_cogs_id   FROM chart_of_accounts WHERE code = '5100';
  SELECT id INTO v_inv_id    FROM chart_of_accounts WHERE code = '1130';

  IF v_ar_id IS NULL OR v_return_id IS NULL THEN
    RAISE EXCEPTION 'Credit Note JE: missing required accounts (1120 A/R or 4300 Sales Returns) in Chart of Accounts';
  END IF;

  -- ── Revenue-reversal JE ──
  v_je_number := public.next_journal_entry_number();

  INSERT INTO journal_entries
    (entry_number, entry_date, source_module, reference_id, reference_number,
     description, total_debit, total_credit, is_posted, posted_by, created_by)
  VALUES
    (v_je_number, p_cn.credit_note_date, 'credit_note', p_cn.id, p_cn.credit_note_number,
     'Credit Note reversal — ' || p_cn.credit_note_number,
     p_cn.total_amount, p_cn.total_amount, true, v_actor, v_actor)
  RETURNING id INTO v_je_id;

  -- Dr Sales Return (subtotal — contra revenue)
  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
  VALUES (v_je_id, 1, v_return_id,
          'Sales Return - ' || p_cn.credit_note_number,
          p_cn.subtotal, 0, p_cn.customer_id);

  -- Dr Output PPN (reduces tax liability)
  IF COALESCE(p_cn.tax_amount, 0) > 0 AND v_ppn_id IS NOT NULL THEN
    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
    VALUES (v_je_id, 2, v_ppn_id,
            'Output PPN reversal - ' || p_cn.credit_note_number,
            p_cn.tax_amount, 0, p_cn.customer_id);
  END IF;

  -- Cr A/R (reduces customer receivable)
  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
  VALUES (v_je_id, 3, v_ar_id,
          'A/R reversal - ' || p_cn.credit_note_number,
          0, p_cn.total_amount, p_cn.customer_id);

  -- ── COGS-reversal JE (Dr Inventory, Cr COGS) ──
  -- Uses ORIGINAL SALE transaction FIFO cost layer from sales_invoice_items
  IF v_cogs_id IS NOT NULL AND v_inv_id IS NOT NULL THEN
    -- Resolve original invoice ID: directly on CN, or indirectly via Material Return
    v_orig_inv_id := p_cn.original_invoice_id;
    IF v_orig_inv_id IS NULL AND p_cn.material_return_id IS NOT NULL THEN
      SELECT mr.original_invoice_id INTO v_orig_inv_id
        FROM public.material_returns mr
       WHERE mr.id = p_cn.material_return_id;

      IF v_orig_inv_id IS NULL THEN
        SELECT si.id INTO v_orig_inv_id
          FROM public.material_returns mr
          JOIN public.sales_invoices si ON mr.original_dc_id::text = ANY(si.linked_challan_ids)
         WHERE mr.id = p_cn.material_return_id
         LIMIT 1;
      END IF;
    END IF;

    FOR v_item IN
      SELECT cni.quantity, cni.batch_id, cni.product_id
        FROM credit_note_items cni
       WHERE cni.credit_note_id = p_cn.id
    LOOP
      v_unit_cogs := NULL;

      -- 1. Exact historical FIFO cost from original sales invoice line
      IF v_orig_inv_id IS NOT NULL THEN
        SELECT COALESCE(sii.cogs_unit_cost, CASE WHEN sii.quantity > 0 THEN ROUND(sii.cogs_total_cost / sii.quantity, 4) ELSE NULL END)
          INTO v_unit_cogs
          FROM public.sales_invoice_items sii
         WHERE sii.invoice_id = v_orig_inv_id
           AND (
             (v_item.batch_id IS NOT NULL AND sii.batch_id = v_item.batch_id)
             OR (v_item.batch_id IS NULL AND sii.product_id = v_item.product_id)
           )
           AND ((sii.cogs_unit_cost IS NOT NULL AND sii.cogs_unit_cost > 0) OR (sii.cogs_total_cost IS NOT NULL AND sii.cogs_total_cost > 0))
         ORDER BY sii.created_at
         LIMIT 1;
      END IF;

      -- 1b. If no invoice cost found, check delivery challan / inventory transaction for original FIFO cost
      IF (v_unit_cogs IS NULL OR v_unit_cogs <= 0) AND p_cn.material_return_id IS NOT NULL THEN
        SELECT it.unit_cost INTO v_unit_cogs
          FROM public.material_returns mr
          JOIN public.inventory_transactions it ON it.source_id = mr.original_dc_id
         WHERE mr.id = p_cn.material_return_id
           AND (
             (v_item.batch_id IS NOT NULL AND it.batch_id = v_item.batch_id)
             OR (v_item.batch_id IS NULL AND it.product_id = v_item.product_id)
           )
           AND it.unit_cost IS NOT NULL AND it.unit_cost > 0
         ORDER BY it.created_at
         LIMIT 1;
      END IF;

      -- 2. Fallback only if historical transaction cost not found
      IF v_unit_cogs IS NULL OR v_unit_cogs <= 0 THEN
        SELECT COALESCE(b.landed_cost_per_unit, b.cost_per_unit, 0) INTO v_unit_cogs
          FROM public.batches b
         WHERE b.id = v_item.batch_id;
      END IF;

      v_total_cogs := v_total_cogs + ROUND(v_item.quantity * COALESCE(v_unit_cogs, 0), 2);
    END LOOP;

    IF v_total_cogs > 0 THEN
      v_je_number := public.next_journal_entry_number();
      INSERT INTO journal_entries
        (entry_number, entry_date, source_module, reference_id, reference_number,
         description, total_debit, total_credit, is_posted, posted_by, created_by)
      VALUES
        (v_je_number, p_cn.credit_note_date, 'credit_note_cogs', p_cn.id, p_cn.credit_note_number,
         'Historical FIFO COGS reversal for Credit Note ' || p_cn.credit_note_number,
         v_total_cogs, v_total_cogs, true, v_actor, v_actor)
      RETURNING id INTO v_je_cogs_id;

      INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit)
      VALUES (v_je_cogs_id, 1, v_inv_id,
              'Inventory restock - ' || p_cn.credit_note_number,
              v_total_cogs, 0);

      INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
      VALUES (v_je_cogs_id, 2, v_cogs_id,
              'COGS reversal - ' || p_cn.credit_note_number,
              0, v_total_cogs, p_cn.customer_id);
    END IF;
  END IF;

  RETURN v_je_id;
END;
$function$;

-- 4. Re-ensure trigger exists in exact original form
DROP TRIGGER IF EXISTS trigger_credit_note_inventory_v1 ON public.credit_notes;
CREATE TRIGGER trigger_credit_note_inventory_v1 
  AFTER UPDATE OF status ON public.credit_notes 
  FOR EACH ROW EXECUTE FUNCTION trg_credit_note_inventory_v1();

-- 5. Drop credit_note_type column (if added)
ALTER TABLE public.credit_notes DROP COLUMN IF EXISTS credit_note_type;
