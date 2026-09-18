#!/usr/bin/env node
"use strict";
/* ════════════════════════════════════════════════════════════════════
 *  conversational_consistency.db.js
 *
 *  WHAT A PERSON ACTUALLY EXPERIENCES — not where a router sends a string.
 *
 *  Two demonstrations, against a real database:
 *
 *  A · ONE OPERATOR, TWO RAILS, ONE TRUTH
 *      The same authorized operator asks the same property question through
 *      the REAL website endpoint (POST /operator/ask-spine/message, over a
 *      real socket) and through the REAL staff SMS handler
 *      (staffGovernedRead.run — the function /communications/inbound-sms
 *      invokes for a knowledge question). Both must rest on the same
 *      governed facts.
 *
 *      WHERE EACH RAIL IS ENTERED, SAID PRECISELY. The web side goes through
 *      HTTP, the session gate and the endpoint. The SMS side is entered one
 *      layer below the Twilio webhook: the transport (signature check,
 *      provider ack, line resolution) is NOT exercised here, the handler it
 *      calls is. Claiming a full webhook proof would be the same overstatement
 *      this file exists to correct.
 *
 *      No model is involved on either rail for a knowledge question:
 *      leasingKnowledge.answer() takes a db and no anthropic client. So this
 *      is not "both said something similar" — it is the same governed read.
 *
 *  B · A PROSPECT IS NOT MADE TO REPEAT THEMSELVES
 *      Preferences are recorded through the canonical writer
 *      (recordPersonFact), read back through the canonical reader from the
 *      real database, and carried by the REAL resolveTurnContext that both
 *      live turn paths call. The agent's model turn is NOT exercised — what
 *      is proven is that the recorded preferences reach the turn, and that an
 *      unrelated question does not become a pricing search.
 *
 *  Synthetic identities. Fixtures are clearly labelled as fixtures. Nothing
 *  is sent anywhere and no real property's knowledge is read or written.
 *
 *  Run: HARNESS_DATABASE_URL="postgres://..." node tests/proofs/conversational_consistency.db.js
 * ════════════════════════════════════════════════════════════════════ */

const http = require("node:http");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const express = require("express");
const { Pool } = require("pg");
const { harnessConnectionString } = require("../_run_receipt.js");

const url = harnessConnectionString();
const pool = new Pool({ connectionString: url, ssl: false });

