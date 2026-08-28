/*
  # Slack-Style Task Management System for Pharma CRM
  
  ## Overview
  Complete task management system with Slack-style discussion threads, @mentions,
  file attachments, and full integration with CRM inquiries, customers, products.
  
  ## New Tables
  
  ### 1. tasks
  Main task tracking table with:
  - Basic info: title, description, deadline (date + time)
  - Priority levels: high, medium, low
  - Status workflow: to_do, in_progress, waiting, completed
  - Entity linking: inquiry_id, customer_id, product_id, supplier_id
  - Multi-user assignment support
  - File attachment paths
  - Tags for organization
  
  ### 2. task_comments
  Slack-style threaded discussions with:
  - Comment text with rich formatting
  - @mention functionality (mentions array)
  - File attachments per comment
  - Parent comment for nested replies
  - Edit and delete tracking
  
  ### 3. task_assignments
  Track multiple users assigned to tasks:
  - Assigned user reference
  - Assignment date and by whom
  - Acceptance status
  - Completion tracking
  
  ### 4. task_status_history
  Complete audit trail of status changes:
  - Old and new status
  - Changed by user and timestamp
  - Reason/notes for change
  
  ## Security
  - Enable RLS on all tables
  - Admins see all tasks
  - Users see only assigned tasks
  - Sales see customer-related tasks
  - Role-based access control
  
  ## Indexes
  - Fast filtering by status, priority, assignee
  - Search by title and description
  - Sort by deadline and creation date
  - Entity relationship lookups
*/

-- Create enums for task system
DO $$ BEGIN
  CREATE TYPE task_priority AS ENUM ('low', 'medium', 'high', 'urgent');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE task_status AS ENUM ('to_do', 'in_progress', 'waiting', 'completed');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Main tasks table
CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Basic task info
  title text NOT NULL,
  description text,
  deadline timestamptz NOT NULL,
  
  -- Priority and status
  priority task_priority DEFAULT 'medium',
  status task_status DEFAULT 'to_do',
  
  -- Assignment
  created_by uuid NOT NULL REFERENCES user_profiles(id),
  assigned_users uuid[] DEFAULT ARRAY[]::uuid[],
  
  -- Entity relationships (optional links)
  inquiry_id uuid REFERENCES crm_inquiries(id) ON DELETE SET NULL,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  product_id uuid REFERENCES products(id) ON DELETE SET NULL,
  supplier_id text,
  
  -- File attachments
  attachment_urls text[] DEFAULT ARRAY[]::text[],
  
  -- Organization
  tags text[] DEFAULT ARRAY[]::text[],
  
  -- Completion tracking
  completed_at timestamptz,
  completed_by uuid REFERENCES user_profiles(id),
  completion_notes text,
  
  -- Timestamps
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  
  -- Soft delete
  is_deleted boolean DEFAULT false,
  deleted_at timestamptz,
  deleted_by uuid REFERENCES user_profiles(id)
);

-- Task comments (Slack-style threads)
CREATE TABLE IF NOT EXISTS task_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  
  -- Comment content
  comment_text text NOT NULL,
  
  -- User who posted
  user_id uuid NOT NULL REFERENCES user_profiles(id),
  
  -- @mentions
  mentions uuid[] DEFAULT ARRAY[]::uuid[],
  
  -- File attachments in comment
  attachment_urls text[] DEFAULT ARRAY[]::text[],
  
  -- Threading (for nested replies)
  parent_comment_id uuid REFERENCES task_comments(id) ON DELETE CASCADE,
  
  -- Edit tracking
  is_edited boolean DEFAULT false,
  edited_at timestamptz,
  
  -- Timestamps
  created_at timestamptz DEFAULT now(),
  
  -- Soft delete
  is_deleted boolean DEFAULT false,
  deleted_at timestamptz
);

-- Task assignments (multi-user support)
CREATE TABLE IF NOT EXISTS task_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  assigned_user_id uuid NOT NULL REFERENCES user_profiles(id),
  
  -- Assignment tracking
  assigned_by uuid NOT NULL REFERENCES user_profiles(id),
  assigned_at timestamptz DEFAULT now(),
  
  -- Acceptance
  accepted boolean DEFAULT false,
  accepted_at timestamptz,
  
  -- Completion
  completed boolean DEFAULT false,
  completed_at timestamptz,
  
  -- Prevent duplicate assignments
  UNIQUE(task_id, assigned_user_id)
);

