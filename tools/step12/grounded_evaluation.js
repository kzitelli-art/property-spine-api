/* ════════════════════════════════════════════════════════════════════
   A `satisfied` EVALUATION THAT IS ENTITLED TO SAY SO

   Migration 140 revision 3 stopped trusting the word. A terminal work
   order is legal only if its current `satisfied` evaluation CITES at
   least one attachment that qualifies under the canonical writer's
   evidence gate — stored, with content, byte_size, sha256 and stored_at
   present, an allowed image MIME, and a repair_photo/condition
   classification.

   ── WHY THIS HELPER EXISTS ──────────────────────────────────────────

   Before that rule, every proof harness wrote:

       insert into work_order_proof_evaluations (…state) values (…,'satisfied',…)

   …with nothing behind it, and then made the work order terminal. That
   is now refused (R0004) — correctly: those were hollow completions, and
   the harnesses were asserting on a state production can no longer
   reach.

   The fix belongs in ONE place. Seven harnesses each growing their own
   "make it satisfied" helper is precisely the drift this release exists
   to end, and the day the evidence predicate changes, seven copies is
   seven chances to miss one.

   ── IT IS NOT A SHORTCUT AROUND THE WRITER ──────────────────────────

   This does what `claimCompletion` does, in the same order, using the
   same facts: preserve evidence, evaluate it, link exactly what was
   evaluated. It exists so a harness can build a LEGITIMATE completion
   without dragging in identity, assignment and comm-event fixtures it is
   not testing. A harness proving the WRITER should call the writer.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const crypto = require("crypto");

//  The same arrays the canonical evidence gate uses. Imported rather than
//  retyped so a harness cannot quietly disagree with the service.
const { COMPLETION_EVIDENCE_CLASSIFICATIONS, COMPLETION_EVIDENCE_MIME } =
  require("../../src/technician/evidence_service.js");

/**
 * Preserve one qualifying attachment against a work order.
 * Returns its id. Bytes are real, and the sha256 is of those bytes —
 * `ck_wopa_size_matches_content` and the sha256 format check both apply,
 * so a lazily faked row would be refused by the schema.
 */
async function preserveQualifyingEvidence(db, {
  work_order_id, property_id, uploaded_by_user_id, seed = "g",
}) {
  const id = crypto.createHash("md5")
    .update("grounded:" + work_order_id + ":" + seed).digest("hex")
    .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5");
  const bytes = Buffer.from([7, 7, 7, 7, 7, 7]);
  await db.query(
    `insert into work_order_proof_attachments
       (id,work_order_id,property_id,uploaded_by_user_id,provider,provider_media_id,
        mime_type,storage_state,proof_classification,content,byte_size,sha256,stored_at)
     values ($1,$2,$3,$4,'twilio',$5,$6,'stored',$7,$8,$9,$10,now())
     on conflict (id) do nothing`,
    [id, work_order_id, property_id, uploaded_by_user_id, "ME" + id.slice(0, 8),
     COMPLETION_EVIDENCE_MIME[0], COMPLETION_EVIDENCE_CLASSIFICATIONS[0],
     bytes, bytes.length, crypto.createHash("sha256").update(bytes).digest("hex")]);
  return id;
}

/**
 * Record a `satisfied` evaluation that cites qualifying evidence,
 * superseding the current head if there is one.
 *
 * `attachment_ids` may be supplied by a caller that already preserved
 * evidence it wants cited; otherwise one is created here.
 */
/*  Is this client already inside a transaction? SAVEPOINT is only legal in
 *  one, and its refusal (25P01) is a clean, side-effect-free probe.
 *
 *  This matters because the evaluation and its links MUST land in the same
 *  transaction. Autocommitted separately, the evaluation commits alone —
 *  a `satisfied` head citing nothing — and the deferred guard refuses it
 *  at that commit (R0004). Which is the guard being right: for the length
 *  of one statement, that row really was a completion with no evidence. */
async function inTransaction(db) {
  try {
    await db.query("savepoint grounded_probe");
    await db.query("release savepoint grounded_probe");
    return true;
  } catch (e) { return false; }
}

async function groundedSatisfied(db, {
  work_order_id, property_id, uploaded_by_user_id, attachment_ids = null,
  evaluated_by_service = "harness.grounded", rule_version = "x", seed = "g",
}) {
  const already = await inTransaction(db);
  if (!already) await db.query("begin");
  try {
    /*  Cite evidence that ALREADY qualifies before preserving more. The
     *  canonical writer evaluates the photos the technician actually sent
     *  and links exactly those; a helper that always minted a fresh one
     *  would inflate `preserved_count` on every fixture and move a
     *  published contract capture for no product reason. */
    let atts = attachment_ids;
    if (!atts || !atts.length) {
      const existing = (await db.query(
        `select id from work_order_proof_attachments
          where work_order_id = $1 and property_id = $2
            and storage_state = 'stored'
            and content is not null and byte_size is not null
            and sha256  is not null and stored_at is not null
            and mime_type = any($3::text[])
            and proof_classification = any($4::text[])
          order by received_at asc`,
        [work_order_id, property_id,
         COMPLETION_EVIDENCE_MIME.slice(), COMPLETION_EVIDENCE_CLASSIFICATIONS.slice()])).rows;
      atts = existing.length ? existing.map((r) => r.id)
        : [await preserveQualifyingEvidence(db,
            { work_order_id, property_id, uploaded_by_user_id, seed })];
    }

    const head = (await db.query(
      `select id from work_order_proof_evaluation_head
        where work_order_id=$1 and property_id=$2`, [work_order_id, property_id])).rows[0];

    const ev = (await db.query(
      `insert into work_order_proof_evaluations
         (work_order_id,property_id,state,evaluated_by_user_id,evaluated_by_service,
          rule_version,supersedes_id)
       values ($1,$2,'satisfied',$3,$4,$5,$6) returning id`,
      [work_order_id, property_id, uploaded_by_user_id || null,
       evaluated_by_service, rule_version, head ? head.id : null])).rows[0];

    for (const attachment_id of atts) {
      // eslint-disable-next-line no-await-in-loop
      await db.query(
        `insert into work_order_proof_evaluation_attachments
           (evaluation_id,attachment_id,work_order_id,property_id) values ($1,$2,$3,$4)
         on conflict do nothing`,
        [ev.id, attachment_id, work_order_id, property_id]);
    }
    if (!already) await db.query("commit");
    return { evaluation_id: ev.id, attachment_ids: atts };
  } catch (e) {
    if (!already) await db.query("rollback").catch(() => {});
    throw e;
  }
}

/**
 * The whole governed shape in ONE transaction: evidence, evaluation,
 * links, then the terminal status. Statement order is irrelevant to the
 * deferred guard, but this is the order the canonical writer uses.
 *
 * `status` defaults to 'complete' — `closed` is historical vocabulary and
 * migration 140 refuses it after the cutover (R0003).
 */
async function completeGoverned(db, {
  work_order_id, property_id, uploaded_by_user_id, status = "complete", seed = "g",
}) {
  await db.query("begin");
  try {
    const out = await groundedSatisfied(db,
      { work_order_id, property_id, uploaded_by_user_id, seed });
    await db.query(`update work_orders set status=$2 where id=$1`, [work_order_id, status]);
    await db.query("commit");
    return out;
  } catch (e) { await db.query("rollback").catch(() => {}); throw e; }
}

module.exports = { preserveQualifyingEvidence, groundedSatisfied, completeGoverned };
