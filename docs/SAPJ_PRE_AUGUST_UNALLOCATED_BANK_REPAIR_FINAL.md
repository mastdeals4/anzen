# SAPJ Pre-August Unallocated Bank Repair (Final)

Scope: live database `dkrtsqienlhpouohmfki`, bank accounts mapped to **111101 (BCA IDR)** and **111102 (BCA USD)**, statement dates **2025-01-01 through 2026-07-31**. August 2026 bank lines were not selected and were not written.

The 20-Feb-2026 Rp3,651,500 line `c4c4033b-f661-4574-8878-dc593ee4eb33` was **not** in the unallocated set and was **not** modified. Canonical allocations remain EXP/26/101 Rp3,161,000 + EXP/26/174 Rp490,500.

No journals were created, reversed, or rewritten. No expense/payment/receipt/tax amounts were changed. Repairs used `execute_historical_finance_repair(..., 'allocate_existing_cash_event')` only.

## Classification of all 94 (re-read live, then re-run after repair)

| Category | Count | After repair still unallocated |
|---|---:|---:|
| A. Safe allocation repair | 70 | 0 |
| B. Source exists, journal missing | 0 | 0 |
| C. Legitimate non-payment (unrepaired) | 1 | 1 |
| D. Duplicate/overlapping import | 0 | 0 |
| E. Ambiguous / amount does not match journal bank GL | 23 | 23 |
| **Total** | **94** | **24** |

Every one of the 94 already had a posted, balanced `matched_entry_id` journal. None were category B. Apparent same-day/same-amount siblings were different counterparties or different billing codes, not duplicate cash events.

### A — 70 allocation-only repairs

Rule set: identified bank line + identified source + posted balanced journal containing the bank COA + bank amount = journal bank-GL movement (direction-correct) + matching IDR currency + no existing canonical allocation on the line or journal.

| Type | n |
|---|---:|
| expense | 61 |
| receipt | 5 |
| fund_transfer | 2 |
| journal (IDR capital contribution) | 2 |

Known examples re-read live and repaired:

| Voucher | Bank | Journal | Paid (unchanged) |
|---|---:|---|---:|
| EXP/25/304 | 3,000,000 | JE2512-0144 | 3,000,000 |
| EXP/26/031 | 1,587,859 | JE2601-0203 | 1,587,859 |
| EXP/26/067 | 411,450 | JE2602-0198 | 411,450 |
| EXP/26/119 | 6,860,000 | JE2602-0199 | 6,860,000 |
| EXP/26-26/118 | 7,000,000 | JE2607-0111 | 7,000,000 |

Full A list (date, source, bank amount, journal):

