# Property knowledge onboarding release

**Released:** 2026-09-16 02:58 UTC  
**API:** `c8c5176bd556d6ea9e57af08bc31ca98fbb4c190`  
**App:** `3607b3d5891a4a96b6b5183ead875b974863aef9`

## What is live

- The prospect opening path selects only the leasing-knowledge shelves relevant
  to the question and reads pricing through the governed pricing adapter.
- A unit with a price is described as priced, never as available without the
  current availability owner.
- The shared prospect-output policy preserves numeric ranges and refuses legal,
  fair-housing, assistance-animal and unowned-action claims before a reply can
  leave the model boundary.
- Existing platform roles are preserved when Super Admin adds property access;
  new users still default to member when no platform role is supplied.

The API passed exact full CI run `35048455828`, including all 56 source gates.
Render deployment `dep-dal05omk1f9s73d7tud0` succeeded; `/health` identified
`c8c5176`, and startup verified 186 applied migrations through ceiling 198. The
app sanctioned suite passed 72 harnesses / 2,427 assertions / 0 failures. Render
deployment `dep-dal06gek1f9s73d8017g` succeeded, and every served asset matched
the exact app commit.

## The reusable onboarding unit

Every property uses the same ten descriptive shelves:

1. Leasing highlights
2. Amenities
3. Layouts
4. Dimensions
5. Photos
6. Floor plans
7. Virtual tours
8. Neighborhood
9. Common questions
10. Moving in

Each shelf retains a current answer, source type, approving staff actor, approval
time, optional expiry and replacement/retirement history. The active-property
editor and prospect/Ask readers use this same owner. Inventory, pricing,
availability/readiness, approved policy, lease configuration, staff identity and
maintenance remain separate canonical owners; their facts are not copied into
descriptive prose.

For future properties, the standard sequence is canonical property and staff
access, inventory reconciliation, ten-shelf source review, canonical owner setup,
property-scoped publication, exact read-back and a named steward for future
changes. `tools/stage_leasing_content.js` prepares ordered create/replace plans
against a fresh property snapshot. It never writes or substitutes for review.

## Current Temple content state

- Skyline has five live shelves: highlights, amenities, layouts, neighborhood
  and common questions. Safer successor wording for highlights and amenities is
  prepared but not yet saved. Dimensions, photos, floor plans, virtual tours and
  moving-in guidance are also prepared but not yet saved.
- The canonical Greenery is adopted into OneFive. All ten descriptive shelves
  are prepared, but none is published. KZ and Mike still need the canonical
  Team-invite/OTP acceptance path to complete person-level Greenery identity.
- John Franco is not provisioned. His current mobile number must be confirmed;
  the number on the older website is not treated as current access authority.

No real prospect message, live customer SMS, Greenery knowledge publication,
Team invite, OTP acceptance, inventory correction or pricing change occurred in
this release.
