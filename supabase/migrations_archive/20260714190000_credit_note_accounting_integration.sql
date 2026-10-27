-- ============================================================================
-- Credit Notes — full accounting integration (2026-07-14)
-- ============================================================================
-- Until now credit_notes reversed inventory (via 20260416100000) but never
-- reversed the Sales / Output PPN / A/R side. That meant issuing a credit
-- note left Output PPN inflated, A/R inflated, and revenue overstated —
-- the exact scenario every mature ERP (SAP / Oracle / Zoho) prevents.
--
-- This migration makes credit_notes the mirror of sales_invoices:
--   Sales Invoice          Credit Note
--   Dr A/R                 Dr Sales Return    (4300)
--   Cr Sales               Dr Output PPN      (2130 — reduces liability)
--   Cr Output PPN          Cr A/R             (1120)
--
--   Dr COGS                Dr Inventory       (COGS reversal)
--   Cr Inventory           Cr COGS
--
-- Posted automatically when status = 'approved' — the same gate the
-- existing stock trigger (20260416100000) uses. Reversed automatically
-- when status leaves 'approved' or the credit note is deleted. Output PPN
-- for the tax period is now computed as gross sales_invoices.tax_amount
-- minus approved credit_notes.tax_amount, keeping the compute chain the
-- single source of truth.
--
-- Contents:
--   1. Add credit_notes.tax_period_id + credit_notes.journal_entry_id.
--   2. Attribution trigger — fills tax_period_id from credit_note_date.
--   3. Shared JE helper _post_credit_note_je(credit_notes) so trigger
--      and backfill produce byte-identical journals.
--   4. post_credit_note_journal trigger — BEFORE INSERT/UPDATE; posts
--      when status enters 'approved'.
--   5. reverse_credit_note_journal trigger — BEFORE UPDATE/DELETE;
--      releases BSL match_entry_ids, cascades JE + JE-lines cleanup.
--   6. trg_recompute_from_credit_note — AFTER INSERT/UPDATE/DELETE.
--   7. compute_period_ppn PPN branch extended: Output PPN nets approved
--      credit-note tax_amount from gross sales tax_amount.
--   8. Backfill: attribute tax_period_id for every existing row, post
--      JEs for existing 'approved' rows that lack one, recompute all
--      PPN periods.
--
-- Additive, idempotent, no schema removals.
-- ============================================================================

BEGIN;

-- 1. Columns ------------------------------------------------------------------
ALTER TABLE public.credit_notes
  ADD COLUMN IF NOT EXISTS tax_period_id    uuid REFERENCES public.tax_periods(id),
  ADD COLUMN IF NOT EXISTS journal_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_credit_notes_tax_period_id ON public.credit_notes(tax_period_id);
CREATE INDEX IF NOT EXISTS idx_credit_notes_je            ON public.credit_notes(journal_entry_id);

-- 2. Auto-attribute tax_period_id --------------------------------------------
CREATE OR REPLACE FUNCTION public.auto_attribute_credit_note_tax_period()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_period_id uuid;
  v_year      int;
  v_month     int;
BEGIN
  IF NEW.tax_period_id IS NOT NULL THEN RETURN NEW; END IF;
  IF NEW.credit_note_date IS NULL THEN RETURN NEW; END IF;

  v_year  := EXTRACT(YEAR  FROM NEW.credit_note_date)::int;
  v_month := EXTRACT(MONTH FROM NEW.credit_note_date)::int;

  SELECT id INTO v_period_id FROM public.tax_periods
   WHERE fiscal_year = v_year AND period_month = v_month AND tax_type = 'PPN';
  IF v_period_id IS NULL THEN
    v_period_id := public.upsert_tax_period(v_year, v_month, 'PPN');
  END IF;
  NEW.tax_period_id := v_period_id;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_auto_attribute_credit_note_period ON public.credit_notes;
CREATE TRIGGER trg_auto_attribute_credit_note_period
  BEFORE INSERT OR UPDATE ON public.credit_notes
  FOR EACH ROW EXECUTE FUNCTION public.auto_attribute_credit_note_tax_period();

