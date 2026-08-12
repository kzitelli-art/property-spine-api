# 4125 Debt — Structural Map

**2026-08-12. Phase A structural read. No schema. No migration.**
**Answers: what objects and relationships does the real 4125 loan force us to
represent? Not: what might CRE debt someday contain.**

---

## ⚠ THE BLOCKER, STATED FIRST

```text
4125 Chestnut Closing Binder.pdf · 55,550,368 bytes
→ PDF TEXT EXTRACTION FAILS. It is a scanned document.
```

The note, mortgage, loan agreement and any amendments exist **only** inside it.
No text-extractable copy was found: the `Alterra DD Copy` folder is sale-side
diligence (environmental, zoning, property information) and holds no loan
documents, and tenant-wide content search for the binder returns **10 of 10
results that are 4233's binder, not 4125's**.

**This is a Phase E finding of the first order, not merely an obstacle.** The
charter says *"use the smallest reader capable of reliably proposing facts from
the real specimen."* The real specimen's governing instruments are page images.
The smallest sufficient reader is therefore **not** a text extractor, and the Tax
label scanner is not a starting point. Any Phase E estimate that assumed text
extraction is wrong.

Everything below marked `NOT ESTABLISHED — blocked` is blocked by this one file.

---

## INSTRUMENTS

```text
ONE debt instrument established.

  senior mortgage loan · number 480010465 · Lument
  original principal $28,250,000 · first payment 2020-09-01
  maturity 2030-08-01 · balloon $24,716,182.48
```

No second debt instrument found. **Morrison Street is preferred equity** — ruled
by the owner, and independently corroborated by the org chart, where
`MSC – 4125 Chestnut HoldCo, LLC` appears in the *ownership* structure at 21.432%
of Borrower.

Mezzanine / supplemental / facility debt: **absent** on this specimen.

---

## BORROWERS / OBLIGORS

```text
BORROWER    4125 Chestnut LLC, a Delaware LLC
            the org chart uses "Borrower" as a defined term and measures
            every holder as a percentage OF it

GUARANTORS  Asher Shafran · Kameron Zitelli · Robert Vernicek · Lee Silpe
            all four described as "U.S. Individual and Guarantor"
```

`4125 Chestnut Interest Holder LLC` is an **upper-tier holder, not the obligor**.

Guarantors are **natural persons**, so they do not fit `legal_entities`, and Debt
must not mint durable person records as a side effect of reading a loan document.

---

## LENDER / SERVICER

```text
"Lument Capital, LLC"              on the amortization schedule
"LUMENT REAL ESTATE CAPITAL, LLC"  the payee on the billing statement
```

Two legal names for one colloquial party. **Whether the note holder and the
servicer are the same entity: NOT ESTABLISHED — blocked.** Agency loans are
routinely held by one party and serviced by another, so lender and servicer may
be two facts rather than one field.

The servicer's asset manager is **mutable and not a loan fact** — `COOPER, DUSTIN`
on the schedule, `Jeremy Banks` on the 2025 statement.

---

## COLLATERAL

```text
4125 Chestnut Street, Philadelphia PA — one property
```

Established by folder location, by the `Lument - Registration Form - 4125 SOLO`
documents, and by amount (4233's financing is a $68.25M Delphi mortgage — a
different loan). **Never by the loan's name**, which is `"LVL 4125"` and carries
both properties' tokens.

```text
legal description tying the mortgage to the parcel   NOT ESTABLISHED — blocked
cross-collateralization                              no evidence; not proven absent
```

---

## TERM PERIODS

Two periods, both established by the **same original source**. This is not an
amendment — the instrument was born with two regimes.

```text
INTEREST ONLY     2020-09-01 → 2024-08-01   payments 1–48
                  balance flat at $28,250,000; payment varies with day count

AMORTIZING        2024-09-01 → 2030-08-01   payments 49–120
                  level P&I $123,411.40; the SPLIT shifts, the sum does not

BOTH              3.28000% fixed · 360 DAYS/ACTUAL DAY MOS (2/29)
                  one rate across all 120 rows
```

**Day-count is a first-class term**, not decoration: 31-day $79,790.56 · 30-day
$77,216.67 · 28-day $72,068.89 · 29-day $74,642.78.

---

## AMENDMENT / MODIFICATION CHAIN

```text
NOT ESTABLISHED — blocked.
```

No amendment documents in the folders read. The schedule shows no rate or payment
change across 120 rows, which is *evidence against* an economic amendment but
**not proof of none** — a non-economic modification would not appear in it.

---

## EXTENSION STRUCTURE

