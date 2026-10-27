-- =====================================================
-- SEED DATA FOR PHARMA TRADING MANAGEMENT SYSTEM
-- =====================================================
-- This script creates:
-- 1. Test users with different roles (admin, accounts, sales, warehouse)
-- 2. Sample products (APIs, excipients, solvents)
-- 3. Sample customers
-- 4. Import batches with inventory
-- 5. CRM leads and activities
-- 6. Sales invoices with line items
-- 7. Finance expenses
-- =====================================================

-- Note: You must create auth.users manually in Supabase Dashboard first
-- or use the Supabase Auth API to create users with these emails:
-- 1. admin@pharma.com (password: admin123)
-- 2. accounts@pharma.com (password: accounts123)
-- 3. sales@pharma.com (password: sales123)
-- 4. warehouse@pharma.com (password: warehouse123)

-- After creating auth users, get their UUIDs and update the user_profiles inserts below

-- For now, we'll use placeholder UUIDs that you'll need to replace
-- with actual auth.user IDs from your Supabase Dashboard

-- =====================================================
-- HELPER: Generate sample UUIDs (replace with real ones)
-- =====================================================
DO $$
DECLARE
  admin_id uuid := '00000000-0000-0000-0000-000000000001';
  accounts_id uuid := '00000000-0000-0000-0000-000000000002';
  sales_id uuid := '00000000-0000-0000-0000-000000000003';
  warehouse_id uuid := '00000000-0000-0000-0000-000000000004';
BEGIN
  -- Note: In production, these IDs must match actual auth.users IDs
  -- For testing, you can create users via Supabase Dashboard and update these IDs

  RAISE NOTICE 'Please create the following users in Supabase Auth Dashboard:';
  RAISE NOTICE '1. admin@pharma.com (password: admin123) - then add this UUID: %', admin_id;
  RAISE NOTICE '2. accounts@pharma.com (password: accounts123) - then add this UUID: %', accounts_id;
  RAISE NOTICE '3. sales@pharma.com (password: sales123) - then add this UUID: %', sales_id;
  RAISE NOTICE '4. warehouse@pharma.com (password: warehouse123) - then add this UUID: %', warehouse_id;
END $$;

-- =====================================================
-- PRODUCTS
-- =====================================================
INSERT INTO products (product_name, product_code, hsn_code, category, unit, packaging_type, default_supplier, description, is_active) VALUES
-- APIs (Active Pharmaceutical Ingredients)
('Paracetamol DC 90', 'API-PCM-001', '29242990', 'api', 'kg', '25kg Fiber Drum', 'Shanghai Pharmaceuticals', 'High-grade paracetamol for direct compression tablets', true),
('Ibuprofen BP', 'API-IBU-001', '29163100', 'api', 'kg', '25kg Fiber Drum', 'BASF Germany', 'Ibuprofen complying with British Pharmacopoeia standards', true),
('Metformin HCl', 'API-MET-001', '29252900', 'api', 'kg', '25kg Fiber Drum', 'Harman Finochem India', 'Metformin Hydrochloride for anti-diabetic formulations', true),
('Amoxicillin Trihydrate', 'API-AMX-001', '29411090', 'api', 'kg', '25kg Aluminum Container', 'Centrient Netherlands', 'Beta-lactam antibiotic, sterile grade', true),
('Cetirizine Dihydrochloride', 'API-CET-001', '29335990', 'api', 'kg', '25kg Fiber Drum', 'Neuland Labs India', 'Antihistamine for allergy relief medications', true),

