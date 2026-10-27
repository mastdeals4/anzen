/*
  # System Task Engine - Advisory Mode Implementation

  ## Overview
  This migration creates a plug-in layer system that generates advisory tasks
  from business events WITHOUT modifying existing ERP logic. Tasks run in pure
  advisory mode - no enforcement, no blocking, no workflow interruption.

  ## What This Adds

  1. **System Task Fields** - Extends tasks table with system task tracking
  2. **Event Tracking Table** - Logs all business events
  3. **Helper Functions** - Auto-generate advisory tasks
  4. **Event Triggers** - Generate tasks on business events (advisory only)

  ## Safety Guarantees
  - All system tasks marked as 'advisory' mode
  - Never blocks any existing workflows
  - Never throws errors if ignored
  - Can be dismissed without consequence
  - Backward compatible with existing tasks
  - Proof system scaffolded but DISABLED
*/

-- ============================================
-- STEP 1: Extend Tasks Table (Non-Breaking)
-- ============================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks' AND column_name = 'task_type'
  ) THEN
    ALTER TABLE tasks ADD COLUMN task_type text DEFAULT 'manual' CHECK (task_type IN ('manual', 'system'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks' AND column_name = 'task_mode'
  ) THEN
    ALTER TABLE tasks ADD COLUMN task_mode text DEFAULT 'advisory' CHECK (task_mode IN ('advisory', 'enforced'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks' AND column_name = 'task_origin'
  ) THEN
    ALTER TABLE tasks ADD COLUMN task_origin text CHECK (
      task_origin IN (
        'sales_order_approved',
        'sales_order_shortage',
        'delivery_challan_created',
        'stock_low_alert',
        'import_requirement_created',
        'purchase_order_created',
        'manual'
      )
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks' AND column_name = 'reference_type'
  ) THEN
    ALTER TABLE tasks ADD COLUMN reference_type text CHECK (
      reference_type IN (
        'sales_order',
        'delivery_challan',
        'import_requirement',
        'purchase_order',
        'product',
        'customer',
        'supplier',
        'batch',
        'other'
      )
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks' AND column_name = 'reference_id'
  ) THEN
    ALTER TABLE tasks ADD COLUMN reference_id uuid;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks' AND column_name = 'auto_assigned_role'
  ) THEN
    ALTER TABLE tasks ADD COLUMN auto_assigned_role text CHECK (
      auto_assigned_role IN ('admin', 'sales', 'warehouse', 'accounts')
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks' AND column_name = 'proof_required'
  ) THEN
    ALTER TABLE tasks ADD COLUMN proof_required boolean DEFAULT false;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks' AND column_name = 'proof_type'
  ) THEN
    ALTER TABLE tasks ADD COLUMN proof_type text CHECK (
      proof_type IN ('photo', 'document', 'signature', 'none')
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks' AND column_name = 'proof_url'
  ) THEN
    ALTER TABLE tasks ADD COLUMN proof_url text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks' AND column_name = 'auto_priority'
  ) THEN
    ALTER TABLE tasks ADD COLUMN auto_priority text CHECK (
      auto_priority IN ('urgent', 'high', 'medium', 'low')
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks' AND column_name = 'dismissed_at'
  ) THEN
    ALTER TABLE tasks ADD COLUMN dismissed_at timestamptz;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks' AND column_name = 'dismissed_by'
  ) THEN
    ALTER TABLE tasks ADD COLUMN dismissed_by uuid REFERENCES user_profiles(id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks' AND column_name = 'dismissal_reason'
  ) THEN
    ALTER TABLE tasks ADD COLUMN dismissal_reason text;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_tasks_task_type ON tasks(task_type) WHERE NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_tasks_task_mode ON tasks(task_mode) WHERE NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_tasks_task_origin ON tasks(task_origin) WHERE task_origin IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_reference ON tasks(reference_type, reference_id) WHERE reference_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_auto_assigned_role ON tasks(auto_assigned_role) WHERE auto_assigned_role IS NOT NULL;

-- ============================================
-- STEP 2: Event Tracking Table
-- ============================================

CREATE TABLE IF NOT EXISTS system_task_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  event_source text NOT NULL,
  event_data jsonb,
  entity_type text,
  entity_id uuid,
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  task_created boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  processed_at timestamptz,
  error_message text
);

