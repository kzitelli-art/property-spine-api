// ════════════════════════════════════════════════════════════════════
//  governed_charge_cutover.js — ONE CUTOVER SEAM FOR ANY GOVERNED CHARGE
//
//  application_fee_cutover.js pinned charge_code and the legacy fact key as
//  module constants, so governing a SECOND term meant copying the file. Two
//  cutover implementations are two copies that must agree — the exact disease
//  the catalog exists to cure. This is that module, parameterised. It is a
//  RESTORATION of the stated design, not a new one: the header of the
//  original already claimed to describe "the" cutover, singular.
//
//  ── WHAT CHANGED, AND WHY EACH CHANGE IS STRICTLY STRONGER ───────────
//
//  1. THE DRAFT IS RE-VALIDATED AT PUBLICATION.
//     approveAndPublish previously flipped record_state draft→active without
//     re-running checkChargePublishable. Every collapse refusal in the
//     publication contract ran only at INSERT time in publishCharge. A draft
//     that was valid when created and edited afterwards published unchecked.
//     That was abstract until a ruling required editing a draft between
//     validation and publication. It is no longer abstract.
//
//  2. THE DIGEST COVERS EVERY MATERIAL TERM.
//     The original digest omitted effective_from, condition_key,
//     applicability_scope, unit_type_id, waivable, waiver_authority_verb and
//     amount_unresolved_reason — so a sheet could be approved, its EFFECTIVE
//     DATE moved, and then published wearing the old approval. Widening the
//     digest changes the hash for any previously computed value. No stored
//     digest is ever re-verified after publication (approveAndPublish is the
//     only reader, and it only runs against drafts), so nothing historical
//     breaks. Stated rather than discovered.
//
//  3. THE OWNER PROOF COUNTS EVERY LIVE CLAIMANT, NOT ONE NAMED KEY.
//     oneSourceProof counted governed_active + one named fact. That is only
//     a proof of single ownership if that key is the ONLY live prose carrying
//     the value. Here the proof takes a list, and additionally SEARCHES for
//     unlisted live facts whose text carries the amount — reporting them as
//     suspected co-owners rather than silently proving "one".
//
//  4. A DRAFT HAS A WRITE PATH, AND IT RECORDS WHO RULED.
//     Implementing a ruling previously had no route at all. recordRuling
//     writes the applicability a human decided, with the ruling and its
//     author on the row, and REFUSES to touch anything that is not a draft.
//     A draft has zero operating effect, so this is not a pricing change; it
//     is the preparation of one.
//
//  ── THE LEGACY LINKAGE IS CODE, AND SAYS SO ──────────────────────────
//  CLASSIFICATION: Class 2 — a TEMPORARY PRODUCTION ADAPTER with a removal
//  condition. Not Class 3: this constant participates in a real economic
//  cutover, deciding which prose gets retired. Class 3 is infrastructure
//  outside the operating workflow, which this is not. The map from
//  charge_code to the prose it supersedes belongs in a COLUMN on
//  property_governed_charges, not in this file. It is here because adding
//  that column is a migration against a shared database and this slice did
//  not have authority for one.
//  REMOVAL CONDITION: when a third governed term is prepared, or when the
//  next migration touches this table — whichever comes first — move
//  SUPERSEDES to a column and delete this constant. Until then, a charge
//  code absent from the map is REFUSED, never defaulted to "no legacy" —
//  because "no legacy source" and "nobody recorded the legacy source" would
//  otherwise be indistinguishable, and the second one silently skips a
//  retirement.
// ════════════════════════════════════════════════════════════════════

"use strict";

const crypto = require("crypto");
const { actorFromSession } = require("../identity/privileged_actor_contract");
const { checkChargePublishable } = require("./governed_charges");

/** charge_code → the prose sources it supersedes. See CLASSIFICATION above. */
const SUPERSEDES = {
  "fee.application": ["pricing_application_fee"],
  "fee.administration": ["pricing_admin_fee"],
};

/** The three rulings the administration-fee card offers, as stored shape. */
const APPLICABILITY_RULINGS = {
  new_lease_only: { applies_to_new_lease: true, applies_to_renewal: false, applies_to_transfer: false },
  new_lease_and_renewal: { applies_to_new_lease: true, applies_to_renewal: true, applies_to_transfer: false },
};

