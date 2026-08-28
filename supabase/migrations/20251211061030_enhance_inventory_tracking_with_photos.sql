/*
  # Enhanced Inventory Tracking with Photos and Audit Logs
  
  ## Overview
  Enhances the inventory tracking system with photo documentation capabilities,
  detailed audit trails, and better transaction tracking.
  
  ## Changes
  
  ### 1. Add Photo Support to Inventory Transactions
    - Add photos jsonb column to inventory_transactions
    - Photos stored as array of objects: [{url, filename, uploaded_at}]
  
  ### 2. Create Storage Buckets
    - `rejection_photos` - For stock rejection documentation
    - `inventory_photos` - For general inventory transaction photos
  
  ### 3. Enhanced Audit Trail
    - Add more metadata to inventory_transactions
    - Track user who performed the action
    - Store before/after stock levels
  
  ### 4. Add Batch Photo Documentation
    - Allow multiple photos per batch for quality documentation
  
  ## Security
    - Update RLS policies for photo storage access
    - Only authenticated users can upload photos
    - Photos viewable by all authenticated users
*/

-- Add photos column to inventory_transactions if not exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'inventory_transactions' AND column_name = 'photos'
  ) THEN
    ALTER TABLE inventory_transactions ADD COLUMN photos jsonb DEFAULT '[]'::jsonb;
  END IF;
END $$;

-- Add metadata column for additional transaction details
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'inventory_transactions' AND column_name = 'metadata'
  ) THEN
    ALTER TABLE inventory_transactions ADD COLUMN metadata jsonb DEFAULT '{}'::jsonb;
  END IF;
END $$;

-- Add before/after stock tracking
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'inventory_transactions' AND column_name = 'stock_before'
  ) THEN
    ALTER TABLE inventory_transactions ADD COLUMN stock_before decimal(10,2);
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'inventory_transactions' AND column_name = 'stock_after'
  ) THEN
    ALTER TABLE inventory_transactions ADD COLUMN stock_after decimal(10,2);
  END IF;
END $$;

-- Create storage bucket for rejection photos
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'rejection_photos',
  'rejection_photos',
  false,
  10485760,
  ARRAY['image/jpeg', 'image/png', 'image/jpg', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

-- Create storage bucket for inventory photos
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'inventory_photos',
  'inventory_photos',
  false,
  10485760,
  ARRAY['image/jpeg', 'image/png', 'image/jpg', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

-- RLS Policies for rejection_photos bucket
CREATE POLICY "Authenticated users can upload rejection photos"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'rejection_photos');

CREATE POLICY "Authenticated users can view rejection photos"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'rejection_photos');

CREATE POLICY "Managers can delete rejection photos"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'rejection_photos' AND
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role IN ('manager', 'admin')
    )
  );

-- RLS Policies for inventory_photos bucket
CREATE POLICY "Authenticated users can upload inventory photos"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'inventory_photos');

CREATE POLICY "Authenticated users can view inventory photos"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'inventory_photos');

CREATE POLICY "Users can delete own inventory photos"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'inventory_photos' AND
    (owner = auth.uid() OR
     EXISTS (
       SELECT 1 FROM user_profiles
       WHERE user_profiles.id = auth.uid()
       AND user_profiles.role IN ('manager', 'admin')
     ))
  );

-- Function to track stock before/after in transactions
CREATE OR REPLACE FUNCTION track_stock_levels_in_transaction()
RETURNS TRIGGER AS $$
DECLARE
  current_stock_level decimal(10,2);
BEGIN
  -- Get current stock level before transaction
  IF NEW.batch_id IS NOT NULL THEN
    SELECT current_stock INTO current_stock_level
    FROM batches
    WHERE id = NEW.batch_id;
    
    NEW.stock_before := current_stock_level;
    NEW.stock_after := current_stock_level + NEW.quantity;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger to track stock levels (only if not already exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger 
    WHERE tgname = 'track_stock_levels_trigger'
  ) THEN
    CREATE TRIGGER track_stock_levels_trigger
      BEFORE INSERT ON inventory_transactions
      FOR EACH ROW
      EXECUTE FUNCTION track_stock_levels_in_transaction();
  END IF;
END $$;

-- Create inventory audit log view for easy reporting
CREATE OR REPLACE VIEW inventory_audit_log AS
SELECT 
  it.id,
  it.transaction_type,
  it.quantity,
  it.stock_before,
  it.stock_after,
  it.reference_type,
  it.reference_id,
  it.notes,
  it.photos,
  it.metadata,
  it.created_at,
  p.product_name,
  p.product_code,
  b.batch_number,
  b.current_stock as batch_current_stock,
  up.full_name as created_by_name,
  up.role as created_by_role
FROM inventory_transactions it
LEFT JOIN products p ON it.product_id = p.id
LEFT JOIN batches b ON it.batch_id = b.id
LEFT JOIN user_profiles up ON it.created_by = up.id
ORDER BY it.created_at DESC;

-- Grant access to the view
GRANT SELECT ON inventory_audit_log TO authenticated;

-- Create function to get transaction history for a batch
CREATE OR REPLACE FUNCTION get_batch_transaction_history(p_batch_id uuid)
RETURNS TABLE (
  transaction_date timestamptz,
  transaction_type text,
  quantity decimal,
  stock_before decimal,
  stock_after decimal,
  reference_type text,
  reference_id uuid,
  notes text,
  created_by_name text,
  has_photos boolean
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    it.created_at,
    it.transaction_type,
    it.quantity,
    it.stock_before,
    it.stock_after,
    it.reference_type,
    it.reference_id,
    it.notes,
    up.full_name,
    (jsonb_array_length(it.photos) > 0) as has_photos
  FROM inventory_transactions it
  LEFT JOIN user_profiles up ON it.created_by = up.id
  WHERE it.batch_id = p_batch_id
  ORDER BY it.created_at DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create function to get stock rejection history with photos
CREATE OR REPLACE FUNCTION get_rejection_history_with_photos(
  p_start_date date DEFAULT NULL,
  p_end_date date DEFAULT NULL,
  p_product_id uuid DEFAULT NULL
)
RETURNS TABLE (
  rejection_id uuid,
  rejection_number text,
  rejection_date date,
  product_name text,
  batch_number text,
  quantity_rejected decimal,
  rejection_reason text,
  status text,
  financial_loss decimal,
  photo_count integer,
  approved_by_name text
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    sr.id,
    sr.rejection_number,
    sr.rejection_date,
    p.product_name,
    b.batch_number,
    sr.quantity_rejected,
    sr.rejection_reason,
    sr.status,
    sr.financial_loss,
    jsonb_array_length(sr.photos)::integer,
    up.full_name
  FROM stock_rejections sr
  LEFT JOIN products p ON sr.product_id = p.id
  LEFT JOIN batches b ON sr.batch_id = b.id
  LEFT JOIN user_profiles up ON sr.approved_by = up.id
  WHERE (p_start_date IS NULL OR sr.rejection_date >= p_start_date)
    AND (p_end_date IS NULL OR sr.rejection_date <= p_end_date)
    AND (p_product_id IS NULL OR sr.product_id = p_product_id)
  ORDER BY sr.rejection_date DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
