/*
  # Add notifications_read_at to user_profiles

  Stores the timestamp when the user last clicked "Mark all read" in the
  notification dropdown. On login, only notifications created AFTER this
  timestamp will trigger toast popups, preventing already-read alerts from
  reappearing on every login.

  Changes:
  - `user_profiles.notifications_read_at` (timestamptz, nullable) — set when
    user clicks "Mark all read"; NULL means they have never done so.
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'user_profiles' AND column_name = 'notifications_read_at'
  ) THEN
    ALTER TABLE user_profiles ADD COLUMN notifications_read_at timestamptz;
  END IF;
END $$;
