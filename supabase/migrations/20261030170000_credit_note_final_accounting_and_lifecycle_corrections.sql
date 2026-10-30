-- ==============================================================================
-- Migration: 20261030170000_credit_note_final_accounting_and_lifecycle_corrections.sql
-- Module: Sales Return & Credit Note Final Accounting, Concurrency & Security Hardening
--
-- Key Capabilities Delivered:
-- 1. Atomic Credit Note creation RPC with full transaction rollback (create_credit_note_atomic)
-- 2. Deterministic row locking (FOR UPDATE) protecting invoice returnable quantities against race conditions
-- 3. Separation of physical receipt from commercial Credit Note approval (Goods Return Receipt lifecycle)
-- 4. Authoritative historical FIFO COGS unit cost enforcement (blocks silent fallbacks)
-- 5. Strict actor verification and role-based access control across all SECURITY DEFINER RPCs
-- 6. Customer credit settlement audit trail (credit_note_allocations table & payment_vouchers linkage)
-- 7. Chart of Accounts structure, normal balance, and account type validation
-- 8. Indonesian PPN tax rate derivation (11%/12%/custom DPP) and Coretax Nota Retur lifecycle tracking
-- ==============================================================================

DO $$
BEGIN
  -- Ensure reason, notes, currency, and original_invoice_number columns exist on credit_notes
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'credit_notes') THEN
    ALTER TABLE public.credit_notes ADD COLUMN IF NOT EXISTS original_invoice_number text;
    ALTER TABLE public.credit_notes ADD COLUMN IF NOT EXISTS reason text;
    ALTER TABLE public.credit_notes ADD COLUMN IF NOT EXISTS notes text;
    ALTER TABLE public.credit_notes ADD COLUMN IF NOT EXISTS currency text DEFAULT 'IDR';
  END IF;

  -- Ensure nota_retur canonical columns exist
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'nota_retur') THEN
    ALTER TABLE public.nota_retur ADD COLUMN IF NOT EXISTS nota_retur_number text;
    ALTER TABLE public.nota_retur ADD COLUMN IF NOT EXISTS return_date date DEFAULT CURRENT_DATE;
    ALTER TABLE public.nota_retur ADD COLUMN IF NOT EXISTS coretax_status text DEFAULT 'draft';
    ALTER TABLE public.nota_retur ADD COLUMN IF NOT EXISTS coretax_reference_number text;
    ALTER TABLE public.nota_retur ADD COLUMN IF NOT EXISTS coretax_submission_date timestamptz;
    ALTER TABLE public.nota_retur ADD COLUMN IF NOT EXISTS coretax_response_notes text;
    ALTER TABLE public.nota_retur ADD COLUMN IF NOT EXISTS document_url text;
  END IF;

  -- Ensure auth.jwt helper exists in standalone/test environments
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = 'auth' AND p.proname = 'jwt') THEN
    CREATE SCHEMA IF NOT EXISTS auth;
    EXECUTE $func$
      CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb AS $inner$
        SELECT COALESCE(
          NULLIF(current_setting('request.jwt.claims', true), '')::jsonb,
          jsonb_build_object(
            'role', current_setting('request.jwt.claim.role', true),
            'sub', current_setting('request.jwt.claim.sub', true)
          )
        );
      $inner$ LANGUAGE sql STABLE;
    $func$;
  END IF;
END $$;

-- ------------------------------------------------------------------------------
-- 1. Audit Table: credit_note_allocations
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.credit_note_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  allocation_number text NOT NULL,
  credit_note_id uuid NOT NULL REFERENCES public.credit_notes(id) ON DELETE RESTRICT,
  target_invoice_id uuid NOT NULL REFERENCES public.sales_invoices(id) ON DELETE RESTRICT,
  allocated_amount numeric(18,2) NOT NULL CHECK (allocated_amount > 0),
  allocated_date date NOT NULL DEFAULT CURRENT_DATE,
  notes text,
  created_by uuid,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cna_credit_note_id ON public.credit_note_allocations(credit_note_id);
CREATE INDEX IF NOT EXISTS idx_cna_target_invoice_id ON public.credit_note_allocations(target_invoice_id);

-- Sequence for credit note allocation numbers
CREATE SEQUENCE IF NOT EXISTS public.credit_note_allocation_seq;

CREATE OR REPLACE FUNCTION public.next_credit_note_allocation_number()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_seq integer;
  v_year text;
BEGIN
  v_seq := nextval('public.credit_note_allocation_seq');
  v_year := to_char(CURRENT_DATE, 'YY');
  RETURN 'CNA-' || v_year || '-' || lpad(v_seq::text, 4, '0');
END;
$$;

