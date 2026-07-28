// ════════════════════════════════════════════════════════════════════
//  administration_fee_cutover.js — THIN COMPATIBILITY ADAPTER (Class 2)
//
//  The mirror of application_fee_cutover.js, and deliberately identical in
//  shape: it supplies two facts and NOTHING else.
//
//      charge_code            fee.administration
//      declared legacy owner  pricing_admin_fee   (read back from SUPERSEDES)
//
//  NO BUSINESS RULES LIVE HERE. Digest, publishability revalidation,
//  approval/publication, cutover, legacy retirement, owner evidence, receipts
//  and retry behaviour are all governed_charge_cutover.js. If this file ever
//  grows a rule, there are two implementations again and the catalog has lost
//  the argument it exists to win.
//
//  recordRuling is NOT re-exported. A ruling is recorded through the
//  generalized service; exposing it behind a per-fee door would invite a
//  second way to decide the same thing.
//
//  CLASSIFICATION: Class 2 — temporary compatibility adapter.
//  REMOVAL CONDITION: delete when operator.js calls governed_charge_cutover.js
//  directly with an explicit charge_code, which is a route change deliberately
//  kept separate from this wiring so the two are independently revertible.
// ════════════════════════════════════════════════════════════════════

"use strict";

const g = require("./governed_charge_cutover");

const CHARGE_CODE = "fee.administration";
// Read back from the generalized registry so this adapter cannot drift from
// the legacy owner the service will actually retire at cutover.
const LEGACY_FACT = g.SUPERSEDES[CHARGE_CODE][0];

const approveAndPublish = (pool, opts = {}) =>
  g.approveAndPublish(pool, { ...opts, charge_code: CHARGE_CODE });

const cutOver = (pool, opts = {}) =>
  g.cutOver(pool, { ...opts, charge_code: CHARGE_CODE });

const oneSourceProof = (pool, opts = {}) =>
  g.oneSourceProof(pool, { ...opts, charge_code: CHARGE_CODE });

const termsDigest = (t = {}) =>
  g.termsDigest({ ...t, charge_code: t.charge_code || CHARGE_CODE });

module.exports = { approveAndPublish, cutOver, oneSourceProof, termsDigest, CHARGE_CODE, LEGACY_FACT };
