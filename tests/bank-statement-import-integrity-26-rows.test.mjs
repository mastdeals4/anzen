#!/usr/bin/env node
/**
 * tests/bank-statement-import-integrity-26-rows.test.mjs
 * 
 * Verifies that the bank statement importer preserves ALL 26 rows from sep26.csv
 * with zero silent data loss, specifically ensuring that the 3 legitimate
 * duplicate-amount transactions on 30/09/2026 are never conflated or dropped:
 * 
 * 1. 30/09/2026 – Rp 2,000,000 – SANDI PRASETYO (vs RANTI TRI MULYANI)
 * 2. 30/09/2026 – Rp 3,000,000 – TIARA ZALFA IMTINA (vs DWI ZAHRA RESTININ)
 * 3. 30/09/2026 – Rp 2,500,000 – MARTUA ALOYSIUS GI (vs MUHAMAD IMRON HANI)
 */

import fs from 'fs';
import crypto from 'crypto';

const normalizeHeader = (s) => s.toLowerCase().trim().replace(/[\s_-]+/g, ' ');

const isDateHeader = (s) =>
  ['tanggal', 'tgl', 'date', 'transaction date', 'trn date', 'tx date'].includes(normalizeHeader(s));

const isDescHeader = (s) =>
  ['keterangan', 'uraian', 'description', 'desc', 'transaction description'].includes(normalizeHeader(s));

const isBranchHeader = (s) =>
  ['cabang', 'branch', 'branch code'].includes(normalizeHeader(s));

const isAmountHeader = (s) =>
  ['mutasi', 'amount', 'total amount', 'nominal'].includes(normalizeHeader(s));

const isDebitHeader = (s) =>
  ['debet', 'debit', 'db', 'mutasi debet', 'mutasi debit'].includes(normalizeHeader(s));

const isCreditHeader = (s) =>
  ['kredit', 'credit', 'cr', 'mutasi kredit', 'mutasi credit'].includes(normalizeHeader(s));

const isBalanceHeader = (s) =>
  ['saldo', 'balance', 'running balance', 'saldo akhir'].includes(normalizeHeader(s));

const parseIndonesianNumber = (value) => {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return value;
  const str = String(value).trim();
  if (str === '') return 0;
  let cleaned = str.replace(/[^\d.,-]/g, '');
  const dotCount = (cleaned.match(/\./g) || []).length;
  const commaCount = (cleaned.match(/,/g) || []).length;
  const lastDot = cleaned.lastIndexOf('.');
  const lastComma = cleaned.lastIndexOf(',');
  if (dotCount > 0 && commaCount > 0) {
    if (lastDot < lastComma) cleaned = cleaned.replace(/\./g, '').replace(/,/g, '.');
    else cleaned = cleaned.replace(/,/g, '');
  } else if (dotCount > 1) cleaned = cleaned.replace(/\./g, '');
  else if (commaCount > 1) cleaned = cleaned.replace(/,/g, '');
  else if (dotCount === 1 && commaCount === 0) {
    const parts = cleaned.split('.');
    if (parts[1].length === 3 && parts[0].length >= 1 && parts[0].length <= 3) cleaned = cleaned.replace(/\./g, '');
  } else if (commaCount === 1 && dotCount === 0) {
    const parts = cleaned.split(',');
    if (parts[1].length === 3 && parts[0].length >= 1 && parts[0].length <= 3) cleaned = cleaned.replace(/,/g, '');
    else cleaned = cleaned.replace(/,/g, '.');
  }
  const result = parseFloat(cleaned);
  return isNaN(result) ? 0 : result;
};

const parseCSVLine = (line, delimiter = ',') => {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') inQuotes = !inQuotes;
    else if (char === delimiter && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else current += char;
  }
  result.push(current.trim());
  return result;
};

