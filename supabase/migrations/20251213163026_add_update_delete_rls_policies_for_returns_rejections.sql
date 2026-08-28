/*
  # Add UPDATE and DELETE RLS Policies for Material Returns and Stock Rejections

  ## Purpose
  Add comprehensive Row Level Security (RLS) policies to allow proper UPDATE and DELETE operations
  on material_returns and stock_rejections tables with appropriate permission checks.

  ## Changes Made

  ### 1. Material Returns Policies
  - **UPDATE Policy**: Allow users to update their own pending_approval returns, or managers/admins to update any
  - **DELETE Policy**: Allow users to delete their own pending_approval returns, or managers/admins to delete any pending returns

  ### 2. Stock Rejections Policies
  - **UPDATE Policy**: Allow users to update their own pending_approval rejections, or managers/admins to update any
  - **DELETE Policy**: Allow users to delete their own pending_approval rejections, or managers/admins to delete any pending rejections

  ## Security Notes
  - All policies enforce that only pending_approval status records can be edited or deleted
  - Users can only modify their own records unless they have manager or admin role
  - Managers and admins can modify any pending_approval records for oversight purposes
  - Approved, rejected, or completed records are protected from modification
*/

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Users can update own pending material returns or managers can update any" ON material_returns;
DROP POLICY IF EXISTS "Users can delete own pending material returns or managers can delete any" ON material_returns;
DROP POLICY IF EXISTS "Users can update own pending stock rejections or managers can update any" ON stock_rejections;
DROP POLICY IF EXISTS "Users can delete own pending stock rejections or managers can delete any" ON stock_rejections;

-- Material Returns UPDATE Policy
CREATE POLICY "Users can update own pending material returns or managers can update any"
  ON material_returns
  FOR UPDATE
  TO authenticated
  USING (
    status = 'pending_approval' AND (
      created_by = auth.uid() OR
      EXISTS (
        SELECT 1 FROM user_profiles
        WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('manager', 'admin')
      )
    )
  )
  WITH CHECK (
    status = 'pending_approval' AND (
      created_by = auth.uid() OR
      EXISTS (
        SELECT 1 FROM user_profiles
        WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('manager', 'admin')
      )
    )
  );

-- Material Returns DELETE Policy
CREATE POLICY "Users can delete own pending material returns or managers can delete any"
  ON material_returns
  FOR DELETE
  TO authenticated
  USING (
    status = 'pending_approval' AND (
      created_by = auth.uid() OR
      EXISTS (
        SELECT 1 FROM user_profiles
        WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('manager', 'admin')
      )
    )
  );

-- Stock Rejections UPDATE Policy
CREATE POLICY "Users can update own pending stock rejections or managers can update any"
  ON stock_rejections
  FOR UPDATE
  TO authenticated
  USING (
    status = 'pending_approval' AND (
      created_by = auth.uid() OR
      EXISTS (
        SELECT 1 FROM user_profiles
        WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('manager', 'admin')
      )
    )
  )
  WITH CHECK (
    status = 'pending_approval' AND (
      created_by = auth.uid() OR
      EXISTS (
        SELECT 1 FROM user_profiles
        WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('manager', 'admin')
      )
    )
  );

-- Stock Rejections DELETE Policy
CREATE POLICY "Users can delete own pending stock rejections or managers can delete any"
  ON stock_rejections
  FOR DELETE
  TO authenticated
  USING (
    status = 'pending_approval' AND (
      created_by = auth.uid() OR
      EXISTS (
        SELECT 1 FROM user_profiles
        WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('manager', 'admin')
      )
    )
  );