-- Excipients
('Microcrystalline Cellulose PH102', 'EXC-MCC-102', '39123990', 'excipient', 'kg', '20kg Paper Bag', 'DFE Pharma Germany', 'Direct compression excipient, high flowability', true),
('Lactose Monohydrate', 'EXC-LAC-001', '17021900', 'excipient', 'kg', '25kg Paper Bag', 'DFE Pharma Germany', 'Pharmaceutical grade lactose for tablets and capsules', true),
('Magnesium Stearate', 'EXC-MGS-001', '29157090', 'excipient', 'kg', '25kg Fiber Drum', 'FACI Asia Pacific', 'Vegetable source lubricant for tablet compression', true),
('Croscarmellose Sodium', 'EXC-CCS-001', '39123990', 'excipient', 'kg', '20kg Paper Bag', 'JRS Pharma Germany', 'Super disintegrant for immediate release tablets', true),
('Polyvinylpyrrolidone K30', 'EXC-PVP-030', '39059990', 'excipient', 'kg', '25kg Fiber Drum', 'Ashland USA', 'Binder and film-forming agent', true),
('Hydroxypropyl Methylcellulose E5', 'EXC-HPMC-E5', '39123990', 'excipient', 'kg', '25kg Paper Bag', 'Colorcon India', 'Film coating polymer for tablets', true),
('Starch 1500', 'EXC-STA-001', '11081300', 'excipient', 'kg', '25kg Paper Bag', 'Colorcon USA', 'Pregelatinized starch for wet granulation', true),

-- Solvents
('Isopropyl Alcohol 99.9%', 'SOL-IPA-001', '29051220', 'solvent', 'litre', '200L Drum', 'Shell Chemicals', 'High purity IPA for pharmaceutical cleaning', true),
('Ethanol 96% Denatured', 'SOL-ETH-001', '22071000', 'solvent', 'litre', '200L Drum', 'Wilmar Indonesia', 'Denatured ethanol for extraction processes', true),
('Purified Water USP', 'SOL-H2O-001', '28539000', 'solvent', 'litre', '1000L IBC', 'In-house RO Plant', 'Sterile purified water meeting USP standards', true),

-- Other materials
('Gelatin Capsules Size 0', 'OTH-CAP-000', '35030019', 'other', 'piece', '100,000 pcs/carton', 'CapsCanada', 'Hard gelatin capsules for powder filling', true),
('Blister PVC Film 250 micron', 'OTH-BLS-001', '39201090', 'other', 'kg', '30kg Roll', 'Bilcare India', 'Pharmaceutical grade PVC for blister packaging', true),
('Aluminum Foil 20 micron', 'OTH-ALU-001', '76071990', 'other', 'kg', '20kg Roll', 'Raviraj Foils India', 'Cold-form aluminum foil for blister packs', true);

-- =====================================================
-- CUSTOMERS
-- =====================================================
INSERT INTO customers (customer_name, company_name, npwp, address, city, country, contact_person, email, phone, gst_vat_type, payment_terms, is_active) VALUES
('PT Kimia Farma Trading', 'PT Kimia Farma Trading & Distribution', '01.310.285.4-092.000', 'Jl. Veteran No. 9, Ps. Baru', 'Jakarta Pusat', 'Indonesia', 'Budi Santoso', 'budi.santoso@kimiafarma.co.id', '+62-21-3841031', 'PKP', 'Net 30', true),
('PT Indofarma Global Medika', 'PT Indofarma Global Medika', '01.001.713.7-411.000', 'Jl. Indofarma No. 1, Cikarang', 'Bekasi', 'Indonesia', 'Siti Nurhaliza', 'siti.n@indofarma.id', '+62-21-89841109', 'PKP', 'Net 45', true),
('PT Kalbe Farma Tbk', 'PT Kalbe Farma Tbk', '01.001.814.7-093.000', 'Gedung Kalbe, Jl. Let. Jend. Suprapto', 'Jakarta Utara', 'Indonesia', 'Dr. Ahmad Wijaya', 'ahmad.w@kalbe.co.id', '+62-21-42873888', 'PKP', 'Net 60', true),
('CV Sejahtera Medika', 'CV Sejahtera Medika', '07.654.321.8-543.000', 'Jl. Kesehatan Raya No. 45', 'Surabaya', 'Indonesia', 'Rizki Pratama', 'rizki@sejahteramedika.com', '+62-31-5319900', 'Non-PKP', 'Net 30', true),
('PT Dexa Medica', 'PT Dexa Medica', '01.310.577.9-092.000', 'Jl. Bambang Utoyo No. 138, Cibitung', 'Bekasi', 'Indonesia', 'Linda Kusuma', 'linda.k@dexa-medica.com', '+62-21-8834 7481', 'PKP', 'Net 45', true),
('PT Tempo Scan Pacific', 'PT Tempo Scan Pacific Tbk', '01.001.625.4-092.000', 'Gedung Tempo Scan Tower, Jl. HR Rasuna Said', 'Jakarta Selatan', 'Indonesia', 'Hendri Gunawan', 'hendri.g@tempo.co.id', '+62-21-5269888', 'PKP', 'Net 30', true),
('PT Sanbe Farma', 'PT Sanbe Farma', '00.105.035.3-411.000', 'Jl. Tamansari No. 103', 'Bandung', 'Indonesia', 'Dewi Lestari', 'dewi.l@sanbe.co.id', '+62-22-87302525', 'PKP', 'Net 45', true),
('PT Bernofarm', 'PT Bernofarm Pharmaceutical', '01.001.722.9-411.000', 'Jl. Raya Sedati-Gede, Pandean', 'Sidoarjo', 'Indonesia', 'Agus Setiawan', 'agus@bernofarm.com', '+62-31-8941401', 'PKP', 'Net 30', true);

