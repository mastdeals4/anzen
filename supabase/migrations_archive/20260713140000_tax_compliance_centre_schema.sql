-- ============================================================================
-- Tax Compliance Centre — Phase 1a: Schema Foundation
-- ============================================================================
-- Purpose:
--   Adds the minimum net-new schema required for the Tax Compliance Centre
--   without duplicating any existing accounting, bank reconciliation, or
--   attachment machinery.
--
-- Additive-only. Idempotent on both fresh and existing production DBs.
--
-- New tables:
--   * tax_periods            — monthly filing period + status
--   * tax_payments           — bridges period ↔ payment_voucher ↔ journal_entry
--   * tax_payment_files      — attachments (mirrors petty_cash_files)
--   * faktur_pajak           — bridges sales_invoice ↔ faktur number ↔ pdf
--   * faktur_pajak_files     — attachments
--   * tax_calendar_config    — configurable Indonesian due-date rules
--
-- Additive columns to existing tables:
--   * sales_invoices.tax_period_id     (uuid → tax_periods)
--   * finance_expenses.tax_period_id   (uuid → tax_periods, for input PPN attribution)
--
-- Seeded CoA rows: PPh 22 / PPh 4(2) payable liability accounts (2134, 2135
-- collide with Bea Meterai Payable already at 2135 → we use codes 2137/2138
-- to avoid collision; verified against existing seed in migration
-- 20251216150000).
--
-- Views:
--   * vw_ppn_net_by_period       — Output − Input − Carry Forward per period
--   * vw_pph_by_period_type      — PPh21/22/23/4(2) totals per period + type
--   * vw_outstanding_tax         — periods with unpaid tax
--   * vw_tax_period_status       — one-row summary per period for calendar UI
--
-- All new tables get RLS enabled with policies mirroring existing conventions.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 0. Chart of Accounts — add PPh 22 & PPh 4(2) payables
--    (PPh 21 = 2131 and PPh 23 = 2132 already exist. PPh 25 = 2133 already
--     exists.  2130 = PPN Output, 2135 = Bea Meterai Payable.)
-- ============================================================================
INSERT INTO chart_of_accounts (code, name, name_id, account_type, account_group, is_header, normal_balance) VALUES
  ('2137', 'PPh 22 Payable',    'Utang PPh 22',    'liability', 'Current Liabilities', false, 'credit'),
  ('2138', 'PPh 4(2) Payable',  'Utang PPh 4(2)',  'liability', 'Current Liabilities', false, 'credit')
ON CONFLICT (code) DO NOTHING;

-- ============================================================================
-- 1. tax_periods — one row per (fiscal_year, period_month, tax_type)
--
--    Separate from accounting_periods because tax filing periods do not
--    always align 1:1 with accounting periods (e.g. PPh Unifikasi vs PPN
--    both cover the same month but have independent filing/payment status).
-- ============================================================================
CREATE TABLE IF NOT EXISTS tax_periods (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  fiscal_year        int         NOT NULL,
  period_month       int         NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  tax_type           text        NOT NULL CHECK (tax_type IN
                       ('PPN','PPh21','PPh22','PPh23','PPh4(2)','PPh_Unifikasi')),
  period_start       date        NOT NULL,
  period_end         date        NOT NULL,
  filing_due_date    date,
  payment_due_date   date,
  status             text        NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open','payment_pending','paid','filed','closed','reopened')),
  filing_status      text        NOT NULL DEFAULT 'not_filed'
                       CHECK (filing_status IN ('not_filed','draft','filed','amended')),
  filed_at           timestamptz,
  filed_by           uuid REFERENCES auth.users(id),
  closed_at          timestamptz,
  closed_by          uuid REFERENCES auth.users(id),
  reopen_reason      text,
  reopened_at        timestamptz,
  reopened_by        uuid REFERENCES auth.users(id),
  -- Snapshot fields populated by compute_period_ppn() RPC (Phase 1b)
  input_ppn_total    numeric(18,2) NOT NULL DEFAULT 0,
  output_ppn_total   numeric(18,2) NOT NULL DEFAULT 0,
  net_ppn            numeric(18,2) NOT NULL DEFAULT 0,
  carry_forward_in   numeric(18,2) NOT NULL DEFAULT 0,
  carry_forward_out  numeric(18,2) NOT NULL DEFAULT 0,
  pph_total          numeric(18,2) NOT NULL DEFAULT 0,
  notes              text,
  created_by         uuid REFERENCES auth.users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (fiscal_year, period_month, tax_type)
);

