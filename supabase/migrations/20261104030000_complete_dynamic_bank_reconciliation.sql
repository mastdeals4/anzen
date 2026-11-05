-- 20261104030000_complete_dynamic_bank_reconciliation.sql
-- SAPJ ERP: Complete Dynamic Bank Reconciliation, FX Accounting & Month-End Monetary Revaluation Engine
-- 1. Create fx_revaluations and fx_revaluation_lines tables with RLS and audit trails
-- 2. Seed historical October 2026 revaluation referencing JE2611-0314 (preserving carry-forward basis)
-- 3. Implement run_fx_month_end_revaluation RPC with idempotency guard for October
-- 4. Restore realized FX gain/loss and carry-forward AP relief in post_payment_voucher
-- 5. Support cross-currency transfers and dual-currency bank accounts in post_fund_transfer_journal
-- 6. Implement automated multi-document bank reconciliation matching in auto_reconcile_bank_statement & auto_match_bank_statement_line

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 1: FX REVALUATION TABLES
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.fx_revaluations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  revaluation_number TEXT NOT NULL UNIQUE,
  revaluation_date DATE NOT NULL,
  period_name TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  closing_rate NUMERIC(18,4) NOT NULL,
  rate_source TEXT NOT NULL DEFAULT 'Bank Indonesia JISDOR',
  total_gain_loss NUMERIC(18,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('draft', 'posted', 'reversed')),
  journal_entry_id UUID REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fx_revaluations_period ON public.fx_revaluations(period_name);
CREATE INDEX IF NOT EXISTS idx_fx_revaluations_date ON public.fx_revaluations(revaluation_date);

CREATE TABLE IF NOT EXISTS public.fx_revaluation_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  revaluation_id UUID NOT NULL REFERENCES public.fx_revaluations(id) ON DELETE CASCADE,
  line_type TEXT NOT NULL CHECK (line_type IN ('bank_asset', 'ap_payable', 'ar_receivable')),
  bank_account_id UUID REFERENCES public.bank_accounts(id) ON DELETE SET NULL,
  purchase_invoice_id UUID REFERENCES public.purchase_invoices(id) ON DELETE SET NULL,
  sales_invoice_id UUID REFERENCES public.sales_invoices(id) ON DELETE SET NULL,
  supplier_id UUID REFERENCES public.suppliers(id) ON DELETE SET NULL,
  customer_id UUID REFERENCES public.customers(id) ON DELETE SET NULL,
  foreign_amount NUMERIC(18,2) NOT NULL,
  carrying_rate NUMERIC(18,4) NOT NULL,
  carrying_amount_idr NUMERIC(18,2) NOT NULL,
  revalued_rate NUMERIC(18,4) NOT NULL,
  revalued_amount_idr NUMERIC(18,2) NOT NULL,
  fx_difference NUMERIC(18,2) NOT NULL,
  gain_loss_type TEXT NOT NULL CHECK (gain_loss_type IN ('unrealized_gain', 'unrealized_loss')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fx_rev_lines_reval_id ON public.fx_revaluation_lines(revaluation_id);
CREATE INDEX IF NOT EXISTS idx_fx_rev_lines_pi_id ON public.fx_revaluation_lines(purchase_invoice_id);
CREATE INDEX IF NOT EXISTS idx_fx_rev_lines_bank_id ON public.fx_revaluation_lines(bank_account_id);

ALTER TABLE public.fx_revaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fx_revaluation_lines ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'fx_revaluations' AND policyname = 'Allow select on fx_revaluations for authenticated'
  ) THEN
    CREATE POLICY "Allow select on fx_revaluations for authenticated"
      ON public.fx_revaluations FOR SELECT TO authenticated USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'fx_revaluations' AND policyname = 'Allow insert on fx_revaluations for finance'
  ) THEN
    CREATE POLICY "Allow insert on fx_revaluations for finance"
      ON public.fx_revaluations FOR INSERT TO authenticated WITH CHECK (
        EXISTS (SELECT 1 FROM public.user_profiles up WHERE up.id = auth.uid() AND up.role IN ('admin', 'director', 'accounts'))
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'fx_revaluation_lines' AND policyname = 'Allow select on fx_revaluation_lines for authenticated'
  ) THEN
    CREATE POLICY "Allow select on fx_revaluation_lines for authenticated"
      ON public.fx_revaluation_lines FOR SELECT TO authenticated USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'fx_revaluation_lines' AND policyname = 'Allow insert on fx_revaluation_lines for finance'
  ) THEN
    CREATE POLICY "Allow insert on fx_revaluation_lines for finance"
      ON public.fx_revaluation_lines FOR INSERT TO authenticated WITH CHECK (
        EXISTS (SELECT 1 FROM public.user_profiles up WHERE up.id = auth.uid() AND up.role IN ('admin', 'director', 'accounts'))
      );
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 2: SEED OCTOBER 2026 REVALUATION (JE2611-0314 PRESERVATION)
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_oct_je_id UUID;
  v_reval_id UUID;
  v_bca_usd_id UUID;
  v_rec RECORD;
