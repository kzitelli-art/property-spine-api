#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   RELEASE 0 — GATE 4, TECHNICIAN AND WORK-ORDER FIXTURE

   Verifies the tester identity and work order 1006, from the production
   database, WITHOUT guessing the identity schema. Identity is resolved by
   calling the PRODUCTION resolver — resolveStaffSenderForOrganization
   from src/comms/communication_lines.js — not by a query written here
   that could drift from the one the route actually runs.

   The organization is DERIVED, never typed: work order 1006 names its
   property, the property names its organization. That is the same
   direction of derivation the spec requires for the operations line.

   Read-only, and proves it before reading (tools/activation/_readonly.js).
   The governed Assign action is NOT here — assignment happens through
   the Work Orders door, by a human. This tool verifies before (--pre)
   and reads back after (--post).

   ── WHAT IS NEVER PRINTED ───────────────────────────────────────────
   The tester's phone number. It enters via TEST_FROM, is passed to the
   resolver, and appears in output only as ****last4. The receipt records
   booleans and internal IDs.

   usage (Render shell):
     TEST_FROM='+1XXXXXXXXXX' node tools/activation/technician_fixture_proof.js --pre
     TEST_FROM='+1XXXXXXXXXX' node tools/activation/technician_fixture_proof.js --post
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const path = require("path");
const { Client } = require("pg");
const { beginProvenReadOnly, refuseNotReadOnly } = require("./_readonly.js");
const { resolveStaffSenderForOrganization } =
  require(path.join(__dirname, "..", "..", "src", "comms", "communication_lines.js"));

const MODE = process.argv.includes("--post") ? "post"
           : process.argv.includes("--pre") ? "pre" : null;
const FROM = process.env.TEST_FROM;
const WO_REF = 1006;

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };
const sec = (t) => console.log(`\n${"═".repeat(64)}\n  ${t}\n${"═".repeat(64)}`);
const last4 = (n) => n ? "****" + String(n).replace(/\D/g, "").slice(-4) : "(unset)";
//  Digit-normalisation IDENTICAL to the resolver's SQL — used only for
//  the cross-population conflict check below, where the resolver does
//  not look.
const digits = (n) => String(n || "").replace(/\D/g, "");

