// ════════════════════════════════════════════════════════════════════
//  activation_service.js — ACTIVATION, AND WHAT COMES OUT OF IT
//
//    ACTIVATION is the process:
//      retained artifact → evidence → proposal → review → canonical records
//
//    OPENING TENANCY POSITION is the outcome:
//      "As of 30 April this is the established lease and occupancy position
//       for this property, from these sources, with these remaining
//       exceptions."
//
//    TENANCY, not the deal's opening state. It holds no debt, taxes,
//    insurance, contracts or bank balances and never will. "Opening
//    Operating Position" is reserved for that composed state; "Opening
//    Accounting Truth" for the GL/subledger cutover after it. Shown to
//    people as "Lease & occupancy established" — see migration 159.
//
//  ── THE CORRECTION THIS EXISTS TO MAKE ──────────────────────────────
//  `src/identity/activation.js` designed this flow and was never mounted:
//  no `require`, no `app.use`, and an app screen calling routes that 404.
//  Worse, its confirm path wrote canonical leases and NOTHING ELSE — and
//  the live staff Rent Roll (`GET /operator/rent-roll` → readLatestSnapshot)
//  reads `import_batches → import_source_rows`, overlaying canonical
//  positions on top. An activation that skipped the evidence substrate
//  would establish leases the operator's own rent roll could not show:
//  "No sourced rent roll has been imported for this property."
//
//  So one activation writes BOTH, and the evidence side is not written
//  here — it is `loadLedgerSnapshot`, the existing ledger importer, called
//  with the caller's transaction. There is no second importer.
//
//      artifact ──▶ loadLedgerSnapshot ──▶ import_batches
//                                          import_source_rows   EVIDENCE
//                                          units · spaces
//                          │
//                          └─ FK ─▶ proposed_records            DECISION
//                                          │
//                                    confirm ─▶ persons · leases
//                                          └─▶ produced_person_id
//                                              produced_lease_id  back onto
//                                              the evidence row
//
//  ── EVIDENCE AND DECISION STAY SEPARATE ─────────────────────────────
//  `import_source_rows` says what the document contained. `proposed_records`
//  says what Spine made of it and what a human did about that. They are
//  joined by a foreign key and never merged: correcting an interpretation
//  must never edit the record of what the source said.
//
//  ── WHAT IT REFUSES TO GUESS ────────────────────────────────────────
//  Rows with no unit number are blocked. Rows with no rent need review. A
//  unit that leases by the bed cannot be tied from a bare unit number and
//  says so. People are never matched by name — two residents share a name
//  more often than a merge is ever noticed.
// ════════════════════════════════════════════════════════════════════

"use strict";

const { mapRows, describePlan, planFor } = require("./rent_roll_field_map.js");
const artifacts = require("./source_artifact_service.js");
const dealService = require("./deal_service.js");

function refusal(status, reason, receipt, extra = {}) {
  const e = new Error(receipt);
  e.httpStatus = status; e.reason = reason; e.receipt = receipt;
  Object.assign(e, extra);
  return e;
}

/*  Can this actor operate this property, and is it inside this deal?
 *  Membership is authority here: a property reached through a deal the
 *  actor may operate is a property the actor may activate. */
async function resolveActivationScope(db, { user_id, deal_intake_id, property_id } = {}) {
  const scope = await dealService.resolveDealScope(db, { user_id, deal_intake_id });
  if (!scope.ok) throw refusal(scope.status, scope.reason, scope.receipt, scope);

  const member = (await db.query(
    `select p.id, p.name, p.display_name, p.address, p.city, p.state, p.zip, p.leasing_basis
       from deal_intake_properties dp
       join properties p on p.id = dp.property_id
      where dp.intake_id = $1 and dp.property_id = $2 and dp.status = 'current'`,
    [deal_intake_id, property_id])).rows[0];
  if (!member) {
    throw refusal(403, "property_not_in_deal",
      "That property is not currently part of this deal, so it cannot be set up from here.");
  }
  return { ...scope, property: member };
}

