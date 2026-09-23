-- Migration: 20260923110000_credit_note_inventory_ownership_guard.sql
-- Purpose: Enforce strict Inventory Ownership: Material Return is the SOLE authoritative
-- physical inventory owner. Any Credit Note with material_return_id IS NOT NULL MUST NOT
-- create or reverse any physical inventory movement under any circumstances (regardless of order of approval).
-- Standalone Credit Notes (material_return_id IS NULL) retain standard inventory behavior.

CREATE OR REPLACE FUNCTION public.trg_credit_note_inventory_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_item record;
BEGIN
  -- Authoritative inventory ownership rule:
  -- For ANY Credit Note with material_return_id IS NOT NULL:
  -- The Material Return is the SOLE authoritative physical inventory owner (Material Return -> Inventory V1 -> stock movement).
  -- A Credit Note linked to a return produces financial effects only (AR reduction, Revenue reversal, Output PPN, COGS JE).
  -- It MUST NEVER create or reverse physical inventory movements.
  IF COALESCE(NEW.material_return_id, OLD.material_return_id) IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- ── Standalone Credit Notes (NO material_return_id) ──
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

  ELSIF OLD.status = 'approved' AND NEW.status IS DISTINCT FROM 'approved' THEN
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

  RETURN NEW;
END;
$function$;
