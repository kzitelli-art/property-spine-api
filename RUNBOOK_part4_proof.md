# PART 4/5 — BRANCH-WORKTREE PROOF RUNBOOK (prove before deploy)

Real prove-before-deploy: the branch runs in an **isolated worktree** in the Render
shell against the live schema, rollback-only. **Nothing reaches auto-deploying `main`
until the proof is green.** Only then do we merge the exact proven SHA.

Runtime deploy set (4 files): `leasepackets.js`, `applications.js`, `operator.js`, `server.js`.
Proof infra (not a runtime dependency): `tools/proofs/proof_part4_packet_services.js`,
`tools/proofs/verify_085_ledger.sql`.

---

## STEP 0 — stage on a non-deploy branch (from freshly pulled main)

Create branch `proposed-terms-part4` off current `main`. Put the 4 runtime files at
repo root and the 2 proof files under `tools/proofs/`. Commit. **Do not merge to main.**

Record for the evidence package:
```
base main SHA        : <fill>
branch SHA           : <fill>
blob SHA per runtime file:
  leasepackets.js    : <fill>
  applications.js    : <fill>
  operator.js        : <fill>
  server.js          : <fill>
```

## STEP 1 — operator-app legacy-path grep (authoritative test)

In the **property-spine-app** checkout:
```bash
git grep -nE '/applications/.*/lease-packet|/lease-packets/.*/send|lease-packet|lease-packets' -- index.html || echo "CLEAN: no legacy-path callers in app"
```
Clean result closes the frontend-caller concern. A hit → STOP, tell the thread before merge.

## STEP 2 — ledger + schema verification (Neon SQL editor)

Run `tools/proofs/verify_085_ledger.sql`. Confirm all five PASS criteria at its foot.
If any fails, STOP — the schema the services assume is not live.

## STEP 3 — isolated worktree in the Render shell

```bash
git fetch origin proposed-terms-part4
git worktree add /tmp/ps-part4-proof origin/proposed-terms-part4
cd /tmp/ps-part4-proof

# A fresh worktree has NO node_modules (gitignored). Symlink the deployed deps
# so require("pg") + app modules resolve. Find the deployed checkout's path first:
#   find / -maxdepth 6 -name node_modules -type d 2>/dev/null | grep -i project | head
# then (adjust path):
ln -s /opt/render/project/src/node_modules /tmp/ps-part4-proof/node_modules

node --check leasepackets.js
node --check applications.js
node --check operator.js
node --check server.js
node --check tools/proofs/proof_part4_packet_services.js
```

All five must print OK (harness prints nothing on success from --check; no error = OK).

> Fallback if the symlink path is wrong: run the branch files from the DEPLOYED
> checkout without committing — `git checkout origin/proposed-terms-part4 -- <the 4 files> tools/proofs/`,
> run the harness, then `git checkout HEAD -- <the 4 files>` to restore. Render deploys
> on push to main, not on a working-dir checkout, so this never deploys — but prefer the
> worktree+symlink so the live working dir is never touched.

## STEP 4 — run the real-module rollback-only proof

```bash
cd /tmp/ps-part4-proof
node tools/proofs/proof_part4_packet_services.js
```

The harness:
- constructs `require("../../leasepackets")({...})._service` from the STAGED branch files
  (throwing stubs for satisfy/completeObligation — those deps must not be touched);
- runs schema preflight (aborts on drift);
- runs G1–G4, I1–I5, A1/A1b/A2/A3 — **every case begin → … → ROLLBACK**;
- commits NOTHING.

Expected tail: `ALL PASS — packet services proven against production schema (rolled back).`

If red: capture output, fix on the branch, re-run. Do not merge.

## STEP 5 — confirm zero persisted fixtures (belt-and-suspenders)

The harness rolls back every case, but verify nothing leaked (e.g. from an aborted run):
```sql
select count(*) from lease_applications where applicant_name = 'Proof Applicant';   -- expect 0
select count(*) from persons where name = 'Proof Applicant';                        -- expect 0
```

## STEP 6 — merge the EXACT proven SHA, deploy, verify deployed SHA

Merge `proposed-terms-part4` at the exact commit that passed. After Render deploys (~2 min):
```bash
# in the deployed shell
git rev-parse HEAD   # must equal the proven branch SHA
```

## STEP 7 — Part 5 live HTTP smoke (from the Render shell)

New generate path:
```
unauthenticated                       → 401
valid session, wrong property/authority → opaque refusal (code only)
valid session, governed application    → draft packet (200)
```
New issue path:
```
valid session                         → raw link once
same actor + key retry                → already_issued, no token
different key after issue              → 409 packet_link_already_issued
```
Legacy write paths:
```
POST /applications/:id/lease-packet   → 410
POST /lease-packets/:id/send          → 410
```

I'll write the exact curl smoke once the branch proof is green.

## STEP 8 — clean up the worktree
```bash
git worktree remove /tmp/ps-part4-proof
```

---

### EVIDENCE PACKAGE (paste back before merge)
```
[ ] exact branch SHA + base main SHA + per-file blob SHAs
[ ] operator-app legacy-path grep: CLEAN
[ ] verify_085_ledger.sql: all 5 PASS criteria
[ ] four runtime node --check passes
[ ] harness node --check pass
[ ] harness: schema preflight PASS
[ ] harness: G1–G4 PASS (no skips)
[ ] harness: I1–I4 PASS
[ ] harness: I5 forced-audit-failure atomicity PASS (status/token/identity/audit all clean)
[ ] harness: A1/A1b/A2/A3 PASS (A2 NON-SKIPPED)
[ ] zero persisted fixture rows (STEP 5)
```
```
NOTE on I5 scope: the harness fails the audit insert via a query-proxy, then rolls back
to a savepoint and proves no partial issuance survives. A real audit failure in prod
aborts the tx and the adapter's full catch→rollback erases everything — strictly stronger
than what I5 asserts. I5 is therefore a valid lower bound on the atomicity guarantee.
```
