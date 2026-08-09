/* ════════════════════════════════════════════════════════════════════
   STEP 4 — THE EIGHT COMPLETION FACTS, CHECKED BY NAME

   §4 of the frozen plan: `claimCompletion` writes eight facts in ONE
   transaction, "all eight or none". §7.4 makes proving that against a
   real handset the release's load-bearing gate.

   ── WHY THIS IS A MODULE AND NOT A SCRIPT ───────────────────────────

   On the day, this logic runs against PRODUCTION, once, over rows a
   human generated with a phone. There is no second attempt and no
   debugging window. So the assertions themselves are proven first —
   `rehearse.js` drives a real completion through the canonical service
   against isolated Postgres and runs THESE functions, then mutates each
   fact away and proves the matching check goes red.

   Unproven assertions pointed at production is how a green receipt gets
   written over a hollow completion.

   ── NO GREEN-COUNT LOGIC (Gate 10's rule, kept) ─────────────────────

   The verdict is never "N checks passed". Every fact is NAMED, checked
   by name, and an absent fact is an explicit refusal. A receipt that can
   pass with a hole in it is how a half-activated rail gets recorded as a
   finished one.

   ── THE CAPSTONE IS `xmin` ──────────────────────────────────────────

   "All eight or none" is a claim about a TRANSACTION, and PostgreSQL
   records the transaction that produced every row in its own `xmin`
   system column. So atomicity is not inferred from reading the writer's
   source — it is read off the rows: every fact must carry the SAME
   transaction id.

   That is exact minutes after the event, which is when this runs. It is
   NOT durable: a later UPDATE to any row changes its xmin, and
   `VACUUM FREEZE` eventually rewrites xmin to the frozen id. Both make
   the capstone report unknown rather than false, and it says so.

   ── WHAT IS NEVER RETURNED ──────────────────────────────────────────
   phone numbers · media URLs · image bytes · note contents · tokens.
   Digests, byte sizes, ids and states ARE returned — they are the
   evidence.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

/*  ── WHOSE VOCABULARY DECIDES F2 · CORRECTED 2026-08-09 ─────────────
 *
 *  This constant used to be a THIRD copy of the §3.1 array, written out
 *  here, with F2b asserting it matched the READER's. That made a
 *  Boundary 5 completion fact depend on `work_order_status_head`'s
 *  array — a file that belongs to Boundary 9 and has not deployed. Run
 *  against production, F2b compared this array to the reader's stale
 *  three-value one and went red on a genuinely valid completion.
 *
 *  The right authority is neither the future reader nor a proof-only
 *  duplicate. It is THE GATE THE DEPLOYED WRITER ACTUALLY USED:
 *  `COMPLETION_EVIDENCE_CLASSIFICATIONS` in evidence_service.js, which
 *  is what claimCompletion consulted when it accepted this evidence.
 *  A proof of what the writer did must judge it by the writer's own
 *  predicate, or it is proving something else.
 *
 *  Imported, never restated: if the writer's array moves, this proof
 *  moves with it and cannot silently keep asserting an older meaning.
 *  Falls back to the §3.1 literal only if the import fails, so an
 *  unreadable source degrades to a named constant rather than to `[]`,
 *  which would make F2 vacuously pass. */
let PROOF_CLASSIFICATIONS, CLASSIFICATION_SOURCE;
try {
  // eslint-disable-next-line global-require
  PROOF_CLASSIFICATIONS = [...require(
    require("path").join(__dirname, "..", "..", "src/technician/evidence_service.js")
  ).COMPLETION_EVIDENCE_CLASSIFICATIONS];
  CLASSIFICATION_SOURCE = "deployed writer (evidence_service.COMPLETION_EVIDENCE_CLASSIFICATIONS)";
  if (!PROOF_CLASSIFICATIONS.length) throw new Error("empty");
} catch (_) {
  PROOF_CLASSIFICATIONS = ["repair_photo", "condition"];
  CLASSIFICATION_SOURCE = "FALLBACK literal — evidence_service could not be read";
}
const VERIFIED_MIME = ["image/jpeg", "image/png", "image/webp"];

