import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
const env = readFileSync(new URL('./.env.local', import.meta.url), 'utf8');
for (const l of env.split('\n')) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] = m[2]; }
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const SO_ID = 'd10814c2-cf69-4334-9bb2-b6e05f86d0fa';
const { data: dcs } = await sb.from('delivery_challans').select('id, challan_number, approval_status').eq('sales_order_id', SO_ID);
console.log('DCs on SO-2026-0014:', dcs);
for (const dc of dcs || []) {
  const { data: items } = await sb.from('delivery_challan_items').select('product_id, batch_id, quantity').eq('challan_id', dc.id);
  console.log(`  ${dc.challan_number} (${dc.approval_status}):`, items);
}
