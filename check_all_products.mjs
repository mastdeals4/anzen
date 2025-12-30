import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://dkrtsqienlhpouohmfki.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRrcnRzcWllbmxocG91b2htZmtpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjE5MTQxNzQsImV4cCI6MjA3NzQ5MDE3NH0.Kjo9RU0WAfQSSEm2vTWmuN5BIYk_hvanKDQkm5qdCGY';

const supabase = createClient(supabaseUrl, supabaseKey);

async function checkDatabase() {
  console.log('\n=== CHECKING DATABASE ===\n');

  // Check products
  const { data: products, error: prodError } = await supabase
    .from('products')
    .select('id, product_name, product_code')
    .order('product_name')
    .limit(10);

  if (prodError) {
    console.log('❌ Error fetching products:', prodError.message);
  } else {
    console.log(`✅ Found ${products.length} products:`);
    products.forEach(p => {
      console.log(`  - ${p.product_name} (${p.product_code || 'no code'})`);
    });
  }

  // Check batches
  const { data: batches, error: batchError } = await supabase
    .from('batches')
    .select('id, batch_number, import_quantity, current_stock, product_id')
    .order('created_at')
    .limit(10);

  if (batchError) {
    console.log('\n❌ Error fetching batches:', batchError.message);
  } else {
    console.log(`\n✅ Found ${batches.length} batches:`);
    batches.forEach(b => {
      console.log(`  - ${b.batch_number}: ${b.current_stock}/${b.import_quantity} Kg`);
    });
  }

  // Check DCs
  const { data: dcs, error: dcError } = await supabase
    .from('delivery_challans')
    .select('id, challan_number, challan_date')
    .order('challan_date', { ascending: false })
    .limit(5);

  if (dcError) {
    console.log('\n❌ Error fetching DCs:', dcError.message);
  } else {
    console.log(`\n✅ Found ${dcs.length} delivery challans (latest 5):`);
    dcs.forEach(dc => {
      console.log(`  - ${dc.challan_number} (${dc.challan_date})`);
    });
  }

  // Check invoices
  const { data: invoices, error: invError } = await supabase
    .from('sales_invoices')
    .select('id, invoice_number, invoice_date')
    .order('invoice_date', { ascending: false })
    .limit(5);

  if (invError) {
    console.log('\n❌ Error fetching invoices:', invError.message);
  } else {
    console.log(`\n✅ Found ${invoices.length} sales invoices (latest 5):`);
    invoices.forEach(inv => {
      console.log(`  - ${inv.invoice_number} (${inv.invoice_date})`);
    });
  }

  // Check views exist
  console.log('\n=== CHECKING VIEWS ===\n');

  const { data: dcStatus, error: viewError } = await supabase
    .from('dc_item_invoice_status')
    .select('*')
    .limit(1);

  if (viewError) {
    console.log('❌ View dc_item_invoice_status error:', viewError.message);
  } else {
    console.log('✅ View dc_item_invoice_status is accessible');
  }

  console.log('\n=== CHECK COMPLETE ===\n');
}

checkDatabase().catch(console.error);
