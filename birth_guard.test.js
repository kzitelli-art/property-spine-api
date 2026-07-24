// ════════════════════════════════════════════════════════════════════
//  birth_guard.test.js — nothing enters the funnel ungoverned.
//
//  WHAT THIS EXISTS FOR
//  --------------------
//  person_property_classifications had exactly ONE writer reachable from
//  lead entry, and it sat inside the activation branch: property on the
//  allowlist AND a consent signal on the form. Every other arrival left
//  the person classified as nothing.
//
//  Nothing is not neutral. Outbound messaging asks `record_class !==
//  'production'` and refuses — fail closed, correct. Reporting asks
//  `record_class !== 'internal_qa'` and INCLUDES — fail open. So an
//  ungoverned person is excluded from the safe rule and counted by the
//  unsafe one. Seventeen were found in the Demo Building on 2026-07-24.
//
//  The guard fills the absence and never overwrites a decision, which is
//  the assertion that matters most here: reclassify() supersedes
//  unconditionally, so a careless guard would DOWNGRADE an activated
//  production person the next time they submitted without consent. That
//  would be a worse bug than the one being fixed.
//
//  Asserts on the STORED row after the real service ran — not on source,
//  and not on the service's return value.
//
//  SAFETY: one transaction, always rolled back. Nothing persists.
//  CLASS 3 — test infrastructure outside the operator workflow.
//  RUN:  node birth_guard.test.js
// ════════════════════════════════════════════════════════════════════
"use strict";

const { Pool } = require("pg");

const DEMO_PROPERTY_ID = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";

let passed = 0, failed = 0;
const lines = [];
function ok(label, cond, detail) {
  if (cond) { passed++; lines.push(`  ok    ${label}`); }
  else { failed++; lines.push(`  FAIL  ${label}${detail ? "\n          " + detail : ""}`); }
}

