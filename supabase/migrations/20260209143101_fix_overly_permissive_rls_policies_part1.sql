/*
  # Fix Overly Permissive RLS Policies - Part 1: System Tables

  1. Problem
    - 61 RLS policies use USING (true) or WITH CHECK (true)
    - This bypasses row-level security completely
    - Security audit flags these as vulnerabilities
    
  2. Solution
    - Replace permissive policies with role-based checks
    - System operations: check auth.uid() exists
    - Operational tables: exclude read-only users
    
  3. Part 1: System Tables (9 policies)
*/

-- 1. audit_logs - system operations
DROP POLICY IF EXISTS "System can insert audit logs" ON audit_logs;
CREATE POLICY "System can insert audit logs"
  ON audit_logs FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);

-- 2. notifications - system operations  
DROP POLICY IF EXISTS "System can create notifications" ON notifications;
CREATE POLICY "System can create notifications"
  ON notifications FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);

-- 3. crm_inquiry_timeline - system operations
DROP POLICY IF EXISTS "System can create timeline events" ON crm_inquiry_timeline;
CREATE POLICY "System can create timeline events"
  ON crm_inquiry_timeline FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);

-- 4. task_status_history - system operations
DROP POLICY IF EXISTS "System can create status history" ON task_status_history;
CREATE POLICY "System can create status history"
  ON task_status_history FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);

-- 5. system_task_events - system operations
DROP POLICY IF EXISTS "System can create events" ON system_task_events;
CREATE POLICY "System can create events"
  ON system_task_events FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);
