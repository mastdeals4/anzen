-- Purchase receiving approval is deliberately separate from financial status.
ALTER TABLE public.purchase_invoices
  ADD COLUMN IF NOT EXISTS receiving_approval_status text,
  ADD COLUMN IF NOT EXISTS receiving_submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS receiving_submitted_by uuid REFERENCES public.user_profiles(id),
  ADD COLUMN IF NOT EXISTS receiving_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS receiving_approved_by uuid REFERENCES public.user_profiles(id),
  ADD COLUMN IF NOT EXISTS receiving_rejection_reason text;

DO $$ BEGIN
  ALTER TABLE public.purchase_invoices
    ADD CONSTRAINT purchase_invoices_receiving_approval_status_check
    CHECK (receiving_approval_status IN ('draft','pending_approval','approved','rejected'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.purchase_invoice_items
  ADD COLUMN IF NOT EXISTS receiving_make_id uuid REFERENCES public.product_sources(id),
  ADD COLUMN IF NOT EXISTS receiving_batch_number text,
  ADD COLUMN IF NOT EXISTS receiving_expiry_date date,
  ADD COLUMN IF NOT EXISTS receiving_import_container_id uuid REFERENCES public.import_containers(id),
  ADD COLUMN IF NOT EXISTS receiving_notes text;

CREATE INDEX IF NOT EXISTS idx_purchase_invoices_receiving_approval
  ON public.purchase_invoices(receiving_approval_status);

CREATE TABLE IF NOT EXISTS public.purchase_invoice_inward_rejections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_invoice_id uuid NOT NULL REFERENCES public.purchase_invoices(id) ON DELETE RESTRICT,
  purchase_invoice_item_id uuid NOT NULL REFERENCES public.purchase_invoice_items(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(trim(reason)) > 0),
  rejected_at timestamptz NOT NULL DEFAULT now(),
  rejected_by uuid REFERENCES public.user_profiles(id)
);

ALTER TABLE public.purchase_invoice_inward_rejections ENABLE ROW LEVEL SECURITY;
CREATE POLICY purchase_invoice_inward_rejections_read ON public.purchase_invoice_inward_rejections
  FOR SELECT TO authenticated USING (true);
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.purchase_invoice_inward_rejections FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.submit_purchase_invoice_for_receiving(p_purchase_invoice_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_invoice public.purchase_invoices%ROWTYPE;
BEGIN
  IF NOT public.inventory_v1_actor_allowed(ARRAY['admin','accounts','manager']) THEN RAISE EXCEPTION 'Permission denied'; END IF;
  SELECT * INTO v_invoice FROM public.purchase_invoices WHERE id = p_purchase_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purchase Invoice not found'; END IF;
  IF v_invoice.status = 'cancelled' THEN RAISE EXCEPTION 'Cancelled Purchase Invoice cannot be submitted'; END IF;
  UPDATE public.purchase_invoices SET receiving_approval_status='pending_approval', receiving_submitted_at=now(), receiving_submitted_by=auth.uid(), receiving_rejection_reason=NULL, updated_at=now() WHERE id=p_purchase_invoice_id;
  RETURN jsonb_build_object('success',true,'status','pending_approval');
END; $$;

CREATE OR REPLACE FUNCTION public.approve_purchase_invoice_for_receiving(p_purchase_invoice_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_status text;
BEGIN
  IF NOT public.inventory_v1_actor_allowed(ARRAY['admin','accounts','manager']) THEN RAISE EXCEPTION 'Permission denied'; END IF;
  SELECT receiving_approval_status INTO v_status FROM public.purchase_invoices WHERE id=p_purchase_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purchase Invoice not found'; END IF;
  IF v_status <> 'pending_approval' THEN RAISE EXCEPTION 'Purchase Invoice must be pending approval'; END IF;
  UPDATE public.purchase_invoices SET receiving_approval_status='approved', receiving_approved_at=now(), receiving_approved_by=auth.uid(), updated_at=now() WHERE id=p_purchase_invoice_id;
  RETURN jsonb_build_object('success',true,'status','approved');
END; $$;

CREATE OR REPLACE FUNCTION public.reject_purchase_invoice_inward(p_purchase_invoice_id uuid, p_purchase_invoice_item_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_status text;
BEGIN
  IF NOT public.inventory_v1_actor_allowed(ARRAY['admin','accounts','warehouse','manager']) THEN RAISE EXCEPTION 'Permission denied'; END IF;
  IF p_reason IS NULL OR length(trim(p_reason))=0 THEN RAISE EXCEPTION 'Rejection reason is required'; END IF;
  SELECT receiving_approval_status INTO v_status FROM public.purchase_invoices WHERE id=p_purchase_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purchase Invoice not found'; END IF;
  IF v_status <> 'approved' THEN RAISE EXCEPTION 'Only approved Purchase Invoices can be rejected at inward'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.purchase_invoice_items WHERE id=p_purchase_invoice_item_id AND purchase_invoice_id=p_purchase_invoice_id AND item_type='inventory') THEN
    RAISE EXCEPTION 'Purchase Invoice item does not belong to this invoice';
  END IF;
  INSERT INTO public.purchase_invoice_inward_rejections(purchase_invoice_id,purchase_invoice_item_id,reason,rejected_by) VALUES (p_purchase_invoice_id,p_purchase_invoice_item_id,trim(p_reason),auth.uid());
  UPDATE public.purchase_invoices SET receiving_approval_status='rejected', receiving_rejection_reason=trim(p_reason), updated_at=now() WHERE id=p_purchase_invoice_id;
  RETURN jsonb_build_object('success',true,'status','rejected');
END; $$;

GRANT EXECUTE ON FUNCTION public.submit_purchase_invoice_for_receiving(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_purchase_invoice_for_receiving(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_purchase_invoice_inward(uuid,uuid,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.guard_receiving_requires_approval()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_status text;
BEGIN
  SELECT receiving_approval_status INTO v_status FROM public.purchase_invoices WHERE id=NEW.purchase_invoice_id;
  -- NULL denotes a legacy invoice created before this approval lifecycle;
  -- preserve its existing receiving behavior without backfilling history.
  IF v_status IS NOT NULL AND v_status <> 'approved' THEN
    RAISE EXCEPTION 'Purchase Invoice must be approved for inward before receiving';
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_receiving_requires_purchase_approval ON public.purchase_invoice_receiving_allocations;
CREATE TRIGGER trg_receiving_requires_purchase_approval
  BEFORE INSERT ON public.purchase_invoice_receiving_allocations
  FOR EACH ROW EXECUTE FUNCTION public.guard_receiving_requires_approval();

CREATE OR REPLACE FUNCTION public.reset_receiving_approval_on_invoice_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.receiving_approval_status = 'approved' AND (
    NEW.supplier_id IS DISTINCT FROM OLD.supplier_id OR
    NEW.invoice_date IS DISTINCT FROM OLD.invoice_date OR
    NEW.total_amount IS DISTINCT FROM OLD.total_amount OR
    NEW.currency IS DISTINCT FROM OLD.currency OR
    NEW.document_urls IS DISTINCT FROM OLD.document_urls OR
    NEW.notes IS DISTINCT FROM OLD.notes
  ) THEN
    NEW.receiving_approval_status := 'pending_approval';
    NEW.receiving_rejection_reason := NULL;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_reset_receiving_approval_on_invoice_change ON public.purchase_invoices;
CREATE TRIGGER trg_reset_receiving_approval_on_invoice_change
  BEFORE UPDATE OF supplier_id,invoice_date,total_amount,currency,document_urls,notes
  ON public.purchase_invoices FOR EACH ROW EXECUTE FUNCTION public.reset_receiving_approval_on_invoice_change();

CREATE OR REPLACE FUNCTION public.reset_receiving_approval_on_item_change()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_invoice_id uuid := COALESCE(NEW.purchase_invoice_id, OLD.purchase_invoice_id);
BEGIN
  UPDATE public.purchase_invoices
     SET receiving_approval_status='pending_approval', receiving_rejection_reason=NULL, updated_at=now()
   WHERE id=v_invoice_id AND receiving_approval_status='approved';
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_reset_receiving_approval_on_item_change ON public.purchase_invoice_items;
CREATE TRIGGER trg_reset_receiving_approval_on_item_change
  AFTER INSERT OR UPDATE OR DELETE ON public.purchase_invoice_items
  FOR EACH ROW EXECUTE FUNCTION public.reset_receiving_approval_on_item_change();

-- Preserve the existing accounting save path while persisting optional,
-- pre-inward receiving details carried by invoice items.
CREATE OR REPLACE FUNCTION public.save_purchase_invoice_with_receiving_details(
  p_invoice_id uuid, p_purchase_order_id uuid, p_invoice_data jsonb, p_items jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_result jsonb; v_invoice_id uuid; v_item jsonb; v_ordinal integer := 0; v_item_id uuid;
BEGIN
  v_result := CASE
    WHEN p_invoice_id IS NOT NULL THEN public.save_purchase_invoice(p_invoice_id, p_invoice_data, p_items)
    WHEN p_purchase_order_id IS NOT NULL THEN public.create_purchase_invoice_from_po(p_purchase_order_id, p_invoice_data, p_items)
    ELSE public.save_purchase_invoice(NULL, p_invoice_data, p_items)
  END;
  v_invoice_id := COALESCE(p_invoice_id, (v_result->>'invoice_id')::uuid);
  IF p_invoice_id IS NULL THEN
    UPDATE public.purchase_invoices SET receiving_approval_status='draft' WHERE id=v_invoice_id;
  END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_items,'[]'::jsonb)) LOOP
    v_ordinal := v_ordinal + 1;
    SELECT id INTO v_item_id FROM public.purchase_invoice_items
      WHERE purchase_invoice_id=v_invoice_id ORDER BY ctid OFFSET v_ordinal-1 LIMIT 1;
    IF v_item_id IS NOT NULL THEN
      IF NULLIF(v_item->>'receiving_make_id','') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.product_sources ps WHERE ps.id=(v_item->>'receiving_make_id')::uuid
          AND ps.product_id=NULLIF(v_item->>'product_id','')::uuid
      ) THEN RAISE EXCEPTION 'Receiving Make does not belong to invoice Product'; END IF;
      UPDATE public.purchase_invoice_items SET
        receiving_make_id=NULLIF(v_item->>'receiving_make_id','')::uuid,
        receiving_batch_number=NULLIF(v_item->>'receiving_batch_number',''),
        receiving_expiry_date=NULLIF(v_item->>'receiving_expiry_date','')::date,
        receiving_import_container_id=NULLIF(v_item->>'receiving_import_container_id','')::uuid,
        receiving_notes=NULLIF(v_item->>'receiving_notes','')
      WHERE id=v_item_id;
    END IF;
  END LOOP;
  RETURN v_result;
END; $$;
GRANT EXECUTE ON FUNCTION public.save_purchase_invoice_with_receiving_details(uuid,uuid,jsonb,jsonb) TO authenticated;
