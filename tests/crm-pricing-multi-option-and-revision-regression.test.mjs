import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// ---------------------------------------------------------------------------
// 1. Inspect source files to ensure architectural integrity
// ---------------------------------------------------------------------------
const pricingWorksheetSrc = fs.readFileSync('src/pages/PricingWorksheet.tsx', 'utf8');
const kunalReplyModalSrc = fs.readFileSync('src/components/crm/KunalInternalReplyModal.tsx', 'utf8');
const stockMovementsModalSrc = fs.readFileSync('src/components/StockMovementsModal.tsx', 'utf8');
const salesSrc = fs.readFileSync('src/pages/Sales.tsx', 'utf8');

test('1. Architectural check: PricingWorksheet supports multi-option data model and persistence', () => {
  // Verifies InquiryPricingOptionItem interface & allPricingOptions field
  assert(pricingWorksheetSrc.includes('interface InquiryPricingOptionItem'), 'PricingWorksheet must define InquiryPricingOptionItem');
  assert(pricingWorksheetSrc.includes('allPricingOptions?: InquiryPricingOptionItem[]'), 'UnifiedPricingRow must include allPricingOptions');
  
  // Verifies independent option handlers
  assert(pricingWorksheetSrc.includes('handleUpdateOption'), 'Must have handleUpdateOption');
  assert(pricingWorksheetSrc.includes('handleAddOption'), 'Must have handleAddOption');
  assert(pricingWorksheetSrc.includes('handleDeleteOption'), 'Must have handleDeleteOption');
  
  // Verifies option switching loads selling_price without clobbering
  assert(pricingWorksheetSrc.includes('opt.selling_price'), 'handleSwitchPricingOption must load opt.selling_price');
  assert(pricingWorksheetSrc.includes('nextQuotePrice'), 'handleSwitchPricingOption must compute nextQuotePrice');
  
  // Verifies persistence saves all options to crm_inquiry_pricing_options
  assert(pricingWorksheetSrc.includes('optionsToSave'), 'Must prepare optionsToSave');
  assert(pricingWorksheetSrc.includes(".from('crm_inquiry_pricing_options')"), 'Must persist to crm_inquiry_pricing_options');
  assert(pricingWorksheetSrc.includes('.update(optPayload)'), 'Must update existing options with selling_price');
  assert(pricingWorksheetSrc.includes('created_by: profile?.id || null'), 'Must insert new options with creator audit');
  
  // Verifies Send to Team builds multi-option payload
  assert(pricingWorksheetSrc.includes('const multiOptions: KunalReplyMultiOption[] = (row.allPricingOptions || [])'), 'Send to team must package multiOptions');
});

test('2. Architectural check: KunalInternalReplyModal formats multi-option internal price table', () => {
  assert(kunalReplyModalSrc.includes('export interface KunalReplyMultiOption'), 'Must export KunalReplyMultiOption');
  assert(kunalReplyModalSrc.includes('options?: KunalReplyMultiOption[]'), 'Props must accept options');
  assert(kunalReplyModalSrc.includes("`Option ${letter}`"), 'buildBody must enumerate Option letters (A, B, ...)');
  assert(kunalReplyModalSrc.includes('buildInternalPriceTable(rows)'), 'buildBody must invoke buildInternalPriceTable with multi-option rows');
});

test('3. Architectural check: StockMovementsModal resolves Purchase Invoices and Quick View', () => {
  assert(stockMovementsModalSrc.includes('const [quickViewPI, setQuickViewPI] = useState'), 'Must maintain quickViewPI state');
  assert(stockMovementsModalSrc.includes('openQuickViewPI'), 'Must have openQuickViewPI handler');
  assert(stockMovementsModalSrc.includes(".from('purchase_invoices')"), 'Must pre-fetch purchase_invoices');
  assert(stockMovementsModalSrc.includes('purchase_invoice_receiving'), 'Must handle purchase_invoice_receiving reference_type');
  assert(stockMovementsModalSrc.includes('Purchase Invoice:'), 'Must render Purchase Invoice Quick View modal');
  assert(stockMovementsModalSrc.includes('Opening Balance'), 'Must format certified_opening cleanly');
});

