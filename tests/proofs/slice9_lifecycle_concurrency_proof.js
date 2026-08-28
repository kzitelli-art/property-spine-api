/* ══════════════════════════════════════════════════════════════════════════
   slice9_lifecycle_concurrency_proof.js — REAL two-connection contention.

   The authority reads its companion facts FOR UPDATE. That the SQL says so is
   not evidence: what must be proven is that a transition attempted while
   another transaction holds the companion lock actually BLOCKS, then re-reads
   the COMMITTED state rather than proceeding from its stale pre-lock view.

   Scenario, on two independent clients:

     T2  begin · select the terms_review obligation FOR UPDATE · hold
     T1  begin · markLeaseReadyFromApproval
                 → locks the application
                 → BLOCKS on the obligation
     assert T1 is still unresolved while T2 holds the lock (bounded wait +
            pg_locks evidence, never an unbounded hang)
     T2  update the obligation to 'complete' · commit
     T1  resumes, sees status='complete', refuses with
         terms_review_obligation_wrong_status
     assert the application is still 'submitted' and approved_at unchanged

   A delay alone would prove nothing — the assertion is on the UNRESOLVED
   promise plus a real granted/waiting lock row.

   Run: node tests/proofs/slice9_lifecycle_concurrency_proof.js
   ══════════════════════════════════════════════════════════════════════════ */
"use strict";
const path = require("path");
const crypto = require("crypto");
const { Client } = require("pg");

const REPO = path.join(__dirname, "..", "..");
const L = require(path.join(REPO, "src/applications/application_lifecycle.js"));

let pass = 0, fail = 0;
const ok = (m, c) => { if (c) { pass++; console.log("   PASS  " + m); } else { fail++; console.log("   FAIL  " + m); } };
const section = (t) => console.log("\n── " + t + " " + "─".repeat(Math.max(0, 52 - t.length)));
const uuid = () => crypto.randomUUID();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!process.env.DATABASE_URL) {
  console.error("\nDATABASE_URL is required.\n"); process.exit(1);
}

// Never let the harness hang: every wait is bounded and reported.
function settled(promise) {
  const state = { done: false, value: undefined, error: undefined };
  promise.then((v) => { state.done = true; state.value = v; },
              (e) => { state.done = true; state.error = e; });
  return state;
}

