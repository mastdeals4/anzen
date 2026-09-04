-- Ensure every successful batch repair has one explicit repair audit record,
-- including a valid false-positive exception whose derived metadata was already
-- clean and therefore produced no row-level update.

CREATE OR REPLACE FUNCTION public.repair_all_posted_fund_transfers()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  t record;
  eligibility text;
  result jsonb;
  scanned integer := 0;
  repaired integer := 0;
  skipped integer := 0;
  skipped_details jsonb := '[]'::jsonb;
BEGIN
  PERFORM public._sec_check_finance_role();
  FOR t IN SELECT id, transfer_number FROM public.fund_transfers WHERE status='posted' ORDER BY transfer_date, transfer_number LOOP
    scanned := scanned + 1;
    eligibility := public.audit_fund_transfer_repair_eligibility(t.id);
    IF eligibility IS NOT NULL THEN
      skipped := skipped + 1;
      skipped_details := skipped_details || jsonb_build_array(jsonb_build_object(
        'fund_transfer_id', t.id, 'transfer_number', t.transfer_number, 'reason', eligibility));
      CONTINUE;
    END IF;
    SELECT public.repair_posted_fund_transfer_from_source(t.id) INTO result;
    IF COALESCE((result->>'repaired')::boolean, false) THEN
      repaired := repaired + 1;
      IF NOT EXISTS (
        SELECT 1 FROM public.audit_logs a
        WHERE a.table_name='fund_transfers' AND a.record_id=t.id
          AND a.new_values->>'validation_rerun'='true'
      ) THEN
        INSERT INTO public.audit_logs(table_name, action_type, record_id, old_values, new_values, changed_fields)
        VALUES ('fund_transfers', 'update', t.id,
          jsonb_build_object('event','batch_repair','transfer_number',t.transfer_number),
          jsonb_build_object('event','batch_repair','repair_result',result,'validation_rerun',true),
          COALESCE(ARRAY(SELECT jsonb_array_elements_text(result->'repaired_fields')), ARRAY[]::text[]));
      END IF;
    ELSE
      skipped := skipped + 1;
      skipped_details := skipped_details || jsonb_build_array(jsonb_build_object(
        'fund_transfer_id', t.id, 'transfer_number', t.transfer_number,
        'reason', COALESCE(result->>'reason', 'Repair did not pass validation')));
    END IF;
  END LOOP;
  RETURN jsonb_build_object('total_scanned', scanned, 'automatically_repaired', repaired,
    'skipped', skipped, 'skipped_details', skipped_details);
END;
$$;

NOTIFY pgrst, 'reload schema';