BEGIN
  SELECT id INTO v_oct_je_id FROM public.journal_entries WHERE entry_number = 'JE2611-0314' LIMIT 1;
  SELECT id INTO v_bca_usd_id FROM public.bank_accounts WHERE currency = 'USD' LIMIT 1;

  IF v_oct_je_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.fx_revaluations WHERE period_name = '2026-10') THEN
    INSERT INTO public.fx_revaluations (
      revaluation_number,
      revaluation_date,
      period_name,
      currency,
      closing_rate,
      rate_source,
      total_gain_loss,
      status,
      journal_entry_id
    ) VALUES (
      'REV-2610-0001',
      '2026-10-31',
      '2026-10',
      'USD',
      18138.00,
      'Bank Indonesia JISDOR',
      -106796488.20,
      'posted',
      v_oct_je_id
    ) RETURNING id INTO v_reval_id;

    -- Bank Asset Line: USD 5,439.00, carrying Rp77,050,650.00 revalued to Rp98,652,582.00
    IF v_bca_usd_id IS NOT NULL THEN
      INSERT INTO public.fx_revaluation_lines (
        revaluation_id, line_type, bank_account_id, foreign_amount, carrying_rate,
        carrying_amount_idr, revalued_rate, revalued_amount_idr, fx_difference, gain_loss_type
      ) VALUES (
        v_reval_id, 'bank_asset', v_bca_usd_id, 5439.00, 14166.3265,
        77050650.00, 18138.0000, 98652582.00, 21601932.00, 'unrealized_gain'
      );
    END IF;

    -- 9 Open USD Purchase Invoices lines
    FOR v_rec IN (
      SELECT id, supplier_id, COALESCE(balance_amount, total_amount) as bal_usd, exchange_rate
      FROM public.purchase_invoices
      WHERE currency = 'USD'
        AND status != 'paid'
        AND COALESCE(balance_amount, total_amount) > 0
        AND invoice_date <= '2026-10-31'
      ORDER BY invoice_date
    ) LOOP
      INSERT INTO public.fx_revaluation_lines (
        revaluation_id, line_type, purchase_invoice_id, supplier_id, foreign_amount,
        carrying_rate, carrying_amount_idr, revalued_rate, revalued_amount_idr,
        fx_difference, gain_loss_type
      ) VALUES (
        v_reval_id, 'ap_payable', v_rec.id, v_rec.supplier_id, v_rec.bal_usd,
        v_rec.exchange_rate, (v_rec.bal_usd * v_rec.exchange_rate),
        18138.0000, (v_rec.bal_usd * 18138.0000),
        ((v_rec.bal_usd * 18138.0000) - (v_rec.bal_usd * v_rec.exchange_rate)),
        'unrealized_loss'
      );
    END LOOP;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 3: AUTOMATED MONTH-END FX REVALUATION RPC
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.run_fx_month_end_revaluation(
  p_period_date DATE,
  p_closing_rate NUMERIC,
  p_rate_source TEXT DEFAULT 'Bank Indonesia JISDOR',
  p_created_by UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_period_name TEXT;
  v_existing_reval RECORD;
  v_reval_id UUID;
  v_reval_num TEXT;
  v_je_id UUID;
  v_je_entry_num TEXT;
  v_actor UUID;
  v_fx_gain_coa UUID;
  v_fx_loss_coa UUID;
  v_ap_coa UUID;
  v_total_unrealized_gain NUMERIC := 0;
  v_total_unrealized_loss NUMERIC := 0;
  v_total_je_debit NUMERIC := 0;
  v_total_je_credit NUMERIC := 0;
  v_line_no INTEGER := 1;
  v_ba RECORD;
  v_pi RECORD;
  v_bank_carrying_idr NUMERIC;
  v_bank_revalued_idr NUMERIC;
  v_bank_diff NUMERIC;
  v_pi_carrying_rate NUMERIC;
  v_pi_carrying_idr NUMERIC;
  v_pi_revalued_idr NUMERIC;
  v_pi_diff NUMERIC;
  v_inserted_lines INTEGER := 0;
BEGIN
  IF auth.role() = 'authenticated' AND auth.uid() IS NOT NULL THEN
    PERFORM public._sec_check_finance_role();
  END IF;

  v_actor := COALESCE(auth.uid(), p_created_by);
  v_period_name := to_char(p_period_date, 'YYYY-MM');

  IF p_closing_rate IS NULL OR p_closing_rate <= 0 THEN
    RAISE EXCEPTION 'A positive closing exchange rate is required for FX revaluation';
  END IF;

  -- 1. Idempotency Guard: October 2026 protection
  IF v_period_name = '2026-10' OR p_period_date <= '2026-10-31' THEN
    SELECT * INTO v_existing_reval FROM public.fx_revaluations WHERE period_name = '2026-10' LIMIT 1;
    IF v_existing_reval.id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'success', true,
        'message', 'October 2026 revaluation is authoritative and preserved (JE2611-0314). No duplicates created.',
        'revaluation_id', v_existing_reval.id,
        'revaluation_number', v_existing_reval.revaluation_number,
        'journal_entry_id', v_existing_reval.journal_entry_id,
        'closing_rate', v_existing_reval.closing_rate,
        'is_existing', true
      );
    END IF;
  END IF;

  -- 2. Guard against duplicate revaluation for any period
  SELECT * INTO v_existing_reval FROM public.fx_revaluations WHERE period_name = v_period_name AND status = 'posted' LIMIT 1;
  IF v_existing_reval.id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', true,
      'message', 'Revaluation for period ' || v_period_name || ' already exists (' || v_existing_reval.revaluation_number || ').',
      'revaluation_id', v_existing_reval.id,
      'revaluation_number', v_existing_reval.revaluation_number,
      'journal_entry_id', v_existing_reval.journal_entry_id,
      'closing_rate', v_existing_reval.closing_rate,
      'is_existing', true
    );
  END IF;

  -- Resolve Standard Chart of Accounts
  SELECT id INTO v_fx_gain_coa FROM public.chart_of_accounts WHERE code = '4930' AND is_active = true LIMIT 1;
  SELECT id INTO v_fx_loss_coa FROM public.chart_of_accounts WHERE code = '7300' AND is_active = true LIMIT 1;
  SELECT id INTO v_ap_coa FROM public.chart_of_accounts WHERE code = '2110' AND is_active = true LIMIT 1;

  IF v_fx_gain_coa IS NULL OR v_fx_loss_coa IS NULL OR v_ap_coa IS NULL THEN
    RAISE EXCEPTION 'Required GL accounts (4930 FX Gain, 7300 FX Loss, 2110 AP) could not be resolved';
  END IF;

  -- Generate Revaluation Number
  v_reval_num := 'REV-' || to_char(p_period_date, 'YYMM') || '-0001';

  INSERT INTO public.fx_revaluations (
    revaluation_number, revaluation_date, period_name, currency, closing_rate,
    rate_source, status, created_by
  ) VALUES (
    v_reval_num, p_period_date, v_period_name, 'USD', p_closing_rate,
    p_rate_source, 'draft', v_actor
  ) RETURNING id INTO v_reval_id;

  -- 3. Revalue USD Bank Assets
  FOR v_ba IN (
    SELECT ba.id, ba.account_name, ba.currency, ba.current_balance, ba.coa_id
    FROM public.bank_accounts ba
    WHERE upper(ba.currency) = 'USD' AND ba.is_active = true
  ) LOOP
    IF v_ba.current_balance > 0 AND v_ba.coa_id IS NOT NULL THEN
      -- Get current functional IDR carrying balance from GL
      SELECT COALESCE(SUM(jel.debit - jel.credit), 0)
      INTO v_bank_carrying_idr
      FROM public.journal_entry_lines jel
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
      WHERE jel.account_id = v_ba.coa_id
        AND je.is_posted = true
        AND NOT COALESCE(je.is_reversed, false)
        AND je.entry_date <= p_period_date;

      v_bank_revalued_idr := round((v_ba.current_balance * p_closing_rate), 2);
      v_bank_diff := v_bank_revalued_idr - v_bank_carrying_idr;

      IF abs(v_bank_diff) >= 0.01 THEN
        INSERT INTO public.fx_revaluation_lines (
          revaluation_id, line_type, bank_account_id, foreign_amount,
          carrying_rate, carrying_amount_idr, revalued_rate, revalued_amount_idr,
          fx_difference, gain_loss_type
        ) VALUES (
          v_reval_id, 'bank_asset', v_ba.id, v_ba.current_balance,
          CASE WHEN v_ba.current_balance > 0 THEN round(v_bank_carrying_idr / v_ba.current_balance, 4) ELSE p_closing_rate END,
          v_bank_carrying_idr, p_closing_rate, v_bank_revalued_idr,
          abs(v_bank_diff),
          CASE WHEN v_bank_diff > 0 THEN 'unrealized_gain' ELSE 'unrealized_loss' END
        );
        v_inserted_lines := v_inserted_lines + 1;

        IF v_bank_diff > 0 THEN
          v_total_unrealized_gain := v_total_unrealized_gain + v_bank_diff;
        ELSE
          v_total_unrealized_loss := v_total_unrealized_loss + abs(v_bank_diff);
        END IF;
      END IF;
    END IF;
  END LOOP;

  -- 4. Revalue Open USD Payables (Purchase Invoices)
  FOR v_pi IN (
    SELECT pi.id, pi.invoice_number, pi.supplier_id, pi.exchange_rate,
           COALESCE(pi.balance_amount, pi.total_amount) as remaining_usd
    FROM public.purchase_invoices pi
    WHERE upper(pi.currency) = 'USD'
      AND pi.status != 'paid'
      AND COALESCE(pi.balance_amount, pi.total_amount) > 0
      AND pi.invoice_date <= p_period_date
    ORDER BY pi.invoice_date
  ) LOOP
    -- Carry-forward rate from latest posted revaluation or original recognition rate
    SELECT COALESCE(
      (SELECT frl.revalued_rate
       FROM public.fx_revaluation_lines frl
       JOIN public.fx_revaluations fr ON fr.id = frl.revaluation_id
       WHERE frl.purchase_invoice_id = v_pi.id
         AND fr.status = 'posted'
         AND fr.revaluation_date < p_period_date
       ORDER BY fr.revaluation_date DESC, fr.created_at DESC
       LIMIT 1),
      v_pi.exchange_rate,
      p_closing_rate
    ) INTO v_pi_carrying_rate;

    v_pi_carrying_idr := round((v_pi.remaining_usd * v_pi_carrying_rate), 2);
    v_pi_revalued_idr := round((v_pi.remaining_usd * p_closing_rate), 2);
    v_pi_diff := v_pi_revalued_idr - v_pi_carrying_idr;

    IF abs(v_pi_diff) >= 0.01 THEN
      INSERT INTO public.fx_revaluation_lines (
        revaluation_id, line_type, purchase_invoice_id, supplier_id, foreign_amount,
        carrying_rate, carrying_amount_idr, revalued_rate, revalued_amount_idr,
        fx_difference, gain_loss_type
      ) VALUES (
        v_reval_id, 'ap_payable', v_pi.id, v_pi.supplier_id, v_pi.remaining_usd,
        v_pi_carrying_rate, v_pi_carrying_idr, p_closing_rate, v_pi_revalued_idr,
        abs(v_pi_diff),
        CASE WHEN v_pi_diff > 0 THEN 'unrealized_loss' ELSE 'unrealized_gain' END
      );
      v_inserted_lines := v_inserted_lines + 1;

      IF v_pi_diff > 0 THEN
        v_total_unrealized_loss := v_total_unrealized_loss + v_pi_diff;
      ELSE
        v_total_unrealized_gain := v_total_unrealized_gain + abs(v_pi_diff);
      END IF;
    END IF;
  END LOOP;

  -- 5. Create Accounting Journal if adjustments exist
  IF v_total_unrealized_gain > 0 OR v_total_unrealized_loss > 0 THEN
    v_je_entry_num := public.next_journal_entry_number();
    v_total_je_debit := v_total_unrealized_loss + v_total_unrealized_gain;
    v_total_je_credit := v_total_je_debit;

    INSERT INTO public.journal_entries (
      entry_number, entry_date, source_module, reference_id, reference_number,
      description, total_debit, total_credit, is_posted, posted_by, created_by,
      transaction_currency, functional_currency, exchange_rate
    ) VALUES (
      v_je_entry_num, p_period_date, 'fx_revaluation', v_reval_id, v_reval_num,
      'Month-End Foreign Currency Revaluation for ' || v_period_name || ' at ' || p_rate_source || ' Rp' || round(p_closing_rate, 0)::text || '/USD',
      v_total_je_debit, v_total_je_credit, true, v_actor, v_actor,
      'USD', 'IDR', p_closing_rate
    ) RETURNING id INTO v_je_id;

    -- Lines:
    -- Loss portion: Dr GL 7300, Cr Accounts (Bank or AP)
    IF v_total_unrealized_loss > 0 THEN
      INSERT INTO public.journal_entry_lines (
        journal_entry_id, line_number, account_id, description,
        debit, credit, transaction_currency, transaction_debit, transaction_credit, exchange_rate
      ) VALUES (
        v_je_id, v_line_no, v_fx_loss_coa,
        'Unrealized FX Loss (' || v_period_name || ' Revaluation at Rp' || round(p_closing_rate, 0)::text || '/USD)',
        v_total_unrealized_loss, 0, 'IDR', v_total_unrealized_loss, 0, 1
      );
      v_line_no := v_line_no + 1;
    END IF;

    -- Gain portion: Cr GL 4930, Dr Accounts (Bank or AP)
    IF v_total_unrealized_gain > 0 THEN
      INSERT INTO public.journal_entry_lines (
        journal_entry_id, line_number, account_id, description,
        debit, credit, transaction_currency, transaction_debit, transaction_credit, exchange_rate
      ) VALUES (
        v_je_id, v_line_no, v_fx_gain_coa,
        'Unrealized FX Gain (' || v_period_name || ' Revaluation at Rp' || round(p_closing_rate, 0)::text || '/USD)',
        0, v_total_unrealized_gain, 'IDR', 0, v_total_unrealized_gain, 1
      );
      v_line_no := v_line_no + 1;
    END IF;

    -- Balance against Bank Assets & AP:
    FOR v_ba IN (
      SELECT frl.line_type, frl.fx_difference, frl.gain_loss_type, ba.coa_id
      FROM public.fx_revaluation_lines frl
      JOIN public.bank_accounts ba ON ba.id = frl.bank_account_id
      WHERE frl.revaluation_id = v_reval_id AND frl.line_type = 'bank_asset'
    ) LOOP
      INSERT INTO public.journal_entry_lines (
        journal_entry_id, line_number, account_id, description,
        debit, credit, transaction_currency, transaction_debit, transaction_credit, exchange_rate
      ) VALUES (
        v_je_id, v_line_no, v_ba.coa_id,
        'USD Bank Asset Revaluation - ' || v_period_name,
        CASE WHEN v_ba.gain_loss_type = 'unrealized_gain' THEN v_ba.fx_difference ELSE 0 END,
        CASE WHEN v_ba.gain_loss_type = 'unrealized_loss' THEN v_ba.fx_difference ELSE 0 END,
        'IDR',
        CASE WHEN v_ba.gain_loss_type = 'unrealized_gain' THEN v_ba.fx_difference ELSE 0 END,
        CASE WHEN v_ba.gain_loss_type = 'unrealized_loss' THEN v_ba.fx_difference ELSE 0 END,
        1
      );
      v_line_no := v_line_no + 1;
    END LOOP;

    -- AP Payables adjustment:
    FOR v_pi IN (
      SELECT frl.supplier_id, SUM(CASE WHEN frl.gain_loss_type = 'unrealized_loss' THEN frl.fx_difference ELSE -frl.fx_difference END) as net_ap_diff
      FROM public.fx_revaluation_lines frl
      WHERE frl.revaluation_id = v_reval_id AND frl.line_type = 'ap_payable'
      GROUP BY frl.supplier_id
    ) LOOP
      IF v_pi.net_ap_diff <> 0 THEN
        INSERT INTO public.journal_entry_lines (
          journal_entry_id, line_number, account_id, description,
          debit, credit, supplier_id, transaction_currency, transaction_debit, transaction_credit, exchange_rate
        ) VALUES (
          v_je_id, v_line_no, v_ap_coa,
          'Accounts Payable USD Revaluation - ' || v_period_name,
          CASE WHEN v_pi.net_ap_diff < 0 THEN abs(v_pi.net_ap_diff) ELSE 0 END,
          CASE WHEN v_pi.net_ap_diff > 0 THEN v_pi.net_ap_diff ELSE 0 END,
          v_pi.supplier_id, 'IDR',
          CASE WHEN v_pi.net_ap_diff < 0 THEN abs(v_pi.net_ap_diff) ELSE 0 END,
          CASE WHEN v_pi.net_ap_diff > 0 THEN v_pi.net_ap_diff ELSE 0 END,
          1
        );
        v_line_no := v_line_no + 1;
      END IF;
    END LOOP;
  END IF;

  UPDATE public.fx_revaluations
  SET status = 'posted',
      journal_entry_id = v_je_id,
      total_gain_loss = (v_total_unrealized_gain - v_total_unrealized_loss),
      updated_at = now()
  WHERE id = v_reval_id;

  RETURN jsonb_build_object(
    'success', true,
    'message', 'Month-end revaluation completed successfully for ' || v_period_name,
    'revaluation_id', v_reval_id,
    'revaluation_number', v_reval_num,
    'journal_entry_id', v_je_id,
    'closing_rate', p_closing_rate,
    'unrealized_gain', v_total_unrealized_gain,
    'unrealized_loss', v_total_unrealized_loss,
    'lines_count', v_inserted_lines
  );
