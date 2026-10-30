-- ==============================================================================
-- SAPJ ERP: Supplier Refund Authoritative Validation & Accounting Integrity Fix
-- Migration: 20261030235000_supplier_refund_authoritative_validation_and_accounting_integrity.sql
-- ==============================================================================

-- 1. Register migration in schema tracker
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_schema = 'supabase_migrations' AND table_name = 'schema_migrations'
  ) THEN
    INSERT INTO supabase_migrations.schema_migrations (version) VALUES
      ('20261030235000')
    ON CONFLICT (version) DO NOTHING;
  END IF;
END $$;

-- 2. Relax legacy customer-only check constraint on receipt_vouchers to support suppliers/staff/directors
ALTER TABLE public.receipt_vouchers DROP CONSTRAINT IF EXISTS rv_customer_or_account_required;
ALTER TABLE public.receipt_vouchers DROP CONSTRAINT IF EXISTS rv_party_or_account_required;
ALTER TABLE public.receipt_vouchers ADD CONSTRAINT rv_party_or_account_required 
  CHECK (customer_id IS NOT NULL OR supplier_id IS NOT NULL OR staff_id IS NOT NULL OR coa_account_id IS NOT NULL);

-- 3. Update get_party_balance_summary() with robust bank statement supplier matching
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
  v_party_type text := lower(trim(COALESCE(p_party_type, '')));
  v_total_receivable numeric(15,2) := 0;
  v_total_payable numeric(15,2) := 0;
  v_raw_credits numeric(15,2) := 0;
  v_customer_refunds numeric(15,2) := 0;
  v_unallocated_credits numeric(15,2) := 0;
  v_raw_advances numeric(15,2) := 0;
  v_supplier_refunds numeric(15,2) := 0;
  v_unallocated_advances numeric(15,2) := 0;
  v_net_balance numeric(15,2) := 0;
  v_direction text := 'zero';
  v_open_docs jsonb := '[]'::jsonb;
  v_doc record;
  v_gl_balance numeric(15,2) := 0;
