/*
  # Fix Security Issues - Part 4: Remove Duplicate Policies
  
  1. Multiple Permissive Policies
    - Remove duplicate anon policy on user_profiles
    - Keep only "Allow username lookup for login" policy
*/

-- Remove duplicate anon policy
DROP POLICY IF EXISTS "Anyone can lookup username for login" ON public.user_profiles;
