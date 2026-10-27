/*
 * A bank-linked save is the one controlled exception to the legacy
 * normalize_unlinked_expense_payment rule. Outside these atomic RPCs a bare
 * bank_transfer selection is still normalized to an unlinked/accrued expense.
 * Inside them, preserve the edited payment fields so the existing canonical
 * auto_post_expense_accounting trigger rebuilds the journal before allocation.
 */

BEGIN;

CREATE OR REPLACE FUNCTION public.normalize_unlinked_expense_payment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF COALESCE(current_setting('app.finance_historical_repair', true), 'off') = 'on' THEN
    RETURN NEW;
  END IF;
  IF NEW.payment_method = 'bank_transfer'
     AND COALESCE(current_setting('app.expense_atomic_bank_link', true), 'off') <> 'on' THEN
    NEW.payment_method := NULL;
    NEW.bank_account_id := NULL;
    NEW.paid_by := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DO $migration$
DECLARE
  v_definition text;
  v_update_marker text := E'  UPDATE public.finance_expenses SET\n';
  v_update_replacement text := E'  -- Preserve the edited bank mode through the legacy unlinked-payment normalizer.\n'
    || E'  PERFORM set_config(''app.expense_atomic_bank_link'',''on'',true);\n\n'
    || v_update_marker;
  v_save_marker text := E'  v_expense_id := public.save_finance_expense(p_expense_id, p_payload);\n';
  v_save_replacement text := E'  -- The selected statement makes this a controlled bank-linked save.\n'
    || E'  PERFORM set_config(''app.expense_atomic_bank_link'',''on'',true);\n'
    || v_save_marker;
BEGIN
  SELECT pg_get_functiondef(
    'public.edit_approved_finance_expense_atomic(uuid,jsonb,uuid,numeric)'::regprocedure
  ) INTO v_definition;
  IF position('app.expense_atomic_bank_link' IN v_definition) = 0 THEN
    IF position(v_update_marker IN v_definition) = 0 THEN
      RAISE EXCEPTION 'Unexpected approved expense edit definition';
    END IF;
    v_definition := replace(v_definition, v_update_marker, v_update_replacement);
    EXECUTE v_definition;
  END IF;

  SELECT pg_get_functiondef(
    'public.save_and_link_finance_expense_atomic(uuid,jsonb,uuid,numeric,uuid,boolean)'::regprocedure
  ) INTO v_definition;
  IF position('app.expense_atomic_bank_link' IN v_definition) = 0 THEN
    IF position(v_save_marker IN v_definition) = 0 THEN
      RAISE EXCEPTION 'Unexpected atomic expense save/link definition';
    END IF;
    v_definition := replace(v_definition, v_save_marker, v_save_replacement);
    EXECUTE v_definition;
  END IF;
END;
$migration$;

-- 20260830110000 temporarily restored a generic trigger after the canonical
-- insert/update pair was installed. Keep only that pair so one source update
-- invokes the journal builder once.
DROP TRIGGER IF EXISTS trigger_auto_post_expense_accounting
  ON public.finance_expenses;

REVOKE ALL ON FUNCTION public.normalize_unlinked_expense_payment()
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.normalize_unlinked_expense_payment()
  TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.edit_approved_finance_expense_atomic(uuid,jsonb,uuid,numeric)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.edit_approved_finance_expense_atomic(uuid,jsonb,uuid,numeric)
  TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.save_and_link_finance_expense_atomic(uuid,jsonb,uuid,numeric,uuid,boolean)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_and_link_finance_expense_atomic(uuid,jsonb,uuid,numeric,uuid,boolean)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
