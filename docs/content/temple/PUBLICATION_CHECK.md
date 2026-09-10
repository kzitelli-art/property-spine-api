# Read-only publication check — 2026-09-10

API health at 10:13 UTC: `d55dae9`, started 2026-09-01. Inspected source at that exact local commit: the fact writer allows only seven original keys. New leasing topics exist in candidate `a9e3420`, not this deployed source. No authenticated live writer request was attempted.

Neon project `odd-cherry-53458838`, explicitly selected production branch `br-old-math-aqvwd76d`: migration ledger maximum 192; `agent_facts` exists. Six property rows match Skyline/Greenery names; all have zero active agent facts and null canonical keys with reason `predates_canonical_identity_requirement`.

| Candidate identity | Address | Active team assignments | Interpretation |
|---|---|---:|---|
| `14e41b7c-e91c-49e8-9651-10c4908a8f6a` skyline | 1417 n 15 phily | 2 | Strong address/assignment candidate, not a repaired canonical identity |
| `a29181cd-3ba1-461c-aead-cd989add1d11` greenery | 1325 N 15th Street, Philadelphia | 0 | Address candidate; no current active assignment found |
| Four other Skyline/Greenery name matches | null | 0 | Do not select by name |

No identities were merged, repaired or created. No sessions were minted. An exploratory spaces count failed because the assumed property column does not exist; no inventory count is claimed. All database calls were reads.

Resume by resolving existing property custody and the intended candidate release, then use the authenticated existing writer. Preserve source-attribution wording and review notes from `leasing-content.json`. Do not directly insert SQL rows or put these topics under communication instructions to work around the old writer.

Content checks passed: exactly ten supported topic keys per property, unique keys, nonempty wording under 8,000 characters, allowed documented-source type, resolvable source references, no private-library links in prospect wording, and no invented canonical property identifiers. No production or new behavioral proof is implied by those content checks.
