import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const productsPath = resolve(__dirname, '..', 'src', 'pages', 'Products.tsx');
const products = readFileSync(productsPath, 'utf8');

test('Products page has displayValue helper that extracts strings from objects', () => {
  assert.match(products, /displayValue/, 'Must have displayValue helper');
  assert.match(products, /objectKeys/, 'displayValue must accept objectKeys parameter');
  assert.match(products, /typeof value === 'object'/, 'displayValue must check for object type');
  assert.match(products, /record\[key\]/, 'displayValue must extract property from object');
});

test('Products page category column uses displayValue with category keys', () => {
  assert.match(products, /category.*displayValue.*name.*category_name.*label/, 'Category render must use displayValue with name/category_name/label keys');
});

test('Products page unit column uses displayValue with unit keys', () => {
  assert.match(products, /unit.*displayValue.*name.*unit_name.*label.*short_name/, 'Unit render must use displayValue with name/unit_name/label/short_name keys');
});

test('Products page current_stock renders 0 for zero stock, not dash', () => {
  assert.match(products, /Number\.isFinite\(numeric\)[\s\S]*?toFixed\(2\)/, 'Stock render must use Number.isFinite + toFixed(2)');
  assert.match(products, /Number\(value \?\? 0\)/, 'Stock render must default to 0 for null/undefined');
});

test('Products page normalizes category and unit in loadProducts data layer', () => {
  assert.match(products, /normalize\(product\.category\)/, 'loadProducts must normalize category');
  assert.match(products, /normalize\(product\.unit\)/, 'loadProducts must normalize unit');
  assert.match(products, /typeof v === 'object'[\s\S]*?v\.name/, 'Normalize function must extract .name from objects');
});

test('Products form sends only database-allowed category and unit values', () => {
  assert.match(products, /option value="api"/);
  assert.match(products, /option value="excipient"/);
  assert.match(products, /option value="solvent"/);
  assert.match(products, /option value="other"/);
  assert.match(products, /option value="litre"/);
  assert.match(products, /option value="piece"/);
  assert.doesNotMatch(products, /option value="excipients"/);
  assert.doesNotMatch(products, /option value="packaging"/);
  assert.doesNotMatch(products, /option value="liter"/);
  assert.doesNotMatch(products, /option value="pieces"/);
});

test('Products page uses canonical stock source (inventory_v1_stock_summary)', () => {
  assert.match(products, /from\('inventory_v1_stock_summary'\)/, 'Must query inventory_v1_stock_summary');
  assert.match(products, /total_current_stock/, 'Must select total_current_stock from stock summary');
});

test('Products page handleEdit uses string category/unit for form population', () => {
  assert.match(products, /product\.category \|\| 'api'/, 'handleEdit must use string category fallback');
  assert.match(products, /product\.unit \|\| 'kg'/, 'handleEdit must use string unit fallback');
});

test('Products page view modal uses displayValue for category/unit', () => {
  assert.match(products, /displayValue\(viewingProduct\.category\)/, 'View modal must use displayValue for category');
  assert.match(products, /displayValue\(viewingProduct\.unit\)/, 'View modal must use displayValue for unit');
  assert.match(products, /Number\(viewingProduct\.current_stock \?\? 0\)/, 'View modal must default current_stock to 0');
});