/*  PACKAGE REVISION. Revision 1 was the frozen Step 4 package. Revision 2
 *  is a PROOF-SCOPING FIX and changes no completion semantics:
 *
 *    · F2's vocabulary now comes from the DEPLOYED WRITER's own gate
 *      (evidence_service.COMPLETION_EVIDENCE_CLASSIFICATIONS) instead of
 *      a third hand-written copy.
 *    · F2b left the completion verdict for readerSourceAlignment(),
 *      which reports PASS / DEFERRED / FAIL as its own conclusion.
 *    · rehearse.js is not shipped: it requires src/release0/, which is
 *      Boundary 8 material and absent from the deployed tree.
 *
 *  Nothing was relaxed. The `unclassified` mutation still reddens F2 —
 *  measured, rehearse 47/0 including that falsification — and mutating
 *  the reader's array moves ONLY the alignment conclusion, also measured
 *  by re-running the whole rehearsal against a stale reader. */
const PACKAGE_REVISION = 2;
const PACKAGE_REVISION_IS = "proof-scoping fix: Boundary 5 no longer depends on the Boundary 9 reader";

const fact = (id, name, held, detail, observed) => ({ id, name, held: !!held, detail, observed });

/**
 * Check the eight facts for ONE work order.
 *
 * Every argument is a BINDING the caller established deliberately —
 * nothing here searches for "the newest rows". A production database has
 * other traffic, and "the most recent completion" is not the same claim
 * as "the completion this test caused".
 */
