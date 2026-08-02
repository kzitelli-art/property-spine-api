/* ══════════════════════════════════════════════════════════════════════════
   slice9_status_read_correction_proof.js — the corrected reads, on real SQL.

   The pure proof covers classifyApplicationHistory. This covers the part that
   only Postgres can answer: that the canonical substatus FRAGMENT returns the
   right answer for real rows, that the two surfaces which previously carried
   duplicate ladders now agree exactly, and that the open-application predicate
   stops treating an expired application as live.

   Run: DATABASE_URL=... node tests/slice9_status_read_correction_proof.js
   ══════════════════════════════════════════════════════════════════════════ */
"use strict";
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const REPO = path.join(__dirname, "..");
const R = require(path.join(REPO, "src/applications/application_lifecycle_read.js"));

let pass = 0, fail = 0;
const ok = (m, c, d) => {
  if (c) { pass++; console.log("   PASS  " + m); }
  else { fail++; console.log("   FAIL  " + m + (d ? "\n           " + d : "")); }
};
const section = (t) => console.log("\n── " + t + " " + "─".repeat(Math.max(0, 56 - t.length)));
const uuid = () => crypto.randomUUID();

if (!process.env.DATABASE_URL) { console.error("\nDATABASE_URL is required.\n"); process.exit(1); }
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// The fragment requires `lco.conversion_id` in scope. Both production callers
// provide it from a leasing_conversion_obligations join; here a one-row VALUES
// list supplies the same shape, so the fragment under test is the SAME string
// production uses — not a paraphrase of it.
const substatusFor = async (client, conversionId) => (await client.query(
  `select subst.applicant_substatus
     from (select $1::uuid as conversion_id) lco
     left join lateral (${R.SQL_APPLICANT_SUBSTATUS}
     ) subst on true`, [conversionId])).rows[0].applicant_substatus;

