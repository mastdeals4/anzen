/*
  # Add Missing Foreign Key Indexes for Performance

  This migration adds indexes for all unindexed foreign keys to improve query performance.
  Foreign keys without indexes can cause performance issues during joins and cascading operations.

  ## Changes
  
  ### Accounting & Finance Tables
  - accounting_periods: index on closed_by
  - bank_reconciliation_items: indexes on journal_entry_id, reconciliation_id
  - bank_reconciliations: indexes on bank_account_id, created_by, reconciled_by
  - payment_vouchers: indexes on bank_account_id, created_by, journal_entry_id, pph_code_id
  - receipt_vouchers: indexes on bank_account_id, created_by, journal_entry_id
  - journal_entries: indexes on created_by, period_id, posted_by, reversed_by_id
  - journal_entry_lines: indexes on batch_id, tax_code_id
  - purchase_invoices: indexes on created_by, journal_entry_id
  - purchase_invoice_items: indexes on product_id, tax_code_id
  - suppliers: index on created_by
  - tax_codes: indexes on collection_account_id, payment_account_id
  
  ### Petty Cash Tables
  - petty_cash_books: indexes on account_id, created_by, custodian_id
  - petty_cash_documents: indexes on petty_cash_transaction_id, uploaded_by
  - petty_cash_files: index on uploaded_by
  - petty_cash_transactions: indexes on bank_account_id, created_by, paid_by_staff_id, received_by_staff_id
  - petty_cash_vouchers: indexes on account_id, approved_by, created_by, journal_entry_id, tax_code_id
  
  ### Inventory & Sales Tables
  - batches: indexes on purchase_invoice_id, supplier_id
  - sales_invoices: index on journal_entry_id
  
  ### Approvals & Returns Tables
  - credit_notes: indexes on approved_by, created_by
  - material_returns: indexes on approval_workflow_id, approved_by, created_by
  - stock_rejections: indexes on approval_workflow_id, approved_by, created_by, inspected_by
*/

-- Accounting Periods
CREATE INDEX IF NOT EXISTS idx_accounting_periods_closed_by ON accounting_periods(closed_by);