-- =====================================================
-- BATCHES (Import batches with inventory)
-- =====================================================
INSERT INTO batches (batch_number, product_id, import_date, import_quantity, current_stock, packaging_details, import_price, duty_charges, freight_charges, other_charges, expiry_date, warehouse_location, is_active)
SELECT
  'BTH-2024-001',
  id,
  '2024-01-15',
  500,
  350,
  '20 drums x 25kg',
  15000000,
  1500000,
  750000,
  250000,
  '2026-01-15',
  'Warehouse A-01',
  true
FROM products WHERE product_code = 'API-PCM-001';

INSERT INTO batches (batch_number, product_id, import_date, import_quantity, current_stock, packaging_details, import_price, duty_charges, freight_charges, other_charges, expiry_date, warehouse_location, is_active)
SELECT
  'BTH-2024-002',
  id,
  '2024-02-20',
  250,
  180,
  '10 drums x 25kg',
  8500000,
  850000,
  425000,
  125000,
  '2026-02-20',
  'Warehouse A-02',
  true
FROM products WHERE product_code = 'API-IBU-001';

INSERT INTO batches (batch_number, product_id, import_date, import_quantity, current_stock, packaging_details, import_price, duty_charges, freight_charges, other_charges, expiry_date, warehouse_location, is_active)
SELECT
  'BTH-2024-003',
  id,
  '2024-03-10',
  1000,
  850,
  '50 bags x 20kg',
  5000000,
  500000,
  350000,
  150000,
  '2027-03-10',
  'Warehouse B-01',
  true
FROM products WHERE product_code = 'EXC-MCC-102';

INSERT INTO batches (batch_number, product_id, import_date, import_quantity, current_stock, packaging_details, import_price, duty_charges, freight_charges, other_charges, expiry_date, warehouse_location, is_active)
SELECT
  'BTH-2024-004',
  id,
  '2024-03-25',
  750,
  600,
  '30 bags x 25kg',
  3750000,
  375000,
  275000,
  100000,
  '2027-03-25',
  'Warehouse B-02',
  true
FROM products WHERE product_code = 'EXC-LAC-001';

INSERT INTO batches (batch_number, product_id, import_date, import_quantity, current_stock, packaging_details, import_price, duty_charges, freight_charges, other_charges, expiry_date, warehouse_location, is_active)
SELECT
  'BTH-2024-005',
  id,
  '2024-04-05',
  300,
  220,
  '12 drums x 25kg',
  12000000,
  1200000,
  600000,
  200000,
  '2026-04-05',
  'Warehouse A-03',
  true
FROM products WHERE product_code = 'API-MET-001';

INSERT INTO batches (batch_number, product_id, import_date, import_quantity, current_stock, packaging_details, import_price, duty_charges, freight_charges, other_charges, expiry_date, warehouse_location, is_active)
SELECT
  'BTH-2024-006',
  id,
  '2024-04-20',
  2000,
  1750,
  '10 drums x 200L',
  8000000,
  400000,
  600000,
  200000,
  '2025-04-20',
  'Warehouse C-01',
  true
