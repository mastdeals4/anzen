/*
  # Fix Security Issues - Function Search Paths (Final)

  1. Purpose
    - Set immutable search_path for functions that don't have it yet
    - Functions already fixed: create_batch_inventory_transaction, sync_customer_from_inquiry, 
      update_inventory_on_batch_insert_or_update, update_updated_at_column

  2. Changes
    - Fix remaining functions: auto_create_followup, log_timeline_event, update_batch_stock
*/

-- Fix functions that don't have secure search_path yet
ALTER FUNCTION auto_create_followup(uuid, text, uuid) SET search_path = public, pg_temp;
ALTER FUNCTION log_timeline_event(uuid, text, text, text, text, text, uuid) SET search_path = public, pg_temp;
ALTER FUNCTION update_batch_stock(uuid, numeric) SET search_path = public, pg_temp;