/*  ── THE HONEST STATUS OF ONE PROPOSED LEASE ───────────────────────
 *  A lease needs, at minimum, a unit and a rent. A unit with no tenant is
 *  a real thing — vacant — but a LEASE with no tenant is not, so that is
 *  needs_review rather than blocked. Confidence reflects the soft fields;
 *  it is never rounded up to look decisive.
 *
 *  Carried forward from the dormant module deliberately: this classifier
 *  was already right, and rewriting it would have been a second opinion
 *  where the product only wants one. */
function classify(n) {
  if (!n.unit_number) {
    return { status: "blocked", confidence: null,
      reason: "This row has no unit number, so there is nothing to attach it to." };
  }

  //  A VACANT / MODEL / DOWN row is a real position — an empty unit is part
  //  of the established position, not missing from it. Its market rent is the
  //  right and only rent it has, and no lease is created for it.
  const vacant = Boolean(n.non_revenue) || !n.name;
  if (vacant) {
    if (n.market_rent == null && n.actual_rent == null) {
      return { status: "needs_review", confidence: 0.4, vacant: true,
        reason: "This unit reads as empty but carries no market rent, so there is nothing " +
                "to record for it." };
    }
    return { status: "staged", confidence: 0.85, reason: null, vacant: true };
  }

  //  ── AN OCCUPIED ROW NEEDS A CONTRACT RENT, NOT AN ASKING RENT ────
  //  Market rent is what the unit is ADVERTISED at. Actual rent is what
  //  this resident pays. They are routinely different, and using the
  //  asking rent as a lease rent produces a schedule nobody agreed to —
  //  wrong-confident in the direction that reaches an owner report.
  //
  //  So a row with a tenant and only a market rent is NOT staged. It is a
  //  question for a human: is the rent missing from this report, or is the
  //  unit actually vacant?
  if (n.actual_rent == null) {
    return { status: "needs_review", confidence: 0.4, vacant: false,
      reason: n.market_rent != null
        ? `${n.name} is shown in this unit but the report has no rent for them — only an ` +
          `asking rent of ${n.market_rent}. Asking rent is not what they pay.`
        : "There is a resident on this row but no rent at all." };
  }

  let confidence = 0.9;
  if (!n.lease_from) confidence -= 0.15;
  if (!n.lease_to)   confidence -= 0.1;
  return { status: "staged", confidence: Math.max(0.4, confidence), reason: null, vacant: false };
}

/*  ── openActivation ────────────────────────────────────────────────
 *  Fails CLOSED on the property. The dormant module allowed an activation
 *  with no property, staged rows against it happily, and then refused at
 *  confirmation — after the human had reviewed everything. */
async function openActivation(db, { user_id, deal_intake_id, property_id, source_label = null } = {}) {
  const scope = await resolveActivationScope(db, { user_id, deal_intake_id, property_id });

  const open = (await db.query(
    `select id, status, created_at from activations
      where property_id = $1 and deal_id = $2 and status = 'open'
      order by created_at desc limit 1`, [property_id, deal_intake_id])).rows[0];
  if (open) return { activation: open, reopened: true,
    receipt: "Picking up the setup already in progress for this property." };

  const label = source_label || `${scope.property.name || scope.property.address} rent roll`;
  const row = (await db.query(
    `insert into activations
       (deal_id, property_id, source_label, status, opened_by_user_id, authority_basis)
     values ($1,$2,$3,'open',$4,$5)
     returning id, deal_id, property_id, source_label, status, created_at`,
    [deal_intake_id, property_id, label, user_id, scope.authority_basis])).rows[0];

  return { activation: row, reopened: false,
    receipt: `Setup started for ${scope.property.name || scope.property.address}.` };
}

/*  ── ingestRentRoll ────────────────────────────────────────────────
 *  ONE transaction: evidence, units, spaces and proposals commit together
 *  or not at all. A batch that survived a failed staging would be evidence
 *  for a decision nobody ever made, and the next attempt would find a
 *  committed batch and skip itself as a duplicate.
 *
 *  `rows` are as the app parsed them, original headers intact.
 *  `source_artifact_id` is the file those rows were read from — required,
 *  because a position with no retainable source is the thing this build
 *  exists to stop producing. */
