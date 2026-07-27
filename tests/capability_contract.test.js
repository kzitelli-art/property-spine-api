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
// After the src/ restructure these two no longer share a directory, so a single
// ROOT cannot locate both. argv[2] still overrides for a flat layout.
const ROOT = process.argv[2] || null;
const capability = require(ROOT ? path.resolve(ROOT, "capability.js")
  : path.join(__dirname, "..", "src", "identity", "capability.js"));
const desk = require(ROOT ? path.resolve(ROOT, "leasing_desk.js")
  : path.join(__dirname, "..", "src", "leasing", "leasing_desk.js"));

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

  const off = D({ enabled: false, property_allowlisted: true, person_id: "p", consent_state: "opted_in" });
  ok("A1. environment switch off denies, whatever the person is",
    off.allowed === false && off.reason_code === "APPLICATION_LINK_DISABLED", JSON.stringify(off));

  const notProp = D({ enabled: true, property_allowlisted: false, person_id: "p", consent_state: "opted_in" });
  ok("A2. an unlisted property denies",
    notProp.allowed === false && notProp.reason_code === "PROPERTY_NOT_ACTIVATED");

  // A3 encodes the ruling: eligibility is consent + property, and CLASS IS
  // NOT CONSULTED AT ALL. It fails against every previous shape of this
  // gate, each of which demanded a record_class.
  const consented = D({ enabled: true, property_allowlisted: true, person_id: "p", consent_state: "opted_in" });
  ok("A3. THE RULING — consent at an activated property is the whole test; class is not consulted",
    consented.allowed === true, JSON.stringify(consented));

  const none = D({ enabled: true, property_allowlisted: true, person_id: "p", consent_state: null });
  ok("A4. NO consent row denies — absence is refusal, never 'undecided, so proceed'",
    none.allowed === false && none.reason_code === "NO_CONSENT", JSON.stringify(none));

  // THE ONE THAT PROTECTS PEOPLE. Taking class out of this gate must not have
  // taken consent with it. A person who said STOP is refused HERE, so the
  // board never offers a Send the transport would refuse.
  const stopped = D({ enabled: true, property_allowlisted: true, person_id: "p", consent_state: "opted_out" });
  ok("A5. an OPTED-OUT person is refused — unbundling did not widen consent",
    stopped.allowed === false && stopped.reason_code === "NO_CONSENT", JSON.stringify(stopped));

  const junk = D({ enabled: true, property_allowlisted: true, person_id: "p", consent_state: "maybe" });
  ok("A5b. only the exact word 'opted_in' passes — an unrecognised value is not consent",
    junk.allowed === false, JSON.stringify(junk));

  const blank = D({ enabled: true, property_allowlisted: true, person_id: "p", consent_state: "" });
  ok("A5c. an empty consent value is not consent", blank.allowed === false, JSON.stringify(blank));

  // The property wall and the kill switch are the other two things this
  // change must not have loosened. Both run BEFORE the person check, so a
  // fully consented person must still be refused by each.
  ok("A5d. unbundling did not widen the property wall",
    D({ enabled: true, property_allowlisted: false, person_id: "p", consent_state: "opted_in" }).reason_code
      === "PROPERTY_NOT_ACTIVATED");
  ok("A5e. unbundling did not defeat the kill switch",
    D({ enabled: false, property_allowlisted: true, person_id: "p", consent_state: "opted_in" }).reason_code
      === "APPLICATION_LINK_DISABLED");

  // A record_class arriving on this call must change NOTHING. If someone
  // reintroduces class here later, this is the assertion that catches it.
  const withClass = D({ enabled: true, property_allowlisted: true, person_id: "p",
                        consent_state: "opted_in", record_class: "whatever" });
  const withoutClass = D({ enabled: true, property_allowlisted: true, person_id: "p", consent_state: "opted_in" });
  ok("A5f. passing a record_class changes nothing — the field is out of this decision",
    withClass.allowed === withoutClass.allowed && withClass.reason_code === withoutClass.reason_code,
    JSON.stringify({ withClass, withoutClass }));

  ok("A6. every denial carries a human reason, never a bare refusal",
    [off, notProp, none, stopped, blank].every((v) => typeof v.display_reason === "string" && v.display_reason.length > 10));

  ok("A6b. classification vocabulary has left the operator-facing reasons entirely",
    !Object.values(capability.REASONS).some((r) => /test record|classif/i.test(r)),
    JSON.stringify(Object.values(capability.REASONS)));

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
      reason_code: "NO_CONSENT",
      display_reason: capability.REASONS.NO_CONSENT,
    },
  });
  ok("B1. a held action keeps the verb the operator would press, disabled",
    denied.label === "Send" && denied.kind === "blocked" && denied.blocked === true,
    JSON.stringify(denied));
  ok("B1b. HELD is not the same truth as UNSUPPORTED — the app can do this, policy holds it",
    denied.kind !== "unsupported");
  ok("B2. it carries the operator-facing reason",
    denied.reason === capability.REASONS.NO_CONSENT, denied.reason);
  ok("B3. it carries the machine reason code for logs",
    denied.reason_code === "NO_CONSENT");

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

  // Layer C sets its own activation, deliberately. Both evaluators read
  // process.env at call time, so on a shell where the kill switch happens to
  // be off EVERY verdict is APPLICATION_LINK_DISABLED — and "batch agrees
  // with single" then agrees about nothing, passing while testing nothing.
  // The classification read is the whole point of this layer, so the layer
  // establishes the preconditions that make it reachable.
  const savedEnabled = process.env.APPLICATION_INTENT_PREPARE_ENABLED;
  const savedIds = process.env.APPLICATION_INTENT_PROPERTY_IDS;
  process.env.APPLICATION_INTENT_PREPARE_ENABLED = "true";
  process.env.APPLICATION_INTENT_PROPERTY_IDS = DEMO_PROPERTY_ID;

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  try {
    await client.query("begin");
    // Fixtures now vary CONSENT, not class — the field this gate actually
    // reads. A classification is written on one of them ON PURPOSE, to prove
    // it makes no difference either way.
    const mk = async (name, consent, cls = null) => {
      const p = (await client.query(
        `insert into persons (name, lifecycle_status, leasing_stage, source)
         values ($1,'prospect','inquiry','harness') returning id`, [name])).rows[0];
      if (consent) {
        await client.query(
          `insert into contact_preferences (person_id, channel, consent_state, source, updated_at)
           values ($1,'text',$2,'harness',now())
           on conflict (person_id, channel) do update set consent_state = excluded.consent_state`,
          [p.id, consent]);
      }
      if (cls) {
        await client.query(
          `insert into person_property_classifications
             (person_id, property_id, record_class, classification_source, classification_reason)
           values ($1,$2,$3,'operator','harness')`, [p.id, DEMO_PROPERTY_ID, cls]);
      }
      return p.id;
    };
    const inId    = await mk("Cap OptedIn", "opted_in");
    const outId   = await mk("Cap OptedOut", "opted_out", "production");
    const noneId  = await mk("Cap NoConsent", null, "internal_qa");
    const ids = [inId, outId, noneId];

    const batch = await capability.evaluateApplicationLinkBirthBatch(client, {
      property_id: DEMO_PROPERTY_ID, person_ids: ids,
    });

    // C0 exists because C1 is satisfiable by universal refusal. If the gate
    // never got past the kill switch, nothing below reads a classification
    // and every assertion in this layer is vacuous. Fail loudly instead.
    ok("C0. the environment gate was actually passed — this layer is not vacuous",
      [...batch.values()].some((v) => v.reason_code !== "APPLICATION_LINK_DISABLED"),
      "every verdict was APPLICATION_LINK_DISABLED; layer C proved nothing");

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

    const bIn = batch.get(String(inId));
    ok("C2. the batch read resolves a real consent row, not a default",
      !!bIn && typeof bIn.allowed === "boolean", JSON.stringify(bIn));

    ok("C3. a person with NO consent row is denied in the batch path too",
      batch.get(String(noneId)) && batch.get(String(noneId)).allowed === false);

    // C4 is A3 again, but through a real consent row read out of real
    // Postgres by the board's batch query — the path the Send button uses.
    ok("C4. THE RULING, ON REAL DATA — a consented person's board row offers Send",
      !!bIn && bIn.allowed === true, JSON.stringify(bIn));

    // THE PROTECTION, ON REAL DATA. This person carries a 'production'
    // classification — the very class that used to be the ticket in — and is
    // still refused, because they said stop. Class opens nothing; consent
    // closes everything.
    const bOut = batch.get(String(outId));
    ok("C5. an opted-out person is refused on real data, production class notwithstanding",
      !!bOut && bOut.allowed === false && bOut.reason_code === "NO_CONSENT", JSON.stringify(bOut));
  } catch (e) {
    failed++; lines.push(`  FAIL  harness threw: ${e.message}`);
  } finally {
    try { await client.query("rollback"); } catch (_) {}
    client.release();
    await pool.end().catch(() => {});
    if (savedEnabled === undefined) delete process.env.APPLICATION_INTENT_PREPARE_ENABLED;
    else process.env.APPLICATION_INTENT_PREPARE_ENABLED = savedEnabled;
    if (savedIds === undefined) delete process.env.APPLICATION_INTENT_PROPERTY_IDS;
    else process.env.APPLICATION_INTENT_PROPERTY_IDS = savedIds;
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