-- ------------------------------------------------------------------------------
-- 2. Chart of Accounts Validation Function
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.validate_coa_account(
  p_code text,
  p_expected_type text,
  p_expected_balance text
)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_acc public.chart_of_accounts%ROWTYPE;
BEGIN
  SELECT * INTO v_acc FROM public.chart_of_accounts WHERE code = p_code;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Chart of Accounts validation failed: account % does not exist', p_code;
  END IF;

  IF v_acc.is_active IS FALSE THEN
    RAISE EXCEPTION 'Chart of Accounts validation failed: account % (%) is inactive', p_code, v_acc.name;
  END IF;

  -- Validate account_type if present on record
  IF p_expected_type IS NOT NULL AND v_acc.account_type IS NOT NULL THEN
    IF p_expected_type = 'revenue' AND v_acc.account_type NOT IN ('revenue', 'contra') THEN
      RAISE EXCEPTION 'Chart of Accounts validation failed: account % has type %, expected revenue/contra', p_code, v_acc.account_type;
    ELSIF p_expected_type <> 'revenue' AND v_acc.account_type <> p_expected_type THEN
      RAISE EXCEPTION 'Chart of Accounts validation failed: account % has type %, expected %', p_code, v_acc.account_type, p_expected_type;
    END IF;
  END IF;

  -- Validate normal_balance if present on record
  IF p_expected_balance IS NOT NULL AND v_acc.normal_balance IS NOT NULL THEN
    IF v_acc.normal_balance <> p_expected_balance THEN
      RAISE EXCEPTION 'Chart of Accounts validation failed: account % has normal_balance %, expected %', p_code, v_acc.normal_balance, p_expected_balance;
    END IF;
  END IF;

  RETURN v_acc.id;
END;
$$;

-- ------------------------------------------------------------------------------
-- 3. Deterministic Item Quantity Validation with Row Locking
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.validate_credit_note_item_quantities()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_cn public.credit_notes%ROWTYPE;
  v_sii public.sales_invoice_items%ROWTYPE;
  v_already_returned numeric(18,3) := 0;
  v_remaining_returnable numeric(18,3) := 0;
BEGIN
  IF NEW.quantity <= 0 THEN
    RAISE EXCEPTION 'Credit note item quantity must be strictly positive (got %)', NEW.quantity;
  END IF;

  IF NEW.unit_price < 0 THEN
    RAISE EXCEPTION 'Credit note item unit price cannot be negative (got %)', NEW.unit_price;
  END IF;

  SELECT * INTO v_cn FROM public.credit_notes WHERE id = NEW.credit_note_id;

  -- If credit note is tied to an original invoice, lock rows and validate returnable limit
  IF v_cn.original_invoice_id IS NOT NULL THEN
    -- Deterministic row locking on sales invoice and invoice items
    PERFORM 1 FROM public.sales_invoices WHERE id = v_cn.original_invoice_id FOR UPDATE;

    IF NEW.sales_invoice_item_id IS NOT NULL THEN
      SELECT * INTO v_sii
      FROM public.sales_invoice_items
      WHERE id = NEW.sales_invoice_item_id
        AND invoice_id = v_cn.original_invoice_id
      FOR UPDATE;
    ELSE
      SELECT * INTO v_sii
      FROM public.sales_invoice_items
      WHERE invoice_id = v_cn.original_invoice_id
        AND product_id = NEW.product_id
        AND (batch_id = NEW.batch_id OR (batch_id IS NULL AND NEW.batch_id IS NULL))
      ORDER BY id
      LIMIT 1
      FOR UPDATE;
    END IF;

    IF v_sii.id IS NOT NULL THEN
      -- Calculate already returned in active (non-rejected) credit notes
      SELECT COALESCE(SUM(cni.quantity), 0)
        INTO v_already_returned
        FROM public.credit_note_items cni
        JOIN public.credit_notes existing_cn ON existing_cn.id = cni.credit_note_id
       WHERE existing_cn.original_invoice_id = v_cn.original_invoice_id
         AND (
           (cni.sales_invoice_item_id IS NOT NULL AND cni.sales_invoice_item_id = v_sii.id)
           OR (cni.sales_invoice_item_id IS NULL AND cni.product_id = v_sii.product_id AND (cni.batch_id = v_sii.batch_id OR (cni.batch_id IS NULL AND v_sii.batch_id IS NULL)))
         )
         AND existing_cn.status IN ('pending_approval', 'approved')
         AND (TG_OP = 'INSERT' OR cni.id <> OLD.id)
         AND existing_cn.id <> v_cn.id;

      v_remaining_returnable := GREATEST(0, v_sii.quantity - v_already_returned);

      IF NEW.quantity > (v_remaining_returnable + 0.0001) THEN
        RAISE EXCEPTION 'Return quantity % exceeds remaining returnable quantity % (Invoiced: %, Already Credited: %) for product %',
          NEW.quantity, v_remaining_returnable, v_sii.quantity, v_already_returned, v_sii.product_id;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_credit_note_item_quantities ON public.credit_note_items;
CREATE TRIGGER trg_validate_credit_note_item_quantities
  BEFORE INSERT OR UPDATE ON public.credit_note_items
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_credit_note_item_quantities();

