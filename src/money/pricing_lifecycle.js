// ════════════════════════════════════════════════════════════════════
//  pricing_lifecycle.js — PROPOSAL → PREVIEW → DRAFT → REVIEW → PUBLISH
//
//  One draft model. property_pricing_versions.status already distinguishes
//  draft from published, so a second "proposed pricing" table would create
//  two answers to "what does this property intend to charge".
//
//  ── A DRAFT HAS NO OPERATING EFFECT, STRUCTURALLY ────────────────────
//  Not by convention — by the shape of the reads. effectivePropertyPricing
//  filters `status='published'`, so a draft cannot reach the AI, the leasing
//  team, Renewals or the Future Rent Roll. It is invisible to every consumer
//  and cannot be mistaken for an offer, because no consumer looks where it
//  lives.
//
//  ── THE RECEIPT IS ATTRIBUTABLE ACROSS A REPLACED DRAFT ──────────────
//  A draft may be rewritten during authoring. A review may not evaporate when
//  that happens, so pricing_review_receipts is append-only, holds the full
//  packet the reviewer actually saw, and carries a digest of the proposal.
//  Publication recomputes that digest and REFUSES if it differs — so a sheet
//  cannot be reviewed, quietly edited, and then published wearing the old
//  receipt. That single check is the difference between an audit trail and
//  the appearance of one.
//
//  ── PUBLISHED IS IMMUTABLE ───────────────────────────────────────────
//  Enforced by database triggers from migration 102, not by this file. A
//  service-level rule protects only the callers who go through the service.
// ════════════════════════════════════════════════════════════════════

"use strict";

const crypto = require("crypto");
const { pricingAuthority } = require("./pricing_authority");
const { previewPublication } = require("./pricing_publication_preview");
const { pricingDecisionPacket } = require("./pricing_decision_packet");

const e = (code, message, status = 400) => {
  const err = new Error(message);
  err.code = code; err.httpStatus = status; err.publicMessage = message;
  return err;
};

/**
 * Canonical digest of a proposal. Key order is normalised so that two
 * semantically identical proposals hash identically and a reordered edit is
 * not mistaken for a substantive one.
 */
function proposalDigest(proposal = {}) {
  const norm = (v) => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      return Object.keys(v).sort().reduce((o, k) => { if (v[k] !== undefined) o[k] = norm(v[k]); return o; }, {});
    }
    return v;
  };
  const material = norm({
    effective_from: proposal.effective_from || null,
    effective_until: proposal.effective_until || null,
    terms: (proposal.terms || []).map((t) => ({
      unit_type_id: String(t.unit_type_id), lease_term_months: t.lease_term_months,
      base_rent: t.base_rent == null ? null : Number(t.base_rent),
      renewal_rent: t.renewal_rent == null ? null : Number(t.renewal_rent),
      offer_state: t.offer_state || "offered",
    })),
    concessions: (proposal.concessions || []).map((c) => ({
      concession_type: c.concession_type, timing_profile: c.timing_profile || null,
      value: c.value == null ? null : Number(c.value), fee_category: c.fee_category || null,
    })),
  });
  return crypto.createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