FROM products WHERE product_code = 'SOL-IPA-001';

INSERT INTO batches (batch_number, product_id, import_date, import_quantity, current_stock, packaging_details, import_price, duty_charges, freight_charges, other_charges, expiry_date, warehouse_location, is_active)
SELECT
  'BTH-2024-007',
  id,
  '2024-05-10',
  100,
  75,
  '4 containers x 25kg',
  25000000,
  2500000,
  1250000,
  500000,
  '2025-11-10',
  'Cold Room A-01',
  true
FROM products WHERE product_code = 'API-AMX-001';

INSERT INTO batches (batch_number, product_id, import_date, import_quantity, current_stock, packaging_details, import_price, duty_charges, freight_charges, other_charges, expiry_date, warehouse_location, is_active)
SELECT
  'BTH-2024-008',
  id,
  '2024-06-01',
  500,
  450,
  '20 bags x 25kg',
  2500000,
  250000,
  200000,
  50000,
  '2027-06-01',
  'Warehouse B-03',
  true
FROM products WHERE product_code = 'EXC-MGS-001';

INSERT INTO batches (batch_number, product_id, import_date, import_quantity, current_stock, packaging_details, import_price, duty_charges, freight_charges, other_charges, expiry_date, warehouse_location, is_active)
SELECT
  'BTH-2024-009',
  id,
  '2024-06-15',
  150,
  120,
  '6 drums x 25kg',
  9000000,
  900000,
  450000,
  150000,
  '2026-06-15',
  'Warehouse A-04',
  true
FROM products WHERE product_code = 'API-CET-001';

INSERT INTO batches (batch_number, product_id, import_date, import_quantity, current_stock, packaging_details, import_price, duty_charges, freight_charges, other_charges, expiry_date, warehouse_location, is_active)
SELECT
  'BTH-2024-010',
  id,
  '2024-07-01',
  5000000,
  4500000,
  '50 cartons x 100,000 pcs',
  25000000,
  1250000,
  1000000,
  250000,
  '2029-07-01',
  'Warehouse D-01',
  true
FROM products WHERE product_code = 'OTH-CAP-000';

-- =====================================================
-- CRM LEADS
-- =====================================================
INSERT INTO crm_leads (company_name, contact_person, email, phone, product_interest, quantity_interest, lead_source, status, expected_close_date, estimated_value, notes) VALUES
('PT Pharos Indonesia', 'Budiman Wijaya', 'budiman@pharos.co.id', '+62-21-6545888', 'Paracetamol DC 90', '1000 kg', 'trade_show', 'negotiation', '2025-12-15', 65000000, 'Met at Indonesia Pharma Expo 2024. Interested in long-term supply agreement.'),
('PT Combiphar', 'Sarah Tan', 'sarah.tan@combiphar.com', '+62-21-4600800', 'Ibuprofen BP, Cetirizine', '500 kg each', 'referral', 'quotation', '2025-12-20', 45000000, 'Referred by PT Kalbe Farma. Requires CoA and MSDS.'),
('CV Medika Jaya', 'Rudi Hartono', 'rudi@medikajaya.com', '+62-31-7345123', 'Microcrystalline Cellulose', '2000 kg', 'cold_call', 'inquiry', '2026-01-30', 12000000, 'Small local manufacturer, price sensitive.'),
('PT Novell Pharmaceutical', 'Dr. Kevin Sutanto', 'kevin@novell.co.id', '+62-21-5367888', 'Metformin HCl', '750 kg', 'website', 'quotation', '2025-12-10', 38000000, 'Requested samples. Follow up on Dec 5.'),
('PT Sido Muncul', 'Ibu Retno', 'retno@sidomuncul.co.id', '+62-24-3580333', 'Various Excipients', 'Multiple', 'email', 'won', '2025-11-25', 75000000, 'Converted to customer. First PO received.'),
('PT Molex Ayus', 'Hendra Kusuma', 'hendra@molexayus.com', '+62-22-8201234', 'Amoxicillin Trihydrate', '200 kg', 'trade_show', 'lost', '2025-11-15', 55000000, 'Lost to competitor due to pricing. Keep for future opportunities.');

