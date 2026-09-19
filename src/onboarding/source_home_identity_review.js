"use strict";
const { dateColumnToIso } = require("../shared/date_column");

const { createHash } = require("node:crypto");
const artifacts = require("./source_artifact_service.js");
const { parseRentRollSource } = require("./rent_roll_source_adapter.js");
const { mapRows, describePlan } = require("./rent_roll_field_map.js");
const { reconcileToSourceTotals, describeTotalsMismatch, TOTALS_MISMATCH } =
  require("./rent_roll_source_reconciliation.js");
const { leasingGrain, GRAIN_NOT_ESTABLISHED, GRAIN_REFUSAL_MESSAGE } =
  require("../tenancy/leasing_grain.js");
const { referencesTo } = require("../tenancy/inventory_materialization.js");

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function text(value) {
  return value == null ? "" : String(value).trim();
}

function folded(value) {
  return text(value).toLocaleLowerCase("en-US");
}

function sourceDate(value, refusal) {
  if (value == null || value === "") return null;
  //  ⚠ THIS COMPARISON REFUSED A RENT ROLL THAT WAS PERFECTLY CONSISTENT.
  //  The three dates compared below are the requested date (a string), the
  //  date inside the file (a string) and the RETAINED artifact's date — a
  //  `date` column, which node-pg hands back as a Date at LOCAL midnight.
  //  toISOString() read that back a day early on any host ahead of UTC, so
  //  the set held two values and the upload was refused with
  //  source_date_mismatch for a disagreement that did not exist. Witnessed
  //  on the owned server with TZ=Europe/Berlin.
  //
  //  The round trip below is UNAFFECTED and stays: it builds an explicit
  //  UTC instant from the rendered string, so it validates the shape
  //  without reintroducing a conversion.
  const out = value instanceof Date ? dateColumnToIso(value) : String(value);
  const parsed = new Date(out + "T00:00:00Z");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(out) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== out) {
    throw refusal(400, "invalid_source_date", "Use a valid rent-roll date in YYYY-MM-DD form.");
  }
  return out;
}

function rowClaims(mapped) {
  return JSON.stringify(mapped.map(row => Object.fromEntries(Object.keys(row)
    .filter(key => key !== "_raw" && row[key] != null).sort().map(key => [key, row[key]]))));
}

function positionKey(unitNumber, spaceLabel, basis) {
  return "home:" + digest([folded(unitNumber), basis === "bed" ? folded(spaceLabel) : "(whole unit)"]).slice(0, 24);
}

function canonicalSpaceLabel(row, basis) {
  return basis === "bed" ? text(row.space_label) : "(whole unit)";
}

