// ════════════════════════════════════════════════════════════════════
//  _engine.js — TEST-ONLY RE-EXPORT. Not part of the deployed service.
//
//  THIS FILE USED TO BE A HAND-MAINTAINED COPY of the obligation engine, with
//  a header instructing whoever changed server.js to come here and update it
//  to match. That instruction was not followed, and the copy drifted — all of
//  it in the PERMISSIVE direction:
//
//    · spawnObligationFromEvent was missing five columns, including dedupe_key
//      (the idempotency mechanism) and the durable-ownership-at-insert fields;
//    · satisfyObligation was missing the ENTIRE reserved-input guard, so it
//      would satisfy the invitation-proof inputs the real engine categorically
//      refuses;
//    · completeObligation was missing the ENTIRE conversion-rail guard, so it
//      would close conversion-linked obligations the real engine categorically
//      refuses.
//
//  Every harness importing this file was therefore asserting against an engine
//  MORE PERMISSIVE than production — a test could pass on behaviour the real
//  system would reject. That is exactly the failure work_order_service.js
//  documents for deriveCategories: two implementations of one rule, kept in
//  step by discipline, silently diverging.
//
//  It is now a re-export of the REAL module. The harness and the server cannot
//  disagree, because there is only one implementation to disagree with.
//
//  DO NOT reintroduce a copy here. If a harness needs the engine, import it.
// ════════════════════════════════════════════════════════════════════
"use strict";

module.exports = require("../src/shared/obligation_engine");
