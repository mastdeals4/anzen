/*
  # Add Warehouse Access to Material Returns and Stock Rejections

  1. Changes
    - Add warehouse role to material_returns policies (need to process returns)
    - Add warehouse role to stock_rejections policies (need to handle rejected stock)
    - Clean up duplicate policies where they exist
    
  2. Security
    - Warehouse staff handle physical returns and rejections
    - Still requires authenticated + active user
*/

-- =============================================
-- MATERIAL RETURNS: Add warehouse access
-- =============================================
DROP POLICY IF EXISTS "Users can view material returns" ON material_returns;
DROP POLICY IF EXISTS "Allow users to view material_returns" ON material_returns;
DROP POLICY IF EXISTS "Manager and admin can insert material_returns" ON material_returns;
DROP POLICY IF EXISTS "Manager and admin can update material_returns" ON material_returns;

-- SELECT: All relevant roles can view
CREATE POLICY "Allow users to view material_returns"
  ON material_returns
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'warehouse', 'sales', 'accounts', 'manager', 'auditor_ca')
    )
  );

-- INSERT: Admin, manager, warehouse can create
CREATE POLICY "Manager, admin, and warehouse can insert material_returns"
  ON material_returns
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'manager', 'warehouse')
        AND user_profiles.is_active = true
    )
  );

-- UPDATE: Admin, manager, warehouse can update
CREATE POLICY "Manager, admin, and warehouse can update material_returns"
  ON material_returns
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'manager', 'warehouse')
        AND user_profiles.is_active = true
    )
  );

-- =============================================
-- MATERIAL RETURN ITEMS: Add warehouse access
-- =============================================
DROP POLICY IF EXISTS "Users can view material return items" ON material_return_items;
DROP POLICY IF EXISTS "Manager and admin can insert material_return_items" ON material_return_items;
DROP POLICY IF EXISTS "Manager and admin can update material_return_items" ON material_return_items;
DROP POLICY IF EXISTS "Manager and admin can delete material_return_items" ON material_return_items;

CREATE POLICY "Users can view material return items"
  ON material_return_items
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'warehouse', 'sales', 'accounts', 'manager', 'auditor_ca')
    )
  );

CREATE POLICY "Manager, admin, and warehouse can insert material_return_items"
  ON material_return_items
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'manager', 'warehouse')
        AND user_profiles.is_active = true
    )
  );

CREATE POLICY "Manager, admin, and warehouse can update material_return_items"
  ON material_return_items
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'manager', 'warehouse')
        AND user_profiles.is_active = true
    )
  );

CREATE POLICY "Manager, admin, and warehouse can delete material_return_items"
  ON material_return_items
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'manager', 'warehouse')
        AND user_profiles.is_active = true
    )
  );

-- =============================================
-- STOCK REJECTIONS: Add warehouse access
-- =============================================
DROP POLICY IF EXISTS "Users can view stock rejections" ON stock_rejections;
DROP POLICY IF EXISTS "Manager and admin can insert stock_rejections" ON stock_rejections;
DROP POLICY IF EXISTS "Manager and admin can update stock_rejections" ON stock_rejections;

CREATE POLICY "Users can view stock rejections"
  ON stock_rejections
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'warehouse', 'sales', 'accounts', 'manager', 'auditor_ca')
    )
  );

CREATE POLICY "Manager, admin, and warehouse can insert stock_rejections"
  ON stock_rejections
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'manager', 'warehouse')
        AND user_profiles.is_active = true
    )
  );

CREATE POLICY "Manager, admin, and warehouse can update stock_rejections"
  ON stock_rejections
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'manager', 'warehouse')
        AND user_profiles.is_active = true
    )
  );
