# Ask Spine conversational leasing reply

**Date:** 2026-09-15  
**API code:** `6dfc3b31bde56f0c87bbb03d6b2148700e0a168d`  
**CI:** run `35016506384` — success  
**Render API:** `dep-dakq7se7bikc73daccv0` — Deploy succeeded | Live  
**App code:** `2feed58b0bd25e481596051c4aa1541ed7fac0a4`  
**Render app:** `dep-daks45nf3r2c738fka30` — Deploy succeeded | Live

## Change

Leasing Knowledge already used the approved `agent_facts` wording, but the
Ask Spine response exposed an internal topic heading and a report-like block.
The existing read now adds a deterministic, topic-aware conversational lead
and plain-language missing/exact-home notes. The app presents the grounding
metadata in human-readable labels while retaining the original keys for audit
and tests. The approved stored wording, scope, links, entitlement and source
provenance are unchanged. No model is used for this wrapper, so a friendlier
tone cannot invent a leasing fact.

## Verification

- `tests/unit/leasing_knowledge.test.js` — pass.
- `tests/unit/leasing_knowledge_coverage.test.js` — pass.
- `tests/verify_source_governance.js` — all 56 gates passed.
- Signed-in production app, Skyline: `What amenities does Skyline have?` now
  renders **“For this property, I can confirm these amenities and
  inclusions:”** followed by the approved Michael Grivna wording. Grounding
  renders as **“Based on confirmed leasing knowledge · About · Amenities · No
  missing topics · Property-wide information”** while the underlying
  metadata remains `ESTABLISHED`, topic `amenities`, property-wide scope.
- Mixed live question `What amenities are there, and do you have floor plans?`
  kept the confirmed amenities answer and added **“I don't have an approved
  answer yet for floor plans.”** with **“Still to confirm · ["floor_plans"]”**.
- Missing-only live question `Do you have floor plans?` stayed
  `NOT_ESTABLISHED` and answered **“I don't have an approved answer for floor
  plans yet.”**; it did not turn missing data into “none.”
- Browser console errors and warnings: none.

This is a wording/read-path release only. It does not change property data,
inventory, pricing, lease configuration, access, or Greenery custody.
