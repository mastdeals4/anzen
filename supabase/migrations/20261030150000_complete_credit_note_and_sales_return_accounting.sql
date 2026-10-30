-- Migration: 20261030150000_complete_credit_note_and_sales_return_accounting.sql
-- Description: Complete Credit Note & Sales Return operational, inventory, financial, tax, and ledger integration
--              supporting the 9 canonical business cases, Goods Inward / disposition tracking, exact FIFO COGS reversal,
--              customer credit balances, future invoice allocation, refund handling, and Coretax Nota Retur integration.

BEGIN;

-- ==============================================================================
-- 1. Chart of Accounts Support for Inventory Loss and Customer Credit
-- ==============================================================================

INSERT INTO public.chart_of_accounts (code, name, account_type)
VALUES 
  ('4300', 'Sales Returns & Allowances', 'revenue'),
  ('2130', 'Output PPN Payable', 'liability'),
  ('5190', 'Inventory Impairment & Damage Loss', 'expense'),
  ('2140', 'Customer Credit & Advances', 'liability')
ON CONFLICT (code) DO NOTHING;

-- ==============================================================================
-- 2. Schema Extensions: credit_notes
-- ==============================================================================

DO $$
BEGIN
  -- Canonical invoice link
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'credit_notes' AND column_name = 'original_invoice_id'
  ) THEN
    ALTER TABLE public.credit_notes 
      ADD COLUMN original_invoice_id uuid REFERENCES public.sales_invoices(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'credit_notes' AND column_name = 'sales_invoice_id'
  ) THEN
    ALTER TABLE public.credit_notes 
      ADD COLUMN sales_invoice_id uuid REFERENCES public.sales_invoices(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'credit_notes' AND column_name = 'credit_note_type'
  ) THEN
    ALTER TABLE public.credit_notes 
      ADD COLUMN credit_note_type text DEFAULT 'physical_return';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'credit_notes' AND column_name = 'material_return_id'
  ) THEN
    ALTER TABLE public.credit_notes 
      ADD COLUMN material_return_id uuid REFERENCES public.material_returns(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'credit_notes' AND column_name = 'journal_entry_id'
  ) THEN
    ALTER TABLE public.credit_notes 
      ADD COLUMN journal_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'credit_notes' AND column_name = 'created_by'
  ) THEN
    ALTER TABLE public.credit_notes 
      ADD COLUMN created_by uuid;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'credit_notes' AND column_name = 'approved_by'
  ) THEN
    ALTER TABLE public.credit_notes 
      ADD COLUMN approved_by uuid;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'credit_notes' AND column_name = 'approval_date'
  ) THEN
    ALTER TABLE public.credit_notes 
      ADD COLUMN approval_date timestamptz;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'credit_notes' AND column_name = 'nota_retur_id'
  ) THEN
    ALTER TABLE public.credit_notes 
      ADD COLUMN nota_retur_id uuid REFERENCES public.nota_retur(id) ON DELETE SET NULL;
  END IF;

  -- Business Case classification (supporting all 9 cases)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'credit_notes' AND column_name = 'business_case'
  ) THEN
    ALTER TABLE public.credit_notes 
      ADD COLUMN business_case text DEFAULT 'full_physical_return';
  END IF;

  -- Stock disposition
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'credit_notes' AND column_name = 'stock_disposition'
  ) THEN
    ALTER TABLE public.credit_notes 
      ADD COLUMN stock_disposition text DEFAULT 'saleable';
  END IF;

  -- Warehouse / Godown
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'credit_notes' AND column_name = 'warehouse_id'
  ) THEN
    ALTER TABLE public.credit_notes 
      ADD COLUMN warehouse_id uuid;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'credit_notes' AND column_name = 'godown'
  ) THEN
    ALTER TABLE public.credit_notes 
      ADD COLUMN godown text DEFAULT 'Main Warehouse';
  END IF;

  -- Inspection & Receiving Tracking
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'credit_notes' AND column_name = 'inspection_status'
  ) THEN
    ALTER TABLE public.credit_notes 
      ADD COLUMN inspection_status text DEFAULT 'inspected';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'credit_notes' AND column_name = 'inspected_by'
  ) THEN
    ALTER TABLE public.credit_notes 
      ADD COLUMN inspected_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'credit_notes' AND column_name = 'inspected_at'
  ) THEN
    ALTER TABLE public.credit_notes 
      ADD COLUMN inspected_at timestamptz;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'credit_notes' AND column_name = 'received_by'
  ) THEN
    ALTER TABLE public.credit_notes 
      ADD COLUMN received_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'credit_notes' AND column_name = 'received_at'
  ) THEN
    ALTER TABLE public.credit_notes 
      ADD COLUMN received_at timestamptz;
  END IF;

  -- Quantity breakdown rollups
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'credit_notes' AND column_name = 'accepted_quantity'
  ) THEN
    ALTER TABLE public.credit_notes 
      ADD COLUMN accepted_quantity numeric(12,3) DEFAULT 0;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'credit_notes' AND column_name = 'damaged_quantity'
  ) THEN
    ALTER TABLE public.credit_notes 
      ADD COLUMN damaged_quantity numeric(12,3) DEFAULT 0;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'credit_notes' AND column_name = 'rejected_quantity'
  ) THEN
    ALTER TABLE public.credit_notes 
      ADD COLUMN rejected_quantity numeric(12,3) DEFAULT 0;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'credit_notes' AND column_name = 'quarantined_quantity'
  ) THEN
    ALTER TABLE public.credit_notes 
      ADD COLUMN quarantined_quantity numeric(12,3) DEFAULT 0;
  END IF;

  -- Customer Credit Balance & Future Invoice / Refund Allocation
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'credit_notes' AND column_name = 'customer_credit_balance'
  ) THEN
    ALTER TABLE public.credit_notes 
      ADD COLUMN customer_credit_balance numeric(15,2) DEFAULT 0;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'credit_notes' AND column_name = 'settlement_status'
  ) THEN
    ALTER TABLE public.credit_notes 
      ADD COLUMN settlement_status text DEFAULT 'offset_original';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'credit_notes' AND column_name = 'applied_to_invoice_id'
  ) THEN
    ALTER TABLE public.credit_notes 
      ADD COLUMN applied_to_invoice_id uuid REFERENCES public.sales_invoices(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'credit_notes' AND column_name = 'applied_amount'
  ) THEN
    ALTER TABLE public.credit_notes 
      ADD COLUMN applied_amount numeric(15,2) DEFAULT 0;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'credit_notes' AND column_name = 'refund_amount'
  ) THEN
    ALTER TABLE public.credit_notes 
      ADD COLUMN refund_amount numeric(15,2) DEFAULT 0;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'credit_notes' AND column_name = 'refund_date'
  ) THEN
    ALTER TABLE public.credit_notes 
      ADD COLUMN refund_date date;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'credit_notes' AND column_name = 'refund_payment_voucher_id'
  ) THEN
    ALTER TABLE public.credit_notes 
      ADD COLUMN refund_payment_voucher_id uuid;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'credit_notes' AND column_name = 'goods_return_receipt_id'
  ) THEN
    ALTER TABLE public.credit_notes 
      ADD COLUMN goods_return_receipt_id uuid REFERENCES public.material_returns(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Add or update check constraints safely
DO $$
BEGIN
  ALTER TABLE public.credit_notes 
    DROP CONSTRAINT IF EXISTS chk_credit_note_business_case,
    ADD CONSTRAINT chk_credit_note_business_case 
      CHECK (business_case IN (
        'full_physical_return',
        'partial_physical_return',
        'damaged_packaging',
        'damaged_product',
        'quality_rejection',
        'price_adjustment',
        'post_invoice_discount',
        'customer_refund',
        'future_credit_adjustment'
      ));

  ALTER TABLE public.credit_notes 
    DROP CONSTRAINT IF EXISTS chk_credit_note_stock_disposition,
    ADD CONSTRAINT chk_credit_note_stock_disposition 
      CHECK (stock_disposition IN ('saleable', 'quarantine', 'damaged', 'scrap', 'rejected'));

  ALTER TABLE public.credit_notes 
    DROP CONSTRAINT IF EXISTS chk_credit_note_settlement_status,
    ADD CONSTRAINT chk_credit_note_settlement_status 
      CHECK (settlement_status IN ('offset_original', 'unsettled', 'applied_to_invoice', 'partially_allocated', 'refunded'));
EXCEPTION
  WHEN OTHERS THEN NULL;
END $$;

-- ==============================================================================
-- 3. Schema Extensions: credit_note_items
-- ==============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'credit_note_items' AND column_name = 'sales_invoice_item_id'
  ) THEN
    ALTER TABLE public.credit_note_items 
      ADD COLUMN sales_invoice_item_id uuid REFERENCES public.sales_invoice_items(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'credit_note_items' AND column_name = 'delivery_challan_item_id'
  ) THEN
    ALTER TABLE public.credit_note_items 
      ADD COLUMN delivery_challan_item_id uuid REFERENCES public.delivery_challan_items(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'credit_note_items' AND column_name = 'condition'
  ) THEN
    ALTER TABLE public.credit_note_items 
      ADD COLUMN condition text DEFAULT 'good';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'credit_note_items' AND column_name = 'disposition'
  ) THEN
    ALTER TABLE public.credit_note_items 
      ADD COLUMN disposition text DEFAULT 'saleable';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'credit_note_items' AND column_name = 'accepted_quantity'
  ) THEN
    ALTER TABLE public.credit_note_items 
      ADD COLUMN accepted_quantity numeric(12,3) DEFAULT 0;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'credit_note_items' AND column_name = 'damaged_quantity'
  ) THEN
    ALTER TABLE public.credit_note_items 
      ADD COLUMN damaged_quantity numeric(12,3) DEFAULT 0;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'credit_note_items' AND column_name = 'rejected_quantity'
  ) THEN
    ALTER TABLE public.credit_note_items 
      ADD COLUMN rejected_quantity numeric(12,3) DEFAULT 0;
  END IF;