async function ingestRentRoll(db, {
  user_id, deal_intake_id, property_id, activation_id,
  rows, source_artifact_id, source_as_of_date, leasing_basis = null, force = false,
} = {}) {
  const scope = await resolveActivationScope(db, { user_id, deal_intake_id, property_id });

  if (!Array.isArray(rows) || rows.length === 0) {
    throw refusal(400, "no_rows",
      "No rows were read from that file. If it has a title block above the table, " +
      "export just the rent-roll sheet.");
  }
  if (rows.length > 5000) {
    throw refusal(413, "too_many_rows",
      `That file has ${rows.length} rows. Spine reads up to 5,000 at a time.`);
  }
  if (!source_artifact_id) {
    throw refusal(400, "source_artifact_required",
      "Upload the file itself before establishing a position from it. Spine keeps the " +
      "source so it can always show what a position came from.");
  }
  const artifact = await artifacts.describe(db, source_artifact_id);
  if (!artifact) throw refusal(404, "artifact_not_found", "That uploaded file is no longer on record.");

  //  ── ONE SETUP READS ONE SOURCE ────────────────────────────────────
  //  V1 scope: one property-specific rent roll per property. Letting a
  //  second file into the same setup would silently repoint which document
  //  the position claims to come from — the first file's rows stay in
  //  evidence while the position cites the second, and "what did this come
  //  from" gets two answers.
  //
  //  Correcting a file is a NEW setup, which supersedes cleanly and leaves
  //  both readable. `opening_tenancy_position_sources` is already a join table for
  //  the day a position is genuinely established from more than one
  //  document (a rent roll plus a correction); this refusal is what stops
  //  that arriving by accident before it is designed.
  if (activation_id) {
    const already = (await db.query(
      `select import_batch_id, source_artifact_id from activations where id=$1`,
      [activation_id])).rows[0];
    if (already && already.import_batch_id
        && already.source_artifact_id !== source_artifact_id) {
      throw refusal(409, "setup_already_read_a_source",
        "This setup has already read a rent roll. To use a different file, start the " +
        "setup again — the new position will supersede this one and both stay on record.");
    }
  }

  //  The artifact must be about THIS deal or THIS property. Otherwise one
  //  property's position could be established from another's document by
  //  passing an id — a client-supplied reference is never authority.
  const artifactInScope =
    (artifact.scope_type === "deal" && artifact.scope_id === deal_intake_id) ||
    (artifact.scope_type === "property" && artifact.scope_id === property_id);
  if (!artifactInScope) {
    throw refusal(403, "artifact_out_of_scope",
      "That file was uploaded for something else. Upload it here to use it here.");
  }

  const asOf = source_as_of_date || artifact.source_as_of_date;
  if (!asOf) {
    throw refusal(400, "source_as_of_date_required",
      "What date is this rent roll as of? A position without a date cannot be compared " +
      "to any other, and a position dated by the upload is dated wrong.");
  }

  const { plan, mapped } = mapRows(rows);
  if (!plan.mapped.unit_number) {
    throw refusal(422, "no_unit_column",
      `Spine could not find a unit column in that file. It read these columns: ` +
      `${plan.headers.slice(0, 12).join(", ")}${plan.headers.length > 12 ? "…" : ""}.`,
      { columns: plan.headers });
  }

  //  Carry the original cells into evidence alongside the mapped shape.
  const ledgerRows = mapped.map((m) => ({ ...m, _source_cells: m._raw }));

  const client = await db.connect();
  try {
    await client.query("begin");

    if (["unit", "bed"].includes(leasing_basis)) {
      await client.query("update properties set leasing_basis=$1 where id=$2",
        [leasing_basis, property_id]);
    }
    const basis = (await client.query(
      "select coalesce(leasing_basis,'unit') as b from properties where id=$1",
      [property_id])).rows[0].b;

    //  THE EXISTING LEDGER IMPORTER. Not reimplemented, not forked —
    //  called, inside this transaction.
    const { loadLedgerSnapshot } = require("../shared/snapshot_loader.js");
    const ledger = await loadLedgerSnapshot(db, ledgerRows, {
      client,
      targetPropertyId: property_id,
      sourceFile: artifact.original_filename,
      sourceAsOfDate: asOf,
      leasingModel: basis === "bed" ? "bed" : "unit",
      confidence: "extracted",
      sourceArtifactId: source_artifact_id,
      force,
      notes: `Established through Asset Management activation ${activation_id || "(new)"} ` +
             `by user ${user_id}. Evidence only at this stage: no person or lease was created here.`,
    });
    if (ledger && ledger.error) {
      await client.query("rollback");
      throw refusal(400, ledger.error, ledger.receipt || `Could not read that rent roll (${ledger.error}).`);
    }
    if (ledger && ledger.already_loaded) {
      await client.query("rollback");
      throw refusal(409, "already_established_from_this_file",
        `This rent roll (${artifact.original_filename}, as of ${asOf}) has already been read ` +
        `for this property. Re-reading it would double the evidence underneath the position.`,
        { import_batch_id: ledger.import_batch_id });
    }

    const batchId = ledger.import_batch_id;

    //  The evidence rows just written, keyed by the row index they came
    //  from — this is the join that turns evidence_refs prose into a key.
    const evidence = (await client.query(
      `select id, row_index, produced_unit_id from import_source_rows
        where import_batch_id = $1`, [batchId])).rows;
    const evidenceByIndex = new Map(evidence.map((e) => [Number(e.row_index), e]));

    const counts = { staged: 0, needs_review: 0, blocked: 0, vacant: 0 };
    for (const m of mapped) {
      const c = classify(m);
      if (c.vacant) counts.vacant++;
      const ev = evidenceByIndex.get(Number(m.row_index)) || null;

      //  Evidence prose is KEPT as well as the key. The key is what a join
      //  uses; the prose is what a human reads in a receipt, and dropping
      //  it would make old and new proposals describe themselves
      //  differently.
      const evidenceRefs = [{
        source: artifact.original_filename,
        artifact_id: source_artifact_id,
        row: m.row_index,
        import_source_row_id: ev ? ev.id : null,
      }];

      const normalized = {
        unit_number: m.unit_number, tenant_name: m.name,
        rent: m.actual_rent != null ? m.actual_rent : m.market_rent,
        market_rent: m.market_rent, actual_rent: m.actual_rent,
        start_date: m.lease_from, end_date: m.lease_to,
        move_in: m.move_in, move_out: m.move_out,
        deposit: m.deposit, balance: m.balance,
        email: m.email, phone: m.phone, status: m.status,
        space_label: m.space_label, sqft: m.sqft,
        non_revenue: Boolean(m.non_revenue),
        is_vacant: Boolean(c.vacant),
      };

      await client.query(
        `insert into proposed_records
           (activation_id, property_id, module, target_type, natural_key,
            payload_json, normalized_json, evidence_refs, confidence,
            status, status_reason, import_source_row_id)
         values ($1,$2,'leasing','lease',$3,$4,$5,$6,$7,$8,$9,$10)
         on conflict (activation_id, target_type, natural_key)
           where natural_key is not null do nothing`,
        [activation_id, property_id,
         m.unit_number ? String(m.unit_number).trim() : null,
         JSON.stringify(m._raw), JSON.stringify(normalized),
         JSON.stringify(evidenceRefs), c.confidence,
         c.status, c.reason, ev ? ev.id : null]);
      counts[c.status] = (counts[c.status] || 0) + 1;
    }

    await client.query(
      `update activations
          set source_artifact_id=$2, import_batch_id=$3, source_as_of_date=$4, updated_at=now()
        where id=$1`, [activation_id, source_artifact_id, batchId, asOf]);

    await client.query("commit");

    return {
      import_batch_id: batchId,
      source_as_of_date: asOf,
      rows_read: mapped.length,
      counts,
      mapping: describePlan(plan),
      receipt:
        `Read ${mapped.length} rows from ${artifact.original_filename}, dated ${asOf}. ` +
        `${counts.staged} ready, ${counts.needs_review || 0} need a look, ` +
        `${counts.blocked || 0} can't be used. Nothing is live yet.`,
    };
  } catch (e) {
    try { await client.query("rollback"); } catch { /* already rolled back */ }
    throw e;
  } finally {
    client.release();
  }
}

