import { execSync } from 'child_process';
import fs from 'fs';

function runSql(sql) {
  fs.writeFileSync('/tmp/investigate_headers.sql', sql);
  const out = execSync('npx supabase db query --linked --file /tmp/investigate_headers.sql --output-format json', { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  const jsonStart = out.indexOf('{');
  return jsonStart !== -1 ? JSON.parse(out.slice(jsonStart)).rows : [];
}

console.log('=== INVESTIGATING CONTAINER HEADERS WITH other_import_costs ===');
const containers = runSql(`
SELECT 
  id,
  container_ref,
  status,
  other_import_costs,
  duty_bm,
  ppn_import,
  pph_import,
  freight_charges,
  clearing_forwarding,
  port_charges,
  container_handling,
  transportation,
  loading_import,
  bpom_ski_fees,
  total_import_expenses,
  notes,
  created_at,
  created_by
FROM import_containers
WHERE other_import_costs > 0;
`);

console.log(JSON.stringify(containers, null, 2));

// Check if there are any audit log entries for these container rows
for (const c of containers) {
  console.log(`\nAudit logs for container ${c.container_ref} (${c.id}):`);
  const logs = runSql(`
    SELECT id, action_type, old_values, new_values, created_at, user_email
    FROM audit_logs
    WHERE table_name = 'import_containers' AND record_id = '${c.id}'
    ORDER BY created_at;
  `);
  console.log(JSON.stringify(logs, null, 2));
}

// Check purchase orders or purchase invoices linked to these containers
console.log('\nPurchase orders linked to these containers:');
const pos = runSql(`
SELECT 
  po.po_number,
  po.po_date,
  po.total_amount,
  po.currency,
  b.import_container_id,
  ic.container_ref
FROM purchase_orders po
JOIN batches b ON b.purchase_order_id = po.id
JOIN import_containers ic ON ic.id = b.import_container_id
WHERE ic.other_import_costs > 0
GROUP BY po.po_number, po.po_date, po.total_amount, po.currency, b.import_container_id, ic.container_ref;
`);
console.table(pos);