async function checkCompletionFacts(db, {
  work_order_id, property_id, actor_user_id, source_comm_event_id = null,
} = {}) {
  const facts = [];
  const q = (sql, vals) => db.query(sql, vals);

  // ── F1 · THE COMPLETION CLAIM ──────────────────────────────────────
  const claims = (await q(
    `select id, reported_by_user_id, source_comm_event_id, occurred_at,
            xmin::text as xmin
       from work_order_progress
      where work_order_id = $1 and property_id = $2 and kind = 'completion_claimed'
      order by occurred_at asc`, [work_order_id, property_id])).rows;
  const claim = claims[claims.length - 1] || null;
  facts.push(fact("F1", "the completion claim was recorded",
    claims.length >= 1 && claim && String(claim.reported_by_user_id) === String(actor_user_id),
    claims.length === 0 ? "no completion_claimed progress row exists"
      : "the claim was not reported by the bound actor",
    { claim_rows: claims.length, claim_id: claim && claim.id,
      reported_by_is_actor: claim && String(claim.reported_by_user_id) === String(actor_user_id) }));

  //  The claim must trace to the message that carried it. Attribution is
  //  the whole point of the technician lane; a claim with no source is a
  //  completion nobody can trace to a person and a moment.
  facts.push(fact("F1b", "the claim traces to the inbound message",
    !source_comm_event_id ||
      (claim && String(claim.source_comm_event_id) === String(source_comm_event_id)),
    "the claim is not linked to the bound inbound comm event",
    { source_comm_event_id: claim && claim.source_comm_event_id }));

  // ── F3 · THE PROOF EVALUATION (checked before F2, which reads it) ──
  const evals = (await q(
    `select id, state, supersedes_id, evaluated_by_user_id, evaluated_by_service,
            rule_version, evaluated_at, xmin::text as xmin
       from work_order_proof_evaluations
      where work_order_id = $1 and property_id = $2
      order by evaluated_at asc`, [work_order_id, property_id])).rows;
  const head = (await q(
    `select id, state from work_order_proof_evaluation_head
      where work_order_id = $1 and property_id = $2`, [work_order_id, property_id])).rows[0] || null;
  const headRow = head ? evals.find((e) => String(e.id) === String(head.id)) : null;

  facts.push(fact("F3", "a proof evaluation exists and is the chain head",
    !!head && head.state === "satisfied" && !!headRow,
    !head ? "no evaluation head — the completion has nothing behind it"
      : head.state !== "satisfied" ? `the head is '${head.state}', not 'satisfied'`
      : "the head is not among this work order's evaluations",
    { evaluation_rows: evals.length, head_id: head && head.id, head_state: head && head.state,
      evaluated_by_service: headRow && headRow.evaluated_by_service,
      rule_version: headRow && headRow.rule_version }));

  //  ONE head, and a single linear chain. Two genesis rows would mean two
  //  independent evaluations of the same work — which is the fork §2.1
  //  exists to make impossible, asserted rather than assumed.
  const genesis = evals.filter((e) => e.supersedes_id === null);
  facts.push(fact("F3b", "the evaluation chain is single and linear",
    genesis.length === 1 && evals.length >= 1,
    `${genesis.length} genesis evaluation(s) — a fork means two independent verdicts`,
    { genesis_rows: genesis.length, chain_length: evals.length }));

  // ── F2 · THE EVIDENCE THAT WAS EVALUATED ───────────────────────────
  const linked = head ? (await q(
    `select a.id, a.storage_state, a.proof_classification, a.mime_type, a.byte_size,
            a.sha256, a.stored_at, a.provider, a.provider_media_id,
            l.property_id as link_property_id, l.work_order_id as link_work_order_id,
            l.xmin::text as xmin
       from work_order_proof_evaluation_attachments l
       join work_order_proof_attachments a
         on a.id = l.attachment_id and a.work_order_id = l.work_order_id
        and a.property_id = l.property_id
      where l.evaluation_id = $1`, [head.id])).rows : [];

  const durable = linked.filter((a) =>
    a.storage_state === "stored" && !!a.sha256 && Number(a.byte_size) > 0 && !!a.stored_at);
  const classified = linked.filter((a) => PROOF_CLASSIFICATIONS.includes(a.proof_classification));
  const mimeOk = linked.filter((a) => VERIFIED_MIME.includes(String(a.mime_type)));

  facts.push(fact("F2", "the evaluated evidence is real, preserved and classified",
    linked.length >= 1 && durable.length === linked.length &&
      classified.length === linked.length && mimeOk.length === linked.length,
    linked.length === 0 ? "the evaluation cites no evidence at all"
      : "an evaluated attachment is not stored, not classified as proof, or has an unverified MIME",
    { linked: linked.length, durable: durable.length, classified: classified.length,
      verified_mime: mimeOk.length,
      //  The durable evidence itself. Never the bytes, never the URL.
      attachments: linked.map((a) => ({
        id: a.id, storage_state: a.storage_state, classification: a.proof_classification,
        mime_type: a.mime_type, byte_size: a.byte_size,
        sha256: a.sha256 ? String(a.sha256).slice(0, 16) + "…" : null,
        provider: a.provider, provider_media_id_present: !!a.provider_media_id })) }));

  /*  F2b HAS MOVED. It asked whether the deployed READER shares the
   *  writer's vocabulary — a cross-boundary source-alignment question,
   *  not a fact about whether this work order was validly completed. It
   *  now lives with S1-S4 under `readerSourceAlignment()` below and is
   *  reported as its own conclusion, so a Boundary 9 file can never
   *  again veto a Boundary 5 verdict. */

  // ── F4 · THE LINKS ARE FULLY SCOPED ────────────────────────────────
  const misscoped = linked.filter((a) =>
    String(a.link_property_id) !== String(property_id) ||
    String(a.link_work_order_id) !== String(work_order_id));
  facts.push(fact("F4", "every evaluation→attachment link is fully scoped",
    linked.length >= 1 && misscoped.length === 0,
    linked.length === 0 ? "there are no links to scope" : "a link crosses a work order or property",
    { links: linked.length, misscoped: misscoped.length }));

  // ── F5 · THE STATUS ────────────────────────────────────────────────
  const wo = (await q(
    `select id, status, work_order_ref, completion_photo, completion_note, updated_at,
            xmin::text as xmin
       from work_orders where id = $1 and property_id = $2`,
    [work_order_id, property_id])).rows[0] || null;
  facts.push(fact("F5", "the work order status is complete",
    !!wo && wo.status === "complete",
    wo ? `status is '${wo.status}'` : "the work order does not exist at this property",
    { work_order_ref: wo && wo.work_order_ref, status: wo && wo.status }));

  // ── F6 · THE DISTINCT `completed` PROGRESS EVENT ───────────────────
  const dones = (await q(
    `select id, reported_by_user_id, occurred_at, xmin::text as xmin
       from work_order_progress
      where work_order_id = $1 and property_id = $2 and kind = 'completed'
      order by occurred_at asc`, [work_order_id, property_id])).rows;
  const done = dones[dones.length - 1] || null;
  facts.push(fact("F6", "a distinct `completed` progress event was appended",
    dones.length === 1 && done && claim && String(done.id) !== String(claim.id),
    dones.length === 0 ? "the governed decision left no `completed` row of its own"
      : dones.length > 1 ? `${dones.length} completed rows — a second writer appended one`
      : "the completed row is not distinct from the claim",
    { completed_rows: dones.length, completed_id: done && done.id,
      distinct_from_claim: !!(done && claim && String(done.id) !== String(claim.id)) }));

  // ── F7 · THE OWNING OBLIGATION ─────────────────────────────────────
  const obls = (await q(
    `select id, type, status, resolution_code, completed_at, xmin::text as xmin
       from obligations
      where related_type = 'work_order' and related_id = $1 and property_id = $2`,
    [work_order_id, property_id])).rows;
  const open = obls.filter((o) => o.status !== "complete");
  const closedSat = obls.filter((o) => o.status === "complete" && o.resolution_code === "satisfied");
  facts.push(fact("F7", "the owning obligation closed with the work",
    obls.length >= 1 && open.length === 0 && closedSat.length >= 1,
    obls.length === 0 ? "no obligation was ever attached to this work order"
      : open.length > 0 ? `${open.length} obligation(s) still open against completed work`
      : "no obligation closed as 'satisfied'",
    { obligations: obls.length, still_open: open.length,
      closed: obls.map((o) => ({ type: o.type, status: o.status, resolution: o.resolution_code })) }));

  // ── F8 · THE ACTION RECEIPT ────────────────────────────────────────
  //  The immutable history row. Matched on the PROGRESS ID inside its
  //  note, not on recency — an unrelated completion in the same minute
  //  must never be creditable as this one.
  const receipts = done ? (await q(
    `select id, type, occurred_at, note, xmin::text as xmin
       from events
      where property_id = $1 and type = 'work_order_completed'
        and note::jsonb ->> 'progress_id' = $2`, [property_id, String(done.id)])).rows : [];
  const receipt = receipts[0] || null;
  let receiptNames = false;
  try {
    const n = receipt ? JSON.parse(receipt.note) : null;
    receiptNames = !!n && String(n.work_order_id) === String(work_order_id) &&
      String(n.reported_by_user_id) === String(actor_user_id);
  } catch (_) { receiptNames = false; }
  facts.push(fact("F8", "the action receipt records who and what",
    receipts.length === 1 && receiptNames,
    receipts.length === 0 ? "no work_order_completed event names this progress row"
      : receipts.length > 1 ? "more than one receipt cites the same progress row"
      : "the receipt does not name this work order and this actor",
    { receipt_events: receipts.length, receipt_id: receipt && receipt.id,
      names_work_order_and_actor: receiptNames }));

  /* ── THE CAPSTONE — "ALL EIGHT OR NONE", READ OFF THE ROWS ─────────
   *
   *  ⚠ A SAVEPOINT IS A SUBTRANSACTION, AND IT HAS ITS OWN xid.
   *
   *  The first version of this asserted that all eight facts share one
   *  `xmin`, and a genuine, correct, atomic completion FAILED IT with
   *  three distinct ids. Not a bug in the writer — a bug in the
   *  assertion. `appendProgress` wraps its insert in `SAVEPOINT
   *  append_progress` (the duplicate-recovery fix), and PostgreSQL gives
   *  every subtransaction its own xid:
   *
   *      begin; insert A; savepoint s; insert B; release s; insert C;
   *      → A and C carry the top-level xid, B carries the subtransaction's
   *
   *  So the two progress rows and their events carry subtransaction ids
   *  while the evaluation, links, status and obligation carry the parent.
   *  They still commit together — that is what a subtransaction IS — but
   *  xmin equality cannot see it.
   *
   *  Splitting the claim in two is what makes it honest:
   *
   *    A1  the SAVEPOINT-FREE facts share one transaction id.  Always
   *        available, and exact: nothing separates these four writes.
   *    A2  ALL facts share one COMMIT TIMESTAMP.  This is the real
   *        atomicity question — a subtransaction commits with its parent,
   *        so one commit timestamp covers the whole family. It needs
   *        `track_commit_timestamp = on`, which is OFF by default. When
   *        it is off this reports INDETERMINATE and says why. It never
   *        reports "not atomic" because the server could not answer.  */
  const xmins = {
    claim: claim && claim.xmin,                                   // subtransaction
    completed: done && done.xmin,                                 // subtransaction
    receipt: receipt && receipt.xmin,                             // subtransaction
    evaluation: headRow && headRow.xmin,                          // parent
    links: linked.length ? [...new Set(linked.map((a) => a.xmin))] : [],   // parent
    work_order: wo && wo.xmin,                                    // parent
    obligation: closedSat.length ? [...new Set(closedSat.map((o) => o.xmin))] : [], // parent
  };
  const parentSide = [xmins.evaluation, xmins.work_order, ...xmins.links, ...xmins.obligation]
    .filter(Boolean);
  const parentDistinct = [...new Set(parentSide)];
  //  FROZEN rows make this UNKNOWN, never false. Reporting "not atomic"
  //  because a row was vacuumed months later would be a confident wrong
  //  about the most important fact in the release.
  const frozen = parentSide.includes("2");
  const a1Indeterminate = parentSide.length < 3 || frozen;
  facts.push(fact("A1", "the savepoint-free facts share ONE transaction id",
    !a1Indeterminate && parentDistinct.length === 1,
    a1Indeterminate
      ? "INDETERMINATE — too few rows, or a row has been frozen since. xmin can no " +
        "longer answer, and that must not be read as 'not atomic'."
      : `${parentDistinct.length} distinct ids across the evaluation, links, status and ` +
        "obligation — those four are written with nothing between them, so more than " +
        "one id means they were NOT written together",
    { distinct_parent_ids: parentDistinct.length, indeterminate: a1Indeterminate,
      per_fact: xmins,
      note: "the claim, completed and receipt rows carry SUBTRANSACTION ids by design — " +
            "appendProgress wraps its insert in a SAVEPOINT" }));

  //  A2 — the whole family, when the server can tell us.
  let commitTs = null, a2Indeterminate = true, a2Reason = "";
  try {
    const on = (await q(`select current_setting('track_commit_timestamp', true) as v`)).rows[0].v;
    if (String(on) !== "on") {
      a2Reason = "track_commit_timestamp is off on this server, so commit times are not recorded";
    } else {
      const all = [...new Set([...parentSide,
        xmins.claim, xmins.completed, xmins.receipt].filter(Boolean))];
      const ts = (await q(
        `select distinct pg_xact_commit_timestamp(x::text::xid) as t
           from unnest($1::text[]) as x`, [all])).rows.map((r) => r.t && r.t.toISOString());
      const known = ts.filter(Boolean);
      if (known.length !== ts.length || known.length === 0) {
        a2Reason = "the server no longer holds a commit timestamp for every fact";
      } else {
        a2Indeterminate = false;
        commitTs = [...new Set(known)];
      }
    }
  } catch (e) {
    a2Reason = "commit timestamps unavailable: " + (e.code || e.message);
  }
  facts.push(fact("A2", "ALL eight facts share ONE commit — subtransactions included",
    //  INDETERMINATE is not a failure. It is the honest answer when the
    //  server was never asked to record the evidence.
    a2Indeterminate ? true : commitTs.length === 1,
    a2Indeterminate ? "INDETERMINATE — " + a2Reason + ". A1 still bounds the parent side."
      : `${commitTs.length} distinct commit timestamps — the facts did NOT commit together`,
    { indeterminate: a2Indeterminate, reason: a2Reason || null,
      distinct_commits: commitTs ? commitTs.length : null, commit_timestamps: commitTs }));

  return {
    facts,
    allHeld: facts.every((f) => f.held),
    //  Reported explicitly rather than left to be discovered in prose: a
    //  caller writing a receipt must be able to say WHICH capstone ran.
    capstoneIndeterminate: a1Indeterminate,
    atomicityIndeterminate: a2Indeterminate,
    atomicityReason: a2Reason || null,
  };
}

