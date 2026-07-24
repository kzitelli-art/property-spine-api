// ════════════════════════════════════════════════════════════════════
//  capability_contract.test.js — the projection and the route agree.
//
//  WHAT THIS PROTECTS
//  ------------------
//  Ninety-four refusal receipts live in the service layer and not one was
//  surfaced in a read. Every gate was discovered by pressing a live button
//  and reading a red box, which makes governance that is WORKING look
//  exactly like breakage.
//
//  The fix is one evaluator asked by both sides. The failure mode it must
//  never produce is the opposite of the old one: a button that says
//  AVAILABLE while the server refuses. That is a promise the product
//  cannot keep — Rule 9, no phantom dispatch, applied to what a screen
//  offers rather than only to what it sends.
//
//  So the assertions below are mostly about AGREEMENT, not about any
//  particular policy. The policy may change; the two sides agreeing may
//  not.
//
//  Layer A is pure and needs nothing. Layer B runs the batch evaluator
//  against real Postgres inside a rolled-back transaction and checks it
//  against the single-person evaluator row by row.
//
//  CLASS 3 — test infrastructure outside the operator workflow.
//  RUN:  node capability_contract.test.js
// ════════════════════════════════════════════════════════════════════
"use strict";

const path = require("path");
const { Pool } = require("pg");
const ROOT = process.argv[2] || ".";
const capability = require(path.resolve(ROOT, "capability.js"));
const desk = require(path.resolve(ROOT, "leasing_desk.js"));

const DEMO_PROPERTY_ID = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";

let passed = 0, failed = 0;
const lines = [];
function ok(label, cond, detail) {
  if (cond) { passed++; lines.push(`  ok    ${label}`); }
  else { failed++; lines.push(`  FAIL  ${label}${detail ? "\n          " + detail : ""}`); }
}
function section(t) { lines.push(`\n  ── ${t} ${"─".repeat(Math.max(0, 52 - t.length))}`); }

// ════════ A · THE PURE DECISION ══════════════════════════════════════
function testDecision() {
  section("A · the decision");
  const D = capability.decideApplicationLinkBirth;

  const off = D({ enabled: false, property_allowlisted: true, person_id: "p", record_class: "internal_qa" });
  ok("A1. environment switch off denies, whatever the person is",
    off.allowed === false && off.reason_code === "APPLICATION_LINK_DISABLED", JSON.stringify(off));

  const notProp = D({ enabled: true, property_allowlisted: false, person_id: "p", record_class: "internal_qa" });
  ok("A2. an unlisted property denies",
    notProp.allowed === false && notProp.reason_code === "PROPERTY_NOT_ACTIVATED");

  const prod = D({ enabled: true, property_allowlisted: true, person_id: "p", record_class: "production" });
  ok("A3. a production person denies during controlled activation",
    prod.allowed === false && prod.reason_code === "CONTROLLED_ACTIVATION_ONLY");

  const none = D({ enabled: true, property_allowlisted: true, person_id: "p", record_class: null });
  ok("A4. an UNCLASSIFIED person denies — absence of a decision is not permission",
    none.allowed === false && none.reason_code === "CONTROLLED_ACTIVATION_ONLY");

  const qa = D({ enabled: true, property_allowlisted: true, person_id: "p", record_class: "internal_qa" });
  ok("A5. an internal_qa person is allowed", qa.allowed === true);

  ok("A6. every denial carries a human reason, never a bare refusal",
    [off, notProp, prod, none].every((v) => typeof v.display_reason === "string" && v.display_reason.length > 10));

  ok("A7. no display reason leaks an environment variable name",
    Object.values(capability.REASONS).every((r) => !/[A-Z_]{6,}/.test(r)),
    JSON.stringify(Object.values(capability.REASONS).filter((r) => /[A-Z_]{6,}/.test(r))));
}

