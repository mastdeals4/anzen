/*
  # Create Journal Voucher View for Unified Journal Display

  1. Purpose
    - Creates a unified view of all journal entries in a voucher-style format
    - Displays one row per journal entry with primary debit/credit accounts
    - Shows proper narration from source records (expenses, petty cash, etc.)
    - Indicates if entry has multiple lines for detailed breakdown

  2. Features
    - Fetches narration from source records (expenses, petty cash, fund transfers)
    - Shows account names with codes
    - Calculates if entry is multi-line
    - Compatible with all source modules

  3. Notes
    - For multi-line entries, shows primary debit and credit accounts
    - Narration comes from source record description for accuracy
    - Uses reference_id to link journal entries to source documents
*/

DROP VIEW IF EXISTS journal_voucher_view CASCADE;

CREATE VIEW journal_voucher_view AS
SELECT
  je.id as journal_entry_id,
  je.entry_date as date,
  je.entry_number as voucher_no,
  CASE
    WHEN je.source_module = 'sales_invoice' THEN 'Sales Invoice'
    WHEN je.source_module = 'sales_invoice_cogs' THEN 'COGS Entry'
    WHEN je.source_module = 'purchase_invoice' THEN 'Purchase Invoice'
    WHEN je.source_module = 'receipt' THEN 'Receipt'
    WHEN je.source_module = 'payment' THEN 'Payment'
    WHEN je.source_module = 'petty_cash' THEN 'Petty Cash'
    WHEN je.source_module = 'expense' THEN 'Expense'
    WHEN je.source_module = 'expenses' THEN 'Expense'
    WHEN je.source_module = 'fund_transfer' THEN 'Fund Transfer'
    WHEN je.source_module = 'batch' THEN 'Batch'
    WHEN je.source_module = 'manual' THEN 'Manual Entry'
    ELSE je.source_module
  END as voucher_type,

  -- Primary debit account
  (
    SELECT coa.code || ' - ' || coa.name
    FROM journal_entry_lines jel
    LEFT JOIN chart_of_accounts coa ON coa.id = jel.account_id
    WHERE jel.journal_entry_id = je.id
      AND jel.debit > 0
    ORDER BY jel.line_number
    LIMIT 1
  ) as debit_account,

  -- Primary credit account
  (
    SELECT coa.code || ' - ' || coa.name
    FROM journal_entry_lines jel
    LEFT JOIN chart_of_accounts coa ON coa.id = jel.account_id
    WHERE jel.journal_entry_id = je.id
      AND jel.credit > 0
    ORDER BY jel.line_number
    LIMIT 1
  ) as credit_account,

  -- Amount (use total_debit as they should match)
  je.total_debit as amount,

  -- Narration from source record or journal entry description
  COALESCE(
    -- Petty cash: get description from petty_cash_transactions via reference_id
    (SELECT description FROM petty_cash_transactions WHERE id = je.reference_id LIMIT 1),
    -- Expense: get description from finance_expenses via reference_id
    (SELECT description FROM finance_expenses WHERE id = je.reference_id LIMIT 1),
    -- Fund transfer: get description
    (SELECT description FROM fund_transfers WHERE id = je.reference_id LIMIT 1),
    -- Sales invoice: get customer and invoice info
    (SELECT
      'Sales to ' || c.company_name || ' - Inv: ' || si.invoice_number
    FROM sales_invoices si
    LEFT JOIN customers c ON c.id = si.customer_id
    WHERE si.id = je.reference_id LIMIT 1),
    -- Receipt voucher
    (SELECT
      'Receipt from ' || c.company_name || ' - ' || rv.voucher_number
    FROM receipt_vouchers rv
    LEFT JOIN customers c ON c.id = rv.customer_id
    WHERE rv.id = je.reference_id LIMIT 1),
    -- Payment voucher
    (SELECT
      'Payment to ' || s.company_name || ' - ' || pv.voucher_number
    FROM payment_vouchers pv
    LEFT JOIN suppliers s ON s.id = pv.supplier_id
    WHERE pv.id = je.reference_id LIMIT 1),
    -- Fallback to journal entry description
    je.description,
    '-'
  ) as narration,

  je.reference_number,
  je.source_module,

  -- Count of lines in this entry
  (SELECT COUNT(*) FROM journal_entry_lines WHERE journal_entry_id = je.id) as line_count,

  -- Is multi-line (more than 2 lines)
  (SELECT COUNT(*) FROM journal_entry_lines WHERE journal_entry_id = je.id) > 2 as is_multi_line,

  je.created_at
FROM journal_entries je
WHERE je.is_posted = true
ORDER BY je.entry_date DESC, je.entry_number DESC;

-- Grant access to authenticated users
GRANT SELECT ON journal_voucher_view TO authenticated;
