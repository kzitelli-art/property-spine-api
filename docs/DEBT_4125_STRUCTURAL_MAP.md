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

### What this establishes, and what it does NOT

> **⚠ CORRECTED 2026-08-12 by owner ruling.** This section originally concluded
> *"the smallest sufficient reader is therefore not a text extractor."* That
> overreached — it froze an implementation from one fact. The requirement is
> established; the mechanism is not chosen.

```text
ESTABLISHED   Debt establishment must support source artifacts that do not
              expose usable embedded text.

NOT CHOSEN    page rendering · multimodal document reading · OCR ·
              human-selected pages · hybrid extraction
```

Phase A does not choose. At source establishment we use the smallest mechanism
that reliably works against the actual documents.

**And Phase A's binder read is not Phase E.** They are different problems and
must not merge:

```text
PHASE A   a targeted, human-assisted read to learn what the loan IS.
          Research. One pass. No production code.
PHASE E   a production-capable document-establishment mechanism.
          A later slice, scoped by evidence we do not yet have.
```

"The binder is scanned" is not a reason to start building document
infrastructure now.

### I cannot perform this pass — three independent confirmations

```text
1  no download capability exists in the Microsoft 365 tool surface
   (search · read_resource · upload · update · copy · move · rename · delete)
2  read_resource is the only content path and it fails on this file
3  the network gateway DENIES onefivecapital.sharepoint.com:443 by policy
   → "connect_rejected · gateway answered 403 to CONNECT"
```

So the bytes cannot reach this environment by any available route. The
human-assisted part of "human-assisted page-image read" is load-bearing. §8 below
states exactly what a human pass must return, keyed to the six questions, so the
pass is targeted rather than an archaeology project.

Everything below marked `NOT ESTABLISHED — blocked` is blocked by this one file.

---

## SOURCE AUTHORITY HIERARCHY

Applied throughout. Lower sources are not useless; they are the wrong source for
certain kinds of fact.

```text
1  executed governing instrument                 note · mortgage · loan agreement
2  executed amendment / modification / assignment
3  lender / servicer statement                   billing statement · amortization schedule
4  closing / supporting documentation            registration forms · certifications
5  internal org chart / reporting workbook
6  folder naming / contextual inference
```

**A servicing statement can establish an observed balance while being the wrong
source for the legal collateral definition. An org chart can strongly support
entity identity without proving who signed a guaranty.**

Nothing in this map is currently supported by a level-1 or level-2 source,
because none has been read. Every structural conclusion below rests on levels 3–6.

---

## INSTRUMENTS

> **⚠ POSTURE CORRECTED.** This section said *"one instrument"* and *"mezzanine /
> supplemental / facility debt: absent."* Both stated absence more strongly than
> the evidence permits. **"I have not found one" is not "none exists"** — and
> closing that specific uncertainty is the whole point of the binder read.

```text
ONE INSTRUMENT CURRENTLY EVIDENCED           authority 3 (servicer statement + schedule)

  senior mortgage loan · number 480010465 · Lument
  original principal $28,250,000 · first payment 2020-09-01
  maturity 2030-08-01 · balloon $24,716,182.48

NO ADDITIONAL DEBT INSTRUMENT FOUND IN REVIEWED SOURCES
ADDITIONAL INSTRUMENT STRUCTURE NOT YET RULED OUT BY THE GOVERNING BINDER
```

**Morrison Street is preferred equity** — owner-ruled, and corroborated by the
org chart (authority 5), where `MSC – 4125 Chestnut HoldCo, LLC` appears in the
*ownership* structure at 21.432% of Borrower. That corroboration is strong for
*equity classification* and is not a level-1 source for whether any other debt
exists.

Mezzanine / supplemental / facility debt: **not found in reviewed sources; not
ruled out.**

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
tax escrow             monthly contribution + balance      authority 3
insurance escrow       monthly contribution + balance      authority 3
replacement reserve    monthly contribution + balance      authority 3
                       + a governed draw process           authority 4
```

Interest reserve / debt-service reserve: **not found in reviewed sources; not
ruled out.** A reserve funded once at closing and never billed monthly would not
appear on a servicing statement at all, so a level-3 source is structurally weak
evidence of absence here.

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

---

## 8. THE HUMAN BINDER PASS — WHAT IT MUST RETURN

One targeted pass. Do not process 55 MB indiscriminately. Six questions.

### Where to look

A closing binder opens with a **tab index**. Photographing or exporting that
index alone probably answers questions 1, 4 and 5 outright, because it names
every document that exists — including any amendment, modification or assignment
that would otherwise be invisible. **Start there; it is the single highest-value
page in the file.**

Precedent that the index exists: `4125 Interest Holder LLC Operating Agreement.pdf`
opens with `TAB 49B`, so this binder is tabbed to at least 49.

Then, only the documents the index identifies as:

```text
Q1  instruments      Promissory Note · any second note · Loan Agreement
Q2  obligors         signature pages of Note and Guaranty; Guaranty parties
Q3  collateral       Mortgage / Security Instrument — the granting clause and
                     Exhibit A legal description
Q4  amendments       any Amendment · Modification · Assignment · Assumption
Q5  extension        Loan Agreement — maturity + any extension option article
Q6  covenants        Loan Agreement — financial covenants + reporting article,
                     CATEGORY NAMES ONLY, no thresholds, no calculations
+   lender/servicer  whether the Note names a payee different from Lument, and
                     whether any assignment or servicing transfer appears
```

### What to bring back per finding

```text
fact
source document      e.g. "Promissory Note"
page / section       e.g. "p. 3, §2.1" or "Tab 12, signature page"
authority level      1–6 per the hierarchy above
```

If the scan does not establish something clearly: **`NOT_ESTABLISHED`.** A blurry
page is not evidence of absence.

### The return format

Only the deltas against this map:

```text
INSTRUMENT COUNT              confirmed / revised
OBLIGORS + GUARANTORS         confirmed / revised
COLLATERAL                    confirmed / revised
AMENDMENT CHAIN               exists / none found / not established
EXTENSION                     exists + structure / absent / not established
COVENANTS                     categories that exist        (no calculations)
REPORTING REQUIREMENTS        categories that exist
LENDER-CONTROLLED ACCOUNTS    categories established
LENDER VS SERVICER            established / not established
ANY FINDING THAT BREAKS THE PROPOSED MODEL      yes / no
```

### Getting it to Spine

The bytes cannot reach this environment (see the blocker above). Any of these
works, most reliable first:

```text
1  paste the findings as text, in the format above
2  commit the exported pages into the repo on a branch — local files ARE readable
3  paste the relevant document text directly
```

**If the answer to the last line is `no`** — nothing breaks the model — Phase C
starts with the minimal historical schema. The build is not held open to solve
document automation first.
