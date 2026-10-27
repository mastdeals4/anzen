-- Migration: Credit Note Material Return Linkage & Idempotency Guard
-- Purpose: Link credit_notes to material_returns, enforce single CN per return, and prevent double-restock

-- 1. Add material_return_id to credit_notes if not exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'credit_notes' AND column_name = 'material_return_id'
  ) THEN
    ALTER TABLE public.credit_notes ADD COLUMN material_return_id uuid REFERENCES public.material_returns(id) ON DELETE SET NULL;
  ELSE
    ALTER TABLE public.credit_notes 
      DROP CONSTRAINT IF EXISTS credit_notes_material_return_id_fkey,
      ADD CONSTRAINT credit_notes_material_return_id_fkey 
        FOREIGN KEY (material_return_id) REFERENCES public.material_returns(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 2. Enforce 1 Credit Note per Material Return via partial unique index
CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_notes_material_return_id 
ON public.credit_notes(material_return_id) 
WHERE material_return_id IS NOT NULL;

-- 3. Update trg_credit_note_inventory_v1 to prevent double-restock if return already restocked
CREATE OR REPLACE FUNCTION public.trg_credit_note_inventory_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item record;
  v_already_restocked boolean := false;
BEGIN
  -- If linked to a material return that already posted an inventory restock, avoid double-restocking
  IF NEW.material_return_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.inventory_transactions
      WHERE reference_type = 'material_return'
        AND reference_id = NEW.material_return_id
        AND transaction_type = 'return'
    ) INTO v_already_restocked;
  END IF;

  IF NEW.status = 'approved' AND OLD.status IS DISTINCT FROM 'approved' THEN
    IF EXISTS (
      SELECT 1
      FROM public.inventory_transactions
      WHERE reference_type = 'credit_note_reversal'
        AND reference_id = NEW.id
        AND metadata->>'canonical_engine_version' = '1.0'
    ) THEN
      RAISE EXCEPTION 'Reversed Credit Note cannot be re-approved; create a new Credit Note';
    END IF;

    -- Only perform inventory restock if not already restocked via material return trigger
    IF NOT v_already_restocked THEN
      FOR v_item IN
        SELECT *
        FROM public.credit_note_items
        WHERE credit_note_id = NEW.id
        ORDER BY id
      LOOP
        PERFORM public.post_inventory_movement(
          public.uuid_from_text('inventory-v1:credit-note:' || NEW.id || ':' || v_item.id),
          v_item.product_id,
          v_item.batch_id,
          'return',
          v_item.quantity,
          NEW.credit_note_date,
          NEW.credit_note_number,
          'credit_note',
          NEW.id,
          'Canonical Credit Note return: ' || NEW.credit_note_number,
          NEW.approved_by,
          NULL,
          NULL
        );
      END LOOP;
    END IF;

  ELSIF OLD.status = 'approved' AND NEW.status IS DISTINCT FROM 'approved' THEN
    IF NOT v_already_restocked THEN
      FOR v_item IN
        SELECT *
        FROM public.credit_note_items
        WHERE credit_note_id = NEW.id
        ORDER BY id
      LOOP
        PERFORM public.post_inventory_movement(
          public.uuid_from_text(
            'inventory-v1:credit-note-reversal:' || NEW.id || ':' || v_item.id
          ),
          v_item.product_id,
          v_item.batch_id,
          'adjustment',
          -v_item.quantity,
          CURRENT_DATE,
          NEW.credit_note_number,
          'credit_note_reversal',
          NEW.id,
          'Canonical Credit Note reversal: ' || NEW.credit_note_number,
          COALESCE(NEW.approved_by, auth.uid()),
          NULL,
          NULL
        );
      END LOOP;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