async function prepareSource(db, {
  property_id, rows, source_artifact_id, source_as_of_date, leasing_basis, refusal,
} = {}) {
  if (!source_artifact_id) throw refusal(400, "source_artifact_required",
    "Upload the file itself before reviewing where its homes belong.");
  const artifact = await artifacts.describe(db, source_artifact_id);
  if (!artifact) throw refusal(404, "artifact_not_found", "That uploaded file is no longer on record.");
  if (artifact.scope_type !== "property" || artifact.scope_id !== property_id) {
    throw refusal(403, "artifact_out_of_scope", "That file was uploaded for something else. Upload it here to use it here.");
  }
  if (artifact.artifact_kind !== "rent_roll") {
    throw refusal(422, "artifact_kind_mismatch", "This source is not held as a rent roll.");
  }
  const held = await artifacts.read(db, source_artifact_id);
  if (!held || !Buffer.isBuffer(held.content) || held.content.length !== Number(artifact.byte_size)
      || createHash("sha256").update(held.content).digest("hex") !== artifact.sha256) {
    throw refusal(409, "source_integrity_mismatch", "The retained file could not be verified. Nothing was interpreted or established.");
  }
  let parsed;
  try {
    parsed = parseRentRollSource({ buffer: held.content, filename: artifact.original_filename, mime_type: artifact.mime_type });
  } catch (error) {
    throw refusal(422, error.code || "unsupported_rent_roll_source",
      "Spine could not interpret this rent-roll layout safely. The original file remains on record.");
  }
  const dates = [sourceDate(source_as_of_date, refusal), sourceDate(artifact.source_as_of_date, refusal),
    sourceDate(parsed.source_as_of_date, refusal)].filter(Boolean);
  if (new Set(dates).size > 1) throw refusal(409, "source_date_mismatch",
    "The requested date, retained source date and date inside the file disagree. Nothing was changed.");
  const asOf = dates[0];
  if (!asOf) throw refusal(400, "source_as_of_date_required",
    "What date is this rent roll as of? A position without a date cannot be compared to any other.");
  if (!parsed.rows.length) throw refusal(422, "no_rows", "No source records were found in the retained rent roll.");
  if (parsed.rows.length > 5000) throw refusal(413, "too_many_rows", "Spine reads up to 5,000 source records at a time.");
  const { plan, mapped } = mapRows(parsed.rows);
  if (rows !== undefined && (!Array.isArray(rows) || rowClaims(mapRows(rows).mapped) !== rowClaims(mapped))) {
    throw refusal(409, "source_rows_mismatch", "The submitted rows disagree with the retained file. Nothing was changed.");
  }
  if (!plan.mapped.unit_number) throw refusal(422, "no_unit_column",
    `Spine could not find a unit column in that file. It read these columns: ${plan.headers.slice(0, 12).join(", ")}${plan.headers.length > 12 ? "…" : ""}.`,
    { columns: plan.headers });
  //  ── DID WE READ THE FILE CORRECTLY? ──────────────────────────────
  //  Before anything can be established, reconcile what was extracted
  //  against the totals the report states about ITSELF. This proves
  //  extraction fidelity only — the footer comes out of the same Yardi
  //  report as the rows, so agreement is never evidence about the
  //  building. But a layout read wrongly does not land on the source's
  //  own totals by accident, and a mismatch means Spine has not
  //  represented the file, whatever each individual row looked like.
  //  A layout stating no totals is simply unchecked, not failed.
  const totals = reconcileToSourceTotals({
    mapped, declared: parsed.source_declared_totals });
  if (totals.mismatches.length) {
    throw refusal(409, TOTALS_MISMATCH, describeTotalsMismatch(totals),
      { source_totals: totals });
  }

  //  BACKSTOP. Callers resolve the grain before they get here; this refuses
  //  rather than silently reading an unestablished property as by-the-unit,
  //  which would key every positionKey() below to "(whole unit)".
  const basis = leasingGrain(leasing_basis);
  if (!basis) throw refusal(409, GRAIN_NOT_ESTABLISHED, GRAIN_REFUSAL_MESSAGE);
  return { artifact, asOf, parsed, plan, mapped, basis,
    //  A SOURCE ASSERTION plus the check it passed — carried so the review
    //  screen can show "we read your file and it adds up", never merged
    //  into anything canonical.
    source_totals: totals,
    ledgerRows: mapped.map(m => ({ ...m, _source_cells: m._raw })) };
}

async function inventoryRows(db, propertyId) {
  return (await db.query(
    `select u.id as unit_id,u.unit_number,
            (ir.id is not null) as retired,
            s.id as space_id,s.space_label,s.position_kind as space_kind
       from units u
       left join inventory_retirements ir on ir.unit_id=u.id and ir.reversed_at is null
       left join spaces s on s.unit_id=u.id
      where u.property_id=$1
      order by u.unit_number,u.id,s.space_label,s.id`, [propertyId])).rows;
}

function selectionFingerprint(row) {
  return digest({ kind: "existing", property_id: row.property_id, unit_id: row.unit_id,
    unit_number: row.unit_number, retired: Boolean(row.retired), space_id: row.space_id || null,
    space_label: row.space_label || null, space_kind: row.space_kind || null });
}

function newFingerprint(propertyId, group, collisions) {
  return digest({ kind: "new", property_id: propertyId,
    source_unit_number: group.source.unit_number,
    source_space_label: group.source.space_label || null,
    exact_collisions: collisions.map(r => ({ unit_id: r.unit_id, retired: Boolean(r.retired),
      space_id: r.space_id || null, space_label: r.space_label || null })) });
}

function childSetFingerprint(propertyId, unitRows, labels, held) {
  const first = unitRows[0];
  return digest({ kind: "existing_parent_new_children", property_id: propertyId,
    unit_id: first.unit_id, unit_number: first.unit_number, retired: Boolean(first.retired),
    approved_child_labels: [...labels].sort(),
    existing_spaces: unitRows.filter(r => r.space_id).map(r => ({ id:r.space_id,
      label:r.space_label, kind:r.space_kind })).sort((a,b)=>String(a.id).localeCompare(String(b.id))),
    placeholder_references: [...held].sort() });
}