-- 3. Shared JE helper --------------------------------------------------------
-- Called from the BEFORE trigger AND the backfill so the two paths post the
-- same journal shape. Returns the id of the primary (revenue-reversal) JE.
CREATE OR REPLACE FUNCTION public._post_credit_note_je(p_cn public.credit_notes)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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

  -- Dr Sales Return (subtotal — the net of what was originally credited to Sales)
  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
  VALUES (v_je_id, 1, v_return_id,
          'Sales Return - ' || p_cn.credit_note_number,
          p_cn.subtotal, 0, p_cn.customer_id);

  -- Dr Output PPN (reduces the liability that was originally credited on the invoice)
  IF COALESCE(p_cn.tax_amount, 0) > 0 AND v_ppn_id IS NOT NULL THEN
    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
    VALUES (v_je_id, 2, v_ppn_id,
            'Output PPN reversal - ' || p_cn.credit_note_number,
            p_cn.tax_amount, 0, p_cn.customer_id);
  END IF;

  -- Cr A/R (the customer balance owed comes down)
  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
  VALUES (v_je_id, 3, v_ar_id,
          'A/R reversal - ' || p_cn.credit_note_number,
          0, p_cn.total_amount, p_cn.customer_id);

  -- ── COGS-reversal JE (Dr Inventory, Cr COGS) ──
  IF v_cogs_id IS NOT NULL AND v_inv_id IS NOT NULL THEN
    FOR v_item IN
      SELECT cni.quantity, COALESCE(b.cost_per_unit, 0) AS cost_per_unit
        FROM credit_note_items cni
        LEFT JOIN batches b ON cni.batch_id = b.id
       WHERE cni.credit_note_id = p_cn.id
    LOOP
      v_total_cogs := v_total_cogs + (v_item.quantity * v_item.cost_per_unit);
    END LOOP;

    IF v_total_cogs > 0 THEN
      v_je_number := public.next_journal_entry_number();
      INSERT INTO journal_entries
        (entry_number, entry_date, source_module, reference_id, reference_number,
         description, total_debit, total_credit, is_posted, posted_by, created_by)
      VALUES
        (v_je_number, p_cn.credit_note_date, 'credit_note_cogs', p_cn.id, p_cn.credit_note_number,
         'COGS reversal for Credit Note ' || p_cn.credit_note_number,
         v_total_cogs, v_total_cogs, true, v_actor, v_actor)
      RETURNING id INTO v_je_cogs_id;

      INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit)
      VALUES (v_je_cogs_id, 1, v_inv_id,
              'Inventory - ' || p_cn.credit_note_number,
              v_total_cogs, 0);

      INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
      VALUES (v_je_cogs_id, 2, v_cogs_id,
              'COGS reversal - ' || p_cn.credit_note_number,
              0, v_total_cogs, p_cn.customer_id);
    END IF;
  END IF;

  RETURN v_je_id;
END $$;

REVOKE ALL     ON FUNCTION public._post_credit_note_je(public.credit_notes) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public._post_credit_note_je(public.credit_notes) TO authenticated;

-- 4. Post-JE trigger — fires on INSERT-approved or UPDATE into 'approved' ----
CREATE OR REPLACE FUNCTION public.post_credit_note_journal()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_should_post boolean := false;
BEGIN
  IF NEW.status = 'approved' AND NEW.journal_entry_id IS NULL THEN
    IF TG_OP = 'INSERT' THEN
      v_should_post := true;
    ELSIF TG_OP = 'UPDATE' AND (OLD.status IS DISTINCT FROM NEW.status) THEN
      v_should_post := true;
    END IF;
  END IF;

  IF v_should_post THEN
    NEW.journal_entry_id := public._post_credit_note_je(NEW);
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_post_credit_note ON public.credit_notes;
CREATE TRIGGER trg_post_credit_note
  BEFORE INSERT OR UPDATE ON public.credit_notes
  FOR EACH ROW EXECUTE FUNCTION public.post_credit_note_journal();