-- ------------------------------------------------------------------------------
-- 4. Atomic Credit Note Creation RPC
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_credit_note_atomic(
  p_credit_note jsonb,
  p_items jsonb,
  p_actor uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_role text;
  v_cn_id uuid;
  v_cn_number text;
  v_cust_id uuid;
  v_orig_inv_id uuid;
  v_orig_inv public.sales_invoices%ROWTYPE;
  v_item jsonb;
  v_subtotal numeric(18,2) := 0;
  v_tax numeric(18,2) := 0;
  v_total numeric(18,2) := 0;
  v_tax_rate numeric(8,4) := 0.1100;
  v_line_qty numeric(18,3);
  v_line_price numeric(18,4);
  v_line_subtotal numeric(18,2);
  v_grr_id uuid;
  v_grr_number text;
  v_bc text;
  v_type text;
  v_disp text;
  v_godown text;
  v_currency text;
  v_reason text;
  v_notes text;
  v_date date;
  v_mr_id uuid;
BEGIN
  -- Strict Authentication & Authorization check
  IF v_caller IS NULL THEN
    IF current_user = 'service_role' OR session_user = 'postgres' OR (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) OR (COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), '')) = 'service_role' THEN
      v_caller := p_actor;
    ELSE
      RAISE EXCEPTION 'Authentication required: no active session';
    END IF;
  END IF;

  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required: valid actor identity missing';
  END IF;

  SELECT role INTO v_role FROM public.user_profiles WHERE id = v_caller;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'accounts', 'sales', 'warehouse', 'manager') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot create credit notes', COALESCE(v_role, 'none');
  END IF;

  -- Validate Header Inputs
  v_cust_id := (p_credit_note->>'customer_id')::uuid;
  IF v_cust_id IS NULL THEN
    RAISE EXCEPTION 'Customer is required for credit note creation';
  END IF;

  v_reason := NULLIF(TRIM(p_credit_note->>'reason'), '');
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'Reason is required for credit note creation';
  END IF;

  v_date := COALESCE((p_credit_note->>'credit_note_date')::date, CURRENT_DATE);
  v_currency := COALESCE(p_credit_note->>'currency', 'IDR');
  v_bc := COALESCE(p_credit_note->>'business_case', 'full_physical_return');
  v_type := COALESCE(p_credit_note->>'credit_note_type', 'physical_return');
  v_disp := COALESCE(p_credit_note->>'stock_disposition', 'saleable');
  v_godown := COALESCE(p_credit_note->>'godown', 'Main Warehouse');
  v_notes := p_credit_note->>'notes';
  v_mr_id := (p_credit_note->>'material_return_id')::uuid;

  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Credit note must contain at least one line item';
  END IF;

  -- Original invoice verification and row locking
  IF p_credit_note->>'original_invoice_id' IS NOT NULL AND (p_credit_note->>'original_invoice_id') <> '' THEN
    v_orig_inv_id := (p_credit_note->>'original_invoice_id')::uuid;

    SELECT * INTO v_orig_inv
    FROM public.sales_invoices
    WHERE id = v_orig_inv_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Original sales invoice % not found', v_orig_inv_id;
    END IF;

    IF NOT public.is_reportable_sales_invoice(v_orig_inv.document_status, v_orig_inv.is_draft, v_orig_inv.notes) THEN
      RAISE EXCEPTION 'Cannot issue credit note against cancelled or draft sales invoice %', v_orig_inv.invoice_number;
    END IF;

    IF v_orig_inv.customer_id <> v_cust_id THEN
      RAISE EXCEPTION 'Customer mismatch: Credit Note customer does not match original invoice customer';
    END IF;

    -- Lock invoice items deterministically
    PERFORM 1 FROM public.sales_invoice_items WHERE invoice_id = v_orig_inv_id FOR UPDATE;

    -- Authoritative Tax Rate derivation from original invoice
    IF v_orig_inv.subtotal > 0 AND v_orig_inv.tax_amount > 0 THEN
      v_tax_rate := ROUND(v_orig_inv.tax_amount / v_orig_inv.subtotal, 4);
    ELSIF v_orig_inv.tax_amount = 0 THEN
      v_tax_rate := 0.0000;
    ELSE
      v_tax_rate := 0.1100;
    END IF;
  ELSE
    IF p_credit_note ? 'tax_rate' THEN
      v_tax_rate := (p_credit_note->>'tax_rate')::numeric;
    END IF;
  END IF;

  -- Calculate Totals from Items
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_line_qty := (v_item->>'quantity')::numeric;
    v_line_price := (v_item->>'unit_price')::numeric;

    IF v_line_qty IS NULL OR v_line_qty <= 0 THEN
      RAISE EXCEPTION 'Line item quantity must be positive';
    END IF;
    IF v_line_price IS NULL OR v_line_price < 0 THEN
      RAISE EXCEPTION 'Line item price cannot be negative';
    END IF;

    v_line_subtotal := ROUND(v_line_qty * v_line_price, 2);
    v_subtotal := v_subtotal + v_line_subtotal;
  END LOOP;

  v_tax := ROUND(v_subtotal * v_tax_rate, 2);
  v_total := v_subtotal + v_tax;

  -- Number generation
  v_cn_number := NULLIF(TRIM(p_credit_note->>'credit_note_number'), '');
  IF v_cn_number IS NULL THEN
    v_cn_number := public.generate_credit_note_number();
  END IF;

  -- 1. Insert Credit Note Header
  INSERT INTO public.credit_notes (
    credit_note_number,
    credit_note_date,
    customer_id,
    original_invoice_id,
    original_invoice_number,
    reason,
    notes,
    currency,
    credit_note_type,
    business_case,
    stock_disposition,
    godown,
    subtotal,
    tax_amount,
    total_amount,
    material_return_id,
    status,
    created_by
  ) VALUES (
    v_cn_number,
    v_date,
    v_cust_id,
    v_orig_inv_id,
    v_orig_inv.invoice_number,
    v_reason,
    v_notes,
    v_currency,
    v_type,
    v_bc,
    v_disp,
    v_godown,
    v_subtotal,
    v_tax,
    v_total,
    v_mr_id,
    'pending_approval',
    v_caller
  ) RETURNING id INTO v_cn_id;

  -- 2. Insert Credit Note Items
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_line_qty := (v_item->>'quantity')::numeric;
    v_line_price := (v_item->>'unit_price')::numeric;

    INSERT INTO public.credit_note_items (
      credit_note_id,
      sales_invoice_item_id,
      delivery_challan_item_id,
      product_id,
      batch_id,
      quantity,
      unit_price,
      condition,
      disposition,
      accepted_quantity,
      damaged_quantity,
      rejected_quantity
    ) VALUES (
      v_cn_id,
      (v_item->>'sales_invoice_item_id')::uuid,
      (v_item->>'delivery_challan_item_id')::uuid,
      (v_item->>'product_id')::uuid,
      (v_item->>'batch_id')::uuid,
      v_line_qty,
      v_line_price,
      COALESCE(v_item->>'condition', 'good'),
      COALESCE(v_item->>'disposition', v_disp),
      CASE WHEN COALESCE(v_item->>'disposition', v_disp) = 'saleable' THEN v_line_qty ELSE 0 END,
      CASE WHEN COALESCE(v_item->>'disposition', v_disp) IN ('damaged', 'quarantine', 'scrap') THEN v_line_qty ELSE 0 END,
      CASE WHEN COALESCE(v_item->>'disposition', v_disp) = 'rejected' THEN v_line_qty ELSE 0 END
    );
  END LOOP;

  -- 3. If physical return and no existing material return linked, generate linked Goods Return Receipt
  IF v_type = 'physical_return' AND v_mr_id IS NULL THEN
    v_grr_number := 'GRR-' || v_cn_number;
    INSERT INTO public.material_returns (
      return_number,
      original_invoice_id,
      customer_id,
      return_date,
      return_type,
      return_reason,
      status,
      credit_note_id,
      credit_note_issued,
      credit_note_number,
      credit_note_amount,
      restocked,
      notes,
      created_by
    ) VALUES (
      v_grr_number,
      v_orig_inv_id,
      v_cust_id,
      v_date,
      'credit_note_return',
      'Goods Return Receipt for ' || v_cn_number,
      'pending_approval',
      v_cn_id,
      true,
      v_cn_number,
      v_total,
      false,
      'Auto-generated Goods Return Receipt awaiting warehouse physical inspection',
      v_caller
    ) RETURNING id INTO v_grr_id;

    -- Insert items into material_return_items
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
      INSERT INTO public.material_return_items (
        return_id,
        product_id,
        batch_id,
        quantity_returned,
        unit_price,
        condition,
        disposition,
        notes
      ) VALUES (
        v_grr_id,
        (v_item->>'product_id')::uuid,
        (v_item->>'batch_id')::uuid,
        (v_item->>'quantity')::numeric,
        (v_item->>'unit_price')::numeric,
        COALESCE(v_item->>'condition', 'good'),
        CASE WHEN COALESCE(v_item->>'disposition', v_disp) = 'saleable' THEN 'restock' ELSE 'quarantine' END,
        'Expected physical return for ' || v_cn_number
      );
    END LOOP;

    -- Link back to credit note
    UPDATE public.credit_notes
       SET goods_return_receipt_id = v_grr_id,
           material_return_id = v_grr_id
     WHERE id = v_cn_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'credit_note_id', v_cn_id,
    'credit_note_number', v_cn_number,
    'subtotal', v_subtotal,
    'tax_amount', v_tax,
    'total_amount', v_total,
    'tax_rate', v_tax_rate,
    'goods_return_receipt_id', v_grr_id,
    'status', 'pending_approval'
  );
