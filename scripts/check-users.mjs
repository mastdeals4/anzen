import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
const env = readFileSync(new URL('./.env.local', import.meta.url), 'utf8');
for (const l of env.split('\n')) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] = m[2]; }
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const r = await sb.auth.admin.listUsers({ perPage: 5 });
console.log(r.data?.users?.map(u => ({ id: u.id, email: u.email })));