END $$;

DO $$
BEGIN
  ALTER TABLE public.credit_note_items 
    DROP CONSTRAINT IF EXISTS chk_cni_condition,
    ADD CONSTRAINT chk_cni_condition 
      CHECK (condition IN ('good', 'damaged_packaging', 'damaged_product', 'expired', 'rejected'));

  ALTER TABLE public.credit_note_items 
    DROP CONSTRAINT IF EXISTS chk_cni_disposition,
    ADD CONSTRAINT chk_cni_disposition 
      CHECK (disposition IN ('saleable', 'quarantine', 'damaged', 'scrap', 'rejected'));
EXCEPTION
  WHEN OTHERS THEN NULL;
END $$;

-- ==============================================================================
-- 4. Quantity and Original Invoice Validation Trigger Guard
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.trg_validate_credit_note_integrity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inv public.sales_invoices%ROWTYPE;
  v_already_credited numeric(15,2);
  v_item record;
  v_orig_item public.sales_invoice_items%ROWTYPE;
  v_already_returned_qty numeric(12,3);
BEGIN
  -- If linked to an original invoice, validate invoice lifecycle and returnable limits
  IF NEW.original_invoice_id IS NOT NULL THEN
    SELECT * INTO v_inv
    FROM public.sales_invoices
    WHERE id = NEW.original_invoice_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Original Sales Invoice % does not exist', NEW.original_invoice_id;
    END IF;

    -- Cannot issue credit note against cancelled or draft sales invoices
    IF NOT public.is_reportable_sales_invoice(v_inv.document_status, v_inv.is_draft, v_inv.notes) THEN
      RAISE EXCEPTION 'Cannot issue Credit Note against cancelled or draft invoice %', v_inv.invoice_number;
    END IF;

    -- Validate eligible total amount across all active credit notes for this invoice
    SELECT COALESCE(SUM(total_amount), 0)
    INTO v_already_credited
    FROM public.credit_notes
    WHERE original_invoice_id = NEW.original_invoice_id
      AND status <> 'rejected'
      AND id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid);

    IF (v_already_credited + COALESCE(NEW.total_amount, 0)) > (v_inv.total_amount + 0.05) THEN
      RAISE EXCEPTION 'Credit Note amount % exceeds remaining eligible invoice total % (Invoice total %, already credited %)',
        NEW.total_amount, (v_inv.total_amount - v_already_credited), v_inv.total_amount, v_already_credited;
    END IF;
  END IF;

  -- Ensure credit_note_type matches business case
  IF NEW.business_case IN ('price_adjustment', 'post_invoice_discount', 'customer_refund', 'future_credit_adjustment') THEN
    NEW.credit_note_type := 'commercial_credit';
  ELSE
    NEW.credit_note_type := 'physical_return';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_credit_note_header_integrity ON public.credit_notes;