- 2025-01-14 CC2501-0001 7,000,000 JE2608-0052
- 2025-04-30 CC2504-0002 12,800,000 JE2608-0053
- 2025-06-18 EXP/25/055 369,300 JE2506-0001
- 2025-07-18 EXP/25/074 375,102 JE2507-0001
- 2025-08-19 EXP/25/089 177,040 JE2508-0002
- 2025-09-18 EXP/25/116 170,811 JE2509-0027
- 2025-09-18 EXP/25/112 369,300 JE2509-0028
- 2025-12-30 EXP/25/304 3,000,000 JE2512-0144
- 2026-01-14 EXP/26/014 76,141,281 JE2601-0197
- 2026-01-20 EXP/26/029 673,928 JE2601-0201
- 2026-01-21 EXP/26/031 1,587,859 JE2601-0203
- 2026-01-22 EXP/26/032 782,100 JE2601-0200
- 2026-02-03 EXP/26/067 411,450 JE2602-0198
- 2026-02-10 EXP/26/073 1,001,750 JE2602-0194
- 2026-02-12 EXP/26/077 337,662,872 JE2602-0182
- 2026-02-18 EXP/26/091 500,000 JE2602-0195
- 2026-02-20 EXP/26/099 2,244,793 JE2602-0192
- 2026-02-27 EXP/26/119 6,860,000 JE2602-0199
- 2026-03-05 EXP/26/128 1,001,750 JE2603-0081
- 2026-03-17 EXP/26/142 1,688,143 JE2603-0082
- 2026-03-17 EXP/26/137 500,000 JE2603-0083
- 2026-03-31 EXP/26/146 1,001,750 JE2603-0080
- 2026-04-09 EXP/26-26/038 22,678,585 JE2604-0084
- 2026-04-20 EXP/26/166 1,001,750 JE2604-0089
- 2026-04-21 EXP/26/170 1,675,593 JE2604-0090
- 2026-04-27 RV2606-0004 125,664,210 JE2607-0058
- 2026-04-30 EXP/26-26/008 6,860,000 JE2604-0083
- 2026-04-30 EXP/26-26/003 1,001,750 JE2604-0093
- 2026-05-20 EXP/26-26/026 1,001,750 JE2605-0063
- 2026-05-21 EXP/26-26/027 1,700,693 JE2605-0059
- 2026-05-28 RV2606-0005 123,918,873.75 JE2607-0059
- 2026-06-01 EXP/26-26/074 30,000 JE2606-0106
- 2026-06-10 FT2608-0003 10,000,000 JE2608-0063
- 2026-06-12 EXP/26-26/048 150,998,580 JE2606-0114
- 2026-06-18 EXP/26-26/051 1,001,750 JE2606-0115
- 2026-06-19 EXP/26-26/058 1,713,243 JE2606-0118
- 2026-06-25 EXP/26-26/061 through /064 50,000 each (distinct state billing codes) JE2606-0111/0110/0109/0108
- 2026-06-26 EXP/26-26/065 50,000 JE2606-0107
- 2026-07-02 EXP/26-26/087 1,835,000 JE2607-0025
- 2026-07-02 EXP/26-26/086 500,000 JE2607-0106
- 2026-07-05 EXP/26-26/092 385,000 JE2607-0070
- 2026-07-06 EXP/26-26/093 500,000 JE2607-0069
- 2026-07-06 EXP/26-26/094 1,001,750 JE2607-0101
- 2026-07-07 EXP/26-26/097 350,000 JE2607-0065
- 2026-07-07 EXP/26-26/096 930,000 JE2607-0066
- 2026-07-07 EXP/26-26/095 291,985 JE2607-0067
- 2026-07-08 EXP/26-26/098 120,000 JE2607-0071
- 2026-07-10 EXP/26-26/099 455,000 JE2607-0077
- 2026-07-17 EXP/26-26/100 600,000 JE2607-0076
- 2026-07-17 EXP/26-26/102 150,000 JE2607-0092
- 2026-07-20 RV2607-0004 485,913,600 JE2607-0038
- 2026-07-20 EXP/26-26/107 2,500 JE2607-0075
- 2026-07-20 EXP/26-26/110 500,000 JE2607-0090
- 2026-07-20 EXP/26-26/108 1,725,793 JE2607-0102
- 2026-07-20 EXP/26-26/106 500,000 JE2607-0107
- 2026-07-20 FT2608-0004 10,000,000 JE2608-0064
- 2026-07-23 RV2607-0007 26,004,500 JE2607-0037
- 2026-07-24 EXP/26-26/111 300,000 JE2607-0073
- 2026-07-29 EXP/26-26/112 590,000 JE2607-0072
- 2026-07-30 EXP/26-26/114 590,000 JE2607-0061
- 2026-07-31 EXP/26-26/123 310,000 JE2607-0082
- 2026-07-31 EXP/26-26/122 1,850,000 JE2607-0083
- 2026-07-31 EXP/26-26/120 2,000,000 JE2607-0084
- 2026-07-31 EXP/26-26/119 3,000,000 JE2607-0085
- 2026-07-31 EXP/26-26/117 3,800,000 JE2607-0086
- 2026-07-31 EXP/26-26/118 7,000,000 JE2607-0111
- 2026-07-31 RV2607-0008 49,215,412 JE2608-0009

Idempotency keys: `pre-aug-alloc:<bank_statement_line_id>` (70 commands).

### C — unrepaired (1)

`5edf43b4-976a-4537-b97d-58ccec4e3e78` 2025-01-16 USD **1,000** banknote deposit on 111102 / CC2501-0002 / JE2608-0109. Journal posts **Rp16,500,000** to 111102 at rate 16,500. USD bank movement does not equal the 111102 line. FX was not invented. Left untouched.

### E — unrepaired (23)

Journal exists and is posted, but **bank amount ≠ journal 111101 movement**. Allocating the full bank amount would violate the cash-identity rule. No fee/salary balancing journal was created.

**Telkom / internet (21):** bank = journal cash + Rp3,000 `bank_charges_amount`. Journal credits 111101 for the bill only. Example: EXP/26/023 bank 402,600 vs JE2601-0198 credit 399,600.

