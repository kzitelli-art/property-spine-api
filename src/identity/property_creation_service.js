// ════════════════════════════════════════════════════════════════════
//  property_creation_service.js — THE ONE PATH BY WHICH A PROPERTY
//  BECOMES DURABLE SPINE TRUTH.
//
//  Build 0 measured four routes that created a property and did not agree
//  on identity, hierarchy or authority: three attached no organization,
//  two set no address-anchored identity, three authenticated with a shared
//  static bearer key, and none of the four was exercised by any harness.
//  Full account: docs/BUILD_0_ONBOARDING_AUTHORITY_AUDIT.md.
//
//  This module is the collapse. After it, `insert into properties` appears
//  in exactly one place in the product, and the four doors are callers.
//  Enforced by tests/gate_property_creation_paths.js.
//
//  ── A BEARER KEY IS NOT AN ACTOR (§21) ───────────────────────────────
//  OPERATOR_KEY identifies no human, belongs to no organization, and
//  produces no attributable actor. It was the authority behind three of
//  the four doors, which means the highest-authority write in the product
//  was attributable to a header value. This service refuses to create a
//  property without a session-resolved user, and the doors now resolve
//  one before calling.
//
//  ── THE SCOPE RULE NARROWS. IT NEVER WIDENS. ─────────────────────────
//      super_admin  may create in any organization, and must NAME one.
//      org_admin    may create in their OWN organization only.
//      anyone else  may not create a property.
//
//  Before this, anyone holding the shared key could create a property in
//  no organization at all. Every actor who could legitimately create one
//  through the live surface still can: the deployed app's only creation
//  caller is the super-admin wizard.
//
//  An org_admin naming a sibling organization is refused rather than
//  silently redirected — "escape sideways" has to be visible when it is
//  attempted, or nobody learns it was tried.
//
//  ── IDENTITY: THE BEST BEHAVIOUR OF EACH DOOR, NOT THE AVERAGE ───────
//  A merged path that loses any of these is a regression even though it
//  removes doors:
//    · owner.js's ALIAS-HIJACK REFUSAL — never re-point a string already
//      resolved to a different property. Checked inside the transaction;
//      the whole create rolls back.
//    · bankintake's CANONICAL-KEY IDEMPOTENCY — the same key twice is the
//      same property, not a duplicate. Now with a cross-organization
//      refusal it did not have: returning another client's property row
//      because the address matched would be an escape sideways.
//    · dealintake's TEACH-ON-CREATION — every identity label observed is
//      registered as a resolved alias, so the next upload resolves.
//
//  ── AN ABSENT IDENTITY IS EXPLAINED, NOT SILENT ──────────────────────
//  Identity is NOT mandatory: the live super-admin wizard treats address
//  as optional and breaking that surface to win a constraint would be the
//  wrong trade. What changed is that a keyless property now records WHY,
//  so Build 1B's activation object can read it as a Missing item instead
//  of inferring it from a NULL. Migration 150.
//
//  CLASSIFICATION: Class 1 permanent primitive.
// ════════════════════════════════════════════════════════════════════

"use strict";

//  The four doors. A fifth may not be added here without the Eight
//  Questions (§31) being answered for it; the same list is CHECKed in the
//  database by migration 150, so source and schema have to move together.
const CREATION_SOURCES = new Set([
  "super_admin_wizard", "bank_intake", "owner_upload", "deal_intake",
]);

//  Platform roles that may bring a property into existence. Creating a
//  property is an organization-level act: it decides which customer owns a
//  building. A property-scoped role is not authority for it.
const MAY_CREATE = new Set(["super_admin", "org_admin"]);

const ABSENT_REASONS = {
  NO_ADDRESS: "no_address_supplied_at_creation",
  UNPARSEABLE: "address_not_parseable_to_canonical_key",
};

/*  A refusal carries the reason as a STABLE KEY plus prose. The key is
 *  what a caller branches on and what a proof asserts; the prose is for
 *  the human reading the receipt. Never one without the other. */
function refusal(status, reason, receipt, extra = {}) {
  const e = new Error(receipt);
  e.httpStatus = status;
  e.refusalReason = reason;
  e.publicMessage = receipt;
  e.detail = extra;
  return e;
}

// ── identity normalization — ONE implementation ─────────────────────
//  Build 0 found owner.js comparing aliases with SQL `lower(btrim())`
//  while registry.js used JS `String(s).trim().toLowerCase()`. They agree
//  today and would drift the moment either changed. Both now call this.
const normAlias = (s) => (s == null ? "" : String(s).trim().toLowerCase());