CREATE TRIGGER trg_validate_credit_note_header_integrity
  BEFORE INSERT OR UPDATE OF original_invoice_id, total_amount, business_case, credit_note_type
  ON public.credit_notes
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_validate_credit_note_integrity();

-- Item-level quantity guard trigger
CREATE OR REPLACE FUNCTION public.trg_validate_credit_note_item_quantities()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_cn public.credit_notes%ROWTYPE;
  v_sii public.sales_invoice_items%ROWTYPE;
  v_already_returned_qty numeric(12,3);
  v_eligible_qty numeric(12,3);
BEGIN
  SELECT * INTO v_cn FROM public.credit_notes WHERE id = NEW.credit_note_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  IF NEW.quantity <= 0 THEN
    RAISE EXCEPTION 'Credit note item quantity must be greater than zero (received %)', NEW.quantity;
  END IF;

  -- If credit note is commercial/price-only, items should not move physical stock
  IF v_cn.credit_note_type = 'commercial_credit' THEN
    NEW.disposition := 'rejected'; -- ensures no inventory movement is generated
  END IF;

  -- If original invoice exists, validate return quantities against invoice line
  IF v_cn.original_invoice_id IS NOT NULL THEN
    -- Match by sales_invoice_item_id or (product_id, batch_id)
    IF NEW.sales_invoice_item_id IS NOT NULL THEN
      SELECT * INTO v_sii FROM public.sales_invoice_items WHERE id = NEW.sales_invoice_item_id;
    ELSE
      SELECT * INTO v_sii 
      FROM public.sales_invoice_items 
      WHERE invoice_id = v_cn.original_invoice_id
        AND product_id = NEW.product_id
        AND (batch_id IS NOT DISTINCT FROM NEW.batch_id OR NEW.batch_id IS NULL)
      ORDER BY quantity DESC
      LIMIT 1;
    END IF;

    IF v_sii.id IS NOT NULL THEN
      NEW.sales_invoice_item_id := v_sii.id;
      IF NEW.delivery_challan_item_id IS NULL THEN
        NEW.delivery_challan_item_id := v_sii.delivery_challan_item_id;
      END IF;

      -- Calculate quantity already returned by other approved or active credit notes on this line
      SELECT COALESCE(SUM(cni.quantity), 0)
      INTO v_already_returned_qty
      FROM public.credit_note_items cni
      JOIN public.credit_notes cn ON cn.id = cni.credit_note_id
      WHERE cn.original_invoice_id = v_cn.original_invoice_id
        AND cn.status <> 'rejected'
        AND cni.sales_invoice_item_id = v_sii.id
        AND cni.id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid);

      v_eligible_qty := GREATEST(v_sii.quantity - v_already_returned_qty, 0);

      IF NEW.quantity > (v_eligible_qty + 0.001) THEN
        RAISE EXCEPTION 'Return quantity % exceeds remaining returnable quantity % (Invoiced %, already returned %)',
          NEW.quantity, v_eligible_qty, v_sii.quantity, v_already_returned_qty;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_credit_note_item_quantities ON public.credit_note_items;
CREATE TRIGGER trg_validate_credit_note_item_quantities
  BEFORE INSERT OR UPDATE OF quantity, sales_invoice_item_id, product_id, batch_id
  ON public.credit_note_items
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_validate_credit_note_item_quantities();

