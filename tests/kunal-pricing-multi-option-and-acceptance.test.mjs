import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { execFileSync } from 'node:child_process';

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const PG_CONFIG = {
  host: '/tmp',
  port: 54329,
  database: 'test_kunal_pricing_multi_options',
  user: process.env.USER || 'Kunal',
};

function runPsqlCommand(sql, db = 'test_kunal_pricing_multi_options') {
  return execFileSync('/usr/local/bin/psql', [
    '-h', PG_CONFIG.host,
    '-p', String(PG_CONFIG.port),
    '-d', db,
    '-c', sql,
    '-v', 'ON_ERROR_STOP=1'
  ], { encoding: 'utf8' });
}

function runPsqlFile(filePath, db = 'test_kunal_pricing_multi_options') {
  execFileSync('/usr/local/bin/psql', [
    '-h', PG_CONFIG.host,
    '-p', String(PG_CONFIG.port),
    '-d', db,
    '-f', filePath,
    '-v', 'ON_ERROR_STOP=1'
  ], { encoding: 'utf8' });
}

test.describe('SAPJ ERP: Kunal Pricing Multi-Option Quotation & Customer Acceptance (Tests A - H)', () => {
  let pool;
  let adminUserId;
  let salesUserId;

  test.before(async () => {
    runPsqlCommand('DROP DATABASE IF EXISTS test_kunal_pricing_multi_options;', 'postgres');
    runPsqlCommand('CREATE DATABASE test_kunal_pricing_multi_options;', 'postgres');

    // Run baseline and setup required CRM tables
    runPsqlFile(path.join(rootDir, 'tests/fixtures/production-schema-baseline.sql'));

    runPsqlCommand(`
      CREATE TABLE IF NOT EXISTS public.crm_inquiries (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        inquiry_number text NOT NULL,
        company_name text,
        product_name text,
        quantity text,
        supplier_name text,
        purchase_price numeric,
        purchase_price_currency text,
        offered_price numeric,
        offered_price_currency text,
        kunal_price_status text,
        price_ready boolean,
        pipeline_status text,
        quote_status text,
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.crm_inquiry_timeline (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        inquiry_id uuid NOT NULL,
        event_type text NOT NULL,
        actor_id uuid,
        actor_name text,
        description text,
        metadata jsonb,
        created_at timestamptz DEFAULT now()
      );
    `);

    // Run our new migration
    runPsqlFile(path.join(rootDir, 'supabase/migrations/20261031120000_kunal_pricing_multi_option_quotation_and_acceptance.sql'));

    pool = new Pool(PG_CONFIG);

    adminUserId = 'a0000000-0000-0000-0000-000000000001';
    salesUserId = 'a0000000-0000-0000-0000-000000000002';

    await pool.query(`
      INSERT INTO public.user_profiles (id, full_name, role, is_active)
      VALUES 
        ($1, 'Kunal Admin', 'admin', true),
        ($2, 'Sales Representative', 'sales', true)
      ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, is_active = true;
    `, [adminUserId, salesUserId]);
  });

  test.after(async () => {
    if (pool) await pool.end();
  });

  // ----------------------------------------------------------------------------
  // Test A — Accepting an Alternative Make
  // ----------------------------------------------------------------------------
  test('Test A: Accepting an alternative make creates separate option and preserves primary', async () => {
    // 1. Create inquiry with primary IPCA
    const inqRes = await pool.query(`
      INSERT INTO public.crm_inquiries (inquiry_number, company_name, product_name, quantity, supplier_name)
      VALUES ('INQ-TEST-A', 'PT Phapros Tbk', 'PYRANTEL PAMOATE', '50 KG', 'IPCA')
      RETURNING id;
    `);
    const inqId = inqRes.rows[0].id;

    // 2. Initial state: IPCA option saved
    const initOptions = [
      {
        offered_make: 'IPCA',
        source_price: 2700,
        source_currency: 'INR',
        selling_price: 32.34,
        selling_currency: 'USD',
        landed_cost_usd: 29.50,
        suggested_quote_usd: 31.80,
        supplier: 'Sonal Gangawane',
        is_selected: true,
        include_in_customer_quote: true,
      }
    ];

    const res1 = await pool.query(`
      SELECT public.save_crm_inquiry_pricing_options($1::uuid, $2::jsonb) as opts;
    `, [inqId, JSON.stringify(initOptions)]);
    const saved1 = res1.rows[0].opts;
    assert.equal(saved1.length, 1);
    assert.equal(saved1[0].offered_make, 'IPCA');
    const ipcaId = saved1[0].id;

    // 3. User accepts alternative JRC: save both options
    const multiOptions = [
      {
        id: ipcaId,
        offered_make: 'IPCA',
        source_price: 2700,
        source_currency: 'INR',
        selling_price: 32.34,
        selling_currency: 'USD',
        landed_cost_usd: 29.50,
        suggested_quote_usd: 31.80,
        supplier: 'Sonal Gangawane',
        is_selected: true,
        include_in_customer_quote: true,
      },
      {
        offered_make: 'JRC',
        source_price: 2050,
        source_currency: 'INR',
        selling_price: 24.60,
        selling_currency: 'USD',
        landed_cost_usd: 22.40,
        suggested_quote_usd: 24.15,
        supplier: 'JRC Pharma',
        is_selected: false,
        include_in_customer_quote: true,
      }
    ];

    const res2 = await pool.query(`
      SELECT public.save_crm_inquiry_pricing_options($1::uuid, $2::jsonb) as opts;
    `, [inqId, JSON.stringify(multiOptions)]);
    const saved2 = res2.rows[0].opts;

    // Confirm:
    // a. Exactly 2 options exist
    assert.equal(saved2.length, 2);
    // b. IPCA remains saved with original rate
    const ipcaOpt = saved2.find(o => o.offered_make === 'IPCA');
    assert.ok(ipcaOpt);
    assert.equal(ipcaOpt.id, ipcaId);
    assert.equal(Number(ipcaOpt.source_price), 2700);
    assert.equal(ipcaOpt.is_selected, true);

    // c. JRC is saved as separate option with own price
    const jrcOpt = saved2.find(o => o.offered_make === 'JRC');
    assert.ok(jrcOpt);
    assert.notEqual(jrcOpt.id, ipcaId);
    assert.equal(Number(jrcOpt.source_price), 2050);
    assert.equal(jrcOpt.supplier, 'JRC Pharma');
    assert.equal(jrcOpt.is_selected, false);
    assert.equal(jrcOpt.include_in_customer_quote, true);

    // d. Confirm switching active source works
    const res3 = await pool.query(`
      SELECT public.save_crm_inquiry_pricing_options($1::uuid, $2::jsonb, $3::uuid) as opts;
    `, [inqId, JSON.stringify(saved2), jrcOpt.id]);
    const saved3 = res3.rows[0].opts;
    const jrcOptSwitched = saved3.find(o => o.id === jrcOpt.id);
    const ipcaOptSwitched = saved3.find(o => o.id === ipcaId);
    assert.equal(jrcOptSwitched.is_selected, true);
    assert.equal(ipcaOptSwitched.is_selected, false);
  });

  // ----------------------------------------------------------------------------
  // Test B — Deduplication on Re-Save
  // ----------------------------------------------------------------------------
  test('Test B: Saving existing options repeatedly does not create duplicate rows', async () => {
    const inqRes = await pool.query(`
      INSERT INTO public.crm_inquiries (inquiry_number, company_name, product_name, quantity, supplier_name)
      VALUES ('INQ-TEST-B', 'PT Kimia Farma', 'PYRANTEL PAMOATE', '25 KG', 'IPCA')
      RETURNING id;
    `);
    const inqId = inqRes.rows[0].id;

    const options = [
      { offered_make: 'IPCA', source_price: 2700, source_currency: 'INR', is_selected: true },
      { offered_make: 'JRC', source_price: 2050, source_currency: 'INR', is_selected: false }
    ];

    await pool.query(`SELECT public.save_crm_inquiry_pricing_options($1::uuid, $2::jsonb);`, [inqId, JSON.stringify(options)]);
    // Save a second time with same data (no IDs provided)
    await pool.query(`SELECT public.save_crm_inquiry_pricing_options($1::uuid, $2::jsonb);`, [inqId, JSON.stringify(options)]);
    // Save a third time
    await pool.query(`SELECT public.save_crm_inquiry_pricing_options($1::uuid, $2::jsonb);`, [inqId, JSON.stringify(options)]);

    // Check row count in table
    const countRes = await pool.query(`SELECT count(*) as count FROM public.crm_inquiry_pricing_options WHERE inquiry_id = $1;`, [inqId]);
    assert.equal(parseInt(countRes.rows[0].count, 10), 2, 'Must remain exactly 2 rows, not 4 or 6');
  });

  // ----------------------------------------------------------------------------
  // Test C — Generic Requested Make Handling
  // ----------------------------------------------------------------------------
  test('Test C: Generic requested make like ANY, INDIA is not stored as an artificial manufacturer', async () => {
    const inqRes = await pool.query(`
      INSERT INTO public.crm_inquiries (inquiry_number, company_name, product_name, quantity, supplier_name)
      VALUES ('INQ-TEST-C', 'CV Bianglala', 'PYRANTEL PAMOATE', '25 KG', 'ANY, INDIA')
      RETURNING id;
    `);
    const inqId = inqRes.rows[0].id;

    // Detected options are IPCA and JRC
    const options = [
      { offered_make: 'IPCA', source_price: 2700, source_currency: 'INR', is_selected: false, include_in_customer_quote: true },
      { offered_make: 'JRC', source_price: 2050, source_currency: 'INR', is_selected: true, include_in_customer_quote: true }
    ];

    const res = await pool.query(`SELECT public.save_crm_inquiry_pricing_options($1::uuid, $2::jsonb) as opts;`, [inqId, JSON.stringify(options)]);
    const saved = res.rows[0].opts;

    assert.equal(saved.length, 2);
    const makes = saved.map(o => o.offered_make);
    assert.ok(makes.includes('IPCA'));
    assert.ok(makes.includes('JRC'));
    assert.ok(!makes.includes('ANY, INDIA'), 'Should not contain generic make ANY, INDIA as an option');
  });

  // ----------------------------------------------------------------------------
  // Test D — Independent Calculations
  // ----------------------------------------------------------------------------
  test('Test D: Changing primary rate does not alter alternate pricing, and vice-versa', async () => {
    const inqRes = await pool.query(`
      INSERT INTO public.crm_inquiries (inquiry_number, company_name, product_name, quantity)
      VALUES ('INQ-TEST-D', 'PT Kalbe Farma', 'METFORMIN HCL', '500 KG')
      RETURNING id;
    `);
    const inqId = inqRes.rows[0].id;

    const options = [
      { offered_make: 'Make Alpha', source_price: 1500, selling_price: 20.00, landed_cost_usd: 18.00, is_selected: true },
      { offered_make: 'Make Beta', source_price: 1200, selling_price: 16.00, landed_cost_usd: 14.50, is_selected: false }
    ];

    const res1 = await pool.query(`SELECT public.save_crm_inquiry_pricing_options($1::uuid, $2::jsonb) as opts;`, [inqId, JSON.stringify(options)]);
    const [optA, optB] = res1.rows[0].opts;

    // Update Make Alpha rate to 1800 and selling_price to 23.50
    optA.source_price = 1800;
    optA.selling_price = 23.50;
    optA.landed_cost_usd = 21.20;

    const res2 = await pool.query(`SELECT public.save_crm_inquiry_pricing_options($1::uuid, $2::jsonb) as opts;`, [inqId, JSON.stringify([optA, optB])]);
    const updated = res2.rows[0].opts;

    const updatedA = updated.find(o => o.id === optA.id);
    const updatedB = updated.find(o => o.id === optB.id);

    // Make Alpha updated
    assert.equal(Number(updatedA.source_price), 1800);
    assert.equal(Number(updatedA.selling_price), 23.50);

    // Make Beta remains 100% untouched
    assert.equal(Number(updatedB.source_price), 1200);
    assert.equal(Number(updatedB.selling_price), 16.00);
    assert.equal(Number(updatedB.landed_cost_usd), 14.50);
  });

  // ----------------------------------------------------------------------------
  // Test E — Atomic Rollback on Error
  // ----------------------------------------------------------------------------
  test('Test E: Invalid inquiry ID fails atomically and does not create orphan records', async () => {
    const fakeInquiryId = '99999999-9999-9999-9999-999999999999';
    const options = [
      { offered_make: 'Test Make', source_price: 1000 }
    ];

    await assert.rejects(
      async () => {
        await pool.query(`SELECT public.save_crm_inquiry_pricing_options($1::uuid, $2::jsonb);`, [fakeInquiryId, JSON.stringify(options)]);
      },
      /CRM Inquiry with ID .* not found/
    );

    const countRes = await pool.query(`SELECT count(*) as count FROM public.crm_inquiry_pricing_options WHERE inquiry_id = $1;`, [fakeInquiryId]);
    assert.equal(parseInt(countRes.rows[0].count, 10), 0);
  });

  // ----------------------------------------------------------------------------
  // Test F — Customer Quotation Inclusion Toggle
  // ----------------------------------------------------------------------------
  test('Test F: Customer quotation inclusion flag toggles without deleting options', async () => {
    const inqRes = await pool.query(`
      INSERT INTO public.crm_inquiries (inquiry_number, company_name, product_name, quantity)
      VALUES ('INQ-TEST-F', 'PT Sanbe Farma', 'AMOXYCILLIN TRIHYDRATE', '100 KG')
      RETURNING id;
    `);
    const inqId = inqRes.rows[0].id;

    // Both included in customer quote
    const options = [
      { offered_make: 'Primary Make', source_price: 2500, is_selected: true, include_in_customer_quote: true },
      { offered_make: 'Alternate Make', source_price: 2200, is_selected: false, include_in_customer_quote: true }
    ];
    const res1 = await pool.query(`SELECT public.save_crm_inquiry_pricing_options($1::uuid, $2::jsonb) as opts;`, [inqId, JSON.stringify(options)]);
    const saved1 = res1.rows[0].opts;
    assert.equal(saved1.filter(o => o.include_in_customer_quote).length, 2);

    // Toggle OFF: Primary only
    saved1.find(o => !o.is_selected).include_in_customer_quote = false;
    const res2 = await pool.query(`SELECT public.save_crm_inquiry_pricing_options($1::uuid, $2::jsonb) as opts;`, [inqId, JSON.stringify(saved1)]);
    const saved2 = res2.rows[0].opts;
    assert.equal(saved2.length, 2, 'Alternate option still exists in database');
    assert.equal(saved2.filter(o => o.include_in_customer_quote).length, 1, 'Only primary is included in customer quote');

    // Toggle ON again: Both re-included
    saved2.find(o => !o.is_selected).include_in_customer_quote = true;
    const res3 = await pool.query(`SELECT public.save_crm_inquiry_pricing_options($1::uuid, $2::jsonb) as opts;`, [inqId, JSON.stringify(saved2)]);
    const saved3 = res3.rows[0].opts;
    assert.equal(saved3.filter(o => o.include_in_customer_quote).length, 2, 'Both options included in quote again');
  });

  // ----------------------------------------------------------------------------
  // Test G & H — Customer Option Acceptance Tracking
  // ----------------------------------------------------------------------------
  test('Test G & H: Customer acceptance tracks exact option ID and allows only one accepted option', async () => {
    const inqRes = await pool.query(`
      INSERT INTO public.crm_inquiries (inquiry_number, company_name, product_name, quantity)
      VALUES ('INQ-TEST-GH', 'PT Dexa Medica', 'CEFIXIME TRIHYDRATE', '25 KG')
      RETURNING id;
    `);
    const inqId = inqRes.rows[0].id;

    const options = [
      { offered_make: 'Make Alpha', selling_price: 150.00, selling_currency: 'USD', is_selected: true, include_in_customer_quote: true },
      { offered_make: 'Make Beta', selling_price: 135.00, selling_currency: 'USD', is_selected: false, include_in_customer_quote: true }
    ];
    const res = await pool.query(`SELECT public.save_crm_inquiry_pricing_options($1::uuid, $2::jsonb) as opts;`, [inqId, JSON.stringify(options)]);
    const [optA, optB] = res.rows[0].opts;

    // Customer accepts Alternate (Make Beta)
    const acceptRes = await pool.query(`
      SELECT public.accept_crm_inquiry_pricing_option($1::uuid, $2::uuid) as result;
    `, [inqId, optB.id]);
    assert.equal(acceptRes.rows[0].result.success, true);
    assert.equal(acceptRes.rows[0].result.offered_make, 'Make Beta');

    // Verify database state:
    // 1. Only Make Beta has is_accepted = true
    const checkOpts = await pool.query(`SELECT id, offered_make, is_accepted FROM public.crm_inquiry_pricing_options WHERE inquiry_id = $1;`, [inqId]);
    const bCheck = checkOpts.rows.find(o => o.id === optB.id);
    const aCheck = checkOpts.rows.find(o => o.id === optA.id);
    assert.equal(bCheck.is_accepted, true);
    assert.equal(aCheck.is_accepted, false);

    // 2. Parent inquiry has accepted_pricing_option_id pointing to Make Beta
    const inqCheck = (await pool.query(`SELECT accepted_pricing_option_id, supplier_name, offered_price, pipeline_status FROM public.crm_inquiries WHERE id = $1;`, [inqId])).rows[0];
    assert.equal(inqCheck.accepted_pricing_option_id, optB.id);
    assert.equal(inqCheck.supplier_name, 'Make Beta');
    assert.equal(Number(inqCheck.offered_price), 135.00);

    // 3. Timeline event was created
    const tlCheck = (await pool.query(`SELECT count(*) as count FROM public.crm_inquiry_timeline WHERE inquiry_id = $1 AND event_type = 'customer_option_accepted';`, [inqId])).rows[0];
    assert.equal(parseInt(tlCheck.count, 10), 1);

    // Now test switching acceptance to Make Alpha
    await pool.query(`SELECT public.accept_crm_inquiry_pricing_option($1::uuid, $2::uuid);`, [inqId, optA.id]);
    const checkOpts2 = await pool.query(`SELECT id, is_accepted FROM public.crm_inquiry_pricing_options WHERE inquiry_id = $1;`, [inqId]);
    assert.equal(checkOpts2.rows.find(o => o.id === optA.id).is_accepted, true);
    assert.equal(checkOpts2.rows.find(o => o.id === optB.id).is_accepted, false, 'Previous accepted option is reset to false');
  });
});
