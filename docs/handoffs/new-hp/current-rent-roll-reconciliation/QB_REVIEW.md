# QB reconciliation review — September 13

Claude's API d35a359 (product be9ae71) and app4558460 were fetched from the named branches. Root independently verified CI519 at e067069: the configured suite succeeded and the new current-rent-roll proof executed59/0. API was carried onto the accepted bed-kind/source-index integration at0d67ce7. Nothing in this receipt accepts the real Skyline tracker or changes production.

## Competing rights

The delivered proof only challenged a new person against overlapping leases. Root added a person-recognition challenge against an existing right-holder on a bed with two pending rights. On unchanged delivered product it returned200, `tied_to_existing_lease`, and promoted the source row. The strengthened proof was60 passed/1 failed on owned PostgreSQL18.6 and a fenced HTTP server.

The bounded correction calls the existing overlap hold whenever more than one competing right remains after person recognition. Recognising a person does not select a valid lease. It changes no lease, activates no pending right and records no possession. The successor passed61/0 on separately tagged synthetic property fixtures in the same nonce-owned proof database. No fresh-empty-database claim is made for the second invocation.

The proof also replaces an OR-tautology with exact92 accepted-claim and31 operative-lease bases; asserts the fixture's160 total/122 occupied/12 pending/0 open/26 review counts; and uses the actual `marketing_state` field with complete unresolved-home membership and null availability dates. The old availability assertion read nonexistent `state` fields. These are fixture expectations, not production counts.

Local logs: workspace `tmp/current-rr-qb-runtime-20260913/witness.log` and `successor.log`; structured receipts in the corresponding `witness/` and `successor/` directories. Initial local driver attempts were refused before assertions for missing and then ambient-equal HARNESS_DATABASE_URL; the final test child explicitly removes DATABASE_URL and uses the owned manifest URL. The schema fixture was constructed with the existing `apply_migrations.sh` under the available Git `usr/bin/sh.exe`, ending at198. No migration was edited for fixture construction.

## Remaining bounded review rulings

- A dated source row must not be called supporting evidence for a lease whose supplied dates or rent it contradicts. Keep mismatches in review with both values; do not overwrite the lease.
- An undated row is an occupancy observation with contractual economics unestablished. Its observed monthly rent does not silently amend a lease. A future-only same-person pending right remains a separate commitment; current observation must not be linked to it as if the lease covered the observation date.
- Multiple competing rights remain held, regardless of which person is recognized. A missing source as-of date cannot supply a guessed current window.
- The app's mass-create-new action is inappropriate when the server reports existing inventory; retain explicit individual new-home decisions and the initial-empty-property bulk path.

The bounded service cases below supersede the earlier in-progress review note. Final app integration, combined CI, release and actual property acceptance remain open.

## Bounded term and observation successor

The two remaining service cases were exercised through the same fenced HTTP proof on the nonce-owned PostgreSQL18.6 database. On unchanged `09816579`, the strengthened proof was 61 passed / 2 failed: a dated row with conflicting rent and dates was promoted as support for the existing lease, and a dateless current observation was linked to the same person's future-only pending lease.

The successor ties a dated row to an existing lease only when every supplied contractual field agrees. A mismatch now remains `needs_review`, retains the source and canonical rent/date values in its reason, and writes no lease link. A dateless observation can tie only to the same person's right that covers the source as-of date. One future-only pending right is retained unchanged while the observation follows the existing `occupancy_accepted_terms_unknown` outcome with no lease link, activation or possession event. Multiple competing rights still hold. An undated source without an as-of date is refused before it can establish a guessed current observation.

The successor proof passed 63/0; a final 63/0 invocation also asserts that the canonical rent and both canonical dates stay unchanged. These invocations made new nonce-tagged synthetic property fixtures in the existing owned database; this is not a fresh-empty-database claim. Logs: workspace `tmp/current-rr-qb-runtime-20260913/terra-semantic-first-red.log`, `terra-semantic-successor.log` and `terra-semantic-successor-final.log`; structured receipts are in the same runtime directory under matching names. The first three driver starts did not reach assertions because the inherited linked dependency tree had lost Express dependencies; a local dependency install restored the proof runtime without changing tracked product files.

Final combined CI, release and actual property acceptance remain open.
