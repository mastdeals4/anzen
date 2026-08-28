/*
  # Fix User Profiles Visibility for Task Assignment

  1. Changes
    - Drop restrictive SELECT policy that only allows users to see their own profile
    - Add new policy that allows all authenticated users to view all user profiles
    - This enables task assignment dropdowns to show all users

  2. Security
    - Users can still only update/delete their own profiles
    - All authenticated users can view all profiles (needed for task assignment, collaboration features)
*/

-- Drop the restrictive policy
DROP POLICY IF EXISTS "Users can view own profile" ON user_profiles;

-- Create new policy that allows all authenticated users to view all profiles
CREATE POLICY "Authenticated users can view all profiles"
  ON user_profiles
  FOR SELECT
  TO authenticated
  USING (true);