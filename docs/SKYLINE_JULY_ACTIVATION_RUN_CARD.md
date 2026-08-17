# Skyline — July 31 activation run card

**Status: PREPARED, NOT EXECUTED. Blocked on one thing only — positive evidence
that Render booted a build containing `bb89c15a`.** 2026-08-17.

Every figure below is frozen from a local dry run on the real artifacts
(`tests/skyline_production_rail_dry_run.db.js`, 28/28). It is an **expectation
for production, not evidence about it.** A production number that disagrees
with this card is a finding to report, not a number to adjust.

---

## 0 · State at freeze

```text
PRODUCTION (owner-verified, not readable from the build container)
  migration ceiling        181
  Skyline property         14e41b7c-e91c-49e8-9651-10c4908a8f6a
  current units             72
  current spaces           160
  whole-unit phantoms         0
  live retirements          159   lineage preserved 159/159
  leases on retired           0
  active leasing cycles       0
  Skyline activations         0
  July-31 import batches      0        ← pristine for this run

CODE
  origin/main              28ca94a691b40bfade32987d9bf53b9300172053
  first parent             bb89c15a15163fa1731e5f0dabeda9ec2db0798d
  proven head              0299570d64404f03a76074234c0db70281fef466
                           tree IDENTICAL to bb89c15a — the proofs cover
                           main's content exactly
```

### The migration timing, corrected

An earlier reading of this card's author claimed current main could not boot
because 181 was pending. **That was wrong.** From the live sources:

```text
181 applied      2026-08-17 14:09:29Z
28ca94a merged   2026-08-17 14:09:48Z
```

181 was live **19 seconds before** the merge existed. There was never a
pending-181 boot condition for it. The error was inferring a boot state from
file presence without the applied-at timestamps.

---

## 1 · The one gate — is the deployed build new enough?

```text
REQUIRED   deployed build contains bb89c15a…   (preferably 28ca94a…)
           health green
           migration ceiling 181
SOURCE     Render dashboard → Events, or the Render API
IF OLDER   STOP. Loading July through the pre-grain-fix loader recreates all
           72 surplus placeholders and undoes the production correction.
```

**No probe in the app can answer this.** `/health` returns `{ok, db_time}` —
no SHA, no ledger ceiling. Recorded as an observability gap for the next
release, deliberately **not** built now: a probe that needs a deploy to exist
cannot establish what happened before it existed.

**Do not create a scratch production property to infer the build.**

---

## 2 · The artifact

```text
d657f655-RentRoll07_1417.xlsx
sha256     51ae5893b43a80308f88696156e9538972e8ea0212900f1fd71c5a068caa9f4a
bytes      40,859
As Of      07/31/2026 · Summarize By = Room · 72 units · Room1/Room2/Room3
```

Hash-verified in-harness, not by filename. The same document is retained in
SharePoint at `Asset Management Workspace / - Accounting / 5.0 GPR / 07.July /
RentRoll07_1417.xlsx`, so the source is not institutionally lost — the
connector's byte transfer is what is broken. Two connector attempts delivered
**zero bytes** (`e3b0c442…b855`, the SHA-256 of the empty string).

**Do not substitute another workbook.** A third file offered during this lane,
`1417_North_15th_Street__2026_07_29.xlsx`, is sheets `Sizing | UW ANALYSIS |
T-12 Input` — a loan-sizing model. Right building, wrong document class.

After `source_artifacts` accepts the bytes, re-read and require:

```text
sha256     51ae5893b43a80308f88696156e9538972e8ea0212900f1fd71c5a068caa9f4a
byte_size  40859
kind       rent_roll
```

Any difference → STOP.

---

## 3 · THE FROZEN EXPECTED RECEIPT

```text
BEFORE EVIDENCE
  units                             72
  spaces                           160
  whole-unit phantoms                0

JULY EVIDENCE LOAD
  placeable evidence rows          251      ← NOT 285
  positions                  160 → 160
  spaces added                       0
  placeholders recreated             0
  retired provenance writes          0
  discrepancies                      0

TRACKER
  promoted                           0
  Signed                           140
  Pending                            4
  Signed & Pending                 144
  Remaining                         16
  Preleased                      90.0%

  Signed Rent                 $113,687
  Pending Rent                  $3,500
  Total Rent                  $117,187
  Remaining at Asking          $13,345
  Projected GPR               $130,532 / mo

  Needs Review                       2
  decomposition   144 = 0 contractual + 142 claimed-only + 0 missing
                      + 2 bed-match-needed
```

### 251, not 285

285 is the raw grid row count of the workbook. **251** is the rows carrying a
unit that the loader can place. Both describe the same file. If production
reports 285 produced-position evidence rows, something placed rows that should
not have been placed.

### ⚠ Do NOT expect `headline.remaining = 160`

The dry-run harness built the corrected inventory with **zero leases**;
production carries historical lease evidence the harness never recreated. So
`headline.remaining` — Spine's *lease* view — reads 160 in the harness and will
read something else in production, legitimately.

**The invariant at the evidence rung is that the physical denominator stays
160.** It is not that every leasing projection equals the zero-lease harness.
The acceptance figures above come from the tracker overlay and are unaffected.

---

## 4 · Sequence, once the build is confirmed

```text
retain exact July bytes in source_artifacts
→ verify stored sha256 + 40,859 bytes + kind
→ ingest July evidence through the EXISTING activation path
    artifact → ingestRentRoll → loadLedgerSnapshot → proposals
    no production-only loader
→ prove 160 → 160 · 251 rows · 0 discrepancies   (before confirming anything)
→ reconcile/confirm July proposals
→ establish cycle 2026-27   2026-08-01 → 2027-07-31
→ stage Mike's tracker through stageTrackerClaims   promoted MUST be 0
→ reactivate the EXISTING KZ → Skyline assignment
    1b8527af-7ba2-4dd8-af7b-cf2f51e8c794   active false → true
    through the governed team-access writer; do not mint a duplicate
→ production browser proof + Ask Spine
```

### What may not be manufactured to reach 144

```text
missing lease date    stays missing
unresolved Person     stays unresolved
source disagreement   stays a visible disagreement
unknown rent          stays blank
```

The two malformed identity rows and the 416A rent disagreement are **hostile
controls**. They are expected to survive as `needs_review: 2`. They do not get
cleaned up to make totals work.

If July evidence materially contradicts the frozen leasing basis, STOP and
report the exact rows before changing any rule.

---

## 5 · Release-time reminders that have each cost time here

```text
release from a CLEAN checkout   the sha pin refuses a modified tracked tree
                               and names the files
read the ledger LIVE           never from a document, including this one
Mike has no staff user         KZ is enough to prove the production path;
                               Mike onboarding is a separate item
```

---

## 6 · Provenance of every number on this card

```text
tests/skyline_production_rail_dry_run.db.js    28/28   the frozen receipt
tests/ledger_grain_reconciliation.db.js        35/35   grain rule, 5 cases
tests/import_retirement_resolution.db.js       24/24   retired-inventory seam
tests/inventory_retirement.db.js               45/45   391 → 319 → 160
tests/surplus_placeholder_repair.db.js         28/28   the 72
verify_source_governance.js                    35/35 gates
```

None of it is evidence about the deployed system. The next red worth caring
about is a production disagreement.
