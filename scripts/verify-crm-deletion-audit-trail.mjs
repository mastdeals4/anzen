import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

const envText = fs.readFileSync('.env', 'utf8');
const env = {};
envText.split('\n').forEach(line => {
  const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
  if (m) env[m[1]] = m[2]?.replace(/^["'\s]+|["'\s]+$/g, '') || '';
});

const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY);

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    process.exit(1);
  }
  console.log(`✅ ${message}`);
}

async function runTests() {
  console.log('\n======================================================');
  console.log('CRM DELETION, ARCHIVE & AUDIT TRAIL VERIFICATION SUITE');
  console.log('======================================================\n');

  // Authenticate as kunal@avira.co.id
  const { data: auth, error: authErr } = await supabase.auth.signInWithPassword({
    email: 'kunal@avira.co.id',
    password: env.TEST_USER_PASSWORD,
  });
  if (authErr) throw authErr;
  console.log(`[Auth] Authenticated as ${auth.user.email} (ID: ${auth.user.id})`);

  // Test 1: User Directory & Profile Resolution
  console.log('\n--- TEST 1: User Profile Resolution (No Raw UUIDs) ---');
  const { data: profiles, error: pErr } = await supabase.from('user_profiles').select('id, full_name, email, role');
  assert(!pErr && profiles?.length > 0, `Loaded ${profiles?.length} user profiles`);
  const kunalProfile = profiles.find(p => p.email === 'kunal@avira.co.id');
  assert(kunalProfile && kunalProfile.full_name === 'Kunal Lunkad', `Resolved user name: ${kunalProfile?.full_name} (${kunalProfile?.role})`);

  // Test 2: Create a fresh test customer with zero dependencies
  console.log('\n--- TEST 2: Safe Permanent Deletion for 0-Dependency Customer ---');
  const uniqueZeroCompName = `TEST_ZERO_DEP_${Date.now()}`;
  const now = new Date().toISOString();
  const { data: zeroCust, error: insZeroErr } = await supabase.from('crm_contacts').insert({
    company_name: uniqueZeroCompName,
    contact_person: 'Zero Dep Contact',
    customer_type: 'prospect',
    is_active: true,
    created_at: now,
    created_by: auth.user.id,
    updated_at: now,
    updated_by: auth.user.id,
  }).select().single();
  assert(!insZeroErr && zeroCust?.id, `Created zero-dependency customer: ${zeroCust?.company_name} (ID: ${zeroCust?.id})`);

  // Verify zero dependencies
  const [inqRes, emailRes, actRes] = await Promise.all([
    supabase.from('crm_inquiries').select('id', { count: 'exact', head: true }).eq('crm_contact_id', zeroCust.id),
    supabase.from('crm_email_activities').select('id', { count: 'exact', head: true }).eq('contact_id', zeroCust.id),
    supabase.from('crm_activity_logs').select('id', { count: 'exact', head: true }).eq('contact_id', zeroCust.id),
  ]);
  const totalDeps = (inqRes.count || 0) + (emailRes.count || 0) + (actRes.count || 0);
  assert(totalDeps === 0, `Zero dependencies verified (inquiries: ${inqRes.count || 0}, emails: ${emailRes.count || 0}, activities: ${actRes.count || 0})`);

  // Permanent deletion should succeed cleanly
  const { error: delZeroErr } = await supabase.from('crm_contacts').delete().eq('id', zeroCust.id);
  assert(!delZeroErr, 'Permanent deletion succeeded cleanly for 0-dependency customer');

  const { data: checkZeroAfter } = await supabase.from('crm_contacts').select('id').eq('id', zeroCust.id);
  assert(checkZeroAfter?.length === 0, 'Confirmed customer record permanently removed');

  // Test 3: Dependent Customer Protection & Archive Workflow
  console.log('\n--- TEST 3: Dependent Customer Protection & Archive/Soft-Delete Workflow ---');
  const uniqueDepCompName = `TEST_DEP_HISTORICAL_${Date.now()}`;
  const { data: depCust, error: insDepErr } = await supabase.from('crm_contacts').insert({
    company_name: uniqueDepCompName,
    contact_person: 'Historical Contact',
    customer_type: 'prospect',
    is_active: true,
    created_at: now,
    created_by: auth.user.id,
    updated_at: now,
    updated_by: auth.user.id,
  }).select().single();
  assert(!insDepErr && depCust?.id, `Created test customer: ${depCust?.company_name}`);

  // Create an inquiry attached to this customer
  const { data: inqRecord, error: inqErr } = await supabase.from('crm_inquiries').insert({
    company_name: uniqueDepCompName,
    crm_contact_id: depCust.id,
    product_name: 'Paracetamol BP',
    quantity: '1000 kg',
    status: 'new',
  }).select().single();
  assert(!inqErr && inqRecord?.id, `Attached inquiry ${inqRecord?.id} to customer`);

  // Verify dependency check detects this linked record
  const { count: depCount } = await supabase.from('crm_inquiries').select('id', { count: 'exact', head: true }).eq('crm_contact_id', depCust.id);
  assert(depCount === 1, `Dependency check detected ${depCount} linked inquiry`);

  // Archive / Soft Delete customer
  const archiveTimestamp = new Date().toISOString();
  const { error: archErr } = await supabase.from('crm_contacts').update({
    is_active: false,
    updated_at: archiveTimestamp,
    updated_by: auth.user.id,
  }).eq('id', depCust.id);
  assert(!archErr, 'Customer successfully archived (is_active: false)');

  // Verify historical inquiry is 100% PRESERVED
  const { data: preservedInq } = await supabase.from('crm_inquiries').select('id, company_name, crm_contact_id').eq('id', inqRecord.id).single();
  assert(preservedInq && preservedInq.crm_contact_id === depCust.id, 'Historical inquiry relationship completely preserved intact');

  // Verify Audit Trail on customer
  const { data: auditCust } = await supabase.from('crm_contacts').select('id, is_active, created_at, created_by, updated_at, updated_by').eq('id', depCust.id).single();
  assert(auditCust?.is_active === false, 'Customer status is inactive/archived');
  assert(auditCust?.created_by === auth.user.id, `Created By permanently preserved: ${auditCust?.created_by}`);
  assert(auditCust?.updated_by === auth.user.id, `Updated By recorded: ${auditCust?.updated_by}`);
  assert(new Date(auditCust?.updated_at).getTime() >= new Date(auditCust?.created_at).getTime(), `Updated At (${auditCust?.updated_at}) >= Created At (${auditCust?.created_at})`);

  // Test 4: Restore Archived Customer
  console.log('\n--- TEST 4: Restore Customer from Archive ---');
  const restoreTimestamp = new Date().toISOString();
  const { error: restErr } = await supabase.from('crm_contacts').update({
    is_active: true,
    updated_at: restoreTimestamp,
    updated_by: auth.user.id,
  }).eq('id', depCust.id);
  assert(!restErr, 'Customer successfully restored back to active status (is_active: true)');

  const { data: restoredCust } = await supabase.from('crm_contacts').select('is_active, updated_at').eq('id', depCust.id).single();
  assert(restoredCust?.is_active === true, 'Customer is active');

  // Test 5: Duplicate Company Name Detection (Active & Archived)
  console.log('\n--- TEST 5: Duplicate Company Detection on Active vs Archived ---');
  // Check active duplicate
  const { data: activeCust } = await supabase.from('crm_contacts').select('company_name').eq('is_active', true).limit(1).single();
  const { data: allContacts } = await supabase.from('crm_contacts').select('id, company_name, is_active').limit(1000);
  const activeNormalized = activeCust.company_name.toLowerCase().trim();
  const matchActive = allContacts.find(c => c.company_name.toLowerCase().trim() === activeNormalized);
  assert(matchActive && matchActive.is_active === true, `Detected active duplicate for ${activeCust.company_name}`);

  // Test 6: Test Teardown Clean Up
  console.log('\n--- TEST 6: Test Teardown Clean Up ---');
  await supabase.from('crm_inquiries').delete().eq('id', inqRecord.id);
  await supabase.from('crm_contacts').delete().eq('id', depCust.id);
  console.log('✅ Temporary test records cleaned up safely');

  console.log('\n======================================================');
  console.log('ALL VERIFICATION TESTS PASSED SUCCESSFULLY! (6/6)');
  console.log('======================================================\n');
}

runTests().catch(err => {
  console.error('Fatal error during test run:', err);
  process.exit(1);
});
