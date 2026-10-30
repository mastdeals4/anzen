-- ==============================================================================
-- SAPJ ERP: Hardened Unified Settlement, Role Authorization & Party Balance Isolation
-- Migration: 20261030220000_harden_unified_settlement_and_party_isolation.sql
-- ==============================================================================

-- 1. Register pending and current migrations in supabase_migrations.schema_migrations (if tracker exists)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_schema = 'supabase_migrations' AND table_name = 'schema_migrations'
  ) THEN
    INSERT INTO supabase_migrations.schema_migrations (version) VALUES
      ('20261030190000'),
      ('20261030200000'),
      ('20261030210000'),
      ('20261030220000')
    ON CONFLICT (version) DO NOTHING;
  END IF;
END $$;

-- 1b. Ensure directors table structure exists for director loan account mapping
CREATE TABLE IF NOT EXISTS public.directors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  director_code varchar(50),
  full_name varchar(255) NOT NULL,
  designation varchar(100),
  email varchar(255),
  phone varchar(50),
  address text,
  capital_account_id uuid,
  loan_account_id uuid,
  drawings_account_id uuid,
  is_active boolean DEFAULT true,
  notes text,
  created_by uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 2. Hardened save_payment_voucher_with_allocations:
--    - Enforces valid party_type ('customer', 'supplier', 'employee', 'director', 'other')
--    - Enforces settlement_discount >= 0 (rejects negative discounts)
--    - Enforces allocation-level settlement_discount >= 0
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
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_voucher_id UUID;
  v_alloc JSONB;
  v_alloc_amount NUMERIC;
  v_alloc_discount NUMERIC;
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

  IF v_party_type NOT IN ('customer', 'supplier', 'employee', 'director', 'other') THEN
    RAISE EXCEPTION 'Unsupported party type %', v_party_type;
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

  IF p_settlement_discount < 0 THEN
    RAISE EXCEPTION 'Settlement discount cannot be negative';
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

    v_alloc_discount := COALESCE((v_alloc->>'settlement_discount')::NUMERIC, 0);
    IF v_alloc_discount < 0 THEN
      RAISE EXCEPTION 'Settlement discount cannot be negative';
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
        v_alloc_discount,
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
        v_alloc_discount,
        NULLIF(v_alloc->>'adjustment_reason', ''),
        NULLIF(v_alloc->>'notes', '')
      );
    END IF;
  END LOOP;

  RETURN v_voucher_id;
END;
$function$;

-- 3. Hardened save_receipt_voucher_with_allocations:
--    - Enforces settlement_discount >= 0 (rejects negative discounts)
--    - Enforces allocation-level settlement_discount >= 0
CREATE OR REPLACE FUNCTION public.save_receipt_voucher_with_allocations(
  p_receipt_id uuid DEFAULT NULL::uuid,
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_allocations jsonb DEFAULT '[]'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
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
  v_alloc_disc numeric;
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

  IF v_settle_disc < 0 THEN
    RAISE EXCEPTION 'Settlement discount cannot be negative';
  END IF;

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
      v_alloc_disc := COALESCE((v_alloc->>'settlement_discount')::numeric, 0);
      IF v_alloc_disc < 0 THEN
        RAISE EXCEPTION 'Settlement discount cannot be negative';
      END IF;

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
        v_alloc_disc,
        NULLIF(v_alloc->>'adjustment_reason',''),
        NULLIF(v_alloc->>'notes','')
      );
    END IF;
  END LOOP;

  RETURN v_id;
END;
$function$;

