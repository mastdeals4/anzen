import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
const env = readFileSync(new URL('./.env.local', import.meta.url), 'utf8');
for (const l of env.split('\n')) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] = m[2]; }
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const { data: prof } = await sb.from('profiles').select('id, role').limit(5);
console.log('profiles:', prof);
const { data: prod } = await sb.from('products').select('*').limit(1);
console.log('product fields:', prod && prod[0] ? Object.keys(prod[0]) : 'none');
const { data: cust } = await sb.from('customers').select('*').limit(1);
console.log('customer fields:', cust && cust[0] ? Object.keys(cust[0]) : 'none');
const { data: batch } = await sb.from('batches').select('*').limit(1);
console.log('batch fields:', batch && batch[0] ? Object.keys(batch[0]) : 'none');
const { data: so } = await sb.from('sales_orders').select('*').limit(1);
console.log('so fields:', so && so[0] ? Object.keys(so[0]) : 'none');