-- ==============================================================================
-- 5. Physical Inventory Movement Trigger (Respecting Stock Disposition)
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.trg_credit_note_inventory_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item record;
  v_already_restocked boolean := false;
  v_disposition text;
BEGIN
  -- Commercial credit notes NEVER move physical inventory
  IF NEW.credit_note_type = 'commercial_credit' THEN
    RETURN NEW;
  END IF;

  -- For Credit Notes linked to a Material Return that already posted inventory, avoid duplicate restock
  IF COALESCE(NEW.material_return_id, OLD.material_return_id) IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.inventory_transactions
      WHERE reference_type = 'material_return'
        AND reference_id = COALESCE(NEW.material_return_id, OLD.material_return_id)
        AND transaction_type = 'return'
    ) INTO v_already_restocked;
    IF v_already_restocked THEN
      RETURN NEW;
    END IF;
  END IF;

  -- Standalone physical return credit notes (credit_note_type = 'physical_return')
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
      v_disposition := COALESCE(v_item.disposition, NEW.stock_disposition, 'saleable');

      -- ONLY 'saleable' stock returns to normal available inventory
      IF v_disposition = 'saleable' THEN
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
          'Canonical Credit Note return (Saleable): ' || NEW.credit_note_number,
          NEW.approved_by,
          NULL,
          NULL
        );
      ELSIF v_disposition IN ('quarantine', 'damaged', 'scrap') THEN
        -- Quarantined or damaged goods are recorded for audit traceability without restoring saleable stock
        INSERT INTO public.inventory_transactions (
          id, product_id, batch_id, transaction_type, quantity,
          transaction_date, reference_number, reference_type, reference_id,
          notes, created_by, metadata
        ) VALUES (
          public.uuid_from_text('inventory-v1:credit-note-' || v_disposition || ':' || NEW.id || ':' || v_item.id),
          v_item.product_id,
          v_item.batch_id,
          v_disposition || '_return',
          v_item.quantity,
          NEW.credit_note_date,
          NEW.credit_note_number,
          'credit_note',
          NEW.id,
          'Credit Note return (' || v_disposition || '): ' || NEW.credit_note_number,
          NEW.approved_by,
          jsonb_build_object(
            'disposition', v_disposition,
            'canonical_engine_version', '1.0',
            'saleable_restocked', false
          )
        ) ON CONFLICT (id) DO NOTHING;
      END IF;
    END LOOP;

  ELSIF OLD.status = 'approved' AND NEW.status IS DISTINCT FROM 'approved' THEN
    FOR v_item IN
      SELECT *
      FROM public.credit_note_items
      WHERE credit_note_id = NEW.id
      ORDER BY id
    LOOP
      v_disposition := COALESCE(v_item.disposition, OLD.stock_disposition, 'saleable');

      IF v_disposition = 'saleable' THEN
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
      END IF;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_credit_note_inventory_v1 ON public.credit_notes;
CREATE TRIGGER trigger_credit_note_inventory_v1
  AFTER UPDATE OF status ON public.credit_notes
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_credit_note_inventory_v1();

-- ==============================================================================
-- 6. General Ledger & COGS Posting Engine (_post_credit_note_je)
-- ==============================================================================

CREATE OR REPLACE FUNCTION public._post_credit_note_je(p_cn public.credit_notes)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_je_id           uuid;
  v_je_cogs_id      uuid;
  v_je_number       text;
  v_ar_id           uuid;
  v_return_id       uuid;
  v_ppn_id          uuid;
  v_cogs_id         uuid;
  v_inv_id          uuid;
  v_loss_id         uuid;
  v_adv_id          uuid;
  v_total_cogs      numeric(18,2) := 0;
  v_total_loss      numeric(18,2) := 0;
  v_item            record;
  v_actor           uuid := COALESCE(p_cn.approved_by, p_cn.created_by, auth.uid());
  v_unit_cogs       numeric(18,4);
  v_orig_inv_id     uuid := p_cn.original_invoice_id;
  v_disposition     text;
  v_orig_inv        public.sales_invoices%ROWTYPE;
  v_unpaid_balance  numeric(18,2) := 0;
  v_excess_credit   numeric(18,2) := 0;
