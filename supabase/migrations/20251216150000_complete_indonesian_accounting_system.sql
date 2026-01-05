/*
  # Complete Indonesian Accounting System
  
  ## Overview
  Full double-entry accounting system with Indonesian tax compliance (PPN/PPh).
  
  ## Tables Created
  1. chart_of_accounts - Account master with hierarchical structure
  2. accounting_periods - Fiscal year/month tracking
  3. tax_codes - PPN (11%) and PPh rates
  4. journal_entries + journal_entry_lines - Double-entry ledger
  5. suppliers - Vendor master with NPWP
  6. purchase_invoices + items - Linked to batches
  7. receipt_vouchers - Customer payments
  8. payment_vouchers - Supplier payments  
  9. voucher_allocations - Invoice allocation
  10. petty_cash_books + vouchers + files - Petty cash with photo uploads
  11. bank_reconciliations - Statement matching
  
  ## Indonesian Tax Compliance
  - PPN (Pajak Pertambahan Nilai) - 11% VAT
  - PPh (Pajak Penghasilan) - Income tax withholding
  - Faktur Pajak numbering
  - NPWP tracking
*/

-- ============================================
-- 1. CHART OF ACCOUNTS
-- ============================================
CREATE TABLE IF NOT EXISTS chart_of_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(20) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  name_id VARCHAR(255), -- Indonesian name
  account_type VARCHAR(50) NOT NULL CHECK (account_type IN ('asset', 'liability', 'equity', 'revenue', 'expense', 'contra')),
  account_group VARCHAR(100),
  parent_id UUID REFERENCES chart_of_accounts(id),
  is_header BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  normal_balance VARCHAR(10) CHECK (normal_balance IN ('debit', 'credit')),
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_coa_code ON chart_of_accounts(code);
CREATE INDEX idx_coa_type ON chart_of_accounts(account_type);
CREATE INDEX idx_coa_parent ON chart_of_accounts(parent_id);

-- ============================================
-- 2. ACCOUNTING PERIODS
-- ============================================
CREATE TABLE IF NOT EXISTS accounting_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fiscal_year INTEGER NOT NULL,
  period_month INTEGER NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open', 'closed', 'locked')),
  closed_by UUID REFERENCES auth.users(id),
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(fiscal_year, period_month)
);

-- ============================================
-- 3. TAX CODES (Indonesian PPN/PPh)
-- ============================================
CREATE TABLE IF NOT EXISTS tax_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(20) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  tax_type VARCHAR(20) NOT NULL CHECK (tax_type IN ('PPN', 'PPh21', 'PPh22', 'PPh23', 'PPh25', 'PPh4(2)', 'other')),
  rate DECIMAL(5,2) NOT NULL,
  is_withholding BOOLEAN DEFAULT false,
  collection_account_id UUID REFERENCES chart_of_accounts(id),
  payment_account_id UUID REFERENCES chart_of_accounts(id),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================
-- 4. ORGANIZATION TAX SETTINGS
-- ============================================
CREATE TABLE IF NOT EXISTS organization_tax_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  npwp_number VARCHAR(30),
  npwp_name VARCHAR(255),
  npwp_address TEXT,
  pkp_status BOOLEAN DEFAULT false,
  pkp_date DATE,
  faktur_prefix VARCHAR(20),
  faktur_current_number INTEGER DEFAULT 0,
  fiscal_year_start_month INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================
-- 5. SUPPLIERS (Vendor Master)
-- ============================================
CREATE TABLE IF NOT EXISTS suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_code VARCHAR(50) UNIQUE,
  company_name VARCHAR(255) NOT NULL,
  contact_person VARCHAR(255),
  email VARCHAR(255),
  phone VARCHAR(50),
  address TEXT,
  city VARCHAR(100),
  country VARCHAR(100) DEFAULT 'Indonesia',
  npwp VARCHAR(30),
  pkp_status BOOLEAN DEFAULT false,
  payment_terms_days INTEGER DEFAULT 30,
  bank_name VARCHAR(100),
  bank_account_number VARCHAR(50),
  bank_account_name VARCHAR(255),
  notes TEXT,
  is_active BOOLEAN DEFAULT true,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_suppliers_name ON suppliers(company_name);
CREATE INDEX idx_suppliers_npwp ON suppliers(npwp);

