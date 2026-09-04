-- Non-Permanent Employee Fee defaults to PPh21, but the accountant may choose
-- another existing tax code when the actual tax treatment requires it.
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

    -- Default only. An explicit accountant-selected tax code is preserved.
    IF NEW.pph_code_id IS NULL THEN
      SELECT id INTO v_pph21_code FROM public.tax_codes
      WHERE tax_type = 'PPh21' AND is_withholding = true
      ORDER BY (code = 'PPH21') DESC, code LIMIT 1;
      IF v_pph21_code IS NULL THEN
        RAISE EXCEPTION 'PPh21 tax code is not configured';
      END IF;
      NEW.pph_code_id := v_pph21_code;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.validate_non_permanent_employee_fee() IS
  'Defaults Non-Permanent Employee Fee expenses to PPh21 while preserving accountant tax-code overrides.';

NOTIFY pgrst, 'reload schema';
