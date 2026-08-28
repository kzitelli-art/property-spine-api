# Release run card — migrations 162 + 163, and the Insurance surface

**Written by the thread that built them. It could not run any of it:**
outbound to `onrender.com` is blocked by this container's agent proxy
(`CONNECT tunnel failed, response 403`, measured on both `/health` and a
never-existed control path), and no `DATABASE_URL` is present. Every value
below that a machine could read from source *is* read from source and
labelled as such. Every value that requires production is left as a slot to
be filled at the console, deliberately.

---

## 0 · What is being released

```text
162_insurance_coverage_participation.sql   participation + backfill + FK
163_insurance_funding.sql                  funding arrangements, finance,
                                           escrow, artifact kinds
```

**Read from source, not remembered:** `origin/main` carries migrations up to
**161** and nothing above it. The branch carries **162** and **163** and
nothing else above 161. So after merge the pending set is exactly those two.

⚠ **A release applies EVERY pending file.** There is no per-file selection in
`migrate.js`. Re-confirm the pending set against production at the time —
if the ledger is below 161 for any reason, this release sweeps in more than
these two and the ceiling below is wrong.

## 1 · The trap this card exists to avoid

**A deploy does NOT migrate.** `prestart` runs `migrate.js` in verify-only
mode and the service **refuses to start** while any migration file in the
build is absent from the ledger. Render then keeps the previous instance
live — so the API looks healthy while running older code. This has cost time
three times.

**API auto-deploy is ON. APP auto-deploy is OFF.** Opposite postures. The
sequence depends on both.

**The invariant:** the migration-release boot must be the FIRST boot of the
merged SHA that is allowed to succeed.

## 2 · The sequence — Path A, as ruled for 160/161

```text
 0  Review only. THERE IS NO CI in either repo. No green check is coming.
    The suite results in §5 are the evidence, produced locally.

 1  PAUSE API auto-deploy.

 2  READ the production ledger. Do not type a remembered number:
        node migrations/migrate.js          (no --apply — verify only)
    Record the ceiling it prints.  EXPECTED: 161
    Confirm both directions clean (file → ledger, ledger → file).

 3  MERGE the API branch.

 4  READ the resulting `main` SHA. ⚠ NOT the PR-head SHA.
    A squash or a merge commit both produce a NEW commit. They coincide
    only under fast-forward, and coinciding by luck is not being correct.

 5  CONFIRM the pending set is exactly:
        162_insurance_coverage_participation.sql
        163_insurance_funding.sql

 6  SET on the API service:
        MIGRATION_RELEASE=1
        EXPECTED_LEDGER_CEILING=<what step 2 printed>
        EXPECTED_SHA=<the SHA from step 4>

 7  MANUALLY DEPLOY that exact SHA. ← this deploy IS the release boot.

 8  CAPTURE the receipt:
        162 applied · 163 applied
        new ledger ceiling = 163
        file → ledger clean · ledger → file clean
        running SHA == expected SHA

 9  DELETE MIGRATION_RELEASE.

10  NORMAL redeploy. Confirm a clean boot with nothing pending.

11  RESUME API auto-deploy.

12  MERGE the APP branch, then MANUALLY DEPLOY it — app auto-deploy is OFF.
```

### ⚠ 162 IS SELF-SAFE. 163 IS NOT ORDER-SENSITIVE.

162 backfills participation from any existing allocations **before** adding
the foreign key, so it does not depend on the allocation table being empty.
Proven against a populated table, not assumed. If production somehow holds
allocations, they are carried, attributed to whoever confirmed them.

## 3 · The production pass — what actually closes this

Schema released is **not** the same claim as surface proven. Say them apart.

A real operator, with a real staff session, at a property with the
`asset_management` module, using an **actual policy and an actual finance
agreement**:

```text
□  Asset Management card appears on Home
□  Property Expenses → Insurance opens
□  ADD CURRENT INSURANCE → upload the real policy PDF
□  the review sheet says whether Spine read it, and every field it did
   not read is BLANK
□  confirm → the dashboard populates from what was entered
□  if the policy states no share for this property:
      COVERAGE STACK   established, "Share not established" on the row
      ECONOMIC POSITION not established, the missing share named
      ANNUAL COST      "Not established" — never a dash, never a zero
□  standing reads CURRENT (or the right window) for the real dates
□  ADD PAYMENT / FINANCING → the real finance agreement
□  Cash & Financing shows provider, installments, finance charge
□  PAYMENT names the mechanism
□  ⚠ THE ONE THAT MATTERS: ANNUAL COST and MONTHLY ACCRUAL are the SAME
   before and after recording the financing. If financing moved either
   number, stop and report it — that is the defect the whole build exists
   to prevent, and no test failing is worth less than this passing.
□  the screen looks like docs/release/insurance-screenshot reference
```

**⚠ If the surface misbehaves, INSPECT THE DEPLOYED APP SHA FIRST.** App
auto-deploy is OFF; a stale app is a likelier cause than anything in the
schema.

### Still open from earlier releases, and not closed by this one

```text
159   established Deal Setup property → "Lease & occupancy established"
      genuinely unestablished property → still unestablished
160/161  Insurance rendering governed truth has NEVER been seen on a
      production page by an entitled account. Only the fail-closed
      direction (401 / 403) is production-proven.
```

That last line is why this pass matters more than usual: it is the first
time any of this surface will have been seen working in production.

## 4 · Known blockers that are not schema

From the 160/161 closeout, still true:

- **TEAM cannot make live permission changes** — `__OFFLINE_MODE` is
  unconditional and its invite POST cannot reach the API. There is no
  in-product path to grant the `asset_management` module to an existing
  person. Granting goes through `PATCH /property-team-assignments/:id`
  with the operator key.
- **Three distinct properties are named "Solo on Chestnut."** Resolve by
  id, never by name. The operating one is
  `a50fbdd0-3642-431e-b532-0dcd6ab8a4fe`.

## 5 · Evidence at the SHA being released

```text
API  branch head 53edb5d
     tests/proofs/insurance_establishment.db.js   141/141   real PG + real HTTP
     tests/proofs/insurance_truth.db.js            52/52
     tests/proofs/asset_management_shell.db.js     46/46
     npm run verify                         14/14    (unshallowed first)

APP  branch head 4390db3
     asset_management_shell.browser.js     171/171   real Chromium
     run_harnesses.sh                      1041 passed · 0 failed · 0 red
```

⚠ `npm run verify` silently runs a SUBSET on a shallow clone. Check
`git rev-parse --is-shallow-repository` before believing a green run.

**What is NOT proven:** anything in production, and PDF bytes → text
(that is server.js's existing `fileToText`, injected rather than
reimplemented; the label scan over its output is proven directly).
`tests/proofs/deal_setup_http.db.js` could not run here — it needs the full
schema, which cannot rebuild from empty (`012_bank_intake` / `yardi_code`).
That predates this work.