BEGIN
  -- Server-side authorization check: admin and accounts roles only
  PERFORM public._sec_check_finance_role();

  IF p_party_id IS NOT NULL AND p_party_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_uuid := p_party_id::uuid;
  END IF;

  IF v_party_type = 'customer' THEN
    IF v_uuid IS NULL THEN
      RAISE EXCEPTION 'A valid customer ID is required';
    END IF;

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
    SELECT COALESCE(SUM((rv.amount * COALESCE(rv.exchange_rate, 1)) - COALESCE(va.allocated, 0)), 0)
    INTO v_raw_credits
    FROM public.receipt_vouchers rv
    LEFT JOIN (
      SELECT receipt_voucher_id, SUM(allocated_amount) as allocated
      FROM public.voucher_allocations
      GROUP BY receipt_voucher_id
    ) va ON va.receipt_voucher_id = rv.id
    WHERE rv.customer_id = v_uuid
      AND rv.is_posted = true
      AND rv.voucher_date <= p_as_of_date
      AND ((rv.amount * COALESCE(rv.exchange_rate, 1)) - COALESCE(va.allocated, 0)) > 0.01;

    -- Unallocated incoming bank statement lines for this customer
    v_raw_credits := v_raw_credits + COALESCE((
      SELECT SUM(bsl.credit_amount - COALESCE(bsa.allocated, 0))
      FROM public.bank_statement_lines bsl
      JOIN public.customers c ON c.id = v_uuid
      LEFT JOIN (
        SELECT bank_statement_line_id, SUM(allocation_amount) as allocated
        FROM public.bank_statement_allocations
        GROUP BY bank_statement_line_id
      ) bsa ON bsa.bank_statement_line_id = bsl.id
      WHERE bsl.credit_amount > 0
        AND bsl.transaction_date <= p_as_of_date
        AND (bsl.credit_amount - COALESCE(bsa.allocated, 0)) > 0.01
        AND (
          bsl.description ILIKE ('%' || c.company_name || '%')
          OR bsl.description ILIKE ('%' || trim(regexp_replace(c.company_name, '^(PT[.]?|CV[.]?)[[:space:]]*|[[:space:]]*(PT[.]?|CV[.]?)$', '', 'gi')) || '%')
        )
    ), 0);

    -- Outgoing Customer Refunds (Payment Vouchers to Customer)
    SELECT COALESCE(SUM(
      (pv.amount * COALESCE(pv.exchange_rate, 1)) + COALESCE(pv.settlement_discount, 0)
    ), 0)
    INTO v_customer_refunds
    FROM public.payment_vouchers pv
    WHERE pv.customer_id = v_uuid
      AND pv.party_type = 'customer'
      AND pv.is_posted = true
      AND pv.voucher_date <= p_as_of_date;

    -- Net unallocated credits after deducting customer refunds paid
    v_unallocated_credits := GREATEST(v_raw_credits - v_customer_refunds, 0);

    -- Net Balance = Receivables (Dr) minus Net Credits (Cr)
    v_net_balance := v_total_receivable - (v_raw_credits - v_customer_refunds);

    -- Check General Ledger Account 1120 for customer running position
    SELECT COALESCE(SUM(jel.debit) - SUM(jel.credit), 0)
    INTO v_gl_balance
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
    WHERE jel.customer_id = v_uuid
      AND coa.code = '1120'
      AND je.is_posted = true
      AND NOT COALESCE(je.is_reversed, false)
      AND je.entry_date <= p_as_of_date;

    -- Build open documents array for customer
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

  ELSIF v_party_type = 'supplier' THEN
    IF v_uuid IS NULL THEN
      RAISE EXCEPTION 'A valid supplier ID is required';
    END IF;

    -- Open Purchase Invoices
    SELECT COALESCE(SUM(balance_amount), 0)
    INTO v_total_payable
    FROM public.purchase_invoices
    WHERE supplier_id = v_uuid
      AND status IN ('pending', 'partial', 'unpaid', 'approved')
      AND invoice_date <= p_as_of_date;

    -- Open Finance Expense Bills
    v_total_payable := v_total_payable + COALESCE((
      SELECT SUM(amount + COALESCE(ppn_amount,0) - COALESCE(pph_amount,0) - COALESCE(paid_amount,0))
      FROM public.finance_expenses fe
      WHERE fe.supplier_id = v_uuid
        AND fe.approval_status = 'approved'
        AND fe.payment_method IS NULL
        AND fe.expense_category NOT IN ('pib_import', 'import_broker', 'loading_import', 'port_charges')
        AND fe.expense_date <= p_as_of_date
    ), 0);

    -- Unallocated Payment Vouchers (Supplier Advances / Overpayments)
    SELECT COALESCE(SUM((pv.amount * COALESCE(pv.exchange_rate, 1)) - COALESCE(va.allocated, 0)), 0)
    INTO v_raw_advances
    FROM public.payment_vouchers pv
    LEFT JOIN (
      SELECT payment_voucher_id, SUM(allocated_amount) as allocated
      FROM public.voucher_allocations
      GROUP BY payment_voucher_id
    ) va ON va.payment_voucher_id = pv.id
    WHERE pv.supplier_id = v_uuid
      AND pv.is_posted = true
      AND pv.voucher_date <= p_as_of_date
      AND ((pv.amount * COALESCE(pv.exchange_rate, 1)) - COALESCE(va.allocated, 0)) > 0.01;

    -- Unallocated outgoing bank statement lines for this supplier (with robust name matching)
    v_raw_advances := v_raw_advances + COALESCE((
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
        AND (
          bsl.description ILIKE ('%' || s.company_name || '%')
          OR bsl.description ILIKE ('%' || trim(regexp_replace(s.company_name, '^(PT[.]?|CV[.]?)[[:space:]]*|[[:space:]]*(PT[.]?|CV[.]?)$', '', 'gi')) || '%')
        )
    ), 0);

    -- Incoming Supplier Refunds (Receipt Vouchers from Supplier)
    SELECT COALESCE(SUM(
      (rv.amount * COALESCE(rv.exchange_rate, 1)) + COALESCE(rv.settlement_discount, 0)
    ), 0)
    INTO v_supplier_refunds
    FROM public.receipt_vouchers rv
    WHERE rv.supplier_id = v_uuid
      AND rv.party_type = 'supplier'
      AND rv.is_posted = true
      AND rv.voucher_date <= p_as_of_date;

    -- Net unallocated advances after deducting supplier refunds received
    v_unallocated_advances := GREATEST(v_raw_advances - v_supplier_refunds, 0);

    -- Net Balance: total_payable minus net advances
    v_net_balance := v_total_payable - (v_raw_advances - v_supplier_refunds);

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

  ELSIF v_party_type = 'employee' THEN
    IF v_uuid IS NULL THEN
      RAISE EXCEPTION 'A valid staff ID is required';
    END IF;

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
    IF v_uuid IS NULL THEN
      RAISE EXCEPTION 'A valid director ID is required for director balance query';
    END IF;

    DECLARE
      v_dir_loan_acc uuid;
      v_dir_exists boolean;
    BEGIN
      SELECT true, loan_account_id INTO v_dir_exists, v_dir_loan_acc
      FROM public.directors
      WHERE id = v_uuid;

      IF NOT COALESCE(v_dir_exists, false) THEN
        RAISE EXCEPTION 'Director with ID % not found', p_party_id;
      END IF;

      SELECT COALESCE(SUM(jel.credit) - SUM(jel.debit), 0)
      INTO v_net_balance
      FROM public.journal_entry_lines jel
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
      WHERE (
        (v_dir_loan_acc IS NOT NULL AND jel.account_id = v_dir_loan_acc)
        OR (v_dir_loan_acc IS NULL AND (coa.code = '2105' OR coa.code LIKE '2105%') AND jel.payee_id = v_uuid)
      )
        AND je.is_posted = true
        AND NOT COALESCE(je.is_reversed, false)
        AND je.entry_date <= p_as_of_date;
    END;

  ELSE
    RAISE EXCEPTION 'Unsupported party type: %. Must be customer, supplier, employee, or director.', p_party_type;
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

