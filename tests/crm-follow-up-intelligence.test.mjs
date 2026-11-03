import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

test('1. Follow-up intelligence distinguishes SAPJ promised date, customer promised date, and follow-up date', () => {
  const modalPath = path.join(process.cwd(), 'src/components/crm/CustomerFollowUpModal.tsx');
  assert.ok(fs.existsSync(modalPath), 'CustomerFollowUpModal.tsx must exist');
  const src = fs.readFileSync(modalPath, 'utf-8');

  assert.match(src, /sapjPromisedDate/, 'Must include sapjPromisedDate state/field');
  assert.match(src, /customerPromisedDate/, 'Must include customerPromisedDate state/field');
  assert.match(src, /followUpDate/, 'Must include followUpDate state/field');
});

test('2. Supports all 10 pending request categories in follow-up management', () => {
  const modalPath = path.join(process.cwd(), 'src/components/crm/CustomerFollowUpModal.tsx');
  const src = fs.readFileSync(modalPath, 'utf-8');

  const categories = [
    'COA Pending',
    'Specification Pending',
    'Revised Price Pending',
    'Price Negotiation',
    'Stock Confirmation',
    'Sample Pending',
    'Delivery Confirmation',
    'Customer Feedback',
    'Order Confirmation',
    'General Customer Question',
  ];

  for (const cat of categories) {
    assert.ok(src.includes(cat), `Must support category: ${cat}`);
  }
});

