-- Migration: Add 'enquiry_request' to tasks reference_type check constraint
-- Canonical relationship: tasks.reference_type = 'enquiry_request' AND tasks.reference_id = enquiry_requests.id

ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_reference_type_check;

ALTER TABLE public.tasks ADD CONSTRAINT tasks_reference_type_check CHECK (
  reference_type IS NULL OR reference_type IN (
    'sales_order',
    'delivery_challan',
    'import_requirement',
    'purchase_order',
    'product',
    'customer',
    'supplier',
    'batch',
    'other',
    'enquiry_request'
  )
);

-- Ensure index exists for performant lookup of tasks by enquiry_request reference
CREATE INDEX IF NOT EXISTS idx_tasks_enquiry_request_ref 
  ON public.tasks(reference_id) 
  WHERE reference_type = 'enquiry_request';

-- Fix legacy trigger error where create_task_status_history attempted to reference non-existent NEW.updated_by
CREATE OR REPLACE FUNCTION public.create_task_status_history()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF (TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status) THEN
    INSERT INTO task_status_history (
      task_id,
      old_status,
      new_status,
      changed_by,
      notes
    ) VALUES (
      NEW.id,
      OLD.status,
      NEW.status,
      COALESCE(auth.uid(), NEW.completed_by, NEW.created_by),
      'Status changed from ' || OLD.status || ' to ' || NEW.status
    );
  END IF;
  RETURN NEW;
END;
$$;
