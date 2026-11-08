# ANZEN ERP — MASTER WHATSAPP CRM & CAMPAIGNS FINAL AUDIT & DIRECTORY RECONCILIATION REPORT

**Audit Date:** 07 November 2026  
**Repository:** PT Shubham Anzen Pharma Jaya ERP (`anzen-main`)  
**Target Environment:** Local Workspace / Supabase Production Database (`dkrtsqienlhpouohmfki`)  
**Audit Lead:** Lead ERP Engineer, CRM Architect & Data Integrity Auditor  
**Verification Status:** **100% RECONCILED & SECURED** (Production Parser Canonical Execution, Strict Trusted-Region Invariants, Exact Occurrence Preservation, Credential Security)

---

## SECTION A — EXECUTIVE SUMMARY & ACCEPTANCE DECISION

### 1. Acceptance Verdict
**STATUS: FORMALLY ACCEPTED FOR STAGED COMMISSIONING (BULK DISPATCH GATED)**

The Smart WhatsApp CRM, Omnichannel Inbox, Campaign Workspace, and Directory Classification subsystems have undergone final forensic reconciliation.

All 518 extracted phone records and all 578 preserved field occurrences have been evaluated through the **actual production `classifyCanonicalPhone()` function** driven by Google's `libphonenumber-js/max` metadata.

### 2. Core Security & Provenance Invariants Enforced
1. **Database Credential Security:** All literal database credentials and passwords have been removed from source scripts. The reconciliation script strictly requires the `SUPABASE_DB_URL` environment variable and terminates safely with exit code 1 when missing. No credentials are logged or printed.
2. **Strict Trusted-Region Provenance:** Regional jurisdiction is derived solely from an explicitly verified `c.country` field. `Boolean(c.city)` has been completely removed; city presence alone never establishes a country. When country is unverified or null, `trustedRegion` is set to `null` and national-format numbers are classified as `needs_review`.
3. **Preservation of Every Phone Occurrence:** All 578 raw field occurrences across `phone` and `mobile` fields are preserved with contact ID, company ID, contact person, source field, raw input, regional provenance, and canonical classification.
4. **Duplicate Identity by Stable Entity ID:** Same-company vs cross-company duplicates are determined strictly by stable CRM entity IDs (`c.id`), never by superficial company name strings.
5. **Segregation of Unparseable Values:** Local 7-digit numbers lacking trunk/area codes (e.g. `4603543`) are segregated into manual review and excluded from canonical E.164 duplicate totals.
6. **Zero-Consent Campaign Gate:** Candidate mobile records are strictly separated from campaign-eligible recipients. Because individual opt-in consent records on file are 0, campaign-eligible recipients remain **STRICTLY ZERO**.
7. **Production Data Preservation:** Confirmed that historical incorrect database records (e.g. `CV BIANGLALA BANDUNG` stored as US `+1` in `crm_contact_phones`) remain 100% untouched in PostgreSQL.

---

## SECTION B — ACTIVE CONTACTS & TRUSTED REGION PROVENANCE AUDIT

Evaluated across all active customer accounts in `crm_contacts` (`is_active = true`):

### 1. Contact Phone Availability Distribution (468 Active Contacts)

| Field Status | Contact Count | Description |
|---|:---:|---|
| **Contacts with Mobile Only** | **16** | Contacts having a valid non-empty `mobile` field and empty `phone` |
| **Contacts with Landline/Phone Only**| **332** | Contacts having a valid non-empty `phone` field and empty `mobile` |
| **Contacts with Both Phone & Mobile** | **86** | Contacts having non-empty values in both fields |
| **Contacts Missing Both (No Numbers)**| **34** | Contacts with neither telephone nor mobile on file |
| **Total Active CRM Contacts** | **468** | **Exact Proof:** $16 + 332 + 86 + 34 = 468$ |

### 2. Trusted-Region Provenance Audit
- **Documented Indonesia (`c.country ILIKE '%indonesia%'`):** **463 contacts** $\rightarrow$ `trustedRegion = 'ID'`
- **Documented India (`c.country ILIKE '%india%'`):** **1 contact** $\rightarrow$ `trustedRegion = 'IN'`
- **Unverified / Missing Country (`c.country IS NULL OR c.country = ''`):** **4 contacts** $\rightarrow$ `trustedRegion = null`
  - `PT Bina Riset`: `country: ''`, no numbers on file.
  - `New Customer 1788200363892`: `country: null`, no numbers on file.
  - `PT BNP Ekosistem Inovasi`: `country: null`, mobile: `'082110769186'`.
  - `PT GEMMA NATURAL LESTARI`: `country: null`, city: `'Jakarta Utara'`, phone: `'021 868 656 53'`.

