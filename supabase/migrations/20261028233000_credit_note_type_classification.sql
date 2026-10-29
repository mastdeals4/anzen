-- Migration: 20261028233000_credit_note_type_classification.sql
-- Purpose: Add explicit credit_note_type ('physical_return' vs 'commercial_credit')
-- Ensures physical returns update inventory and reverse COGS, while commercial credits
-- only generate AR/Revenue/PPN adjustments without moving physical stock or touching COGS.
-- Preserves existing CN-26-0001 records and valid historical postings without duplication.
-- Protects approved/posted physical returns from unauthorized transitions to commercial credits.

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 1: PRECONDITION INTEGRITY CHECKS (ABORT SAFELY ON ANY MISMATCH)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_inv_count      integer;
  v_inv            record;
  v_cn_count       integer;
  v_cn             record;
  v_items_count    integer;
  v_items_qty      numeric;
  v_b108_qty       numeric;
  v_b109_qty       numeric;
  v_it_count       integer;
  v_it_b108_qty    numeric;
  v_it_b109_qty    numeric;
  v_je_ar          record;
  v_je_ar_lines    integer;
  v_je_cogs        record;
  v_je_cogs_lines  integer;
  v_line_4300      record;
  v_line_2130      record;
  v_line_1120      record;
  v_line_1130      record;
  v_line_5100      record;
