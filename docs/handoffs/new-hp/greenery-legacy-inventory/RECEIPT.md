# Greenery legacy-inventory establishment rehearsal — receipt (2026-09-12)

Returned to HP QB. Proof-only: one proof, one runner line, this receipt and
scrubbed evidence. No product source changed. No production read or write, no
provider action, no deployment, no merge, rebase, reset or force push. Owned
nonce-verified database from the real migration chain (ceiling 194 / 182
rows) and an owned server of the unmodified tests-only successor
`8cf5078752e62785d239f5721e735fcadb64ec37` (product source equal to live
`b4a494c`). Isolated worktree and branch
`claude/greenery-legacy-inventory-20260912`. Doctrine read: `CLAUDE.md`,
`docs/PHILOSOPHY.md`, `docs/DB_HARNESS_ISOLATION.md`, relevant
`docs/CURRENT_STATE.md` entries. No SQL after any business action.

## What was asked and what was found

Can the existing owners take The Greenery from the shape the production read
found (171 legacy unit rows with one placeholder space each, no use, no
lineage, no organization, basis unknown) to an established bed-basis opening
position **without** deleting, merging, retiring or manufacturing anything?

**Yes, through adoption → super-admin provisioning → Deal Setup → read-source
(bed) → per-row confirm → establish. Every one of the 171 legacy identities
survives.** 33 checks, 0 failures, 16 observations. But the establishment
leaves the 106 untouched legacy rows in the leasable denominator, so every
occupancy percentage the property reports afterwards is wrong by a factor of
two until those rows are reconciled, and no door reconciles them today.

## The synthetic shape (assumption, stated)

The exact production labels were not available to this lane (the shape files
are in the workspace). The proof reproduces the counts QB supplied:

- 64 parents: 101–116, 201–216, 301–316, 401–416.
- 105 tracker positions: 41 two-label parents (NNNA / NNNB), 23 single-label
  parents, five of them A-suffixed (208A, 308A, 404A, 408A, 414A), the other
  18 named by the parent alone (rented whole).
- 107 legacy non-parent rows: `NNN - 1` / `NNN - 2` under two-label parents
  except `401 - 1` / `401 - 3`; `NNNA` for the five A-singles; `102 - 2` for
  parent 102; `NNN - 1` for the other plain singles; one extra `NNN - 3` at
  114 and at 214.
- Source rent roll: 105 rows with `Unit` = parent and `Room` = tracker label
  (blank for the 18 whole-rented singles), a `Type` column with two synthetic
  codes, 84 occupied and 21 vacant, plus **one labelled probe row** whose
  `Unit` column carries the legacy room-style label `114 - 3`.

If the real labels differ (for example if parents carry a prefix), the
fixture should be regenerated from the workspace shape file before anyone
reads these numbers as Greenery's.

## Before and after

| Read | Before | After establishment |
|---|---|---|
| units | 171 | 171 (none created, none removed) |
| spaces | 171 placeholders | 212: 87 beds (41×2 + 5 A-singles), 125 placeholders |
| leases / opening positions | 0 / 0 | 84 / 1 |
| source lineage rows | 0 | 106 (105 positions + probe) |
| availability by state | 171 occupancy_unknown | 84 occupied, 22 use_not_configured, 106 occupancy_unknown, 0 marketable |
| occupancy by basis | unavailable (basis unsupported) | basis bed, 84 occupied of **212 rentable**, 39.6% |
| canonical rent roll totals | — | inventory 212, leasable 212, occupied 84, pct **39.62**, unresolved_positions 106 reported beside |
| leaseable-units | — | 0 eligible (no governed use type) |

Placeholders are represented, not hidden: every legacy row stays
`occupancy_unknown` in availability and is counted under
`reported_beside.unresolved_positions` in the rent roll. Parents' pristine
placeholders were consumed into the first named bed (identity preserved) and
the second bed was created; the 18 whole-rented singles kept their placeholder
and received their lease or vacancy at whole-unit grain.

## Findings