CREATE INDEX IF NOT EXISTS idx_tax_periods_year_month ON tax_periods(fiscal_year, period_month);
CREATE INDEX IF NOT EXISTS idx_tax_periods_status     ON tax_periods(status);
CREATE INDEX IF NOT EXISTS idx_tax_periods_due        ON tax_periods(payment_due_date);

-- ============================================================================
-- 2. tax_payments — one row per remittance to the government
--
--    Rather than posting its own journal entry, a tax_payment links to a
--    payment_voucher (payment_type='tax_payment') which fires the existing
--    post_payment_voucher_journal trigger.  That guarantees a single
--    posting path, single reconciliation surface, and reuse of the existing
--    Bank Reconciliation engine (via journal_entry_id → bank_reconciliation_items).
-- ============================================================================
CREATE TABLE IF NOT EXISTS tax_payments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tax_period_id         uuid NOT NULL REFERENCES tax_periods(id) ON DELETE RESTRICT,
  tax_type              text NOT NULL CHECK (tax_type IN
                          ('PPN','PPh21','PPh22','PPh23','PPh4(2)','PPh_Unifikasi')),
  payment_date          date NOT NULL,
  amount                numeric(18,2) NOT NULL CHECK (amount > 0),
  bank_account_id       uuid REFERENCES bank_accounts(id),
  billing_code          text,        -- Kode Billing (SSE / MPN)
  ntpn                  text,        -- Nomor Transaksi Penerimaan Negara
  government_reference  text,        -- fallback reference when NTPN not yet issued
  notes                 text,
  -- Reconciliation glue: filled by record_tax_payment() RPC
  payment_voucher_id    uuid REFERENCES payment_vouchers(id) ON DELETE SET NULL,
  journal_entry_id      uuid REFERENCES journal_entries(id)  ON DELETE SET NULL,
  status                text NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft','posted','reconciled','void')),
  created_by            uuid REFERENCES auth.users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tax_payments_period ON tax_payments(tax_period_id);