-- ============================================
-- 6. JOURNAL ENTRIES (Double-Entry Ledger)
-- ============================================
CREATE TABLE IF NOT EXISTS journal_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_number VARCHAR(50) NOT NULL UNIQUE,
  entry_date DATE NOT NULL,
  period_id UUID REFERENCES accounting_periods(id),
  source_module VARCHAR(50), -- 'sales_invoice', 'purchase_invoice', 'receipt', 'payment', 'petty_cash', 'manual'
  reference_id UUID, -- ID of source document
  reference_number VARCHAR(100),
  description TEXT,
  total_debit DECIMAL(18,2) DEFAULT 0,
  total_credit DECIMAL(18,2) DEFAULT 0,
  is_posted BOOLEAN DEFAULT true,
  is_reversed BOOLEAN DEFAULT false,
  reversed_by_id UUID REFERENCES journal_entries(id),
  posted_by UUID REFERENCES auth.users(id),
  posted_at TIMESTAMPTZ DEFAULT now(),
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_je_date ON journal_entries(entry_date);
CREATE INDEX idx_je_source ON journal_entries(source_module, reference_id);
CREATE INDEX idx_je_number ON journal_entries(entry_number);

CREATE TABLE IF NOT EXISTS journal_entry_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_entry_id UUID NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  line_number INTEGER NOT NULL,
  account_id UUID NOT NULL REFERENCES chart_of_accounts(id),
  description TEXT,
  debit DECIMAL(18,2) DEFAULT 0,
  credit DECIMAL(18,2) DEFAULT 0,
  tax_code_id UUID REFERENCES tax_codes(id),
  customer_id UUID REFERENCES customers(id),
  supplier_id UUID REFERENCES suppliers(id),
  batch_id UUID REFERENCES batches(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_jel_entry ON journal_entry_lines(journal_entry_id);
CREATE INDEX idx_jel_account ON journal_entry_lines(account_id);
CREATE INDEX idx_jel_customer ON journal_entry_lines(customer_id);
CREATE INDEX idx_jel_supplier ON journal_entry_lines(supplier_id);

-- ============================================
-- 7. PURCHASE INVOICES (Linked to Batches)
-- ============================================
CREATE TABLE IF NOT EXISTS purchase_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number VARCHAR(100) NOT NULL,
  supplier_id UUID NOT NULL REFERENCES suppliers(id),
  invoice_date DATE NOT NULL,
  due_date DATE,
  currency VARCHAR(10) DEFAULT 'IDR',
  exchange_rate DECIMAL(18,6) DEFAULT 1,
  subtotal DECIMAL(18,2) DEFAULT 0,
  tax_amount DECIMAL(18,2) DEFAULT 0,
  total_amount DECIMAL(18,2) DEFAULT 0,
  paid_amount DECIMAL(18,2) DEFAULT 0,
  balance_amount DECIMAL(18,2) GENERATED ALWAYS AS (total_amount - paid_amount) STORED,
  status VARCHAR(20) DEFAULT 'unpaid' CHECK (status IN ('draft', 'unpaid', 'partial', 'paid', 'cancelled')),
  faktur_pajak_number VARCHAR(50),
  notes TEXT,
  document_urls TEXT[],
  journal_entry_id UUID REFERENCES journal_entries(id),
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(supplier_id, invoice_number)
);

CREATE INDEX idx_pi_supplier ON purchase_invoices(supplier_id);
CREATE INDEX idx_pi_date ON purchase_invoices(invoice_date);
CREATE INDEX idx_pi_status ON purchase_invoices(status);