| Date | Line | Voucher | Bank | Journal 111101 credit |
|---|---|---|---:|---:|
| 2026-01-15 | 5625cada… | EXP/26/023 | 402,600 | 399,600 |
| 2026-01-15 | 915fd7b8… | EXP/26/025 | 153,496 | 150,496 |
| 2026-01-15 | 02a6a169… | EXP/26/024 | 186,525 | 183,525 |
| 2026-02-19 | 6df31b67… | EXP/26/098 | 402,600 | 399,600 |
| 2026-02-19 | f55c58e1… | EXP/26/096 | 74,032 | 71,032 |
| 2026-02-19 | 6724b027… | EXP/26/097 | 108,800 | 105,800 |
| 2026-03-17 | 1fb4dc27… | EXP/26/141 | 83,145 | 80,145 |
| 2026-03-17 | c9489d9e… | EXP/26/139 | 402,600 | 399,600 |
| 2026-03-17 | d1493674… | EXP/26/140 | 100,403 | 97,403 |
| 2026-04-21 | df8e9db6… | EXP/26/169 | 95,605 | 92,605 |
| 2026-04-21 | 231f24a3… | EXP/26/168 | 423,407 | 420,407 |
| 2026-04-21 | 358c8155… | EXP/26/167 | 78,316 | 75,316 |
| 2026-05-19 | 7adc61b0… | EXP/26-26/021 | 259,386 | 256,386 |
| 2026-05-19 | 718d4391… | EXP/26-26/022 | 88,083 | 85,083 |
| 2026-05-19 | ad395042… | EXP/26-26/020 | 408,150 | 405,150 |
| 2026-06-19 | 73b3be25… | EXP/26-26/055 | 108,211 | 105,211 |
| 2026-06-19 | fc9a570e… | EXP/26-26/056 | 408,150 | 405,150 |
| 2026-06-19 | 8b1951e3… | EXP/26-26/057 | 80,565 | 77,565 |
| 2026-07-20 | 67e29098… | EXP/26-26/104 | 120,077 | 117,077 |
| 2026-07-20 | 4cda4ecd… | EXP/26-26/103 | 408,150 | 405,150 |
| 2026-07-20 | 721f4ae2… | EXP/26-26/105 | 118,128 | 115,128 |

**Other (2):**

| Date | Line | Voucher | Bank | Journal 111101 | Why not A |
|---|---|---|---:|---:|---|
| 2026-05-29 | 910ff6f8… | EXP/26-26/034 | 6,820,000 | 6,860,000 | Cash payable 7,000,000 − PPh 140,000 = 6,860,000; bank is 6,820,000 |
| 2026-07-31 | 27602c89… | EXP/26-26/124 | 2,000,000 | 2,500,000 | Salary journal 2,500,000 vs bank 2,000,000 |

## Verification of repaired allocations

- 70/70: allocation amount = bank line amount (ε 0.01).
- 70/70: allocation amount = journal movement on the bank COA (debit lines → credit 111101; credit lines → debit 111101).
- No second allocation was added to any of those journals.
- Journal `total_debit` / `total_credit` / line count unchanged (RPC rejects unexpected journal change).
- Known example `paid_amount` / `settlement_amount` unchanged.
- Feb-20 split unchanged (3,161,000 + 490,500).

## IDR 111101 bank ↔ GL (2025-01-01 .. 2026-07-31)

| | Amount |
|---|---:|
| Statement net (credits − debits), 638 lines (615 allocated) | 450,377,759.44 |
| Posted GL net (debits − credits) on 111101 | 455,444,658.94 |
| Bank net − GL net | **−5,066,899.50** |

This difference was **not** plugged. It is not a residual of the 70 repairs (those identities hold line-by-line). It remains because:

1. The uploaded statement population is not a single unique cash book (overlapping imports still exist on allocated lines).
2. The 23 leftover IDR lines have journals whose 111101 cash is not equal to the bank amount (net of those 23: statement −13,330,429 vs their journals −13,807,429, gap 477,000 = salary 500,000 extra GL + consulting 40,000 extra GL − 21 × 3,000 bank charges on Telkom).
3. Other posted 111101 activity can exist without a 1:1 statement line in this corpus.

## USD 111102 bank ↔ GL (same period)

| | Amount |
|---|---:|
| Statement net, 61 lines (60 allocated) | 5,454.00 (USD statement units) |
| Posted GL net on 111102 | 656,781,819.00 |
| Bank net − GL net | **−656,776,365.00** |

111102 still holds **IDR-sized functional postings**. The remaining unmatched USD 1,000 deposit is journalled as Rp16,500,000. No FX was invented and no currency correction was posted.

## August

No August bank statement lines were in the 94. No August allocations, journals, expenses, payments, or tax rows were written by this repair. Pre-August events that already had JE2608/FT2608 numbers (created earlier) received allocation rows only when the pre-August bank amount already matched that journal’s bank GL.

## Mechanism

Live RPC had been reduced to Phase 5G AP reclassification only. `allocate_existing_cash_event` was restored (journals immutable; historical-repair context skips payment/tax trigger mutation). Constraint allows `journal` document type for capital contribution links.

## Application

Bank Reconciliation UI allocation-status fix was left in place. Canonical truth remains `bank_statement_allocations`.

## Validation

- `npm run typecheck` pass
- `npm run build` pass
- `npm run lint -- --quiet` pass
- `git diff --check` pass

## Git commit

`398cb4196409d05e89e575611741aad4c93d12ba`