CREATE INDEX IF NOT EXISTS idx_tax_payments_pv     ON tax_payments(payment_voucher_id);
CREATE INDEX IF NOT EXISTS idx_tax_payments_je     ON tax_payments(journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_tax_payments_date   ON tax_payments(payment_date);
CREATE INDEX IF NOT EXISTS idx_tax_payments_status ON tax_payments(status);

-- Attachments — mirrors petty_cash_files pattern.
CREATE TABLE IF NOT EXISTS tax_payment_files (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tax_payment_id    uuid NOT NULL REFERENCES tax_payments(id) ON DELETE CASCADE,
  file_url          text NOT NULL,
  file_name         varchar(255),
  file_type         varchar(50),
  file_size         integer,
  kind              text CHECK (kind IN ('billing_code','ntpn','government_receipt','bank_transfer_proof','faktur_pajak','other')),
  uploaded_by       uuid REFERENCES auth.users(id),
  uploaded_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tax_payment_files_payment ON tax_payment_files(tax_payment_id);

-- ============================================================================
-- 3. faktur_pajak — one row per sales_invoice with an assigned faktur number
--
--    Existing sales_invoices.faktur_pajak_number remains the source of truth
--    for the number itself; this table adds status tracking + attachments.
-- ============================================================================
CREATE TABLE IF NOT EXISTS faktur_pajak (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_invoice_id   uuid NOT NULL UNIQUE REFERENCES sales_invoices(id) ON DELETE CASCADE,
  tax_period_id      uuid REFERENCES tax_periods(id),
  faktur_number      varchar(50) NOT NULL,
  issue_date         date NOT NULL,
  customer_id        uuid REFERENCES customers(id),
  dpp_amount         numeric(18,2) NOT NULL DEFAULT 0,
  ppn_amount         numeric(18,2) NOT NULL DEFAULT 0,
  status             text NOT NULL DEFAULT 'generated'
                       CHECK (status IN ('generated','uploaded','reported','cancelled')),
  reported_at        timestamptz,
  notes              text,
  created_by         uuid REFERENCES auth.users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (faktur_number)
);

CREATE INDEX IF NOT EXISTS idx_faktur_pajak_period ON faktur_pajak(tax_period_id);
CREATE INDEX IF NOT EXISTS idx_faktur_pajak_status ON faktur_pajak(status);
CREATE INDEX IF NOT EXISTS idx_faktur_pajak_issue  ON faktur_pajak(issue_date);

CREATE TABLE IF NOT EXISTS faktur_pajak_files (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  faktur_pajak_id   uuid NOT NULL REFERENCES faktur_pajak(id) ON DELETE CASCADE,
  file_url          text NOT NULL,
  file_name         varchar(255),
  file_type         varchar(50),
  file_size         integer,
  kind              text CHECK (kind IN ('pdf','xml','csv','other')),
  uploaded_by       uuid REFERENCES auth.users(id),
  uploaded_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_faktur_pajak_files_faktur ON faktur_pajak_files(faktur_pajak_id);

-- ============================================================================
-- 4. tax_calendar_config — configurable Indonesian due-date rules
--
--    Indonesian defaults (2026):
--      PPN         → filing/payment by end of following month
--      PPh21       → filing 20th, payment 10th of following month
--      PPh22       → filing 20th of following month, payment on transaction
--      PPh23       → filing 20th, payment 10th of following month
--      PPh4(2)     → filing 20th, payment 15th of following month
--      PPh_Unifikasi → filing 20th of following month
-- ============================================================================
CREATE TABLE IF NOT EXISTS tax_calendar_config (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tax_type                      text NOT NULL UNIQUE
                                  CHECK (tax_type IN
                                    ('PPN','PPh21','PPh22','PPh23','PPh4(2)','PPh_Unifikasi')),
  payment_due_day               int  CHECK (payment_due_day BETWEEN 1 AND 31),
  filing_due_day                int  CHECK (filing_due_day  BETWEEN 1 AND 31),
  due_relative_month_offset     int  NOT NULL DEFAULT 1,
  end_of_month_payment          boolean NOT NULL DEFAULT false,
  description                   text,
  is_active                     boolean NOT NULL DEFAULT true,
  updated_by                    uuid REFERENCES auth.users(id),
  updated_at                    timestamptz NOT NULL DEFAULT now()
);

INSERT INTO tax_calendar_config
  (tax_type,        payment_due_day, filing_due_day, due_relative_month_offset, end_of_month_payment, description)
VALUES
  ('PPN',           NULL, NULL, 1, true,  'PPN: payment & filing by end of following month'),
  ('PPh21',         10,   20,   1, false, 'PPh 21: pay by 10th, file by 20th of following month'),
  ('PPh22',         NULL, 20,   1, false, 'PPh 22: paid on transaction, file by 20th of following month'),
  ('PPh23',         10,   20,   1, false, 'PPh 23: pay by 10th, file by 20th of following month'),
  ('PPh4(2)',       15,   20,   1, false, 'PPh 4(2): pay by 15th, file by 20th of following month'),
  ('PPh_Unifikasi', NULL, 20,   1, false, 'PPh Unifikasi: file by 20th of following month')
ON CONFLICT (tax_type) DO NOTHING;

-- ============================================================================
-- 5. Additive columns on existing tables
-- ============================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='sales_invoices' AND column_name='tax_period_id') THEN
    ALTER TABLE sales_invoices ADD COLUMN tax_period_id uuid REFERENCES tax_periods(id);
    CREATE INDEX idx_sales_invoices_tax_period ON sales_invoices(tax_period_id);
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_name='finance_expenses')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name='finance_expenses' AND column_name='tax_period_id') THEN
    ALTER TABLE finance_expenses ADD COLUMN tax_period_id uuid REFERENCES tax_periods(id);
    CREATE INDEX idx_finance_expenses_tax_period ON finance_expenses(tax_period_id);
  END IF;
END $$;

-- ============================================================================
-- 6. Approval thresholds — allow tax payment approval + period close approval
-- ============================================================================
INSERT INTO approval_thresholds (transaction_type, min_amount, max_amount, required_role, description) VALUES
  ('tax_payment_approval', 0,           10000000,    'manager', 'Tax payments up to Rp 10.000.000 require manager approval'),
  ('tax_payment_approval', 10000000,    NULL,        'admin',   'Tax payments over Rp 10.000.000 require admin approval'),
  ('tax_period_close',     0,           NULL,        'admin',   'Closing a tax period always requires admin approval')
ON CONFLICT (transaction_type, min_amount, max_amount) DO NOTHING;

-- ============================================================================
-- 7. Views — the tax reports read from these; the UI never joins raw tables
-- ============================================================================

-- Net PPN per period (Output − Input − carry-forward-in)
CREATE OR REPLACE VIEW public.vw_ppn_net_by_period AS
SELECT
  tp.id                                                  AS tax_period_id,
  tp.fiscal_year,
  tp.period_month,
  tp.period_start,
  tp.period_end,
  tp.status,
  tp.filing_status,
  tp.input_ppn_total,
  tp.output_ppn_total,
  tp.carry_forward_in,
  (tp.output_ppn_total - tp.input_ppn_total - tp.carry_forward_in) AS net_ppn_payable,
  GREATEST(tp.input_ppn_total - tp.output_ppn_total, 0)            AS carry_forward_out,
  tp.payment_due_date,
  tp.filing_due_date