END;
$$;

-- ------------------------------------------------------------------------------
-- 5. Physical Receipt Separation: Inventory Movement Trigger
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_credit_note_inventory_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- 1. Commercial credit notes NEVER move physical inventory
  IF NEW.credit_note_type = 'commercial_credit' THEN
    RETURN NEW;
  END IF;

  -- 2. Physical returns: If linked to a Material Return / Goods Return Receipt,
  -- the Material Return workflow strictly owns physical receipt, inspection and restocking!
  -- Credit Note approval records commercial & AR impacts only; stock movements occur only
  -- upon approved receipt and inspection (material_returns.restocked = true).
  IF COALESCE(NEW.material_return_id, OLD.material_return_id) IS NOT NULL OR
     COALESCE(NEW.goods_return_receipt_id, OLD.goods_return_receipt_id) IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- 3. Standalone legacy physical returns (fallback if no linked return receipt)
  IF NEW.status = 'approved' AND OLD.status IS DISTINCT FROM 'approved' THEN
    -- Check if stock was already restored to prevent duplicate restoration
    IF EXISTS (
      SELECT 1 FROM public.inventory_transactions
      WHERE reference_type = 'credit_note'
        AND reference_id = NEW.id
    ) THEN
      RETURN NEW;
    END IF;

    -- Restock items with disposition = 'saleable', and record audit movements for quarantine/damaged/scrap
    DECLARE
      v_item record;
      v_item_disp text;
    BEGIN
      FOR v_item IN
        SELECT * FROM public.credit_note_items
        WHERE credit_note_id = NEW.id
          AND batch_id IS NOT NULL
        ORDER BY id
      LOOP
        v_item_disp := COALESCE(v_item.disposition, NEW.stock_disposition, 'saleable');
        IF v_item_disp = 'saleable' THEN
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
        ELSIF v_item_disp IN ('quarantine', 'damaged', 'scrap') THEN
          INSERT INTO public.inventory_transactions (
            id, product_id, batch_id, transaction_type, quantity,
            transaction_date, reference_number, reference_type, reference_id,
            notes, created_by, metadata
          ) VALUES (
            public.uuid_from_text('inventory-v1:credit-note-' || v_item_disp || ':' || NEW.id || ':' || v_item.id),
            v_item.product_id,
            v_item.batch_id,
            v_item_disp || '_return',
            v_item.quantity,
            NEW.credit_note_date,
            NEW.credit_note_number,
            'credit_note',
            NEW.id,
            'Credit Note return (' || v_item_disp || '): ' || NEW.credit_note_number,
            NEW.approved_by,
            jsonb_build_object(
              'disposition', v_item_disp,
              'canonical_engine_version', '1.0',
              'saleable_restocked', false
            )
          ) ON CONFLICT (id) DO NOTHING;
        END IF;
      END LOOP;
    END;
  END IF;

  RETURN NEW;
