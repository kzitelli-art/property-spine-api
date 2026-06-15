// activation.js
// ===========================================================================
// SPINE ACTIVATION V1 — LEASING SLICE
//
// "Read the folder. Build the draft spine. Confirm the truth. Activate."
//
// This module is the activation pipeline over the EXISTING claim/obligation
// model. It does NOT invent a new confirmation system and does NOT create
// per-type proposed tables. One rent-roll row = one proposed_record
// (target_type='lease') = one operator confirmation = one structural tie.
//
// THE DOCTRINE IT OBEYS
//   • proposed_records IS the claim layer (no generic claims table exists).
//   • A read-only glance never mutates live state. Staging writes only
//     proposed_records, never units/leases/persons.
//   • A wrong confident value is worse than an honest blank: rows missing a
//     required field are staged as `blocked`/`needs_review`, never confirmed.
//   • The handler refuses to guess. A by-the-bed unit (student housing: one
//     unit, many beds) can't be tied from a bare unit number, so it stops and
//     asks rather than fabricating which bed.
//   • People are never merged by name. Two residents can share a name; the
//     module always writes a fresh person. A duplicate is fixable; a silent
//     merge corrupts the record.
//   • Confirmation = ONE atomic transaction that writes the live tie, marks
//     the proposal promoted, and satisfies the obligation — same write-then-
//     satisfy order every proven module uses.
//   • Leasing Exposure = units with no tied lease. Confirming drops it.
//
// LIVE SCHEMA THIS WRITES (verified against server.js):
//   units   (property_id, unit_number, bedrooms, bathrooms, square_feet, market_rent)
//           -- unique (property_id, unit_number); a DB trigger auto-creates
//              exactly one `spaces` row per unit.
//   persons (name, email, phone, source, lifecycle_status, leasing_stage, interested_unit_id)
//   leases  (property_id, space_id, tenant_ids[], rent, start_date, end_date,
//            security_deposit, application_fee, lease_status)
//           -- leases attach to space_id, NEVER unit_id. tenant_ids is a
//              uuid[] into persons.
//
// CHAIN ON CONFIRM:  unit -> (trigger) space -> lease(space_id) ; person -> tenant_ids
//
// ENDPOINTS
//   POST /activations
//        { property_id, source_label? } -> create an activation envelope
//   POST /activations/:id/stage-rent-roll
//        { rows: [...] }  (already-parsed rent-roll rows)  ->
//        stages one proposed_record per row; classifies each honestly
//   GET  /activations/:id
//        -> envelope + proposed rows + leasing exposure summary
//   GET  /activations/:id/proposed
//        -> the proposed rows (optional ?status=)
//   POST /proposed/:id/confirm
//        { confirmed_by? } -> the atomic fan-out (the structural tie)
//   POST /proposed/:id/reject
//        { reason? } -> mark rejected (no live write)
//   GET  /properties/:id/leasing-exposure
//        -> units total / tied / untied (the number the screen shows)
//
// Wired in server.js with dependency injection (the composition layer):
//   app.use("/", activationModule({ pool, spawnObligationFromEvent,
//                                    satisfyObligation, completeObligation }));
// ===========================================================================