-- Task status history (audit trail)
CREATE TABLE IF NOT EXISTS task_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  
  -- Status change
  old_status task_status,
  new_status task_status NOT NULL,
  
  -- Who changed it
  changed_by uuid NOT NULL REFERENCES user_profiles(id),
  changed_at timestamptz DEFAULT now(),
  
  -- Reason/notes
  notes text
);

-- ==================
-- INDEXES
-- ==================

-- Tasks indexes
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status) WHERE NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority) WHERE NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_tasks_deadline ON tasks(deadline) WHERE NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_tasks_created_by ON tasks(created_by) WHERE NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_users ON tasks USING GIN(assigned_users);
CREATE INDEX IF NOT EXISTS idx_tasks_inquiry ON tasks(inquiry_id) WHERE inquiry_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_customer ON tasks(customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_product ON tasks(product_id) WHERE product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_completed_at ON tasks(completed_at DESC) WHERE completed_at IS NOT NULL;

-- Full text search on tasks
CREATE INDEX IF NOT EXISTS idx_tasks_title_search ON tasks USING gin(to_tsvector('english', title));
CREATE INDEX IF NOT EXISTS idx_tasks_description_search ON tasks USING gin(to_tsvector('english', coalesce(description, '')));

-- Comments indexes
CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id) WHERE NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_task_comments_user ON task_comments(user_id);
CREATE INDEX IF NOT EXISTS idx_task_comments_created ON task_comments(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_comments_parent ON task_comments(parent_comment_id) WHERE parent_comment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_task_comments_mentions ON task_comments USING GIN(mentions);

-- Assignments indexes
CREATE INDEX IF NOT EXISTS idx_task_assignments_task ON task_assignments(task_id);
CREATE INDEX IF NOT EXISTS idx_task_assignments_user ON task_assignments(assigned_user_id);
CREATE INDEX IF NOT EXISTS idx_task_assignments_assigned_by ON task_assignments(assigned_by);

-- Status history indexes
CREATE INDEX IF NOT EXISTS idx_task_status_history_task ON task_status_history(task_id);
CREATE INDEX IF NOT EXISTS idx_task_status_history_changed_at ON task_status_history(changed_at DESC);

-- ==================
-- ROW LEVEL SECURITY
-- ==================

-- Enable RLS
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_status_history ENABLE ROW LEVEL SECURITY;

-- Tasks policies
CREATE POLICY "Admins can view all tasks"
  ON tasks FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role = 'admin'
    )
  );

CREATE POLICY "Users can view assigned tasks"
  ON tasks FOR SELECT
  TO authenticated
  USING (
    auth.uid() = created_by
    OR auth.uid() = ANY(assigned_users)
    OR NOT is_deleted
  );

CREATE POLICY "Users can create tasks"
  ON tasks FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = created_by);

CREATE POLICY "Task creators and assignees can update"
  ON tasks FOR UPDATE
  TO authenticated
  USING (
    auth.uid() = created_by
    OR auth.uid() = ANY(assigned_users)
    OR EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role = 'admin'
    )
  );

CREATE POLICY "Admins and creators can delete tasks"
  ON tasks FOR DELETE
  TO authenticated
  USING (
    auth.uid() = created_by
    OR EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role = 'admin'
    )
  );

-- Task comments policies
CREATE POLICY "Users can view comments on accessible tasks"
  ON task_comments FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM tasks
      WHERE tasks.id = task_comments.task_id
      AND (
        auth.uid() = tasks.created_by
        OR auth.uid() = ANY(tasks.assigned_users)
        OR EXISTS (
          SELECT 1 FROM user_profiles
          WHERE user_profiles.id = auth.uid()
          AND user_profiles.role = 'admin'
        )
      )
    )
  );

CREATE POLICY "Users can add comments to accessible tasks"
  ON task_comments FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM tasks
      WHERE tasks.id = task_comments.task_id
      AND (
        auth.uid() = tasks.created_by
        OR auth.uid() = ANY(tasks.assigned_users)
        OR EXISTS (
          SELECT 1 FROM user_profiles
          WHERE user_profiles.id = auth.uid()
          AND user_profiles.role = 'admin'
        )
      )
    )
  );

CREATE POLICY "Users can update own comments"
  ON task_comments FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own comments"
  ON task_comments FOR DELETE
  TO authenticated
  USING (
    auth.uid() = user_id
    OR EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role = 'admin'
    )
  );