// ── SAVE DRAFT ───────────────────────────────────────────────────────
async function saveDraft(pool, { property_id, person_id, user_id = null, proposal = {}, draft_version_id = null } = {}) {
  if (!property_id) throw e("no_property", "No property context.");
  const auth = await pricingAuthority(pool, { property_id, person_id, user_id });
  if (!auth.may_prepare_pricing) {
    throw e("not_authorized_to_prepare",
      "Preparing pricing for this property requires explicit governed authority.", 403);
  }

  // A draft is still checked, so an operator sees the same refusals they will
  // see at publication rather than discovering them later.
  const preview = await previewPublication(pool, { property_id, proposal });

  const client = await pool.connect();
  try {
    await client.query("begin");

    let versionId = draft_version_id;
    if (versionId) {
      const existing = (await client.query(
        "select id, status, property_id from property_pricing_versions where id=$1", [versionId])).rows[0];
      if (!existing) throw e("draft_not_found", "That draft does not exist.", 404);
      if (String(existing.property_id) !== String(property_id))
        throw e("cross_property_draft", "That draft belongs to another property.", 403);
      if (existing.status !== "draft")
        throw e("not_a_draft", "Only a draft may be edited. A published version is immutable.", 409);
      // Replace the draft's contents wholesale. Terms are deleted rather than
      // merged, so a type removed from the proposal cannot survive invisibly.
      await client.query("delete from pricing_terms where pricing_version_id=$1", [versionId]);
      await client.query("delete from concession_policies where pricing_version_id=$1", [versionId]);
      await client.query(
        `update property_pricing_versions
            set effective_from=$2, effective_until=$3, note=$4, updated_at=now()
          where id=$1`,
        [versionId, proposal.effective_from || null, proposal.effective_until || null, proposal.note || null]);
    } else {
      versionId = (await client.query(
        `insert into property_pricing_versions
           (property_id, status, effective_from, effective_until, note, created_by_person_id)
         values ($1,'draft',$2,$3,$4,$5) returning id`,
        [property_id, proposal.effective_from || null, proposal.effective_until || null,
         proposal.note || null, auth.person_id])).rows[0].id;
    }

    for (const t of proposal.terms || []) {
      // NEVER inherited from a prior version. A type absent from this proposal
      // is absent from this draft — silently carrying a previous number
      // forward is how a stale price outlives the decision that made it.
      await client.query(
        `insert into pricing_terms
           (pricing_version_id, property_id, unit_type_id, unit_type, lease_term_months,
            base_rent, renewal_rent, offer_state)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [versionId, property_id, t.unit_type_id, t.legacy_label || null,
         //  A TERM IS CHOSEN, NEVER DEFAULTED (effective_pricing.js's own rule).
         //  `|| 12` published a 12-month price nobody proposed.
         (() => { if (!t.lease_term_months) { throw e("term_length_required",
                    "Every pricing term needs lease_term_months; a term with no length cannot be priced.", 400); }
                  return t.lease_term_months; })(),
         t.offer_state === "offered" ? t.base_rent : (t.base_rent ?? null),
         t.renewal_rent ?? null, t.offer_state || "offered"]);
    }

    for (const c of proposal.concessions || []) {
      await client.query(
        `insert into concession_policies
           (pricing_version_id, property_id, scope, lease_type, concession_type, value,
            fee_category, timing_profile, required_term_months, duration_months, applies_from, active)
         values ($1,$2,'property',$3,$4,$5,$6,$7,$8,$9,$10,false)`,
        [versionId, property_id, c.lease_type || "new", c.concession_type, c.value,
         c.fee_category || null, c.timing_profile || null, c.required_term_months || null,
         c.duration_months || null, c.applies_from || null]);
    }

    await client.query("commit");
    return {
      draft_version_id: versionId,
      status: "draft",
      actor: { session_user_id: auth.session_user_id || null, acting_person_id: auth.person_id,
               property_id, verb: 'may_prepare_pricing', authority_basis: auth.basis.may_prepare_pricing,
               link_status: auth.link_status || 'person_supplied' },
      operating_effect: "none",
      operating_effect_detail:
        "Draft rows are invisible to effectivePropertyPricing, the AI adapter, Renewals and the " +
        "Future Rent Roll, all of which read status='published' only.",
      digest: proposalDigest(proposal),
      preview,
      authority_basis: auth.basis,
    };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── SUBMIT REVIEW RECEIPT ────────────────────────────────────────────
async function submitReview(pool, { property_id, person_id, user_id = null, draft_version_id, proposal, decision, note } = {}) {
  const auth = await pricingAuthority(pool, { property_id, person_id, user_id });
  if (!auth.may_review_pricing) {
    throw e("not_authorized_to_review",
      "Reviewing pricing for this property requires explicit governed authority.", 403);
  }
  if (!["approved", "rejected", "changes_requested"].includes(decision))
    throw e("invalid_decision", "A review decision must be approved, rejected or changes_requested.");

  // The reviewer's evidence is captured, not just their verdict, so the
  // decision can be reproduced after the draft has moved on.
  const packet = await pricingDecisionPacket(pool, { property_id });
  const preview = await previewPublication(pool, { property_id, proposal });
  const digest = proposalDigest(proposal);

  const row = (await pool.query(
    `insert into pricing_review_receipts
       (property_id, reviewed_version_id, reviewed_by_person_id, decision, note,
        packet_snapshot, proposal_snapshot, preview_snapshot, proposal_digest, authority_basis)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     returning id, reviewed_at`,
    [property_id, draft_version_id || null, auth.person_id, decision, note || null,
     JSON.stringify(packet), JSON.stringify(proposal), JSON.stringify(preview),
     digest, JSON.stringify(auth.basis)])).rows[0];

  return {
    review_receipt_id: row.id,
    reviewed_at: row.reviewed_at,
    reviewed_by: { person_id: auth.person_id, name: auth.name },
    decision, proposal_digest: digest,
    actor: { session_user_id: auth.session_user_id || null, acting_person_id: auth.person_id,
               property_id, verb: 'may_review_pricing', authority_basis: auth.basis.may_review_pricing,
               link_status: auth.link_status || 'person_supplied' },
    would_publish: preview.would_publish,
    authority_basis: auth.basis,
    retention: "append_only_survives_draft_replacement",
  };
}

// ── PUBLISH ──────────────────────────────────────────────────────────
async function publishVersion(pool, {
  property_id, person_id, user_id = null, draft_version_id, proposal, review_receipt_id, dry_run = true,
} = {}) {
  const auth = await pricingAuthority(pool, { property_id, person_id, user_id });
  if (!auth.may_publish_pricing) {
    throw e("not_authorized_to_publish",
      "Publishing pricing for this property requires explicit governed authority. " +
      (auth.denied_reason || ""), 403);
  }

  const preview = await previewPublication(pool, { property_id, proposal });
  if (!preview.would_publish) {
    throw e("publication_refused",
      "The proposed version does not satisfy the publication contract: " +
      preview.blockers.map((b) => b.code).join(", "), 409);
  }

  if (!review_receipt_id) throw e("no_review_receipt", "Publication requires a reviewed receipt.", 409);
  const receipt = (await pool.query(
    "select * from pricing_review_receipts where id=$1 and property_id=$2",
    [review_receipt_id, property_id])).rows[0];
  if (!receipt) throw e("review_receipt_not_found", "That review receipt does not exist for this property.", 404);
  if (receipt.decision !== "approved") throw e("review_not_approved", `The review decision was ${receipt.decision}.`, 409);

  // THE CHECK THAT MAKES THE RECEIPT MEAN SOMETHING. A sheet cannot be
  // reviewed, edited, then published wearing the old approval.
  const digest = proposalDigest(proposal);
  if (digest !== receipt.proposal_digest) {
    throw e("proposal_changed_since_review",
      "This sheet is not the one that was reviewed. Re-submit it for review before publishing.", 409);
  }
  // A person may not approve their own sheet into production unattended.
  if (String(receipt.reviewed_by_person_id) === String(auth.person_id) && !auth.basis.may_publish_pricing.startsWith("assignment:")) {
    throw e("self_review_without_ownership",
      "A grant holder cannot both review and publish the same sheet.", 403);
  }

  const client = await pool.connect();
  try {
    await client.query("begin");

    //  THE DRAFT FIRST. This used to close the live sheet and THEN update
    //  `where id=$1 and status='draft'` with no property predicate and no
    //  row-count check: a mistyped or foreign draft id retired the property's
    //  pricing, matched nothing, committed, and answered `published: true`.
    //  Every quote then handed off with no_published_pricing_version. The
    //  draft must exist, be THIS property's, still be a draft, and be the
    //  version the receipt actually reviewed — all before anything moves.
    const draft = (await client.query(
      `select id, property_id, status from property_pricing_versions where id=$1 for update`,
      [draft_version_id])).rows[0];
    if (!draft || String(draft.property_id) !== String(property_id)) {
      throw e("draft_not_found", "That draft does not exist on this property. Nothing was published.", 404);
    }
    if (draft.status !== "draft") {
      throw e("draft_not_publishable", `That version is ${draft.status}, not a draft. Nothing was published.`, 409);
    }
    if (receipt.reviewed_version_id && String(receipt.reviewed_version_id) !== String(draft_version_id)) {
      throw e("receipt_for_different_version",
        "The review receipt was written for a different version. Re-submit this draft for review before publishing.", 409);
    }

    const prior = (await client.query(
      `select id from property_pricing_versions
        where property_id=$1 and status='published'
          and (effective_until is null or effective_until > $2::timestamptz)
        order by effective_from desc limit 1`, [property_id, proposal.effective_from])).rows[0] || null;

    if (prior) {
      // A replacement CLOSES the prior period rather than deleting it. History
      // is retained; the old version keeps saying what it said.
      await client.query(
        `update property_pricing_versions set effective_until=$2, superseded_at=now() where id=$1`,
        [prior.id, proposal.effective_from]);
    }

    const published = await client.query(
      `update property_pricing_versions
          set status='published', published_by_person_id=$2, published_at=now(),
              authority_basis=$3, review_receipt_id=$4, supersedes_version_id=$5,
              publication_receipt=$6
        where id=$1 and property_id=$7 and status='draft'`,
      [draft_version_id, auth.person_id, JSON.stringify(auth.basis), review_receipt_id,
       prior ? prior.id : null,
       JSON.stringify({ before: preview.receipt.before, after: preview.receipt.after,
                        checked: preview.receipt.checked, quote_preview: preview.quote_preview }),
       property_id]);
    //  Belt to the braces above: the row was locked and checked, so this can
    //  only be 0 if something changed under us — and then nothing may commit.
    if (published.rowCount !== 1) {
      throw e("draft_not_publishable", "The draft changed while publishing. Nothing was published.", 409);
    }

    if (dry_run) {
      // A real transaction against real constraints and real triggers, then
      // rolled back. This proves the path without publishing pricing.
      await client.query("rollback");
      return { published: false, dry_run: true, would_have_published: draft_version_id,
               supersedes: prior ? prior.id : null, authority_basis: auth.basis,
      actor: { session_user_id: auth.session_user_id || null, acting_person_id: auth.person_id,
               property_id, verb: 'may_publish_pricing', authority_basis: auth.basis.may_publish_pricing,
               link_status: auth.link_status || 'person_supplied', reviewed_proposal_digest: digest },
               note: "Executed against live constraints and triggers, then rolled back. No row was published." };
    }
    await client.query("commit");
    return { published: true, version_id: draft_version_id, supersedes: prior ? prior.id : null,
             review_receipt_id, authority_basis: auth.basis,
      actor: { session_user_id: auth.session_user_id || null, acting_person_id: auth.person_id,
               property_id, verb: 'may_publish_pricing', authority_basis: auth.basis.may_publish_pricing,
               link_status: auth.link_status || 'person_supplied', reviewed_proposal_digest: digest }, };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── HISTORY ──────────────────────────────────────────────────────────
async function versionHistory(pool, { property_id } = {}) {
  const versions = (await pool.query(
    `select v.id, v.status, v.effective_from, v.effective_until, v.published_at,
            v.supersedes_version_id, v.superseded_at, v.review_receipt_id,
            p.name as published_by, v.authority_basis
       from property_pricing_versions v
       left join persons p on p.id = v.published_by_person_id
      where v.property_id=$1 order by coalesce(v.effective_from, v.created_at) desc`, [property_id])).rows;
  const receipts = (await pool.query(
    `select r.id, r.reviewed_version_id, r.decision, r.reviewed_at, r.proposal_digest,
            p.name as reviewed_by
       from pricing_review_receipts r
       left join persons p on p.id = r.reviewed_by_person_id
      where r.property_id=$1 order by r.reviewed_at desc`, [property_id])).rows;
  return {
    property_id, versions, review_receipts: receipts,
    retention_rule: "Published versions are immutable and retained. A replacement closes the prior " +
      "period and points at it. Review receipts are append-only and survive the drafts they reviewed.",
  };
}

module.exports = { saveDraft, submitReview, publishVersion, versionHistory, proposalDigest };
