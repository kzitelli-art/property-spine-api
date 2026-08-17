// ════════════════════════════════════════════════════════════════════
//  person_supersession.js — CORRECTION WITHOUT MERGING
//
//  The confirm path in activation.js has always carried this ruling:
//
//      "We do NOT match an existing person by name... A duplicate person
//       is an honest, FIXABLE blank; a merged person is a wrong-confident
//       value."
//
//  It was right about the choice and wrong about one word. Nothing in the
//  tree could fix anything: `persons` has carried record_status,
//  retired_at, retired_reason, retired_by_user_id and
//  superseded_by_person_id since migration 104, and no code has ever
//  written one of them. Spine chose duplicates over merges — correctly —
//  and then could not repair the duplicates. This file closes that half.
//
//  ── IT MOVES NOTHING. THAT IS THE ENTIRE DESIGN ─────────────────────
//  Migration 104 froze the doctrine in the column comments themselves:
//
//      record_status            "Retirement NEVER deletes and never
//                                merges: relationships, leases,
//                                conversations and audit history stay
//                                attached to the row that earned them."
//      superseded_by_person_id  "An auditable pointer, NOT a merge —
//                                nothing is moved."
//
//  So: no lease rewrite, no conversation rewrite, no application rewrite,
//  no obligation rewrite, no audit rewrite. Not one child row is touched.
//  A read may FOLLOW the pointer where recognition is the point —
//  person_ingress does exactly that, once — but historical attribution
//  stays true. What happened, happened, and it happened to the row it
//  happened to.
//
//  This is why "deduplicating persons" is not on the table. Physically
//  collapsing two rows would rewrite who did what, which is the opposite
//  of the truth-preservation Spine is built on.
//
//  ── WHAT IT IS NOT ──────────────────────────────────────────────────
//  Not a merge engine, not a bulk dedupe, not a matcher, not a scheduled
//  job. One deliberate correction, by a named actor, with a written
//  reason. Deliberately boring.
//
//  CLASSIFICATION: Class 1 — permanent product primitive.
// ════════════════════════════════════════════════════════════════════

"use strict";

function refuse(code, message) {
  const e = new Error(message);
  e.code = code;
  e.publicMessage = message;
  return e;
}

/*  The child tables that stay exactly where they are. Named explicitly so
 *  the hostile proof can assert "these row sets are byte-identical after
 *  the correction" rather than trusting the absence of an UPDATE.  */
const HISTORY_STAYS_PUT = Object.freeze([
  "leases", "conversations", "comm_events", "lease_applications",
  "leasing_leads", "person_attributes", "leasing_conversions",
]);

/*  supersedePerson — retire one record in favour of another.
 *
 *  retire_person_id    the duplicate. Keeps its name, its source, its
 *                      leases, its history and its audit trail.
 *  surviving_person_id the canonical record going forward.
 *  actor_user_id       who decided. Required.
 *  reason              why, in words. Required — migration 104's CHECK
 *                      enforces it, and a row flagged retired with no
 *                      reason "looks resolved without recording the
 *                      resolution".
 *  evidence_refs       what the decision rested on. Optional, recorded
 *                      into the reason so nothing needs a new column.
 */
async function supersedePerson(client, {
  retire_person_id, surviving_person_id, actor_user_id, reason, evidence_refs = null,
} = {}) {
  if (!retire_person_id || !surviving_person_id) {
    throw refuse("SUPERSESSION_REQUIRES_BOTH", "Supersession needs both a retiring and a surviving Person.");
  }
  if (String(retire_person_id) === String(surviving_person_id)) {
    //  Also enforced by ck_persons_not_self_superseding. Refused here too,
    //  with a sentence, because a database error is not product copy.
    throw refuse("SELF_SUPERSESSION", "A Person cannot supersede itself.");
  }
  if (!actor_user_id) throw refuse("SUPERSESSION_ACTOR_REQUIRED", "A correction must name who made it.");
  if (!reason || !String(reason).trim()) {
    throw refuse("SUPERSESSION_REASON_REQUIRED",
      "A correction must say why. A retirement with no reason looks resolved without recording the resolution.");
  }

  const both = (await client.query(
    `select id, record_status, superseded_by_person_id from persons where id = any($1::uuid[])`,
    [[retire_person_id, surviving_person_id]])).rows;
  const retiring = both.find((p) => String(p.id) === String(retire_person_id));
  const surviving = both.find((p) => String(p.id) === String(surviving_person_id));
  if (!retiring) throw refuse("RETIRING_PERSON_NOT_FOUND", "The Person to retire does not exist.");
  if (!surviving) throw refuse("SURVIVING_PERSON_NOT_FOUND", "The surviving Person does not exist.");

  //  THE SURVIVOR MUST BE LIVE. Pointing a correction at a record that is
  //  itself retired builds a chain nobody can read, and the reader in
  //  person_ingress deliberately follows exactly one hop.
  if (surviving.record_status === "retired") {
    throw refuse("SURVIVOR_IS_RETIRED",
      "The surviving Person is itself retired. Correct to a live record, or resolve that one first.");
  }
  if (retiring.record_status === "retired") {
    throw refuse("ALREADY_RETIRED",
      "That Person is already retired. Re-pointing a retirement in place would erase the correction it already carries.");
  }

  const note = evidence_refs
    ? `${String(reason).trim()} [evidence: ${JSON.stringify(evidence_refs)}]`
    : String(reason).trim();

  //  ONE STATEMENT. record_status, the reason, the time, the actor and the
  //  pointer land together or not at all — ck_persons_retirement_is_explained
  //  would reject any partial write anyway, which is the constraint doing
  //  its job rather than this code being trusted.
  const updated = (await client.query(
    `update persons
        set record_status='retired',
            retired_at=now(),
            retired_reason=$1,
            retired_by_user_id=$2,
            superseded_by_person_id=$3,
            updated_at=now()
      where id=$4 and record_status='active'
      returning id, record_status, retired_at, retired_reason, superseded_by_person_id`,
    [note, actor_user_id, surviving_person_id, retire_person_id])).rows[0];

  if (!updated) throw refuse("SUPERSESSION_RACED", "That Person was retired by someone else first.");

  return {
    retired: updated.id,
    surviving: surviving_person_id,
    reason: updated.retired_reason,
    //  Said out loud in the return value, because the one thing a caller
    //  might assume happened is the one thing that did not.
    moved: [],
    history_untouched: HISTORY_STAYS_PUT,
  };
}

module.exports = { supersedePerson, HISTORY_STAYS_PUT };