-- 5. Reverse-JE trigger — fires on approval revocation or DELETE ------------
CREATE OR REPLACE FUNCTION public.reverse_credit_note_journal()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_je_ids uuid[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.journal_entry_id IS NULL THEN
      RETURN OLD;
    END IF;

    SELECT COALESCE(array_agg(id), ARRAY[]::uuid[])
      INTO v_je_ids
      FROM journal_entries
     WHERE source_module IN ('credit_note', 'credit_note_cogs')
       AND reference_id  = OLD.id;

    IF array_length(v_je_ids, 1) IS NOT NULL THEN
      -- Do not touch bank_statement_lines.updated_at — the column is not
      -- present in every environment (two conflicting CREATE TABLE
      -- IF NOT EXISTS definitions exist in the migration history).
      -- matched_at = NULL is the authoritative recon-reset timestamp.
      UPDATE bank_statement_lines
         SET matched_entry_id      = NULL,
             reconciliation_status = 'unmatched',
             matched_at            = NULL
       WHERE matched_entry_id = ANY (v_je_ids);
      -- bank_reconciliation_items.journal_entry_id has ON DELETE SET NULL
      -- (installed in 20260714150000), so the JE DELETE clears it too.

      DELETE FROM journal_entry_lines WHERE journal_entry_id = ANY (v_je_ids);
      DELETE FROM journal_entries     WHERE id = ANY (v_je_ids);
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE: only reverse if status leaves 'approved'
  IF TG_OP = 'UPDATE'
     AND OLD.status = 'approved'
     AND NEW.status IS DISTINCT FROM 'approved'
     AND OLD.journal_entry_id IS NOT NULL THEN

    SELECT COALESCE(array_agg(id), ARRAY[]::uuid[])
      INTO v_je_ids
      FROM journal_entries
     WHERE source_module IN ('credit_note', 'credit_note_cogs')
       AND reference_id  = OLD.id;

    IF array_length(v_je_ids, 1) IS NOT NULL THEN
      -- Do not touch bank_statement_lines.updated_at — the column is not
      -- present in every environment (two conflicting CREATE TABLE
      -- IF NOT EXISTS definitions exist in the migration history).
      -- matched_at = NULL is the authoritative recon-reset timestamp.
      UPDATE bank_statement_lines
         SET matched_entry_id      = NULL,
             reconciliation_status = 'unmatched',
             matched_at            = NULL
       WHERE matched_entry_id = ANY (v_je_ids);

      DELETE FROM journal_entry_lines WHERE journal_entry_id = ANY (v_je_ids);
      DELETE FROM journal_entries     WHERE id = ANY (v_je_ids);
    END IF;

    NEW.journal_entry_id := NULL;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

DROP TRIGGER IF EXISTS trg_reverse_credit_note ON public.credit_notes;
CREATE TRIGGER trg_reverse_credit_note
  BEFORE UPDATE OR DELETE ON public.credit_notes
  FOR EACH ROW EXECUTE FUNCTION public.reverse_credit_note_journal();

-- 6. Recompute trigger -------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_recompute_from_credit_note()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM recompute_periods_for_date(OLD.credit_note_date);
  ELSE
    PERFORM recompute_periods_for_date(NEW.credit_note_date);
    IF TG_OP = 'UPDATE'
       AND (NEW.credit_note_date IS DISTINCT FROM OLD.credit_note_date) THEN
      PERFORM recompute_periods_for_date(OLD.credit_note_date);
    END IF;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_recompute_credit_note_period ON public.credit_notes;
CREATE TRIGGER trg_recompute_credit_note_period
  AFTER INSERT OR UPDATE OR DELETE ON public.credit_notes
  FOR EACH ROW EXECUTE FUNCTION public.trg_recompute_from_credit_note();

-- 7. Extend compute_period_ppn PPN branch to net approved credit notes -------
CREATE OR REPLACE FUNCTION public.compute_period_ppn(p_period_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_period       tax_periods%ROWTYPE;
  v_input        numeric(18,2);
  v_output_gross numeric(18,2);
  v_output_cn    numeric(18,2);
  v_output       numeric(18,2);
  v_prior_cf     numeric(18,2);
  v_pph_total    numeric(18,2);
BEGIN
  SELECT * INTO v_period FROM tax_periods WHERE id = p_period_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tax period % not found', p_period_id;
  END IF;

  IF v_period.tax_type = 'PPN' THEN
    -- INPUT PPN (unchanged from 20260714170000): purchase_invoices +
    -- finance_expenses (regular ppn_amount excluding broker rows) +
    -- broker_items[i].ppn_amount + pib_ppn_amount.
    SELECT
      COALESCE((
        SELECT SUM(tax_amount) FROM purchase_invoices
         WHERE tax_period_id = p_period_id AND tax_amount > 0
      ), 0)
      +
      COALESCE((
        SELECT SUM(fe.ppn_amount)
          FROM finance_expenses fe
         WHERE fe.tax_period_id = p_period_id
           AND fe.ppn_amount > 0
           AND NOT EXISTS (
             SELECT 1
               FROM jsonb_array_elements(COALESCE(fe.broker_items, '[]'::jsonb)) item
              WHERE COALESCE((item->>'ppn_amount')::numeric, 0) > 0
           )
      ), 0)
      +
      COALESCE((
        SELECT SUM(COALESCE((item->>'ppn_amount')::numeric, 0))
          FROM finance_expenses fe
          CROSS JOIN LATERAL jsonb_array_elements(COALESCE(fe.broker_items, '[]'::jsonb)) item
         WHERE fe.tax_period_id = p_period_id
           AND COALESCE((item->>'ppn_amount')::numeric, 0) > 0
      ), 0)
      +
      COALESCE((
        SELECT SUM(pib_ppn_amount) FROM finance_expenses
         WHERE tax_period_id = p_period_id AND pib_ppn_amount > 0
      ), 0)
    INTO v_input;

    -- OUTPUT PPN = gross sales_invoices.tax_amount
    --            − approved credit_notes.tax_amount (both attributed to
    --              this same PPN period)
    SELECT COALESCE(SUM(tax_amount), 0) INTO v_output_gross
      FROM sales_invoices
     WHERE tax_period_id = p_period_id AND tax_amount > 0;

    SELECT COALESCE(SUM(tax_amount), 0) INTO v_output_cn
      FROM credit_notes
     WHERE tax_period_id = p_period_id
       AND status = 'approved'
       AND tax_amount > 0;

    v_output := GREATEST(v_output_gross - v_output_cn, 0);

    SELECT COALESCE(carry_forward_out, 0) INTO v_prior_cf
      FROM tax_periods
     WHERE tax_type = 'PPN'
       AND (fiscal_year, period_month) < (v_period.fiscal_year, v_period.period_month)
     ORDER BY fiscal_year DESC, period_month DESC
     LIMIT 1;
    v_prior_cf := COALESCE(v_prior_cf, 0);

    UPDATE tax_periods SET
      input_ppn_total   = v_input,
      output_ppn_total  = v_output,
      carry_forward_in  = v_prior_cf,
      net_ppn           = GREATEST(v_output - v_input - v_prior_cf, 0),
      carry_forward_out = GREATEST(v_input + v_prior_cf - v_output, 0),
      updated_at        = now()
    WHERE id = p_period_id;

  ELSE
    -- PPh period — unchanged.
    SELECT
      COALESCE((
        SELECT SUM(fe.pph_amount)
          FROM finance_expenses fe
          LEFT JOIN tax_codes tc ON tc.id = fe.pph_code_id
         WHERE EXTRACT(YEAR  FROM fe.expense_date)::int = v_period.fiscal_year
           AND EXTRACT(MONTH FROM fe.expense_date)::int = v_period.period_month
           AND fe.pph_amount > 0
           AND (v_period.tax_type = 'PPh_Unifikasi' OR tc.tax_type = v_period.tax_type)
      ), 0)
      +
      COALESCE((
        SELECT SUM(pv.pph_amount)
          FROM payment_vouchers pv
          LEFT JOIN tax_codes tc ON tc.id = pv.pph_code_id
         WHERE EXTRACT(YEAR  FROM pv.voucher_date)::int = v_period.fiscal_year
           AND EXTRACT(MONTH FROM pv.voucher_date)::int = v_period.period_month
           AND pv.pph_amount > 0
           AND (v_period.tax_type = 'PPh_Unifikasi' OR tc.tax_type = v_period.tax_type)
      ), 0)
    INTO v_pph_total;

    UPDATE tax_periods SET
      pph_total  = v_pph_total,
      updated_at = now()
    WHERE id = p_period_id;
  END IF;
END $$;

-- 8. Backfill ----------------------------------------------------------------
-- (a) Attribute tax_period_id for every existing credit_note.
DO $$
DECLARE r credit_notes%ROWTYPE; v_id uuid; v_yr int; v_mo int;
BEGIN
  FOR r IN
    SELECT * FROM credit_notes
     WHERE tax_period_id IS NULL AND credit_note_date IS NOT NULL
  LOOP
    v_yr := EXTRACT(YEAR  FROM r.credit_note_date)::int;
    v_mo := EXTRACT(MONTH FROM r.credit_note_date)::int;
    SELECT id INTO v_id FROM tax_periods
     WHERE fiscal_year = v_yr AND period_month = v_mo AND tax_type = 'PPN';
    IF v_id IS NULL THEN
      v_id := upsert_tax_period(v_yr, v_mo, 'PPN');
    END IF;
    UPDATE credit_notes SET tax_period_id = v_id WHERE id = r.id;
  END LOOP;
END $$;

-- (b) Post JEs for existing 'approved' credit_notes that lack one. Uses the
--     same _post_credit_note_je helper the trigger uses, so backfill and
--     forward-going flow produce byte-identical journals.
DO $$
DECLARE r credit_notes%ROWTYPE; v_je uuid;
BEGIN
  FOR r IN
    SELECT * FROM credit_notes
     WHERE status = 'approved'
       AND journal_entry_id IS NULL
  LOOP
    v_je := _post_credit_note_je(r);
    -- Set journal_entry_id without re-firing post/reverse (both guarded by
    -- status transitions / journal_entry_id NULL check, so the UPDATE below
    -- is a no-op for those triggers).
    UPDATE credit_notes SET journal_entry_id = v_je WHERE id = r.id;
  END LOOP;
END $$;

-- (c) Recompute every PPN period so tax_periods.output_ppn_total reflects
--     the corrected engine (nets approved credit notes).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM tax_periods WHERE tax_type = 'PPN' ORDER BY fiscal_year, period_month LOOP
    PERFORM compute_period_ppn(r.id);
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
