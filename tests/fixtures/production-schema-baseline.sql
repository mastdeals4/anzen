-- ==============================================================================
-- Production Schema Baseline Fixture for SAPJ Migration Compatibility Testing
-- ==============================================================================

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb,
    jsonb_build_object(
      'role', current_setting('request.jwt.claim.role', true),
      'sub', current_setting('request.jwt.claim.sub', true)
    )
  );
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
  company_name text NOT NULL,
  address text,
  city text,
  phone text,
  npwp text,
  email text,
  is_active boolean DEFAULT true
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
  account_type text NOT NULL,
  normal_balance text,
  is_active boolean DEFAULT true
);

INSERT INTO public.chart_of_accounts (code, name, account_type, normal_balance)
VALUES ('5100', 'Cost of Goods Sold', 'expense', 'debit'),
       ('1130', 'Inventory', 'asset', 'debit'),
       ('4100', 'Sales Revenue', 'revenue', 'credit'),
       ('1120', 'Accounts Receivable', 'asset', 'debit'),
       ('1102', 'Bank Central Asia - IDR', 'asset', 'debit'),
       ('4300', 'Sales Returns & Allowances', 'contra', 'debit'),
       ('2130', 'Output PPN Payable', 'liability', 'credit'),
       ('2140', 'Customer Credit & Advances', 'liability', 'credit')
ON CONFLICT (code) DO UPDATE SET normal_balance = EXCLUDED.normal_balance, account_type = EXCLUDED.account_type;

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
  description text,
  total_debit numeric DEFAULT 0,
  total_credit numeric DEFAULT 0,
  notes text,
  entry_date date DEFAULT CURRENT_DATE,
  accounting_period_id uuid,
  status text DEFAULT 'posted',
  is_posted boolean DEFAULT true,
  is_reversed boolean DEFAULT false,
  posted_by uuid,
  created_by uuid
);

CREATE TABLE IF NOT EXISTS public.journal_entry_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE CASCADE,
  line_number integer DEFAULT 1,
  account_id uuid REFERENCES public.chart_of_accounts(id),
  sales_invoice_item_id uuid,
  description text,
  debit numeric DEFAULT 0,
  credit numeric DEFAULT 0,
  customer_id uuid
);

CREATE SEQUENCE IF NOT EXISTS public.credit_note_number_seq;
CREATE SEQUENCE IF NOT EXISTS public.journal_entry_number_seq;

CREATE OR REPLACE FUNCTION public.next_journal_entry_number() RETURNS text AS $$
DECLARE
  v_seq integer;
BEGIN
  v_seq := nextval('public.credit_note_number_seq');
  RETURN 'JE' || to_char(CURRENT_DATE, 'YYMM') || '-' || lpad(v_seq::text, 4, '0');
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS public.bank_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_name text NOT NULL,
  bank_name text NOT NULL,
  account_number text NOT NULL,
  account_type text NOT NULL DEFAULT 'current',
  currency text DEFAULT 'IDR',
  opening_balance numeric DEFAULT 0,
  current_balance numeric DEFAULT 0,
  is_active boolean DEFAULT true,
  coa_id uuid REFERENCES public.chart_of_accounts(id)
);

CREATE TABLE IF NOT EXISTS public.payment_vouchers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  voucher_number text NOT NULL,
  voucher_date date NOT NULL DEFAULT CURRENT_DATE,
  supplier_id uuid,
  payment_method text NOT NULL DEFAULT 'bank_transfer',
  bank_account_id uuid REFERENCES public.bank_accounts(id),
  reference_number text,
  amount numeric(18,2) NOT NULL,
  description text,
  journal_entry_id uuid REFERENCES public.journal_entries(id),
  created_by uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  is_posted boolean DEFAULT true
);

CREATE TABLE IF NOT EXISTS public.inventory_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid,
  batch_id uuid,
  transaction_type text NOT NULL,
  quantity numeric NOT NULL,
  transaction_date date DEFAULT CURRENT_DATE,
  reference_number text,
  reference_type text,
  reference_id uuid,
  notes text,
  created_by uuid,
  created_at timestamptz DEFAULT now(),
  metadata jsonb DEFAULT '{}'::jsonb
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

