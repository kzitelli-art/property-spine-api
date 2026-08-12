#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   BOUNDARY 8b — THE ACTIVATION RUNNER

   `recordActivation` has existed since Step 7 and has never had a caller
   that could run against production. Every existing caller is a proof or
   a falsification suite, each refusing anything but an isolated baseline.
   That gap is why this file exists, and it is deliberately the ONLY thing
   in this repository that can perform the cutover.

   The alternative — a hand-run one-liner against production — is the
   exact shape of failure this whole release was built to make impossible.

   ── TWO MODES, AND THE DEFAULT IS THE SAFE ONE ──────────────────────

       node tools/step7/activate.js --dry-run --census census.json

   Opens a transaction PROVEN unable to write before it reads anything,
   and reports the five facts the owner asked to see:

       POPULATION_NOT_EXPLAINABLE  ·  legacy count  ·  legacy digest
       guard currently inactive    ·  census freshness

   Then stops. `--dry-run` is not a flag you remember to add: WRITING
   requires `--activate` AND `R0_ACTIVATION_AUTHORIZATION`, and with
   neither of those this refuses rather than doing anything.

       R0_ACTIVATION_AUTHORIZATION='authorized by <owner> <when>' \
         node tools/step7/activate.js --activate --census census.json

   ── WHY THE CENSUS COMES FROM A FILE ────────────────────────────────

   Taking the census inside this process and then handing it to the
   activation as the expected set would make the comparison vacuous: it
   would always match itself. §6.2's point is that a HUMAN reads a census,
   decides, and the activation then refuses if production moved in
   between. So the expected set is supplied:

       R0_CENSUS_AUTHORIZATION='...' node tools/step7/census.js --json > census.json

   The runner re-derives the digest from the file's own set and checks it
   against the digest the census recorded, so a hand-edited census cannot
   be fed in.

   ── WHAT THIS FILE DOES NOT DECIDE ──────────────────────────────────

   Nothing. Every refusal below already exists inside recordActivation and
   is enforced in the same transaction as the write. This reports them
   BEFORE the write so the owner is not learning about a refusal from a
   stack trace. It never relaxes one, and it cannot: the write path calls
   the service and nothing else.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Client } = require("pg");

const ROOT = path.join(__dirname, "..", "..");
const svc = require(path.join(ROOT, "src/release0/activation_service.js"));
const { beginProvenReadOnly } = require(path.join(ROOT, "tools/activation/_readonly.js"));

const ARGV = process.argv.slice(2);
const has = (f) => ARGV.includes(f);
const val = (f) => { const i = ARGV.indexOf(f); return i >= 0 ? ARGV[i + 1] : null; };

const DRY = has("--dry-run");
const GO = has("--activate");
const CENSUS_FILE = val("--census");
const AUTH = process.env.R0_ACTIVATION_AUTHORIZATION;
const URL = process.env.DATABASE_URL;

const bar = "═".repeat(70);
const say = (k, v) => console.log("  " + String(k).padEnd(34, " ") + v);
const fail = (msg, extra) => {
  console.error("\n  ⛔ REFUSED — " + msg);
  if (extra) console.error("     " + extra);
  console.error("");
  process.exit(1);
};

//  Recomputed exactly as census.js does. Restated here would be a second
//  definition; this is the same five fields in the same order, and it is
//  checked against the census file's own digest below, so a drift between
//  the two shows up as a mismatch rather than as a silent pass.
const digestOf = (rows) => crypto.createHash("sha256").update(JSON.stringify(
  rows.map((r) => ({
    work_order_id: r.work_order_id, property_id: r.property_id, status: r.status,
    had_column_photo: r.had_column_photo, had_column_note: r.had_column_note,
  })))).digest("hex");

