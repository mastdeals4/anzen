/*
  # Fix Security Issues - Part 1: Indexes
  
  1. Missing Foreign Key Indexes (9 issues)
    - Add indexes for foreign keys to improve JOIN performance
    - Covers: approved_by, rejected_by, archived_by, released_by, reserved_by, customer_id, created_by, sales_order_item_id
  
  2. Duplicate Index Removal
    - Remove idx_delivery_challans_so_id (duplicate of idx_delivery_challans_sales_order)
*/

-- Add missing foreign key indexes
CREATE INDEX IF NOT EXISTS idx_delivery_challans_approved_by 
  ON public.delivery_challans(approved_by);

CREATE INDEX IF NOT EXISTS idx_delivery_challans_rejected_by 
  ON public.delivery_challans(rejected_by);

CREATE INDEX IF NOT EXISTS idx_import_requirements_customer_id 
  ON public.import_requirements(customer_id);

CREATE INDEX IF NOT EXISTS idx_invoice_payment_allocations_created_by 
  ON public.invoice_payment_allocations(created_by);

CREATE INDEX IF NOT EXISTS idx_sales_orders_archived_by 
  ON public.sales_orders(archived_by);

CREATE INDEX IF NOT EXISTS idx_sales_orders_rejected_by 
  ON public.sales_orders(rejected_by);

CREATE INDEX IF NOT EXISTS idx_stock_reservations_released_by 
  ON public.stock_reservations(released_by);

CREATE INDEX IF NOT EXISTS idx_stock_reservations_reserved_by 
  ON public.stock_reservations(reserved_by);

CREATE INDEX IF NOT EXISTS idx_stock_reservations_sales_order_item_id 
  ON public.stock_reservations(sales_order_item_id);

-- Remove duplicate index
DROP INDEX IF EXISTS public.idx_delivery_challans_so_id;