// ── canonical key derivation — ONE implementation ───────────────────
//  Moved verbatim from owner.js, which was the only door that derived a
//  key from an address. Conservative by design: it returns null rather
//  than a guess, and a null here becomes an explained absence, not a
//  silent one.
//
//  Shape: NUMBER-STREETNAME, uppercased, [A-Z0-9-] only. The street NAME
//  is the discriminating token (CHESTNUT, WALNUT, 15TH); the directional
//  and the street TYPE are noise that varies by source.
function deriveCanonicalKey(address) {
  if (!address || !String(address).trim()) return null;
  const raw = String(address).trim();
  const m = raw.match(/^\s*(\d+[A-Za-z]?)\s+(.+)$/);
  if (!m) return null;
  const number = m[1];
  let street = m[2].split(",")[0].trim();
  const tokens = street.split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && /^[NSEW]{1,2}\.?$/i.test(tokens[0])) tokens.shift();
  const STYPE = /^(st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|ln|lane|ct|court|pl|place|ter|terrace|way|pkwy|parkway)\.?$/i;
  while (tokens.length > 1 && STYPE.test(tokens[tokens.length - 1])) tokens.pop();
  const nameCore = tokens.join("-");
  if (!nameCore) return null;
  const key = `${number}-${nameCore}`.toUpperCase().replace(/[^A-Z0-9-]/g, "");
  return key.length >= 3 ? key : null;
}

// ════════════════════════════════════════════════════════════════════
//  SCOPE RESOLUTION — the server decides, from the session's user id.
//
//  READ-ONLY and separately callable, so a surface can ask "may I offer
//  this button" without attempting a write. Fails closed on every path.
// ════════════════════════════════════════════════════════════════════
async function resolveCreationScope(db, { user_id, requested_organization_id = null } = {}) {
  if (!user_id) {
    return { ok: false, reason: "no_authenticated_actor",
      receipt: "Creating a property requires a signed-in operator. A shared operator key is not an actor." };
  }

  let u;
  try {
    u = (await db.query(
      `select id, person_id, is_active, status, platform_role, organization_id
         from users where id = $1`, [user_id])).rows[0] || null;
  } catch (e) {
    //  "Unavailable" and "permitted" must never collapse in the
    //  permissive direction. Same rule as actor_context.js.
    return { ok: false, reason: "identity_read_failed",
      receipt: "Could not establish who is acting. Refused." };
  }
  if (!u) return { ok: false, reason: "actor_not_found", receipt: "No such user." };
  if (!u.is_active || u.status !== "active") {
    return { ok: false, reason: "actor_inactive", receipt: "This account is not active." };
  }

  const role = u.platform_role || "member";
  if (!MAY_CREATE.has(role)) {
    return { ok: false, reason: "insufficient_platform_role",
      receipt: "Creating a property is an organization-level action. " +
               "Your account does not hold that authority." };
  }

  //  super_admin spans all organizations (organization_id is null by
  //  design, migration 093), so it must NAME the organization. "Any org"
  //  is not the same as "no org", and a property with no client is the
  //  orphan this build exists to stop creating.
  if (role === "super_admin") {
    if (!requested_organization_id) {
      return { ok: false, reason: "organization_required",
        receipt: "Name the organization this property belongs to. A property with no client cannot be reported on." };
    }
    const org = (await db.query(
      `select id from organizations where id = $1`, [requested_organization_id])).rows[0];
    if (!org) return { ok: false, reason: "organization_not_found", receipt: "Organization not found." };
    return { ok: true, organization_id: org.id, actor_person_id: u.person_id || null,
             authority_basis: "platform_role:super_admin" };
  }

  //  org_admin: the organization comes from the LOGIN, never the request.
  if (!u.organization_id) {
    return { ok: false, reason: "actor_has_no_organization",
      receipt: "Your account is not linked to an organization." };
  }
  //  A named organization that is not theirs is refused, not redirected.
  if (requested_organization_id && String(requested_organization_id) !== String(u.organization_id)) {
    return { ok: false, reason: "organization_scope_violation",
      receipt: "You may only create properties in your own organization." };
  }
  return { ok: true, organization_id: u.organization_id, actor_person_id: u.person_id || null,
           authority_basis: "platform_role:org_admin" };
}

