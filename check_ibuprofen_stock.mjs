import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://dkrtsqienlhpouohmfki.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRrcnRzcWllbmxocG91b2htZmtpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjE5MTQxNzQsImV4cCI6MjA3NzQ5MDE3NH0.Kjo9RU0WAfQSSEm2vTWmuN5BIYk_hvanKDQkm5qdCGY';

const supabase = createClient(supabaseUrl, supabaseKey);

async function checkIbuprofenStock() {
  console.log('\n=== STEP 1: CURRENT IBUPROFEN BP BATCH STATUS ===\n');

  // Get product ID first
  const { data: products } = await supabase
    .from('products')
    .select('id')
    .eq('product_name', 'Ibuprofen BP')
    .single();

  if (!products) {
    console.log('❌ Ibuprofen BP product not found!');
    return;
  }

  const productId = products.id;

  // Get batches
  const { data: batches } = await supabase
    .from('batches')
    .select('*')
    .eq('product_id', productId)
    .order('created_at');

  if (!batches || batches.length === 0) {
    console.log('❌ No Ibuprofen BP batches found!');
    return;
  }

  console.log('Batches found:', batches.length);
  batches.forEach(b => {
    console.log(`\nBatch: ${b.batch_number}`);
    console.log(`  Imported: ${b.import_quantity} Kg`);
    console.log(`  Current Stock: ${b.current_stock} Kg`);
    console.log(`  Reserved: ${b.reserved_stock} Kg`);
    console.log(`  Sold/Used: ${b.import_quantity - b.current_stock - b.reserved_stock} Kg`);
    console.log(`  Active: ${b.is_active}`);
  });

  console.log('\n=== STEP 2: DELIVERY CHALLAN ITEMS ===\n');

  for (const batch of batches) {
    const { data: dcItems } = await supabase
      .from('delivery_challan_items')
      .select(`
        quantity,
        delivery_challans!inner(challan_number, challan_date, customers!inner(company_name))
      `)
      .eq('batch_id', batch.id);

    if (dcItems && dcItems.length > 0) {
      console.log(`\nBatch ${batch.batch_number}:`);
      dcItems.forEach(item => {
        console.log(`  DC ${item.delivery_challans.challan_number} - ${item.delivery_challans.challan_date}`);
        console.log(`    Customer: ${item.delivery_challans.customers.company_name}`);
        console.log(`    Quantity: ${item.quantity} Kg`);
      });
    }
  }

  console.log('\n=== STEP 3: SALES INVOICE ITEMS ===\n');

  for (const batch of batches) {
    const { data: invoiceItems } = await supabase
      .from('sales_invoice_items')
      .select(`
        quantity,
        delivery_challan_item_id,
        sales_invoices!inner(invoice_number, invoice_date, customers!inner(company_name))
      `)
      .eq('batch_id', batch.id);

    if (invoiceItems && invoiceItems.length > 0) {
      console.log(`\nBatch ${batch.batch_number}:`);
      invoiceItems.forEach(item => {
        console.log(`  Invoice ${item.sales_invoices.invoice_number} - ${item.sales_invoices.invoice_date}`);
        console.log(`    Customer: ${item.sales_invoices.customers.company_name}`);
        console.log(`    Quantity: ${item.quantity} Kg`);
        console.log(`    DC Linked: ${item.delivery_challan_item_id ? 'Yes' : 'No'}`);
      });
    }
  }

  console.log('\n=== STEP 4: STOCK CALCULATION ===\n');

  for (const batch of batches) {
    // Get DC items NOT linked to invoices
    const { data: dcOnly } = await supabase
      .from('delivery_challan_items')
      .select('quantity, id')
      .eq('batch_id', batch.id);

    const { data: linkedInvoices } = await supabase
      .from('sales_invoice_items')
      .select('delivery_challan_item_id')
      .not('delivery_challan_item_id', 'is', null);

    const linkedIds = new Set(linkedInvoices?.map(i => i.delivery_challan_item_id) || []);
    const dcOnlyQty = dcOnly?.filter(dc => !linkedIds.has(dc.id))
      .reduce((sum, dc) => sum + parseFloat(dc.quantity), 0) || 0;

    // Get all invoiced quantities
    const { data: invoices } = await supabase
      .from('sales_invoice_items')
      .select('quantity')
      .eq('batch_id', batch.id);

    const invoicedQty = invoices?.reduce((sum, i) => sum + parseFloat(i.quantity), 0) || 0;

    const expectedStock = parseFloat(batch.import_quantity) - dcOnlyQty - invoicedQty;
    const difference = expectedStock - parseFloat(batch.current_stock);

    console.log(`\nBatch: ${batch.batch_number}`);
    console.log(`  Imported: ${batch.import_quantity} Kg`);
    console.log(`  DC Only (not invoiced): ${dcOnlyQty.toFixed(2)} Kg`);
    console.log(`  Invoiced: ${invoicedQty.toFixed(2)} Kg`);
    console.log(`  Expected Stock: ${expectedStock.toFixed(2)} Kg`);
    console.log(`  Actual Stock: ${batch.current_stock} Kg`);
    console.log(`  Difference: ${difference.toFixed(2)} Kg ${difference !== 0 ? '⚠️ MISMATCH!' : '✅ OK'}`);

    if (Math.abs(difference) > 0.01) {
      console.log(`\n  🔧 Fixing batch ${batch.batch_number}...`);
      const { error } = await supabase
        .from('batches')
        .update({ current_stock: expectedStock })
        .eq('id', batch.id);

      if (error) {
        console.log(`  ❌ Error fixing: ${error.message}`);
      } else {
        console.log(`  ✅ Fixed! Updated from ${batch.current_stock} to ${expectedStock.toFixed(2)} Kg`);

        // Log the adjustment
        await supabase
          .from('inventory_transactions')
          .insert({
            product_id: productId,
            batch_id: batch.id,
            transaction_type: 'adjustment',
            quantity_change: difference,
            transaction_date: new Date().toISOString(),
            notes: `Auto-fix: Stock corrected from ${batch.current_stock} to ${expectedStock.toFixed(2)}`,
            reference_type: 'stock_audit'
          });
      }
    }
  }

  console.log('\n=== AUDIT COMPLETE ===\n');
}

checkIbuprofenStock().catch(console.error);
