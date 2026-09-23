-- ==============================================================================
-- Audit-Safe Credit Note & COGS Reversal (Preserve General Ledger & Audit Trail)
-- ==============================================================================
-- When a posted Credit Note is reversed or unapproved (status changes from
-- 'approved' to another status) or deleted, do NOT physically delete posted
-- journal entries or their lines.
--
-- Instead:
-- 1. Create a balanced reversal journal entry with debits and credits swapped
-- 2. Mark the original journal entry as is_reversed = true, reversed_by_id = v_rev_id
-- 3. Unmatch any bank statement lines matched to the entry
-- 4. Preserve full historical audit trail and sequential journal numbering
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.reverse_credit_note_journal()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_je record;
  v_rev_entry text;
  v_reversal_id uuid;
  v_period_id uuid;
BEGIN
  -- Handle both DELETE of credit_notes and UPDATE where status was 'approved' and leaves 'approved'
  IF (TG_OP = 'DELETE' AND OLD.status = 'approved')
     OR (TG_OP = 'UPDATE' AND OLD.status = 'approved' AND NEW.status IS DISTINCT FROM 'approved') THEN

    FOR v_je IN
      SELECT *
      FROM public.journal_entries
      WHERE source_module IN ('credit_note', 'credit_note_cogs')
        AND (reference_id = OLD.id OR id = OLD.journal_entry_id)
        AND is_posted = true
        AND NOT COALESCE(is_reversed, false)
      ORDER BY created_at ASC
    LOOP
      -- 1. Unmatch any bank statement lines matched to this entry
      UPDATE public.bank_statement_lines
      SET matched_entry_id = NULL,
          reconciliation_status = 'unmatched',
          matched_at = NULL
      WHERE matched_entry_id = v_je.id;

      -- 2. Determine open accounting period for today, fallback to original period
      SELECT id INTO v_period_id
      FROM public.accounting_periods
      WHERE CURRENT_DATE BETWEEN start_date AND end_date
        AND status = 'open'
      LIMIT 1;

      IF v_period_id IS NULL THEN
        v_period_id := v_je.period_id;
      END IF;

      -- 3. Generate a sequential journal entry number
      v_rev_entry := public.next_journal_entry_number();

      -- 4. Insert the reversal entry preserving full audit trail
      INSERT INTO public.journal_entries (
        entry_number,
        entry_date,
        period_id,
        source_module,
        reference_id,
        reference_number,
        description,
        total_debit,
        total_credit,
        is_posted,
        posted_by,
        posted_at,
        created_by,
        created_at,
        transaction_category,
        transaction_currency,
        functional_currency,
        exchange_rate,
        amounts_are_functional
      ) VALUES (
        v_rev_entry,
        CURRENT_DATE,
        v_period_id,
        v_je.source_module || '_reversal',
        OLD.id,
        'REV-' || v_je.entry_number,
        'Reversal of ' || v_je.entry_number || ': ' || COALESCE(v_je.description, ''),
        v_je.total_credit, -- Inverted
        v_je.total_debit,  -- Inverted
        true,
        COALESCE(auth.uid(), v_je.posted_by),
        now(),
        COALESCE(auth.uid(), v_je.created_by),
        now(),
        v_je.transaction_category,
        v_je.transaction_currency,
        v_je.functional_currency,
        v_je.exchange_rate,
        v_je.amounts_are_functional
      ) RETURNING id INTO v_reversal_id;

      -- 5. Copy lines with inverted debits and credits
      INSERT INTO public.journal_entry_lines (
        journal_entry_id,
        line_number,
        account_id,
        description,
        debit,
        credit,
        tax_code_id,
        customer_id,
        supplier_id,
        batch_id,
        transaction_currency,
        transaction_debit,
        transaction_credit,
        functional_currency,
        exchange_rate,
        sales_invoice_item_id,
        payee_id
      )
      SELECT
        v_reversal_id,
        line_number,
        account_id,
        'Reversal of ' || v_je.entry_number || ' L' || line_number || ': ' || COALESCE(description, ''),
        credit, -- debit becomes credit
        debit,  -- credit becomes debit
        tax_code_id,
        customer_id,
        supplier_id,
        batch_id,
        transaction_currency,
        transaction_credit, -- transaction debit becomes credit
        transaction_debit,  -- transaction credit becomes debit
        functional_currency,
        exchange_rate,
        sales_invoice_item_id,
        payee_id
      FROM public.journal_entry_lines
      WHERE journal_entry_id = v_je.id
      ORDER BY line_number;

      -- 6. Mark the original journal entry as reversed and point to reversal entry
      UPDATE public.journal_entries
      SET is_reversed = true,
          reversed_by_id = v_reversal_id
      WHERE id = v_je.id;

    END LOOP;

    -- 7. Clear journal_entry_id on the credit note row
    IF TG_OP = 'UPDATE' AND NEW.journal_entry_id IS NOT NULL THEN
      UPDATE public.credit_notes
      SET journal_entry_id = NULL
      WHERE id = NEW.id;
    END IF;

  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $function$;
