/*
  # Pricing workflow tables

  Canonical migration for the Price Requests workflow. The live database may
  already contain these tables, so this migration uses IF NOT EXISTS patterns
  and only adds missing columns/indexes/policies.
*/

CREATE TABLE IF NOT EXISTS price_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pr_number text UNIQUE,
  inquiry_id uuid REFERENCES crm_inquiries(id) ON DELETE SET NULL,
  customer_name text,
  assigned_to uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  overall_status text NOT NULL DEFAULT 'draft' CHECK (overall_status IN ('draft', 'sourcing', 'pricing', 'quoted', 'won', 'lost')),
  total_products integer NOT NULL DEFAULT 0,
  source_pending integer NOT NULL DEFAULT 0,
  source_received integer NOT NULL DEFAULT 0,
  final_pending integer NOT NULL DEFAULT 0,
  final_ready integer NOT NULL DEFAULT 0,
  notes text,
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS price_request_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  price_request_id uuid NOT NULL REFERENCES price_requests(id) ON DELETE CASCADE,
  product_name text NOT NULL,
  specification text,
  quantity numeric,
  unit text,
  source_type text NOT NULL DEFAULT 'unknown' CHECK (source_type IN ('india', 'china', 'local', 'unknown')),
  source_contact text,
  price_status text NOT NULL DEFAULT 'pending' CHECK (price_status IN ('pending', 'received')),
  doc_status text NOT NULL DEFAULT 'not_required' CHECK (doc_status IN ('not_required', 'pending', 'received')),
  source_price numeric,
  source_currency text NOT NULL DEFAULT 'USD',
  final_quote_price numeric,
  final_quote_currency text NOT NULL DEFAULT 'USD',
  final_entered_by uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  final_entered_at timestamptz,
  target_price numeric,
  competitor_price numeric,
  remarks text,
  pending_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pricing_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  price_request_id uuid REFERENCES price_requests(id) ON DELETE SET NULL,
  price_request_item_id uuid REFERENCES price_request_items(id) ON DELETE SET NULL,
  customer_name text,
  product_name text NOT NULL,
  inquiry_number text,
  source_price numeric,
  source_currency text,
  final_quoted_price numeric,
  final_quote_currency text,
  target_price numeric,
  competitor_price numeric,
  won_lost text DEFAULT 'pending' CHECK (won_lost IN ('pending', 'won', 'lost')),
  lost_reason text,
  remarks text,
  quote_date timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS communication_timeline (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  price_request_id uuid REFERENCES price_requests(id) ON DELETE CASCADE,
  item_id uuid REFERENCES price_request_items(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  actor_id uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  actor_name text,
  description text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE price_requests ADD COLUMN IF NOT EXISTS pr_number text;
ALTER TABLE price_requests ADD COLUMN IF NOT EXISTS inquiry_id uuid REFERENCES crm_inquiries(id) ON DELETE SET NULL;
ALTER TABLE price_requests ADD COLUMN IF NOT EXISTS customer_name text;
ALTER TABLE price_requests ADD COLUMN IF NOT EXISTS assigned_to uuid REFERENCES user_profiles(id) ON DELETE SET NULL;
ALTER TABLE price_requests ADD COLUMN IF NOT EXISTS overall_status text NOT NULL DEFAULT 'draft';
ALTER TABLE price_requests ADD COLUMN IF NOT EXISTS total_products integer NOT NULL DEFAULT 0;
ALTER TABLE price_requests ADD COLUMN IF NOT EXISTS source_pending integer NOT NULL DEFAULT 0;
ALTER TABLE price_requests ADD COLUMN IF NOT EXISTS source_received integer NOT NULL DEFAULT 0;
ALTER TABLE price_requests ADD COLUMN IF NOT EXISTS final_pending integer NOT NULL DEFAULT 0;
ALTER TABLE price_requests ADD COLUMN IF NOT EXISTS final_ready integer NOT NULL DEFAULT 0;
ALTER TABLE price_requests ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE price_requests ADD COLUMN IF NOT EXISTS last_activity_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE price_requests ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES user_profiles(id) ON DELETE SET NULL;
ALTER TABLE price_requests ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE price_requests ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE price_request_items ADD COLUMN IF NOT EXISTS price_request_id uuid REFERENCES price_requests(id) ON DELETE CASCADE;
ALTER TABLE price_request_items ADD COLUMN IF NOT EXISTS product_name text;
ALTER TABLE price_request_items ADD COLUMN IF NOT EXISTS specification text;
ALTER TABLE price_request_items ADD COLUMN IF NOT EXISTS quantity numeric;
ALTER TABLE price_request_items ADD COLUMN IF NOT EXISTS unit text;
ALTER TABLE price_request_items ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'unknown';
ALTER TABLE price_request_items ADD COLUMN IF NOT EXISTS source_contact text;
ALTER TABLE price_request_items ADD COLUMN IF NOT EXISTS price_status text NOT NULL DEFAULT 'pending';
ALTER TABLE price_request_items ADD COLUMN IF NOT EXISTS doc_status text NOT NULL DEFAULT 'not_required';
ALTER TABLE price_request_items ADD COLUMN IF NOT EXISTS source_price numeric;
ALTER TABLE price_request_items ADD COLUMN IF NOT EXISTS source_currency text NOT NULL DEFAULT 'USD';
ALTER TABLE price_request_items ADD COLUMN IF NOT EXISTS final_quote_price numeric;
ALTER TABLE price_request_items ADD COLUMN IF NOT EXISTS final_quote_currency text NOT NULL DEFAULT 'USD';
ALTER TABLE price_request_items ADD COLUMN IF NOT EXISTS final_entered_by uuid REFERENCES user_profiles(id) ON DELETE SET NULL;
ALTER TABLE price_request_items ADD COLUMN IF NOT EXISTS final_entered_at timestamptz;
ALTER TABLE price_request_items ADD COLUMN IF NOT EXISTS target_price numeric;
ALTER TABLE price_request_items ADD COLUMN IF NOT EXISTS competitor_price numeric;
ALTER TABLE price_request_items ADD COLUMN IF NOT EXISTS remarks text;
ALTER TABLE price_request_items ADD COLUMN IF NOT EXISTS pending_reason text;
ALTER TABLE price_request_items ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE price_request_items ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE pricing_ledger ADD COLUMN IF NOT EXISTS price_request_id uuid REFERENCES price_requests(id) ON DELETE SET NULL;
ALTER TABLE pricing_ledger ADD COLUMN IF NOT EXISTS price_request_item_id uuid REFERENCES price_request_items(id) ON DELETE SET NULL;
ALTER TABLE pricing_ledger ADD COLUMN IF NOT EXISTS customer_name text;
ALTER TABLE pricing_ledger ADD COLUMN IF NOT EXISTS product_name text;
ALTER TABLE pricing_ledger ADD COLUMN IF NOT EXISTS inquiry_number text;
ALTER TABLE pricing_ledger ADD COLUMN IF NOT EXISTS source_price numeric;
ALTER TABLE pricing_ledger ADD COLUMN IF NOT EXISTS source_currency text;
ALTER TABLE pricing_ledger ADD COLUMN IF NOT EXISTS final_quoted_price numeric;
ALTER TABLE pricing_ledger ADD COLUMN IF NOT EXISTS final_quote_currency text;
ALTER TABLE pricing_ledger ADD COLUMN IF NOT EXISTS target_price numeric;
ALTER TABLE pricing_ledger ADD COLUMN IF NOT EXISTS competitor_price numeric;
ALTER TABLE pricing_ledger ADD COLUMN IF NOT EXISTS won_lost text DEFAULT 'pending';
ALTER TABLE pricing_ledger ADD COLUMN IF NOT EXISTS lost_reason text;
ALTER TABLE pricing_ledger ADD COLUMN IF NOT EXISTS remarks text;
ALTER TABLE pricing_ledger ADD COLUMN IF NOT EXISTS quote_date timestamptz NOT NULL DEFAULT now();
ALTER TABLE pricing_ledger ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES user_profiles(id) ON DELETE SET NULL;
ALTER TABLE pricing_ledger ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE pricing_ledger ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE communication_timeline ADD COLUMN IF NOT EXISTS price_request_id uuid REFERENCES price_requests(id) ON DELETE CASCADE;
ALTER TABLE communication_timeline ADD COLUMN IF NOT EXISTS item_id uuid REFERENCES price_request_items(id) ON DELETE SET NULL;
ALTER TABLE communication_timeline ADD COLUMN IF NOT EXISTS event_type text;
ALTER TABLE communication_timeline ADD COLUMN IF NOT EXISTS actor_id uuid REFERENCES user_profiles(id) ON DELETE SET NULL;
ALTER TABLE communication_timeline ADD COLUMN IF NOT EXISTS actor_name text;
ALTER TABLE communication_timeline ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE communication_timeline ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE communication_timeline ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

CREATE SEQUENCE IF NOT EXISTS price_requests_pr_number_seq;

CREATE OR REPLACE FUNCTION set_price_request_number()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.pr_number IS NULL OR NEW.pr_number = '' THEN
    NEW.pr_number := 'PR-' || to_char(now(), 'YY') || '-' || lpad(nextval('price_requests_pr_number_seq')::text, 5, '0');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_price_request_number ON price_requests;
CREATE TRIGGER trg_set_price_request_number
  BEFORE INSERT ON price_requests
  FOR EACH ROW
  EXECUTE FUNCTION set_price_request_number();

CREATE OR REPLACE FUNCTION touch_pricing_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_price_requests_updated_at ON price_requests;
CREATE TRIGGER trg_price_requests_updated_at
  BEFORE UPDATE ON price_requests
  FOR EACH ROW
  EXECUTE FUNCTION touch_pricing_updated_at();

DROP TRIGGER IF EXISTS trg_price_request_items_updated_at ON price_request_items;
CREATE TRIGGER trg_price_request_items_updated_at
  BEFORE UPDATE ON price_request_items
  FOR EACH ROW
  EXECUTE FUNCTION touch_pricing_updated_at();

DROP TRIGGER IF EXISTS trg_pricing_ledger_updated_at ON pricing_ledger;
CREATE TRIGGER trg_pricing_ledger_updated_at
  BEFORE UPDATE ON pricing_ledger
  FOR EACH ROW
  EXECUTE FUNCTION touch_pricing_updated_at();

CREATE UNIQUE INDEX IF NOT EXISTS idx_price_requests_pr_number_unique ON price_requests(pr_number);
CREATE UNIQUE INDEX IF NOT EXISTS idx_price_requests_inquiry_id_unique ON price_requests(inquiry_id) WHERE inquiry_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pricing_ledger_item_unique ON pricing_ledger(price_request_item_id) WHERE price_request_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_price_requests_status ON price_requests(overall_status);
CREATE INDEX IF NOT EXISTS idx_price_requests_last_activity ON price_requests(last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_price_request_items_request ON price_request_items(price_request_id);
CREATE INDEX IF NOT EXISTS idx_price_request_items_desk ON price_request_items(price_status, final_quote_price);
CREATE INDEX IF NOT EXISTS idx_pricing_ledger_request ON pricing_ledger(price_request_id);
CREATE INDEX IF NOT EXISTS idx_pricing_ledger_quote_date ON pricing_ledger(quote_date DESC);
CREATE INDEX IF NOT EXISTS idx_communication_timeline_request ON communication_timeline(price_request_id, created_at DESC);

ALTER TABLE price_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_request_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication_timeline ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION current_user_has_pricing_role(allowed_roles text[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM user_profiles
    WHERE id = auth.uid()
      AND is_active = true
      AND role = ANY(allowed_roles)
  );
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'price_requests' AND policyname = 'pricing_request_read') THEN
    CREATE POLICY "pricing_request_read" ON price_requests
      FOR SELECT TO authenticated
      USING (current_user_has_pricing_role(ARRAY['admin', 'manager', 'sales']));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'price_requests' AND policyname = 'pricing_request_insert') THEN
    CREATE POLICY "pricing_request_insert" ON price_requests
      FOR INSERT TO authenticated
      WITH CHECK (current_user_has_pricing_role(ARRAY['admin', 'manager', 'sales']));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'price_requests' AND policyname = 'pricing_request_update') THEN
    CREATE POLICY "pricing_request_update" ON price_requests
      FOR UPDATE TO authenticated
      USING (current_user_has_pricing_role(ARRAY['admin', 'manager', 'sales']))
      WITH CHECK (current_user_has_pricing_role(ARRAY['admin', 'manager', 'sales']));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'price_request_items' AND policyname = 'pricing_items_read') THEN
    CREATE POLICY "pricing_items_read" ON price_request_items
      FOR SELECT TO authenticated
      USING (current_user_has_pricing_role(ARRAY['admin', 'manager', 'sales']));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'price_request_items' AND policyname = 'pricing_items_insert') THEN
    CREATE POLICY "pricing_items_insert" ON price_request_items
      FOR INSERT TO authenticated
      WITH CHECK (current_user_has_pricing_role(ARRAY['admin', 'manager', 'sales']));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'price_request_items' AND policyname = 'pricing_items_update') THEN
    CREATE POLICY "pricing_items_update" ON price_request_items
      FOR UPDATE TO authenticated
      USING (current_user_has_pricing_role(ARRAY['admin', 'manager', 'sales']))
      WITH CHECK (current_user_has_pricing_role(ARRAY['admin', 'manager', 'sales']));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'pricing_ledger' AND policyname = 'pricing_ledger_read') THEN
    CREATE POLICY "pricing_ledger_read" ON pricing_ledger
      FOR SELECT TO authenticated
      USING (current_user_has_pricing_role(ARRAY['admin', 'manager', 'sales']));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'pricing_ledger' AND policyname = 'pricing_ledger_insert') THEN
    CREATE POLICY "pricing_ledger_insert" ON pricing_ledger
      FOR INSERT TO authenticated
      WITH CHECK (current_user_has_pricing_role(ARRAY['admin', 'manager']));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'pricing_ledger' AND policyname = 'pricing_ledger_update') THEN
    CREATE POLICY "pricing_ledger_update" ON pricing_ledger
      FOR UPDATE TO authenticated
      USING (current_user_has_pricing_role(ARRAY['admin', 'manager']))
      WITH CHECK (current_user_has_pricing_role(ARRAY['admin', 'manager']));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'communication_timeline' AND policyname = 'pricing_timeline_read') THEN
    CREATE POLICY "pricing_timeline_read" ON communication_timeline
      FOR SELECT TO authenticated
      USING (current_user_has_pricing_role(ARRAY['admin', 'manager', 'sales']));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'communication_timeline' AND policyname = 'pricing_timeline_insert') THEN
    CREATE POLICY "pricing_timeline_insert" ON communication_timeline
      FOR INSERT TO authenticated
      WITH CHECK (current_user_has_pricing_role(ARRAY['admin', 'manager', 'sales']));
  END IF;
END $$;