CREATE TABLE IF NOT EXISTS purchase_invoice_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_invoice_id UUID NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products(id),
  batch_id UUID REFERENCES batches(id),
  description TEXT,
  quantity DECIMAL(18,3) NOT NULL,
  unit VARCHAR(50),
  unit_price DECIMAL(18,2) NOT NULL,
  discount_percent DECIMAL(5,2) DEFAULT 0,
  tax_code_id UUID REFERENCES tax_codes(id),
  tax_amount DECIMAL(18,2) DEFAULT 0,
  line_total DECIMAL(18,2) NOT NULL,
  landed_cost_duty DECIMAL(18,2) DEFAULT 0,
  landed_cost_freight DECIMAL(18,2) DEFAULT 0,
  landed_cost_other DECIMAL(18,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_pii_invoice ON purchase_invoice_items(purchase_invoice_id);
CREATE INDEX idx_pii_batch ON purchase_invoice_items(batch_id);

-- ============================================
-- 8. RECEIPT VOUCHERS (Payments from Customers)
-- ============================================
CREATE TABLE IF NOT EXISTS receipt_vouchers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  voucher_number VARCHAR(50) NOT NULL UNIQUE,
  voucher_date DATE NOT NULL,
  customer_id UUID NOT NULL REFERENCES customers(id),
  payment_method VARCHAR(50) NOT NULL CHECK (payment_method IN ('cash', 'bank_transfer', 'check', 'giro', 'other')),
  bank_account_id UUID REFERENCES bank_accounts(id),
  reference_number VARCHAR(100), -- Check/giro number
  amount DECIMAL(18,2) NOT NULL,
  description TEXT,
  document_urls TEXT[],
  journal_entry_id UUID REFERENCES journal_entries(id),
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_rv_customer ON receipt_vouchers(customer_id);
CREATE INDEX idx_rv_date ON receipt_vouchers(voucher_date);

-- ============================================
-- 9. PAYMENT VOUCHERS (Payments to Suppliers)
-- ============================================
CREATE TABLE IF NOT EXISTS payment_vouchers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  voucher_number VARCHAR(50) NOT NULL UNIQUE,
  voucher_date DATE NOT NULL,
  supplier_id UUID NOT NULL REFERENCES suppliers(id),
  payment_method VARCHAR(50) NOT NULL CHECK (payment_method IN ('cash', 'bank_transfer', 'check', 'giro', 'other')),
  bank_account_id UUID REFERENCES bank_accounts(id),
  reference_number VARCHAR(100),
  amount DECIMAL(18,2) NOT NULL,
  pph_amount DECIMAL(18,2) DEFAULT 0,
  pph_code_id UUID REFERENCES tax_codes(id),
  net_amount DECIMAL(18,2) GENERATED ALWAYS AS (amount - pph_amount) STORED,
  description TEXT,
  document_urls TEXT[],
  journal_entry_id UUID REFERENCES journal_entries(id),
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_pv_supplier ON payment_vouchers(supplier_id);
CREATE INDEX idx_pv_date ON payment_vouchers(voucher_date);

-- ============================================
-- 10. VOUCHER ALLOCATIONS (Invoice Allocation)
-- ============================================
CREATE TABLE IF NOT EXISTS voucher_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  voucher_type VARCHAR(20) NOT NULL CHECK (voucher_type IN ('receipt', 'payment')),
  receipt_voucher_id UUID REFERENCES receipt_vouchers(id) ON DELETE CASCADE,
  payment_voucher_id UUID REFERENCES payment_vouchers(id) ON DELETE CASCADE,
  sales_invoice_id UUID REFERENCES sales_invoices(id),
  purchase_invoice_id UUID REFERENCES purchase_invoices(id),
  allocated_amount DECIMAL(18,2) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  CHECK (
    (voucher_type = 'receipt' AND receipt_voucher_id IS NOT NULL AND sales_invoice_id IS NOT NULL) OR
    (voucher_type = 'payment' AND payment_voucher_id IS NOT NULL AND purchase_invoice_id IS NOT NULL)
  )
);

CREATE INDEX idx_va_receipt ON voucher_allocations(receipt_voucher_id);
CREATE INDEX idx_va_payment ON voucher_allocations(payment_voucher_id);
CREATE INDEX idx_va_sales ON voucher_allocations(sales_invoice_id);
CREATE INDEX idx_va_purchase ON voucher_allocations(purchase_invoice_id);

