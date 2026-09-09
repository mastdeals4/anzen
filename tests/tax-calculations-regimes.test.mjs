import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculatePPh21NonEmployeeCumulative,
  calculatePPh21CasualLabor,
  calculatePPhFinal4_2,
  computeExpensePPh,
} from '../src/utils/taxCalculations.ts';

test('1. Bukan Pegawai / Tenaga Ahli: DPP = 50% of gross and Article 17 marginal calculation', () => {
  // Scenario A: First transaction of the year, gross Rp 10,000,000, cumulative DPP = 0
  // DPP = 50% * 10M = 5M
  // Bracket 1 (0 - 60M) @ 5% -> PPh = 5M * 5% = 250,000
  // Effective rate on gross = 2.50%
  const res1 = calculatePPh21NonEmployeeCumulative(10_000_000, 0);
  assert.equal(res1.dppRatio, 0.5);
  assert.equal(res1.dppAmount, 5_000_000);
  assert.equal(res1.pphAmount, 250_000);
  assert.equal(res1.effectiveRateOnGross, 2.5);
  assert.equal(res1.newCumulativeDpp, 5_000_000);

  // Scenario B: Large transaction, gross Rp 100,000,000, cumulative DPP = 0
  // DPP = 50M (still within 0 - 60M bracket)
  // PPh = 50M * 5% = 2,500,000
  const res2 = calculatePPh21NonEmployeeCumulative(100_000_000, 0);
  assert.equal(res2.dppAmount, 50_000_000);
  assert.equal(res2.pphAmount, 2_500_000);
  assert.equal(res2.effectiveRateOnGross, 2.5);
  assert.equal(res2.newCumulativeDpp, 50_000_000);
});

test('2. Bukan Pegawai: Correct marginal calculation when crossing an Article 17 bracket boundary', () => {
  // Scenario: Prior cumulative DPP = 50,000,000
  // Gross = 40,000,000 -> Current DPP = 20,000,000
  // Total cumulative DPP after this payment = 70,000,000
  // Bracket 1 (up to 60M): remaining capacity is 60M - 50M = 10,000,000 @ 5% = 500,000
  // Bracket 2 (60M to 250M): excess is 70M - 60M = 10,000,000 @ 15% = 1,500,000
  // Total PPh = 500,000 + 1,500,000 = 2,000,000
  // Effective rate on gross = 2,000,000 / 40,000,000 = 5.00%
  const res = calculatePPh21NonEmployeeCumulative(40_000_000, 50_000_000);
  assert.equal(res.dppAmount, 20_000_000);
  assert.equal(res.pphAmount, 2_000_000);
  assert.equal(res.effectiveRateOnGross, 5.0);
  assert.equal(res.newCumulativeDpp, 70_000_000);
});

test('3. Pegawai Tidak Tetap / Harian Lepas: Daily threshold logic under PP 58/2023 & PMK 168/2023', () => {
  // Scenario A: Daily wage <= Rp 450.000 -> 0% tax
  // Gross = Rp 400.000 for 1 day
  const resA = calculatePPh21CasualLabor(400_000, 1);
  assert.equal(resA.pphAmount, 0);
  assert.equal(resA.effectiveRateOnGross, 0);
  assert.equal(resA.dailyWage, 400_000);

  // Scenario B: Gross = Rp 1.200.000 for 3 days -> Rp 400.000/day -> 0% tax
  const resB = calculatePPh21CasualLabor(1_200_000, 3);
  assert.equal(resB.pphAmount, 0);
  assert.equal(resB.effectiveRateOnGross, 0);
  assert.equal(resB.dailyWage, 400_000);

  // Scenario C: Daily wage > Rp 450.000 and <= Rp 2.500.000 -> 0.5% TER Harian
  // Gross = Rp 1.000.000 for 1 day -> daily wage = 1M
  // PPh = 1.000.000 * 0.5% = Rp 5.000
  const resC = calculatePPh21CasualLabor(1_000_000, 1);
  assert.equal(resC.pphAmount, 5_000);
  assert.equal(resC.effectiveRateOnGross, 0.5);
  assert.equal(resC.dailyWage, 1_000_000);

  // Scenario D: Gross = Rp 3.000.000 for 3 days -> daily wage = 1M -> 0.5% TER Harian
  // PPh = 3.000.000 * 0.5% = Rp 15.000
  const resD = calculatePPh21CasualLabor(3_000_000, 3);
  assert.equal(resD.pphAmount, 15_000);
  assert.equal(resD.effectiveRateOnGross, 0.5);
});

test('4. PPh Final Pasal 4 Ayat (2): Land / Building rental is 10% on Gross', () => {
  // Rental gross = Rp 25,000,000
  // DPP = 100% (25M)
  // PPh = 10% = Rp 2,500,000
  const res = calculatePPhFinal4_2(25_000_000);
  assert.equal(res.dppRatio, 1.0);
  assert.equal(res.dppAmount, 25_000_000);
  assert.equal(res.pphAmount, 2_500_000);
  assert.equal(res.effectiveRateOnGross, 10.0);
});

test('5. computeExpensePPh dispatcher resolves regimes authoritatively', () => {
  // PPH21-NE
  const resNE = computeExpensePPh({
    grossAmount: 20_000_000,
    taxCode: { code: 'PPH21-NE', tax_type: 'PPh21', rate: 0 },
    payeeClassification: 'bukan_pegawai_komisi',
  });
  assert.equal(resNE.regime, 'pasal17_dpp50');
  assert.equal(resNE.dppAmount, 10_000_000);
  assert.equal(resNE.pphAmount, 500_000);
  assert.equal(resNE.pphRate, 2.5);

  // PPH21-TT
  const resTT = computeExpensePPh({
    grossAmount: 1_500_000,
    taxCode: { code: 'PPH21-TT', tax_type: 'PPh21', rate: 0 },
    payeeClassification: 'pegawai_tidak_tetap',
    workingDays: 2, // 750k/day -> 0.5%
  });
  assert.equal(resTT.regime, 'ter_harian_lepas');
  assert.equal(resTT.pphAmount, 7_500);

  // PPH4(2)
  const resFinal = computeExpensePPh({
    grossAmount: 50_000_000,
    taxCode: { code: 'PPH4(2)', tax_type: 'PPh4(2)', rate: 10 },
  });
  assert.equal(resFinal.regime, 'pph_final_4_2');
  assert.equal(resFinal.pphAmount, 5_000_000);

  // Standard PPh 23 Services 2%
  const res23 = computeExpensePPh({
    grossAmount: 10_000_000,
    taxCode: { code: 'PPH23-2', tax_type: 'PPh23', rate: 2 },
  });
  assert.equal(res23.regime, 'standard_fixed');
  assert.equal(res23.pphAmount, 200_000);
});
