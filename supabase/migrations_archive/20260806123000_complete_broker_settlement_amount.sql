-- The initial settlement migration intentionally deferred the broker table
-- column to its posted journal view. Complete the direct document contract so
-- every Expense, including Customs Broker, exposes settlement_amount itself.
BEGIN;
CREATE OR REPLACE FUNCTION public.calculate_expense_settlement_amount(
  p_category text,p_amount numeric,p_ppn numeric,p_pph numeric,p_stamp numeric,
  p_bank_charges numeric,p_broker_items jsonb
)
RETURNS numeric LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN p_category='pib_import' THEN COALESCE(p_amount,0)
    WHEN p_category='import_broker' THEN COALESCE(p_amount,0)
      +COALESCE((SELECT sum(CASE
        WHEN item->>'amount' IS NOT NULL AND NULLIF(item->>'amount','')::numeric<>0
          THEN NULLIF(item->>'amount','')::numeric
        ELSE COALESCE(NULLIF(item->>'dpp_amount','')::numeric,0)
             +COALESCE(NULLIF(item->>'ppn_amount','')::numeric,0) END)
        FROM jsonb_array_elements(COALESCE(p_broker_items,'[]'::jsonb)) item),0)
      +COALESCE(p_stamp,0)-COALESCE(p_pph,0)
    ELSE COALESCE(p_amount,0)+COALESCE(p_ppn,0)-COALESCE(p_pph,0)+COALESCE(p_stamp,0)
      +CASE WHEN p_category='utilities' THEN COALESCE(p_bank_charges,0) ELSE 0 END
  END;
$$;
ALTER TABLE public.finance_expenses DROP COLUMN settlement_amount;
ALTER TABLE public.finance_expenses ADD COLUMN settlement_amount numeric
  GENERATED ALWAYS AS (public.calculate_expense_settlement_amount(
    expense_category,amount,ppn_amount,pph_amount,stamp_duty_amount,bank_charges_amount,broker_items
  )) STORED;
COMMENT ON COLUMN public.finance_expenses.settlement_amount IS
  'Canonical actual bank settlement: invoice plus reimbursable/tax components, less withholding, plus bank charges/adjustments.';
NOTIFY pgrst,'reload schema';
COMMIT;
