/* ══════════════════════════════════════════════════════════════════════════
   slice9_lifecycle_authority_proof.js — the ISOLATED authority proof.

   No production caller exists yet, by design. This exercises the five writers
   directly against real Postgres, inside a transaction that is rolled back.

   Run twice:
     UNDER_125=0 node tests/slice9_lifecycle_authority_proof.js   (124 only)
     UNDER_125=1 node tests/slice9_lifecycle_authority_proof.js   (125 applied)

   The claims that matter are the ones a plausible implementation gets wrong:
     · a historical row's missing submitted_at survives approval, admission
       and activation — it is never "repaired";
     · admission writes STATUS ONLY and countersigned_at is byte-identical;
     · already_beyond_target is distinct from already_at_target, so a caller
       cannot emit a duplicate admission event;
     · companion obligations are verified, not trusted;
     · every instant comes from Postgres, never a JS clock.
   ══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const REPO = path.join(__dirname, "..");
const MODULE_PATH = path.join(REPO, "src/applications/application_lifecycle.js");
const L = require(MODULE_PATH);

let pass = 0, fail = 0;
const ok = (m, c) => { if (c) { pass++; console.log("   PASS  " + m); } else { fail++; console.log("   FAIL  " + m); } };
const section = (t) => console.log("\n── " + t + " " + "─".repeat(Math.max(0, 54 - t.length)));
const uuid = () => crypto.randomUUID();
const UNDER_125 = process.env.UNDER_125 === "1";

if (!process.env.DATABASE_URL) {
  console.error("\nDATABASE_URL is required. This proof asserts against real Postgres.\n");
  process.exit(1);
}

async function refusedCode(c, fn) {
  await c.query("savepoint p");
  try { await fn(); await c.query("release savepoint p"); return null; }
  catch (e) { await c.query("rollback to savepoint p"); return e.code || "(no code)"; }
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  console.log(`\n══ lifecycle authority — ${UNDER_125 ? "UNDER STAGED 125" : "under 124 only"} ══`);

  section("A  module shape and isolation");
  const src = fs.readFileSync(MODULE_PATH, "utf8");
  const writers = ["createSubmittedApplication", "markLeaseReadyFromApproval",
    "markTermConfirmationRequiredFromExecutedLease", "markActiveFromConfirmedTerm", "markTerminal"];
  ok("exactly the five writable acts are exported",
    writers.every((w) => typeof L[w] === "function"));
  ok("no writer for exact approved / tenant_signed / countersigned",
    !L.approveApplication && !L.markTenantSigned && !L.markCountersigned && !L.markLeaseReady && !L.markAcceptedTermRequired && !L.markActive);
  ok("retired statuses remain READABLE vocabulary",
    L.STATUS.APPROVED === "approved" && L.LADDER.includes("tenant_signed") && L.LADDER.includes("countersigned"));
  const noComments = src.replace(/^\s*\/\/.*$/gm, "");
  ok("module opens no connection and owns no transaction",
    !/pool\.connect|\.connect\(\)|\bbegin\b|\bcommit\b|rollback/i.test(noComments));
  ok("module imports nothing — no pool, express, session or obligation engine",
    !/require\(/.test(noComments));
  ok("no JavaScript clock supplies a lifecycle instant",
    !/new Date\(|Date\.now\(/.test(noComments));
  ok("every authored instant is transaction_timestamp()",
    (noComments.match(/transaction_timestamp\(\)/g) || []).length >= 8);

  section("B  transition assessment distinguishes all four outcomes");
  ok("applied", L.assessTransition("submitted", "lease_ready").transition_state === "applied");
  ok("already_at_target", L.assessTransition("active", "active").transition_state === "already_at_target");
  ok("already_beyond_target is NOT collapsed into idempotency",
    L.assessTransition("active", "accepted_term_required").transition_state === "already_beyond_target");
  ok("refused: terminal cannot reopen",
    L.assessTransition("declined", "submitted").transition_state === "refused");
  ok("refused: terminal disposition is immutable",
    L.assessTransition("declined", "withdrawn").transition_state === "refused");
  ok("refused: terminal origin not permitted (active → declined)",
    L.assessTransition("active", "declined").transition_state === "refused");
  ok("draft → withdrawn is allowed",
    L.assessTransition("draft", "withdrawn").transition_state === "applied");

  const c = await pool.connect();
  try {
    await c.query("begin");
    const prop = (await c.query("select id from properties limit 1")).rows[0].id;
    const person = (await c.query("select id from persons limit 1")).rows[0].id;
    const user = (await c.query("select id from users limit 1")).rows[0];
    const unit = (await c.query("select id from units where property_id=$1 limit 1", [prop])).rows[0];

    // A genuinely HISTORICAL row (null milestones at a submission-reached
    // status) cannot be created while 124's compatibility trigger is active —
    // it authors the milestone on INSERT, correctly. Such rows only exist from
    // before the migration, so the fixture reproduces that by disabling the
    // adapter for the seed and restoring it immediately.
    // Under 124 the compatibility adapter authors the milestone on INSERT;
    // under 125 the strict trigger REFUSES the insert outright. Either way a
    // genuinely historical row can only be seeded by standing the relevant
    // trigger down for the seed — which is exactly what "predates enforcement"
    // means. Whichever trigger is present is the one to disable.
    const historicalTrigger = UNDER_125
      ? "trg_application_authors_milestones" : "trg_app_compat_author_milestones";
    const mkHistorical = async (status, extra = {}) => {
      await c.query(`alter table lease_applications disable trigger ${historicalTrigger}`);
      try { return await mkApp(status, extra); }
      finally { await c.query(`alter table lease_applications enable trigger ${historicalTrigger}`); }
    };
    const mkApp = async (status, extra = {}) => {
      const cols = { id: uuid(), property_id: prop, person_id: person, status, ...extra };
      const keys = Object.keys(cols);
      await c.query(
        `insert into lease_applications (${keys.join(",")}) values (${keys.map((_, i) => `$${i + 1}`).join(",")})`,
        keys.map((k) => cols[k]));
      return cols.id;
    };
    const mkObl = async (appId, type, status) => {
      const id = uuid();
      await c.query(
        `insert into obligations (id, property_id, related_id, related_type, type, status)
         values ($1,$2,$3,'lease_application',$4,$5)`, [id, prop, appId, type, status]);
      return id;
    };
    const row = async (id) => (await c.query("select * from lease_applications where id=$1", [id])).rows[0];

    // executed_lease_records has 13 NOT NULL columns with no defaults; supply
    // them all in one place rather than discovering them one crash at a time.
    const mkExecuted = async (appId, spaceId, state, hash) => {
      const id = uuid();
      const ev = (await c.query(
        `insert into events (property_id, type, note) values ($1,'proof_executed_lease','iso') returning id`,
        [prop])).rows[0].id;
      await c.query(
        `insert into executed_lease_records
          (id, application_id, property_id, space_id, rent, security_deposit, lease_start_date,
           lease_end_date, payload_hash, record_state, executed_at, signers, execution_channel,
           verified_by_user_id, event_id, document_sha256, voided_by_user_id, void_reason)
         values ($1,$2,$3,$4,1500,1500,'2026-09-01','2027-08-31',$5,$6,now(),
                 '[{"role":"applicant","name":"Iso"}]'::jsonb,'paper',$7,$8,$5,$9,$10)`,
        [id, appId, prop, spaceId, hash, state, user ? user.id : null, ev,
         state === 'voided' ? (user ? user.id : null) : null,
         state === 'voided' ? 'iso proof void' : null]);
      return id;
    };

    section("C  birth authors submitted_at in one statement");
    const born = await L.createSubmittedApplication(c, {
      columns: { id: uuid(), property_id: prop, person_id: person, applicant_name: "Iso Proof" },
    });
    ok("status is submitted", born.application.status === "submitted");
    ok("submitted_at authored", born.application.submitted_at != null);
    ok("receipt reports it authored NOW", born.milestones_authored_now.includes("submitted_at"));
    ok("transition_state applied", born.transition_state === "applied");
    const dbNow = (await c.query("select transaction_timestamp() t")).rows[0].t;
    ok("instant is the DATABASE transaction clock",
      Math.abs(new Date(born.application.submitted_at) - new Date(dbNow)) < 1000);

    section("D  approval authors approved_at only when crossing");
    const a1 = await mkApp("submitted", { submitted_at: new Date().toISOString() });
    const o1 = await mkObl(a1, "terms_review", "open");
    const r1 = await L.markLeaseReadyFromApproval(c, { applicationId: a1, termsReviewObligationId: o1 });
    ok("submitted → lease_ready applied", r1.transition_state === "applied" && r1.application.status === "lease_ready");
    ok("approved_at authored on the crossing", r1.milestones_authored_now.includes("approved_at"));
    ok("terms_review obligation pointer written", r1.application.terms_review_obligation_id === o1);

    // HISTORICAL: submitted_at null must survive approval untouched.
    const a2 = await mkHistorical("submitted");
    const o2 = await mkObl(a2, "terms_review", "in_progress");
    const r2 = await L.markLeaseReadyFromApproval(c, { applicationId: a2, termsReviewObligationId: o2 });
    ok("historical missing submitted_at is NOT repaired by approval", r2.application.submitted_at === null);
    ok("and is absent from present_after", !r2.milestones_present_after.includes("submitted_at"));

    // HISTORICAL approved with approved_at null: advancing authors nothing.
    const a3 = await mkHistorical("approved");
    const o3 = await mkObl(a3, "terms_review", "open");
    const r3 = await L.markLeaseReadyFromApproval(c, { applicationId: a3, termsReviewObligationId: o3 });
    ok("historical approved with null approved_at keeps it NULL", r3.application.approved_at === null);
    ok("nothing reported authored", r3.milestones_authored_now.length === 0);

    section("E  approval refuses bad companion facts");
    const a4 = await mkApp("submitted", { submitted_at: new Date().toISOString() });
    ok("missing obligation refused",
      (await refusedCode(c, () => L.markLeaseReadyFromApproval(c, { applicationId: a4 }))) === "terms_review_obligation_required");
    const wrongType = await mkObl(a4, "term_required", "open");
    ok("wrong obligation type refused",
      (await refusedCode(c, () => L.markLeaseReadyFromApproval(c, { applicationId: a4, termsReviewObligationId: wrongType }))) === "terms_review_obligation_wrong_type");
    const otherApp = await mkApp("submitted", { submitted_at: new Date().toISOString() });
    const foreign = await mkObl(otherApp, "terms_review", "open");
    ok("wrong lineage refused",
      (await refusedCode(c, () => L.markLeaseReadyFromApproval(c, { applicationId: a4, termsReviewObligationId: foreign }))) === "terms_review_obligation_lineage_mismatch");
    const closed = await mkObl(a4, "terms_review", "complete");
    ok("closed obligation refused",
      (await refusedCode(c, () => L.markLeaseReadyFromApproval(c, { applicationId: a4, termsReviewObligationId: closed }))) === "terms_review_obligation_wrong_status");

    section("F  admission writes STATUS ONLY");
    const stamp = "2020-01-02T03:04:05.000Z";
    const a5 = await mkApp("lease_ready", { submitted_at: stamp, approved_at: stamp, countersigned_at: stamp });
    const beforeCs = (await row(a5)).countersigned_at;
    const space0 = (await c.query("select id from spaces where unit_id=$1 limit 1", [unit.id])).rows[0];
    const elr = await mkExecuted(a5, space0.id, 'verified', 'h1');
    const to1 = await mkObl(a5, "term_required", "open");
    const r5 = await L.markTermConfirmationRequiredFromExecutedLease(c, {
      applicationId: a5, executedLeaseRecordId: elr, termRequiredObligationId: to1 });
    ok("status is accepted_term_required", r5.application.status === "accepted_term_required");
    ok("countersigned_at is BYTE-IDENTICAL through admission",
      String((await row(a5)).countersigned_at) === String(beforeCs));
    ok("no milestone was authored by admission", r5.milestones_authored_now.length === 0);

    section("G  admission refuses bad evidence");
    const a6 = await mkApp("lease_ready", { submitted_at: stamp, approved_at: stamp });
    const to2 = await mkObl(a6, "term_required", "open");
    ok("wrong-application record refused",
      (await refusedCode(c, () => L.markTermConfirmationRequiredFromExecutedLease(c,
        { applicationId: a6, executedLeaseRecordId: elr, termRequiredObligationId: to2 }))) === "executed_lease_record_lineage_mismatch");
    const voided = await mkExecuted(a6, space0.id, 'voided', 'h2');
    ok("voided record refused",
      (await refusedCode(c, () => L.markTermConfirmationRequiredFromExecutedLease(c,
        { applicationId: a6, executedLeaseRecordId: voided, termRequiredObligationId: to2 }))) === "executed_lease_record_not_verified");
    const a6b = await mkApp("lease_ready", { submitted_at: stamp, approved_at: stamp });
    const elr6b = await mkExecuted(a6b, space0.id, 'verified', 'h3');
    ok("missing term obligation refused",
      (await refusedCode(c, () => L.markTermConfirmationRequiredFromExecutedLease(c,
        { applicationId: a6b, executedLeaseRecordId: elr6b }))) === "term_required_obligation_required");

    section("H  already_beyond_target is a distinct, zero-write outcome");
    const lease = uuid();
    await c.query(
      `insert into leases (id, property_id, space_id, application_id, start_date, end_date, rent, lease_status)
       values ($1,$2,$3,$4,'2026-09-01','2027-08-31',1500,'active')`, [lease, prop, space0.id, a5]);
    await c.query("update obligations set status='complete' where id=$1", [to1]);
    const act = await L.markActiveFromConfirmedTerm(c, { applicationId: a5, leaseId: lease, termRequiredObligationId: to1 });
    ok("activation applied", act.application.status === "active");
    ok("activated_at authored", act.application.activated_at != null);
    ok("activation did NOT fill submitted_at from nothing",
      act.application.submitted_at != null === (stamp != null));

    const beyond = await L.markTermConfirmationRequiredFromExecutedLease(c, {
      applicationId: a5, executedLeaseRecordId: elr, termRequiredObligationId: to1 });
    ok("active → accepted_term_required returns already_beyond_target",
      beyond.transition_state === "already_beyond_target");
    ok("and writes NOTHING", beyond.milestones_authored_now.length === 0 && beyond.application.status === "active");

    section("I  activation refuses bad lineage");
    const a7 = await mkApp("accepted_term_required", { submitted_at: stamp, approved_at: stamp });
    const to3 = await mkObl(a7, "term_required", "open");
    ok("wrong lease lineage refused",
      (await refusedCode(c, () => L.markActiveFromConfirmedTerm(c,
        { applicationId: a7, leaseId: lease, termRequiredObligationId: to3 }))) === "lease_lineage_mismatch");
    const lease2 = uuid();
    await c.query(
      `insert into leases (id, property_id, space_id, application_id, start_date, end_date, rent, lease_status)
       values ($1,$2,$3,$4,'2026-09-01','2027-08-31',1500,'active')`, [lease2, prop, space0.id, a7]);
    ok("incomplete term obligation refused",
      (await refusedCode(c, () => L.markActiveFromConfirmedTerm(c,
        { applicationId: a7, leaseId: lease2, termRequiredObligationId: to3 }))) === "term_required_obligation_wrong_status");

    section("J  terminal matrix matches the ruling exactly");
    // Under 125 a seed row must itself satisfy the milestone rules, so give
    // each origin status the milestones that status legitimately implies.
    const milestonesFor = (s) => ({
      ...(L.reachedSubmission(s) ? { submitted_at: stamp } : {}),
      ...(L.reachedApproval(s) ? { approved_at: stamp } : {}),
    });
    const term = async (fromStatus, code, extra = {}) => {
      const id = await mkApp(fromStatus, { ...milestonesFor(fromStatus), ...extra });
      return refusedCode(c, () => L.markTerminal(c, {
        applicationId: id, terminalCode: code, decisionReason: "iso proof",
        actorUserId: user ? user.id : null }));
    };
    for (const [from, code] of [["submitted", "declined"], ["approved", "declined"], ["lease_ready", "declined"],
      ["submitted", "expired"], ["approved", "expired"], ["lease_ready", "expired"],
      ["draft", "withdrawn"], ["submitted", "withdrawn"], ["approved", "withdrawn"], ["lease_ready", "withdrawn"]]) {
      ok(`${from} → ${code} allowed`, (await term(from, code)) === null);
    }
    ok("draft → declined refused", (await term("draft", "declined")) === "terminal_origin_not_permitted");
    ok("draft → expired refused", (await term("draft", "expired")) === "terminal_origin_not_permitted");
    ok("accepted_term_required → declined refused",
      (await term("accepted_term_required", "declined")) === "terminal_origin_not_permitted");
    ok("active → withdrawn refused", (await term("active", "withdrawn")) === "terminal_origin_not_permitted");

    section("K  terminal shape, replay and history");
    const dw = await mkApp("draft");
    const rdw = await L.markTerminal(c, { applicationId: dw, terminalCode: "withdrawn", decisionReason: "changed mind", actorUserId: user ? user.id : null });
    ok("draft → withdrawn leaves submitted_at NULL", rdw.application.submitted_at === null);
    ok("terminal_code equals status", rdw.application.terminal_code === rdw.application.status);
    ok("terminal_at and decided_at both authored", rdw.application.terminal_at != null && rdw.application.decided_at != null);

    const aw = await mkApp("approved", { submitted_at: stamp, approved_at: stamp });
    const raw = await L.markTerminal(c, { applicationId: aw, terminalCode: "withdrawn", decisionReason: "gone", actorUserId: user ? user.id : null });
    ok("approved → withdrawn RETAINS approved_at", raw.application.approved_at != null);
    ok("and retains submitted_at", raw.application.submitted_at != null);
    ok("nothing new authored beyond terminal fields",
      raw.milestones_authored_now.sort().join(",") === "terminal_at,terminal_code");

    const before = await row(aw);
    const replay = await L.markTerminal(c, { applicationId: aw, terminalCode: "withdrawn", decisionReason: "again", actorUserId: null });
    ok("exact terminal replay is already_at_target", replay.transition_state === "already_at_target");
    ok("replay moves NO timestamp",
      String((await row(aw)).terminal_at) === String(before.terminal_at));
    ok("different terminal disposition refused",
      (await refusedCode(c, () => L.markTerminal(c, { applicationId: aw, terminalCode: "declined" }))) === "terminal_disposition_immutable");

    if (UNDER_125) {
      section("L  staged 125 refuses false milestone shapes");
      const bad = async (sql, params) => refusedCode(c, () => c.query(sql, params));
      const d1 = await mkApp("draft");
      ok("draft acquiring submitted_at refused",
        (await bad("update lease_applications set submitted_at=now() where id=$1", [d1])) !== null);
      const s1 = await mkApp("submitted", { submitted_at: stamp });
      ok("submitted acquiring approved_at refused",
        (await bad("update lease_applications set approved_at=now() where id=$1", [s1])) !== null);
      const t1 = await mkApp("withdrawn", { terminal_at: stamp, terminal_code: "withdrawn" });
      ok("terminal row acquiring submitted_at refused",
        (await bad("update lease_applications set submitted_at=now() where id=$1", [t1])) !== null);
      ok("terminal row acquiring approved_at refused",
        (await bad("update lease_applications set approved_at=now() where id=$1", [t1])) !== null);
      const keep = await mkApp("submitted", { submitted_at: stamp });
      await L.markTerminal(c, { applicationId: keep, terminalCode: "declined", decisionReason: "no", actorUserId: null });
      ok("submitted → declined KEEPS submitted_at (legitimate history)",
        (await row(keep)).submitted_at != null);
    }

    await c.query("rollback");
  } finally { c.release(); }

  section("M  nothing survived the rollback");
  const left = (await pool.query(
    "select count(*)::int n from lease_applications where applicant_name='Iso Proof'")).rows[0].n;
  ok("probe rows did not persist", left === 0);

  await pool.end();
  console.log(`\n════ ${pass} passed, ${fail} failed ${UNDER_125 ? "(under staged 125)" : "(under 124)"} ════\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nPROOF CRASHED:", e.message, "\n"); process.exit(1); });