CREATE INDEX IF NOT EXISTS idx_system_task_events_type ON system_task_events(event_type);
CREATE INDEX IF NOT EXISTS idx_system_task_events_source ON system_task_events(event_source);
CREATE INDEX IF NOT EXISTS idx_system_task_events_entity ON system_task_events(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_system_task_events_task ON system_task_events(task_id);
CREATE INDEX IF NOT EXISTS idx_system_task_events_created_at ON system_task_events(created_at DESC);

ALTER TABLE system_task_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view system task events"
  ON system_task_events FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role = 'admin'
    )
  );

CREATE POLICY "System can create events"
  ON system_task_events FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- ============================================
-- STEP 3: Helper Functions
-- ============================================

DROP FUNCTION IF EXISTS get_users_by_role(text);
CREATE OR REPLACE FUNCTION get_users_by_role(role_name text)
RETURNS uuid[] AS $$
DECLARE
  user_ids uuid[];
BEGIN
  SELECT ARRAY_AGG(id) INTO user_ids
  FROM user_profiles
  WHERE role = role_name
    AND is_active = true;
  RETURN COALESCE(user_ids, ARRAY[]::uuid[]);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION calculate_task_priority(task_deadline timestamptz)
RETURNS text AS $$
DECLARE
  hours_until_deadline numeric;
BEGIN
  hours_until_deadline := EXTRACT(EPOCH FROM (task_deadline - now())) / 3600;
  IF hours_until_deadline < 0 THEN
    RETURN 'urgent';
  ELSIF hours_until_deadline < 24 THEN
    RETURN 'urgent';
  ELSIF hours_until_deadline < 48 THEN
    RETURN 'high';
  ELSIF hours_until_deadline < 168 THEN
    RETURN 'medium';
  ELSE
    RETURN 'low';
  END IF;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION create_system_task(
  p_title text,
  p_description text,
  p_deadline timestamptz,
  p_origin text,
  p_reference_type text,
  p_reference_id uuid,
  p_assigned_role text,
  p_priority text DEFAULT NULL,
  p_customer_id uuid DEFAULT NULL,
  p_product_id uuid DEFAULT NULL
)
RETURNS uuid AS $$
DECLARE
  v_task_id uuid;
  v_assigned_users uuid[];
  v_auto_priority text;
  v_creator_id uuid;
BEGIN
  v_assigned_users := get_users_by_role(p_assigned_role);
  v_auto_priority := COALESCE(p_priority, calculate_task_priority(p_deadline));

  SELECT id INTO v_creator_id FROM user_profiles WHERE role = 'admin' AND is_active = true LIMIT 1;
  IF v_creator_id IS NULL THEN
    SELECT id INTO v_creator_id FROM user_profiles WHERE is_active = true LIMIT 1;
  END IF;

  INSERT INTO tasks (
    title, description, deadline, priority, auto_priority, status,
    task_type, task_mode, task_origin, reference_type, reference_id,
    auto_assigned_role, assigned_users, customer_id, product_id, created_by, proof_required
  ) VALUES (
    p_title, p_description, p_deadline, v_auto_priority::task_priority, v_auto_priority, 'to_do'::task_status,
    'system', 'advisory', p_origin, p_reference_type, p_reference_id,
    p_assigned_role, v_assigned_users, p_customer_id, p_product_id, v_creator_id, false
  )
  RETURNING id INTO v_task_id;

  IF array_length(v_assigned_users, 1) > 0 THEN
    INSERT INTO task_assignments (task_id, assigned_user_id, assigned_by)
    SELECT v_task_id, unnest(v_assigned_users), v_creator_id;
  END IF;

  RETURN v_task_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- STEP 4: Event Triggers
-- ============================================

CREATE OR REPLACE FUNCTION trigger_sales_order_approved_task()
RETURNS TRIGGER AS $$
DECLARE
  v_task_id uuid;
  v_event_id uuid;
  v_customer_name text;
  v_has_shortage boolean;
