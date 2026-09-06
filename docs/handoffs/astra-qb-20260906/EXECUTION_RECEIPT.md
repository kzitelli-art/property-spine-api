# Execution receipt — September 6, 2026

Battery-safe transfer for a new QB on Kameron's desktop. This receipt distinguishes completed evidence from unfinished real-source acceptance.

## Published code

- API candidate: `122872154dd58224e80665ddbc10d6dc8cc32d01`, branch `codex/canonical-onboarding-rehearsal-20260905`.
- Its previous commit: `cc896dcd791793f01f832ccd596898770a4fc6da`.
- App candidate: `180c6d10accb3b0033e20129f07ce4e5e585c0de`, same branch name in the app repository.
- Code was committed and pushed; API local/remote equality was verified after the final CSV repair. The app was clean after its commit/push.
- Handoff branch: `codex/astra-qb-handoff-20260906`, documentation/recovery only, based on e09c541. It is not the product checkout.

## Verified evidence

- Real July and Skyline first-red on unchanged API e09c541/app4849545: upload201, download200, exact bytes/hash, read-source422 `no_unit_column`, visible `Rent Roll` title-row refusal. Zero attempted external requests in the successful browser run. Owned cleanup verified. See `first-red-aggregate.json`.
- App sanctioned static suite: **42 harnesses,1576 assertions passed**, including25 assertions for the new review contract.
- API source-governance:50 gates passed before the cc896dcd commit.
- [API CI run399](https://github.com/kzitelli-art/property-spine-api/actions/runs/34033396210) **passed on exact cc896dcd**. Job101486998422 logs were independently inspected: unchanged-parent source7/lifecycle7/publication15; successor source29/ledger16/lifecycle10/publication15; Deal Setup HTTP31; all other selected required assertions and owned cleanup passed. Linux/Node22/PostgreSQL16. This does not exercise private workbooks or the paired app browser.
- A Windows/PostgreSQL17 local run at exact cc896dcd/app180c6d10 independently passed the same parent suites and successor source29/ledger16/lifecycle10/publication15. It then failed existing Deal Setup HTTP H12 with409 `source_rows_mismatch`; the subsequent test TypeError masked the summary but did not obscure the earlier refusal. The real-source successor browser stage was not reached. Owned database dropped, cluster stopped and data removed.
- Root cause was reproduced with the unchanged cc896dcd adapter: SheetJS's CSV inference changed `2025-07-01` to `6/30/25` on the EDT laptop. Commit1228721 disables type inference for CSV evidence only. The same positive-parent comparison passed against the successor, preserving dates and lexical decimal text; **13 adapter tests passed**. No assertion was weakened to accept the shifted date.
- [API CI run400](https://github.com/kzitelli-art/property-spine-api/actions/runs/34034017193) **passed on exact122872154dd58224e80665ddbc10d6dc8cc32d01**. Job101488674889 logs were inspected: adapter13, new parent/successor suites, existing selected assertions and owned database cleanup passed. The final log states all required assertions passed at12:46:41 UTC and confirms owned database cleanup at12:46:42 UTC. This supersedes run399 for API candidate CI custody; it still does not supply private-workbook browser acceptance.

Earlier ledger15/16 failures were incorrect proof field selection; the corrected public `basis_ref.proposal_id` assertion now passes both CI and Windows. They are not outstanding product failures.

## Final local run

A fresh owned local run at API1228721/app180c6d10 was started after the fix. Its final disposition will be recorded below before shutdown. Until that record exists, **real July/Skyline successor review, restart, lineage and synthetic mixed Add All remain unaccepted**.

No production/provider action, deployment, merge, rebase, force-push, production migration or actual-source confirmation was performed. Actual workbooks, row data, browser screenshots, session tokens and private fixture IDs are excluded from Git. Raw diagnostic logs remain private; code, proof runners, instruction packet and curated legacy recovery patches are pushed.