BEGIN
  -- 1. Check required Chart of Accounts codes
  IF NOT EXISTS (SELECT 1 FROM chart_of_accounts WHERE code = '1120') THEN
    RAISE EXCEPTION 'Precondition failed: Account 1120 (A/R) missing from Chart of Accounts';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM chart_of_accounts WHERE code = '4300') THEN
    RAISE EXCEPTION 'Precondition failed: Account 4300 (Sales Returns) missing from Chart of Accounts';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM chart_of_accounts WHERE code = '1130') THEN
    RAISE EXCEPTION 'Precondition failed: Account 1130 (Inventory) missing from Chart of Accounts';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM chart_of_accounts WHERE code = '5100') THEN
    RAISE EXCEPTION 'Precondition failed: Account 5100 (COGS - Materials) missing from Chart of Accounts';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM chart_of_accounts WHERE code = '2130') THEN
    RAISE EXCEPTION 'Precondition failed: Account 2130 (Output PPN) missing from Chart of Accounts';
  END IF;

  -- 2. Check existing function and trigger definitions
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = '_post_credit_note_je') THEN
    RAISE EXCEPTION 'Precondition failed: Function _post_credit_note_je does not exist';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'trg_credit_note_inventory_v1') THEN
    RAISE EXCEPTION 'Precondition failed: Function trg_credit_note_inventory_v1 does not exist';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.credit_notes'::regclass
       AND tgname = 'trigger_credit_note_inventory_v1'
       AND tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'Precondition failed: Trigger trigger_credit_note_inventory_v1 missing or disabled on public.credit_notes';
  END IF;

  -- 3. Check invoice SAPJ-26-013 invariants (exact identity, single occurrence, settled state, zero balance)
  SELECT count(*) INTO v_inv_count FROM public.sales_invoices WHERE invoice_number = 'SAPJ-26-013';
  IF v_inv_count != 1 THEN
    RAISE EXCEPTION 'Precondition failed: SAPJ-26-013 count is %, expected exactly 1', v_inv_count;
  END IF;

  SELECT id, payment_status, total_amount, balance_amount
    INTO v_inv
    FROM public.sales_invoices
   WHERE invoice_number = 'SAPJ-26-013';

  IF v_inv.id != '03162b99-b06b-475b-b00c-e14cb9dd6123'::uuid THEN
    RAISE EXCEPTION 'Precondition failed: SAPJ-26-013 ID is %, expected 03162b99-b06b-475b-b00c-e14cb9dd6123', v_inv.id;
  END IF;
  IF v_inv.payment_status != 'paid' THEN
    RAISE EXCEPTION 'Precondition failed: SAPJ-26-013 payment_status is %, expected paid', v_inv.payment_status;
  END IF;
  IF v_inv.balance_amount != 0.00 THEN
    RAISE EXCEPTION 'Precondition failed: SAPJ-26-013 balance_amount is %, expected 0.00', v_inv.balance_amount;
  END IF;
  IF v_inv.total_amount != 251328420.00 THEN
    RAISE EXCEPTION 'Precondition failed: SAPJ-26-013 total_amount is %, expected 251328420.00', v_inv.total_amount;
  END IF;

  -- 4. Check CN-26-0001 invariants (exact identity, single occurrence, approved status, amounts, journal link)
  SELECT count(*) INTO v_cn_count FROM public.credit_notes WHERE credit_note_number = 'CN-26-0001';
  IF v_cn_count != 1 THEN
    RAISE EXCEPTION 'Precondition failed: CN-26-0001 count is %, expected exactly 1', v_cn_count;
  END IF;

  SELECT id, status, total_amount, subtotal, tax_amount, material_return_id, journal_entry_id
    INTO v_cn
    FROM public.credit_notes
   WHERE credit_note_number = 'CN-26-0001';

  IF v_cn.id != '83953d95-7baf-4a07-b7c5-b63d6f08945c'::uuid THEN
    RAISE EXCEPTION 'Precondition failed: CN-26-0001 ID is %, expected 83953d95-7baf-4a07-b7c5-b63d6f08945c', v_cn.id;
  END IF;
  IF v_cn.status != 'approved' THEN
    RAISE EXCEPTION 'Precondition failed: CN-26-0001 status is %, expected approved', v_cn.status;
  END IF;
  IF v_cn.journal_entry_id != 'e5485488-ad57-442c-8e02-c98619cbc240'::uuid THEN
    RAISE EXCEPTION 'Precondition failed: CN-26-0001 journal_entry_id mismatch';
  END IF;
  IF v_cn.total_amount != 1745336.25 OR v_cn.subtotal != 1572375.00 OR v_cn.tax_amount != 172961.25 THEN
    RAISE EXCEPTION 'Precondition failed: CN-26-0001 financial amounts mismatch';
  END IF;

  -- 5. Check CN-26-0001 line items (exactly 2 items, 125 kg total: B108/2026 100 kg, B109/2026 25 kg)
  SELECT count(*), COALESCE(SUM(quantity), 0)
    INTO v_items_count, v_items_qty
    FROM public.credit_note_items
   WHERE credit_note_id = v_cn.id;

  IF v_items_count != 2 OR v_items_qty != 125.000 THEN
    RAISE EXCEPTION 'Precondition failed: CN-26-0001 items count %, qty %, expected 2 items totaling 125.000 kg', v_items_count, v_items_qty;
  END IF;

  SELECT COALESCE(SUM(cni.quantity), 0) INTO v_b108_qty
    FROM public.credit_note_items cni
    JOIN public.batches b ON b.id = cni.batch_id
   WHERE cni.credit_note_id = v_cn.id AND b.batch_number = 'B108/2026';
  IF v_b108_qty != 100.000 THEN
    RAISE EXCEPTION 'Precondition failed: B108/2026 qty is %, expected 100.000 kg', v_b108_qty;
  END IF;

  SELECT COALESCE(SUM(cni.quantity), 0) INTO v_b109_qty
    FROM public.credit_note_items cni
    JOIN public.batches b ON b.id = cni.batch_id
   WHERE cni.credit_note_id = v_cn.id AND b.batch_number = 'B109/2026';
  IF v_b109_qty != 25.000 THEN
    RAISE EXCEPTION 'Precondition failed: B109/2026 qty is %, expected 25.000 kg', v_b109_qty;
  END IF;

  -- 6. Check inventory return transactions for CN-26-0001
  SELECT count(*) INTO v_it_count
    FROM public.inventory_transactions
   WHERE reference_id = v_cn.id AND transaction_type = 'return';
  IF v_it_count != 2 THEN
    RAISE EXCEPTION 'Precondition failed: CN-26-0001 inventory return movements count is %, expected 2', v_it_count;
  END IF;

  SELECT COALESCE(SUM(it.quantity), 0) INTO v_it_b108_qty
    FROM public.inventory_transactions it
    JOIN public.batches b ON b.id = it.batch_id
   WHERE it.reference_id = v_cn.id AND it.transaction_type = 'return' AND b.batch_number = 'B108/2026';
  IF v_it_b108_qty != 100.000 THEN
    RAISE EXCEPTION 'Precondition failed: Inventory return B108/2026 qty is %, expected 100.000 kg', v_it_b108_qty;
  END IF;

  SELECT COALESCE(SUM(it.quantity), 0) INTO v_it_b109_qty
    FROM public.inventory_transactions it
    JOIN public.batches b ON b.id = it.batch_id
   WHERE it.reference_id = v_cn.id AND it.transaction_type = 'return' AND b.batch_number = 'B109/2026';
  IF v_it_b109_qty != 25.000 THEN
    RAISE EXCEPTION 'Precondition failed: Inventory return B109/2026 qty is %, expected 25.000 kg', v_it_b109_qty;
  END IF;

  -- 7. Check AR Journal JE2610-0219 (header, lines, accounts, posting status)
  SELECT id, entry_number, total_debit, total_credit, is_posted
    INTO v_je_ar
    FROM public.journal_entries
   WHERE entry_number = 'JE2610-0219';

  IF v_je_ar.id IS NULL OR NOT v_je_ar.is_posted OR v_je_ar.total_debit != 1745336.25 OR v_je_ar.total_credit != 1745336.25 THEN
    RAISE EXCEPTION 'Precondition failed: JE2610-0219 header is invalid or unposted';
  END IF;

  SELECT count(*) INTO v_je_ar_lines
    FROM public.journal_entry_lines
   WHERE journal_entry_id = v_je_ar.id;
  IF v_je_ar_lines != 3 THEN
    RAISE EXCEPTION 'Precondition failed: JE2610-0219 lines count is %, expected 3', v_je_ar_lines;
  END IF;

  SELECT debit, credit INTO v_line_4300
    FROM public.journal_entry_lines jel
    JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
   WHERE jel.journal_entry_id = v_je_ar.id AND coa.code = '4300';
  IF v_line_4300.debit != 1572375.00 OR v_line_4300.credit != 0.00 THEN
    RAISE EXCEPTION 'Precondition failed: JE2610-0219 Line 4300 (Sales Returns) mismatch';
  END IF;

  SELECT debit, credit INTO v_line_2130
    FROM public.journal_entry_lines jel
    JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
   WHERE jel.journal_entry_id = v_je_ar.id AND coa.code = '2130';
  IF v_line_2130.debit != 172961.25 OR v_line_2130.credit != 0.00 THEN
    RAISE EXCEPTION 'Precondition failed: JE2610-0219 Line 2130 (Output PPN) mismatch';
  END IF;

  SELECT debit, credit INTO v_line_1120
    FROM public.journal_entry_lines jel
    JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
   WHERE jel.journal_entry_id = v_je_ar.id AND coa.code = '1120';
  IF v_line_1120.debit != 0.00 OR v_line_1120.credit != 1745336.25 THEN
    RAISE EXCEPTION 'Precondition failed: JE2610-0219 Line 1120 (A/R) mismatch';
  END IF;

  -- 8. Check COGS Journal JE2610-0220 (header, lines, accounts, posting status)
  SELECT id, entry_number, total_debit, total_credit, is_posted
    INTO v_je_cogs
    FROM public.journal_entries
   WHERE entry_number = 'JE2610-0220';

  IF v_je_cogs.id IS NULL OR NOT v_je_cogs.is_posted OR v_je_cogs.total_debit != 1227102.50 OR v_je_cogs.total_credit != 1227102.50 THEN
    RAISE EXCEPTION 'Precondition failed: JE2610-0220 header is invalid or unposted';
  END IF;

  SELECT count(*) INTO v_je_cogs_lines
    FROM public.journal_entry_lines
   WHERE journal_entry_id = v_je_cogs.id;
  IF v_je_cogs_lines != 2 THEN
    RAISE EXCEPTION 'Precondition failed: JE2610-0220 lines count is %, expected 2', v_je_cogs_lines;
  END IF;

  SELECT debit, credit INTO v_line_1130
    FROM public.journal_entry_lines jel
    JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
   WHERE jel.journal_entry_id = v_je_cogs.id AND coa.code = '1130';
  IF v_line_1130.debit != 1227102.50 OR v_line_1130.credit != 0.00 THEN
    RAISE EXCEPTION 'Precondition failed: JE2610-0220 Line 1130 (Inventory) mismatch';
  END IF;

  SELECT debit, credit INTO v_line_5100
    FROM public.journal_entry_lines jel
    JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
   WHERE jel.journal_entry_id = v_je_cogs.id AND coa.code = '5100';
  IF v_line_5100.debit != 0.00 OR v_line_5100.credit != 1227102.50 THEN
    RAISE EXCEPTION 'Precondition failed: JE2610-0220 Line 5100 (COGS - Materials) mismatch';
  END IF;

  RAISE NOTICE 'Comprehensive Preconditions PASSED: SAPJ-26-013, CN-26-0001, batches, stock movements, journal entries and schema definitions all verified.';
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 2: ADD COLUMN credit_note_type (IF NOT EXISTS)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'credit_notes' AND column_name = 'credit_note_type'
  ) THEN
    ALTER TABLE public.credit_notes 
      ADD COLUMN credit_note_type text
      CONSTRAINT chk_credit_note_type CHECK (credit_note_type IN ('physical_return', 'commercial_credit'));
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 3: PRESERVE KNOWN CLASSIFICATIONS & CONSERVATIVE HISTORICAL BACKFILL
-- ─────────────────────────────────────────────────────────────────────────────
-- 1. CN-26-0001: Verified physical return of 125 kg Corn Starch BP with restocked batches
UPDATE public.credit_notes
   SET credit_note_type = 'physical_return'
 WHERE credit_note_number = 'CN-26-0001'
   AND (credit_note_type IS NULL OR credit_note_type = 'physical_return');