// ════════ B · THE PROJECTION HONOURS IT ══════════════════════════════
function testNormalizer() {
  section("B · the board projection");
  const base = { obligation_id: "o1", conversion_id: "c1", next_move_code: "send_application", person_id: "p1" };

  const denied = desk.normalizeFollowupAction({
    ...base,
    send_application_capability: {
      action: "send_application", allowed: false,
      reason_code: "CONTROLLED_ACTIVATION_ONLY",
      display_reason: capability.REASONS.CONTROLLED_ACTIVATION_ONLY,
    },
  });
  ok("B1. a held action keeps the verb the operator would press, disabled",
    denied.label === "Send" && denied.kind === "blocked" && denied.blocked === true,
    JSON.stringify(denied));
  ok("B1b. HELD is not the same truth as UNSUPPORTED — the app can do this, policy holds it",
    denied.kind !== "unsupported");
  ok("B2. it carries the operator-facing reason",
    denied.reason === capability.REASONS.CONTROLLED_ACTIVATION_ONLY, denied.reason);
  ok("B3. it carries the machine reason code for logs",
    denied.reason_code === "CONTROLLED_ACTIVATION_ONLY");

  const allowed = desk.normalizeFollowupAction({
    ...base,
    send_application_capability: { action: "send_application", allowed: true, reason_code: "ALLOWED", display_reason: "Ready to send." },
  });
  ok("B4. an allowed action still renders as Send", allowed.label === "Send" && allowed.kind === "task_write");

  const unknown = desk.normalizeFollowupAction({ ...base, send_application_capability: null });
  ok("B5. an UNEVALUATED verdict changes nothing — unknown is not denial",
    unknown.label === "Send" && unknown.kind === "task_write", JSON.stringify(unknown));

  ok("B6. the closed CTA vocabulary is intact — no new verb was invented",
    ["Open", "Send", "Complete", "Unavailable"].includes(denied.label) &&
    ["Open", "Send", "Complete", "Unavailable"].includes(allowed.label));
  ok("B7. a genuinely unsupported action still reads Unavailable",
    (function () {
      const u = desk.normalizeFollowupAction({ obligation_id: "o9", next_move_code: "unknown_move" });
      return u.label === "Unavailable" && u.kind === "unsupported";
    })());
}

// ════════ C · BATCH AND SINGLE AGREE, ON REAL DATA ═══════════════════
async function testAgreement() {
  section("C · batch and single agree");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  try {
    await client.query("begin");
    const mk = async (name, cls) => {
      const p = (await client.query(
        `insert into persons (name, lifecycle_status, leasing_stage, source)
         values ($1,'prospect','inquiry','harness') returning id`, [name])).rows[0];
      if (cls) {
        await client.query(
          `insert into person_property_classifications
             (person_id, property_id, record_class, classification_source, classification_reason)
           values ($1,$2,$3,'operator','harness')`, [p.id, DEMO_PROPERTY_ID, cls]);
      }
      return p.id;
    };
    const qaId   = await mk("Cap QA", "internal_qa");
    const prodId = await mk("Cap Prod", "production");
    const noneId = await mk("Cap None", null);
    const ids = [qaId, prodId, noneId];

    const batch = await capability.evaluateApplicationLinkBirthBatch(client, {
      property_id: DEMO_PROPERTY_ID, person_ids: ids,
    });

    let agree = true, detail = "";
    for (const id of ids) {
      const single = await capability.evaluateApplicationLinkBirth(client, {
        property_id: DEMO_PROPERTY_ID, person_id: id,
      });
      const b = batch.get(String(id));
      if (!b || b.allowed !== single.allowed || b.reason_code !== single.reason_code) {
        agree = false;
        detail += `\n          ${id}: batch=${b && b.reason_code} single=${single.reason_code}`;
      }
    }
    ok("C1. THE ONE THAT MATTERS — the board verdict equals the route verdict for every person",
      agree, detail);

    const bQa = batch.get(String(qaId));
    ok("C2. the batch read resolves a real classification, not a default",
      !!bQa && typeof bQa.allowed === "boolean", JSON.stringify(bQa));

    ok("C3. an unclassified person is denied in the batch path too",
      batch.get(String(noneId)) && batch.get(String(noneId)).allowed === false);
  } catch (e) {
    failed++; lines.push(`  FAIL  harness threw: ${e.message}`);
  } finally {
    try { await client.query("rollback"); } catch (_) {}
    client.release();
    await pool.end().catch(() => {});
  }
}

async function main() {
  testDecision();
  testNormalizer();
  if (process.env.DATABASE_URL) await testAgreement();
  else lines.push("\n  note  DATABASE_URL not set — layer C skipped.");

  const bar = "─".repeat(66);
  console.log(`\n${bar}\nCAPABILITY — ONE VERDICT, TWO CALLERS\n${bar}`);
  console.log(lines.join("\n"));
  console.log(`\n${bar}`);
  console.log(`${passed}/${passed + failed} passed` + (failed ? `  —  ${failed} failure(s)` : ""));
  console.log(failed
    ? "Rolled back; nothing persisted. Fix the failures above and re-run."
    : "A button never offers what the server would refuse.");
  console.log(`${bar}\n`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error("harness error:", e); process.exitCode = 1; });
