# Debt Build 1 — Phase A Source Read (4125 Chestnut)

**2026-08-12. Read-only. No schema, no code, no design.**
**Against the real 4125 SharePoint/OneDrive specimen.**

Phase A of the Capital Stack → Debt build charter. The charter's instruction is
the reason this document exists before any table:

> Do not start by creating fifty debt fields and then looking for documents to
> fill them. Let the real loan teach us the model.
>
> Stop before schema if the real documents contradict the assumed model.

**They do, in three places.** Those are in §7. Everything before it is inventory.

---

## Scope of this read — what was and was not looked at

**Looked at:** the `4125 Chestnut (Uno Chestnut) - MGMT` document library — full
folder listing; `Mortgage Statements/` in full; `Replacement Requests - Lument/`
in full; `Reporting - Lender & Investor/` one level; the Lument amortization
schedule end to end; targeted content search across the tenant for 4125 loan
documents.

**Not looked at, and named so the gap is not mistaken for absence:** the
`Acquisition/` folder contents (61 MB — closing binder, likely the note and
mortgage themselves); the six years of individual monthly mortgage statements
(2020–2025); `Morrison Street (Monthly)/` contents (612 MB); `Lender
(Quarterly)/`; `Investor (Quarterly)/`; `Investor Interest Transfers/`; the
`4125 Chestnut (Solo Chestnut) - Alterra DD Copy/` folder. **No original note,
mortgage/security instrument, or loan agreement has been read yet.** Every term
below comes from a servicer-produced amortization schedule, which is evidence of
what the servicer computed — not the governing instrument.

---

## 1. THE ANSWER: one debt instrument, and the second party is equity

| party | role | disposition |
|---|---|---|
| **Lument** | lender/servicer, loan 480010465 | **Debt.** Terms, observed balance and payment evidence in hand |
| **Morrison Street** | capital party, monthly reporting | **Preferred equity — RULED 2026-08-12.** Not Debt. Capital Stack → Equity & Preferred Equity, a later build |
| **4125 Chestnut LLC** | **the Borrower** | Delaware LLC. Resolved from the org chart |
| 4 individuals | **Guarantors** | Shafran, Zitelli, Vernicek, Silpe |

The Morrison Street ruling is **independently corroborated by the org chart**,
which was read after the ruling was given: `MSC – 4125 Chestnut HoldCo, LLC` sits
in the *ownership* chart at **21.432% aggregate ownership in Borrower**. MSC is
Morrison Street Capital. It is an equity holder, not a lender, and the org chart
says so structurally rather than by name.

**So Debt V1 has exactly one instrument.** That does not license a single-loan
model — per the charter, *"the architecture must not become 4125-special because
the first specimen is simple."* The instrument/collateral separation in §3 and
§5 is required regardless of this specimen having one loan.

---

## 2. The senior loan — governed terms as stated by the servicer

Source: `Mortgage Statements/Amortization Schedule.pdf`, Lument Capital, LLC.

```text
Loan Number      480010465
Loan Name        "LVL 4125"                    ⚠ see §3
Loan Amount      $28,250,000.00
First Payment    2020-09-01
Maturity Date    2030-08-01
Interest Rate    3.28000%                      fixed, single rate across all 120 rows
Interest Basis   360 DAYS/ACTUAL DAY MOS (2/29)
Payment Amount   —                             ⚠ BLANK IN THE SOURCE. See §7.1
Asset Manager    COOPER, DUSTIN                (the LENDER's asset manager, not ours)
```

### Interest-only, then amortizing — a structural fact, not a nuance

```text
payments 1–48    2020-09-01 → 2024-08-01   principal "-", balance flat at $28,250,000
payment 49       2024-09-01                 first principal: $43,620.84
payments 49–120  amortizing
payment 120      2030-08-01                 principal $24,716,182.48   ← BALLOON
```

The IO period ended **2024-09-01**. That is precisely the causal hook the charter
names ("interest-only period ended") and it is already in the past, so any
year-over-year debt-service comparison for this property crosses it.

### Actual/360 is real here, and it is visible in the numbers

Interest is recomputed per actual days in each period:

```text
31-day month   $79,790.56
30-day month   $77,216.67
28-day month   $72,068.89
29-day month   $74,642.78   (2024 leap)
```

