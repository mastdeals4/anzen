-- Add idempotency support for inventory transactions
ALTER TABLE inventory_transactions
ADD COLUMN IF NOT EXISTS operation_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'inventory_transactions_operation_id_unique'
      AND conrelid = 'inventory_transactions'::regclass
  ) THEN
    ALTER TABLE inventory_transactions
    ADD CONSTRAINT inventory_transactions_operation_id_unique
    UNIQUE (operation_id);
  END IF;
END $$;