-- 2. Multi-dimensional positive classification for unclassified records (credit_note_type IS NULL)
-- A record is classified as 'physical_return' ONLY when positive physical return evidence exists:
--   - Linked to a material return
--   - OR has physical inventory_transactions (return movement)
--   - OR has a COGS reversal journal (source_module = 'credit_note_cogs')
-- A record is classified as 'commercial_credit' ONLY when positive commercial evidence exists
--   AND NO physical return or COGS evidence exists:
--   - Approved status, commercial reason text (discount, price concession, rebate, rounding, etc.)
--   - AND zero inventory transactions AND zero COGS journal entries.
-- All other records remain NULL (unclassified) for manual audit and explicit user review.
UPDATE public.credit_notes cn
   SET credit_note_type = CASE
     -- Positive physical return evidence
     WHEN cn.material_return_id IS NOT NULL THEN 'physical_return'
     WHEN EXISTS (
       SELECT 1 FROM public.inventory_transactions it 
       WHERE it.reference_id = cn.id AND it.transaction_type = 'return'
     ) THEN 'physical_return'
     WHEN EXISTS (
       SELECT 1 FROM public.journal_entries je 
       WHERE je.reference_id = cn.id AND je.source_module = 'credit_note_cogs'
     ) THEN 'physical_return'
     -- Positive commercial concession evidence (explicit commercial text + no stock/COGS movement)
     WHEN cn.status = 'approved'
       AND (
         LOWER(cn.reason) ~* '(discount|price concession|commercial|rebate|rounding|allowance)'
         OR LOWER(COALESCE(cn.notes, '')) ~* '(discount|price concession|commercial|rebate|rounding|allowance)'
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.inventory_transactions it 
         WHERE it.reference_id = cn.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.journal_entries je 
         WHERE je.reference_id = cn.id AND je.source_module = 'credit_note_cogs'
       ) THEN 'commercial_credit'
     -- Otherwise: leave unclassified (NULL) for manual review
     ELSE NULL
   END
 WHERE cn.credit_note_type IS NULL;

