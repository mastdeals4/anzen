/*
  # Add User Module Permissions System

  ## Overview
  Replaces the fixed role-based menu visibility with a flexible per-user module permission system.
  Admins can grant or revoke access to any module for any user through the Settings UI.

  ## New Tables
  - `user_permissions`
    - `id` (uuid, primary key)
    - `user_id` (uuid, FK to user_profiles) - which user
    - `module` (text) - module key matching sidebar nav IDs
    - `can_access` (boolean, default true) - whether user can see/use this module
    - `created_at` / `updated_at` (timestamps)
    - UNIQUE constraint on (user_id, module)

  ## Default Behavior
  - Admin users always have full access regardless of permissions table
  - When a user has NO rows in user_permissions, they fall back to role-based defaults
  - Once any permission row exists for a user, the table is the source of truth for that user

  ## Security
  - RLS enabled
  - Admins can read/write all permissions
  - Users can only read their own permissions
*/

CREATE TABLE IF NOT EXISTS user_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  module text NOT NULL,
  can_access boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (user_id, module)
);

ALTER TABLE user_permissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage all permissions"
  ON user_permissions
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role = 'admin'
    )
  );

CREATE POLICY "Admins can insert permissions"
  ON user_permissions
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role = 'admin'
    )
  );

CREATE POLICY "Admins can update permissions"
  ON user_permissions
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role = 'admin'
    )
  );

CREATE POLICY "Admins can delete permissions"
  ON user_permissions
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role = 'admin'
    )
  );

CREATE POLICY "Users can read own permissions"
  ON user_permissions
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_user_permissions_user_id ON user_permissions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_permissions_module ON user_permissions(module);

CREATE OR REPLACE FUNCTION update_user_permissions_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_user_permissions_updated_at
  BEFORE UPDATE ON user_permissions
  FOR EACH ROW
  EXECUTE FUNCTION update_user_permissions_updated_at();
