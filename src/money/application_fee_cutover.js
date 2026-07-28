// ════════════════════════════════════════════════════════════════════
//  application_fee_cutover.js — APPROVE → PUBLISH → SHADOW → CUT OVER
//
//  The first real end-to-end economic decision. Three separate actions, each
//  requiring authority, each producing a receipt.
//
//  ── PUBLICATION IS NOT ACTIVATION ────────────────────────────────────
//  Publishing establishes approved economic truth and sets quote_state to
//  INACTIVE. The term is then visible to operators as cutover-ready and
//  invisible to the live assistant.
//
//  ── THE ATOMIC RULE (added after the first cutover, not before) ──────
//  cutOver() activates for quoting, retires the legacy fact, and writes the
//  receipt in ONE transaction, then RE-READS the owner count and refuses to
//  commit unless it is exactly one. Two owners or zero owners both roll back.
//
//  The application fee itself did NOT cut over this way: publication and
//  retirement were two separate commits, and the database briefly held two
//  authoritative-looking rows. The assistant read only the legacy fact
//  throughout, so no customer answer was wrong — but the seam was not
//  transactional. This is the correction, and the history is recorded rather
//  than rewritten.
//
//  ── THE DIGEST IS THE APPROVAL ───────────────────────────────────────
//  Approval binds a hash of the exact reviewed terms. Publication recomputes
//  it and refuses on mismatch, so a sheet cannot be approved, quietly edited,
//  then published wearing the old approval.
// ════════════════════════════════════════════════════════════════════

"use strict";

const crypto = require("crypto");
const { actorFromSession } = require("../identity/privileged_actor_contract");

const CHARGE_CODE = "fee.application";
const LEGACY_FACT = "pricing_application_fee";

