/*
  # Fix Overly Permissive RLS Policies - Part 5: Sales Operations

  1. Delivery Challans, Credit Notes, and Related Tables
     - Restrict to non-read-only users
*/

-- 1. delivery_challans
DROP POLICY IF EXISTS "Authenticated users can create delivery challans" ON delivery_challans;
DROP POLICY IF EXISTS "Authenticated users can update delivery challans" ON delivery_challans;
DROP POLICY IF EXISTS "Authenticated users can delete delivery challans" ON delivery_challans;

CREATE POLICY "Authenticated users can create delivery challans"
  ON delivery_challans FOR INSERT
  TO authenticated
  WITH CHECK (NOT is_read_only_user());

CREATE POLICY "Authenticated users can update delivery challans"
  ON delivery_challans FOR UPDATE
  TO authenticated
  USING (NOT is_read_only_user())
  WITH CHECK (NOT is_read_only_user());

CREATE POLICY "Authenticated users can delete delivery challans"
  ON delivery_challans FOR DELETE
  TO authenticated
  USING (NOT is_read_only_user());

-- 2. delivery_challan_items
DROP POLICY IF EXISTS "Authenticated users can create delivery challan items" ON delivery_challan_items;
DROP POLICY IF EXISTS "Authenticated users can update delivery challan items" ON delivery_challan_items;

CREATE POLICY "Authenticated users can create delivery challan items"
  ON delivery_challan_items FOR INSERT
  TO authenticated
  WITH CHECK (NOT is_read_only_user());

CREATE POLICY "Authenticated users can update delivery challan items"
  ON delivery_challan_items FOR UPDATE
  TO authenticated
  USING (NOT is_read_only_user())
  WITH CHECK (NOT is_read_only_user());

-- 3. credit_notes
DROP POLICY IF EXISTS "Users can create credit notes" ON credit_notes;
CREATE POLICY "Users can create credit notes"
  ON credit_notes FOR INSERT
  TO authenticated
  WITH CHECK (NOT is_read_only_user());

-- 4. credit_note_items
DROP POLICY IF EXISTS "Users can insert credit note items" ON credit_note_items;
DROP POLICY IF EXISTS "Users can delete credit note items" ON credit_note_items;

CREATE POLICY "Users can insert credit note items"
  ON credit_note_items FOR INSERT
  TO authenticated
  WITH CHECK (NOT is_read_only_user());

CREATE POLICY "Users can delete credit note items"
  ON credit_note_items FOR DELETE
  TO authenticated
  USING (NOT is_read_only_user());

-- 5. stock_reservations
DROP POLICY IF EXISTS "Authenticated users can manage stock reservations" ON stock_reservations;
CREATE POLICY "Authenticated users can manage stock reservations"
  ON stock_reservations FOR ALL
  TO authenticated
  USING (NOT is_read_only_user())
  WITH CHECK (NOT is_read_only_user());
