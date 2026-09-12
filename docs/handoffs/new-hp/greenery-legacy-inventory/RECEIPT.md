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
(bed) → per-row confirm → establish, provided the upload names the parent
apartment exactly as production does (`1325-101`). Every one of the 171
legacy identities survives.** 40 checks, 0 failures, 17 observations, on the
retained production, tracker and workpaper labels. Two things decide the
outcome and neither is code: the export convention, and the reconciliation of
the 107 legacy rows, which stay in the leasable denominator and halve every
occupancy figure until a reviewed path exists.

## The shape (retained labels, no ids)

The fixture is built from QB's read-only production read
(`tmp/greenery-legacy-space-shape-20260912.json`), the current tracker
labels (Greenery 2026–2027 RR, D9:D113) and the August 31 workpaper
hierarchy, embedded as non-PII label lists in the proof:

- 64 prefixed parents `1325-101` … `1325-416`; 89 suffixed legacy rows
  (`101 - 1`, `114 - C`, `301 - B`, `401 - 3` …); 18 unsuffixed legacy rows
  (`103`, `104`, `208` …). One `(whole unit)` placeholder each, no
  position kind, no use, no lineage, no organization, basis unknown.
- 105 tracker positions under the 64 parents: 41 two-label (A/B), 23
  single-label, five of them A-suffixed (208A, 308A, 404A, 408A, 414A).
- Unit-type codes per parent from the workpaper: STU00011 (41), STU00012
  (12), STU00010 (11).
- Source rent roll, convention A: `Unit` = `1325-NNN`, `Room` = tracker
  label, `Type` = workpaper code, 84 occupied and 21 vacant.
- A second same-shaped property receives the same rows in **convention B**
  (`Unit` = bare stem `101`, `Room` = `A`/`B`, blank for singles), read but
  never confirmed.

## Before and after

| Read | Before | After establishment |
|---|---|---|
| units | 171 | 171 (none created, none removed) |
| spaces | 171 placeholders | 212: 105 beds (every tracker label), 107 legacy placeholders |
| leases / opening positions | 0 / 0 | 84 / 1 |
| source lineage rows | 0 | 105, none on a legacy row |
| availability by state | 171 occupancy_unknown | 84 occupied, 21 use_not_configured, 107 occupancy_unknown, 0 marketable |
| occupancy by basis | unavailable (basis unsupported) | basis bed, 84 occupied of **212 rentable**, 39.6% |
| canonical rent roll totals | — | inventory 212, leasable 212, occupied 84, pct **39.62**, unresolved_positions 107 reported beside |
| leaseable-units | — | 0 eligible (no governed use type) |

Placeholders are represented, not hidden: every legacy row stays
`occupancy_unknown` in availability and is counted under
`reported_beside.unresolved_positions` in the rent roll. Each parent's
pristine placeholder was consumed into its first tracker label (row identity
preserved) and the second label was created where the tracker has one.

## Findings

1. **Denominator inflation.** Occupancy by basis and the canonical rent roll
   count the 107 untouched legacy placeholders as rentable / leasable. The
   source establishes 105 positions with 84 occupied (80%); the property
   reports 39.6%. The rent roll does say 107 are unresolved beside the number,
   but the headline percentage, and any owner or lender read derived from it,
   is computed over 212. Reconciling or excluding the legacy rows is not a
   nicety; it gates every occupancy figure at Greenery.
2. **No door reconciles a legacy row.** There is no product action that
   marks `114 - 1` as the same position as `114A`, retires it as superseded,
   or excludes it from the denominator with a reason. The mapping tool only
   classifies use; Deal Setup only adds what the source names. Until a
   reviewed correction path exists, the 107 rows remain unresolved.
3. **The export convention decides the inventory.** The tracker names
   homes `101A`, `102`, `103` with no `1325-` prefix. Read as-is (convention
   B, bare stem in `Unit`), the reader matched no prefixed parent at all: it
   created 46 **new** units for the stems that have no legacy row of that
   exact text (217 units on the probe property) and landed the 18 unsuffixed
   stems on the legacy rows `103`, `104`, `208` … rather than on their
   parents. Read with the prefixed parent in `Unit` (convention A) it
   materialised exactly 105 beds under the 64 parents and touched no legacy
   row. The reader matches `unit_number` text; nothing in it knows that `101`
   and `1325-101` are one apartment. Whoever prepares the Greenery upload
   must add the prefix, or the establishment is wrong in a way no later
   read will flag.
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
6. **Classification refuses honestly.** The reviewed mapping tool refuses
   the three workpaper codes (STU00010, STU00011, STU00012) because no
   Greenery ruling block covers them, and writes nothing. An owner-approved
   block is required before any bed can become offerable.
7. **Repeat behaviour is safe.** Re-reading into the established setup is
   refused (`setup_not_open`); re-uploading the identical file returns the
   same artifact; a second setup can be opened after establishment (the
   correction path by design) but reading the same file into it is refused
   (`already_established_from_this_file`). Inventory, leases and the position
   did not change.
8. **A-suffixed singles.** Each established exactly one bed; no B bed was
   inferred.
9. **QB's label comparison reproduces.** Under the narrow textual rule, 102
   legacy rows correspond to a workpaper room, five do not (`102 - 2`,
   `114 - C`, `214 - 2`, `301 - B`, `401 - 3`) and three source rooms have no
   candidate (`1325-102/Room1`, `1325-301/Room2`, `1325-401/Room2`).
   Computed, not written; correspondences are proposals for the recognition
   authority, not identity mappings.

## Decisions required before production establishment

- **Organization custody** (finding 4): one client for both properties or
  two, decided before the super-admin door runs for Mike.
- **Reconciliation of the 107 legacy rows** (findings 1, 2, 9): for each,
  same-as-an-established-bed, surplus, or unknown. The five unmatched labels
  and the two count differences at 114 and 214 cannot be decided from text.
  This needs a reviewed correction path in the product or an authorised
  repair write; neither exists in the released source.
- **Export format** (finding 3): the upload must carry the prefixed parent
  (`1325-NNN`) in the unit column and the tracker label in the room column.
  The tracker as it stands does not.
- **Unit-type vocabulary** (finding 6): the codes the workbook carries and
  an owner-approved ruling block.

## First failing request

None. Every governed request on this chain succeeded on the unmodified
source. The failures are of meaning, not of mechanism: the establishment is
correct for the rows it is given, the reads that consume it count rows it
never touched, and the row it is given depends on a prefix nobody has yet
agreed to add.

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
node tests/proofs/greenery_legacy_inventory.db.js      # 40 passed, 0 failed, 17 observations
node tests/verify_source_governance.js                 # passed
node tests/e2e/proof_boundary.js cleanup
```

Cleanup: the owned database was dropped after the run; `spine_proofs`
untouched. No production connection string was used.
