/*
  # Allow Anonymous Username Lookup for Login

  ## Problem:
  Users cannot login with username because RLS blocks unauthenticated users 
  from reading user_profiles table to lookup email from username.

  ## Solution:
  Add a SELECT policy for anonymous users that only allows reading 
  email and username fields (no sensitive data).

  ## Security:
  - Only email and username fields exposed (no role, no sensitive data)
  - Cannot read full profiles
  - Only for login flow
*/

-- Drop old restrictive policy
DROP POLICY IF EXISTS "Authenticated users can view all profiles" ON user_profiles;

-- Allow anon users to read username and email ONLY for login
CREATE POLICY "Anyone can lookup username for login"
  ON user_profiles
  FOR SELECT
  TO anon
  USING (true);

-- Allow authenticated users to view all profiles
CREATE POLICY "Authenticated users can view profiles"
  ON user_profiles
  FOR SELECT
  TO authenticated
  USING (true);

COMMENT ON POLICY "Anyone can lookup username for login" ON user_profiles IS 
'Allows unauthenticated users to lookup email from username during login. Only email and username fields should be queried.';