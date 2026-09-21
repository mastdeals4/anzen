import { execSync } from 'child_process';
import fs from 'fs';

function runSql(sql) {
  fs.writeFileSync('/tmp/check_layers_containers.sql', sql);
  const out = execSync('npx supabase db query --linked --file /tmp/check_layers_containers.sql --output-format json', { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  const jsonStart = out.indexOf('{');
  return jsonStart !== -1 ? JSON.parse(out.slice(jsonStart)).rows : [];
}

const res = runSql(`
SELECT 
  pbcl.import_container_id,
  ic.container_ref,
  count(pbcl.id) as layer_count,
  sum(pbcl.initial_quantity) as total_qty,
  sum(pbcl.remaining_quantity) as rem_qty,
  sum(pbcl.initial_quantity * pbcl.functional_landed_cost_per_unit) as total_landed_cost_in_layers,
  sum(pbcl.remaining_quantity * pbcl.functional_landed_cost_per_unit) as rem_landed_cost_in_layers
FROM purchase_batch_cost_layers pbcl
LEFT JOIN import_containers ic ON ic.id = pbcl.import_container_id
GROUP BY pbcl.import_container_id, ic.container_ref
ORDER BY ic.container_ref;
`);

console.table(res);
const totalLandedInLayers = res.reduce((s, r) => s + Number(r.total_landed_cost_in_layers || 0), 0);
const remLandedInLayers = res.reduce((s, r) => s + Number(r.rem_landed_cost_in_layers || 0), 0);
console.log(`Total Landed Cost in Layers: ${totalLandedInLayers.toLocaleString('id-ID')}`);
console.log(`Remaining Landed Cost in Layers: ${remLandedInLayers.toLocaleString('id-ID')}`);
