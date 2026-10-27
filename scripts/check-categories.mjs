import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
const env = readFileSync(new URL('./.env.local', import.meta.url), 'utf8');
for (const l of env.split('\n')) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] = m[2]; }
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const { data } = await sb.from('products').select('category').limit(20);
console.log([...new Set(data.map(d=>d.category))]);
const { data: dci } = await sb.from('delivery_challan_items').select('*').limit(1);
console.log('dc_item fields:', dci && dci[0] ? Object.keys(dci[0]) : 'none');
const { data: soi } = await sb.from('sales_order_items').select('*').limit(1);
console.log('soi fields:', soi && soi[0] ? Object.keys(soi[0]) : 'none');
