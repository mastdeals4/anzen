-- Broker expenses are journalized by post_customs_broker_canonical(). The
-- generic PPh synchronizer must not add a second withholding line.
CREATE OR REPLACE FUNCTION public.trg_sync_expense_pph_account()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_account_id uuid; v_journal_id uuid; v_line_number integer;
BEGIN
  IF NEW.expense_category = 'import_broker' THEN RETURN NEW; END IF;
  IF COALESCE(NEW.pph_amount,0) <= 0 THEN RETURN NEW; END IF;
  v_account_id := fn_pph_payable_account_id(NEW.pph_code_id);
  IF v_account_id IS NULL THEN RETURN NEW; END IF;
  SELECT id INTO v_journal_id FROM journal_entries WHERE reference_id=NEW.id AND source_module='expenses' ORDER BY created_at DESC LIMIT 1;
  IF v_journal_id IS NULL THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM journal_entry_lines WHERE journal_entry_id=v_journal_id AND debit=0 AND description ILIKE 'PPh Ditahan%') THEN
    UPDATE journal_entry_lines SET account_id=v_account_id WHERE journal_entry_id=v_journal_id AND debit=0 AND description ILIKE 'PPh Ditahan%';
  ELSE
    UPDATE journal_entry_lines SET credit=credit-NEW.pph_amount WHERE id=(SELECT id FROM journal_entry_lines WHERE journal_entry_id=v_journal_id AND credit>=NEW.pph_amount ORDER BY credit DESC,line_number DESC LIMIT 1);
    SELECT coalesce(max(line_number),0)+1 INTO v_line_number FROM journal_entry_lines WHERE journal_entry_id=v_journal_id;
    INSERT INTO journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description) VALUES(v_journal_id,v_line_number,v_account_id,0,NEW.pph_amount,'PPh Ditahan - '||coalesce(NEW.description,NEW.voucher_number,'Expense'));
  END IF;
  UPDATE journal_entries SET total_debit=(SELECT coalesce(sum(debit),0) FROM journal_entry_lines WHERE journal_entry_id=v_journal_id), total_credit=(SELECT coalesce(sum(credit),0) FROM journal_entry_lines WHERE journal_entry_id=v_journal_id) WHERE id=v_journal_id;
  RETURN NEW;
END; $function$;

-- Precisely scoped, preconditioned repair of the four audited duplicate lines.
DO $repair$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('1456ce32-5019-4dab-a221-028dda840803'::uuid,'JE2602-0200',18000::numeric),
    ('153ef7f9-40b0-4f4d-9523-53ecea5817c8'::uuid,'JE2602-0201',18000::numeric),
    ('b2d22e1a-4360-4308-9788-e46ca76968a8'::uuid,'JE2606-0120',48000::numeric),
    ('7cae3318-9dc5-495f-9337-ee34554e6fa6'::uuid,'JE2608-0178',66000::numeric)
  ) AS x(line_id,entry_number,amount) LOOP
    IF NOT EXISTS (SELECT 1 FROM journal_entry_lines l JOIN journal_entries j ON j.id=l.journal_entry_id JOIN chart_of_accounts a ON a.id=l.account_id WHERE l.id=r.line_id AND j.entry_number=r.entry_number AND a.code='2132' AND l.debit=0 AND l.credit=r.amount) THEN
      RAISE EXCEPTION 'Precondition failed for audited PPh line %',r.line_id;
    END IF;
    DELETE FROM journal_entry_lines WHERE id=r.line_id;
  END LOOP;
  UPDATE journal_entry_lines SET credit=5753597 WHERE id='7d7c304a-3340-45f7-ae9a-c4dafa4c7772' AND credit=5735597;
  UPDATE journal_entry_lines SET credit=6094500 WHERE id='ccc1a580-faf1-4d4a-8b0b-00f552fa325c' AND credit=6046500;
  UPDATE journal_entry_lines SET credit=28861549 WHERE id='0572cda5-8d60-4439-95bc-8b5070e3b8e1' AND credit=28795549;
  UPDATE journal_entries j SET total_debit=(SELECT coalesce(sum(debit),0) FROM journal_entry_lines l WHERE l.journal_entry_id=j.id), total_credit=(SELECT coalesce(sum(credit),0) FROM journal_entry_lines l WHERE l.journal_entry_id=j.id) WHERE j.entry_number IN ('JE2602-0200','JE2602-0201','JE2606-0120','JE2608-0178');
END $repair$;
