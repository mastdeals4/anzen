#!/usr/bin/env node
/**
 * tests/bank-statement-importer-dual-format.test.mjs
 * 
 * Verifies that the Bank Reconciliation CSV importer properly supports
 * both Indonesian and English BCA export formats without regression.
 * 
 * Tests:
 * 1. Indonesian CSV: CorpAcctTrxn202683103545636.csv (52 lines, correct debit/credit, year from DD/MM/YY)
 * 2. English CSV: CorpAcctTrxn202692110138231.csv (20 lines, correct debit/credit, metadata Period, branch in reference)
 * 3. English CSV (Full): CorpAcctTrxn20269211026212.csv (33 lines, summary balances, running balance)
 * 4. English USD CSV: CorpAcctTrxn202692110223407.csv (USD currency detection, correct debit/credit)
 * 5. Amount parsing: strips CR/DB before numeric parsing, correctly identifies direction
 * 6. Date parsing: DD/MM/YYYY, DD/MM/YY, DD/MM with zero false year prompts
 * 7. Branch / Reference separation: Description NEVER contains Branch
 * 8. Validation: Rejects invalid lines (debit=0&credit=0 or debit>0&credit>0)
 */

import fs from 'fs';
import path from 'path';

// Exact normalization and parsing helpers identical to BankReconciliationEnhanced.tsx
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

const parseCSVLine = (line, delimiter = ';') => {
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

const detectNeedsYearPrompt = (rows) => {
  for (let i = 0; i < Math.min(20, rows.length); i++) {
    const row = rows[i];
    if (!row) continue;
    for (let j = 0; j < row.length; j++) {
      const cell = String(row[j] || '');
      if (/Period(?:e)?\s*:\s*\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}/i.test(cell)) return false;
    }
  }
  let dateCol = -1;
  for (let i = 0; i < Math.min(25, rows.length); i++) {
    const row = rows[i];
    if (!row) continue;
    const colIdx = row.findIndex(c => isDateHeader(String(c || '')));
    if (colIdx !== -1) { dateCol = colIdx; break; }
  }
  if (dateCol === -1) return false;
  let hasDateWithoutYear = false;
  let hasDateWithYear = false;
  for (let i = 0; i < rows.length; i++) {
    const val = rows[i]?.[dateCol];
    if (typeof val === 'number') { hasDateWithYear = true; break; }
    const cell = String(val || '').trim();
    if (/^\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}$/.test(cell)) { hasDateWithYear = true; break; }
    else if (/^\d{1,2}[\/-]\d{1,2}$/.test(cell)) hasDateWithoutYear = true;
  }
  return hasDateWithoutYear && !hasDateWithYear;
};

