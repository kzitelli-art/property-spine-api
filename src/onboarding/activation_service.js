// ════════════════════════════════════════════════════════════════════
const personIngress = require("../identity/person_ingress.js"); // the ONE door a human enters Spine through
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

const { describePlan, planFor } = require("./rent_roll_field_map.js");
const artifacts = require("./source_artifact_service.js");
const dealService = require("./deal_service.js");
const { competingOperativeLeases, describeCompeting, asDate } =
  require("../tenancy/operative_overlap.js");
//  Hoisted to module scope. It was required inline further down inside
//  confirmProposal, which put the whole function body in that binding's
//  temporal dead zone — the vacant-path guard above it would have thrown
//  ReferenceError before it could refuse anything. snapshot_loader does
//  not require this module back, so there is no cycle to avoid here.
const homeIdentity = require("./source_home_identity_review.js");

function refusal(status, reason, receipt, extra = {}) {
  const e = new Error(receipt);
  e.httpStatus = status; e.reason = reason; e.receipt = receipt;
  Object.assign(e, extra);
  return e;
}

/*  Can this actor operate this property's lease and occupancy setup?
 *  Deal ownership bounds the organization. Members also need a current
 *  assignment with the relevant capability on the target property. */
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
  if (!["org_admin", "super_admin"].includes(scope.actor.platform_role)) {
    const assignment = (await db.query(
      `select allowed_modules from property_team_assignments
        where user_id = $1 and property_id = $2 and active = true`,
      [scope.actor.id, member.id])).rows[0];
    if (!assignment || !assignment.allowed_modules.some(module =>
      module === "leasing" || module === "management")) {
      throw refusal(403, "property_setup_access_required",
        "You need Leasing or Management access to this property to review its rent roll and set up lease and occupancy.");
    }
    return { ...scope, property: member, authority_basis: "property_team_assignment:leasing_or_management" };
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
  if (n.section === "future") {
    return { status: n.unit_number ? "needs_review" : "blocked", confidence: 0.4, vacant: false,
      reason: n.unit_number
        ? "This is a future claim, not current occupancy. Review its identity and lease evidence before establishing it."
        : "This future applicant has no assigned unit. The source record is retained for review." };
  }
  if (!n.unit_number) {
    return { status: "blocked", confidence: null,
      reason: "This row has no unit number, so there is nothing to attach it to." };
  }

  //  A VACANT / MODEL / DOWN row is a real position — an empty unit is part
  //  of the established position, not missing from it. Its market rent is the
  //  right and only rent it has, and no lease is created for it.
  if (!n.name && !n.non_revenue) {
    return {status:"needs_review",confidence:0.4,vacant:false,
      reason:"The source does not identify a resident or explicitly describe this position as vacant. A blank name cannot establish vacancy."};
  }
  const vacant = Boolean(n.non_revenue);
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
  //  A status that says the signature is still pending is not a signed
  //  claim. It stays evidence for a human, never current occupancy.
  if (/^pending$/i.test(String(n.status || "").trim())) {
    return { status: "needs_review", confidence: 0.4, vacant: false,
      reason: `${n.name} is shown as pending on this source. A pending signature is not a signed lease and cannot establish current occupancy.` };
  }
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

/* Hold every row whose mutable fields grant this operation, then resolve the
 * authority from those locked rows.  FOR SHARE conflicts with authority
 * updates.  A revocation that was already waiting wins before this read; a
 * later revocation waits until the transaction has committed or rolled back. */
async function lockAndResolveActivationScope(client, { user_id, deal_intake_id, property_id } = {}) {
  await client.query("select id from users where id=$1 for share", [user_id]);
  await client.query("select id from deal_intakes where id=$1 for share", [deal_intake_id]);
  await client.query(
    `select property_id from deal_intake_properties
      where intake_id=$1 and property_id=$2 and status='current' for share`,
    [deal_intake_id, property_id]);
  await client.query("select id from properties where id=$1 for share", [property_id]);
  await client.query(
    `select property_id from property_team_assignments
      where user_id=$1 and property_id=$2 for share`, [user_id, property_id]);
  return resolveActivationScope(client, { user_id, deal_intake_id, property_id });
}

async function lockReviewedInventory(client, { property_id, prepared, inventory_decisions } = {}) {
  // Serialize every proposed source unit label, including approved-new labels,
  // without locking unrelated inventory for the property.
  const labels = [...new Set((prepared.mapped || []).map(r => r.unit_number).filter(Boolean)
    .map(v => String(v).trim().toLocaleLowerCase("en-US")))].sort();
  for (const label of labels) {
    await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))",
      [`source-home:${property_id}:${label}`]);
  }
  const decisions = Array.isArray(inventory_decisions) ? inventory_decisions : [];
  const unitIds = [...new Set(decisions.map(d => d && d.unit_id).filter(Boolean))];
  const spaceIds = [...new Set(decisions.map(d => d && d.space_id).filter(Boolean))];
  const reuseIds = [...new Set(decisions.map(d => d && d.decision_id).filter(Boolean))];
  if (reuseIds.length) {
    const reused = (await client.query(
      `select selected_unit_id,selected_space_id from proposed_records
        where id=any($1::uuid[]) for share`, [reuseIds])).rows;
    reused.forEach(r => { if (r.selected_unit_id) unitIds.push(r.selected_unit_id); if (r.selected_space_id) spaceIds.push(r.selected_space_id); });
  }
  if (unitIds.length) await client.query(
    `select id from units where property_id=$1 and id=any($2::uuid[]) for update`,
    [property_id, [...new Set(unitIds)]]);
  if (spaceIds.length) await client.query(
    `select s.id from spaces s join units u on u.id=s.unit_id
      where u.property_id=$1 and s.id=any($2::uuid[]) for update of s`,
    [property_id, [...new Set(spaceIds)]]);
}

/* Parse retained bytes and compare source identities with current inventory.
 * This is deliberately read-only: it does not set leasing_basis, create an
 * import batch, source rows, proposals, units, or spaces. */
