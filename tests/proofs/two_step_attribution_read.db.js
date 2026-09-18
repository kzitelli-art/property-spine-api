"use strict";
// Read-only challenge after the owned two-step journey. No fixture writes.
const assert = require("node:assert/strict");
const boundary = require("../e2e/proof_boundary");
require("../e2e/proof_fence_preload");
const { Pool } = require("pg");
const {
  buildReviewDetail,
} = require("../../src/applications/application_review");
const {
  readLeasingStanding,
} = require("../../src/leasing/leasing_standing_read");
(async () => {
  await boundary.assertDatabase();
  const pool = new Pool({
    connectionString: boundary.manifest().url,
    ssl: false,
  });
  const db = await pool.connect();
  let passed = 0;
  const check = (value, label) => {
    assert.ok(value, label);
    passed++;
    console.log("PASS " + label);
  };
  try {
    await db.query(
      "begin transaction isolation level repeatable read read only",
    );
    const rows = (
      await db.query(`select a.id,a.property_id,a.person_id,c.id confirmation_id,c.actor_user_id preparer,c.created_at prepared_at,o.authority_basis_snapshot,o.created_at authored_at
    from lease_applications a join application_proposed_terms_confirmations c on c.id=a.proposed_terms_confirmation_id
    join lease_offers o on o.id=c.application_offer_id
    where c.source='authored_offer_acknowledged' order by a.created_at desc limit 20`)
    ).rows;
    assert.ok(rows.length, "run owned two-step journey first");
    let distinct = false;
    for (const row of rows) {
      const review = await buildReviewDetail(db, row.id, row.property_id);
      const c = review.proposed_terms_confirmation;
      check(
        c.source === "authored_offer_acknowledged" &&
          c.confirmed_by === null &&
          c.confirmed_at === null,
        "derived preparation is not human confirmation",
      );
      check(
        c.prepared_by === row.preparer &&
          String(c.prepared_at) === String(row.prepared_at),
        "preparation retains its actor and occurrence",
      );
      check(
        c.offer_author.user_id === row.authority_basis_snapshot.actor_user_id,
        "authorship comes from retained offer authority",
      );
      distinct ||= c.prepared_by !== c.offer_author.user_id;
      const standing = await readLeasingStanding(db, {
        person_id: row.person_id,
        property_id: row.property_id,
      });
      check(
        !standing.uncertainty.some((x) => x.kind === "read_failed"),
        "standing has no swallowed read failures",
      );
      if (standing.application.id === row.id)
        check(
          standing.application.proposed_terms_confirmation.id === c.id &&
            standing.application.proposed_terms_confirmation.confirmed_by ===
              null,
          "Ask/Person standing follows current pointer with same attribution",
        );
      const audit = (
        await db.query(
          "select id from lease_packet_audit_events where lease_packet_id=$1 and event_type='executed_by_decision' order by created_at desc,id desc limit 1",
          [review.packet.id],
        )
      ).rows[0];
      check(
        audit
          ? review.execution_decision?.event_id === audit.id
          : review.execution_decision === null,
        "Execute read is backed by current packet audit, never inferred",
      );
    }
    check(distinct, "fixture distinguishes author from preparer");
    await db.query("commit");
    console.log(`Two-step attribution: ${passed} passed, 0 failed`);
  } finally {
    await db.query("rollback").catch(() => {});
    db.release();
    await pool.end();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
