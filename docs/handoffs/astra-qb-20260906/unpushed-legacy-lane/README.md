# Unpushed legacy lane recovery material

This archive preserves the source and test changes from a separate laptop-only branch. It is **not part of the current onboarding candidate**, has not been rebased onto current upstream, and must not be applied blindly. Review each diff against its original parent and current code before reuse. The exact branch remains local; these six metadata-free diffs make its code and tests recoverable away from that checkout.

## Custody

- Local branch: `codex/skyline-guarantor-agent-20260822`
- Merge base: `7b649c6eb1d199a6705f9f23f8ff2a304c761c60`
- Recorded upstream tip at audit: `91690eade84355461615aacb1af94a8fac7c1f77`
- Local head: `c1622e2af0865d998579d377c5fa9455c9ae9e69`
- Divergence at audit: 10 commits ahead, 65 commits behind
- Audit date: 2026-09-06

## Full local-only commit manifest

1. `dd48658ce9dd70d38885688cc20b36f218183047` — Fail closed across staff invite lifecycle
2. `218656fa8191450fdea425f4ade0b626314f993a` — Show terminal invite receipts in the browser
3. `c52ac76b797dc96e191ec2250b3619e0ff5752a9` — Append staff invite lifecycle evidence stop
4. `6c9eb58f808a728b4adf1d3206618c4fee8452ac` — Reject superseded lease signing links
5. `8a983ff88a49ef2526db444c425a10627e6010b8` — Append superseded lease link proof receipt
6. `9ed2eab8a23bbbbb390369e05c120c2de1c278f7` — Record contained CAMP baseline drift
7. `2660df199f67222b659610565de5dcfbbd481782` — Unify public V3 guarantor authority
8. `a2f2d6077a8240078f28616de2d4d2339734f2a0` — Refuse contradictory typed lease signatures
9. `2969dcca6ed0a35ecc179b182fe4e18762ae5f27` — Append guarantor authority and signature evidence
10. `c1622e2af0865d998579d377c5fa9455c9ae9e69` — Freeze completed lease signer evidence

All ten commits were dated 2026-08-24. Commit author metadata is intentionally omitted from this archive.

## Recoverable source and test diffs

| File | Commit | Paths |
|---|---|---|
| `01-staff-invite-fail-closed.diff` | `dd48658` | `src/identity/teamaccess.js`; `tests/e2e/staff_invite_acceptance.browser.js` |
| `02-staff-invite-terminal-receipts.diff` | `218656f` | `src/identity/teamaccess.js`; `tests/e2e/staff_invite_acceptance.browser.js` |
| `03-superseded-lease-links.diff` | `6c9eb58` | `src/applications/leasepackets.js`; `tests/e2e/leasing_hostile.e2e.js` |
| `04-public-v3-guarantor-authority.diff` | `2660df1` | `src/applications/applicationSubmission.js`; `tests/e2e/tour_application_lease.e2e.js` |
| `05-contradictory-typed-signatures.diff` | `a2f2d60` | `src/applications/leasepackets.js`; `tests/e2e/leasing_e2e_lib.js`; `tests/e2e/leasing_hostile.e2e.js` |
| `06-freeze-completed-signers.diff` | `c1622e2` | `src/applications/leasepackets.js`; `tests/e2e/leasing_hostile.e2e.js` |

Each file is the plain output of `git diff <commit>^ <commit> -- <listed src/tests paths>`. The files contain no format-patch headers or author email metadata.

## Docs-only evidence commits

The raw `docs/CURRENT_STATE.md` patches are intentionally excluded. These summaries preserve their purpose without carrying old operational receipts. They are dated historical notes and **were not revalidated on 2026-09-06**.

- `c52ac76b797dc96e191ec2250b3619e0ff5752a9`: recorded the then-observed staff invite lifecycle evidence and stopping point.
- `8a983ff88a49ef2526db444c425a10627e6010b8`: recorded the then-observed refusal of superseded lease signing links.
- `9ed2eab8a23bbbbb390369e05c120c2de1c278f7`: recorded the then-contained CAMP baseline drift.
- `2969dcca6ed0a35ecc179b182fe4e18762ae5f27`: recorded then-observed guarantor-authority and typed-signature evidence.

## Recovery limits

The diffs preserve only the six code/test commits and depend on their recorded parent states. They do not contain the four raw docs patches, the full branch graph, working-tree files, databases, provider state, private source documents, or proof screenshots. Reconstructing behavior requires deliberate review and adaptation to the current tree.