async function previewRentRoll(db, {
  user_id, deal_intake_id, property_id, activation_id,
  rows, source_artifact_id, source_as_of_date, leasing_basis = null,
} = {}) {
  const scope = await resolveActivationScope(db, { user_id, deal_intake_id, property_id });
  const act = (await db.query(
    `select deal_id,property_id,status,import_batch_id from activations where id=$1`,
    [activation_id])).rows[0];
  if (!act || act.deal_id !== deal_intake_id || act.property_id !== property_id) {
    throw refusal(403, "activation_out_of_scope", "This setup does not belong to the requested property and deal.");
  }
  if (act.status !== "open" || act.import_batch_id) throw refusal(409, "setup_already_read_source",
    "This setup already has retained review. Start a new setup to review a correction.");
  const basis = ["unit", "bed"].includes(leasing_basis)
    ? leasing_basis : (scope.property.leasing_basis === "bed" ? "bed" : "unit");
  const prepared = await homeIdentity.prepareSource(db, { property_id, rows,
    source_artifact_id, source_as_of_date, leasing_basis: basis, refusal });
  const review = await homeIdentity.planReview(db, { property_id, activation_id, prepared });
  return { ...review,
    receipt: `Read ${review.rows_read} source rows without changing inventory. Review each grouped source home before applying it.` };
}

/* Pre-196 staged claims have retained evidence but no approved home decision.
 * They are never back-labelled.  Restart closes that open setup as history and
 * opens a clean review that points at the same immutable artifact bytes. */
async function restartSourceIdentityReview(db, { user_id, activation_id } = {}) {
  const client = await db.connect();
  try {
    await client.query("begin");
    const old = (await client.query(`select * from activations where id=$1 for update`, [activation_id])).rows[0];
    if (!old) throw refusal(404, "activation_not_found", "That setup is no longer on record.");
    if (old.status !== "open" || !old.source_artifact_id || !old.import_batch_id) {
      throw refusal(409, "source_review_restart_unavailable", "This setup has no staged retained source that needs a new identity review.");
    }
    const unbound = (await client.query(
      `select count(*)::int n from proposed_records
        where activation_id=$1 and target_type='lease' and inventory_identity_decision_id is null`,
      [activation_id])).rows[0].n;
    if (!unbound) throw refusal(409, "source_review_already_bound", "This setup already carries reviewed source-to-home decisions.");
    const scope = await lockAndResolveActivationScope(client, {
      user_id, deal_intake_id: old.deal_id, property_id: old.property_id,
    });
    await client.query(`update activations set status='abandoned',updated_at=now() where id=$1`, [old.id]);
    const next = (await client.query(
      `insert into activations(deal_id,property_id,source_label,status,opened_by_user_id,authority_basis)
       values($1,$2,$3,'open',$4,$5) returning *`,
      [old.deal_id,old.property_id,old.source_label,user_id,scope.authority_basis || null])).rows[0];
    const artifact = await artifacts.describe(client, old.source_artifact_id);
    await client.query("commit");
    return { activation: next, retained_source: { artifact_id:old.source_artifact_id,
      source_as_of_date:old.source_as_of_date, leasing_basis:scope.property.leasing_basis,
      filename:artifact && artifact.original_filename, sha256:artifact && artifact.sha256 },
      prior_activation_id:old.id,
      receipt:`The earlier staged claims remain on record. A new review is ready from the same retained source; no historical claim was relabelled.` };
  } catch (e) { await client.query("rollback").catch(()=>{}); throw e; }
  finally { client.release(); }
}

/*  ── ingestRentRoll ────────────────────────────────────────────────
 *  ONE transaction: evidence, units, spaces and proposals commit together
 *  or not at all. A batch that survived a failed staging would be evidence
 *  for a decision nobody ever made, and the next attempt would find a
 *  committed batch and skip itself as a duplicate.
 *
 *  The server reads retained bytes through the shared format adapter.
 *  `source_artifact_id` is the file those rows were read from — required,
 *  because a position with no retainable source is the thing this build
 *  exists to stop producing. */
