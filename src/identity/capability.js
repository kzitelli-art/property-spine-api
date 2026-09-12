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
  NO_CONSENT:
    "This person hasn't agreed to be contacted yet.",
  EMAIL_MISSING: "No email address is recorded for this person.",
  EMAIL_OPTED_OUT: "This person has asked not to be contacted by email.",
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
//  ── CLASS NO LONGER GATES ELIGIBILITY (owner ruling 2026-07-26) ──────
//  This gate used to require a record_class. So did the tenancy admission
//  perimeter, and so did the comms boundary — in the OPPOSITE direction.
//  One field was deciding three independent things, two of them
//  contradicting each other, which is why every unjammed gate jammed again
//  one step deeper.
//
//  Eligibility now asks the only two questions that describe reality:
//    · did this person say yes?          (consent)
//    · is this property switched on?     (env allowlist)
//  Class is out of it entirely. It goes back to one job — marking replay
//  runs so they do not pollute the numbers — which is bookkeeping, not
//  permission.
//
//  CONSENT IS CHECKED HERE ON PURPOSE, not left to the send. The
//  application link goes out by SMS, so the comms boundary would refuse an
//  opted-out recipient anyway — but refusing at send time while the board
//  shows a live Send button is exactly the phantom dispatch Rule 9 forbids.
//  The button must know what the transport knows.
//
//  Absence is refusal, unchanged: no consent row means no, never "not yet
//  decided, so proceed".
function decideApplicationLinkBirth({ enabled, property_allowlisted, person_id, consent_state, delivery_method = "sms", email = null, email_consent_state = null }) {
  const deny = (code) => ({
    action: ACTION_APPLICATION_LINK,
    allowed: false,
    reason_code: code,
    display_reason: REASONS[code],
  });

  if (!enabled) return deny("APPLICATION_LINK_DISABLED");
  if (!property_allowlisted) return deny("PROPERTY_NOT_ACTIVATED");
  if (delivery_method === "manual_email") {
    if (!person_id) return deny("PERSON_UNKNOWN");
    if (["opted_out", "stop", "revoked"].includes(String(email_consent_state || "").toLowerCase())) return deny("EMAIL_OPTED_OUT");
    if (typeof email !== "string" || !email.trim()) return deny("EMAIL_MISSING");
    return { action: ACTION_APPLICATION_LINK, allowed: true, reason_code: "ALLOWED",
      display_reason: "Ready to prepare an email link. Nothing will be sent." };
  }
  // A person is optional at the gate's original call site (some routes pass
  // none), but a board row that offers Send always has one.
  if (person_id) {
    if (consent_state !== "opted_in") return deny("NO_CONSENT");
  }
  return {
    action: ACTION_APPLICATION_LINK,
    allowed: true,
    reason_code: "ALLOWED",
    display_reason: REASONS.ALLOWED,
  };
}

// Consent is per PERSON and per CHANNEL — deliberately not per property.
// contact_preferences is the one revocation home, so a STOP reaches every
// property at once. Scoping it per property would let a person who said stop
// keep receiving from the building next door.
const CONSENT_SQL = `
  select person_id, consent_state
    from contact_preferences
   where channel = 'text'
     and person_id = any($1::uuid[])`;

