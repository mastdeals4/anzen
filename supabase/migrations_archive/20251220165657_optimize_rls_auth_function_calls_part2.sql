/*
  # Optimize RLS Policies - Auth Function Initialization (Part 2)

  Continues optimization of RLS policies for better performance at scale.

  ## Changes
  
  ### Stock Rejections
  - Optimized: Users can create stock rejections
  - Optimized: Managers can update stock rejections
  - Optimized: Users can update own pending stock rejections or managers can update
  - Optimized: Users can delete own pending stock rejections or managers can delete
  
  ### Gmail Processed Messages
  - Optimized: Users can view own processed messages
  - Optimized: Users can insert own processed messages
  - Optimized: Users can update own processed messages
  - Optimized: Users can delete own processed messages
  
  ### Credit Notes
  - Optimized: Users can delete own credit notes
  - Optimized: Users can update own credit notes
  
  ### User Profiles
  - Optimized: Users can update own profile
*/

-- Optimize stock_rejections policies
DROP POLICY IF EXISTS "Users can create stock rejections" ON stock_rejections;
CREATE POLICY "Users can create stock rejections"
  ON stock_rejections FOR INSERT
  TO authenticated
  WITH CHECK (created_by = (select auth.uid()));

DROP POLICY IF EXISTS "Managers can update stock rejections" ON stock_rejections;
CREATE POLICY "Managers can update stock rejections"
  ON stock_rejections FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = (select auth.uid())
      AND role IN ('admin', 'manager')
    )
  );

DROP POLICY IF EXISTS "Users can update own pending stock rejections or managers can u" ON stock_rejections;
CREATE POLICY "Users can update own pending stock rejections or managers can update"
  ON stock_rejections FOR UPDATE
  TO authenticated
  USING (
    (created_by = (select auth.uid()) AND status = 'pending')
    OR EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = (select auth.uid())
      AND role IN ('admin', 'manager')
    )
  );

DROP POLICY IF EXISTS "Users can delete own pending stock rejections or managers can d" ON stock_rejections;
CREATE POLICY "Users can delete own pending stock rejections or managers can delete"
  ON stock_rejections FOR DELETE
  TO authenticated
  USING (
    (created_by = (select auth.uid()) AND status = 'pending')
    OR EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = (select auth.uid())
      AND role IN ('admin', 'manager')
    )
  );

-- Optimize gmail_processed_messages policies
DROP POLICY IF EXISTS "Users can view own processed messages" ON gmail_processed_messages;
CREATE POLICY "Users can view own processed messages"
  ON gmail_processed_messages FOR SELECT
  TO authenticated
  USING (user_id = (select auth.uid()));

DROP POLICY IF EXISTS "Users can insert own processed messages" ON gmail_processed_messages;
CREATE POLICY "Users can insert own processed messages"
  ON gmail_processed_messages FOR INSERT
  TO authenticated
  WITH CHECK (user_id = (select auth.uid()));

DROP POLICY IF EXISTS "Users can update own processed messages" ON gmail_processed_messages;
CREATE POLICY "Users can update own processed messages"
  ON gmail_processed_messages FOR UPDATE
  TO authenticated
  USING (user_id = (select auth.uid()));

DROP POLICY IF EXISTS "Users can delete own processed messages" ON gmail_processed_messages;
CREATE POLICY "Users can delete own processed messages"
  ON gmail_processed_messages FOR DELETE
  TO authenticated
  USING (user_id = (select auth.uid()));

-- Optimize credit_notes policies
DROP POLICY IF EXISTS "Users can delete own credit notes" ON credit_notes;
CREATE POLICY "Users can delete own credit notes"
  ON credit_notes FOR DELETE
  TO authenticated
  USING (
    created_by = (select auth.uid())
    AND status = 'draft'
  );

DROP POLICY IF EXISTS "Users can update own credit notes" ON credit_notes;
CREATE POLICY "Users can update own credit notes"
  ON credit_notes FOR UPDATE
  TO authenticated
  USING (
    created_by = (select auth.uid())
    AND status = 'draft'
  );

-- Optimize profiles (user_profiles) policies
DROP POLICY IF EXISTS "Users can update own profile" ON user_profiles;
CREATE POLICY "Users can update own profile"
  ON user_profiles FOR UPDATE
  TO authenticated
  USING (id = (select auth.uid()));