END;
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 4: POST_PAYMENT_VOUCHER WITH CARRY-FORWARD AP & REALIZED FX
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.post_payment_voucher(p_pv_id uuid, p_posted_by uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pv RECORD;
  v_entry text;
  v_je uuid;
  v_bank_coa uuid;
  v_debit_coa uuid;
  v_charge_coa uuid;
  v_diff_coa uuid;
  v_pph_coa uuid;
  v_fx_gain_coa uuid;
  v_fx_loss_coa uuid;
  v_total_debit numeric := 0;
  v_total_credit numeric := 0;
  v_line int := 1;
  v_actual_poster uuid;
  v_party_type text;
  v_gross numeric;
  v_actual numeric;
  v_settle_diff numeric;
  v_rate numeric := 1;
  v_charge_amt numeric := 0;
  v_pph_bank numeric := 0;
  v_bank_active boolean;
  v_bank_is_header boolean;
  v_bank_currency text;
  v_invoice_currency text;
  v_avail_advances numeric := 0;
  v_usd_bank_carrying_rate numeric := 18138;
  v_alloc_usd numeric := 0;
  v_alloc_carrying_idr numeric := 0;
  v_alloc_settle_idr numeric := 0;
  v_realized_fx numeric := 0;
  v_fx_loss_amt numeric := 0;
  v_fx_gain_amt numeric := 0;
  v_ap_relief_idr numeric := 0;
  v_bank_credit_idr numeric := 0;
BEGIN
  IF auth.role() = 'authenticated' AND auth.uid() IS NOT NULL THEN
    PERFORM public._sec_check_finance_role();
  ELSIF auth.role() = 'anon' THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  v_actual_poster := COALESCE(auth.uid(), p_posted_by);

  SELECT * INTO v_pv FROM public.payment_vouchers WHERE id = p_pv_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment voucher % not found', p_pv_id;
  END IF;

  IF v_pv.is_posted THEN
    RAISE EXCEPTION 'Payment voucher % is already posted', v_pv.voucher_number;
  END IF;

  v_party_type := lower(COALESCE(v_pv.party_type, 'supplier'));
  v_gross := COALESCE(v_pv.amount, 0);
  v_actual := COALESCE(v_pv.actual_bank_debit, v_pv.bank_amount, v_gross);
  v_settle_diff := COALESCE(v_pv.settlement_discount, 0);
  v_charge_amt := COALESCE(v_pv.bank_charge, 0);
  v_pph_bank := COALESCE(v_pv.pph_amount, 0);
  v_rate := COALESCE(NULLIF(v_pv.exchange_rate, 0), 1);
  v_bank_currency := upper(COALESCE(v_pv.payment_currency, 'IDR'));
  v_invoice_currency := upper(COALESCE(v_pv.invoice_currency, v_pv.payment_currency, 'IDR'));

  -- Concurrency & Balance Validation for Customer Refund
  IF v_party_type = 'customer' AND v_pv.customer_id IS NOT NULL THEN
    PERFORM id FROM public.customers WHERE id = v_pv.customer_id FOR UPDATE;

    SELECT COALESCE(SUM(
      (rv.amount * COALESCE(rv.exchange_rate, 1)) - COALESCE(va.allocated, 0)
    ), 0)
    INTO v_avail_advances
    FROM public.receipt_vouchers rv
    LEFT JOIN (
      SELECT receipt_voucher_id, SUM(allocated_amount) as allocated
      FROM public.voucher_allocations
      GROUP BY receipt_voucher_id
    ) va ON va.receipt_voucher_id = rv.id
    WHERE rv.customer_id = v_pv.customer_id
      AND rv.is_posted = true;

    v_avail_advances := v_avail_advances - COALESCE((
      SELECT SUM(
        (pv2.amount * COALESCE(pv2.exchange_rate, 1)) + COALESCE(pv2.settlement_discount, 0)
      )
      FROM public.payment_vouchers pv2
      WHERE pv2.customer_id = v_pv.customer_id
        AND pv2.party_type = 'customer'
        AND pv2.is_posted = true
        AND pv2.id <> p_pv_id
    ), 0);

    IF (v_actual + v_settle_diff) > (v_avail_advances + 0.01) THEN
      RAISE EXCEPTION 'Customer refund total settlement (%) exceeds available refundable advance/credit balance (%)',
        (v_actual + v_settle_diff), v_avail_advances;
    END IF;
  END IF;

  -- Resolve Bank / Cash Credit Account
  IF v_pv.payment_method IN ('bank_transfer', 'check', 'giro') THEN
    IF v_pv.bank_account_id IS NULL THEN
      RAISE EXCEPTION 'Bank account is required for % payments (voucher %)', v_pv.payment_method, v_pv.voucher_number;
    END IF;

    SELECT ba.coa_id, coa.is_active, coa.is_header, upper(ba.currency)
    INTO v_bank_coa, v_bank_active, v_bank_is_header, v_bank_currency
    FROM public.bank_accounts ba
    LEFT JOIN public.chart_of_accounts coa ON coa.id = ba.coa_id
    WHERE ba.id = v_pv.bank_account_id;

    IF v_bank_coa IS NULL THEN
      RAISE EXCEPTION 'Selected bank account % has no General Ledger account linked', v_pv.bank_account_id;
    END IF;
    IF NOT COALESCE(v_bank_active, false) THEN
      RAISE EXCEPTION 'Linked bank GL account % is inactive', v_bank_coa;
    END IF;
    IF COALESCE(v_bank_is_header, false) THEN
      RAISE EXCEPTION 'Linked bank GL account % is a header account — leaf required', v_bank_coa;
    END IF;

    -- If paying from USD bank, determine effective USD carrying rate
    IF v_bank_currency = 'USD' THEN
      SELECT 
        CASE 
          WHEN ba.current_balance > 0 THEN 
            COALESCE((
              SELECT SUM(jel.debit - jel.credit)
              FROM public.journal_entry_lines jel
              JOIN public.journal_entries je ON je.id = jel.journal_entry_id
              WHERE jel.account_id = ba.coa_id AND je.is_posted = true AND NOT COALESCE(je.is_reversed, false)
            ) / ba.current_balance, 18138.00)
          ELSE 18138.00
        END
      INTO v_usd_bank_carrying_rate
      FROM public.bank_accounts ba WHERE ba.id = v_pv.bank_account_id;
    END IF;

  ELSIF v_pv.payment_method = 'cash' THEN
    SELECT id, is_active, is_header INTO v_bank_coa, v_bank_active, v_bank_is_header
    FROM public.chart_of_accounts
    WHERE code = '1101' AND is_active = true AND is_header = false LIMIT 1;

    IF v_bank_coa IS NULL THEN
      SELECT id, is_active, is_header INTO v_bank_coa, v_bank_active, v_bank_is_header
      FROM public.chart_of_accounts
      WHERE code = '1102' AND is_active = true AND is_header = false LIMIT 1;
    END IF;

    IF v_bank_coa IS NULL THEN
      RAISE EXCEPTION 'No active postable Cash/Petty Cash GL account found (GL 1101/1102)';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported payment method: % for payment voucher %', v_pv.payment_method, v_pv.voucher_number;
  END IF;

  -- Resolve Standard Chart of Accounts
  SELECT id INTO v_fx_loss_coa FROM public.chart_of_accounts WHERE code = '7300' AND is_active = true LIMIT 1;
  SELECT id INTO v_fx_gain_coa FROM public.chart_of_accounts WHERE code = '4930' AND is_active = true LIMIT 1;

  -- Resolve Debit Control Account
  IF v_party_type = 'supplier' THEN
    IF v_pv.payment_purpose = 'supplier_advance' OR v_pv.settlement_against = 'advance' THEN
      IF v_pv.coa_account_id IS NOT NULL THEN
        v_debit_coa := v_pv.coa_account_id;
      ELSE
        SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '1170' AND is_active = true AND is_header = false LIMIT 1;
      END IF;
    ELSE
      IF v_pv.coa_account_id IS NOT NULL THEN
        v_debit_coa := v_pv.coa_account_id;
      ELSE
        SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '2110' AND is_active = true AND is_header = false LIMIT 1;
      END IF;
    END IF;

    -- Compute Multi-Document Carrying Value vs Settlement Value with Carry-Forward Rate
    SELECT 
      COALESCE(SUM(va.allocated_amount), 0),
      COALESCE(SUM(va.allocated_amount * COALESCE(
        (SELECT frl.revalued_rate
         FROM public.fx_revaluation_lines frl
         JOIN public.fx_revaluations fr ON fr.id = frl.revaluation_id
         WHERE frl.purchase_invoice_id = va.purchase_invoice_id
           AND fr.status = 'posted'
           AND fr.revaluation_date <= v_pv.voucher_date
         ORDER BY fr.revaluation_date DESC, fr.created_at DESC
         LIMIT 1),
        pi.exchange_rate,
        v_rate
      )), 0)
    INTO v_alloc_usd, v_alloc_carrying_idr
    FROM public.voucher_allocations va
    JOIN public.purchase_invoices pi ON pi.id = va.purchase_invoice_id
    WHERE va.payment_voucher_id = p_pv_id;

    IF v_alloc_usd > 0 THEN
      -- AP relief is strictly at carrying IDR
      v_ap_relief_idr := v_alloc_carrying_idr + ((v_gross - v_alloc_usd) * v_rate);
      
      IF v_bank_currency = 'USD' THEN
        -- USD bank settlement: Bank is relieved at bank's carrying rate
        v_alloc_settle_idr := (v_gross * v_usd_bank_carrying_rate);
        v_bank_credit_idr := (v_actual * v_usd_bank_carrying_rate);
      ELSE
        -- IDR bank settlement: Bank is relieved at actual IDR debited (v_actual)
        v_alloc_settle_idr := (v_gross * v_rate);
        v_bank_credit_idr := v_actual;
      END IF;

      v_realized_fx := v_alloc_settle_idr - v_ap_relief_idr;

      IF v_realized_fx > 0 THEN
        v_fx_loss_amt := v_realized_fx;
      ELSIF v_realized_fx < 0 THEN
        v_fx_gain_amt := abs(v_realized_fx);
      END IF;
    ELSE
      -- Unallocated / Advance payment
      v_ap_relief_idr := (v_gross + v_settle_diff) * v_rate;
      v_bank_credit_idr := v_actual * (CASE WHEN v_bank_currency = 'USD' THEN v_usd_bank_carrying_rate ELSE 1 END);
      v_fx_loss_amt := 0;
      v_fx_gain_amt := 0;
    END IF;

  ELSIF v_party_type = 'customer' THEN
    IF v_pv.coa_account_id IS NOT NULL THEN
      v_debit_coa := v_pv.coa_account_id;
    ELSE
      SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '2111' AND is_active = true AND is_header = false LIMIT 1;
      IF v_debit_coa IS NULL THEN
        SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '1120' AND is_active = true AND is_header = false LIMIT 1;
      END IF;
    END IF;
    v_ap_relief_idr := (v_gross + v_settle_diff) * v_rate;
    v_bank_credit_idr := (v_actual + v_settle_diff) * v_rate;

  ELSIF v_party_type = 'employee' THEN
    IF v_pv.payment_purpose = 'salary_advance' THEN
      SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '1160' AND is_active = true AND is_header = false LIMIT 1;
    ELSE
      SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '5101' AND is_active = true AND is_header = false LIMIT 1;
    END IF;
    v_ap_relief_idr := (v_gross + v_settle_diff) * v_rate;
    v_bank_credit_idr := (v_actual + v_settle_diff) * v_rate;

  ELSIF v_party_type = 'director' THEN
    DECLARE
      v_dir_loan_acc uuid;
    BEGIN
      SELECT loan_account_id INTO v_dir_loan_acc FROM public.directors WHERE id = v_pv.staff_id;
      IF v_dir_loan_acc IS NOT NULL THEN
        v_debit_coa := v_dir_loan_acc;
      ELSE
        SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '2105' AND is_active = true AND is_header = false LIMIT 1;
      END IF;
    END;
    v_ap_relief_idr := v_gross * v_rate;
    v_bank_credit_idr := v_actual * v_rate;

  ELSE
    IF v_pv.coa_account_id IS NOT NULL THEN
      v_debit_coa := v_pv.coa_account_id;
    ELSE
      SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '6900' AND is_active = true AND is_header = false LIMIT 1;
    END IF;
    v_ap_relief_idr := (v_gross + v_settle_diff) * v_rate;
    v_bank_credit_idr := (v_actual + v_settle_diff) * v_rate;
  END IF;

  IF v_debit_coa IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.chart_of_accounts WHERE id = v_debit_coa AND is_active = true AND is_header = false
  ) THEN
    RAISE EXCEPTION 'Debit control account could not be resolved or is inactive/header for payment voucher %', v_pv.voucher_number;
  END IF;

  -- Resolve bank charge account if any (COA 7100 or 8101)
  IF v_charge_amt > 0 THEN
    SELECT id INTO v_charge_coa FROM public.chart_of_accounts WHERE code = '7100' AND is_active = true AND is_header = false LIMIT 1;
    IF v_charge_coa IS NULL THEN
      SELECT id INTO v_charge_coa FROM public.chart_of_accounts WHERE code = '8101' AND is_active = true AND is_header = false LIMIT 1;
    END IF;
    IF v_charge_coa IS NULL THEN
      SELECT id INTO v_charge_coa FROM public.chart_of_accounts WHERE code = '6900' AND is_active = true AND is_header = false LIMIT 1;
    END IF;
  END IF;

  -- Resolve settlement difference account if any
  IF v_settle_diff > 0 THEN
    IF v_pv.adjustment_account_id IS NOT NULL THEN
      SELECT id INTO v_diff_coa FROM public.chart_of_accounts WHERE id = v_pv.adjustment_account_id AND is_active = true AND is_header = false;
    END IF;
    IF v_diff_coa IS NULL THEN
      SELECT id INTO v_diff_coa FROM public.chart_of_accounts WHERE code = '6910' AND is_active = true AND is_header = false LIMIT 1;
    END IF;
    IF v_diff_coa IS NULL THEN
      SELECT id INTO v_diff_coa FROM public.chart_of_accounts WHERE code = '6900' AND is_active = true AND is_header = false LIMIT 1;
    END IF;
  END IF;

  -- Calculate balanced totals
  v_total_debit := v_ap_relief_idr + (v_charge_amt * (CASE WHEN v_bank_currency = 'USD' THEN v_usd_bank_carrying_rate ELSE 1 END)) + v_fx_loss_amt;
  v_total_credit := v_bank_credit_idr + (v_settle_diff * v_rate) + v_fx_gain_amt;

  IF abs(v_total_debit - v_total_credit) > 0.05 THEN
    RAISE EXCEPTION 'Payment voucher journal does not balance: Debit (%) != Credit (%)', v_total_debit, v_total_credit;
  END IF;

  v_entry := public.next_journal_entry_number();

  INSERT INTO public.journal_entries(
    entry_number, entry_date, source_module, reference_id, reference_number,
    description, total_debit, total_credit, is_posted, posted_by,
    created_by, transaction_currency, functional_currency, exchange_rate
  ) VALUES (
    v_entry, v_pv.voucher_date, 'payment', v_pv.id, v_pv.voucher_number,
    'Payment Voucher (' || v_party_type || '): ' || v_pv.voucher_number,
    v_total_debit, v_total_credit, true, v_actual_poster,
    v_actual_poster, v_bank_currency, 'IDR', v_rate
  ) RETURNING id INTO v_je;

  -- Line 1: Debit AP Control Account / Expense / Advance
  INSERT INTO public.journal_entry_lines(
    journal_entry_id, line_number, account_id, description, debit, credit,
    transaction_currency, transaction_debit, transaction_credit, exchange_rate,
    supplier_id, customer_id, payee_id
  ) VALUES (
    v_je, v_line, v_debit_coa,
    CASE 
      WHEN v_party_type = 'supplier' AND (v_pv.payment_purpose = 'supplier_advance' OR v_pv.settlement_against = 'advance') THEN 'Supplier Advance - '
      WHEN v_party_type = 'supplier' THEN 'Supplier Payment - '
      WHEN v_party_type = 'customer' THEN 'Customer Refund - '
      WHEN v_party_type = 'employee' THEN 'Staff Payment - '
      WHEN v_party_type = 'director' THEN 'Director Loan Repayment - '
      ELSE 'Payment - '
    END || v_pv.voucher_number,
    v_ap_relief_idr, 0,
    v_invoice_currency, (v_gross + v_settle_diff), 0, v_rate,
    v_pv.supplier_id, v_pv.customer_id, v_pv.staff_id
  );
  v_line := v_line + 1;

  -- Line 2: Realized FX Loss (GL 7300) if any
  IF v_fx_loss_amt > 0 AND v_fx_loss_coa IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(
      journal_entry_id, line_number, account_id, description, debit, credit,
      transaction_currency, transaction_debit, transaction_credit, exchange_rate,
      supplier_id, customer_id, payee_id
    ) VALUES (
      v_je, v_line, v_fx_loss_coa, 'Realized Foreign Exchange Loss - ' || v_pv.voucher_number,
      v_fx_loss_amt, 0, 'IDR', v_fx_loss_amt, 0, 1,
      v_pv.supplier_id, v_pv.customer_id, v_pv.staff_id
    );
    v_line := v_line + 1;
  END IF;

  -- Line 3: Bank Charge (GL 7100 / 8101)
  IF v_charge_amt > 0 AND v_charge_coa IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(
      journal_entry_id, line_number, account_id, description, debit, credit,
      transaction_currency, transaction_debit, transaction_credit, exchange_rate,
      supplier_id, customer_id, payee_id
    ) VALUES (
      v_je, v_line, v_charge_coa, 'Bank Charge - ' || v_pv.voucher_number,
      v_charge_amt * (CASE WHEN v_bank_currency = 'USD' THEN v_usd_bank_carrying_rate ELSE 1 END), 0,
      v_bank_currency, v_charge_amt, 0, 1,
      v_pv.supplier_id, v_pv.customer_id, v_pv.staff_id
    );
    v_line := v_line + 1;
  END IF;

  -- Line 4: Credit Realized FX Gain (GL 4930) if any
  IF v_fx_gain_amt > 0 AND v_fx_gain_coa IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(
      journal_entry_id, line_number, account_id, description, debit, credit,
      transaction_currency, transaction_debit, transaction_credit, exchange_rate,
      supplier_id, customer_id, payee_id
    ) VALUES (
      v_je, v_line, v_fx_gain_coa, 'Realized Foreign Exchange Gain - ' || v_pv.voucher_number,
      0, v_fx_gain_amt, 'IDR', 0, v_fx_gain_amt, 1,
      v_pv.supplier_id, v_pv.customer_id, v_pv.staff_id
    );
    v_line := v_line + 1;
  END IF;

  -- Line 5: Credit Settlement Discount / Difference if any
  IF v_settle_diff > 0 AND v_diff_coa IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(
      journal_entry_id, line_number, account_id, description, debit, credit,
      transaction_currency, transaction_debit, transaction_credit, exchange_rate,
      supplier_id, customer_id, payee_id
    ) VALUES (
      v_je, v_line, v_diff_coa, 'Settlement Discount / Difference - ' || v_pv.voucher_number,
      0, v_settle_diff * v_rate, v_bank_currency, 0, v_settle_diff, 1,
      v_pv.supplier_id, v_pv.customer_id, v_pv.staff_id
    );
    v_line := v_line + 1;
  END IF;

  -- Line 6: Credit Bank / Cash
  INSERT INTO public.journal_entry_lines(
    journal_entry_id, line_number, account_id, description, debit, credit,
    transaction_currency, transaction_debit, transaction_credit, exchange_rate,
    supplier_id, customer_id, payee_id
  ) VALUES (
    v_je, v_line, v_bank_coa, 'Bank Payment - ' || v_pv.voucher_number,
    0, v_bank_credit_idr,
    v_bank_currency, 0, v_actual, 1,
    v_pv.supplier_id, v_pv.customer_id, v_pv.staff_id
  );

  UPDATE public.payment_vouchers SET is_posted = true, journal_entry_id = v_je WHERE id = p_pv_id;

  -- Recalculate Purchase Invoice balances and states
  IF v_party_type = 'supplier' THEN
    PERFORM public.recalculate_purchase_invoice_payment_state(va.purchase_invoice_id)
    FROM public.voucher_allocations va
    WHERE va.payment_voucher_id = p_pv_id AND va.purchase_invoice_id IS NOT NULL;
  END IF;

  -- Synchronize bank account current_balance with authoritative GL
  IF v_pv.bank_account_id IS NOT NULL THEN
    PERFORM public.sync_bank_account_balance(v_pv.bank_account_id);
  END IF;

  INSERT INTO public.audit_logs(table_name, record_id, action_type, old_values, new_values, user_id)
  VALUES('payment_vouchers', p_pv_id, 'update', jsonb_build_object('is_posted', false), jsonb_build_object('is_posted', true, 'journal_entry_id', v_je), v_actual_poster);
