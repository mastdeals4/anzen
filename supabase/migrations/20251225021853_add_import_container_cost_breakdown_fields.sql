/*
  # Add Individual Cost Breakdown Fields to Import Containers

  1. Enhancement (Backward Compatible)
    - Add individual cost fields to `import_containers` table
    - Replace computed `total_import_expense` with sum of individual components
    - All fields are NULLABLE and default to 0 for backward compatibility

  2. Individual Cost Fields (CAPITALIZED - Increase Batch Cost)
    - duty_bm (BM - Duty)
    - ppn_import (PPN Import)
    - pph_import (PPh)
    - freight_charges (Freight)
    - clearing_forwarding (Clearing & Forwarding)
    - port_charges (Port charges)
    - container_handling (Container unloading)
    - transportation (Port → godown trucking)
    - other_import_costs (Miscellaneous import costs)

  3. Key Changes
    - Remove old single field approach
    - Add detailed cost breakdown for BPOM audit compliance
    - Update allocation function to use sum of individual costs
*/

-- =====================================================
-- 1. ADD INDIVIDUAL COST BREAKDOWN FIELDS
-- =====================================================

DO $$
BEGIN
  -- Add duty_bm if not exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'import_containers' AND column_name = 'duty_bm'
  ) THEN
    ALTER TABLE import_containers ADD COLUMN duty_bm DECIMAL(18,2) DEFAULT 0;
  END IF;

  -- Add ppn_import if not exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'import_containers' AND column_name = 'ppn_import'
  ) THEN
    ALTER TABLE import_containers ADD COLUMN ppn_import DECIMAL(18,2) DEFAULT 0;
  END IF;

  -- Add pph_import if not exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'import_containers' AND column_name = 'pph_import'
  ) THEN
    ALTER TABLE import_containers ADD COLUMN pph_import DECIMAL(18,2) DEFAULT 0;
  END IF;

  -- Add freight_charges if not exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'import_containers' AND column_name = 'freight_charges'
  ) THEN
    ALTER TABLE import_containers ADD COLUMN freight_charges DECIMAL(18,2) DEFAULT 0;
  END IF;

  -- Add clearing_forwarding if not exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'import_containers' AND column_name = 'clearing_forwarding'
  ) THEN
    ALTER TABLE import_containers ADD COLUMN clearing_forwarding DECIMAL(18,2) DEFAULT 0;
  END IF;

  -- Add port_charges if not exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'import_containers' AND column_name = 'port_charges'
  ) THEN
    ALTER TABLE import_containers ADD COLUMN port_charges DECIMAL(18,2) DEFAULT 0;
  END IF;

  -- Add container_handling if not exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'import_containers' AND column_name = 'container_handling'
  ) THEN
    ALTER TABLE import_containers ADD COLUMN container_handling DECIMAL(18,2) DEFAULT 0;
  END IF;

  -- Add transportation if not exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'import_containers' AND column_name = 'transportation'
  ) THEN
    ALTER TABLE import_containers ADD COLUMN transportation DECIMAL(18,2) DEFAULT 0;
  END IF;

  -- Add other_import_costs if not exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'import_containers' AND column_name = 'other_import_costs'
  ) THEN
    ALTER TABLE import_containers ADD COLUMN other_import_costs DECIMAL(18,2) DEFAULT 0;
  END IF;
END $$;

-- =====================================================
-- 2. CREATE COMPUTED COLUMN FOR TOTAL (IF NOT EXISTS)
-- =====================================================

-- Drop old total_import_expenses if it's not a generated column
DO $$
BEGIN
  -- Check if column exists and is not generated
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'import_containers' 
      AND column_name = 'total_import_expenses'
      AND is_generated = 'NEVER'
  ) THEN
    -- Migrate data from old single field to new breakdown
    -- For existing records, put all cost in 'other_import_costs'
    UPDATE import_containers
    SET other_import_costs = COALESCE(total_import_expenses, 0)
    WHERE duty_bm = 0 AND ppn_import = 0 AND pph_import = 0 
      AND freight_charges = 0 AND clearing_forwarding = 0 
      AND port_charges = 0 AND container_handling = 0 
      AND transportation = 0;

    -- Drop the old column
    ALTER TABLE import_containers DROP COLUMN total_import_expenses;
  END IF;
END $$;