CREATE TABLE IF NOT EXISTS public.material_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_number text,
  original_dc_id uuid REFERENCES public.delivery_challans(id),
  original_invoice_id uuid REFERENCES public.sales_invoices(id),
  customer_id uuid REFERENCES public.customers(id),
  return_date date DEFAULT CURRENT_DATE,
  return_type text DEFAULT 'quality_issue',
  return_reason text DEFAULT 'Customer Return',
  status text DEFAULT 'pending_approval',
  approved_by uuid,
  credit_note_id uuid,
  credit_note_issued boolean DEFAULT false,
  credit_note_number text,
  credit_note_amount numeric DEFAULT 0,
  restocked boolean DEFAULT false,
  notes text,
  nota_retur_id uuid,
  created_by uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.material_return_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id uuid REFERENCES public.material_returns(id) ON DELETE CASCADE,
  product_id uuid REFERENCES public.products(id),
  batch_id uuid REFERENCES public.batches(id),
  quantity_returned numeric NOT NULL,
  original_quantity numeric DEFAULT 0,
  unit_price numeric DEFAULT 0,
  condition text DEFAULT 'good',
  disposition text DEFAULT 'pending',
  notes text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.nota_retur (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nota_retur_number text DEFAULT 'NR/2026/10/0001',
  return_date date DEFAULT CURRENT_DATE,
  material_return_id uuid REFERENCES public.material_returns(id),
  credit_note_id uuid,
  sales_invoice_id uuid REFERENCES public.sales_invoices(id),
  original_invoice_number text NOT NULL,
  sales_invoice_number text,
  original_faktur_pajak_number text,
  original_faktur_pajak_date date,
  customer_id uuid REFERENCES public.customers(id),
  customer_name text,
  customer_address text,
  currency text DEFAULT 'IDR',
  dpp_amount numeric(15,2) DEFAULT 0,
  tax_rate numeric(5,4) DEFAULT 0.1100,
  ppn_amount numeric(15,2) DEFAULT 0,
  total_amount numeric(15,2) DEFAULT 0,
  status text DEFAULT 'draft',
  coretax_status text DEFAULT 'draft',
  coretax_reference_number text,
  coretax_submission_date timestamptz,
  notes text,
  document_url text,
  created_by uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.nota_retur_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nota_retur_id uuid REFERENCES public.nota_retur(id) ON DELETE CASCADE,
  product_id uuid REFERENCES public.products(id),
  batch_id uuid REFERENCES public.batches(id),
  item_name text NOT NULL,
  quantity numeric(12,3) NOT NULL,
  unit_price numeric(15,2) DEFAULT 0,
  dpp_amount numeric(15,2) DEFAULT 0,
  tax_rate numeric(5,2) DEFAULT 11.00,
  ppn_amount numeric(15,2) DEFAULT 0,
  total_amount numeric(15,2) DEFAULT 0
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
  product_id uuid REFERENCES public.products(id),
  amount numeric DEFAULT 0,
  expense_date date DEFAULT CURRENT_DATE,
  approval_status text DEFAULT 'approved'
);

-- Credit Notes
CREATE TABLE IF NOT EXISTS public.credit_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_note_number text NOT NULL,
  original_invoice_id uuid REFERENCES public.sales_invoices(id),
  sales_invoice_id uuid REFERENCES public.sales_invoices(id),
  material_return_id uuid REFERENCES public.material_returns(id),
  customer_id uuid REFERENCES public.customers(id),
  credit_note_date date DEFAULT CURRENT_DATE,
  status text DEFAULT 'approved',
  credit_note_type text DEFAULT 'physical_return',
  original_invoice_number text,
  reason text,
  notes text,
  currency text DEFAULT 'IDR',
  subtotal numeric DEFAULT 0,
  tax_amount numeric DEFAULT 0,
  total_amount numeric DEFAULT 0,
  journal_entry_id uuid REFERENCES public.journal_entries(id),
  nota_retur_id uuid REFERENCES public.nota_retur(id),
  created_by uuid,
  approved_by uuid,
  approval_date timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
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



-- Helper Stubs
CREATE OR REPLACE FUNCTION public.post_inventory_movement(
  p_movement_id uuid, p_product_id uuid, p_batch_id uuid, p_type text,
  p_quantity numeric, p_date date, p_ref text, p_source text, p_source_id uuid,
  p_notes text, p_user uuid, p_val1 text, p_val2 text
) RETURNS void AS $$
BEGIN
  INSERT INTO public.inventory_transactions (
    id, product_id, batch_id, transaction_type, quantity,
    transaction_date, reference_number, reference_type, reference_id,
    notes, created_by
  ) VALUES (
    COALESCE(p_movement_id, gen_random_uuid()), p_product_id, p_batch_id, p_type, p_quantity,
    COALESCE(p_date, CURRENT_DATE), p_ref, p_source, p_source_id,
    p_notes, p_user
  ) ON CONFLICT (id) DO NOTHING;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF p_type IN ('return', 'in', 'adjustment_in') THEN
    UPDATE public.batches SET current_stock = current_stock + p_quantity WHERE id = p_batch_id;
  ELSIF p_type IN ('out', 'sale', 'adjustment_out') THEN
    UPDATE public.batches SET current_stock = current_stock - p_quantity WHERE id = p_batch_id;
  END IF;
  RETURN;
END;
$$ LANGUAGE plpgsql;

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

CREATE OR REPLACE FUNCTION public.get_invoice_credit_note_amount(p_invoice_id uuid)
RETURNS numeric AS $$
  SELECT COALESCE(SUM(total_amount), 0)
  FROM public.credit_notes
  WHERE original_invoice_id = p_invoice_id
    AND status = 'approved';
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION public.recalculate_sales_invoice_payment_state(p_invoice_id uuid)
RETURNS void AS $$
DECLARE
  v_invoice record;
  v_allocated numeric(18,2) := 0;
  v_credit_note numeric(18,2) := 0;
  v_paid numeric(18,2);
BEGIN
  SELECT id, total_amount INTO v_invoice FROM public.sales_invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT COALESCE(SUM(allocated_amount), 0) INTO v_allocated
  FROM public.voucher_allocations WHERE sales_invoice_id = p_invoice_id;

  v_credit_note := public.get_invoice_credit_note_amount(p_invoice_id);
  v_paid := LEAST(GREATEST(v_allocated + v_credit_note, 0), COALESCE(v_invoice.total_amount, 0));

  UPDATE public.sales_invoices
  SET paid_amount = v_paid,
      balance_amount = GREATEST(COALESCE(v_invoice.total_amount, 0) - v_paid, 0),
      payment_status = CASE
        WHEN v_paid <= 0 THEN 'pending'
        WHEN v_paid >= v_invoice.total_amount THEN 'paid'
        ELSE 'partial'
      END
  WHERE id = p_invoice_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

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
