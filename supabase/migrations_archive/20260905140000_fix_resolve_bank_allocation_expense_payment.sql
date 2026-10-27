-- Fix resolve_bank_allocation_document() for expense_payment journals
-- When an expense is paid via bank, link_bank_statement_line posts a journal with source_module = 'expense_payment'.
-- resolve_bank_allocation_document must map this journal back to document_type = 'expense' and document_id = reference_id.
BEGIN;

CREATE OR REPLACE FUNCTION public.resolve_bank_allocation_document(p_journal_entry_id uuid)
RETURNS TABLE(document_type text, document_id uuid)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_module text;
  v_reference uuid;
BEGIN
  SELECT lower(COALESCE(source_module,'')), reference_id
    INTO v_module, v_reference
    FROM public.journal_entries
   WHERE id = p_journal_entry_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF v_module IN ('payment','payments','payment_voucher')
     AND v_reference IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.payment_vouchers WHERE id=v_reference) THEN
    document_type := 'payment'; document_id := v_reference; RETURN NEXT; RETURN;
  ELSIF v_module IN ('receipt','receipts','receipt_voucher')
     AND v_reference IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.receipt_vouchers WHERE id=v_reference) THEN
    document_type := 'receipt'; document_id := v_reference; RETURN NEXT; RETURN;
  ELSIF v_module IN ('expense','expenses','expense_payment')
     AND v_reference IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.finance_expenses WHERE id=v_reference) THEN
    document_type := 'expense'; document_id := v_reference; RETURN NEXT; RETURN;
  ELSIF v_module IN ('fund_transfer','fund_transfers')
     AND v_reference IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.fund_transfers WHERE id=v_reference) THEN
    document_type := 'fund_transfer'; document_id := v_reference; RETURN NEXT; RETURN;
  ELSIF v_module IN ('tax_payment','tax_payments')
     AND v_reference IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.tax_payments WHERE id=v_reference) THEN
    document_type := 'tax_payment'; document_id := v_reference; RETURN NEXT; RETURN;
  ELSIF v_module IN ('petty_cash','petty_cash_transaction')
     AND v_reference IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.petty_cash_transactions WHERE id=v_reference) THEN
    document_type := 'petty_cash'; document_id := v_reference; RETURN NEXT; RETURN;
  ELSIF v_module = 'historical_repair' AND v_reference IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.finance_expenses WHERE id=v_reference) THEN
      document_type := 'expense'; document_id := v_reference; RETURN NEXT; RETURN;
    ELSIF EXISTS (SELECT 1 FROM public.payment_vouchers WHERE id=v_reference) THEN
      document_type := 'payment'; document_id := v_reference; RETURN NEXT; RETURN;
    ELSIF EXISTS (SELECT 1 FROM public.receipt_vouchers WHERE id=v_reference) THEN
      document_type := 'receipt'; document_id := v_reference; RETURN NEXT; RETURN;
    ELSIF EXISTS (SELECT 1 FROM public.fund_transfers WHERE id=v_reference) THEN
      document_type := 'fund_transfer'; document_id := v_reference; RETURN NEXT; RETURN;
    ELSIF EXISTS (SELECT 1 FROM public.tax_payments WHERE id=v_reference) THEN
      document_type := 'tax_payment'; document_id := v_reference; RETURN NEXT; RETURN;
    ELSIF EXISTS (SELECT 1 FROM public.petty_cash_transactions WHERE id=v_reference) THEN
      document_type := 'petty_cash'; document_id := v_reference; RETURN NEXT; RETURN;
    END IF;
  END IF;

  document_type := 'journal';
  document_id := p_journal_entry_id;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_bank_allocation_document(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_bank_allocation_document(uuid) TO authenticated, service_role;

-- Repair the historical allocation created under the previous function logic for EXP/25/234.
-- Updating the allocation fires trg_sync_bank_allocation_document_identity (BEFORE) and
-- trg_sync_bank_line_from_allocation (AFTER) to synchronize document identity and matched_expense_id.
UPDATE public.bank_statement_allocations
   SET document_type = 'expense',
       document_id = '95d9d4e2-817a-4304-86ad-ab83855fea44'
 WHERE id = 'b1fff80f-e427-4d09-b4aa-a91741959097'
   AND journal_entry_id = '15197326-dc41-4beb-8ce4-9ebd1503a934';

-- Ensure line ownership and expense payment state are fully refreshed
SELECT public.sync_bank_line_allocation_owner('26b73b9d-5a89-4119-b2d5-535cd21def27');
SELECT public.recalculate_expense_payment_state('95d9d4e2-817a-4304-86ad-ab83855fea44');

-- Verification assertion
DO $$
DECLARE
  v_alloc public.bank_statement_allocations%ROWTYPE;
  v_line public.bank_statement_lines%ROWTYPE;
BEGIN
  SELECT * INTO v_alloc FROM public.bank_statement_allocations WHERE id = 'b1fff80f-e427-4d09-b4aa-a91741959097';
  IF v_alloc.document_type <> 'expense' OR v_alloc.document_id <> '95d9d4e2-817a-4304-86ad-ab83855fea44'::uuid THEN
    RAISE EXCEPTION 'Bank allocation document identity not repaired: type=%, doc=%', v_alloc.document_type, v_alloc.document_id;
  END IF;

  SELECT * INTO v_line FROM public.bank_statement_lines WHERE id = '26b73b9d-5a89-4119-b2d5-535cd21def27';
  IF v_line.matched_expense_id <> '95d9d4e2-817a-4304-86ad-ab83855fea44'::uuid THEN
    RAISE EXCEPTION 'Bank statement line matched_expense_id not synced: %', v_line.matched_expense_id;
  END IF;
END $$;

COMMIT;