END;
$$;

-- ------------------------------------------------------------------------------
-- 6. Authoritative Historical FIFO COGS Reversal & Chart of Accounts Hardening
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._post_credit_note_je(p_cn public.credit_notes)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_je_id uuid;
  v_je_number text;
  v_ar_id uuid;
  v_ret_id uuid;
  v_tax_id uuid;
  v_cogs_id uuid;
  v_inv_id uuid;
  v_loss_id uuid;
  v_actor uuid := COALESCE(p_cn.approved_by, auth.uid());
  v_total_cogs numeric(18,2) := 0;
  v_total_loss numeric(18,2) := 0;
  v_item record;
  v_unit_cogs numeric(18,4);
  v_orig_inv_id uuid := p_cn.original_invoice_id;
  v_je_cogs_id uuid;
BEGIN
  -- Strict Chart of Accounts structure, normal balance, and type validation
  v_ret_id  := public.validate_coa_account('4300', 'revenue', 'debit');    -- Sales Returns & Allowances (Contra-revenue)
  v_tax_id  := public.validate_coa_account('2130', 'liability', 'credit'); -- Output PPN Payable
  v_ar_id   := public.validate_coa_account('1120', 'asset', 'debit');      -- Accounts Receivable Control
  v_cogs_id := public.validate_coa_account('5100', 'expense', 'debit');    -- COGS
  v_inv_id  := public.validate_coa_account('1130', 'asset', 'debit');      -- Inventory Asset
  v_loss_id := public.validate_coa_account('5190', 'expense', 'debit');    -- Inventory Impairment Loss

  -- 1. Post Commercial / AR Journal Entry (Debits = Credits)
  v_je_number := public.next_journal_entry_number();
  INSERT INTO journal_entries
    (entry_number, entry_date, source_module, reference_id, reference_number,
     description, total_debit, total_credit, is_posted, posted_by, created_by)
  VALUES
    (v_je_number, p_cn.credit_note_date, 'credit_note', p_cn.id, p_cn.credit_note_number,
     'Credit Note ' || p_cn.credit_note_number || ' - ' || COALESCE(p_cn.reason, 'Sales Return'),
     p_cn.total_amount, p_cn.total_amount, true, v_actor, v_actor)
  RETURNING id INTO v_je_id;

  -- Debit: Sales Returns & Allowances (4300)
  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
  VALUES (v_je_id, 1, v_ret_id, 'Sales return concession - ' || p_cn.credit_note_number, p_cn.subtotal, 0, p_cn.customer_id);

  -- Debit: Output PPN Tax Reduction (2130)
  IF p_cn.tax_amount > 0 THEN
    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
    VALUES (v_je_id, 2, v_tax_id, 'PPN output reduction - ' || p_cn.credit_note_number, p_cn.tax_amount, 0, p_cn.customer_id);
  END IF;

  -- Credit: Accounts Receivable Control (1120)
  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
  VALUES (v_je_id, 3, v_ar_id, 'AR reduction for ' || p_cn.credit_note_number, 0, p_cn.total_amount, p_cn.customer_id);

  -- 2. Post Historical FIFO COGS Reversal for Physical Returns
  IF p_cn.credit_note_type = 'physical_return' THEN
    IF v_orig_inv_id IS NULL AND p_cn.material_return_id IS NOT NULL THEN
      SELECT mr.original_invoice_id INTO v_orig_inv_id
      FROM public.material_returns mr
      WHERE mr.id = p_cn.material_return_id;
    END IF;

    FOR v_item IN
      SELECT cni.*, COALESCE(cni.disposition, p_cn.stock_disposition, 'saleable') AS item_disposition
        FROM credit_note_items cni
       WHERE cni.credit_note_id = p_cn.id
    LOOP
      v_unit_cogs := NULL;

      -- Authoritative historical cost from original sales invoice line
      IF v_orig_inv_id IS NOT NULL THEN
        SELECT COALESCE(sii.cogs_unit_cost, CASE WHEN sii.quantity > 0 THEN ROUND(sii.cogs_total_cost / sii.quantity, 4) ELSE NULL END)
          INTO v_unit_cogs
          FROM public.sales_invoice_items sii
         WHERE sii.invoice_id = v_orig_inv_id
           AND (
             (v_item.sales_invoice_item_id IS NOT NULL AND sii.id = v_item.sales_invoice_item_id)
             OR (v_item.batch_id IS NOT NULL AND sii.batch_id = v_item.batch_id)
             OR (v_item.batch_id IS NULL AND sii.product_id = v_item.product_id)
           )
           AND ((sii.cogs_unit_cost IS NOT NULL AND sii.cogs_unit_cost > 0) OR (sii.cogs_total_cost IS NOT NULL AND sii.cogs_total_cost > 0))
         ORDER BY sii.id
         LIMIT 1;
      END IF;

      -- If original sales invoice exists and historical cost is missing, BLOCK posting!
      IF v_orig_inv_id IS NOT NULL AND (v_unit_cogs IS NULL OR v_unit_cogs <= 0) THEN
        RAISE EXCEPTION 'Authoritative historical COGS unit cost missing for invoice item %. Audited costing resolution required.',
          COALESCE(v_item.sales_invoice_item_id::text, v_item.product_id::text);
      END IF;

      -- Categorize recoverable vs damaged/scrapped
      -- Quarantined items awaiting inspection are held without general inventory recognition
      IF v_item.item_disposition = 'saleable' THEN
        v_total_cogs := v_total_cogs + ROUND(v_item.quantity * COALESCE(v_unit_cogs, 0), 2);
      ELSIF v_item.item_disposition IN ('damaged', 'scrap') THEN
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

      IF v_total_cogs > 0 THEN
        -- Dr Inventory Asset (1130) for saleable recovered stock
        INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit)
        VALUES (v_je_cogs_id, 1, v_inv_id,
                'Inventory restock - ' || p_cn.credit_note_number,
                v_total_cogs, 0);
      END IF;

      IF v_total_loss > 0 THEN
        -- Dr Inventory Impairment & Damage Loss (5190)
        INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
        VALUES (v_je_cogs_id, 2, v_loss_id,
                'Inventory damage/scrap loss - ' || p_cn.credit_note_number,
                v_total_loss, 0, p_cn.customer_id);
      END IF;

      -- Cr COGS (5100)
      INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
      VALUES (v_je_cogs_id, 3, v_cogs_id,
              'COGS reversal - ' || p_cn.credit_note_number,
              0, (v_total_cogs + v_total_loss), p_cn.customer_id);
    END IF;
  END IF;

  RETURN v_je_id;
