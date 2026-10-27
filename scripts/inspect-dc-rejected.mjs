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

// DC DO-26-0010
const { data: dc } = await sb.from('delivery_challans').select('*').eq('challan_number', 'DO-26-0010').single();
console.log('DC DO-26-0010:', JSON.stringify(dc, null, 2));

if (dc?.sales_order_id) {
  const { data: soi } = await sb
    .from('sales_order_items')
    .select('id, product_id, quantity, delivered_quantity')
    .eq('sales_order_id', dc.sales_order_id);
  console.log('SO items:', JSON.stringify(soi, null, 2));
  const { data: so } = await sb.from('sales_orders').select('id, so_number, status').eq('id', dc.sales_order_id).single();
  console.log('SO:', JSON.stringify(so, null, 2));
}

// Check enum
const { data: enumRows } = await sb.rpc('exec_sql', { sql: "SELECT unnest(enum_range(NULL::dc_approval_status)) AS val" }).then(r => r).catch(() => ({ data: 'no-rpc' }));
console.log('enum (best-effort):', enumRows);
