// ════════════════════════════════════════════════════════════════════
//  link_resident.js — THE DOOR THAT LINKS A NAMED RESIDENT TO A PERSON
//
//  Row 156 closed the routing inversion: a rent-roll row with no phone and
//  no email establishes the lease with NO tenant and stages the person
//  claim, and the rent roll shows the source's name as an unlinked claim.
//  That was the right refusal and it left one thing missing — nothing let
//  an operator link that resident once they HAD a handle. This is that one
//  door, and nothing more.
//
//  IT CREATES NO PERSON ITSELF. Every outcome goes through
//  person_ingress.ingestPerson, the only `insert into persons` in Property
//  Spine (gate_person_ingress.js enforces this). What this module adds is
//  the operator authority, the lease-side writes, and the promotion of the
//  claim the import staged.
//
//  ── WHY activation_id IS DELIBERATELY NOT PASSED TO ingestPerson ─────
//  With `channel:'rent_roll'` AND an activation_id AND an
//  import_source_row_id, ingestPerson first looks for a confirmed person
//  proposal for that row — and a reviewer who earlier judged the row
//  `distinct_unlinked` would short-circuit this link to `person_id: null`
//  forever. That decision was made under a specific condition: a different
//  person from every candidate, and NOTHING to recognise them by. An
//  operator arriving here has supplied the very thing that was missing.
//  Honouring the old decision would make the handle unusable, which is the
//  opposite of what row 156 left open.
//
//  Omitting activation_id resolves from the handle instead, and has a
//  second property worth naming: writeProposal returns immediately without
//  an activation_id, so a conflicted outcome writes no stray claim row —
//  "409 and write nothing" is then structural rather than a rollback we
//  have to remember.
//
//  person_ingress's staging rule is untouched. This module never calls
//  confirmPersonProposal and never writes `persons`.
//
//  CLASSIFICATION: Class 1 (permanent). The route, its gate and the
//  promotion are the canonical operator path for linking a resident.
// ════════════════════════════════════════════════════════════════════

"use strict";

