#!/usr/bin/env node
"use strict";

const http = require("http");
const express = require("express");
const { Pool } = require("pg");
const receipt = require("./_run_receipt.js");
const { resolveAuthority } = require("../src/identity/authority_resolution.js");
const { saveDraft, submitReview, publishVersion } = require("../src/money/pricing_lifecycle.js");
const sessions = require("../src/identity/staff_session_service.js");
const { establishAuthorizedReviewer } = require("./support/authority_reviewer_fixture.js");

const EXPECTED_ASSERTIONS = 16;
const CONN = receipt.harnessConnectionString();
const pool = new Pool({ connectionString: CONN });
const tag = `economics-ask-http-${process.pid}-${Date.now()}`;

let pass = 0, fail = 0;
function proves(label, condition, detail = "") {
  if (condition) { pass += 1; console.log(`  ok    ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`); }
}

function post(port, body, token) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: "127.0.0.1", port, path: "/operator/ask-spine/ask", method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
        "x-staff-session": token,
      },
    }, (res) => {
      let raw = "";
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (_) { /* asserted below */ }
        resolve({ status: res.statusCode, json, raw });
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}

function factsFrom(request) {
  return JSON.parse(request.messages[0].content
    .replace(/^QUESTION SUBJECT:[^\n]+\nFACTS:\n/, "")
    .replace(/\n\nOPERATOR ASKED:[\s\S]*$/, ""));
}