(async function main() {
  if (!URL) fail("DATABASE_URL is not set.", "Run this ON the deployed instance.");
  if (!DRY && !GO) {
    fail("neither --dry-run nor --activate was given.",
      "This tool does nothing by default. Start with --dry-run.");
  }
  if (DRY && GO) fail("--dry-run and --activate are mutually exclusive.");
  if (!CENSUS_FILE) {
    fail("--census <file> is required.",
      "Produce it first:  R0_CENSUS_AUTHORIZATION='...' node tools/step7/census.js --json > census.json");
  }
  if (GO && !AUTH) {
    fail("R0_ACTIVATION_AUTHORIZATION is not set.",
      "The cutover is the one irreversible act in this release. It records WHO " +
      "authorized it, and refuses to be run by someone who did not say so.");
  }

  let census;
  try { census = JSON.parse(fs.readFileSync(CENSUS_FILE, "utf8")); }
  catch (e) { fail("could not read the census file: " + e.message); }
  if (census.kind !== "release_0_cutover_census" || !Array.isArray(census.set)) {
    fail("that file is not a census receipt.",
      "Expected the output of `node tools/step7/census.js --json`.");
  }
  //  A census whose digest does not describe its own set has been edited.
  const recomputed = digestOf(census.set);
  if (recomputed !== census.digest) {
    fail("the census file's digest does not match its own set.",
      `recorded ${census.digest.slice(0, 16)} · recomputed ${recomputed.slice(0, 16)} — ` +
      "this file has been modified since the census produced it.");
  }

  console.log("\n" + bar);
  console.log(`  RELEASE 0 · ACTIVATION  ${DRY ? "— DRY RUN (writes nothing)" : "— LIVE CUTOVER"}`);
  console.log(bar + "\n");

  const c = new Client({ connectionString: URL, ssl: { rejectUnauthorized: false } });
  try { await c.connect(); }
  catch (e) { fail("could not connect: " + (e.code || "connection failed"),
    "(detail withheld — connection errors can echo the credential)"); }

  say("running SHA", (process.env.RENDER_GIT_COMMIT || process.env.GIT_SHA || "UNKNOWN").slice(0, 12));
  say("census file", `${CENSUS_FILE}  (${census.count} row(s))`);
  say("census taken at", census.taken_at);
  say("census authorization", census.authorization);

  //  ── FRESHNESS ────────────────────────────────────────────────────
  //  The census tool says it plainly: a stale census is the whole reason
  //  it exists. Reported as a number rather than judged for the owner —
  //  but the LIVE path refuses on it, because "I took that census this
  //  morning" is exactly how a cutover inherits a population nobody
  //  looked at.
  const ageMin = (Date.now() - new Date(census.taken_at).getTime()) / 60000;
  const STALE_MIN = 15;
  say("census age", `${ageMin.toFixed(1)} min` + (ageMin > STALE_MIN ? "   ⛔ STALE" : "   fresh"));

  // ── THE READ-ONLY PHASE. Both modes run it. ───────────────────────
  const ro = await beginProvenReadOnly(c, "r0_activate");
  if (!ro.ok) { await c.end(); fail("read-only could not be proven — " + ro.reason); }
  say("read-only probe", "PROVEN — a write was attempted and refused");
  console.log("");

  const live = await svc.readLegacyTerminalSet(c);
  const liveDigest = digestOf(live);

  const epoch = (await c.query(
    `select activation_id, activated_at from release_0_activation_epoch`).catch(() => ({ rows: [] }))).rows[0];
  const history = Number((await c.query(
    `select count(*) n from release_0_activation_history`).catch(() => ({ rows: [{ n: -1 }] }))).rows[0].n);

  //  The SAME predicate the guard calls, and the same one the activation
  //  transaction will run. Not a copy — the SQL function installed by 140.
  const unexplainable = (await c.query(
    `select w.id as work_order_id, w.status,
            public.release_0_completion_proof_status(w.id, w.property_id) as proof_status
       from work_orders w
      where w.status in ('complete','closed')
        and public.release_0_completion_proof_status(w.id, w.property_id) <> 'none'
        and not (w.status = 'complete'
                 and public.release_0_completion_proof_status(w.id, w.property_id) = 'grounded')
      order by w.id`).catch((e) => { throw e; })).rows;

  const guardInactive = !!epoch && !epoch.activation_id;
  const setsMatch = liveDigest === census.digest;

  console.log("  ── the five facts ────────────────────────────────────────────────");
  console.log(`     POPULATION_NOT_EXPLAINABLE   ${unexplainable.length}` +
    (unexplainable.length === 0 ? "   ✓" : "   ⛔ activation will refuse"));
  console.log(`     legacy population (live)     ${live.length} row(s)`);
  console.log(`     legacy digest (live)         ${liveDigest}`);
  console.log(`     …matches the census file     ${setsMatch ? "YES  ✓" : "NO   ⛔ production moved"}`);
  console.log(`     guard currently              ${guardInactive ? "INACTIVE  ✓" : "ACTIVE — already cut over"}`);
  console.log(`     activation history rows      ${history}`);
  console.log("");

  if (unexplainable.length) {
    console.log("  ── unexplainable rows ────────────────────────────────────────────");
    unexplainable.forEach((r) => console.log(
      `     ${r.work_order_id}  ${r.status}  proof_status=${r.proof_status}`));
    console.log("     Each is terminal with an evaluation that does not justify it.");
    console.log("     Resolve each, re-run the census, then re-authorize.\n");
  }

  console.log("  ── the legacy population being frozen ────────────────────────────");
  if (!live.length) console.log("     (none)");
  live.forEach((r) => console.log(
    `     ${r.work_order_id}  ${r.status}  photo:${r.had_column_photo ? "yes" : "no "}  note:${r.had_column_note ? "yes" : "no "}`));
  console.log("");

  await c.query("rollback").catch(() => {});

  // ── DRY RUN STOPS HERE ────────────────────────────────────────────
  if (DRY) {
    const ready = unexplainable.length === 0 && setsMatch && guardInactive && ageMin <= STALE_MIN;
    console.log(bar);
    console.log(ready
      ? "  ✓ READY. Every precondition holds. Nothing was written."
      : "  ⛔ NOT READY. See the marks above. Nothing was written.");
    if (ready) {
      console.log("");
      console.log("  To cut over, with the SAME census file:");
      console.log("    R0_ACTIVATION_AUTHORIZATION='authorized by <owner> <when>' \\");
      console.log(`      node tools/step7/activate.js --activate --census ${CENSUS_FILE}`);
    }
    console.log(bar + "\n");
    await c.end();
    process.exit(ready ? 0 : 1);
  }

  // ── LIVE CUTOVER ──────────────────────────────────────────────────
  //  Every one of these is ALSO enforced inside recordActivation, in the
  //  same transaction as the write. Refusing here as well is not
  //  belt-and-braces for its own sake: it means the owner reads a
  //  sentence instead of a stack trace, and it means the connection is
  //  never even switched out of read-only when a precondition is off.
  if (ageMin > STALE_MIN) {
    await c.end();
    fail(`the census is ${ageMin.toFixed(1)} minutes old (limit ${STALE_MIN}).`,
      "Re-run the census and re-authorize. A stale census is the whole reason that tool exists.");
  }
  if (!setsMatch) {
    await c.end();
    fail("production has moved since the census was taken.",
      `census ${census.digest.slice(0, 16)} · live ${liveDigest.slice(0, 16)} — re-run the census.`);
  }
  if (unexplainable.length) {
    await c.end();
    fail(`${unexplainable.length} terminal row(s) are not explainable.`,
      "Activating would make them permanent. Resolve them first.");
  }
  if (!guardInactive) {
    await c.end();
    fail("the guard is already active.",
      `epoch activation_id=${epoch && epoch.activation_id} — the cutover already happened.`);
  }

  /*  ── THE BOUNDARY INSTANT IS THE CENSUS, NOT THE CLOCK ────────────
   *
   *  The first version of this runner used `new Date()` here and was
   *  REFUSED against production:
   *
   *    BAD_INPUT  activated_at (…:49.436Z) is not earlier than this
   *    transaction's start (…:49.435Z)
   *
   *  One millisecond, and the guard was right twice over.
   *
   *  Practically: Node runs on Render and now() comes from Neon. Two
   *  machines, two clocks. A wall-clock instant taken microseconds before
   *  `begin` can still land after the transaction start, and no amount of
   *  ordering the statements fixes a skew.
   *
   *  Semantically — and this is the real point — the service already says
   *  what this argument is for: "step 6 happens, then step 7's transaction
   *  opens. A legitimate captured instant is minutes older." The boundary
   *  is not "when I ran this command". It is the moment the legacy
   *  population was measured. Everything after it must be proven;
   *  everything at or before it is what the census just inventoried.
   *
   *  That instant is the census's own `taken_at`. It is already
   *  authorized, already reviewed, and already the thing the drift check
   *  guarantees nothing has moved since. Using it makes the boundary a
   *  recorded decision rather than an artifact of when someone typed.
   *
   *  The service's comment calls its own check "a happy accident" — a
   *  second, independent guard against a derived instant. It caught this
   *  on the first real run. Nothing about it is accidental now.  */
  const activatedAt = new Date(census.taken_at);
  console.log("  ── cutting over ──────────────────────────────────────────────────");
  say("authorization", AUTH);
  say("activated_at", activatedAt.toISOString() + "   (the census instant, not the wall clock)");

  let receipt;
  await c.query("begin");
  try {
    receipt = await svc.recordActivation(c, {
      activated_at: activatedAt,
      captured_by: AUTH,
      expected: census.set,
      captured_at_step: "step_6",
    });
    await c.query("commit");
  } catch (e) {
    await c.query("rollback").catch(() => {});
    await c.end();
    console.error("\n  ⛔ THE CUTOVER WAS REFUSED AND ROLLED BACK. Nothing changed.\n");
    console.error("     " + (e.code || "ERROR") + "  " + (e.message || e));
    if (e.detail) console.error("     " + JSON.stringify(e.detail, null, 2).split("\n").join("\n     "));
    console.error("");
    process.exit(1);
  }

  const after = (await c.query(
    `select activation_id, activated_at from release_0_activation_epoch`)).rows[0];

  console.log("");
  console.log(bar);
  console.log("  ✓ CUTOVER RECORDED");
  console.log(bar);
  //  The service returns the row under `activation`, not a flat
  //  activation_id. The first version guessed the shape and printed
  //  "(see receipt)" on a successful cutover — harmless, but a receipt
  //  that cannot name what it just did is a poor receipt.
  const act = (receipt && receipt.activation) || {};
  say("activation id", act.id || "(not returned)");
  say("outcome", (receipt && receipt.outcome) || "(not returned)");
  say("epoch activation_id", after ? after.activation_id : "(absent)");
  say("epoch activated_at", after ? String(after.activated_at) : "(absent)");
  say("legacy inventoried", JSON.stringify(receipt && receipt.inventory));
  console.log("");
  console.log("  The guard is now ACTIVE. From this instant, a terminal work order");
  console.log("  without a grounded proof evaluation is refused by the database.");
  console.log("");
  console.log("  Next: prove both sides, then re-run the census.");
  console.log(bar + "\n");

  await c.end();
})().catch((e) => {
  console.error("\n  ⛔ " + (e && e.code ? e.code + " — " : "") + (e && e.message || e));
  console.error("");
  process.exit(2);
});