-- Log audit notice for any remaining unclassified historical records
DO $$
DECLARE
  v_unclassified_count integer;
BEGIN
  SELECT COUNT(*) INTO v_unclassified_count
    FROM public.credit_notes
   WHERE credit_note_type IS NULL;

  IF v_unclassified_count > 0 THEN
    RAISE NOTICE 'Audit Notice: % credit note(s) remain unclassified (NULL) pending manual review.', v_unclassified_count;
  ELSE
    RAISE NOTICE 'Audit Notice: All existing credit notes successfully classified with verified positive evidence.';
  END IF;
END $$;

-- Set default for future rows now that historical data is safely backfilled
ALTER TABLE public.credit_notes 
  ALTER COLUMN credit_note_type SET DEFAULT 'physical_return';

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 4: TRANSITION GUARD TRIGGER (PREVENTS UNAUTHORIZED TYPE MUTATIONS)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trg_guard_credit_note_type_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF (OLD.status = 'approved' OR OLD.journal_entry_id IS NOT NULL) 
     AND OLD.credit_note_type IS NOT NULL
     AND OLD.credit_note_type IS DISTINCT FROM NEW.credit_note_type THEN
    RAISE EXCEPTION 'Cannot modify credit_note_type on an approved or posted Credit Note (ID: %, Number: %) without a controlled reversal workflow.', 
      OLD.id, OLD.credit_note_number;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_credit_note_type_transition ON public.credit_notes;
