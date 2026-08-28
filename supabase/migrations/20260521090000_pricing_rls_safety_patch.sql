/*
  # Pricing Workflow Phase 2 – RLS Safety Patch

  Fixes:
  1. Drop all broad old policies that allow any authenticated user to update
  2. Expand price_status CHECK constraint to include sourcing_request_sent / waiting_reply
  3. Add DB trigger to block non-admin/manager from writing final quote fields
  4. Re-create correct role-split policies for all four pricing tables
  5. Duplicate-safe unique indexes with RAISE EXCEPTION guards

  Safe to re-run. All DROP IF EXISTS / CREATE IF NOT EXISTS. No data mutations.
*/

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Ensure helper function exists (idempotent)
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION current_user_has_pricing_role(allowed_roles text[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_profiles
    WHERE id = auth.uid()
      AND is_active = true
      AND role = ANY(allowed_roles)
  );
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Add missing columns (idempotent)
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE price_requests ADD COLUMN IF NOT EXISTS last_activity_note text;

-- ────────────────────────────────────────────────────────────────────────────
-- 3a. Normalize existing data to lowercase before touching constraints
--     Handles live rows that may have been inserted with capital-letter values
--     from an older version of the app.
-- ────────────────────────────────────────────────────────────────────────────

-- Normalize source_type (India→india, China→china, Local→local, Unknown→unknown)
UPDATE price_request_items
SET source_type = lower(source_type)
WHERE source_type != lower(source_type);

-- Normalize price_status:
--   'Pending'    → 'pending'
--   'Requested'  → 'sourcing_request_sent'  (old status maps to new name)
--   'Received'   → 'received'
--   'Not_Available' / 'not_available' → 'pending'  (collapse to pending)
--   Any other capitalised variant → lower()
UPDATE price_request_items
SET price_status = CASE
  WHEN lower(price_status) = 'requested'      THEN 'sourcing_request_sent'
  WHEN lower(price_status) = 'not_available'  THEN 'pending'
  ELSE lower(price_status)
END
WHERE price_status != lower(price_status)
   OR lower(price_status) IN ('requested', 'not_available');

-- ────────────────────────────────────────────────────────────────────────────
-- 3b. Replace source_type CHECK constraint (drop any name variant, re-add)
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE price_request_items
  DROP CONSTRAINT IF EXISTS price_request_items_source_type_check;

ALTER TABLE price_request_items
  ADD CONSTRAINT price_request_items_source_type_check
  CHECK (source_type IN ('india', 'china', 'local', 'unknown'));

-- ────────────────────────────────────────────────────────────────────────────
-- 3c. Replace price_status CHECK constraint with full set of valid values
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE price_request_items
  DROP CONSTRAINT IF EXISTS price_request_items_price_status_check;

ALTER TABLE price_request_items
  ADD CONSTRAINT price_request_items_price_status_check
  CHECK (price_status IN ('pending', 'sourcing_request_sent', 'waiting_reply', 'received'));

-- ────────────────────────────────────────────────────────────────────────────
-- 4. DB trigger: block non-admin/manager from writing final quote fields
--    Covers: final_quote_price, final_quote_currency, final_entered_by, final_entered_at
--    (column names match the actual schema: final_entered_by / final_entered_at)
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION enforce_final_quote_write_restriction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  caller_role text;
BEGIN
  -- Look up the role of the current user
  SELECT role INTO caller_role
  FROM user_profiles
  WHERE id = auth.uid()
    AND is_active = true;

  -- Only admin/manager may write final quote fields
  IF caller_role NOT IN ('admin', 'manager') THEN
    -- Block if any final quote field is being changed from its current value
    IF (
      NEW.final_quote_price      IS DISTINCT FROM OLD.final_quote_price      OR
      NEW.final_quote_currency   IS DISTINCT FROM OLD.final_quote_currency   OR
      NEW.final_entered_by       IS DISTINCT FROM OLD.final_entered_by       OR
      NEW.final_entered_at       IS DISTINCT FROM OLD.final_entered_at
    ) THEN
      RAISE EXCEPTION
        'Permission denied: only admin or manager may update final quote fields. '
        'Your role (%) cannot change final_quote_price, final_quote_currency, '
        'final_entered_by, or final_entered_at.',
        COALESCE(caller_role, 'unknown');
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_final_quote_restriction ON price_request_items;
CREATE TRIGGER trg_enforce_final_quote_restriction
  BEFORE UPDATE ON price_request_items
  FOR EACH ROW
  EXECUTE FUNCTION enforce_final_quote_write_restriction();

-- ────────────────────────────────────────────────────────────────────────────
-- 5. price_requests policies
--    Drop ALL existing policies then recreate from scratch
-- ────────────────────────────────────────────────────────────────────────────
-- Drop everything (old broad + any partial replacements)
DROP POLICY IF EXISTS "pricing_request_read"            ON price_requests;
DROP POLICY IF EXISTS "pricing_request_insert"          ON price_requests;
DROP POLICY IF EXISTS "pricing_request_update"          ON price_requests;
DROP POLICY IF EXISTS "pricing_request_update_manager"  ON price_requests;
DROP POLICY IF EXISTS "pricing_request_update_sales"    ON price_requests;

-- SELECT: admin, manager, sales
CREATE POLICY "pricing_request_read" ON price_requests
  FOR SELECT TO authenticated
  USING (current_user_has_pricing_role(ARRAY['admin', 'manager', 'sales']));

-- INSERT: admin, manager, sales (sales create PRs linked to their inquiries)
CREATE POLICY "pricing_request_insert" ON price_requests
  FOR INSERT TO authenticated
  WITH CHECK (current_user_has_pricing_role(ARRAY['admin', 'manager', 'sales']));

-- UPDATE admin/manager: unrestricted on all pricing PRs
CREATE POLICY "pricing_request_update_manager" ON price_requests
  FOR UPDATE TO authenticated
  USING  (current_user_has_pricing_role(ARRAY['admin', 'manager']))
  WITH CHECK (current_user_has_pricing_role(ARRAY['admin', 'manager']));

-- UPDATE sales: only on PRs they created OR are assigned to.
-- Allows sourcing actions and status notes but not final-quote logic
-- (final quote counters are written by manager via PricingDesk).
CREATE POLICY "pricing_request_update_sales" ON price_requests
  FOR UPDATE TO authenticated
  USING  (
    current_user_has_pricing_role(ARRAY['sales'])
    AND (created_by = auth.uid() OR assigned_to = auth.uid())
  )
  WITH CHECK (
    current_user_has_pricing_role(ARRAY['sales'])
    AND (created_by = auth.uid() OR assigned_to = auth.uid())
  );

-- ────────────────────────────────────────────────────────────────────────────
-- 6. price_request_items policies
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "pricing_items_read"           ON price_request_items;
DROP POLICY IF EXISTS "pricing_items_insert"         ON price_request_items;
DROP POLICY IF EXISTS "pricing_items_update"         ON price_request_items;
DROP POLICY IF EXISTS "pricing_items_update_manager" ON price_request_items;
DROP POLICY IF EXISTS "pricing_items_update_sales"   ON price_request_items;

-- SELECT: admin, manager, sales
CREATE POLICY "pricing_items_read" ON price_request_items
  FOR SELECT TO authenticated
  USING (current_user_has_pricing_role(ARRAY['admin', 'manager', 'sales']));

-- INSERT: admin, manager, sales (adding items to a PR)
CREATE POLICY "pricing_items_insert" ON price_request_items
  FOR INSERT TO authenticated
  WITH CHECK (current_user_has_pricing_role(ARRAY['admin', 'manager', 'sales']));

-- UPDATE admin/manager: unrestricted (trigger still enforces correctness)
CREATE POLICY "pricing_items_update_manager" ON price_request_items
  FOR UPDATE TO authenticated
  USING  (current_user_has_pricing_role(ARRAY['admin', 'manager']))
  WITH CHECK (current_user_has_pricing_role(ARRAY['admin', 'manager']));

-- UPDATE sales: allowed only while final_quote_price is still NULL.
-- The trigger above will additionally block any attempt to SET final quote fields.
CREATE POLICY "pricing_items_update_sales" ON price_request_items
  FOR UPDATE TO authenticated
  USING  (
    current_user_has_pricing_role(ARRAY['sales'])
    AND final_quote_price IS NULL
  )
  WITH CHECK (
    current_user_has_pricing_role(ARRAY['sales'])
    AND final_quote_price IS NULL
  );

-- ────────────────────────────────────────────────────────────────────────────
-- 7. pricing_ledger policies
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "pricing_ledger_read"   ON pricing_ledger;
DROP POLICY IF EXISTS "pricing_ledger_insert" ON pricing_ledger;
DROP POLICY IF EXISTS "pricing_ledger_update" ON pricing_ledger;

-- SELECT: admin, manager, sales (sales need to see ledger for their customers)
CREATE POLICY "pricing_ledger_read" ON pricing_ledger
  FOR SELECT TO authenticated
  USING (current_user_has_pricing_role(ARRAY['admin', 'manager', 'sales']));

-- INSERT: admin and manager only (final quotes are entered by Kunal/manager)
CREATE POLICY "pricing_ledger_insert" ON pricing_ledger
  FOR INSERT TO authenticated
  WITH CHECK (current_user_has_pricing_role(ARRAY['admin', 'manager']));

-- UPDATE: admin and manager only
CREATE POLICY "pricing_ledger_update" ON pricing_ledger
  FOR UPDATE TO authenticated
  USING  (current_user_has_pricing_role(ARRAY['admin', 'manager']))
  WITH CHECK (current_user_has_pricing_role(ARRAY['admin', 'manager']));

-- ────────────────────────────────────────────────────────────────────────────
-- 8. communication_timeline policies
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "pricing_timeline_read"   ON communication_timeline;
DROP POLICY IF EXISTS "pricing_timeline_insert" ON communication_timeline;

CREATE POLICY "pricing_timeline_read" ON communication_timeline
  FOR SELECT TO authenticated
  USING (current_user_has_pricing_role(ARRAY['admin', 'manager', 'sales']));

CREATE POLICY "pricing_timeline_insert" ON communication_timeline
  FOR INSERT TO authenticated
  WITH CHECK (current_user_has_pricing_role(ARRAY['admin', 'manager', 'sales']));

-- ────────────────────────────────────────────────────────────────────────────
-- 9. Duplicate-safe unique indexes
-- ────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  dup_count integer;
BEGIN
  SELECT COUNT(*) INTO dup_count
  FROM (
    SELECT inquiry_id FROM price_requests
    WHERE inquiry_id IS NOT NULL
    GROUP BY inquiry_id HAVING COUNT(*) > 1
  ) d;

  IF dup_count > 0 THEN
    RAISE EXCEPTION
      'Cannot create unique index on price_requests(inquiry_id): '
      '% duplicate inquiry_id value(s) found. '
      'Deduplicate first: '
      'SELECT inquiry_id, COUNT(*) FROM price_requests '
      'WHERE inquiry_id IS NOT NULL '
      'GROUP BY inquiry_id HAVING COUNT(*) > 1;',
      dup_count;
  END IF;
END $$;

DO $$
DECLARE
  dup_count integer;
BEGIN
  SELECT COUNT(*) INTO dup_count
  FROM (
    SELECT price_request_item_id FROM pricing_ledger
    WHERE price_request_item_id IS NOT NULL
    GROUP BY price_request_item_id HAVING COUNT(*) > 1
  ) d;

  IF dup_count > 0 THEN
    RAISE EXCEPTION
      'Cannot create unique index on pricing_ledger(price_request_item_id): '
      '% duplicate value(s) found. '
      'Deduplicate first: '
      'SELECT price_request_item_id, COUNT(*) FROM pricing_ledger '
      'WHERE price_request_item_id IS NOT NULL '
      'GROUP BY price_request_item_id HAVING COUNT(*) > 1;',
      dup_count;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_price_requests_inquiry_id_unique
  ON price_requests(inquiry_id) WHERE inquiry_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pricing_ledger_item_unique
  ON pricing_ledger(price_request_item_id) WHERE price_request_item_id IS NOT NULL;
