// ════════════════════════════════════════════════════════════════════
//  inventory_materialization.js — TURNING A UNIT INTO ITS REAL RENTABLE
//  POSITIONS, ONCE, WITHOUT MANUFACTURING INVENTORY.
//
//  ── THE PROBLEM THIS EXISTS TO SOLVE ────────────────────────────────
//  `trg_unit_space` fires AFTER INSERT ON units and inserts one
//  '(whole unit)' space. The INVARIANT is correct — every unit has at
//  least one rentable space, so a lease always has somewhere to attach.
//  The IMPLEMENTATION assumes the unit IS the rentable position, which is
//  true for a by-unit property and false for every by-bed one.
//
//  Loading real Skyline exposed the cost: 72 units each got a phantom
//  whole-unit space beside their real Room1/Room2/Room3, so the property
//  read as 232 rentable positions instead of 160 and 72 beds nobody could
//  lease reported as VACANT. Every leasable denominator — occupancy,
//  availability, future rent roll — was computed over them.
//
//  ── THE RULE (owner ruling, 2026-08-15) ─────────────────────────────
//      The auto-created '(whole unit)' space is PROVISIONAL until the
//      inventory grain is known. When grain arrives, the canonical writer
//      may CONSUME that pristine placeholder as the first real position
//      and create the remaining ones.
//
//  This is a general canonical inventory-materialization rule, not a
//  Skyline patch. A by-unit property resolves to exactly one rentable
//  space per unit; a by-bed property to exactly as many as the source
//  says exist. Never more.
//
//  ── PRISTINE IS A STRICT TEST, AND IT IS ASKED OF THE CATALOG ───────
//  Consuming a placeholder means RENAMING a row. That is only safe while
//  nothing depends on it meaning what it currently means. So a placeholder
//  is pristine only if NOTHING references it — and the set of things that
//  can reference a space is read from pg_constraint at runtime, never from
//  a list maintained here.
//
//  A hand-maintained list would be wrong the first time somebody adds a
//  table with a space_id, and it would be wrong SILENTLY: the guard would
//  still pass, and a renamed space would quietly re-point a lease, an
//  executed lease record or a utility service point at a different
//  rentable position. Ten tables reference spaces today. The eleventh must
//  not require anyone to remember this file.
//
//  If the placeholder is not pristine, this REFUSES. It does not create
//  the beds beside it and it does not delete anything: a unit that already
//  carries history at whole-unit grain is a real conversion question for a
//  human, not something an importer may decide.
//
//  CLASSIFICATION: Class 1 — permanent product primitive.
//  TRANSACTION: the CALLER owns begin/commit. This writes on the client it
//  is given and never commits, matching tenancy_anchor_service.
// ════════════════════════════════════════════════════════════════════

"use strict";

const PLACEHOLDER_LABEL = "(whole unit)";

function err(code, message, extra) {
  const e = new Error(message);
  e.code = code;
  e.httpStatus = extra && extra.httpStatus ? extra.httpStatus : 409;
  e.publicMessage = message;
  if (extra) Object.assign(e, extra);
  return e;
}

/*  Every (table, column) that carries a foreign key to spaces, read from
 *  the catalog. Cached per-process: the schema does not change under a
 *  running server, and this would otherwise run once per unit.  */
let _referencesCache = null;
async function spaceReferences(client) {
  if (_referencesCache) return _referencesCache;
  const { rows } = await client.query(
    `select c.conrelid::regclass::text as table_name, a.attname as column_name
       from pg_constraint c
       join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
      where c.contype = 'f' and c.confrelid = 'spaces'::regclass
      order by 1, 2`
  );
  _referencesCache = rows.map((r) => ({ table: r.table_name, column: r.column_name }));
  return _referencesCache;
}

/*  Is this space referenced by anything at all? Returns the list of
 *  references found, so a refusal can NAME what is holding it rather than
 *  saying "not pristine" and making a human go looking.  */
async function referencesTo(client, spaceId) {
  const refs = await spaceReferences(client);
  const found = [];
  for (const { table, column } of refs) {
    const { rows } = await client.query(
      `select count(*)::int as n from ${table} where ${column} = $1`, [spaceId]);
    if (rows[0].n > 0) found.push(`${table}.${column} (${rows[0].n})`);
  }
  return found;
}

/*  materializeRentableSpaces — make this unit's rentable positions match
 *  the labels the SOURCE says exist.
 *
 *    client   an open pg client inside the caller's transaction
 *    unit_id  the unit
 *    labels   ordered rentable-position labels, e.g. ['Room1','Room2'].
 *             For a by-unit property pass ['(whole unit)'] (or []) —
 *             the placeholder is then already correct and is kept as-is.
 *    kind     'bed' | 'unit' — written to spaces.position_kind
 *    use_type optional governed use, e.g. 'residential'
 *
 *  Idempotent. Running it twice with the same labels creates nothing the
 *  second time, because onboarding gets re-run and a second run must not
 *  double the building.
 */
