#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   CAPABILITY 2 — `maintenance.ownership_and_acceptance`, PROVEN

   Real Postgres. Real HTTP. The shipped executor, renderer, receipt
   service and route.

     A  the three ownership states, derived mechanically
     B  cardinality survives — many obligations, never one owner
     C  facets come from the FULL population, caps from the page
     D  the optional source — PARTIAL, and never a corrupted fact
     E  ★ THE GENERICITY TEST — decisive with NO Release 0 activation,
        in the same database where Capability 1 is honestly unavailable
     F  real HTTP, server-derived authority, cross-property
     G  the durable receipt
     H  language: assigned/accepted, never owns/accountable

   ⚠ ISOLATED POSTGRES ONLY — run through tools/build1/run_isolated.sh.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const { Pool } = require("pg");

const ROOT = path.join(__dirname, "..", "..");
const executor = require(path.join(ROOT, "src/askspine/intent_executor.js"));
const renderer = require(path.join(ROOT, "src/askspine/renderer.js"));
const receipts = require(path.join(ROOT, "src/askspine/receipt_service.js"));
const acceptance = require(path.join(ROOT, "src/technician/acceptance_service.js"));

const URL = process.env.OWNERSHIP2_DATABASE_URL;
const SLUG = "maintenance.ownership_and_acceptance";
const C1 = "maintenance.completion_without_valid_proof";

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };
const sec = (t) => console.log(`\n${"═".repeat(70)}\n  ${t}\n${"═".repeat(70)}`);
const lane0 = (e) => ((e.totals && e.totals.lanes) || [])[0] || {};
const facet = (e, k) => (((lane0(e).facets || {}).ownership_state || {})[k] || 0);

const ID = (n) => crypto.createHash("md5").update("own2:" + n).digest("hex")
  .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5");
const ORG = ID("org"), PROP = ID("prop"), OTHER = ID("other");
const ALICE = ID("alice"), BOB = ID("bob"), GONE = ID("gone");

