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

// Helper to run raw SQL via PostgREST RPC (if available)
async function runSql(sql) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
    method: 'POST',
    headers: {
      'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql }),
  });
  console.log(res.status, await res.text().then(t => t.slice(0, 2000)));
}

await runSql(`SELECT enum_range(NULL::dc_approval_status)::text AS vals`);
await runSql(`SELECT tgname, pg_get_triggerdef(t.oid) FROM pg_trigger t WHERE tgrelid = 'delivery_challans'::regclass AND NOT tgisinternal`);
