# Greenery staff onboarding rehearsal — receipt (2026-09-12)

Returned to HP QB for review and integration. Bounded to staff onboarding.
No production read or write, no provider action, no message, no deployment,
no merge, reset or force push. Line activation, pricing, mapping, readiness,
inventory, conversations and tours were not touched.

Baseline: API `0f5dccca201f0f280db3df12049fb900e062571a` and app
`4ca3e677ad895254314dd8a1ffb8eeaedaa45f2f` on
`codex/hp-release-integration-20260911`. Isolated worktree and branch
`claude/greenery-staff-onboarding-20260912`. Doctrine read: `CLAUDE.md`,
`docs/PHILOSOPHY.md` and `docs/DB_HARNESS_ISOLATION.md` (both unchanged since
932c9af), `docs/CURRENT_STATE.md`. A workspace `AGENTS.md` does not exist in
either repository and was not read.

## Objective and answer

Can the existing governed path bring an already-existing, active
`human_staff` account — classified, uniquely bridged, phone verified,
assigned at a Skyline-shaped property, **no email** — into a newly adopted
Greenery-shaped property and leave them resolvable as its staff member with
Leasing access?

**Yes, on this baseline, through `POST /properties/:id/team-invites` plus
the OTP acceptance in `/auth/sms/start` and `/auth/sms/verify`.** That is the
appropriate public door for an existing staff member: it is phone-based,
requires the existing person to be confirmed, and its acceptance branch in
`src/identity/team_access.js` finds the account by phone, classifies it,
establishes a staff context at the new property through
`staff_bridge.establishStaffContext`, writes the person-level `assignments`
row and the `property_team_assignments` row, and issues the property session.

What stands in front of that door is **first-property access**: the invite
must be issued from a session at the new property, a session requires an
active team assignment there, and the first assignment after adoption can
only come from the two admin provisioning doors. On the unmodified baseline
both doors fail for a phone-only account. That is the one real blocker
reproduced, and it is fixed in this branch.

## Proof — `tests/proofs/greenery_staff_onboarding.db.js`

Owned nonce-verified database built from the real migration chain (ceiling
194 / 182 rows), owned server booted like `tests/e2e/boot.sh`
(`SMS_SEND_MODE=customer_care`, `APP_BASE_URL` on the owned port), fake SMS
transport. Every state change after the fixture is an HTTP call against the
real routes; reads are SQL. The "Mike" fixture is itself created through the
governed invite and OTP path at the Skyline-shaped property, not inserted.
The only fixture rows written by SQL are organizations, properties,
communication lines (line policy is outside this lane) and the admin accounts.

| Mode | Source | Result |
|---|---|---|
| `PROOF_EXPECT_DEFECT=1` witness | unmodified `0f5dccca` | 37 passed, 0 failed, 9 observations (the defects below observed as expected) |
| successor | `0f5dccca` + this branch's fix | 39 passed, 0 failed, 8 observations |

Evidence: `evidence.witness.json`, `evidence.successor.json` beside this
receipt (identifiers, phones, emails, tokens and codes scrubbed).

Sequence exercised:

1. **Custody.** Before adoption: an invite at the property from another
   property's session is 403 `staff_session_property_mismatch`; the org
   admin cannot open the property through the selector (403). Super-admin
   adoption succeeds and keeps the property id; a second adoption into
   another client is 409 `property_already_has_an_organization`; an org
   admin cannot use the adoption door (403); another client's org admin
   cannot provision staff at it (400 "does not belong").
2. **First-property access.** Org-admin door `POST /org/users/invite` and
   super-admin door `POST /admin/organizations/:id/invite` for a phone-only
   org admin; then the super-admin door for an email-bearing org admin with
   the exact email and platform role; then the same call with the role
   omitted; then the org admin opens the property through
   `POST /operator/properties/select`.
3. **Governed invite.** Inviting the existing phone without `person_id` is
   409 `existing_person_confirmation_required` and lists the same person;
   confirming a person who does not carry the phone is 409
   `person_phone_mismatch`; the confirmed invite is created and its code
   reaches the fake transport; the account accepts and receives a session
   at the new property; the acceptance names the same user and person and
   grants `leasing`.
