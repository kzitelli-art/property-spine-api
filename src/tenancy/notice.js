// ════════════════════════════════════════════════════════════════════
//  RESIDENT NOTICE MODULE — notice.js   (Availability Slice A)
//
//  The operating truth this captures: a resident has given notice to vacate.
//  That fact makes the unit FUTURE SUPPLY — Leasing can market and lease it for
//  a future move-in date — WITHOUT changing the contracted rent-roll truth. The
//  resident is still occupying under an active lease until move-out; notice does
//  NOT make the unit vacant, rentable, or in turnover. (Move-out/possession is
//  the transition into turnover — turnovers.js — not this.)
//
//  WHY THIS IS THE KEYSTONE: until notice exists as a durable fact, Availability
//  can only see the present. Notice is the one primitive that lets Availability
//  look FORWARD. Everything else (the Availability read, commitment tiers, the
//  turn-priority order) reads this.
//
//  AUTHORITY (the load-bearing rule): the browser may say "record notice on this
//  unit, vacating on this date." It may NOT nominate WHICH lease/tenancy is the
//  authority. This route RESOLVES the current active lease from server state
//  (via the unit's space) and writes an immutable snapshot of that tenancy onto
//  the event. A request that names a lease id is ignored; the server decides.
//
//  WHAT IT WRITES: a unit_events row (the established event/history spine, same
//  as move_in_scheduled), event_type='notice_given', status='scheduled':
//    effective_date = the scheduled MOVE-OUT date (resident's intended vacate)
//    payload        = an immutable tenancy snapshot resolved on the server:
//                     { lease_id, space_id, lease_end_date, tenant_name,
//                       notice_date, given_by }
//  It touches NOTHING else — not units.occupancy_status, not leases.lease_status.
//  It CANNOT alter contractual occupancy, because it does not write those tables.
//  NO obligation spawns at notice (mirrors move_in_scheduled: a far-future
//  vacate should not clutter the obligation queue; turnover work begins at
//  move-out, owned elsewhere).
//
//  REVERSAL / SUPERSESSION (durable event-state, never a UI toggle):
//    cancel  (rescind/renew) → status='cancelled'  — the unit stops being future
//                              supply. A future lease-RENEWAL should EMIT this;
//                              it must not create a second availability rule.
//    supersede (extend/change date) → the prior event → status='superseded',
//                              a new notice_given carries the new date.
//  Availability reads ONLY status='scheduled' notice events, so cancel/supersede
//  instantly and honestly updates future supply.
//
//  Mount in server.js (two lines):
//    const noticeModule = require("./notice");
//    app.use("/", noticeModule({ pool }));
// ════════════════════════════════════════════════════════════════════