(async () => {
  const t1 = new Client({ connectionString: process.env.DATABASE_URL });
  const t2 = new Client({ connectionString: process.env.DATABASE_URL });
  const obs = new Client({ connectionString: process.env.DATABASE_URL });
  await t1.connect(); await t2.connect(); await obs.connect();

  // Captured NOW, while both clients are idle. Once T1 is blocked inside the
  // transition, any further query on that client queues behind it forever —
  // asking a blocked connection for its own pid is a deadlocked harness.
  const t1pid = (await t1.query("select pg_backend_pid() as pid")).rows[0].pid;
  const t2pid = (await t2.query("select pg_backend_pid() as pid")).rows[0].pid;

  // Seed on a third connection and COMMIT, so both transactions can see it.
  const prop = (await obs.query("select id from properties limit 1")).rows[0].id;
  const person = (await obs.query("select id from persons limit 1")).rows[0].id;
  const appId = uuid(), oblId = uuid();
  await obs.query(
    `insert into lease_applications (id, property_id, person_id, status, submitted_at, applicant_name)
     values ($1,$2,$3,'submitted', now(), 'Concurrency Proof')`, [appId, prop, person]);
  await obs.query(
    `insert into obligations (id, property_id, related_id, related_type, type, status)
     values ($1,$2,$3,'lease_application','terms_review','open')`, [oblId, prop, appId]);

  try {
    section("A  T2 holds the companion lock; T1 must block");
    await t2.query("begin");
    await t2.query("select id from obligations where id=$1 for update", [oblId]);

    await t1.query("begin");
    const t1run = settled(L.markLeaseReadyFromApproval(t1, {
      applicationId: appId, termsReviewObligationId: oblId,
    }));

    // Bounded wait — if it resolves here, FOR UPDATE is not doing its job.
    await sleep(1200);
    ok("T1 has NOT completed while T2 holds the obligation lock", t1run.done === false);

    // Counting ANY ungranted lock in the database would pass on an unrelated
    // waiter. The evidence has to name the relation being waited on AND the
    // pid doing the waiting, and that pid must be T1's backend.
    // The actual row-lock-queue signature, confirmed against pg_locks rather
    // than assumed: a waiter for a locked ROW does NOT wait on a relation
    // lock. It takes a tuple lock on the row's relation to hold its place in
    // the queue, then waits on the HOLDER'S transactionid. Asserting a
    // relation wait would never fire; counting any ungranted lock in the
    // database would fire for an unrelated session. Both are named here.
    const locks = (await obs.query(
      `select bl.locktype, bl.granted, bl.mode, bl.relation::regclass::text as rel
         from pg_locks bl where bl.pid = $1`, [t1pid])).rows;

    ok("T1 is WAITING on a transactionid (the row-lock queue signature)",
      locks.some((l) => l.locktype === "transactionid" && l.granted === false));
    ok("T1 holds a tuple lock on obligations — it is queued on THAT row",
      locks.some((l) => l.locktype === "tuple" && l.rel === "obligations"));
    ok("T1 had already locked lease_applications before it blocked",
      locks.some((l) => l.locktype === "relation" && l.rel === "lease_applications" && l.granted));
    ok("T1 is blocked BY T2 specifically (pg_blocking_pids)",
      (await obs.query("select pg_blocking_pids($1) as b", [t1pid])).rows[0].b.includes(t2pid));

    const midStatus = (await obs.query(
      "select status, approved_at from lease_applications where id=$1", [appId])).rows[0];
    ok("the application is still 'submitted' mid-contention", midStatus.status === "submitted");

    section("B  T2 commits a change; T1 must re-read the COMMITTED state");
    await t2.query("update obligations set status='complete' where id=$1", [oblId]);
    await t2.query("commit");

    // T1 should now acquire the lock, see 'complete', and refuse.
    const deadline = Date.now() + 8000;
    while (!t1run.done && Date.now() < deadline) await sleep(50);
    ok("T1 resolved once the lock was released (no unbounded hang)", t1run.done === true);
    ok("T1 REFUSED on the committed status, not the stale pre-lock read",
      !!t1run.error && t1run.error.code === "terms_review_obligation_wrong_status");
    ok("the refusal is a controlled transition error",
      !!t1run.error && t1run.error.transition_state === "refused");

    await t1.query("rollback");

    section("C  no partial effect survives");
    const after = (await obs.query(
      "select status, approved_at from lease_applications where id=$1", [appId])).rows[0];
    ok("the application is still 'submitted'", after.status === "submitted");
    ok("approved_at was never authored", after.approved_at === null);
    const obl = (await obs.query("select status from obligations where id=$1", [oblId])).rows[0];
    ok("T2's committed change stands", obl.status === "complete");

    // ── D  UNCONTENDED CONTROL ────────────────────────────────────────
    //  Without this, section A proves only that the call had not finished
    //  after 1200ms — which a slow call would also satisfy. The same shape
    //  with NO competing lock must resolve promptly. That is what makes the
    //  earlier non-resolution attributable to contention.
    section("D  the same shape resolves promptly with no lock held");
    await obs.query("update obligations set status='open' where id=$1", [oblId]);
    await t1.query("begin");
    const startedAt = process.hrtime.bigint();
    const solo = settled(L.markLeaseReadyFromApproval(t1, {
      applicationId: appId, termsReviewObligationId: oblId,
    }));
    const soloDeadline = Date.now() + 8000;
    while (!solo.done && Date.now() < soloDeadline) await sleep(10);
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    ok(`uncontended call resolved (${elapsedMs.toFixed(0)}ms)`, solo.done === true);
    ok("uncontended call resolved well inside the contended wait window",
      solo.done === true && elapsedMs < 1200);
    ok("and it was not refused for a lock-related reason",
      !solo.error || solo.error.code !== "terms_review_obligation_wrong_status");
    await t1.query("rollback");

    const afterD = (await obs.query(
      "select status from lease_applications where id=$1", [appId])).rows[0];
    ok("the rolled-back control left no committed effect", afterD.status === "submitted");
  } finally {
    await t1.query("rollback").catch(() => {});
    await t2.query("rollback").catch(() => {});
    await obs.query("delete from obligations where id=$1", [oblId]).catch(() => {});
    await obs.query("delete from lease_applications where id=$1", [appId]).catch(() => {});
    await t1.end().catch(() => {}); await t2.end().catch(() => {}); await obs.end().catch(() => {});
  }

  console.log(`\n════ ${pass} passed, ${fail} failed ════\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nPROOF CRASHED:", e.message, "\n"); process.exit(1); });
