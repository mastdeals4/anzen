-- ============================================================================
-- Migration: 20260709140000_purchase_invoice_delete_recon_cleanup
-- Date:      2026-07-09
--
-- ROOT CAUSE
--   The previous delete_purchase_invoice(uuid) RPC (migration 20260709120000)
--   correctly cleaned bank_statement_lines that were matched to the PI's OWN
--   journal entries (source_module='purchase_invoice'), but it left behind
--   bank_statement_line rows that had been matched to a PAYMENT VOUCHER's
--   journal entry.
--
--   Real flow for a paid purchase invoice:
--     PI  ──creates JE──►  purchase_invoice JE   (this one is deleted OK today)
--     PV  ──creates JE──►  payment_voucher JE    (this JE stays; correct)
--     PV  ──allocates──►   PI via voucher_allocations
--     Bank recon later matches the bank line to the PV's JE:
--         bank_statement_lines.matched_entry_id = PV.journal_entry_id
--         bank_statement_lines.reconciliation_status = 'recorded'
--
--   When the user deletes the PI:
--     • voucher_allocations rows for the PI are removed          ✓ (was fine)
--     • the PI's own JE is deleted                                ✓ (was fine)
--     • the PV JE stays (correct — the PV may pay other invoices)
--     • BUT if the PV was allocating ONLY to this PI, the PV now has zero
--       allocations, its paid_amount is 0, and the bank line remains
--       'recorded' pointing at a JE for an orphan PV.
--
--   User sees Bank Reconciliation still displaying:
--       Status: Recorded    Journal: JE2603-0036
--   even though the PI it referenced is gone.
--
-- WHAT THIS FIX DOES
--   Replaces public.delete_purchase_invoice(uuid) so that AFTER removing the
--   invoice's own allocations and JE, it inspects every payment_voucher that
--   was allocating to this invoice and — if the PV now has ZERO remaining
--   allocations — treats the PV as orphaned and releases its bank matches:
--
--     UPDATE bank_statement_lines
--        SET matched_entry_id       = NULL,
--            matched_expense_id     = NULL,
--            matched_receipt_id     = NULL,
--            matched_petty_cash_id  = NULL,
--            matched_fund_transfer_id = NULL,
--            reconciliation_status  = 'unmatched',
--            matched_at             = NULL,
--            matched_by             = NULL
--      WHERE matched_entry_id = <orphan PV's journal_entry_id>;
--
--   The PV row itself is NOT deleted — orphan PVs may still be a legitimate
--   accounts payable book-keeping artefact for the finance team to review /
--   reverse via the Payment Voucher screen. Only the bank-line link is
--   released so the bank transaction returns to the "Unmatched" queue.
--
--   For safety, this migration ALSO widens the original cleanup (the PI's
--   own JEs) to null every typed match FK — not just matched_entry_id —
--   because a PI-created JE may in some import flows have been rematched via
--   matched_expense_id / matched_receipt_id / etc. Belt-and-braces.
--
-- BACKWARD COMPATIBILITY
--   Same signature, same return type, same permissions. Callers do not
--   change.
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

  -- ── PATCH 2026-07-09 ─────────────────────────────────────────────────
  --   Identify PVs that were allocating ONLY to this invoice — they now
  --   have zero allocations remaining. Their JEs will therefore appear as
  --   "Recorded" on bank reconciliation with no linked document.  We
  --   release those bank-line matches back to the Unmatched queue.
  --
  --   NOTE: We do NOT delete the PV rows themselves — an orphan PV may
  --   still hold a valid "money left the bank" record that Finance may
  --   want to reverse or re-allocate manually.
  -- ─────────────────────────────────────────────────────────────────────
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

  -- (c) Bank reconciliation cleanup for the PI's OWN JEs — now clears
  --     every typed FK, not just matched_entry_id.
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

  -- (d) Break the invoice → JE FK BEFORE deleting the JE.
  IF v_original_je_id IS NOT NULL THEN
    UPDATE public.purchase_invoices
       SET journal_entry_id = NULL
     WHERE id = p_id;
  END IF;

  -- (e) Delete JE lines then JE headers.
  IF array_length(v_je_ids, 1) IS NOT NULL THEN
    DELETE FROM public.journal_entry_lines
     WHERE journal_entry_id = ANY (v_je_ids);

    DELETE FROM public.journal_entries
     WHERE id = ANY (v_je_ids);
  END IF;

  -- (f) Detach batches.
  UPDATE public.batches
     SET purchase_invoice_id = NULL
   WHERE purchase_invoice_id = p_id;

  -- (g) Belt-and-braces items delete.
  DELETE FROM public.purchase_invoice_items
   WHERE purchase_invoice_id = p_id;

  -- (h) Delete the invoice row.
  DELETE FROM public.purchase_invoices
   WHERE id = p_id;

  -- (i) Audit trail.
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
        'orphan_pv_je_ids_released',to_jsonb(v_orphan_pv_je_ids)
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

REVOKE ALL ON FUNCTION public.delete_purchase_invoice(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.delete_purchase_invoice(uuid) FROM anon;
GRANT  EXECUTE ON FUNCTION public.delete_purchase_invoice(uuid) TO authenticated;

COMMENT ON FUNCTION public.delete_purchase_invoice(uuid) IS
'Accounting-safe PI delete. Removes PI + its JE + own allocations, and
releases bank-recon links on any PV whose allocations dropped to zero
(prevents stale "Recorded" rows pointing at orphan PV JEs). PV rows and
their JEs are preserved for manual review.';

-- ============================================================================
-- One-time backfill: repair rows already stuck in "Recorded" state due to
-- the pre-fix behaviour.
--
-- Any bank_statement_line whose matched_entry_id points at a PV whose
-- allocations table is now empty is orphaned by definition (the PV cannot
-- be paying anything). Release the match.
-- ============================================================================

DO $$
DECLARE
  v_orphan_je_ids UUID[];
  v_count         INT := 0;
BEGIN
  SELECT COALESCE(array_agg(pv.journal_entry_id), ARRAY[]::UUID[])
    INTO v_orphan_je_ids
    FROM public.payment_vouchers pv
   WHERE pv.journal_entry_id IS NOT NULL
     AND NOT EXISTS (
           SELECT 1
             FROM public.voucher_allocations va
            WHERE va.payment_voucher_id = pv.id
         );

  IF array_length(v_orphan_je_ids, 1) IS NOT NULL THEN
    UPDATE public.bank_statement_lines
       SET matched_entry_id        = NULL,
           matched_expense_id      = NULL,
           matched_receipt_id      = NULL,
           matched_petty_cash_id   = NULL,
           matched_fund_transfer_id= NULL,
           reconciliation_status   = 'unmatched',
           matched_at              = NULL,
           matched_by              = NULL
     WHERE matched_entry_id = ANY (v_orphan_je_ids);

    GET DIAGNOSTICS v_count = ROW_COUNT;
  END IF;

  RAISE NOTICE '============================================================';
  RAISE NOTICE 'Migration 20260709140000_purchase_invoice_delete_recon_cleanup applied.';
  RAISE NOTICE '  delete_purchase_invoice(uuid) RPC replaced (recon cleanup for orphan PVs).';
  RAISE NOTICE '  Backfill released % stale bank-line matches.', v_count;
  RAISE NOTICE '============================================================';
END $$;

NOTIFY pgrst, 'reload schema';
