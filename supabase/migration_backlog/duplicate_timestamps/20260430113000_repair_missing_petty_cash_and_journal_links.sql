/*
  # Repair missing petty cash / journal links using system logic

  Goal:
  1) Find petty_cash_transactions without journal_entries and recompute journal via post_petty_cash_to_journal(...)
  2) Find fund_transfers with to_account_type='petty_cash' but no linked petty_cash_transactions,
     rebuild linked petty cash row using the same logic as create_fund_transfer_with_posting(...),
     then recompute journal via post_petty_cash_to_journal(...)
  3) Log all fixes
*/

DO $$
DECLARE
  v_pc RECORD;
  v_ft RECORD;
  v_journal_id UUID;
  v_pc_tx_id UUID;
  v_source_account_name TEXT;
BEGIN
  RAISE LOG 'Repair start: missing links (petty_cash without journal, fund_transfer without petty_cash)';

  -- 1) petty_cash without journal
  FOR v_pc IN
    SELECT pct.id
    FROM public.petty_cash_transactions pct
    LEFT JOIN public.journal_entries je
      ON je.source_type = 'petty_cash'
     AND je.source_id = pct.id
    WHERE je.id IS NULL
  LOOP
    BEGIN
      SELECT public.post_petty_cash_to_journal(v_pc.id) INTO v_journal_id;
      RAISE LOG 'Fixed petty_cash->journal: petty_cash_id=%, journal_id=%', v_pc.id, v_journal_id;
    EXCEPTION WHEN OTHERS THEN
      RAISE LOG 'Failed petty_cash->journal: petty_cash_id=%, error=%', v_pc.id, SQLERRM;
    END;
  END LOOP;

  -- 2) fund_transfer(to petty_cash) without linked petty_cash transaction
  FOR v_ft IN
    SELECT ft.*
    FROM public.fund_transfers ft
    LEFT JOIN public.petty_cash_transactions pct
      ON pct.fund_transfer_id = ft.id
    WHERE ft.to_account_type = 'petty_cash'
      AND pct.id IS NULL
  LOOP
    BEGIN
      SELECT COALESCE(ba.alias, ba.bank_name, 'Bank')
        INTO v_source_account_name
      FROM public.bank_accounts ba
      WHERE ba.id = v_ft.from_bank_account_id;

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
        v_ft.transfer_date,
        'withdraw',
        v_ft.to_amount,
        COALESCE(v_ft.description, 'Fund transfer from ' || COALESCE(v_source_account_name, 'Bank')),
        CASE WHEN v_ft.from_account_type = 'bank' THEN v_ft.from_bank_account_id ELSE NULL END,
        'Fund Transfer ' || v_ft.transfer_number,
        v_ft.id,
        v_ft.created_by
      )
      ON CONFLICT (fund_transfer_id) WHERE fund_transfer_id IS NOT NULL DO NOTHING
      RETURNING id INTO v_pc_tx_id;

      IF v_pc_tx_id IS NULL THEN
        SELECT id INTO v_pc_tx_id
        FROM public.petty_cash_transactions
        WHERE fund_transfer_id = v_ft.id
        LIMIT 1;
      END IF;

      IF v_pc_tx_id IS NOT NULL THEN
        SELECT public.post_petty_cash_to_journal(v_pc_tx_id) INTO v_journal_id;
        RAISE LOG 'Fixed fund_transfer->petty_cash->journal: fund_transfer_id=%, petty_cash_id=%, journal_id=%', v_ft.id, v_pc_tx_id, v_journal_id;
      ELSE
        RAISE LOG 'Skipped fund_transfer fix (no petty cash row created/found): fund_transfer_id=%', v_ft.id;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE LOG 'Failed fund_transfer->petty_cash->journal: fund_transfer_id=%, error=%', v_ft.id, SQLERRM;
    END;
  END LOOP;

  RAISE LOG 'Repair complete: missing links process finished';
END
$$;
