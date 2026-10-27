import fs from "fs";

const raw = JSON.parse(fs.readFileSync("/Users/Kunal/.gemini/antigravity-ide/brain/73556c95-1acf-43fd-9f69-2089a61e6410/scratch/expense_audit_results.json", "utf8"));
const rows = raw.rows || [];

console.log(`Total expenses with payment/reconciliation activity: ${rows.length}`);

const classified = [];
const flagCounts = {
  OVERPAID: 0,
  POSSIBLE_DOUBLE_COUNT: 0,
  DUPLICATE_PAYMENT: 0,
  UNALLOCATED_SETTLEMENT: 0,
  RECONCILIATION_ONLY: 0,
  OK: 0
};

for (const r of rows) {
  const payable = parseFloat(r.net_payable);
  const vaSettlement = parseFloat(r.va_settlement);
  const directJeSettlement = parseFloat(r.direct_je_settlement);
  const bsaRecon = parseFloat(r.bsa_reconciliation);
  const bslLegacy = parseFloat(r.bsl_legacy_total);

  // Identify true actual settlement vs reconciliation:
  // Payment vouchers (vaSettlement) and direct JE settlements are actual accounting payment events.
  // If an expense has both VA settlement and direct JE settlement: check if they represent the same event.
  // BSA (bank_statement_allocations) is bank statement reconciliation.
  let actualSettlement = 0;
  let possibleDoubleCount = 0;
  let flags = [];

  // If VA settlement exists:
  if (vaSettlement > 0) {
    actualSettlement += vaSettlement;
  } else if (directJeSettlement > 0) {
    actualSettlement += directJeSettlement;
  } else if (bslLegacy > 0) {
    actualSettlement += bslLegacy;
  } else if (bsaRecon > 0) {
    // Only reconciliation exists, no VA or direct JE
    actualSettlement = 0;
  }

  // Check possible double counts:
  // 1. If VA settlement exists AND direct JE settlement exists for the same expense
  if (vaSettlement > 0 && directJeSettlement > 0) {
    possibleDoubleCount += Math.min(vaSettlement, directJeSettlement);
    flags.push("POSSIBLE_DOUBLE_COUNT");
  }

  // 2. If direct JE count > 1 (like EXP/26/239 with 4 duplicate JEs!)
  if (parseInt(r.direct_je_count, 10) > 1 && directJeSettlement > payable + 1.0) {
    flags.push("DUPLICATE_PAYMENT");
  }

  // 3. If BSA recon exists AND VA settlement exists, but someone added BSA to settlement
  if (bsaRecon > 0 && vaSettlement > 0) {
    // Reconciliation mirrors VA payment
  }

  // Check overpaid:
  if (actualSettlement > payable + 1.0) {
    flags.push("OVERPAID");
  } else if (actualSettlement === 0 && bsaRecon > 0) {
    flags.push("RECONCILIATION_ONLY");
  } else if (actualSettlement > 0 && bsaRecon === 0 && bslLegacy === 0) {
    flags.push("UNALLOCATED_SETTLEMENT");
  }

  if (flags.length === 0) {
    flags.push("OK");
  }

  const primaryStatus = flags[0];
  flagCounts[primaryStatus] = (flagCounts[primaryStatus] || 0) + 1;

  classified.push({
    expense_id: r.expense_id,
    voucher_number: r.voucher_number,
    expense_date: r.expense_date,
    payable: payable,
    va_settlement: vaSettlement,
    direct_je_settlement: directJeSettlement,
    direct_je_count: parseInt(r.direct_je_count, 10),
    actual_settlement_total: actualSettlement,
    remaining_payable: Math.round((payable - actualSettlement) * 100) / 100,
    reconciliation_amount: bsaRecon > 0 ? bsaRecon : bslLegacy,
    possible_double_count_amount: possibleDoubleCount,
    flags,
    status: primaryStatus
  });
}

console.log("Summary of Expense Settlement Classifications:");
console.table(flagCounts);

// Write to scratch file
fs.writeFileSync("/Users/Kunal/.gemini/antigravity-ide/brain/73556c95-1acf-43fd-9f69-2089a61e6410/scratch/classified_expenses.json", JSON.stringify(classified, null, 2));

// Filter flagged/interesting expenses
const flagged = classified.filter(c => c.status !== "OK");
console.log(`Flagged expenses count: ${flagged.length}`);
console.log("Sample of Flagged Expenses:");
console.table(flagged.slice(0, 20).map(f => ({
  voucher: f.voucher_number,
  payable: f.payable,
  actual_settled: f.actual_settlement_total,
  direct_je: f.direct_je_settlement,
  bsa_recon: f.reconciliation_amount,
  status: f.status,
  flags: f.flags.join(", ")
})));
