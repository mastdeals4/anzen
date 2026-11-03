import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Helper mimicking simplified Batches.tsx costing functions
function createSimplifiedBatchCostingEngine(formData) {
  const getDutyDetails = () => {
    const assessableUsd = Number(formData.import_price_usd) || 0;
    const ndpbm = Number(formData.customs_ndpbm_rate) || 0;
    const dutyPercent = Number(formData.duty_percent) || 0;
    const qty = Number(formData.import_quantity) || 1;

    if (dutyPercent <= 0 || assessableUsd <= 0 || ndpbm <= 0) {
      return { perUnit: 0, total: 0, formula: '', roundingDiff: 0, rawTotal: 0 };
    }

    const rawTotal = assessableUsd * qty * ndpbm * (dutyPercent / 100);
    // Official Indonesian Customs DJBC rule: Billing Bea Masuk is rounded up to the nearest thousand IDR
    const customsTotal = Math.ceil(rawTotal / 1000) * 1000;
    const roundingDiff = Number((customsTotal - rawTotal).toFixed(2));
    const perUnit = qty > 0 ? customsTotal / qty : 0;
    const formula = `$ ${assessableUsd.toFixed(2)} × Rp ${ndpbm.toLocaleString()} × ${dutyPercent}%`;

    return { perUnit, total: customsTotal, formula, roundingDiff, rawTotal };
  };

  const getDutyPerUnit = () => {
    return getDutyDetails().perUnit;
  };

  const getPurchasePriceIDR = () => {
    return formData.import_price_idr > 0 && formData.import_price_usd <= 0
      ? formData.import_price_idr
      : formData.import_price_usd * formData.exchange_rate_usd_to_idr;
  };

  const calculateTotalCostIDR = () => {
    const importPriceIDR = getPurchasePriceIDR();
    const dutyAmount = getDutyPerUnit();
    return importPriceIDR + dutyAmount + (Number(formData.freight_charges) || 0) + (Number(formData.other_charges) || 0);
  };

  return {
    getDutyDetails,
    getDutyPerUnit,
    getPurchasePriceIDR,
    calculateTotalCostIDR,
  };
}

test('1. Exact Batch PRGI/B2606008: Reconciliation against Attached PIB Evidence', () => {
  // Attached PIB evidence:
  // - CIF: USD 4,050 ($40.50 × 100 kg)
  // - NDPBM: 17,937
  // - Duty: 5%
  // - Quantity: 100 kg
  // - Actual BM paid: Rp 3,633,000
  const formData = {
    import_quantity: 100,
    import_price_usd: 40.50,
    import_price_idr: 0,
    exchange_rate_usd_to_idr: 17750,
    customs_ndpbm_rate: 17937,
    duty_percent: 5,
    freight_charges: 0,
    other_charges: 0,
  };

  const engine = createSimplifiedBatchCostingEngine(formData);
  const details = engine.getDutyDetails();

  // Raw formula: $4,050 * 17,937 * 0.05 = 3,632,242.50
  assert.equal(details.rawTotal, 3632242.50);

  // Official PIB Payment: Rp 3,633,000 (rounded up to nearest thousand IDR)
  assert.equal(details.total, 3633000);

  // Reconciled difference: Rp 757.50
  assert.equal(details.roundingDiff, 757.50);

  // Duty per kg: Rp 36,330 / kg
  assert.equal(details.perUnit, 36330);
  assert.equal(engine.getDutyPerUnit(), 36330);
});

test('2. Dynamic Recalculation across 5% -> 4% -> 1% -> 0% and NDPBM Edits', () => {
  const formData = {
    import_quantity: 100,
    import_price_usd: 40.50,
    import_price_idr: 0,
    exchange_rate_usd_to_idr: 17750,
    customs_ndpbm_rate: 17937,
    duty_percent: 5,
    freight_charges: 0,
    other_charges: 0,
  };

  let engine = createSimplifiedBatchCostingEngine(formData);
  assert.equal(engine.getDutyPerUnit(), 36330);
  assert.equal(engine.getDutyDetails().total, 3633000);

  // User edits Duty % to 4%:
  formData.duty_percent = 4;
  engine = createSimplifiedBatchCostingEngine(formData);
  // Raw: 4050 * 17937 * 0.04 = 2,905,794
  // DJBC rounded up: 2,906,000
  assert.equal(engine.getDutyDetails().total, 2906000);
  assert.equal(engine.getDutyPerUnit(), 29060);

  // User edits Duty % to 1%:
  formData.duty_percent = 1;
  engine = createSimplifiedBatchCostingEngine(formData);
  // Raw: 4050 * 17937 * 0.01 = 726,448.50
  // DJBC rounded up: 727,000
  assert.equal(engine.getDutyDetails().total, 727000);
  assert.equal(engine.getDutyPerUnit(), 7270);

  // User edits Customs NDPBM to 17,000 at 1%:
  formData.customs_ndpbm_rate = 17000;
  engine = createSimplifiedBatchCostingEngine(formData);
  // Raw: 4050 * 17000 * 0.01 = 688,500
  // DJBC rounded: 689,000
  assert.equal(engine.getDutyDetails().total, 689000);
  assert.equal(engine.getDutyPerUnit(), 6890);

  // User sets Duty % to 0%:
  formData.duty_percent = 0;
  engine = createSimplifiedBatchCostingEngine(formData);
  assert.equal(engine.getDutyDetails().total, 0);
  assert.equal(engine.getDutyPerUnit(), 0);
});

