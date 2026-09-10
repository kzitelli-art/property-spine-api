# New HP handoff — checkpoint

Prepared 2026-09-09. Both repositories use branch codex/new-hp-handoff-20260909.

- API product checkpoint: ec9e7740ad485119dd50fda308d59410e8bdc7d3
- App product checkpoint: f2eda58544b1650f123735f4105c750a47eba081
- Documentation-only commits may follow the API product checkpoint. Read the remote branch tip for the complete guide.
- API repository: https://github.com/kzitelli-art/property-spine-api
- App repository: https://github.com/kzitelli-art/property-spine-app

The checkpoint preserves the accumulated tenant journey, phone terms and shared review work, plus the completed excluded-home read/UI repair. It is a development checkpoint, not a production release. Main branches were not merged and no deployment was performed.

Latest independent verification: API target-date 15 assertions, excluded browser component red/green, adjacent date/offer browser controls, 45 inline scripts parsed, owned application_turn_window DB/HTTP/post-tour controller browser successor, and all 54 source-governance gates passed. The owned DB and cluster data were removed. See ../desktop-qb-20260906/tenant-journey/EXCLUDED_TARGETS.md. Earlier phone-origin 159-assertion integration evidence is in PHONE_TERMS.md in that same directory; it was not rerun for this focused repair.

Next work: automatic matching must compare prospect constraints/preferences with governed price and exact-home facts on an explicit basis. Exclusion reasons are now visible; ranking and prospective turn planning are not thereby finished. Preserve existing canonical owners. Floor fact coverage is not yet established. No need to request another copy of Fable's completed exclusion assignment.

HP bootstrap: follow README.md in this folder; use the exact sibling folder names shown there. Inspected desktop runtime: Node v24.16.0, Git 2.54.0.windows.1, PostgreSQL 17.11, Chrome. Restore private workbooks via OneDrive/local secure storage and supply their paths to the owned proof runner. They, authentication sessions, provider credentials and local databases are not part of Git. Do not copy an old .git/worktrees directory to HP; clone fresh. Old desktop Git auto-maintenance reported permission errors pruning two unrelated app worktree metadata directories; commits succeeded and those directories were not manually removed.

Release gaps remain explicit: no new live SMS, provider delivery, deployed migration or tenant-side production acceptance; full automatic matching/turn planning remains open. GitHub Actions status must be checked on the pushed API tip; local green is not a CI result. The app workflow auto-trigger targets another historical branch, so this handoff push does not by itself run that workflow.