async function publishProperty(adminId, userId, personId, label, terms) {
  const propertyId = (await pool.query(
    `insert into properties (name, address, leasing_basis)
     values ($1, $2, 'bed') returning id`,
    [`${tag}-${label}`, `${label} Proof Street`])).rows[0].id;
  const typeId = (await pool.query(
    `insert into property_unit_types (property_id, code, label, sort_order)
     values ($1, '2BR', '2 Bedroom', 10) returning id`, [propertyId])).rows[0].id;
  const unitId = (await pool.query(
    `insert into units (property_id, unit_number, bedrooms, bathrooms, unit_type_id)
     values ($1, '302', 2, 1, $2) returning id`, [propertyId, typeId])).rows[0].id;
  await pool.query("delete from spaces where unit_id=$1 and space_label='(whole unit)'", [unitId]);
  await pool.query(
    `insert into spaces (unit_id, space_label, use_type, position_kind)
     values ($1, 'Bed A', 'residential', 'bed')`, [unitId]);
  await pool.query(
    `insert into person_contexts (person_id, context_type, property_id, created_by_user_id)
     values ($1, 'staff', $2, $3)`, [personId, propertyId, adminId]);
  await establishAuthorizedReviewer(pool, {
    userId: adminId, propertyId, label: `${tag}-authority-reviewer`,
  });
  await resolveAuthority(pool, { spec: {
    user_id: userId,
    person_id: personId,
    property_id: propertyId,
    requested_role: "asset_manager",
    reviewer_user_id: adminId,
    reason: "economics Ask Spine real HTTP proof",
  }, apply: true });
  await pool.query(
    `insert into property_team_assignments
       (property_id, user_id, role_title, scope_type, allowed_modules,
        primary_for_modules, can_manage_roles, active)
     values ($1, $2, 'Asset Manager', 'property', $3, $3, false, true)`,
    [propertyId, userId, ["asset_management"]]);

  const proposal = {
    publisher_person_id: personId,
    effective_from: "2026-01-01",
    terms: terms.map((term) => ({
      unit_type_id: typeId,
      lease_term_months: term.months,
      base_rent: term.rent,
      renewal_rent: term.rent,
      offer_state: "offered",
    })),
  };
  const draft = await saveDraft(pool, { property_id: propertyId, user_id: userId, proposal });
  const review = await submitReview(pool, {
    property_id: propertyId,
    user_id: userId,
    draft_version_id: draft.draft_version_id,
    proposal,
    decision: "approved",
    note: "real HTTP proof",
  });
  await publishVersion(pool, {
    property_id: propertyId,
    user_id: userId,
    draft_version_id: draft.draft_version_id,
    proposal: { ...proposal, receipt_reviewed: true },
    review_receipt_id: review.review_receipt_id,
    dry_run: false,
  });

  const client = await pool.connect();
  try {
    await client.query("begin");
    const session = await sessions.issueStaffSession(client, {
      userId, propertyId, purpose: "sms_otp",
    });
    await client.query("commit");
    return { propertyId, typeId, token: session.session_token };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  receipt.begin(__filename, { url: CONN, expected: EXPECTED_ASSERTIONS });

  const adminId = (await pool.query(
    `insert into users (name, email, role, is_active, status, account_kind)
     values ($1, $2, 'asset_manager', true, 'active', 'human_staff') returning id`,
    [`${tag}-admin`, `${tag}-admin@example.test`])).rows[0].id;
  const personId = (await pool.query(
    `insert into persons (name, email, source)
     values ($1, $2, 'staff_bridge') returning id`,
    [`${tag}-person`, `${tag}-operator@example.test`])).rows[0].id;
  const userId = (await pool.query(
    `insert into users (name, email, role, is_active, status, account_kind, person_id)
     values ($1, $2, 'asset_manager', true, 'active', 'human_staff', $3) returning id`,
    [`${tag}-operator`, `${tag}-operator@example.test`, personId])).rows[0].id;

  const skyline = await publishProperty(adminId, userId, personId, "one-term", [
    { months: 12, rent: 850 },
  ]);
  const menu = await publishProperty(adminId, userId, personId, "multi-term", [
    { months: 5, rent: 975 },
    { months: 12, rent: 850 },
  ]);

  const calls = [];
  const anthropic = { messages: { async create(request) {
    calls.push(request);
    return { content: [{ type: "text", text: JSON.stringify({
      outcome: "answered",
      answer: "The published terms are recorded in Spine.",
    }) }] };
  } } };
  const app = express();
  app.use(express.json());
  app.use("/", require("../src/agent/ask_spine.js")({ pool, anthropic }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const one = await post(port, { question: "What is the published price?" }, skyline.token);
    const oneFacts = factsFrom(calls[0]);
    const oneType = oneFacts.economics.base_rent.types[0];
    proves("a real session reaches the real Ask Spine HTTP route", one.status === 200, one.raw);
    proves("the route derives the one-term property from the session",
      one.json.property_id === skyline.propertyId, JSON.stringify(one.json));
    proves("the real SQL read returns Skyline-like 12-month pricing",
      oneType.terms.join(",") === "12" && oneType.new_lease_rent === 850,
      JSON.stringify(oneType));
    proves("one term needs no invented choice",
      oneType.term_selection === "not_required" && oneType.quotable === true);
    proves("the model receives neither unit-type nor pricing-version database ids",
      !JSON.stringify(oneFacts).includes(skyline.typeId)
      && !/version_id|unit_type_id/.test(JSON.stringify(oneFacts)));
    proves("the HTTP grounding names the canonical economics read",
      one.json.grounded_on.economics_read_state === "OK"
      && one.json.grounded_on.economics_unit_type_count === 1);

    const many = await post(port, { question: "What is the asking rent for a 2 bedroom?" }, menu.token);
    const manyFacts = factsFrom(calls[1]);
    const manyType = manyFacts.economics.base_rent.types[0];
    proves("the second real property is independently session-scoped",
      many.status === 200 && many.json.property_id === menu.propertyId, many.raw);
    proves("both published terms cross the real HTTP boundary",
      manyType.terms.join(",") === "5,12", JSON.stringify(manyType.terms));
    proves("multiple terms never flatten to the first or dearest rent",
      manyType.new_lease_rent === null && manyType.renewal_rent === null
      && manyType.quotable === false);
    proves("the term choice remains explicit in the facts",
      manyType.term_selection === "required"
      && manyType.unresolved_reason === "lease_term_not_selected");
    proves("each term keeps its own real published rent",
      manyType.term_economics.map((term) => `${term.lease_term_months}:${term.new_lease_rent}`)
        .join(",") === "5:975,12:850");
    proves("the canonical combined total names the missing term selection",
      manyFacts.economics.combined_monthly_total.withheld === true
      && manyFacts.economics.combined_monthly_total.withheld_because
        .includes("base_rent:lease_term_not_selected"));
    proves("the response grounding reports that the total was withheld",
      many.json.grounded_on.economics_monthly_total_withheld === true);

    const beforeWall = calls.length;
    const wall = await post(port, {
      property_id: menu.propertyId,
      question: "What is the asking rent?",
    }, skyline.token);
    proves("a client cannot switch the property in the body", wall.status === 403, wall.raw);
    proves("the refused cross-property request reaches neither reader nor model",
      calls.length === beforeWall);
    proves("both successful turns used the Economics subject",
      calls.slice(0, 2).every((request) => /QUESTION SUBJECT: economics/.test(
        request.messages[0].content)));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (pass + fail !== EXPECTED_ASSERTIONS || fail) process.exit(1);
}

main().catch(async (error) => {
  console.error("HARNESS ERROR:", error);
  await pool.end().catch(() => {});
  process.exit(1);
});