BEGIN
  -- Resolve Chart of Accounts
  SELECT id INTO v_ar_id     FROM chart_of_accounts WHERE code = '1120';
  SELECT id INTO v_return_id FROM chart_of_accounts WHERE code = '4300';
  SELECT id INTO v_ppn_id    FROM chart_of_accounts WHERE code = '2130';
  SELECT id INTO v_cogs_id   FROM chart_of_accounts WHERE code = '5100';
  SELECT id INTO v_inv_id    FROM chart_of_accounts WHERE code = '1130';
  SELECT id INTO v_loss_id   FROM chart_of_accounts WHERE code = '5190';
  SELECT id INTO v_adv_id    FROM chart_of_accounts WHERE code = '2140';

  IF v_ar_id IS NULL OR v_return_id IS NULL THEN
    RAISE EXCEPTION 'Credit Note JE: missing required accounts (1120 A/R or 4300 Sales Returns) in Chart of Accounts';
  END IF;

  -- ── 1. Revenue & Receivables Reversal JE ──
  v_je_number := public.next_journal_entry_number();

  INSERT INTO journal_entries
    (entry_number, entry_date, source_module, reference_id, reference_number,
     description, total_debit, total_credit, is_posted, posted_by, created_by)
  VALUES
    (v_je_number, p_cn.credit_note_date, 'credit_note', p_cn.id, p_cn.credit_note_number,
     'Credit Note reversal — ' || p_cn.credit_note_number,
     p_cn.total_amount, p_cn.total_amount, true, v_actor, v_actor)
  RETURNING id INTO v_je_id;

  -- Dr Sales Returns / Allowances (subtotal — contra revenue)
  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
  VALUES (v_je_id, 1, v_return_id,
          'Sales Return - ' || p_cn.credit_note_number,
          p_cn.subtotal, 0, p_cn.customer_id);

  -- Dr Output PPN (tax reduction)
  IF COALESCE(p_cn.tax_amount, 0) > 0 AND v_ppn_id IS NOT NULL THEN
    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
    VALUES (v_je_id, 2, v_ppn_id,
            'Output PPN reversal - ' || p_cn.credit_note_number,
            p_cn.tax_amount, 0, p_cn.customer_id);
  END IF;

  -- Cr Accounts Receivable (gross amount credited to customer account)
  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
  VALUES (v_je_id, 3, v_ar_id,
          'A/R reversal - ' || p_cn.credit_note_number,
          0, p_cn.total_amount, p_cn.customer_id);

  -- ── 2. Inventory & COGS Reversal JE ──
  -- Posted ONLY for physical goods returns; commercial credits do not move inventory or COGS
  IF p_cn.credit_note_type = 'physical_return' AND v_cogs_id IS NOT NULL THEN
    -- Resolve original invoice ID directly or via Material Return
    IF v_orig_inv_id IS NULL AND p_cn.material_return_id IS NOT NULL THEN
      SELECT mr.original_invoice_id INTO v_orig_inv_id
        FROM public.material_returns mr
       WHERE mr.id = p_cn.material_return_id;

      IF v_orig_inv_id IS NULL THEN
        SELECT si.id INTO v_orig_inv_id
          FROM public.material_returns mr
          JOIN public.sales_invoices si ON mr.original_dc_id::text = ANY(si.linked_challan_ids)
         WHERE mr.id = p_cn.material_return_id
         LIMIT 1;
      END IF;
    END IF;

    FOR v_item IN
      SELECT cni.*, COALESCE(cni.disposition, p_cn.stock_disposition, 'saleable') AS item_disposition
        FROM credit_note_items cni
       WHERE cni.credit_note_id = p_cn.id
    LOOP
      v_unit_cogs := NULL;

      -- 1. Exact historical FIFO cost from original sales invoice line
      IF v_orig_inv_id IS NOT NULL THEN
        SELECT COALESCE(sii.cogs_unit_cost, CASE WHEN sii.quantity > 0 THEN ROUND(sii.cogs_total_cost / sii.quantity, 4) ELSE NULL END)
          INTO v_unit_cogs
          FROM public.sales_invoice_items sii
         WHERE sii.invoice_id = v_orig_inv_id
           AND (
             (v_item.batch_id IS NOT NULL AND sii.batch_id = v_item.batch_id)
             OR (v_item.batch_id IS NULL AND sii.product_id = v_item.product_id)
           )
           AND ((sii.cogs_unit_cost IS NOT NULL AND sii.cogs_unit_cost > 0) OR (sii.cogs_total_cost IS NOT NULL AND sii.cogs_total_cost > 0))
         ORDER BY sii.id
         LIMIT 1;
      END IF;

      -- 1b. Fallback to delivery challan items if linked via material return
      IF (v_unit_cogs IS NULL OR v_unit_cogs <= 0) AND p_cn.material_return_id IS NOT NULL THEN
        SELECT COALESCE(b.landed_cost_per_unit, b.cost_per_unit, 0) INTO v_unit_cogs
          FROM public.material_returns mr
          JOIN public.delivery_challan_items dci ON dci.challan_id = mr.original_dc_id
          JOIN public.batches b ON b.id = dci.batch_id
         WHERE mr.id = p_cn.material_return_id
           AND (
             (v_item.batch_id IS NOT NULL AND dci.batch_id = v_item.batch_id)
             OR (v_item.batch_id IS NULL AND dci.product_id = v_item.product_id)
           )
         LIMIT 1;
      END IF;

      -- 1c. Fallback to batch landed cost
      IF v_unit_cogs IS NULL OR v_unit_cogs <= 0 THEN
        SELECT COALESCE(b.landed_cost_per_unit, b.cost_per_unit, 0) INTO v_unit_cogs
          FROM public.batches b
         WHERE b.id = v_item.batch_id;
      END IF;

      -- Categorize recoverable vs damaged/scrapped
      IF v_item.item_disposition = 'saleable' AND v_inv_id IS NOT NULL THEN
        v_total_cogs := v_total_cogs + ROUND(v_item.quantity * COALESCE(v_unit_cogs, 0), 2);
      ELSIF v_item.item_disposition IN ('damaged', 'scrap') AND v_loss_id IS NOT NULL THEN
        v_total_loss := v_total_loss + ROUND(v_item.quantity * COALESCE(v_unit_cogs, 0), 2);
      END IF;
    END LOOP;

    -- Post COGS reversal journal if recoverable stock or damage loss exists
    IF (v_total_cogs + v_total_loss) > 0 THEN
      v_je_number := public.next_journal_entry_number();
      INSERT INTO journal_entries
        (entry_number, entry_date, source_module, reference_id, reference_number,
         description, total_debit, total_credit, is_posted, posted_by, created_by)
      VALUES
        (v_je_number, p_cn.credit_note_date, 'credit_note_cogs', p_cn.id, p_cn.credit_note_number,
         'Historical FIFO COGS reversal for Credit Note ' || p_cn.credit_note_number,
         (v_total_cogs + v_total_loss), (v_total_cogs + v_total_loss), true, v_actor, v_actor)
      RETURNING id INTO v_je_cogs_id;

      IF v_total_cogs > 0 AND v_inv_id IS NOT NULL THEN
        -- Dr Inventory (recoverable stock)
        INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit)
        VALUES (v_je_cogs_id, 1, v_inv_id,
                'Inventory restock - ' || p_cn.credit_note_number,
                v_total_cogs, 0);
      END IF;

      IF v_total_loss > 0 AND v_loss_id IS NOT NULL THEN
        -- Dr Inventory Impairment & Damage Loss
        INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
        VALUES (v_je_cogs_id, 2, v_loss_id,
                'Inventory damage/scrap loss - ' || p_cn.credit_note_number,
                v_total_loss, 0, p_cn.customer_id);
      END IF;

      -- Cr COGS
      INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
      VALUES (v_je_cogs_id, 3, v_cogs_id,
              'COGS reversal - ' || p_cn.credit_note_number,
              0, (v_total_cogs + v_total_loss), p_cn.customer_id);
    END IF;
  END IF;

  RETURN v_je_id;