async function ingestRentRoll(db, {
  user_id, deal_intake_id, property_id, activation_id,
  rows, source_artifact_id, source_as_of_date, leasing_basis = null, force = false,
  source_token, inventory_decisions,
} = {}) {
  // Early scope and source validation make preview/apply errors useful.  The
  // authority is deliberately resolved again under the activation lock below
  // before leasing basis or inventory can change.
  const initialScope = await resolveActivationScope(db, { user_id, deal_intake_id, property_id });
  const reviewedBasis = ["unit", "bed"].includes(leasing_basis)
    ? leasing_basis : (initialScope.property.leasing_basis === "bed" ? "bed" : "unit");
  const prepared = await homeIdentity.prepareSource(db, { property_id, rows,
    source_artifact_id, source_as_of_date, leasing_basis: reviewedBasis, refusal });
  const { artifact, asOf, parsed, plan, mapped, ledgerRows } = prepared;

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

  const client = await db.connect();
  try {
    await client.query("begin");

    const lockedActivation = (await client.query(
      "select deal_id,property_id,status,import_batch_id,source_artifact_id from activations where id=$1 for update", [activation_id])).rows[0];
    if (!lockedActivation || lockedActivation.deal_id !== deal_intake_id || lockedActivation.property_id !== property_id) {
      throw refusal(403, "activation_out_of_scope", "This setup does not belong to the requested property and deal.");
    }
    if (lockedActivation.status !== "open") throw refusal(409, "setup_not_open", "This setup is no longer open for reading a source.");
    if (lockedActivation.import_batch_id) throw refusal(409, "already_established_from_this_file", "This setup has already read its source. Return to its retained review.");

    // Two disjoint source groups can still update the same property's
    // leasing basis. Serialize applies for this property before taking the
    // shared authority/property locks, so concurrent activations cannot both
    // hold FOR SHARE and deadlock while upgrading that row for the write.
    await client.query(`select pg_advisory_xact_lock(hashtextextended($1,196))`,
      [`source-home-identity:${property_id}`]);

    // Authorization can disappear between preview and apply.  Re-resolve it
    // on this transaction before the first operating write, including the
    // leasing-basis update that used to happen before inventory was loaded.
    // Target locks come first. If this transaction waits behind inventory
    // work, authority is read only after that wait, never before it.
    await lockReviewedInventory(client, { property_id, prepared, inventory_decisions });
    const applyScope = await lockAndResolveActivationScope(client, {
      user_id, deal_intake_id, property_id,
    });
    const reviewed = await homeIdentity.resolveDecisions(client, {
      property_id, activation_id, prepared, source_token,
      decisions: inventory_decisions, refusal,
    });

    const { materializeRentableSpaces } = require("../shared/snapshot_loader.js");
    const resolvedByKey = reviewed.resolved;
    const childrenByUnit = new Map();
    for (const entry of resolvedByKey.values()) {
      if (entry.action !== "create_children") continue;
      if (!childrenByUnit.has(entry.unit_id)) childrenByUnit.set(entry.unit_id, entry);
    }
    for (const [unitId, exemplar] of childrenByUnit) {
      // The approval covers the complete child set for this source parent.
      // The canonical materializer rechecks placeholder references and keeps
      // the pristine placeholder's identity when it becomes the first bed.
      await materializeRentableSpaces(client, {
        unit_id: unitId, labels: exemplar.child_plan.labels, kind: "bed",
      });
      const spaces = (await client.query(
        `select id,space_label from spaces where unit_id=$1`, [unitId])).rows;
      for (const entry of resolvedByKey.values()) {
        if (entry.action !== "create_children" || entry.unit_id !== unitId) continue;
        const space = spaces.find(s => String(s.space_label).trim().toLocaleLowerCase("en-US")
          === String(entry.group.source.space_label).trim().toLocaleLowerCase("en-US"));
        if (!space) throw refusal(409, "approved_space_not_materialized",
          "The reviewed child set did not produce the approved rentable space. Nothing was loaded.");
        entry.space_id = space.id;
        entry.selected = await homeIdentity.currentSelection(client, property_id, unitId, space.id);
      }
    }
    const createByUnit = new Map();
    for (const entry of resolvedByKey.values()) {
      if (entry.action !== "create_new") continue;
      const unitKey = String(entry.group.source.unit_number).trim().toLocaleLowerCase("en-US");
      if (!createByUnit.has(unitKey)) createByUnit.set(unitKey, []);
      createByUnit.get(unitKey).push(entry);
    }
    for (const entries of createByUnit.values()) {
      const sourceUnit = entries[0].group.source.unit_number;
      const unit = (await client.query(
        `insert into units (property_id,unit_number) values ($1,$2) returning id,unit_number`,
        [property_id, sourceUnit])).rows[0];
      const labels = [...new Set(entries.map(e => e.group.source.space_label).filter(Boolean))];
      await materializeRentableSpaces(client, {
        unit_id: unit.id, labels, kind: prepared.basis === "bed" ? "bed" : "unit",
      });
      const madeSpaces = (await client.query(
        `select id,space_label,position_kind as space_kind from spaces where unit_id=$1`, [unit.id])).rows;
      for (const entry of entries) {
        const space = madeSpaces.find(s => String(s.space_label).trim().toLocaleLowerCase("en-US")
          === String(entry.group.source.space_label).trim().toLocaleLowerCase("en-US"));
        if (!space) throw refusal(409, "approved_space_not_materialized",
          "The approved new rentable space could not be materialized. Nothing was loaded.");
        entry.unit_id = unit.id;
        entry.space_id = space.id;
        entry.selected = await homeIdentity.currentSelection(client, property_id, unit.id, space.id);
      }
    }

    // The approved decision is stored in the existing proposal ledger.  One
    // grouped decision may serve several rows that name the same source home.
    for (const entry of resolvedByKey.values()) {
      if (entry.action === "reuse") continue;
      const confirmationFingerprint = entry.selected.fingerprint;
      const evidenceRefs = entry.group.row_indices.map(row => ({
        source: artifact.original_filename, artifact_id: source_artifact_id, row,
      }));
      const payload = {
        source: { artifact_id: source_artifact_id, sha256: artifact.sha256,
          as_of: asOf, rows: entry.group.row_indices },
        source_claim: entry.group.source,
        decision: { action: entry.action },
        review_fingerprint: entry.review_fingerprint,
        confirmation_fingerprint: confirmationFingerprint,
        authority: { actor: String(user_id), basis: applyScope.authority_basis || null },
      };
      const normalized = { identity_key: entry.group.key,
        leasing_basis: prepared.basis,
        source_unit_number: entry.group.source.unit_number,
        source_space_label: entry.group.source.space_label,
        canonical_unit_id: entry.unit_id, canonical_space_id: entry.space_id };
      const decision = (await client.query(
        `insert into proposed_records
           (activation_id,property_id,module,target_type,natural_key,payload_json,
            normalized_json,evidence_refs,confidence,status,promoted_record_id,
            confirmed_by,confirmed_at,resolution_kind,selected_unit_id,selected_space_id)
         values ($1,$2,'leasing','inventory_identity',$3,$4,$5,$6,1,'promoted',$7,$8,now(),$9,$10,$11)
         returning id`,
        [activation_id,property_id,entry.group.key,JSON.stringify(payload),JSON.stringify(normalized),
         JSON.stringify(evidenceRefs),entry.space_id || entry.unit_id,String(user_id),
         ["create_new","create_children"].includes(entry.action) ? "created" : "resolved_existing",entry.unit_id,entry.space_id])).rows[0];
      entry.decision_id = decision.id;
    }

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
    const reviewedRepeat = Boolean((await client.query(
      "select 1 from activations prior " +
      "join proposed_records d on d.activation_id=prior.id " +
      "where prior.property_id=$1 and prior.source_artifact_id=$2 and prior.id<>$3 " +
      "and d.target_type='inventory_identity' and d.status='promoted' limit 1",
      [property_id, source_artifact_id, activation_id])).rows[0]);
    const ledger = await loadLedgerSnapshot(db, ledgerRows, {
      client,
      targetPropertyId: property_id,
      sourceFile: artifact.original_filename,
      sourceAsOfDate: asOf,
      leasingModel: basis === "bed" ? "bed" : "unit",
      confidence: "extracted",
      sourceArtifactId: source_artifact_id,
      // A later activation may explicitly reuse or correct a prior reviewed
      // mapping for these immutable bytes. It records new evidence lineage;
      // same-activation duplicate clicks remain refused above.
      force: force || reviewedRepeat,
      notes: `Established through Asset Management activation ${activation_id || "(new)"} ` +
             `by user ${user_id}. Evidence only at this stage: no person or lease was created here.`,
      identityBindings: new Map(mapped.map(row => {
        const key = homeIdentity.positionKey(row.unit_number,
          homeIdentity.canonicalSpaceLabel(row, prepared.basis), prepared.basis);
        const entry = resolvedByKey.get(key);
        return [Number(row.row_index), entry ? { unit_id: entry.unit_id, space_id: entry.space_id } : null];
      }).filter(([, binding]) => binding)),
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

    /*  The durable identity of a proposed position within one activation.
     *  Unit alone for a whole-unit export; unit + room where the source
     *  names a rentable position inside the unit. Trimmed and cased
     *  consistently so "Room1" and "room1 " are one key rather than two
     *  proposals for one bed. */
    const naturalKeyFor = (m) => {
      const unit = m.unit_number ? String(m.unit_number).trim() : null;
      if (!unit) return null;
      const label = m.space_label ? String(m.space_label).trim() : "";
      return label ? `${unit}|${label}` : unit;
    };

    const currentClaims = new Map();
    for (const m of mapped.filter(row => row.section !== "future")) {
      const key = naturalKeyFor(m);
      if (!key) continue;
      const claims = currentClaims.get(key.toLowerCase()) || new Set();
      claims.add(JSON.stringify([m.name || null,m.resident_id || null,m.actual_rent ?? null,m.lease_from || null,m.lease_to || null,Boolean(m.non_revenue)]));
      currentClaims.set(key.toLowerCase(),claims);
    }
    const counts = { staged: 0, needs_review: 0, blocked: 0, conflicted: 0, vacant: 0 };
    for (const m of mapped) {
      const c = classify(m);
      const ev = evidenceByIndex.get(Number(m.row_index)) || null;
      if (!ev) throw refusal(409, "source_row_lineage_missing", "A source record lost its evidence link. Nothing was staged.");
      const conflict = m.section !== "future" && (currentClaims.get((naturalKeyFor(m) || "").toLowerCase()) || new Set()).size > 1;
      if (conflict) { c.status = "conflicted"; c.reason = "The source contains conflicting current claims for this position. Spine cannot choose between them."; }

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
        rent: m.actual_rent ?? null,
        market_rent: m.market_rent, actual_rent: m.actual_rent,
        start_date: m.lease_from, end_date: m.lease_to,
        move_in: m.move_in, move_out: m.move_out,
        deposit: m.deposit, balance: m.balance,
        email: m.email, phone: m.phone, status: m.status,
        space_label: m.space_label, sqft: m.sqft,
        non_revenue: Boolean(m.non_revenue),
        is_vacant: Boolean(c.vacant),
        section: m.section || "current", resident_id: m.resident_id || null,
        resident_id_source: m.resident_id_source || null, source_claim_conflict: conflict,
      };

      const inserted = await client.query(
        `insert into proposed_records
           (activation_id, property_id, module, target_type, natural_key,
             payload_json, normalized_json, evidence_refs, confidence,
             status, status_reason, import_source_row_id, inventory_identity_decision_id)
         values ($1,$2,'leasing','lease',$3,$4,$5,$6,$7,$8,$9,$10,$11)
         on conflict (import_source_row_id, target_type)
           where import_source_row_id is not null do nothing returning id`,
        [activation_id, property_id,
         //  ── THE NATURAL KEY IS THE RENTABLE POSITION, NOT THE UNIT ────
         //  This was the unit number alone, and the insert carries
         //  `on conflict (activation_id, target_type, natural_key) do
         //  nothing`. On a by-the-bed property every row of a unit
         //  therefore collided with the first one and was DROPPED — 160
         //  Skyline bed rows would have become 72 proposals, silently,
         //  with no refusal and no count to notice it by.
         //
         //  The key is the position the lease will attach to. Where the
         //  source names a room the key is unit + room; where it does not,
         //  the key stays the unit — which preserves the old behaviour for
         //  by-unit exports exactly.
         naturalKeyFor(m),
         JSON.stringify(m._raw), JSON.stringify(normalized),
         JSON.stringify(evidenceRefs), c.confidence,
         c.status, c.reason, ev ? ev.id : null,
         (resolvedByKey.get(homeIdentity.positionKey(m.unit_number,
           homeIdentity.canonicalSpaceLabel(m, prepared.basis), prepared.basis)) || {}).decision_id || null]);
      if (inserted.rowCount !== 1) throw refusal(409, "source_claim_already_staged", "This evidence row already has a claim. Nothing was staged twice.");
      if (c.vacant) counts.vacant++;
      counts[c.status] = (counts[c.status] || 0) + inserted.rowCount;
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
      source_format: parsed.format, source_sheet: parsed.sheet_name,
      receipt:
        `Read ${mapped.length} rows from ${artifact.original_filename}, dated ${asOf}. ` +
        `${counts.staged} ready, ${counts.needs_review || 0} need a look, ` +
        `${counts.blocked || 0} unassigned or blocked, ${counts.conflicted || 0} conflicting. Nothing is live yet.`,
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

    // Every lifecycle writer locks the setup before any proposal. Establishing
    // the opening position takes the same lock, so a published baseline cannot
    // race a confirmation and then change underneath its recorded counts.
    const activationRef = (await client.query(
      "select activation_id from proposed_records where id=$1", [proposed_id])).rows[0];
    if (!activationRef) throw refusal(404, "not_found", "That row is no longer on this setup.");
    const lockedActivation = (await client.query(
      "select id,status from activations where id=$1 for update", [activationRef.activation_id])).rows[0];
    if (!lockedActivation || lockedActivation.status !== "open") {
      throw refusal(409, "setup_not_open",
        "This setup is already established. Start a new setup to record a correction.");
    }

    const p = (await client.query(
      `select pr.*, a.deal_id, a.property_id as activation_property_id
         from proposed_records pr
         join activations a on a.id = pr.activation_id
         where pr.id = $1 for update of pr`, [proposed_id])).rows[0];
    if (!p) throw refusal(404, "not_found", "That row is no longer on this setup.");

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

    const n = p.normalized_json || {};
    const propertyId = p.property_id || p.activation_property_id;
    if (p.target_type !== "lease" || p.status === "rejected") {
      throw refusal(422, "not_a_confirmable_lease_claim", "This record is not an available lease claim.");
    }
    if (n.section === "future") {
      throw refusal(422, "future_claim_requires_review", "This source describes a future claim. It cannot establish current occupancy through Add.");
    }
    if (p.status === "conflicted" || n.source_claim_conflict) {
      throw refusal(409, "source_claim_conflict", "This source has conflicting claims for this position. Resolve the evidence before adding a lease.");
    }
    if (!n.is_vacant && !n.tenant_name) {
      throw refusal(422,"resident_identity_required","This source does not identify a resident or establish vacancy. Review the missing identity before adding the position.");
    }
    if (!n.is_vacant && n.tenant_name && n.actual_rent == null) {
      throw refusal(422, "actual_rent_required", "The source has no actual rent for this resident. Asking rent cannot establish their contract rent.");
    }

    // 1–2) Consume the exact durable attachment approved before the source
    // materialized.  Confirmation never resolves the immutable source label
    // again and never creates a replacement when the selected target moved.
    if (!p.inventory_identity_decision_id) throw refusal(409, "inventory_identity_review_required",
      "Review where this source home belongs before confirming occupancy or vacancy.");
    const identity = (await client.query(
      `select d.*,da.property_id as decision_property_id,dsa.sha256 as decision_artifact_sha256,
              csa.sha256 as claim_artifact_sha256
         from proposed_records d
         join activations da on da.id=d.activation_id
         join source_artifacts dsa on dsa.id=da.source_artifact_id
         join activations ca on ca.id=$2
         join source_artifacts csa on csa.id=ca.source_artifact_id
        where d.id=$1 and d.target_type='inventory_identity' and d.status='promoted'`,
      [p.inventory_identity_decision_id,p.activation_id])).rows[0];
    const claimedHash = identity && identity.payload_json && identity.payload_json.source
      && identity.payload_json.source.sha256;
    if (identity) {
      await client.query(`select id from units where id=$1 and property_id=$2 for update`,
        [identity.selected_unit_id, propertyId]);
      await client.query(`select id from spaces where id=$1 and unit_id=$2 for update`,
        [identity.selected_space_id, identity.selected_unit_id]);
    }
    // Re-read and hold authority after every lifecycle/target lock wait. A
    // proposal can sit for days, and the confirmer need not be its stager.
    const scope = await lockAndResolveActivationScope(client, {
      user_id, deal_intake_id: p.deal_id, property_id: propertyId,
    });
    const selected = identity && await homeIdentity.currentSelection(client, propertyId,
      identity.selected_unit_id, identity.selected_space_id);
    if (!identity || identity.decision_property_id !== propertyId
        || identity.decision_artifact_sha256 !== identity.claim_artifact_sha256
        || claimedHash !== identity.claim_artifact_sha256
        || !selected || selected.retired
        || identity.payload_json.confirmation_fingerprint !== selected.fingerprint) {
      throw refusal(409, "inventory_identity_target_changed",
        "The approved home, its parent hierarchy, retirement state, or source binding changed. Review the source identity again; nothing was confirmed.");
    }
    const unit = (await client.query(`select * from units where id=$1`, [identity.selected_unit_id])).rows[0];
    const space = (await client.query(`select * from spaces where id=$1 and unit_id=$2`,
      [identity.selected_space_id, identity.selected_unit_id])).rows[0];
    if (!unit || !space) throw refusal(409, "inventory_identity_target_changed",
      "The approved rentable home no longer has the reviewed hierarchy. Nothing was confirmed.");

    //  A vacant row establishes a resolved rentable position and no lease. That is a real
    //  position — a vacancy is part of an opening position, not an
    //  omission from it — and inventing a lease for it would be the
    //  wrong-confident value this whole path exists to prevent.
    if (n.is_vacant || !n.tenant_name) {
      // Vacancies and occupied claims resolve the same rentable position.
      const vacantSpace = space;

      if (vacantSpace) {
        await client.query("select id from spaces where id=$1 for update", [vacantSpace.id]);
        const competing = await competingOperativeLeases(client, {
          space_id: vacantSpace.id,
          start_date: n.start_date ?? null,
          end_date: n.end_date ?? null,
        });
        if (competing.length) {
          const where = `Unit ${n.unit_number}` +
            (vacantSpace.space_label ? ` · ${vacantSpace.space_label}` : "");
          await client.query(
            `update proposed_records
                set status='needs_review', status_reason=$2, updated_at=now()
              where id=$1`,
            [proposed_id,
             `${where} is reported empty by this source, but ${competing.length === 1
               ? "a lease in force says it is occupied"
               : `${competing.length} leases in force say it is occupied`}: ` +
             `${describeCompeting(competing)}. Spine has no basis to choose between the ` +
              `source and the lease record, so this row was not confirmed.`]);
          await client.query("commit");
          throw refusal(409, "vacancy_contradicted_by_operative_lease",
            `${where} is shown as empty on this rent roll, but Spine holds a lease in force ` +
            `for it. One of the two is out of date and Spine cannot tell which, so this row ` +
            `is marked for review — check whether the resident moved out, and retire or ` +
            `correct the lease if they did.`,
            { competing: competing.map((l) => ({
                lease_id: l.id, lease_status: l.lease_status,
                start_date: l.start_date, end_date: l.end_date,
                tenant_ids: l.tenant_ids || [] })) });
        }
      }

      // Close the same source-to-position lineage as occupied confirmation.
      if (p.import_source_row_id) {
        const attached = await client.query(
          `update import_source_rows
              set produced_unit_id=$2, produced_space_id=$3
            where id=$1
              and (produced_unit_id is null or produced_unit_id=$2)
              and (produced_space_id is null or produced_space_id=$3)`,
          [p.import_source_row_id, unit.id, space.id]);
        if (attached.rowCount !== 1) throw refusal(409, "source_home_attachment_changed",
          "This evidence row is attached to a different reviewed home. Nothing was confirmed.");
      }
      await client.query(
        `update proposed_records
            set status='promoted', promoted_record_id=null,
                confirmed_by=$2, confirmed_at=now(), updated_at=now(),
                status_reason='Confirmed as a vacant rentable position. No lease was created.'
          where id=$1`, [proposed_id, String(user_id)]);
      await client.query("commit");
      return { lease_id: null, vacant: true,
        receipt: `Unit ${n.unit_number}${space.space_label ? ` · ${space.space_label}` : ""} recorded as vacant.` };
    }

    //  ── 2c. ONE SPACE, ONE TENANCY ────────────────────────────────
    //  The wall executed_lease_service §2b has always held, held by this
    //  writer too: `leases` has only a plain index on space_id, so
    //  confirming a newer rent roll would otherwise insert a SECOND
    //  tenancy onto a bed that already had one.
    //
    //  THE WINDOW. A row that carries lease dates is compared on them. A
    //  row that carries NONE — a current tracker export names the resident
    //  and the rent and no term — is a dated OBSERVATION: it is compared
    //  from the source's as-of date forward, so a tenancy that ended
    //  before the observation is not a competitor and every right in force
    //  or pending from that date is. The observation never becomes a lease
    //  term; see the acceptance below.
    const actMeta = (await client.query(
      "select import_batch_id, source_as_of_date from activations where id=$1",
      [p.activation_id])).rows[0] || {};
    const sourceAsOf = actMeta.source_as_of_date
      ? new Date(actMeta.source_as_of_date).toISOString().slice(0, 10) : null;
    const undated = n.start_date == null && n.end_date == null;
    await client.query("select id from spaces where id=$1 for update", [space.id]);
    const competing = await competingOperativeLeases(client, {
      space_id: space.id,
      start_date: undated ? sourceAsOf : (n.start_date ?? null),
      end_date: undated ? null : (n.end_date ?? null),
    });
    //  The receipt names the CANONICAL home the reviewer mapped this row to,
    //  and the source's own label beside it when the two differ: a tracker
    //  says "101B", the inventory says "1417-101".
    const where = `Unit ${unit.unit_number}${space.space_label ? ` · ${space.space_label}` : ""}` +
      (n.unit_number && String(n.unit_number).trim() !== String(unit.unit_number).trim()
        ? ` (source "${n.unit_number}")` : "");
    //  The residents already holding a right on this home. They are offered
    //  to the human as identity candidates (recognition over re-entry); a
    //  competing right held by NOBODY resolvable is refused before any
    //  person could be minted for a row that will not be confirmed.
    const homeTenants = [...new Set(competing.flatMap((l) => (l.tenant_ids || []).map(String)))];
    const holdForOverlap = async () => {
      await client.query(
        `update proposed_records
            set status='needs_review', status_reason=$2, updated_at=now()
          where id=$1`,
        [proposed_id,
         `${where} already has ${competing.length === 1 ? "an operative lease" :
            `${competing.length} operative leases`} covering ` +
         `${asDate(undated ? sourceAsOf : n.start_date)} → ${asDate(undated ? null : n.end_date)}: ${describeCompeting(competing)}. ` +
          `This row was not confirmed and no lease was created.`]);
      await client.query("commit");
      throw refusal(409, "overlapping_operative_lease",
        `${where} already has a lease in force for these dates, so Spine will not put a ` +
        `second tenancy on it. This row is now marked for review — resolve the existing ` +
        `lease first (correct its dates, or retire it if it never happened), then confirm ` +
        `this one again.`,
        { competing: competing.map((l) => ({
            lease_id: l.id, lease_status: l.lease_status,
            start_date: l.start_date, end_date: l.end_date,
            tenant_ids: l.tenant_ids || [] })) });
    };
    if (competing.length && !homeTenants.length) await holdForOverlap();

    //  3) the person, RESOLVED through the one governed ingress boundary.
    //     The name ruling this carried is preserved verbatim inside
    //     person_ingress.js — never matched by name, because two residents
    //     share a name more often than a silent merge is ever noticed. What
    //     changes is who decides: this service no longer mints a human, it
    //     submits evidence. This IS the confirmation, so the authority is
    //     real and named, and the operator signs once. The home's current
    //     right-holders ride along as candidates a human may pick.
    const ingested = await personIngress.ingestPerson(client, {
      property_id: n.property_id || p.property_id || null,
      channel: "rent_roll",
      activation_id: p.activation_id,
      authority: { actor: String(user_id),
                   basis: "operator confirmation of an activation row" },
      evidence: {
        name: n.tenant_name,
        phone: n.phone ?? null,
        email: n.email ?? null,
        source_record_id: n.resident_id ?? null,
        source_system: "rent_roll",
        import_source_row_id: p.import_source_row_id || null,
        prior_produced_person_id: await require("../shared/snapshot_loader.js")
          .priorProducedPerson(client, propertyId, n.resident_id),
        home_tenant_person_ids: homeTenants,
        home_tenant_basis: homeTenants.length ? describeCompeting(competing) : null,
        import_batch_id: actMeta.import_batch_id || null,
        source: "activation",
        source_type: "rent_roll_ledger",
        source_as_of_date: actMeta.source_as_of_date || null,
        confidence: "extracted",
        lifecycle_status: "resident",
        leasing_stage: "resident",
        normalized: n,
      },
    });
    const person = ingested.person_id
      ? (await client.query(`select * from persons where id=$1`, [ingested.person_id])).rows[0]
      : null;
    if (!person) {
      await client.query(
        "update proposed_records set status='needs_review',status_reason=$2,updated_at=now() where id=$1",
        [proposed_id, homeTenants.length
          ? "This home already has a resident on record. Choose whether this row names that resident or a different person; no person or lease was invented."
          : "The resident's identity needs review. Historical candidate evidence is retained; no person or lease was invented."]);
      await client.query("commit");
      throw refusal(409, "resident_identity_requires_review", "Review the resident identity candidate before establishing this lease. No lease was created.");
    }

    //  ── 3b. ALREADY REPRESENTED ───────────────────────────────────
    //  The resolved person already holds a right on this home. The source
    //  row is evidence about THAT tenancy — it is tied to the lease and
    //  creates nothing. A pending lease stays pending: a later as-of date
    //  activates nothing and records no possession.
    const tied = competing.find((l) => (l.tenant_ids || []).map(String).includes(String(person.id)));
    if (tied) {
      if (p.import_source_row_id) {
        const attached = await client.query(
          `update import_source_rows
              set produced_person_id=$2, produced_lease_id=$3,
                  produced_unit_id=$4, produced_space_id=$5,
                  parse_note='current source row — recognised as an existing tenancy on this home'
            where id=$1
              and (produced_unit_id is null or produced_unit_id=$4)
              and (produced_space_id is null or produced_space_id=$5)`,
          [p.import_source_row_id, person.id, tied.id, unit.id, space.id]);
        if (attached.rowCount !== 1) throw refusal(409, "source_home_attachment_changed",
          "This evidence row is attached to a different reviewed home. Nothing was confirmed.");
      }
      await client.query(
        `update proposed_records
            set status='promoted', promoted_record_id=$2,
                confirmed_by=$3, confirmed_at=now(), updated_at=now(),
                status_reason=$4
          where id=$1`,
        [proposed_id, tied.id, String(user_id),
         `Already represented: ${n.tenant_name} holds lease ${tied.id} (${tied.lease_status}, ` +
         `${asDate(tied.start_date)} → ${asDate(tied.end_date)}) on ${where}. This row is evidence about that tenancy; no second lease was created` +
         (tied.lease_status === "pending" ? " and the pending lease was not activated." : ".")]);
      await client.query("commit");
      return { lease_id: tied.id, person_id: person.id, unit_id: unit.id, vacant: false,
        outcome: "tied_to_existing_lease", tied_lease_status: tied.lease_status,
        receipt: `${where} — ${n.tenant_name} is already on record here (lease ${tied.lease_status}). This source row now supports that tenancy; nothing new was created.`,
        authority_basis: scope.authority_basis };
    }
    //  A different person than every right-holder on this home: the source
    //  and the record disagree, and Spine does not choose.
    if (competing.length) await holdForOverlap();

    //  ── 3c. OCCUPANCY WITHOUT TERMS ───────────────────────────────
    //  A current source that names the resident and the rent but no lease
    //  dates establishes that the bed is OCCUPIED, not what the contract
    //  says. The existing opening-position reader already carries that
    //  rung (opening_claim_occupied: "contractual terms unknown"). Writing
    //  a lease with no dates would assert a term in force forever; a
    //  manufactured term from a cohort label would assert one nobody
    //  signed. Neither is done. The rent stays on the evidence row and the
    //  claim as the source reported it.
    if (undated) {
      if (p.import_source_row_id) {
        const attached = await client.query(
          `update import_source_rows
              set produced_person_id=$2, produced_unit_id=$3, produced_space_id=$4,
                  parse_note='current source row — accepted as current occupancy; contractual terms unknown (no lease dates in source)'
            where id=$1
              and (produced_unit_id is null or produced_unit_id=$3)
              and (produced_space_id is null or produced_space_id=$4)`,
          [p.import_source_row_id, person.id, unit.id, space.id]);
        if (attached.rowCount !== 1) throw refusal(409, "source_home_attachment_changed",
          "This evidence row is attached to a different reviewed home. Nothing was confirmed.");
      }
      await client.query(
        `update proposed_records
            set status='promoted', promoted_record_id=null,
                confirmed_by=$2, confirmed_at=now(), updated_at=now(),
                status_reason=$3
          where id=$1`,
        [proposed_id, String(user_id),
         `Accepted as current occupancy as of ${sourceAsOf || "the source date"}: ${n.tenant_name} on ${where}. ` +
         `Contractual terms unknown — this source carries no lease dates, so no lease was created; the reported rent is retained as evidence.`]);
      await client.query("commit");
      return { lease_id: null, person_id: person.id, unit_id: unit.id, vacant: false,
        outcome: "occupancy_accepted_terms_unknown",
        receipt: `${where} — ${n.tenant_name} recorded as occupying this home as of ${sourceAsOf || "the source date"}. No lease dates in the source, so no lease was created; terms stay unknown until a lease is established.`,
        authority_basis: scope.authority_basis };
    }

    //  4) the lease, stamped with the batch it came from (migration 046).
    const act = actMeta;
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
      [propertyId, space.id, [person.id], n.actual_rent,
       n.start_date ?? null, n.end_date ?? null, n.balance ?? 0,
       act.import_batch_id || null, act.source_as_of_date || null])).rows[0];

    //  5) CLOSE THE LINEAGE LOOP. `import_source_rows` has carried
    //     produced_person_id and produced_lease_id since migration 046 and
    //     the ledger importer has always written null into both, because
    //     it deliberately creates neither. This is the step that was
    //     missing: the evidence row now names every object it produced.
    if (p.import_source_row_id) {
      const attached = await client.query(
        `update import_source_rows
            set produced_person_id=$2, produced_lease_id=$3,
                produced_unit_id=$4, produced_space_id=$5,
                parse_note='current ledger row — confirmed into canonical truth'
          where id=$1
            and (produced_unit_id is null or produced_unit_id=$4)
            and (produced_space_id is null or produced_space_id=$5)`,
        [p.import_source_row_id, person ? person.id : null, lease.id, unit.id, space.id]);
      if (attached.rowCount !== 1) throw refusal(409, "source_home_attachment_changed",
        "This evidence row is attached to a different reviewed home. Nothing was confirmed.");
    }

    await client.query(
      `update proposed_records
          set status='promoted', promoted_record_id=$2,
              confirmed_by=$3, confirmed_at=now(), updated_at=now(), status_reason=null
        where id=$1`, [proposed_id, lease.id, String(user_id)]);

    await client.query("commit");
    return { lease_id: lease.id, person_id: person ? person.id : null, unit_id: unit.id, vacant: false,
      outcome: "lease_created",
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
  const client = await db.connect();
  try {
    await client.query("begin");
    const activationRef = (await client.query(
      "select activation_id from proposed_records where id=$1", [proposed_id])).rows[0];
    if (!activationRef) throw refusal(404, "not_found", "That row is no longer on this setup.");
    const lockedActivation = (await client.query(
      "select id,status from activations where id=$1 for update", [activationRef.activation_id])).rows[0];
    if (!lockedActivation || lockedActivation.status !== "open") {
      throw refusal(409, "setup_not_open",
        "This setup is already established. Start a new setup to record a correction.");
    }
    const p = (await client.query(
      `select pr.id,pr.status,pr.property_id,a.deal_id,a.property_id as ap
         from proposed_records pr join activations a on a.id=pr.activation_id
        where pr.id=$1 for update of pr`, [proposed_id])).rows[0];
    if (!p) throw refusal(404, "not_found", "That row is no longer on this setup.");
    if (p.status === "promoted") {
      throw refusal(409, "already_promoted",
        "This one is already part of the position and cannot be dismissed from here.");
    }
    await resolveActivationScope(client, {
      user_id, deal_intake_id: p.deal_id, property_id: p.property_id || p.ap });
    await client.query(
      `update proposed_records
          set status='rejected', status_reason=$2, confirmed_by=$3,
              confirmed_at=now(), updated_at=now()
        where id=$1`,
      [proposed_id, reason || "Dismissed by the operator.", String(user_id)]);
    await client.query("commit");
    return { receipt: "Left out of the position." };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
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
  const client = await db.connect();
  try {
    await client.query("begin");

    // The setup is the lifecycle mutex. Confirmation, rejection and identity
    // resolution all take this lock first, so this tally and the baseline it
    // records describe one stable proposal set.
    const act = (await client.query(
      "select * from activations where id=$1 for update", [activation_id])).rows[0];
    if (!act) throw refusal(404, "activation_not_found", "That setup is no longer on record.");
    if (act.status !== "open") {
      throw refusal(409, "setup_not_open",
        "This setup is already established. Start a new setup to record a correction.");
    }
    if (!act.import_batch_id) {
      throw refusal(409, "no_source_read_yet",
        "Upload a rent roll first — there is nothing to establish a position from.");
    }
    const scope = await resolveActivationScope(client, {
      user_id, deal_intake_id: act.deal_id, property_id: act.property_id });
    const tally = (await client.query(
      `select
         count(*) filter (where status='promoted')::int as established,
         count(*) filter (where status in ('staged','needs_review','blocked','conflicted'))::int as unresolved,
         count(*)::int as total
       from proposed_records where activation_id=$1 and target_type='lease'`,
      [activation_id])).rows[0];
    if (tally.established === 0) {
      throw refusal(409, "nothing_confirmed",
        "Nothing has been confirmed yet, so there is no position to establish.");
    }

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

// Resume the existing person-proposal confirmation mechanism inside Deal
// Setup. Candidates are displayed evidence; only an explicit human choice
// resolves identity. No person is matched by name, room or source code here.
async function resolveResidentIdentity(db, {user_id,proposed_id,action,person_id=null} = {}) {
  const client = await db.connect();
  try {
    await client.query("begin");
    const activationRef = (await client.query(
      "select activation_id from proposed_records where id=$1", [proposed_id])).rows[0];
    if (!activationRef) throw refusal(404,"not_found","That lease claim is not available.");
    const setup = (await client.query(
      "select id,deal_id,status from activations where id=$1 for update",
      [activationRef.activation_id])).rows[0];
    if (!setup || setup.status !== "open") throw refusal(409,"setup_not_open","This setup is already established. Start a new setup to record a correction.");
    const lease = (await client.query(`select * from proposed_records
      where id=$1 for update`,[proposed_id])).rows[0];
    if (!lease || lease.target_type !== "lease") throw refusal(404,"not_found","That lease claim is not available.");
    await resolveActivationScope(client,{user_id,deal_intake_id:setup.deal_id,property_id:lease.property_id});
    if (!["staged","needs_review"].includes(lease.status)) throw refusal(409,"lease_claim_not_available","This lease claim is not awaiting a resident identity decision.");
    const identity = (await client.query(`select * from proposed_records
      where activation_id=$1 and import_source_row_id=$2 and target_type='person' for update`,
      [lease.activation_id,lease.import_source_row_id])).rows[0];
    if (!identity || identity.status === "promoted") throw refusal(409,"identity_review_not_pending","There is no pending identity decision for this source row.");
    const candidates = (identity.payload_json && identity.payload_json.candidates) || [];
    if (!["resolved_existing","created"].includes(action)) throw refusal(400,"identity_choice_required","Choose a displayed resident candidate or explicitly identify this as a different resident.");
    if (action === "resolved_existing" && !candidates.some(candidate=>candidate.person_id === person_id)) {
      throw refusal(403,"identity_candidate_not_offered","That person is not one of this source row's identity candidates.");
    }
    const resolution = await personIngress.confirmPersonProposal(client,{
      proposal_id:identity.id,action,person_id,actor:String(user_id),
      authority:{actor:String(user_id),basis:"explicit resident identity review in Deal Setup"}});
    const n = lease.normalized_json || {};
    const ready = n.section !== "future" && n.unit_number && n.actual_rent != null && !n.source_claim_conflict;
    await client.query("update proposed_records set status=$2,status_reason=$3,updated_at=now() where id=$1",
      [proposed_id,ready ? "staged" : lease.status,ready ? "Resident identity resolved. Review and add the lease separately." : lease.status_reason]);
    await client.query("commit");
    return {person_id:resolution.person_id,receipt:"Resident identity resolved. No lease was established by this identity decision."};
  } catch(error) { await client.query("rollback").catch(()=>{}); throw error; }
  finally { client.release(); }
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
            pr.import_source_row_id, isr.row_index,
            (select jsonb_build_object('decision_id',d.id,'resolution_kind',d.resolution_kind,
                       'selected_unit_id',d.selected_unit_id,'selected_space_id',d.selected_space_id,
                       'source_claim',d.payload_json->'source_claim')
               from proposed_records d where d.id=pr.inventory_identity_decision_id) as home_identity_review,
            (select jsonb_build_object('status',ip.status,'candidates',ip.payload_json->'candidates',
               'person_id',ip.promoted_record_id,'resolution_kind',ip.resolution_kind)
             from proposed_records ip where ip.activation_id=pr.activation_id
               and ip.import_source_row_id=pr.import_source_row_id and ip.target_type='person') as identity_review
       from proposed_records pr
       left join import_source_rows isr on isr.id = pr.import_source_row_id
      where pr.activation_id = $1 and pr.target_type = 'lease'
      order by isr.row_index nulls last, pr.natural_key`, [activation_id])).rows;

  const counts = proposals.reduce((a, p) => { a[p.status] = (a[p.status] || 0) + 1; return a; }, {});
  const source_home_review_required = proposals.filter(p => !p.home_identity_review).length;
  const review_counts = proposals.reduce((a,p) => {
    const n = p.normalized_json || {};
    const future = n.section === "future";
    a.total++;
    a[future ? "future" : "current"]++;
    if (n.unit_number) a.assigned++;
    else a[future ? "unassigned_future" : "unassigned_current"]++;
    if (!future && !n.is_vacant && n.tenant_name && n.actual_rent == null) a.missing_actual_current_occupied++;
    if (future && n.unit_number && n.actual_rent == null) a.missing_actual_assigned_future++;
    return a;
  }, {total:0,current:0,future:0,assigned:0,unassigned_future:0,unassigned_current:0,missing_actual_current_occupied:0,missing_actual_assigned_future:0});

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
    proposals, counts, review_counts, source_home_review_required,
    opening_position: position, mapping,
    source: artifact ? {
      filename: artifact.original_filename, byte_size: artifact.byte_size,
      uploaded_at: artifact.uploaded_at, as_of: act.source_as_of_date,
      sha256: artifact.sha256,
    } : null,
  };
}

module.exports = {
  openActivation, previewRentRoll, restartSourceIdentityReview, ingestRentRoll, confirmProposal, rejectProposal,
  establishOpeningPosition, readActivation, resolveActivationScope, classify, refusal,
  resolveResidentIdentity,
};
