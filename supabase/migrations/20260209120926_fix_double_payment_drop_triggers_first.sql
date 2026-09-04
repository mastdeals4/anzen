/*
  # Fix Double Payment - Step 1: Drop Old Triggers

  Drop all triggers on invoice_payment_allocations table before fixing
*/

DROP TRIGGER IF EXISTS trg_update_invoice_payment_from_allocations ON invoice_payment_allocations;
DROP TRIGGER IF EXISTS trigger_update_invoice_payment_status_from_allocation ON invoice_payment_allocations;
