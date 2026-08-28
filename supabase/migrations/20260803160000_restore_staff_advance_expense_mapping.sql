-- Finance V1.1.2 approved Salary Advance GL exception.
--
-- The latest category-function replacement accidentally omitted the existing
-- staff_advance branch, causing the Expense entry path to fall through to
-- Miscellaneous Expense (6900). Restore the canonical asset classification
-- without changing schema, workflow, or any other category mapping.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_expense_account_id(p_category text)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id uuid;
BEGIN
  v_account_id := CASE p_category
    WHEN 'salary' THEN (SELECT id FROM chart_of_accounts WHERE code='6100' LIMIT 1)
    WHEN 'staff_overtime' THEN (SELECT id FROM chart_of_accounts WHERE code='6100' LIMIT 1)
    WHEN 'non_permanent_employee_fee' THEN (SELECT id FROM chart_of_accounts WHERE code='6100' LIMIT 1)
    WHEN 'staff_welfare' THEN (SELECT id FROM chart_of_accounts WHERE code='6150' LIMIT 1)
    WHEN 'employee_benefits' THEN (SELECT id FROM chart_of_accounts WHERE code='6110' LIMIT 1)
    WHEN 'travel_conveyance' THEN (SELECT id FROM chart_of_accounts WHERE code='6500' LIMIT 1)
    WHEN 'staff_advance' THEN (SELECT id FROM chart_of_accounts WHERE code='1160' LIMIT 1)
    WHEN 'office_rent' THEN (SELECT id FROM chart_of_accounts WHERE code='6220' LIMIT 1)
    WHEN 'warehouse_rent' THEN (SELECT id FROM chart_of_accounts WHERE code='6210' LIMIT 1)
    WHEN 'rent' THEN (SELECT id FROM chart_of_accounts WHERE code='6200' LIMIT 1)
    WHEN 'office_admin' THEN (SELECT id FROM chart_of_accounts WHERE code='6410' LIMIT 1)
    WHEN 'office_supplies' THEN (SELECT id FROM chart_of_accounts WHERE code='6400' LIMIT 1)
    WHEN 'office_shifting_renovation' THEN (SELECT id FROM chart_of_accounts WHERE code='6420' LIMIT 1)
    WHEN 'utilities' THEN (SELECT id FROM chart_of_accounts WHERE code='6300' LIMIT 1)
    WHEN 'electricity' THEN (SELECT id FROM chart_of_accounts WHERE code='6310' LIMIT 1)
    WHEN 'water' THEN (SELECT id FROM chart_of_accounts WHERE code='6320' LIMIT 1)
    WHEN 'internet_phone' THEN (SELECT id FROM chart_of_accounts WHERE code='6330' LIMIT 1)
    WHEN 'fuel' THEN (SELECT id FROM chart_of_accounts WHERE code='6500' LIMIT 1)
    WHEN 'vehicle_maintenance' THEN (SELECT id FROM chart_of_accounts WHERE code='6500' LIMIT 1)
    WHEN 'delivery_sales' THEN (SELECT id FROM chart_of_accounts WHERE code='6510' LIMIT 1)
    WHEN 'loading_sales' THEN (SELECT id FROM chart_of_accounts WHERE code='6520' LIMIT 1)
    WHEN 'other_sales' THEN (SELECT id FROM chart_of_accounts WHERE code='6510' LIMIT 1)
    WHEN 'marketing_advertising' THEN (SELECT id FROM chart_of_accounts WHERE code='6600' LIMIT 1)
    WHEN 'legal_professional' THEN (SELECT id FROM chart_of_accounts WHERE code='6700' LIMIT 1)
    WHEN 'consulting_fees' THEN (SELECT id FROM chart_of_accounts WHERE code='6700' LIMIT 1)
    WHEN 'accounting_audit' THEN (SELECT id FROM chart_of_accounts WHERE code='6700' LIMIT 1)
    WHEN 'professional_services' THEN (SELECT id FROM chart_of_accounts WHERE code='6700' LIMIT 1)
    WHEN 'bank_charges' THEN (SELECT id FROM chart_of_accounts WHERE code='7100' LIMIT 1)
    WHEN 'interest_expense' THEN (SELECT id FROM chart_of_accounts WHERE code='7200' LIMIT 1)
    WHEN 'duty_customs' THEN (SELECT id FROM chart_of_accounts WHERE code='1130' LIMIT 1)
    WHEN 'duty_import' THEN (SELECT id FROM chart_of_accounts WHERE code='1130' LIMIT 1)
    WHEN 'freight_import' THEN (SELECT id FROM chart_of_accounts WHERE code='5300' LIMIT 1)
    WHEN 'clearing_forwarding' THEN (SELECT id FROM chart_of_accounts WHERE code='5300' LIMIT 1)
    WHEN 'port_charges' THEN (SELECT id FROM chart_of_accounts WHERE code='5300' LIMIT 1)
    WHEN 'container_handling' THEN (SELECT id FROM chart_of_accounts WHERE code='5300' LIMIT 1)
    WHEN 'transport_import' THEN (SELECT id FROM chart_of_accounts WHERE code='5300' LIMIT 1)
    WHEN 'loading_import' THEN (SELECT id FROM chart_of_accounts WHERE code='5300' LIMIT 1)
    WHEN 'bpom_ski_fees' THEN (SELECT id FROM chart_of_accounts WHERE code='5410' LIMIT 1)
    WHEN 'other_import' THEN (SELECT id FROM chart_of_accounts WHERE code='5400' LIMIT 1)
    WHEN 'import_broker' THEN (SELECT id FROM chart_of_accounts WHERE code='5300' LIMIT 1)
    WHEN 'ppn_import' THEN (SELECT id FROM chart_of_accounts WHERE code='1150' LIMIT 1)
    WHEN 'pph_import' THEN (SELECT id FROM chart_of_accounts WHERE code='1155' LIMIT 1)
    WHEN 'duty' THEN (SELECT id FROM chart_of_accounts WHERE code='1130' LIMIT 1)
    WHEN 'freight' THEN (SELECT id FROM chart_of_accounts WHERE code='5300' LIMIT 1)
    WHEN 'office' THEN (SELECT id FROM chart_of_accounts WHERE code='6400' LIMIT 1)
    WHEN 'other' THEN (SELECT id FROM chart_of_accounts WHERE code='6900' LIMIT 1)
    WHEN 'fixed_asset' THEN NULL
    WHEN 'pib_import' THEN NULL
    ELSE (SELECT id FROM chart_of_accounts WHERE code='6900' LIMIT 1)
  END;

  IF v_account_id IS NULL AND p_category NOT IN ('pib_import','fixed_asset') THEN
    SELECT id INTO v_account_id FROM chart_of_accounts WHERE code='6000' LIMIT 1;
  END IF;
  RETURN v_account_id;
END;
$$;

DO $$
BEGIN
  IF (SELECT code FROM public.chart_of_accounts
      WHERE id=public.get_expense_account_id('staff_advance')) IS DISTINCT FROM '1160' THEN
    RAISE EXCEPTION 'staff_advance must resolve to COA 1160';
  END IF;
  IF (SELECT code FROM public.chart_of_accounts
      WHERE id=public.get_expense_account_id('professional_services')) IS DISTINCT FROM '6700' THEN
    RAISE EXCEPTION 'professional_services must remain on COA 6700';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;
