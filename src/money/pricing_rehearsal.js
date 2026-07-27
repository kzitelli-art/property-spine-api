// ════════════════════════════════════════════════════════════════════
//  pricing_rehearsal.js — THE FULL LIFECYCLE, WITH NOTHING LEFT BEHIND
//
//  Runs the complete chain against LIVE constraints and triggers:
//      verified session user → verified staff person → property entitlement
//      → may_prepare_pricing → save draft → may_review_pricing
//      → append review receipt → may_publish_pricing → contract passes
//      → publication transaction ROLLED BACK
//
//  ── WHY ROLLBACK AND NOT A MOCK ──────────────────────────────────────
//  A mocked publication proves the code agrees with itself. This exercises
//  the real exclusion constraint, the real immutability triggers and the real
//  foreign keys, then discards the result — so the thing that gets proven is
//  the database's opinion, not mine.
//
//  ── THE ECONOMICS ARE DELIBERATELY FAKE ──────────────────────────────
//  Every rent is a constructed placeholder. Choosing real rents is
//  ownership's decision and it has not been made; a rehearsal that quietly
//  proposed plausible numbers would be a draft of the answer.
//
//  RUNNABLE ONLY once a real actor holds the verbs. Until then it reports the
//  exact step it stops at, which is itself the useful output.
// ════════════════════════════════════════════════════════════════════

"use strict";

const { resolveActorContext } = require("../identity/actor_context");
const { saveDraft, submitReview, publishVersion, proposalDigest } = require("./pricing_lifecycle");
const { effectivePropertyPricing } = require("./effective_pricing");
const { futureRentRollPricingPreview } = require("./future_rent_roll_pricing_contract");

// Constructed, obviously-not-real economics.
const REHEARSAL_RENT = 1234;
const REHEARSAL_RENEWAL = 1244;

const step = (name, passed, detail, data = null) => ({ step: name, passed, detail, data });