const parseStatementDataWithMetadata = (rows, providedYear) => {
  const lines = [];
  const metadata = {
    period: '',
    startDate: '',
    endDate: '',
    openingBalance: 0,
    closingBalance: 0,
    totalDebits: 0,
    totalCredits: 0,
    currency: '',
  };

  let fileYear = providedYear || null;

  for (let i = 0; i < Math.min(25, rows.length); i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;
    for (let j = 0; j < row.length; j++) {
      const cell = String(row[j] || '').trim();
      if (!cell) continue;
      const pMatch = cell.match(/Period(?:e)?\s*:\s*(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})\s*-\s*(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/i);
      if (pMatch) {
        let sDay = parseInt(pMatch[1]), sMon = parseInt(pMatch[2]), sYr = parseInt(pMatch[3]);
        let eDay = parseInt(pMatch[4]), eMon = parseInt(pMatch[5]), eYr = parseInt(pMatch[6]);
        if (sYr < 100) sYr += 2000;
        if (eYr < 100) eYr += 2000;
        fileYear = sYr;
        metadata.startDate = `${sYr}-${String(sMon).padStart(2, '0')}-${String(sDay).padStart(2, '0')}`;
        metadata.endDate = `${eYr}-${String(eMon).padStart(2, '0')}-${String(eDay).padStart(2, '0')}`;
        const monthNames = ['', 'JANUARI', 'FEBRUARI', 'MARET', 'APRIL', 'MEI', 'JUNI', 'JULI', 'AGUSTUS', 'SEPTEMBER', 'OKTOBER', 'NOVEMBER', 'DESEMBER'];
        metadata.period = `${monthNames[sMon] || sMon} ${sYr}`;
      }
      const cMatch = cell.match(/(?:Currency Code|Mata Uang)\s*:\s*([A-Za-z]+)/i);
      if (cMatch) {
        const rawC = cMatch[1].toUpperCase();
        metadata.currency = rawC === 'RP' ? 'IDR' : rawC;
      }
    }
  }

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

  if (dateCol === -1) return { lines, metadata };

  if (!fileYear) {
    for (let i = headerRowIdx + 1; i < rows.length; i++) {
      const cell = String(rows[i]?.[dateCol] || '').trim();
      const m = cell.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
      if (m) {
        let yr = parseInt(m[3]);
        fileYear = yr < 100 ? (yr < 70 ? 2000 + yr : 1900 + yr) : yr;
        break;
      }
    }
  }

  const defaultYear = fileYear || providedYear || new Date().getFullYear();

  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0 || row.every(c => !String(c || '').trim())) continue;

    const firstCell = String(row[0] || '').toUpperCase();
    const secondCell = String(row[1] || '').toUpperCase();
    const rowText = `${firstCell} ${secondCell}`;

    if (rowText.includes('SALDO AWAL') || rowText.includes('START BALANCE') || rowText.includes('OPENING BALANCE')) continue;
    if (
      rowText.includes('MUTASI DEBET') || rowText.includes('MUTASI DEBIT') ||
      rowText.includes('MUTASI KREDIT') || rowText.includes('MUTASI CREDIT') ||
      rowText.includes('MUTASI DB') || rowText.includes('MUTASI CR') ||
      rowText.includes('SALDO AKHIR') || rowText.includes('LAST BALANCE') ||
      rowText.includes('CLOSING BALANCE') || rowText.includes('ENDING BALANCE')
    ) break;

    const dateVal = row[dateCol];
    if (!dateVal || !String(dateVal).trim()) continue;

    let parsedDate = '';
    if (typeof dateVal === 'number') {
      const excelEpoch = new Date(1900, 0, 1);
      const daysOffset = dateVal - 2;
      const jsDate = new Date(excelEpoch.getTime() + daysOffset * 24 * 60 * 60 * 1000);
      parsedDate = `${jsDate.getFullYear()}-${String(jsDate.getMonth() + 1).padStart(2, '0')}-${String(jsDate.getDate()).padStart(2, '0')}`;
    } else {
      const dateStr = String(dateVal).trim();
      const fullDateMatch = dateStr.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})$/);
      const numericMatch = dateStr.match(/^(\d{1,2})[.\/-](\d{1,2})$/);
      const namedMatch = dateStr.match(/^(\d{1,2})[-\s]([A-Za-z]{3,4})(?:[-\s](\d{2,4}))?$/);
      const monthNames = {
        jan: 1, feb: 2, mar: 3, apr: 4, may: 5, mei: 5,
        jun: 6, jul: 7, aug: 8, agu: 8, ags: 8, sep: 9,
        oct: 10, okt: 10, nov: 11, dec: 12, des: 12
      };

      let day = 0, mon = 0, yr = defaultYear;
      if (fullDateMatch) {
        day = parseInt(fullDateMatch[1]);
        mon = parseInt(fullDateMatch[2]);
        let rawYr = parseInt(fullDateMatch[3]);
        yr = rawYr < 100 ? (rawYr < 70 ? 2000 + rawYr : 1900 + rawYr) : rawYr;
      } else if (numericMatch) {
        day = parseInt(numericMatch[1]);
        mon = parseInt(numericMatch[2]);
      } else if (namedMatch) {
        day = parseInt(namedMatch[1]);
        mon = monthNames[namedMatch[2].toLowerCase()] || 0;
        if (namedMatch[3]) {
          let rawYr = parseInt(namedMatch[3]);
          yr = rawYr < 100 ? (rawYr < 70 ? 2000 + rawYr : 1900 + rawYr) : rawYr;
        }
      }

      if (day < 1 || day > 31 || mon < 1 || mon > 12) continue;
      parsedDate = `${yr}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }

    let debit = 0, credit = 0;
    if (debitCol >= 0 && creditCol >= 0) {
      const debitStr = String(row[debitCol] || '').trim();
      const creditStr = String(row[creditCol] || '').trim();
      debit = parseIndonesianNumber(debitStr);
      credit = parseIndonesianNumber(creditStr);
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
      if (isCR) credit = amount;
      else if (isDB) debit = amount;
    }

    let balance = 0;
    if (balanceCol >= 0 && row[balanceCol] !== undefined && row[balanceCol] !== null && String(row[balanceCol]).trim() !== '') {
      balance = parseIndonesianNumber(row[balanceCol]);
    }

    const description = descCol >= 0 ? String(row[descCol] || '').trim() : '';
    const branch = branchCol >= 0 ? String(row[branchCol] || '').trim() : '';

    const numDebit = Number(debit) || 0;
    const numCredit = Number(credit) || 0;
    const isValid = (numDebit > 0 && numCredit === 0) || (numCredit > 0 && numDebit === 0);

    if (!isValid) {
      throw new Error(
        `Bank statement line at row ${i + 1} (${parsedDate}) must have exactly one positive debit or credit amount. Found debit=${numDebit}, credit=${numCredit}. Raw values: [${row.map(c => String(c ?? '')).join(' | ')}]`
      );
    }

    lines.push({
      id: `temp-${i}`,
      date: parsedDate,
      description,
      reference: branch,
      debit: numDebit,
      credit: numCredit,
      balance,
      currency: metadata.currency || 'IDR',
    });
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;
    const rowJoined = row.map(c => String(c || '').trim()).join(' ');
    const mStart = rowJoined.match(/(?:Saldo\s*Awal|Start\s*Balance)\s*[:=]?\s*([\d,.]+)/i);
    if (mStart) metadata.openingBalance = parseIndonesianNumber(mStart[1]);
    const mDebit = rowJoined.match(/(?:Mutasi\s*Deb[ei]t|Mutasi\s*DB)\s*[:=]?\s*([\d,.]+)/i);
    if (mDebit) metadata.totalDebits = parseIndonesianNumber(mDebit[1]);
    const mCredit = rowJoined.match(/(?:Mutasi\s*Kredit|Mutasi\s*Credit|Mutasi\s*CR)\s*[:=]?\s*([\d,.]+)/i);
    if (mCredit) metadata.totalCredits = parseIndonesianNumber(mCredit[1]);
    const mLast = rowJoined.match(/(?:Saldo\s*Akhir|Last\s*Balance|Ending\s*Balance|Closing\s*Balance)\s*[:=]?\s*([\d,.]+)/i);
    if (mLast) metadata.closingBalance = parseIndonesianNumber(mLast[1]);
  }

  return { lines, metadata };
};

const parseFile = (filepath) => {
  const text = fs.readFileSync(filepath, 'utf8');
  const sampleLines = text.split('\n').slice(0, 15).join('\n');
  const commaCount = (sampleLines.match(/,/g) || []).length;
  const semicolonCount = (sampleLines.match(/;/g) || []).length;
  const delimiter = commaCount >= semicolonCount ? ',' : ';';
  const rows = [];
  let currentLine = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      inQuotes = !inQuotes;
      currentLine += char;
    } else if (char === '\n' && !inQuotes) {
      if (currentLine.trim()) rows.push(parseCSVLine(currentLine, delimiter));
      currentLine = '';
    } else if (char !== '\r') {
      currentLine += char;
    }
  }
  if (currentLine.trim()) rows.push(parseCSVLine(currentLine, delimiter));
  const needsPrompt = detectNeedsYearPrompt(rows);
  return { rows, needsPrompt, ...parseStatementDataWithMetadata(rows) };
};

let allPassed = true;
function assert(name, condition, details = '') {
  if (condition) console.log(`✅ PASS: ${name}${details ? ' - ' + details : ''}`);
  else {
    console.error(`❌ FAIL: ${name}${details ? ' - ' + details : ''}`);
    allPassed = false;
  }
}

console.log('====================================================================');
console.log('BANK RECONCILIATION DUAL-FORMAT CSV IMPORTER REGRESSION TEST');
console.log('====================================================================\n');

// 1. Indonesian CSV
{
  const res = parseFile('/Users/Kunal/Downloads/CorpAcctTrxn202683103545636.csv');
  assert('Indonesian CSV lines count', res.lines.length === 52, `found ${res.lines.length}`);
  assert('Indonesian CSV no false year prompt', res.needsPrompt === false);
  assert('Indonesian CSV line 1 date', res.lines[0].date === '2026-08-03');
  assert('Indonesian CSV line 1 debit', res.lines[0].debit === 13930405);
  assert('Indonesian CSV line 1 credit', res.lines[0].credit === 0);
  assert('Indonesian CSV line 3 is credit', res.lines[2].credit === 46363590 && res.lines[2].debit === 0);
  assert('Indonesian CSV line 52 date', res.lines[51].date === '2026-08-28');
  assert('Indonesian CSV line 52 debit', res.lines[51].debit === 375000);
}

// 2. English CSV (User target file)
{
  const res = parseFile('/Users/Kunal/Downloads/CorpAcctTrxn202692110138231.csv');
  assert('English CSV lines count', res.lines.length === 20, `found ${res.lines.length}`);
  assert('English CSV no false year prompt', res.needsPrompt === false);
  assert('English CSV metadata period', res.metadata.period === 'SEPTEMBER 2026');
  assert('English CSV metadata start date', res.metadata.startDate === '2026-09-09');
  assert('English CSV metadata end date', res.metadata.endDate === '2026-09-21');
  assert('English CSV metadata currency', res.metadata.currency === 'IDR');
  assert('English CSV line 1 date', res.lines[0].date === '2026-09-09');
  assert('English CSV line 1 credit', res.lines[0].credit === 95996907 && res.lines[0].debit === 0);
  assert('English CSV line 1 branch in reference', res.lines[0].reference === '0000');
  assert('English CSV description excludes branch', !res.lines[0].description.includes('; 0000'));
  assert('English CSV line 1 balance', res.lines[0].balance === 172776627.44);
  assert('English CSV line 6 debit', res.lines[5].debit === 450000 && res.lines[5].credit === 0);
}

// 3. English CSV (Full month)
{
  const res = parseFile('/Users/Kunal/Downloads/CorpAcctTrxn20269211026212.csv');
  assert('English Full CSV lines count', res.lines.length === 33, `found ${res.lines.length}`);
  assert('English Full CSV opening balance', res.metadata.openingBalance === 76779720.44);
  assert('English Full CSV closing balance', res.metadata.closingBalance === 65822944.44);
  assert('English Full CSV total debits', res.metadata.totalDebits === 354101770);
  assert('English Full CSV total credits', res.metadata.totalCredits === 343144994);
  assert('English Full CSV last line credit', res.lines[32].credit === 29430956);
}

// 4. English USD CSV
{
  const res = parseFile('/Users/Kunal/Downloads/CorpAcctTrxn202692110223407.csv');
  assert('English USD CSV lines count', res.lines.length === 2, `found ${res.lines.length}`);
  assert('English USD CSV currency detected', res.metadata.currency === 'USD');
  assert('English USD CSV line 1 debit', res.lines[0].debit === 5);
  assert('English USD CSV line 2 debit', res.lines[1].debit === 6000);
}

// 5. Validation rule tests: reject debit=0&credit=0 and debit>0&credit>0
{
  let rejectedZero = false;
  try {
    parseStatementDataWithMetadata([
      ['Date', 'Description', 'Branch', 'Amount', 'Balance'],
      ['10/09/2026', 'Zero Transaction', '0000', '0.00', '100.00'],
    ]);
  } catch (e) {
    rejectedZero = e.message.includes('must have exactly one positive debit or credit amount');
  }
  assert('Validation: Rejects zero-amount line', rejectedZero);

  let rejectedDouble = false;
  try {
    parseStatementDataWithMetadata([
      ['Date', 'Description', 'Debit', 'Credit', 'Balance'],
      ['10/09/2026', 'Double Transaction', '500.00', '500.00', '100.00'],
    ]);
  } catch (e) {
    rejectedDouble = e.message.includes('must have exactly one positive debit or credit amount');
  }
  assert('Validation: Rejects simultaneous positive debit and credit', rejectedDouble);

  // 6. Dot date formats and 2-digit years
  const dotDateRes = parseStatementDataWithMetadata([
    ['Transaction Date', 'Description', 'Branch', 'Amount', 'Balance'],
    ['14.9.26', 'Payment 1', '0000', '100,000.00 DB', '900,000.00'],
    ['09.09.2026', 'Payment 2', '0000', '200,000.00 DB', '700,000.00'],
    ['09/09/26', 'Deposit 1', '0000', '300,000.00 CR', '1,000,000.00'],
    ['', '', '', '', ''], // Blank row with ,,
    ['SALDO AWAL', '0.00', '', '', ''], // Footer row
    ['MUTASI DEBET', '300,000.00', '', '', ''], // Footer row
  ]);
  assert('Dot date format: 14.9.26 parses to 2026-09-14', dotDateRes.lines[0]?.date === '2026-09-14');
  assert('Dot date format: 09.09.2026 parses to 2026-09-09', dotDateRes.lines[1]?.date === '2026-09-09');
  assert('Slash 2-digit year: 09/09/26 parses to 2026-09-09', dotDateRes.lines[2]?.date === '2026-09-09');
  assert('Blank rows and footer rows are ignored', dotDateRes.lines.length === 3);
}

console.log('\n====================================================================');
if (allPassed) {
  console.log('🏆 ALL BANK RECONCILIATION IMPORTER TESTS PASSED');
  console.log('====================================================================');
  process.exit(0);
} else {
  console.error('💥 SOME TESTS FAILED');
  console.log('====================================================================');
  process.exit(1);
}
