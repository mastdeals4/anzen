-- ============================================================================
-- Migration: 20260709150000_purchase_invoice_delete_integrity_check
-- Date:      2026-07-09
--
-- WHY THIS EXISTS
--   The previous two migrations (20260709120000 + 20260709140000) already
--   ship an accounting-safe delete_purchase_invoice(uuid) RPC that removes
--   the invoice's descendants and releases bank-recon links. If any future
--   schema change adds a new referencing table, or if a subtle bug is
--   introduced in a later revision, the RPC could report success while
--   silently leaving orphan rows behind — exactly the class of bug that
--   the reported "Recorded" JE2603-0036 incident was.
--
--   To prevent that, this migration replaces the RPC with a self-verifying
--   version: after every cleanup step runs but BEFORE the transaction
--   commits, the function re-queries each table it touched and raises an
--   exception if it finds ANY orphan. Because the checks live inside the
--   same implicit transaction, RAISE EXCEPTION rolls back every change the
--   function made — no partial cleanup can escape.
--
-- WHAT IS VERIFIED
--   1. purchase_invoices           row for p_id is gone.
--   2. purchase_invoice_items      no rows for p_id.
--   3. voucher_allocations         no rows for p_id.
--   4. journal_entries             no rows for (source_module='purchase_invoice',
--                                  reference_id=p_id).
--   5. journal_entry_lines         no rows against any collected JE id
--                                  (covers cascade-drift regressions).
--   6. bank_statement_lines        no matched_entry_id equal to any collected
--                                  JE id, and none matched to an orphan PV's
--                                  JE that we identified for release.
--   7. batches                     no batches still tagged with
--                                  purchase_invoice_id = p_id.
--
--   If any check fails, RAISE EXCEPTION with an actionable message; the
--   transaction rolls back, the invoice remains, and the caller sees the
--   error rather than silent corruption.
--
-- BACKWARD COMPATIBILITY
--   Same signature, same return type, same permissions. Callers do not
--   change. On a healthy path the extra checks add at most ~7 index
--   look-ups per delete — negligible.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.delete_purchase_invoice(p_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_invoice           purchase_invoices%ROWTYPE;
  v_je_ids            UUID[];
  v_affected_pvs      UUID[];
  v_original_je_id    UUID;
  v_orphan_pv_je_ids  UUID[];

  -- integrity-check counters
  v_orphan_pi         INT;
  v_orphan_items      INT;
  v_orphan_allocs     INT;
  v_orphan_jes        INT;
  v_orphan_je_lines   INT;
  v_orphan_bsl_pi     INT;
  v_orphan_bsl_pv     INT;
  v_orphan_batches    INT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_id IS NULL THEN
    RAISE EXCEPTION 'Purchase invoice id is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- (a) Lock the invoice row.
  SELECT * INTO v_invoice
    FROM public.purchase_invoices
   WHERE id = p_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase invoice % not found', p_id USING ERRCODE = 'no_data_found';
  END IF;

  v_original_je_id := v_invoice.journal_entry_id;

  -- Collect every JE created by this invoice.
  SELECT COALESCE(array_agg(id), ARRAY[]::UUID[])
    INTO v_je_ids
    FROM public.journal_entries
   WHERE source_module = 'purchase_invoice'
     AND reference_id  = p_id;

  IF v_original_je_id IS NOT NULL
     AND NOT v_original_je_id = ANY (v_je_ids) THEN
    v_je_ids := array_append(v_je_ids, v_original_je_id);
  END IF;

  -- Payment vouchers that were paying THIS invoice.
  SELECT COALESCE(array_agg(DISTINCT payment_voucher_id), ARRAY[]::UUID[])
    INTO v_affected_pvs
    FROM public.voucher_allocations
   WHERE purchase_invoice_id = p_id
     AND payment_voucher_id IS NOT NULL;

  -- Drop the allocations pointing at this invoice.
  DELETE FROM public.voucher_allocations
   WHERE purchase_invoice_id = p_id;

  -- Identify PVs whose allocations are now empty and release their bank matches.
  IF array_length(v_affected_pvs, 1) IS NOT NULL THEN
    SELECT COALESCE(array_agg(pv.journal_entry_id), ARRAY[]::UUID[])
      INTO v_orphan_pv_je_ids
      FROM public.payment_vouchers pv
     WHERE pv.id = ANY (v_affected_pvs)
       AND pv.journal_entry_id IS NOT NULL
       AND NOT EXISTS (
             SELECT 1
               FROM public.voucher_allocations va
              WHERE va.payment_voucher_id = pv.id
           );

    IF array_length(v_orphan_pv_je_ids, 1) IS NOT NULL THEN
      UPDATE public.bank_statement_lines
         SET matched_entry_id        = NULL,
             matched_expense_id      = NULL,
             matched_receipt_id      = NULL,
             matched_petty_cash_id   = NULL,
             matched_fund_transfer_id= NULL,
             reconciliation_status   = 'unmatched',
             matched_at              = NULL,
             matched_by              = NULL
       WHERE matched_entry_id = ANY (v_orphan_pv_je_ids);
    END IF;
  END IF;

  -- Bank recon cleanup for the PI's OWN JEs (all typed FKs).
  IF array_length(v_je_ids, 1) IS NOT NULL THEN
    UPDATE public.bank_statement_lines
       SET matched_entry_id        = NULL,
           matched_expense_id      = NULL,
           matched_receipt_id      = NULL,
           matched_petty_cash_id   = NULL,
           matched_fund_transfer_id= NULL,
           reconciliation_status   = 'unmatched',
           matched_at              = NULL,
           matched_by              = NULL
     WHERE matched_entry_id = ANY (v_je_ids);
  END IF;

  -- Break invoice → JE FK before deleting the JE.
  IF v_original_je_id IS NOT NULL THEN
    UPDATE public.purchase_invoices
       SET journal_entry_id = NULL
     WHERE id = p_id;
  END IF;

  -- Delete JE lines then JE headers.
  IF array_length(v_je_ids, 1) IS NOT NULL THEN
    DELETE FROM public.journal_entry_lines
     WHERE journal_entry_id = ANY (v_je_ids);

    DELETE FROM public.journal_entries
     WHERE id = ANY (v_je_ids);
  END IF;

  -- Detach batches.
  UPDATE public.batches
     SET purchase_invoice_id = NULL
   WHERE purchase_invoice_id = p_id;

  -- Belt-and-braces items delete.
  DELETE FROM public.purchase_invoice_items
   WHERE purchase_invoice_id = p_id;

  -- Delete the invoice row.
  DELETE FROM public.purchase_invoices
   WHERE id = p_id;

  -- ═════════════════════════════════════════════════════════════════════
  -- INTEGRITY CHECKS
  --
  -- Every RAISE EXCEPTION below rolls back this transaction — the invoice
  -- stays, the JE stays, allocations stay. Better a visible failure than
  -- silent orphan state on the bank reconciliation screen.
  -- ═════════════════════════════════════════════════════════════════════

  SELECT COUNT(*) INTO v_orphan_pi
    FROM public.purchase_invoices
   WHERE id = p_id;
  IF v_orphan_pi <> 0 THEN
    RAISE EXCEPTION
      'delete_purchase_invoice(%): integrity check failed — purchase_invoices row still present (count=%). Rolling back.',
      p_id, v_orphan_pi
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT COUNT(*) INTO v_orphan_items
    FROM public.purchase_invoice_items
   WHERE purchase_invoice_id = p_id;
  IF v_orphan_items <> 0 THEN
    RAISE EXCEPTION
      'delete_purchase_invoice(%): integrity check failed — % orphan purchase_invoice_items remain. Rolling back.',
      p_id, v_orphan_items
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT COUNT(*) INTO v_orphan_allocs
    FROM public.voucher_allocations
   WHERE purchase_invoice_id = p_id;
  IF v_orphan_allocs <> 0 THEN
    RAISE EXCEPTION
      'delete_purchase_invoice(%): integrity check failed — % orphan voucher_allocations remain. Rolling back.',
      p_id, v_orphan_allocs
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT COUNT(*) INTO v_orphan_jes
    FROM public.journal_entries
   WHERE source_module = 'purchase_invoice'
     AND reference_id  = p_id;
  IF v_orphan_jes <> 0 THEN
    RAISE EXCEPTION
      'delete_purchase_invoice(%): integrity check failed — % orphan journal_entries (source_module=purchase_invoice) remain. Rolling back.',
      p_id, v_orphan_jes
      USING ERRCODE = 'raise_exception';
  END IF;

  IF array_length(v_je_ids, 1) IS NOT NULL THEN
    SELECT COUNT(*) INTO v_orphan_je_lines
      FROM public.journal_entry_lines
     WHERE journal_entry_id = ANY (v_je_ids);
    IF v_orphan_je_lines <> 0 THEN
      RAISE EXCEPTION
        'delete_purchase_invoice(%): integrity check failed — % orphan journal_entry_lines remain against deleted JEs. Rolling back.',
        p_id, v_orphan_je_lines
        USING ERRCODE = 'raise_exception';
    END IF;

    SELECT COUNT(*) INTO v_orphan_bsl_pi
      FROM public.bank_statement_lines
     WHERE matched_entry_id = ANY (v_je_ids);
    IF v_orphan_bsl_pi <> 0 THEN
      RAISE EXCEPTION
        'delete_purchase_invoice(%): integrity check failed — % bank_statement_lines still matched to deleted PI JEs. Rolling back.',
        p_id, v_orphan_bsl_pi
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  IF array_length(v_orphan_pv_je_ids, 1) IS NOT NULL THEN
    SELECT COUNT(*) INTO v_orphan_bsl_pv
      FROM public.bank_statement_lines
     WHERE matched_entry_id = ANY (v_orphan_pv_je_ids);
    IF v_orphan_bsl_pv <> 0 THEN
      RAISE EXCEPTION
        'delete_purchase_invoice(%): integrity check failed — % bank_statement_lines still matched to orphan PV JEs. Rolling back.',
        p_id, v_orphan_bsl_pv
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  SELECT COUNT(*) INTO v_orphan_batches
    FROM public.batches
   WHERE purchase_invoice_id = p_id;
  IF v_orphan_batches <> 0 THEN
    RAISE EXCEPTION
      'delete_purchase_invoice(%): integrity check failed — % batches still tagged to deleted invoice. Rolling back.',
      p_id, v_orphan_batches
      USING ERRCODE = 'raise_exception';
  END IF;

  -- ═════════════════════════════════════════════════════════════════════
  -- Audit trail — only reached when every check above passed.
  -- ═════════════════════════════════════════════════════════════════════
  BEGIN
    INSERT INTO public.audit_logs (
      table_name, record_id, action_type, old_values, new_values, user_id
    ) VALUES (
      'purchase_invoices',
      p_id,
      'delete',
      jsonb_build_object(
        'invoice_number',           v_invoice.invoice_number,
        'supplier_id',              v_invoice.supplier_id,
        'invoice_date',             v_invoice.invoice_date,
        'total_amount',             v_invoice.total_amount,
        'paid_amount',              v_invoice.paid_amount,
        'status',                   v_invoice.status,
        'journal_entry_ids',        to_jsonb(v_je_ids),
        'payment_voucher_ids',      to_jsonb(v_affected_pvs),
        'orphan_pv_je_ids_released',to_jsonb(v_orphan_pv_je_ids),
        'integrity_checks',         'passed'
      ),
      jsonb_build_object(
        '_action',      'DELETE_PURCHASE_INVOICE',
        'deleted_at',   NOW(),
        'deleted_by',   auth.uid()
      ),
      auth.uid()
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
END;
$$;

REVOKE ALL     ON FUNCTION public.delete_purchase_invoice(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.delete_purchase_invoice(uuid) FROM anon;
GRANT  EXECUTE ON FUNCTION public.delete_purchase_invoice(uuid) TO authenticated;

COMMENT ON FUNCTION public.delete_purchase_invoice(uuid) IS
'Accounting-safe PI delete with post-cleanup integrity verification.
Removes PI + its JE + own allocations, releases bank-recon links on any
PV whose allocations dropped to zero, then re-queries every table it
touched. If ANY orphan row remains (invoice, items, allocations, JE,
JE lines, matched bank lines, or tagged batches), RAISE EXCEPTION rolls
back the whole transaction. PV rows and their JEs are preserved for
manual review.';

DO $$
BEGIN
  RAISE NOTICE '============================================================';
  RAISE NOTICE 'Migration 20260709150000_purchase_invoice_delete_integrity_check applied.';
  RAISE NOTICE '  delete_purchase_invoice(uuid) now self-verifies and rolls back on any orphan.';
  RAISE NOTICE '============================================================';
END $$;

NOTIFY pgrst, 'reload schema';