/*  ── confirmProposal ───────────────────────────────────────────────
 *  The structural tie, in one transaction: unit → space → lease, plus the
 *  person, plus the evidence row updated to name what it produced.
 *
 *  There is no `confirmed_by` parameter from a caller's body. The actor is
 *  the session. */
async function confirmProposal(db, { user_id, proposed_id } = {}) {
  const client = await db.connect();
  try {
    await client.query("begin");

    const p = (await client.query(
      `select pr.*, a.deal_id, a.property_id as activation_property_id
         from proposed_records pr
         join activations a on a.id = pr.activation_id
        where pr.id = $1 for update of pr`, [proposed_id])).rows[0];
    if (!p) { await client.query("rollback"); throw refusal(404, "not_found", "That row is no longer on this setup."); }

    if (p.status === "promoted") {
      await client.query("rollback");
      throw refusal(409, "already_promoted",
        "This one is already part of the position.", { lease_id: p.promoted_record_id });
    }
    if (p.status === "blocked") {
      await client.query("rollback");
      throw refusal(422, "blocked", p.status_reason ||
        "This row cannot be used as it stands.");
    }

    //  Authority is re-resolved here, not trusted from staging time. A
    //  proposal can sit for days; the actor confirming it is not
    //  necessarily the actor who staged it.
    const scope = await resolveActivationScope(db, {
      user_id, deal_intake_id: p.deal_id, property_id: p.property_id || p.activation_property_id });

    const n = p.normalized_json || {};
    const propertyId = p.property_id || p.activation_property_id;

    //  A vacant row establishes the UNIT and no lease. That is a real
    //  position — a vacancy is part of an opening position, not an
    //  omission from it — and inventing a lease for it would be the
    //  wrong-confident value this whole path exists to prevent.
    if (n.is_vacant || !n.tenant_name) {
      await client.query(
        `update proposed_records
            set status='promoted', promoted_record_id=null,
                confirmed_by=$2, confirmed_at=now(), updated_at=now(),
                status_reason='Confirmed as a vacant unit. No lease was created.'
          where id=$1`, [proposed_id, String(user_id)]);
      await client.query("commit");
      return { lease_id: null, vacant: true,
        receipt: `Unit ${n.unit_number} recorded as vacant.` };
    }

    //  1) the unit — created by the evidence pass already, but resolved
    //     rather than assumed, because a human may have renamed it.
    let unit = (await client.query(
      `select * from units where property_id=$1 and unit_number=$2`,
      [propertyId, String(n.unit_number)])).rows[0];
    if (!unit) {
      unit = (await client.query(
        `insert into units (property_id, unit_number, market_rent)
         values ($1,$2,$3) returning *`,
        [propertyId, String(n.unit_number), n.market_rent ?? n.rent ?? null])).rows[0];
    }

    //  2) the space. A by-the-bed unit has many, and a bare unit number
    //     cannot say which bed this lease is for. Tying to "the first one"
    //     would put roommates on one bed. Refuse and send it back.
    const spaces = (await client.query(
      "select * from spaces where unit_id=$1 order by created_at", [unit.id])).rows;
    if (spaces.length === 0) {
      await client.query("rollback");
      throw refusal(500, "no_space_for_unit",
        "That unit has no space record, which should be impossible. Nothing was written.");
    }
    if (spaces.length > 1) {
      await client.query("rollback");
      await db.query(
        `update proposed_records set status='needs_review', status_reason=$2, updated_at=now()
          where id=$1`,
        [proposed_id,
         `Unit ${n.unit_number} has ${spaces.length} beds and this row does not say which one ` +
         `this lease is for. It has to be confirmed by bed.`]);
      throw refusal(422, "ambiguous_bed",
        `Unit ${n.unit_number} leases by the bed. This row does not say which bed, so Spine ` +
        `will not guess.`, { space_count: spaces.length });
    }
    const space = spaces[0];

    //  3) the person. NEVER matched by name: two residents share a name
    //     more often than a silent merge is ever noticed, and a duplicate
    //     person is fixable where a merged one corrupts two tenancies.
    const person = (await client.query(
      `insert into persons (name, email, phone, source, lifecycle_status, leasing_stage,
                            import_batch_id, source_type, source_as_of_date, confidence)
       values ($1,$2,$3,'activation','resident','resident',$4,'rent_roll_ledger',$5,'extracted')
       returning *`,
      [n.tenant_name, n.email ?? null, n.phone ?? null,
       (await client.query("select import_batch_id from activations where id=$1",
         [p.activation_id])).rows[0]?.import_batch_id || null,
       (await client.query("select source_as_of_date from activations where id=$1",
         [p.activation_id])).rows[0]?.source_as_of_date || null])).rows[0];

    //  4) the lease, stamped with the batch it came from (migration 046).
    const act = (await client.query(
      "select import_batch_id, source_as_of_date from activations where id=$1",
      [p.activation_id])).rows[0] || {};
    //  DEPOSIT IS NOT WRITTEN ONTO THE LEASE. `leases` has no
    //  security_deposit column in the schema these migrations build — the
    //  dormant module and the old bare writer both referenced one that does
    //  not exist here, which is its own finding. The deposit IS retained:
    //  in the evidence row, and in this proposal's normalized_json. Adding
    //  a column to `leases` to hold a number this build does not use would
    //  be inventing schema to make a write look complete.
    const lease = (await client.query(
      `insert into leases
         (property_id, space_id, tenant_ids, rent, start_date, end_date,
          balance, lease_status,
          import_batch_id, source_type, source_as_of_date, confidence)
       values ($1,$2,$3,$4,$5,$6,$7,'active',$8,'rent_roll_ledger',$9,'extracted')
       returning *`,
      [propertyId, space.id, [person.id], n.rent,
       n.start_date ?? null, n.end_date ?? null, n.balance ?? 0,
       act.import_batch_id || null, act.source_as_of_date || null])).rows[0];

    //  5) CLOSE THE LINEAGE LOOP. `import_source_rows` has carried
    //     produced_person_id and produced_lease_id since migration 046 and
    //     the ledger importer has always written null into both, because
    //     it deliberately creates neither. This is the step that was
    //     missing: the evidence row now names every object it produced.
    if (p.import_source_row_id) {
      await client.query(
        `update import_source_rows
            set produced_person_id=$2, produced_lease_id=$3,
                produced_unit_id=coalesce(produced_unit_id,$4),
                produced_space_id=coalesce(produced_space_id,$5),
                parse_note='current ledger row — confirmed into canonical truth'
          where id=$1`,
        [p.import_source_row_id, person.id, lease.id, unit.id, space.id]);
    }

    await client.query(
      `update proposed_records
          set status='promoted', promoted_record_id=$2,
              confirmed_by=$3, confirmed_at=now(), updated_at=now(), status_reason=null
        where id=$1`, [proposed_id, lease.id, String(user_id)]);

    await client.query("commit");
    return { lease_id: lease.id, person_id: person.id, unit_id: unit.id, vacant: false,
      receipt: `Unit ${n.unit_number} — ${n.tenant_name} is now part of the position.`,
      authority_basis: scope.authority_basis };
  } catch (e) {
    try { await client.query("rollback"); } catch { /* already rolled back */ }
    throw e;
  } finally {
    client.release();
  }
}