FROM tax_periods tp
WHERE tp.tax_type = 'PPN';

-- PPh totals per period + type (drawn from finance_expenses)
CREATE OR REPLACE VIEW public.vw_pph_by_period_type AS
SELECT
  tp.id                                          AS tax_period_id,
  tp.fiscal_year,
  tp.period_month,
  tp.tax_type,
  COALESCE(SUM(fe.pph_amount), 0)                AS pph_total,
  COALESCE(SUM(fe.pph_paid_amount), 0)           AS pph_paid_total,
  COALESCE(SUM(fe.pph_amount) - SUM(fe.pph_paid_amount), 0) AS pph_outstanding,
  tp.status,
  tp.payment_due_date,
  tp.filing_due_date
FROM tax_periods tp
LEFT JOIN finance_expenses fe
  ON fe.tax_period_id = tp.id
 AND (
   (tp.tax_type = 'PPh21'   AND fe.pph_amount > 0)
   OR (tp.tax_type = 'PPh22' AND fe.pph_amount > 0)
   OR (tp.tax_type = 'PPh23' AND fe.pph_amount > 0)
   OR (tp.tax_type = 'PPh4(2)' AND fe.pph_amount > 0)
   OR (tp.tax_type = 'PPh_Unifikasi' AND fe.pph_amount > 0)
 )
WHERE tp.tax_type <> 'PPN'
GROUP BY tp.id, tp.fiscal_year, tp.period_month, tp.tax_type,
         tp.status, tp.payment_due_date, tp.filing_due_date;

-- Outstanding tax across all periods
CREATE OR REPLACE VIEW public.vw_outstanding_tax AS
SELECT
  tp.id                                          AS tax_period_id,
  tp.fiscal_year,
  tp.period_month,
  tp.tax_type,
  tp.status,
  tp.payment_due_date,
  CASE
    WHEN tp.tax_type = 'PPN' THEN GREATEST(
      tp.output_ppn_total - tp.input_ppn_total - tp.carry_forward_in
      - COALESCE((SELECT SUM(amount) FROM tax_payments
                  WHERE tax_period_id = tp.id AND status IN ('posted','reconciled')), 0),
      0)
    ELSE GREATEST(
      tp.pph_total
      - COALESCE((SELECT SUM(amount) FROM tax_payments
                  WHERE tax_period_id = tp.id AND status IN ('posted','reconciled')), 0),
      0)
  END                                            AS outstanding_amount
FROM tax_periods tp
WHERE tp.status NOT IN ('paid','closed');

-- Compact one-row-per-period status view for the calendar UI
CREATE OR REPLACE VIEW public.vw_tax_period_status AS
SELECT
  tp.id,
  tp.fiscal_year,
  tp.period_month,
  tp.tax_type,
  tp.status,
  tp.filing_status,
  tp.payment_due_date,
  tp.filing_due_date,
  tp.net_ppn,
  tp.pph_total,
  (SELECT COUNT(*) FROM tax_payments WHERE tax_period_id = tp.id AND status = 'reconciled') AS reconciled_payments_count,
  (SELECT COUNT(*) FROM tax_payments WHERE tax_period_id = tp.id AND status IN ('draft','posted')) AS unreconciled_payments_count,
  (SELECT COUNT(*) FROM sales_invoices si
     WHERE si.tax_period_id = tp.id
       AND (si.faktur_pajak_number IS NULL OR si.faktur_pajak_number = '')
       AND (si.tax_amount > 0)) AS missing_faktur_count
FROM tax_periods tp;

-- ============================================================================
-- 8. RLS — mirror the "authenticated read; admin/manager write" convention
--         used by other Finance tables.  service_role bypasses RLS entirely.
-- ============================================================================

ALTER TABLE tax_periods         ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_payments        ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_payment_files   ENABLE ROW LEVEL SECURITY;
ALTER TABLE faktur_pajak        ENABLE ROW LEVEL SECURITY;
ALTER TABLE faktur_pajak_files  ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_calendar_config ENABLE ROW LEVEL SECURITY;

-- Reusable predicate: caller is finance-privileged
--  (admin or manager, is_active). Kept as a helper CTE-style scalar via
--  EXISTS in each policy to avoid dependency on a helper function.

