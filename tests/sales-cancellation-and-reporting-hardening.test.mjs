import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const migrationSql = fs.readFileSync(
  'supabase/migrations/20261030120000_sales_invoice_canonical_lifecycle_and_reporting_hardening.sql',
  'utf8'
);
const salesSource = fs.readFileSync('src/pages/Sales.tsx', 'utf8');
const engineSource = fs.readFileSync('src/services/salesProfitabilityEngine.ts', 'utf8');
const excelSource = fs.readFileSync('src/utils/salesProfitabilityExcelExport.ts', 'utf8');
const modalSource = fs.readFileSync('src/components/ExportSalesProfitModal.tsx', 'utf8');
const reportSource = fs.readFileSync('src/pages/reports/CanonicalSalesProfitReport.tsx', 'utf8');

// ==============================================================================
// 1. Canonical Document Lifecycle & Schema Enhancements
// ==============================================================================
test('1. Migration schema adds structured document_status and cancellation metadata', () => {
  // Check column additions
  assert.match(
    migrationSql,
    /ALTER TABLE public\.sales_invoices\s+ADD COLUMN IF NOT EXISTS document_status text NOT NULL DEFAULT 'posted'\s+CHECK \(document_status IN \('draft', 'posted', 'cancelled'\)\);/,
    'Must add document_status with check constraint'
  );
  assert.match(
    migrationSql,
    /ALTER TABLE public\.sales_invoices\s+ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;/,
    'Must add cancelled_at timestamp'
  );
  assert.match(
    migrationSql,
    /ALTER TABLE public\.sales_invoices\s+ADD COLUMN IF NOT EXISTS cancelled_by uuid REFERENCES public\.user_profiles\(id\);/,
    'Must add cancelled_by foreign key'
  );
  assert.match(
    migrationSql,
    /ALTER TABLE public\.sales_invoices\s+ADD COLUMN IF NOT EXISTS cancellation_reason text;/,
    'Must add cancellation_reason column'
  );

  // Check performance index
  assert.match(
    migrationSql,
    /CREATE INDEX IF NOT EXISTS idx_sales_invoices_document_status\s+ON public\.sales_invoices\(document_status, invoice_date\);/,
    'Must create index on document_status and invoice_date'
  );

  // Check safe historical backfill
  assert.match(
    migrationSql,
    /UPDATE public\.sales_invoices\s+SET document_status = 'draft'\s+WHERE is_draft = true;/,
    'Must backfill draft invoices'
  );
  assert.match(
    migrationSql,
    /UPDATE public\.sales_invoices\s+SET document_status = 'cancelled'/s,
    'Must backfill historical cancelled invoices'
  );
  assert.match(
    migrationSql,
    /UPDATE public\.sales_invoices\s+SET document_status = 'posted'\s+WHERE document_status IS NULL;/,
    'Must default remaining rows to posted'
  );

  // Check two-way synchronization trigger
  assert.match(
    migrationSql,
    /CREATE OR REPLACE FUNCTION public\.trg_sync_sales_invoice_document_status\(\)/,
    'Must declare synchronization trigger function'
  );
  assert.match(
    migrationSql,
    /CREATE TRIGGER trg_sync_sales_invoice_document_status/,
    'Must create trigger on sales_invoices'
  );
});

