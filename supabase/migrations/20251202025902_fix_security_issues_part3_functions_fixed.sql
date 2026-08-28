/*
  # Fix Security Issues - Part 3: Function Search Paths (Fixed)
  
  1. Function Search Path Fixes (11 functions)
    - Set stable search_path for all functions to prevent search_path hijacking
    - Using correct function signatures from database
*/

-- Trigger functions (no arguments)
ALTER FUNCTION public.trg_update_timestamp() 
  SET search_path = public, pg_temp;

ALTER FUNCTION public.auto_update_pipeline_status() 
  SET search_path = public, pg_temp;

ALTER FUNCTION public.auto_generate_inquiry_number() 
  SET search_path = public, pg_temp;

ALTER FUNCTION public.fn_restore_reservation_on_dc_delete() 
  SET search_path = public, pg_temp;

ALTER FUNCTION public.generate_inquiry_number() 
  SET search_path = public, pg_temp;

-- Functions with arguments
ALTER FUNCTION public.check_inquiry_requirements_fulfilled(uuid) 
  SET search_path = public, pg_temp;

ALTER FUNCTION public.mark_requirement_sent(uuid, text) 
  SET search_path = public, pg_temp;

ALTER FUNCTION public.fn_calculate_import_priority(date) 
  SET search_path = public, pg_temp;

ALTER FUNCTION public.fn_release_reservation_by_so_id(uuid, uuid) 
  SET search_path = public, pg_temp;

ALTER FUNCTION public.fn_release_partial_reservation(uuid, uuid, numeric, uuid) 
  SET search_path = public, pg_temp;

ALTER FUNCTION public.fn_deduct_stock_and_release_reservation(uuid, uuid, uuid, numeric, uuid) 
  SET search_path = public, pg_temp;