let passed = 0, failed = 0;
const ok = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok    ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail !== undefined ? "  " + JSON.stringify(detail) : ""}`); }
};
const uuid = () => crypto.randomUUID();
const sha256 = v => crypto.createHash("sha256").update(v).digest("hex");

const ID = {
  org: uuid(), property: uuid(),
  leasingUser: uuid(), leasingSession: uuid(),
  assetUser: uuid(), assetSession: uuid(),
  prospect: uuid(),
};
const LEASING_TOKEN = "proof-leasing-" + uuid();
const ASSET_TOKEN = "proof-asset-" + uuid();

//  CLEARLY IDENTIFIED TEST FIXTURES. Not scrubbed findings, not borrowed from
//  a real property, and marked as fixtures in their own text so a stray read
//  can never be mistaken for approved property knowledge.
//  Keys come from leasingKnowledge.TOPICS, checked rather than guessed: a
//  first pass invented a "pets" key and the shelf read came back empty, which
//  would have "proven" consistency by both rails agreeing on nothing.
const FIXTURES = [
  ["leasing_faq", "TEST FIXTURE - Cats and dogs welcome. Two pets per home, 50 lb limit each."],
  ["amenities", "TEST FIXTURE - Fitness room, resident lounge and a rooftop terrace."],
];

async function seed() {
  const q = (s, p) => pool.query(s, p);
  //  The SMS handler records the turn on a staff thread, which is
  //  organization-scoped. That is the real write path, so a real organization
  //  is seeded rather than the write being bypassed.
  await q(`insert into organizations (id, name, plan, status) values ($1,'Proof Org','free','active')`, [ID.org]);
  await q(`insert into properties (id, name, organization_id) values ($1,'Proof Property (fixtures only)',$2)`,
    [ID.property, ID.org]);

  for (const [user, session, token, modules, name] of [
    [ID.leasingUser, ID.leasingSession, LEASING_TOKEN, ["leasing"], "Proof Leasing Operator"],
    //  Entitled to the property, NOT to leasing. The refusal must be the same
    //  on both rails — an entitlement that holds on one channel and not the
    //  other is the divergence this whole slice is about.
    [ID.assetUser, ID.assetSession, ASSET_TOKEN, ["asset_management"], "Proof Asset Operator"],
  ]) {
    await q(`insert into users (id, name, role, is_active, status, account_kind)
             values ($1,$2,'leasing_manager',true,'active','human_staff')`, [user, name]);
    await q(`insert into property_team_assignments (user_id, property_id, role_title, allowed_modules, active)
             values ($1,$2,'Proof Role',$3::text[],true)`, [user, ID.property, modules]);
    await q(`insert into staff_sessions (id, user_id, property_id, token_digest, issuance_purpose, revoked, expires_at)
             values ($1,$2,$3,$4,'sms_otp',false, now() + interval '1 hour')`,
      [session, user, ID.property, sha256(token)]);
  }

  for (const [key, text] of FIXTURES) {
    await q(`insert into agent_facts (id, property_id, fact_key, category, rendered_text,
                                      source_type, status, confirmed_at, approved_by_user_id)
             values ($1,$2,$3,'leasing',$4,'operator_entry','active', now(), $5)`,
      [uuid(), ID.property, key, text, ID.leasingUser]);
  }

  await q(`insert into persons (id, name, primary_phone_e164) values ($1,'Proof Prospect','+12155550300')`,
    [ID.prospect]);
}

async function teardown() {
  const q = (s, p) => pool.query(s, p).catch(() => {});
  await q(`delete from person_attributes where person_id=$1`, [ID.prospect]);
  await q(`delete from agent_facts where property_id=$1`, [ID.property]);
  await q(`delete from staff_sessions where id = any($1::uuid[])`, [[ID.leasingSession, ID.assetSession]]);
  await q(`delete from property_team_assignments where user_id = any($1::uuid[])`, [[ID.leasingUser, ID.assetUser]]);
  await q(`delete from persons where id=$1`, [ID.prospect]);
  await q(`delete from users where id = any($1::uuid[])`, [[ID.leasingUser, ID.assetUser]]);
  await q(`delete from comm_events where staff_thread_id in (select id from staff_threads where organization_id=$1)`, [ID.org]);
  await q(`delete from staff_threads where organization_id=$1`, [ID.org]);
  await q(`delete from properties where id=$1`, [ID.property]);
  await q(`delete from organizations where id=$1`, [ID.org]);
}

async function main() {
  await teardown();
  await seed();

  // ── the WEB rail: the real endpoint, mounted and served ───────────
  const app = express();
  app.use(express.json());
  app.use("/", require("../../src/agent/ask_spine")({ pool, anthropic: null }));
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const webAsk = (message, token) => fetch(base + "/operator/ask-spine/message", {
    method: "POST",
    headers: { "content-type": "application/json", "x-staff-session": token },
    body: JSON.stringify({ message }),
  }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));

  // ── the SMS rail: the real handler the Twilio webhook calls ───────
  const { makeStaffGovernedRead } = require("../../src/comms/staff_governed_read");
  const askSpineAnswer = require("../../src/agent/ask_spine_answer");
  const staffGovernedRead = makeStaffGovernedRead({ askSpineAnswer });
  //  The webhook resolves this context from the line and the staff bridge;
  //  here it is supplied directly, which is exactly the boundary named above.
  const smsAsk = (body, userId) => staffGovernedRead.run(pool, null, {
    organizationId: ID.org, userId, lineId: null, body,
    providerMessageId: "PROOF" + crypto.randomBytes(8).toString("hex"),
    propertyContext: { outcome: "one", propertyId: ID.property,
      allowedModules: userId === ID.leasingUser ? ["leasing"] : ["asset_management"] },
    clarification: null, askOptions: {},
  });

  console.log("\nCONVERSATIONAL CONSISTENCY — REAL DB\n");
  console.log("A · one operator, two rails, one truth");

  const QUESTION = "what is our pet policy";
  const web = await webAsk(QUESTION, LEASING_TOKEN);
  const sms = await smsAsk(QUESTION, ID.leasingUser);

  ok("the website endpoint answers 200", web.status === 200, web.status);
  ok("the website rail answered from governed knowledge",
    web.json && web.json.outcome === "answered", web.json && web.json.outcome);
  const smsRead = (sms && (sms.read || sms)) || {};
  ok("the SMS rail answered too", smsRead.outcome === "answered", smsRead.outcome);

  //  THE CLAIM. grounded_on is governed state, not model output — so this is
  //  "the same authoritative information", not "two similar sentences".
  let sameGround = false;
  try { assert.deepEqual(web.json.grounded_on, smsRead.grounded_on); sameGround = true; } catch (_) {}
  ok("BOTH RAILS RESTED ON THE SAME GOVERNED FACTS (grounded_on is identical)",
    sameGround, { web: web.json && web.json.grounded_on, sms: smsRead.grounded_on });
  ok("and the governed topic really is the one the question asked for",
    (web.json.grounded_on.topics || []).includes("leasing_faq"), web.json.grounded_on.topics);
  ok("the answer carries the approved fixture wording, not an invention",
    /50 lb limit/.test(web.json.answer || ""), web.json.answer);
  ok("the SMS rail carries the same wording",
    /50 lb limit/.test(smsRead.answer || ""), smsRead.answer);

  //  Entitlement must hold identically on both channels.
  const webRefused = await webAsk(QUESTION, ASSET_TOKEN);
  const smsRefused = await smsAsk(QUESTION, ID.assetUser);
  const smsRefusedRead = (smsRefused && (smsRefused.read || smsRefused)) || {};
  ok("an operator without leasing is refused on the website",
    webRefused.json && webRefused.json.outcome === "not_authorized", webRefused.json && webRefused.json.outcome);
  ok("and refused identically over SMS",
    smsRefusedRead.outcome === "not_authorized", smsRefusedRead.outcome);
  ok("neither refusal leaks the knowledge it withheld",
    !/50 lb limit/.test(JSON.stringify(webRefused.json || {}))
    && !/50 lb limit/.test(JSON.stringify(smsRefusedRead || {})), "leaked");

  //  A question with nothing recorded must say so on both rails, not guess.
  //  floor_plans is deliberately NOT seeded. (The obvious phrasing about guest
  //  parking maps to `amenities`, which IS seeded — so it would have proven
  //  the opposite of what it claimed.)
  const NOTHING = "can you show me the floor plans";
  const webGap = await webAsk(NOTHING, LEASING_TOKEN);
  const smsGap = await smsAsk(NOTHING, ID.leasingUser);
  const smsGapRead = (smsGap && (smsGap.read || smsGap)) || {};
  let sameGap = false;
  try { assert.deepEqual(webGap.json.grounded_on, smsGapRead.grounded_on); sameGap = true; } catch (_) {}
  ok("an unestablished topic is the SAME honest gap on both rails", sameGap,
    { web: webGap.json && webGap.json.grounded_on, sms: smsGapRead.grounded_on });

  // ══════════════════════════════════════════════════════════════════
  console.log("\nB · a prospect is not made to repeat themselves");

  const agent = require("../../src/agent/agent")({
    pool, anthropic: null, INGEST_MODEL: "proof",
    sms: { sendSms: async () => { throw new Error("proof: transport must not be reached"); } },
  });
  const resolveTurnContext = agent.__test__ && agent.__test__.resolveTurnContext;
  ok("the real turn-context resolver is reachable", typeof resolveTurnContext === "function");
  if (typeof resolveTurnContext !== "function") { await finish(server); return; }

  //  TURN 1 — "I need a two-bedroom in August under $2,500."
  const turn1 = await resolveTurnContext({
    message: "I need a two-bedroom in August under $2,500.",
    person_id: ID.prospect, property_id: ID.property });
  ok("the opening turn is treated as a governed search",
    turn1.needsPricing === true && turn1.needsInventory === true,
    { pricing: turn1.needsPricing, inventory: turn1.needsInventory });

  //  What the prospect said is recorded through the CANONICAL writer.
  const { recordPersonFact } = require("../../src/identity/person_facts");
  for (const [key, value] of [["unit_type", "2BR"], ["move_month", "August"], ["budget", "$2,500"]]) {
    const w = await recordPersonFact(pool, {
      personId: ID.prospect, propertyId: ID.property,
      attrKey: key, attrValue: value,
      source: "ai_conversation", actorType: "agent",
    });
    if (!w.written) console.error("  (writer refused:", key, w.skipped_reason, ")");
  }
  const stored = (await pool.query(
    `select attr_key, attr_value from person_attributes
      where person_id=$1 and status='active' order by attr_key`, [ID.prospect])).rows;
  ok("all three preferences are recorded in the database", stored.length === 3, stored);

  //  TURN 2 — "What about furnished?"  An elliptical follow-up.
  const turn2 = await resolveTurnContext({
    message: "What about furnished?", person_id: ID.prospect, property_id: ID.property });
  ok("THE FOLLOW-UP CARRIES WHAT THE PROSPECT ALREADY SAID — read from the database",
    ["unit_type", "move_month", "budget"].every(k => k in (turn2.established || {})),
    Object.keys(turn2.established || {}));
  const est = turn2.established || {};
  ok("with the values they actually gave",
    (est.unit_type || {}).value === "2BR"
    && (est.move_month || {}).value === "August"
    && (est.budget || {}).value === "$2,500", est);
  ok("and their provenance, so an answer can say where it came from",
    (est.budget || {}).source === "ai_conversation", est.budget);
  ok("the follow-up still reaches the right shelf",
    (turn2.factKeys || []).includes("amenities"), turn2.factKeys);

  //  TURN 3 — "How do packages work?"  A NEW question, not a price question.
  const turn3 = await resolveTurnContext({
    message: "How do packages work?", person_id: ID.prospect, property_id: ID.property });
  ok("A NEW QUESTION DOES NOT BECOME A PRICING SEARCH", turn3.needsPricing === false, turn3.needsPricing);
  ok("nor an inventory search", turn3.needsInventory === false, turn3.needsInventory);
  ok("and it does not drag the recorded budget into an unrelated answer",
    Object.keys(turn3.established || {}).length === 0, turn3.established);

  //  The control that makes the one above mean something: the flags must be
  //  identical for the same words with NOTHING recorded. That is what proves
  //  they come from this turn, not from the stored profile.
  const bare = await resolveTurnContext({
    message: "How do packages work?", person_id: null, property_id: ID.property });
  ok("the flags are the same with nothing recorded — they come from the words, not the profile",
    bare.needsPricing === turn3.needsPricing && bare.needsInventory === turn3.needsInventory,
    { withProfile: turn3.needsPricing, without: bare.needsPricing });

  //  Staff and prospect conversations are separate. The prospect's recorded
  //  preferences must not be reachable through the staff knowledge rail.
  const staffPeek = await webAsk("what is our pet policy", LEASING_TOKEN);
  ok("the staff rail discloses no prospect preference",
    !/\$2,500|August/.test(JSON.stringify(staffPeek.json || {})), staffPeek.json && staffPeek.json.answer);

  // ══════════════════════════════════════════════════════════════════
  //  THE TRANSCRIPT. Printed so a receipt can show what a person actually
  //  sees, rather than asserting it happened and asking to be believed.
  console.log("\n── WHAT A PERSON ACTUALLY SEES ──────────────────────────\n");
  console.log("  OPERATOR asks, on the website:  \"" + QUESTION + "\"");
  console.log("    web  → [" + web.json.outcome + "] " + web.json.answer);
  console.log("    sms  → [" + smsRead.outcome + "] " + smsRead.answer);
  console.log("    both grounded_on: " + JSON.stringify(web.json.grounded_on));
  console.log("\n  SAME OPERATOR, without leasing access:");
  console.log("    web  → [" + webRefused.json.outcome + "] " + webRefused.json.answer);
  console.log("    sms  → [" + smsRefusedRead.outcome + "] " + smsRefusedRead.answer);
  console.log("\n  PROSPECT:");
  console.log("    \"I need a two-bedroom in August under $2,500.\"");
  console.log("      → governed search: pricing=" + turn1.needsPricing + " inventory=" + turn1.needsInventory);
  console.log("      → recorded: " + stored.map(r => r.attr_key + "=" + r.attr_value).join(", "));
  console.log("    \"What about furnished?\"");
  console.log("      → carried forward: " + Object.entries(turn2.established || {})
        .map(([k, v]) => k + "=" + v.value).join(", "));
  console.log("      → reads shelf: " + (turn2.factKeys || []).join(", "));
  console.log("    \"How do packages work?\"");
  console.log("      → pricing=" + turn3.needsPricing + " inventory=" + turn3.needsInventory
        + "  carried forward: " + (Object.keys(turn3.established || {}).length ? "…" : "(nothing — correctly)"));
  console.log("");

  await finish(server);
}

async function finish(server) {
  await new Promise(r => server.close(r));
  await teardown();
  await pool.end();
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch(async e => {
  console.error("\n  PROOF ABORTED:", (e && e.stack) || e);
  await teardown().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(1);
});
