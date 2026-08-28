/*
  # Fix Missing Batch Inventory Transaction Trigger

  ## Problem
  The trigger `trigger_create_batch_inventory_transaction` was dropped at some point
  (likely removed by a migration that cleaned up or rewrote triggers). This means
  any new batch inserted after that point has NO purchase transaction in inventory_transactions.

  18 batches currently have stock but no corresponding purchase transaction,
  making their transaction history appear empty.

  ## Solution
  1. Create a proper trigger function that fires on batch INSERT
  2. Re-create the trigger on the batches table
  3. Backfill the 18 orphaned batches with their missing purchase transactions
  4. Add a guard so this never breaks silently again

  ## Affected Batches (backfilled)
  - KET/125100608 (Ketoconazole), MLAH0260425 (Meloxicam), SCPL/MF/014/2025 (Mometasone Furoate)
  - XMEP250178 (Cefixime USP), BCYPH/2510070 (Cyproheptadine), BLRD/2509044 (Loratadine)
  - DFK/125090136 (Diclofenac Potassium), BDOM/2509043 (Domperidone BP)
  - BDM/2510066 (Domperidone Maleate BP), 17721025 + 17731025 (Sulfamethoxazole x2)
  - TMP02260001 (Trimethoprim), 4002/1101/25/A-0512B (Ibuprofen USP)
  - 4001/1101/25/A-4276, 4001/1101/25/A-4277, 4001/1101/25/A-4632 (Ibuprofen BP x3)
  - M1CFX10003625N, M1CFX10003725N (Cefixime Trihydrate x2)
*/

-- Step 1: Create the trigger function (replaces the old non-trigger version)
CREATE OR REPLACE FUNCTION public.auto_create_batch_purchase_transaction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO inventory_transactions (
    product_id,
    batch_id,
    transaction_type,
    quantity,
    transaction_date,
    reference_number,
    notes,
    created_by
  ) VALUES (
    NEW.product_id,
    NEW.id,
    'purchase',
    NEW.import_quantity,
    NEW.import_date,
    NEW.batch_number,
    'Batch import: ' || NEW.batch_number,
    NEW.created_by
  );
  RETURN NEW;
END;
$$;

-- Step 2: Drop any old version of the trigger and re-create
DROP TRIGGER IF EXISTS trigger_create_batch_inventory_transaction ON batches;
DROP TRIGGER IF EXISTS trg_auto_batch_purchase_transaction ON batches;

CREATE TRIGGER trg_auto_batch_purchase_transaction
  AFTER INSERT ON batches
  FOR EACH ROW
  EXECUTE FUNCTION auto_create_batch_purchase_transaction();

-- Step 3: Backfill the 18 orphaned batches that have no purchase transaction
INSERT INTO inventory_transactions (
  product_id,
  batch_id,
  transaction_type,
  quantity,
  transaction_date,
  reference_number,
  notes,
  created_by
)
SELECT
  b.product_id,
  b.id,
  'purchase',
  b.import_quantity,
  b.import_date,
  b.batch_number,
  'Batch import: ' || b.batch_number || ' [backfilled]',
  b.created_by
FROM batches b
WHERE NOT EXISTS (
  SELECT 1 FROM inventory_transactions it
  WHERE it.batch_id = b.id AND it.transaction_type = 'purchase'
);
