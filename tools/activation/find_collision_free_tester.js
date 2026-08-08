#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   RELEASE 0 — FIND A COLLISION-FREE TESTER

   The intended tester's mobile is simultaneously a staff identity on the
   operations rail and a REACHABLE prospect identity on the property-facing
   rail (an open leasing lead at the same property — H-1). Gate 4 blocks on
   that, correctly.

   The clean way past it is to route around it, not to clean production
   data so a test can finish. This searches, READ-ONLY, for an existing
   active staff member who can carry the Release 0 proof without anyone
   touching leasing or identity truth.

   ── THE PREDICATES ARE PRODUCTION'S, NOT THIS FILE'S ────────────────
   Candidates come from operator_actions.eligibleTechnicians — literally
   the function that populates the Assign picker — so a candidate offered
   here is a candidate the governed UI will offer and the write will
   accept. Identity is resolved through resolveStaffSenderForOrganization,
   the function the inbound route runs.

   Reachability uses the two tiers communications_boundary.js uses, and
   NOT a foreign-key inventory. An information_schema FK walk is what
   reported the demo person "inert" while an open lead sat on it; a
   catalog describes the world, it is not the world (H-2).

   ── WHAT DISQUALIFIES A CANDIDATE ───────────────────────────────────
     no phone on the staff record        an inbound cannot be attributed
     phone shared with another user      identity would be a guess
     reachable resident on that phone    two operating identities
     reachable open prospect on phone    two operating identities

   A dormant same-phone person record does NOT disqualify: it is
   unreachable by production, and it is reported rather than counted.

   Read-only, proven before any read. Phones appear only as ****last4.

   usage:  node tools/activation/find_collision_free_tester.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const path = require("path");
const { Client } = require("pg");
const { beginProvenReadOnly, refuseNotReadOnly } = require("./_readonly.js");
const operatorActions = require(path.join(__dirname, "..", "..", "src", "technician", "operator_actions.js"));
const { resolveStaffSenderForOrganization } =
  require(path.join(__dirname, "..", "..", "src", "comms", "communication_lines.js"));

const WO_REF = 1006;
const last4 = (n) => n ? "****" + String(n).replace(/\D/g, "").slice(-4) : "(none)";
const sec = (t) => console.log(`\n${"═".repeat(64)}\n  ${t}\n${"═".repeat(64)}`);