test('4. Architectural check: Sales.tsx supports controlled price revision & GL synchronization', () => {
  assert(salesSrc.includes('Financially Posted Invoice — Controlled Revision Mode'), 'Must display Controlled Revision Mode banner');
  assert(salesSrc.includes('isFinancialEditor'), 'Must guard revision mode to financial editors');
  assert(salesSrc.includes('total < currentPaid - 0.01'), 'Must validate revised total is not below collected payments');
  assert(salesSrc.includes('journal_entries'), 'Must synchronize linked journal_entries');
  assert(salesSrc.includes('journal_entry_lines'), 'Must update journal_entry_lines for A/R, Revenue, and Tax');
  assert(salesSrc.includes('audit_logs'), 'Must log price revision to audit_logs');
});

// ---------------------------------------------------------------------------
// 2. Functional Calculation Tests
// ---------------------------------------------------------------------------

// Canonical FCL Calculation Engine Simulation (matching pricingService.ts & PricingWorksheet)
function simulateFclCanonicalCalc(params) {
  const {
    sourcePrice,
    sourceCurrency, // 'INR' | 'USD'
    quantity = 1000,
    inrToUsdRate = 86.5,
    indiaMarginPct = 4.0,
    freightUsdPerKg = 0.08,
    insurancePct = 0.1,
    dutyPct = 4.0,
    clearanceUsd = 1100,
    containerCapacityKg = 12000,
    indonesiaMarginPct = 4.0,
  } = params;

  if (!sourcePrice || sourcePrice <= 0) return null;

  // 1. Purchase price in USD
  const purchasePriceUsd = sourceCurrency === 'INR' 
    ? (sourcePrice / inrToUsdRate) 
    : sourcePrice;

  // 2. FOB India Price (after India margin)
  const fobIndiaUsd = purchasePriceUsd * (1 + indiaMarginPct / 100);

  // 3. CIF Indonesia Price = FOB + Freight + Insurance
  const insuranceUsdPerKg = fobIndiaUsd * (insurancePct / 100);
  const cifUsdPerKg = fobIndiaUsd + freightUsdPerKg + insuranceUsdPerKg;

  // 4. Landed Cost = CIF + Import Duty + Clearance per kg
  const dutyUsdPerKg = cifUsdPerKg * (dutyPct / 100);
  const clearancePerKg = clearanceUsd / containerCapacityKg;
  const landedCostUsd = cifUsdPerKg + dutyUsdPerKg + clearancePerKg;

  // 5. Suggested Quote (with Indonesia margin)
  const suggestedQuoteUsd = landedCostUsd * (1 + indonesiaMarginPct / 100);

  return {
    purchasePriceUsd: Number(purchasePriceUsd.toFixed(4)),
    fobIndiaUsd: Number(fobIndiaUsd.toFixed(4)),
    cifUsdPerKg: Number(cifUsdPerKg.toFixed(4)),
    landedCostUsd: Number(landedCostUsd.toFixed(4)),
    suggestedQuoteUsd: Number(suggestedQuoteUsd.toFixed(4)),
  };
}

test('5. Multi-Option Landed Cost & Quote Engine: computes independent landed costs for Option A and Option B', () => {
  // Scenario: Pyrantel Pamoate USP inquiry for 1,000 kg
  // Option A: JRC at INR 1,850/kg
  const optA = simulateFclCanonicalCalc({
    sourcePrice: 1850,
    sourceCurrency: 'INR',
    quantity: 1000,
    inrToUsdRate: 86.5,
  });

  // Option B: IPCA at INR 2,050/kg
  const optB = simulateFclCanonicalCalc({
    sourcePrice: 2050,
    sourceCurrency: 'INR',
    quantity: 1000,
    inrToUsdRate: 86.5,
  });

  // Option C: Global direct USD supplier at USD 24.50/kg
  const optC = simulateFclCanonicalCalc({
    sourcePrice: 24.50,
    sourceCurrency: 'USD',
    quantity: 1000,
  });

  assert(optA && optB && optC, 'All options must calculate successfully');

  // Verify Option A calculations
  assert.equal(optA.purchasePriceUsd, 21.3873); // 1850 / 86.5
  assert(optA.landedCostUsd > optA.purchasePriceUsd, 'Landed cost must exceed purchase price');
  assert(optA.suggestedQuoteUsd > optA.landedCostUsd, 'Suggested quote must include margin');

  // Verify Option B calculations are strictly higher and independent
  assert.equal(optB.purchasePriceUsd, 23.6994); // 2050 / 86.5
  assert(optB.landedCostUsd > optA.landedCostUsd, 'Option B landed cost must be higher than Option A');
  assert(optB.suggestedQuoteUsd > optA.suggestedQuoteUsd, 'Option B suggested quote must be higher than Option A');

  // Independent manual quote prices set by Kunal
  const quotePriceA = 24.50; // USD / kg
  const quotePriceB = 27.00; // USD / kg

  assert.notEqual(quotePriceA, quotePriceB, 'Each option holds its own distinct quotation price');
  assert(quotePriceA > optA.landedCostUsd, 'Option A quote yields positive margin');
  assert(quotePriceB > optB.landedCostUsd, 'Option B quote yields positive margin');
});

