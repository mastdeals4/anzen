/*
  # Fix User Creation - Add Username Support
  
  1. Changes
    - Update auto_create_user_profile trigger to extract username from metadata
    - Generate username from email if not provided in metadata
    - Fix database error when creating new users
  
  2. Notes
    - Username is required in user_profiles table
    - Trigger now handles this requirement properly
*/

-- Drop and recreate the trigger function with username support
CREATE OR REPLACE FUNCTION public.auto_create_user_profile()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public, auth
LANGUAGE plpgsql
AS $$
DECLARE
  v_username text;
BEGIN
  -- Extract username from metadata or generate from email
  v_username := COALESCE(
    NEW.raw_user_meta_data->>'username',
    LOWER(SPLIT_PART(NEW.email, '@', 1))
  );
  
  -- Make sure username is unique by appending a number if needed
  WHILE EXISTS (SELECT 1 FROM public.user_profiles WHERE username = v_username) LOOP
    v_username := v_username || floor(random() * 1000)::text;
  END LOOP;
  
  INSERT INTO public.user_profiles (id, username, email, full_name, role)
  VALUES (
    NEW.id,
    v_username,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email),
    COALESCE(NEW.raw_user_meta_data->>'role', 'user')
  );
  
  RETURN NEW;
EXCEPTION
  WHEN unique_violation THEN
    -- If still a unique violation, try one more time with timestamp
    v_username := v_username || extract(epoch from now())::bigint::text;
    INSERT INTO public.user_profiles (id, username, email, full_name, role)
    VALUES (
      NEW.id,
      v_username,
      NEW.email,
      COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email),
      COALESCE(NEW.raw_user_meta_data->>'role', 'user')
    );
    RETURN NEW;
END;
$$;

-- Ensure trigger exists
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.auto_create_user_profile();