END;
$$;

-- Trigger function to execute GL posting when Credit Note becomes approved
CREATE OR REPLACE FUNCTION public.post_credit_note_journal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_should_post boolean := false;
  v_orig_inv public.sales_invoices%ROWTYPE;
  v_unpaid_balance numeric(18,2) := 0;
  v_orig_inv_id uuid := NEW.original_invoice_id;
BEGIN
  IF NEW.status = 'approved' AND NEW.journal_entry_id IS NULL THEN
    IF TG_OP = 'INSERT' THEN
      v_should_post := true;
    ELSIF TG_OP = 'UPDATE' AND (OLD.status IS DISTINCT FROM NEW.status) THEN
      v_should_post := true;
    END IF;
  END IF;

  IF v_should_post THEN
    -- Resolve original invoice if not directly set
    IF v_orig_inv_id IS NULL AND NEW.material_return_id IS NOT NULL THEN
      SELECT mr.original_invoice_id INTO v_orig_inv_id
      FROM public.material_returns mr
      WHERE mr.id = NEW.material_return_id;
    END IF;

    -- Calculate credit balance and settlement status on NEW directly before posting JE
    IF v_orig_inv_id IS NOT NULL THEN
      SELECT * INTO v_orig_inv FROM public.sales_invoices WHERE id = v_orig_inv_id;
      IF v_orig_inv.id IS NOT NULL THEN
        v_unpaid_balance := GREATEST(v_orig_inv.total_amount - COALESCE(v_orig_inv.paid_amount, 0), 0);
        IF NEW.total_amount > v_unpaid_balance THEN
          NEW.customer_credit_balance := NEW.total_amount - v_unpaid_balance;
          NEW.settlement_status := 'unsettled';
        ELSE
          NEW.customer_credit_balance := 0;
          NEW.settlement_status := 'offset_original';
        END IF;
      END IF;
    END IF;

    NEW.journal_entry_id := public._post_credit_note_je(NEW);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_post_credit_note ON public.credit_notes;
CREATE TRIGGER trg_post_credit_note
  BEFORE INSERT OR UPDATE ON public.credit_notes
  FOR EACH ROW
  EXECUTE FUNCTION public.post_credit_note_journal();

