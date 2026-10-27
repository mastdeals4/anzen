-- ============================================================================
-- Migration: 20260914200000_implement_task_notifications_and_reminders.sql
-- Description: Phase 7.5 - Operational Notifications, Mentions, and Reminders
-- 
-- Implements genuine notification triggers:
--   1. notify_task_assignment() on task_assignments (replaces baseline placeholder)
--   2. notify_mentioned_users() on task_comments (replaces baseline placeholder)
--   3. evaluate_enquiry_task_reminders() idempotent escalation evaluator
--
-- Reuses existing public.notifications, public.tasks, and public.enquiry_requests.
-- Zero new task or reminder tables.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. Real Implementation of notify_task_assignment()
-- ============================================================================
CREATE OR REPLACE FUNCTION public.notify_task_assignment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_task RECORD;
  v_assigner_name TEXT;
  v_inquiry_number TEXT;
  v_request_code TEXT;
  v_title TEXT;
  v_message TEXT;
BEGIN
  -- 1. Fetch task details
  SELECT 
    t.title,
    t.priority,
    t.deadline,
    t.reference_type,
    t.reference_id,
    t.inquiry_id
  INTO v_task
  FROM public.tasks t
  WHERE t.id = NEW.task_id;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- 2. Fetch assigner name (if available)
  IF NEW.assigned_by IS NOT NULL THEN
    SELECT COALESCE(full_name, email)
    INTO v_assigner_name
    FROM public.user_profiles
    WHERE id = NEW.assigned_by;
  END IF;
  v_assigner_name := COALESCE(v_assigner_name, 'System / Manager');

  -- 3. If task is linked to enquiry or enquiry_request, fetch contextual codes
  IF v_task.inquiry_id IS NOT NULL THEN
    SELECT inquiry_number INTO v_inquiry_number
    FROM public.crm_inquiries
    WHERE id = v_task.inquiry_id;
  END IF;

  IF v_task.reference_type = 'enquiry_request' AND v_task.reference_id IS NOT NULL THEN
    SELECT request_code INTO v_request_code
    FROM public.enquiry_requests
    WHERE id = v_task.reference_id;
  END IF;

  -- 4. Construct message
  v_title := 'New task assigned: ' || v_task.title;
  
  v_message := v_assigner_name || ' assigned you to task: ' || v_task.title;
  IF v_inquiry_number IS NOT NULL THEN
    v_message := v_message || ' [' || v_inquiry_number;
    IF v_request_code IS NOT NULL THEN
      v_message := v_message || ' - ' || v_request_code;
    END IF;
    v_message := v_message || ']';
  END IF;

  IF v_task.priority IS NOT NULL THEN
    v_message := v_message || ' | Priority: ' || UPPER(v_task.priority::text);
  END IF;

  IF v_task.deadline IS NOT NULL THEN
    v_message := v_message || ' | Due: ' || to_char(v_task.deadline AT TIME ZONE 'UTC', 'YYYY-MM-DD');
  END IF;

  -- 5. Insert notification for assigned user (idempotent, avoid duplicate unread)
  INSERT INTO public.notifications (
    user_id,
    type,
    title,
    message,
    reference_id,
    reference_type,
    is_read,
    created_at
  )
  VALUES (
    NEW.assigned_user_id,
    'task_assigned',
    v_title,
    v_message,
    NEW.task_id,
    'task',
    false,
    now()
  )
  ON CONFLICT (user_id, type, message) WHERE (is_read = false)
  DO NOTHING;

  RETURN NEW;
END;
$$;

-- Ensure trigger exists on task_assignments
DROP TRIGGER IF EXISTS trigger_notify_task_assignment ON public.task_assignments;
CREATE TRIGGER trigger_notify_task_assignment
  AFTER INSERT ON public.task_assignments
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_task_assignment();

-- ============================================================================
-- 2. Real Implementation of notify_mentioned_users()
-- ============================================================================
CREATE OR REPLACE FUNCTION public.notify_mentioned_users()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_task_title TEXT;
  v_commenter_name TEXT;
  v_mentioned_id UUID;
  v_title TEXT;
  v_message TEXT;
BEGIN
  -- If no mentions, nothing to do
  IF NEW.mentions IS NULL OR array_length(NEW.mentions, 1) IS NULL THEN
    RETURN NEW;
  END IF;

  -- 1. Fetch task title
  SELECT title INTO v_task_title
  FROM public.tasks
  WHERE id = NEW.task_id;
  v_task_title := COALESCE(v_task_title, 'Task');

  -- 2. Fetch commenter name
  SELECT COALESCE(full_name, email) INTO v_commenter_name
  FROM public.user_profiles
  WHERE id = NEW.user_id;
  v_commenter_name := COALESCE(v_commenter_name, 'A team member');

  v_title := 'You were mentioned in a task';
  v_message := v_commenter_name || ' mentioned you in task: ' || v_task_title;

  -- 3. Loop over mentioned users (excluding commenter themself)
  FOREACH v_mentioned_id IN ARRAY NEW.mentions
  LOOP
    IF v_mentioned_id IS NOT NULL AND v_mentioned_id <> NEW.user_id THEN
      INSERT INTO public.notifications (
        user_id,
        type,
        title,
        message,
        reference_id,
        reference_type,
        is_read,
        created_at
      )
      VALUES (
        v_mentioned_id,
        'task_mention',
        v_title,
        v_message,
        NEW.task_id,
        'task',
        false,
        now()
      )
      ON CONFLICT (user_id, type, message) WHERE (is_read = false)
      DO NOTHING;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

-- Ensure trigger exists on task_comments
DROP TRIGGER IF EXISTS trigger_notify_mentioned_users ON public.task_comments;
CREATE TRIGGER trigger_notify_mentioned_users
  AFTER INSERT ON public.task_comments
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_mentioned_users();