-- 4. Hardened get_party_balance_summary:
--    - Isolates director balance by specific director ID / individual loan account
--    - Isolates other party balance by specific payee_id
CREATE OR REPLACE FUNCTION public.get_party_balance_summary(
  p_party_type text,
  p_party_id text,
  p_as_of_date date DEFAULT CURRENT_DATE
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
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
    -- Isolated Director Loan balance by specific director ID / specific loan account
    DECLARE
      v_dir_loan_acc uuid;
    BEGIN
      IF v_uuid IS NOT NULL THEN
        SELECT loan_account_id INTO v_dir_loan_acc
        FROM public.directors
        WHERE id = v_uuid;
      END IF;

      SELECT COALESCE(SUM(jel.credit) - SUM(jel.debit), 0)
      INTO v_net_balance
      FROM public.journal_entry_lines jel
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
      WHERE (
        (v_dir_loan_acc IS NOT NULL AND jel.account_id = v_dir_loan_acc)
        OR (v_dir_loan_acc IS NULL AND v_uuid IS NOT NULL AND (coa.code = '2105' OR coa.code LIKE '2105%') AND jel.payee_id = v_uuid)
        OR (v_uuid IS NULL AND (coa.code = '2105' OR coa.code LIKE '2105%'))
      )
        AND je.is_posted = true
        AND NOT COALESCE(je.is_reversed, false)
        AND je.entry_date <= p_as_of_date;
    END;

  ELSIF v_party_type = 'other' THEN
    IF v_uuid IS NOT NULL THEN
      SELECT COALESCE(SUM(jel.credit) - SUM(jel.debit), 0)
      INTO v_net_balance
      FROM public.journal_entry_lines jel
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
      WHERE jel.payee_id = v_uuid
        AND je.is_posted = true
        AND NOT COALESCE(je.is_reversed, false)
        AND je.entry_date <= p_as_of_date;
    END IF;
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
$function$;

-- 5. Hardened prevent_receipt_allocation_overpayment:
--    - Enforces row-level lock on receipt_voucher FOR UPDATE
--    - Enforces row-level lock on sales_invoice FOR UPDATE if sales_invoice_id is provided
--    - Rejects overallocations exceeding invoice total amount
CREATE OR REPLACE FUNCTION public.prevent_receipt_allocation_overpayment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_receipt_amount numeric;
  v_existing numeric;
  v_si_total numeric;
  v_si_existing numeric;
BEGIN
  IF NEW.voucher_type <> 'receipt' OR NEW.receipt_voucher_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.sales_invoice_id IS NULL AND NEW.sales_order_id IS NULL THEN
    RAISE EXCEPTION 'Receipt allocation must reference a sales invoice or sales order';
  END IF;
  IF NEW.sales_invoice_id IS NOT NULL AND NEW.sales_order_id IS NOT NULL THEN
    RAISE EXCEPTION 'Receipt allocation cannot reference both a sales invoice and sales order';
  END IF;
  IF COALESCE(NEW.allocated_amount, 0) <= 0 THEN
    RAISE EXCEPTION 'Receipt allocation amount must be greater than zero';
  END IF;

  -- Lock the voucher while checking to make concurrent allocations safe.
  SELECT amount INTO v_receipt_amount
    FROM public.receipt_vouchers
   WHERE id = NEW.receipt_voucher_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Receipt voucher % not found', NEW.receipt_voucher_id;
  END IF;

  SELECT COALESCE(sum(allocated_amount), 0) INTO v_existing
    FROM public.voucher_allocations
   WHERE receipt_voucher_id = NEW.receipt_voucher_id
     AND voucher_type = 'receipt'
     AND (TG_OP <> 'UPDATE' OR id <> NEW.id);
  IF v_existing + NEW.allocated_amount > COALESCE(v_receipt_amount, 0) + 0.01 THEN
    RAISE EXCEPTION 'Receipt allocations exceed receipt amount (%, attempted %) ',
      v_receipt_amount, v_existing + NEW.allocated_amount;
  END IF;

  -- Lock the sales invoice and verify no over-allocation across concurrent transactions
  IF NEW.sales_invoice_id IS NOT NULL THEN
    SELECT total_amount INTO v_si_total
      FROM public.sales_invoices
     WHERE id = NEW.sales_invoice_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Sales invoice % not found', NEW.sales_invoice_id;
    END IF;

    SELECT COALESCE(sum(allocated_amount), 0) INTO v_si_existing
      FROM public.voucher_allocations
     WHERE sales_invoice_id = NEW.sales_invoice_id
       AND voucher_type = 'receipt'
       AND (TG_OP <> 'UPDATE' OR id <> NEW.id);

    IF v_si_existing + NEW.allocated_amount > COALESCE(v_si_total, 0) + 0.01 THEN
      RAISE EXCEPTION 'Receipt allocation exceeds sales invoice total amount (%, attempted %)',
        v_si_total, v_si_existing + NEW.allocated_amount;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

-- Ensure prevent_purchase_invoice_payment_overallocation function exists
CREATE OR REPLACE FUNCTION public.prevent_purchase_invoice_payment_overallocation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_total numeric;
  v_existing numeric;
BEGIN
  IF NEW.voucher_type <> 'payment' OR NEW.purchase_invoice_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT total_amount INTO v_total
    FROM public.purchase_invoices
   WHERE id = NEW.purchase_invoice_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase invoice % not found', NEW.purchase_invoice_id;
  END IF;

  SELECT COALESCE(SUM(allocated_amount), 0) INTO v_existing
    FROM public.voucher_allocations
   WHERE purchase_invoice_id = NEW.purchase_invoice_id
     AND voucher_type = 'payment'
     AND (TG_OP <> 'UPDATE' OR id <> NEW.id);

  IF v_existing + NEW.allocated_amount > COALESCE(v_total, 0) + 0.01 THEN
    RAISE EXCEPTION 'Payment allocation exceeds Purchase Invoice outstanding amount';
  END IF;

  RETURN NEW;
END;
$function$;

-- Ensure allocation overpayment triggers are active on voucher_allocations
DROP TRIGGER IF EXISTS trg_prevent_receipt_allocation_overpayment ON public.voucher_allocations;
CREATE TRIGGER trg_prevent_receipt_allocation_overpayment
BEFORE INSERT OR UPDATE ON public.voucher_allocations
FOR EACH ROW EXECUTE FUNCTION public.prevent_receipt_allocation_overpayment();

DROP TRIGGER IF EXISTS trg_prevent_purchase_invoice_payment_overallocation ON public.voucher_allocations;
CREATE TRIGGER trg_prevent_purchase_invoice_payment_overallocation
BEFORE INSERT OR UPDATE ON public.voucher_allocations
FOR EACH ROW EXECUTE FUNCTION public.prevent_purchase_invoice_payment_overallocation();

-- 6. Role Authorization & Privilege Hardening:
--    - Revoke all public / anonymous execution
--    - Grant strictly to authenticated and service_role
REVOKE ALL ON FUNCTION public.get_party_balance_summary(text, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_party_balance_summary(text, text, date) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.save_payment_voucher_with_allocations(
  uuid, text, date, uuid, text, uuid, text, numeric, numeric, uuid, text, text, numeric, numeric, numeric, uuid, jsonb, uuid, text, text, uuid, text, numeric, text, uuid, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_payment_voucher_with_allocations(
  uuid, text, date, uuid, text, uuid, text, numeric, numeric, uuid, text, text, numeric, numeric, numeric, uuid, jsonb, uuid, text, text, uuid, text, numeric, text, uuid, text
) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.save_receipt_voucher_with_allocations(uuid, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_receipt_voucher_with_allocations(uuid, jsonb, jsonb) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.post_receipt_voucher(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_receipt_voucher(uuid, uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.post_payment_voucher(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_payment_voucher(uuid, uuid) TO authenticated, service_role;
