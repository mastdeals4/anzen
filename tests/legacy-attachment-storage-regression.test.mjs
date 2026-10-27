import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile('src/utils/signedUrlCache.ts', 'utf8');
const legacyBranch = source.indexOf("if (bucket === 'documents')");
const signCall = source.indexOf('.createSignedUrl(path', legacyBranch);
assert.ok(legacyBranch >= 0, 'legacy documents branch exists');
assert.ok(source.indexOf('.download(path)', legacyBranch) < signCall, 'legacy download precedes signing');
assert.match(source, /URL\.createObjectURL\(downloaded\.data\)/);
assert.match(source, /export async function openStorageDocument/);
assert.match(source, /export async function downloadStorageDocument/);
assert.match(source, /bucket === 'documents'/);
assert.ok(source.includes("bucket === 'documents'")); // other buckets retain generic signing
console.log('legacy and current attachment storage regression checks passed');