BEGIN
  IF NEW.status IN ('approved', 'stock_reserved') AND OLD.status != NEW.status THEN
    SELECT company_name INTO v_customer_name FROM customers WHERE id = NEW.customer_id;
    SELECT EXISTS(SELECT 1 FROM import_requirements WHERE sales_order_id = NEW.id) INTO v_has_shortage;

    INSERT INTO system_task_events (event_type, event_source, entity_type, entity_id, event_data)
    VALUES ('sales_order_approved', 'sales_orders', 'sales_order', NEW.id, jsonb_build_object(
      'so_number', NEW.so_number, 'customer_id', NEW.customer_id,
      'customer_name', v_customer_name, 'has_shortage', v_has_shortage
    )) RETURNING id INTO v_event_id;

    IF NEW.status = 'stock_reserved' AND NOT v_has_shortage THEN
      v_task_id := create_system_task(
        p_title := 'Prepare Dispatch for SO ' || NEW.so_number,
        p_description := 'Stock is reserved for ' || v_customer_name || '. Prepare delivery challan and arrange dispatch.' ||
                        CASE WHEN NEW.expected_delivery_date IS NOT NULL
                        THEN E'\n\nExpected Delivery: ' || NEW.expected_delivery_date::text ELSE '' END,
        p_deadline := COALESCE(NEW.expected_delivery_date::timestamptz, now() + interval '3 days'),
        p_origin := 'sales_order_approved',
        p_reference_type := 'sales_order',
        p_reference_id := NEW.id,
        p_assigned_role := 'warehouse',
        p_customer_id := NEW.customer_id
      );
      UPDATE system_task_events SET task_id = v_task_id, task_created = true, processed_at = now() WHERE id = v_event_id;
    END IF;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  IF v_event_id IS NOT NULL THEN
    UPDATE system_task_events SET error_message = SQLERRM, processed_at = now() WHERE id = v_event_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trigger_sales_order_task_creation ON sales_orders;
CREATE TRIGGER trigger_sales_order_task_creation
  AFTER UPDATE ON sales_orders
  FOR EACH ROW
  EXECUTE FUNCTION trigger_sales_order_approved_task();

CREATE OR REPLACE FUNCTION trigger_stock_shortage_task()
RETURNS TRIGGER AS $$
DECLARE
  v_task_id uuid;
  v_event_id uuid;
  v_product_name text;
  v_customer_name text;
  v_so_number text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT product_name INTO v_product_name FROM products WHERE id = NEW.product_id;
    SELECT company_name INTO v_customer_name FROM customers WHERE id = NEW.customer_id;
    IF NEW.sales_order_id IS NOT NULL THEN
      SELECT so_number INTO v_so_number FROM sales_orders WHERE id = NEW.sales_order_id;
    END IF;

    INSERT INTO system_task_events (event_type, event_source, entity_type, entity_id, event_data)
    VALUES ('import_requirement_created', 'import_requirements', 'import_requirement', NEW.id, jsonb_build_object(
      'product_id', NEW.product_id, 'product_name', v_product_name,
      'shortage_quantity', NEW.shortage_quantity, 'sales_order_id', NEW.sales_order_id, 'so_number', v_so_number
    )) RETURNING id INTO v_event_id;

    v_task_id := create_system_task(
      p_title := 'Procurement Required: ' || v_product_name,
      p_description := 'Stock shortage detected. Required: ' || NEW.required_quantity::text || ' units' || E'\n' ||
                      'Shortage: ' || NEW.shortage_quantity::text || ' units' ||
                      CASE WHEN v_so_number IS NOT NULL
                      THEN E'\n\nFor Sales Order: ' || v_so_number || ' (' || v_customer_name || ')' ELSE '' END ||
                      CASE WHEN NEW.required_delivery_date IS NOT NULL
                      THEN E'\n\nRequired by: ' || NEW.required_delivery_date::text ELSE '' END,
      p_deadline := COALESCE(NEW.required_delivery_date::timestamptz - interval '30 days', now() + interval '7 days'),
      p_origin := 'sales_order_shortage',
      p_reference_type := 'sales_order',
      p_reference_id := NEW.sales_order_id,
      p_assigned_role := 'admin',
      p_priority := NEW.priority::text,
      p_customer_id := NEW.customer_id,
      p_product_id := NEW.product_id
    );
    UPDATE system_task_events SET task_id = v_task_id, task_created = true, processed_at = now() WHERE id = v_event_id;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  IF v_event_id IS NOT NULL THEN
    UPDATE system_task_events SET error_message = SQLERRM, processed_at = now() WHERE id = v_event_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trigger_import_requirement_task_creation ON import_requirements;