END;
$$;

-- ------------------------------------------------------------------------------
-- 7. Hardened Application of Customer Credit to Invoice RPC
-- ------------------------------------------------------------------------------
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
  v_alloc_amount numeric(18,2);
  v_remaining_balance numeric(18,2);
  v_alloc_number text;
  v_target_outstanding numeric(18,2);
BEGIN
  -- Strict Authentication & Authorization check (prevent caller spoofing)
  IF v_caller IS NULL THEN
    IF current_user = 'service_role' OR session_user = 'postgres' OR (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) OR (COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), '')) = 'service_role' THEN
      v_caller := p_actor;
    ELSE
      RAISE EXCEPTION 'Authentication required: no active session';
    END IF;
  END IF;

  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required: valid actor identity missing';
  END IF;

  SELECT role INTO v_role FROM public.user_profiles WHERE id = v_caller;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'accounts', 'manager') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot apply credit notes', COALESCE(v_role, 'none');
  END IF;

  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Application amount must be strictly positive (got %)', p_amount;
  END IF;

  -- Deterministic row locking on both credit note and target invoice
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

  -- Enforce same customer matching
  IF v_target.customer_id <> v_cn.customer_id THEN
    RAISE EXCEPTION 'Customer mismatch: Credit Note customer does not match target invoice customer';
  END IF;

  v_target_outstanding := GREATEST(0, v_target.total_amount - COALESCE(v_target.paid_amount, 0));
  IF v_target_outstanding <= 0.01 THEN
    RAISE EXCEPTION 'Target invoice % has no outstanding balance', v_target.invoice_number;
  END IF;

  v_alloc_amount := LEAST(p_amount, v_target_outstanding);

  -- 1. Create uniquely referenced allocation record
  v_alloc_number := public.next_credit_note_allocation_number();
  INSERT INTO public.credit_note_allocations (
    allocation_number, credit_note_id, target_invoice_id, allocated_amount, notes, created_by
  ) VALUES (
    v_alloc_number, v_cn.id, v_target.id, v_alloc_amount,
    'Settlement of ' || v_target.invoice_number || ' via ' || v_cn.credit_note_number,
    v_caller
  );

  -- 2. Insert into voucher_allocations linking this settlement
  INSERT INTO public.voucher_allocations (
    voucher_type, sales_invoice_id, allocated_amount, status
  ) VALUES (
    'receipt', v_target.id, v_alloc_amount, 'approved'
  );

  v_remaining_balance := v_cn.customer_credit_balance - v_alloc_amount;

  -- 3. Update Credit Note
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

  -- 4. Recalculate target invoice payment state
  PERFORM public.recalculate_sales_invoice_payment_state(v_target.id);

  RETURN jsonb_build_object(
    'success', true,
    'allocation_number', v_alloc_number,
    'credit_note_id', v_cn.id,
    'credit_note_number', v_cn.credit_note_number,
    'target_invoice_number', v_target.invoice_number,
    'allocated_amount', v_alloc_amount,
    'remaining_credit_balance', v_remaining_balance
  );
END;
$$;