-- tax_periods -----------------------------------------------------------------
DROP POLICY IF EXISTS "tax_periods_select" ON tax_periods;
CREATE POLICY "tax_periods_select" ON tax_periods
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "tax_periods_write" ON tax_periods;
CREATE POLICY "tax_periods_write" ON tax_periods
  FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM user_profiles up
            WHERE up.id = (SELECT auth.uid())
              AND up.role IN ('admin','manager')
              AND up.is_active = true)
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM user_profiles up
            WHERE up.id = (SELECT auth.uid())
              AND up.role IN ('admin','manager')
              AND up.is_active = true)
  );

-- tax_payments ----------------------------------------------------------------
DROP POLICY IF EXISTS "tax_payments_select" ON tax_payments;
CREATE POLICY "tax_payments_select" ON tax_payments
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "tax_payments_write" ON tax_payments;
CREATE POLICY "tax_payments_write" ON tax_payments
  FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM user_profiles up
            WHERE up.id = (SELECT auth.uid())
              AND up.role IN ('admin','manager')
              AND up.is_active = true)
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM user_profiles up
            WHERE up.id = (SELECT auth.uid())
              AND up.role IN ('admin','manager')
              AND up.is_active = true)
  );

-- tax_payment_files -----------------------------------------------------------
DROP POLICY IF EXISTS "tax_payment_files_select" ON tax_payment_files;
CREATE POLICY "tax_payment_files_select" ON tax_payment_files
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "tax_payment_files_write" ON tax_payment_files;
CREATE POLICY "tax_payment_files_write" ON tax_payment_files
  FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM user_profiles up
            WHERE up.id = (SELECT auth.uid())
              AND up.role IN ('admin','manager')
              AND up.is_active = true)
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM user_profiles up
            WHERE up.id = (SELECT auth.uid())
              AND up.role IN ('admin','manager')
              AND up.is_active = true)
  );

-- faktur_pajak ----------------------------------------------------------------
DROP POLICY IF EXISTS "faktur_pajak_select" ON faktur_pajak;
CREATE POLICY "faktur_pajak_select" ON faktur_pajak
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "faktur_pajak_write" ON faktur_pajak;
CREATE POLICY "faktur_pajak_write" ON faktur_pajak
  FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM user_profiles up
            WHERE up.id = (SELECT auth.uid())
              AND up.role IN ('admin','manager')
              AND up.is_active = true)
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM user_profiles up
            WHERE up.id = (SELECT auth.uid())
              AND up.role IN ('admin','manager')
              AND up.is_active = true)
  );

-- faktur_pajak_files ----------------------------------------------------------
DROP POLICY IF EXISTS "faktur_pajak_files_select" ON faktur_pajak_files;
CREATE POLICY "faktur_pajak_files_select" ON faktur_pajak_files
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "faktur_pajak_files_write" ON faktur_pajak_files;
CREATE POLICY "faktur_pajak_files_write" ON faktur_pajak_files
  FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM user_profiles up
            WHERE up.id = (SELECT auth.uid())
              AND up.role IN ('admin','manager')
              AND up.is_active = true)
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM user_profiles up
            WHERE up.id = (SELECT auth.uid())
              AND up.role IN ('admin','manager')
              AND up.is_active = true)
  );

-- tax_calendar_config — read-open, admin-only write
DROP POLICY IF EXISTS "tax_calendar_config_select" ON tax_calendar_config;
CREATE POLICY "tax_calendar_config_select" ON tax_calendar_config
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "tax_calendar_config_write" ON tax_calendar_config;
CREATE POLICY "tax_calendar_config_write" ON tax_calendar_config
  FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM user_profiles up
            WHERE up.id = (SELECT auth.uid())
              AND up.role = 'admin'
              AND up.is_active = true)
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM user_profiles up
            WHERE up.id = (SELECT auth.uid())
              AND up.role = 'admin'
              AND up.is_active = true)
  );

-- ============================================================================
-- 9. updated_at trigger — mirrors existing convention
-- ============================================================================
CREATE OR REPLACE FUNCTION public.set_updated_at_tax_compliance()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_tax_periods_updated_at') THEN
    CREATE TRIGGER trg_tax_periods_updated_at
      BEFORE UPDATE ON tax_periods
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_tax_compliance();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_tax_payments_updated_at') THEN
    CREATE TRIGGER trg_tax_payments_updated_at
      BEFORE UPDATE ON tax_payments
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_tax_compliance();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_faktur_pajak_updated_at') THEN
    CREATE TRIGGER trg_faktur_pajak_updated_at
      BEFORE UPDATE ON faktur_pajak
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_tax_compliance();
  END IF;
END $$;

COMMIT;
