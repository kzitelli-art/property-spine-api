// ════════════════════════════════════════════════════════════════════
//  person_facts.js — THE ONE WAY A PERSON × PROPERTY FACT IS RECORDED
//
//  Before this file, three separate places hand-rolled the same
//  retire-then-insert against person_attributes, three different ways,
//  with three different failure behaviours. That is a §7 violation
//  (capture once, read everywhere) and it is why the same table ended up
//  with a tour id in a column documented to hold a conversation id, and
//  why nothing ever recorded WHO captured a fact even where the code had
//  the user id in scope and simply left it out of the INSERT.
//
//  This is the single canonical write. Every fact goes through it.
//
//  WHAT A FACT CARRIES (migration 092, doctrine §6):
//    value             attr_key / attr_value
//    capture channel   source          — form | ai_conversation | human
//    receipt           source_record_type + source_ref (TYPED, so a
//                      reader never has to guess which table to look in)
//    occurred time     occurred_at + occurred_at_basis — the moment the
//                      person actually said it, and whether that is the
//                      real business time or write time standing in
//    recorded time     created_at (database default, never caller-supplied)
//    recording actor   actor_type + actor_user_id
//    claim strength    asserted | proven
//    intent            verb — captured | confirmed | corrected
//    lineage           supersedes_id + correction_reason
//
//  `db` accepts a Pool OR a checked-out Client, so a caller inside a
//  transaction keeps its atomicity. Every parameter is explicitly cast:
//  Postgres infers a parameter's type from its uses, and one bare $n
//  beside a cast $n makes the whole parameter the wrong type.
//
//  THIS FILE NEVER SWALLOWS. Callers own their failure policy — all three
//  already have the right one (a savepoint, so one bad fact cannot take
//  down the tour close or the other five facts in the batch). What this
//  file does is make every non-write VISIBLE, because after the savepoint
//  work all three writers are log-only and a silently broken write path
//  would otherwise be invisible in production.
//
//  Class 1 — permanent product primitive.
// ════════════════════════════════════════════════════════════════════

const ACTOR_TYPES = ["operator", "agent", "system", "prospect", "unattributed"];
const VERBS = ["captured", "confirmed", "corrected"];
const CLAIM_STRENGTHS = ["asserted", "proven"];
const SOURCE_RECORD_TYPES = ["comm_event", "leasing_lead", "leasing_tour", "unknown"];
const OCCURRED_BASES = ["source_record", "recorded_proxy"];

// One stable, greppable line per non-write. The deploy gate for the
// cutover is a fact, not a grep: within an hour of shipping,
//   select count(*) from person_attributes where verb is not null
// must be > 0.
function note(attrKey, reason, personId) {
  console.error(`[person_facts] not written key=${attrKey} reason=${reason} person=${personId}`);
}

/**
 * Record one person × property fact.
 * Returns { written, row, superseded_id, skipped_reason }.
 * Throws only on a real database error — the caller decides what that means.
 */
