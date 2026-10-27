import { execFileSync } from 'node:child_process';

function runSql(sql) {
  const stdout = execFileSync('supabase', ['db', 'query', '--linked', '--output-format', 'json', sql], {
    cwd: '/Users/Kunal/Documents/anzen-main',
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  const res = JSON.parse(stdout);
  if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
  return res.rows || [];
}

async function main() {
  console.log('====================================================================');
  console.log('EXECUTING FINAL REPAIR PHASE — LIVE DATABASE');
  console.log('====================================================================');

  // ====================================================================
  // STEP 1: Fix get_invoice_allocation_amount and resolve RV2609-0008
  // ====================================================================
  console.log('\n--- 1. FIXING SAPJ-26-043 & RV2609-0008 ---');
  
  // 1a. Update get_invoice_allocation_amount
  runSql(`
    CREATE OR REPLACE FUNCTION public.get_invoice_allocation_amount(p_invoice_id uuid, p_exclude_voucher_id uuid DEFAULT NULL::uuid)
     RETURNS numeric
     LANGUAGE sql
     SECURITY DEFINER
     SET search_path TO 'public', 'pg_temp'
    AS $function$
      SELECT COALESCE(SUM(va.allocated_amount), 0)
      FROM public.voucher_allocations va
      JOIN public.receipt_vouchers rv ON rv.id = va.receipt_voucher_id
      WHERE va.sales_invoice_id = p_invoice_id
        AND va.voucher_type = 'receipt'
        AND rv.is_posted = true
        AND (p_exclude_voucher_id IS NULL OR va.receipt_voucher_id <> p_exclude_voucher_id);
    $function$;
  `);
  console.log('   ✅ get_invoice_allocation_amount updated with rv.is_posted = true check');

  // 1b. Add trigger on receipt_vouchers for posting change sync
  runSql(`
    CREATE OR REPLACE FUNCTION public.sync_si_state_on_rv_posting_change()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $function$
    DECLARE
      v_invoice_id uuid;
    BEGIN
      IF COALESCE(OLD.is_posted, FALSE) IS DISTINCT FROM COALESCE(NEW.is_posted, FALSE) THEN
        FOR v_invoice_id IN
          SELECT DISTINCT sales_invoice_id
          FROM public.voucher_allocations
          WHERE receipt_voucher_id = NEW.id
            AND voucher_type = 'receipt'
            AND sales_invoice_id IS NOT NULL
        LOOP
          PERFORM public.recalculate_sales_invoice_payment_state(v_invoice_id);
        END LOOP;
      END IF;

      RETURN NEW;
    END;
    $function$;

    DROP TRIGGER IF EXISTS trg_sync_si_state_on_rv_posting_change ON public.receipt_vouchers;
    CREATE TRIGGER trg_sync_si_state_on_rv_posting_change
    AFTER UPDATE OF is_posted ON public.receipt_vouchers
    FOR EACH ROW EXECUTE FUNCTION sync_si_state_on_rv_posting_change();
  `);
  console.log('   ✅ sync_si_state_on_rv_posting_change trigger installed on receipt_vouchers');

  // 1c. Void/Unlink draft allocation for RV2609-0008 on SAPJ-26-043
  runSql(`
    DELETE FROM public.voucher_allocations 
    WHERE receipt_voucher_id = '8b34a669-2a1d-4dea-a009-200157ba24ee' 
      AND sales_invoice_id = 'c1d86b43-f5eb-436d-a869-bf93c161e76e';

    -- Recalculate payment state of SAPJ-26-043
    SELECT public.recalculate_sales_invoice_payment_state('c1d86b43-f5eb-436d-a869-bf93c161e76e');
  `);
  console.log('   ✅ RV2609-0008 unlinked and SAPJ-26-043 payment state recalculated');

  // Verify SAPJ-26-043 state
  const invState = runSql(`
    SELECT invoice_number, total_amount, paid_amount, payment_status
    FROM public.sales_invoices
    WHERE invoice_number = 'SAPJ-26-043';
  `)[0];
  console.log('   SAPJ-26-043 current state:', invState);
  if (Number(invState.paid_amount) !== 41203339 || invState.payment_status !== 'partial') {
    throw new Error(`Unexpected SAPJ-26-043 state: ${JSON.stringify(invState)}`);
  }
  console.log('   ✅ SAPJ-26-043 reconciles to exactly Rp 41,203,339.00 paid (Part 1)');


  // ====================================================================
  // STEP 2: PAYMENT PURPOSE / SALARY SETTLEMENT ARCHITECTURE
  // ====================================================================
  console.log('\n--- 2. PAYMENT PURPOSE & SALARY SETTLEMENT ENGINE ---');
  
  // 2a. Drop old 18-arg overload
  runSql(`
    DROP FUNCTION IF EXISTS public.save_payment_voucher_with_allocations(uuid, text, date, uuid, text, uuid, text, numeric, numeric, uuid, text, text, numeric, numeric, numeric, uuid, jsonb, uuid);
    DROP FUNCTION IF EXISTS public.save_payment_voucher_command(uuid, jsonb, jsonb);
  `);
  console.log('   ✅ Dropped obsolete overloads');

  // 2b. Install canonical save_payment_voucher_with_allocations ensuring payment_purpose is set on INSERT
  runSql(`
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
      p_payment_purpose text DEFAULT 'general'::text
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
      v_invoice_id UUID;
      v_expense_id UUID;
      v_creator UUID;
      v_purpose TEXT := COALESCE(p_payment_purpose, 'general');
    BEGIN
      PERFORM public._sec_check_finance_role();
      v_creator := auth.uid();

      IF p_supplier_id IS NULL AND p_staff_id IS NULL THEN
        RAISE EXCEPTION 'Payment voucher needs a payee: supplier or staff';
      END IF;

      IF v_purpose NOT IN ('general', 'salary_advance', 'salary_advance_settlement') THEN
        RAISE EXCEPTION 'Unsupported payment purpose %', v_purpose;
      END IF;

      IF p_voucher_id IS NULL THEN
        INSERT INTO payment_vouchers (
          voucher_number, voucher_date, supplier_id, staff_id, payment_method,
          bank_account_id, reference_number, amount, pph_amount, pph_code_id,
          description, payment_currency, exchange_rate,
          bank_amount, bank_charge, created_by,
          payment_purpose, salary_advance_status
        ) VALUES (
          p_voucher_number, p_voucher_date, p_supplier_id, p_staff_id, p_payment_method,
          p_bank_account_id, p_reference_number, p_amount, p_pph_amount, p_pph_code_id,
          p_description, p_payment_currency, p_exchange_rate,
          p_bank_amount, p_bank_charge, v_creator,
          v_purpose,
          CASE v_purpose WHEN 'salary_advance' THEN 'outstanding' ELSE 'not_applicable' END
        ) RETURNING id INTO v_voucher_id;
      ELSE
        v_voucher_id := p_voucher_id;

        IF EXISTS (SELECT 1 FROM payment_vouchers WHERE id = v_voucher_id AND is_posted = TRUE) THEN
          RAISE EXCEPTION 'Cannot edit: % is posted. Cancel Posting first to make changes.', p_voucher_number;
        END IF;

        UPDATE payment_vouchers SET
          voucher_date          = p_voucher_date,
          supplier_id           = p_supplier_id,
          staff_id              = p_staff_id,
          payment_method        = p_payment_method,
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
            allocated_amount, allocated_currency, voucher_type
          ) VALUES (
            v_voucher_id, v_invoice_id, v_alloc_amount,
            COALESCE(v_alloc->>'currency', 'IDR'), 'payment'
          );
        ELSIF v_expense_id IS NOT NULL THEN
          INSERT INTO voucher_allocations (
            payment_voucher_id, finance_expense_id,
            allocated_amount, allocated_currency, voucher_type
          ) VALUES (
            v_voucher_id, v_expense_id, v_alloc_amount,
            COALESCE(v_alloc->>'currency', 'IDR'), 'payment'
          );
        END IF;
      END LOOP;

      RETURN v_voucher_id;
    END;
    $function$;

    -- Provide 3-arg delegation wrapper for backward compatibility
    CREATE OR REPLACE FUNCTION public.save_payment_voucher_command(
      p_voucher_id uuid DEFAULT NULL::uuid, 
      p_payload jsonb DEFAULT '{}'::jsonb, 
      p_allocations jsonb DEFAULT '[]'::jsonb
    )
    RETURNS jsonb
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
    BEGIN
      RETURN public.save_payment_voucher_command(
        p_voucher_id, 
        p_payload, 
        p_allocations, 
        NULLIF(p_payload->>'payment_purpose', '')
      );
    END;
    $$;
  `);
  console.log('   ✅ Canonical save_payment_voucher_with_allocations & command wrapper deployed');


  // ====================================================================
  // STEP 4: 188 LEGACY INVENTORY operation_id HARDENING
  // ====================================================================
  console.log('\n--- 4. INVENTORY OPERATION_ID HARDENING ---');
  runSql(`
    CREATE OR REPLACE FUNCTION public.enforce_inventory_transaction_operation_id()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
    BEGIN
      IF NEW.operation_id IS NULL THEN
        RAISE EXCEPTION 'Inventory transactions require an idempotent operation_id';
      END IF;
      RETURN NEW;
    END;
    $$;

    DROP TRIGGER IF EXISTS trg_enforce_inventory_op_id ON public.inventory_transactions;
    CREATE TRIGGER trg_enforce_inventory_op_id
    BEFORE INSERT ON public.inventory_transactions
    FOR EACH ROW
    EXECUTE FUNCTION public.enforce_inventory_transaction_operation_id();
  `);
  console.log('   ✅ Trigger trg_enforce_inventory_op_id installed on inventory_transactions');


  // ====================================================================
  // STEP 5: GL 1101 PREVENTATIVE HARDENING
  // ====================================================================
  console.log('\n--- 5. GL 1101 PREVENTATIVE HARDENING ---');
  runSql(`
    -- Deactivate account 1101 in chart_of_accounts
    UPDATE public.chart_of_accounts SET is_active = false WHERE code = '1101';

    -- Add DB trigger on journal_entry_lines preventing new postings to 1101
    CREATE OR REPLACE FUNCTION public.prevent_gl1101_posting()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
    DECLARE
      v_code text;
      v_is_reversed boolean;
    BEGIN
      SELECT c.code INTO v_code FROM public.chart_of_accounts c WHERE c.id = NEW.account_id;
      IF v_code = '1101' THEN
        SELECT COALESCE(je.is_reversed, false) INTO v_is_reversed FROM public.journal_entries je WHERE je.id = NEW.journal_entry_id;
        IF NOT v_is_reversed THEN
          RAISE EXCEPTION 'Account 1101 (Cash on Hand) is permanently retired and cannot accept new journal postings.';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$;

    DROP TRIGGER IF EXISTS trg_prevent_gl1101_posting ON public.journal_entry_lines;
    CREATE TRIGGER trg_prevent_gl1101_posting
    BEFORE INSERT OR UPDATE OF account_id ON public.journal_entry_lines
    FOR EACH ROW
    EXECUTE FUNCTION public.prevent_gl1101_posting();

    -- Add trigger on fund_transfers preventing cash_on_hand
    CREATE OR REPLACE FUNCTION public.prevent_cash_on_hand_fund_transfer()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
    BEGIN
      IF NEW.from_account_type = 'cash_on_hand' OR NEW.to_account_type = 'cash_on_hand' THEN
        RAISE EXCEPTION 'Fund transfer with cash_on_hand is permanently disabled.';
      END IF;
      RETURN NEW;
    END;
    $$;

    DROP TRIGGER IF EXISTS trg_prevent_cash_on_hand_fund_transfer ON public.fund_transfers;
    CREATE TRIGGER trg_prevent_cash_on_hand_fund_transfer
    BEFORE INSERT ON public.fund_transfers
    FOR EACH ROW
    EXECUTE FUNCTION public.prevent_cash_on_hand_fund_transfer();
  `);
  console.log('   ✅ GL 1101 deactivated and posting protection triggers active');


  // ====================================================================
  // STEP 6: SECURITY DEFINER SEARCH PATH NORMALIZATION
  // ====================================================================
  console.log('\n--- 6. NORMALIZING SECURITY DEFINER SEARCH PATHS ---');
  
  const secDefFuncs = runSql(`
    SELECT 
      p.oid,
      p.proname,
      pg_get_function_identity_arguments(p.oid) as identity_args,
      p.proconfig
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' 
      AND p.prosecdef = true
    ORDER BY p.proname;
  `);

  let alteredCount = 0;
  for (const f of secDefFuncs) {
    const cfg = f.proconfig ? f.proconfig.join(',') : '';
    if (cfg !== 'search_path=public, pg_temp') {
      const alterSql = `ALTER FUNCTION public."${f.proname}"(${f.identity_args}) SET search_path TO 'public', 'pg_temp';`;
      try {
        runSql(alterSql);
        alteredCount++;
      } catch (err) {
        console.error(`Failed to alter ${f.proname}(${f.identity_args}):`, err.message);
      }
    }
  }
  console.log(`   ✅ Normalized ${alteredCount} SECURITY DEFINER functions to SET search_path TO 'public', 'pg_temp'`);

  // Verify 0 malformed functions remain
  const remainingMalformed = runSql(`
    SELECT 
      p.proname,
      pg_get_function_identity_arguments(p.oid) as identity_args,
      p.proconfig
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' 
      AND p.prosecdef = true
      AND (p.proconfig IS NULL OR array_to_string(p.proconfig, ',') <> 'search_path=public, pg_temp');
  `);
  console.log(`   Remaining malformed search_path functions: ${remainingMalformed.length}`);
  if (remainingMalformed.length > 0) {
    console.log(remainingMalformed);
  } else {
    console.log('   ✅ Zero malformed search_path functions remain!');
  }

  console.log('\n====================================================================');
  console.log('FINAL REPAIR DATABASE MUTATIONS COMPLETED SUCCESSFULLY');
  console.log('====================================================================');
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