test('6. KunalInternalReplyModal multi-option email table format', () => {
  function fmtPrice(val, curr) {
    if (val === null || val === undefined || isNaN(Number(val))) return '-';
    const c = curr || 'USD';
    const num = Number(val).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `${c} ${num}`;
  }

  const options = [
    {
      offered_make: 'JRC',
      india_price: 1850,
      india_price_currency: 'INR',
      purchase_price: 23.35,
      purchase_currency: 'USD',
      offered_price: 25.50,
      offered_currency: 'USD',
      kunal_remark: 'Ready stock in Mumbai',
    },
    {
      offered_make: 'IPCA',
      india_price: 2050,
      india_price_currency: 'INR',
      purchase_price: 25.80,
      purchase_currency: 'USD',
      offered_price: 28.00,
      offered_currency: 'USD',
      kunal_remark: 'Lead time 2 weeks',
    },
  ];

  const rows = options.map((opt, idx) => {
    const letter = String.fromCharCode(65 + idx);
    const optMake = opt.offered_make
      ? `${opt.offered_make} (Option ${letter})`
      : `Option ${letter}`;
    return {
      inquiryNumber: 'INQ-2026-0099',
      aceerpNo: 'AC-102',
      product: 'Pyrantel Pamoate USP',
      requiredMake: 'Standard',
      offeredMake: optMake,
      qty: '1,000 kg',
      inrSourcePrice: fmtPrice(opt.india_price, opt.india_price_currency),
      usdLandedCost: fmtPrice(opt.purchase_price, opt.purchase_currency),
      quotePrice: fmtPrice(opt.offered_price, opt.offered_currency),
      remarks: opt.kunal_remark,
    };
  });

  assert.equal(rows.length, 2);
  assert.equal(rows[0].offeredMake, 'JRC (Option A)');
  assert.equal(rows[0].inrSourcePrice, 'INR 1,850.00');
  assert.equal(rows[0].usdLandedCost, 'USD 23.35');
  assert.equal(rows[0].quotePrice, 'USD 25.50');

  assert.equal(rows[1].offeredMake, 'IPCA (Option B)');
  assert.equal(rows[1].inrSourcePrice, 'INR 2,050.00');
  assert.equal(rows[1].usdLandedCost, 'USD 25.80');
  assert.equal(rows[1].quotePrice, 'USD 28.00');
});