async function recordPersonFact(db, {
  personId,
  propertyId = null,
  attrKey,
  attrValue,
  source,                    // capture CHANNEL: form | ai_conversation | human
  sourceRecordType = null,   // comm_event | leasing_lead | leasing_tour | unknown
  sourceRecordId = null,
  occurredAt = null,
  occurredAtBasis = null,
  actorType = null,
  actorUserId = null,
  claimStrength = "asserted",
  verb = "captured",
  correctionReason = null,
  idempotencyKey = null,
} = {}) {
  if (!personId || !attrKey || attrValue == null || attrValue === "") {
    note(attrKey, "missing_required_input", personId);
    return { written: false, row: null, superseded_id: null, skipped_reason: "missing_required_input" };
  }

  // ── 0. NORMALIZE THE ACTOR ────────────────────────────────────────
  // 'operator' means a NAMED staff member. The operator-KEY door can
  // genuinely produce no user id (it resolves session ?? body ?? null),
  // and pa_operator_actor_has_user would reject that row and roll the
  // retire back with it. 'unattributed' is the honest answer AND a
  // countable signal: if it stays high, tours are being closed through
  // the machine door instead of a staff session.
  if (actorType === "operator" && !actorUserId) actorType = "unattributed";
  if (actorType !== "operator") actorUserId = null;

  // Fail loudly on a vocabulary mistake rather than letting the database
  // raise 23514 mid-transaction — the caller's savepoint would hide it.
  if (actorType && !ACTOR_TYPES.includes(actorType)) throw new Error(`person_facts: bad actorType '${actorType}'`);
  if (verb && !VERBS.includes(verb)) throw new Error(`person_facts: bad verb '${verb}'`);
  if (claimStrength && !CLAIM_STRENGTHS.includes(claimStrength)) throw new Error(`person_facts: bad claimStrength '${claimStrength}'`);
  if (sourceRecordType && !SOURCE_RECORD_TYPES.includes(sourceRecordType)) throw new Error(`person_facts: bad sourceRecordType '${sourceRecordType}'`);
  if (occurredAtBasis && !OCCURRED_BASES.includes(occurredAtBasis)) throw new Error(`person_facts: bad occurredAtBasis '${occurredAtBasis}'`);
  if (occurredAt && !occurredAtBasis) throw new Error("person_facts: occurredAt requires occurredAtBasis");
  if (verb === "corrected" && !(correctionReason && String(correctionReason).trim())) {
    throw new Error("person_facts: a correction requires a reason");
  }

  // ── 1. IDEMPOTENCY PRE-CHECK — BEFORE anything is retired ─────────
  // Ordering is the whole point. A retried webhook must not retire a
  // value it is not going to replace. Doing this check after the retire
  // (or using `on conflict do nothing` on the insert) leaves the key with
  // ZERO active rows and the card blank for a fact the system holds.
  if (idempotencyKey) {
    const dup = (await db.query(
      `select id from person_attributes
        where person_id = $1::uuid and idempotency_key = $2::text limit 1`,
      [personId, idempotencyKey])).rows[0];
    if (dup) {
      note(attrKey, "duplicate", personId);
      return { written: false, row: null, superseded_id: null, skipped_reason: "duplicate" };
    }
  }

  // ── 2. THE CURRENT ROW ────────────────────────────────────────────
  // `is not distinct from` on property_id so a person-level fact
  // (property_id null, the seam 061 reserved) matches correctly. The
  // (created_at desc, id desc) tiebreaker is what the three hand-rolled
  // versions lacked — without it two rows created in the same
  // millisecond made "the current value" arbitrary.
  const cur = (await db.query(
    `select id, attr_value from person_attributes
      where person_id = $1::uuid
        and property_id is not distinct from $2::uuid
        and attr_key = $3::text
        and status = 'active'
      order by created_at desc, id desc
      limit 1`,
    [personId, propertyId, attrKey])).rows[0];

  // ── 3. NO-OP GUARD — byte-for-byte today's behaviour ──────────────
  // All three existing callers pass verb='captured', so their behaviour
  // is unchanged: an identical value writes nothing. Only a caller
  // passing verb='confirmed' records a re-affirmation, which today is
  // thrown away everywhere — the prospect restating the same budget
  // leaves no trace in the record at all.
  if (cur && cur.attr_value === attrValue && verb === "captured") {
    return { written: false, row: null, superseded_id: cur.id, skipped_reason: "unchanged" };
  }

  // ── 4. RETIRE ─────────────────────────────────────────────────────
  if (cur) {
    await db.query(`update person_attributes set status = 'retired' where id = $1::uuid`, [cur.id]);
  }

  // ── 5. INSERT — deliberately NO `on conflict` clause ──────────────
  // A genuine race raises 23505 and, because steps 4 and 5 sit inside the
  // caller's transaction or savepoint, the retire rolls back with it.
  // Swallowing the conflict here would commit the retire and drop the
  // replacement — the exact zero-active-rows bug this service exists to
  // make impossible.
  const row = (await db.query(
    `insert into person_attributes
       (person_id, property_id, attr_key, attr_value, source, source_ref,
        source_record_type, occurred_at, occurred_at_basis, actor_type, actor_user_id,
        claim_strength, verb, supersedes_id, correction_reason, idempotency_key)
     values ($1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::uuid,
             $7::text, $8::timestamptz, $9::text, $10::text, $11::uuid,
             $12::text, $13::text, $14::uuid, $15::text, $16::text)
     returning *`,
    [personId, propertyId, attrKey, attrValue, source, sourceRecordId,
     sourceRecordType, occurredAt, occurredAtBasis, actorType, actorUserId,
     claimStrength, verb, cur ? cur.id : null, correctionReason, idempotencyKey]
  )).rows[0];

  return { written: true, row, superseded_id: cur ? cur.id : null, skipped_reason: null };
}

module.exports = {
  recordPersonFact,
  ACTOR_TYPES, VERBS, CLAIM_STRENGTHS, SOURCE_RECORD_TYPES, OCCURRED_BASES,
};