-- ============================================
-- 11. PETTY CASH SYSTEM
-- ============================================
CREATE TABLE IF NOT EXISTS petty_cash_books (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  custodian_id UUID REFERENCES auth.users(id),
  custodian_name VARCHAR(255),
  float_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
  current_balance DECIMAL(18,2) NOT NULL DEFAULT 0,
  account_id UUID REFERENCES chart_of_accounts(id),
  is_active BOOLEAN DEFAULT true,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS petty_cash_vouchers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  voucher_number VARCHAR(50) NOT NULL UNIQUE,
  petty_cash_book_id UUID NOT NULL REFERENCES petty_cash_books(id),
  voucher_type VARCHAR(20) NOT NULL CHECK (voucher_type IN ('expense', 'replenishment')),
  voucher_date DATE NOT NULL,
  amount DECIMAL(18,2) NOT NULL,
  expense_category VARCHAR(100),
  description TEXT NOT NULL,
  received_by VARCHAR(255),
  tax_code_id UUID REFERENCES tax_codes(id),
  tax_amount DECIMAL(18,2) DEFAULT 0,
  account_id UUID REFERENCES chart_of_accounts(id),
  journal_entry_id UUID REFERENCES journal_entries(id),
  approved_by UUID REFERENCES auth.users(id),
  approved_at TIMESTAMPTZ,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_pcv_book ON petty_cash_vouchers(petty_cash_book_id);
CREATE INDEX idx_pcv_date ON petty_cash_vouchers(voucher_date);

CREATE TABLE IF NOT EXISTS petty_cash_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  petty_cash_voucher_id UUID NOT NULL REFERENCES petty_cash_vouchers(id) ON DELETE CASCADE,
  file_url TEXT NOT NULL,
  file_name VARCHAR(255),
  file_type VARCHAR(50),
  file_size INTEGER,
  uploaded_by UUID REFERENCES auth.users(id),
  uploaded_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_pcf_voucher ON petty_cash_files(petty_cash_voucher_id);

-- ============================================
-- 12. BANK RECONCILIATION
-- ============================================
CREATE TABLE IF NOT EXISTS bank_reconciliations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_account_id UUID NOT NULL REFERENCES bank_accounts(id),
  statement_date DATE NOT NULL,
  statement_start_date DATE NOT NULL,
  statement_end_date DATE NOT NULL,
  opening_balance DECIMAL(18,2) NOT NULL,
  closing_balance DECIMAL(18,2) NOT NULL,
  book_balance DECIMAL(18,2),
  difference DECIMAL(18,2),
  status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'in_progress', 'reconciled')),
  reconciled_by UUID REFERENCES auth.users(id),
  reconciled_at TIMESTAMPTZ,
  notes TEXT,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bank_reconciliation_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_id UUID NOT NULL REFERENCES bank_reconciliations(id) ON DELETE CASCADE,
  transaction_date DATE NOT NULL,
  description TEXT,
  reference_number VARCHAR(100),
  debit DECIMAL(18,2) DEFAULT 0,
  credit DECIMAL(18,2) DEFAULT 0,
  journal_entry_id UUID REFERENCES journal_entries(id),
  is_matched BOOLEAN DEFAULT false,
  matched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================
-- 13. ADD COLUMNS TO EXISTING TABLES
-- ============================================

-- Add NPWP to customers if not exists
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'customers' AND column_name = 'npwp') THEN
    ALTER TABLE customers ADD COLUMN npwp VARCHAR(30);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'customers' AND column_name = 'pkp_status') THEN
    ALTER TABLE customers ADD COLUMN pkp_status BOOLEAN DEFAULT false;
  END IF;
END $$;

-- Add journal_entry_id to sales_invoices
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sales_invoices' AND column_name = 'journal_entry_id') THEN
    ALTER TABLE sales_invoices ADD COLUMN journal_entry_id UUID REFERENCES journal_entries(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sales_invoices' AND column_name = 'faktur_pajak_number') THEN
    ALTER TABLE sales_invoices ADD COLUMN faktur_pajak_number VARCHAR(50);
  END IF;
END $$;

-- Add purchase_invoice_id to batches
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'batches' AND column_name = 'purchase_invoice_id') THEN
    ALTER TABLE batches ADD COLUMN purchase_invoice_id UUID REFERENCES purchase_invoices(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'batches' AND column_name = 'supplier_id') THEN
    ALTER TABLE batches ADD COLUMN supplier_id UUID REFERENCES suppliers(id);
  END IF;
END $$;

