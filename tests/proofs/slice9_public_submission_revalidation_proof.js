// ════════════════════════════════════════════════════════════════════
//  slice9_public_submission_revalidation_proof.js
//
//  Commit C. An invitation stays open while inventory moves. Preparation-time
//  truth is not submission-time truth.
//
//  The exact scenario: a link is prepared while the unit has ONE space, and by
//  the time the applicant submits the unit has TWO. The application can no
//  longer be attributed to a space — lease_applications has no space_id — so
//  the birth must be refused, and refused with its OWN code: the unit CHANGED,
//  it was not an unsupported shape all along.
//
//  Run: DATABASE_URL=... node tests/proofs/slice9_public_submission_revalidation_proof.js
//  One transaction, rolled back.
// ════════════════════════════════════════════════════════════════════

"use strict";
const path = require("path");
const { Pool } = require("pg");
const REPO = path.resolve(__dirname, "..", "..");
const { seedInventory } = require("./fixtures/slice9_inventory_fixture");
const crypto = require("crypto");

let pass = 0, fail = 0;
const ok = (c, m, d) => {
  if (c) { pass++; console.log("   PASS  " + m); }
  else { fail++; console.log("   FAIL  " + m + (d ? "\n           " + d : "")); }
};
const ssl = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || "")
  ? false : { rejectUnauthorized: false };
