/*
  # Fix Security Issues - Part 2: RLS Policy Optimization (Fixed)
  
  1. RLS Policy Optimization (10 policies)
    - Replace `auth.uid()` with `(select auth.uid())` 
    - Prevents re-evaluation for each row, improving performance
    - Fixed column names: status (not approval_status)
*/

-- crm_reminders: Users can view their reminders
DROP POLICY IF EXISTS "Users can view their reminders" ON public.crm_reminders;
CREATE POLICY "Users can view their reminders"
  ON public.crm_reminders
  FOR SELECT
  TO authenticated
  USING (assigned_to = (select auth.uid()));

-- sales_orders: Admins and sales can update all sales orders
DROP POLICY IF EXISTS "Admins and sales can update all sales orders" ON public.sales_orders;
CREATE POLICY "Admins and sales can update all sales orders"
  ON public.sales_orders
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE id = (select auth.uid())
      AND role IN ('admin', 'sales')
    )
  );

-- sales_orders: Users can create sales orders
DROP POLICY IF EXISTS "Users can create sales orders" ON public.sales_orders;
CREATE POLICY "Users can create sales orders"
  ON public.sales_orders
  FOR INSERT
  TO authenticated
  WITH CHECK (created_by = (select auth.uid()));

-- sales_orders: Users can delete own draft sales orders
DROP POLICY IF EXISTS "Users can delete own draft sales orders" ON public.sales_orders;
CREATE POLICY "Users can delete own draft sales orders"
  ON public.sales_orders
  FOR DELETE
  TO authenticated
  USING (created_by = (select auth.uid()) AND status = 'draft');

-- sales_orders: Users can update own draft sales orders
DROP POLICY IF EXISTS "Users can update own draft sales orders" ON public.sales_orders;
CREATE POLICY "Users can update own draft sales orders"
  ON public.sales_orders
  FOR UPDATE
  TO authenticated
  USING (created_by = (select auth.uid()) AND status = 'draft');

-- sales_order_items: Users can manage sales order items
DROP POLICY IF EXISTS "Users can manage sales order items" ON public.sales_order_items;
CREATE POLICY "Users can manage sales order items"
  ON public.sales_order_items
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.sales_orders
      WHERE sales_orders.id = sales_order_items.sales_order_id
      AND (
        sales_orders.created_by = (select auth.uid())
        OR EXISTS (
          SELECT 1 FROM public.user_profiles
          WHERE id = (select auth.uid())
          AND role IN ('admin', 'sales')
        )
      )
    )
  );

-- import_requirements: Admins can manage import requirements
DROP POLICY IF EXISTS "Admins can manage import requirements" ON public.import_requirements;
CREATE POLICY "Admins can manage import requirements"
  ON public.import_requirements
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE id = (select auth.uid())
      AND role = 'admin'
    )
  );

-- invoice_payment_allocations: Admins and accounts can insert
DROP POLICY IF EXISTS "Admins and accounts can insert invoice payment allocations" ON public.invoice_payment_allocations;
CREATE POLICY "Admins and accounts can insert invoice payment allocations"
  ON public.invoice_payment_allocations
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE id = (select auth.uid())
      AND role IN ('admin', 'accounts')
    )
  );

-- invoice_payment_allocations: Admins and accounts can update
DROP POLICY IF EXISTS "Admins and accounts can update invoice payment allocations" ON public.invoice_payment_allocations;
CREATE POLICY "Admins and accounts can update invoice payment allocations"
  ON public.invoice_payment_allocations
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE id = (select auth.uid())
      AND role IN ('admin', 'accounts')
    )
  );

-- invoice_payment_allocations: Admins can delete
DROP POLICY IF EXISTS "Admins can delete invoice payment allocations" ON public.invoice_payment_allocations;
CREATE POLICY "Admins can delete invoice payment allocations"
  ON public.invoice_payment_allocations
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE id = (select auth.uid())
      AND role = 'admin'
    )
  );