REVOKE ALL ON FUNCTION public.get_party_balance_summary(text, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_party_balance_summary(text, text, date) TO authenticated, service_role;


-- 3. Update post_receipt_voucher() with Authoritative Supplier Refund Validation
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
  v_avail_advances     NUMERIC := 0;
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

  v_actual_received := COALESCE(v_rv.settlement_amount, v_rv.amount * v_rate);
  v_settle_diff := COALESCE(v_rv.settlement_discount, 0);

  -- Validate settlement adjustment
  IF v_settle_diff < 0 THEN
    RAISE EXCEPTION 'Settlement discount cannot be negative';
  END IF;
  IF v_settle_diff > 0 AND (v_rv.adjustment_reason IS NULL OR trim(v_rv.adjustment_reason) = '') THEN
    RAISE EXCEPTION 'Adjustment reason is mandatory when settlement discount/difference is non-zero';
  END IF;
  IF v_rv.adjustment_account_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.chart_of_accounts WHERE id = v_rv.adjustment_account_id AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Adjustment account % does not exist or is inactive', v_rv.adjustment_account_id;
  END IF;

  -- ==============================================================================
  -- AUTHORITATIVE CONCURRENCY & BALANCE VALIDATION FOR SUPPLIER REFUND
  -- ==============================================================================
  IF v_party_type = 'supplier' AND v_rv.supplier_id IS NOT NULL THEN
    -- Lock the supplier row FOR UPDATE to strictly serialize concurrent refund postings
    PERFORM id FROM public.suppliers WHERE id = v_rv.supplier_id FOR UPDATE;

    -- 1. Calculate available unallocated supplier advances from payment vouchers
    SELECT COALESCE(SUM((pv.amount * COALESCE(pv.exchange_rate, 1)) - COALESCE(va.allocated, 0)), 0)
    INTO v_avail_advances
    FROM public.payment_vouchers pv
    LEFT JOIN (
      SELECT payment_voucher_id, SUM(allocated_amount) as allocated
      FROM public.voucher_allocations
      GROUP BY payment_voucher_id
    ) va ON va.payment_voucher_id = pv.id
    WHERE pv.supplier_id = v_rv.supplier_id
      AND pv.is_posted = true;

    -- 2. Include unallocated outgoing bank statement lines for this supplier (robust company name matching)
    v_avail_advances := v_avail_advances + COALESCE((
      SELECT SUM(bsl.debit_amount - COALESCE(bsa.allocated, 0))
      FROM public.bank_statement_lines bsl
      JOIN public.suppliers s ON s.id = v_rv.supplier_id
      LEFT JOIN (
        SELECT bank_statement_line_id, SUM(allocation_amount) as allocated
        FROM public.bank_statement_allocations
        GROUP BY bank_statement_line_id
      ) bsa ON bsa.bank_statement_line_id = bsl.id
      WHERE bsl.debit_amount > 0
        AND (bsl.debit_amount - COALESCE(bsa.allocated, 0)) > 0.01
        AND (
          bsl.description ILIKE ('%' || s.company_name || '%')
          OR bsl.description ILIKE ('%' || trim(regexp_replace(s.company_name, '^(PT[.]?|CV[.]?)[[:space:]]*|[[:space:]]*(PT[.]?|CV[.]?)$', '', 'gi')) || '%')
        )
    ), 0);

    -- 3. Deduct previously posted supplier refund receipts
    v_avail_advances := v_avail_advances - COALESCE((
      SELECT SUM((rv2.amount * COALESCE(rv2.exchange_rate, 1)) + COALESCE(rv2.settlement_discount, 0))
      FROM public.receipt_vouchers rv2
      WHERE rv2.supplier_id = v_rv.supplier_id
        AND rv2.party_type = 'supplier'
        AND rv2.is_posted = true
        AND rv2.id <> v_rv.id
    ), 0);

    -- 4. Authoritative check:
    -- Regardless of whether settlement_against is 'advance' or 'outstanding_balance',
    -- a supplier refund settling an advance must NEVER exceed the available refundable balance,
    -- and must be strictly rejected when the available refundable advance is zero or negative!
    IF v_avail_advances <= 0.005 THEN
      RAISE EXCEPTION 'No refundable supplier advance balance available for supplier (refundable advance balance is 0.00). Transaction rejected.';
    ELSIF (v_actual_received + v_settle_diff) > (v_avail_advances + 0.01) THEN
      RAISE EXCEPTION 'Supplier refund total settlement (%) exceeds available refundable advance balance (%)',
        (v_actual_received + v_settle_diff), v_avail_advances;
    END IF;
  END IF;

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

    IF v_settle_diff <> 0 THEN
      IF v_rv.adjustment_account_id IS NOT NULL THEN
        v_diff_account_id := v_rv.adjustment_account_id;
      ELSE
        SELECT id INTO v_diff_account_id FROM public.chart_of_accounts WHERE code = '4200' LIMIT 1;
        IF v_diff_account_id IS NULL THEN
          SELECT id INTO v_diff_account_id FROM public.chart_of_accounts WHERE code = '6910' LIMIT 1;
        END IF;
      END IF;
    END IF;

    v_carrying_amount := v_actual_received + v_settle_diff;

  ELSIF v_party_type = 'supplier' THEN
    IF v_rv.coa_account_id IS NOT NULL THEN
      v_credit_account_id := v_rv.coa_account_id;
    ELSE
      SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '2110' LIMIT 1;
    END IF;

    IF v_settle_diff <> 0 THEN
      IF v_rv.adjustment_account_id IS NOT NULL THEN
        v_diff_account_id := v_rv.adjustment_account_id;
      ELSE
        SELECT id INTO v_diff_account_id FROM public.chart_of_accounts WHERE code = '6910' LIMIT 1;
        IF v_diff_account_id IS NULL THEN
          SELECT id INTO v_diff_account_id FROM public.chart_of_accounts WHERE code = '6900' LIMIT 1;
        END IF;
      END IF;
    END IF;

    v_carrying_amount := v_actual_received + v_settle_diff;

  ELSIF v_party_type = 'employee' THEN
    SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '1160' LIMIT 1;
    IF v_credit_account_id IS NULL THEN
      SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '1120' LIMIT 1;
    END IF;
    v_carrying_amount := v_actual_received;

  ELSIF v_party_type = 'director' THEN
    SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '2105' LIMIT 1;
    IF v_credit_account_id IS NULL THEN
      SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '2110' LIMIT 1;
    END IF;
    v_carrying_amount := v_actual_received;

  ELSE
    RAISE EXCEPTION 'Unsupported party type: %', v_party_type;
  END IF;

  v_total_debit := v_actual_received + CASE WHEN v_settle_diff > 0 THEN v_settle_diff ELSE 0 END;
  v_total_credit := v_carrying_amount;

  v_je_number := public.next_journal_entry_number();

  INSERT INTO public.journal_entries (
    entry_number,
    entry_date,
    source_module,
    reference_id,
    reference_number,
    description,
    total_debit,
    total_credit,
    is_posted,
    posted_by,
    created_by,
    transaction_currency,
    functional_currency,
    exchange_rate
  ) VALUES (
    v_je_number,
    v_rv.voucher_date,
    'receipt',
    v_rv.id,
    v_rv.voucher_number,
    'Receipt Voucher (' || v_party_type || '): ' || v_rv.voucher_number,
    v_total_debit,
    v_total_credit,
    TRUE,
    v_actual_poster,
    v_actual_poster,
    v_currency,
    'IDR',
    v_rate
  ) RETURNING id INTO v_je_id;

  -- Line 1: Debit Bank / Cash with actual cash received
  INSERT INTO public.journal_entry_lines (
    journal_entry_id,
    line_number,
    account_id,
    description,
    debit,
    credit,
    customer_id,
    supplier_id,
    payee_id,
    transaction_currency,
    exchange_rate
  ) VALUES (
    v_je_id,
    v_line,
    v_bank_account_id,
    'Bank Receipt - ' || v_rv.voucher_number,
    v_actual_received,
    0,
    v_rv.customer_id,
    v_rv.supplier_id,
    v_rv.staff_id,
    v_currency,
    v_rate
  );
  v_line := v_line + 1;

  -- Line 2: Debit Settlement Difference / Adjustment (if any)
  IF v_settle_diff > 0 AND v_diff_account_id IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines (
      journal_entry_id,
      line_number,
      account_id,
      description,
      debit,
      credit,
      customer_id,
      supplier_id,
      payee_id,
      transaction_currency,
      exchange_rate
    ) VALUES (
      v_je_id,
      v_line,
      v_diff_account_id,
      COALESCE(v_rv.adjustment_reason, 'Settlement adjustment') || ' - ' || v_rv.voucher_number,
      v_settle_diff,
      0,
      v_rv.customer_id,
      v_rv.supplier_id,
      v_rv.staff_id,
      v_currency,
      v_rate
    );
    v_line := v_line + 1;
  END IF;

  -- Line 3: Credit Party Control Account (clearing AR / AP / Staff Advance / Customer Deposit)
  INSERT INTO public.journal_entry_lines (
    journal_entry_id,
    line_number,
    account_id,
    description,
    debit,
    credit,
    customer_id,
    supplier_id,
    payee_id,
    transaction_currency,
    exchange_rate
  ) VALUES (
    v_je_id,
    v_line,
    v_credit_account_id,
    CASE 
      WHEN v_party_type = 'supplier' THEN 'Supplier Refund - '
      WHEN v_party_type = 'employee' THEN 'Staff Advance Recovery - '
      WHEN v_party_type = 'director' THEN 'Director Funding - '
      ELSE 'Customer Receipt - '
    END || v_rv.voucher_number,
    0,
    v_carrying_amount,
    v_rv.customer_id,
    v_rv.supplier_id,
    v_rv.staff_id,
    v_currency,
    v_rate
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
    'receipt_vouchers',
    p_rv_id,
    'update',
    jsonb_build_object('is_posted', false),
    jsonb_build_object('is_posted', true, 'journal_entry_id', v_je_id),
    v_actual_poster
  );
END;
$$;

REVOKE ALL ON FUNCTION public.post_receipt_voucher(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_receipt_voucher(uuid, uuid) TO authenticated, service_role;