CREATE TRIGGER trg_guard_credit_note_type_transition
  BEFORE UPDATE OF credit_note_type ON public.credit_notes
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_guard_credit_note_type_transition();

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 5: UPDATE INVENTORY TRIGGER FUNCTION
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trg_credit_note_inventory_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_item record;
BEGIN
  -- Commercial credit notes NEVER move physical inventory
  IF NEW.credit_note_type = 'commercial_credit' THEN
    RETURN NEW;
  END IF;

  -- For Credit Notes linked to a Material Return, the Material Return owns inventory
  IF COALESCE(NEW.material_return_id, OLD.material_return_id) IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Standalone physical return credit notes (credit_note_type = 'physical_return')
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

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 6: UPDATE COGS AND REVENUE POSTING FUNCTION
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._post_credit_note_je(p_cn public.credit_notes)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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

  -- ── 1. Revenue & Receivables Reversal JE (posted for BOTH types) ──
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

  -- ── 2. COGS-reversal JE (Dr Inventory, Cr COGS) ──
  -- ONLY posted for physical goods returns; commercial credits do not affect inventory or COGS
  IF p_cn.credit_note_type = 'physical_return' AND v_cogs_id IS NOT NULL AND v_inv_id IS NOT NULL THEN
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

      -- 1b. Fallback to delivery challan items if linked via material return
      IF (v_unit_cogs IS NULL OR v_unit_cogs <= 0) AND p_cn.material_return_id IS NOT NULL THEN
        SELECT COALESCE(b.landed_cost_per_unit, b.cost_per_unit, 0) INTO v_unit_cogs
          FROM public.material_returns mr
          JOIN public.delivery_challan_items dci ON dci.challan_id = mr.original_dc_id
          JOIN public.batches b ON b.id = dci.batch_id
         WHERE mr.id = p_cn.material_return_id
           AND (
             (v_item.batch_id IS NOT NULL AND dci.batch_id = v_item.batch_id)
             OR (v_item.batch_id IS NULL AND dci.product_id = v_item.product_id)
           )
         LIMIT 1;
      END IF;

      -- 1c. Fallback to batch landed cost
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
$$;
