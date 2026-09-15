# Ask Spine conversational leasing reply

**Date:** 2026-09-15  
**API code:** `d50b07a14feca834bd0bb31a6b71b74672ae4080`  
**CI:** run 606 (`34996742666`) — success  
**Render:** `dep-daknd8dbvr0c73e8kpk0` — Deploy succeeded | Live

## Change

Leasing Knowledge already used the approved `agent_facts` wording, but the
Ask Spine response exposed an internal topic heading and a report-like block.
The existing read now adds a deterministic, topic-aware conversational lead
and plain-language missing/exact-home notes. The approved stored wording,
scope, links, entitlement and grounding metadata are unchanged. No model is
used for this wrapper, so a friendlier tone cannot invent a leasing fact.

## Verification

- `tests/unit/leasing_knowledge.test.js` — pass.
- `tests/unit/leasing_knowledge_coverage.test.js` — pass.
- `tests/verify_source_governance.js` — all 56 gates passed.
- Signed-in production app, Skyline: `What amenities does Skyline have?` now
  renders **“Here are the confirmed amenities and inclusions:”** followed by
  the approved Michael Grivna wording. Grounding remains `leasing knowledge ·
  ESTABLISHED`, topic `amenities`, property-wide scope.
- Browser console errors and warnings: none.

This is a wording/read-path release only. It does not change property data,
inventory, pricing, lease configuration, access, or Greenery custody.