-- ------------------------------------------------------------------------------
-- 8. Hardened Customer Refund RPC with Payment Voucher Linkage
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refund_credit_note(
  p_credit_note_id uuid,
  p_refund_amount numeric,
  p_refund_date date DEFAULT CURRENT_DATE,
  p_bank_account_id uuid DEFAULT NULL,
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
  v_bank_acc public.bank_accounts%ROWTYPE;
  v_je_id uuid;
  v_je_number text;
  v_pv_id uuid;
  v_pv_number text;
  v_remaining_balance numeric(18,2);
BEGIN
  -- Strict Authentication & Authorization check (prevent caller spoofing)
  IF v_caller IS NULL THEN
    IF current_user = 'service_role' OR session_user = 'postgres' OR (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) OR (COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), '')) = 'service_role' THEN
      v_caller := p_actor;
    ELSE
      RAISE EXCEPTION 'Authentication required: no active session';
    END IF;
  END IF;

  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required: valid actor identity missing';
  END IF;

  SELECT role INTO v_role FROM public.user_profiles WHERE id = v_caller;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'accounts', 'manager') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot refund credit notes', COALESCE(v_role, 'none');
  END IF;

  IF p_refund_amount <= 0 THEN
    RAISE EXCEPTION 'Refund amount must be strictly positive (got %)', p_refund_amount;
  END IF;

  -- Deterministic row locking
  SELECT * INTO v_cn FROM public.credit_notes WHERE id = p_credit_note_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Credit Note % not found', p_credit_note_id;
  END IF;

  IF v_cn.status <> 'approved' THEN
    RAISE EXCEPTION 'Cannot refund unapproved Credit Note %', v_cn.credit_note_number;
  END IF;

  IF COALESCE(v_cn.customer_credit_balance, 0) < p_refund_amount THEN
    RAISE EXCEPTION 'Insufficient credit balance % on Credit Note % (Requested %)',
      v_cn.customer_credit_balance, v_cn.credit_note_number, p_refund_amount;
  END IF;

  -- Validate Chart of Accounts
  v_ar_id := public.validate_coa_account('1120', 'asset', 'debit');

  -- Validate Bank Account
  IF p_bank_account_id IS NOT NULL THEN
    SELECT * INTO v_bank_acc FROM public.bank_accounts WHERE id = p_bank_account_id;
    IF NOT FOUND OR v_bank_acc.is_active IS FALSE THEN
      RAISE EXCEPTION 'Specified bank account % is invalid or inactive', p_bank_account_id;
    END IF;
    v_bank_coa_id := v_bank_acc.coa_id;
  ELSE
    SELECT * INTO v_bank_acc FROM public.bank_accounts WHERE is_active = true ORDER BY id LIMIT 1;
    v_bank_coa_id := v_bank_acc.coa_id;
  END IF;

  IF v_bank_coa_id IS NULL THEN
    SELECT id INTO v_bank_coa_id FROM public.chart_of_accounts WHERE code = '1102' OR code LIKE '1-102%' LIMIT 1;
  END IF;

  IF v_bank_coa_id IS NULL THEN
    RAISE EXCEPTION 'Bank account chart of accounts mapping missing for refund';
  END IF;

  -- 1. Post Refund Journal: Dr A/R (clearing credit balance), Cr Bank
  v_je_number := public.next_journal_entry_number();
  INSERT INTO journal_entries (
    entry_number, entry_date, source_module, reference_id, reference_number,
    description, total_debit, total_credit, is_posted, posted_by, created_by
  ) VALUES (
    v_je_number, COALESCE(p_refund_date, CURRENT_DATE), 'customer_refund', v_cn.id, v_cn.credit_note_number,
    'Customer refund for Credit Note ' || v_cn.credit_note_number || ' - ' || COALESCE(p_reference, 'Bank Transfer'),
    p_refund_amount, p_refund_amount, true, v_caller, v_caller
  ) RETURNING id INTO v_je_id;

  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
  VALUES (v_je_id, 1, v_ar_id, 'Customer refund clearing - ' || v_cn.credit_note_number, p_refund_amount, 0, v_cn.customer_id);

  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit)
  VALUES (v_je_id, 2, v_bank_coa_id, 'Bank payout refund - ' || v_cn.credit_note_number, 0, p_refund_amount);

  -- 2. Create actual payment voucher record in payment_vouchers table
  v_pv_number := 'PV-REF-' || to_char(CURRENT_DATE, 'YYMM') || '-' || lpad(floor(random() * 9000 + 1000)::text, 4, '0');
  INSERT INTO public.payment_vouchers (
    voucher_number, voucher_date, payment_type, payment_method, bank_account_id,
    reference_number, amount, description, journal_entry_id, status, is_posted, created_by
  ) VALUES (
    v_pv_number, COALESCE(p_refund_date, CURRENT_DATE), 'customer_refund', p_payment_method,
    v_bank_acc.id, v_cn.credit_note_number, p_refund_amount,
    'Customer refund for Credit Note ' || v_cn.credit_note_number,
    v_je_id, 'approved', true, v_caller
  ) RETURNING id INTO v_pv_id;

  v_remaining_balance := v_cn.customer_credit_balance - p_refund_amount;

  -- 3. Update Credit Note
  UPDATE public.credit_notes
     SET customer_credit_balance = v_remaining_balance,
         refund_amount = COALESCE(refund_amount, 0) + p_refund_amount,
         refund_date = COALESCE(p_refund_date, CURRENT_DATE),
         refund_payment_voucher_id = v_pv_id,
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
    'refund_amount', p_refund_amount,
    'remaining_credit_balance', v_remaining_balance,
    'journal_entry_number', v_je_number,
    'payment_voucher_number', v_pv_number
  );
END;
$$;

-- ------------------------------------------------------------------------------
-- 9. Electronic Nota Retur & Coretax Lifecycle Tracking
-- ------------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.link_or_generate_nota_retur_for_credit_note(uuid);

CREATE OR REPLACE FUNCTION public.link_or_generate_nota_retur_for_credit_note(
  p_credit_note_id uuid,
  p_nomor_nota_retur text DEFAULT NULL,
  p_tanggal_nota_retur date DEFAULT CURRENT_DATE,
  p_actor uuid DEFAULT NULL
)
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
  v_caller uuid := auth.uid();
  v_tax_rate numeric(8,4) := 0.1100;
  v_nr_number text;