// ==============================================================================
// 2. Central Sales Eligibility Rule & Canonical Views
// ==============================================================================
test('2. Single authoritative definition of reportable sales and canonical database views', () => {
  // Check active_sales_invoices view
  assert.match(
    migrationSql,
    /CREATE OR REPLACE VIEW public\.active_sales_invoices WITH \(security_invoker = true\) AS\s+SELECT \*\s+FROM public\.sales_invoices\s+WHERE document_status = 'posted'\s+AND is_draft = false;/,
    'Must create active_sales_invoices canonical view'
  );

  // Check active_sales_invoice_items view
  assert.match(
    migrationSql,
    /CREATE OR REPLACE VIEW public\.active_sales_invoice_items WITH \(security_invoker = true\) AS\s+SELECT sii\.\*\s+FROM public\.sales_invoice_items sii\s+JOIN public\.sales_invoices si ON si\.id = sii\.invoice_id\s+WHERE si\.document_status = 'posted'\s+AND si\.is_draft = false;/,
    'Must create active_sales_invoice_items canonical view'
  );

  // Check is_reportable_sales_invoice helper function
  assert.match(
    migrationSql,
    /CREATE OR REPLACE FUNCTION public\.is_reportable_sales_invoice\(/,
    'Must create is_reportable_sales_invoice function'
  );
});

// ==============================================================================
// 3. cancel_sales_invoice RPC Hardening
// ==============================================================================
test('3. cancel_sales_invoice RPC enforces idempotency and populates structured metadata', () => {
  assert.match(
    migrationSql,
    /CREATE OR REPLACE FUNCTION public\.cancel_sales_invoice\(/,
    'Must declare cancel_sales_invoice RPC'
  );

  // Idempotency check
  assert.match(
    migrationSql,
    /IF v_inv\.document_status = 'cancelled' OR v_inv\.notes LIKE '\[CANCELLED%' THEN\s+RETURN jsonb_build_object\(\s*'success', true,\s*'already_cancelled', true/,
    'Must return success without duplicate reversals if already cancelled'
  );

  // Updates document_status and metadata
  assert.match(
    migrationSql,
    /UPDATE public\.sales_invoices\s+SET document_status = 'cancelled',\s+cancelled_at = now\(\),\s+cancelled_by = v_caller,\s+cancellation_reason = v_reason/s,
    'Must update document_status, cancelled_at, cancelled_by, cancellation_reason'
  );

  // Reverses revenue & COGS journal entries
  assert.match(
    migrationSql,
    /v_je\.source_module \|\| '_cancellation'/,
    'Must reverse revenue journal entries'
  );
  assert.match(
    migrationSql,
    /'sales_invoice_cogs_cancellation'/,
    'Must reverse COGS journal entries'
  );
});

// ==============================================================================
// 4. create_sales_invoice_atomic and DC Lifecycle Invariants
// ==============================================================================
test('4. Delivery Challan deliverable capacity excludes cancelled invoices and permits replacement invoices', () => {
  // DC remaining quantity check excludes cancelled invoices
  assert.match(
    migrationSql,
    /WHERE sii\.delivery_challan_item_id = v_dc_item\s+AND COALESCE\(si\.document_status, 'posted'\) = 'posted'\s+AND NOT COALESCE\(si\.is_draft, false\)\s+AND NOT \(COALESCE\(si\.notes, ''\) LIKE '\[CANCELLED%'/s,
    'create_sales_invoice_atomic must check document_status = posted and exclude cancelled invoices'
  );

  // Inserts document_status on new sales invoice
  assert.match(
    migrationSql,
    /INSERT INTO public\.sales_invoices \([\s\S]*?document_status[\s\S]*?VALUES \([\s\S]*?v_doc_status/s,
    'Must persist document_status when creating sales invoice'
  );

  // dc_invoicing_summary view excludes cancelled invoices
  assert.match(
    migrationSql,
    /CREATE OR REPLACE VIEW public\.dc_invoicing_summary WITH \(security_invoker = true\) AS[\s\S]*?JOIN public\.sales_invoices si ON si\.id = sii\.invoice_id\s+AND COALESCE\(si\.document_status, 'posted'\) = 'posted'/s,
    'dc_invoicing_summary must exclude non-posted and cancelled invoices'
  );

  // so_delivery_invoice_status view excludes cancelled invoices
  assert.match(
    migrationSql,
    /CREATE OR REPLACE VIEW public\.so_delivery_invoice_status WITH \(security_invoker = true\) AS[\s\S]*?AND COALESCE\(si\.document_status, 'posted'\) = 'posted'/s,
    'so_delivery_invoice_status must check document_status = posted'
  );

  // trg_dc_reverse_product_reservation_v2 only blocks if active (posted) invoice exists
  assert.match(
    migrationSql,
    /CREATE OR REPLACE FUNCTION public\.trg_dc_reverse_product_reservation_v2\(\)[\s\S]*?AND COALESCE\(si\.document_status, 'posted'\) = 'posted'/s,
    'trg_dc_reverse_product_reservation_v2 must only block if uncancelled posted invoices exist'
  );
});

// ==============================================================================
// 5. Reporting Functions Exclude Cancelled Invoices
// ==============================================================================
test('5. All database reporting functions exclude cancelled invoices and return separate disclosure', () => {
  // get_authoritative_sales_line_cogs
  assert.match(
    migrationSql,
    /CREATE OR REPLACE FUNCTION public\.get_authoritative_sales_line_cogs[\s\S]*?AND COALESCE\(si\.document_status, 'posted'\) = 'posted'/s,
    'get_authoritative_sales_line_cogs must filter by document_status = posted'
  );

  // get_sales_profitability_line_expenses
  assert.match(
    migrationSql,
    /CREATE OR REPLACE FUNCTION public\.get_sales_profitability_line_expenses[\s\S]*?AND COALESCE\(si\.document_status, 'posted'\) = 'posted'/s,
    'get_sales_profitability_line_expenses must filter by document_status = posted'
  );

  // get_sales_profitability_summary returns cancelled_invoices disclosure
  assert.match(
    migrationSql,
    /CREATE OR REPLACE FUNCTION public\.get_sales_profitability_summary[\s\S]*?cancelled_invoices_data AS[\s\S]*?'cancelled_invoices', jsonb_build_object/s,
    'get_sales_profitability_summary must return cancelled_invoices disclosure in JSON'
  );

  // get_sales_profitability_product_batches
  assert.match(
    migrationSql,
    /CREATE OR REPLACE FUNCTION public\.get_sales_profitability_product_batches[\s\S]*?AND COALESCE\(si\.document_status, 'posted'\) = 'posted'/s,
    'get_sales_profitability_product_batches must filter by document_status = posted'
  );

  // get_sales_profitability_batch_orders
  assert.match(
    migrationSql,
    /CREATE OR REPLACE FUNCTION public\.get_sales_profitability_batch_orders[\s\S]*?AND COALESCE\(si\.document_status, 'posted'\) = 'posted'/s,
    'get_sales_profitability_batch_orders must filter by document_status = posted'
  );

  // get_sales_profit_summary
  assert.match(
    migrationSql,
    /CREATE OR REPLACE FUNCTION public\.get_sales_profit_summary[\s\S]*?AND COALESCE\(si\.document_status, 'posted'\) = 'posted'/s,
    'get_sales_profit_summary must filter by document_status = posted'
  );

  // get_sales_profit_drilldown
  assert.match(
    migrationSql,
    /CREATE OR REPLACE FUNCTION public\.get_sales_profit_drilldown[\s\S]*?AND COALESCE\(si\.document_status, 'posted'\) = 'posted'/s,
    'get_sales_profit_drilldown must filter by document_status = posted'
  );

  // get_customer_sales_report
  assert.match(
    migrationSql,
    /CREATE OR REPLACE FUNCTION public\.get_customer_sales_report[\s\S]*?AND COALESCE\(si\.document_status, 'posted'\) = 'posted'/s,
    'get_customer_sales_report must filter by document_status = posted'
  );

  // get_product_performance_report
  assert.match(
    migrationSql,
    /CREATE OR REPLACE FUNCTION public\.get_product_performance_report[\s\S]*?AND COALESCE\(si\.document_status, 'posted'\) = 'posted'/s,
    'get_product_performance_report must filter by document_status = posted'
  );
});

// ==============================================================================
// 6. Frontend Sales UI & Cancelled Archive
// ==============================================================================
test('6. Sales.tsx implements canonical lifecycle, tabbed navigation, and Cancelled Archive', () => {
  // SalesInvoice interface has document_status and cancellation metadata
  assert.match(
    salesSource,
    /document_status\?:\s*'draft' \| 'posted' \| 'cancelled';/,
    'SalesInvoice interface must define document_status'
  );
  assert.match(
    salesSource,
    /cancelled_at\?: string \| null;/,
    'SalesInvoice interface must define cancelled_at'
  );
  assert.match(
    salesSource,
    /cancellation_reason\?: string \| null;/,
    'SalesInvoice interface must define cancellation_reason'
  );

  // isCancelledInvoice and isPostedInvoice check document_status
  assert.match(
    salesSource,
    /function isCancelledInvoice\(invoice: SalesInvoice\): boolean\s*\{\s*return Boolean\(\s*invoice\.document_status === 'cancelled'/s,
    'isCancelledInvoice must check invoice.document_status === cancelled'
  );
  assert.match(
    salesSource,
    /function isPostedInvoice\(invoice: SalesInvoice\): boolean\s*\{\s*if \(isCancelledInvoice\(invoice\)\) return false;\s*if \(invoice\.document_status\) \{\s*return invoice\.document_status === 'posted';/s,
    'isPostedInvoice must check invoice.document_status === posted'
  );

  // Tab navigation state
  assert.match(
    salesSource,
    /const \[activeTab, setActiveTab\] = useState<'active' \| 'posted' \| 'drafts' \| 'cancelled'>\('active'\);/,
    'Sales.tsx must define activeTab state with active, posted, drafts, cancelled'
  );

  // Live KPI statistics exclude cancelled invoices
  assert.match(
    salesSource,
    /const activeInvoices = invoices\.filter\(\(inv\) => !isCancelledInvoice\(inv\)\);/,
    'Must filter activeInvoices excluding cancelled invoices'
  );
  assert.match(
    salesSource,
    /const cancelledInvoices = invoices\.filter\(\(inv\) => isCancelledInvoice\(inv\)\);/,
    'Must separate cancelledInvoices'
  );
  assert.match(
    salesSource,
    /total:\s*(activeInvoices\.length|invoices\.filter\(\(inv\)\s*=>\s*!isCancelledInvoice\(inv\)\)\.length)/,
    'Stats total must count active invoices only'
  );
  assert.match(
    salesSource,
    /totalRevenue:\s*(postedRevenue|postedInvoices\.reduce|activeInvoices\.reduce|invoices\s*\.filter\(\(inv\)\s*=>\s*!isCancelledInvoice\(inv\)\))/,
    'Stats totalRevenue must sum posted recognized invoices only'
  );

  // Cancelled Archive Tab UI with Archive Icon and Badge
  assert.match(
    salesSource,
    /<Archive className="w-3\.5 h-3\.5" \/>\s*Cancelled Archive/s,
    'Must render Cancelled Archive tab with Archive icon'
  );

  // Cancelled columns for audit archive
  assert.match(
    salesSource,
    /const cancelledColumns = \[/,
    'Sales.tsx must define dedicated cancelledColumns for archive view'
  );
  assert.match(
    salesSource,
    /columns=\{activeTab === 'cancelled' \? cancelledColumns : columns\}/,
    'DataTable must switch to cancelledColumns when on Cancelled Archive tab'
  );

  // Cancelled invoices cannot be edited or reposted
  assert.match(
    salesSource,
    /activeTab !== 'cancelled'/s,
    'Edit, Repost, and Delete buttons must be hidden on Cancelled Archive tab'
  );
});

// ==============================================================================
// 7. Sales Profitability Engine, Excel Export & UI Disclosures
// ==============================================================================
test('7. Profitability Engine, Excel Export, and Reports disclose excluded cancelled transactions', () => {
  // CompanyProfitabilitySummary interface includes cancelled_invoices
  assert.match(
    engineSource,
    /cancelled_invoices\?:\s*\{\s*count:\s*number;\s*total_amount:\s*number;\s*subtotal:\s*number;\s*total_qty:\s*number;\s*\};/s,
    'CompanyProfitabilitySummary must include cancelled_invoices interface'
  );

  // Excel export discloses excluded cancelled invoices
  assert.match(
    excelSource,
    /company\?\.cancelled_invoices && company\.cancelled_invoices\.count > 0/,
    'Excel export must check company.cancelled_invoices'
  );
  assert.match(
    excelSource,
    /AUDIT DISCLOSURE: Excludes[\s\S]*?cancelled sales invoice\(s\)/s,
    'Excel export must write prominent audit disclosure row'
  );

  // CanonicalSalesProfitReport displays audit disclosure banner
  assert.match(
    reportSource,
    /Excluded Cancelled Invoices:/,
    'CanonicalSalesProfitReport must render Excluded Cancelled Invoices disclosure banner'
  );

  // ExportSalesProfitModal displays audit reassurance
  assert.match(
    modalSource,
    /Audit Safe: Cancelled sales invoices are automatically excluded/,
    'ExportSalesProfitModal must assure user that cancelled invoices are excluded'
  );
});