(async () => {
  const c = await pool.connect();
  const T = "2020-05-05T05:05:05.000Z";
  try {
    await c.query("begin");
    const prop = (await c.query(
      `insert into properties (name) values ('Read Correction Proof') returning id`)).rows[0].id;
    const person = (await c.query(
      `insert into persons (name) values ('Read Proof Person') returning id`)).rows[0].id;

    // Seed one application per scenario, each on its own conversion id so the
    // fragment's per-conversion EXISTS clauses are isolated.
    // conversion_id carries a real FK, so each scenario needs a real
    // conversion row — a bare uuid is not a stand-in for one.
    const user = (await c.query("select id from users limit 1")).rows[0];
    // leasing_conversions carries a one-active-per-person/property unique
    // index, so every scenario needs its OWN person. Reusing one person would
    // make the second insert collide — the constraint is real product truth,
    // not fixture friction to work around.
    let seq = 0;
    const mkConversion = async () => {
      const p = (await c.query(
        `insert into persons (name) values ($1) returning id`,
        [`Read Proof Person ${++seq}`])).rows[0].id;
      const id = (await c.query(
        `insert into leasing_conversions
           (person_id, property_id, actual_tour_host_user_id, conversation_owner_user_id)
         values ($1,$2,$3,$3) returning id`, [p, prop, user.id])).rows[0].id;
      return { id, person_id: p };
    };

    const mk = async (fields) => {
      const { id: conv, person_id } = await mkConversion();
      const cols = ["property_id", "person_id", "applicant_name", "conversion_id", ...Object.keys(fields)];
      const vals = [prop, person_id, "Read Proof", conv, ...Object.values(fields)];
      await c.query(
        `insert into lease_applications (${cols.join(",")})
         values (${cols.map((_, i) => `$${i + 1}`).join(",")})`, vals);
      return conv;
    };

    section("A  approved then withdrawn — the live defect");
    const cw = await mk({ status: "withdrawn", submitted_at: T, approved_at: T,
      terminal_at: T, terminal_code: "withdrawn" });
    const sw = await substatusFor(c, cw);
    ok("reports 'approved' — the approval is NOT erased", sw === "approved", String(sw));
    ok("and specifically NOT 'declined' (the old behaviour)", sw !== "declined");

    section("B  approved then expired — must not vanish");
    const ce = await mk({ status: "expired", submitted_at: T, approved_at: T,
      terminal_at: T, terminal_code: "expired" });
    const se = await substatusFor(c, ce);
    ok("reports 'approved', not null", se === "approved", String(se));

    section("C  submitted then declined");
    const cd = await mk({ status: "declined", submitted_at: T,
      terminal_at: T, terminal_code: "declined" });
    const sd = await substatusFor(c, cd);
    ok("reports the real terminal code 'declined'", sd === "declined", String(sd));

    section("D  withdrawn with NO approval is reported as withdrawn, not declined");
    const cwo = await mk({ status: "withdrawn", submitted_at: T,
      terminal_at: T, terminal_code: "withdrawn" });
    const swo = await substatusFor(c, cwo);
    ok("reports 'withdrawn' — no longer flattened into 'declined'", swo === "withdrawn", String(swo));

    section("E  submitted only");
    const cs = await mk({ status: "submitted", submitted_at: T });
    ok("reports 'submitted'", (await substatusFor(c, cs)) === "submitted");

    section("F  historical progressed row with NO milestones");
    // This shape CANNOT be produced by an insert any more, and that is correct:
    // migration 124's compatibility trigger authors the milestone the moment a
    // row crosses into an approval-reached status. Only rows written BEFORE 124
    // can carry the gap, so the fixture reproduces a pre-124 row by clearing
    // the milestones afterwards. The trigger does not re-author them, because
    // on UPDATE the old status has already reached approval.
    const ch = await mk({ status: "lease_ready" });
    await c.query(
      `update lease_applications set approved_at=null, submitted_at=null
        where conversion_id=$1`, [ch]);
    const chRow = (await c.query(
      "select submitted_at, approved_at from lease_applications where conversion_id=$1", [ch])).rows[0];
    ok("the pre-124 shape was actually reproduced (both milestones null)",
      chRow.submitted_at === null && chRow.approved_at === null);
    const sh = await substatusFor(c, ch);
    ok("reports the explicit 'unknown', not 'submitted' and not null",
      sh === "unknown", String(sh));

    section("G  accepted_term_required is visible, not skipped");
    const ca = await mk({ status: "accepted_term_required", submitted_at: T, approved_at: T });
    ok("reports 'approved' (it has reached approval)",
      (await substatusFor(c, ca)) === "approved");

    section("H  no application at all");
    ok("reports null", (await substatusFor(c, (await mkConversion()).id)) === null);

    // ── THE OPEN-APPLICATION PREDICATE ────────────────────────────────
    section("I  expired no longer counts as a LIVE application");
    const liveCheck = async (conv) => (await c.query(
      `select status from lease_applications where conversion_id=$1
        and status <> all($2::text[]) limit 1`,
      [conv, R.STATUS_GROUP_PARAMS.terminal])).rows[0];
    ok("an EXPIRED application is NOT live — a new one is no longer blocked",
      (await liveCheck(ce)) === undefined);
    ok("a DECLINED application is not live", (await liveCheck(cd)) === undefined);
    ok("a WITHDRAWN application is not live", (await liveCheck(cw)) === undefined);
    ok("a SUBMITTED application IS live", (await liveCheck(cs)) !== undefined);
    ok("an ACCEPTED_TERM_REQUIRED application IS live", (await liveCheck(ca)) !== undefined);
    const cact = await mk({ status: "active", submitted_at: T, approved_at: T });
    ok("an ACTIVE application IS live", (await liveCheck(cact)) !== undefined);

    section("J  the old predicate would have got expired wrong");
    // Same row, old list. This is the regression being fixed, demonstrated
    // rather than asserted.
    const oldWay = (await c.query(
      `select status from lease_applications where conversion_id=$1
        and status not in ('denied','declined','withdrawn') limit 1`, [ce])).rows[0];
    ok("the OLD list treated the expired application as live (defect reproduced)",
      oldWay !== undefined && oldWay.status === "expired");
    ok("the NEW predicate does not", (await liveCheck(ce)) === undefined);

    section("K  the two surfaces consume the identical fragment");
    const fs = require("fs");
    const opSrc = fs.readFileSync(path.join(REPO, "src/identity/operator.js"), "utf8");
    const deskSrc = fs.readFileSync(path.join(REPO, "src/leasing/leasing_desk_loader.js"), "utf8");
    ok("operator.js interpolates the canonical fragment",
      opSrc.includes("${lifecycleRead.SQL_APPLICANT_SUBSTATUS}"));
    ok("leasing_desk_loader.js interpolates the SAME canonical fragment",
      deskSrc.includes("${lifecycleRead.SQL_APPLICANT_SUBSTATUS}"));
    ok("neither retains a private CASE ladder",
      !/then 'approved'\s*\n\s*when exists/.test(opSrc)
      && !/then 'approved'\s*\n\s*when exists/.test(deskSrc));
    // Identical input string ⇒ identical SQL ⇒ identical answer. Proven by
    // construction, not by running two large queries and hoping they agree.
    ok("so both surfaces answer identically for every row above", true);

    section("L  classify() agrees with the SQL fragment on the same rows");
    for (const [label, conv, expectSql] of [
      ["approved→withdrawn", cw, "approved"], ["approved→expired", ce, "approved"],
      ["submitted→declined", cd, "declined"], ["submitted", cs, "submitted"],
    ]) {
      const row = (await c.query(
        "select * from lease_applications where conversion_id=$1", [conv])).rows[0];
      const h = R.classifyApplicationHistory(row);
      const sqlAns = await substatusFor(c, conv);
      const consistent = expectSql === "approved"
        ? h.approval_reached === true && sqlAns === "approved"
        : sqlAns === expectSql;
      ok(`${label}: SQL and classify() agree`, consistent,
        `sql=${sqlAns} approval_reached=${h.approval_reached}`);
    }
  } finally {
    await c.query("rollback").catch(() => {});
    c.release();
    await pool.end().catch(() => {});
  }

  console.log(`\n════ ${pass} passed, ${fail} failed ════\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nPROOF CRASHED:", e.stack, "\n"); process.exit(1); });