-- Add computed total column
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'import_containers' AND column_name = 'total_import_expenses'
  ) THEN
    ALTER TABLE import_containers 
    ADD COLUMN total_import_expenses DECIMAL(18,2) GENERATED ALWAYS AS (
      COALESCE(duty_bm, 0) + 
      COALESCE(ppn_import, 0) + 
      COALESCE(pph_import, 0) + 
      COALESCE(freight_charges, 0) + 
      COALESCE(clearing_forwarding, 0) + 
      COALESCE(port_charges, 0) + 
      COALESCE(container_handling, 0) + 
      COALESCE(transportation, 0) + 
      COALESCE(other_import_costs, 0)
    ) STORED;
  END IF;
END $$;

-- =====================================================
-- 3. UPDATE ALLOCATION FUNCTION TO USE INDIVIDUAL COSTS
-- =====================================================

CREATE OR REPLACE FUNCTION allocate_import_costs_to_batches(
  p_container_id UUID
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_container RECORD;
  v_batch RECORD;
  v_total_invoice_value DECIMAL(18,2);
  v_total_import_cost DECIMAL(18,2);
  v_allocation_percentage DECIMAL(10,6);
  v_allocated_cost DECIMAL(18,2);
  v_batches_allocated INTEGER := 0;
BEGIN
  -- Get container details
  SELECT * INTO v_container
  FROM import_containers
  WHERE id = p_container_id;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Container not found');
  END IF;

  IF v_container.status != 'draft' THEN
    RETURN json_build_object('success', false, 'error', 'Container already allocated or locked');
  END IF;

  -- Calculate total import cost from individual components
  v_total_import_cost := 
    COALESCE(v_container.duty_bm, 0) + 
    COALESCE(v_container.ppn_import, 0) + 
    COALESCE(v_container.pph_import, 0) + 
    COALESCE(v_container.freight_charges, 0) + 
    COALESCE(v_container.clearing_forwarding, 0) + 
    COALESCE(v_container.port_charges, 0) + 
    COALESCE(v_container.container_handling, 0) + 
    COALESCE(v_container.transportation, 0) + 
    COALESCE(v_container.other_import_costs, 0);

  IF v_total_import_cost = 0 THEN
    RETURN json_build_object('success', false, 'error', 'No import costs to allocate');
  END IF;

  -- Calculate total invoice value for this container's batches
  SELECT COALESCE(SUM(import_price * import_quantity), 0) INTO v_total_invoice_value
  FROM batches
  WHERE import_container_id = p_container_id;

  IF v_total_invoice_value = 0 THEN
    RETURN json_build_object('success', false, 'error', 'No batches linked to this container');
  END IF;

  -- Allocate costs to each batch
  FOR v_batch IN
    SELECT id, import_price, import_quantity, (import_price * import_quantity) as batch_invoice_value
    FROM batches
    WHERE import_container_id = p_container_id
      AND COALESCE(cost_locked, false) = false
  LOOP
    -- Calculate allocation percentage and cost
    v_allocation_percentage := (v_batch.batch_invoice_value / v_total_invoice_value) * 100;
    v_allocated_cost := (v_total_import_cost * v_batch.batch_invoice_value) / v_total_invoice_value;

    -- Create or update allocation record
    INSERT INTO import_container_allocations (
      container_id,
      batch_id,
      batch_invoice_value,
      allocation_percentage,
      allocated_cost,
      allocated_by
    ) VALUES (
      p_container_id,
      v_batch.id,
      v_batch.batch_invoice_value,
      v_allocation_percentage,
      v_allocated_cost,
      auth.uid()
    ) ON CONFLICT (container_id, batch_id) DO UPDATE
    SET allocation_percentage = EXCLUDED.allocation_percentage,
        allocated_cost = EXCLUDED.allocated_cost;

    -- Update batch with allocated cost
    UPDATE batches
    SET import_cost_allocated = v_allocated_cost,
        final_landed_cost = import_price + v_allocated_cost,
        cost_locked = true
    WHERE id = v_batch.id;

    v_batches_allocated := v_batches_allocated + 1;
  END LOOP;

  -- Update container status
  UPDATE import_containers
  SET status = 'allocated',
      locked_at = now(),
      locked_by = auth.uid(),
      allocated_expenses = v_total_import_cost
  WHERE id = p_container_id;

  RETURN json_build_object(
    'success', true,
    'batches_allocated', v_batches_allocated,
    'total_cost', v_total_import_cost
  );
END;
$$;