-- =====================================================
-- CRM ACTIVITIES
-- =====================================================
INSERT INTO crm_activities (lead_id, activity_type, subject, description, follow_up_date, is_completed)
SELECT
  id,
  'call',
  'Initial contact call',
  'Discussed product requirements and pricing. Will send quotation by email.',
  NOW() + INTERVAL '3 days',
  true
FROM crm_leads WHERE company_name = 'PT Pharos Indonesia';

INSERT INTO crm_activities (lead_id, activity_type, subject, description, follow_up_date, is_completed)
SELECT
  id,
  'email',
  'Quotation sent',
  'Sent detailed quotation with CoA, MSDS, and pricing for 1000kg Paracetamol DC 90.',
  NOW() + INTERVAL '5 days',
  false
FROM crm_leads WHERE company_name = 'PT Pharos Indonesia';

INSERT INTO crm_activities (lead_id, activity_type, subject, description, follow_up_date, is_completed)
SELECT
  id,
  'meeting',
  'Technical discussion',
  'Meeting scheduled to discuss technical specifications and delivery schedule.',
  NOW() + INTERVAL '7 days',
  false
FROM crm_leads WHERE company_name = 'PT Combiphar';

-- =====================================================
-- SALES INVOICES
-- =====================================================
INSERT INTO sales_invoices (invoice_number, customer_id, invoice_date, due_date, subtotal, tax_amount, discount_amount, total_amount, payment_status, delivery_challan_number, notes, is_draft)
SELECT
  'INV-2024-0001',
  id,
  '2024-09-15',
  '2024-10-15',
  45000000,
  4950000,
  0,
  49950000,
  'paid',
  'DC-2024-0015',
  'Payment received via bank transfer on Sept 30, 2024',
  false
FROM customers WHERE company_name = 'PT Kimia Farma Trading & Distribution';

INSERT INTO sales_invoices (invoice_number, customer_id, invoice_date, due_date, subtotal, tax_amount, discount_amount, total_amount, payment_status, delivery_challan_number, notes, is_draft)
SELECT
  'INV-2024-0002',
  id,
  '2024-09-20',
  '2024-11-04',
  32000000,
  3520000,
  0,
  35520000,
  'paid',
  'DC-2024-0018',
  'Payment received on Oct 28, 2024',
  false
FROM customers WHERE company_name = 'PT Indofarma Global Medika';

INSERT INTO sales_invoices (invoice_number, customer_id, invoice_date, due_date, subtotal, tax_amount, discount_amount, total_amount, payment_status, delivery_challan_number, notes, is_draft)
SELECT
  'INV-2024-0003',
  id,
  '2024-10-05',
  '2024-12-04',
  87500000,
  9625000,
  0,
  97125000,
  'pending',
  'DC-2024-0022',
  'Awaiting payment',
  false
FROM customers WHERE company_name = 'PT Kalbe Farma Tbk';

INSERT INTO sales_invoices (invoice_number, customer_id, invoice_date, due_date, subtotal, tax_amount, discount_amount, total_amount, payment_status, delivery_challan_number, notes, is_draft)
SELECT
  'INV-2024-0004',
  id,
  '2024-10-10',
  '2024-11-09',
  18000000,
  1980000,
  900000,
  19080000,
  'paid',
  'DC-2024-0025',
  '5% discount for early payment. Paid on Oct 25, 2024',
  false
FROM customers WHERE company_name = 'CV Sejahtera Medika';

INSERT INTO sales_invoices (invoice_number, customer_id, invoice_date, due_date, subtotal, tax_amount, discount_amount, total_amount, payment_status, delivery_challan_number, notes, is_draft)
SELECT
  'INV-2024-0005',
  id,
  '2024-10-25',
  '2024-12-09',
  54000000,
  5940000,
  0,
  59940000,
  'partial',
  'DC-2024-0031',
  'Partial payment received: Rp 30,000,000',
  false
FROM customers WHERE company_name = 'PT Dexa Medica';