function parentChoiceFingerprint(propertyId, unitRows) {
  const first = unitRows[0];
  return digest({ kind: "existing_parent_choice", property_id: propertyId,
    unit_id: first.unit_id, unit_number: first.unit_number, retired: Boolean(first.retired),
    existing_spaces: unitRows.filter(r => r.space_id).map(r => ({ id:r.space_id,
      label:r.space_label, kind:r.space_kind })).sort((a,b)=>String(a.id).localeCompare(String(b.id))),
  });
}

/*  Does the selected space carry the grain the review is being made at?
 *  bed basis:  a room, classified as a bed. A room classified 'unit' is the
 *              wrong-kind shape (an unconditional mapping-tool write); the
 *              classification is corrected by the governed mapping tool, not
 *              by relaxing this rule.
 *  unit basis: the whole-unit placeholder. Every unit's placeholder is
 *              created by the units trigger WITHOUT a position_kind (NULL),
 *              so an established unit-basis property never carried 'unit'
 *              on it; the label is the grain. Requiring 'unit' here refused
 *              every existing whole-unit home on the unit shape.  */
function grainMatches(basis, selected) {
  if (!selected || !selected.space_id) return false;
  if (basis === "bed") return selected.space_label !== "(whole unit)" && selected.space_kind === "bed";
  return selected.space_label === "(whole unit)" && (selected.space_kind === "unit" || selected.space_kind == null);
}

async function currentSelection(db, propertyId, unitId, spaceId) {
  const row = (await db.query(
    `select $1::uuid as property_id,u.id as unit_id,u.unit_number,
            (ir.id is not null) as retired,
            s.id as space_id,s.space_label,s.position_kind as space_kind
       from units u
       left join inventory_retirements ir on ir.unit_id=u.id and ir.reversed_at is null
       left join spaces s on s.id=$3 and s.unit_id=u.id
      where u.property_id=$1 and u.id=$2`, [propertyId, unitId, spaceId || null])).rows[0];
  if (!row || (spaceId && !row.space_id)) return null;
  return { ...row, fingerprint: selectionFingerprint(row) };
}

function buildGroups(prepared) {
  const groups = new Map();
  for (const row of prepared.mapped) {
    if (!text(row.unit_number)) continue;
    const spaceLabel = canonicalSpaceLabel(row, prepared.basis);
    const key = positionKey(row.unit_number, spaceLabel, prepared.basis);
    if (!groups.has(key)) groups.set(key, {
      key,
      source: { unit_number: text(row.unit_number), space_label: spaceLabel || null },
      row_indices: [], current_row_indices: [], future_row_indices: [],
    });
    const group = groups.get(key);
    group.row_indices.push(Number(row.row_index));
    group[row.section === "future" ? "future_row_indices" : "current_row_indices"].push(Number(row.row_index));
  }
  return [...groups.values()];
}