-- ============================================================================
-- 3. Idempotent Reminder & Escalation Evaluator
-- ============================================================================
CREATE OR REPLACE FUNCTION public.evaluate_enquiry_task_reminders()
RETURNS TABLE (
  evaluated_requests INT,
  evaluated_tasks INT,
  reminders_advanced INT,
  escalations_triggered INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  r RECORD;
  t RECORD;
  v_req_count INT := 0;
  v_task_count INT := 0;
  v_adv_count INT := 0;
  v_esc_count INT := 0;
  v_target_level INT;
  v_now TIMESTAMPTZ := now();
  v_hours_overdue NUMERIC;
BEGIN
  -- Iterate through all active requests that have a due_at set
  FOR r IN
    SELECT 
      req.id,
      req.inquiry_id,
      req.request_code,
      req.title,
      req.status,
      req.due_at,
      req.reminder_level,
      req.last_reminded_at,
      req.escalated_at,
      req.assigned_to,
      inq.inquiry_number
    FROM public.enquiry_requests req
    JOIN public.crm_inquiries inq ON inq.id = req.inquiry_id
    WHERE req.status IN ('OPEN', 'IN_PROGRESS', 'BLOCKED')
      AND req.due_at IS NOT NULL
  LOOP
    v_req_count := v_req_count + 1;
    
    -- Calculate overdue hours
    IF r.due_at < v_now THEN
      v_hours_overdue := EXTRACT(EPOCH FROM (v_now - r.due_at)) / 3600.0;
      
      -- Determine reminder level:
      -- Level 1: Due / Overdue 0 - 24 hours
      -- Level 2: Overdue 24 - 48 hours
      -- Level 3: Overdue 48 - 72 hours
      -- Level 4: Escalation (Overdue > 72 hours)
      IF v_hours_overdue >= 72 THEN
        v_target_level := 4;
      ELSIF v_hours_overdue >= 48 THEN
        v_target_level := 3;
      ELSIF v_hours_overdue >= 24 THEN
        v_target_level := 2;
      ELSE
        v_target_level := 1;
      END IF;

      -- If target level exceeds current reminder_level, advance
      IF v_target_level > r.reminder_level THEN
        UPDATE public.enquiry_requests
        SET 
          reminder_level = v_target_level,
          last_reminded_at = v_now,
          escalated_at = CASE WHEN v_target_level = 4 AND escalated_at IS NULL THEN v_now ELSE escalated_at END,
          updated_at = v_now
        WHERE id = r.id;

        v_adv_count := v_adv_count + 1;
        IF v_target_level = 4 AND r.escalated_at IS NULL THEN
          v_esc_count := v_esc_count + 1;
        END IF;

        -- Create notification for request owner if assigned
        IF r.assigned_to IS NOT NULL THEN
          INSERT INTO public.notifications (
            user_id,
            type,
            title,
            message,
            reference_id,
            reference_type,
            is_read,
            created_at
          )
          VALUES (
            r.assigned_to,
            CASE WHEN v_target_level = 4 THEN 'task_deadline' ELSE 'task_deadline' END,
            CASE WHEN v_target_level = 4 THEN 'ESCALATION: Requirement overdue >72h' ELSE 'Reminder: Requirement overdue' END,
            'Requirement ' || r.request_code || ' (' || r.inquiry_number || ' - ' || r.title || ') is ' || 
            ROUND(v_hours_overdue / 24.0, 1)::text || ' days overdue. Level ' || v_target_level::text,
            r.id,
            'enquiry_request',
            false,
            v_now
          )
          ON CONFLICT (user_id, type, message) WHERE (is_read = false)
          DO NOTHING;
        END IF;
      END IF;
    END IF;
  END LOOP;

  -- 2. Evaluate active incomplete tasks past deadline
  FOR t IN
    SELECT 
      tsk.id,
      tsk.title,
      tsk.deadline,
      tsk.priority,
      tsk.reference_type,
      tsk.reference_id,
      tsk.inquiry_id,
      inq.inquiry_number,
      ta.assigned_user_id
    FROM public.tasks tsk
    LEFT JOIN public.crm_inquiries inq ON inq.id = tsk.inquiry_id
    JOIN public.task_assignments ta ON ta.task_id = tsk.id
    WHERE tsk.is_deleted = false
      AND tsk.status IN ('to_do', 'in_progress', 'waiting')
      AND tsk.deadline IS NOT NULL
      AND tsk.deadline < v_now
  LOOP
    v_task_count := v_task_count + 1;
    v_hours_overdue := EXTRACT(EPOCH FROM (v_now - t.deadline)) / 3600.0;

    INSERT INTO public.notifications (
      user_id,
      type,
      title,
      message,
      reference_id,
      reference_type,
      is_read,
      created_at
    )
    VALUES (
      t.assigned_user_id,
      'task_deadline',
      CASE WHEN v_hours_overdue >= 72 THEN 'ESCALATION: Task overdue >72h' ELSE 'Task Overdue Alert' END,
      'Task "' || t.title || '"' || 
      CASE WHEN t.inquiry_number IS NOT NULL THEN ' (' || t.inquiry_number || ')' ELSE '' END || 
      ' is ' || ROUND(v_hours_overdue / 24.0, 1)::text || ' days overdue.',
      t.id,
      'task',
      false,
      v_now
    )
    ON CONFLICT (user_id, type, message) WHERE (is_read = false)
    DO NOTHING;
  END LOOP;

  RETURN QUERY SELECT v_req_count, v_task_count, v_adv_count, v_esc_count;
END;
$$;

COMMIT;
