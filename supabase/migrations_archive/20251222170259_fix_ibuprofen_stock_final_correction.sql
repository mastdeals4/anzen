/*
  # Fix Ibuprofen Stock - Final Correction
  
  ## Problem
  All Ibuprofen batch stock levels are WRONG:
  - A-3145: Shows 1500 kg, should be 850 kg (OFF BY +650 kg)
  - A-3146: Shows 100 kg, should be 400 kg (OFF BY -300 kg)
  - A-3147: Shows 50 kg, should be 200 kg (OFF BY -150 kg)
  
  ## Root Cause
  Previous fixes miscalculated stock. Need to recalculate from actual movements.
  
  ## Actual Movements
  A-3145:
  - Imported: 1000 kg
  - Delivered via DC-005: 150 kg
  - Sold via invoice: 0 kg
  - CORRECT STOCK: 1000 - 150 - 0 = 850 kg
  
  A-3146:
  - Imported: 1000 kg
  - Delivered via DC-005: 500 kg
  - Delivered via DC-007: 50 kg
  - Sold via SAPJ-009: 50 kg
  - CORRECT STOCK: 1000 - 500 - 50 - 50 = 400 kg
  
  A-3147:
  - Imported: 1000 kg
  - Delivered via DC-007: 400 kg
  - Sold via SAPJ-009: 400 kg
  - CORRECT STOCK: 1000 - 400 - 400 = 200 kg
  
  ## Fix Applied
  Set correct stock values for all three Ibuprofen batches
*/

-- Fix A-3145: Set to correct 850 kg
UPDATE batches
SET 
  current_stock = 850.000,
  updated_at = now()
WHERE batch_number = '4001/1101/25/A-3145';

-- Fix A-3146: Set to correct 400 kg
UPDATE batches
SET 
  current_stock = 400.000,
  updated_at = now()
WHERE batch_number = '4001/1101/25/A-3146';

-- Fix A-3147: Set to correct 200 kg
UPDATE batches
SET 
  current_stock = 200.000,
  updated_at = now()
WHERE batch_number = '4001/1101/25/A-3147';
