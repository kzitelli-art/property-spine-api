/* ══════════════════════════════════════════════════════════════════════════
   slice9_future_commitment_proof.js — PURE proof of the future-commitment fix.

   THE DEFECT THIS CLOSES

   position_classifier only populated `successor` when a GOVERNING lease
   existed (the block requires `governing && governing.end_date`). A standalone
   future lease on an otherwise vacant position therefore produced
   successor.state === 'none', availability_read's proof-respecting branches
   never fired, and it fell through to:

       if (availability_state === 'committed_future') → successor_locked

   unconditionally. An unfunded, unexecuted future lease on a vacant unit was
   suppressed from marketing correctly and then reported LOCKED — a state
   stronger than the proof the lease carried.

   Pure on purpose: every shape below is constructible in memory, including
   the confirmed-opening-import case that a database may not currently hold.

   Run: node tests/slice9_future_commitment_proof.js
   ══════════════════════════════════════════════════════════════════════════ */
"use strict";
const path = require("path");
const PC = require(path.join(__dirname, "..", "src/tenancy/position_classifier.js"));

let pass = 0, fail = 0;
const ok = (m, c, d) => {
  if (c) { pass++; console.log("   PASS  " + m); }
  else { fail++; console.log("   FAIL  " + m + (d ? "\n           " + d : "")); }
};
const section = (t) => console.log("\n── " + t + " " + "─".repeat(Math.max(0, 56 - t.length)));

const AS_OF = "2026-08-02";
const lease = (o) => Object.assign({
  id: "L-" + Math.abs(JSON.stringify(o).length), lease_status: "pending",
  start_date: "2026-10-01", end_date: "2027-09-30",
  executed_verified: false, move_in_funds_cleared: false,
  source_type: null, confidence: null, tenant_ids: [],
}, o);
const row = (leases) => ({ space_id: "S1", unit_id: "U1", unit_number: "101",
  space_label: null, leases, possession_events: [], notice_date: null,
  turn_status: null, compat_occupancy: null });

section("A  the helper itself");
const none = PC.classifyFutureCommitment(null);
ok("no lease → state 'none'", none.state === "none");
ok("...with null lease_id and proof_basis", none.lease_id === null && none.proof_basis === null);
ok("...and locked false", none.locked === false);

const unfunded = PC.classifyFutureCommitment(lease({ executed_verified: true }));
ok("executed but NOT funded → 'pending'", unfunded.state === "pending", unfunded.state);
ok("...locked is false", unfunded.locked === false);
ok("...proof_basis 'unproven' — native requires BOTH", unfunded.proof_basis === "unproven");

const unexecuted = PC.classifyFutureCommitment(lease({ move_in_funds_cleared: true }));
ok("funded but NOT executed → 'pending'", unexecuted.state === "pending");

const locked = PC.classifyFutureCommitment(
  lease({ executed_verified: true, move_in_funds_cleared: true }));
ok("executed AND funded → 'locked'", locked.state === "locked");
ok("...proof_basis 'native_verified'", locked.proof_basis === "native_verified");
ok("...start_date is carried", locked.start_date === "2026-10-01");

section("B  confirmed opening import keeps its own proof basis");
const opening = PC.classifyFutureCommitment(lease({
  source_type: "historical_snapshot", confidence: "confirmed" }));
ok("it is NOT locked — it did not pass native execution and funding",
  opening.state === "pending", opening.state);
ok("but its proof_basis is 'confirmed_opening_import', NOT 'unproven'",
  opening.proof_basis === "confirmed_opening_import", opening.proof_basis);
ok("and NEVER 'native_verified'", opening.proof_basis !== "native_verified");
// This is the contract: it may suppress marketing as governed opening truth,
// while the response can still tell it apart from a natively proven lease.

section("C  THE DEFECT — standalone future lease on a vacant position");
const standalonePending = PC.classifyPosition(row([lease({})]), { asOf: AS_OF });
ok("availability_state is committed_future (marketing suppressed)",
  standalonePending.availability_state === "committed_future");
ok("successor is still 'none' — there is no governing lease to succeed",
  standalonePending.successor.state === "none");
ok("BUT future_commitment is now carried and says 'pending'",
  standalonePending.future_commitment.state === "pending",
  JSON.stringify(standalonePending.future_commitment));
ok("...and is NOT locked", standalonePending.future_commitment.locked === false);
// Before the fix these two facts were the whole bug: suppression was right,
// and the only signal availability_read could see said 'none', so it guessed.

const standaloneLocked = PC.classifyPosition(
  row([lease({ executed_verified: true, move_in_funds_cleared: true })]), { asOf: AS_OF });
ok("a funded, executed standalone future lease IS locked",
  standaloneLocked.future_commitment.state === "locked");
ok("...still committed_future for marketing",
  standaloneLocked.availability_state === "committed_future");

