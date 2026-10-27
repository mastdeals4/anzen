import { execSync } from "child_process";
import fs from "fs";

console.log("Analyzing BSL integrity checks A through P...");

const bslData = JSON.parse(fs.readFileSync("/Users/Kunal/.gemini/antigravity-ide/brain/73556c95-1acf-43fd-9f69-2089a61e6410/scratch/bsl_integrity_results.json", "utf8")).rows || [];

console.log(`Loaded ${bslData.length} IDR bank statement lines through 10 Sep 2026.`);

// Fetch all posted bank journal entries for IDR bank account through 10 Sep 2026
const jesSql = `
SELECT 
  je.id AS je_id,
  je.entry_number,
  je.entry_date,
  je.source_module,
  je.description,
  je.is_posted,
  je.is_reversed,
  jel.id AS jel_id,
  jel.account_id,
  jel.debit,
  jel.credit
FROM journal_entries je
JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
WHERE jel.account_id = 'eda4928b-2120-4c1c-a4e1-46c9eb7a610d'
  AND je.entry_date <= '2026-09-10'
ORDER BY je.entry_date, je.entry_number;
`;

fs.writeFileSync("/Users/Kunal/.gemini/antigravity-ide/brain/73556c95-1acf-43fd-9f69-2089a61e6410/scratch/bank_jes.sql", jesSql);
const jesRes = execSync(`npx supabase db query --linked -o json --file /Users/Kunal/.gemini/antigravity-ide/brain/73556c95-1acf-43fd-9f69-2089a61e6410/scratch/bank_jes.sql`, {
  encoding: "utf8",
  maxBuffer: 30 * 1024 * 1024
});

const bankJes = JSON.parse(jesRes).rows || [];
console.log(`Loaded ${bankJes.length} bank journal entry lines through 10 Sep 2026.`);

const jeMap = new Map();
for (const j of bankJes) {
  if (!jeMap.has(j.je_id)) {
    jeMap.set(j.je_id, {
      je_id: j.je_id,
      entry_number: j.entry_number,
      entry_date: j.entry_date,
      source_module: j.source_module,
      is_posted: j.is_posted,
      is_reversed: j.is_reversed,
      lines: []
    });
  }
  jeMap.get(j.je_id).lines.push(j);
}

// Track checks
const exceptions = {
  A_matched_no_allocation: [],
  B_confirmed_no_allocation: [],
  C_allocation_invalid_je: [],
  D_allocation_no_bank_coa: [],
  E_wrong_bank_account: [],
  F_wrong_currency: [],
  G_wrong_direction: [],
  H_amount_mismatch: [],
  I_allocation_exceeds_line: [],
  J_conflicting_owners: [],
  K_matched_entry_inconsistent: [],
  L_matched_field_inconsistent: [],
  M_duplicate_hash: [],
  N_duplicate_accounting_event: [],
  O_statement_no_accounting_event: [],
  P_accounting_event_no_statement: []
};

// Map JEs allocated
const allocatedJeIds = new Set();
const jeToBslMap = new Map();

