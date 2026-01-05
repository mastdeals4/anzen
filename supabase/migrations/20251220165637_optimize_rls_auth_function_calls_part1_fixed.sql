/*
  # Optimize RLS Policies - Auth Function Initialization (Part 1)

  This migration optimizes RLS policies by replacing direct auth function calls with subquery initialization.
  This prevents re-evaluation of auth functions for each row, significantly improving query performance at scale.

  ## Changes
  
  ### Approval Workflows
  - Optimized: Users can view own approval requests
  - Optimized: Users can create approval requests
  - Optimized: Managers can update approval requests
  
  ### Approval Thresholds
  - Optimized: Admins can manage approval thresholds
  
  ### Material Returns
  - Optimized: Users can create material returns
  - Optimized: Managers can update material returns
  - Optimized: Users can update own pending material returns or managers can update
  - Optimized: Users can delete own pending material returns or managers can delete
  
  ### Material Return Items
  - Optimized: Users can manage return items
  
  ## Technical Details
  Replace: `auth.uid()` with `(select auth.uid())`
  This ensures the auth function is evaluated once per query, not once per row.
*/

-- Drop and recreate approval_workflows policies with optimized auth calls
DROP POLICY IF EXISTS "Users can view own approval requests" ON approval_workflows;
CREATE POLICY "Users can view own approval requests"
  ON approval_workflows FOR SELECT
  TO authenticated
  USING (requested_by = (select auth.uid()));

DROP POLICY IF EXISTS "Users can create approval requests" ON approval_workflows;
CREATE POLICY "Users can create approval requests"
  ON approval_workflows FOR INSERT
  TO authenticated
  WITH CHECK (requested_by = (select auth.uid()));

DROP POLICY IF EXISTS "Managers can update approval requests" ON approval_workflows;
CREATE POLICY "Managers can update approval requests"
  ON approval_workflows FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = (select auth.uid())
      AND role IN ('admin', 'manager')
    )
  );

-- Optimize approval_thresholds policies
DROP POLICY IF EXISTS "Admins can manage approval thresholds" ON approval_thresholds;
CREATE POLICY "Admins can manage approval thresholds"
  ON approval_thresholds FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = (select auth.uid())
      AND role = 'admin'
    )
  );

-- Optimize material_returns policies
DROP POLICY IF EXISTS "Users can create material returns" ON material_returns;
CREATE POLICY "Users can create material returns"
  ON material_returns FOR INSERT
  TO authenticated
  WITH CHECK (created_by = (select auth.uid()));

DROP POLICY IF EXISTS "Managers can update material returns" ON material_returns;
CREATE POLICY "Managers can update material returns"
  ON material_returns FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = (select auth.uid())
      AND role IN ('admin', 'manager')
    )
  );

DROP POLICY IF EXISTS "Users can update own pending material returns or managers can u" ON material_returns;
CREATE POLICY "Users can update own pending material returns or managers can update"
  ON material_returns FOR UPDATE
  TO authenticated
  USING (
    (created_by = (select auth.uid()) AND status = 'pending')
    OR EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = (select auth.uid())
      AND role IN ('admin', 'manager')
    )
  );

DROP POLICY IF EXISTS "Users can delete own pending material returns or managers can d" ON material_returns;
CREATE POLICY "Users can delete own pending material returns or managers can delete"
  ON material_returns FOR DELETE
  TO authenticated
  USING (
    (created_by = (select auth.uid()) AND status = 'pending')
    OR EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = (select auth.uid())
      AND role IN ('admin', 'manager')
    )
  );

-- Optimize material_return_items policies
DROP POLICY IF EXISTS "Users can manage return items" ON material_return_items;
CREATE POLICY "Users can manage return items"
  ON material_return_items FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM material_returns mr
      WHERE mr.id = material_return_items.return_id
      AND (
        mr.created_by = (select auth.uid())
        OR EXISTS (
          SELECT 1 FROM user_profiles
          WHERE id = (select auth.uid())
          AND role IN ('admin', 'manager')
        )
      )
    )
  );
