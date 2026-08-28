/*
  # Remove Duplicate Permissive Policies

  1. Changes
    - Remove old overly-permissive policies that conflict with role-based ones
    - Keep only the proper role-based policies with warehouse access
    
  2. Security
    - Ensures only one policy per operation (no conflicts)
    - Maintains warehouse role access where needed
*/

-- Remove duplicate delivery challan policies
DROP POLICY IF EXISTS "Authenticated users can create delivery challans" ON delivery_challans;
DROP POLICY IF EXISTS "Authenticated users can update delivery challans" ON delivery_challans;
DROP POLICY IF EXISTS "Authenticated users can delete delivery challans" ON delivery_challans;

-- Remove duplicate material returns policies
DROP POLICY IF EXISTS "Users can create material returns" ON material_returns;
DROP POLICY IF EXISTS "Users and managers can update material returns" ON material_returns;
DROP POLICY IF EXISTS "Users can delete own pending material returns or managers can d" ON material_returns;

-- Remove duplicate stock rejections policies
DROP POLICY IF EXISTS "Users can create stock rejections" ON stock_rejections;
DROP POLICY IF EXISTS "Users and managers can update stock rejections" ON stock_rejections;
DROP POLICY IF EXISTS "Users can delete own pending stock rejections or managers can d" ON stock_rejections;

-- Remove duplicate sales orders policies (keep existing role-based ones)
DROP POLICY IF EXISTS "Users can create sales orders" ON sales_orders;
DROP POLICY IF EXISTS "Users and admins can update sales orders" ON sales_orders;
DROP POLICY IF EXISTS "Users can delete own draft sales orders" ON sales_orders;

-- Recreate proper sales orders policies WITH warehouse role
CREATE POLICY "Admin and sales can insert sales_orders"
  ON sales_orders
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'sales')
        AND user_profiles.is_active = true
    )
  );

CREATE POLICY "Admin and sales can update sales_orders"
  ON sales_orders
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'sales')
        AND user_profiles.is_active = true
    )
  );

CREATE POLICY "Admin can delete sales_orders"
  ON sales_orders
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role = 'admin'
        AND user_profiles.is_active = true
    )
  );

-- Remove duplicate batches policy
DROP POLICY IF EXISTS "All authenticated users can view batches" ON batches;
