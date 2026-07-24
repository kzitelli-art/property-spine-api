// ════════════════════════════════════════════════════════════════════
//  capability.js — ONE evaluator per governed action.
//
//  WHY THIS EXISTS
//  ---------------
//  Twelve environment switches can refuse an operator mid-action, and
//  ninety-four refusal receipts live in the service layer. Not one was
//  surfaced in a read: every gate was discovered by pressing a live
//  button and reading a red box. A refusal that only appears on click is
//  indistinguishable from breakage, so governance that is working looks
//  exactly like governance that is broken.
//
//  THE ONE RULE THIS MODULE ENFORCES
//  ---------------------------------
//  The projection that RENDERS an action and the route that PERFORMS it
//  ask the SAME function. If they each computed the verdict, they would
//  drift, and the drift has a worst case: a button that says available
//  while the server refuses — a phantom dispatch, which Rule 9 forbids.
//
//  Fetch shape may differ (one row for a route, a batch for a board).
//  The DECISION may not: `decideApplicationLinkBirth` is a pure function
//  of already-fetched facts, and every caller goes through it.
//
//  DISPLAY LANGUAGE
//  ----------------
//  `reason_code` is for machines and logs. `display_reason` is for a
//  human standing in front of the screen, and it never names an
//  environment variable — an operator needs the operating reason, not
//  the deployment vocabulary.
//
//  CLASS 1 — permanent product primitive. Capability is how the product
//  states what may be done and why not; it does not retire with any
//  activation flag.
// ════════════════════════════════════════════════════════════════════
"use strict";

const ACTION_APPLICATION_LINK = "send_application";

// Reason codes are a closed set. A code with no display string is a bug,
// not a fallback — an operator must never be told "not allowed" with no
// reason, which is exactly the wall this module exists to remove.
// Written for a leasing manager standing in front of the screen, not for a
// release note. Each says what is true and, by implication, what would have
// to change — never "unavailable", which states a condition and answers
// nothing.
const REASONS = {
  ALLOWED: "Ready to send.",
  APPLICATION_LINK_DISABLED:
    "Application links aren't switched on yet.",
  PROPERTY_NOT_ACTIVATED:
    "Application links aren't switched on for this property yet.",
  CONTROLLED_ACTIVATION_ONLY:
    "Application links aren't switched on for real prospects yet \u2014 test records only for now.",
  PERSON_UNKNOWN:
    "No person is connected to this work yet.",
};

function envFlag(name) {
  return String(process.env[name] || "").toLowerCase() === "true";
}
function envList(name) {
  return String(process.env[name] || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
}

// ── THE DECISION ─────────────────────────────────────────────────────
//  Pure. Takes facts already in hand; performs no IO. Both the route and
//  the projection land here, which is what makes them agree by
//  construction rather than by discipline.
//
//  `record_class` semantics: null means the person carries no current
//  classification. That is treated as NOT eligible — an ungoverned record
//  is not an internal-QA record, and during controlled activation the
//  absence of a decision is not permission.
function decideApplicationLinkBirth({ enabled, property_allowlisted, person_id, record_class }) {
  const deny = (code) => ({
    action: ACTION_APPLICATION_LINK,
    allowed: false,
    reason_code: code,
    display_reason: REASONS[code],
  });

  if (!enabled) return deny("APPLICATION_LINK_DISABLED");
  if (!property_allowlisted) return deny("PROPERTY_NOT_ACTIVATED");
  // A person is optional at the gate's original call site (some routes pass
  // none), but a board row that offers Send always has one. When an id is
  // supplied the classification must be present and must be internal_qa.
  if (person_id) {
    if (record_class !== "internal_qa") return deny("CONTROLLED_ACTIVATION_ONLY");
  }
  return {
    action: ACTION_APPLICATION_LINK,
    allowed: true,
    reason_code: "ALLOWED",
    display_reason: REASONS.ALLOWED,
  };
}

const CLASSIFICATION_SQL = `
  select person_id, record_class
    from person_property_classifications
   where property_id = $1
     and person_id = any($2::uuid[])
     and superseded_at is null`;

// ── ONE PERSON — what a write route needs ───────────────────────────
async function evaluateApplicationLinkBirth(q, { property_id, person_id = null }) {
  const enabled = envFlag("APPLICATION_INTENT_PREPARE_ENABLED");
  const property_allowlisted = envList("APPLICATION_INTENT_PROPERTY_IDS")
    .includes(String(property_id));

  // Short-circuit before touching the database: an environment-level or
  // property-level refusal does not depend on who the person is.
  if (!enabled || !property_allowlisted) {
    return decideApplicationLinkBirth({ enabled, property_allowlisted, person_id, record_class: null });
  }

  let record_class = null;
  if (person_id) {
    const r = await q.query(CLASSIFICATION_SQL, [property_id, [person_id]]);
    record_class = (r.rows[0] && r.rows[0].record_class) || null;
  }
  return decideApplicationLinkBirth({ enabled, property_allowlisted, person_id, record_class });
}

// ── MANY PEOPLE — what a board projection needs ─────────────────────
//  One query for the whole page rather than one per row. The decision is
//  still the same pure function, so a batch verdict and a single verdict
//  cannot disagree.
async function evaluateApplicationLinkBirthBatch(q, { property_id, person_ids = [] }) {
  const enabled = envFlag("APPLICATION_INTENT_PREPARE_ENABLED");
  const property_allowlisted = envList("APPLICATION_INTENT_PROPERTY_IDS")
    .includes(String(property_id));
  const out = new Map();

  const ids = [...new Set((person_ids || []).filter(Boolean).map(String))];
  if (!enabled || !property_allowlisted) {
    for (const id of ids) {
      out.set(id, decideApplicationLinkBirth({ enabled, property_allowlisted, person_id: id, record_class: null }));
    }
    // The environment-level verdict, for rows that carry no person.
    out.set(null, decideApplicationLinkBirth({ enabled, property_allowlisted, person_id: null, record_class: null }));
    return out;
  }

  const byPerson = new Map();
  if (ids.length) {
    const r = await q.query(CLASSIFICATION_SQL, [property_id, ids]);
    for (const row of r.rows) byPerson.set(String(row.person_id), row.record_class);
  }
  for (const id of ids) {
    out.set(id, decideApplicationLinkBirth({
      enabled, property_allowlisted, person_id: id, record_class: byPerson.get(id) || null,
    }));
  }
  out.set(null, decideApplicationLinkBirth({ enabled, property_allowlisted, person_id: null, record_class: null }));
  return out;
}

module.exports = {
  ACTION_APPLICATION_LINK,
  REASONS,
  decideApplicationLinkBirth,
  evaluateApplicationLinkBirth,
  evaluateApplicationLinkBirthBatch,
};