This is the exact case flagged in `STANDING_ECONOMIC_OBLIGATIONS_SOURCE_READ.md`
Flag 1 — *"debt interest on actual/360 needs either a different grain or a
start/end range."* It is no longer hypothetical.

### Scheduled balances (projection, NOT observation)

```text
2025-12-01   $27,513,712.54
2026-06-01   $27,227,510.84
2026-08-01   $27,131,874.12      ← most recent scheduled payment before today
```

**These are schedule rows, not a lender-stated balance.** See §7.3.

---

## 3. ⚠ THE LOAN NAME IS "LVL 4125" AND THAT IS THE KNOWN TRAP

The instrument's own name in the servicer's system contains **both** property
tokens. `src/identity/property_resolution_service.js` already carries the
warning, written before this build:

> *"both 4125 and 4233; a 4233 loan doc says 'LVL 4125'. Name is not…"*

This amortization schedule is the artifact that comment is about, or its twin.
Two independent corroborations put loan 480010465 on **4125**, and neither is
the name:

```text
LOCATION   the file sits in 4125 Chestnut (Uno Chestnut) - MGMT/Mortgage Statements
AMOUNT     $28.25M — 4233's financing is a $68.25M mortgage from Delphi
           against an $88M purchase (4233 closing binder). Different loan.
SIBLINGS   "Lument - Registration Form - 4125 SOLO - Signed.pdf" in the same folder
```

**Ruling for the build: a loan's property relationship is never resolved from the
loan's name or number.** It is resolved from the security instrument's legal
description, or from an explicit human confirmation, and it is recorded with the
evidence that established it. A file named `480010465_LVL_ PMC_Lument Borr PM
Certification Update - Signed.pdf` sits in the 4125 folder while carrying the
4233 property's short name in its filename — that is the collision live, in a
filename, today.

---

## 4. Reserves — Lument holds a replacement reserve with a draw process

`Replacement Requests - Lument/` contains:

```text
_Replacement Reserve_Disbursement Worksheet.xls
_Lien Waiver_Unconditional_Vendor paid.pdf
Eligible Items.pdf
```

So the loan establishes a **lender-controlled replacement reserve**, with an
eligibility list, a disbursement worksheet and lien-waiver evidence per draw.

This is a debt-linked contractual fact and belongs in Debt per the charter. It is
**not** the general Reserves & Escrows module, and Debt V1 should capture only
enough to understand the loan.

### ⚠ Lument escrows TAXES AND INSURANCE. Confirmed, not inferred.

The 2025-08-01 billing statement collects all three monthly, and reports all
three balances:

```text
MONTHLY                          ESCROW BALANCES     7/17/2025      6/30/2025
Tax                  $4,076.24   Tax                $22,262.35     $18,186.11
Insurance            $3,019.07   Insurance          $42,266.98     $39,247.91
Replacement Reserve  $1,763.00   Replacement       $104,017.00    $102,254.00
```

**This is the funding boundary, live, on the first Debt specimen.** Debt now
holds a document that states a tax escrow balance and an insurance escrow
balance. The rules that already exist apply without amendment:

```text
Debt MAY state    the loan REQUIRES monthly tax and insurance escrow
                  — that is a contractual term of the instrument
Debt MAY NOT      author a tax funding position or an insurance funding
                  position, or let either read as PAID
```

`gate_funding_boundary.js` already encodes this for Taxes and Insurance, and its
tax clause is exact: *"a fully funded escrow is still not PAID until there is
evidence the City was paid."* A $22,262.35 tax escrow balance on a lender
statement is **not** a Philadelphia real-estate-tax payment, and Debt must never
be the path by which it becomes one.

**Phase B consequence:** Debt is the third domain to touch this wall, and it
touches it from the *other* side — the first two authored their own funding,
whereas Debt reads a lender's statement that happens to carry all three numbers.
The declaration in `gate_funding_boundary.js` should gain Debt before the first
Debt file lands, exactly as Taxes was declared before its schema existed.

Two escrow as-of dates appear in one document (`7/17/2025` and `6/30/2025`).
Escrow balances are dated observations, like the principal balance in §7.3 —
never "current".

---

## 5. Parties — borrower RESOLVED, and a party class the charter did not list