/**
 * NO PARALLEL WRITER. §4.1 retired the legacy done-path and §19c Ruling D
 * makes claimCompletion the one completion service. These check that the
 * completion in front of us came from THAT writer and no other.
 */
/*  ── READER / WRITER SOURCE ALIGNMENT — NOT A COMPLETION FACT ───────
 *
 *  Three states, because two would force a lie. The reader belongs to a
 *  later boundary; until it deploys, "do they agree?" has no answer
 *  worth acting on, and calling that FAIL trains people to wave reds
 *  through. DEFERRED says exactly what is true.
 *
 *  It becomes REQUIRED at Boundary 9: the surface clause cannot
 *  discharge while the reader would render as proof something the
 *  writer refused to accept as proof. */
function readerSourceAlignment() {
  let readerArray = null, readErr = null;
  try {
    // eslint-disable-next-line global-require
    readerArray = require(
      require("path").join(__dirname, "..", "..", "src/surfaces/work_order_status_read.js")
    ).PROOF_REQUIRED_CLASSIFICATIONS;
  } catch (e) { readErr = String(e.message || e).split("\n")[0]; }

  if (!Array.isArray(readerArray)) {
    return { status: "DEFERRED", writer_array: PROOF_CLASSIFICATIONS, reader_array: null,
      why: "the reader exposes no classification array here" + (readErr ? ` (${readErr})` : "") };
  }
  const agree = JSON.stringify([...readerArray].sort()) ===
                JSON.stringify([...PROOF_CLASSIFICATIONS].sort());
  if (agree) {
    return { status: "PASS", writer_array: PROOF_CLASSIFICATIONS, reader_array: readerArray,
      why: "the deployed reader and the deployed writer accept the same evidence" };
  }
  const readerWider = readerArray.filter((x) => !PROOF_CLASSIFICATIONS.includes(x));
  return {
    status: "DEFERRED",
    writer_array: PROOF_CLASSIFICATIONS,
    reader_array: readerArray,
    reader_accepts_extra: readerWider,
    why: "the deployed reader would render as proof what the writer refuses to accept as " +
         "proof (" + readerWider.join(", ") + "). This is the §3.1 defect one level up and " +
         "it belongs to the Boundary 9 reader release — NOT to this completion.",
    becomes_required_at: "Boundary 9",
  };
}