-- Bank Reconciliation
CREATE INDEX IF NOT EXISTS idx_bank_reconciliation_items_journal_entry ON bank_reconciliation_items(journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_bank_reconciliation_items_reconciliation ON bank_reconciliation_items(reconciliation_id);
CREATE INDEX IF NOT EXISTS idx_bank_reconciliations_bank_account ON bank_reconciliations(bank_account_id);
CREATE INDEX IF NOT EXISTS idx_bank_reconciliations_created_by ON bank_reconciliations(created_by);
CREATE INDEX IF NOT EXISTS idx_bank_reconciliations_reconciled_by ON bank_reconciliations(reconciled_by);

-- Batches
CREATE INDEX IF NOT EXISTS idx_batches_purchase_invoice ON batches(purchase_invoice_id);
CREATE INDEX IF NOT EXISTS idx_batches_supplier ON batches(supplier_id);

-- Credit Notes
CREATE INDEX IF NOT EXISTS idx_credit_notes_approved_by ON credit_notes(approved_by);
CREATE INDEX IF NOT EXISTS idx_credit_notes_created_by ON credit_notes(created_by);

-- Journal Entries
CREATE INDEX IF NOT EXISTS idx_journal_entries_created_by ON journal_entries(created_by);
CREATE INDEX IF NOT EXISTS idx_journal_entries_period ON journal_entries(period_id);
CREATE INDEX IF NOT EXISTS idx_journal_entries_posted_by ON journal_entries(posted_by);
CREATE INDEX IF NOT EXISTS idx_journal_entries_reversed_by ON journal_entries(reversed_by_id);

-- Journal Entry Lines
CREATE INDEX IF NOT EXISTS idx_journal_entry_lines_batch ON journal_entry_lines(batch_id);
CREATE INDEX IF NOT EXISTS idx_journal_entry_lines_tax_code ON journal_entry_lines(tax_code_id);

-- Material Returns
CREATE INDEX IF NOT EXISTS idx_material_returns_approval_workflow ON material_returns(approval_workflow_id);
CREATE INDEX IF NOT EXISTS idx_material_returns_approved_by ON material_returns(approved_by);
CREATE INDEX IF NOT EXISTS idx_material_returns_created_by ON material_returns(created_by);

-- Payment Vouchers
CREATE INDEX IF NOT EXISTS idx_payment_vouchers_bank_account ON payment_vouchers(bank_account_id);
CREATE INDEX IF NOT EXISTS idx_payment_vouchers_created_by ON payment_vouchers(created_by);
CREATE INDEX IF NOT EXISTS idx_payment_vouchers_journal_entry ON payment_vouchers(journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_payment_vouchers_pph_code ON payment_vouchers(pph_code_id);

-- Petty Cash Books
CREATE INDEX IF NOT EXISTS idx_petty_cash_books_account ON petty_cash_books(account_id);
CREATE INDEX IF NOT EXISTS idx_petty_cash_books_created_by ON petty_cash_books(created_by);
CREATE INDEX IF NOT EXISTS idx_petty_cash_books_custodian ON petty_cash_books(custodian_id);

-- Petty Cash Documents
CREATE INDEX IF NOT EXISTS idx_petty_cash_documents_transaction ON petty_cash_documents(petty_cash_transaction_id);
CREATE INDEX IF NOT EXISTS idx_petty_cash_documents_uploaded_by ON petty_cash_documents(uploaded_by);

-- Petty Cash Files
CREATE INDEX IF NOT EXISTS idx_petty_cash_files_uploaded_by ON petty_cash_files(uploaded_by);

-- Petty Cash Transactions
CREATE INDEX IF NOT EXISTS idx_petty_cash_transactions_bank_account ON petty_cash_transactions(bank_account_id);
CREATE INDEX IF NOT EXISTS idx_petty_cash_transactions_created_by ON petty_cash_transactions(created_by);
CREATE INDEX IF NOT EXISTS idx_petty_cash_transactions_paid_by ON petty_cash_transactions(paid_by_staff_id);
CREATE INDEX IF NOT EXISTS idx_petty_cash_transactions_received_by ON petty_cash_transactions(received_by_staff_id);

-- Petty Cash Vouchers
CREATE INDEX IF NOT EXISTS idx_petty_cash_vouchers_account ON petty_cash_vouchers(account_id);
CREATE INDEX IF NOT EXISTS idx_petty_cash_vouchers_approved_by ON petty_cash_vouchers(approved_by);
CREATE INDEX IF NOT EXISTS idx_petty_cash_vouchers_created_by ON petty_cash_vouchers(created_by);
CREATE INDEX IF NOT EXISTS idx_petty_cash_vouchers_journal_entry ON petty_cash_vouchers(journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_petty_cash_vouchers_tax_code ON petty_cash_vouchers(tax_code_id);

-- Purchase Invoices
CREATE INDEX IF NOT EXISTS idx_purchase_invoice_items_product ON purchase_invoice_items(product_id);
CREATE INDEX IF NOT EXISTS idx_purchase_invoice_items_tax_code ON purchase_invoice_items(tax_code_id);
CREATE INDEX IF NOT EXISTS idx_purchase_invoices_created_by ON purchase_invoices(created_by);
CREATE INDEX IF NOT EXISTS idx_purchase_invoices_journal_entry ON purchase_invoices(journal_entry_id);

-- Receipt Vouchers
CREATE INDEX IF NOT EXISTS idx_receipt_vouchers_bank_account ON receipt_vouchers(bank_account_id);
CREATE INDEX IF NOT EXISTS idx_receipt_vouchers_created_by ON receipt_vouchers(created_by);
CREATE INDEX IF NOT EXISTS idx_receipt_vouchers_journal_entry ON receipt_vouchers(journal_entry_id);

-- Sales Invoices
CREATE INDEX IF NOT EXISTS idx_sales_invoices_journal_entry ON sales_invoices(journal_entry_id);

-- Stock Rejections
CREATE INDEX IF NOT EXISTS idx_stock_rejections_approval_workflow ON stock_rejections(approval_workflow_id);
CREATE INDEX IF NOT EXISTS idx_stock_rejections_approved_by ON stock_rejections(approved_by);
CREATE INDEX IF NOT EXISTS idx_stock_rejections_created_by ON stock_rejections(created_by);
CREATE INDEX IF NOT EXISTS idx_stock_rejections_inspected_by ON stock_rejections(inspected_by);

-- Suppliers
CREATE INDEX IF NOT EXISTS idx_suppliers_created_by ON suppliers(created_by);

-- Tax Codes
CREATE INDEX IF NOT EXISTS idx_tax_codes_collection_account ON tax_codes(collection_account_id);
CREATE INDEX IF NOT EXISTS idx_tax_codes_payment_account ON tax_codes(payment_account_id);
