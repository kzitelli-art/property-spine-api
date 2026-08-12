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

## 1. THE ANSWER: one established instrument, one unresolved party

| party | role | established? |
|---|---|---|
| **Lument Capital, LLC** | servicer/lender, loan 480010465 | **YES** — terms in hand |
| **Morrison Street** | capital party, monthly reporting | **NO** — debt or preferred equity is `NOT_ESTABLISHED` |

4125 is **not** the simple one-loan specimen the charter allowed for. There is a
second capital party receiving monthly reporting, and which Capital Stack room it
belongs in is not determinable from what has been read.

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
enough to understand the loan. Whether Lument also escrows **taxes** and
**insurance** is `NOT_ESTABLISHED` from what has been read — and if it does, §40.5
and the funding boundary both apply: Debt may state the loan *requires* an escrow;
it may never author the tax or insurance funding position.

---

## 5. Parties and entities — borrower identity is NOT resolved

Names observed, none confirmed as the borrower of record:

```text
4125 Chestnut Interest Holder LLC     Delaware LLC — operating agreement in Acquisition/
"4125 Chestnut HoldCo"                from "4125 Chestnut HoldCo Pay Schedule_v3.xlsx"
"Uno Chestnut" / "Uno on Chestnut"    the property/reporting name in current use
"Solo Chestnut" / "4125 SOLO"         the earlier name, still in the Lument forms
```

An **Interest Holder LLC** is characteristically an upper-tier entity, not the
property-owning borrower. Do not assume it is the obligor.

**Do not create a debt-specific borrower table.** Per the charter, borrower
identity uses `legal_entities` / `legal_entity_properties`. Those exist
(migration 164) — but `relationship_type` is constrained to
`owner | operating_entity | other`. **There is no `borrower`.** That is a real
schema touch in Phase B, and it is the one place 164 does not already fit.

**Lender identity:** Lument is a servicer and possibly not the note holder;
agency loans are routinely serviced by one party and held by another. Whether
"lender" and "servicer" are one field or two is a Phase B question the original
note answers and this schedule does not. Text is acceptable in V1 per the
charter; do not reach for `vendors`.

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

### 7.1 There is no monthly debt service number

The charter's own product goal asks Ask Spine to answer *"What's our monthly debt
service?"*, and the first screen sketch has a `Monthly Debt Service $___` tile.

**The source's `Payment Amount` field is blank, and the structure explains why.**
On actual/360 the payment is not level: interest alone ranges $63,760 – $79,790
across the schedule, and total payment varies every single month. There is no
governed monthly debt service constant for this loan.

What Spine can honestly say, and each is a different fact:

```text
next scheduled payment          a dated row: interest + principal for THAT period
trailing actual debt service    from lender statements, once read
annual scheduled total          e.g. 2026: $906,247.74 interest + $574,689.06 principal
```

A single `monthly_debt_service` column would force one of these to impersonate
the others. **Recommendation: the standing projection carries `next payment due`
with its date and components, not a monthly constant** — and the conversational
answer to "what's our monthly debt service" names the next payment and its
period rather than inventing an average. This needs a ruling before Phase B.

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

---

## 8. What Phase A still needs before Phase B

```text
1  read Acquisition/ — note, mortgage, loan agreement, closing statement
2  resolve Morrison Street: mezzanine debt or preferred equity
3  read the most recent lender statement — the first OBSERVED balance,
   and the first payment evidence
4  confirm whether Lument escrows taxes and/or insurance
5  confirm the borrower of record from the security instrument
6  rule on §7.1 — how monthly debt service is represented
```

Items 1, 3 and 5 are reads. Items 2 and 4 are reads that may change the model.
Item 6 is the owner's ruling.

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