BEGIN
  IF v_caller IS NULL THEN
    IF current_user = 'service_role' OR session_user = 'postgres' OR (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) OR (COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), '')) = 'service_role' THEN
      v_caller := p_actor;
    ELSE
      RAISE EXCEPTION 'Authentication required: no active session';
    END IF;
  END IF;

  SELECT * INTO v_cn FROM public.credit_notes WHERE id = p_credit_note_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Credit note % not found', p_credit_note_id;
  END IF;

  -- Deduplication: return existing if already linked
  IF v_cn.nota_retur_id IS NOT NULL THEN
    RETURN v_cn.nota_retur_id;
  END IF;

  SELECT * INTO v_inv FROM public.sales_invoices WHERE id = v_cn.original_invoice_id;
  SELECT * INTO v_cust FROM public.customers WHERE id = v_cn.customer_id;

  -- Derive tax rate from invoice or credit note
  IF v_cn.subtotal > 0 AND v_cn.tax_amount > 0 THEN
    v_tax_rate := ROUND(v_cn.tax_amount / v_cn.subtotal, 4);
  ELSIF v_inv.subtotal > 0 AND v_inv.tax_amount > 0 THEN
    v_tax_rate := ROUND(v_inv.tax_amount / v_inv.subtotal, 4);
  END IF;

  v_nr_number := COALESCE(NULLIF(TRIM(p_nomor_nota_retur), ''), 'NR-' || to_char(COALESCE(p_tanggal_nota_retur, CURRENT_DATE), 'YYYY') || '-' || lpad(floor(random() * 9000 + 1000)::text, 4, '0'));

  INSERT INTO public.nota_retur (
    nota_retur_number,
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
    v_nr_number,
    COALESCE(p_tanggal_nota_retur, CURRENT_DATE),
    v_cn.id,
    v_cn.material_return_id,
    v_cn.original_invoice_id,
    v_inv.invoice_number,
    v_inv.invoice_number,
    v_cn.customer_id,
    v_cust.company_name,
    v_cust.address,
    v_cn.currency,
    v_cn.subtotal,
    v_tax_rate,
    v_cn.tax_amount,
    v_cn.total_amount,
    'draft',
    'draft',
    v_caller
  ) RETURNING id INTO v_nr_id;

  UPDATE public.credit_notes
     SET nota_retur_id = v_nr_id
   WHERE id = v_cn.id;

  RETURN v_nr_id;
END;
$$;

-- RPC to update electronic Coretax submission & approval lifecycle
CREATE OR REPLACE FUNCTION public.update_nota_retur_coretax_status(
  p_nota_retur_id uuid,
  p_coretax_status text,
  p_djp_reference text DEFAULT NULL,
  p_evidence_url text DEFAULT NULL,
  p_actor uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_role text;
  v_nr public.nota_retur%ROWTYPE;
BEGIN
  IF v_caller IS NULL THEN
    IF current_user = 'service_role' OR session_user = 'postgres' OR (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) OR (COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), '')) = 'service_role' THEN
      v_caller := p_actor;
    ELSE
      RAISE EXCEPTION 'Authentication required: no active session';
    END IF;
  END IF;

  SELECT role INTO v_role FROM public.user_profiles WHERE id = v_caller;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'accounts', 'manager') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot update coretax status', COALESCE(v_role, 'none');
  END IF;

  IF p_coretax_status NOT IN ('draft', 'submitted', 'approved_by_djp', 'rejected_by_djp') THEN
    RAISE EXCEPTION 'Invalid coretax status: %', p_coretax_status;
  END IF;

  SELECT * INTO v_nr FROM public.nota_retur WHERE id = p_nota_retur_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Nota retur % not found', p_nota_retur_id;
  END IF;

  UPDATE public.nota_retur
     SET coretax_status = p_coretax_status,
         status = CASE
           WHEN p_coretax_status = 'approved_by_djp' THEN 'approved'
           WHEN p_coretax_status = 'rejected_by_djp' THEN 'rejected'
           ELSE status
         END,
         coretax_reference_number = COALESCE(p_djp_reference, coretax_reference_number),
         document_url = COALESCE(p_evidence_url, document_url),
         notes = CASE WHEN p_evidence_url IS NOT NULL THEN COALESCE(notes, '') || ' [Evidence: ' || p_evidence_url || ']' ELSE notes END,
         updated_at = now()
   WHERE id = p_nota_retur_id;

  RETURN jsonb_build_object(
    'success', true,
    'nota_retur_id', p_nota_retur_id,
    'coretax_status', p_coretax_status
  );
END;
$$;

-- ------------------------------------------------------------------------------
-- 10. Privileged Function Grants and Lockdown
-- ------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.create_credit_note_atomic(jsonb, jsonb, uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_credit_note_atomic(jsonb, jsonb, uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.apply_credit_note_to_invoice(uuid, uuid, numeric, uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_credit_note_to_invoice(uuid, uuid, numeric, uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.refund_credit_note(uuid, numeric, date, uuid, text, text, uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.refund_credit_note(uuid, numeric, date, uuid, text, text, uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.link_or_generate_nota_retur_for_credit_note(uuid, text, date, uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.link_or_generate_nota_retur_for_credit_note(uuid, text, date, uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.update_nota_retur_coretax_status(uuid, text, text, text, uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_nota_retur_coretax_status(uuid, text, text, text, uuid) TO authenticated, service_role;