section("D  successor path uses the SAME helper");
const withGoverning = PC.classifyPosition(row([
  lease({ id: "CUR", lease_status: "active", start_date: "2025-09-01", end_date: "2026-08-31" }),
  lease({ id: "NEXT", start_date: "2026-09-01", end_date: "2027-08-31", executed_verified: true }),
]), { asOf: AS_OF });
ok("successor is populated when a governing lease exists",
  withGoverning.successor.state !== "none");
ok("and an executed-but-unfunded successor is 'pending', not locked",
  withGoverning.successor.state === "pending", withGoverning.successor.state);
ok("successor carries start_date from the shared helper",
  withGoverning.successor.start_date === "2026-09-01");

const lockedSucc = PC.classifyPosition(row([
  lease({ id: "CUR", lease_status: "active", start_date: "2025-09-01", end_date: "2026-08-31" }),
  lease({ id: "NEXT", start_date: "2026-09-01", end_date: "2027-08-31",
    executed_verified: true, move_in_funds_cleared: true }),
]), { asOf: AS_OF });
ok("an executed AND funded successor is locked", lockedSucc.successor.state === "locked");

section("E  the governed rules are not weakened");
const noCharges = PC.classifyFutureCommitment(lease({
  executed_verified: true, move_in_funds_cleared: false }));
ok("absence of a required charge set is NOT funded → pending",
  noCharges.state === "pending");
// space_position.js:149 states this explicitly. A lease with no move-in
// charges must not default to funded, and this proof exists so that a future
// "why is nothing ever locked?" change cannot quietly flip it.

section("F  terminal and non-future leases create no commitment");
for (const st of ["cancelled", "terminated", "rescinded", "void", "superseded", "expired"]) {
  const p = PC.classifyPosition(row([lease({ lease_status: st })]), { asOf: AS_OF });
  ok(`a ${st} future lease yields NO commitment`,
    p.future_commitment.state === "none", p.future_commitment.state);
  ok(`...and does not suppress marketing`, p.availability_state === "ready_now");
}

section("G  a vacant position with no lease at all");
const empty = PC.classifyPosition(row([]), { asOf: AS_OF });
ok("future_commitment is 'none'", empty.future_commitment.state === "none");
ok("availability_state is ready_now", empty.availability_state === "ready_now");

section("H  activation-pending is distinct from a future commitment");
const commenced = PC.classifyPosition(row([
  lease({ lease_status: "pending", start_date: "2026-07-01", end_date: "2027-06-30" }),
]), { asOf: AS_OF });
ok("a pending lease spanning today is committed_activation_pending",
  commenced.availability_state === "committed_activation_pending");
ok("...and is NOT reported as a future commitment",
  commenced.future_commitment.state === "none", commenced.future_commitment.state);

section("I  availability_read maps proof, not assumption");
// marketingState is exported, so the mapping is provable directly — no
// database fixture can make this clearer than calling the function.
const { marketingState } = require(path.join(__dirname, "..", "src/surfaces/availability_read.js"));
const pos = (o) => Object.assign({
  availability_state: "committed_future", successor: { state: "none", lease_id: null, proof_basis: null },
  future_commitment: { state: "none", lease_id: null, start_date: null, proof_basis: null, locked: false },
  lease: null, notice_state: "none", conflict_state: "clear",
}, o);

const mPending = marketingState(pos({
  future_commitment: { state: "pending", lease_id: "L1", start_date: "2026-10-01",
    proof_basis: "unproven", locked: false } }), true);
ok("committed_future + PENDING commitment → successor_pending, NOT locked",
  mPending.state === "successor_pending", mPending.state);
ok("...and the reason names execution and funding",
  /execution_and_funding/.test(mPending.reason), mPending.reason);

const mLocked = marketingState(pos({
  future_commitment: { state: "locked", lease_id: "L2", start_date: "2026-10-01",
    proof_basis: "native_verified", locked: true } }), true);
ok("committed_future + LOCKED commitment → successor_locked", mLocked.state === "successor_locked");

const mOpening = marketingState(pos({
  future_commitment: { state: "pending", lease_id: "L3", start_date: "2026-10-01",
    proof_basis: "confirmed_opening_import", locked: false } }), true);
ok("a confirmed opening import suppresses marketing", mOpening.state !== "marketable_now");
ok("...but is NOT reported locked", mOpening.state === "successor_pending", mOpening.state);

const mMissing = marketingState(pos({ future_commitment: null }), true);
ok("committed_future with NO commitment object → pending, never upgraded to locked",
  mMissing.state === "successor_pending", mMissing.state);
ok("...and says the proof was unavailable",
  /proof_unavailable/.test(mMissing.reason), mMissing.reason);

// The regression this whole pass exists to prevent.
ok("NO committed_future input can produce successor_locked without locked proof",
  ["pending", "none", null].every((st) => {
    const r = marketingState(pos({
      future_commitment: st ? { state: st, lease_id: "X", start_date: null,
        proof_basis: "unproven", locked: false } : null }), true);
    return r.state !== "successor_locked";
  }));

console.log(`\n════ ${pass} passed, ${fail} failed ════\n`);
process.exit(fail === 0 ? 0 : 1);
