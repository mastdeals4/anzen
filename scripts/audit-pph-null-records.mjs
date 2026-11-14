import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

// Load environment variables
const env = Object.fromEntries(
  fs.readFileSync('.env', 'utf8')
    .split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => {
      const idx = l.indexOf('=');
      return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
    })
);

const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY);

async function runAudit() {
  const { error: authErr } = await supabase.auth.signInWithPassword({
    email: 'kunal@avira.co.id',
    password: env.TEST_USER_PASSWORD,
  });
  if (authErr) {
    console.error('Auth error:', authErr);
    process.exit(1);
  }

  // 1. Fetch all NULL PPh records
  const { data: nullExpenses, error: expErr } = await supabase
    .from('finance_expenses')
    .select('*')
    .gt('pph_amount', 0)
    .is('pph_tax_period_id', null)
    .order('expense_date', { ascending: true });

  if (expErr) {
    console.error('Error fetching expenses:', expErr);
    process.exit(1);
  }

  console.log(`Found ${nullExpenses.length} NULL PPh records.`);

  // 2. Fetch all reference data
  const [
    { data: taxCodes },
    { data: taxPeriods },
    { data: staffList },
    { data: payeesList },
    { data: suppliersList },
    { data: allocations },
    { data: bankStatementLines },
    { data: postingLifecycles }
  ] = await Promise.all([
    supabase.from('tax_codes').select('*'),
    supabase.from('tax_periods').select('*'),
    supabase.from('finance_staff_master').select('*'),
    supabase.from('finance_payees').select('*'),
    supabase.from('suppliers').select('*'),
    supabase.from('voucher_allocations').select('*, payment_vouchers(*)').in('finance_expense_id', nullExpenses.map(e => e.id)),
    supabase.from('bank_statement_lines').select('*').in('matched_expense_id', nullExpenses.map(e => e.id)),
    supabase.from('effective_expense_posting_state').select('*').in('expense_id', nullExpenses.map(e => e.id))
  ]);

  // Also fetch payment vouchers that might reference the expense directly or via originating BSL
  const origBslIds = nullExpenses.map(e => e.originating_bank_statement_line_id).filter(Boolean);
  let origBslRecords = [];
  if (origBslIds.length > 0) {
    const { data: bslData } = await supabase.from('bank_statement_lines').select('*').in('id', origBslIds);
    origBslRecords = bslData || [];
  }

  // Fetch journal entries for these expenses
  const expIds = nullExpenses.map(e => e.id);
  const expVouchers = nullExpenses.map(e => e.voucher_number).filter(Boolean);
  const { data: journalEntries } = await supabase
    .from('journal_entries')
    .select('*, journal_entry_lines(*)')
    .or(`reference_id.in.(${expIds.join(',')}),reference_number.in.(${expVouchers.join(',')})`);

  // Build lookups
  const taxCodeMap = new Map((taxCodes || []).map(tc => [tc.id, tc]));
  const taxPeriodMap = new Map((taxPeriods || []).map(tp => [tp.id, tp]));
  const staffMap = new Map((staffList || []).map(s => [s.id, s]));
  const payeeMap = new Map((payeesList || []).map(p => [p.id, p]));
  const supplierMap = new Map((suppliersList || []).map(s => [s.id, s]));
  const bslMap = new Map((bankStatementLines || []).map(b => [b.matched_expense_id, b]));
  const origBslMap = new Map((origBslRecords || []).map(b => [b.id, b]));
  const lifecycleMap = new Map((postingLifecycles || []).map(l => [l.expense_id, l]));

  // Allocations by expense id
  const allocByExpId = new Map();
  for (const alloc of (allocations || [])) {
    if (!allocByExpId.has(alloc.finance_expense_id)) {
      allocByExpId.set(alloc.finance_expense_id, []);
    }
    allocByExpId.get(alloc.finance_expense_id).push(alloc);
  }

  // Journals by expense id or reference number
  const journalByExpId = new Map();
  for (const je of (journalEntries || [])) {
    if (je.reference_id) {
      if (!journalByExpId.has(je.reference_id)) journalByExpId.set(je.reference_id, []);
      journalByExpId.get(je.reference_id).push(je);
    }
    if (je.reference_number) {
      if (!journalByExpId.has(je.reference_number)) journalByExpId.set(je.reference_number, []);
      journalByExpId.get(je.reference_number).push(je);
    }
  }

  // Audit each record
  const auditedRecords = nullExpenses.map(exp => {
    const taxCode = taxCodeMap.get(exp.pph_code_id);
    const genPeriod = taxPeriodMap.get(exp.tax_period_id);
    const staff = staffMap.get(exp.staff_id);
    const payee = payeeMap.get(exp.payee_id);
    const supplier = supplierMap.get(exp.supplier_id);
    const allocs = allocByExpId.get(exp.id) || [];
    const matchedBsl = bslMap.get(exp.id);
    const origBsl = exp.originating_bank_statement_line_id ? origBslMap.get(exp.originating_bank_statement_line_id) : null;
    const lifecycle = lifecycleMap.get(exp.id);
    const journals = (journalByExpId.get(exp.id) || []).concat(journalByExpId.get(exp.voucher_number) || []);

    // Recipient name
    let recipientName = '—';
    let recipientType = 'none';
    if (staff) {
      recipientName = staff.full_name;
      recipientType = 'staff';
    } else if (payee) {
      recipientName = payee.full_name;
      recipientType = 'payee';
    } else if (supplier) {
      recipientName = supplier.company_name;
      recipientType = 'supplier';
    } else if (exp.description) {
      recipientName = exp.description.slice(0, 40);
      recipientType = 'description_inferred';
    }

    // Payment Evidence Discovery
    let actualPaymentDate = null;
    let paymentEvidenceType = 'none';
    let paymentRefDetails = [];

    // Check voucher allocations
    for (const alloc of allocs) {
      const pv = alloc.payment_vouchers;
      if (pv) {
        if (!actualPaymentDate || (pv.voucher_date && pv.voucher_date < actualPaymentDate)) {
          actualPaymentDate = pv.voucher_date;
        }
        paymentEvidenceType = 'payment_voucher';
        paymentRefDetails.push(`PV:${pv.voucher_number} (${pv.voucher_date}) Rp${alloc.allocated_amount}`);
      }
    }

    // Check matched bank statement line
    if (matchedBsl) {
      if (!actualPaymentDate) actualPaymentDate = matchedBsl.transaction_date;
      paymentEvidenceType = paymentEvidenceType === 'payment_voucher' ? 'both' : 'bank_statement';
      paymentRefDetails.push(`BSL:${matchedBsl.transaction_date} Rp${matchedBsl.debit_amount || matchedBsl.credit_amount}`);
    }

    // Check originating bank statement line
    if (origBsl) {
      if (!actualPaymentDate) actualPaymentDate = origBsl.transaction_date;
      paymentEvidenceType = paymentEvidenceType === 'payment_voucher' ? 'both' : 'orig_bank_statement';
      paymentRefDetails.push(`OrigBSL:${origBsl.transaction_date} Rp${origBsl.debit_amount}`);
    }

    // Check cash payment method
    if (exp.payment_method === 'cash') {
      actualPaymentDate = exp.expense_date;
      paymentEvidenceType = 'petty_cash';
      paymentRefDetails.push(`PettyCash:${exp.expense_date}`);
    }

    // If paid_amount > 0 and payment_method = bank_transfer with no BSL/PV, check if expense_date or paid_by
    if (!actualPaymentDate && (exp.paid_amount > 0 || exp.payment_method)) {
      paymentEvidenceType = 'direct_expense_record';
      actualPaymentDate = exp.expense_date; // Fallback candidate
      paymentRefDetails.push(`ExpenseMethod:${exp.payment_method || 'direct'} (date: ${exp.expense_date})`);
    }

    // Canonical Payable Calculation
    // Total gross = exp.amount
    // If withholding: cash payable = amount - pph_amount
    const canonicalPayable = (exp.pph_treatment === 'gross_up' || exp.pph_treatment === 'company_borne')
      ? exp.amount
      : Math.max(0, exp.amount - (exp.pph_amount || 0));

    const isFullyPaid = exp.paid_amount >= canonicalPayable - 1;
    const isPartiallyPaid = exp.paid_amount > 0 && !isFullyPaid;
    const isUnpaid = (exp.paid_amount || 0) === 0;

    let paymentStatus = 'unpaid';
    if (isFullyPaid) paymentStatus = 'paid';
    else if (isPartiallyPaid) paymentStatus = 'partial';

    // Classification per TASK 2:
    // 1. Paid but PPh period missing.
    // 2. Unpaid — withholding not yet recognized.
    // 3. Partially paid.
    // 4. Cancelled.
    // 5. Missing payment evidence.
    // 6. Other / needs manual review.
    let classification = 'other';
    let classificationReason = '';

    if (exp.approval_status === 'cancelled' || lifecycle?.effective_posting_state === 'REVERSED') {
      classification = 'Cancelled';
      classificationReason = 'Expense is cancelled / reversed. No tax withholding required.';
    } else if (isUnpaid) {
      classification = 'Unpaid — withholding not yet recognized';
      classificationReason = 'Expense is approved but unpaid (paid_amount = 0). Under statutory cash withholding basis, tax withholding is recognized upon payment.';
    } else if (isPartiallyPaid) {
      classification = 'Partially paid';
      classificationReason = `Partially paid (Rp ${exp.paid_amount} of Rp ${canonicalPayable}). Tax withholding recognized proportionally to disbursement.`;
    } else if (isFullyPaid) {
      if (allocs.length === 0 && !matchedBsl && !origBsl && exp.payment_method !== 'cash') {
        classification = 'Missing payment evidence';
        classificationReason = 'Marked paid in expense record, but lacks linked Payment Voucher or Bank Statement Line allocation.';
      } else {
        classification = 'Paid but PPh period missing';
        classificationReason = `Disbursed on ${actualPaymentDate || exp.expense_date} but pph_tax_period_id was left null.`;
      }
    }

    // Check PPh calculation correctness
    const expectedRate = taxCode?.rate || 0;
    const grossAmount = exp.amount;
    const dppAmount = exp.dpp_amount || exp.pph_dpp_amount || grossAmount;
    let calcDiscrepancy = null;

    // Journal posting status
    const isPosted = lifecycle?.effective_posting_state === 'ACTIVE' || lifecycle?.effective_posting_state === 'REPLACED';
    const journalNumber = lifecycle?.active_journal_number || lifecycle?.effective_journal_number || 'None';

    // Supported PPh period based on actualPaymentDate
    let supportedPeriod = null;
    if (actualPaymentDate) {
      const pDate = new Date(actualPaymentDate);
      const pYear = pDate.getFullYear();
      const pMonth = pDate.getMonth() + 1;
      const taxType = taxCode?.tax_type || (exp.expense_category === 'salary' ? 'PPh21' : 'PPh23');
      const foundPeriod = (taxPeriods || []).find(tp => 
        tp.fiscal_year === pYear && 
        tp.period_month === pMonth && 
        (tp.tax_type === taxType || tp.tax_type === 'PPh_Unifikasi')
      );
      if (foundPeriod) {
        supportedPeriod = `${foundPeriod.tax_type} ${foundPeriod.fiscal_year}-${String(foundPeriod.period_month).padStart(2, '0')} (ID: ${foundPeriod.id})`;
      } else {
        supportedPeriod = `${taxType} ${pYear}-${String(pMonth).padStart(2, '0')} (Period record not in DB)`;
      }
    }

    return {
      id: exp.id,
      voucher_number: exp.voucher_number,
      expense_date: exp.expense_date,
      category: exp.expense_category,
      recipient: recipientName,
      recipient_type: recipientType,
      pph_code: taxCode?.code || 'None',
      pph_tax_type: taxCode?.tax_type || 'Unknown',
      pph_treatment: exp.pph_treatment || 'withholding_deducted',
      pph_regime: exp.pph_calculation_regime || 'standard',
      pph_rate: exp.pph_rate || taxCode?.rate || 0,
      dpp_amount: dppAmount,
      gross_amount: exp.amount,
      pph_amount: exp.pph_amount,
      canonical_payable: canonicalPayable,
      paid_amount: exp.paid_amount || 0,
      payment_status: paymentStatus,
      payment_method: exp.payment_method || 'None',
      actual_payment_date: actualPaymentDate,
      payment_evidence_type: paymentEvidenceType,
      payment_references: paymentRefDetails.join('; ') || 'None',
      tax_period_id: exp.tax_period_id,
      gen_period_name: genPeriod ? `${genPeriod.tax_type} ${genPeriod.fiscal_year}-${String(genPeriod.period_month).padStart(2, '0')}` : 'None',
      approval_status: exp.approval_status,
      posting_state: lifecycle?.effective_posting_state || 'UNKNOWN',
      journal_number: journalNumber,
      classification,
      classification_reason: classificationReason,
      supported_period: supportedPeriod,
      requires_pph_period: isFullyPaid || isPartiallyPaid,
    };
  });

  console.log('\n=== AUDIT SUMMARY BY CLASSIFICATION ===');
  const countByClass = {};
  for (const r of auditedRecords) {
    countByClass[r.classification] = (countByClass[r.classification] || 0) + 1;
  }
  console.table(countByClass);

  console.log('\n=== AUDIT SUMMARY BY PPH CODE ===');
  const countByPph = {};
  for (const r of auditedRecords) {
    const k = `${r.pph_code} (${r.pph_tax_type})`;
    countByPph[k] = (countByPph[k] || 0) + 1;
  }
  console.table(countByPph);

  console.log('\n=== SAMPLE AUDITED RECORDS ===');
  console.table(auditedRecords.slice(0, 10).map(r => ({
    voucher: r.voucher_number,
    date: r.expense_date,
    recipient: r.recipient,
    pph_code: r.pph_code,
    pph: r.pph_amount,
    paid: r.paid_amount,
    pay_status: r.payment_status,
    class: r.classification,
    supported_period: r.supported_period
  })));

  // Write detailed json to brain artifact
  fs.writeFileSync(
    '/Users/Kunal/.gemini/antigravity/brain/ba0a5665-f6f0-4bb7-bcd8-a665594273a2/pph_null_audit_records.json',
    JSON.stringify(auditedRecords, null, 2)
  );
  console.log('Saved detailed json to brain artifact.');
}

runAudit().catch(console.error);