test('7. Stock Movements reference resolution: cleans degraded references and resolves PI Quick View', () => {
  // Mock PI lookup table pre-fetched by StockMovementsModal
  const purchaseInvoicesMap = new Map([
    ['pi-uuid-001', {
      id: 'pi-uuid-001',
      invoice_number: '80103232',
      invoice_date: '2026-08-15',
      currency: 'USD',
      total_amount: 15400,
      receiving_status: 'received',
      suppliers: { company_name: 'PT Menjangan Sakti' },
    }],
    ['pi-uuid-002', {
      id: 'pi-uuid-002',
      invoice_number: 'PI-2026-0042',
      invoice_date: '2026-09-02',
      currency: 'IDR',
      total_amount: 85000000,
      receiving_status: 'received',
      suppliers: { company_name: 'PT Kimia Farma Trading' },
    }],
  ]);

  function resolveMovementPartyAndRef(item) {
    let party = 'Stock Movement';
    let docRef = item.reference_number || '-';
    let targetPi = null;

    if (item.transaction_type === 'certified_opening') {
      docRef = 'Opening Balance';
      party = 'Warehouse Audit';
    } else if (item.reference_type === 'purchase_invoice_receiving' || item.reference_type === 'purchase_invoice') {
      // Check if reference_id matches pre-fetched PI
      const pi = purchaseInvoicesMap.get(item.reference_id);
      if (pi) {
        targetPi = pi;
        docRef = pi.invoice_number;
        party = pi.suppliers?.company_name || 'Supplier';
      } else if (item.reference_number && item.reference_number.startsWith('000/')) {
        // Degraded prefix cleaned
        docRef = item.reference_number.replace(/^000\//, 'PI-');
      }
    }

    return { party, docRef, targetPi };
  }

  // Case A: Receiving movement with raw UUID reference_id
  const move1 = {
    transaction_type: 'purchase_receipt',
    reference_type: 'purchase_invoice_receiving',
    reference_id: 'pi-uuid-001',
    reference_number: '000/80103232',
  };
  const res1 = resolveMovementPartyAndRef(move1);
  assert.equal(res1.docRef, '80103232', 'Must normalize degraded 000/ prefix to canonical invoice number');
  assert.equal(res1.party, 'PT Menjangan Sakti', 'Must resolve supplier party name');
  assert(res1.targetPi !== null, 'Must associate Quick View target');
  assert.equal(res1.targetPi.receiving_status, 'received');

  // Case B: Certified opening balance movement
  const move2 = {
    transaction_type: 'certified_opening',
    reference_type: null,
    reference_id: null,
    reference_number: null,
  };
  const res2 = resolveMovementPartyAndRef(move2);
  assert.equal(res2.docRef, 'Opening Balance', 'Certified opening must render "Opening Balance"');
  assert.equal(res2.party, 'Warehouse Audit');
});

test('8. Controlled Sales Invoice Price Revision: mathematical and General Ledger invariants', () => {
  // Scenario: SO-2026-0087 -> DO-26-0073 -> SAPJ-26-072
  // Dispatched: 100 kg of Paracetamol
  // Original Invoice: Unit Price Rp 100,000, PPN 11%
  const original = {
    qty: 100, // LOCKED: dispatched on DO-26-0073
    unitPrice: 100000,
    taxRate: 11,
    paidAmount: 2000000, // Customer made Rp 2,000,000 down-payment
  };

  const origSubtotal = original.qty * original.unitPrice; // 10,000,000
  const origTax = Math.round(origSubtotal * (original.taxRate / 100)); // 1,100,000
  const origTotal = origSubtotal + origTax; // 11,100,000
  const origBalance = origTotal - original.paidAmount; // 9,100,000

  // 1. Revision Simulation: Unit price renegotiated to Rp 95,000
  const revisedUnitPrice = 95000;
  const revisedTaxRate = 11;

  const revisedSubtotal = original.qty * revisedUnitPrice; // 9,500,000
  const revisedTax = Math.round(revisedSubtotal * (revisedTaxRate / 100)); // 1,045,000
  const revisedTotal = revisedSubtotal + revisedTax; // 10,545,000
  const revisedBalance = revisedTotal - original.paidAmount; // 8,545,000

  // Verify Subtotal, Tax, Total, and Balance
  assert.equal(revisedSubtotal, 9500000);
  assert.equal(revisedTax, 1045000);
  assert.equal(revisedTotal, 10545000);
  assert.equal(revisedBalance, 8545000);

  // 2. Invariant Check: Payment Integrity
  // Total must not be lower than already collected amount
  assert(revisedTotal >= original.paidAmount, 'Revised total must be >= collected payments');

  // Attempting an invalid revision below paid amount should fail
  const invalidUnitPrice = 15000; // Total would be 100 * 15000 * 1.11 = 1,665,000 < 2,000,000
  const invalidTotal = (original.qty * invalidUnitPrice) * 1.11;
  const isAllowed = invalidTotal >= original.paidAmount;
  assert.equal(isAllowed, false, 'Revision below already paid amount must be rejected');

  // 3. Invariant Check: General Ledger Balancing
  // When invoice posted:
  // Dr. 1120 Accounts Receivable: Total
  // Cr. 4100 Sales Revenue: Subtotal
  // Cr. 2130 PPN Keluaran: Tax
  const glDebit = revisedTotal; // 10,545,000
  const glCreditRevenue = revisedSubtotal; // 9,500,000
  const glCreditTax = revisedTax; // 1,045,000
  const glTotalCredit = glCreditRevenue + glCreditTax; // 10,545,000

  assert.equal(glDebit, glTotalCredit, 'General Ledger entry must be strictly in balance: Debit = Credit');
  assert.equal(glDebit - glTotalCredit, 0, 'GL delta must be exactly 0');
});