Source: `Acquisition/4125 Chestnut - Org Chart.pdf`, which uses "Borrower" as a
defined term throughout and measures every holder's percentage *of the Borrower*.

```text
                    4125 Chestnut Street, Philadelphia
                              ↑ owned by
    ┌─────────────────────────────────────────────────────┐
    │  4125 Chestnut LLC, a Delaware LLC   ← THE BORROWER  │
    └─────────────────────────────────────────────────────┘
                              ↑ members
      4125 Chestnut Holdings LLC (DE) [K]  77.568%
      4125 Chestnut GP LLC (PA)      [J]   1.776%   non-member manager
                              ↑ upper tier
      4125 Chestnut Interest Holder LLC (DE)
      MSC – 4125 Chestnut HoldCo, LLC (DE)  [F]  21.432%   ← Morrison Street, EQUITY
      UPenn Apartments LLC (NY)             [H]  34.291%
      EQUITYMULTIPLE 80, LLC (DE)           [G]  12.859%
      Talisen 1849 LLC (PA)                 [E]   4.715%
      FPP 1 LLC (PA)
```

**`4125 Chestnut Interest Holder LLC` is NOT the borrower** — it is an upper-tier
holder, which is what the first pass suspected and the org chart confirms.

### Guarantors are a Debt party class, and the charter's list omits them

```text
Asher Shafran      U.S. Individual and Guarantor   4.029% net
Kameron Zitelli    U.S. Individual and Guarantor   2.015% net
Robert Vernicek    U.S. Individual and Guarantor   2.015% net
Lee Silpe          U.S. Individual and Guarantor   2.015% net
```

Four **individual** guarantors. §5's charter text covers borrower and lender and
does not mention guarantors at all. They are natural persons, not legal entities,
so they do not fit `legal_entities` — and Debt must not mint durable person
records as a side effect of reading a loan document (§12: *a name may be evidence
of identity; it may not silently create a durable person*). **Recommendation for
Phase B: guarantor is recorded as an attributed fact of the instrument with its
source, not as an identity Debt creates.**

### Schema consequence, unchanged

**Do not create a debt-specific borrower table.** Borrower identity uses
`legal_entities` / `legal_entity_properties` (migration 164) — but
`relationship_type` is `owner | operating_entity | other`. **There is no
`borrower`.** That remains the one place 164 does not already fit.

### Lender identity is not one name

```text
"Lument Capital, LLC"              on the amortization schedule
"LUMENT REAL ESTATE CAPITAL, LLC"  the payee on the billing statement
```

Two different legal names for what is colloquially "Lument". Agency loans are
routinely serviced by one party and held by another, so **lender and servicer may
be two facts, not one field** — the original note answers this and has not been
read. Text is acceptable in V1 per the charter; do not reach for `vendors`.

**The servicer's asset manager is mutable and is not a durable loan fact:**
`COOPER, DUSTIN` on the schedule, `Jeremy Banks` on the 2025 statement.

---

## 6. Evidence inventory — what exists, by charter category

```text
original note                     NOT YET READ   likely in Acquisition/
mortgage / security instrument    NOT YET READ   likely in Acquisition/
loan agreement                    NOT YET READ   likely in Acquisition/
closing statement                 NOT YET READ   Acquisition/
amendments / modifications        NONE FOUND     absence not established — Acquisition/ unread
extensions                        NONE FOUND     same
assignments                       NONE FOUND     same
lender statements                 PRESENT        Mortgage Statements/ 2020–2025, unread
payment notices                   PRESENT        ACH Payment Form.pdf
escrow statements                 NOT ESTABLISHED
reserve statements                PRESENT        Replacement Requests - Lument/
interest-rate notices             N/A            fixed-rate instrument
payoff statements                 NONE FOUND
covenant correspondence           NOT ESTABLISHED
lender reporting requirements     PRESENT        Lender (Quarterly)/, Morrison Street (Monthly)/,
                                                 PM Certification, Management Questionnaire
```

**"None found" here means "not found in the folders read", never "does not
exist."** `Acquisition/` is unread and is the folder most likely to contain the
instrument documents, amendments and extensions.

---

## 7. Where the real documents contradict the assumed model

The charter says to stop here rather than push into schema. Three items.

### 7.1 Monthly debt service is level — but it is NOT the monthly payment

