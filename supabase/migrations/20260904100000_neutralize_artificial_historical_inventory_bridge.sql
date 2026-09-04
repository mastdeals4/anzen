-- Controlled, reversible neutralization of the proven artificial historical
-- inventory bridge.  This migration intentionally changes no source,
-- purchase, batch, inventory-transaction, COGS, AP, bank, or FX records.

DO $$
DECLARE
  v_inventory uuid;
  v_retained_earnings uuid;
  v_net_inventory numeric;
  v_net_retained_earnings numeric;
  v_0055 numeric;
  v_0056 numeric;
  v_amount constant numeric := 4059330637.70;
  v_repair_id uuid := public.uuid_from_text('hfr-260904:inventory-bridge-neutralization');
BEGIN
  SELECT id INTO STRICT v_inventory FROM public.chart_of_accounts WHERE code='1130';
  SELECT id INTO STRICT v_retained_earnings FROM public.chart_of_accounts WHERE code='3200';

  -- Refuse to run unless the four audited journals still have exactly the
  -- verified net effect and the paired remeasurement journals net to zero.
  WITH bridge AS (
    SELECT je.entry_number,
           COALESCE(sum(jel.debit-jel.credit) FILTER (WHERE jel.account_id=v_inventory),0) inventory_effect,
           COALESCE(sum(jel.debit-jel.credit) FILTER (WHERE jel.account_id=v_retained_earnings),0) retained_effect
    FROM public.journal_entries je
    LEFT JOIN public.journal_entry_lines jel ON jel.journal_entry_id=je.id
    WHERE je.entry_number IN ('HFR-260826-INV-001','HFR-260904-INV-FINAL','JE2609-0055','JE2609-0056')
      AND je.is_posted AND NOT COALESCE(je.is_reversed,false)
    GROUP BY je.entry_number
  )
  SELECT COALESCE(sum(inventory_effect),0), COALESCE(sum(retained_effect),0),
         COALESCE(sum(inventory_effect) FILTER (WHERE entry_number='JE2609-0055'),0),
         COALESCE(sum(inventory_effect) FILTER (WHERE entry_number='JE2609-0056'),0)
    INTO v_net_inventory,v_net_retained_earnings,v_0055,v_0056
  FROM bridge;

  IF v_net_inventory <> v_amount
     OR v_net_retained_earnings <> -v_amount
     OR v_0055 + v_0056 <> 0 THEN
    RAISE EXCEPTION 'Artificial inventory bridge precondition failed: inventory %, retained earnings %, JE0055 %, JE0056 %',
      v_net_inventory,v_net_retained_earnings,v_0055,v_0056;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.journal_entries
    WHERE id=v_repair_id OR entry_number='HFR-260904-INV-NEUTRALIZE'
       OR reference_number='HFR-260904-INV-BRIDGE-NEUTRALIZATION'
  ) THEN
    RAISE EXCEPTION 'Historical inventory bridge neutralization already exists; refusing duplicate repair';
  END IF;

  INSERT INTO public.journal_entries(
    id,entry_number,entry_date,source_module,reference_id,reference_number,
    description,total_debit,total_credit,is_posted,is_reversed,posted_at
  ) VALUES (
    v_repair_id,'HFR-260904-INV-NEUTRALIZE',CURRENT_DATE,
    'historical_inventory_bridge_neutralization',v_repair_id,
    'HFR-260904-INV-BRIDGE-NEUTRALIZATION',
    'Reversal/neutralization of artificial historical inventory valuation bridge; no physical inventory effect',
    v_amount,v_amount,true,false,now()
  );

  INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit)
  VALUES
    (v_repair_id,1,v_retained_earnings,'Neutralize artificial historical inventory bridge',v_amount,0),
    (v_repair_id,2,v_inventory,'Neutralize artificial historical inventory bridge',0,v_amount);
END $$;
