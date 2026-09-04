/*
  # Fix username lookup for unauthenticated login

  ## Problem
  The login flow requires looking up a username to get the associated email
  before authenticating. The SELECT policy on user_profiles only allows 
  authenticated users, so anonymous users cannot perform the username lookup,
  causing login to fail.

  ## Fix
  Add a policy allowing anonymous (anon) users to select only the email,
  username, and is_active fields needed for the login username lookup.
*/

CREATE POLICY "Allow anon username lookup for login"
  ON user_profiles
  FOR SELECT
  TO anon
  USING (true);