module.exports = function notice(deps) {
  const express = require("express");
  const router = express.Router();

  const { pool } = deps;
  if (!pool) throw new Error("notice module requires a pool");

  // Resolve the CURRENT active tenancy for a unit from server state. A unit
  // leases through its space(s); the active lease is the authority for notice.
  // Returns { lease } or null. 'commercial' is included because the rent-roll
  // read treats active|commercial as the current lease (management_read.js).
  // If a unit has multiple spaces (by-bed), notice must name the space — see
  // the route: we refuse an ambiguous unit rather than guess a tenancy.
  async function resolveActiveTenancy(client, unit_id, space_id_hint) {
    // find the unit's spaces
    const spaces = await client.query(
      "select id from spaces where unit_id=$1 order by created_at asc", [unit_id]);
    if (spaces.rows.length === 0) return { error: "no_space" };

    let spaceId = null;
    if (space_id_hint) {
      // a space hint is allowed ONLY to disambiguate a by-bed unit; it must be
      // one of THIS unit's spaces (server-verified), never an arbitrary id.
      const ok = spaces.rows.some(s => s.id === space_id_hint);
      if (!ok) return { error: "space_not_in_unit" };
      spaceId = space_id_hint;
    } else if (spaces.rows.length === 1) {
      spaceId = spaces.rows[0].id;
    } else {
      return { error: "ambiguous_space", spaces: spaces.rows.map(s => s.id) };
    }

    // the active lease on that space (the server-resolved authority)
    const lease = await client.query(
      `select l.id, l.space_id, l.end_date, l.tenant_ids, l.lease_status
         from leases l
        where l.space_id = $1 and l.lease_status in ('active','commercial')
        order by l.start_date desc nulls last
        limit 1`,
      [spaceId]);
    if (lease.rows.length === 0) return { error: "no_active_lease", space_id: spaceId };

    // resolve a tenant display name (best-effort; a snapshot, not authority)
    let tenantName = null;
    const l = lease.rows[0];
    if (Array.isArray(l.tenant_ids) && l.tenant_ids.length) {
      const p = await client.query(
        "select name from persons where id = any($1) limit 1", [l.tenant_ids]);
      if (p.rows.length) tenantName = p.rows[0].name;
    }
    return { lease: l, tenant_name: tenantName, space_id: spaceId };
  }

  // ════════════════════════════════════════════════════════════════
  //  GIVE NOTICE  —  POST /units/:id/notice
  //  Body: { move_out_date (required, YYYY-MM-DD), given_by?, space_id? }
  //  space_id is ONLY used to disambiguate a by-bed unit; it is verified to
  //  belong to the unit. The tenancy is resolved on the SERVER; the body never
  //  nominates a lease id as authority.
  // ════════════════════════════════════════════════════════════════
  router.post("/units/:id/notice", async (req, res) => {
    const unit_id = req.params.id;
    const { move_out_date, given_by = null, space_id = null } = req.body || {};
    if (!move_out_date) {
      return res.status(400).json({ error: "move_out_date is required (YYYY-MM-DD) — the resident's scheduled vacate date" });
    }
    // basic sanity: a vacate date in the past is not future supply.
    const parsed = new Date(move_out_date);
    if (isNaN(parsed.getTime())) {
      return res.status(400).json({ error: "move_out_date is not a valid date (expected YYYY-MM-DD)" });
    }

    const client = await pool.connect();
    try {
      await client.query("begin");

      const uQ = await client.query("select id, property_id, unit_number from units where id=$1", [unit_id]);
      if (uQ.rows.length === 0) { await client.query("rollback"); return res.status(404).json({ error: "unit not found" }); }
      const unit = uQ.rows[0];

      // guard: don't stack two open notices on the same unit
      const dup = await client.query(
        `select id from unit_events where unit_id=$1 and event_type='notice_given' and status='scheduled' limit 1`,
        [unit_id]);
      if (dup.rows.length) {
        await client.query("rollback");
        return res.status(409).json({
          error: "this unit already has an open notice",
          unit_event_id: dup.rows[0].id,
          hint: "cancel or supersede the existing notice instead of stacking a second one",
        });
      }

      // RESOLVE THE TENANCY FROM SERVER STATE (the authority)
      const t = await resolveActiveTenancy(client, unit_id, space_id);
      if (t.error === "no_space") {
        await client.query("rollback");
        return res.status(409).json({ error: "unit has no space record — cannot resolve a tenancy to give notice on" });
      }
      if (t.error === "space_not_in_unit") {
        await client.query("rollback");
        return res.status(400).json({ error: "the provided space_id does not belong to this unit" });
      }
      if (t.error === "ambiguous_space") {
        await client.query("rollback");
        return res.status(409).json({
          error: "this unit has multiple spaces (leases by the bed) — notice must name which space",
          spaces: t.spaces,
          hint: "resend with space_id set to the specific bed's space",
        });
      }
      if (t.error === "no_active_lease") {
        await client.query("rollback");
        return res.status(409).json({
          error: "no active lease on this unit — there is no tenancy to give notice on",
          hint: "a vacant or not-yet-leased unit does not receive notice; it is already (future) supply via turnover/availability",
        });
      }

      // the immutable tenancy SNAPSHOT — what was true at the moment of notice.
      // The authority is the server-resolved lease; these fields are recorded so
      // the notice is permanently tied to that specific tenancy, not a claim.
      const payload = {
        lease_id: t.lease.id,
        space_id: t.space_id,
        lease_end_date: t.lease.end_date,
        tenant_name: t.tenant_name,
        notice_date: new Date().toISOString().slice(0, 10),
        given_by: given_by || null,
      };

      //  space_id is a COLUMN, not only a payload key. The canonical space
      //  reader (space_position.js) finds a notice by `ue.space_id`; written
      //  only into the payload, a notice succeeded here and was invisible
      //  everywhere. The resolver above already settled which space.
      const ins = await client.query(
        `insert into unit_events (unit_id, property_id, space_id, event_type, effective_date, payload, source, status)
         values ($1,$2,$3,'notice_given',$4,$5,'manual','scheduled') returning *`,
        [unit_id, unit.property_id, t.space_id, move_out_date, JSON.stringify(payload)]);

      await client.query("commit");
      res.status(201).json({
        unit_event: ins.rows[0],
        resolved_tenancy: { lease_id: t.lease.id, space_id: t.space_id, tenant_name: t.tenant_name, lease_end_date: t.lease.end_date },
        note: "Notice recorded. The unit is now FUTURE SUPPLY for Availability (leaseable for a future move-in) — but still occupied on the rent roll until move-out. No obligation spawned; turnover begins at move-out. The tenancy was resolved on the server; the request could not nominate a lease.",
      });
    } catch (e) {
      await client.query("rollback");
      console.error("notice give error", e);
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  // ════════════════════════════════════════════════════════════════
  //  CANCEL NOTICE  —  POST /unit-events/:id/cancel-notice
  //  Body: { reason? , cancelled_by? }
  //  Rescind or renewal: the resident is staying. The unit stops being future
  //  supply. Durable event-state transition (status='cancelled') with attributed
  //  reason — NOT a UI toggle. A future lease-renewal flow should call THIS.
  // ════════════════════════════════════════════════════════════════
  router.post("/unit-events/:id/cancel-notice", async (req, res) => {
    const event_id = req.params.id;
    const { reason = null, cancelled_by = null } = req.body || {};

    const client = await pool.connect();
    try {
      await client.query("begin");

      const eQ = await client.query(
        "select * from unit_events where id=$1 and event_type='notice_given' for update", [event_id]);
      if (eQ.rows.length === 0) { await client.query("rollback"); return res.status(404).json({ error: "no notice event with that id" }); }
      const ev = eQ.rows[0];
      if (ev.status !== "scheduled") {
        await client.query("rollback");
        return res.status(409).json({ error: `this notice is already ${ev.status} — only an open (scheduled) notice can be cancelled` });
      }

      // preserve history: keep the original payload, append the cancellation fact.
      const newPayload = Object.assign({}, ev.payload || {}, {
        cancel_reason: reason || null,
        cancelled_by: cancelled_by || null,
        cancelled_at: new Date().toISOString(),
      });

      const upd = await client.query(
        `update unit_events set status='cancelled', payload=$2, updated_at=now()
          where id=$1 returning *`,
        [event_id, JSON.stringify(newPayload)]);

      await client.query("commit");
      res.json({
        unit_event: upd.rows[0],
        note: "Notice cancelled. The unit is no longer future supply — Availability stops treating it as leaseable-forward. The original notice is retained (status=cancelled) with the cancellation attributed; nothing was deleted.",
      });
    } catch (e) {
      await client.query("rollback");
      console.error("notice cancel error", e);
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  // ════════════════════════════════════════════════════════════════
  //  SUPERSEDE NOTICE  —  POST /units/:id/notice/supersede
  //  Body: { move_out_date (required), given_by?, space_id? }
  //  Extend or change the vacate date. Marks the prior open notice
  //  status='superseded' (with a pointer to the new one) and writes a new
  //  notice_given with the new date — in ONE transaction. History preserved;
  //  the durable chain is auditable. Not a mutate-in-place.
  // ════════════════════════════════════════════════════════════════
  router.post("/units/:id/notice/supersede", async (req, res) => {
    const unit_id = req.params.id;
    const { move_out_date, given_by = null, space_id = null } = req.body || {};
    if (!move_out_date) return res.status(400).json({ error: "move_out_date is required (the new scheduled vacate date)" });
    if (isNaN(new Date(move_out_date).getTime())) return res.status(400).json({ error: "move_out_date is not a valid date" });

    const client = await pool.connect();
    try {
      await client.query("begin");

      const uQ = await client.query("select id, property_id from units where id=$1", [unit_id]);
      if (uQ.rows.length === 0) { await client.query("rollback"); return res.status(404).json({ error: "unit not found" }); }
      const unit = uQ.rows[0];

      // the current open notice (there is at most one, by the give-notice guard)
      const priorQ = await client.query(
        `select * from unit_events where unit_id=$1 and event_type='notice_given' and status='scheduled' for update`,
        [unit_id]);
      if (priorQ.rows.length === 0) {
        await client.query("rollback");
        return res.status(409).json({
          error: "no open notice on this unit to supersede",
          hint: "use POST /units/:id/notice to give a first notice",
        });
      }
      const prior = priorQ.rows[0];

      // re-resolve the tenancy from server state (authority), same as give-notice.
      const t = await resolveActiveTenancy(client, unit_id, space_id || (prior.payload && prior.payload.space_id) || null);
      if (t.error) {
        await client.query("rollback");
        return res.status(409).json({ error: "could not resolve the active tenancy to supersede notice", detail: t.error });
      }

      const newPayload = {
        lease_id: t.lease.id,
        space_id: t.space_id,
        lease_end_date: t.lease.end_date,
        tenant_name: t.tenant_name,
        notice_date: new Date().toISOString().slice(0, 10),
        given_by: given_by || null,
        supersedes_event_id: prior.id,
      };

      const ins = await client.query(
        `insert into unit_events (unit_id, property_id, event_type, effective_date, payload, source, status)
         values ($1,$2,'notice_given',$3,$4,'manual','scheduled') returning *`,
        [unit_id, unit.property_id, move_out_date, JSON.stringify(newPayload)]);

      // mark the prior notice superseded, pointing forward to the new one.
      const priorPayload = Object.assign({}, prior.payload || {}, { superseded_by_event_id: ins.rows[0].id, superseded_at: new Date().toISOString() });
      await client.query(
        `update unit_events set status='superseded', payload=$2, updated_at=now() where id=$1`,
        [prior.id, JSON.stringify(priorPayload)]);

      await client.query("commit");
      res.status(201).json({
        unit_event: ins.rows[0],
        superseded_event_id: prior.id,
        note: "Notice superseded. The new vacate date is live for Availability; the prior notice is retained (status=superseded) with a pointer to the replacement. Durable chain, no mutate-in-place.",
      });
    } catch (e) {
      await client.query("rollback");
      console.error("notice supersede error", e);
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  // ════════════════════════════════════════════════════════════════
  //  BOARD  —  GET /notices   (?property_id=  ?status=)
  //  Open (and optionally all) notices with their resolved tenancy snapshot.
  //  This is a plain read; the Availability projection (Slice C) is the one
  //  that turns these into forward supply. Defaults to status='scheduled'.
  // ════════════════════════════════════════════════════════════════
  router.get("/notices", async (req, res) => {
    const { property_id, status = "scheduled" } = req.query;
    try {
      const vals = [];
      const where = ["ue.event_type='notice_given'"];
      if (property_id) { vals.push(property_id); where.push(`ue.property_id = $${vals.length}`); }
      if (status && status !== "all") { vals.push(status); where.push(`ue.status = $${vals.length}`); }

      const r = await pool.query(
        `select ue.*, u.unit_number
           from unit_events ue
           join units u on u.id = ue.unit_id
          where ${where.join(" and ")}
          order by ue.effective_date asc`,
        vals);

      const notices = r.rows.map(ue => ({
        unit_event_id: ue.id,
        unit_id: ue.unit_id,
        unit_number: ue.unit_number,
        property_id: ue.property_id,
        move_out_date: ue.effective_date,
        status: ue.status,
        lease_id: ue.payload ? ue.payload.lease_id : null,
        space_id: ue.payload ? ue.payload.space_id : null,
        tenant_name: ue.payload ? ue.payload.tenant_name : null,
        lease_end_date: ue.payload ? ue.payload.lease_end_date : null,
        notice_date: ue.payload ? ue.payload.notice_date : null,
      }));

      res.json({
        count: notices.length,
        status_filter: status,
        note: "These are notice facts. A unit on open notice is FUTURE SUPPLY but still occupied on the rent roll until move-out. The Availability read turns these into leaseable-forward units.",
        notices,
      });
    } catch (e) {
      console.error("notices board error", e);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
