/*
  # Fix Products RLS Policies - Allow Warehouse Role

  1. Changes
    - Drop existing restrictive INSERT and UPDATE policies for products
    - Create new policies that allow admin, sales, AND warehouse roles
    - Warehouse staff need to manage products for inventory operations
    
  2. Security
    - Still requires authenticated users
    - Still requires active user profile
    - Expanded from 2 roles (admin, sales) to 3 roles (admin, sales, warehouse)
*/

-- Drop existing restrictive policies
DROP POLICY IF EXISTS "Admin and sales can insert products" ON products;
DROP POLICY IF EXISTS "Admin and sales can update products" ON products;

-- Create new INSERT policy allowing admin, sales, and warehouse
CREATE POLICY "Admin, sales, and warehouse can insert products"
  ON products
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'sales', 'warehouse')
        AND user_profiles.is_active = true
    )
  );

-- Create new UPDATE policy allowing admin, sales, and warehouse
CREATE POLICY "Admin, sales, and warehouse can update products"
  ON products
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'sales', 'warehouse')
        AND user_profiles.is_active = true
    )
  );