CREATE TRIGGER trigger_import_requirement_task_creation
  AFTER INSERT ON import_requirements
  FOR EACH ROW
  EXECUTE FUNCTION trigger_stock_shortage_task();

CREATE OR REPLACE FUNCTION trigger_delivery_challan_task()
RETURNS TRIGGER AS $$
DECLARE
  v_task_id uuid;
  v_event_id uuid;
  v_customer_name text;
  v_item_count int;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT company_name INTO v_customer_name FROM customers WHERE id = NEW.customer_id;
    SELECT COUNT(*) INTO v_item_count FROM delivery_challan_items WHERE delivery_challan_id = NEW.id;

    INSERT INTO system_task_events (event_type, event_source, entity_type, entity_id, event_data)
    VALUES ('delivery_challan_created', 'delivery_challans', 'delivery_challan', NEW.id, jsonb_build_object(
      'challan_number', NEW.challan_number, 'customer_id', NEW.customer_id, 'customer_name', v_customer_name
    )) RETURNING id INTO v_event_id;

    v_task_id := create_system_task(
      p_title := 'Deliver Challan ' || NEW.challan_number,
      p_description := 'Delivery Challan created for ' || v_customer_name || '. Items: ' || v_item_count::text || E'\n\n' ||
                      'Complete delivery and obtain customer signature.',
      p_deadline := COALESCE(NEW.challan_date::timestamptz + interval '2 days', now() + interval '2 days'),
      p_origin := 'delivery_challan_created',
      p_reference_type := 'delivery_challan',
      p_reference_id := NEW.id,
      p_assigned_role := 'warehouse',
      p_customer_id := NEW.customer_id
    );
    UPDATE system_task_events SET task_id = v_task_id, task_created = true, processed_at = now() WHERE id = v_event_id;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  IF v_event_id IS NOT NULL THEN
    UPDATE system_task_events SET error_message = SQLERRM, processed_at = now() WHERE id = v_event_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trigger_delivery_challan_task_creation ON delivery_challans;
CREATE TRIGGER trigger_delivery_challan_task_creation
  AFTER INSERT ON delivery_challans
  FOR EACH ROW
  EXECUTE FUNCTION trigger_delivery_challan_task();

-- ============================================
-- STEP 5: Utility Functions
-- ============================================

CREATE OR REPLACE FUNCTION get_system_tasks_summary(user_role text DEFAULT NULL)
RETURNS TABLE (
  total_tasks bigint,
  urgent_tasks bigint,
  overdue_tasks bigint,
  today_tasks bigint,
  by_origin jsonb
) AS $$
BEGIN
  RETURN QUERY
  WITH task_stats AS (
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE auto_priority = 'urgent') as urgent,
      COUNT(*) FILTER (WHERE deadline < now()) as overdue,
      COUNT(*) FILTER (WHERE deadline::date = CURRENT_DATE) as today,
      jsonb_object_agg(
        COALESCE(task_origin, 'unknown'),
        count
      ) as origins
    FROM (
      SELECT task_origin, auto_priority, deadline, COUNT(*) as count
      FROM tasks
      WHERE task_type = 'system'
        AND task_mode = 'advisory'
        AND status != 'completed'
        AND NOT is_deleted
        AND (user_role IS NULL OR auto_assigned_role = user_role OR auth.uid() = ANY(assigned_users))
      GROUP BY task_origin, auto_priority, deadline
    ) sub
  )
  SELECT total, urgent, overdue, today, origins FROM task_stats;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION dismiss_system_task(p_task_id uuid, p_reason text DEFAULT NULL)
RETURNS boolean AS $$
BEGIN
  UPDATE tasks
  SET dismissed_at = now(), dismissed_by = auth.uid(), dismissal_reason = p_reason, status = 'completed'::task_status
  WHERE id = p_task_id AND task_type = 'system' AND task_mode = 'advisory';
  RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION get_users_by_role(text) TO authenticated;
GRANT EXECUTE ON FUNCTION calculate_task_priority(timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION create_system_task(text, text, timestamptz, text, text, uuid, text, text, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION get_system_tasks_summary(text) TO authenticated;
GRANT EXECUTE ON FUNCTION dismiss_system_task(uuid, text) TO authenticated;