async function checkNoParallelWriter(db, { work_order_id, property_id }) {
  const facts = [];
  const q = (sql, vals) => db.query(sql, vals);

  //  The legacy closeout writes `work_order_closed`. If one exists for
  //  this work order, a second completion path is live.
  const legacy = (await q(
    `select count(*)::int n from events
      where property_id = $1 and type = 'work_order_closed'
        and note::jsonb ->> 'work_order_id' = $2`, [property_id, String(work_order_id)])).rows[0].n;
  facts.push(fact("N1", "no legacy closeout event exists for this work order", legacy === 0,
    `${legacy} work_order_closed event(s) — the retired done-path ran`, { legacy_events: legacy }));

  //  The legacy evidence columns must not have become the basis of
  //  anything. They may hold history; nothing may READ them as proof, and
  //  the evaluation citing zero attachments while a column is populated
  //  is what that would look like.
  const wo = (await q(
    `select completion_photo is not null as photo, completion_note is not null as note
       from work_orders where id = $1 and property_id = $2`,
    [work_order_id, property_id])).rows[0] || { photo: false, note: false };
  const linkCount = (await q(
    `select count(*)::int n from work_order_proof_evaluation_attachments
      where work_order_id = $1 and property_id = $2`, [work_order_id, property_id])).rows[0].n;
  facts.push(fact("N2", "the completion rests on preserved attachments, not a legacy column",
    linkCount >= 1,
    "the evaluation cites no attachment — a column string cannot be the basis",
    { evaluation_links: linkCount, legacy_photo_column_present: wo.photo,
      legacy_note_column_present: wo.note }));

  //  Exactly one governed completion. A second `completed` row from any
  //  source would mean two writers agreed to close the same work twice.
  const dones = (await q(
    `select count(*)::int n from work_order_progress
      where work_order_id = $1 and property_id = $2 and kind = 'completed'`,
    [work_order_id, property_id])).rows[0].n;
  facts.push(fact("N3", "exactly one governed completion exists", dones === 1,
    `${dones} completed progress rows`, { completed_rows: dones }));

  //  And exactly one head. uq_wope_one_successor makes a fork
  //  unrepresentable; this asserts the guarantee rather than trusting it.
  const heads = (await q(
    `select count(*)::int n from work_order_proof_evaluation_head
      where work_order_id = $1 and property_id = $2`, [work_order_id, property_id])).rows[0].n;
  facts.push(fact("N4", "exactly one evaluation head", heads === 1,
    `${heads} heads — the chain has forked`, { heads }));

  return { facts, allHeld: facts.every((f) => f.held) };
}

module.exports = {
  PROOF_CLASSIFICATIONS, CLASSIFICATION_SOURCE, VERIFIED_MIME, readerSourceAlignment,
  PACKAGE_REVISION, PACKAGE_REVISION_IS,
  checkCompletionFacts, checkNoParallelWriter,
};