function legacyKeysFor(charge_code) {
  const keys = SUPERSEDES[charge_code];
  if (!keys) {
    const e = new Error(
      `no legacy source is recorded for ${charge_code} — refusing to act. ` +
      `An unrecorded legacy source is not the same as no legacy source, and ` +
      `treating it as none would skip a retirement and leave two live owners.`);
    e.httpStatus = 409; e.publicMessage = e.message; throw e;
  }
  return keys;
}

/**
 * Hash of EVERY material term. Key order normalised so a reorder is not a
 * change. Anything a quote could differ on belongs in here.
 */
function termsDigest(t) {
  const material = {
    charge_code: t.charge_code,
    amount: t.amount == null ? null : Number(t.amount),
    amount_unresolved_reason: t.amount_unresolved_reason ?? null,
    economic_class: t.economic_class,
    cadence: t.cadence,
    obligation: t.obligation,
    // WHAT the charge is assessed against (migration 110). Previously implicit
    // inside applicability_basis prose; now a material term in its own right,
    // so it belongs in the approval hash. This CHANGES the digest of both
    // existing rows — expected, and stated in the B0 receipt. Prior receipts
    // are historical records under the earlier contract and are not rewritten.
    assessed_per: t.assessed_per ?? null,
    applicability_basis: t.applicability_basis ?? null,
    applicability_scope: t.applicability_scope ?? null,
    unit_type_id: t.unit_type_id ?? null,
    condition_key: t.condition_key ?? null,
    incurred_on_event: t.incurred_on_event ?? null,
    applies_to_new_lease: !!t.applies_to_new_lease,
    applies_to_renewal: !!t.applies_to_renewal,
    applies_to_transfer: !!t.applies_to_transfer,
    refundable: !!t.refundable,
    waivable: !!t.waivable,
    waiver_authority_verb: t.waiver_authority_verb ?? null,
    effective_from: t.effective_from instanceof Date
      ? t.effective_from.toISOString().slice(0, 10)
      : String(t.effective_from || "").slice(0, 10),
    effective_until: t.effective_until instanceof Date
      ? t.effective_until.toISOString().slice(0, 10)
      : (t.effective_until ? String(t.effective_until).slice(0, 10) : null),
  };
  const sorted = Object.keys(material).sort().reduce((o, k) => { o[k] = material[k]; return o; }, {});
  return crypto.createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

async function loadDraft(client, property_id, charge_code) {
  return (await client.query(
    `select * from property_governed_charges
      where property_id=$1 and charge_code=$2 and record_state='draft'`,
    [property_id, charge_code])).rows[0] || null;
}

/**
 * RECORD A HUMAN RULING ON A DRAFT.
 *
 * This is not a pricing change: a draft has zero operating effect and nothing
 * quotes it. It is the act of making the draft say what a human decided,
 * instead of what a migration mirrored from ambiguous prose.
 *
 * Refuses on anything that is not a draft — an active charge is superseded by
 * a new row, never edited into a different meaning.
 */
async function recordRuling(pool, { property_id, user_id, charge_code, ruling, note = null } = {}) {
  const shape = APPLICABILITY_RULINGS[ruling];
  if (!shape) {
    const e = new Error(
      `unknown ruling "${ruling}" — allowed: ${Object.keys(APPLICABILITY_RULINGS).join(", ")}. ` +
      `The "conditional" ruling is deliberately absent: it requires a governed ` +
      `condition_key, which is a separate decision, not a variant of this one.`);
    e.httpStatus = 400; e.publicMessage = e.message; throw e;
  }
  const actor = await actorFromSession(pool, { user_id, property_id, verb: "may_publish_pricing" });

  const client = await pool.connect();
  try {
    await client.query("begin");
    const draft = await loadDraft(client, property_id, charge_code);
    if (!draft) {
      const e = new Error("there is no draft of this charge to rule on");
      e.httpStatus = 409; e.publicMessage = e.message; throw e;
    }

    const before = {
      applies_to_new_lease: draft.applies_to_new_lease,
      applies_to_renewal: draft.applies_to_renewal,
      applies_to_transfer: draft.applies_to_transfer,
      digest: termsDigest(draft),
    };

    const row = (await client.query(
      `update property_governed_charges
          set applies_to_new_lease=$2, applies_to_renewal=$3, applies_to_transfer=$4
        where id=$1 and record_state='draft'
        returning *`,
      [draft.id, shape.applies_to_new_lease, shape.applies_to_renewal, shape.applies_to_transfer]
    )).rows[0];
    if (!row) {
      const e = new Error("the charge stopped being a draft while the ruling was being recorded");
      e.httpStatus = 409; e.publicMessage = e.message; throw e;
    }

    const receipt = {
      ruling,
      ruled_by: { session_user_id: actor.session_user_id, acting_person_id: actor.acting_person_id,
                  display_name: actor.display_name },
      authority_basis: actor.authority_basis,
      note,
      before,
      after: {
        applies_to_new_lease: row.applies_to_new_lease,
        applies_to_renewal: row.applies_to_renewal,
        applies_to_transfer: row.applies_to_transfer,
        digest: termsDigest(row),
      },
      // The point of recording both digests: an approval bound to the BEFORE
      // digest can no longer publish, and the refusal will name this ruling.
      supersedes_prior_approval: before.digest !== termsDigest(row),
      recorded_at: new Date().toISOString(),
      what_this_is_not: "A draft has no operating effect. Nothing quotes this. " +
                        "The live assistant is unchanged by this write.",
    };
    await client.query(
      `update property_governed_charges set publication_receipt=$2 where id=$1`,
      [draft.id, JSON.stringify({ ruling_receipt: receipt })]);

    await client.query("commit");
    return { ruled: true, charge_id: draft.id, receipt, new_digest: receipt.after.digest };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally { client.release(); }
}

/**
 * APPROVE + PUBLISH, in one transaction. The live assistant is NOT switched
 * here — the legacy prose stays active until cutover.
 */
async function approveAndPublish(pool, { property_id, user_id, charge_code, approved_digest, note = null } = {}) {
  const legacyKeys = legacyKeysFor(charge_code);
  const actor = await actorFromSession(pool, { user_id, property_id, verb: "may_publish_pricing" });

  const client = await pool.connect();
  try {
    await client.query("begin");
    const draft = await loadDraft(client, property_id, charge_code);
    if (!draft) { const e = new Error("no draft candidate to publish"); e.httpStatus = 409; throw e; }

    const digest = termsDigest(draft);
    if (approved_digest && approved_digest !== digest) {
      const e = new Error("the reviewed terms have changed since approval — re-review before publishing");
      e.code = "digest_mismatch"; e.httpStatus = 409; e.publicMessage = e.message; throw e;
    }

    // ── THE CHECK THAT WAS MISSING ──────────────────────────────────
    // The publication contract ran at insert time and never again. A draft
    // edited after creation reached publication unchecked.
    const check = checkChargePublishable({ ...draft, property_id },
      { property_id, actor_may_publish: true });
    if (!check.publishable) {
      const e = new Error("charge refused at publication: " + check.blockers.map((x) => x.code).join(", "));
      e.httpStatus = 409; e.publicMessage = e.message; e.blockers = check.blockers; throw e;
    }

    const receipt = {
      approved_by: { session_user_id: actor.session_user_id, acting_person_id: actor.acting_person_id,
                     display_name: actor.display_name },
      authority_basis: actor.authority_basis,
      approved_terms_digest: digest,
      publication_contract_rechecked: true,
      terms: {
        charge_code, amount: draft.amount == null ? null : Number(draft.amount),
        economic_class: draft.economic_class, cadence: draft.cadence, obligation: draft.obligation,
        applicability_basis: draft.applicability_basis, incurred_on_event: draft.incurred_on_event,
        applies_to_new_lease: draft.applies_to_new_lease, applies_to_renewal: draft.applies_to_renewal,
        applies_to_transfer: draft.applies_to_transfer, refundable: draft.refundable,
      },
      prior_ruling: (draft.publication_receipt && draft.publication_receipt.ruling_receipt) || null,
      note,
      published_at: new Date().toISOString(),
      // Both spellings: the singular key is the shape the application-fee
      // receipt has always carried and is preserved verbatim for compatibility;
      // the plural is the generalized truth. They cannot disagree — the
      // singular is the first element of the same array.
      legacy_source_still_live: legacyKeys[0],
      legacy_sources_still_live: legacyKeys,
      assistant_switched: false,
      quote_state: "inactive",
      note_on_publication: "Publication establishes approved economic truth. It does NOT make the " +
                           "term quotable — activation is a separate transaction.",
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
             assistant_source: "legacy prose — unchanged until cutover" };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally { client.release(); }
}

/**
 * THE ATOMIC CUTOVER. Activates for quoting, retires EVERY legacy source, and
 * writes the receipt in ONE transaction, then re-reads the owner count and
 * refuses to commit unless it is exactly one.
 */
async function cutOver(pool, { property_id, user_id, charge_code, note = null } = {}) {
  const legacyKeys = legacyKeysFor(charge_code);
  const actor = await actorFromSession(pool, { user_id, property_id, verb: "may_publish_pricing" });

  const client = await pool.connect();
  try {
    await client.query("begin");

    // Lock the governed row FIRST so two concurrent cutovers serialise.
    const gov = (await client.query(
      `select id, amount, record_state, quote_state from property_governed_charges
        where property_id=$1 and charge_code=$2 and record_state='active' for update`,
      [property_id, charge_code])).rows[0];
    if (!gov) { const e = new Error("nothing published to cut over to"); e.httpStatus = 409; throw e; }

    const receipt = {
      cutover_at: new Date().toISOString(),
      charge_code,
      performed_by: { session_user_id: actor.session_user_id, acting_person_id: actor.acting_person_id,
                      display_name: actor.display_name },
      authority_basis: actor.authority_basis,
      governed_charge_id: gov.id,
      governed_amount: gov.amount == null ? null : Number(gov.amount),
      note,
      atomicity: "activation, legacy retirement and this receipt commit in ONE transaction. " +
                 "If any statement fails, none commit.",
      rollback: "deactivate and reinstate together, in one transaction.",
    };

    // 1. ACTIVATE for quoting.
    const activated = (await client.query(
      `update property_governed_charges
          set quote_state='live', activated_at=now(), activated_by_person_id=$2, cutover_receipt=$3
        where id=$1 and quote_state='inactive'
        returning id, quote_state`,
      [gov.id, actor.acting_person_id, JSON.stringify(receipt)])).rows[0];
    if (!activated) {
      const e = new Error("the term was not in an inactive, activatable state");
      e.httpStatus = 409; e.publicMessage = e.message; throw e;
    }

    // 2. RETIRE every recorded legacy source.
    const retired = (await client.query(
      `update agent_facts set status='retired'
        where property_id=$1 and fact_key = any($2::text[]) and status='active'
        returning fact_key`, [property_id, legacyKeys])).rows;

    // 3. REFUSE a committed state with two live owners or none.
    const live = (await client.query(
      `select (select count(*)::int from property_governed_charges
                 where property_id=$1 and charge_code=$2 and quote_state='live') g,
              (select count(*)::int from agent_facts
                 where property_id=$1 and fact_key = any($3::text[]) and status='active') f`,
      [property_id, charge_code, legacyKeys])).rows[0];
    const owners = Number(live.g) + Number(live.f);
    if (owners !== 1) {
      const e = new Error(owners > 1
        ? "refusing to commit: two live quotable owners"
        : "refusing to commit: no live quotable owner — that is a silent gap");
      e.httpStatus = 409; e.publicMessage = e.message; throw e;
    }

    receipt.legacy_retired = retired.map((r) => r.fact_key);
    receipt.live_owners_after = owners;
    await client.query(
      "update property_governed_charges set cutover_receipt=$2 where id=$1",
      [gov.id, JSON.stringify(receipt)]);

    await client.query("commit");
    return { cut_over: true, receipt };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally { client.release(); }
}

/**
 * Report the recorded owner set. READ-ONLY.
 *
 * ⚠️ THIS IS NOT THE FINAL ONE-OWNER PROOF, AND MUST NOT CERTIFY A CUTOVER.
 * The amount-collision scan is a COLLISION ALARM. It is wrong in both
 * directions and neither can be fixed by making the pattern cleverer:
 *   FALSE POSITIVE — an unrelated fact that happens to mention the same
 *     number (a $99 pet fee is not the administration fee).
 *   FALSE NEGATIVE — a competing administration-fee claim carrying NO
 *     amount ("an admin fee applies at renewal") is a real second owner of
 *     the question and this scan cannot see it at all.
 * So it raises suspicion; it never clears it. Certifying an owner set is a
 * separate read-only enumeration a human reviews. Callers must treat
 * `verdict` as "nothing detected", never as "nothing there".
 */
async function oneSourceProof(pool, { property_id, charge_code } = {}) {
  const legacyKeys = legacyKeysFor(charge_code);

  const gov = (await pool.query(
    `select id, amount, record_state, quote_state from property_governed_charges
      where property_id=$1 and charge_code=$2`, [property_id, charge_code])).rows;
  const fact = (await pool.query(
    `select fact_key, status, rendered_text from agent_facts
      where property_id=$1 and fact_key = any($2::text[])`, [property_id, legacyKeys])).rows;

  const govActive = gov.filter((g) => g.record_state === "active");
  const factActive = fact.filter((f) => f.status === "active");

  // Any OTHER live fact whose prose carries this amount is a co-owner nobody
  // recorded. Reported, not counted — naming it is the point.
  const amount = govActive.length ? govActive[0].amount : (gov[0] && gov[0].amount);
  let suspected = [];
  if (amount != null) {
    const whole = String(Math.round(Number(amount)));
    suspected = (await pool.query(
      `select fact_key, status, rendered_text from agent_facts
        where property_id=$1 and status='active'
          and fact_key <> all($2::text[])
          and rendered_text ~ ('\\$\\s*' || $3::text || '(\\D|$)')
        order by fact_key`, [property_id, legacyKeys, whole])).rows
      .map((r) => ({ source: `agent_facts.${r.fact_key}`, text: r.rendered_text }));
  }

  const quotableSources = govActive.length + factActive.length;
  return {
    charge_code,
    legacy_keys_checked: legacyKeys,
    governed_active: govActive.length,
    legacy_active: factActive.length,
    quotable_sources: quotableSources,
    exactly_one: quotableSources === 1,
    the_source: govActive.length === 1 ? "property_governed_charges"
      : factActive.length === 1 ? "agent_facts" : "none",
    retired_history_retained: fact.some((f) => f.status === "retired"),
    suspected_unrecorded_claimants: suspected,
    suspected_note: suspected.length
      ? "These live facts mention the same amount and are NOT recorded as superseded by this " +
        "charge. They may be a different fee, or they may be a second copy of this one. " +
        "This scan cannot tell them apart — a human must."
      : null,
    // Stated on the payload so no caller can mistake a clean scan for a proof.
    detector_limits: {
      is_final_owner_proof: false,
      false_positive: "an unrelated fact mentioning the same number",
      false_negative: "a competing claim about this fee that states no amount",
      certification: "the owner set is certified by a separate read-only enumeration a human " +
                     "reviews, not by this scan",
    },
    // ── VERDICT VOCABULARY: PRESERVED, NOT REDEFINED ─────────────────
    // `one_canonical_truth` is the string the application-fee route has
    // returned since publication, so it is kept — but ONLY for the state it
    // has always meant: exactly one quotable owner among {governed rows for
    // this code, the DECLARED legacy keys}. That count is still computed the
    // same way and is still genuinely proven, so preserving the string is
    // compatibility, not a claim upgrade.
    //
    // The collision scan does NOT strengthen it. It can only WEAKEN it: when
    // an unrecorded claimant is detected the verdict degrades to a distinct
    // string, so a caller reading `one_canonical_truth` is never being told
    // the scan certified anything. detector_limits above says so on every
    // payload, clean or not.
    verdict: quotableSources === 1
      ? (suspected.length ? "one_recorded_owner_WITH_UNRECORDED_CLAIMANTS"
                          : "one_canonical_truth")
      : quotableSources === 0 ? "SILENT_GAP — nothing answers"
      : "TWO_INDEPENDENT_OWNERS — must never ship",
  };
}

module.exports = {
  recordRuling, approveAndPublish, cutOver, oneSourceProof, termsDigest,
  legacyKeysFor, SUPERSEDES, APPLICABILITY_RULINGS,
};