async function materializeRentableSpaces(client, {
  unit_id, labels = [], kind = "bed", use_type = null, stamp = null,
} = {}) {
  if (!client || typeof client.query !== "function") {
    throw new Error("materializeRentableSpaces requires a database client");
  }
  if (!unit_id) throw new Error("materializeRentableSpaces requires unit_id");

  const wanted = [...new Set(labels.map((l) => String(l == null ? "" : l).trim()).filter(Boolean))];
  if (!wanted.length) wanted.push(PLACEHOLDER_LABEL);

  const existing = (await client.query(
    `select id, space_label from spaces where unit_id = $1 order by created_at, id`,
    [unit_id])).rows;

  const byLabel = new Map(existing.map((s) => [s.space_label, s]));
  const receipt = { unit_id, wanted, consumed_placeholder: null, created: [], kept: [], total: 0 };

  //  ── CONSUME THE PROVISIONAL PLACEHOLDER, IF THAT IS WHAT IT IS ────
  //  Only when the source's grain does NOT already include a whole-unit
  //  position. A by-unit property wants the placeholder to stay exactly as
  //  it is, so there is nothing to consume and nothing to check.
  const placeholder = byLabel.get(PLACEHOLDER_LABEL);
  const wantsPlaceholder = wanted.includes(PLACEHOLDER_LABEL);

  if (placeholder && !wantsPlaceholder) {
    const held = await referencesTo(client, placeholder.id);
    if (held.length) {
      //  REFUSE. Renaming this row would silently re-point whatever holds
      //  it at a different rentable position.
      throw err("PLACEHOLDER_NOT_PRISTINE",
        `Unit already has history recorded at whole-unit grain, so its ` +
        `'${PLACEHOLDER_LABEL}' position cannot become a bed. Held by: ${held.join(", ")}.`,
        { unit_id, space_id: placeholder.id, held });
    }
    //  Pristine: it becomes the FIRST source-named position. The row's
    //  identity is preserved deliberately — nothing referenced it, so
    //  nothing moves, and the unit never passes through a moment with
    //  zero spaces (which is what the invariant exists to prevent).
    const firstLabel = wanted[0];
    if (!byLabel.has(firstLabel)) {
      await client.query(
        `update spaces set space_label = $2, position_kind = $3, use_type = coalesce($4, use_type)
          where id = $1`, [placeholder.id, firstLabel, kind, use_type]);
      byLabel.delete(PLACEHOLDER_LABEL);
      byLabel.set(firstLabel, { id: placeholder.id, space_label: firstLabel });
      receipt.consumed_placeholder = { space_id: placeholder.id, became: firstLabel };
    } else {
      //  The first label already exists as its own row (a re-run after a
      //  partial load). The placeholder is then surplus, and surplus
      //  UNREFERENCED inventory is deleted rather than left to read as a
      //  vacant bed — that is the whole defect this module removes.
      await client.query(`delete from spaces where id = $1`, [placeholder.id]);
      receipt.consumed_placeholder = { space_id: placeholder.id, became: null, removed: true };
    }
  }

  //  ── CREATE WHAT IS STILL MISSING ──────────────────────────────────
  for (const label of wanted) {
    if (byLabel.has(label)) { receipt.kept.push(label); continue; }
    const cols = ["unit_id", "space_label", "position_kind"];
    const vals = [unit_id, label, kind];
    if (use_type) { cols.push("use_type"); vals.push(use_type); }
    if (stamp && stamp.import_batch_id) {
      cols.push("import_batch_id", "source_type", "source_as_of_date", "confidence");
      vals.push(stamp.import_batch_id, stamp.source_type || null,
                stamp.source_as_of_date || null, stamp.confidence || null);
    }
    const holes = vals.map((_, i) => `$${i + 1}`).join(",");
    const ins = await client.query(
      `insert into spaces (${cols.join(",")}) values (${holes}) returning id`, vals);
    byLabel.set(label, { id: ins.rows[0].id, space_label: label });
    receipt.created.push(label);
  }

  //  ── ALIGN THE GRAIN ON POSITIONS THAT ALREADY EXISTED ─────────────
  //  A re-run must not leave half the beds classified and half not.
  await client.query(
    `update spaces set position_kind = $2, use_type = coalesce($3, use_type)
      where unit_id = $1 and space_label = any($4::text[])`,
    [unit_id, kind, use_type, wanted]);

  const total = (await client.query(
    `select count(*)::int as n from spaces where unit_id = $1`, [unit_id])).rows[0].n;
  receipt.total = total;

  //  ── THE INVARIANT THIS MODULE PROMISES ────────────────────────────
  //  As many rentable positions as the source says exist. Not one more.
  //  Asserted here rather than trusted, because the phantom bed is exactly
  //  the kind of surplus that reads as real inventory downstream.
  if (total !== wanted.length) {
    const labelsNow = (await client.query(
      `select space_label from spaces where unit_id = $1 order by space_label`, [unit_id]
    )).rows.map((r) => r.space_label);
    throw err("INVENTORY_COUNT_MISMATCH",
      `Unit should have ${wanted.length} rentable positions (${wanted.join(", ")}) ` +
      `but has ${total} (${labelsNow.join(", ")}).`,
      { unit_id, expected: wanted, actual: labelsNow });
  }

  return receipt;
}

module.exports = { materializeRentableSpaces, PLACEHOLDER_LABEL, referencesTo, spaceReferences };
