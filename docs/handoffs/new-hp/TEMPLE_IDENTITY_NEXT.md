# Temple identity — next bounded investigation

Read-only worker audit on September 10 at `920b5da`; no DB execution or product edit. This is source evidence, not a reproduced defect or authorization receipt for any real target.

`src/identity/registry.js` POST `/registry/properties/:id/canonical-key` and `src/surfaces/owner.js` POST `/owner/properties/:id/identity` set canonical_key without clearing canonical_key_absent_reason. Migration150 requires exactly one. The previously read legacy Temple rows have an absence reason, so the expected first red is a constraint refusal when the existing route repairs one in an owned fixture.

These routes are legacy operator-key routes. A constraint-only patch would not establish current actor attribution or scope. Inspect the shared identity owners and preserve governed authority before using a repair path live.

Existing organization adoption is `property_hierarchy_service.assignPropertyToOrganization`, exposed by `/admin/organizations/:id/properties`: super-admin, row lock, event, orphan adoption only; no reparenting. Reuse it if evidence establishes the orphan's intended organization.

Canonical team invitation requires the caller's session to be in the target property before checking elevated role. Existing org/admin provisioning can bootstrap access but does not establish the complete person/context/work-assignment bridge. A seat alone is not proof that Mike's SMS authority works.

Before live loading, compare all six name matches through addresses/aliases, inventory, leases/applications, conversations, deal/source links, assignments and organization events. Establish actual actor and property custody. Do not create replacement properties: creation idempotency by canonical key cannot reconcile legacy keyless identities. Confirm current deployed code/schema and prove repair/refusal/unchanged IDs/authority in a disposable runtime first.
