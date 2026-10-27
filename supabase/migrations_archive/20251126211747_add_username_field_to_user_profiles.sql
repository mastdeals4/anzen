/*
  # Add Username Field to User Profiles
  
  1. Changes
    - Add `username` field to `user_profiles` table for login (unique, not null)
    - Generate default usernames for existing users from their emails
    - Add index on username for faster lookups
    
  2. Security
    - Username must be unique across all users
    - Will be used for authentication instead of email
*/

-- Add username column to user_profiles (allow NULL temporarily for migration)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'user_profiles' AND column_name = 'username'
  ) THEN
    ALTER TABLE user_profiles ADD COLUMN username text;
  END IF;
END $$;

-- Generate usernames from existing emails (part before @)
UPDATE user_profiles
SET username = LOWER(SPLIT_PART(email, '@', 1))
WHERE username IS NULL;

-- Make username NOT NULL and UNIQUE
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'user_profiles_username_unique'
  ) THEN
    ALTER TABLE user_profiles ADD CONSTRAINT user_profiles_username_unique UNIQUE (username);
  END IF;
END $$;

ALTER TABLE user_profiles ALTER COLUMN username SET NOT NULL;

-- Create index on username for faster lookups
CREATE INDEX IF NOT EXISTS idx_user_profiles_username ON user_profiles(username);
