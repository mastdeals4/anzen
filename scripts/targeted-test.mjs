#!/usr/bin/env node
import { execSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

const ROOT_DIR = process.cwd();
const TESTS_DIR = join(ROOT_DIR, 'tests');

// Fast standalone regression tests that verify frontend logic & accounting invariants
const DEFAULT_SMOKE_TESTS = [
  'tests/expense-cancellation-regression.test.mjs',
  'tests/tax-calculations-regimes.test.mjs',
  'tests/sales-cogs-sapj-26-017-and-032-regression.test.mjs',
  'tests/future-cogs-cost-snapshot-regression.test.mjs',
];

function getAllTestFiles() {
  if (!existsSync(TESTS_DIR)) return [];
  return readdirSync(TESTS_DIR)
    .filter(f => f.endsWith('.test.mjs'))
    .map(f => `tests/${f}`);
}

function getChangedFiles() {
  const files = new Set();
  try {
    const statusOutput = execSync('git status --porcelain', { encoding: 'utf8' }).trim();
    if (statusOutput) {
      statusOutput.split('\n').forEach(line => {
        const file = line.slice(3).trim();
        if (file) files.add(file);
      });
    }
    const diffOutput = execSync('git diff --name-only HEAD', { encoding: 'utf8' }).trim();
    if (diffOutput) {
      diffOutput.split('\n').forEach(file => {
        if (file) files.add(file.trim());
      });
    }
  } catch {
    // If git fails, return empty set
  }
  return Array.from(files);
}

function resolveTargetedTests(rawArgs) {
  const allTests = getAllTestFiles();

  // 1. Explicit arguments provided (e.g. `npm run test:targeted -- stock` or specific file path)
  const args = rawArgs.filter(a => !a.startsWith('--'));
  if (args.length > 0) {
    const matched = new Set();
    for (const arg of args) {
      const cleanArg = arg.toLowerCase().replace(/^tests\//, '').replace(/\.test\.mjs$/, '');
      for (const testFile of allTests) {
        if (testFile.toLowerCase().includes(cleanArg)) {
          matched.add(testFile);
        }
      }
    }
    if (matched.size > 0) {
      return Array.from(matched);
    }
    console.warn(`[test:targeted] No test files matched argument(s): ${args.join(', ')}`);
    return [];
  }

  // 2. Derive targets from git changes
  const changedFiles = getChangedFiles();
  const matched = new Set();

  for (const changed of changedFiles) {
    if (changed.startsWith('tests/') && changed.endsWith('.test.mjs')) {
      matched.add(changed);
    } else if (changed.startsWith('src/') || changed.startsWith('supabase/')) {
      const baseName = basename(changed).split('.')[0].toLowerCase();
      // Match keywords in test filenames (e.g. stock, expense, etc.)
      for (const testFile of allTests) {
        if (testFile.toLowerCase().includes(baseName)) {
          matched.add(testFile);
        }
      }
    }
  }

  if (matched.size > 0) {
    return Array.from(matched);
  }

  // 3. Fallback: run core fast smoke regression suite
  console.log('[test:targeted] No specific changes detected. Running core smoke regression suite...');
  console.log('[test:targeted] Tip: pass a keyword to target tests, e.g. `npm run test:targeted -- stock`\n');
  return DEFAULT_SMOKE_TESTS.filter(f => existsSync(join(ROOT_DIR, f)));
}

function main() {
  const rawArgs = process.argv.slice(2);
  const targets = resolveTargetedTests(rawArgs);

  if (targets.length === 0) {
    console.log('[test:targeted] No target tests found to execute.');
    process.exit(0);
  }

  console.log(`[test:targeted] Running ${targets.length} test suite(s):`);
  targets.forEach(t => console.log(`  • ${t}`));
  console.log('');

  const result = spawnSync('node', ['--test', ...targets], {
    stdio: 'inherit',
    cwd: ROOT_DIR,
  });

  process.exit(result.status ?? 0);
}

main();