> **⚠ CORRECTED on the second Phase A pass.** The first pass read only the
> amortization schedule, saw a blank `Payment Amount` field and interest varying
> $63,760–$79,790, and concluded there was no level payment. **That was wrong**,
> and the lender statement shows why. The blank field was blank because *one*
> constant cannot describe *two* phases, not because no constant exists.

```text
payments 1–48    INTEREST ONLY. Payment varies with day count. No constant.
payments 49–120  LEVEL P&I of $123,411.40. The SPLIT shifts monthly; the sum does not.
```

Verifiable in the schedule itself — every amortizing row sums to the same number:

```text
2025-01-01   interest 79,281.11 + principal 44,130.29 = 123,411.40
2025-03-01   interest 71,383.26 + principal 52,028.14 = 123,411.40
2025-09-01   interest 78,237.73 + principal 45,173.67 = 123,411.40
```

**And now the part that matters more.** The lender statement's `TOTAL AMOUNT DUE`
is **$132,269.71**, not $123,411.40:

```text
Principal              $45,046.44   ┐
Interest               $78,364.96   ┘  debt service      $123,411.40
Tax                     $4,076.24   ┐
Insurance               $3,019.07   ├  escrow / reserve    $8,858.31
Replacement Reserve     $1,763.00   ┘
TOTAL                 $132,269.71
```

```text
DEBT SERVICE  ≠  TOTAL MONTHLY PAYMENT
```

$132,269.71 is what leaves the bank account. **$8,858.31 of it is not debt
service** — it is tax and insurance funding plus a reserve deposit, moving
*through* the lender. Answering *"what's our monthly debt service?"* with the
total overstates the cost of the debt by 7%, and it does so by importing funding
into an economic answer, which is the funding boundary violated in a sentence.

**RULED (2026-08-12): the standing projection carries `next payment due` as a
dated row with its components, never a monthly constant.** The ruling survives
the correction and is strengthened by it — a dated row with a split is the only
form that stays honest across the IO boundary, across the shifting P&I split,
and across the debt-service/escrow distinction. The screen tile is
**Next Payment**, not Monthly Debt Service.

### 7.2 Morrison Street may not be Debt at all

612 MB of **monthly** reporting to a party that is not the property manager and
not the senior lender. Morrison Street Capital transacts in both mezzanine debt
and preferred equity, and those land in **different Capital Stack rooms**.

Charter: *"Do not infer one instrument merely because several documents use
similar names."* Applying that: Morrison Street's instrument class is
`NOT_ESTABLISHED`. Reading one document from that folder resolves it, and that is
a Phase A completion item, not a Phase B assumption.

If it is mezzanine debt, 4125 is a two-tier stack from day one and the charter's
*"What's our senior debt? / What's our mezz debt?"* questions are live
requirements rather than forward-looking ones.

### 7.3 A fourth truth wall the charter does not list: schedule ≠ observation

The charter lists five walls. The specimen produces a sixth, and it is the one
most likely to be violated by accident because both numbers are "the balance":

```text
SCHEDULED BALANCE    what the amortization schedule projects for a date,
                     assuming every payment was made exactly as scheduled
OBSERVED BALANCE     what a lender statement says the balance actually is,
                     as of a stated date
```

Spine can compute `$27,131,874.12` for 2026-08-01 from the schedule without any
evidence a single 2026 payment was made. Rendering that as *the* balance asserts
payment history the schedule cannot support — a confident wrong wearing a
citation (§5, §40.4). They differ by `source_authority`, and the standing
projection must carry which one it is.

**Both are legitimate facts. Presenting the first as the second is not.**

### And the specimen makes this urgent rather than theoretical

```text
OBSERVED    $27,745,265.77   per Lument statement, billing due date 2025-08-01
SCHEDULED   $27,131,874.12   per amortization schedule, 2026-08-01
TODAY       2026-08-12
```

**The most recent lender statement retained is 2025-08-01 — over twelve months
old.** `Mortgage Statements/` holds 2020 through 2025 and there is no 2026
folder. So the honest answer to *"what's our balance?"* today is a twelve-month-
old observation, or a projection carrying no payment evidence for 2026. It is
not "$27.1M".

The charter's falsification case reads *"balance exists, as_of is six months
old."* The real specimen is worse than the test, and it is the **live** state of
the first property Debt will ship against — this is not a fixture someone has to
remember to construct.

