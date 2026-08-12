/* ════════════════════════════════════════════════════════════════════
   legal_entity_service.js — THE canonical writer for legal entities and
   their relationship to properties.

   ── IT IS NOT A TAX MODULE, AND IT IS NOT DEAL SETUP ────────────────
   It records one fact: this legal entity exists, and it is related to
   this property in this named way, from this date, on this evidence.

   Taxes needs it because BIRT and NPT belong to the TAXPAYER rather than
   the property. Ownership and debt work will need the same object. That
   is why it lives here rather than inside either of them — a
   `tax_taxpayers` table would be two tables for one real-world thing.

   ── WHAT IT REFUSES TO GROW ─────────────────────────────────────────
   No percentages, no waterfalls, no cap table, no beneficial ownership,
   no signatures, no org-chart ingestion. Those belong to the later
   onboarding stage CLAUDE.md reserves, and arriving early and
   half-built is how a reserved name gets spent.

   No EIN and no city tax account number either. A tax identifier is how
   ONE JURISDICTION names this entity — the same distinction migration
   161 draws between a policy number and a coverage's identity. Those
   live in Taxes until source work proves otherwise.

   CLASS 1 — permanent product primitive.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const ENTITY_TYPES = Object.freeze([
  "llc", "lp", "llp", "corporation", "s_corporation",
  "trust", "partnership", "individual", "other",
]);

//  An entity that OWNS a property and one that OPERATES it are different
//  facts with different consequences, and a tax obligation may attach to
//  one and not the other. An unnamed edge makes every later reader guess.
const RELATIONSHIP_TYPES = Object.freeze(["owner", "operating_entity", "other"]);

/*  pg returns a `date` column as a JS Date at LOCAL midnight, so
 *  String(d).slice(0,10) yields "Mon Jan 01" — which is what this read
 *  emitted before a proof caught it, and it would have gone out over the
 *  API as a date.
 *
 *  Built from local components rather than toISOString(). The container
 *  is UTC today so both agree, but toISOString() on a local-midnight Date
 *  shifts the DAY for any deployment west of UTC, and a tax due date off
 *  by one is not a rounding error. Recorded, not chased: the insurance
 *  reads use the toISOString form and are correct while the runtime is
 *  UTC — worth converging when something touches them.
 */