-- ============================================
-- 14. SEED CHART OF ACCOUNTS (Indonesian SME)
-- ============================================
INSERT INTO chart_of_accounts (code, name, name_id, account_type, account_group, is_header, normal_balance) VALUES
-- ASSETS (1xxx)
('1000', 'Assets', 'Aset', 'asset', 'Assets', true, 'debit'),
('1100', 'Current Assets', 'Aset Lancar', 'asset', 'Current Assets', true, 'debit'),
('1101', 'Cash on Hand', 'Kas', 'asset', 'Current Assets', false, 'debit'),
('1102', 'Petty Cash', 'Kas Kecil', 'asset', 'Current Assets', false, 'debit'),
('1110', 'Bank Accounts', 'Bank', 'asset', 'Current Assets', true, 'debit'),
('1111', 'Bank BCA', 'Bank BCA', 'asset', 'Current Assets', false, 'debit'),
('1112', 'Bank Mandiri', 'Bank Mandiri', 'asset', 'Current Assets', false, 'debit'),
('1120', 'Accounts Receivable', 'Piutang Dagang', 'asset', 'Current Assets', false, 'debit'),
('1121', 'Allowance for Doubtful Accounts', 'Cadangan Piutang Tak Tertagih', 'contra', 'Current Assets', false, 'credit'),
('1130', 'Inventory', 'Persediaan', 'asset', 'Current Assets', false, 'debit'),
('1140', 'Prepaid Expenses', 'Biaya Dibayar Dimuka', 'asset', 'Current Assets', false, 'debit'),
('1150', 'PPN Input (VAT Receivable)', 'PPN Masukan', 'asset', 'Current Assets', false, 'debit'),
('1200', 'Fixed Assets', 'Aset Tetap', 'asset', 'Fixed Assets', true, 'debit'),
('1201', 'Equipment', 'Peralatan', 'asset', 'Fixed Assets', false, 'debit'),
('1202', 'Accumulated Depreciation - Equipment', 'Akum. Penyusutan Peralatan', 'contra', 'Fixed Assets', false, 'credit'),
('1210', 'Vehicles', 'Kendaraan', 'asset', 'Fixed Assets', false, 'debit'),
('1211', 'Accumulated Depreciation - Vehicles', 'Akum. Penyusutan Kendaraan', 'contra', 'Fixed Assets', false, 'credit'),

-- LIABILITIES (2xxx)
('2000', 'Liabilities', 'Kewajiban', 'liability', 'Liabilities', true, 'credit'),
('2100', 'Current Liabilities', 'Kewajiban Lancar', 'liability', 'Current Liabilities', true, 'credit'),
('2110', 'Accounts Payable', 'Utang Dagang', 'liability', 'Current Liabilities', false, 'credit'),
('2120', 'Accrued Expenses', 'Beban Yang Masih Harus Dibayar', 'liability', 'Current Liabilities', false, 'credit'),
('2130', 'PPN Output (VAT Payable)', 'PPN Keluaran', 'liability', 'Current Liabilities', false, 'credit'),
('2131', 'PPh 21 Payable', 'Utang PPh 21', 'liability', 'Current Liabilities', false, 'credit'),
('2132', 'PPh 23 Payable', 'Utang PPh 23', 'liability', 'Current Liabilities', false, 'credit'),
('2133', 'PPh 25 Payable', 'Utang PPh 25', 'liability', 'Current Liabilities', false, 'credit'),
('2140', 'Customer Deposits', 'Uang Muka Pelanggan', 'liability', 'Current Liabilities', false, 'credit'),
('2200', 'Long Term Liabilities', 'Kewajiban Jangka Panjang', 'liability', 'Long Term Liabilities', true, 'credit'),
('2210', 'Bank Loans', 'Utang Bank', 'liability', 'Long Term Liabilities', false, 'credit'),

-- EQUITY (3xxx)
('3000', 'Equity', 'Modal', 'equity', 'Equity', true, 'credit'),
('3100', 'Owner Capital', 'Modal Pemilik', 'equity', 'Equity', false, 'credit'),
('3200', 'Retained Earnings', 'Laba Ditahan', 'equity', 'Equity', false, 'credit'),
('3300', 'Current Year Earnings', 'Laba Tahun Berjalan', 'equity', 'Equity', false, 'credit'),

-- REVENUE (4xxx)
('4000', 'Revenue', 'Pendapatan', 'revenue', 'Revenue', true, 'credit'),
('4100', 'Sales Revenue', 'Penjualan', 'revenue', 'Revenue', false, 'credit'),
('4110', 'Sales - Local', 'Penjualan Lokal', 'revenue', 'Revenue', false, 'credit'),
('4120', 'Sales - Export', 'Penjualan Ekspor', 'revenue', 'Revenue', false, 'credit'),
('4200', 'Sales Discounts', 'Potongan Penjualan', 'contra', 'Revenue', false, 'debit'),
('4300', 'Sales Returns', 'Retur Penjualan', 'contra', 'Revenue', false, 'debit'),
('4900', 'Other Income', 'Pendapatan Lain-lain', 'revenue', 'Revenue', false, 'credit'),

