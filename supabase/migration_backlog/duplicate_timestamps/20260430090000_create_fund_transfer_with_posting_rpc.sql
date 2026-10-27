/*
  # Create atomic fund transfer RPC with petty-cash posting

  - Adds RPC create_fund_transfer_with_posting(...) that inserts fund_transfers
    and, when needed, petty_cash_transactions in a single DB transaction.
  - Adds idempotency guard for petty cash rows using unique partial index
    on petty_cash_transactions(fund_transfer_id).
*/

-- Ensure fund_transfer_id exists for linking petty cash withdrawals to fund transfers
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'petty_cash_transactions'
      AND column_name = 'fund_transfer_id'
  ) THEN
    ALTER TABLE public.petty_cash_transactions
      ADD COLUMN fund_transfer_id UUID REFERENCES public.fund_transfers(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Idempotency: one petty cash transaction per fund transfer
CREATE UNIQUE INDEX IF NOT EXISTS idx_petty_cash_transactions_fund_transfer_unique
  ON public.petty_cash_transactions (fund_transfer_id)
  WHERE fund_transfer_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.create_fund_transfer_with_posting(
  p_transfer_date DATE,
  p_from_amount NUMERIC,
  p_to_amount NUMERIC,
  p_from_account_type TEXT,
  p_to_account_type TEXT,
  p_description TEXT DEFAULT NULL,
  p_from_bank_account_id UUID DEFAULT NULL,
  p_to_bank_account_id UUID DEFAULT NULL,
  p_from_bank_statement_line_id UUID DEFAULT NULL,
  p_to_bank_statement_line_id UUID DEFAULT NULL,
  p_exchange_rate NUMERIC DEFAULT NULL,
  p_created_by UUID DEFAULT NULL
)
RETURNS public.fund_transfers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
  v_transfer_number TEXT;
  v_transfer public.fund_transfers;
  v_source_account_name TEXT;
BEGIN
  v_user_id := COALESCE(p_created_by, auth.uid());
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_transfer_number := public.generate_fund_transfer_number();

  INSERT INTO public.fund_transfers (
    transfer_number,
    transfer_date,
    amount,
    from_amount,
    to_amount,
    exchange_rate,
    from_account_type,
    to_account_type,
    from_bank_account_id,
    to_bank_account_id,
    from_bank_statement_line_id,
    to_bank_statement_line_id,
    description,
    created_by
  ) VALUES (
    v_transfer_number,
    p_transfer_date,
    p_from_amount,
    p_from_amount,
    p_to_amount,
    p_exchange_rate,
    p_from_account_type,
    p_to_account_type,
    CASE WHEN p_from_account_type = 'bank' THEN p_from_bank_account_id ELSE NULL END,
    CASE WHEN p_to_account_type = 'bank' THEN p_to_bank_account_id ELSE NULL END,
    p_from_bank_statement_line_id,
    p_to_bank_statement_line_id,
    NULLIF(p_description, ''),
    v_user_id
  )
  RETURNING * INTO v_transfer;

  -- If destination is petty cash, create the linked petty cash withdrawal atomically.
  -- Existing petty_cash trigger chain (journal posting, etc.) stays unchanged.
  IF v_transfer.to_account_type = 'petty_cash' THEN
    SELECT COALESCE(ba.alias, ba.bank_name, 'Bank')
      INTO v_source_account_name
    FROM public.bank_accounts ba
    WHERE ba.id = v_transfer.from_bank_account_id;

    INSERT INTO public.petty_cash_transactions (
      transaction_date,
      transaction_type,
      amount,
      description,
      bank_account_id,
      source,
      fund_transfer_id,
      created_by
    ) VALUES (
      v_transfer.transfer_date,
      'withdraw',
      v_transfer.to_amount,
      COALESCE(v_transfer.description, 'Fund transfer from ' || COALESCE(v_source_account_name, 'Bank')),
      CASE WHEN v_transfer.from_account_type = 'bank' THEN v_transfer.from_bank_account_id ELSE NULL END,
      'Fund Transfer ' || v_transfer.transfer_number,
      v_transfer.id,
      v_transfer.created_by
    )
    ON CONFLICT (fund_transfer_id) DO NOTHING;
  END IF;

  RETURN v_transfer;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_fund_transfer_with_posting(
  DATE, NUMERIC, NUMERIC, TEXT, TEXT, TEXT, UUID, UUID, UUID, UUID, NUMERIC, UUID
) TO authenticated;

COMMENT ON FUNCTION public.create_fund_transfer_with_posting(
  DATE, NUMERIC, NUMERIC, TEXT, TEXT, TEXT, UUID, UUID, UUID, UUID, NUMERIC, UUID
) IS
'Creates fund_transfers and petty cash withdrawal (for to_account_type=petty_cash) in one transaction. Idempotent petty cash insertion via unique fund_transfer_id index.';