function isoDay(d) {
  if (!d) return null;
  if (typeof d === "string") return d.slice(0, 10);
  if (!(d instanceof Date)) return null;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function entityError(code, message, extra = {}) {
  const e = new Error(message); e.code = code; Object.assign(e, extra); return e;
}

function requireProvenance(source_artifact_id, provenance_note, what) {
  if (!source_artifact_id && !(provenance_note && String(provenance_note).trim())) {
    throw entityError("PROVENANCE_REQUIRED",
      `${what} requires provenance: a source document, or a note recording where ` +
      "this came from. Without one it cannot explain itself later.");
  }
}

/*  ── ESTABLISH A LEGAL ENTITY ───────────────────────────────────────
 *  The name on the formation document. Not a display name.
 */
async function establishEntity(client, {
  legal_name, entity_type = null, formation_jurisdiction = null,
  source_artifact_id = null, provenance_note = null, user_id,
} = {}) {
  if (!legal_name || !String(legal_name).trim()) {
    throw entityError("BAD_INPUT", "legal_name is required");
  }
  if (entity_type !== null && !ENTITY_TYPES.includes(entity_type)) {
    throw entityError("BAD_INPUT", `entity_type must be one of ${ENTITY_TYPES.join(", ")}`);
  }
  if (!user_id) throw entityError("BAD_INPUT", "user_id is required");
  requireProvenance(source_artifact_id, provenance_note, "a legal entity");

  const { rows } = await client.query(
    `insert into legal_entities
       (legal_name, entity_type, formation_jurisdiction,
        source_artifact_id, provenance_note, recorded_by_user_id)
     values ($1,$2,$3,$4,$5,$6) returning *`,
    [String(legal_name).trim(), entity_type, formation_jurisdiction,
     source_artifact_id, provenance_note, user_id]);
  return rows[0];
}

/*  ── RELATE IT TO A PROPERTY ────────────────────────────────────────
 *  Named, and dated. A relationship that ends is CLOSED rather than
 *  deleted, so last year's tax position stays explainable after this
 *  year's transfer.
 */
async function relateToProperty(client, {
  legal_entity_id, property_id, relationship_type,
  effective_from, effective_to = null,
  source_artifact_id = null, provenance_note = null, user_id,
} = {}) {
  if (!legal_entity_id || !property_id) {
    throw entityError("BAD_INPUT", "legal_entity_id and property_id are required");
  }
  if (!RELATIONSHIP_TYPES.includes(relationship_type)) {
    throw entityError("BAD_INPUT",
      `relationship_type must be one of ${RELATIONSHIP_TYPES.join(", ")}`);
  }
  if (!effective_from) throw entityError("BAD_INPUT", "effective_from is required");
  if (!user_id) throw entityError("BAD_INPUT", "user_id is required");
  requireProvenance(source_artifact_id, provenance_note, "an entity–property relationship");

  const ent = (await client.query(
    `select id from legal_entities where id = $1`, [legal_entity_id])).rows[0];
  if (!ent) throw entityError("NOT_FOUND", "legal entity not found");

  //  Close any live relationship OF THE SAME KIND before opening the
  //  next. An entity may be owner AND operating entity at once — two
  //  kinds, two rows — but it cannot be the owner twice over one period.
  await client.query(
    `update legal_entity_properties
        set effective_to = $4
      where legal_entity_id = $1 and property_id = $2 and relationship_type = $3
        and effective_to is null and effective_from < $4`,
    [legal_entity_id, property_id, relationship_type, effective_from]);

  const { rows } = await client.query(
    `insert into legal_entity_properties
       (legal_entity_id, property_id, relationship_type, effective_from, effective_to,
        source_artifact_id, provenance_note, recorded_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
    [legal_entity_id, property_id, relationship_type, effective_from, effective_to,
     source_artifact_id, provenance_note, user_id]);
  return rows[0];
}

/*  ── READ THE ENTITIES RELATED TO A PROPERTY ────────────────────────
 *  Live during the requested period, by relationship kind.
 */
async function readForProperty(client, { property_id, as_of = null } = {}) {
  const day = as_of || new Date().toISOString().slice(0, 10);
  const { rows } = await client.query(
    `select e.id as legal_entity_id, e.legal_name, e.entity_type,
            e.formation_jurisdiction,
            r.id as relationship_id, r.relationship_type,
            r.effective_from, r.effective_to,
            r.source_artifact_id, r.provenance_note
       from legal_entity_properties r
       join legal_entities e on e.id = r.legal_entity_id
      where r.property_id = $1
        and r.effective_from <= $2
        and (r.effective_to is null or r.effective_to > $2)
      order by r.relationship_type asc, e.legal_name asc`,
    [property_id, day]);

  return rows.map((r) => ({
    legal_entity_id: r.legal_entity_id,
    legal_name: r.legal_name,
    //  Reported because it is a real attribute. It is NOT a rule: a
    //  corporation being exempt from NPT is a governed finding somebody
    //  establishes, never something read off this field.
    entity_type: r.entity_type,
    formation_jurisdiction: r.formation_jurisdiction,
    relationship_id: r.relationship_id,
    relationship_type: r.relationship_type,
    effective_from: isoDay(r.effective_from),
    effective_to: isoDay(r.effective_to),
    provenance_strength: r.source_artifact_id ? "documentary" : "attested",
  }));
}

module.exports = {
  ENTITY_TYPES, RELATIONSHIP_TYPES,
  establishEntity, relateToProperty, readForProperty, entityError, isoDay,
};
