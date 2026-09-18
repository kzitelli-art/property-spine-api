# Merge ruling — integrating the deployed line, 2026-09-18

Binding on whoever performs the next merges. Written before the merge, not after,
because the row-reference hazard below produces a document that reads correct and
states something false.

## Standing decision from the owner, tonight

**No push to `main`.** Everything chains on owned branches; the owner takes one
fast-forward in the morning. The integration line is
`claude/main-integration-20260918`.

## Verified facts (measured on this tree, not assumed)

| claim | measurement |
|---|---|
| The deployed line and the integration line have genuinely diverged | 37 commits the deployed branch has that integration lacks; 48 the other way. It was a fast-follow against the board alone; the `determined-dirac` merge ended that. |
| Migration 199 is not in the integration line | `53522e94` (which adds `199_property_display_name_command.sql`) is an ancestor of the deployed branch and **not** of integration. |
| The integration line tops out at migration 198 | integration 198 / 187 files · `determined-dirac` 198 / 187 · deployed 200 / 189. Production's ledger is at 200. |
| So the integration line is **not deployable** in the sense a reader would assume | `migrate.js` verify-only checks files ⊆ ledger, so a 198-file build starts against a 200 ledger. It starts; it is not the deployed schema. Do not let a green CI run on this branch be read as deploy-readiness. |
| `institutional-bucket-truth` needs no merge | it is an ancestor of `determined-dirac`, already integrated. |
| `codex/property-identity-cleanup` is docs-only **beyond the deployed line** | 9 of its 12 commits are already in the deployed branch (including `53522e94` and `3b92d652`); the 3 that are not are all `Record …` commits. |
| `claude-opus/deal-reconciliation` touches no product code | 0 files under `src/`, `migrations/`, `server.js`; 1,194 insertions, all docs. It is a BUILD_CONTRACT whose work items require owner-authorised production writes. |
| `claude/new-build-git-setup-o5l93r` must **not** be merged | 134 files, 19,097 deletions against the integration line. It is a separate artefact on a much older base, not a lane. Flagged for the owner. |

## THE HAZARD, and the rule that governs it

The deployed branch's own `CURRENT_STATE` rows are **85-90** (the shared base,
board `2aab0db5`, tops out at 84). Those rows cross-reference each other by
number — twelve references in total:

```
row 86 → row 87 (×3, one as "SUPERSEDED IN PART BY ROW 87")
row 87 → row 86
row 88 → row 87, and "SUPERSEDED BY ROW 90"
row 89 → rows 87-88 (×2), and "SUPERSEDED BY ROW 90"
row 90 → "rows 84-89 are live", row 86
```

The integration line already occupies 1-110. A plain renumber of 85-90 to the
tail leaves every one of those references pointing at a row that exists and is
about something else. The references do not dangle — **they resolve, and lie.**
Concretely, on the integration line today:

- integration row 87 reads *"FOUND, NOT FIXED — `main` and the deployed line have forked"*
- integration row 88 reads *"MEASURED, NOT CHASED — 96 files hardcode `ssl: { rejectUnauthorized: false }`"*
- integration row 90 reads *"date-column timezone fix, DB-proven in two timezones"*

So an unrewritten renumber would publish *"rows 84-89 are live, production-verified"*
pointing at rows that themselves say **not fixed** and **not chased**, and would
claim the retention hardening was *"superseded by"* a timezone fix. That is
precisely the confidently-wrong state document this file exists to prevent, and
it is worse than a visible breakage because nothing looks wrong.

**THE RULE, in four parts:**

1. **Compute the offset at merge time**, from the integration line's actual
   highest row — not from 110, which will move if another merge lands first.
   Deployed rows 85-90 become `top+1 … top+6`.
2. **Rewrite every reference inside the moved block by the same offset**, in all
   its spellings: `row N`, `Row N`, `ROW N`, `rows N-M`, `rows N–M` (en dash and
   hyphen both occur).
3. **Do NOT offset a reference to a row ≤ 84.** Rows 1-84 are shared lineage and
   still carry the same content in the integration line, so those references are
   already correct. Row 90's `rows 84-89` is a range that **spans the boundary**
   and cannot be offset mechanically — rewrite it as prose naming row 84 and the
   moved range separately.
4. **`ledger_rows 188` in row 90 is NOT a row reference.** It is a ledger row
   count (`ceiling 200 · ledger_rows 188 · column 1 · constraint 1 · index 1`).
   A regex sweep for `rows \d+` matches it. Leave it alone.