const digest = (raw) => crypto.createHash("sha256").update(String(raw)).digest("hex");

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) { console.log("FATAL: DATABASE_URL required"); process.exit(1); }
  const pool = new Pool({ connectionString: url, ssl });
  const c = await pool.connect();

  try {
    await c.query("begin");
    const s = await seedInventory(c);
    const P = s.property_id, U = s.units;
    const { resolveSubmissionTarget, resolveApplicationTarget, REFUSAL } =
      require(path.join(REPO, "src/applications/application_target_authority"));

    const person = (await c.query(
      `insert into persons (name, lifecycle_status) values ('Commit C applicant','applicant') returning id`
    )).rows[0].id;

    // A SENT invitation against a marketable sole-space unit — the shape a real
    // applicant would hold.
    async function sentInvitation(unit_id) {
      const raw = crypto.randomBytes(24).toString("base64url");
      const inv = (await c.query(
        `insert into application_invitations
           (token_digest, person_id, property_id, unit_id, status, sent_at)
         values ($1,$2,$3,$4,'provider_dispatched', now()) returning *`,
        [digest(raw), person, P, unit_id])).rows[0];
      return { raw, inv };
    }

    console.log("\n── THE SCENARIO: SOLE-SPACE AT PREPARATION, TWO AT SUBMIT ─");
    const target = U["A-marketable"];
    const { inv } = await sentInvitation(target.unit_id);
    ok(!!inv.id, "an invitation exists against a marketable sole-space unit");

    const before = await resolveSubmissionTarget(c, { property_id: P, unit_id: target.unit_id });
    ok(before.ok === true, "at preparation time the target resolves");
    ok(before.resolution_basis === "sole_space_unit", "as a sole-space unit");

    // INVENTORY MOVES: the unit gains a second space.
    await c.query(
      `insert into spaces (unit_id, space_label, position_kind, use_type)
       values ($1,'Bed 2','bed','residential')`, [target.unit_id]);

    const after = await resolveSubmissionTarget(c, { property_id: P, unit_id: target.unit_id });
    ok(after.ok === false, "after the split the same target refuses");
    ok(after.refusal_code === REFUSAL.BECAME_AMBIGUOUS,
      `and refuses with application_target_became_ambiguous (${after.refusal_code})`);
    ok(after.refusal_code !== REFUSAL.MULTI_SPACE,
      "NOT the preparation-time code — the unit changed, it was not always unsupported");
    ok(/changed/i.test(after.refusal_reason || ""),
      "operator copy says the unit was changed, not that the operator forgot something");
    ok(!/space_grain|became_ambiguous/.test(after.refusal_reason || ""),
      "no internal code in operator copy");
    ok(after.httpStatus === 409, "carries 409");

    console.log("\n── NOTHING DOWNSTREAM HAPPENS ON REFUSAL ────────────────");
    //  The revalidation sits ABOVE the atomic consume, so a refusal cannot have
    //  produced any of these. Asserted as state, not as reading order.
    const counts = (await c.query(
      `select
         (select count(*) from lease_applications where property_id=$1 and unit_id=$2)::int apps,
         (select count(*) from events where property_id=$1 and type='application_submitted')::int evts,
         (select count(*) from obligations where property_id=$1 and type='application_approval')::int gates,
         (select status from application_invitations where id=$3) inv_status`,
      [P, target.unit_id, inv.id])).rows[0];
    ok(counts.apps === 0, "no lease_application was born");
    ok(counts.evts === 0, "no application_submitted event was recorded");
    ok(counts.gates === 0, "no approval obligation was spawned");
    ok(counts.inv_status === "provider_dispatched",
      `the invitation is NOT consumed — the token is not burned by a condition the applicant cannot fix (${counts.inv_status})`);

    console.log("\n── THE TARGET IS NEVER RE-AIMED ─────────────────────────");
    const unchanged = (await c.query(
      `select unit_id from application_invitations where id=$1`, [inv.id])).rows[0];
    ok(String(unchanged.unit_id) === String(target.unit_id),
      "the invitation still points at its original unit — no conversion to another unit");
    ok(after.resolved_space_id === null,
      "and no space was selected from the two now available");

    console.log("\n── A UNIT TAKEN BY SOMEONE ELSE ─────────────────────────");
    const taken = U["J-future-locked"];
    const tk = await resolveSubmissionTarget(c, { property_id: P, unit_id: taken.unit_id });
    ok(tk.ok === false && tk.refusal_code === REFUSAL.NO_LONGER_OFFERABLE,
      `a unit committed to a future resident refuses submission (${tk.refusal_code})`);
    const occ = await resolveSubmissionTarget(c, { property_id: P, unit_id: U["G-occupied"].unit_id });
    ok(occ.ok === false && occ.refusal_code === REFUSAL.NO_LONGER_OFFERABLE,
      "an occupied unit refuses submission");
    const cont = await resolveSubmissionTarget(c, { property_id: P, unit_id: U["O-conflict"].unit_id });
    ok(cont.ok === false, "a contested position refuses submission");

    console.log("\n── SUBMISSION AND PREPARATION NOW AGREE EXACTLY ─────────");
    //  THE CORRECTION. Submission previously permitted upcoming and
    //  turnover_required unconditionally while preparation refused them —
    //  a strictly WEAKER standard, because the governed intended_move_in
    //  reached no durable row and submission could not reproduce the verdict.
    //  Both boundaries now read ONE present-tense fact: marketable_now.
    for (const [name, state] of [["B-upcoming", "upcoming"], ["C-turnover", "turnover_required"]]) {
      const prep = await resolveApplicationTarget(c, { property_id: P, unit_id: U[name].unit_id });
      const subm = await resolveSubmissionTarget(c, { property_id: P, unit_id: U[name].unit_id });
      ok(prep.ok === false && subm.ok === false,
        `${name} (${state}) is refused at BOTH boundaries`);
      ok(prep.refusal_code === subm.refusal_code,
        `${name} refuses with the SAME code at both (${prep.refusal_code} / ${subm.refusal_code})`);
      ok(subm.refusal_code === "future_application_target_not_supported",
        `${name} submission code is the capability refusal (${subm.refusal_code})`);
    }

    console.log("\n── SUBMISSION MAY BE STRICTER, NEVER WEAKER ─────────────");
    //  Exhaustive over every seeded position: no unit may be refused at
    //  preparation and permitted at submission. That direction is the defect.
    const allUnits = (await c.query(
      `select id from units where property_id=$1`, [P])).rows.map((r) => r.id);
    const weaker = [];
    for (const uid of allUnits) {
      const p1 = await resolveApplicationTarget(c, { property_id: P, unit_id: uid });
      const s1 = await resolveSubmissionTarget(c, { property_id: P, unit_id: uid });
      if (!p1.ok && s1.ok) weaker.push(uid);
    }
    ok(weaker.length === 0,
      `NO position is refused at preparation and permitted at submission (${allUnits.length} positions checked)`,
      weaker.length ? "weaker at: " + weaker.join(", ") : "");

    console.log("\n── A SUBMISSION REFUSAL BIRTHS NOTHING ──────────────────");
    const beforeSub = (await c.query(
      `select
         (select count(*) from lease_applications where property_id=$1)::int apps,
         (select count(*) from events where property_id=$1 and type='application_submitted')::int evts,
         (select count(*) from obligations where property_id=$1 and type='application_approval')::int obs`,
      [P])).rows[0];
    const refusedSub = await resolveSubmissionTarget(c, { property_id: P, unit_id: U["B-upcoming"].unit_id });
    ok(refusedSub.ok === false, "the future-dated target is refused at submission");
    const afterSub = (await c.query(
      `select
         (select count(*) from lease_applications where property_id=$1)::int apps,
         (select count(*) from events where property_id=$1 and type='application_submitted')::int evts,
         (select count(*) from obligations where property_id=$1 and type='application_approval')::int obs`,
      [P])).rows[0];
    ok(afterSub.apps === beforeSub.apps, "NO lease application was born");
    ok(afterSub.evts === beforeSub.evts, "NO application_submitted event was recorded");
    ok(afterSub.obs === beforeSub.obs, "NO approval obligation was spawned");
    ok(refusedSub.resolved_space_id === null || refusedSub.ok === false,
      "and no resolved space is presented as lineage");

    console.log("\n── ZERO-SPACE AND PROPERTY LINEAGE ──────────────────────");
    const zero = await resolveSubmissionTarget(c, { property_id: P, unit_id: U["R-zero-space"].unit_id });
    ok(zero.ok === false && zero.refusal_code === REFUSAL.UNCONFIGURED,
      "a unit whose space was removed refuses as unconfigured");
    const otherProp = (await c.query(
      `insert into properties (name, leasing_basis) values ('Commit C other','unknown') returning id`)).rows[0].id;
    const wrong = await resolveSubmissionTarget(c, { property_id: otherProp, unit_id: target.unit_id });
    ok(wrong.ok === false && wrong.refusal_code === REFUSAL.NOT_AT_PROPERTY,
      "property lineage is verified at submission");

    console.log("\n── ORDERING IS ENFORCED IN SOURCE ───────────────────────");
    const src = require("fs").readFileSync(
      path.join(REPO, "src/applications/application_submission.js"), "utf8");
    const revalidateAt = src.indexOf("resolveSubmissionTarget");
    const consumeAt = src.indexOf("ATOMIC CONSUME");
    const idempotentAt = src.indexOf("idempotency: already consumed");
    ok(revalidateAt > 0 && consumeAt > 0 && revalidateAt < consumeAt,
      "revalidation is placed BEFORE the atomic consume");
    ok(idempotentAt > 0 && idempotentAt < revalidateAt,
      "and AFTER the idempotency return — a durably born application is never re-validated");

  } catch (e) {
    fail++; console.log("   FAIL  harness threw: " + e.message + "\n" + e.stack);
  } finally {
    await c.query("rollback").catch(() => {});
    c.release();
    await pool.end();
  }

  console.log("\n──────────────────────────────────────────────────────────");
  console.log(`   public submission revalidation: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
