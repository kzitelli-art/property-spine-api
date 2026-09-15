# PostgreSQL 18.6 migration 194–198 recovery receipt

- Run date: 2026-09-13.
- Product/recovery worktree SHA: `58bde6dd25b912dcb70b38ea068e86e1102bad15` (`Record migration 194 to 198 recovery proof`).
- Recovery source worktree: `C:\Users\kamer\Documents\ChatGPT\Property Spine\tmp\schema195-pg18-run-20260913` (detached at the SHA above during the run).
- Runtime: `C:\Users\kamer\Documents\ChatGPT\Property Spine\tmp\postgresql18-proof-20260913\pgsql`; `postgres --version` and `pg_ctl --version` both reported 18.6.
- Owned cluster: `C:\Users\kamer\Documents\ChatGPT\Property Spine\tmp\schema195-recovery-pg18-20260913`.
- Owned listener: `127.0.0.1:55462`.
- Input database identity: host `127.0.0.1`, port `55462`, user `postgres`, database `spine_proof_71fbd5c925a9d3936ce0da23e2aecbea`; nonce is recorded in `ownership.json` beside this receipt.
- Input fixture source: detached `d15c96816570704228a0a604a7d1673216e61b4a`, real numbered migrations from empty through ledger ceiling 194 (`182` ledger rows).
- Harness command: `node tests/proofs/migration_194_198_release_recovery.db.js`, with `HARNESS_DATABASE_URL` set to the manifest database, matching `HARNESS_NONCE`, `DATABASE_URL` and `NODE_OPTIONS` unset, and the PG18 `bin` directory prepended for the process.
- Result: **52 passed, 0 failed; exit 0**.
- Coverage observed: exact194 input and old physical fingerprint; 195/196/197/198 real lock timeout/refusal and explicit resume paths; full 194→197 failure and resume; clean 194→198 apply; exact198 verify-only/restart; two owned API health starts at the pinned build; no external egress; source-pin, ledger, constraint, index, function, trigger, and hostile pre-196 refusal checks.
- Raw final output: `pg18-recovery-58bde6d-final3-raw.log`.

Retained setup-only first-red logs:

- `pg18-recovery-58bde6d-raw.log`: boundary-created database name used 24 hex characters while the harness requires `spine_proof_<HARNESS_NONCE>`.
- `pg18-recovery-58bde6d-final-raw.log`: Windows CRLF bytes for migration 198 differed from the reviewed LF blob hash; the exact pinned Git blob was restored in the isolated run checkout.
- `pg18-recovery-58bde6d-final2-raw.log`: the boundary marker table was inherited by the cloned exact198 database and conflicted with the helper's unconditional marker creation; the marker was removed from the owned source fixture. The same log also records the missing child `pg` dependency before the ignored local dependency junction was added.

Cleanup: the nonce database was dropped with the PostgreSQL 18 `dropdb` binary; the owned PG18 cluster was stopped with `pg_ctl -m fast`; port 55462 was verified free. No service, persistent PATH, provider, production, Neon, or shared database change occurred. Existing PostgreSQL 17 runtime/processes and the 55461 baseline were untouched. Raw logs and receipts remain under this evidence directory. This is local PG18.6 compatibility evidence, not a claim about Neon or production PostgreSQL 18.6.


A separate owned runtime was observed using the same downloaded PG18.6 binary directory with data directory tmp/current-rr-qb-runtime-20260913/pgdata on port 55464 (postmaster PID 16072); it was not part of this run and was left untouched.