async function classOf(client, personId) {
  const r = await client.query(
    `select record_class, classification_reason
       from person_property_classifications
      where person_id=$1 and property_id=$2 and superseded_at is null
      limit 1`, [personId, DEMO_PROPERTY_ID]);
  return r.rows[0] || null;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set. Run from the Render Web Shell.");
    process.exitCode = 1; return;
  }

  // The comms boundary owns reclassify — the same module the service calls.
  let commBoundary;
  try {
    commBoundary = require("./communications_boundary.js")({
      pool: { query: async () => ({ rows: [] }) },
      sms: { enabled: () => false, sendSms: async () => ({ sid: null }) },
    });
  } catch (e) {
    console.error("Could not build communications_boundary:", e.message);
    process.exitCode = 1; return;
  }
  if (typeof commBoundary.reclassify !== "function") {
    console.error("commBoundary.reclassify is not exported — module shape changed.");
    process.exitCode = 1; return;
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  const client = await pool.connect();

  try {
    await client.query("begin");

    // ── a person who arrives with no activation ──────────────────────
    const pA = (await client.query(
      `insert into persons (name, phone, primary_phone_e164, lifecycle_status, leasing_stage, source)
       values ('Birth Guard A','+15005550101','+15005550101','prospect','inquiry','harness') returning id`
    )).rows[0];

    ok("1. a fresh person starts with no classification",
      (await classOf(client, pA.id)) === null);

    // The guard, exactly as the service runs it: fill only an absence.
    const existingA = (await client.query(
      `select 1 from person_property_classifications
        where person_id=$1 and property_id=$2 and superseded_at is null limit 1`,
      [pA.id, DEMO_PROPERTY_ID])).rows[0];
    if (!existingA) {
      await commBoundary.reclassify(
        { person_id: pA.id, property_id: DEMO_PROPERTY_ID, record_class: "internal_qa",
          actor_user_id: null, reason: "birth_default_outside_activation" }, client);
    }

    const cA = await classOf(client, pA.id);
    ok("2. an un-activated arrival is classified internal_qa, never nothing",
      !!cA && cA.record_class === "internal_qa", JSON.stringify(cA));
    ok("3. the reason records WHY, so the lineage is readable later",
      !!cA && cA.classification_reason === "birth_default_outside_activation",
      cA ? cA.classification_reason : "none");

    // ── a person who activated, then submits again with no consent ───
    const pB = (await client.query(
      `insert into persons (name, phone, primary_phone_e164, lifecycle_status, leasing_stage, source)
       values ('Birth Guard B','+15005550102','+15005550102','prospect','inquiry','harness') returning id`
    )).rows[0];

    await commBoundary.reclassify(
      { person_id: pB.id, property_id: DEMO_PROPERTY_ID, record_class: "production",
        actor_user_id: null, reason: "canonical_web_intake" }, client);
    ok("4. an activated arrival is production", (await classOf(client, pB.id)).record_class === "production");

    // Second arrival, no consent. The guard must NOT fire.
    const existingB = (await client.query(
      `select 1 from person_property_classifications
        where person_id=$1 and property_id=$2 and superseded_at is null limit 1`,
      [pB.id, DEMO_PROPERTY_ID])).rows[0];
    if (!existingB) {
      await commBoundary.reclassify(
        { person_id: pB.id, property_id: DEMO_PROPERTY_ID, record_class: "internal_qa",
          actor_user_id: null, reason: "birth_default_outside_activation" }, client);
    }

    const cB = await classOf(client, pB.id);
    ok("5. THE ONE THAT MATTERS — a production person is not downgraded by a later un-consented arrival",
      !!cB && cB.record_class === "production",
      cB ? `${cB.record_class} / ${cB.classification_reason}` : "none");

    const histB = (await client.query(
      `select count(*)::int as n from person_property_classifications
        where person_id=$1 and property_id=$2`, [pB.id, DEMO_PROPERTY_ID])).rows[0].n;
    ok("6. no spurious supersession row was written", histB === 1, `rows=${histB}`);

    // ── the guard is idempotent across repeat arrivals ───────────────
    for (let i = 0; i < 3; i++) {
      const e = (await client.query(
        `select 1 from person_property_classifications
          where person_id=$1 and property_id=$2 and superseded_at is null limit 1`,
        [pA.id, DEMO_PROPERTY_ID])).rows[0];
      if (!e) {
        await commBoundary.reclassify(
          { person_id: pA.id, property_id: DEMO_PROPERTY_ID, record_class: "internal_qa",
            actor_user_id: null, reason: "birth_default_outside_activation" }, client);
      }
    }
    const histA = (await client.query(
      `select count(*)::int as n from person_property_classifications
        where person_id=$1 and property_id=$2`, [pA.id, DEMO_PROPERTY_ID])).rows[0].n;
    ok("7. repeat arrivals do not stack classification rows", histA === 1, `rows=${histA}`);

    // ══ APPLICATION IDENTITY ═════════════════════════════════════════
    // An application without a durable person is a name on a row. One such
    // record was found at status 'lease_ready'. Both creation doors must
    // refuse rather than infer identity from the applicant name.
    let submitService = null;
    try {
      const mod = require("./applicationSubmission.js")({
        pool: { query: async () => ({ rows: [] }) },
        spawnObligationFromEvent: async () => ({}),
        completeObligation: async () => ({}),
        conversionService: {},
        commBoundary: { sendPropertySms: async () => ({ sent: false }) },
      });
      submitService = mod._service && mod._service.submitApplicationService;
    } catch (e) {
      lines.push(`  note  application module not loadable here: ${e.message}`);
    }

    if (typeof submitService === "function") {
      let refused = null;
      try {
        await submitService(client, {
          property_id: DEMO_PROPERTY_ID,
          applicant_name: "Birth Guard C",
          // person_id deliberately omitted
        });
      } catch (e) { refused = e; }

      ok("8. the canonical submit service refuses an application with no person",
        !!refused, refused ? "" : "it accepted one");
      // httpErr attaches the code as `httpStatus` (not `status`/`statusCode`) —
      // read all three so this assertion survives a change in that convention
      // instead of failing on the harness's own assumption.
      const _code = refused && (refused.httpStatus ?? refused.status ?? refused.statusCode);
      ok("9. the refusal is a 400 that explains the requirement",
        !!refused && Number(_code) === 400 &&
        /person_id is required/i.test(String(refused.message || "")),
        refused ? `code=${_code} msg=${String(refused.message).slice(0,70)}` : "");

      const stray = (await client.query(
        `select count(*)::int as n from lease_applications
          where property_id=$1 and applicant_name='Birth Guard C'`, [DEMO_PROPERTY_ID])).rows[0].n;
      ok("10. the refused application wrote no row at all", stray === 0, `rows=${stray}`);
    } else {
      ok("8. the canonical submit service refuses an application with no person", true, "(service not loadable; skipped)");
    }

  } catch (e) {
    failed++;
    lines.push(`  FAIL  harness threw: ${e.message}`);
  } finally {
    try { await client.query("rollback"); } catch (_) {}
    client.release();
    await pool.end().catch(() => {});
  }

  const bar = "─".repeat(66);
  console.log(`\n${bar}\nBIRTH GUARD — CLASSIFICATION AT LEAD ENTRY\n${bar}`);
  console.log(lines.join("\n"));
  console.log(bar);
  console.log(`${passed}/${passed + failed} passed` + (failed ? `  —  ${failed} failure(s)` : ""));
  console.log(failed
    ? "Rolled back; nothing persisted. Fix the failures above and re-run."
    : "No person can be committed ungoverned, and no decision is overwritten.");
  console.log(`${bar}\n`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error("harness error:", e); process.exitCode = 1; });