module.exports = function linkResidentRoutes(deps) {
  const express = require("express");
  const router = express.Router();
  const staffSessions = require("../identity/staff_session_service");
  const personIngress = require("../identity/person_ingress");

  const { pool } = deps || {};
  if (!pool) throw new Error("link_resident requires a pool");

  async function requireOperator(req, res, next) {
    try {
      const op = await staffSessions.resolveStaffSession(pool, req.headers["x-staff-session"]);
      if (!op) return res.status(401).json({ receipt: "No valid operator session. Sign in." });
      req.operator = op; next();
    } catch (e) { return res.status(500).json({ receipt: "Session resolution failed." }); }
  }

  //  §21. The browser may request; it may not supply authority. A body that
  //  names a property is REFUSED rather than ignored, so a caller can never
  //  believe it chose the scope.
  function refuseClientAuthority(req, res, next) {
    const b = req.body || {};
    if (b.property_id || b.person_id || (req.query && req.query.property_id)) {
      return res.status(403).json({
        receipt: "Property and person are decided by Spine from your session and the handle you gave. "
          + "Remove property_id / person_id and send only the phone or email.",
        acting_on: req.operator.property_id,
      });
    }
    return next();
  }

  //  Linking a resident to a lease is a MANAGEMENT act: it resolves who is
  //  in a home. Leasing fills the funnel; management resolves the tenancy.
  function requireManagement(req, res, next) {
    const mods = req.operator.allowed_modules || [];
    if (!mods.includes("management")) {
      return res.status(403).json({
        receipt: "Linking a resident needs Management access for this property. "
          + "Ask a property admin to add the Management module to your role.",
      });
    }
    return next();
  }

  const gate = [requireOperator, refuseClientAuthority, requireManagement];

  router.post("/operator/leases/:leaseId/link-resident", ...gate, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const b = req.body || {};
    const basis = typeof b.source_basis === "string" ? b.source_basis.trim() : "";
    if (!basis) {
      return res.status(400).json({
        receipt: "Say where this phone or email came from — a call, an email, the signed lease. "
          + "Spine records how a resident was identified, not only that they were.",
      });
    }

    //  ONE definition of "a handle", the same one person_ingress uses. A name
    //  is not a handle and a PMS resident id is provenance, never a key.
    const evidenceIn = { phone: b.phone, email: b.email };
    const handle = personIngress.continuityHandle(evidenceIn);
    if (!handle) {
      return res.status(400).json({
        receipt: "A phone number or an email address is required to link a resident. "
          + "A name alone is not something Spine can recognise this person by later.",
      });
    }

    const client = await pool.connect();
    try {
      await client.query("begin");

      //  Scope from the SESSION. Out of scope is 404, not 403 — the same
      //  posture as every operator read in this system: a FORBIDDEN would
      //  confirm the lease exists on a property this operator cannot see.
      //  A lease names a SPACE, not a unit (a space is a bed where the
      //  property is bed-based). The unit is reached through it, and only so
      //  the event lands on the unit timeline an operator actually reads.
      //  `for update of l` — the join is for context and must not be locked.
      const lease = (await client.query(
        `select l.id, l.property_id, l.tenant_ids, sp.unit_id
           from leases l
           left join spaces sp on sp.id = l.space_id
          where l.id = $1 and l.property_id = $2
          for update of l`,
        [req.params.leaseId, req.operator.property_id])).rows[0];
      if (!lease) {
        await client.query("rollback");
        return res.status(404).json({ receipt: "No such lease on this property." });
      }

      if (Array.isArray(lease.tenant_ids) && lease.tenant_ids.length > 0) {
        await client.query("rollback");
        return res.status(409).json({
          receipt: "This lease already has a resident linked. To change who is on it, "
            + "correct the tenancy rather than linking a second person here.",
        });
      }

      //  The staged claim, reached through the LEASE claim that produced this
      //  lease — that is the only link between a lease and the import row it
      //  came from. Both may be absent for a lease established another way;
      //  linking still works, there is simply no claim to promote.
      const leaseClaim = (await client.query(
        `select activation_id, import_source_row_id, normalized_json->>'tenant_name' as claimed_name
           from proposed_records
          where promoted_record_id = $1 and target_type = 'lease'
          order by confirmed_at desc nulls last limit 1`, [lease.id])).rows[0] || {};

      const personClaim = leaseClaim.import_source_row_id ? (await client.query(
        `select id from proposed_records
          where activation_id = $1 and import_source_row_id = $2
            and target_type = 'person' and status = 'staged'
          order by created_at desc limit 1`,
        [leaseClaim.activation_id, leaseClaim.import_source_row_id])).rows[0] || null : null;

      //  THE ONE WRITER. authority = this staff session, named. See the
      //  header for why activation_id is not passed.
      //
      //  A lease in force is presence, not a lead: this door only ever
      //  fires against an already-signed lease, so a person it CREATES is
      //  created a resident, never the ingress default 'lead'. See (b)
      //  below for the resolved_existing side of the same fact.
      const out = await personIngress.ingestPerson(client, {
        property_id: req.operator.property_id,
        channel: "rent_roll",
        authority: {
          actor: String(req.operator.id),
          basis: `operator link-resident: ${basis}`,
        },
        evidence: {
          phone: b.phone || null,
          email: b.email || null,
          name: leaseClaim.claimed_name || null,
          source_system: "rent_roll",
          import_source_row_id: leaseClaim.import_source_row_id || null,
          lifecycle_status: "resident",
          leasing_stage: "resident",
        },
      });

      //  A disagreement is not a link. Nothing is written and the candidates
      //  travel, so a human resolves it with what Spine actually saw.
      if (out.disposition === "conflicted" || out.disposition === "needs_review") {
        await client.query("rollback");
        return res.status(409).json({
          outcome: out.disposition,
          receipt: out.disposition === "conflicted"
            ? "That phone or email matches more than one person already in Spine, so the resident "
              + "was not linked. Pick which record this is, or use a handle that belongs only to them."
            : "That phone or email may belong to someone Spine already knows. It was not linked. "
              + "Review the match before linking this resident.",
          candidates: (out.candidates || []).map((c) => ({ person_id: c.person_id || c.id, name: c.name })),
          reason: out.reason || null,
        });
      }

      if (!out.person_id) {
        //  Defensive: with a handle and an authority the seam should have
        //  created or resolved. Refuse rather than report a link that is not
        //  one — an unexpected disposition is not a success.
        await client.query("rollback");
        return res.status(409).json({
          outcome: out.disposition || "not_linked",
          receipt: "Spine could not establish this resident from that phone or email. "
            + "Nothing was changed. Check the handle, or ask for help with this lease.",
          reason: out.reason || null,
        });
      }

      // ── the lease now names a person ──
      await client.query(
        `update leases set tenant_ids = array[$1::uuid], updated_at = now() where id = $2`,
        [out.person_id, lease.id]);

      //  (b) A LEASE IN FORCE IS PRESENCE. `ingestPerson` on `resolved_existing`
      //  recognises the person but never updates them (person_ingress.js is
      //  untouched — see the header). If the person Spine already knew is
      //  still sitting at the ingress default `lead` (or has no lifecycle at
      //  all), attaching them to a real lease is exactly the fact that
      //  advances them — the counterparty guard in authority_resolution.js
      //  (HARD_COUNTERPARTY) must fire for them from this moment on. Any
      //  OTHER status — tenant, resident, past_resident, applicant, vendor —
      //  is left alone: this door recognises presence, it never downgrades a
      //  status a more specific fact already established.
      let lifecycleAdvanced = false;
      if (out.resolution_kind === "resolved_existing") {
        const advanced = (await client.query(
          `update persons set lifecycle_status = 'resident', leasing_stage = 'resident'
             where id = $1 and (lifecycle_status = 'lead' or lifecycle_status is null)
             returning id`,
          [out.person_id])).rows[0];
        lifecycleAdvanced = !!advanced;
      }

      //  resolution_kind and promoted_record_id in ONE statement (migration
      //  177): a promotion may never exist without the institutional fact of
      //  HOW it resolved.
      if (personClaim) {
        await client.query(
          `update proposed_records
              set status = 'promoted', promoted_record_id = $1, resolution_kind = $2,
                  confirmed_by = $3, confirmed_at = now(),
                  status_reason = $4
            where id = $5`,
          [out.person_id, out.resolution_kind, String(req.operator.id),
           `Resident linked by an operator from a ${handle.kind}: ${basis}`, personClaim.id]);
      }

      if (leaseClaim.import_source_row_id) {
        await client.query(
          `update import_source_rows set produced_person_id = $1 where id = $2`,
          [out.person_id, leaseClaim.import_source_row_id]);
      }

      //  One event, naming the handle KIND and the basis — never the handle
      //  value. A ledger of how identity was established should not become a
      //  second place a phone number lives. When the recognised person was
      //  advanced off `lead`, that is said here too — it is the only durable
      //  record of why their lifecycle changed.
      const noteLine = `Resident linked to lease ${lease.id} by ${handle.kind} (${out.resolution_kind}). Basis: ${basis}`
        + (lifecycleAdvanced ? " Lifecycle advanced to resident: a lease in force is presence." : "");
      await client.query(
        `insert into events (property_id, person_id, unit_id, type, note)
         values ($1,$2,$3,'resident_linked',$4)`,
        [lease.property_id, out.person_id, lease.unit_id || null, noteLine]);

      await client.query("commit");
      return res.json({
        outcome: out.resolution_kind,          // created | resolved_existing
        person_id: out.person_id,
        lease_id: lease.id,
        handle_kind: handle.kind,
        claim_promoted: !!personClaim,
        receipt: out.resolution_kind === "created"
          ? `Resident linked. Spine created a person record from the ${handle.kind} you gave and attached it to this lease.`
          : `Resident linked. Spine recognised this ${handle.kind} as someone it already knew and attached that record to this lease.`,
      });
    } catch (e) {
      await client.query("rollback").catch(() => {});
      //  person_ingress refusals are sayable and carry their own status.
      if (e && e.publicMessage) {
        return res.status(e.httpStatus || 409).json({ receipt: e.publicMessage, code: e.code || null });
      }
      console.error("link-resident error", e);
      return res.status(500).json({ receipt: "The resident could not be linked. Nothing was changed." });
    } finally { client.release(); }
  });

  return router;
};