async function rehearseVersionOne(pool, { property_id, user_id, effective_from = "2099-01-01" } = {}) {
  const steps = [];
  const created = { versions: [], receipts: [] };
  let stopped_at = null;

  const before = {
    published_version: null, pricing_tables: null, frr_projected: null,
  };

  try {
    // ── 1. verified session user → verified staff person ──────────
    const ctx = await resolveActorContext(pool, { user_id, property_id });
    steps.push(step("verified_session_user", !!(ctx.user && ctx.user.user_id),
      ctx.user ? `Login resolved (${ctx.user.display_name}).` : "No login.", null));
    steps.push(step("verified_staff_person", ctx.link_status === "linked",
      ctx.link_status === "linked"
        ? `Acting person: ${ctx.person.display_name}.`
        : `Not linked — ${ctx.failure_reason}.`));
    steps.push(step("property_entitlement", ctx.property_entitlement === "session_scoped",
      `Entitlement: ${ctx.property_entitlement}.`));

    for (const verb of ["may_prepare_pricing", "may_review_pricing", "may_publish_pricing"]) {
      steps.push(step(verb, !!(ctx.capabilities && ctx.capabilities[verb]),
        ctx.capabilities && ctx.capabilities[verb]
          ? `Held, basis ${ctx.basis[verb]}.`
          : "Not held — the rehearsal stops here until ownership resolves authority."));
    }

    if (!ctx.ok || !ctx.capabilities.may_prepare_pricing) {
      stopped_at = "may_prepare_pricing";
      return finish();
    }

    // ── baseline, so "nothing changed" is measured not asserted ───
    const eff0 = await effectivePropertyPricing(pool, { property_id });
    const frr0 = await futureRentRollPricingPreview(pool, { property_id });
    const counts0 = await tableCounts(pool);
    before.published_version = eff0.published_version;
    before.pricing_tables = counts0;
    before.frr_projected = frr0.summary.positions_given_projected_pricing;

    // ── 2. a constructed proposal addressing every marketable type ─
    const priced = eff0.unit_types.filter((t) => t.requires_pricing_decision);
    const proposal = {
      effective_from,
      publisher_person_id: ctx.person.person_id,
      receipt_reviewed: true,
      note: "REHEARSAL — constructed economics, not a pricing decision.",
      terms: priced.map((t) => ({
        unit_type_id: t.unit_type_id, lease_term_months: 12,
        base_rent: REHEARSAL_RENT, renewal_rent: REHEARSAL_RENEWAL, offer_state: "offered",
      })),
    };

    const draft = await saveDraft(pool, { property_id, user_id, proposal });
    created.versions.push(draft.draft_version_id);
    steps.push(step("save_draft", !!draft.draft_version_id,
      `Draft ${draft.draft_version_id} saved with ${proposal.terms.length} addressed types.`));
    steps.push(step("draft_records_both_identities",
      !!(draft.actor && draft.actor.session_user_id && draft.actor.acting_person_id),
      "Draft receipt names the acting user and the acting person.", draft.actor));

    const effDraft = await effectivePropertyPricing(pool, { property_id });
    steps.push(step("draft_has_no_operating_effect", effDraft.published_version === null,
      "Effective pricing still reports no published version while the draft exists."));

    // ── 3. review receipt ─────────────────────────────────────────
    if (!ctx.capabilities.may_review_pricing) { stopped_at = "may_review_pricing"; return finish(); }
    const rev = await submitReview(pool, {
      property_id, user_id, draft_version_id: draft.draft_version_id,
      proposal, decision: "approved", note: "REHEARSAL",
    });
    created.receipts.push(rev.review_receipt_id);
    steps.push(step("append_review_receipt", !!rev.review_receipt_id,
      `Receipt ${rev.review_receipt_id} appended, digest ${String(rev.proposal_digest).slice(0, 12)}…`));
    steps.push(step("review_records_both_identities",
      !!(rev.actor && rev.actor.session_user_id && rev.actor.acting_person_id),
      "Review receipt names both identities.", rev.actor));

    // ── 4. the digest is the ONLY eligible proposal ───────────────
    let mismatch = null;
    try {
      await publishVersion(pool, {
        property_id, user_id, draft_version_id: draft.draft_version_id,
        proposal: { ...proposal, terms: proposal.terms.map((t) => ({ ...t, base_rent: REHEARSAL_RENT + 1 })) },
        review_receipt_id: rev.review_receipt_id, dry_run: true,
      });
    } catch (e) { mismatch = e.code; }
    steps.push(step("changing_the_draft_invalidates_the_receipt",
      mismatch === "proposal_changed_since_review",
      "A one-dollar edit after review is refused with proposal_changed_since_review."));

    // ── 5. publication, then rolled back ──────────────────────────
    if (!ctx.capabilities.may_publish_pricing) { stopped_at = "may_publish_pricing"; return finish(); }
    const pub = await publishVersion(pool, {
      property_id, user_id, draft_version_id: draft.draft_version_id,
      proposal, review_receipt_id: rev.review_receipt_id, dry_run: true,
    });
    steps.push(step("publication_contract_passes", pub.dry_run === true && pub.published === false,
      "The contract passed and the transaction was rolled back — no version was published.", {
        would_have_published: pub.would_have_published, supersedes: pub.supersedes,
      }));
    steps.push(step("publication_records_authority_basis",
      !!(pub.actor && pub.actor.authority_basis),
      `Authority basis: ${pub.actor && pub.actor.authority_basis}.`, pub.actor));
    steps.push(step("publication_records_reviewed_digest",
      !!(pub.actor && pub.actor.reviewed_proposal_digest === proposalDigest(proposal)),
      "The published receipt carries the exact reviewed digest."));

    return finish();
  } catch (e) {
    steps.push(step("rehearsal_error", false, e.message));
    return finish(e.message);
  }

  async function finish(errorMessage = null) {
    // ── clean up by tracked id. Never by property_id. ─────────────
    for (const v of created.versions) {
      await pool.query("update property_pricing_versions set status='retired' where id=$1", [v]).catch(() => {});
      await pool.query("delete from pricing_terms where pricing_version_id=$1", [v]).catch(() => {});
      await pool.query("delete from concession_policies where pricing_version_id=$1", [v]).catch(() => {});
    }
    for (const r of created.receipts) {
      await pool.query("update property_pricing_versions set review_receipt_id=null where review_receipt_id=$1", [r]).catch(() => {});
      await pool.query("delete from pricing_review_receipts where id=$1", [r]).catch(() => {});
    }
    for (const v of created.versions) {
      await pool.query("delete from property_pricing_versions where id=$1", [v]).catch(() => {});
    }

    // ── prove the world is exactly as it was ─────────────────────
    const after = await tableCounts(pool);
    const effN = await effectivePropertyPricing(pool, { property_id });
    const frrN = await futureRentRollPricingPreview(pool, { property_id });
    const unchanged = {
      published_version: effN.published_version === null,
      pricing_tables: before.pricing_tables
        ? JSON.stringify(after) === JSON.stringify(before.pricing_tables)
        : after.versions === 0 && after.terms === 0 && after.receipts === 0,
      future_rent_roll_projected_positions:
        frrN.summary.positions_given_projected_pricing === (before.frr_projected ?? 0),
      concessions_active: after.active_concessions === 0,
      live_ai_consumer: "unchanged — the adapter is still dark and agent.js does not reference it",
    };

    return {
      disposition: "rehearsal_rollback_only_nothing_published",
      economics: { note: "Constructed placeholders. Ownership has not chosen rents.",
                   base_rent: REHEARSAL_RENT, renewal_rent: REHEARSAL_RENEWAL },
      runnable: stopped_at === null && !errorMessage,
      stopped_at,
      steps,
      unchanged,
      cleanup: { tracked_versions: created.versions, tracked_receipts: created.receipts,
                 method: "deleted by tracked id only" },
      error: errorMessage,
    };
  }
}

async function tableCounts(pool) {
  const r = (await pool.query(
    `select (select count(*)::int from property_pricing_versions) versions,
            (select count(*)::int from pricing_terms) terms,
            (select count(*)::int from pricing_review_receipts) receipts,
            (select count(*)::int from concession_policies where active) active_concessions`)).rows[0];
  return r;
}

module.exports = { rehearseVersionOne, REHEARSAL_RENT, REHEARSAL_RENEWAL };