The precedent this follows: the `determined-dirac` merge kept dirac's numbers
and moved the four rows that had no internal references, because dirac's 84-105
cross-reference each other. Here **both** sides have references, so keeping both
sets of numbers is impossible and rewriting is mandatory rather than optional.

## Merge order, revised by containment

1. ✅ board `2aab0db5` → `773e2b4a` (CI 659 green)
2. ✅ `determined-dirac` → `e8cbebc3` (CI 661 green; repairs the deployed
   lender-label regression — see row 106)
3. `claude/ci-ledger-200-20260918` — the deployed line **plus** the ledger
   rehearsal fixes. Merging this branch rather than the deployed branch itself
   is deliberate: it is the only version of that line whose CI ledger rehearsal
   is honest at ceiling 200. **This is the merge the hazard above governs.**
   On the institutional surface, resolve toward the integration line
   (dirac's `statusLabel`); never toward `bucket_label`-first.
4. `codex/property-identity-cleanup` — docs only once (3) has landed.
5. `claude-opus/deal-reconciliation` — docs only; its contract needs owner
   authorisation before any work item is executed.
6. App-repo branches, separately.
7. `claude/new-build-git-setup-o5l93r` — **do not merge.** Owner decision.

## Owner decisions this raises

- Migrations 199 and 200 are live in production and were released outside the
  pinned, rehearsed path the 195-198 wrapper established. Pinning them
  retroactively is queued; it does not undo the fact that the release happened
  unrehearsed.
- The BUILD_CONTRACT in (5) specifies production writes to property display
  names, the deal registry and access assignments. None may be executed without
  the owner saying so, per the standing constraints.

---

## Dry run of merge (3), performed and aborted before this was written

The deployed line was merged with `--no-commit`, inspected, and `--abort`ed.
Result: **exactly two conflicted files**, one hunk each.

| file | resolution |
|---|---|
| `docs/CURRENT_STATE.md` | the row hazard above. Follow the four-part rule. |
| `tests/e2e/app_pin.txt` | decided below. |

### ⚠ THE FILE THAT DID *NOT* CONFLICT IS THE ONE TO CHECK

`src/surfaces/rent_roll_institutional.js` **auto-merged with no conflict**, even
though both sides rewrote `statusLabel`. A clean auto-merge of a function two
branches both edited is exactly the case where a blend can appear with nothing
to warn you: reintroducing `if (r.bucket_label) return r.bucket_label;` as an
early return *alongside* the qualifier logic would restore the regression
silently, and no conflict marker would exist to notice.

**Verified by reading the merged result, not by the absence of a conflict:**

```
if (r.bucket == null) return "Occupancy Unconfirmed";
const base = r.bucket_label;
const qualifiers = [];
... bucket === "occupied" && contractual_terms_state === "not_established" -> "terms not established"
... bucket === "occupied" && economics_state === "unavailable"             -> "rent unavailable"
... bucket === "needs_review" && tenancy_state === "contested"             -> "overlapping leases"
... is_down                                                               -> "unit down"
return qualifiers.length ? `${base} — ${qualifiers.join(" · ")}` : base;
```

Early `bucket_label` return: **0 occurrences**. Qualifier pushes: **4**. Dirac's
version survives whole.

**Re-run this check on the real merge.** It is cheap and it is the only thing
standing between a clean-looking merge and a lender surface that calls an
unverified bed "Occupied".

A fifth thing dirac fixed, catalogued here because it was not in row 106: a
physically down bed buckets as `open` and printed a bare **"Open"** — i.e.
offered — so `is_down` now appends "unit down" as a qualifier rather than being
swallowed by the bucket.

### `tests/e2e/app_pin.txt` — RESOLVE FORWARD

Both pins are on the **same app branch**, `claude/determined-dirac-qcvj5v`:

| side | app sha | note |
|---|---|---|
| integration (from dirac) | `312a9992` | the pin dirac froze CI green against |
| deployed line | `2e8199a4` | 2026-09-17, *"prove the panel is reachable in the real page, not just in the test"* |

**Take `2e8199a4`.** It is not a rival pin, it is a forward move on the same
branch, and the merged API is a superset of the deployed line that app was
exercised against. Pinning the older app against newer API code is the riskier
direction.

This is a pin move, so it is the QB's to make and it is stated here rather than
made silently. If a browser rung fails on it, that failure is a real signal
about app/API coupling and must be diagnosed, **not** resolved by reverting the
pin to make the suite green.

### Not production pins

`app_pin.txt` governs which app CI checks out for the browser rungs. It is not a
release claim and has nothing to do with the deployed app (`6f92b50`). Do not
conflate them.
