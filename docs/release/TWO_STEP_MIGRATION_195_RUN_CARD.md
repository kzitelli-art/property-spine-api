# Two-step leasing migration 195 — bounded predeploy operation

This is a **release-window operation**, not a runtime setting and not a fixture
rehearsal. It is based on the September 13 two-step migration decision. It has
not authorised a production release, provider action, rollback, or recovery
artifact.

The executable entry is `tools/release/migration_195_predeploy.js`. It checks:

- a full exact `EXPECTED_SHA` against the build running the command;
- the SHA-256 of the reviewed `195_two_step_leasing_authored_offer_basis.sql`;
- the complete ledger set, not only its ceiling, for precisely 194 or 195;
- the four checked physical definitions and the prerequisite lineage columns;
- a post-195 ledger whose checks remain stale is refused.

It does not accept another pending migration, an unknown ledger row, a changed
195 file, a short SHA, a dirty non-Render checkout, or a stale post-state.

## Predeploy operation

Use only after the release operator has read the real target independently,
selected the exact API and compatible recovery artifacts, and paused affected
leasing work. The command below is the one-time schema action. It passes
`MIGRATION_RELEASE=1` only to the child `migrations/migrate.js` process; do not
persist that variable in a service environment.

```sh
DATABASE_URL="<reviewed target>" \
EXPECTED_SHA="<full 40-character API build SHA>" \
node tools/release/migration_195_predeploy.js --apply
```

The command accepts only the exact 194 pre-state, applies only through the
governed runner with ceiling `194`, then rereads the ledger and physical schema
as the 195 post-state. A repeat without `--apply` is deliberately verify-only:

```sh
DATABASE_URL="<reviewed target>" \
EXPECTED_SHA="<full 40-character API build SHA>" \
node tools/release/migration_195_predeploy.js
```

After a committed 195, start the matching API with ordinary verify-only
`prestart`; a baseline build must not be restarted. Publish the matching app
only after the matching API health and signed-in canonical reconciliation have
been observed.

## Separate owned rehearsal

The local fixture-only rehearsal is documented by its command output and uses a
nonce-owned database and cluster. It is evidence about the executable entry and
the runner; it is not a production predeploy command and it establishes neither
data compatibility nor a recovery artifact.

The required remaining release evidence is still the decision memo's: a fresh
read-only target ledger and affected-row/constraint preflight, real locking
timing, a pinned schema-195-compatible recovery build, exact API/app deploy and
health evidence, served assets, and signed-in canonical workflow reconciliation.
