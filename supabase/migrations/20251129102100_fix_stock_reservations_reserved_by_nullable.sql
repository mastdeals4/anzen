/*
  # Fix: Make reserved_by nullable in stock_reservations
  
  ## Problem
  The stock_reservations table has reserved_by as NOT NULL, but automated 
  reservation functions (like fn_reserve_stock_for_so_v2) don't have a user context.
  
  ## Solution
  Make reserved_by nullable to allow system-initiated reservations.
  
  ## Changes
  - ALTER stock_reservations.reserved_by to allow NULL
*/

ALTER TABLE stock_reservations 
ALTER COLUMN reserved_by DROP NOT NULL;