async function rejectProposal(db, { user_id, proposed_id, reason = null } = {}) {
  const p = (await db.query(
    `select pr.id, pr.status, pr.property_id, a.deal_id, a.property_id as ap
       from proposed_records pr join activations a on a.id = pr.activation_id
      where pr.id = $1`, [proposed_id])).rows[0];
  if (!p) throw refusal(404, "not_found", "That row is no longer on this setup.");
  if (p.status === "promoted") {
    throw refusal(409, "already_promoted",
      "This one is already part of the position and cannot be dismissed from here.");
  }
  await resolveActivationScope(db, {
    user_id, deal_intake_id: p.deal_id, property_id: p.property_id || p.ap });

  await db.query(
    `update proposed_records
        set status='rejected', status_reason=$2, confirmed_by=$3,
            confirmed_at=now(), updated_at=now()
      where id=$1`,
    [proposed_id, reason || "Dismissed by the operator.", String(user_id)]);
  return { receipt: "Left out of the position." };
}

/*  ── establishOpeningTenancyPosition ───────────────────────────────
 *  The statement. It does not copy any lease: it records what was
 *  established, from what, by whom, as of when, and what remains
 *  unresolved. Every actual position is read canonically.
 *
 *  Unresolved rows do NOT block establishing. A position with four
 *  exceptions is a real position that has four exceptions; refusing to
 *  state it until every row is perfect is how setup never finishes. What
 *  is not allowed is establishing while pretending they are not there —
 *  the count is part of the statement. */