-- Accurate credit note amount excluding unsettled credit balances
CREATE OR REPLACE FUNCTION public.get_invoice_credit_note_amount(p_invoice_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(SUM(total_amount - COALESCE(customer_credit_balance, 0)), 0)
  FROM public.credit_notes
  WHERE original_invoice_id = p_invoice_id
    AND status = 'approved';
$$;

-- Trigger to recalculate original sales invoice payment balance when credit note changes
CREATE OR REPLACE FUNCTION public.trg_sync_credit_note_invoice_payment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
    IF NEW.original_invoice_id IS NOT NULL THEN
      PERFORM public.recalculate_sales_invoice_payment_state(NEW.original_invoice_id);
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.original_invoice_id IS NOT NULL AND OLD.original_invoice_id IS DISTINCT FROM NEW.original_invoice_id THEN
      PERFORM public.recalculate_sales_invoice_payment_state(OLD.original_invoice_id);
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.original_invoice_id IS NOT NULL THEN
      PERFORM public.recalculate_sales_invoice_payment_state(OLD.original_invoice_id);
    END IF;
    RETURN OLD;
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_credit_note_invoice ON public.credit_notes;
CREATE TRIGGER trg_sync_credit_note_invoice
  AFTER INSERT OR UPDATE OR DELETE ON public.credit_notes
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_sync_credit_note_invoice_payment();

-- ==============================================================================
-- 7. Application of Customer Credit & Refund RPCs
-- ==============================================================================

-- Apply available Credit Note balance to another unpaid sales invoice
CREATE OR REPLACE FUNCTION public.apply_credit_note_to_invoice(
  p_credit_note_id uuid,
  p_target_invoice_id uuid,
  p_amount numeric,
  p_actor uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_cn public.credit_notes%ROWTYPE;
  v_target public.sales_invoices%ROWTYPE;
  v_role text;
  v_caller uuid := auth.uid();
  v_alloc_amount numeric(15,2);
  v_remaining_balance numeric(15,2);
BEGIN
  IF v_caller IS NULL THEN
    v_caller := p_actor;
  END IF;
  SELECT role INTO v_role FROM public.user_profiles WHERE id = v_caller;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'accounts') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot apply credit notes', COALESCE(v_role, 'none');
  END IF;

  SELECT * INTO v_cn FROM public.credit_notes WHERE id = p_credit_note_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Credit Note % not found', p_credit_note_id;
  END IF;

  IF v_cn.status <> 'approved' THEN
    RAISE EXCEPTION 'Cannot apply unapproved Credit Note %', v_cn.credit_note_number;
  END IF;

  IF COALESCE(v_cn.customer_credit_balance, 0) < p_amount THEN
    RAISE EXCEPTION 'Insufficient credit balance % on Credit Note % (Requested %)',
      v_cn.customer_credit_balance, v_cn.credit_note_number, p_amount;
  END IF;

  SELECT * INTO v_target FROM public.sales_invoices WHERE id = p_target_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Target Sales Invoice % not found', p_target_invoice_id;
  END IF;

  IF NOT public.is_reportable_sales_invoice(v_target.document_status, v_target.is_draft, v_target.notes) THEN
    RAISE EXCEPTION 'Cannot apply credit to cancelled or draft invoice %', v_target.invoice_number;
  END IF;

  IF v_target.customer_id <> v_cn.customer_id THEN
    RAISE EXCEPTION 'Customer mismatch: Credit Note customer does not match target invoice customer';
  END IF;

  v_alloc_amount := LEAST(p_amount, GREATEST(v_target.balance_amount, 0));
  IF v_alloc_amount <= 0 THEN
    RAISE EXCEPTION 'Target invoice % has no outstanding balance', v_target.invoice_number;
  END IF;

  -- Record in voucher_allocations linking this credit note settlement
  INSERT INTO public.voucher_allocations (
    voucher_type, sales_invoice_id, allocated_amount, status
  ) VALUES (
    'receipt', v_target.id, v_alloc_amount, 'approved'
  );

  v_remaining_balance := v_cn.customer_credit_balance - v_alloc_amount;

  UPDATE public.credit_notes
     SET customer_credit_balance = v_remaining_balance,
         applied_to_invoice_id = v_target.id,
         applied_amount = COALESCE(applied_amount, 0) + v_alloc_amount,
         settlement_status = CASE 
           WHEN v_remaining_balance <= 0.01 THEN 'applied_to_invoice'
           ELSE 'partially_allocated'
         END,
         updated_at = now()
   WHERE id = v_cn.id;

  -- Recalculate payment status on target invoice
  PERFORM public.recalculate_sales_invoice_payment_state(v_target.id);

  RETURN jsonb_build_object(
    'success', true,
    'credit_note_id', v_cn.id,
    'credit_note_number', v_cn.credit_note_number,
    'target_invoice_number', v_target.invoice_number,
    'allocated_amount', v_alloc_amount,
    'remaining_credit_balance', v_remaining_balance
  );
END;
$$;

-- Refund customer credit balance via bank or cash
CREATE OR REPLACE FUNCTION public.refund_credit_note(
  p_credit_note_id uuid,
  p_amount numeric,
  p_bank_account_id uuid,
  p_payment_method text DEFAULT 'bank_transfer',
  p_reference text DEFAULT NULL,
  p_actor uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_cn public.credit_notes%ROWTYPE;
  v_role text;
  v_caller uuid := auth.uid();
  v_ar_id uuid;
  v_bank_coa_id uuid;
  v_je_id uuid;
  v_je_number text;
  v_remaining_balance numeric(15,2);
BEGIN
  IF v_caller IS NULL THEN
    v_caller := p_actor;
  END IF;
  SELECT role INTO v_role FROM public.user_profiles WHERE id = v_caller;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'accounts') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot refund credit notes', COALESCE(v_role, 'none');
  END IF;

  SELECT * INTO v_cn FROM public.credit_notes WHERE id = p_credit_note_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Credit Note % not found', p_credit_note_id;
  END IF;

  IF v_cn.status <> 'approved' THEN
    RAISE EXCEPTION 'Cannot refund unapproved Credit Note %', v_cn.credit_note_number;
  END IF;

  IF COALESCE(v_cn.customer_credit_balance, 0) < p_amount THEN
    RAISE EXCEPTION 'Insufficient credit balance % on Credit Note % (Requested %)',
      v_cn.customer_credit_balance, v_cn.credit_note_number, p_amount;
  END IF;

  -- Resolve bank account CoA
  SELECT id INTO v_ar_id FROM chart_of_accounts WHERE code = '1120';
  IF p_bank_account_id IS NOT NULL THEN
    SELECT coa_id INTO v_bank_coa_id FROM bank_accounts WHERE id = p_bank_account_id;
  END IF;
  IF v_bank_coa_id IS NULL THEN
    SELECT id INTO v_bank_coa_id FROM chart_of_accounts WHERE code LIKE '1-102%' OR code = '1102' OR LOWER(name) LIKE '%bank%' LIMIT 1;
  END IF;

  IF v_bank_coa_id IS NULL OR v_ar_id IS NULL THEN
    RAISE EXCEPTION 'Chart of accounts missing A/R (1120) or bank account mapping';
  END IF;

  -- Post Refund Journal: Dr A/R (clearing credit balance), Cr Bank
  v_je_number := public.next_journal_entry_number();
  INSERT INTO journal_entries (
    entry_number, entry_date, source_module, reference_id, reference_number,
    description, total_debit, total_credit, is_posted, posted_by, created_by
  ) VALUES (
    v_je_number, CURRENT_DATE, 'customer_refund', v_cn.id, v_cn.credit_note_number,
    'Customer refund for Credit Note ' || v_cn.credit_note_number || ' - Ref: ' || COALESCE(p_reference, 'Bank Transfer'),
    p_amount, p_amount, true, v_caller, v_caller
  ) RETURNING id INTO v_je_id;

  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
  VALUES (v_je_id, 1, v_ar_id, 'Customer refund debit - ' || v_cn.credit_note_number, p_amount, 0, v_cn.customer_id);

  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit)
  VALUES (v_je_id, 2, v_bank_coa_id, 'Bank payout refund - ' || v_cn.credit_note_number, 0, p_amount);

  v_remaining_balance := v_cn.customer_credit_balance - p_amount;

  UPDATE public.credit_notes
     SET customer_credit_balance = v_remaining_balance,
         refund_amount = COALESCE(refund_amount, 0) + p_amount,
         refund_date = CURRENT_DATE,
         settlement_status = CASE 
           WHEN v_remaining_balance <= 0.01 THEN 'refunded'
           ELSE 'partially_allocated'
         END,
         updated_at = now()
   WHERE id = v_cn.id;

  RETURN jsonb_build_object(
    'success', true,
    'credit_note_id', v_cn.id,
    'credit_note_number', v_cn.credit_note_number,
    'refund_amount', p_amount,
    'remaining_credit_balance', v_remaining_balance,
    'journal_entry_number', v_je_number
  );
