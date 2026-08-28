-- Add the non-permanent employee / honorarium expense category.
-- Reuses the existing Staff expense account and PPh21 tax engine.

ALTER TABLE public.finance_expenses
  DROP CONSTRAINT IF EXISTS finance_expenses_expense_category_check;

ALTER TABLE public.finance_expenses
  ADD CONSTRAINT finance_expenses_expense_category_check
  CHECK (expense_category = ANY (ARRAY[
    'duty_customs','ppn_import','pph_import','freight_import','clearing_forwarding',
    'port_charges','container_handling','transport_import','loading_import',
    'bpom_ski_fees','other_import','pib_import','import_broker',
    'delivery_sales','loading_sales','other_sales','salary','staff_overtime',
    'staff_welfare','travel_conveyance','warehouse_rent','utilities','bank_charges',
    'office_admin','office_shifting_renovation','duty','freight','office','other',
    'fixed_asset','professional_services','staff_advance',
    'non_permanent_employee_fee'
  ]));

-- Preserve the current account mapping and add one Staff-cost branch.
CREATE OR REPLACE FUNCTION public.get_expense_account_id(p_category TEXT)
RETURNS UUID
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_account_id uuid;
BEGIN
  v_account_id := CASE p_category
    WHEN 'salary' THEN (SELECT id FROM chart_of_accounts WHERE code='6100' LIMIT 1)
    WHEN 'staff_overtime' THEN (SELECT id FROM chart_of_accounts WHERE code='6100' LIMIT 1)
    WHEN 'non_permanent_employee_fee' THEN (SELECT id FROM chart_of_accounts WHERE code='6100' LIMIT 1)
    WHEN 'staff_welfare' THEN (SELECT id FROM chart_of_accounts WHERE code='6150' LIMIT 1)
    WHEN 'employee_benefits' THEN (SELECT id FROM chart_of_accounts WHERE code='6110' LIMIT 1)
    WHEN 'travel_conveyance' THEN (SELECT id FROM chart_of_accounts WHERE code='6500' LIMIT 1)
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

-- Category selection is enough to classify the row as PPh21-eligible. The
-- amount remains entered through the existing PPh21/manual calculation flow.
CREATE OR REPLACE FUNCTION public.validate_non_permanent_employee_fee()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_pph21_code uuid;
BEGIN
  IF NEW.expense_category = 'non_permanent_employee_fee' THEN
    IF NEW.supplier_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.suppliers s
      WHERE s.id = NEW.supplier_id
        AND lower(COALESCE(s.supplier_type,'')) IN (
          'employee','non-permanent individual','freelancer','casual worker','honorarium recipient'
        )
    ) THEN
      RAISE EXCEPTION 'Non-Permanent Employee Fee is intended for an individual subject to PPh 21, not a company supplier';
    END IF;
    SELECT id INTO v_pph21_code FROM public.tax_codes
    WHERE tax_type = 'PPh21' AND is_withholding = true
    ORDER BY (code = 'PPH21') DESC, code LIMIT 1;
    IF v_pph21_code IS NULL THEN
      RAISE EXCEPTION 'PPh21 tax code is not configured';
    END IF;
    NEW.pph_code_id := v_pph21_code;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_non_permanent_employee_fee ON public.finance_expenses;
CREATE TRIGGER trg_validate_non_permanent_employee_fee
  BEFORE INSERT OR UPDATE OF expense_category, supplier_id, pph_code_id
  ON public.finance_expenses
  FOR EACH ROW EXECUTE FUNCTION public.validate_non_permanent_employee_fee();

COMMENT ON FUNCTION public.validate_non_permanent_employee_fee() IS
  'Classifies Non-Permanent Employee Fee expenses with the existing PPh21 code and rejects non-individual suppliers.';

NOTIFY pgrst, 'reload schema';