---

## SECTION C — RECONCILED DIRECTORY DATASETS (LEVEL B vs LEVEL A)

The audit evaluates the CRM directory at two distinct architectural levels:

### 1. Level B: Reconciled 518 Extracted Phone Entries (Per-Contact Distinct Entries)

In Level B, multiple numbers within compound fields are split into distinct records, but duplicate identical numbers within the same contact across `phone` and `mobile` are reconciled to a single per-contact phone entry.

#### A. Phone-Type Partition (Sum = 518 Extracted Entries Exactly)
| Phone Type Dimension | Count | Definition & Integrity Scope |
|---|:---:|---|
| **`mobile`** | **101** | Verified cellular candidate records (`+628...`, `+919...`) |
| **`fixed_line`** | **385** | Verified geographic landlines (`021`, `022`, `024`, `031`, etc.) |
| **`service_special`** | **5** | Universal access numbers (UAN `1500xxx`) |
| **`invalid`** | **25** | Unparseable strings, missing area codes, malformed `+0` |
| **`needs_review`** | **2** | National numbers lacking trusted region (`PT BNP` & `PT GEMMA`) |
| **SUM OF PHONE TYPES** | **518** | **Exact Mathematical Match:** $101 + 385 + 5 + 25 + 2 = 518$ |

#### B. Country Partition (Strictly Derived from Telephone Digits)
| Phone Country Dimension | Count | Details |
|---|:---:|---|
| **Indonesia** | **511** | Verified `+62` calling code |
| **India** | **2** | Verified `+91` calling code (1 mobile, 1 fixed-line Mumbai) |
| **Thailand** | **1** | Verified `+66` calling code |
| **Needs Review** | **4** | 2 malformed `+0` (`PT AVANTCHEM`, `PT Simex`) + 2 unverified region (`PT BNP`, `PT GEMMA`) |
| **SUM OF COUNTRIES** | **518** | **Exact Mathematical Match:** $511 + 2 + 1 + 4 = 518$ |

#### C. Full Directory Display Partition
$$\text{518 Extracted Phone Entries} + \text{34 Missing Number Contacts} = \mathbf{552}\text{ Directory Entries}$$
$$101 + 385 + 5 + 25 + 2 + 34 = \mathbf{552}$$

---

### 2. Level A: 578 Raw Field Occurrences Preserved (Every Occurrence Across Fields)

In Level A, every phone occurrence across both `phone` and `mobile` fields is preserved in the audit inventory without intra-contact suppression.

#### A. Phone-Type Partition (Sum = 578 Raw Occurrences Exactly)
| Phone Type Dimension | Count | Definition & Integrity Scope |
|---|:---:|---|
| **`mobile`** | **128** | Total cellular occurrences |
| **`fixed_line`** | **413** | Total landline occurrences |
| **`service_special`** | **7** | Total universal access / toll-free occurrences |
| **`invalid`** | **28** | Total unparseable or malformed occurrences |
| **`needs_review`** | **2** | Total national occurrences lacking trusted region |
| **SUM OF PHONE TYPES** | **578** | **Exact Mathematical Match:** $128 + 413 + 7 + 28 + 2 = 578$ |

#### B. Country Partition (Sum = 578 Raw Occurrences Exactly)
| Phone Country Dimension | Count | Details |
|---|:---:|---|
| **Indonesia** | **571** | Verified `+62` calling code |
| **India** | **2** | Verified `+91` calling code |
| **Thailand** | **1** | Verified `+66` calling code |
| **Needs Review** | **4** | 2 malformed `+0` + 2 unverified regional provenance |
| **SUM OF COUNTRIES** | **578** | **Exact Mathematical Match:** $571 + 2 + 1 + 4 = 578$ |

#### C. Full Directory Display Partition
$$\text{578 Raw Occurrences} + \text{34 Missing Number Contacts} = \mathbf{612}\text{ Total Field Occurrences}$$
$$128 + 413 + 7 + 28 + 2 + 34 = \mathbf{612}$$