module.exports = function activationModule({
  pool,
  spawnObligationFromEvent,
  satisfyObligation,
  completeObligation,
}) {
  const express = require("express");
  const router = express.Router();

  // ---- helpers ------------------------------------------------------------

  // Pull the lease-shaped fields out of one rent-roll row, tolerant of the
  // many header spellings a real rent roll uses. Returns a normalized object;
  // missing fields come back null (honest blank), never invented.
  function normalizeRow(row) {
    const g = (...keys) => {
      for (const k of keys) {
        for (const rk of Object.keys(row || {})) {
          if (rk.toLowerCase().replace(/[^a-z0-9]/g, "") ===
              k.toLowerCase().replace(/[^a-z0-9]/g, "")) {
            const v = row[rk];
            if (v !== undefined && v !== null && String(v).trim() !== "") return v;
          }
        }
      }
      return null;
    };

    const num = (v) => {
      if (v === null) return null;
      const n = parseFloat(String(v).replace(/[$,]/g, "").trim());
      return Number.isFinite(n) ? n : null;
    };

    const date = (v) => {
      if (v === null) return null;
      const d = new Date(v);
      return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
    };

    return {
      unit_number: g("unit", "unit_number", "unitno", "unit#", "apt", "apartment", "suite"),
      tenant_name: g("tenant", "tenant_name", "resident", "resident_name", "name", "lessee"),
      rent:        num(g("rent", "market_rent", "monthly_rent", "lease_rent", "current_rent", "charge")),
      start_date:  date(g("start", "start_date", "lease_start", "move_in", "movein", "from")),
      end_date:    date(g("end", "end_date", "lease_end", "expiration", "expires", "to")),
      deposit:     num(g("deposit", "security_deposit", "sec_deposit", "security")),
      phone:       g("phone", "tenant_phone", "cell", "mobile"),
      email:       g("email", "tenant_email", "e_mail"),
    };
  }

  // The anti-Mark gate. Decide the honest status of a proposed lease from its
  // normalized fields. A lease needs, at minimum: a unit and a rent. A unit
  // with no tenant is a real thing (vacant) — but a *lease* with no tenant is
  // not, so that's needs_review, not blocked.
  function classify(n) {
    if (!n.unit_number) {
      return { status: "blocked",
               reason: "No unit number — cannot tie this row to a unit." };
    }
    if (n.rent === null) {
      return { status: "needs_review",
               reason: "No rent found — a lease needs a rent to build a schedule." };
    }
    if (!n.tenant_name) {
      return { status: "needs_review",
               reason: "Unit has rent but no tenant name — vacant, or missing resident on the roll?" };
    }
    // Everything a lease needs is present. Confidence reflects the soft fields.
    let confidence = 0.9;
    if (!n.start_date) confidence -= 0.15;
    if (!n.end_date)   confidence -= 0.1;
    return { status: "staged", reason: null, confidence: Math.max(0.4, confidence) };
  }

  // ---- POST /activations — create the envelope ----------------------------
  router.post("/activations", async (req, res) => {
    const { property_id, source_label } = req.body || {};
    try {
      if (property_id) {
        const p = await pool.query("select id from properties where id=$1", [property_id]);
        if (p.rows.length === 0) return res.status(404).json({ error: "property not found" });
      }
      const r = await pool.query(
        `insert into activations (property_id, source_label)
         values ($1,$2) returning *`,
        [property_id ?? null, source_label ?? null]
      );
      res.status(201).json({
        activation: r.rows[0],
        receipt: `Activation ${r.rows[0].id} opened${source_label ? " for " + source_label : ""}. ` +
                 `Stage a rent roll next.`,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- POST /activations/:id/stage-rent-roll ------------------------------
  // Body: { rows: [ {unit, tenant, rent, ...}, ... ] }  (already parsed)
  // READ-ONLY toward live state: writes ONLY proposed_records.
  router.post("/activations/:id/stage-rent-roll", async (req, res) => {
    const rows = (req.body && req.body.rows) || [];
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: "rows[] is required (parsed rent-roll rows)" });
    }
    const client = await pool.connect();
    try {
      await client.query("begin");

      const act = await client.query(
        "select * from activations where id=$1 for update", [req.params.id]);
      if (act.rows.length === 0) {
        await client.query("rollback");
        return res.status(404).json({ error: "activation not found" });
      }
      const activation = act.rows[0];
      const property_id = activation.property_id;

      const staged = [];
      let counts = { staged: 0, needs_review: 0, blocked: 0, skipped_duplicate: 0 };

      for (let i = 0; i < rows.length; i++) {
        const raw = rows[i];
        const n = normalizeRow(raw);
        const c = classify(n);
        const natural_key = n.unit_number ? String(n.unit_number).trim() : null;

        const evidence = [{
          source: activation.source_label || "rent_roll",
          row: i + 1,
        }];

        try {
          const ins = await client.query(
            `insert into proposed_records
               (activation_id, property_id, module, target_type, natural_key,
                payload_json, normalized_json, evidence_refs, confidence,
                status, status_reason)
             values ($1,$2,'leasing','lease',$3,$4,$5,$6,$7,$8,$9)
             returning id, status, status_reason, natural_key`,
            [
              req.params.id, property_id, natural_key,
              JSON.stringify(raw), JSON.stringify(n), JSON.stringify(evidence),
              c.confidence ?? null, c.status, c.reason,
            ]
          );
          staged.push(ins.rows[0]);
          counts[c.status] = (counts[c.status] || 0) + 1;
        } catch (e) {
          // 23505 = the uq_proposed_natural guard: same unit staged twice
          if (e.code === "23505") {
            counts.skipped_duplicate++;
          } else {
            throw e;
          }
        }
      }

      await client.query("commit");

      res.status(201).json({
        activation_id: req.params.id,
        counts,
        staged,
        receipt:
          `Read ${rows.length} rows. ${counts.staged} ready to confirm, ` +
          `${counts.needs_review} need review, ${counts.blocked} blocked` +
          (counts.skipped_duplicate ? `, ${counts.skipped_duplicate} duplicate unit(s) skipped` : "") +
          `. Nothing is live yet — confirm rows to create leases.`,
      });
    } catch (e) {
      await client.query("rollback");
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  // ---- GET /activations/:id/proposed --------------------------------------
  router.get("/activations/:id/proposed", async (req, res) => {
    try {
      const params = [req.params.id];
      let where = "activation_id=$1";
      if (req.query.status) { params.push(req.query.status); where += ` and status=$2`; }
      const r = await pool.query(
        `select * from proposed_records where ${where} order by natural_key nulls last, created_at`,
        params
      );
      res.json({ proposed: r.rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- GET /activations/:id — envelope + rows + leasing exposure -----------
  router.get("/activations/:id", async (req, res) => {
    try {
      const act = await pool.query("select * from activations where id=$1", [req.params.id]);
      if (act.rows.length === 0) return res.status(404).json({ error: "activation not found" });
      const activation = act.rows[0];

      const proposed = await pool.query(
        `select status, count(*)::int as n from proposed_records
         where activation_id=$1 group by status`, [req.params.id]);
      const byStatus = {};
      for (const r of proposed.rows) byStatus[r.status] = r.n;

      let exposure = null;
      if (activation.property_id) {
        exposure = await leasingExposure(activation.property_id);
      }

      res.json({
        activation,
        proposed_counts: byStatus,
        leasing_exposure: exposure,
        receipt: exposure
          ? `Leasing Exposure: ${exposure.untied} of ${exposure.total_units} units untied. ` +
            `${byStatus.staged || 0} proposed lease(s) ready to confirm.`
          : `${byStatus.staged || 0} proposed lease(s) ready to confirm.`,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- POST /proposed/:id/confirm — THE STRUCTURAL TIE --------------------
  // One atomic transaction. Refuses to confirm anything not in a confirmable
  // status. Fans out: unit -> space -> lease ; person -> tenant_ids. Marks the
  // proposal promoted. Satisfies + completes the confirmation obligation.
  router.post("/proposed/:id/confirm", async (req, res) => {
    const confirmed_by = (req.body && req.body.confirmed_by) || null;
    const client = await pool.connect();
    try {
      await client.query("begin");

      const pr = await client.query(
        "select * from proposed_records where id=$1 for update", [req.params.id]);
      if (pr.rows.length === 0) {
        await client.query("rollback");
        return res.status(404).json({ error: "proposed record not found" });
      }
      const proposed = pr.rows[0];

      if (proposed.status === "promoted") {
        await client.query("rollback");
        return res.status(409).json({
          error: "already promoted",
          promoted_record_id: proposed.promoted_record_id,
        });
      }
      // Anti-Mark: a blocked/needs_review row cannot be confirmed as-is.
      if (proposed.status === "blocked" || proposed.status === "needs_review") {
        await client.query("rollback");
        return res.status(422).json({
          error: "cannot confirm — this row is not confirmable as-is",
          status: proposed.status,
          reason: proposed.status_reason,
          fix: "Resolve the missing field on the roll, or reject this row.",
        });
      }
      if (proposed.target_type !== "lease") {
        await client.query("rollback");
        return res.status(400).json({ error: `confirm not implemented for target_type '${proposed.target_type}' (V1: lease only)` });
      }

      const n = proposed.normalized_json || {};
      const property_id = proposed.property_id;
      if (!property_id) {
        await client.query("rollback");
        return res.status(422).json({ error: "proposed record has no property_id — cannot tie." });
      }

      // 1) resolve or insert the unit by (property_id, unit_number)
      let unit;
      const existingUnit = await client.query(
        "select * from units where property_id=$1 and unit_number=$2",
        [property_id, String(n.unit_number)]);
      if (existingUnit.rows.length > 0) {
        unit = existingUnit.rows[0];
      } else {
        const u = await client.query(
          `insert into units (property_id, unit_number, market_rent)
           values ($1,$2,$3) returning *`,
          [property_id, String(n.unit_number), n.rent ?? null]);
        unit = u.rows[0];
      }

      // 2) read back the unit's space(s). A by-the-unit lease has exactly one
      //    space (the trigger makes one per unit). But student housing leases
      //    BY THE BED — one unit, many spaces — and a bare unit number cannot
      //    say WHICH bed this lease is for. Tying to "the first space" would be
      //    a wrong-confident value: roommates would collide on one bed. So if
      //    the unit has more than one space, we refuse to guess and send the
      //    row back for review instead of fabricating a tie.
      const sp = await client.query(
        "select * from spaces where unit_id=$1 order by created_at", [unit.id]);
      if (sp.rows.length === 0) {
        await client.query("rollback");
        return res.status(500).json({ error: "no space found for unit (trigger invariant broken)" });
      }
      if (sp.rows.length > 1) {
        await client.query("rollback");
        await pool.query(
          `update proposed_records
           set status='needs_review',
               status_reason=$1, updated_at=now()
           where id=$2`,
          [`Unit ${n.unit_number} has ${sp.rows.length} beds — the rent roll row ` +
           `doesn't say which bed this lease is for. Confirm by bed, not by unit.`,
           req.params.id]);
        return res.status(422).json({
          error: "cannot confirm — unit has multiple beds; which bed is ambiguous",
          unit_id: unit.id,
          space_count: sp.rows.length,
          fix: "This unit leases by the bed. The row must identify the bed before it can tie.",
        });
      }
      const space = sp.rows[0];

      // 3) insert the person (tenant). We do NOT match an existing person by
      //    name: two different real residents can share a name, and merging
      //    them onto one person row would silently corrupt the truth (one
      //    person tied to two unrelated leases). A duplicate person is an
      //    honest, fixable blank; a merged person is a wrong-confident value.
      //    This matches every other module, which also inserts fresh.
      let person = null;
      if (n.tenant_name) {
        const p = await client.query(
          `insert into persons (name, email, phone, source, lifecycle_status, leasing_stage)
           values ($1,$2,$3,'activation','resident','resident') returning *`,
          [n.tenant_name, n.email ?? null, n.phone ?? null]);
        person = p.rows[0];
      }

      // 4) insert the lease against space_id with tenant_ids = [person.id]
      const lease = await client.query(
        `insert into leases
           (property_id, space_id, tenant_ids, rent, start_date, end_date,
            security_deposit, lease_status)
         values ($1,$2,$3,$4,$5,$6,$7,'active') returning *`,
        [
          property_id, space.id,
          person ? [person.id] : [],
          n.rent, n.start_date ?? null, n.end_date ?? null,
          n.deposit ?? null,
        ]);
      const leaseId = lease.rows[0].id;

      // 5+6) mark the proposal promoted, carry the live id
      await client.query(
        `update proposed_records
         set status='promoted', promoted_record_id=$1,
             confirmed_by=$2, confirmed_at=now(), updated_at=now()
         where id=$3`,
        [leaseId, confirmed_by, req.params.id]);

      // 7) the obligation receipt: spawn the confirm obligation already
      //    satisfied, and complete it — so the promise board shows a closed,
      //    signed tie (no required inputs remain). Same engine, same path.
      const obl = await spawnObligationFromEvent(client, {
        property_id,
        unit_id: unit.id,
        person_id: person ? person.id : null,
        module: "leasing",
        type: "activation_confirm_lease",
        label: `Lease activated from rent roll: unit ${n.unit_number}` +
               (n.tenant_name ? ` / ${n.tenant_name}` : "") +
               ` @ ${n.rent}`,
        related_type: "lease",
        related_id: leaseId,
        required_inputs: ["operator_confirmation"],
      });
      await satisfyObligation(client, {
        obligation_id: obl.id,
        input: "operator_confirmation",
        proof: confirmed_by ? `confirmed by ${confirmed_by}` : "operator confirmed",
      });
      await completeObligation(client, {
        obligation_id: obl.id,
        completed_by: confirmed_by,
      });

      await client.query("commit");

      const exposure = await leasingExposure(property_id);
      res.status(201).json({
        promoted: true,
        proposed_record_id: req.params.id,
        lease_id: leaseId,
        unit_id: unit.id,
        space_id: space.id,
        person_id: person ? person.id : null,
        obligation_id: obl.id,
        leasing_exposure: exposure,
        receipt:
          `Confirmed. Unit ${n.unit_number}` +
          (n.tenant_name ? ` / ${n.tenant_name}` : "") +
          ` is now a live lease (${leaseId}). ` +
          `Leasing Exposure: ${exposure.untied} of ${exposure.total_units} units untied.`,
      });
    } catch (e) {
      await client.query("rollback");
      // typed obligation errors carry a .code; surface cleanly
      res.status(e.code && typeof e.code === "string" && e.code === e.code.toUpperCase() ? 422 : 500)
        .json({ error: e.message, code: e.code || null });
    } finally {
      client.release();
    }
  });

  // ---- POST /proposed/:id/reject — no live write --------------------------
  router.post("/proposed/:id/reject", async (req, res) => {
    const reason = (req.body && req.body.reason) || null;
    try {
      const r = await pool.query(
        `update proposed_records
         set status='rejected', status_reason=$1, updated_at=now()
         where id=$2 and status <> 'promoted'
         returning id, status`,
        [reason, req.params.id]);
      if (r.rows.length === 0) {
        return res.status(409).json({ error: "not found, or already promoted (cannot reject a live tie)" });
      }
      res.json({ rejected: true, proposed_record_id: req.params.id,
                 receipt: "Rejected. No live record was written." });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- leasing exposure (the headline number) -----------------------------
  // Untied = units with no lease in an active/pending status. This is the same
  // axis as operating exposure, measured at activation grain.
  async function leasingExposure(property_id) {
    const total = await pool.query(
      "select count(*)::int as n from units where property_id=$1", [property_id]);
    const tied = await pool.query(
      `select count(distinct un.id)::int as n
         from units un
         join spaces sp on sp.unit_id = un.id
         join leases l on l.space_id = sp.id
        where un.property_id=$1
          and l.lease_status in ('active','pending')`,
      [property_id]);
    const total_units = total.rows[0].n;
    const tied_units = tied.rows[0].n;
    return {
      total_units,
      tied_units,
      untied: Math.max(0, total_units - tied_units),
    };
  }

  router.get("/properties/:id/leasing-exposure", async (req, res) => {
    try {
      const p = await pool.query("select id from properties where id=$1", [req.params.id]);
      if (p.rows.length === 0) return res.status(404).json({ error: "property not found" });
      const exposure = await leasingExposure(req.params.id);
      res.json({
        property_id: req.params.id,
        ...exposure,
        receipt: `Leasing Exposure: ${exposure.untied} of ${exposure.total_units} units untied ` +
                 `(${exposure.tied_units} tied to an active lease).`,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