The observation itself is internally consistent with the schedule, which is worth
recording as corroboration rather than as proof of payment: the 2025-08-01
statement's `PRINCIPAL BALANCE` equals the schedule's balance after the
2025-07-01 payment, as it should before the 8/1 payment posts.

### Payment evidence exists, and it is a different fact again

```text
7/3/2025   PAYMENT REC'D   $132,269.71   principal (47,444.66)  interest 75,966.74  escrow 8,858.31
6/5/2025   PAYMENT REC'D   $132,269.71   principal (44,785.94)  interest 78,625.46  escrow 8,858.31
6/5/2025   MISC AMOUNTS PAYMENT   $337.58
```

Three distinct truths in one table — *amount due*, *amount received*, and *how it
was applied* — plus a `MISC AMOUNTS PAYMENT` that belongs to none of the five
scheduled components. `AMT DUE / AMT RECEIVED / AMT REMAINING` are separate
columns on the statement itself, which is the charter's payment-truth separation
already expressed by the source.

Also governed, and easy to lose: `DEFERRED INT. BALANCE $0.00`,
`DEFAULT INT. BALANCE $0.00`, a **10-day grace** (late charge after 8/10 for an
8/1 due date), a late charge of **$6,613.49** (5% of the total due), and
`DO NOT PAY — THIS AMOUNT WILL BE DRAFTED` — the loan is on **ACH auto-draft**,
so payment initiation is not an operator action.

---

## 8. Phase A status

```text
1  read Acquisition/                          PARTIAL — org chart read;
                                              closing binder (55 MB) NOT read
2  resolve Morrison Street                     ✓ RULED preferred equity,
                                              corroborated by the org chart
3  most recent lender statement                ✓ 2025-08-01 — observed balance
                                              and payment evidence in hand
4  does Lument escrow taxes / insurance?       ✓ YES, both. See §4
5  borrower of record                          ✓ 4125 Chestnut LLC (DE), from
                                              the org chart
6  rule on monthly debt service                ✓ RULED — next payment, dated
                                              and split. See §7.1
```

### What is still genuinely open

```text
THE NOTE, MORTGAGE AND LOAN AGREEMENT ARE STILL UNREAD.
```

`Acquisition/4125 Chestnut Closing Binder.pdf` is 55 MB and contains them. Until
it is read, the following are `NOT_ESTABLISHED` rather than absent:

```text
prepayment terms / yield maintenance / lockout
extension options            ← §7 of the charter's walls depends on this
default rate
covenants and thresholds     ← DSCR, debt yield, liquidity, net worth
reporting requirements       ← cadence and deadlines
amendments / modifications
the legal description that ties the mortgage to 4125   ← §3 depends on this
whether "lender" and "servicer" are one party or two   ← §5
```

**The extension question matters most for Ask Spine.** The charter's maturity
wall — *"maturity ≠ extension"* — cannot be exercised until the loan agreement
says whether an extension option exists. Today Spine would answer "matures
2030-08-01" with no idea whether that is the whole truth.

**Recommendation: read the closing binder before Phase B schema.** Covenants and
extension options are exactly the structures the charter says to model "only to
the depth the specimen requires", and the specimen has not yet been allowed to
speak on them.

---

## 9. Carried forward for Phase B, if the above holds

Nothing here is schema. These are constraints the specimen has already proven:

- **Day-count is a first-class term.** `360 DAYS/ACTUAL DAY MOS (2/29)` is not
  decoration; it is why interest differs every month, and it must be stored, not
  assumed 30/360.
- **Term periods are effective-dated from birth.** IO→amortizing at 2024-09-01 is
  already an in-past transition on the first specimen. A single flat "terms" row
  cannot hold it.
- **Balloon is a term, not a final row.** $24,716,182.48 due 2030-08-01.
- **The property relationship carries its own evidence** (§3).
- **`legal_entity_properties` needs a borrower relationship type** (§5).
- **No governed currency context exists anywhere in the repo.** The schedule is
  USD and says so nowhere; Phase B resolves currency explicitly or refuses.
- **§40.6 standing projection must be answerable without walking this schedule.**
  120 rows for one loan is exactly the "full detail" the compact read exists to
  avoid loading.