async function planReview(db, { property_id, activation_id, prepared } = {}) {
  const inventory = await inventoryRows(db, property_id);
  const current = inventory.filter(r => !r.retired);
  const byUnit = new Map();
  for (const row of inventory) {
    const key = folded(row.unit_number);
    if (!byUnit.has(key)) byUnit.set(key, []);
    byUnit.get(key).push(row);
  }
  const prior = (await db.query(
    `select pr.id,pr.selected_unit_id,pr.selected_space_id,pr.payload_json,pr.normalized_json,pr.confirmed_at,
            sa.sha256,a.id as activation_id
       from proposed_records pr
       join activations a on a.id=pr.activation_id
       join source_artifacts sa on sa.id=a.source_artifact_id
      where pr.property_id=$1 and pr.target_type='inventory_identity'
        and pr.status='promoted' and sa.sha256=$2
      order by pr.confirmed_at desc`, [property_id, prepared.artifact.sha256])).rows;
  const groups = buildGroups(prepared);
  const priorByKey = new Map();
  for (const row of prior) {
    const key = row.normalized_json && row.normalized_json.identity_key;
    if (!key) continue;
    if (!priorByKey.has(key)) { priorByKey.set(key, row); continue; } // query is newest first
    const latest = priorByKey.get(key);
    if (new Date(latest.confirmed_at).getTime() === new Date(row.confirmed_at).getTime()
        && (latest.selected_unit_id !== row.selected_unit_id || latest.selected_space_id !== row.selected_space_id)) {
      priorByKey.set(key, { ambiguous: true, confirmed_at: latest.confirmed_at });
    }
  }
  const sourceLabelsByUnit = new Map();
  for (const group of groups.filter(g => g.current_row_indices.length && g.source.space_label)) {
    const key = folded(group.source.unit_number);
    if (!sourceLabelsByUnit.has(key)) sourceLabelsByUnit.set(key, []);
    const labels = sourceLabelsByUnit.get(key);
    if (!labels.some(label => folded(label) === folded(group.source.space_label))) labels.push(group.source.space_label);
  }
  const childPlans = new Map();
  for (const [unitKey, labels] of sourceLabelsByUnit) {
    const exactCurrent = (byUnit.get(unitKey) || []).filter(r => !r.retired);
    const unitIds = [...new Set(exactCurrent.map(r => r.unit_id))];
    if (unitIds.length !== 1) continue;
    const unitRows = exactCurrent.filter(r => r.unit_id === unitIds[0]);
    const placeholder = unitRows.find(r => r.space_label === "(whole unit)") || null;
    const held = placeholder ? await referencesTo(db, placeholder.space_id) : [];
    const existingLabels = unitRows.filter(r=>r.space_id).map(r=>folded(r.space_label));
    const desiredLabels = labels.map(folded);
    const outsideSet = existingLabels.filter(label => label !== folded("(whole unit)") && !desiredLabels.includes(label));
    childPlans.set(unitKey, {
      unit_id: unitIds[0], unit_label: unitRows[0].unit_number, labels,
      placeholder_space_id: placeholder && placeholder.space_id,
      placeholder_pristine: Boolean(placeholder && held.length === 0),
      placeholder_references: held, outside_source_set: outsideSet,
      fingerprint: childSetFingerprint(property_id, unitRows, labels, held),
      can_materialize: held.length === 0 && outsideSet.length === 0,
    });
  }
  const availableUnits = [];
  const seenUnits = new Set();
  for (const row of current) {
    if (seenUnits.has(row.unit_id)) continue;
    seenUnits.add(row.unit_id);
    const spaces = current.filter(s => s.unit_id === row.unit_id && s.space_id).map(s => ({
      id: s.space_id, label: s.space_label, kind: s.space_kind,
      fingerprint: selectionFingerprint({ ...s, property_id }),
    }));
    const unitRows = current.filter(s => s.unit_id === row.unit_id);
    const parentSelectable = spaces.length === 1 && spaces[0].label === "(whole unit)";
    availableUnits.push({ id: row.unit_id, label: row.unit_number, spaces,
      parent_choice_fingerprint: parentSelectable ? parentChoiceFingerprint(property_id, unitRows) : null,
      parent_choice_note: parentSelectable
        ? "This current parent has only its whole-unit position. Its pristine state will be rechecked before approved source rooms are applied."
        : null });
  }
  for (const group of groups) {
    const exact = byUnit.get(folded(group.source.unit_number)) || [];
    const exactCurrent = exact.filter(r => !r.retired);
    const exactRetired = exact.filter(r => r.retired);
    const matching = exactCurrent.filter(r => r.space_id &&
      folded(r.space_label) === folded(group.source.space_label));
    const reusable = priorByKey.get(group.key) || null;
    const childPlan = childPlans.get(folded(group.source.unit_number)) || null;
    group.status = group.current_row_indices.length ? "needs_identity_review" : "future_evidence_only";
    group.exact_candidates = matching.map(r => ({ unit_id: r.unit_id, unit_label: r.unit_number,
      space_id: r.space_id, space_label: r.space_label,
      fingerprint: selectionFingerprint({ ...r, property_id }) }));
    group.current_unit_candidates = [...new Map(exactCurrent.map(r => [r.unit_id,
      { unit_id: r.unit_id, unit_label: r.unit_number }])).values()];
    group.retired_candidates = exactRetired.map(r => ({ unit_id: r.unit_id, unit_label: r.unit_number,
      space_id: r.space_id, space_label: r.space_label }));
    group.new_fingerprint = newFingerprint(property_id, group, exact);
    group.suggested_decision = null;
    if (group.current_row_indices.length && reusable && !reusable.ambiguous) {
      const selected = await currentSelection(db, property_id, reusable.selected_unit_id, reusable.selected_space_id);
      const claimedHash = reusable.payload_json && reusable.payload_json.source && reusable.payload_json.source.sha256;
      const confirmation = reusable.payload_json && reusable.payload_json.confirmation_fingerprint;
      const priorBasis = reusable.normalized_json && reusable.normalized_json.leasing_basis;
      if (selected && !selected.retired && claimedHash === prepared.artifact.sha256
          && reusable.normalized_json.identity_key === group.key && priorBasis === prepared.basis
          && confirmation === selected.fingerprint && grainMatches(prepared.basis, selected)) {
        group.suggested_decision = { action: "reuse", decision_id: reusable.id, fingerprint: selected.fingerprint };
      }
    }
    if (reusable && reusable.ambiguous) group.status = "ambiguous_prior_review";
    if (!(reusable && reusable.ambiguous) && !group.suggested_decision && group.current_row_indices.length && matching.length === 1
        && grainMatches(prepared.basis, { ...matching[0], fingerprint:null })) {
      group.suggested_decision = { action: "select_existing", unit_id: matching[0].unit_id,
        space_id: matching[0].space_id, fingerprint: selectionFingerprint({ ...matching[0], property_id }) };
    }
    if (!(reusable && reusable.ambiguous) && !group.suggested_decision && group.current_row_indices.length && current.length === 0 && !exactRetired.length
        && group.source.space_label) {
      group.suggested_decision = { action: "create_new", fingerprint: group.new_fingerprint };
    }
    group.existing_parent_new_children = childPlan;
    if (!(reusable && reusable.ambiguous) && !group.suggested_decision && group.current_row_indices.length && childPlan
        && childPlan.can_materialize && prepared.basis === "bed") {
      group.suggested_decision = { action: "create_children", unit_id: childPlan.unit_id,
        fingerprint: childPlan.fingerprint };
      group.status = "existing_parent_new_children";
    }
    if (!group.source.space_label) group.status = "ambiguous_missing_space";
    else if (exactRetired.length && exactCurrent.length === 0) group.status = "retired_only";
    else if (matching.length > 1) group.status = "ambiguous_exact_match";
    else if (reusable && reusable.ambiguous) group.status = "ambiguous_prior_review";
    else if (childPlan && !childPlan.can_materialize && group.current_row_indices.length) group.status = "existing_parent_needs_review";
    else if (!group.suggested_decision && group.current_row_indices.length) group.status = "unfamiliar";
  }
  return {
    source: { artifact_id: prepared.artifact.id, filename: prepared.artifact.original_filename,
      sha256: prepared.artifact.sha256, as_of: prepared.asOf, format: prepared.parsed.format,
      sheet: prepared.parsed.sheet_name },
    leasing_basis: prepared.basis,
    source_token: digest({ activation_id, property_id, artifact_id: prepared.artifact.id,
      sha256: prepared.artifact.sha256, as_of: prepared.asOf, basis: prepared.basis,
      identities: groups.map(g => [g.key, g.row_indices]) }),
    mapping: describePlan(prepared.plan), rows_read: prepared.mapped.length,
    identities: groups, available_units: availableUnits,
    counts: groups.reduce((out, g) => { out[g.status] = (out[g.status] || 0) + 1; return out; }, {}),
  };
}