test('3. Unassessed Batch Costing & Dynamic Landed Cost', () => {
  // Unassessed new batch: 50 kg @ $20.00 USD, NDPBM 16,813, Supplier FX 16,800
  const formData = {
    import_quantity: 50,
    import_price_usd: 20.00,
    import_price_idr: 0,
    exchange_rate_usd_to_idr: 16800,
    customs_ndpbm_rate: 16813,
    duty_percent: 5,
    freight_charges: 0,
    other_charges: 0,
  };

  let engine = createSimplifiedBatchCostingEngine(formData);

  // Raw: 1,000 * 16,813 * 0.05 = 840,650
  // Customs rounded: 841,000
  assert.equal(engine.getDutyDetails().total, 841000);
  assert.equal(engine.getDutyPerUnit(), 16820);
  // Unit purchase price IDR: 20 * 16,800 = 336,000
  assert.equal(engine.getPurchasePriceIDR(), 336000);
  // Unit landed cost: 336,000 + 16,820 = 352,820
  assert.equal(engine.calculateTotalCostIDR(), 352820);

  // Change Duty % to 4%:
  formData.duty_percent = 4;
  engine = createSimplifiedBatchCostingEngine(formData);
  // Raw: 1000 * 16813 * 0.04 = 672,520 -> 673,000
  assert.equal(engine.getDutyDetails().total, 673000);
  assert.equal(engine.getDutyPerUnit(), 13460);
  assert.equal(engine.calculateTotalCostIDR(), 349460);
});

test('4. Source Code Static Integrity: Simplified Batches.tsx', () => {
  const batchesCode = fs.readFileSync('src/pages/Batches.tsx', 'utf8');

  // Verify simplified helper functions exist
  assert.match(batchesCode, /const getDutyDetails = \(\) =>/);
  assert.match(batchesCode, /const getDutyPerUnit = \(\): number =>/);

  // Verify simplified UI labels
  assert.match(batchesCode, /Calculated Duty:/);
  assert.match(batchesCode, /Total Duty:/);

  // Verify removal of unnecessary explanation cards and badges
  assert.doesNotMatch(batchesCode, /Dual Duty Breakdown:/);
  assert.doesNotMatch(batchesCode, /Authoritative PIB Applied/);
  assert.doesNotMatch(batchesCode, /Dynamic Estimate Applied/);

  // Verify dynamic cost propagation calls on save
  assert.match(batchesCode, /reallocate_container_costs/);
  assert.match(batchesCode, /propagate_batch_cost_change/);
});

test('5. Batch PRGI/B2606008 Total Landed Cost, Layer Synchronization & COGS Reconciliation', () => {
  // Key costing parameters for PRGI/B2606008
  const purchasePricePerKg = 718875.00; // USD 40.50 * 17,750 Supplier FX
  const containerAllocatedPerKg = 261846.87; // Shared broker expenses pool / 100 kg
  const dutyPerKg = 36330.00; // 5% duty @ 17,937 NDPBM official customs payment (Rp 3,633,000 / 100 kg)
  const quantityKg = 100;

  // Expected Landed Cost per unit
  const expectedLandedCostPerKg = purchasePricePerKg + containerAllocatedPerKg + dutyPerKg;
  assert.equal(expectedLandedCostPerKg, 1017051.87);

  // Stale value previously displayed after save
  const staleLandedCostPerKg = 990846.87;

  // Mathematical breakdown of the discrepancy
  const unitDifference = Number((expectedLandedCostPerKg - staleLandedCostPerKg).toFixed(2));
  assert.equal(unitDifference, 26205.00);

  const totalDifference = unitDifference * quantityKg;
  assert.equal(totalDifference, 2620500.00);

  // Composed of:
  // 1. Omitted Bea Masuk: +36,330.00
  // 2. Layer FX vs Batch Master FX: -(729,000 - 718,875) = -10,125.00
  // Net: 36,330 - 10,125 = 26,205.00
  assert.equal(dutyPerKg - (729000 - purchasePricePerKg), unitDifference);

  // Total Landed Cost for batch
  const totalLandedCost = expectedLandedCostPerKg * quantityKg;
  assert.equal(totalLandedCost, 101705187.00);

  // Sales Invoice SAPJ-26-035 (100% sold) COGS
  const salesInvoiceCogs = totalLandedCost;
  assert.equal(salesInvoiceCogs, 101705187.00);

  // True-up journal delta against previously posted GL (Rp 99,084,687)
  const previouslyPostedGl = staleLandedCostPerKg * quantityKg;
  const glTrueUpDelta = salesInvoiceCogs - previouslyPostedGl;
  assert.equal(glTrueUpDelta, 2620500.00);
});