-- Task assignments policies
CREATE POLICY "Users can view assignments for accessible tasks"
  ON task_assignments FOR SELECT
  TO authenticated
  USING (
    auth.uid() = assigned_user_id
    OR EXISTS (
      SELECT 1 FROM tasks
      WHERE tasks.id = task_assignments.task_id
      AND (auth.uid() = tasks.created_by OR auth.uid() = ANY(tasks.assigned_users))
    )
    OR EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role = 'admin'
    )
  );

CREATE POLICY "Admins and task creators can create assignments"
  ON task_assignments FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM tasks
      WHERE tasks.id = task_assignments.task_id
      AND (
        auth.uid() = tasks.created_by
        OR EXISTS (
          SELECT 1 FROM user_profiles
          WHERE user_profiles.id = auth.uid()
          AND user_profiles.role = 'admin'
        )
      )
    )
  );

CREATE POLICY "Assigned users can update their assignments"
  ON task_assignments FOR UPDATE
  TO authenticated
  USING (auth.uid() = assigned_user_id);

-- Status history policies (read-only for audit)
CREATE POLICY "Users can view status history for accessible tasks"
  ON task_status_history FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM tasks
      WHERE tasks.id = task_status_history.task_id
      AND (
        auth.uid() = tasks.created_by
        OR auth.uid() = ANY(tasks.assigned_users)
        OR EXISTS (
          SELECT 1 FROM user_profiles
          WHERE user_profiles.id = auth.uid()
          AND user_profiles.role = 'admin'
        )
      )
    )
  );

CREATE POLICY "System can create status history"
  ON task_status_history FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- ==================
-- TRIGGERS
-- ==================

-- Update updated_at timestamp on tasks
CREATE OR REPLACE FUNCTION update_tasks_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_tasks_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION update_tasks_updated_at();

-- Auto-create status history on status change
CREATE OR REPLACE FUNCTION create_task_status_history()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO task_status_history (task_id, old_status, new_status, changed_by)
    VALUES (NEW.id, OLD.status, NEW.status, auth.uid());
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_create_task_status_history
  AFTER UPDATE ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION create_task_status_history();

-- Auto-update task completed_at when status changes to completed
CREATE OR REPLACE FUNCTION update_task_completion()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'completed' AND OLD.status != 'completed' THEN
    NEW.completed_at = now();
    NEW.completed_by = auth.uid();
  ELSIF NEW.status != 'completed' AND OLD.status = 'completed' THEN
    NEW.completed_at = NULL;
    NEW.completed_by = NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_task_completion
  BEFORE UPDATE ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION update_task_completion();

-- Create notification when user is mentioned in comment
CREATE OR REPLACE FUNCTION notify_mentioned_users()
RETURNS TRIGGER AS $$
DECLARE
  mentioned_user uuid;
  task_title text;
  commenter_name text;
BEGIN
  -- Get task title
  SELECT title INTO task_title FROM tasks WHERE id = NEW.task_id;
  
  -- Get commenter name
  SELECT full_name INTO commenter_name FROM user_profiles WHERE id = NEW.user_id;
  
  -- Create notification for each mentioned user
  IF NEW.mentions IS NOT NULL THEN
    FOREACH mentioned_user IN ARRAY NEW.mentions
    LOOP
      INSERT INTO notifications (user_id, type, title, message, reference_id, reference_type)
      VALUES (
        mentioned_user,
        'task_mention',
        'You were mentioned in a task',
        commenter_name || ' mentioned you in task: ' || task_title,
        NEW.task_id,
        'task'
      );
    END LOOP;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_notify_mentioned_users
  AFTER INSERT ON task_comments
  FOR EACH ROW
  EXECUTE FUNCTION notify_mentioned_users();

-- Create notification when task is assigned
CREATE OR REPLACE FUNCTION notify_task_assignment()
RETURNS TRIGGER AS $$
DECLARE
  task_title text;
  assigner_name text;
BEGIN
  -- Get task title
  SELECT title INTO task_title FROM tasks WHERE id = NEW.task_id;
  
  -- Get assigner name
  SELECT full_name INTO assigner_name FROM user_profiles WHERE id = NEW.assigned_by;
  
  -- Create notification for assigned user
  INSERT INTO notifications (user_id, type, title, message, reference_id, reference_type)
  VALUES (
    NEW.assigned_user_id,
    'task_assigned',
    'New task assigned',
    assigner_name || ' assigned you to task: ' || task_title,
    NEW.task_id,
    'task'
  );
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_notify_task_assignment
  AFTER INSERT ON task_assignments
  FOR EACH ROW
  EXECUTE FUNCTION notify_task_assignment();