---

## SECTION D — DUPLICATE IDENTITY BY STABLE COMPANY ID (`c.id`)

Duplicate groupings are computed strictly on valid canonical E.164 numbers using stable entity IDs:

### 1. Level B Duplicate Identity (50 Groups, 113 Records, 63 Excess)
- **Valid Normalized E.164 Records:** 491
- **Unique Normalized E.164 Keys:** 428
- **Canonical E.164 Duplicate Groups:** **50**
- **Total Records in Duplicate Groups:** **113**
- **Excess Duplicate Records:** **63**
- **Exact Mathematical Identity:**
  $$\text{50 Groups} + \text{63 Excess Records} = \mathbf{113}\text{ Records (100% Proven)}$$

#### Categorization by Stable Company ID:
1. **Same-Company Duplicate Groups:** **7 groups** (14 records, 7 excess)  
   Number repeated across multiple distinct contacts within the same company ID:
   - `+6282118111128` (`mobile`): **CV BIANGLALA BANDUNG** (ID: `0d97a7b7-8aa1-4a1b-a73d-f3ba1c5fbfd4`)
   - `+6281296479477` (`mobile`): **PT Bromo Pharmaceuticals** (ID: `ad806516-994c-48fd-8709-b1fb32d40731`)
   - `+6281293739515` (`mobile`): **PT COMBIPHAR** (ID: `cbb58efb-2fe3-4b6f-a3d9-8c915ac5977b`)
   - `+62317911143` (`fixed_line`): **PT DASA ESA FARMA** (ID: `b3546d1d-77dc-42a4-9921-c5785e7cca1a`)
   - `+628975047301` (`mobile`): **PT SAFA FARMA INDONESIA** (ID: `d6b9461f-5574-43a5-aa5e-5df1b1f3c971`)
   - `+628564621222` (`mobile`): **PT Sejahtera Lestari Farma** (ID: `2ea44656-dd04-4d5d-bb76-361cfe810338`)
   - `+628113948965` (`mobile`): **PT Surya Dermato Medica** (ID: `02bc750b-0d17-4e96-adba-7bb7b4c0cef6`)
2. **Cross-Company Duplicate Groups:** **43 groups** (99 records, 56 excess)  
   Numbers shared across different company IDs (e.g. Kalbe Farma affiliates sharing `+622189907333`, Dexa Medica affiliates sharing `+62217454111`).
3. **Sub-Categorization Proof:**
   $$\text{7 Same-Company Groups} + \text{43 Cross-Company Groups} = \mathbf{50}\text{ Total Groups (Exact Match)}$$
   $$\text{7 Same-Company Excess} + \text{56 Cross-Company Excess} = \mathbf{63}\text{ Total Excess (Exact Match)}$$

---

### 2. Level A Duplicate Identity (88 Groups, 208 Records, 120 Excess)
When evaluating all 578 raw field occurrences without intra-contact suppression:
- **Valid Normalized E.164 Occurrences:** 548
- **Unique Normalized E.164 Keys:** 428
- **Canonical E.164 Duplicate Groups:** **88**
- **Total Records in Duplicate Groups:** **208**
- **Total Excess Duplicate Records:** **120**
- **Exact Mathematical Identity:**
  $$\text{88 Groups} + \text{120 Excess Records} = \mathbf{208}\text{ Records (100% Proven)}$$

#### Categorization by Stable Company ID:
1. **Same-Company Duplicate Groups:** **45 groups** (90 records, 45 excess)  
   Where the same company recorded the identical number in both its `phone` and `mobile` columns.
2. **Cross-Company Duplicate Groups:** **43 groups** (118 records, 75 excess)  
   Where different company IDs share the identical phone number.
3. **Sub-Categorization Proof:**
   $$\text{45 Same-Company Groups} + \text{43 Cross-Company Groups} = \mathbf{88}\text{ Total Groups (Exact Match)}$$
   $$\text{45 Same-Company Excess} + \text{75 Cross-Company Excess} = \mathbf{120}\text{ Total Excess (Exact Match)}$$

---