async function establishOpeningPosition(db, { user_id, activation_id } = {}) {
  const act = (await db.query(
    `select * from activations where id = $1`, [activation_id])).rows[0];
  if (!act) throw refusal(404, "activation_not_found", "That setup is no longer on record.");
  if (!act.import_batch_id) {
    throw refusal(409, "no_source_read_yet",
      "Upload a rent roll first — there is nothing to establish a position from.");
  }
  const scope = await resolveActivationScope(db, {
    user_id, deal_intake_id: act.deal_id, property_id: act.property_id });

  const tally = (await db.query(
    `select
       count(*) filter (where status='promoted')::int                          as established,
       count(*) filter (where status in ('needs_review','blocked','conflicted'))::int as unresolved,
       count(*)::int                                                            as total
     from proposed_records where activation_id = $1`, [activation_id])).rows[0];

  if (tally.established === 0) {
    throw refusal(409, "nothing_confirmed",
      "Nothing has been confirmed yet, so there is no position to establish.");
  }

  const client = await db.connect();
  try {
    await client.query("begin");

    //  Re-establishing supersedes; it never accumulates two current
    //  answers for one property.
    //
    //  ORDER MATTERS. The prior position must stop being 'established'
    //  BEFORE the new row is inserted, because only one established
    //  position per property may exist and the index enforces that
    //  immediately. It cannot name its successor yet — that row does not
    //  exist — so the shape rule is a deferred constraint trigger and this
    //  intermediate state resolves before commit. See migration 157.
    const prior = (await client.query(
      `select id from opening_tenancy_positions
        where property_id = $1 and status = 'established' for update`,
      [act.property_id])).rows[0];
    if (prior) {
      await client.query(
        `update opening_tenancy_positions set status='superseded', superseded_at=now() where id=$1`,
        [prior.id]);
    }

    const created = (await client.query(
      `insert into opening_tenancy_positions
         (property_id, deal_intake_id, activation_id, import_batch_id, as_of_date,
          positions_established, positions_unresolved, source_rows_read,
          established_by_user_id, established_by_person_id, authority_basis, status)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'established')
       returning *`,
      [act.property_id, act.deal_id, activation_id, act.import_batch_id,
       act.source_as_of_date, tally.established, tally.unresolved, tally.total,
       user_id, scope.actor ? scope.actor.person_id : null, scope.authority_basis])).rows[0];

    if (prior) {
      //  Now the successor exists, so the prior position can name it. The
      //  deferred trigger validates both rows at commit.
      await client.query(
        `update opening_tenancy_positions set superseded_by_id=$2 where id=$1`,
        [prior.id, created.id]);
    }

    if (act.source_artifact_id) {
      await client.query(
        `insert into opening_tenancy_position_sources (opening_tenancy_position_id, source_artifact_id, role)
         values ($1,$2,'rent_roll') on conflict do nothing`,
        [created.id, act.source_artifact_id]);
    }

    await client.query(
      `update activations set status='activated', updated_at=now() where id=$1`, [activation_id]);

    await client.query("commit");
    //  A receipt is product copy. `act.source_as_of_date` is a JS Date, and
    //  interpolating one produces "Thu Apr 30 2026 00:00:00 GMT+0000
    //  (Coordinated Universal Time)" in the middle of a sentence a person
    //  reads. It is a DATE; it is written as one.
    const asOfText = act.source_as_of_date
      ? new Date(act.source_as_of_date).toISOString().slice(0, 10)
      : "an unstated date";

    return { opening_position: created, superseded: prior ? prior.id : null,
      receipt:
        `Lease & occupancy established as of ${asOfText}: ` +
        `${tally.established} unit${tally.established === 1 ? "" : "s"}` +
        (tally.unresolved
          ? `, ${tally.unresolved} still needing attention.`
          : ", nothing outstanding.") };
  } catch (e) {
    try { await client.query("rollback"); } catch { /* already rolled back */ }
    throw e;
  } finally {
    client.release();
  }
}