END;
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 5: POST_FUND_TRANSFER_JOURNAL WITH DUAL CURRENCY & CROSS-CURRENCY FX
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.post_fund_transfer_journal(p_transfer_id uuid, p_user_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_transfer        RECORD;
  v_journal_id      UUID;
  v_from_coa_id     UUID;
  v_to_coa_id       UUID;
  v_fx_gain_coa     UUID;
  v_fx_loss_coa     UUID;
  v_description     TEXT;
  v_actor           UUID;
  v_from_curr       TEXT := 'IDR';
  v_to_curr         TEXT := 'IDR';
  v_from_amount_idr NUMERIC;
  v_to_amount_idr   NUMERIC;
  v_fx_diff         NUMERIC := 0;
  v_total_debit     NUMERIC;
  v_total_credit    NUMERIC;
  v_usd_rate        NUMERIC := 18138;
BEGIN
  IF auth.role() = 'authenticated' AND auth.uid() IS NOT NULL THEN
    PERFORM public._sec_check_finance_role();
  END IF;

  v_actor := COALESCE(auth.uid(), p_user_id);

  SELECT * INTO v_transfer FROM public.fund_transfers WHERE id = p_transfer_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Fund transfer not found'; END IF;
  IF v_transfer.journal_entry_id IS NOT NULL THEN RETURN v_transfer.journal_entry_id; END IF;

  -- Resolve From Account COA
  IF v_transfer.from_account_type = 'petty_cash' THEN
    SELECT id INTO v_from_coa_id FROM public.chart_of_accounts WHERE code = '1102' AND is_active = true LIMIT 1;
    v_from_curr := 'IDR';
  ELSIF v_transfer.from_account_type = 'cash_on_hand' THEN
    SELECT id INTO v_from_coa_id FROM public.chart_of_accounts WHERE code = '1101' AND is_active = true LIMIT 1;
    v_from_curr := 'IDR';
  ELSIF v_transfer.from_account_type = 'bank' THEN
    SELECT ba.coa_id, upper(ba.currency) INTO v_from_coa_id, v_from_curr
    FROM public.bank_accounts ba WHERE ba.id = v_transfer.from_bank_account_id;
  END IF;

  -- Resolve To Account COA
  IF v_transfer.to_account_type = 'petty_cash' THEN
    SELECT id INTO v_to_coa_id FROM public.chart_of_accounts WHERE code = '1102' AND is_active = true LIMIT 1;
    v_to_curr := 'IDR';
  ELSIF v_transfer.to_account_type = 'cash_on_hand' THEN
    SELECT id INTO v_to_coa_id FROM public.chart_of_accounts WHERE code = '1101' AND is_active = true LIMIT 1;
    v_to_curr := 'IDR';
  ELSIF v_transfer.to_account_type = 'bank' THEN
    SELECT ba.coa_id, upper(ba.currency) INTO v_to_coa_id, v_to_curr
    FROM public.bank_accounts ba WHERE ba.id = v_transfer.to_bank_account_id;
  END IF;

  IF v_from_coa_id IS NULL OR v_to_coa_id IS NULL THEN
    RAISE EXCEPTION 'Cannot determine chart of accounts for transfer %', v_transfer.transfer_number;
  END IF;

  -- Resolve FX Gain / Loss Accounts
  SELECT id INTO v_fx_gain_coa FROM public.chart_of_accounts WHERE code = '4930' AND is_active = true LIMIT 1;
  SELECT id INTO v_fx_loss_coa FROM public.chart_of_accounts WHERE code = '7300' AND is_active = true LIMIT 1;

  -- Calculate Functional Amounts:
  IF v_from_curr = 'IDR' AND v_to_curr = 'USD' THEN
    -- IDR -> USD Transfer: Debit USD Bank in IDR, Credit IDR Bank in IDR
    v_from_amount_idr := COALESCE(v_transfer.from_amount, v_transfer.amount);
    v_to_amount_idr := v_from_amount_idr;
    v_total_debit := v_to_amount_idr;
    v_total_credit := v_from_amount_idr;

  ELSIF v_from_curr = 'USD' AND v_to_curr = 'IDR' THEN
    -- USD -> IDR Transfer: Debit IDR Bank for IDR received, Credit USD Bank for USD cost
    v_to_amount_idr := COALESCE(v_transfer.to_amount, v_transfer.amount);
    v_usd_rate := COALESCE(v_transfer.exchange_rate, 18138);
    v_from_amount_idr := round(COALESCE(v_transfer.from_amount, v_transfer.amount) * v_usd_rate, 2);
    v_fx_diff := v_to_amount_idr - v_from_amount_idr;
    
    v_total_debit := v_to_amount_idr + CASE WHEN v_fx_diff < 0 THEN abs(v_fx_diff) ELSE 0 END;
    v_total_credit := v_from_amount_idr + CASE WHEN v_fx_diff > 0 THEN v_fx_diff ELSE 0 END;

  ELSE
    -- Same Currency (IDR -> IDR)
    v_from_amount_idr := v_transfer.amount;
    v_to_amount_idr := v_transfer.amount;
    v_total_debit := v_transfer.amount;
    v_total_credit := v_transfer.amount;
  END IF;

  v_description := 'Fund Transfer ' || v_transfer.transfer_number;
  IF v_transfer.description IS NOT NULL THEN
    v_description := v_description || ' - ' || v_transfer.description;
  END IF;

  INSERT INTO public.journal_entries (
    entry_number, entry_date, source_module, reference_id, reference_number,
    description, total_debit, total_credit, is_posted, created_by,
    transaction_currency, functional_currency, exchange_rate
  ) VALUES (
    public.next_journal_entry_number(), v_transfer.transfer_date, 'fund_transfers', v_transfer.id, v_transfer.transfer_number,
    v_description, v_total_debit, v_total_credit, true, v_actor,
    v_from_curr, 'IDR', COALESCE(v_transfer.exchange_rate, 1)
  ) RETURNING id INTO v_journal_id;

  -- Line 1: Debit Destination Account (Transfer In)
  INSERT INTO public.journal_entry_lines (
    journal_entry_id, line_number, account_id, debit, credit, description,
    transaction_currency, transaction_debit, transaction_credit, exchange_rate
  ) VALUES (
    v_journal_id, 1, v_to_coa_id, v_to_amount_idr, 0, 'Transfer In - ' || v_transfer.transfer_number,
    v_to_curr, COALESCE(v_transfer.to_amount, v_transfer.amount), 0, COALESCE(v_transfer.exchange_rate, 1)
  );

  -- Line 2: Credit Source Account (Transfer Out)
  INSERT INTO public.journal_entry_lines (
    journal_entry_id, line_number, account_id, debit, credit, description,
    transaction_currency, transaction_debit, transaction_credit, exchange_rate
  ) VALUES (
    v_journal_id, 2, v_from_coa_id, 0, v_from_amount_idr, 'Transfer Out - ' || v_transfer.transfer_number,
    v_from_curr, 0, COALESCE(v_transfer.from_amount, v_transfer.amount), COALESCE(v_transfer.exchange_rate, 1)
  );

  -- Line 3: Realized FX Gain / Loss if USD -> IDR difference
  IF v_fx_diff > 0 AND v_fx_gain_coa IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines (
      journal_entry_id, line_number, account_id, debit, credit, description,
      transaction_currency, transaction_debit, transaction_credit, exchange_rate
    ) VALUES (
      v_journal_id, 3, v_fx_gain_coa, 0, v_fx_diff, 'Realized FX Gain on Fund Transfer - ' || v_transfer.transfer_number,
      'IDR', 0, v_fx_diff, 1
    );
  ELSIF v_fx_diff < 0 AND v_fx_loss_coa IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines (
      journal_entry_id, line_number, account_id, debit, credit, description,
      transaction_currency, transaction_debit, transaction_credit, exchange_rate
    ) VALUES (
      v_journal_id, 3, v_fx_loss_coa, abs(v_fx_diff), 0, 'Realized FX Loss on Fund Transfer - ' || v_transfer.transfer_number,
      'IDR', abs(v_fx_diff), 0, 1
    );
  END IF;

  UPDATE public.fund_transfers
  SET journal_entry_id = v_journal_id,
      status = 'posted',
      posted_at = now(),
      posted_by = v_actor
  WHERE id = p_transfer_id;

  -- Synchronize bank balances if bank accounts involved
  IF v_transfer.from_bank_account_id IS NOT NULL THEN
    PERFORM public.sync_bank_account_balance(v_transfer.from_bank_account_id);
  END IF;
  IF v_transfer.to_bank_account_id IS NOT NULL THEN
    PERFORM public.sync_bank_account_balance(v_transfer.to_bank_account_id);
  END IF;

  RETURN v_journal_id;
END;
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 6: REAL AUTOMATED BANK RECONCILIATION MATCHING ENGINE
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.auto_reconcile_bank_statement(p_upload_id uuid DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_line RECORD;
  v_pv RECORD;
  v_rv RECORD;
  v_exp RECORD;
  v_ft RECORD;
  v_tax RECORD;
  v_matched_count INTEGER := 0;
  v_conflict_count INTEGER := 0;
  v_candidate_count INTEGER := 0;
  v_matched_id UUID;
  v_matched_type TEXT;
BEGIN
  FOR v_line IN
    SELECT bsl.*
    FROM public.bank_statement_lines bsl
    WHERE (p_upload_id IS NULL OR bsl.upload_id = p_upload_id)
      AND bsl.reconciliation_status IN ('unmatched', 'suggested', 'conflict')
      AND NOT COALESCE(bsl.manually_unlinked, false)
    ORDER BY bsl.transaction_date ASC
  LOOP
    v_candidate_count := 0;
    v_matched_id := NULL;
    v_matched_type := NULL;

    -- ─────────────────────────────────────────────────────────────────────────
    -- 1. OUTGOING DEBIT TRANSACTIONS (Money Out)
    -- ─────────────────────────────────────────────────────────────────────────
    IF v_line.debit_amount > 0 THEN
      -- A. Match Payment Vouchers
      SELECT pv.id, 'payment_voucher' INTO v_pv
      FROM public.payment_vouchers pv
      WHERE pv.bank_account_id = v_line.bank_account_id
        AND pv.is_posted = true
        AND abs(COALESCE(pv.actual_bank_debit, pv.bank_amount, pv.amount + COALESCE(pv.bank_charge, 0)) - v_line.debit_amount) < 0.01
        AND abs(pv.voucher_date - v_line.transaction_date) <= 5
        AND pv.id NOT IN (
          SELECT matched_payment_id FROM public.bank_statement_lines
          WHERE matched_payment_id IS NOT NULL AND id <> v_line.id
        )
      ORDER BY abs(pv.voucher_date - v_line.transaction_date) ASC
      LIMIT 2;

      IF FOUND THEN
        v_candidate_count := v_candidate_count + 1;
        v_matched_id := v_pv.id;
        v_matched_type := 'payment';
      END IF;

      -- B. Match Finance Expenses
      SELECT fe.id, 'expense' INTO v_exp
      FROM public.finance_expenses fe
      WHERE fe.bank_account_id = v_line.bank_account_id
        AND fe.status = 'approved'
        AND abs(fe.amount - v_line.debit_amount) < 0.01
        AND abs(fe.expense_date - v_line.transaction_date) <= 5
        AND fe.id NOT IN (
          SELECT matched_expense_id FROM public.bank_statement_lines
          WHERE matched_expense_id IS NOT NULL AND id <> v_line.id
        )
      ORDER BY abs(fe.expense_date - v_line.transaction_date) ASC
      LIMIT 2;

      IF FOUND THEN
        v_candidate_count := v_candidate_count + 1;
        IF v_matched_id IS NULL THEN
          v_matched_id := v_exp.id;
          v_matched_type := 'expense';
        END IF;
      END IF;

      -- C. Match Fund Transfers Out
      SELECT ft.id, 'fund_transfer' INTO v_ft
      FROM public.fund_transfers ft
      WHERE ft.from_bank_account_id = v_line.bank_account_id
        AND ft.status = 'posted'
        AND abs(COALESCE(ft.from_amount, ft.amount) - v_line.debit_amount) < 0.01
        AND abs(ft.transfer_date - v_line.transaction_date) <= 5
        AND ft.id NOT IN (
          SELECT matched_fund_transfer_id FROM public.bank_statement_lines
          WHERE matched_fund_transfer_id IS NOT NULL AND id <> v_line.id
        )
      ORDER BY abs(ft.transfer_date - v_line.transaction_date) ASC
      LIMIT 2;

      IF FOUND THEN
        v_candidate_count := v_candidate_count + 1;
        IF v_matched_id IS NULL THEN
          v_matched_id := v_ft.id;
          v_matched_type := 'fund_transfer';
        END IF;
      END IF;

      -- D. Match Tax Payments
      SELECT tp.id, 'tax_payment' INTO v_tax
      FROM public.tax_payments tp
      WHERE tp.bank_account_id = v_line.bank_account_id
        AND abs(tp.amount - v_line.debit_amount) < 0.01
        AND abs(tp.payment_date - v_line.transaction_date) <= 5
        AND tp.id NOT IN (
          SELECT matched_tax_payment_id FROM public.bank_statement_lines
          WHERE matched_tax_payment_id IS NOT NULL AND id <> v_line.id
        )
      ORDER BY abs(tp.payment_date - v_line.transaction_date) ASC
      LIMIT 2;

      IF FOUND THEN
        v_candidate_count := v_candidate_count + 1;
        IF v_matched_id IS NULL THEN
          v_matched_id := v_tax.id;
          v_matched_type := 'tax_payment';
        END IF;
      END IF;

    -- ─────────────────────────────────────────────────────────────────────────
    -- 2. INCOMING CREDIT TRANSACTIONS (Money In)
    -- ─────────────────────────────────────────────────────────────────────────
    ELSIF v_line.credit_amount > 0 THEN
      -- A. Match Receipt Vouchers
      SELECT rv.id, 'receipt_voucher' INTO v_rv
      FROM public.receipt_vouchers rv
      WHERE rv.bank_account_id = v_line.bank_account_id
        AND rv.is_posted = true
        AND abs(rv.amount - v_line.credit_amount) < 0.01
        AND abs(rv.receipt_date - v_line.transaction_date) <= 5
        AND rv.id NOT IN (
          SELECT matched_receipt_id FROM public.bank_statement_lines
          WHERE matched_receipt_id IS NOT NULL AND id <> v_line.id
        )
      ORDER BY abs(rv.receipt_date - v_line.transaction_date) ASC
      LIMIT 2;

      IF FOUND THEN
        v_candidate_count := v_candidate_count + 1;
        v_matched_id := v_rv.id;
        v_matched_type := 'receipt';
      END IF;

      -- B. Match Fund Transfers In
      SELECT ft.id, 'fund_transfer' INTO v_ft
      FROM public.fund_transfers ft
      WHERE ft.to_bank_account_id = v_line.bank_account_id
        AND ft.status = 'posted'
        AND abs(COALESCE(ft.to_amount, ft.amount) - v_line.credit_amount) < 0.01
        AND abs(ft.transfer_date - v_line.transaction_date) <= 5
        AND ft.id NOT IN (
          SELECT matched_fund_transfer_id FROM public.bank_statement_lines
          WHERE matched_fund_transfer_id IS NOT NULL AND id <> v_line.id
        )
      ORDER BY abs(ft.transfer_date - v_line.transaction_date) ASC
      LIMIT 2;

      IF FOUND THEN
        v_candidate_count := v_candidate_count + 1;
        IF v_matched_id IS NULL THEN
          v_matched_id := v_ft.id;
          v_matched_type := 'fund_transfer';
        END IF;
      END IF;
    END IF;

    -- ─────────────────────────────────────────────────────────────────────────
    -- 3. RESOLVE MATCHING STATE & RECONCILIATION
    -- ─────────────────────────────────────────────────────────────────────────
    IF v_candidate_count = 1 AND v_matched_id IS NOT NULL THEN
      -- Exactly one document candidate: Reconcile and link (NEVER create second journal!)
      UPDATE public.bank_statement_lines
      SET matching_status = 'confirmed',
          reconciliation_status = 'reconciled',
          matched_payment_id = CASE WHEN v_matched_type = 'payment' THEN v_matched_id ELSE matched_payment_id END,
          matched_receipt_id = CASE WHEN v_matched_type = 'receipt' THEN v_matched_id ELSE matched_receipt_id END,
          matched_expense_id = CASE WHEN v_matched_type = 'expense' THEN v_matched_id ELSE matched_expense_id END,
          matched_fund_transfer_id = CASE WHEN v_matched_type = 'fund_transfer' THEN v_matched_id ELSE matched_fund_transfer_id END,
          matched_tax_payment_id = CASE WHEN v_matched_type = 'tax_payment' THEN v_matched_id ELSE matched_tax_payment_id END,
          matched_at = now(),
          notes = 'Auto-reconciled against posted ' || v_matched_type
      WHERE id = v_line.id;

      v_matched_count := v_matched_count + 1;

    ELSIF v_candidate_count > 1 THEN
      -- Ambiguous matches: Route to review queue with conflict status
      UPDATE public.bank_statement_lines
      SET matching_status = 'suggested',
          reconciliation_status = 'conflict',
          notes = 'Multiple potential accounting documents match this transaction (' || v_candidate_count || ' candidates) - manual review required'
      WHERE id = v_line.id;

      v_conflict_count := v_conflict_count + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'auto_matched_count', v_matched_count,
    'conflict_review_count', v_conflict_count
  );
END;
$function$;

-- Update trigger to invoke intelligent reconciliation on statement insert
CREATE OR REPLACE FUNCTION public.auto_match_bank_statement_line()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pv_id UUID;
  v_rv_id UUID;
  v_fe_id UUID;
  v_ft_id UUID;
  v_count INTEGER := 0;
BEGIN
  IF NEW.matched_petty_cash_id IS NOT NULL
     OR NEW.matched_expense_id IS NOT NULL
     OR NEW.matched_receipt_id IS NOT NULL
     OR NEW.matched_payment_id IS NOT NULL
     OR NEW.matched_fund_transfer_id IS NOT NULL
     OR NEW.matched_tax_payment_id IS NOT NULL
     OR NEW.matched_entry_id IS NOT NULL
     OR COALESCE(NEW.manually_unlinked, false) THEN
    RETURN NEW;
  END IF;

  -- Default to unmatched
  NEW.reconciliation_status := COALESCE(NEW.reconciliation_status, 'unmatched');
  NEW.matching_status := COALESCE(NEW.matching_status, 'none');

  -- Fast path check on insert: If exact single voucher exists, link directly
  IF NEW.debit_amount > 0 THEN
    SELECT pv.id INTO v_pv_id
    FROM public.payment_vouchers pv
    WHERE pv.bank_account_id = NEW.bank_account_id
      AND pv.is_posted = true
      AND abs(COALESCE(pv.actual_bank_debit, pv.bank_amount, pv.amount + COALESCE(pv.bank_charge, 0)) - NEW.debit_amount) < 0.01
      AND abs(pv.voucher_date - NEW.transaction_date) <= 5
      AND pv.id NOT IN (SELECT matched_payment_id FROM public.bank_statement_lines WHERE matched_payment_id IS NOT NULL)
    LIMIT 1;

    IF v_pv_id IS NOT NULL THEN
      NEW.matched_payment_id := v_pv_id;
      NEW.matching_status := 'confirmed';
      NEW.reconciliation_status := 'reconciled';
      NEW.matched_at := now();
      NEW.notes := 'Auto-reconciled against posted payment voucher';
    END IF;
  ELSIF NEW.credit_amount > 0 THEN
    SELECT rv.id INTO v_rv_id
    FROM public.receipt_vouchers rv
    WHERE rv.bank_account_id = NEW.bank_account_id
      AND rv.is_posted = true
      AND abs(rv.amount - NEW.credit_amount) < 0.01
      AND abs(rv.receipt_date - NEW.transaction_date) <= 5
      AND rv.id NOT IN (SELECT matched_receipt_id FROM public.bank_statement_lines WHERE matched_receipt_id IS NOT NULL)
    LIMIT 1;

    IF v_rv_id IS NOT NULL THEN
      NEW.matched_receipt_id := v_rv_id;
      NEW.matching_status := 'confirmed';
      NEW.reconciliation_status := 'reconciled';
      NEW.matched_at := now();
      NEW.notes := 'Auto-reconciled against posted receipt voucher';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