END;
$$;

-- ==============================================================================
-- 8. Coretax Nota Retur Linkage RPC
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.link_or_generate_nota_retur_for_credit_note(p_credit_note_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_cn public.credit_notes%ROWTYPE;
  v_inv public.sales_invoices%ROWTYPE;
  v_cust public.customers%ROWTYPE;
  v_nr_id uuid;
  v_item record;
BEGIN
  SELECT * INTO v_cn FROM public.credit_notes WHERE id = p_credit_note_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Credit note % not found', p_credit_note_id;
  END IF;

  -- Check if already linked
  IF v_cn.nota_retur_id IS NOT NULL THEN
    RETURN v_cn.nota_retur_id;
  END IF;

  SELECT * INTO v_inv FROM public.sales_invoices WHERE id = v_cn.original_invoice_id;
  SELECT * INTO v_cust FROM public.customers WHERE id = v_cn.customer_id;

  -- Generate Nota Retur
  INSERT INTO public.nota_retur (
    return_date,
    credit_note_id,
    material_return_id,
    sales_invoice_id,
    original_invoice_number,
    sales_invoice_number,
    customer_id,
    customer_name,
    customer_address,
    currency,
    dpp_amount,
    tax_rate,
    ppn_amount,
    total_amount,
    status,
    coretax_status,
    created_by
  ) VALUES (
    v_cn.credit_note_date,
    v_cn.id,
    v_cn.material_return_id,
    COALESCE(v_cn.original_invoice_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(v_inv.invoice_number, 'INV-UNKNOWN'),
    v_inv.invoice_number,
    v_cn.customer_id,
    COALESCE(v_cust.company_name, 'Unknown Customer'),
    COALESCE(v_cust.address, ''),
    'IDR',
    v_cn.subtotal,
    0.1100,
    v_cn.tax_amount,
    v_cn.total_amount,
    'draft',
    'draft',
    COALESCE(v_cn.created_by, auth.uid())
  ) RETURNING id INTO v_nr_id;

  -- Copy line items
  FOR v_item IN
    SELECT cni.*, p.product_name
    FROM public.credit_note_items cni
    LEFT JOIN public.products p ON p.id = cni.product_id
    WHERE cni.credit_note_id = v_cn.id
  LOOP
    INSERT INTO public.nota_retur_items (
      nota_retur_id,
      product_id,
      batch_id,
      item_name,
      quantity,
      unit_price,
      dpp_amount,
      tax_rate,
      ppn_amount,
      total_amount
    ) VALUES (
      v_nr_id,
      v_item.product_id,
      v_item.batch_id,
      COALESCE(v_item.product_name, 'Returned Product'),
      v_item.quantity,
      v_item.unit_price,
      ROUND(v_item.quantity * v_item.unit_price, 2),
      11.00,
      ROUND(v_item.quantity * v_item.unit_price * 0.11, 2),
      ROUND(v_item.quantity * v_item.unit_price * 1.11, 2)
    );
  END LOOP;

  -- Update credit_notes with nota_retur_id
  UPDATE public.credit_notes SET nota_retur_id = v_nr_id WHERE id = v_cn.id;

  RETURN v_nr_id;
END;
$$;

-- Revoke execute from anon, public and grant to authenticated
REVOKE EXECUTE ON FUNCTION public.apply_credit_note_to_invoice(uuid, uuid, numeric, uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_credit_note_to_invoice(uuid, uuid, numeric, uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.refund_credit_note(uuid, numeric, uuid, text, text, uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.refund_credit_note(uuid, numeric, uuid, text, text, uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.link_or_generate_nota_retur_for_credit_note(uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.link_or_generate_nota_retur_for_credit_note(uuid) TO authenticated, service_role;

COMMIT;
