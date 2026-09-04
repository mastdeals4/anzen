/* Permanent master-data and Sales Order -> Delivery Challan guards.
   Existing legacy rows are preserved; source identity is mandatory only for
   new/edited SO-linked items. */
BEGIN;

CREATE OR REPLACE FUNCTION public.normalize_customer_identity(p_value text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT regexp_replace(lower(trim(COALESCE(p_value,''))), '[^a-z0-9]+', '', 'g');
$$;

CREATE OR REPLACE FUNCTION public.normalize_customer_tax_id(p_value text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT regexp_replace(COALESCE(p_value,''), '[^0-9]+', '', 'g');
$$;

CREATE OR REPLACE FUNCTION public.prevent_active_customer_identity_duplicate()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_id text;
BEGIN
  IF COALESCE(NEW.is_active,true) THEN
    IF public.normalize_customer_identity(NEW.company_name) <> '' AND EXISTS (
      SELECT 1 FROM public.customers c WHERE c.id<>NEW.id AND COALESCE(c.is_active,true)
        AND public.normalize_customer_identity(c.company_name)=public.normalize_customer_identity(NEW.company_name)
    ) THEN RAISE EXCEPTION 'Possible existing customer found: exact normalized legal name already exists' USING ERRCODE='unique_violation'; END IF;
    v_id:=public.normalize_customer_tax_id(NEW.npwp);
    IF v_id<>'' AND EXISTS (
      SELECT 1 FROM public.customers c WHERE c.id<>NEW.id AND COALESCE(c.is_active,true)
        AND public.normalize_customer_tax_id(c.npwp)=v_id
    ) THEN RAISE EXCEPTION 'Possible existing customer found: NPWP/tax ID already exists' USING ERRCODE='unique_violation'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_prevent_active_customer_identity_duplicate ON public.customers;
CREATE TRIGGER trg_prevent_active_customer_identity_duplicate
BEFORE INSERT OR UPDATE OF company_name,npwp,is_active ON public.customers
FOR EACH ROW EXECUTE FUNCTION public.prevent_active_customer_identity_duplicate();

CREATE UNIQUE INDEX IF NOT EXISTS uq_active_customer_normalized_name
  ON public.customers (public.normalize_customer_identity(company_name))
  WHERE COALESCE(is_active,true) AND public.normalize_customer_identity(company_name)<>'';
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_customer_normalized_npwp
  ON public.customers (public.normalize_customer_tax_id(npwp))
  WHERE COALESCE(is_active,true) AND public.normalize_customer_tax_id(npwp)<>'';

ALTER TABLE public.delivery_challan_items
  ADD COLUMN IF NOT EXISTS sales_order_item_id uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='delivery_challan_items_sales_order_item_id_fkey') THEN
    ALTER TABLE public.delivery_challan_items ADD CONSTRAINT delivery_challan_items_sales_order_item_id_fkey
      FOREIGN KEY (sales_order_item_id) REFERENCES public.sales_order_items(id) ON DELETE RESTRICT;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_delivery_challan_items_sales_order_item ON public.delivery_challan_items(sales_order_item_id);

CREATE OR REPLACE FUNCTION public.validate_delivery_challan_source_item()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_dc public.delivery_challans%rowtype; v_soi public.sales_order_items%rowtype; v_remaining numeric;
BEGIN
  SELECT * INTO v_dc FROM public.delivery_challans WHERE id=NEW.challan_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Delivery Challan does not exist'; END IF;
  IF v_dc.sales_order_id IS NULL THEN
    IF NEW.sales_order_item_id IS NOT NULL THEN RAISE EXCEPTION 'Unlinked Delivery Challan cannot reference a Sales Order item'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.sales_order_item_id IS NULL THEN
    SELECT soi.id INTO NEW.sales_order_item_id
    FROM public.sales_order_items soi
    WHERE soi.sales_order_id=v_dc.sales_order_id AND soi.product_id=NEW.product_id;
    IF NEW.sales_order_item_id IS NULL THEN RAISE EXCEPTION 'Delivery Challan product is not present on the selected Sales Order'; END IF;
    IF (SELECT count(*) FROM public.sales_order_items soi WHERE soi.sales_order_id=v_dc.sales_order_id AND soi.product_id=NEW.product_id) > 1 THEN
      RAISE EXCEPTION 'Delivery Challan item source is ambiguous; select the exact Sales Order item';
    END IF;
  END IF;
  IF NEW.sales_order_item_id IS NULL THEN RAISE EXCEPTION 'Sales Order-linked Delivery Challan item requires sales_order_item_id'; END IF;
  SELECT * INTO v_soi FROM public.sales_order_items WHERE id=NEW.sales_order_item_id AND sales_order_id=v_dc.sales_order_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Delivery Challan item is not from the selected Sales Order'; END IF;
  IF NEW.product_id IS DISTINCT FROM v_soi.product_id THEN RAISE EXCEPTION 'Delivery Challan product must match the Sales Order item'; END IF;
  v_remaining:=v_soi.quantity-COALESCE(v_soi.delivered_quantity,0);
  IF TG_OP='UPDATE' THEN v_remaining:=v_remaining+COALESCE(OLD.quantity,0); END IF;
  IF NEW.quantity<=0 OR NEW.quantity>v_remaining+0.0001 THEN RAISE EXCEPTION 'Delivery quantity exceeds remaining Sales Order quantity'; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_validate_delivery_challan_source_item ON public.delivery_challan_items;
CREATE TRIGGER trg_validate_delivery_challan_source_item
BEFORE INSERT OR UPDATE OF challan_id,product_id,quantity,sales_order_item_id ON public.delivery_challan_items
FOR EACH ROW EXECUTE FUNCTION public.validate_delivery_challan_source_item();

CREATE OR REPLACE FUNCTION public.validate_delivery_challan_complete_source()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.sales_order_id IS NOT NULL AND NEW.customer_id IS DISTINCT FROM (SELECT customer_id FROM public.sales_orders WHERE id=NEW.sales_order_id) THEN
    RAISE EXCEPTION 'Delivery Challan customer must match Sales Order customer';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_validate_delivery_challan_complete_source ON public.delivery_challans;
CREATE TRIGGER trg_validate_delivery_challan_complete_source
BEFORE INSERT OR UPDATE OF sales_order_id,customer_id ON public.delivery_challans
FOR EACH ROW EXECUTE FUNCTION public.validate_delivery_challan_complete_source();

COMMENT ON COLUMN public.delivery_challan_items.sales_order_item_id IS 'Authoritative Sales Order source item for SO-created Delivery Challans; null only for retained legacy unlinked rows.';
NOTIFY pgrst,'reload schema';
COMMIT;