// ════════════════════════════════════════════════════════════════════
//  createProperty — THE canonical write. One transaction.
//
//  @param spec {
//    actor: { user_id }          FROM THE SESSION. Never from a body.
//    organization_id             requested; the server decides the real one
//    name (required), display_name, address, city, state, zip,
//    property_type, planned_unit_count, leasing_basis,
//    canonical_key               explicit override; else derived from address
//    aliases: []                 strings to teach as resolved
//    source                      one of CREATION_SOURCES
//    idempotent                  bank-intake semantics: same key = same property
//  }
//  @returns { property, created, receipt }
//  @throws  a refusal carrying httpStatus + refusalReason
// ════════════════════════════════════════════════════════════════════
async function createProperty(pool, spec = {}) {
  const {
    actor = {}, organization_id = null, name, display_name = null,
    address = null, city = null, state = null, zip = null,
    property_type = null, planned_unit_count = null, leasing_basis = null,
    canonical_key = null, aliases = [], alias_source_system = null,
    source, idempotent = false,
  } = spec;

  //  Which system a string was OBSERVED in is provenance, and owner.js's
  //  door carried it ('rent_roll') where dealintake's did not. Keeping the
  //  caller's value preserves the better of the two behaviours; the list
  //  mirrors property_aliases' own CHECK, so an unknown value degrades to
  //  'other' rather than throwing at the database.
  const ALIAS_SOURCES = ["yardi", "entrata", "mri", "lender", "bank",
                         "sharepoint", "rent_roll", "other"];
  const aliasSource = ALIAS_SOURCES.includes(alias_source_system) ? alias_source_system : "other";

  if (!CREATION_SOURCES.has(source)) {
    throw refusal(500, "unknown_creation_source",
      `Unknown creation source '${source}'. Every door must name itself.`);
  }
  if (!name || !String(name).trim()) {
    throw refusal(400, "name_required", "A property name is required.");
  }

  // ── authority, before anything is written ─────────────────────────
  const scope = await resolveCreationScope(pool, {
    user_id: actor.user_id, requested_organization_id: organization_id,
  });
  if (!scope.ok) {
    const status = scope.reason === "no_authenticated_actor" ? 401
      : scope.reason === "organization_not_found" ? 404
      : scope.reason === "organization_required" || scope.reason === "name_required" ? 400
      : scope.reason === "identity_read_failed" ? 503
      : 403;
    throw refusal(status, scope.reason, scope.receipt);
  }

  // ── identity: explicit key wins, else derive, else explain ────────
  const explicitKey = canonical_key && String(canonical_key).trim()
    ? String(canonical_key).trim().toUpperCase() : null;
  const derivedKey = explicitKey ? null : deriveCanonicalKey(address);
  const key = explicitKey || derivedKey;
  const absentReason = key ? null
    : (address && String(address).trim() ? ABSENT_REASONS.UNPARSEABLE : ABSENT_REASONS.NO_ADDRESS);

  const aliasValues = (Array.isArray(aliases) ? aliases : [])
    .map((a) => (a == null ? "" : String(a).trim()))
    .filter(Boolean);

  let planned = null;
  if (planned_unit_count !== undefined && planned_unit_count !== null
      && String(planned_unit_count).trim() !== "") {
    const n = Number(planned_unit_count);
    if (!Number.isInteger(n) || n < 0) {
      throw refusal(400, "planned_unit_count_invalid",
        "planned_unit_count must be a non-negative integer.");
    }
    planned = n;
  }

  const basis = ["unit", "bed", "unknown"].includes(leasing_basis) ? leasing_basis : null;

  const client = await pool.connect();
  try {
    await client.query("begin");

    // ── idempotent door (bank intake): same key IS the same property ──
    if (idempotent && key) {
      const existing = (await client.query(
        `select id, name, address, canonical_key, organization_id
           from properties where canonical_key = $1 for update`, [key])).rows[0];
      if (existing) {
        //  Cross-organization refusal that the original upsert did not
        //  have. Handing back a row belonging to another client because
        //  the address matched is an escape sideways, and it would have
        //  been invisible — the caller just gets a property id.
        if (existing.organization_id && String(existing.organization_id) !== String(scope.organization_id)) {
          await client.query("rollback");
          throw refusal(409, "identity_belongs_to_another_organization",
            "A property with this identity already exists in another organization.",
            { canonical_key: key });
        }
        await client.query(`update properties set updated_at = now() where id = $1`, [existing.id]);
        await client.query("commit");
        return {
          property: existing, created: false,
          receipt: `property already existed for ${key}; nothing was duplicated`,
          authority_basis: scope.authority_basis,
        };
      }
    }

    // ── alias-hijack refusal (owner.js's rule, preserved verbatim) ────
    //  Never re-point a string already resolved to a DIFFERENT property.
    //  Checked BEFORE the insert and inside the transaction, so a losing
    //  race rolls the whole create back rather than half-teaching.
    for (const value of aliasValues) {
      const hit = (await client.query(
        `select id, property_id from property_aliases
          where lower(btrim(alias_value)) = $1
            and confidence = 'resolved'
            and property_id is not null
          limit 1`, [normAlias(value)])).rows[0];
      if (hit) {
        await client.query("rollback");
        throw refusal(409, "alias_conflict",
          "That file identity is already linked to a different property.",
          { alias_value: value, existing_property_id: hit.property_id });
      }
    }

    // ── the write ─────────────────────────────────────────────────────
    let prop;
    try {
      prop = (await client.query(
        `insert into properties
           (name, display_name, address, city, state, zip, property_type,
            planned_unit_count, organization_id, canonical_key,
            canonical_key_absent_reason${basis ? ", leasing_basis" : ""})
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11${basis ? ",$12" : ""})
         returning id, name, display_name, address, city, state, zip,
                   property_type, planned_unit_count, organization_id,
                   canonical_key, canonical_key_absent_reason, leasing_basis, created_at`,
        [String(name).trim(),
         display_name && String(display_name).trim() ? String(display_name).trim() : null,
         address ? String(address).trim() : null, city || null, state || null, zip || null,
         property_type || null, planned, scope.organization_id, key, absentReason,
         ...(basis ? [basis] : [])])).rows[0];
    } catch (e) {
      await client.query("rollback");
      if (e.code === "23505") {
        //  Collision. Do NOT create a duplicate — hand the caller the
        //  link-existing path, same as owner.js did.
        //
        //  ── THE WORDING IS PRODUCT, NOT PLUMBING ──────────────────────
        //  This message reaches a first-time user in the super-admin
        //  wizard. It used to say "A property with this identity may
        //  already exist", which was found on screen by the browser proof:
        //  "identity" is OUR word for OUR machinery, and someone who has
        //  just typed an address has no idea what it means. The HTTP
        //  harness could not catch that — it only ever saw the 409.
        //
        //  So the sentence depends on what the person actually gave us. A
        //  human typed an address; a machine caller passed a key.
        const humanCause = derivedKey
          ? "There is already a property at that address."
          : "A property with this identity already exists.";
        throw refusal(409, "property_identity_exists",
          humanCause + " Choose the existing one rather than adding it twice.",
          { canonical_key: key, existing_identity: key,
            next_step: "Offer the link-to-existing path instead of creating a duplicate." });
      }
      throw e;
    }

    // ── teach every observed identity string (dealintake's rule) ──────
    const taught = [];
    for (const value of aliasValues) {
      const row = (await client.query(
        `insert into property_aliases
           (property_id, source_system, alias_type, alias_value, confidence, note)
         values ($1,$2,'address_string',$3,'resolved',$4)
         on conflict (source_system, alias_value) do update
           set property_id = excluded.property_id, confidence = 'resolved', updated_at = now()
         returning id`,
        [prop.id, aliasSource, value, `taught at property creation via ${source}`])).rows[0];
      taught.push({ alias_id: row.id, alias_value: value, source_system: aliasSource });
    }

    // ── the immutable creation record ─────────────────────────────────
    await client.query(
      `insert into property_creation_events
         (property_id, organization_id, actor_user_id, actor_person_id,
          authority_basis, creation_source, canonical_key,
          canonical_key_absent_reason, aliases_taught)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
      [prop.id, scope.organization_id, actor.user_id, scope.actor_person_id,
       scope.authority_basis, source, key, absentReason, JSON.stringify(aliasValues)]);

    await client.query("commit");
    return {
      property: prop, created: true,
      receipt: `property created: ${prop.name}` + (key ? ` (${key})` : " — identity not established"),
      authority_basis: scope.authority_basis,
      aliases_taught: taught.length,
      aliases: taught,
      canonical_key_source: explicitKey ? "explicit" : derivedKey ? "derived" : "none",
    };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = {
  createProperty, resolveCreationScope,
  deriveCanonicalKey, normAlias,
  CREATION_SOURCES, MAY_CREATE, ABSENT_REASONS,
};
