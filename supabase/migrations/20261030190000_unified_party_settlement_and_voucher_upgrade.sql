-- ==============================================================================
-- SAPJ ERP: UNIFIED RECEIPT & PAYMENT VOUCHER UPGRADE
-- Migration: 20261030190000_unified_party_settlement_and_voucher_upgrade.sql
-- Direction-based Party Settlement Engine (Customer, Supplier, Staff, Director, Other)
-- ==============================================================================

-- 1. Ensure Standard Settlement & Discount Accounts Exist in chart_of_accounts
INSERT INTO public.chart_of_accounts (code, name, account_type, normal_balance, is_active)
VALUES 
  ('5105', 'Purchase Discounts', 'expense', 'credit', true)
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.chart_of_accounts (code, name, account_type, normal_balance, is_active)
VALUES 
  ('6910', 'Settlement Discount & Rounding Difference', 'expense', 'debit', true)
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.chart_of_accounts (code, name, account_type, normal_balance, is_active)
VALUES 
  ('4915', 'Settlement Gain & Rounding Off', 'revenue', 'credit', true)
ON CONFLICT (code) DO NOTHING;


-- 2. Additive Columns on receipt_vouchers
ALTER TABLE public.receipt_vouchers
  ADD COLUMN IF NOT EXISTS party_type text DEFAULT 'customer',
  ADD COLUMN IF NOT EXISTS supplier_id uuid REFERENCES public.suppliers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS staff_id uuid REFERENCES public.finance_staff_master(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payment_purpose text DEFAULT 'invoice_payment',
  ADD COLUMN IF NOT EXISTS settlement_against text DEFAULT 'outstanding_balance',
  ADD COLUMN IF NOT EXISTS settlement_discount numeric(15,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS adjustment_reason text,
  ADD COLUMN IF NOT EXISTS adjustment_account_id uuid REFERENCES public.chart_of_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS adjustment_notes text;

CREATE INDEX IF NOT EXISTS idx_receipt_vouchers_party ON public.receipt_vouchers(party_type, customer_id, supplier_id);
CREATE INDEX IF NOT EXISTS idx_receipt_vouchers_supplier ON public.receipt_vouchers(supplier_id) WHERE supplier_id IS NOT NULL;


-- 3. Additive Columns on payment_vouchers
ALTER TABLE public.payment_vouchers
  ADD COLUMN IF NOT EXISTS party_type text DEFAULT 'supplier',
  ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS settlement_against text DEFAULT 'outstanding_balance',
  ADD COLUMN IF NOT EXISTS settlement_discount numeric(15,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS adjustment_reason text,
  ADD COLUMN IF NOT EXISTS adjustment_account_id uuid REFERENCES public.chart_of_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS adjustment_notes text;

CREATE INDEX IF NOT EXISTS idx_payment_vouchers_party ON public.payment_vouchers(party_type, supplier_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_payment_vouchers_customer ON public.payment_vouchers(customer_id) WHERE customer_id IS NOT NULL;


-- 4. Additive Columns on voucher_allocations
ALTER TABLE public.voucher_allocations
  ADD COLUMN IF NOT EXISTS settlement_discount numeric(15,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS adjustment_reason text,
  ADD COLUMN IF NOT EXISTS notes text;


-- 5. RPC: get_party_balance_summary
CREATE OR REPLACE FUNCTION public.get_party_balance_summary(
  p_party_type text,
  p_party_id text,
  p_as_of_date date DEFAULT CURRENT_DATE
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uuid uuid;
  v_party_type text := lower(trim(p_party_type));
  v_total_receivable numeric(15,2) := 0;
  v_total_payable numeric(15,2) := 0;
  v_unallocated_credits numeric(15,2) := 0;
  v_unallocated_advances numeric(15,2) := 0;
  v_net_balance numeric(15,2) := 0;
  v_direction text := 'zero';
  v_open_docs jsonb := '[]'::jsonb;
  v_doc record;
  v_gl_balance numeric(15,2) := 0;
BEGIN
  IF p_party_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_uuid := p_party_id::uuid;
  END IF;

  IF v_party_type = 'customer' AND v_uuid IS NOT NULL THEN
    -- Open Sales Invoices
    SELECT COALESCE(SUM(balance_amount), 0)
    INTO v_total_receivable
    FROM public.sales_invoices
    WHERE customer_id = v_uuid
      AND is_draft = false
      AND document_status = 'posted'
      AND payment_status IN ('unpaid', 'partial', 'pending')
      AND invoice_date <= p_as_of_date;

    -- Unallocated Receipts / Customer Advances
    SELECT COALESCE(SUM(rv.amount - COALESCE(va.allocated, 0)), 0)
    INTO v_unallocated_credits
    FROM public.receipt_vouchers rv
    LEFT JOIN (
      SELECT receipt_voucher_id, SUM(allocated_amount) as allocated
      FROM public.voucher_allocations
      GROUP BY receipt_voucher_id
    ) va ON va.receipt_voucher_id = rv.id
    WHERE rv.customer_id = v_uuid
      AND rv.is_posted = true
      AND rv.voucher_date <= p_as_of_date
      AND (rv.amount - COALESCE(va.allocated, 0)) > 0.01;

    -- Net Balance = Receivables (Dr) - Credits (Cr)
    v_net_balance := v_total_receivable - v_unallocated_credits;

    -- Build open documents array
    FOR v_doc IN (
      SELECT id, invoice_number as doc_number, invoice_date as doc_date, total_amount, balance_amount, 'sales_invoice' as doc_type
      FROM public.sales_invoices
      WHERE customer_id = v_uuid
        AND is_draft = false
        AND document_status = 'posted'
        AND payment_status IN ('unpaid', 'partial', 'pending')
        AND invoice_date <= p_as_of_date
      ORDER BY invoice_date ASC
    ) LOOP
      v_open_docs := v_open_docs || jsonb_build_object(
        'id', v_doc.id,
        'document_type', v_doc.doc_type,
        'document_number', v_doc.doc_number,
        'document_date', v_doc.doc_date,
        'total_amount', v_doc.total_amount,
        'balance_amount', v_doc.balance_amount
      );
    END LOOP;

  ELSIF v_party_type = 'supplier' AND v_uuid IS NOT NULL THEN
    -- Open Purchase Invoices
    SELECT COALESCE(SUM(balance_amount), 0)
    INTO v_total_payable
    FROM public.purchase_invoices
    WHERE supplier_id = v_uuid
      AND status IN ('pending', 'partial', 'unpaid', 'approved')
      AND invoice_date <= p_as_of_date;

    -- Open Approved Expenses (A/P)
    v_total_payable := v_total_payable + COALESCE((
      SELECT SUM(COALESCE(fe.amount, 0) + COALESCE(fe.ppn_amount, 0) - COALESCE(fe.pph_amount, 0) - COALESCE(fe.paid_amount, 0))
      FROM public.finance_expenses fe
      WHERE fe.supplier_id = v_uuid
        AND fe.approval_status = 'approved'
        AND fe.payment_method IS NULL
        AND fe.expense_category NOT IN ('pib_import', 'import_broker', 'loading_import', 'port_charges')
        AND fe.expense_date <= p_as_of_date
    ), 0);

    -- Unallocated Payment Vouchers (Supplier Advances / Overpayments)
    SELECT COALESCE(SUM(pv.amount - COALESCE(va.allocated, 0)), 0)
    INTO v_unallocated_advances
    FROM public.payment_vouchers pv
    LEFT JOIN (
      SELECT payment_voucher_id, SUM(allocated_amount) as allocated
      FROM public.voucher_allocations
      GROUP BY payment_voucher_id
    ) va ON va.payment_voucher_id = pv.id
    WHERE pv.supplier_id = v_uuid
      AND pv.is_posted = true
      AND pv.voucher_date <= p_as_of_date
      AND (pv.amount - COALESCE(va.allocated, 0)) > 0.01;

    -- Unallocated outgoing bank statement lines for this supplier
    v_unallocated_advances := v_unallocated_advances + COALESCE((
      SELECT SUM(bsl.debit_amount - COALESCE(bsa.allocated, 0))
      FROM public.bank_statement_lines bsl
      JOIN public.suppliers s ON s.id = v_uuid
      LEFT JOIN (
        SELECT bank_statement_line_id, SUM(allocation_amount) as allocated
        FROM public.bank_statement_allocations
        GROUP BY bank_statement_line_id
      ) bsa ON bsa.bank_statement_line_id = bsl.id
      WHERE bsl.debit_amount > 0
        AND bsl.transaction_date <= p_as_of_date
        AND (bsl.debit_amount - COALESCE(bsa.allocated, 0)) > 0.01
        AND bsl.description ILIKE ('%' || s.company_name || '%')
    ), 0);

    -- Check General Ledger Account 2110 for supplier running position
    SELECT COALESCE(SUM(jel.credit) - SUM(jel.debit), 0)
    INTO v_gl_balance
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
    WHERE jel.supplier_id = v_uuid
      AND coa.code = '2110'
      AND je.is_posted = true
      AND NOT COALESCE(je.is_reversed, false)
      AND je.entry_date <= p_as_of_date;

    -- Net Balance: if total_payable > 0 and unallocated_advances == 0, payable dominates.
    -- If supplier has overpayment / unallocated payment, unallocated_advances dominates.
    IF v_total_payable > 0 AND v_unallocated_advances = 0 THEN
      v_net_balance := v_total_payable;
    ELSIF v_unallocated_advances > 0 AND v_total_payable = 0 THEN
      v_net_balance := -v_unallocated_advances;
    ELSE
      v_net_balance := v_total_payable - v_unallocated_advances;
    END IF;

    -- Build open documents array for supplier
    FOR v_doc IN (
      SELECT id, invoice_number as doc_number, invoice_date as doc_date, total_amount, balance_amount, 'purchase_invoice' as doc_type
      FROM public.purchase_invoices
      WHERE supplier_id = v_uuid
        AND status IN ('pending', 'partial', 'unpaid', 'approved')
        AND invoice_date <= p_as_of_date
      UNION ALL
      SELECT id, COALESCE(voucher_number, invoice_number) as doc_number, expense_date as doc_date,
             (amount + COALESCE(ppn_amount,0) - COALESCE(pph_amount,0)) as total_amount,
             (amount + COALESCE(ppn_amount,0) - COALESCE(pph_amount,0) - COALESCE(paid_amount,0)) as balance_amount,
             'expense_bill' as doc_type
      FROM public.finance_expenses
      WHERE supplier_id = v_uuid
        AND approval_status = 'approved'
        AND payment_method IS NULL
        AND expense_category NOT IN ('pib_import', 'import_broker', 'loading_import', 'port_charges')
        AND expense_date <= p_as_of_date
      ORDER BY doc_date ASC
    ) LOOP
      v_open_docs := v_open_docs || jsonb_build_object(
        'id', v_doc.id,
        'document_type', v_doc.doc_type,
        'document_number', v_doc.doc_number,
        'document_date', v_doc.doc_date,
        'total_amount', v_doc.total_amount,
        'balance_amount', v_doc.balance_amount
      );
    END LOOP;

  ELSIF v_party_type = 'employee' AND v_uuid IS NOT NULL THEN
    -- Staff Advances (Asset 1160)
    SELECT COALESCE(SUM(jel.debit) - SUM(jel.credit), 0)
    INTO v_net_balance
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
    WHERE (jel.payee_id = v_uuid OR jel.description ILIKE ('%' || p_party_id || '%'))
      AND coa.code = '1160'
      AND je.is_posted = true
      AND NOT COALESCE(je.is_reversed, false)
      AND je.entry_date <= p_as_of_date;

  ELSIF v_party_type = 'director' THEN
    -- Director Loan (Liability 2105)
    SELECT COALESCE(SUM(jel.credit) - SUM(jel.debit), 0)
    INTO v_net_balance
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
    WHERE coa.code = '2105'
      AND je.is_posted = true
      AND NOT COALESCE(je.is_reversed, false)
      AND je.entry_date <= p_as_of_date;
  END IF;

  IF v_net_balance > 0.005 THEN
    v_direction := 'debit';
  ELSIF v_net_balance < -0.005 THEN
    v_direction := 'credit';
  ELSE
    v_direction := 'zero';
  END IF;

  RETURN jsonb_build_object(
    'party_type', v_party_type,
    'party_id', p_party_id,
    'total_receivable', v_total_receivable,
    'total_payable', v_total_payable,
    'unallocated_credits', v_unallocated_credits,
    'unallocated_advances', v_unallocated_advances,
    'gl_balance', v_gl_balance,
    'net_balance', v_net_balance,
    'balance_direction', v_direction,
    'outstanding_amount', abs(v_net_balance),
    'open_documents', v_open_docs
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_party_balance_summary TO authenticated, service_role;


-- 6. RPC: save_receipt_voucher_with_allocations (Upgraded)
CREATE OR REPLACE FUNCTION public.save_receipt_voucher_with_allocations(
  p_receipt_id uuid DEFAULT NULL::uuid,
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_allocations jsonb DEFAULT '[]'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
  v_alloc jsonb;
  v_bank_currency text;
  v_currency text;
  v_rate numeric;
  v_actor uuid;
  v_party_type text;
  v_customer_id uuid;
  v_supplier_id uuid;
  v_staff_id uuid;
  v_purpose text;
  v_settle_against text;
  v_settle_disc numeric;
  v_adj_reason text;
  v_adj_account_id uuid;
  v_adj_notes text;
BEGIN
  PERFORM public._sec_check_finance_role();
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    IF current_user = 'service_role' OR session_user = 'postgres' OR (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN
      v_actor := COALESCE(NULLIF(p_payload->>'created_by','')::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid);
    END IF;
  END IF;

  v_party_type := lower(COALESCE(NULLIF(p_payload->>'party_type',''), 'customer'));
  IF v_party_type NOT IN ('customer', 'supplier', 'employee', 'director', 'other') THEN
    RAISE EXCEPTION 'Unsupported party type %', v_party_type;
  END IF;

  v_customer_id := NULLIF(p_payload->>'customer_id','')::uuid;
  v_supplier_id := NULLIF(p_payload->>'supplier_id','')::uuid;
  v_staff_id := NULLIF(p_payload->>'staff_id','')::uuid;

  IF v_party_type = 'customer' AND v_customer_id IS NULL THEN
    RAISE EXCEPTION 'Customer is required for customer receipt';
  END IF;

  IF v_party_type = 'supplier' AND v_supplier_id IS NULL THEN
    RAISE EXCEPTION 'Supplier is required for supplier refund receipt';
  END IF;

  IF v_party_type = 'employee' AND v_staff_id IS NULL THEN
    RAISE EXCEPTION 'Staff member is required for employee receipt';
  END IF;

  IF COALESCE((p_payload->>'amount')::numeric, 0) <= 0 THEN
    RAISE EXCEPTION 'Receipt amount must be greater than zero';
  END IF;

  v_purpose := COALESCE(NULLIF(p_payload->>'payment_purpose',''), CASE v_party_type WHEN 'supplier' THEN 'supplier_refund' ELSE 'invoice_payment' END);
  v_settle_against := COALESCE(NULLIF(p_payload->>'settlement_against',''), 'outstanding_balance');
  v_settle_disc := COALESCE(NULLIF(p_payload->>'settlement_discount','')::numeric, 0);
  v_adj_reason := NULLIF(p_payload->>'adjustment_reason','');
  v_adj_account_id := NULLIF(p_payload->>'adjustment_account_id','')::uuid;
  v_adj_notes := NULLIF(p_payload->>'adjustment_notes','');

  IF v_settle_disc <> 0 AND (v_adj_reason IS NULL OR trim(v_adj_reason) = '') THEN
    RAISE EXCEPTION 'Adjustment reason is mandatory when settlement discount/difference is non-zero';
  END IF;

  SELECT upper(currency) INTO v_bank_currency
  FROM public.bank_accounts
  WHERE id = NULLIF(p_payload->>'bank_account_id','')::uuid;

  v_currency := upper(COALESCE(NULLIF(p_payload->>'transaction_currency',''), v_bank_currency, 'IDR'));
  v_rate := COALESCE(NULLIF((p_payload->>'exchange_rate')::numeric, 0), CASE WHEN v_currency='IDR' THEN 1 ELSE NULL END);

  IF v_rate IS NULL OR v_rate <= 0 OR (v_currency = 'USD' AND v_rate <= 1) THEN
    RAISE EXCEPTION 'A valid exchange rate is required for % receipts', v_currency;
  END IF;

  IF v_bank_currency IS NOT NULL AND v_bank_currency <> v_currency THEN
    RAISE EXCEPTION 'Receipt currency % does not match selected bank currency %', v_currency, v_bank_currency;
  END IF;

  IF p_receipt_id IS NULL THEN
    INSERT INTO public.receipt_vouchers(
      voucher_number,
      voucher_date,
      party_type,
      customer_id,
      supplier_id,
      staff_id,
      payment_method,
      payment_purpose,
      settlement_against,
      settlement_discount,
      adjustment_reason,
      adjustment_account_id,
      adjustment_notes,
      bank_account_id,
      reference_number,
      amount,
      description,
      created_by,
      currency_code,
      transaction_currency,
      functional_currency,
      exchange_rate,
      bank_account_currency,
      payment_currency
    ) VALUES (
      public.next_receipt_voucher_number((p_payload->>'voucher_date')::date),
      (p_payload->>'voucher_date')::date,
      v_party_type,
      v_customer_id,
      v_supplier_id,
      v_staff_id,
      COALESCE(NULLIF(p_payload->>'payment_method',''), 'bank_transfer'),
      v_purpose,
      v_settle_against,
      v_settle_disc,
      v_adj_reason,
      v_adj_account_id,
      v_adj_notes,
      NULLIF(p_payload->>'bank_account_id','')::uuid,
      NULLIF(p_payload->>'reference_number',''),
      (p_payload->>'amount')::numeric,
      NULLIF(p_payload->>'description',''),
      v_actor,
      v_currency,
      v_currency,
      'IDR',
      v_rate,
      COALESCE(v_bank_currency, v_currency),
      v_currency
    ) RETURNING id INTO v_id;
  ELSE
    IF EXISTS (SELECT 1 FROM public.receipt_vouchers WHERE id = p_receipt_id AND is_posted = true) THEN
      RAISE EXCEPTION 'Cannot edit a posted receipt voucher. Cancel posting first.';
    END IF;

    UPDATE public.receipt_vouchers SET
      voucher_date          = (p_payload->>'voucher_date')::date,
      party_type            = v_party_type,
      customer_id           = v_customer_id,
      supplier_id           = v_supplier_id,
      staff_id              = v_staff_id,
      payment_purpose       = v_purpose,
      settlement_against    = v_settle_against,
      settlement_discount   = v_settle_disc,
      adjustment_reason     = v_adj_reason,
      adjustment_account_id = v_adj_account_id,
      adjustment_notes      = v_adj_notes,
      payment_method        = COALESCE(NULLIF(p_payload->>'payment_method',''), 'bank_transfer'),
      bank_account_id       = NULLIF(p_payload->>'bank_account_id','')::uuid,
      reference_number      = NULLIF(p_payload->>'reference_number',''),
      amount                = (p_payload->>'amount')::numeric,
      description           = NULLIF(p_payload->>'description',''),
      currency_code         = v_currency,
      transaction_currency  = v_currency,
      functional_currency   = 'IDR',
      exchange_rate         = v_rate,
      bank_account_currency = COALESCE(v_bank_currency, v_currency),
      payment_currency      = v_currency,
      updated_at            = now()
    WHERE id = p_receipt_id
    RETURNING id INTO v_id;

    DELETE FROM public.voucher_allocations WHERE receipt_voucher_id = v_id;
  END IF;

  FOR v_alloc IN SELECT value FROM jsonb_array_elements(COALESCE(p_allocations,'[]'::jsonb)) LOOP
    IF COALESCE((v_alloc->>'amount')::numeric, 0) > 0 THEN
      INSERT INTO public.voucher_allocations(
        voucher_type,
        receipt_voucher_id,
        sales_invoice_id,
        sales_order_id,
        allocated_amount,
        settlement_discount,
        adjustment_reason,
        notes
      ) VALUES (
        'receipt',
        v_id,
        NULLIF(v_alloc->>'sales_invoice_id','')::uuid,
        NULLIF(v_alloc->>'sales_order_id','')::uuid,
        (v_alloc->>'amount')::numeric,
        COALESCE((v_alloc->>'settlement_discount')::numeric, 0),
        NULLIF(v_alloc->>'adjustment_reason',''),
        NULLIF(v_alloc->>'notes','')
      );
    END IF;
  END LOOP;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.save_receipt_voucher_with_allocations TO authenticated, service_role;


-- 7. RPC: save_payment_voucher_with_allocations (Upgraded)
CREATE OR REPLACE FUNCTION public.save_payment_voucher_with_allocations(
  p_voucher_id uuid DEFAULT NULL::uuid,
  p_voucher_number text DEFAULT NULL::text,
  p_voucher_date date DEFAULT NULL::date,
  p_supplier_id uuid DEFAULT NULL::uuid,
  p_payment_method text DEFAULT NULL::text,
  p_bank_account_id uuid DEFAULT NULL::uuid,
  p_reference_number text DEFAULT NULL::text,
  p_amount numeric DEFAULT 0,
  p_pph_amount numeric DEFAULT 0,
  p_pph_code_id uuid DEFAULT NULL::uuid,
  p_description text DEFAULT NULL::text,
  p_payment_currency text DEFAULT 'IDR'::text,
  p_exchange_rate numeric DEFAULT 1,
  p_bank_amount numeric DEFAULT NULL::numeric,
  p_bank_charge numeric DEFAULT 0,
  p_created_by uuid DEFAULT NULL::uuid,
  p_allocations jsonb DEFAULT '[]'::jsonb,
  p_staff_id uuid DEFAULT NULL::uuid,
  p_payment_purpose text DEFAULT 'general'::text,
  p_party_type text DEFAULT 'supplier'::text,
  p_customer_id uuid DEFAULT NULL::uuid,
  p_settlement_against text DEFAULT 'outstanding_balance'::text,
  p_settlement_discount numeric DEFAULT 0,
  p_adjustment_reason text DEFAULT NULL::text,
  p_adjustment_account_id uuid DEFAULT NULL::uuid,
  p_adjustment_notes text DEFAULT NULL::text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_voucher_id UUID;
  v_alloc JSONB;
  v_alloc_amount NUMERIC;
  v_invoice_id UUID;
  v_expense_id UUID;
  v_creator UUID;
  v_purpose TEXT := COALESCE(p_payment_purpose, 'general');
  v_party_type TEXT := lower(COALESCE(p_party_type, 'supplier'));
BEGIN
  PERFORM public._sec_check_finance_role();
  v_creator := auth.uid();
  IF v_creator IS NULL THEN
    IF current_user = 'service_role' OR session_user = 'postgres' OR (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN
      v_creator := COALESCE(p_created_by, 'a0000000-0000-0000-0000-000000000001'::uuid);
    END IF;
  END IF;

  IF v_party_type = 'supplier' AND p_supplier_id IS NULL AND p_staff_id IS NULL THEN
    RAISE EXCEPTION 'Supplier is required for supplier payment';
  END IF;

  IF v_party_type = 'customer' AND p_customer_id IS NULL THEN
    RAISE EXCEPTION 'Customer is required for customer refund payment';
  END IF;

  IF v_party_type = 'employee' AND p_staff_id IS NULL THEN
    RAISE EXCEPTION 'Staff member is required for employee payment';
  END IF;

  IF p_settlement_discount <> 0 AND (p_adjustment_reason IS NULL OR trim(p_adjustment_reason) = '') THEN
    RAISE EXCEPTION 'Adjustment reason is mandatory when settlement discount/difference is non-zero';
  END IF;

  IF p_voucher_id IS NULL THEN
    INSERT INTO payment_vouchers (
      voucher_number, voucher_date, party_type, supplier_id, customer_id, staff_id, payment_method,
      bank_account_id, reference_number, amount, pph_amount, pph_code_id,
      description, payment_currency, exchange_rate,
      bank_amount, bank_charge, created_by,
      payment_purpose, salary_advance_status,
      settlement_against, settlement_discount, adjustment_reason, adjustment_account_id, adjustment_notes
    ) VALUES (
      p_voucher_number, p_voucher_date, v_party_type, p_supplier_id, p_customer_id, p_staff_id, COALESCE(NULLIF(p_payment_method,''), 'bank_transfer'),
      p_bank_account_id, p_reference_number, p_amount, p_pph_amount, p_pph_code_id,
      p_description, p_payment_currency, p_exchange_rate,
      p_bank_amount, p_bank_charge, v_creator,
      v_purpose,
      CASE v_purpose WHEN 'salary_advance' THEN 'outstanding' ELSE 'not_applicable' END,
      p_settlement_against, p_settlement_discount, p_adjustment_reason, p_adjustment_account_id, p_adjustment_notes
    ) RETURNING id INTO v_voucher_id;
  ELSE
    v_voucher_id := p_voucher_id;

    IF EXISTS (SELECT 1 FROM payment_vouchers WHERE id = v_voucher_id AND is_posted = TRUE) THEN
      RAISE EXCEPTION 'Cannot edit: % is posted. Cancel Posting first to make changes.', p_voucher_number;
    END IF;

    UPDATE payment_vouchers SET
      voucher_date          = p_voucher_date,
      party_type            = v_party_type,
      supplier_id           = p_supplier_id,
      customer_id           = p_customer_id,
      staff_id              = p_staff_id,
      payment_method        = COALESCE(NULLIF(p_payment_method,''), 'bank_transfer'),
      bank_account_id       = p_bank_account_id,
      reference_number      = p_reference_number,
      amount                = p_amount,
      pph_amount            = p_pph_amount,
      pph_code_id           = p_pph_code_id,
      description           = p_description,
      payment_currency      = p_payment_currency,
      exchange_rate         = p_exchange_rate,
      bank_amount           = p_bank_amount,
      bank_charge           = p_bank_charge,
      payment_purpose       = v_purpose,
      salary_advance_status = CASE v_purpose WHEN 'salary_advance' THEN 'outstanding' ELSE 'not_applicable' END,
      settlement_against    = p_settlement_against,
      settlement_discount   = p_settlement_discount,
      adjustment_reason     = p_adjustment_reason,
      adjustment_account_id = p_adjustment_account_id,
      adjustment_notes      = p_adjustment_notes,
      updated_at            = NOW()
    WHERE id = v_voucher_id;
  END IF;

  DELETE FROM voucher_allocations WHERE payment_voucher_id = v_voucher_id;

  FOR v_alloc IN SELECT value FROM jsonb_array_elements(p_allocations) AS value
  LOOP
    v_alloc_amount := COALESCE((v_alloc->>'amount')::NUMERIC, 0);
    IF v_alloc_amount <= 0 THEN
      CONTINUE;
    END IF;

    v_invoice_id := NULLIF(v_alloc->>'invoice_id', '')::UUID;
    v_expense_id := NULLIF(v_alloc->>'finance_expense_id', '')::UUID;

    IF v_invoice_id IS NOT NULL THEN
      INSERT INTO voucher_allocations (
        payment_voucher_id, purchase_invoice_id,
        allocated_amount, allocated_currency, voucher_type,
        settlement_discount, adjustment_reason, notes
      ) VALUES (
        v_voucher_id, v_invoice_id, v_alloc_amount,
        COALESCE(v_alloc->>'currency', 'IDR'), 'payment',
        COALESCE((v_alloc->>'settlement_discount')::NUMERIC, 0),
        NULLIF(v_alloc->>'adjustment_reason', ''),
        NULLIF(v_alloc->>'notes', '')
      );
    ELSIF v_expense_id IS NOT NULL THEN
      INSERT INTO voucher_allocations (
        payment_voucher_id, finance_expense_id,
        allocated_amount, allocated_currency, voucher_type,
        settlement_discount, adjustment_reason, notes
      ) VALUES (
        v_voucher_id, v_expense_id, v_alloc_amount,
        COALESCE(v_alloc->>'currency', 'IDR'), 'payment',
        COALESCE((v_alloc->>'settlement_discount')::NUMERIC, 0),
        NULLIF(v_alloc->>'adjustment_reason', ''),
        NULLIF(v_alloc->>'notes', '')
      );
    END IF;
  END LOOP;

  RETURN v_voucher_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.save_payment_voucher_with_allocations TO authenticated, service_role;


-- 8. RPC: save_payment_voucher_command (Upgraded)
CREATE OR REPLACE FUNCTION public.save_payment_voucher_command(
  p_voucher_id uuid DEFAULT NULL::uuid,
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_allocations jsonb DEFAULT '[]'::jsonb,
  p_payment_purpose text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_number text;
  v_id uuid;
  v_date date := (p_payload->>'voucher_date')::date;
  v_payment_currency text := upper(COALESCE(NULLIF(p_payload->>'payment_currency',''),'IDR'));
  v_invoice_currency text := upper(COALESCE(
    NULLIF(p_payload->>'invoice_currency',''),
    NULLIF((SELECT COALESCE(a->>'currency',a->>'allocated_currency')
            FROM jsonb_array_elements(COALESCE(p_allocations,'[]'::jsonb)) a
            WHERE COALESCE(a->>'currency',a->>'allocated_currency') IS NOT NULL LIMIT 1),''),
    v_payment_currency));
  v_bank_currency text;
  v_rate numeric := COALESCE(NULLIF(p_payload->>'exchange_rate','')::numeric,1);
  v_invoice_amount numeric := COALESCE(NULLIF(p_payload->>'invoice_amount','')::numeric,
    NULLIF(p_payload->>'amount','')::numeric,0);
  v_payment_amount numeric := COALESCE(NULLIF(p_payload->>'payment_amount','')::numeric,
    v_invoice_amount-COALESCE(NULLIF(p_payload->>'pph_amount','')::numeric,0));
  v_converted numeric;
  v_actual numeric;
  v_bank_charge numeric := COALESCE(NULLIF(p_payload->>'bank_charge','')::numeric,0);
  v_docs text[];
  v_purpose text := COALESCE(p_payment_purpose, NULLIF(p_payload->>'payment_purpose',''), 'general');
  v_party_type text := lower(COALESCE(NULLIF(p_payload->>'party_type',''), 'supplier'));
  v_customer_id uuid := NULLIF(p_payload->>'customer_id','')::uuid;
  v_supplier_id uuid := NULLIF(p_payload->>'supplier_id','')::uuid;
  v_staff_id uuid := NULLIF(p_payload->>'staff_id','')::uuid;
  v_settle_against text := COALESCE(NULLIF(p_payload->>'settlement_against',''), 'outstanding_balance');
  v_settle_disc numeric := COALESCE(NULLIF(p_payload->>'settlement_discount','')::numeric, 0);
  v_adj_reason text := NULLIF(p_payload->>'adjustment_reason','');
  v_adj_account_id uuid := NULLIF(p_payload->>'adjustment_account_id','')::uuid;
  v_adj_notes text := NULLIF(p_payload->>'adjustment_notes','');
BEGIN
  PERFORM public._sec_check_finance_role();
  SELECT upper(currency) INTO v_bank_currency FROM public.bank_accounts
   WHERE id=NULLIF(p_payload->>'bank_account_id','')::uuid;
  v_bank_currency:=COALESCE(v_bank_currency,v_payment_currency);
  IF v_payment_currency NOT IN('IDR','USD') OR v_invoice_currency NOT IN('IDR','USD')
     OR v_bank_currency NOT IN('IDR','USD') OR v_rate<=0 THEN
    RAISE EXCEPTION 'Payment currencies or exchange rate are invalid';
  END IF;
  v_converted:=COALESCE(NULLIF(p_payload->>'converted_amount','')::numeric,
    v_payment_amount*CASE WHEN v_invoice_currency=v_bank_currency THEN 1 ELSE v_rate END);
  v_actual:=COALESCE(NULLIF(p_payload->>'actual_bank_debit','')::numeric,
    NULLIF(p_payload->>'bank_amount','')::numeric,v_converted+v_bank_charge);
  IF v_actual<=0 AND v_invoice_amount>0 THEN RAISE EXCEPTION 'Actual bank debit must be positive'; END IF;
  SELECT COALESCE(array_agg(value),ARRAY[]::text[]) INTO v_docs
    FROM jsonb_array_elements_text(COALESCE(p_payload->'document_urls','[]'::jsonb));

  SELECT voucher_number INTO v_number FROM public.payment_vouchers WHERE id=p_voucher_id;
  v_number:=COALESCE(v_number,public.next_payment_voucher_number(v_date));

  v_id:=public.save_payment_voucher_with_allocations(
    p_voucher_id=>p_voucher_id,
    p_voucher_number=>v_number,
    p_voucher_date=>v_date,
    p_supplier_id=>v_supplier_id,
    p_payment_method=>p_payload->>'payment_method',
    p_bank_account_id=>NULLIF(p_payload->>'bank_account_id','')::uuid,
    p_reference_number=>NULLIF(p_payload->>'reference_number',''),
    p_amount=>v_invoice_amount,
    p_pph_amount=>COALESCE(NULLIF(p_payload->>'pph_amount','')::numeric,0),
    p_pph_code_id=>NULLIF(p_payload->>'pph_code_id','')::uuid,
    p_description=>NULLIF(p_payload->>'description',''),
    p_payment_currency=>v_payment_currency,
    p_exchange_rate=>v_rate,
    p_bank_amount=>v_actual,
    p_bank_charge=>v_bank_charge,
    p_created_by=>COALESCE(NULLIF(p_payload->>'created_by','')::uuid,auth.uid()),
    p_allocations=>p_allocations,
    p_staff_id=>v_staff_id,
    p_payment_purpose=>v_purpose,
    p_party_type=>v_party_type,
    p_customer_id=>v_customer_id,
    p_settlement_against=>v_settle_against,
    p_settlement_discount=>v_settle_disc,
    p_adjustment_reason=>v_adj_reason,
    p_adjustment_account_id=>v_adj_account_id,
    p_adjustment_notes=>v_adj_notes
  );

  UPDATE public.payment_vouchers SET
    invoice_currency=v_invoice_currency,
    invoice_amount=v_invoice_amount,
    payment_amount=v_payment_amount,
    payment_currency=v_payment_currency,
    transaction_currency=v_invoice_currency,
    functional_currency='IDR',
    exchange_rate=v_rate,
    bank_currency=v_bank_currency,
    bank_account_currency=v_bank_currency,
    converted_amount=v_converted,
    actual_bank_debit=v_actual,
    bank_amount=v_actual,
    document_urls=NULLIF(v_docs,ARRAY[]::text[])
  WHERE id=v_id;

  RETURN jsonb_build_object('id',v_id,'voucher_number',v_number);
END;
$$;

GRANT EXECUTE ON FUNCTION public.save_payment_voucher_command TO authenticated, service_role;


-- 9. RPC: save_payment_voucher_with_purpose (Upgraded)
CREATE OR REPLACE FUNCTION public.save_payment_voucher_with_purpose(
  p_voucher_id uuid DEFAULT NULL::uuid,
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_allocations jsonb DEFAULT '[]'::jsonb,
  p_payment_purpose text DEFAULT 'general'::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
  v_purpose text := COALESCE(p_payment_purpose, NULLIF(p_payload->>'payment_purpose',''), 'general');
BEGIN
  PERFORM public._sec_check_finance_role();

  IF v_purpose NOT IN (
    'general',
    'salary_advance',
    'salary_advance_settlement',
    'supplier_invoice_payment',
    'supplier_advance',
    'supplier_overpayment_settlement',
    'supplier_other_payment',
    'customer_refund',
    'customer_excess_payment_refund',
    'customer_advance_refund',
    'customer_other_payment',
    'salary_payroll',
    'employee_reimbursement',
    'employee_advance',
    'other_employee_payment',
    'director_loan_repayment',
    'director_withdrawal',
    'other_related_party_payment',
    'other_payment'
  ) THEN
    RAISE EXCEPTION 'Unsupported payment purpose %', v_purpose;
  END IF;

  v_result := public.save_payment_voucher_command(
    p_voucher_id,
    p_payload,
    p_allocations,
    v_purpose
  );

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.save_payment_voucher_with_purpose TO authenticated, service_role;


-- 10. RPC: post_receipt_voucher (Upgraded for Direction-Based Party Settlement)
CREATE OR REPLACE FUNCTION public.post_receipt_voucher(
  p_rv_id uuid,
  p_posted_by uuid DEFAULT NULL::uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rv                 RECORD;
  v_je_id              UUID;
  v_je_number          TEXT;
  v_bank_account_id    UUID;
  v_credit_account_id  UUID;
  v_diff_account_id    UUID;
  v_actual_poster      UUID;
  v_rate               NUMERIC := 1;
  v_actual_received    NUMERIC;
  v_settle_diff        NUMERIC := 0;
  v_carrying_amount    NUMERIC := 0;
  v_total_debit        NUMERIC;
  v_total_credit       NUMERIC;
  v_line               INTEGER := 1;
  v_currency           TEXT;
  v_party_type         TEXT;
BEGIN
  PERFORM public._sec_check_finance_role();
  v_actual_poster := auth.uid();
  IF v_actual_poster IS NULL THEN
    v_actual_poster := COALESCE(p_posted_by, 'a0000000-0000-0000-0000-000000000001'::uuid);
  END IF;

  SELECT * INTO v_rv FROM public.receipt_vouchers WHERE id = p_rv_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Receipt voucher % not found', p_rv_id; END IF;
  IF v_rv.is_posted THEN RAISE EXCEPTION 'Receipt voucher % is already posted', v_rv.voucher_number; END IF;

  v_party_type := lower(COALESCE(v_rv.party_type, 'customer'));
  v_currency := UPPER(COALESCE(v_rv.payment_currency, v_rv.transaction_currency, 'IDR'));
  v_rate := COALESCE(v_rv.exchange_rate, 1);
  IF v_rate <= 0 THEN v_rate := 1; END IF;

  -- Resolve Bank / Cash Debit Account
  IF v_rv.bank_account_id IS NOT NULL THEN
    SELECT coa_id INTO v_bank_account_id FROM public.bank_accounts WHERE id = v_rv.bank_account_id;
  ELSIF v_rv.payment_method = 'cash' THEN
    SELECT id INTO v_bank_account_id FROM public.chart_of_accounts WHERE code = '1101' LIMIT 1;
  END IF;
  IF v_bank_account_id IS NULL THEN
    SELECT id INTO v_bank_account_id FROM public.chart_of_accounts WHERE code = '1110' LIMIT 1;
  END IF;
  IF v_bank_account_id IS NULL THEN
    SELECT id INTO v_bank_account_id FROM public.chart_of_accounts WHERE code = '1111' LIMIT 1;
  END IF;
  IF v_bank_account_id IS NULL THEN
    RAISE EXCEPTION 'Bank or Cash GL account could not be resolved for voucher %', v_rv.voucher_number;
  END IF;

  v_actual_received := COALESCE(v_rv.settlement_amount, v_rv.amount * v_rate);
  v_settle_diff := COALESCE(v_rv.settlement_discount, 0);

  -- Resolve Credit Control Account based on party type and purpose
  IF v_party_type = 'customer' THEN
    IF v_rv.coa_account_id IS NOT NULL THEN
      v_credit_account_id := v_rv.coa_account_id;
    ELSIF v_rv.payment_purpose IN ('customer_advance', 'excess_payment') THEN
      SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '2140' LIMIT 1;
      IF v_credit_account_id IS NULL THEN
        SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '1120' LIMIT 1;
      END IF;
    ELSE
      SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '1120' LIMIT 1;
    END IF;

    -- Customer settlement discount / write-off account
    IF v_settle_diff <> 0 THEN
      IF v_rv.adjustment_account_id IS NOT NULL THEN
        v_diff_account_id := v_rv.adjustment_account_id;
      ELSE
        SELECT id INTO v_diff_account_id FROM public.chart_of_accounts WHERE code = '4200' LIMIT 1; -- Sales Discounts
        IF v_diff_account_id IS NULL THEN
          SELECT id INTO v_diff_account_id FROM public.chart_of_accounts WHERE code = '6910' LIMIT 1;
        END IF;
      END IF;
    END IF;

    v_carrying_amount := v_actual_received + v_settle_diff;

  ELSIF v_party_type = 'supplier' THEN
    -- Supplier Refund Received / Overpayment Recovery:
    -- Dr Bank (cash received)
    -- Dr Settlement Difference / Write-off (if refund received is less than debit balance)
    -- Cr Accounts Payable 2110 (clearing supplier debit balance)
    IF v_rv.coa_account_id IS NOT NULL THEN
      v_credit_account_id := v_rv.coa_account_id;
    ELSE
      SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '2110' LIMIT 1;
    END IF;

    IF v_settle_diff <> 0 THEN
      IF v_rv.adjustment_account_id IS NOT NULL THEN
        v_diff_account_id := v_rv.adjustment_account_id;
      ELSE
        SELECT id INTO v_diff_account_id FROM public.chart_of_accounts WHERE code = '6910' LIMIT 1; -- Settlement Discount & Rounding Difference
        IF v_diff_account_id IS NULL THEN
          SELECT id INTO v_diff_account_id FROM public.chart_of_accounts WHERE code = '6900' LIMIT 1;
        END IF;
      END IF;
    END IF;

    v_carrying_amount := v_actual_received + v_settle_diff;

  ELSIF v_party_type = 'employee' THEN
    SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '1160' LIMIT 1; -- Staff Advances & Loans
    IF v_credit_account_id IS NULL THEN
      SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '1120' LIMIT 1;
    END IF;
    v_carrying_amount := v_actual_received;

  ELSIF v_party_type = 'director' THEN
    SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '2105' LIMIT 1; -- Director Loan
    IF v_credit_account_id IS NULL THEN
      SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '2110' LIMIT 1;
    END IF;
    v_carrying_amount := v_actual_received;

  ELSE
    -- Other
    IF v_rv.coa_account_id IS NOT NULL THEN
      v_credit_account_id := v_rv.coa_account_id;
    ELSE
      SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '4910' LIMIT 1; -- Miscellaneous Income
    END IF;
    v_carrying_amount := v_actual_received;
  END IF;

  IF v_credit_account_id IS NULL THEN
    RAISE EXCEPTION 'Credit account could not be resolved for receipt %', v_rv.voucher_number;
  END IF;

  -- Balanced Journal Totals
  v_total_debit := v_actual_received + CASE WHEN v_settle_diff > 0 THEN v_settle_diff ELSE 0 END;
  v_total_credit := v_carrying_amount + CASE WHEN v_settle_diff < 0 THEN abs(v_settle_diff) ELSE 0 END;

  v_je_number := public.next_journal_entry_number();

  INSERT INTO public.journal_entries (
    entry_number, entry_date, source_module, reference_id, reference_number,
    description, total_debit, total_credit, is_posted, posted_by,
    transaction_currency, functional_currency, exchange_rate
  ) VALUES (
    v_je_number, v_rv.voucher_date, 'receipt', v_rv.id, v_rv.voucher_number,
    'Receipt Voucher (' || v_party_type || '): ' || v_rv.voucher_number,
    v_total_debit, v_total_credit, TRUE, v_actual_poster,
    v_currency, 'IDR', v_rate
  ) RETURNING id INTO v_je_id;

  -- Line 1: Debit Bank / Cash with actual cash received
  INSERT INTO public.journal_entry_lines (
    journal_entry_id, line_number, account_id, description, debit, credit,
    customer_id, supplier_id, payee_id, transaction_currency, exchange_rate
  ) VALUES (
    v_je_id, v_line, v_bank_account_id,
    'Cash Receipt - ' || v_rv.voucher_number,
    v_actual_received, 0,
    v_rv.customer_id, v_rv.supplier_id, v_rv.staff_id, v_currency, v_rate
  );
  v_line := v_line + 1;

  -- Line 2: Debit Settlement Difference / Discount (if discount/write-off given/taken)
  IF v_settle_diff > 0 AND v_diff_account_id IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines (
      journal_entry_id, line_number, account_id, description, debit, credit,
      customer_id, supplier_id, payee_id, transaction_currency, exchange_rate
    ) VALUES (
      v_je_id, v_line, v_diff_account_id,
      COALESCE(v_rv.adjustment_reason, 'Settlement adjustment') || ' - ' || v_rv.voucher_number,
      v_settle_diff, 0,
      v_rv.customer_id, v_rv.supplier_id, v_rv.staff_id, v_currency, v_rate
    );
    v_line := v_line + 1;
  END IF;

  -- Line 3: Credit Party Control Account with Full Carrying Amount (closing party balance)
  INSERT INTO public.journal_entry_lines (
    journal_entry_id, line_number, account_id, description, debit, credit,
    customer_id, supplier_id, payee_id, transaction_currency, exchange_rate
  ) VALUES (
    v_je_id, v_line, v_credit_account_id,
    CASE 
      WHEN v_party_type = 'supplier' THEN 'Supplier Refund Settlement - '
      WHEN v_party_type = 'employee' THEN 'Staff Advance Recovery - '
      WHEN v_party_type = 'director' THEN 'Director Funding - '
      ELSE 'Customer Receipt - '
    END || v_rv.voucher_number,
    0, v_carrying_amount,
    v_rv.customer_id, v_rv.supplier_id, v_rv.staff_id, v_currency, v_rate
  );
  v_line := v_line + 1;

  -- Recalculate Sales Invoice states if allocations were linked
  IF v_party_type = 'customer' THEN
    PERFORM public.recalculate_sales_invoice_payment_state(va.sales_invoice_id)
    FROM public.voucher_allocations va
    WHERE va.receipt_voucher_id = p_rv_id AND va.sales_invoice_id IS NOT NULL;
  END IF;

  UPDATE public.receipt_vouchers
  SET is_posted = TRUE, journal_entry_id = v_je_id
  WHERE id = p_rv_id;

  INSERT INTO public.audit_logs (table_name, record_id, action_type, old_values, new_values, user_id)
  VALUES (
    'receipt_vouchers', p_rv_id, 'update',
    jsonb_build_object('is_posted', FALSE),
    jsonb_build_object('is_posted', TRUE, 'journal_entry_id', v_je_id, 'journal_entry_number', v_je_number, 'posted_by', v_actual_poster),
    v_actual_poster
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.post_receipt_voucher TO authenticated, service_role;


-- 11. RPC: post_payment_voucher (Upgraded for Direction-Based Party Settlement)
CREATE OR REPLACE FUNCTION public.post_payment_voucher(
  p_pv_id uuid,
  p_posted_by uuid DEFAULT NULL::uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_pv                 RECORD;
  v_rate               NUMERIC := 1;
  v_gross              NUMERIC;
  v_payment            NUMERIC;
  v_converted          NUMERIC;
  v_pph_bank           NUMERIC;
  v_charge_amt         NUMERIC;
  v_actual             NUMERIC;
  v_expected           NUMERIC;
  v_bank_spread        NUMERIC;
  v_debit_amount       NUMERIC;
  v_settle_diff        NUMERIC := 0;
  v_total_debit        NUMERIC;
  v_total_credit       NUMERIC;
  v_entry              TEXT;
  v_je                 UUID;
  v_line               INTEGER := 1;
  v_debit_coa          UUID;
  v_bank_coa           UUID;
  v_charge_coa         UUID;
  v_pph_coa            UUID;
  v_diff_coa           UUID;
  v_invoice_currency   TEXT;
  v_bank_currency      TEXT;
  v_actual_poster      UUID;
  v_party_type         TEXT;
BEGIN
  PERFORM public._sec_check_finance_role();
  v_actual_poster := auth.uid();
  IF v_actual_poster IS NULL THEN
    v_actual_poster := COALESCE(p_posted_by, 'a0000000-0000-0000-0000-000000000001'::uuid);
  END IF;

  SELECT * INTO v_pv FROM public.payment_vouchers WHERE id = p_pv_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment voucher % not found', p_pv_id; END IF;
  IF v_pv.is_posted THEN RAISE EXCEPTION 'Payment voucher % is already posted', v_pv.voucher_number; END IF;

  v_party_type := lower(COALESCE(v_pv.party_type, 'supplier'));
  v_invoice_currency := upper(COALESCE(v_pv.invoice_currency, v_pv.transaction_currency, v_pv.payment_currency, 'IDR'));
  SELECT upper(currency) INTO v_bank_currency FROM public.bank_accounts WHERE id = v_pv.bank_account_id;
  v_bank_currency := COALESCE(v_bank_currency, v_pv.bank_currency, v_pv.payment_currency, 'IDR');
  
  v_rate := CASE WHEN v_invoice_currency = v_bank_currency THEN 1 ELSE COALESCE(v_pv.exchange_rate, 0) END;
  IF v_rate <= 0 THEN RAISE EXCEPTION 'Missing exchange rate for %', v_pv.voucher_number; END IF;

  v_gross := COALESCE(v_pv.invoice_amount, v_pv.amount, 0);
  v_payment := COALESCE(v_pv.payment_amount, v_gross - COALESCE(v_pv.pph_amount, 0));
  v_converted := COALESCE(v_pv.converted_amount, v_payment * v_rate);
  v_pph_bank := COALESCE(v_pv.pph_amount, 0) * v_rate;
  v_charge_amt := COALESCE(v_pv.bank_charge, 0);
  v_actual := COALESCE(v_pv.actual_bank_debit, v_pv.bank_amount, v_converted + v_charge_amt);
  v_settle_diff := COALESCE(v_pv.settlement_discount, 0);

  -- Bank GL Account
  SELECT coa_id INTO v_bank_coa FROM public.bank_accounts WHERE id = v_pv.bank_account_id;
  IF v_bank_coa IS NULL THEN
    SELECT id INTO v_bank_coa FROM public.chart_of_accounts WHERE code = '1110' LIMIT 1;
  END IF;

  -- Resolve Debit Control Account based on party type and purpose
  IF v_party_type = 'supplier' THEN
    IF v_pv.payment_purpose = 'salary_advance' THEN
      SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '1160' LIMIT 1;
    ELSIF v_pv.coa_account_id IS NOT NULL THEN
      v_debit_coa := v_pv.coa_account_id;
    ELSE
      SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '2110' LIMIT 1;
    END IF;

    -- Purchase discount / settlement difference
    IF v_settle_diff <> 0 THEN
      IF v_pv.adjustment_account_id IS NOT NULL THEN
        v_diff_coa := v_pv.adjustment_account_id;
      ELSE
        SELECT id INTO v_diff_coa FROM public.chart_of_accounts WHERE code = '5105' LIMIT 1; -- Purchase Discounts
        IF v_diff_coa IS NULL THEN
          SELECT id INTO v_diff_coa FROM public.chart_of_accounts WHERE code = '4915' LIMIT 1;
        END IF;
      END IF;
    END IF;

    v_debit_amount := (v_gross * v_rate) + v_settle_diff;

  ELSIF v_party_type = 'customer' THEN
    -- Customer Refund Paid:
    -- Dr Customer Deposits 2140 or AR 1120 (with customer_id)
    -- Cr Bank (cash paid)
    -- Cr Settlement Gain / Fee 4915 / 4910 (if refund paid is less than customer credit)
    IF v_pv.coa_account_id IS NOT NULL THEN
      v_debit_coa := v_pv.coa_account_id;
    ELSE
      SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '2140' LIMIT 1; -- Customer Deposits
      IF v_debit_coa IS NULL THEN
        SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '1120' LIMIT 1;
      END IF;
    END IF;

    IF v_settle_diff <> 0 THEN
      IF v_pv.adjustment_account_id IS NOT NULL THEN
        v_diff_coa := v_pv.adjustment_account_id;
      ELSE
        SELECT id INTO v_diff_coa FROM public.chart_of_accounts WHERE code = '4915' LIMIT 1; -- Settlement Gain & Rounding Off
        IF v_diff_coa IS NULL THEN
          SELECT id INTO v_diff_coa FROM public.chart_of_accounts WHERE code = '4910' LIMIT 1;
        END IF;
      END IF;
    END IF;

    v_debit_amount := (v_gross * v_rate) + v_settle_diff;

  ELSIF v_party_type = 'employee' THEN
    IF v_pv.payment_purpose = 'salary_advance' THEN
      SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '1160' LIMIT 1;
    ELSIF v_pv.coa_account_id IS NOT NULL THEN
      v_debit_coa := v_pv.coa_account_id;
    ELSE
      SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '6100' LIMIT 1; -- Salaries & Wages
      IF v_debit_coa IS NULL THEN
        SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '1160' LIMIT 1;
      END IF;
    END IF;
    v_debit_amount := v_gross * v_rate;

  ELSIF v_party_type = 'director' THEN
    SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '2105' LIMIT 1; -- Director Loan
    v_debit_amount := v_gross * v_rate;

  ELSE
    -- Other
    IF v_pv.coa_account_id IS NOT NULL THEN
      v_debit_coa := v_pv.coa_account_id;
    ELSE
      SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '6900' LIMIT 1; -- Misc Expense
    END IF;
    v_debit_amount := v_gross * v_rate;
  END IF;

  SELECT id INTO v_charge_coa FROM public.chart_of_accounts WHERE code = '6901' LIMIT 1;
  IF v_charge_coa IS NULL THEN SELECT id INTO v_charge_coa FROM public.chart_of_accounts WHERE code = '6900' LIMIT 1; END IF;

  SELECT id INTO v_pph_coa FROM public.chart_of_accounts WHERE code = '2132' LIMIT 1;

  v_total_debit := v_debit_amount + v_charge_amt;
  v_total_credit := v_actual + v_pph_bank + CASE WHEN v_settle_diff > 0 THEN v_settle_diff ELSE 0 END;

  v_entry := public.next_journal_entry_number();

  INSERT INTO public.journal_entries(
    entry_number, entry_date, source_module, reference_id, reference_number, description,
    total_debit, total_credit, is_posted, posted_by, transaction_currency, functional_currency, exchange_rate
  ) VALUES (
    v_entry, v_pv.voucher_date, 'payment', v_pv.id, v_pv.voucher_number,
    'Payment Voucher (' || v_party_type || '): ' || v_pv.voucher_number,
    v_total_debit, v_total_credit, true, v_actual_poster, v_invoice_currency, 'IDR', v_rate
  ) RETURNING id INTO v_je;

  -- Line 1: Debit Party Control Account (clearing AP / Customer Deposit / Staff Advance)
  INSERT INTO public.journal_entry_lines(
    journal_entry_id, line_number, account_id, description, debit, credit,
    transaction_currency, transaction_debit, transaction_credit, exchange_rate,
    supplier_id, customer_id, payee_id
  ) VALUES (
    v_je, v_line, v_debit_coa,
    CASE 
      WHEN v_party_type = 'customer' THEN 'Customer Refund - '
      WHEN v_party_type = 'employee' THEN 'Staff Payment - '
      WHEN v_party_type = 'director' THEN 'Director Loan Repayment - '
      ELSE 'Supplier Payment - '
    END || v_pv.voucher_number,
    v_debit_amount, 0,
    v_invoice_currency, (v_gross + v_settle_diff), 0, v_rate,
    v_pv.supplier_id, v_pv.customer_id, v_pv.staff_id
  );
  v_line := v_line + 1;

  -- Line 2: Bank Charge
  IF v_charge_amt > 0 AND v_charge_coa IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(
      journal_entry_id, line_number, account_id, description, debit, credit,
      transaction_currency, transaction_debit, transaction_credit, exchange_rate,
      supplier_id, customer_id, payee_id
    ) VALUES (
      v_je, v_line, v_charge_coa, 'Bank Charge - ' || v_pv.voucher_number, v_charge_amt, 0,
      v_bank_currency, v_charge_amt, 0, 1,
      v_pv.supplier_id, v_pv.customer_id, v_pv.staff_id
    );
    v_line := v_line + 1;
  END IF;

  -- Line 3: PPh Withholding
  IF v_pph_bank > 0 AND v_pph_coa IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(
      journal_entry_id, line_number, account_id, description, debit, credit,
      transaction_currency, transaction_debit, transaction_credit, exchange_rate,
      supplier_id, customer_id, payee_id
    ) VALUES (
      v_je, v_line, v_pph_coa, 'PPh Withholding - ' || v_pv.voucher_number, 0, v_pph_bank,
      v_bank_currency, 0, v_pv.pph_amount, v_rate,
      v_pv.supplier_id, v_pv.customer_id, v_pv.staff_id
    );
    v_line := v_line + 1;
  END IF;

  -- Line 4: Settlement Discount / Difference Credit (e.g. Purchase Discount or Fee kept)
  IF v_settle_diff > 0 AND v_diff_coa IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(
      journal_entry_id, line_number, account_id, description, debit, credit,
      transaction_currency, transaction_debit, transaction_credit, exchange_rate,
      supplier_id, customer_id, payee_id
    ) VALUES (
      v_je, v_line, v_diff_coa,
      COALESCE(v_pv.adjustment_reason, 'Settlement discount') || ' - ' || v_pv.voucher_number,
      0, v_settle_diff,
      v_bank_currency, 0, v_settle_diff, 1,
      v_pv.supplier_id, v_pv.customer_id, v_pv.staff_id
    );
    v_line := v_line + 1;
  END IF;

  -- Line 5: Credit Bank / Cash with actual cash paid
  INSERT INTO public.journal_entry_lines(
    journal_entry_id, line_number, account_id, description, debit, credit,
    transaction_currency, transaction_debit, transaction_credit, exchange_rate,
    supplier_id, customer_id, payee_id
  ) VALUES (
    v_je, v_line, v_bank_coa, 'Bank Payment - ' || v_pv.voucher_number, 0, v_actual,
    v_bank_currency, 0, v_actual, 1,
    v_pv.supplier_id, v_pv.customer_id, v_pv.staff_id
  );

  UPDATE public.payment_vouchers SET is_posted = true, journal_entry_id = v_je WHERE id = p_pv_id;

  INSERT INTO public.audit_logs(table_name, record_id, action_type, old_values, new_values, user_id)
  VALUES('payment_vouchers', p_pv_id, 'update', jsonb_build_object('is_posted', false), jsonb_build_object('is_posted', true, 'journal_entry_id', v_je), v_actual_poster);
END;
$$;

GRANT EXECUTE ON FUNCTION public.post_payment_voucher TO authenticated, service_role;
