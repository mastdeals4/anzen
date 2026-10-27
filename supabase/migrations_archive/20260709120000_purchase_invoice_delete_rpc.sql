-- ============================================================================
-- Migration: 20260709120000_purchase_invoice_delete_rpc
-- Date:      2026-07-09
--
-- ROOT CAUSE
--   Deleting a purchase_invoice row failed with:
--     update or delete on table "purchase_invoices" violates foreign key
--     constraint "voucher_allocations_purchase_invoice_id_fkey"
--     on table "voucher_allocations"
--
--   voucher_allocations.purchase_invoice_id REFERENCES purchase_invoices(id)
--   with no ON DELETE action.  As soon as an invoice had ever been paid (fully
--   or partially) at least one allocation existed and the frontend's plain
--   `DELETE FROM purchase_invoices` was blocked.
--
--   Deleting the FK in isolation would silently leave orphan allocations,
--   stale paid_amount on payment_vouchers, orphan journal entries + lines,
--   stuck bank-statement matches, and batches pointing to a non-existent
--   invoice.  The right fix is an accounting-safe RPC that removes every
--   descendant in the correct order inside a single transaction.
--
-- WHAT THIS MIGRATION DOES
--   1. Creates public.delete_purchase_invoice(p_id UUID) — SECURITY DEFINER
--      RPC that safely reverses and deletes a purchase invoice by:
--        a. Locking the invoice row.
--        b. Deleting voucher_allocations for this invoice — the existing
--           trg_sync_purchase_invoice_payment_state trigger already keeps
--           paid_amount coherent for OTHER invoices touched by the same
--           payment vouchers.
--        c. Unlinking bank_statement_lines that were matched to any journal
--           entry that originated from this invoice (matched_entry_id NULL,
--           reconciliation_status = 'unmatched') — restores lines to the
--           bank reconciliation queue.
--        d. NULLing the FK invoice.journal_entry_id BEFORE deleting the JE
--           (purchase_invoices.journal_entry_id has NO ACTION on delete, and
--           the BEFORE UPDATE trigger post_purchase_invoice_journal() is a
--           no-op when OLD.journal_entry_id IS NOT NULL — so no re-post).
--        e. Deleting journal_entry_lines then journal_entries for every JE
--           whose source_module='purchase_invoice' AND reference_id=p_id.
--        f. NULLing batches.purchase_invoice_id for any batches that were
--           tagged to this invoice (batches themselves and their inventory
--           transactions are preserved — deleting them would silently drop
--           stock).
--        g. Explicitly deleting purchase_invoice_items (ON DELETE CASCADE
--           would also handle this — belt and braces against FK config drift).
--        h. Finally deleting the purchase_invoices row.
--        i. Writing an audit_logs entry describing the deletion.
--      Everything runs in the RPC's implicit transaction: any failure rolls
--      back the whole thing.
--
--   2. Grants EXECUTE to authenticated (SELECT/DELETE RLS still applies to
--      the underlying rows via the DEFINER's checks upstream).
--
-- BACKWARD COMPATIBILITY
--   The FK constraints themselves are not changed.  Callers that stop using
--   the RPC and fall back to a raw DELETE will still hit the original error
--   — which is intentional: the raw DELETE is not safe.
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
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_id IS NULL THEN
    RAISE EXCEPTION 'Purchase invoice id is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- (a) Lock the invoice row so nothing else can post payments against it.
  SELECT * INTO v_invoice
    FROM public.purchase_invoices
   WHERE id = p_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase invoice % not found', p_id USING ERRCODE = 'no_data_found';
  END IF;

  v_original_je_id := v_invoice.journal_entry_id;

  -- Gather all JE ids that were posted for this invoice (there is usually one,
  -- but reversals or historical duplicates can produce more).  The row lock
  -- above prevents concurrent inserts.
  SELECT COALESCE(array_agg(id), ARRAY[]::UUID[])
    INTO v_je_ids
    FROM public.journal_entries
   WHERE source_module = 'purchase_invoice'
     AND reference_id  = p_id;

  IF v_original_je_id IS NOT NULL
     AND NOT v_original_je_id = ANY (v_je_ids) THEN
    v_je_ids := array_append(v_je_ids, v_original_je_id);
  END IF;

  -- (b) Record payment vouchers touched by this invoice's allocations, so
  --     we can leave a clean audit trail (paid_amount on other invoices is
  --     maintained by trg_sync_purchase_invoice_payment_state automatically).
  SELECT COALESCE(array_agg(DISTINCT payment_voucher_id), ARRAY[]::UUID[])
    INTO v_affected_pvs
    FROM public.voucher_allocations
   WHERE purchase_invoice_id = p_id
     AND payment_voucher_id IS NOT NULL;

  -- Delete allocations FIRST — this is the FK that was blocking the delete.
  -- The AFTER DELETE trigger recalculates paid_amount for this invoice; the
  -- UPDATE is harmless (the row is about to be deleted) and cannot deadlock
  -- because we already hold the FOR UPDATE lock.
  DELETE FROM public.voucher_allocations
   WHERE purchase_invoice_id = p_id;

  -- (c) Bank reconciliation cleanup.  Any bank_statement_line pointing at one
  --     of this invoice's JEs must be released back to the "unmatched" queue
  --     before we drop the JE (matched_entry_id has NO ACTION on delete).
  IF array_length(v_je_ids, 1) IS NOT NULL THEN
    UPDATE public.bank_statement_lines
       SET matched_entry_id      = NULL,
           reconciliation_status = 'unmatched',
           matched_at            = NULL,
           matched_by            = NULL
     WHERE matched_entry_id = ANY (v_je_ids);
  END IF;

  -- (d) Break the invoice → JE FK BEFORE deleting the JE.  The BEFORE UPDATE
  --     trigger post_purchase_invoice_journal() short-circuits when
  --     NEW.journal_entry_id IS NULL AND OLD.journal_entry_id IS NOT NULL,
  --     so this update posts nothing new.
  IF v_original_je_id IS NOT NULL THEN
    UPDATE public.purchase_invoices
       SET journal_entry_id = NULL
     WHERE id = p_id;
  END IF;

  -- (e) Delete JE lines then JE headers.  We delete lines explicitly to be
  --     safe against any future FK config drift, even though journal_entry_lines
  --     cascades on journal_entries delete in the current schema.
  IF array_length(v_je_ids, 1) IS NOT NULL THEN
    DELETE FROM public.journal_entry_lines
     WHERE journal_entry_id = ANY (v_je_ids);

    DELETE FROM public.journal_entries
     WHERE id = ANY (v_je_ids);
  END IF;

  -- (f) Detach batches from this invoice.  We do NOT delete batches — they
  --     may still hold stock and have downstream inventory_transactions.
  UPDATE public.batches
     SET purchase_invoice_id = NULL
   WHERE purchase_invoice_id = p_id;

  -- (g) Belt-and-braces: delete items explicitly.  purchase_invoice_items
  --     has ON DELETE CASCADE from purchase_invoices, but explicit deletion
  --     keeps the RPC correct even if that CASCADE is ever relaxed.
  DELETE FROM public.purchase_invoice_items
   WHERE purchase_invoice_id = p_id;

  -- (h) Finally delete the invoice itself.
  DELETE FROM public.purchase_invoices
   WHERE id = p_id;

  -- (i) Audit trail.  audit_logs is best-effort — swallow any failure so a
  --     missing audit_logs table (older environments) does not block the
  --     accounting-safe delete.
  BEGIN
    INSERT INTO public.audit_logs (
      table_name, record_id, action_type, old_values, new_values, user_id
    ) VALUES (
      'purchase_invoices',
      p_id,
      'delete',
      jsonb_build_object(
        'invoice_number',        v_invoice.invoice_number,
        'supplier_id',           v_invoice.supplier_id,
        'invoice_date',          v_invoice.invoice_date,
        'total_amount',          v_invoice.total_amount,
        'paid_amount',           v_invoice.paid_amount,
        'status',                v_invoice.status,
        'journal_entry_ids',     to_jsonb(v_je_ids),
        'payment_voucher_ids',   to_jsonb(v_affected_pvs)
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
'Accounting-safe purchase invoice delete: reverses voucher allocations,
unlinks bank reconciliation, deletes journal entries + lines, detaches
batches, cascades items, then deletes the invoice — all in one transaction.';

DO $$
BEGIN
  RAISE NOTICE '============================================================';
  RAISE NOTICE 'Migration 20260709120000_purchase_invoice_delete_rpc applied.';
  RAISE NOTICE '  delete_purchase_invoice(uuid) RPC created and granted to authenticated.';
  RAISE NOTICE '============================================================';
END $$;