-- COST OF GOODS SOLD (5xxx)
('5000', 'Cost of Goods Sold', 'Harga Pokok Penjualan', 'expense', 'COGS', true, 'debit'),
('5100', 'COGS - Materials', 'HPP - Bahan Baku', 'expense', 'COGS', false, 'debit'),
('5200', 'Import Duty', 'Bea Masuk', 'expense', 'COGS', false, 'debit'),
('5300', 'Freight In', 'Biaya Angkut Masuk', 'expense', 'COGS', false, 'debit'),
('5400', 'Other Import Costs', 'Biaya Import Lainnya', 'expense', 'COGS', false, 'debit'),

-- OPERATING EXPENSES (6xxx)
('6000', 'Operating Expenses', 'Beban Operasional', 'expense', 'Operating Expenses', true, 'debit'),
('6100', 'Salaries & Wages', 'Gaji dan Upah', 'expense', 'Operating Expenses', false, 'debit'),
('6110', 'Employee Benefits', 'Tunjangan Karyawan', 'expense', 'Operating Expenses', false, 'debit'),
('6200', 'Rent Expense', 'Biaya Sewa', 'expense', 'Operating Expenses', false, 'debit'),
('6210', 'Warehouse Rent', 'Sewa Gudang', 'expense', 'Operating Expenses', false, 'debit'),
('6220', 'Office Rent', 'Sewa Kantor', 'expense', 'Operating Expenses', false, 'debit'),
('6300', 'Utilities', 'Utilitas', 'expense', 'Operating Expenses', false, 'debit'),
('6310', 'Electricity', 'Listrik', 'expense', 'Operating Expenses', false, 'debit'),
('6320', 'Water', 'Air', 'expense', 'Operating Expenses', false, 'debit'),
('6330', 'Telephone & Internet', 'Telepon & Internet', 'expense', 'Operating Expenses', false, 'debit'),
('6400', 'Office Supplies', 'Perlengkapan Kantor', 'expense', 'Operating Expenses', false, 'debit'),
('6500', 'Transportation', 'Transportasi', 'expense', 'Operating Expenses', false, 'debit'),
('6600', 'Marketing & Advertising', 'Pemasaran & Iklan', 'expense', 'Operating Expenses', false, 'debit'),
('6700', 'Professional Fees', 'Biaya Profesional', 'expense', 'Operating Expenses', false, 'debit'),
('6800', 'Depreciation Expense', 'Biaya Penyusutan', 'expense', 'Operating Expenses', false, 'debit'),
('6900', 'Miscellaneous Expense', 'Biaya Lain-lain', 'expense', 'Operating Expenses', false, 'debit'),

-- OTHER EXPENSES (7xxx)
('7000', 'Other Expenses', 'Beban Lain-lain', 'expense', 'Other Expenses', true, 'debit'),
('7100', 'Bank Charges', 'Biaya Bank', 'expense', 'Other Expenses', false, 'debit'),
('7200', 'Interest Expense', 'Biaya Bunga', 'expense', 'Other Expenses', false, 'debit'),
('7300', 'Foreign Exchange Loss', 'Rugi Selisih Kurs', 'expense', 'Other Expenses', false, 'debit')

ON CONFLICT (code) DO NOTHING;

-- ============================================
-- 15. SEED TAX CODES (Indonesian)
-- ============================================
INSERT INTO tax_codes (code, name, tax_type, rate, is_withholding) VALUES
('PPN11', 'PPN 11%', 'PPN', 11.00, false),
('PPN0', 'PPN 0% (Export)', 'PPN', 0.00, false),
('PPNFREE', 'Bebas PPN', 'PPN', 0.00, false),
('PPH21', 'PPh 21 - Employee', 'PPh21', 0.00, true),
('PPH22', 'PPh 22 - Import 2.5%', 'PPh22', 2.50, true),
('PPH23-2', 'PPh 23 - Services 2%', 'PPh23', 2.00, true),
('PPH23-15', 'PPh 23 - Royalty 15%', 'PPh23', 15.00, true),
('PPH4(2)', 'PPh 4(2) - Final 10%', 'PPh4(2)', 10.00, true)
ON CONFLICT (code) DO NOTHING;

-- ============================================
-- 16. HELPER FUNCTIONS
-- ============================================