INSERT INTO sales_invoices (invoice_number, customer_id, invoice_date, due_date, subtotal, tax_amount, discount_amount, total_amount, payment_status, delivery_challan_number, notes, is_draft)
SELECT
  'INV-2024-0006',
  id,
  '2024-10-30',
  '2024-11-29',
  28500000,
  3135000,
  0,
  31635000,
  'pending',
  'DC-2024-0034',
  'Payment due Nov 29, 2024',
  false
FROM customers WHERE company_name = 'PT Tempo Scan Pacific Tbk';

-- =====================================================
-- SALES INVOICE ITEMS
-- =====================================================
-- Invoice 1 items
INSERT INTO sales_invoice_items (invoice_id, product_id, batch_id, quantity, unit_price, tax_rate)
SELECT
  si.id,
  p.id,
  b.id,
  150,
  300000,
  11
FROM sales_invoices si
CROSS JOIN products p
CROSS JOIN batches b
WHERE si.invoice_number = 'INV-2024-0001'
  AND p.product_code = 'API-PCM-001'
  AND b.batch_number = 'BTH-2024-001';

-- Invoice 2 items
INSERT INTO sales_invoice_items (invoice_id, product_id, batch_id, quantity, unit_price, tax_rate)
SELECT
  si.id,
  p.id,
  b.id,
  70,
  457143,
  11
FROM sales_invoices si
CROSS JOIN products p
CROSS JOIN batches b
WHERE si.invoice_number = 'INV-2024-0002'
  AND p.product_code = 'API-IBU-001'
  AND b.batch_number = 'BTH-2024-002';

-- Invoice 3 items (multiple items)
INSERT INTO sales_invoice_items (invoice_id, product_id, batch_id, quantity, unit_price, tax_rate)
SELECT
  si.id,
  p.id,
  b.id,
  150,
  400000,
  11
FROM sales_invoices si
CROSS JOIN products p
CROSS JOIN batches b
WHERE si.invoice_number = 'INV-2024-0003'
  AND p.product_code = 'EXC-MCC-102'
  AND b.batch_number = 'BTH-2024-003';

INSERT INTO sales_invoice_items (invoice_id, product_id, batch_id, quantity, unit_price, tax_rate)
SELECT
  si.id,
  p.id,
  b.id,
  150,
  183333,
  11
FROM sales_invoices si
CROSS JOIN products p
CROSS JOIN batches b
WHERE si.invoice_number = 'INV-2024-0003'
  AND p.product_code = 'EXC-LAC-001'
  AND b.batch_number = 'BTH-2024-004';

-- Invoice 4 items
INSERT INTO sales_invoice_items (invoice_id, product_id, batch_id, quantity, unit_price, tax_rate)
SELECT
  si.id,
  p.id,
  b.id,
  80,
  225000,
  11
FROM sales_invoices si
CROSS JOIN products p
CROSS JOIN batches b
WHERE si.invoice_number = 'INV-2024-0004'
  AND p.product_code = 'API-MET-001'
  AND b.batch_number = 'BTH-2024-005';

-- Invoice 5 items
INSERT INTO sales_invoice_items (invoice_id, product_id, batch_id, quantity, unit_price, tax_rate)
SELECT
  si.id,
  p.id,
  b.id,
  25,
  2160000,
  11
FROM sales_invoices si
CROSS JOIN products p
CROSS JOIN batches b
WHERE si.invoice_number = 'INV-2024-0005'
  AND p.product_code = 'API-AMX-001'
  AND b.batch_number = 'BTH-2024-007';

-- Invoice 6 items
INSERT INTO sales_invoice_items (invoice_id, product_id, batch_id, quantity, unit_price, tax_rate)
SELECT
  si.id,
  p.id,
  b.id,
  250,
  114000,
  11
FROM sales_invoices si
CROSS JOIN products p
CROSS JOIN batches b
WHERE si.invoice_number = 'INV-2024-0006'
  AND p.product_code = 'SOL-IPA-001'
  AND b.batch_number = 'BTH-2024-006';