// ── ONE PERSON — what a write route needs ───────────────────────────
async function evaluateApplicationLinkBirth(q, { property_id, person_id = null }) {
  const enabled = envFlag("APPLICATION_INTENT_PREPARE_ENABLED");
  const property_allowlisted = envList("APPLICATION_INTENT_PROPERTY_IDS")
    .includes(String(property_id));

  // Short-circuit before touching the database: an environment-level or
  // property-level refusal does not depend on who the person is.
  if (!enabled || !property_allowlisted) {
    return decideApplicationLinkBirth({ enabled, property_allowlisted, person_id, consent_state: null });
  }

  let consent_state = null;
  if (person_id) {
    const r = await q.query(CONSENT_SQL, [[person_id]]);
    consent_state = (r.rows[0] && r.rows[0].consent_state) || null;
  }
  return decideApplicationLinkBirth({ enabled, property_allowlisted, person_id, consent_state });
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
      out.set(id, decideApplicationLinkBirth({ enabled, property_allowlisted, person_id: id, consent_state: null }));
    }
    // The environment-level verdict, for rows that carry no person.
    out.set(null, decideApplicationLinkBirth({ enabled, property_allowlisted, person_id: null, consent_state: null }));
    return out;
  }

  const byPerson = new Map();
  if (ids.length) {
    const r = await q.query(CONSENT_SQL, [ids]);
    for (const row of r.rows) byPerson.set(String(row.person_id), row.consent_state);
  }
  for (const id of ids) {
    out.set(id, decideApplicationLinkBirth({
      enabled, property_allowlisted, person_id: id, consent_state: byPerson.get(id) || null,
    }));
  }
  out.set(null, decideApplicationLinkBirth({ enabled, property_allowlisted, person_id: null, consent_state: null }));
  return out;
}

// Manual preparation is not a transport. Read the recorded destination and
// email revocation from their existing owners; text consent remains separate.
async function evaluateManualEmailPreparationBatch(q, { property_id, person_ids = [] }) {
  const enabled = envFlag("APPLICATION_INTENT_PREPARE_ENABLED");
  const property_allowlisted = envList("APPLICATION_INTENT_PROPERTY_IDS").includes(String(property_id));
  const ids = [...new Set(person_ids.filter(Boolean).map(String))];
  const facts = new Map();
  if (enabled && property_allowlisted && ids.length) {
    const r = await q.query(`select p.id, p.email, cp.consent_state from persons p
      left join contact_preferences cp on cp.person_id=p.id and cp.channel='email'
      where p.id=any($1::uuid[])`, [ids]);
    for (const row of r.rows) facts.set(String(row.id), row);
  }
  const prepared = ids.length ? (await q.query(`select ai.id as invitation_id, ai.person_id, ai.conversion_id,
    o.id as send_obligation_id, p.email as recipient_snapshot, p.email
    from application_invitations ai join persons p on p.id=ai.person_id
    join obligations o on o.related_type='application_invitation' and o.related_id=ai.id
      and o.type='send_application_link' and o.status='open'
    where ai.property_id=$1 and ai.person_id=any($2::uuid[]) and ai.status='prepared'
    order by ai.created_at desc`, [property_id, ids])).rows : [];
  const out = new Map();
  for (const id of [...ids, null]) {
    const fact = facts.get(id);
    out.set(id, { ...decideApplicationLinkBirth({ enabled, property_allowlisted,
      person_id: fact ? id : null, email: fact?.email, email_consent_state: fact?.consent_state,
      delivery_method: "manual_email" }), prepared_invitations: prepared.filter(r => String(r.person_id) === id)
        .map(({person_id, ...r}) => ({...r, link:null, prepared:true, sent:false, dispatched:false, delivery_method:"manual_email"})) });
  }
  return out;
}
async function evaluateManualEmailPreparation(q, { property_id, person_id = null }) {
  return (await evaluateManualEmailPreparationBatch(q, { property_id, person_ids: [person_id] })).get(person_id ? String(person_id) : null);
}

module.exports = {
  ACTION_APPLICATION_LINK,
  REASONS,
  evaluateManualEmailPreparation,
  evaluateManualEmailPreparationBatch,
  // ELIGIBLE_RECORD_CLASSES is gone. It existed for a few hours on
  // 2026-07-26 as a shared allowlist so this gate and the tenancy admission
  // perimeter could not disagree about which CLASSES were eligible. The
  // ruling that followed removed class from eligibility altogether, so the
  // list has nothing left to agree about. Both gates now ask consent +
  // property, which is one answer for everyone by construction rather than
  // by keeping two lists in step.
  decideApplicationLinkBirth,
  evaluateApplicationLinkBirth,
  evaluateApplicationLinkBirthBatch,
};