(async function main() {
  if (!process.env.DATABASE_URL) { console.error("REFUSED: DATABASE_URL is not set."); process.exit(1); }
  const c = new Client({ connectionString: process.env.DATABASE_URL,
                         ssl: { rejectUnauthorized: false } });
  await c.connect();
  const ro = await beginProvenReadOnly(c, "find_tester");
  if (!ro.ok) process.exit(await refuseNotReadOnly(c, ro.reason));

  console.log("RELEASE 0 — COLLISION-FREE TESTER SEARCH  (read-only)");
  console.log("  read-only proven before any read");

  const wo = (await c.query(
    `select w.id, w.status, w.property_id, p.organization_id
       from work_orders w join properties p on p.id = w.property_id
      where w.work_order_ref = $1`, [WO_REF])).rows;
  if (wo.length !== 1) {
    console.error("\nREFUSED: " + wo.length + " work orders carry ref " + WO_REF);
    await c.end(); process.exit(1);
  }
  const W = wo[0];
  console.log("  work order      " + W.id + "  (" + W.status + ")");
  console.log("  property        " + W.property_id);
  console.log("  organization    " + W.organization_id + "   ← derived, not typed");

  //  THE PICKER'S OWN LIST. If a name is not here, the governed Assign
  //  control will not offer it and assignWork would refuse it anyway.
  const candidates = await operatorActions.eligibleTechnicians(c, { propertyId: W.property_id });
  sec("ELIGIBLE TECHNICIANS — from the production Assign picker");
  console.log("  " + candidates.length + " candidate(s) the governed UI would offer\n");

  const ob = (await c.query(
    `select id, assigned_user_id from obligations
      where related_type='work_order' and related_id=$1 and property_id=$2
      order by created_at asc limit 1`, [W.id, W.property_id])).rows[0] || null;

  const clear = [], rejected = [];
  for (const cand of candidates) {
    const u = (await c.query(
      `select id, name, phone, is_active from users where id = $1`, [cand.id])).rows[0];
    const digits = String(u.phone || "").replace(/\D/g, "");
    const d10 = digits.slice(-10);
    const reasons = [];

    if (!d10 || d10.length < 10) {
      reasons.push("no usable phone on the staff record — an inbound could not be attributed");
    } else {
      //  Identity through the PRODUCTION resolver, exactly as the inbound
      //  route resolves it.
      const who = await resolveStaffSenderForOrganization(c, {
        organizationId: W.organization_id, fromNumber: u.phone });
      if (who.outcome !== "one") reasons.push("staff resolution is '" + who.outcome + "', not a unique identity");
      else if (who.user.id !== u.id) reasons.push("the phone resolves to a DIFFERENT staff user");

      //  TIER 1 + TIER 2, the resolver's own joins.
      const reach = (await c.query(
        `select 'resident' as via, l.property_id
           from persons per
           join leases l on l.lease_status='active' and per.id = any(l.tenant_ids)
           join tenant_invites ti on ti.person_id=per.id and ti.property_id=l.property_id and ti.status='used'
          where coalesce(per.record_status,'active') <> 'retired'
            and right(regexp_replace(coalesce(per.primary_phone_e164, per.phone, ''),'\\D','','g'),10) = $1
          union
         select 'prospect' as via, ll.property_id
           from persons per
           join leasing_leads ll on ll.person_id = per.id
          where ll.status not in ('leased','lost')
            and coalesce(per.record_status,'active') <> 'retired'
            and right(regexp_replace(coalesce(per.primary_phone_e164, per.phone, ''),'\\D','','g'),10) = $1`,
        [d10])).rows;
      for (const r of reach) reasons.push("reachable " + r.via + " identity at property " + r.property_id);

      //  Dormant rows are REPORTED, never disqualifying.
      const dormant = Number((await c.query(
        `select count(*) n from persons per
          where coalesce(per.record_status,'active') <> 'retired'
            and right(regexp_replace(coalesce(per.primary_phone_e164, per.phone, ''),'\\D','','g'),10) = $1
            and not exists (select 1 from leases l join tenant_invites ti
                              on ti.person_id=per.id and ti.property_id=l.property_id and ti.status='used'
                             where l.lease_status='active' and per.id = any(l.tenant_ids))
            and not exists (select 1 from leasing_leads ll
                             where ll.person_id=per.id and ll.status not in ('leased','lost'))`,
        [d10])).rows[0].n);

      const already = ob && ob.assigned_user_id === u.id;
      const entry = { id: u.id, name: u.name, last4: last4(u.phone), dormant, already };
      if (reasons.length === 0) clear.push(entry); else rejected.push({ ...entry, reasons });
      continue;
    }
    rejected.push({ id: u.id, name: u.name, last4: last4(u.phone), reasons });
  }

  sec("REJECTED");
  if (!rejected.length) console.log("  none");
  for (const r of rejected) {
    console.log("  ✗ " + r.name + "  (" + r.last4 + ")  " + r.id);
    for (const why of r.reasons) console.log("      · " + why);
  }

  sec("COLLISION-FREE CANDIDATES");
  if (!clear.length) console.log("  none");
  for (const r of clear) {
    console.log("  ✓ " + r.name + "  (" + r.last4 + ")  " + r.id
      + (r.already ? "   ← ALREADY ASSIGNED to 1006" : ""));
    if (r.dormant) console.log("      note: " + r.dormant
      + " dormant same-phone person record(s) — unreachable, hygiene only, not disqualifying");
  }

  //  ── THE ATTRIBUTION CONSTRAINT ────────────────────────────────────
  //  assignWork returns { outcome: "unchanged" } and writes NO event when
  //  the obligation is already assigned to the requested technician. So a
  //  fresh, correctly-attributed assignment event requires assigning to a
  //  DIFFERENT user than the current holder — re-picking the same person
  //  repairs nothing.
  sec("VERDICT");
  const usable = clear.filter((r) => !r.already);
  if (!usable.length) {
    if (clear.length && clear.every((r) => r.already)) {
      console.log("  The only collision-free candidate is ALREADY the assignee.");
      console.log("  assignWork short-circuits on an unchanged assignee and writes no");
      console.log("  event, so this cannot produce a freshly attributed receipt.\n");
    }
    console.log("  RELEASE 0 TESTER IDENTITY BLOCKED");
    console.log("\n  No eligible staff member can carry the proof without first");
    console.log("  changing leasing or identity truth. That decision is the owner's,");
    console.log("  and it is a governed slice, not a step in this one.");
    await c.end();
    process.exit(1);
  }

  console.log("  CANDIDATE FOUND — Release 0 can proceed without mutating");
  console.log("  unrelated leasing or identity data.\n");
  for (const r of usable) console.log("    " + r.name + "   user_id " + r.id + "   " + r.last4);
  console.log("\n  Assigning 1006 to this person is a CHANGE of assignee, so it takes");
  console.log("  the governed write path and emits a work_order_assigned event that");
  console.log("  names the assigning actor. One action closes both the tester");
  console.log("  collision and the missing attribution.");
  console.log("\n  The old anonymous event is left exactly as it is: the action");
  console.log("  happened and its actor was not captured. That is history, not a bug");
  console.log("  to backfill.");
  await c.end();
  process.exit(0);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(1); });