1. **Denominator inflation.** Occupancy by basis and the canonical rent roll
   count the 106 untouched legacy placeholders as rentable / leasable. The
   source establishes 105 positions with 84 occupied (80%); the property
   reports 39.6%. The rent roll does say 106 are unresolved beside the number,
   but the headline percentage, and any owner or lender read derived from it,
   is computed over 212. Reconciling or excluding the legacy rows is not a
   nicety; it gates every occupancy figure at Greenery.
2. **No door reconciles a legacy row.** There is no product action that
   marks `114 - 1` as the same position as `114A`, retires it as superseded,
   or excludes it from the denominator with a reason. The mapping tool only
   classifies use; Deal Setup only adds what the source names. Until a
   reviewed correction path exists, the 106 rows are a permanent unknown.
3. **A room-style label in the Unit column lands on the legacy record.**
   The probe row (`Unit = "114 - 3"`) matched the legacy unit by text and its
   vacancy was recorded there, not on parent 114. If the tracker is exported
   with room labels in the unit column, the establishment silently attaches
   positions to the wrong grain. The upload must carry the parent in `Unit`
   and the bed in `Room`.
4. **The super-admin door writes `organization_id` onto the account.** Mike's
   rehearsal account had no organization; the org-admin door refused it (409
   `existing_account_authority_conflict`, as QB ruled) and the super-admin
   door attached it, keeping platform role and person, but setting the
   account's organization to Greenery's. If Skyline and Greenery are
   different clients, the choice of which organization owns Mike's account
   is made by whichever door runs first. Admin-role gates read that column;
   staff routing does not. The organization decision in L01 should be made
   before this door is used.
5. **The admin door writes no person-level assignment.** Mike resolves as
   `not_assigned_here` afterwards. Deal Setup does not need a resolved
   identity; tour hosting and offer authorship do. Known from the earlier
   lane; still true.
6. **Classification refuses honestly.** The reviewed mapping tool refuses the
   two synthetic codes because no Greenery ruling block exists, and writes
   nothing. The real Greenery vocabulary needs an owner-approved block before
   any bed can become offerable.
7. **Repeat behaviour is safe.** Re-reading into the established setup is
   refused (`setup_not_open`); re-uploading the identical file returns the
   same artifact; a second setup can be opened after establishment (the
   correction path by design) but reading the same file into it is refused
   (`already_established_from_this_file`). Inventory, leases and the position
   did not change.
8. **A-suffixed singles.** Each established exactly one bed; no B bed was
   inferred.

## Decisions required before production establishment

- **Organization custody** (finding 4): one client for both properties or
  two, decided before the super-admin door runs for Mike.
- **Reconciliation of the 107 legacy rows** (findings 1, 2): for each,
  same-as-an-established-bed, surplus, or unknown. The two extras (`114 - 3`,
  `214 - 3`), the naming conflicts (`102 - 2`, `401 - 3`) and the
  A/B-to-Room-number equivalence (`301B`) cannot be decided from labels.
  This needs a reviewed correction path in the product or an authorised
  repair write; neither exists in the released source.
- **Export format** (finding 3): the workbook must carry the parent
  apartment in the unit column and the bed label separately.
- **Unit-type vocabulary** (finding 6): the codes the workbook carries and
  an owner-approved ruling block.

## First failing request

None. Every governed request on this chain succeeded on the unmodified
source. The failures are of meaning, not of mechanism: the establishment is
correct and the reads that consume it count rows the establishment never
touched.

## Proof and commands

`tests/proofs/greenery_legacy_inventory.db.js`, registered in
`tests/e2e/verify_all.sh` inside the owned-server block after "greenery
staff onboarding". It needs no per-property allowlist (nothing here captures
an inquiry or births an application) and mints its own property id unless
`PROOF_GREENERY_ID` is supplied. Evidence: `evidence.legacy.json` (ids,
phones, emails scrubbed).

```
node tests/e2e/proof_boundary.js create && ./tests/e2e/apply_migrations.sh
# owned server booted like tests/e2e/boot.sh, then:
node tests/proofs/greenery_legacy_inventory.db.js      # 33 passed, 0 failed, 16 observations
node tests/verify_source_governance.js                 # passed
node tests/e2e/proof_boundary.js cleanup
```

Cleanup: the owned database was dropped after the run; `spine_proofs`
untouched. No production connection string was used.