### 3. Segregation of Unparseable Numbers (Manual-Review Groups)
Under ITU-T telecom standards, numbers that cannot be normalized to E.164 must **never** be lumped into canonical duplicate counts:
- In Level B: **1 unparseable shared string** — `"4603543"` (a 7-digit local Jakarta number missing area code `021`) shared between `PT. Mahakam Beta Farma` and `PT. MAHAKAM BETAFARMA (Contoh)`.
- In Level A: **4 unparseable shared strings** — `"0271 724336"` (same-company), `"024-747755"` (same-company), `"2786137"` (same-company), `"4603543"` (cross-company).

---

## SECTION E — FORENSIC AUDIT OF "NEEDS REVIEW" RECORDS

Under the corrected trusted-region logic (no `Boolean(c.city)`), exactly **4 records** require human review:

| # | Company Name | Entity ID | Source Field | Raw Input | Country in DB | Trusted Region | Country Result | Phone Type Result | Validation Reason |
|:---:|:---|:---|:---:|:---|:---:|:---:|:---:|:---:|:---|
| 1 | **PT AVANTCHEM** | `0da4068f...` | `phone` | `+065  65618333` | Indonesia | ID | **Needs Review** (⚠️) | **`invalid`** | Malformed international prefix (+0 is invalid) |
| 2 | **PT Simex Pharmaceutical** | `260d6b36...` | `phone` | `+02122676767 (hunting)`| Indonesia | ID | **Needs Review** (⚠️) | **`invalid`** | Malformed international prefix (+0 is invalid) |
| 3 | **PT BNP Ekosistem Inovasi** | `13d9ef2f...` | `mobile` | `082110769186` | *NULL* | *NULL* | **Needs Review** (❓) | **`needs_review`** | National format number without trusted region |
| 4 | **PT GEMMA NATURAL LESTARI**| `e91e5e30...` | `phone` | `021 868 656 53` | *NULL* | *NULL* | **Needs Review** (❓) | **`needs_review`** | National format number without trusted region |

### Technical Separation:
1. **Records 1 & 2 (Malformed `+0`):** Have verified country provenance, but violate ITU-T E.164 syntax. They flag **Country: Needs Review** to prevent wrong country routing, and **Phone Type: invalid** because carrier switches cannot route malformed E.164.
2. **Records 3 & 4 (Unverified Country):** Have valid national phone digit structure, but lack country provenance in the database (`country: NULL`). They flag **Country: Needs Review** and **Phone Type: needs_review** awaiting regional confirmation.

---

## SECTION F — CAMPAIGN CANDIDATE METRICS & CONSENT ENFORCEMENT

| Dimension | Level B (518 Entries) | Level A (578 Occurrences) | Compliance Status |
|---|:---:|:---:|---|
| **Valid Mobile Candidates** | **101** | **128** | Evaluated cellular records |
| **Unique Normalized Mobiles (E.164)**| **89** | **89** | Deduplicated mobile recipient pool |
| **Contacts Linked to Mobiles** | **85** | **85** | Companies with a mobile contact |
| **Recorded Individual Opt-In Consents**| **0** | **0** | Zero verified consent grants on file |
| **Unknown-Consent Candidates** | **101** | **128** | Gated pending verified opt-in |
| **FINAL CAMPAIGN-ELIGIBLE RECIPIENTS**| **0** | **0** | **STRICTLY ZERO** |

---

## SECTION G — VERIFICATION COMMANDS & REPRODUCIBILITY

```bash
# 1. Run authoritative reconciliation script (requires SUPABASE_DB_URL)
SUPABASE_DB_URL="<db_connection_string>" node scripts/reconcile-crm-directory-production.mjs

# 2. Run canonical phone & campaign safety tests
node --test tests/canonical-phone-and-campaign-safety.test.mjs

# 3. Fast incremental TypeScript typecheck
npm run typecheck
```

---

## SECTION H — GIT & PRODUCTION REPOSITORY INTEGRITY

- **Branch:** `main`
- **HEAD Commit SHA:** `5242c4863cce05070885ec9023b0e46ffa8b7295`
- **Git History:** 100% preserved (Zero commits, zero pushes, zero resets/stashes).
- **Production Database Writes:** **ZERO** (Strictly read-only queries against `dkrtsqienlhpouohmfki`).
- **Live WhatsApp Dispatches:** **ZERO** (No live sessions or messages).
