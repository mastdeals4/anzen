import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';

const root = process.cwd();
const migrationsDir = resolve(root, 'supabase/migrations');
const outputDir = resolve(root, 'audit-reports');

const cliOutput = execFileSync(
  'supabase',
  [
    'db',
    'query',
    '--linked',
    '--output-format',
    'json',
    `SELECT version,name,statements
       FROM supabase_migrations.schema_migrations
      ORDER BY version`,
  ],
  { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 },
);

const response = JSON.parse(cliOutput.slice(cliOutput.indexOf('{')));
const remoteRows = response.rows ?? [];
const localFiles = readdirSync(migrationsDir)
  .filter(file => /^\d{14}.*\.sql$/.test(file))
  .sort();

const localByVersion = new Map();
for (const file of localFiles) {
  const version = file.slice(0, 14);
  const files = localByVersion.get(version) ?? [];
  files.push(file);
  localByVersion.set(version, files);
}

const sanitizeName = value => String(value || 'remote_migration')
  .replace(/[^a-zA-Z0-9_-]+/g, '_')
  .replace(/^_+|_+$/g, '')
  .toLowerCase();

const reconstructed = [];
for (const row of remoteRows) {
  if (localByVersion.has(row.version)) continue;
  const filename = `${row.version}_${sanitizeName(row.name)}.sql`;
  const target = join(migrationsDir, filename);
  const sql = `${(row.statements ?? []).join('\n\n')}\n`;
  if (!existsSync(target)) {
    writeFileSync(target, sql);
    reconstructed.push(filename);
  }
}

const refreshedFiles = readdirSync(migrationsDir)
  .filter(file => /^\d{14}.*\.sql$/.test(file))
  .sort();
const refreshedVersions = new Map();
for (const file of refreshedFiles) {
  const version = file.slice(0, 14);
  const files = refreshedVersions.get(version) ?? [];
  files.push(file);
  refreshedVersions.set(version, files);
}

const remoteVersions = new Set(remoteRows.map(row => row.version));
const duplicateLocalVersions = [...refreshedVersions.entries()]
  .filter(([, files]) => files.length > 1)
  .map(([version, files]) => ({ version, files }));
const localOnlyVersions = [...refreshedVersions.keys()]
  .filter(version => !remoteVersions.has(version));
const remoteOnlyVersions = [...remoteVersions]
  .filter(version => !refreshedVersions.has(version));

mkdirSync(outputDir, { recursive: true });
const manifest = {
  generated_at: new Date().toISOString(),
  local_files: refreshedFiles.length,
  local_versions: refreshedVersions.size,
  remote_versions: remoteVersions.size,
  reconstructed,
  duplicate_local_versions: duplicateLocalVersions,
  local_only_versions: localOnlyVersions,
  remote_only_versions: remoteOnlyVersions,
};

const jsonPath = join(outputDir, 'finance-v1-migration-manifest.json');
writeFileSync(jsonPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(JSON.stringify({
  manifest: basename(jsonPath),
  reconstructed: reconstructed.length,
  local_files: manifest.local_files,
  local_versions: manifest.local_versions,
  remote_versions: manifest.remote_versions,
  duplicate_versions: duplicateLocalVersions.length,
  local_only_versions: localOnlyVersions.length,
  remote_only_versions: remoteOnlyVersions.length,
}, null, 2));

if (remoteOnlyVersions.length) process.exitCode = 2;
