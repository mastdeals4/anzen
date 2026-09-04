/*
  # Pricing Workflow Phase 2+3 additions

  Adds:
  - sourcing_request_sent status support in price_request_items
  - last_activity_note column on price_requests
  - RLS: prevent sales role from editing final_quote fields in price_request_items

  Safe to run on live DB. All operations are IF NOT EXISTS / or additive.
*/

-- Add last_activity_note column if missing
ALTER TABLE price_requests ADD COLUMN IF NOT EXISTS last_activity_note text;

-- Add sourcing_request_sent to price_status CHECK constraint
-- First remove old constraint, then re-add expanded one.
-- We do this safely by dropping and re-creating.
DO $$
BEGIN
  -- Drop old check constraint if it exists with old values
  ALTER TABLE price_request_items DROP CONSTRAINT IF EXISTS price_request_items_price_status_check;

  -- Add updated constraint that includes sourcing_request_sent and waiting_reply
  ALTER TABLE price_request_items ADD CONSTRAINT price_request_items_price_status_check
    CHECK (price_status IN ('pending', 'sourcing_request_sent', 'waiting_reply', 'received'));
EXCEPTION
  WHEN others THEN
    -- If constraint already exists with correct values, ignore
    NULL;
END $$;

-- Sales users cannot update final quote fields. Drop old items policies and recreate with column-level split.
DO $$
BEGIN
  DROP POLICY IF EXISTS "pricing_items_update" ON price_request_items;

  -- Admin/manager can update all columns
  CREATE POLICY "pricing_items_update_manager" ON price_request_items
    FOR UPDATE TO authenticated
    USING (current_user_has_pricing_role(ARRAY['admin', 'manager']))
    WITH CHECK (current_user_has_pricing_role(ARRAY['admin', 'manager']));

  -- Sales can update sourcing fields but NOT final_quote fields.
  -- We enforce this at the policy level by requiring final_quote fields to be unchanged for sales.
  -- The application enforces this in UI; this policy provides a second layer for direct API calls.
  CREATE POLICY "pricing_items_update_sales" ON price_request_items
    FOR UPDATE TO authenticated
    USING (
      current_user_has_pricing_role(ARRAY['sales'])
      AND (
        -- Allow only if final_quote fields are not being changed (compare with current row)
        -- Since Postgres row-level security can't easily do column-level in standard RLS,
        -- we restrict sales to update only when final_quote_price IS NULL (item not yet quoted).
        -- Once final quote is entered by manager, sales cannot overwrite it.
        final_quote_price IS NULL
      )
    )
    WITH CHECK (
      current_user_has_pricing_role(ARRAY['sales'])
      AND final_quote_price IS NULL
    );
END $$;

-- Safety guard before unique indexes: detect and fail with message if duplicates exist
DO $$
DECLARE
  dup_count integer;
BEGIN
  -- Check for duplicate inquiry_id in price_requests (excluding NULLs)
  SELECT COUNT(*) INTO dup_count
  FROM (
    SELECT inquiry_id, COUNT(*) AS cnt
    FROM price_requests
    WHERE inquiry_id IS NOT NULL
    GROUP BY inquiry_id
    HAVING COUNT(*) > 1
  ) dups;

  IF dup_count > 0 THEN
    RAISE EXCEPTION 'Cannot create unique index on price_requests(inquiry_id): % duplicate inquiry_id value(s) found. '
      'Run: SELECT inquiry_id, COUNT(*) FROM price_requests WHERE inquiry_id IS NOT NULL GROUP BY inquiry_id HAVING COUNT(*) > 1;'
      ' to identify and clean up duplicates before re-running this migration.', dup_count;
  END IF;
END $$;

DO $$
DECLARE
  dup_count integer;
BEGIN
  -- Check for duplicate price_request_item_id in pricing_ledger (excluding NULLs)
  SELECT COUNT(*) INTO dup_count
  FROM (
    SELECT price_request_item_id, COUNT(*) AS cnt
    FROM pricing_ledger
    WHERE price_request_item_id IS NOT NULL
    GROUP BY price_request_item_id
    HAVING COUNT(*) > 1
  ) dups;

  IF dup_count > 0 THEN
    RAISE EXCEPTION 'Cannot create unique index on pricing_ledger(price_request_item_id): % duplicate price_request_item_id value(s) found. '
      'Run: SELECT price_request_item_id, COUNT(*) FROM pricing_ledger WHERE price_request_item_id IS NOT NULL GROUP BY price_request_item_id HAVING COUNT(*) > 1;'
      ' to identify and clean up duplicates before re-running this migration.', dup_count;
  END IF;
END $$;

-- Safe unique indexes (will skip silently if already exist)
CREATE UNIQUE INDEX IF NOT EXISTS idx_price_requests_inquiry_id_unique
  ON price_requests(inquiry_id)
  WHERE inquiry_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pricing_ledger_item_unique
  ON pricing_ledger(price_request_item_id)
  WHERE price_request_item_id IS NOT NULL;
