-- ==============================================================================
-- Production Schema Baseline Fixture for SAPJ Migration Compatibility Testing
-- ==============================================================================

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$ LANGUAGE sql STABLE;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Roles & Permissions
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon;
  END IF;
END $$;

-- Enums
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'dc_approval_status') THEN
    CREATE TYPE public.dc_approval_status AS ENUM ('pending_approval', 'approved', 'rejected', 'cancelled');
  END IF;
END $$;

-- User Profiles
CREATE TABLE IF NOT EXISTS public.user_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role text NOT NULL,
  full_name text
);

INSERT INTO public.user_profiles (id, role, full_name)
VALUES ('00000000-0000-0000-0000-000000000001', 'admin', 'Default Admin User'),
       ('00000000-0000-0000-0000-000000000002', 'warehouse', 'Default Warehouse User'),
       ('00000000-0000-0000-0000-000000000003', 'viewer', 'Default Viewer User')
ON CONFLICT (id) DO NOTHING;

-- Customers
CREATE TABLE IF NOT EXISTS public.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name text NOT NULL
);

-- Products & Batches
CREATE TABLE IF NOT EXISTS public.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_name text NOT NULL,
  product_code text,
  unit text DEFAULT 'kg'
);

CREATE TABLE IF NOT EXISTS public.batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid REFERENCES public.products(id),
  batch_number text NOT NULL,
  cost_per_unit numeric DEFAULT 0,
  landed_cost_per_unit numeric DEFAULT 0,
  import_price numeric DEFAULT 0,
  import_quantity numeric DEFAULT 0,
  current_stock numeric DEFAULT 0,
  is_active boolean DEFAULT true
);

-- Sales Orders
CREATE TABLE IF NOT EXISTS public.sales_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  so_number text NOT NULL UNIQUE,
  customer_id uuid REFERENCES public.customers(id),
  order_date date DEFAULT CURRENT_DATE,
  status text DEFAULT 'confirmed',
  total_amount numeric DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public.sales_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id uuid REFERENCES public.sales_orders(id),
  product_id uuid REFERENCES public.products(id),
  quantity numeric NOT NULL,
  unit_price numeric DEFAULT 0
);

-- Delivery Challans
CREATE TABLE IF NOT EXISTS public.delivery_challans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  challan_number text NOT NULL UNIQUE,
  customer_id uuid REFERENCES public.customers(id),
  sales_order_id uuid REFERENCES public.sales_orders(id),
  challan_date date DEFAULT CURRENT_DATE,
  approval_status text DEFAULT 'approved',
  rejection_reason text,
  rejected_by uuid,
  rejected_at timestamptz,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.delivery_challan_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  challan_id uuid REFERENCES public.delivery_challans(id),
  product_id uuid REFERENCES public.products(id),
  batch_id uuid REFERENCES public.batches(id),
  quantity numeric NOT NULL
);

CREATE TABLE IF NOT EXISTS public.dc_batch_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_challan_item_id uuid REFERENCES public.delivery_challan_items(id),
  batch_id uuid REFERENCES public.batches(id),
  quantity numeric NOT NULL,
  status text DEFAULT 'consumed'
);

-- Chart of Accounts & Accounting Periods
CREATE TABLE IF NOT EXISTS public.chart_of_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  account_type text NOT NULL
);

INSERT INTO public.chart_of_accounts (code, name, account_type)
VALUES ('5100', 'Cost of Goods Sold', 'expense'),
       ('1130', 'Inventory', 'asset'),
       ('4100', 'Sales Revenue', 'revenue'),
       ('1120', 'Accounts Receivable', 'asset')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.accounting_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_name text NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  is_closed boolean DEFAULT false
);

INSERT INTO public.accounting_periods (period_name, start_date, end_date, is_closed)
VALUES ('2026-10', '2026-10-01', '2026-10-31', false)
ON CONFLICT DO NOTHING;

-- Accounting / Journals
CREATE TABLE IF NOT EXISTS public.journal_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_number text,
  source_module text,
  reference_id uuid,
  reference_number text,
  notes text,
  entry_date date DEFAULT CURRENT_DATE,
  accounting_period_id uuid,
  status text DEFAULT 'posted',
  is_posted boolean DEFAULT true,
  is_reversed boolean DEFAULT false
);

CREATE TABLE IF NOT EXISTS public.journal_entry_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE CASCADE,
  account_id uuid REFERENCES public.chart_of_accounts(id),
  sales_invoice_item_id uuid,
  debit numeric DEFAULT 0,
  credit numeric DEFAULT 0
);

-- Voucher Allocations & Rounding Adjustments
CREATE TABLE IF NOT EXISTS public.voucher_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  voucher_type text DEFAULT 'receipt',
  sales_invoice_id uuid,
  invoice_id uuid,
  allocated_amount numeric DEFAULT 0,
  status text DEFAULT 'approved'
);

CREATE TABLE IF NOT EXISTS public.invoice_rounding_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid,
  sales_invoice_id uuid,
  adjustment_amount numeric DEFAULT 0,
  amount numeric DEFAULT 0
);

-- Expenses & Categories
CREATE TABLE IF NOT EXISTS public.expense_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  category_key text,
  category_type text DEFAULT 'general',
  is_sales_related boolean DEFAULT false
);

CREATE TABLE IF NOT EXISTS public.finance_expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  voucher_number text,
  description text,
  expense_category text DEFAULT 'general',
  category_id uuid REFERENCES public.expense_categories(id),
  sales_invoice_id uuid,
  sales_order_id uuid,
  delivery_challan_id uuid,
  sales_order_allocations jsonb DEFAULT '[]'::jsonb,
  amount numeric DEFAULT 0,
  expense_date date DEFAULT CURRENT_DATE,
  approval_status text DEFAULT 'approved'
);

