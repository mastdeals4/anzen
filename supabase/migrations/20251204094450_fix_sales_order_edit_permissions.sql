/*
  # Fix Sales Order Edit Permissions

  1. Changes
    - Update RLS policy to allow users to edit their own sales orders even after approval
    - Allow editing of orders in status: draft, rejected, approved, stock_reserved, shortage, pending_approval
    - Block editing of orders in final states: delivered, closed, cancelled, partially_delivered, pending_delivery

  2. Security
    - Users can only edit their own orders
    - Admins and sales can edit all orders
    - Orders in final delivery states cannot be edited by regular users
*/

-- Drop old restrictive policy
DROP POLICY IF EXISTS "Users can update own draft sales orders" ON sales_orders;

-- Create new policy that allows editing of non-final orders
CREATE POLICY "Users can update own non-final sales orders"
  ON sales_orders FOR UPDATE
  TO authenticated
  USING (
    created_by = auth.uid()
    AND status NOT IN ('delivered', 'closed', 'cancelled', 'partially_delivered', 'pending_delivery')
  )
  WITH CHECK (created_by = auth.uid());
