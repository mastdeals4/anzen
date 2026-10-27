-- Eight historical bank withdrawals carry both the canonical fund-transfer FK
-- and its derived petty-cash receipt FK. They are one source chain, not two
-- independent allocations. Keep the bank-facing fund-transfer allocation.

BEGIN;

DELETE FROM public.bank_statement_allocations a
USING public.bank_statement_lines b, public.petty_cash_transactions pc
WHERE a.bank_statement_line_id=b.id
  AND a.document_type='petty_cash'
  AND pc.id=a.document_id
  AND b.matched_fund_transfer_id IS NOT NULL
  AND pc.fund_transfer_id=b.matched_fund_transfer_id
  AND EXISTS (
    SELECT 1 FROM public.bank_statement_allocations ft
    WHERE ft.bank_statement_line_id=b.id
      AND ft.document_type='fund_transfer'
      AND ft.document_id=b.matched_fund_transfer_id
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.bank_statement_lines b
    JOIN public.bank_statement_allocations a ON a.bank_statement_line_id=b.id
    GROUP BY b.id
    HAVING sum(a.allocation_amount)>COALESCE(NULLIF(b.debit_amount,0),b.credit_amount,0)+0.01
  ) THEN RAISE EXCEPTION 'Bank allocation backfill remains over-allocated'; END IF;
END $$;

COMMIT;