async function resolveDecisions(db, { property_id, activation_id, prepared, source_token, decisions, refusal } = {}) {
  const plan = await planReview(db, { property_id, activation_id, prepared });
  if (!source_token || source_token !== plan.source_token) throw refusal(409, "source_review_stale",
    "The reviewed source or leasing basis changed. Review where its homes belong again; nothing was changed.");
  const supplied = new Map((Array.isArray(decisions) ? decisions : []).map(d => [d && d.key, d]));
  const resolved = new Map();
  for (const group of plan.identities) {
    if (!group.current_row_indices.length) continue;
    const decision = supplied.get(group.key);
    if (!decision) throw refusal(422, "inventory_identity_decision_required",
      `Choose where source home ${group.source.unit_number}${group.source.space_label ? ` · ${group.source.space_label}` : ""} belongs.`);
    if (decision.action === "create_new") {
      if (!group.source.space_label || decision.fingerprint !== group.new_fingerprint) throw refusal(409, "inventory_target_changed",
        "The reviewed new-home collision state changed. Review this source identity again; nothing was changed.");
      if (group.current_unit_candidates.length || group.retired_candidates.length) throw refusal(409, "new_inventory_collision",
        "This source unit now has an exact current or retired inventory candidate. Choose the current canonical home or review the retired representation; a duplicate was not created.");
      resolved.set(group.key, { group, action: "create_new", review_fingerprint: decision.fingerprint });
      continue;
    }
    if (decision.action === "select_existing") {
      const selected = await currentSelection(db, property_id, decision.unit_id, decision.space_id);
      if (!selected || selected.retired || !grainMatches(prepared.basis, selected)
          || decision.fingerprint !== selected.fingerprint) throw refusal(409, "inventory_target_changed",
        "The selected home, its parent, or retirement state changed. Review this source identity again; nothing was changed.");
      resolved.set(group.key, { group, action: "select_existing", unit_id: selected.unit_id,
        space_id: selected.space_id, selected, review_fingerprint: decision.fingerprint });
      continue;
    }
    if (decision.action === "create_children") {
      let child = group.existing_parent_new_children;
      if (!child || decision.unit_id !== child.unit_id || decision.fingerprint !== child.fingerprint) {
        const unit = plan.available_units.find(candidate => candidate.id === decision.unit_id);
        const labels = plan.identities.filter(candidate => candidate.current_row_indices.length
          && folded(candidate.source.unit_number) === folded(group.source.unit_number))
          .map(candidate => candidate.source.space_label).filter(Boolean);
        const rows = (await inventoryRows(db, property_id)).filter(candidate => candidate.unit_id === decision.unit_id && !candidate.retired);
        const placeholder = rows.find(candidate => candidate.space_label === "(whole unit)") || null;
        const held = placeholder ? await referencesTo(db, placeholder.space_id) : [];
        const outsideSet = rows.filter(candidate => candidate.space_id && candidate.space_label !== "(whole unit)");
        if (unit && unit.parent_choice_fingerprint === decision.fingerprint && rows.length
            && placeholder && !held.length && !outsideSet.length) {
          child = { unit_id:decision.unit_id, unit_label:rows[0].unit_number, labels,
            placeholder_space_id:placeholder.space_id, placeholder_pristine:true,
            placeholder_references:[], outside_source_set:[], can_materialize:true,
            fingerprint:decision.fingerprint, explicitly_selected_parent:true };
        }
      }
      if (!child || !child.can_materialize || decision.unit_id !== child.unit_id
          || decision.fingerprint !== child.fingerprint) throw refusal(409, "inventory_target_changed",
        "The reviewed parent, complete room set, or placeholder state changed. Review this source identity again; nothing was changed.");
      resolved.set(group.key, { group, action: "create_children", unit_id: child.unit_id,
        child_plan: child, review_fingerprint: child.fingerprint });
      continue;
    }
    if (decision.action === "reuse") {
      const latest = group.suggested_decision;
      if (!latest || latest.action !== "reuse" || latest.decision_id !== decision.decision_id) {
        throw refusal(409, "reused_inventory_review_superseded",
          "A newer reviewed mapping exists for these exact source bytes. Review and use the current mapping; nothing was changed.");
      }
      const prior = (await db.query(
        `select pr.*,a.property_id as decision_property_id,sa.sha256
           from proposed_records pr join activations a on a.id=pr.activation_id
           join source_artifacts sa on sa.id=a.source_artifact_id
          where pr.id=$1 and pr.target_type='inventory_identity' and pr.status='promoted'`,
        [decision.decision_id])).rows[0];
      const claimedHash = prior && prior.payload_json && prior.payload_json.source && prior.payload_json.source.sha256;
      const selected = prior && await currentSelection(db, property_id, prior.selected_unit_id, prior.selected_space_id);
      if (!prior || prior.decision_property_id !== property_id || prior.sha256 !== prepared.artifact.sha256
          || claimedHash !== prepared.artifact.sha256 || !selected || selected.retired
          || prior.normalized_json.identity_key !== group.key
          || prior.normalized_json.leasing_basis !== prepared.basis
          || !grainMatches(prepared.basis, selected)
          || prior.payload_json.confirmation_fingerprint !== selected.fingerprint
          || decision.fingerprint !== selected.fingerprint) {
        throw refusal(409, "reused_inventory_review_stale",
          "The earlier reviewed mapping no longer names the same current home for these exact source bytes. Review it again; nothing was changed.");
      }
      resolved.set(group.key, { group, action: "reuse", unit_id: selected.unit_id,
        space_id: selected.space_id, selected, decision_id: prior.id,
        review_fingerprint: selected.fingerprint });
      continue;
    }
    throw refusal(422, "inventory_identity_decision_invalid", "Choose an existing home or approve a new one from this review.");
  }
  return { plan, resolved };
}

module.exports = {
  prepareSource, planReview, resolveDecisions, currentSelection,
  positionKey, canonicalSpaceLabel, selectionFingerprint, digest,
};