(async function main() {
  if (!MODE) { console.error("usage: technician_fixture_proof.js --pre | --post"); process.exit(1); }
  if (!FROM) { console.error("REFUSED: TEST_FROM is not set."); process.exit(1); }
  if (!process.env.DATABASE_URL) { console.error("REFUSED: DATABASE_URL is not set."); process.exit(1); }

  const c = new Client({ connectionString: process.env.DATABASE_URL,
                         ssl: { rejectUnauthorized: false } });
  await c.connect();
  const ro = await beginProvenReadOnly(c, "technician_fixture");
  if (!ro.ok) process.exit(await refuseNotReadOnly(c, ro.reason));

  console.log("RELEASE 0 — GATE 4 TECHNICIAN FIXTURE (" + MODE + ")");
  console.log("  tester phone  " + last4(FROM) + "   (never recorded in full)");
  console.log("  read-only proven before any read");

  // ── WORK ORDER 1006, AND THE DERIVED ORGANIZATION ──────────────────
  sec("WORK ORDER " + WO_REF);
  const wo = (await c.query(
    `select w.id, w.status, w.property_id, w.title, w.source, w.created_at,
            p.organization_id, p.name as property_name
       from work_orders w join properties p on p.id = w.property_id
      where w.work_order_ref = $1`, [WO_REF])).rows;
  if (!ok("W1  exactly one work order carries ref " + WO_REF, wo.length === 1, String(wo.length))) {
    console.log("\n  Cannot continue without the fixture work order.");
    await c.end(); process.exit(1);
  }
  const W = wo[0];
  ok("W2  status is open", W.status === "open", W.status);
  ok("W3  property and organization are derivable", !!W.property_id && !!W.organization_id);
  console.log("  work_order_id   " + W.id);
  console.log("  property_id     " + W.property_id);
  console.log("  organization_id " + W.organization_id + "   ← DERIVED from the work order, not typed");
  //  The controlled marker is REPORTED, not asserted — this tool verifies
  //  state it can prove and shows the operator what identifies the fixture.
  console.log("  title           " + String(W.title || "").slice(0, 60));
  console.log("  source          " + (W.source || "(null)"));
  console.log("  created_at      " + W.created_at.toISOString());

  // ── IDENTITY, THROUGH THE PRODUCTION RESOLVER ──────────────────────
  sec("TESTER IDENTITY — via resolveStaffSenderForOrganization");
  const who = await resolveStaffSenderForOrganization(c, {
    organizationId: W.organization_id, fromNumber: FROM });
  ok("T1  the phone resolves to exactly ONE active staff identity",
     who.outcome === "one",
     who.outcome === "many"
       ? "AMBIGUOUS: " + who.candidates.length + " active users share this phone — stop condition"
       : "outcome: " + who.outcome);
  const tester = who.user || null;
  if (tester) {
    console.log("  tester user_id  " + tester.id);
    console.log("  role            " + (tester.role || "(none)"));
  }

  //  The resolver is ORGANIZATION-SCOPED. A same-phone user in another
  //  organization, or a same-phone resident, would not make it ambiguous
  //  there — but the spec requires that no conflicting person or user owns
  //  this phone AT ALL, because an inbound message carries only the phone.
  const d10 = digits(FROM).slice(-10);
  const userClash = (await c.query(
    `select count(*) n from users u
      where u.is_active = true
        and right(regexp_replace(coalesce(u.phone,''), '\\D', '', 'g'), 10) = $1`, [d10])).rows[0].n;
  ok("T2  exactly one ACTIVE user anywhere owns this phone", Number(userClash) === 1,
     userClash + " active users match — identity would be a guess");
  //  ── T3: REACHABILITY, NOT MERE EXISTENCE ──────────────────────────
  //  The first version of this check asked "does ANY persons row share
  //  this phone", and it failed the real fixture on a dormant
  //  boardroom_demo row that production could never resolve. That is the
  //  wrong model of a collision, and correcting the model is the fix —
  //  not retiring the row so the check turns green. Do not write to
  //  production identity data to satisfy a checker.
  //
  //  A COMPETING OPERATING IDENTITY is one the production inbound
  //  resolvers can actually reach. communications_boundary.js reaches a
  //  person by phone through exactly two tiers, and both are replicated
  //  below verbatim in their essentials:
  //
  //    TIER 1  resident  — an ACTIVE lease naming the person in
  //                        tenant_ids, AND a tenant_invite with
  //                        status='used' for the same property
  //    TIER 2  prospect  — a leasing_leads row whose status is not
  //                        terminal ('leased' | 'lost')
  //
  //  A persons row with neither is a filing-cabinet entry, not an
  //  identity the system will ever resolve an inbound message to.
  //
  //  DELIBERATELY NOT PROPERTY-SCOPED. The production resolvers scope to
  //  the property of the receiving line; this check does not, because a
  //  person reachable at ANY property is a real operating identity on
  //  that property's line. Broader in the reachability dimension is the
  //  safe direction; broader in the mere-existence dimension was not.
  //
  //  Retired rows are excluded regardless — migration 104: "A retired
  //  row cannot receive authority."
  const reachable = (await c.query(
    `select per.id, per.name, 'resident' as via, l.property_id
       from persons per
       join leases l on l.lease_status = 'active' and per.id = any(l.tenant_ids)
       join tenant_invites ti on ti.person_id = per.id
                             and ti.property_id = l.property_id
                             and ti.status = 'used'
      where coalesce(per.record_status, 'active') <> 'retired'
        and right(regexp_replace(coalesce(per.primary_phone_e164, per.phone, ''), '\\D', '', 'g'), 10) = $1
      union
     select per.id, per.name, 'prospect' as via, ll.property_id
       from persons per
       join leasing_leads ll on ll.person_id = per.id
      where ll.status not in ('leased', 'lost')
        and coalesce(per.record_status, 'active') <> 'retired'
        and right(regexp_replace(coalesce(per.primary_phone_e164, per.phone, ''), '\\D', '', 'g'), 10) = $1`,
    [d10])).rows;
  ok("T3  no REACHABLE person identity (resident or open prospect) shares this phone",
     reachable.length === 0,
     reachable.map((r) => r.via + " " + r.id + " at property " + r.property_id).join("  ·  ")
       + "  — an inbound could genuinely resolve to this person");

  //  Dormant same-phone rows are REPORTED, never asserted on. They are a
  //  hygiene item for a governed identity-cleanup slice, not a blocker
  //  for a proof that does not touch them.
  const dormant = (await c.query(
    `select per.id, per.name, per.source, per.created_at from persons per
      where coalesce(per.record_status, 'active') <> 'retired'
        and right(regexp_replace(coalesce(per.primary_phone_e164, per.phone, ''), '\\D', '', 'g'), 10) = $1
        and not exists (select 1 from leases l join tenant_invites ti
                          on ti.person_id = per.id and ti.property_id = l.property_id and ti.status = 'used'
                         where l.lease_status = 'active' and per.id = any(l.tenant_ids))
        and not exists (select 1 from leasing_leads ll
                         where ll.person_id = per.id and ll.status not in ('leased','lost'))
      order by per.created_at`, [d10])).rows;
  if (dormant.length) {
    console.log("  note: " + dormant.length + " DORMANT same-phone person record(s) — unreachable,");
    console.log("        no operating consequence, logged as an identity-hygiene item:");
    for (const d of dormant) {
      console.log("          " + d.id + "  source=" + (d.source || "(none)")
        + "  created=" + d.created_at.toISOString().slice(0, 10));
    }
  }

  // ── ELIGIBILITY — the assignWork rule, verbatim semantics ──────────
  sec("ELIGIBILITY FOR " + WO_REF);
  if (tester) {
    const elig = (await c.query(
      `select 1 from property_team_assignments pta join users u on u.id = pta.user_id
        where pta.user_id = $1 and pta.property_id = $2 and pta.active = true and u.is_active = true`,
      [tester.id, W.property_id])).rows.length;
    ok("E1  tester holds an ACTIVE team assignment at the work order's property",
       elig === 1, "the governed Assign control will refuse this technician");
  } else {
    fail++; console.log("  FAIL  E1  no resolved tester to check eligibility for");
  }

  // ── THE ROUTING OBLIGATION ─────────────────────────────────────────
  sec("ROUTING OBLIGATION");
  const obs = (await c.query(
    `select id, status, assigned_user_id, accepted_by_user_id, ownership_origin
       from obligations
      where related_type = 'work_order' and related_id = $1 and property_id = $2
      order by created_at asc`, [W.id, W.property_id])).rows;
  ok("O1  exactly one routing obligation exists", obs.length === 1, String(obs.length));
  const O = obs[0] || null;
  if (O) {
    console.log("  obligation_id   " + O.id);
    ok("O2  obligation is not complete", O.status !== "complete", O.status);
    ok("O3  not yet accepted", !O.accepted_by_user_id, String(O.accepted_by_user_id));
    if (MODE === "pre") {
      ok("O4  UNASSIGNED — assigned_user_id is null", O.assigned_user_id === null,
         "already assigned to " + O.assigned_user_id);
    } else {
      ok("O4  assigned to the verified tester", !!tester && O.assigned_user_id === tester.id,
         "assigned_user_id " + O.assigned_user_id);
      ok("O5  ownership_origin is operator_assigned", O.ownership_origin === "operator_assigned",
         String(O.ownership_origin));
    }
  }

  // ── POST ONLY: the governed assignment receipt ─────────────────────
  if (MODE === "post" && O && tester) {
    sec("ASSIGNMENT READ-BACK — the governed receipt");
    //  events carries occurred_at, not created_at — the column was
    //  verified against information_schema, not assumed.
    const ev = (await c.query(
      `select id, occurred_at, note from events
        where type = 'work_order_assigned' and property_id = $1
          and note::jsonb ->> 'work_order_id' = $2
          and note::jsonb ->> 'obligation_id' = $3
        order by occurred_at desc limit 1`, [W.property_id, W.id, O.id])).rows;
    if (ok("R1  a work_order_assigned event records this assignment", ev.length === 1,
           "no governed assignment event found — was it assigned by SQL?")) {
      const note = typeof ev[0].note === "string" ? JSON.parse(ev[0].note) : ev[0].note;
      ok("R2  the event names the tester", note.assigned_user_id === tester.id,
         String(note.assigned_user_id));
      ok("R3  the event names the assigning actor", !!note.assigned_by_user_id,
         "assigned_by_user_id is missing");
      console.log("  event_id        " + ev[0].id);
      console.log("  assigned_at     " + ev[0].occurred_at.toISOString());
      console.log("  assigned_by     " + note.assigned_by_user_id);
    }
  }

  // ── COMPLETION FACTS — must be zero, before and after ──────────────
  sec("COMPLETION SAFETY");
  const prog = (await c.query(
    `select kind, count(*) n from work_order_progress
      where work_order_id = $1 and kind in ('completed','completion_claimed')
      group by kind`, [W.id])).rows;
  const completed = Number((prog.find(r => r.kind === "completed") || { n: 0 }).n);
  const claimed = Number((prog.find(r => r.kind === "completion_claimed") || { n: 0 }).n);
  ok("C1  zero completed progress events", completed === 0, String(completed));
  ok("C2  zero completion claims", claimed === 0, String(claimed));
  //  Migration 137 creates work_order_proof_evaluations. At ledger 136 the
  //  table must be ABSENT — its existence would mean a migration ran,
  //  which is a stop condition, not a zero.
  const evalTable = (await c.query(
    `select count(*) n from information_schema.tables
      where table_schema = 'public' and table_name = 'work_order_proof_evaluations'`)).rows[0].n;
  ok("C3  proof-evaluation table absent (migration 137 has not run)",
     Number(evalTable) === 0, "the table EXISTS — a migration ran; stop");
  const att = (await c.query(
    `select storage_state, count(*) n from work_order_proof_attachments
      where work_order_id = $1 group by storage_state`, [W.id])).rows;
  console.log("  attachments     " + (att.length ? att.map(r => r.storage_state + ":" + r.n).join("  ") : "none"));

  sec("VERDICT");
  console.log(`  passed ${pass}   failed ${fail}`);
  if (fail === 0 && MODE === "pre") {
    console.log("\n  FIXTURE VERIFIED. Assign " + WO_REF + " to the tester through the");
    console.log("  Work Orders door — the governed Assign control. NEVER by SQL.");
    console.log("  Then run this tool again with --post.");
  }
  if (fail === 0 && MODE === "post") {
    console.log("\n  GATE 4 READ-BACK COMPLETE. The assignment is governed and recorded.");
  }
  await c.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(1); });