/*  Everything the setup screen needs, in one read. Returns the SAME shape
 *  whether the activation was opened a minute ago or last week — which is
 *  what makes "leave and come back" work. */
async function readActivation(db, { user_id, activation_id } = {}) {
  const act = (await db.query("select * from activations where id=$1", [activation_id])).rows[0];
  if (!act) throw refusal(404, "activation_not_found", "That setup is no longer on record.");
  const scope = await resolveActivationScope(db, {
    user_id, deal_intake_id: act.deal_id, property_id: act.property_id });

  const proposals = (await db.query(
    `select pr.id, pr.natural_key, pr.status, pr.status_reason, pr.confidence,
            pr.normalized_json, pr.promoted_record_id, pr.confirmed_at,
            pr.import_source_row_id, isr.row_index
       from proposed_records pr
       left join import_source_rows isr on isr.id = pr.import_source_row_id
      where pr.activation_id = $1
      order by isr.row_index nulls last, pr.natural_key`, [activation_id])).rows;

  const counts = proposals.reduce((a, p) => { a[p.status] = (a[p.status] || 0) + 1; return a; }, {});

  const artifact = act.source_artifact_id
    ? await artifacts.describe(db, act.source_artifact_id) : null;

  //  ── WHAT SPINE UNDERSTOOD, RE-DERIVED FROM THE EVIDENCE ───────────
  //  The mapping was reported once, at ingest, and then vanished on
  //  reload — so a person coming back to finish a setup could no longer
  //  see which of THEIR columns we read as rent. That is the review
  //  screen's whole first question.
  //
  //  It is RE-DERIVED from `_source_cells` on the evidence rows rather
  //  than stored: a stored copy can drift from what the evidence actually
  //  contains, and this way the answer is always computed from the same
  //  original cells the position was built on.
  let mapping = null;
  if (act.import_batch_id) {
    const sample = (await db.query(
      `select raw from import_source_rows
        where import_batch_id = $1 order by row_index limit 50`,
      [act.import_batch_id])).rows
      .map((r) => (r.raw && r.raw._source_cells) || null)
      .filter(Boolean);
    if (sample.length) mapping = describePlan(planFor(sample));
  }

  const position = (await db.query(
    `select * from opening_tenancy_positions
      where property_id = $1 and status = 'established'`, [act.property_id])).rows[0] || null;

  return {
    activation: act, property: scope.property, deal: scope.deal,
    proposals, counts, opening_position: position, mapping,
    source: artifact ? {
      filename: artifact.original_filename, byte_size: artifact.byte_size,
      uploaded_at: artifact.uploaded_at, as_of: act.source_as_of_date,
      sha256: artifact.sha256,
    } : null,
  };
}

module.exports = {
  openActivation, ingestRentRoll, confirmProposal, rejectProposal,
  establishOpeningPosition, readActivation, resolveActivationScope, classify, refusal,
};