4. **Identity at the property.** `resolveStaffIdentity` → `resolved`
   (`bridge_plus_active_assignment_plus_authority`); staff contexts and
   person-level assignments at both properties; the Skyline team assignment
   untouched; platform role `member`, `human_staff`, still no email;
   `GET /properties/:id/my-access` reports leasing and lands on it;
   `GET /operator/leasing/leaseable-units` answers the new session; the
   original Skyline session still works; the selector switches between the
   two properties; the new session cannot invite at Skyline (403).
5. **Repeat.** A second invite and acceptance succeed; one team assignment,
   one person assignment, one context, no duplicate user or person, still
   resolved; the used and the superseded invite both refuse a new OTP start
   (409 "already used"); a later invite with a different role replaces the
   team assignment's role and modules in place and adds a second
   person-level assignment role.
6. **No line.** At a property with no text line the invite is link-only and
   `/auth/sms/start` returns `dev_code` — only because `NODE_ENV` is not
   production (`isProd()` in `team_access.js`); nothing left the server.

## First failing request on the baseline

`POST /org/users/invite` (org-admin session) with `{name, phone,
property_id, role_key:"property_admin"}` for an existing phone-only account
→ **500** `there is no unique or exclusion constraint matching the ON
CONFLICT specification`. The same body through
`POST /admin/organizations/:id/invite` → **500**, same message. Cause: both
doors use `on conflict (phone)`; `users` has no plain unique constraint on
`phone`, only the partial expression index `uq_users_phone_normalized`
(`regexp_replace(phone,'\D','','g')` where the digits are 10 or more), so
Postgres refuses the statement on every call, conflict or not. A phone-only
org admin therefore cannot receive the first assignment at an adopted
property, and no session, and no governed invites can follow: the
first-property access deadlock is real for phone-only admin accounts.

Second defect witnessed: the super-admin door defaulted `platform_role` to
`member` and wrote it on conflict, so repeating it for an existing org admin
without the field demoted them (`org_admin → member`).

Not a blocker for this objective: with an email-bearing org admin and the
exact email plus explicit platform role supplied, the super-admin door
attaches the account (201) with no duplicate and the role preserved, and the
rest of the path proceeds. The purported "organization-invite phone
conflict" is therefore real but confined to the admin provisioning doors;
the governed staff invite never needed an email.

## Correction (this branch, two files)

- `src/identity/super_admin.js` `/admin/organizations/:orgId/invite`:
  `platform_role` is optional (validated only when supplied); new accounts
  get `member`, existing accounts keep their role
  (`coalesce($n, users.platform_role)`); the phone branch's conflict target
  is the normalized-phone expression with the index's predicate; the
  response reports the effective `platform_role` from the row.
- `src/identity/org_admin.js` `/org/users/invite`: the phone branch's
  conflict target is corrected the same way. Its email branch was already
  role-preserving.

Regression proof: the successor mode of the same proof asserts phone-only
provisioning through both doors (201, same user id, no new user or person)
and role preservation when omitted; the witness mode asserts the prior
behaviour on the unmodified source. Registered in `tests/e2e/verify_all.sh`
inside the owned-server block after "legacy decision writes closed".
Source governance gates: passed on the patched tree.

## Recorded, not changed

- `users.organization_id` is never written by the governed invite path; org
  scope for staff comes from `property_team_assignments` through the
  property. Admin-role gates read `users.organization_id`, staff routing
  does not.
- An email-bearing admin invite that names a phone already on another
  account still fails at `uq_users_phone_normalized` (which account should
  win is a ruling, not a conflict target).
- An unowned property can be adopted into any client; adoption cannot be
  reversed or moved. The first adoption must name the right client.

## Commands

```
node tests/e2e/proof_boundary.js create && ./tests/e2e/apply_migrations.sh
# owned server for the tree under test, booted like tests/e2e/boot.sh, then:
PROOF_EXPECT_DEFECT=1 node tests/proofs/greenery_staff_onboarding.db.js   # unmodified 0f5dccca: 37/0
node tests/proofs/greenery_staff_onboarding.db.js                         # this branch: 39/0
node tests/verify_source_governance.js                                    # passed
node tests/e2e/proof_boundary.js cleanup
```

Cleanup: the owned database was dropped after the runs; `spine_proofs` was
not touched. No production connection string was used.