-- =====================================================
-- INVENTORY TRANSACTIONS
-- =====================================================
-- Purchase transactions (from batches)
INSERT INTO inventory_transactions (batch_id, transaction_type, quantity_change, reference_type, reference_id, notes)
SELECT id, 'purchase', import_quantity, 'batch', id, 'Initial import batch'
FROM batches;

-- Sales transactions (from invoices)
INSERT INTO inventory_transactions (batch_id, transaction_type, quantity_change, reference_type, reference_id, notes)
SELECT
  b.id,
  'sale',
  -sii.quantity,
  'invoice',
  si.id,
  'Sales invoice: ' || si.invoice_number
FROM sales_invoice_items sii
JOIN sales_invoices si ON si.id = sii.invoice_id
JOIN batches b ON b.id = sii.batch_id;

-- =====================================================
-- FINANCE EXPENSES
-- =====================================================
INSERT INTO finance_expenses (expense_category, amount, expense_date, description) VALUES
('warehouse_rent', 15000000, '2024-09-01', 'Monthly warehouse rent - September 2024'),
('warehouse_rent', 15000000, '2024-10-01', 'Monthly warehouse rent - October 2024'),
('utilities', 3500000, '2024-09-15', 'Electricity and water - September 2024'),
('utilities', 3800000, '2024-10-15', 'Electricity and water - October 2024'),
('salary', 45000000, '2024-09-25', 'Staff salaries - September 2024'),
('salary', 45000000, '2024-10-25', 'Staff salaries - October 2024'),
('office', 2500000, '2024-09-10', 'Office supplies and stationery'),
('office', 1800000, '2024-10-08', 'IT equipment and software licenses');

-- Add batch-specific expenses
INSERT INTO finance_expenses (expense_category, amount, expense_date, description, batch_id)
SELECT
  'duty',
  duty_charges,
  import_date,
  'Import duty for batch ' || batch_number,
  id
FROM batches WHERE duty_charges > 0;

INSERT INTO finance_expenses (expense_category, amount, expense_date, description, batch_id)
SELECT
  'freight',
  freight_charges,
  import_date,
  'Freight charges for batch ' || batch_number,
  id
FROM batches WHERE freight_charges > 0;

-- =====================================================
-- SUMMARY
-- =====================================================
DO $$
DECLARE
  product_count int;
  customer_count int;
  batch_count int;
  invoice_count int;
  lead_count int;
BEGIN
  SELECT COUNT(*) INTO product_count FROM products;
  SELECT COUNT(*) INTO customer_count FROM customers;
  SELECT COUNT(*) INTO batch_count FROM batches;
  SELECT COUNT(*) INTO invoice_count FROM sales_invoices;
  SELECT COUNT(*) INTO lead_count FROM crm_leads;

  RAISE NOTICE '========================================';
  RAISE NOTICE 'SEED DATA SUMMARY';
  RAISE NOTICE '========================================';
  RAISE NOTICE 'Products created: %', product_count;
  RAISE NOTICE 'Customers created: %', customer_count;
  RAISE NOTICE 'Batches created: %', batch_count;
  RAISE NOTICE 'Sales invoices created: %', invoice_count;
  RAISE NOTICE 'CRM leads created: %', lead_count;
  RAISE NOTICE '========================================';
  RAISE NOTICE '';
  RAISE NOTICE 'IMPORTANT: You still need to create auth users!';
  RAISE NOTICE 'Go to Supabase Dashboard > Authentication > Users';
  RAISE NOTICE 'Create users with these emails and passwords:';
  RAISE NOTICE '1. admin@pharma.com (password: admin123)';
  RAISE NOTICE '2. accounts@pharma.com (password: accounts123)';
  RAISE NOTICE '3. sales@pharma.com (password: sales123)';
  RAISE NOTICE '4. warehouse@pharma.com (password: warehouse123)';
  RAISE NOTICE '';
  RAISE NOTICE 'After creating each user, copy their UUID and run:';
  RAISE NOTICE 'INSERT INTO user_profiles (id, email, full_name, role, language, is_active)';
  RAISE NOTICE 'VALUES (''<UUID>'', ''<email>'', ''<name>'', ''<role>'', ''en'', true);';
  RAISE NOTICE '========================================';
END $$;
