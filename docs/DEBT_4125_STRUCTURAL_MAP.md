# 4125 Debt — Structural Map

**PHASE A CLOSED — 2026-08-12.**
**Governing documents visually reviewed by the owner. No further source work.**

Supersedes the pre-binder version of this map (git history holds it). What
materially changed is in §0.

The binder is the **2020 purchase/financing closing set**, with ORIX/Freddie Mac
loan documents. Authority level 1 — executed governing instruments.

---

## 0. WHAT THE BINDER CORRECTED

Three findings changed, and one of them is the reason the posture rule exists.

```text
WAS (pre-binder)                          NOW (governing documents)
────────────────────────────────────────  ──────────────────────────────────────
"Lument" as lender                        ORIX originated; assigned to Freddie
                                          Mac; Lument services. THREE roles.
four guarantors                           FIVE — Joseph Rigazio was missed
"no interest or debt-service reserve"     A $1,110,703 COVID-19 DEBT SERVICE
                                          RESERVE exists.
```

**The reserve correction is the important one.** The pre-binder map inferred no
debt-service reserve from a servicing statement. A reserve funded once at closing
and never billed monthly *cannot* appear on a monthly statement — so the source
was structurally incapable of showing it. This is precisely why "not found in
reviewed sources" must never be written as "absent", and it is now a worked
example rather than a principle.

**And one thing got stronger, not weaker.** Absence of additional debt is no
longer an inference: the Loan Agreement *expressly* marks **Acquisition Loan**
and leaves **Supplemental Loan** and **Cross-Collateralized/Cross-Defaulted Loan
Pool** unchecked. An unchecked box in a governing instrument is positive
evidence, unlike a failed search.

---

## THE STRUCTURAL MAP

### INSTRUMENTS

```text
ONE $28.25MM Freddie Mac first mortgage loan at closing        authority 1

  Loan Agreement: "Acquisition Loan" marked
                  "Supplemental Loan" NOT marked
                  "Cross-Collateralized/Cross-Defaulted Loan Pool" NOT marked
```

Supplemental and cross-collateralized debt are **affirmatively excluded by the
governing instrument**, not merely unfound.

### BORROWER / OBLIGORS

```text
BORROWER     4125 Chestnut LLC                                 authority 1

GUARANTORS   FIVE                                              authority 1
             Kameron Zitelli · Lee Silpe · Asher Shafran
             Joseph Rigazio · Robert Vernicek
```

Rigazio appears on the org chart as non-member manager of 4125 Chestnut Holdings
LLC and was not in its guarantor legend — which is why an org chart (authority 5)
is not a source for who signed a guaranty.

### PARTY ROLES — THREE, NOT ONE

```text
ORIGINATOR / LENDER    ORIX Real Estate Capital, LLC           authority 1
HOLDER / ASSIGNEE      Freddie Mac — security instrument assigned to it
SERVICER               Lument (Lument Real Estate Capital, LLC on statements)
```

**Do not collapse these into one `lender_name`.** The assignment is a dated event,
so party roles are effective-dated for the same reason terms are.

### COLLATERAL

```text
ONE mortgaged property · land described in Exhibit A · FIRST LIEN   authority 1
No cross-collateralized pool identified.
```

### TERM PERIODS — TWO REGIMES IN THE ORIGINAL INSTRUMENT

```text
first payment            2020-09-01                            authority 1
INTEREST ONLY            through 2024-08-01
first P&I payment        2024-09-01
LEVEL P&I                $123,411.40 to maturity
rate                     3.28% fixed
scheduled maturity       2030-08-01
```

**No amendment is required to produce two regimes.** The simple specimen forces
effective-dated terms on day one.

### EXTENSION

```text
NO EXTENSION OPTION EVIDENCED in the original governing package reviewed —
Note · summary · agreement TOC · attached riders · Exhibit B modifications.
```

Stated as evidenced-absence at authority 1, not as "no extension exists": a later
amendment could still introduce one.

### COVENANTS / REQUIREMENTS

```text
Article VI — ordinary borrower covenants                       authority 1
  financial reporting / books and records · taxes · insurance ·
  maintenance · repairs and capital replacements
```

**Categories only.** Ordinary borrower covenants do not justify a covenant-
compliance engine, and no thresholds were extracted or are needed.

### LENDER-CONTROLLED ACCOUNTS — FOUR CATEGORIES

```text
tax imposition reserve                                         authority 1
insurance imposition reserve                                   authority 1
replacement reserve            $1,763 / month                  authority 1
COVID-19 DEBT SERVICE RESERVE  $1,110,703                      authority 1
```

The debt-service reserve is a **data-model input, not a project.** Represent the
minimum debt-linked reserve requirement the specimen forces. **Do not build
Reserves & Escrows.**

Tax and insurance imposition reserves are Debt *requirements*; their balances
remain Tax's and Insurance's funding truth.

### AMENDMENT / MODIFICATION CHAIN

```text
NO POST-CLOSING MODIFICATION ESTABLISHED by this closing binder.
```

The `Agreement for Amendment of Documents` is a **closing** agreement permitting
conforming Freddie-required changes — not a later economic modification.
Exhibit B holds negotiated modifications that were **part of the original Loan
Agreement**.

### OBSERVATION AND PAYMENT SOURCES

```text
Lument monthly billing statement    balance · rate · escrow balances · YTD
                                    latest retained 2025-08-01; no 2026 folder
Lument amortization schedule        120 published rows — a PROJECTION
statement transaction history       payment received + application
ACH auto-draft                      payment initiation is not an operator action
                                    latest payment evidence 2025-07-03
```

### CROSS-DOMAIN CLAIMS IN ONE ARTIFACT

```text
DEBT        principal balance · P&I · rate · YTD · grace · late charge
TAXES       tax escrow contribution + balance   → Taxes funding truth
INSURANCE   insurance escrow contribution + balance → Insurance funding truth
OTHER       replacement reserve contribution + balance
```

Debt does not route these and does not write them.

---

## THE ONLY TWO ARCHITECTURAL CONSEQUENCES

Phase A produced exactly two modelling truths. Not a new phase.

```text
1  EFFECTIVE-DATED TERMS ARE REQUIRED
   forced by the original instrument's IO → amortizing regimes

2  PARTY ROLES MUST STAY DISTINCT
   originator/lender · holder/assignee · servicer
   and effective-dated, because assignment is a dated event
```

Everything else the binder established is **data the model must hold**, not
structure the model must grow.

---

## EXPLICITLY NOT EARNED BY THIS READ

```text
covenant monitoring / compliance engine    covenant EXISTENCE is not permission
Reserves & Escrows module                  a reserve requirement is a field
document-reader / OCR work                 Phase E, scoped later, not now
generic multi-domain router                the artifact is shared; authority is not
SOLO / second specimen                     4125 first, and 4125 is closed
Ask Spine implementation                   the read contract constrains schema;
                                           the conversation comes at H
```

**Phase A is closed. No more binder archaeology.**
Next: freeze the Debt read contract and truth walls, then the smallest historical
schema that serves 4125.