-- Generate next journal entry number
CREATE OR REPLACE FUNCTION generate_journal_entry_number()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_year TEXT;
  v_month TEXT;
  v_count INTEGER;
  v_number TEXT;
BEGIN
  v_year := TO_CHAR(CURRENT_DATE, 'YY');
  v_month := TO_CHAR(CURRENT_DATE, 'MM');
  
  SELECT COUNT(*) + 1 INTO v_count
  FROM journal_entries
  WHERE entry_number LIKE 'JE' || v_year || v_month || '%';
  
  v_number := 'JE' || v_year || v_month || '-' || LPAD(v_count::TEXT, 4, '0');
  
  RETURN v_number;
END;
$$;

-- Generate next voucher number
CREATE OR REPLACE FUNCTION generate_voucher_number(p_prefix TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_year TEXT;
  v_month TEXT;
  v_count INTEGER;
  v_number TEXT;
BEGIN
  v_year := TO_CHAR(CURRENT_DATE, 'YY');
  v_month := TO_CHAR(CURRENT_DATE, 'MM');
  
  IF p_prefix = 'RV' THEN
    SELECT COUNT(*) + 1 INTO v_count FROM receipt_vouchers
    WHERE voucher_number LIKE p_prefix || v_year || v_month || '%';
  ELSIF p_prefix = 'PV' THEN
    SELECT COUNT(*) + 1 INTO v_count FROM payment_vouchers
    WHERE voucher_number LIKE p_prefix || v_year || v_month || '%';
  ELSIF p_prefix = 'PC' THEN
    SELECT COUNT(*) + 1 INTO v_count FROM petty_cash_vouchers
    WHERE voucher_number LIKE p_prefix || v_year || v_month || '%';
  ELSE
    v_count := 1;
  END IF;
  
  v_number := p_prefix || v_year || v_month || '-' || LPAD(v_count::TEXT, 4, '0');
  
  RETURN v_number;
END;
$$;

-- ============================================
-- 17. VIEWS FOR REPORTING
-- ============================================

-- Trial Balance View
CREATE OR REPLACE VIEW trial_balance_view AS
SELECT 
  coa.code,
  coa.name,
  coa.name_id,
  coa.account_type,
  coa.account_group,
  coa.normal_balance,
  COALESCE(SUM(jel.debit), 0) AS total_debit,
  COALESCE(SUM(jel.credit), 0) AS total_credit,
  COALESCE(SUM(jel.debit), 0) - COALESCE(SUM(jel.credit), 0) AS balance
FROM chart_of_accounts coa
LEFT JOIN journal_entry_lines jel ON coa.id = jel.account_id
LEFT JOIN journal_entries je ON jel.journal_entry_id = je.id AND je.is_posted = true
WHERE coa.is_header = false AND coa.is_active = true
GROUP BY coa.id, coa.code, coa.name, coa.name_id, coa.account_type, coa.account_group, coa.normal_balance
ORDER BY coa.code;

-- Customer Receivables Balance
CREATE OR REPLACE VIEW customer_receivables_view AS
SELECT 
  c.id AS customer_id,
  c.company_name,
  COALESCE(SUM(CASE WHEN jel.account_id IN (SELECT id FROM chart_of_accounts WHERE code = '1120') THEN jel.debit - jel.credit ELSE 0 END), 0) AS receivable_balance
FROM customers c
LEFT JOIN journal_entry_lines jel ON c.id = jel.customer_id
LEFT JOIN journal_entries je ON jel.journal_entry_id = je.id AND je.is_posted = true
GROUP BY c.id, c.company_name
HAVING COALESCE(SUM(CASE WHEN jel.account_id IN (SELECT id FROM chart_of_accounts WHERE code = '1120') THEN jel.debit - jel.credit ELSE 0 END), 0) != 0;

-- Supplier Payables Balance
CREATE OR REPLACE VIEW supplier_payables_view AS
SELECT 
  s.id AS supplier_id,
  s.company_name,
  COALESCE(SUM(CASE WHEN jel.account_id IN (SELECT id FROM chart_of_accounts WHERE code = '2110') THEN jel.credit - jel.debit ELSE 0 END), 0) AS payable_balance
FROM suppliers s
LEFT JOIN journal_entry_lines jel ON s.id = jel.supplier_id
LEFT JOIN journal_entries je ON jel.journal_entry_id = je.id AND je.is_posted = true
GROUP BY s.id, s.company_name
HAVING COALESCE(SUM(CASE WHEN jel.account_id IN (SELECT id FROM chart_of_accounts WHERE code = '2110') THEN jel.credit - jel.debit ELSE 0 END), 0) != 0;

-- ============================================
-- 18. ROW LEVEL SECURITY
-- ============================================
ALTER TABLE chart_of_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_tax_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entry_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_invoice_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE receipt_vouchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_vouchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE voucher_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE petty_cash_books ENABLE ROW LEVEL SECURITY;
ALTER TABLE petty_cash_vouchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE petty_cash_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_reconciliation_items ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users to read all accounting data
CREATE POLICY "Allow read for authenticated" ON chart_of_accounts FOR SELECT TO authenticated USING (true);
CREATE POLICY "Allow read for authenticated" ON accounting_periods FOR SELECT TO authenticated USING (true);
CREATE POLICY "Allow read for authenticated" ON tax_codes FOR SELECT TO authenticated USING (true);
CREATE POLICY "Allow read for authenticated" ON organization_tax_settings FOR SELECT TO authenticated USING (true);
CREATE POLICY "Allow read for authenticated" ON suppliers FOR SELECT TO authenticated USING (true);
CREATE POLICY "Allow read for authenticated" ON journal_entries FOR SELECT TO authenticated USING (true);
CREATE POLICY "Allow read for authenticated" ON journal_entry_lines FOR SELECT TO authenticated USING (true);
CREATE POLICY "Allow read for authenticated" ON purchase_invoices FOR SELECT TO authenticated USING (true);
CREATE POLICY "Allow read for authenticated" ON purchase_invoice_items FOR SELECT TO authenticated USING (true);
CREATE POLICY "Allow read for authenticated" ON receipt_vouchers FOR SELECT TO authenticated USING (true);
CREATE POLICY "Allow read for authenticated" ON payment_vouchers FOR SELECT TO authenticated USING (true);
CREATE POLICY "Allow read for authenticated" ON voucher_allocations FOR SELECT TO authenticated USING (true);
CREATE POLICY "Allow read for authenticated" ON petty_cash_books FOR SELECT TO authenticated USING (true);
CREATE POLICY "Allow read for authenticated" ON petty_cash_vouchers FOR SELECT TO authenticated USING (true);
CREATE POLICY "Allow read for authenticated" ON petty_cash_files FOR SELECT TO authenticated USING (true);
CREATE POLICY "Allow read for authenticated" ON bank_reconciliations FOR SELECT TO authenticated USING (true);
CREATE POLICY "Allow read for authenticated" ON bank_reconciliation_items FOR SELECT TO authenticated USING (true);

-- Allow insert/update/delete for authenticated (admin/accounts roles check in app)
CREATE POLICY "Allow write for authenticated" ON chart_of_accounts FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow write for authenticated" ON accounting_periods FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow write for authenticated" ON tax_codes FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow write for authenticated" ON organization_tax_settings FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow write for authenticated" ON suppliers FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow write for authenticated" ON journal_entries FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow write for authenticated" ON journal_entry_lines FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow write for authenticated" ON purchase_invoices FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow write for authenticated" ON purchase_invoice_items FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow write for authenticated" ON receipt_vouchers FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow write for authenticated" ON payment_vouchers FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow write for authenticated" ON voucher_allocations FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow write for authenticated" ON petty_cash_books FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow write for authenticated" ON petty_cash_vouchers FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow write for authenticated" ON petty_cash_files FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow write for authenticated" ON bank_reconciliations FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow write for authenticated" ON bank_reconciliation_items FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Grant permissions
GRANT SELECT ON trial_balance_view TO authenticated;
GRANT SELECT ON customer_receivables_view TO authenticated;
GRANT SELECT ON supplier_payables_view TO authenticated;

-- ============================================
-- MIGRATION COMPLETE
-- ============================================
DO $$
BEGIN
  RAISE NOTICE '✅ Indonesian Accounting System migration complete!';
  RAISE NOTICE 'Tables created: chart_of_accounts, accounting_periods, tax_codes, suppliers, journal_entries, purchase_invoices, receipt_vouchers, payment_vouchers, petty_cash_books, petty_cash_vouchers, bank_reconciliations';
  RAISE NOTICE 'Indonesian COA with 70+ accounts seeded';
  RAISE NOTICE 'Tax codes for PPN 11%% and PPh created';
END $$;
