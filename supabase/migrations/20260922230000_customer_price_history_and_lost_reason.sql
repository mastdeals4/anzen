-- Migration: Add lost_reason_code and get_customer_product_price_history RPC
-- Purpose: Support structured CRM lost reasons and customer price history retrieval

-- 1. Add lost_reason_code to crm_inquiries if not exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'crm_inquiries' AND column_name = 'lost_reason_code'
  ) THEN
    ALTER TABLE public.crm_inquiries ADD COLUMN lost_reason_code text;
  END IF;
END $$;

-- 2. Create RPC get_customer_product_price_history
CREATE OR REPLACE FUNCTION public.get_customer_product_price_history(
  p_customer_id uuid,
  p_product_id uuid
)
RETURNS TABLE (
  history_type text,
  ref_type text,
  ref_number text,
  ref_id uuid,
  doc_date date,
  currency text,
  unit_price numeric,
  quantity numeric,
  customer_name text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- 1. Customer-specific sales orders (up to 5 most recent)
  IF p_customer_id IS NOT NULL THEN
    RETURN QUERY
    SELECT 
      'customer'::text AS history_type,
      'Sales Order'::text AS ref_type,
      so.so_number::text AS ref_number,
      so.id AS ref_id,
      so.so_date AS doc_date,
      so.currency::text AS currency,
      soi.unit_price AS unit_price,
      soi.quantity AS quantity,
      c.company_name::text AS customer_name
    FROM public.sales_order_items soi
    JOIN public.sales_orders so ON so.id = soi.sales_order_id
    JOIN public.customers c ON c.id = so.customer_id
    WHERE so.customer_id = p_customer_id
      AND soi.product_id = p_product_id
    ORDER BY so.so_date DESC, so.created_at DESC
    LIMIT 5;

    -- Also check customer-specific sales invoices
    RETURN QUERY
    SELECT 
      'customer'::text AS history_type,
      'Sales Invoice'::text AS ref_type,
      si.invoice_number::text AS ref_number,
      si.id AS ref_id,
      si.invoice_date AS doc_date,
      si.currency::text AS currency,
      sii.unit_price AS unit_price,
      sii.quantity AS quantity,
      c.company_name::text AS customer_name
    FROM public.sales_invoice_items sii
    JOIN public.sales_invoices si ON si.id = sii.sales_invoice_id
    JOIN public.customers c ON c.id = si.customer_id
    WHERE si.customer_id = p_customer_id
      AND sii.product_id = p_product_id
      -- Exclude if already shown by linked sales order
      AND NOT EXISTS (
        SELECT 1 FROM public.sales_order_items x_soi
        JOIN public.sales_orders x_so ON x_so.id = x_soi.sales_order_id
        WHERE x_so.id = si.sales_order_id AND x_soi.product_id = p_product_id
      )
    ORDER BY si.invoice_date DESC, si.created_at DESC
    LIMIT 5;
  END IF;

  -- 2. General market benchmark / rate card (latest sales to any customer for this product)
  RETURN QUERY
  SELECT 
    'benchmark'::text AS history_type,
    'Sales Order (Benchmark)'::text AS ref_type,
    so.so_number::text AS ref_number,
    so.id AS ref_id,
    so.so_date AS doc_date,
    so.currency::text AS currency,
    soi.unit_price AS unit_price,
    soi.quantity AS quantity,
    c.company_name::text AS customer_name
  FROM public.sales_order_items soi
  JOIN public.sales_orders so ON so.id = soi.sales_order_id
  JOIN public.customers c ON c.id = so.customer_id
  WHERE (p_customer_id IS NULL OR so.customer_id != p_customer_id)
    AND soi.product_id = p_product_id
  ORDER BY so.so_date DESC, so.created_at DESC
  LIMIT 5;
END;
$$;
