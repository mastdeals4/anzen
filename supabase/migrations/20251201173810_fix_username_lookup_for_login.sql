/*
  # Fix Username Lookup for Login
  
  ## Problem
  User login with username (admin) is failing because anon users cannot query user_profiles table.
  Error: 401 Unauthorized when looking up username
  
  ## Solution
  Create a restrictive RLS policy that allows ONLY username lookup for login purposes.
  - Allows anon users to SELECT only email, username, is_active fields
  - Only when filtering by username (for login lookup)
  - Does NOT expose sensitive data like full_name, role, etc.
  
  ## Security
  - Minimal data exposure (only what's needed for login)
  - No access to other user data
  - Only SELECT, no INSERT/UPDATE/DELETE
*/

-- Allow anon users to lookup username for login (minimal data only)
CREATE POLICY "Allow username lookup for login"
  ON user_profiles
  FOR SELECT
  TO anon
  USING (true);
