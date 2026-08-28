/*
  # Optimize RLS Policies - Part 3 (Tasks and Task-related Tables) - Fixed

  1. Performance Improvements
    - Wrap auth.uid() calls with SELECT to cache the value
    - Prevents re-evaluation for each row
    
  2. Tables Optimized
    - tasks
    - task_comments
    - task_assignments
    - task_status_history
*/

-- Tasks
DROP POLICY IF EXISTS "Admins can view all tasks" ON tasks;
DROP POLICY IF EXISTS "Users can view assigned tasks" ON tasks;
DROP POLICY IF EXISTS "Users can create tasks" ON tasks;
DROP POLICY IF EXISTS "Task creators and assignees can update" ON tasks;
DROP POLICY IF EXISTS "Admins and creators can delete tasks" ON tasks;

CREATE POLICY "Admins can view all tasks"
  ON tasks FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = (SELECT auth.uid()) AND role = 'admin'
    )
  );

CREATE POLICY "Users can view assigned tasks"
  ON tasks FOR SELECT TO authenticated
  USING (
    (SELECT auth.uid()) = ANY(assigned_users) OR 
    created_by = (SELECT auth.uid())
  );

CREATE POLICY "Users can create tasks"
  ON tasks FOR INSERT TO authenticated
  WITH CHECK (created_by = (SELECT auth.uid()));

CREATE POLICY "Task creators and assignees can update"
  ON tasks FOR UPDATE TO authenticated
  USING (
    created_by = (SELECT auth.uid()) OR 
    (SELECT auth.uid()) = ANY(assigned_users) OR
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = (SELECT auth.uid()) AND role = 'admin'
    )
  );

CREATE POLICY "Admins and creators can delete tasks"
  ON tasks FOR DELETE TO authenticated
  USING (
    created_by = (SELECT auth.uid()) OR
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = (SELECT auth.uid()) AND role = 'admin'
    )
  );

-- Task Comments
DROP POLICY IF EXISTS "Users can view comments on accessible tasks" ON task_comments;
DROP POLICY IF EXISTS "Users can add comments to accessible tasks" ON task_comments;
DROP POLICY IF EXISTS "Users can update own comments" ON task_comments;
DROP POLICY IF EXISTS "Users can delete own comments" ON task_comments;

CREATE POLICY "Users can view comments on accessible tasks"
  ON task_comments FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM tasks
      WHERE tasks.id = task_comments.task_id
      AND (
        tasks.created_by = (SELECT auth.uid()) OR
        (SELECT auth.uid()) = ANY(tasks.assigned_users) OR
        EXISTS (
          SELECT 1 FROM user_profiles
          WHERE id = (SELECT auth.uid()) AND role = 'admin'
        )
      )
    )
  );

CREATE POLICY "Users can add comments to accessible tasks"
  ON task_comments FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid()) AND
    EXISTS (
      SELECT 1 FROM tasks
      WHERE tasks.id = task_comments.task_id
      AND (
        tasks.created_by = (SELECT auth.uid()) OR
        (SELECT auth.uid()) = ANY(tasks.assigned_users) OR
        EXISTS (
          SELECT 1 FROM user_profiles
          WHERE id = (SELECT auth.uid()) AND role = 'admin'
        )
      )
    )
  );

CREATE POLICY "Users can update own comments"
  ON task_comments FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY "Users can delete own comments"
  ON task_comments FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- Task Assignments
DROP POLICY IF EXISTS "Users can view assignments for accessible tasks" ON task_assignments;
DROP POLICY IF EXISTS "Admins and task creators can create assignments" ON task_assignments;
DROP POLICY IF EXISTS "Assigned users can update their assignments" ON task_assignments;

CREATE POLICY "Users can view assignments for accessible tasks"
  ON task_assignments FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM tasks
      WHERE tasks.id = task_assignments.task_id
      AND (
        tasks.created_by = (SELECT auth.uid()) OR
        (SELECT auth.uid()) = ANY(tasks.assigned_users) OR
        EXISTS (
          SELECT 1 FROM user_profiles
          WHERE id = (SELECT auth.uid()) AND role = 'admin'
        )
      )
    )
  );

CREATE POLICY "Admins and task creators can create assignments"
  ON task_assignments FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM tasks
      WHERE tasks.id = task_assignments.task_id
      AND (
        tasks.created_by = (SELECT auth.uid()) OR
        EXISTS (
          SELECT 1 FROM user_profiles
          WHERE id = (SELECT auth.uid()) AND role = 'admin'
        )
      )
    )
  );

CREATE POLICY "Assigned users can update their assignments"
  ON task_assignments FOR UPDATE TO authenticated
  USING (assigned_user_id = (SELECT auth.uid()));

-- Task Status History
DROP POLICY IF EXISTS "Users can view status history for accessible tasks" ON task_status_history;

CREATE POLICY "Users can view status history for accessible tasks"
  ON task_status_history FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM tasks
      WHERE tasks.id = task_status_history.task_id
      AND (
        tasks.created_by = (SELECT auth.uid()) OR
        (SELECT auth.uid()) = ANY(tasks.assigned_users) OR
        EXISTS (
          SELECT 1 FROM user_profiles
          WHERE id = (SELECT auth.uid()) AND role = 'admin'
        )
      )
    )
  );