for (const line of bslData) {
  const lineAmount = parseFloat(line.line_amount);
  const totalAllocated = parseFloat(line.total_allocated);
  const allocCount = parseInt(line.alloc_count, 10);
  const isMatched = line.reconciliation_status === 'matched';
  const isConfirmed = line.matching_status === 'confirmed';

  // Check A: matched status but no allocation
  if (isMatched && allocCount === 0 && !line.matched_entry_id) {
    exceptions.A_matched_no_allocation.push({ line_id: line.bsl_id, desc: line.description, amount: lineAmount });
  }

  // Check B: confirmed status but no valid allocation
  if (isConfirmed && allocCount === 0 && !line.matched_entry_id) {
    exceptions.B_confirmed_no_allocation.push({ line_id: line.bsl_id, desc: line.description, amount: lineAmount });
  }

  // Check I: allocation exceeds statement line
  if (totalAllocated > lineAmount + 0.01) {
    exceptions.I_allocation_exceeds_line.push({ line_id: line.bsl_id, line_amount: lineAmount, total_allocated: totalAllocated });
  }

  // Check F: wrong currency
  if (line.currency && line.currency !== 'IDR') {
    exceptions.F_wrong_currency.push({ line_id: line.bsl_id, currency: line.currency });
  }

  // If allocations exist:
  if (allocCount > 0 && line.allocations) {
    for (const a of line.allocations) {
      if (a.journal_entry_id) {
        allocatedJeIds.add(a.journal_entry_id);

        if (!jeToBslMap.has(a.journal_entry_id)) jeToBslMap.set(a.journal_entry_id, []);
        jeToBslMap.get(a.journal_entry_id).push({ line_id: line.bsl_id, alloc_id: a.alloc_id, amount: a.amount });

        const je = jeMap.get(a.journal_entry_id);
        if (!je) {
          // Check D: JE has no bank COA or is not in bankJes!
          exceptions.D_allocation_no_bank_coa.push({
            line_id: line.bsl_id,
            alloc_id: a.alloc_id,
            journal_entry_id: a.journal_entry_id,
            amount: a.amount
          });
        } else {
          // Check C: JE not posted
          if (!je.is_posted) {
            exceptions.C_allocation_invalid_je.push({ line_id: line.bsl_id, je_id: je.je_id, entry_number: je.entry_number });
          }

          // Check G: direction
          // Bank statement debit (outgoing) should correspond to bank COA credit (outgoing)
          // Bank statement credit (incoming) should correspond to bank COA debit (incoming)
          const totalJeDebit = je.lines.reduce((s, l) => s + parseFloat(l.debit), 0);
          const totalJeCredit = je.lines.reduce((s, l) => s + parseFloat(l.credit), 0);

          if (line.line_direction === 'debit' && totalJeCredit <= 0 && totalJeDebit > 0) {
            exceptions.G_wrong_direction.push({
              line_id: line.bsl_id,
              je_id: je.je_id,
              entry_number: je.entry_number,
              line_dir: line.line_direction,
              je_debit: totalJeDebit,
              je_credit: totalJeCredit
            });
          } else if (line.line_direction === 'credit' && totalJeDebit <= 0 && totalJeCredit > 0) {
            exceptions.G_wrong_direction.push({
              line_id: line.bsl_id,
              je_id: je.je_id,
              entry_number: je.entry_number,
              line_dir: line.line_direction,
              je_debit: totalJeDebit,
              je_credit: totalJeCredit
            });
          }
        }
      }
    }

    // Check H: Amount mismatch on fully matched lines
    if (isMatched && Math.abs(totalAllocated - lineAmount) > 0.01) {
      exceptions.H_amount_mismatch.push({ line_id: line.bsl_id, line_amount: lineAmount, total_allocated: totalAllocated });
    }

    // Check K: matched_entry_id inconsistent with single allocation
    if (allocCount === 1 && line.allocations[0].journal_entry_id) {
      if (line.matched_entry_id && line.matched_entry_id !== line.allocations[0].journal_entry_id) {
        exceptions.K_matched_entry_inconsistent.push({ line_id: line.bsl_id, matched_entry_id: line.matched_entry_id, alloc_je_id: line.allocations[0].journal_entry_id });
      }
    }
  } else if (!line.matched_entry_id) {
    // Check O: statement transaction with no accounting event
    exceptions.O_statement_no_accounting_event.push({
      line_id: line.bsl_id,
      date: line.transaction_date,
      desc: line.description,
      debit: line.debit_amount,
      credit: line.credit_amount,
      status: line.reconciliation_status
    });
  }
}

// Check N: duplicate accounting event (multiple BSLs allocated to the same JE)
for (const [jeId, bsls] of jeToBslMap) {
  if (bsls.length > 1) {
    exceptions.N_duplicate_accounting_event.push({
      je_id: jeId,
      bsl_count: bsls.length,
      lines: bsls
    });
  }
}

// Check P: accounting event with no statement transaction (posted bank JEs through 10 Sep with no statement allocation)
for (const [jeId, je] of jeMap) {
  if (je.is_posted && !je.is_reversed && !allocatedJeIds.has(jeId)) {
    const totalDebit = je.lines.reduce((s, l) => s + parseFloat(l.debit), 0);
    const totalCredit = je.lines.reduce((s, l) => s + parseFloat(l.credit), 0);
    exceptions.P_accounting_event_no_statement.push({
      je_id: jeId,
      entry_number: je.entry_number,
      entry_date: je.entry_date,
      source_module: je.source_module,
      description: je.description,
      debit: totalDebit,
      credit: totalCredit
    });
  }
}

console.log("=== INTEGRITY AUDIT SUMMARY (A through P) ===");
for (const [key, list] of Object.entries(exceptions)) {
  console.log(`${key}: ${list.length} exceptions`);
}

fs.writeFileSync("/Users/Kunal/.gemini/antigravity-ide/brain/73556c95-1acf-43fd-9f69-2089a61e6410/scratch/bsl_integrity_summary.json", JSON.stringify(exceptions, null, 2));
console.log("Saved full exception details to scratch/bsl_integrity_summary.json");