-- Credit Notes
CREATE TABLE IF NOT EXISTS public.credit_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_note_number text NOT NULL,
  sales_invoice_id uuid,
  customer_id uuid,
  credit_note_date date DEFAULT CURRENT_DATE,
  status text DEFAULT 'approved',
  subtotal numeric DEFAULT 0,
  tax_amount numeric DEFAULT 0,
  total_amount numeric DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public.credit_note_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_note_id uuid REFERENCES public.credit_notes(id),
  product_id uuid REFERENCES public.products(id),
  batch_id uuid REFERENCES public.batches(id),
  quantity numeric DEFAULT 0,
  unit_price numeric DEFAULT 0,
  total_price numeric(15,2) GENERATED ALWAYS AS ((quantity * unit_price)) STORED
);

-- Sales Invoices Baseline Table
CREATE TABLE IF NOT EXISTS public.sales_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number text NOT NULL UNIQUE,
  customer_id uuid REFERENCES public.customers(id),
  sales_order_id uuid REFERENCES public.sales_orders(id),
  invoice_date date DEFAULT CURRENT_DATE,
  due_date date,
  discount_amount numeric DEFAULT 0,
  delivery_challan_number text,
  po_number text,
  payment_terms_days integer DEFAULT 30,
  notes text,
  subtotal numeric DEFAULT 0,
  tax_amount numeric DEFAULT 0,
  stamp_duty_amount numeric DEFAULT 0,
  total_amount numeric DEFAULT 0,
  paid_amount numeric DEFAULT 0,
  balance_amount numeric DEFAULT 0,
  payment_status text DEFAULT 'pending',
  created_by uuid,
  linked_challan_ids text[],
  journal_entry_id uuid,
  is_draft boolean DEFAULT false,
  document_status text DEFAULT 'posted',
  cancelled_at timestamptz,
  cancelled_by uuid,
  cancellation_reason text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.sales_invoice_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid REFERENCES public.sales_invoices(id) ON DELETE CASCADE,
  product_id uuid REFERENCES public.products(id),
  batch_id uuid REFERENCES public.batches(id),
  quantity numeric NOT NULL,
  unit_price numeric DEFAULT 0,
  tax_rate numeric DEFAULT 0,
  delivery_challan_item_id uuid REFERENCES public.delivery_challan_items(id),
  cogs_total_cost numeric(15,2),
  cogs_unit_cost numeric(15,4)
);

-- Helper Stubs
CREATE OR REPLACE FUNCTION public.post_inventory_movement(
  p_movement_id uuid, p_product_id uuid, p_batch_id uuid, p_type text,
  p_quantity numeric, p_date date, p_ref text, p_source text, p_source_id uuid,
  p_notes text, p_user uuid, p_val1 text, p_val2 text
) RETURNS void AS $$ BEGIN RETURN; END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.calculate_batch_authoritative_cost(p_batch public.batches)
RETURNS numeric AS $$
BEGIN
  RETURN COALESCE(p_batch.landed_cost_per_unit, p_batch.cost_per_unit, 0::numeric);
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION public.effective_sales_cogs_unit_cost(p_batch_id uuid)
RETURNS numeric AS $$
DECLARE
  v_batch public.batches%ROWTYPE;
BEGIN
  SELECT * INTO v_batch FROM public.batches WHERE id = p_batch_id;
  IF NOT FOUND THEN RETURN 0; END IF;
  RETURN public.calculate_batch_authoritative_cost(v_batch);
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION public.get_credit_note_item_fifo_cogs(p_cni_id uuid)
RETURNS numeric AS $$
BEGIN
  RETURN 0::numeric;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION public.uuid_from_text(p_val text) RETURNS uuid AS $$
BEGIN
  RETURN md5(p_val)::uuid;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ------------------------------------------------------------------------------
-- Existing Production View: dc_invoicing_summary (13 Columns Baseline)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.dc_invoicing_summary AS
 SELECT dc.id AS challan_id,
    dc.challan_number,
    dc.customer_id,
    dc.challan_date,
    dc.approval_status,
    count(DISTINCT dci.id) AS total_items,
    count(DISTINCT CASE WHEN sii.id IS NULL THEN dci.id ELSE NULL::uuid END) AS not_invoiced_items,
    count(DISTINCT CASE WHEN sii.id IS NOT NULL THEN dci.id ELSE NULL::uuid END) AS invoiced_items,
    COALESCE(sum(dci.quantity), 0::numeric) AS total_quantity,
    COALESCE(sum(CASE WHEN sii.id IS NULL THEN dci.quantity ELSE 0::numeric END), 0::numeric) AS total_remaining_quantity,
    'not_invoiced'::text AS dc_status,
    ARRAY[]::text[] AS linked_invoices,
    ARRAY[]::text[] AS linked_invoice_numbers
   FROM public.delivery_challans dc
     LEFT JOIN public.delivery_challan_items dci ON dc.id = dci.challan_id
     LEFT JOIN public.sales_invoice_items sii ON sii.delivery_challan_item_id = dci.id
   GROUP BY dc.id, dc.challan_number, dc.customer_id, dc.challan_date, dc.approval_status;

-- ------------------------------------------------------------------------------
-- Existing Production View: so_delivery_invoice_status (12 Columns Baseline)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.so_delivery_invoice_status AS
 SELECT so.id AS so_id,
    so.so_number,
    so.customer_id,
    so.status AS so_status,
    'pending'::text AS delivery_status,
    'pending'::text AS invoice_status,
    NULL::text AS special_status,
    0::bigint AS approved_dc_count,
    0::bigint AS invoice_count,
    0::numeric AS ordered_qty,
    0::numeric AS approved_delivered_qty,
    0::numeric AS invoiced_qty
   FROM public.sales_orders so;