```text
NOT ESTABLISHED — blocked. This is the most consequential unknown.
```

The schedule ends 2030-08-01 with a balloon and no extension rows, which is
equally consistent with *no extension exists* and *an extension exists and is
unexercised*. **The charter's `maturity ≠ extension` wall cannot be exercised
until this is known**, and Spine would today answer "matures 2030-08-01" without
knowing whether that is the whole truth.

Per the ruling: preserve the seam, do not build the subsystem.

---

## COVENANT / REPORTING STRUCTURE

**Reporting requirements EXIST.** Categories only:

```text
lender quarterly reporting stream        Reporting - Lender & Investor/Lender (Quarterly)
borrower PM certification                480010465_LVL_PMC_Lument Borr PM Certification
management program questionnaire         LUMENT Management Program Questionnaire
loan registration                        Lument - Registration Form - 4125 SOLO
replacement reserve draw process         Eligible Items · Disbursement Worksheet ·
                                         Unconditional Lien Waiver
```

**Financial covenants — DSCR, debt yield, liquidity, net worth:
NOT ESTABLISHED — blocked.**

---

## LENDER-CONTROLLED ACCOUNTS

Three categories, all established from the billing statement:

```text
tax escrow             monthly contribution + balance
insurance escrow       monthly contribution + balance
replacement reserve    monthly contribution + balance + a governed draw process
```

Interest reserve / debt-service reserve: absent on this specimen.

---

## CURRENT OBSERVATION SOURCES

```text
Lument monthly billing statement   principal balance · rate · escrow balances · YTD
                                   ⚠ latest retained is 2025-08-01. No 2026 folder.
Lument amortization schedule       120 published rows — a PROJECTION, not an observation
```

The published schedule is the pinning target: the derivation must reproduce all
120 rows, on the tax precedent that a published value must never mask a broken
rule.

---

## PAYMENT EVIDENCE SOURCES

```text
statement "RECENT TRANSACTION HISTORY"   payment received + how it was applied
ACH auto-draft                           "DO NOT PAY — will be drafted"
ACH Payment Form.pdf                     the arrangement itself
```

Latest payment evidence: **2025-07-03**. Payment initiation is not an operator
action, which matters for what "are we current?" can mean.

---

## CROSS-DOMAIN CLAIMS PRESENT IN SOURCES

One artifact, four destinations. This is the concrete case behind the ruling.

```text
DEBT        principal balance · P&I split · rate · principal/interest paid YTD
            deferred interest $0 · default interest $0 · 10-day grace ·
            late charge 5%

TAXES       tax escrow contribution $4,076.24/mo · balance $22,262.35 (7/17/2025)
            → Taxes funding truth. NOT Debt's to author.

INSURANCE   insurance escrow contribution $3,019.07/mo · balance $42,266.98
            → Insurance funding truth. NOT Debt's to author.

OTHER       replacement reserve $1,763.00/mo · balance $104,017.00
            → debt-linked lender reserve; a reserve domain later
```

Two different escrow as-of dates appear in one document (`7/17/2025`,
`6/30/2025`).

---

## UNKNOWNS THAT COULD CHANGE THE MODEL

```text
1  EXTRACTION MECHANISM     the governing instruments are SCANNED. Phase E
                            cannot assume text. Highest-impact unknown.
2  extension options        exists / absent unknown — the wall depends on it
3  covenant structure       categories unknown — thresholds explicitly not needed
4  amendment chain          whether terms were ever modified
5  lender vs servicer       one party or two
6  prepayment / defeasance  structure unknown
7  legal description        the evidence that ties mortgage → parcel
```

Items 2–7 are all inside the same scanned file. **One human-assisted read of that
binder closes six of the seven.**

---

## WHAT THE SPECIMEN FORCES

Objects and relationships the real loan requires — nothing speculative:

```text
instrument                          one, but modelled as many
entity → instrument (obligor)       borrower; NOT entity → property
instrument → property (collateral)  with the evidence that established it
effective-dated terms               two periods from one original source,
                                    so the mechanism is required on day one
day-count convention                a stored term, not an assumption
published schedule                  retained, and the derivation reproduces it
dated balance observations          append-only; the latest is 12 months stale
dated payments with application     due / received / applied are three facts
escrow REQUIREMENTS                 contractual terms; balances belong elsewhere
guarantor                           attributed fact, not a minted identity
```

Seams preserved without subsystems: **extension**, **covenant**, **amendment**,
**cross-collateral**, **second instrument** — each `NOT ESTABLISHED` rather than
absent, and each cheap to add once the binder is read.