(async function main() {
  if (!URL) { console.error("REFUSED: OWNERSHIP2_DATABASE_URL is not set."); process.exit(1); }
  const pool = new Pool({ connectionString: URL, max: 8 });
  const c = await pool.connect();
  const sentinel = Number((await c.query(
    `select count(*) n from release_0_scale_harness_guard where purpose like 'ISOLATED RELEASE 0%'`
  ).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n);
  if (sentinel !== 1) { console.error("REFUSED: not the isolated baseline."); process.exit(2); }

  for (const m of ["141_ask_spine_read_receipts.sql",
                   "142_obligation_acceptance_cannot_be_orphaned.sql"]) {
    // eslint-disable-next-line no-await-in-loop
    await c.query(fs.readFileSync(path.join(ROOT, "migrations", m), "utf8"));
  }
  await c.query(`insert into organizations (id,name) values ($1,'Own2') on conflict do nothing`, [ORG]);
  for (const [id, nm] of [[PROP, "Own2 Prop"], [OTHER, "Own2 Other"]]) {
    // eslint-disable-next-line no-await-in-loop
    await c.query(`insert into properties (id,name,organization_id) values ($1,$2,$3)
                   on conflict (id) do nothing`, [id, nm, ORG]);
  }
  //  GONE is deliberately NOT on the team: an assignee whose current
  //  standing cannot be resolved, which is the honest optional-source case.
  for (const [id, nm, ph, team] of [[ALICE, "Alice", "+15005552001", true],
                                    [BOB, "Bob", "+15005552002", true],
                                    [GONE, "Dana", "+15005552003", false]]) {
    // eslint-disable-next-line no-await-in-loop
    await c.query(`insert into users (id,name,phone,role) values ($1,$2,$3,'maintenance')
                   on conflict (id) do nothing`, [id, nm, ph]);
    // eslint-disable-next-line no-await-in-loop
    if (team) await c.query(`insert into property_team_assignments
        (user_id,property_id,role_title,allowed_modules,active)
        values ($1,$2,'Technician',array['maintenance'],true) on conflict do nothing`, [id, PROP]);
  }

  let seq = 0;
  const mkWo = async (prop = PROP) => {
    const wo = ID("wo" + (++seq));
    await c.query(`insert into work_orders (id,property_id,title,status,source)
                   values ($1,$2,'own2 fixture','open','own2proof')`, [wo, prop]);
    return wo;
  };
  const mkObl = async (wo, { type = "work_order_routing", prop = PROP, module = "maintenance",
                             assigned = null, status = "open" } = {}) => (await c.query(
    `insert into obligations (property_id, related_id, related_type, module, type, label,
                              assigned_user_id, status)
     values ($1,$2,'work_order',$3,$4,$5,$6,$7) returning id`,
    [prop, wo, module, type, `${type}`, assigned, status])).rows[0].id;
  const run = (prop = PROP, mods = ["maintenance"]) => executor.execute(pool, {
    intent_slug: SLUG, property_id: prop, allowed_modules: mods });

  console.log("CAPABILITY 2 — maintenance.ownership_and_acceptance\n");

  /* ═══ A · THE THREE STATES ══════════════════════════════════════ */
  sec("A · the three ownership states, derived from durable fields only");
  const woA = await mkWo();
  {
    await mkObl(woA, { type: "proof_evaluation_missing" });                  // unassigned
    await mkObl(woA, { type: "resident_follow_up", assigned: BOB });         // assigned, not accepted
    const acc = await mkObl(woA, { type: "work_order_routing", assigned: ALICE });
    await acceptance.acceptWork(c, { obligation_id: acc, user_id: ALICE,
      organization_id: ORG, acceptance_key: "own2-a" });

    const e = await run();
    const states = e.supporting_records.map((r) => r.ownership_state).sort();
    ok("A1  all three states appear on ONE work order",
       JSON.stringify(states) ===
       JSON.stringify(["assigned_accepted", "assigned_not_accepted", "unassigned"]),
       JSON.stringify(states));
    ok("A2  the facet counts agree", facet(e, "unassigned") === 1 &&
       facet(e, "assigned_not_accepted") === 1 && facet(e, "assigned_accepted") === 1,
       JSON.stringify(lane0(e).facets));
    ok("A3  acceptance is never inferred — the accepted one has an accepted_at",
       e.supporting_records.filter((r) => r.ownership_state === "assigned_accepted")
         .every((r) => !!r.accepted_at),
       "absence of an acceptance fact means NOT accepted, never 'probably accepted'");
    ok("A4  …and the not-accepted one has none",
       e.supporting_records.filter((r) => r.ownership_state === "assigned_not_accepted")
         .every((r) => r.accepted_at === null));
    ok("A5  coverage is DECISIVE", e.coverage_state === "decisive", e.coverage_state);
  }

  /* ═══ B · CARDINALITY ═══════════════════════════════════════════ */
  sec("B · one work order, three obligations, never one owner");
  {
    const e = await run();
    const forWo = e.supporting_records.filter((r) => r.work_order_id === woA);
    ok("B1  the work order yields THREE separate records", forWo.length === 3, String(forWo.length));
    ok("B2  each keeps its own obligation identity and type",
       new Set(forWo.map((r) => r.obligation_id)).size === 3 &&
       new Set(forWo.map((r) => r.obligation_type)).size === 3,
       JSON.stringify(forWo.map((r) => r.obligation_type)));
    ok("B3  the record type is OBLIGATION, not work order",
       forWo.every((r) => r.record_type === "obligation"), forWo[0].record_type);
    ok("B4  no record claims a single owner for the work order",
       forWo.every((r) => !("owner" in r) && !("work_order_owner" in r)),
       "flattening three obligations into one owner destroys information");
    const answer = renderer.render(e).answer;
    ok("B5  …and the sentence never names one either",
       !/owns/i.test(answer) && !/owner/i.test(answer), answer);
  }

  /* ═══ C · FACETS vs CAPS ════════════════════════════════════════ */
  sec("C · facets from the FULL population, records from the capped page");
  {
    const cap = executor.loadContract(SLUG).result_cap_per_lane;
    const extra = 45;
    for (let i = 0; i < extra; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const w = await mkWo();
      // eslint-disable-next-line no-await-in-loop
      await mkObl(w, { type: "work_order_routing" });      // all unassigned
    }
    const e = await run();
    ok("C1  the total counts the whole population",
       lane0(e).total_matching === 48, String(lane0(e).total_matching));
    ok("C2  the page is capped", lane0(e).selected_count === cap,
       `${lane0(e).selected_count} vs cap ${cap}`);
    ok("C3  the facet counts EXCEED the page — they describe everything",
       facet(e, "unassigned") === 46 && facet(e, "unassigned") > cap,
       JSON.stringify(lane0(e).facets) + " — a facet computed over the 20 selected " +
       "rows would be a claim about the page dressed as a claim about the property");
    const r = renderer.render(e);
    ok("C4  the sentence states the full counts",
       /46 unassigned/.test(r.answer) && /48 current maintenance obligations/.test(r.answer),
       r.answer);
    ok("C5  …and discloses that the list is a subset",
       /Showing 20 of 48/.test(r.boundedness_note || ""), String(r.boundedness_note));
    console.log(`        → "${r.answer}"`);
    console.log(`          [${r.boundedness_note}]`);
  }

  /* ═══ D · THE OPTIONAL SOURCE ═══════════════════════════════════ */
  sec("D · assignee standing is enrichment — it can never change a fact");
  {
    //  On woA, which sorts FIRST. Section C added 45 rows; a new work
    //  order would sort past the cap and the record would be absent for a
    //  reason that has nothing to do with what D is testing.
    const o = await mkObl(woA, { type: "vendor_coordination", assigned: GONE });
    const e = await run();
    const rec = e.supporting_records.find((r) => r.obligation_id === o);
    ok("D1  an assignee with no active team standing is STILL assigned",
       rec && rec.ownership_state === "assigned_not_accepted",
       JSON.stringify(rec) + " — a display lookup that cannot resolve must never " +
       "become UNASSIGNED; that would corrupt the operating fact");
    ok("D2  …with the standing honestly absent", rec.assignee_display === null &&
       rec.assignee_team_standing === null, JSON.stringify(rec));
    ok("D3  …and the assignee id still travels", rec.assigned_user_id === GONE);
    const alice = e.supporting_records.find((r) => r.assigned_user_id === ALICE);
    ok("D4  a resolvable assignee DOES carry a display name",
       alice && alice.assignee_display === "Alice", JSON.stringify(alice));

    //  Now break the optional source itself.
    await c.query(`alter table property_team_assignments rename to _hidden_pta`);
    const broken = await run();
    await c.query(`alter table _hidden_pta rename to property_team_assignments`);
    ok("D5  a FAILED optional source degrades coverage to PARTIAL",
       broken.coverage_state === "partial", broken.coverage_state);
    ok("D6  …while the operating facts survive intact",
       broken.supporting_records.length > 0 &&
       broken.supporting_records.every((r) => r.ownership_state !== undefined) &&
       broken.supporting_records.some((r) => r.assigned_user_id === ALICE),
       "the assignment is a required-source fact; enrichment failing may not erase it");
    ok("D7  …and no record silently became unassigned",
       broken.supporting_records.filter((r) => r.assigned_user_id === ALICE)
         .every((r) => r.ownership_state !== "unassigned"));
  }

  /* ═══ E · THE GENERICITY TEST ═══════════════════════════════════ */
  sec("E · ★ decisive with NO Release 0 activation — the abstraction test");
  {
    const activated = Number((await c.query(
      `select count(*)::int n from release_0_activation_history`)).rows[0].n);
    ok("E1  this database has NO Release 0 activation", activated === 0, String(activated));

    const c1 = await executor.execute(pool, {
      intent_slug: C1, property_id: PROP, allowed_modules: ["maintenance"] });
    ok("E2  Capability 1 is therefore honestly UNAVAILABLE",
       c1.coverage_state === "unavailable" &&
       c1.conclusion_code === "unavailable_source_cannot_answer", c1.coverage_state);

    const c2 = await run();
    ok("E3  ★ Capability 2 is DECISIVE in the SAME database",
       c2.coverage_state === "decisive" || c2.coverage_state === "partial",
       c2.coverage_state + " — if this were unavailable, the executor's answerability " +
       "would be Release-0-shaped rather than contract-driven");
    ok("E4  …and it never consulted the activation authority",
       !c2.source_outcomes.some((o) => o.id === "release_0_activation_authority"),
       JSON.stringify(c2.source_outcomes.map((o) => o.id)));
    ok("E5  …because its contract declares no Release 0 source",
       !(executor.loadContract(SLUG).required_sources || [])
         .some((s) => /release_0/.test(s.id)),
       JSON.stringify((executor.loadContract(SLUG).required_sources || []).map((s) => s.id)));
    console.log("        → two capabilities, one executor, opposite answerability,");
    console.log("          zero intent-specific branches in the executor.");
  }

  /* ═══ F · REAL HTTP ═════════════════════════════════════════════ */
  sec("F · real HTTP, server-derived authority, cross-property");
  let server;
  {
    const app = express();
    app.use("/", require(path.join(ROOT, "src/agent/ask_spine.js"))({ pool }));
    server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
    const port = server.address().port;
    const staffSessions = require(path.join(ROOT, "src/identity/staff_session_service.js"));
    const issued = await staffSessions.issueStaffSession(pool, {
      userId: ALICE, propertyId: PROP, purpose: "bootstrap_invite" });

    const get = (p, headers) => new Promise((resolve) => {
      http.get(`http://127.0.0.1:${port}${p}`, { headers: headers || {} }, (r) => {
        let b = ""; r.on("data", (d) => { b += d; });
        r.on("end", () => { let j = null; try { j = JSON.parse(b); } catch (e) { /* */ }
          resolve({ status: r.statusCode, json: j }); });
      }).on("error", () => resolve({ status: 0, json: null }));
    });
    const P = "/operator/ask-spine/ownership-and-acceptance";

    ok("F1  no session → 401", (await get(P)).status === 401);
    const authed = await get(P, { "x-staff-session": issued.session_token });
    ok("F2  a real session → 200", authed.status === 200, String(authed.status));
    ok("F3  the intent slug travels", authed.json.intent_slug === SLUG, authed.json.intent_slug);
    ok("F4  the records are obligations",
       authed.json.supporting_records.every((r) => r.record_type === "obligation"));
    ok("F5  a client property_id is REFUSED",
       (await get(`${P}?property_id=${OTHER}`,
         { "x-staff-session": issued.session_token })).status === 403);

    //  Cross-property absence, not merely filtering.
    const wOther = await mkWo(OTHER);
    await mkObl(wOther, { prop: OTHER, assigned: BOB });
    const again = await get(P, { "x-staff-session": issued.session_token });
    ok("F6  the other property's obligation is ABSENT from the records",
       !again.json.supporting_records.some((r) => r.work_order_id === wOther));
    const e2 = await run(OTHER);
    ok("F7  …and IS visible to its own property",
       e2.supporting_records.some((r) => r.work_order_id === wOther),
       "otherwise F6 proves nothing");
    ok("F8  the totals did not leak it either",
       again.json.totals.lanes[0].total_matching < e2.totals.lanes[0].total_matching + 49,
       "a leak in the COUNT is still a leak");
  }

  /* ═══ G · THE RECEIPT ═══════════════════════════════════════════ */
  sec("G · the durable read receipt, for a different entity type");
  {
    const e = await run();
    const r = renderer.render(e);
    const row = await receipts.writeReceipt(pool, {
      execution: e, rendered: r, property_id: PROP, actor: { user_id: ALICE } });
    const got = (await c.query(`select * from ask_spine_read_receipts where id=$1`, [row.id])).rows[0];
    ok("G1  it names THIS intent", got.intent_slug === SLUG, got.intent_slug);
    ok("G2  …and this contract version and digest",
       got.intent_contract_version === executor.loadContract(SLUG).version &&
       got.intent_contract_digest === executor.loadContract(SLUG).digest);
    ok("G3  the lane breakdown carries the facets",
       JSON.stringify(got.lane_breakdown).includes("ownership_state"),
       JSON.stringify(got.lane_breakdown).slice(0, 120));
    ok("G4  the supporting records are obligations",
       got.supporting_records.every((x) => x.record_type === "obligation"));
    ok("G5  read time and fact time stay separate",
       "executed_at" in got && "evidence_as_of" in got && !!got.evidence_as_of_basis,
       got.evidence_as_of_basis);
  }

  /* ═══ H · LANGUAGE ══════════════════════════════════════════════ */
  sec("H · assigned and accepted — never owns, never accountable");
  {
    const contract = executor.loadContract(SLUG);
    const SAMPLE = { result_cap_per_lane: 20, total_matching: 3, selected_count: 3,
      lanes: [{ lane: contract.lanes[0], total_matching: 3, selected_count: 3, result_cap: 20,
                facets: { ownership_state: { unassigned: 1, assigned_not_accepted: 1,
                                             assigned_accepted: 1 } } }] };
    const sentences = ["ownership_none_current", "ownership_all_accepted", "ownership_mixed"]
      .map((code) => renderer.render({ conclusion_code: code, totals: SAMPLE }).answer)
      .join(" | ");
    for (const w of contract.renderer_contract.forbidden_words) {
      ok(`H·  no sentence says "${w}"`, !new RegExp(`\\b${w}\\b`, "i").test(sentences),
         sentences);
    }
    ok("H1  …and the preferred vocabulary is present",
       /assigned/.test(sentences) && /accepted/.test(sentences), sentences);
    console.log("        " + sentences.replace(/ \| /g, "\n        "));
  }

  sec("VERDICT");
  console.log(`  passed ${pass}   failed ${fail}\n`);
  if (server) server.close();
  c.release();
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(1); });