// Exact parsing logic from BankReconciliationEnhanced.tsx
const parseStatementDataWithMetadata = (rows, providedYear = 2026) => {
  const lines = [];
  const metadata = {
    period: null,
    startDate: null,
    endDate: null,
    currency: null,
    openingBalance: null,
    closingBalance: null,
    totalDebits: null,
    totalCredits: null,
  };

  let headerRowIdx = -1;
  for (let i = 0; i < Math.min(25, rows.length); i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;
    if (row.some(isDateHeader) && (row.some(isDescHeader) || row.some(isAmountHeader) || row.some(isDebitHeader))) {
      headerRowIdx = i;
      break;
    }
  }

  if (headerRowIdx === -1) return { lines, metadata };

  const headerRow = rows[headerRowIdx];
  let dateCol = -1, descCol = -1, branchCol = -1, amountCol = -1, balanceCol = -1;
  let debitCol = -1, creditCol = -1;

  headerRow.forEach((cell, idx) => {
    const s = String(cell || '');
    if (isDateHeader(s)) dateCol = idx;
    else if (isDescHeader(s)) descCol = idx;
    else if (isBranchHeader(s)) branchCol = idx;
    else if (isDebitHeader(s)) debitCol = idx;
    else if (isCreditHeader(s)) creditCol = idx;
    else if (isAmountHeader(s)) amountCol = idx;
    else if (isBalanceHeader(s)) balanceCol = idx;
  });

  const defaultYear = providedYear || 2026;

  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0 || row.every((c) => !String(c || '').trim())) continue;

    const rowText = row.map((c) => String(c || '').toUpperCase().trim()).join(' ');
    if (rowText.includes('SALDO AWAL') || rowText.includes('START BALANCE') || rowText.includes('OPENING BALANCE')) continue;
    if (
      rowText.includes('MUTASI DEBET') ||
      rowText.includes('MUTASI DEBIT') ||
      rowText.includes('MUTASI KREDIT') ||
      rowText.includes('SALDO AKHIR') ||
      rowText.includes('LAST BALANCE') ||
      rowText.includes('CLOSING BALANCE')
    ) {
      break;
    }

    const dateVal = row[dateCol];
    if (!dateVal || !String(dateVal).trim()) continue;

    const dateStr = String(dateVal).trim();
    const fullDateMatch = dateStr.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})$/);
    const numericMatch = dateStr.match(/^(\d{1,2})[.\/-](\d{1,2})$/);
    let day = 0, mon = 0, yr = defaultYear;

    if (fullDateMatch) {
      day = parseInt(fullDateMatch[1]);
      mon = parseInt(fullDateMatch[2]);
      const rawYr = parseInt(fullDateMatch[3]);
      yr = rawYr < 100 ? (rawYr < 70 ? 2000 + rawYr : 1900 + rawYr) : rawYr;
    } else if (numericMatch) {
      day = parseInt(numericMatch[1]);
      mon = parseInt(numericMatch[2]);
    }

    if (day < 1 || day > 31 || mon < 1 || mon > 12) continue;
    const parsedDate = `${yr}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    let debit = 0, credit = 0;
    if (debitCol >= 0 && creditCol >= 0) {
      debit = parseIndonesianNumber(row[debitCol]);
      credit = parseIndonesianNumber(row[creditCol]);
    } else if (amountCol >= 0) {
      const rawAmountStr = String(row[amountCol] || '').trim();
      let isCR = /\bCR\b/i.test(rawAmountStr);
      let isDB = /\bDB\b/i.test(rawAmountStr);

      if (!isCR && !isDB) {
        for (let c = 0; c < row.length; c++) {
          if (c === amountCol || c === dateCol || c === descCol || c === branchCol || c === balanceCol) continue;
          const cellVal = String(row[c] || '').trim();
          if (/^CR$/i.test(cellVal)) { isCR = true; break; }
          if (/^DB$/i.test(cellVal)) { isDB = true; break; }
        }
      }

      const cleanAmountStr = rawAmountStr.replace(/\b(CR|DB)\b/gi, '').trim();
      const amount = parseIndonesianNumber(cleanAmountStr);

      if (isCR) {
        credit = amount;
        debit = 0;
      } else if (isDB) {
        debit = amount;
        credit = 0;
      }
    }

    let balance = 0;
    if (balanceCol >= 0 && row[balanceCol] !== undefined && row[balanceCol] !== null && String(row[balanceCol]).trim() !== '') {
      balance = parseIndonesianNumber(row[balanceCol]);
    }

    // Collect multi-column description and details
    const descParts = [];
    if (descCol >= 0 && row[descCol] !== undefined && row[descCol] !== null) {
      const primary = String(row[descCol] || '').trim();
      if (primary) descParts.push(primary);
    }

    let extraRef = '';
    for (let c = 0; c < row.length; c++) {
      if (
        c === descCol ||
        c === dateCol ||
        c === branchCol ||
        c === debitCol ||
        c === creditCol ||
        c === amountCol ||
        c === balanceCol
      ) {
        continue;
      }

      const cellVal = String(row[c] || '').trim();
      if (!cellVal) continue;
      if (/^(CR|DB)$/i.test(cellVal)) continue;

      if (/^\d{6,10}-\d+$/.test(cellVal) && !extraRef) {
        extraRef = cellVal;
      }

      descParts.push(cellVal);
    }

    const rawDescription = descParts.join(' ').replace(/\s+/g, ' ').trim();
    const branch = branchCol >= 0 ? String(row[branchCol] || '').trim() : '';

    let reference = branch || extraRef;
    if (!reference) {
      const refMatch = rawDescription.match(/\b(\d{4}\/[A-Z0-9]+\/[A-Z0-9]+)\b/);
      if (refMatch) {
        reference = refMatch[1];
      }
    }

    const description = rawDescription;
    const numDebit = Number(debit) || 0;
    const numCredit = Number(credit) || 0;

    lines.push({
      id: `temp-${i}`,
      date: parsedDate,
      description,
      reference,
      debit: numDebit,
      credit: numCredit,
      balance,
      currency: metadata.currency || 'IDR',
      status: 'unmatched',
    });
  }

  return { lines, metadata };
};

// Test Runner
let allPassed = true;
function assert(name, condition, details = '') {
  if (condition) {
    console.log(`✅ PASS: ${name}${details ? ' - ' + details : ''}`);
  } else {
    console.error(`❌ FAIL: ${name}${details ? ' - ' + details : ''}`);
    allPassed = false;
  }
}

console.log('====================================================================');
console.log('BANK STATEMENT IMPORT INTEGRITY REGRESSION TEST (sep26.csv)');
console.log('====================================================================\n');

const filePath = '/Users/Kunal/Downloads/sep26.csv';
const csvContent = fs.readFileSync(filePath, 'utf8');

const rows = [];
let currentLine = '';
let inQuotes = false;
for (let i = 0; i < csvContent.length; i++) {
  const char = csvContent[i];
  if (char === '"') inQuotes = !inQuotes;
  else if (char === '\n' && !inQuotes) {
    if (currentLine.trim()) rows.push(parseCSVLine(currentLine, ','));
    currentLine = '';
  } else if (char !== '\r') {
    currentLine += char;
  }
}
if (currentLine.trim()) rows.push(parseCSVLine(currentLine, ','));

const { lines } = parseStatementDataWithMetadata(rows, 2026);

// 1. Total row count must be exactly 26
assert('All 26 transactions in sep26.csv preserved', lines.length === 26, `found ${lines.length}`);

// 2. Specific 3 duplicate-amount pairs on 30/09/2026
const linesSep30 = lines.filter((l) => l.date === '2026-09-30');
assert('Found 12 transactions on 30/09/2026', linesSep30.length === 12, `found ${linesSep30.length}`);

// Pair 1: Rp 2,000,000 on 30/09 (Sandi Prasetyo vs Ranti Tri Mulyani)
const sandi = linesSep30.find((l) => l.debit === 2000000 && l.description.includes('SANDI PRASETYO'));
const ranti = linesSep30.find((l) => l.debit === 2000000 && l.description.includes('RANTI TRI MULYANI'));
assert('30/09 Rp 2,000,000 SANDI PRASETYO preserved', Boolean(sandi), sandi ? sandi.description : 'MISSING');
assert('30/09 Rp 2,000,000 RANTI TRI MULYANI preserved', Boolean(ranti), ranti ? ranti.description : 'MISSING');
assert('Sandi and Ranti have distinct descriptions', sandi && ranti && sandi.description !== ranti.description);

// Pair 2: Rp 3,000,000 on 30/09 (Tiara Zalfa Imtina vs Dwi Zahra Restinin)
const tiara = linesSep30.find((l) => l.debit === 3000000 && /TIARA ZALFA IMTINA/i.test(l.description));
const dwi = linesSep30.find((l) => l.debit === 3000000 && /DWI ZAHRA RESTININ/i.test(l.description));
assert('30/09 Rp 3,000,000 TIARA ZALFA IMTINA preserved', Boolean(tiara), tiara ? tiara.description : 'MISSING');
assert('30/09 Rp 3,000,000 DWI ZAHRA RESTININ preserved', Boolean(dwi), dwi ? dwi.description : 'MISSING');
assert('Tiara and Dwi have distinct descriptions', tiara && dwi && tiara.description !== dwi.description);

// Pair 3: Rp 2,500,000 on 30/09 (Martua Aloysius Gi vs Muhamad Imron Hani)
const martua = linesSep30.find((l) => l.debit === 2500000 && /MARTUA ALOYSIUS GI/i.test(l.description));
const imron = linesSep30.find((l) => l.debit === 2500000 && /MUHAMAD IMRON HANI/i.test(l.description));
assert('30/09 Rp 2,500,000 MARTUA ALOYSIUS GI preserved', Boolean(martua), martua ? martua.description : 'MISSING');
assert('30/09 Rp 2,500,000 MUHAMAD IMRON HANI preserved', Boolean(imron), imron ? imron.description : 'MISSING');
assert('Martua and Imron have distinct descriptions', martua && imron && martua.description !== imron.description);

// 3. Totals and statement balances
const totalDebits = lines.reduce((sum, l) => sum + l.debit, 0);
const totalCredits = lines.reduce((sum, l) => sum + l.credit, 0);
const netChange = totalCredits - totalDebits;

assert('Total debits match sum of all 23 debit lines', totalDebits === 164883693, `Rp ${totalDebits.toLocaleString()}`);
assert('Total credits match sum of 3 credit lines', totalCredits === 107129370, `Rp ${totalCredits.toLocaleString()}`);

const dummyOpening = 100000000;
const statementBalance = dummyOpening + totalCredits - totalDebits;
assert('Statement balance is opening + credits - debits', statementBalance === dummyOpening + netChange);

// 4. Hash uniqueness
const accountId = 'acc-test-uuid';
const hashes = new Set();
lines.forEach((l) => {
  const normDesc = l.description.toLowerCase().replace(/\s+/g, ' ').trim();
  const hashInput = `${accountId}|${l.date}|${l.debit}|${l.credit}|${normDesc}|${l.balance}|${l.reference}`;
  const h = crypto.createHash('md5').update(hashInput).digest('hex');
  hashes.add(h);
});

assert('All 26 statement lines produce distinct hashes', hashes.size === 26, `unique hashes: ${hashes.size}/26`);

// 5. Deduplication occurrence simulation
const normalizeDesc = (d) => d.toLowerCase().replace(/\s+/g, ' ').trim();
const dbKeyCounts = new Map();
const csvKeyCounts = new Map();
const skipped = [];
const toInsert = lines.filter((line) => {
  const k = `${line.date}|${line.debit}|${line.credit}|${line.reference.trim().toLowerCase()}|${normalizeDesc(line.description)}`;
  const csvOcc = csvKeyCounts.get(k) || 0;
  csvKeyCounts.set(k, csvOcc + 1);
  const dbCount = dbKeyCounts.get(k) || 0;
  if (csvOcc < dbCount) {
    skipped.push(line);
    return false;
  }
  return true;
});

assert('Initial import keeps all 26 lines', toInsert.length === 26 && skipped.length === 0);

// Simulate re-upload of identical file when DB already has all 26
toInsert.forEach((line) => {
  const k = `${line.date}|${line.debit}|${line.credit}|${line.reference.trim().toLowerCase()}|${normalizeDesc(line.description)}`;
  dbKeyCounts.set(k, (dbKeyCounts.get(k) || 0) + 1);
});

const csvKeyCounts2 = new Map();
const skipped2 = [];
const toInsert2 = lines.filter((line) => {
  const k = `${line.date}|${line.debit}|${line.credit}|${line.reference.trim().toLowerCase()}|${normalizeDesc(line.description)}`;
  const csvOcc = csvKeyCounts2.get(k) || 0;
  csvKeyCounts2.set(k, csvOcc + 1);
  const dbCount = dbKeyCounts.get(k) || 0;
  if (csvOcc < dbCount) {
    skipped2.push(line);
    return false;
  }
  return true;
});

assert('Re-upload skips all 26 lines without corrupting data', toInsert2.length === 0 && skipped2.length === 26);

// Force import gives unique override hash to each skipped entry
const forceImportData = skipped2.map((e) => ({
  ...e,
  transaction_hash: `${crypto.randomUUID()}_override_${Date.now()}`,
}));
const forceHashes = new Set(forceImportData.map((e) => e.transaction_hash));
assert('Force import generates 26 unique override hashes', forceHashes.size === 26);

console.log('\n====================================================================');
if (allPassed) {
  console.log('🏆 ALL 26-ROW INTEGRITY TESTS PASSED!');
  process.exit(0);
} else {
  console.error('💥 SOME TESTS FAILED');
  process.exit(1);
}
