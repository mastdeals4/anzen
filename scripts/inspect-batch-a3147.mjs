// Inspect batch 4001/1101/25/A-3147 + related DCs and inventory transactions.
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const env = readFileSync(new URL('./.env.local', import.meta.url), 'utf8');
for (const line of env.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const BATCH_ID = 'cb5539e0-4c14-4086-ba30-92cf194d5db2';
const PRODUCT_ID = '4fd7e5b5-1226-4044-b9bd-e16e1e8a516a';

const { data: batch } = await sb.from('batches').select('*').eq('id', BATCH_ID).single();
console.log('BATCH', JSON.stringify(batch, null, 2));

const { data: product } = await sb.from('products').select('id,name,current_stock').eq('id', PRODUCT_ID).single();
console.log('PRODUCT', JSON.stringify(product, null, 2));

const { data: items } = await sb
  .from('delivery_challan_items')
  .select('id, challan_id, product_id, batch_id, quantity, delivery_challans(challan_number, approval_status, challan_date, rejection_reason)')
  .eq('batch_id', BATCH_ID);
console.log('DC ITEMS for batch', JSON.stringify(items, null, 2));

const { data: txns } = await sb
  .from('inventory_transactions')
  .select('id, transaction_type, quantity, reference_number, reference_type, transaction_date, notes, stock_before, stock_after')
  .eq('batch_id', BATCH_ID)
  .order('transaction_date', { ascending: true })
  .order('created_at', { ascending: true });
console.log('TXNS for batch', JSON.stringify(txns, null, 2));
