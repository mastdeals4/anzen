/*
  # Add approval_operation_id column to delivery_challans

  1. Modified Tables
    - `delivery_challans`
      - Added `approval_operation_id` (uuid, nullable) - used for idempotent inventory operations during DC approval

  2. Notes
    - This column allows the frontend to pass a unique operation ID when approving a DC
    - The operation ID is used to prevent duplicate inventory transactions on retry
*/

ALTER TABLE public.delivery_challans
  ADD COLUMN IF NOT EXISTS approval_operation_id uuid;