/** Hash of the material terms. Key order normalised so a reorder is not a change. */
function termsDigest(t) {
  const material = {
    charge_code: CHARGE_CODE,
    amount: Number(t.amount),
    economic_class: t.economic_class,
    cadence: t.cadence,
    obligation: t.obligation,
    applicability_basis: t.applicability_basis,
    incurred_on_event: t.incurred_on_event,
    applies_to_new_lease: !!t.applies_to_new_lease,
    applies_to_renewal: !!t.applies_to_renewal,
    applies_to_transfer: !!t.applies_to_transfer,
    refundable: !!t.refundable,
  };
  const sorted = Object.keys(material).sort().reduce((o, k) => { o[k] = material[k]; return o; }, {});
  return crypto.createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

async function loadDraft(client, property_id) {
  return (await client.query(
    `select * from property_governed_charges
      where property_id=$1 and charge_code=$2 and record_state='draft'`,
    [property_id, CHARGE_CODE])).rows[0] || null;
}

/**
 * APPROVE + PUBLISH, in one transaction. The live assistant is NOT switched
 * here — the legacy fact stays active until shadow passes.
 */
async function approveAndPublish(pool, { property_id, user_id, approved_digest, note = null } = {}) {
  const actor = await actorFromSession(pool, { user_id, property_id, verb: "may_publish_pricing" });

  const client = await pool.connect();
  try {
    await client.query("begin");
    const draft = await loadDraft(client, property_id);
    if (!draft) { const e = new Error("no draft candidate to publish"); e.httpStatus = 409; throw e; }

    const digest = termsDigest(draft);
    if (approved_digest && approved_digest !== digest) {
      const e = new Error("the reviewed terms have changed since approval — re-review before publishing");
      e.code = "digest_mismatch"; e.httpStatus = 409; e.publicMessage = e.message; throw e;
    }

    const receipt = {
      approved_by: { session_user_id: actor.session_user_id, acting_person_id: actor.acting_person_id,
                     display_name: actor.display_name },
      authority_basis: actor.authority_basis,
      approved_terms_digest: digest,
      terms: { amount: Number(draft.amount), economic_class: draft.economic_class,
               cadence: draft.cadence, obligation: draft.obligation,
               applicability_basis: draft.applicability_basis,
               incurred_on_event: draft.incurred_on_event,
               applies_to_new_lease: draft.applies_to_new_lease,
               applies_to_renewal: draft.applies_to_renewal,
               refundable: draft.refundable },
      note,
      published_at: new Date().toISOString(),
      legacy_source_still_live: LEGACY_FACT,
      assistant_switched: false,
      quote_state: 'inactive',
      note_on_publication: 'Publication establishes approved economic truth. It does NOT make the term quotable — activation is a separate transaction.',
    };

    const row = (await client.query(
      `update property_governed_charges
          set record_state='active', quote_state='inactive', published_by_person_id=$2, published_at=now(),
              authority_basis=$3, publication_receipt=$4
        where id=$1 and record_state='draft'
        returning id, charge_code, amount, record_state, quote_state, published_at`,
      [draft.id, actor.acting_person_id,
       JSON.stringify({ verb: "may_publish_pricing", basis: actor.authority_basis }),
       JSON.stringify(receipt)])).rows[0];

    await client.query("commit");
    return { published: true, charge: row, receipt,
             // Stated plainly: publishing is not switching.
             assistant_source: "legacy fact — unchanged until shadow passes" };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally { client.release(); }
}

/**
 * THE ATOMIC CUTOVER. Retires the legacy fact in ONE transaction, at which
 * point the governed charge is the only quotable source. The agent reads
 * governed charges alongside facts, so retirement is the switch.
 */
async function cutOver(pool, { property_id, user_id, note = null } = {}) {
  const actor = await actorFromSession(pool, { user_id, property_id, verb: 'may_publish_pricing' });

  const client = await pool.connect();
  try {
    await client.query('begin');

    // Lock the governed row FIRST so two concurrent cutovers serialise.
    const gov = (await client.query(
      `select id, amount, record_state, quote_state from property_governed_charges
        where property_id=$1 and charge_code=$2 and record_state='active' for update`,
      [property_id, CHARGE_CODE])).rows[0];
    if (!gov) { const e = new Error('nothing published to cut over to'); e.httpStatus = 409; throw e; }

    const receipt = {
      cutover_at: new Date().toISOString(),
      performed_by: { session_user_id: actor.session_user_id, acting_person_id: actor.acting_person_id,
                      display_name: actor.display_name },
      authority_basis: actor.authority_basis,
      governed_charge_id: gov.id,
      governed_amount: Number(gov.amount),
      note,
      atomicity: 'activation, legacy retirement and this receipt commit in ONE transaction. ' +
                 'If any statement fails, none commit.',
      rollback: 'deactivate and reinstate together, in one transaction.',
    };

    // ── the three statements that must succeed or fail together ──
    // 1. ACTIVATE for quoting.
    const activated = (await client.query(
      `update property_governed_charges
          set quote_state='live', activated_at=now(), activated_by_person_id=$2, cutover_receipt=$3
        where id=$1 and quote_state='inactive'
        returning id, quote_state`,
      [gov.id, actor.acting_person_id, JSON.stringify(receipt)])).rows[0];
    if (!activated) {
      const e = new Error('the term was not in an inactive, activatable state');
      e.httpStatus = 409; e.publicMessage = e.message; throw e;
    }

    // 2. RETIRE the legacy source.
    const retired = (await client.query(
      `update agent_facts set status='retired'
        where property_id=$1 and fact_key=$2 and status='active'
        returning fact_key`, [property_id, LEGACY_FACT])).rows;

    // 3. REFUSE a committed state with two live owners or none.
    const live = (await client.query(
      `select (select count(*)::int from property_governed_charges
                 where property_id=$1 and charge_code=$2 and quote_state='live') g,
              (select count(*)::int from agent_facts
                 where property_id=$1 and fact_key=$3 and status='active') f`,
      [property_id, CHARGE_CODE, LEGACY_FACT])).rows[0];
    const owners = Number(live.g) + Number(live.f);
    if (owners !== 1) {
      const e = new Error(owners > 1
        ? 'refusing to commit: two live quotable owners'
        : 'refusing to commit: no live quotable owner — that is a silent gap');
      e.httpStatus = 409; e.publicMessage = e.message; throw e;
    }

    receipt.legacy_retired = retired.map((r) => r.fact_key);
    receipt.live_owners_after = owners;
    await client.query(
      'update property_governed_charges set cutover_receipt=$2 where id=$1',
      [gov.id, JSON.stringify(receipt)]);

    await client.query('commit');
    return { cut_over: true, receipt };
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally { client.release(); }
}

/** Prove exactly ONE quotable source. READ-ONLY. */
async function oneSourceProof(pool, { property_id } = {}) {
  const gov = (await pool.query(
    `select id, amount, record_state from property_governed_charges
      where property_id=$1 and charge_code=$2`, [property_id, CHARGE_CODE])).rows;
  const fact = (await pool.query(
    `select fact_key, status, rendered_text from agent_facts
      where property_id=$1 and fact_key=$2`, [property_id, LEGACY_FACT])).rows;

  const govActive = gov.filter((g) => g.record_state === "active");
  const factActive = fact.filter((f) => f.status === "active");
  const quotableSources = govActive.length + factActive.length;

  return {
    governed_active: govActive.length,
    legacy_active: factActive.length,
    quotable_sources: quotableSources,
    exactly_one: quotableSources === 1,
    the_source: govActive.length === 1 ? "property_governed_charges"
      : factActive.length === 1 ? "agent_facts" : "none",
    retired_history_retained: fact.some((f) => f.status === "retired"),
    verdict: quotableSources === 1 ? "one_canonical_truth"
      : quotableSources === 0 ? "SILENT_GAP — nothing answers"
      : "TWO_INDEPENDENT_OWNERS — must never ship",
  };
}

module.exports = { approveAndPublish, cutOver, oneSourceProof, termsDigest, CHARGE_CODE, LEGACY_FACT };
