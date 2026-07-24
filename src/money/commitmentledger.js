// ════════════════════════════════════════════════════════════════════
//  commitmentledger.js — PRICING AUTHORITY + THE LEASE OFFER RAIL
//  (Commitment Ledger, Tiers 1–2 + the guardrail dial · REV 2)
//  migrations 062, 063(rev2), 064, 065
//
//  REV 2 — the guardrail doctrine corrected (charter Stream 1):
//  soft mode that blocked countersign on GRANT_PENDING was hard mode
//  wearing a soft label — a violation of the anti-Mark rule (the loop
//  must never be left open, but life is never stopped). The corrected
//  taxonomy, with the symmetry that makes it whole:
//
//    SOFT records the promise as a valid offer + a review trail.
//    HARD blocks the binding offer but RECORDS the promise as an
//    incident needing resolution.
//    Neither mode ever loses what was actually said.
//
//  HARD — block the binding offer, never lose the promise:
//    · NO lease_offer (no economics; never enters the Forward Rent Roll)
//    · a durable, attributable concession_incident IS created — what was
//      said, by whom, to whom, where/when, proposed value, evidence —
//      plus an open resolution obligation (retract|correct|approve|
//      replace) routed one hop up the authority graph, else owner.
//    · createLeaseOffer RETURNS { blocked, incident } on a COMMITTED
//      transaction — it must not throw, because a thrown error would
//      roll the incident back and lose the promise. The refusal itself
//      is a recorded fact. No grant = HARD.
//
//  SOFT — honor and review (life is never stopped):
//    · out of scope, any size → the offer proceeds, flagged. NO decision
//      case (the Decision Rail exits soft mode; rail type 'concession'
//      remains vocabulary for the FUTURE provisional mode).
//    · over the dollar threshold → over_threshold is stamped into the
//      authority snapshot; at LOCK, atomically with the schedule, ONE
//      non-blocking review obligation spawns (idempotent per offer —
//      in-tx check + a partial unique index as the belt). The owner can
//      coach, ratify the pattern, or adjust future authority; they
//      CANNOT silently erase an already-made commitment. Completing the
//      review unblocks NOTHING (nothing was blocked).
//
//  SCOPED-OR-BOUND OFFERS (charter #2): a pre-lease offer may quote an
//  exact space OR carry an eligibility scope ("any Studio"). It NEVER
//  creates a hold. Only the schedule binds an exact space, at lock,
//  after re-validation — property wall always verified; unit_type/
//  bed_type segment match is ATTESTED (units carry no type column
//  today; recorded honestly as caller_attested_segment, never faked).
//
//  THE EVIDENCE MODEL (charter #5): communicated_at ≠ recorded_at.
//  An offer without evidence is a DRAFT — it cannot qualify and cannot
//  lock. The clock runs from communicated_at (the promise was made
//  then), a stated default Kameron may override.
//
//  THE RESOLVER (charter Stream 1): resolveGuardrailPolicy is the ONE
//  place offer logic learns a person's guardrail. V1 reads the
//  individual grant; no grant = hard. A later property-default →
//  role-override → individual-override layering changes ONLY this
//  function.
//
//  STILL HONESTLY MISSING (walls — never guessed):
//    computeScheduleLines throws CALENDAR_CONTRACT_MISSING for every
//    profile until the calendar contract is filled from real Solo lease
//    language. The D13 reconciliation matcher does not exist. The
//    provisional mode (propose-then-clear, prospect-visible pending)
//    is documented future work — decision_case_id and rail type
//    'concession' are retained for it.
//
//  Factory (house pattern):
//    require('./commitmentledger')({ pool, spawnObligationFromEvent,
//                                    completeObligation, decisionService })
//  decisionService (the rail's _service) is OPTIONAL in rev 2 — soft
//  mode no longer calls it; retained for future provisional wiring.
// ════════════════════════════════════════════════════════════════════

const express = require("express");

const CONCESSION_TYPES = ["free_rent", "fixed_rent_credit", "fee_waiver"];
const TIMING_PROFILES = ["first_full_month", "third_full_month", "final_full_month", "monthly_scheduled_credit"];

// ── PATH-TWO CONTRACTS ────────────────────────────────────────────────
// #5 CALENDAR PUBLISH GUARD: which timing profiles have a PROVEN calendar
// implementation. Empty by design — computeScheduleLines is still a stub,
// so NO timing profile is implemented yet. A timing-dependent policy may
// not be published, and a timing-dependent discretionary concession may
// not be communicated, until its profile is in this set AND proven. The
// wall moves from a countersign surprise to a publish/communicate-time
// gate. When the real Solo calendar lands, its proven profiles list here.
const IMPLEMENTED_TIMING_PROFILES = [];
// A concession is "calendar-dependent" unless its economics need no dated
// schedule logic. Fee waivers are one-time and month-agnostic → exempt.
function isCalendarDependent(concession_type, timing_profile) {
  if (concession_type === "fee_waiver") return false;
  // free_rent and fixed_rent_credit place dated lines → need the calendar
  return true;
}
function timingProfileReady(timing_profile) {
  return IMPLEMENTED_TIMING_PROFILES.includes(timing_profile);
}
// #2 the intent signal: only a COMMUNICATED promise can mint a hard-mode
// incident. An exploratory selection that hard-fails writes nothing.
const PROMISE_STATES = ["communicated", "exploratory"];

const QUALIFYING_ACTIONS = ["application_submitted", "lease_signed"];
const EVIDENCE_TYPES = ["dispatched_message", "tour_host_attestation", "follow_up_dispatch"];
const OFFER_SCOPES = ["property", "unit_type", "bed_type"];
const INCIDENT_RESOLUTIONS = ["retract", "correct", "approve", "replace"];
const FEE_WAIVER_FLAG = {
  application: "may_grant_application_fee_waiver",
  amenity: "may_grant_amenity_fee_waiver",
  admin: "may_grant_admin_fee_waiver",
};

// assignments.role vocabulary → role_name enum (money.js/decisions.js convention)
function mapRole(orgRole) {
  const map = {
    property_manager: "property_manager",
    maintenance: "maintenance",
    leasing: "leasing_agent",
    bookkeeper: "accountant",
    asset_manager: "asset_manager",
    owner: "owner",
    reporting: "accountant",
    capital: "owner",
  };
  return map[orgRole] || "property_manager";
}

function ledgerError(code, message, extra = {}) {
  const e = new Error(message);
  e.code = code;
  Object.assign(e, extra);
  return e;
}

function money(n) {
  return "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// #3 a deterministic signature of a concession's shape — used to dedupe
// hard-mode incidents so a double-submit / retry cannot mint two records
// of one promise. Stable field order, normalized numbers.
const crypto = require("crypto");
const { dormantWriteGuard } = require("../identity/dormant_gate");  // fail-closed commitment-write gate
function concessionSignature(concessions, scope, scope_ref, space_id) {
  const norm = (concessions || [])
    .map((c) => `${c.concession_type}:${Number(c.value)}:${c.fee_category || ""}:${c.timing_profile || ""}`)
    .sort();
  const target = space_id ? `space:${space_id}` : `scope:${scope || ""}:${scope_ref || ""}`;
  return crypto.createHash("sha256").update(JSON.stringify({ norm, target })).digest("hex");
}

module.exports = function commitmentLedgerModule({ pool, spawnObligationFromEvent, completeObligation = null, decisionService = null }) {
  const app = express.Router();

  // ── shared verifications ─────────────────────────────────────────
  async function mustProperty(client, property_id) {
    const r = await client.query(`select id, name from properties where id = $1`, [property_id]);
    if (r.rowCount === 0) throw ledgerError("NOT_FOUND", "property not found");
    return r.rows[0];
  }
  async function mustPerson(client, person_id, label) {
    const r = await client.query(`select id, name from persons where id = $1`, [person_id]);
    if (r.rowCount === 0) throw ledgerError("NOT_FOUND", `${label || "person"} not found`);
    return r.rows[0];
  }
  // D5 property wall: the space must belong to a unit on THIS property.
  async function mustSpaceOnProperty(client, space_id, property_id) {
    const r = await client.query(
      `select s.id from spaces s join units u on u.id = s.unit_id
        where s.id = $1 and u.property_id = $2`,
      [space_id, property_id]
    );
    if (r.rowCount === 0) {
      throw ledgerError("SPACE_NOT_ON_PROPERTY", "space does not belong to this property — the property wall holds");
    }
  }
  async function witness(client, { property_id, person_id = null, type, note }) {
    const r = await client.query(
      `insert into events (property_id, person_id, type, note)
       values ($1,$2,$3,$4) returning id`,
      [property_id, person_id, type, note]
    );
    return r.rows[0].id;
  }

  // ── THE GUARDRAIL POLICY RESOLVER (the single source) ─────────────
  // The ONE place offer logic learns a person's guardrail. V1 resolves
  // the strongest active individual grant; NO GRANT = HARD (fail-closed,
  // the same posture as the Decision Rail's cap-0). Future layering
  // (property default → role override → individual override) changes
  // ONLY this function — callers never read grant columns directly.
  // #1 AS-OF RESOLUTION: the authority decision happened when the prospect
  // HEARD the promise, not when someone later typed it into Spine. Grant
  // validity is resolved as of `asOf` (= communicated_at). A grant that was
  // active at 3pm but retired by 6pm still governs a 3pm promise; a grant
  // that only became active at 6pm cannot retroactively bless a 3pm promise.
  // asOf defaults to now() for callers with no communication moment (a
  // published-policy path with no evidence never reaches the dial).
  async function resolveGuardrailPolicy(client, property_id, person_id, asOf = null) {
    const r = await client.query(
      `select * from concession_authority_grants
        where property_id = $1 and person_id = $2
          and effective_from <= coalesce($3::timestamptz, now())
          and (effective_until is null or effective_until > coalesce($3::timestamptz, now()))
        order by max_discretionary_value desc, created_at
        limit 1`,
      [property_id, person_id, asOf]
    );
    if (r.rowCount === 0) return { mode: "hard", threshold: 0, grant: null, source: "no_grant" };
    const g = r.rows[0];
    return {
      mode: g.guardrail_mode,                       // 'soft' | 'hard'
      threshold: Number(g.escalation_threshold),
      grant: g,
      source: "individual_grant",
    };
  }

  // authority read for review/incident ROUTING (the assignments graph —
  // the same read pattern the Decision Rail uses; this module writes no
  // policy, it routes by what 004 already granted).
  async function readAssignmentAuthority(client, property_id, person_id) {
    const r = await client.query(
      `select id, role, escalates_to_assignment_id
         from assignments
        where property_id = $1 and person_id = $2 and is_active = true
        order by approval_cap desc nulls last, created_at
        limit 1`,
      [property_id, person_id]
    );
    if (r.rowCount === 0) return { role: null, escalates_to_assignment_id: null };
    return r.rows[0];
  }
  // one hop up the graph → a role_name target; no pointer / stale = owner
  async function escalationRoleFor(client, property_id, person_id) {
    const auth = await readAssignmentAuthority(client, property_id, person_id);
    if (!auth.escalates_to_assignment_id) return "owner";
    const r = await client.query(
      `select role from assignments where id = $1 and is_active = true`,
      [auth.escalates_to_assignment_id]
    );
    if (r.rowCount === 0) return "owner";
    return mapRole(r.rows[0].role);
  }

  // ── publish authority (unchanged from rev 1) ──────────────────────
  async function canPublish(client, property_id, person_id) {
    const role = await client.query(
      `select role from assignments
        where property_id = $1 and person_id = $2 and is_active = true
          and role in ('owner','asset_manager')
        limit 1`,
      [property_id, person_id]
    );
    if (role.rowCount > 0) return { via: "role", role: role.rows[0].role };
    const g = await client.query(
      `select id from concession_authority_grants
        where property_id = $1 and person_id = $2
          and may_publish_public_offers = true
          and effective_from <= now()
          and (effective_until is null or effective_until > now())
        limit 1`,
      [property_id, person_id]
    );
    if (g.rowCount > 0) return { via: "grant", grant_id: g.rows[0].id };
    return null;
  }

  // ── D12: THE deterministic concession value ──────────────────────
  function computeConcessionValue(concessions, base_rent) {
    let total = 0;
    for (const c of concessions || []) {
      const v = Number(c.value);
      if (!Number.isFinite(v) || v <= 0) throw ledgerError("BAD_INPUT", "concession value must be a positive number");
      if (c.concession_type === "free_rent") {
        const br = Number(base_rent);
        if (!Number.isFinite(br) || br <= 0) {
          throw ledgerError("UNPRICED_SEGMENT",
            "free_rent cannot be valued — no published base rent for this segment. Publish pricing first.");
        }
        total += v * br;
      } else {
        total += v;
      }
    }
    return Math.round(total * 100) / 100;
  }

  // ── SERVICE: publishPricing (Tier 1, D9 — unchanged from rev 1) ───
  async function publishPricing(client, spec) {
    const { property_id, published_by_person_id, terms = [], policies = [], note = null } = spec || {};
    if (!property_id) throw ledgerError("BAD_INPUT", "property_id required");
    if (!published_by_person_id) throw ledgerError("BAD_INPUT", "published_by_person_id required — a human publishes");
    if (!Array.isArray(terms) || terms.length === 0) throw ledgerError("BAD_INPUT", "at least one pricing term required");

    await mustProperty(client, property_id);
    await mustPerson(client, published_by_person_id, "publisher");
    const authority = await canPublish(client, property_id, published_by_person_id);
    if (!authority) {
      throw ledgerError("NO_AUTHORITY",
        "publishing pricing requires an owner/asset-manager assignment or an explicit publish grant on this property");
    }

    for (const t of terms) {
      if (!t.unit_type || typeof t.unit_type !== "string") throw ledgerError("BAD_INPUT", "each term needs unit_type");
      const m = Number(t.lease_term_months), br = Number(t.base_rent);
      if (!Number.isInteger(m) || m < 1 || m > 36) throw ledgerError("BAD_INPUT", "lease_term_months must be 1–36");
      if (!Number.isFinite(br) || br < 0) throw ledgerError("BAD_INPUT", "base_rent must be a non-negative number");
    }
    for (const p of policies) {
      if (!CONCESSION_TYPES.includes(p.concession_type)) {
        throw ledgerError("BAD_INPUT", `concession_type must be one of: ${CONCESSION_TYPES.join(", ")}`);
      }
      if (p.concession_type === "fee_waiver" && !p.fee_category) {
        throw ledgerError("BAD_INPUT", "fee_waiver policy requires fee_category");
      }
      if (p.timing_profile && !TIMING_PROFILES.includes(p.timing_profile)) {
        throw ledgerError("BAD_INPUT", `timing_profile must be one of: ${TIMING_PROFILES.join(", ")}`);
      }
      // #5 CALENDAR PUBLISH GUARD: a timing-dependent policy may not be
      // published until its timing profile has a proven calendar
      // implementation. This is the FIRST wall (createLeaseOffer is the
      // second). It moves CALENDAR_CONTRACT_MISSING off the countersign path
      // entirely — no one can publish a promise the system can't schedule, so
      // no agent is ever left holding a concession that fails only at lock.
      // Fee waivers (month-agnostic) are exempt and remain publishable.
      if (isCalendarDependent(p.concession_type, p.timing_profile || "first_full_month")
          && !timingProfileReady(p.timing_profile || "first_full_month")) {
        throw ledgerError("CALENDAR_CONTRACT_MISSING",
          `cannot publish a timing-dependent policy (${p.concession_type} · ${p.timing_profile || "first_full_month"}) — its calendar profile is not implemented and proven yet. Fee waivers and other non-calendar concessions may be published.`);
      }
      if (p.qualifying_action && !QUALIFYING_ACTIONS.includes(p.qualifying_action)) {
        throw ledgerError("BAD_INPUT", `qualifying_action must be one of: ${QUALIFYING_ACTIONS.join(", ")}`);
      }
      if (!(Number(p.value) > 0)) throw ledgerError("BAD_INPUT", "policy value must be positive");
    }

    const cur = await client.query(
      `select id from property_pricing_versions
        where property_id = $1 and status = 'published' for update`,
      [property_id]
    );
    const prior_id = cur.rowCount ? cur.rows[0].id : null;

    if (prior_id) {
      // retire FIRST — the one-published-per-property unique index refuses
      // two live versions, and it is right to. Supersede, never edit.
      await client.query(
        `update property_pricing_versions
            set status = 'retired', effective_until = now(), updated_at = now()
          where id = $1`, [prior_id]);
      await client.query(
        `update concession_policies set active = false where pricing_version_id = $1`, [prior_id]);
    }

    const v = await client.query(
      `insert into property_pricing_versions
         (property_id, status, effective_from, published_by_person_id, published_at,
          authority_basis, supersedes_version_id, note)
       values ($1,'published',now(),$2,now(),$3,$4,$5)
       returning *`,
      [property_id, published_by_person_id, JSON.stringify(authority), prior_id, note]
    );
    const version = v.rows[0];

    for (const t of terms) {
      await client.query(
        `insert into pricing_terms
           (pricing_version_id, unit_type, lease_term_months, base_rent,
            renewal_rent, immediate_move_in_rent, fee_terms)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [version.id, t.unit_type, t.lease_term_months, t.base_rent,
         t.renewal_rent ?? null, t.immediate_move_in_rent ?? null,
         JSON.stringify(t.fee_terms || {})]
      );
    }
    for (const p of policies) {
      await client.query(
        `insert into concession_policies
           (pricing_version_id, property_id, scope, scope_ref, lease_type,
            required_term_months, concession_type, value, fee_category,
            timing_profile, qualifying_action, qualifying_window_hours,
            valid_from, valid_until, active)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true)`,
        [version.id, property_id, p.scope || "property", p.scope_ref ?? null,
         p.lease_type || "new", p.required_term_months ?? null,
         p.concession_type, p.value, p.fee_category ?? null,
         p.timing_profile || "first_full_month",
         p.qualifying_action || "application_submitted",
         p.qualifying_window_hours ?? null,
         p.valid_from ?? null, p.valid_until ?? null]
      );
    }

    await witness(client, {
      property_id, person_id: null, type: "pricing_published",
      note: `Pricing version published (${terms.length} term${terms.length === 1 ? "" : "s"}, ${policies.length} ${policies.length === 1 ? "policy" : "policies"})${prior_id ? " — supersedes prior version" : ""}`,
    });

    return { version, superseded_version_id: prior_id };
  }

  // ── SERVICE: getActivePricing (the one sheet) ────────────────────
  async function getActivePricing(client, property_id) {
    const v = await client.query(
      `select * from property_pricing_versions
        where property_id = $1 and status = 'published' limit 1`,
      [property_id]
    );
    if (v.rowCount === 0) return { version: null, terms: [], policies: [] };
    const version = v.rows[0];
    const terms = (await client.query(
      `select * from pricing_terms where pricing_version_id = $1 order by unit_type, lease_term_months`,
      [version.id])).rows;
    const policies = (await client.query(
      `select * from concession_policies
        where pricing_version_id = $1 and active = true
          and (valid_from is null or valid_from <= now())
          and (valid_until is null or valid_until > now())
        order by created_at`,
      [version.id])).rows;
    return { version, terms, policies };
  }

  async function segmentBaseRent(client, property_id, unit_type, lease_term_months) {
    const r = await client.query(
      `select pt.base_rent
         from pricing_terms pt
         join property_pricing_versions v on v.id = pt.pricing_version_id
        where v.property_id = $1 and v.status = 'published'
          and pt.unit_type = $2 and pt.lease_term_months = $3
        limit 1`,
      [property_id, unit_type, lease_term_months]
    );
    return r.rowCount ? Number(r.rows[0].base_rent) : null;
  }

  // ── the HARD-BLOCK incident writer (never lose the promise) ───────
  // Runs on the CALLER's client and COMMITS with it — the incident and
  // whatever capture surrounded it (a tour outcome) live or die together.
  async function recordConcessionIncident(client, {
    property_id, person_id, spoken_by_person_id, recorded_by_person_id,
    proposed_terms, proposed_value, guardrail_mode, why,
    communicated_at, evidence_type, evidence_ref, source_tour_id,
    source_event_signature = null,
  }) {
    // #3 IDEMPOTENCY: one incident per (evidence_ref, concession signature).
    // A retry, browser double-submit, or client recovery must not mint a
    // second durable record of one promise. The signature ties to the
    // communication evidence (evidence_ref) + the concession shape. Check
    // first; the partial unique index (migration 065) is the belt if two
    // requests race past the check.
    const dedupeKey = source_event_signature
      ? `${evidence_ref || "noevref"}::${source_event_signature}`
      : null;
    if (dedupeKey) {
      const existing = await client.query(
        `select * from concession_incidents where dedupe_key = $1 limit 1`, [dedupeKey]);
      if (existing.rowCount > 0) {
        const inc0 = existing.rows[0];
        let ob0 = null;
        if (inc0.obligation_id) {
          ob0 = (await client.query(`select * from obligations where id = $1`, [inc0.obligation_id])).rows[0] || null;
        }
        return { incident: inc0, obligation: ob0, deduped: true };
      }
    }

    const ev = await witness(client, {
      property_id, person_id, type: "concession_incident_recorded",
      note: `Off-guardrail concession (${money(proposed_value)}) — blocked from becoming an offer; recorded for resolution. ${why || ""}`.trim(),
    });
    let incident;
    try {
      await client.query("savepoint incident_insert");
      const inc = await client.query(
        `insert into concession_incidents
           (property_id, person_id, spoken_by_person_id, recorded_by_person_id,
            proposed_terms, proposed_value, guardrail_mode, why,
            communicated_at, evidence_type, evidence_ref, source_tour_id,
            source_event_id, dedupe_key)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         returning *`,
        [property_id, person_id, spoken_by_person_id, recorded_by_person_id || spoken_by_person_id,
         JSON.stringify(proposed_terms), proposed_value, guardrail_mode, why || null,
         communicated_at || null, evidence_type || null, evidence_ref || null, source_tour_id || null,
         ev, dedupeKey]
      );
      await client.query("release savepoint incident_insert");
      incident = inc.rows[0];
    } catch (e) {
      if (e.code === "23505" && dedupeKey) {
        // the belt caught a race. Roll back JUST the failed insert (not the
        // whole tx — Postgres aborts to the savepoint), then re-read the
        // winner. The spent event row is harmless (a witnessed attempt).
        await client.query("rollback to savepoint incident_insert");
        await client.query("release savepoint incident_insert");
        const won = await client.query(`select * from concession_incidents where dedupe_key = $1 limit 1`, [dedupeKey]);
        const inc0 = won.rows[0] || null;
        let ob0 = null;
        if (inc0 && inc0.obligation_id) {
          ob0 = (await client.query(`select * from obligations where id = $1`, [inc0.obligation_id])).rows[0] || null;
        }
        // inc0 may be null if the winner is mid-commit under READ COMMITTED —
        // still a correct dedupe: no second row was created, and the caller is
        // told plainly this promise is already being recorded.
        return { incident: inc0, obligation: ob0, deduped: true };
      }
      throw e;
    }
    const target = await escalationRoleFor(client, property_id, spoken_by_person_id);
    const obligation = await spawnObligationFromEvent(client, {
      property_id, person_id,
      source_event_id: ev,
      module: "management",
      type: "concession_incident",
      label: `Off-guardrail promise (${money(proposed_value)}) needs resolution — retract, correct, approve, or replace`,
      assigned_role: target,
      escalates_to_role: "owner",
      priority: "high",
      related_id: incident.id,
      related_type: "concession_incident",
    });
    const upd = await client.query(
      `update concession_incidents set obligation_id = $1, updated_at = now()
        where id = $2 returning *`, [obligation.id, incident.id]);
    return { incident: upd.rows[0], obligation };
  }

  // ── SERVICE: resolveConcessionIncident ────────────────────────────
  // Closes the loop: retract | correct | approve | replace, with a note
  // and a real resolver. 'approve' does NOT auto-mint an offer in V1 —
  // the receipt directs reissue through the capture path (an approved
  // promise still deserves evidence of communication).
  async function resolveConcessionIncident(client, { incident_id, resolution, resolved_by_person_id, note = null }) {
    if (!INCIDENT_RESOLUTIONS.includes(resolution)) {
      throw ledgerError("BAD_INPUT", `resolution must be one of: ${INCIDENT_RESOLUTIONS.join(", ")}`);
    }
    if (!resolved_by_person_id) throw ledgerError("BAD_INPUT", "resolved_by_person_id required — a human resolves");
    if (!note || !String(note).trim()) {
      throw ledgerError("BAD_INPUT", "a resolution note is required — the person who made the promise deserves the why");
    }
    const q = await client.query(`select * from concession_incidents where id = $1 for update`, [incident_id]);
    if (q.rowCount === 0) throw ledgerError("NOT_FOUND", "incident not found");
    const inc = q.rows[0];
    if (inc.status !== "open") throw ledgerError("NOT_OPEN", `incident is already ${inc.status}`);
    await mustPerson(client, resolved_by_person_id, "resolver");

    if (inc.obligation_id && completeObligation) {
      try {
        await completeObligation(client, { obligation_id: inc.obligation_id, completed_by: resolved_by_person_id });
      } catch (e) { if (e.code !== "ALREADY_COMPLETE") throw e; }
    }
    const upd = await client.query(
      `update concession_incidents
          set status = 'resolved', resolution = $1, resolution_note = $2,
              resolved_by_person_id = $3, resolved_at = now(), updated_at = now()
        where id = $4 returning *`,
      [resolution, note, resolved_by_person_id, incident_id]
    );
    await witness(client, {
      property_id: inc.property_id, person_id: inc.person_id,
      type: "concession_incident_resolved",
      note: `Off-guardrail promise (${money(inc.proposed_value)}) resolved: ${resolution} — ${note}`,
    });
    return upd.rows[0];
  }

  // ── SERVICE: createLeaseOffer (rev 2 — the corrected dial) ────────
  // spec: { property_id, granted_by_person_id, person_id?, application_id?,
  //   TARGET: space_id  XOR  { scope: 'property'|'unit_type'|'bed_type', scope_ref },
  //   source: 'published'|'discretionary', unit_type, lease_term_months,
  //   EVIDENCE (all-or-none; absent = DRAFT):
  //     communicated_at, evidence_type, evidence_ref, source_tour_id?,
  //   recorded_by_person_id?,
  //   published: { policy_id },
  //   discretionary: { concessions:[{concession_type,value,fee_category?,timing_profile?}], reason_code? } }
  //
  // RETURNS one of:
  //   { offer, band, concession_authority_value }            — the promise stands
  //   { blocked: true, incident, obligation, band, why }     — hard: no offer,
  //                                                            promise RECORDED
  async function createLeaseOffer(client, spec) {
    const {
      property_id, granted_by_person_id,
      person_id = null, application_id = null,
      space_id = null, scope = null, scope_ref = null,
      source, unit_type, lease_term_months,
      communicated_at = null, evidence_type = null, evidence_ref = null,
      source_tour_id = null, recorded_by_person_id = null,
      // #2 intent: 'communicated' (a real promise) vs 'exploratory' (an agent
      // checking whether something is allowed). Only a communicated promise
      // can mint a hard-mode incident. Default communicated for back-compat
      // with the published/in-scope paths that never reach the incident branch.
      promise_state = "communicated",
      // #4 the economic envelope for a SCOPED offer — the authorized ceiling
      // when the exact space (and thus exact economics) is not yet known.
      max_economic_value = null,
      // #1/#2 evidence-timing bounds. tour_window_* is the OBSERVED window
      // (actual attendance / recorded start-end) — real operational evidence.
      // scheduled_reference is the PLANNED appointment time — a labeled
      // fallback boundary only, never treated as verified actual communication.
      tour_window_start = null, tour_window_end = null,
      scheduled_reference = null, late_capture_reason = null,
    } = spec || {};

    if (!property_id) throw ledgerError("BAD_INPUT", "property_id required");
    if (!granted_by_person_id) throw ledgerError("BAD_INPUT", "granted_by_person_id required — a human offers");
    if (!["published", "discretionary"].includes(source)) {
      throw ledgerError("BAD_INPUT", "source must be published or discretionary");
    }
    if (!PROMISE_STATES.includes(promise_state)) {
      throw ledgerError("BAD_INPUT", `promise_state must be one of: ${PROMISE_STATES.join(", ")}`);
    }
    if (!unit_type || typeof unit_type !== "string") throw ledgerError("BAD_INPUT", "unit_type required");
    const termMonths = Number(lease_term_months);
    if (!Number.isInteger(termMonths) || termMonths < 1 || termMonths > 36) {
      throw ledgerError("BAD_INPUT", "lease_term_months must be 1–36");
    }

    // TARGET: exactly one shape (reviewer #2 — an offer never holds a room)
    if (space_id && scope) throw ledgerError("BAD_INPUT", "offer target is space_id OR scope — never both");
    if (!space_id && !scope) throw ledgerError("BAD_INPUT", "offer needs a target: an exact space_id or an eligibility scope");
    if (scope && !OFFER_SCOPES.includes(scope)) {
      throw ledgerError("BAD_INPUT", `scope must be one of: ${OFFER_SCOPES.join(", ")}`);
    }
    if (scope && scope !== "property" && !scope_ref) {
      throw ledgerError("BAD_INPUT", `${scope} scope requires scope_ref (the segment name)`);
    }

    // EVIDENCE: all-or-none (draft ≠ promise)
    const evidenced = !!(communicated_at || evidence_type || evidence_ref);
    if (evidenced && !(communicated_at && evidence_type && evidence_ref)) {
      throw ledgerError("BAD_INPUT", "evidence is all-or-none: communicated_at + evidence_type + evidence_ref");
    }
    if (evidenced && !EVIDENCE_TYPES.includes(evidence_type)) {
      throw ledgerError("BAD_INPUT", `evidence_type must be one of: ${EVIDENCE_TYPES.join(", ")}`);
    }
    if (evidenced && isNaN(Date.parse(communicated_at))) {
      throw ledgerError("BAD_INPUT", "communicated_at must be a valid timestamp");
    }
    // #1 ANTI-BACKDATING BOUNDS by evidence type. communicated_at is the
    // authority-decision moment, so it cannot be forged. A future promise is
    // never valid. A tour attestation must fall within the tour window unless
    // an attributable late-capture reason is given (the honest escape hatch —
    // recorded, not silent). Message/follow-up evidence is expected to derive
    // communicated_at from the immutable outbound event; we reject a future
    // value here and record the derivation expectation in the basis.
    if (evidenced) {
      const commMs = Date.parse(communicated_at);
      const nowMs = Date.now();
      const SKEW = 2 * 60 * 1000; // 2-min clock skew tolerance
      if (commMs > nowMs + SKEW) {
        throw ledgerError("COMMUNICATED_IN_FUTURE",
          "communicated_at cannot be in the future — a promise is heard before it is recorded");
      }
      if (evidence_type === "tour_host_attestation") {
        // #2 EVIDENCE HONESTY. The OBSERVED window (actual attendance /
        // recorded start-end) is real operational evidence and may bound
        // communicated_at directly. A PLANNED scheduled time is not proof the
        // tour happened then — it may serve as a sanity fallback boundary, but
        // an attestation resting only on a planned time (no observed window)
        // is an after-the-fact CLAIM and REQUIRES an attributable
        // late_capture_reason. This prevents scheduled time from masquerading
        // as verified actual communication.
        const ws = tour_window_start ? Date.parse(tour_window_start) : null;
        const we = tour_window_end ? Date.parse(tour_window_end) : null;
        const hasObservedWindow = ws != null && we != null;
        if (hasObservedWindow) {
          const inObserved = commMs >= ws - SKEW && commMs <= we + SKEW;
          if (!inObserved && !late_capture_reason) {
            throw ledgerError("ATTESTATION_OUT_OF_WINDOW",
              "the attestation falls outside the OBSERVED tour window and carries no late_capture_reason");
          }
        } else {
          // no observed window → a bare claim. Optionally sanity-check against
          // the planned time only to reject the physically impossible (a promise
          // long before the appointment was even scheduled), but never treat it
          // as verified. Absent a reason, refuse — the claim is unbounded.
          if (!late_capture_reason) {
            throw ledgerError("ATTESTATION_UNBOUNDED",
              "a host attestation with no observed tour window is an after-the-fact claim — it requires an attributable late_capture_reason (a scheduled appointment time is not proof of when the promise was communicated)");
          }
          if (scheduled_reference && !isNaN(Date.parse(scheduled_reference))) {
            const sched = Date.parse(scheduled_reference);
            // reject only the impossible: communicated more than a day BEFORE
            // the appointment was scheduled to even occur.
            if (commMs < sched - 24 * 3600 * 1000) {
              throw ledgerError("COMMUNICATED_BEFORE_SCHEDULE",
                "communicated_at is more than a day before the scheduled tour — the promise cannot predate the appointment that produced it");
            }
          }
        }
      }
    }

    await mustProperty(client, property_id);
    await mustPerson(client, granted_by_person_id, "granting person");
    if (space_id) await mustSpaceOnProperty(client, space_id, property_id);
    if (person_id) await mustPerson(client, person_id, "offer recipient");

    // #1 the as-of moment: the authority/policy snapshot resolves as of when
    // the prospect heard the promise. Unevidenced (draft) offers have no
    // communication moment → now(). Passed to every validity-windowed read.
    const asOf = evidenced ? communicated_at : null;
    // #2 provenance of communicated_at, recorded honestly into the basis:
    //   'observed_window' — bounded by real attendance/recorded start-end
    //   'attested_with_reason' — after-the-fact host claim + late_capture_reason
    //   'message_derived' — from an immutable outbound event
    //   'unbounded_now' — a bare recorded_at for a non-attestation evidenced offer
    let evidence_provenance = null;
    if (evidenced) {
      if (evidence_type === "tour_host_attestation") {
        evidence_provenance = (tour_window_start && tour_window_end)
          ? "observed_window" : "attested_with_reason";
      } else {
        evidence_provenance = "message_derived";
      }
    }

    const verQ = await client.query(
      `select id from property_pricing_versions
        where property_id = $1 and status = 'published'
          and (effective_from is null or effective_from <= coalesce($2::timestamptz, now()))
        order by effective_from desc nulls last limit 1`,
      [property_id, asOf]
    );
    const pricing_version_id = verQ.rowCount ? verQ.rows[0].id : null;
    const base_rent = await segmentBaseRent(client, property_id, unit_type, termMonths);

    let concessions, authority_basis, expires_at = null,
        qualifying_action = "application_submitted",
        guardrail_flag = false, band = "pre_authorized",
        source_policy_id = null, value;

    if (source === "published") {
      const policy_id = spec.published && spec.published.policy_id;
      if (!policy_id) throw ledgerError("BAD_INPUT", "published offer requires published.policy_id");
      // #1 policy validity resolved AS OF communicated_at, not now()
      const pQ = await client.query(
        `select p.* from concession_policies p
          where p.id = $1 and p.property_id = $2 and p.active = true
            and (p.valid_from is null or p.valid_from <= coalesce($3::timestamptz, now()))
            and (p.valid_until is null or p.valid_until > coalesce($3::timestamptz, now()))`,
        [policy_id, property_id, asOf]
      );
      if (pQ.rowCount === 0) {
        throw ledgerError("POLICY_UNAVAILABLE",
          "that published offer was not live on this property at the moment it was communicated (expired, retired, superseded, wrong property, or not yet effective)");
      }
      const policy = pQ.rows[0];
      if (policy.pricing_version_id !== pricing_version_id) {
        throw ledgerError("POLICY_UNAVAILABLE", "that offer belongs to a pricing version that was not the live one when it was communicated");
      }
      if (policy.required_term_months != null && Number(policy.required_term_months) !== termMonths) {
        throw ledgerError("TERM_MISMATCH",
          `this offer requires a ${policy.required_term_months}-month lease`);
      }
      // #5 CALENDAR COMMUNICATE GUARD: a timing-dependent published policy
      // cannot be communicated (turned into a live promise) until its timing
      // profile is implemented and proven. Publishing was already blocked
      // (see publishPricing) — this is the second wall, protecting the moment
      // of the promise even if a legacy policy slipped through.
      if (isCalendarDependent(policy.concession_type, policy.timing_profile)
          && !timingProfileReady(policy.timing_profile)) {
        throw ledgerError("CALENDAR_CONTRACT_MISSING",
          `this offer's timing profile (${policy.timing_profile}) has no proven calendar implementation yet — it cannot be communicated as a promise until the calendar contract is filled`);
      }
      concessions = [{
        concession_type: policy.concession_type,
        value: Number(policy.value),
        fee_category: policy.fee_category,
        timing_profile: policy.timing_profile,
      }];
      qualifying_action = policy.qualifying_action;
      // THE CLOCK runs from communicated_at (the promise was made then) —
      // stated default; only an evidenced (non-draft) offer gets a clock.
      if (evidenced && policy.qualifying_window_hours != null) {
        expires_at = new Date(Date.parse(communicated_at) + Number(policy.qualifying_window_hours) * 3600 * 1000);
      } else if (evidenced && policy.valid_until) {
        expires_at = policy.valid_until;
      }
      source_policy_id = policy.id;
      // #1 the basis snapshots WHAT WAS TRUE at communicated_at
      authority_basis = { via: "published_policy", policy_id: policy.id, pricing_version_id,
        resolved_as_of: asOf, evidence_type: evidence_type || null,
        evidence_provenance };
      // #4 value: a bound published offer computes against base rent; a scoped
      // published offer (rare, but allowed) needs the envelope ceiling too.
      if (scope) {
        if (max_economic_value == null || !(Number(max_economic_value) > 0)) {
          throw ledgerError("ENVELOPE_REQUIRED",
            "a scoped published offer must carry max_economic_value — the exact space (and its exact economics) is not yet chosen");
        }
        value = Math.round(Number(max_economic_value) * 100) / 100;
        authority_basis.envelope = { max_economic_value: value, basis: "scoped_ceiling" };
      } else {
        value = computeConcessionValue(concessions, base_rent);
      }
    } else {
      // ── discretionary — THE DIAL (rev 2 semantics + path-two contracts) ──
      const d = spec.discretionary || {};
      concessions = (d.concessions || []).map((c) => ({
        concession_type: c.concession_type,
        value: Number(c.value),
        fee_category: c.fee_category ?? null,
        timing_profile: c.timing_profile || "first_full_month",
      }));
      if (concessions.length === 0) throw ledgerError("BAD_INPUT", "discretionary offer requires at least one concession");
      for (const c of concessions) {
        if (!CONCESSION_TYPES.includes(c.concession_type)) {
          throw ledgerError("BAD_INPUT", `concession_type must be one of: ${CONCESSION_TYPES.join(", ")}`);
        }
        if (c.concession_type === "fee_waiver" && !c.fee_category) {
          throw ledgerError("BAD_INPUT", "fee_waiver requires fee_category");
        }
        if (!TIMING_PROFILES.includes(c.timing_profile)) {
          throw ledgerError("BAD_INPUT", `timing_profile must be one of: ${TIMING_PROFILES.join(", ")}`);
        }
        // #5 CALENDAR COMMUNICATE GUARD: a timing-dependent discretionary
        // concession cannot be communicated until its profile is proven.
        if (evidenced && isCalendarDependent(c.concession_type, c.timing_profile)
            && !timingProfileReady(c.timing_profile)) {
          throw ledgerError("CALENDAR_CONTRACT_MISSING",
            `timing profile ${c.timing_profile} has no proven calendar implementation — this concession cannot be communicated as a promise yet`);
        }
      }

      // #4 the ECONOMIC ENVELOPE. When the exact space is unknown (a scoped
      // offer), free_rent cannot be valued against one base rent, and the
      // final economics depend on which space is chosen. So a scoped offer
      // MUST carry an explicit authorized ceiling (max_economic_value); the
      // authority check runs against that ceiling. A bound offer (exact
      // space) values normally. computeConcessionValue already fail-closes
      // (UNPRICED_SEGMENT) when free_rent meets a scope with no base rent.
      if (scope) {
        if (max_economic_value == null || !(Number(max_economic_value) > 0)) {
          throw ledgerError("ENVELOPE_REQUIRED",
            "a scoped offer must carry max_economic_value — the authorized ceiling, since the exact space (and its exact economics) is not yet chosen");
        }
        value = Math.round(Number(max_economic_value) * 100) / 100;
      } else {
        value = computeConcessionValue(concessions, base_rent);
      }

      // #1 authority resolved AS OF communicated_at
      const policy = await resolveGuardrailPolicy(client, property_id, granted_by_person_id, asOf);
      const grant = policy.grant;

      // scope check against the grant
      let inScope = false, scopeWhy = "no active grant — no discretionary authority exists";
      if (grant) {
        inScope = true; scopeWhy = null;
        let freeMonths = 0;
        for (const c of concessions) {
          if (c.concession_type === "free_rent") {
            freeMonths += Number(c.value);
          } else if (c.concession_type === "fee_waiver") {
            const flag = FEE_WAIVER_FLAG[c.fee_category];
            if (!flag || !grant[flag]) { inScope = false; scopeWhy = `${c.fee_category || "that"} fee waiver is not in your grant`; break; }
          }
          if (grant.permitted_concession_timing_profile &&
              c.timing_profile !== grant.permitted_concession_timing_profile) {
            inScope = false; scopeWhy = `timing profile ${c.timing_profile} is outside your grant`; break;
          }
        }
        if (inScope && freeMonths > Number(grant.maximum_discretionary_free_rent_months)) {
          inScope = false; scopeWhy = `${freeMonths} free month(s) exceeds your ${grant.maximum_discretionary_free_rent_months}`;
        }
        if (inScope && value > Number(grant.max_discretionary_value)) {
          inScope = false; scopeWhy = `${money(value)} exceeds your discretionary cap ${money(grant.max_discretionary_value)}`;
        }
      }

      // #4 THE SCOPED HARD-GATE LINE. A scoped offer's segment eligibility
      // ("any Studio") is only ATTESTED — units carry no verified type source
      // yet. An attested assertion may satisfy a SOFT decision (a human stands
      // behind it, reviewably), but it can NEVER satisfy a HARD gate, which
      // demands verified eligibility that does not exist. So a scoped offer
      // under hard mode is refused honestly, BEFORE it can be recorded as an
      // in-scope grant — this is the exact fake-verification the honest label
      // was meant to prevent. (property_scope is exempt only when the whole
      // property is the eligibility set AND the envelope is authorized above.)
      if (inScope && grant && policy.mode === "hard" && scope && scope !== "property") {
        inScope = false;
        scopeWhy = `a ${scope} scope ("${scope_ref}") is only attested, not verified — hard-mode authority cannot rest on an unverified segment match`;
      }

      if (inScope) {
        band = "within_grant";
        authority_basis = {
          via: "grant", grant_id: grant.id, assignment_id: grant.assignment_id,
          max_discretionary_value: Number(grant.max_discretionary_value),
          guardrail_mode: policy.mode, value,
          resolved_as_of: asOf, evidence_provenance,
          envelope: scope ? { max_economic_value: value, basis: "scoped_ceiling" } : null,
        };
      } else if (policy.mode === "hard") {
        // ── HARD: block the binding offer, RECORD the promise — but ONLY
        //    a promise that was actually COMMUNICATED (#2). ──────────────
        // An exploratory selection ("is this allowed?") that hard-fails must
        // NOT mint an incident claiming a promise was made — that would
        // manufacture a false operational record, the mirror image of losing
        // a real one. Exploratory → refuse, write nothing. A communicated
        // hard-blocked concession → durable incident (which REQUIRES evidence;
        // no evidence means there is no attributable promise to record).
        if (promise_state === "exploratory") {
          return {
            blocked: true, incident: null, obligation: null,
            band: policy.source === "no_grant" ? "no_grant_blocked_exploratory" : "hard_blocked_exploratory",
            why: scopeWhy, proposed_value: value, exploratory: true,
          };
        }
        if (!evidenced) {
          throw ledgerError("PROMISE_NEEDS_EVIDENCE",
            "a communicated hard-blocked concession must carry evidence (communicated_at + evidence_type + evidence_ref) to be recorded as an incident — without it there is no attributable promise. If this was exploratory, send promise_state='exploratory'.");
        }
        const { incident, obligation, deduped } = await recordConcessionIncident(client, {
          property_id, person_id,
          spoken_by_person_id: granted_by_person_id,
          recorded_by_person_id,
          proposed_terms: { unit_type, lease_term_months: termMonths, base_rent, concessions,
                            target: space_id ? { space_id } : { scope, scope_ref },
                            envelope: scope ? { max_economic_value: value } : null },
          proposed_value: value,
          guardrail_mode: policy.source === "no_grant" ? "none" : "hard",
          why: scopeWhy,
          communicated_at, evidence_type, evidence_ref, source_tour_id,
          source_event_signature: concessionSignature(concessions, scope, scope_ref, space_id),
        });
        return {
          blocked: true, incident, obligation, deduped: deduped === true,
          band: policy.source === "no_grant" ? "no_grant_blocked" : "hard_blocked",
          why: scopeWhy, proposed_value: value,
        };
      } else {
        // ── SOFT: honored + flagged. Life is never stopped. ────────
        // NO decision case (the rail exits soft mode). over_threshold is
        // stamped into the snapshot; the review obligation spawns at
        // LOCK, atomically with the schedule.
        guardrail_flag = true;
        const over = value > policy.threshold;
        band = over ? "soft_flagged_over_threshold" : "soft_flagged";
        authority_basis = {
          via: "grant_exceeded_soft",
          grant_id: grant.id, why: scopeWhy, value,
          guardrail_mode: "soft",
          escalation_threshold: policy.threshold,
          over_threshold: over,
          resolved_as_of: asOf, evidence_provenance,
          envelope: scope ? { max_economic_value: value, basis: "scoped_ceiling" } : null,
        };
      }
    }

    // both branches set `value` (bound → computed; scoped → envelope ceiling).
    if (typeof value === "undefined" || !(value >= 0)) {
      throw ledgerError("BAD_INPUT", "internal: concession value was not resolved");
    }
    const offered_terms_snapshot = {
      unit_type, lease_term_months: termMonths, base_rent,
      concessions, source,
      target: space_id ? { space_id } : { scope, scope_ref },
      envelope: scope ? { max_economic_value: value, basis: "scoped_ceiling" } : null,
    };

    const status = evidenced ? "sent" : "draft";
    const o = await client.query(
      `insert into lease_offers
         (property_id, person_id, application_id, space_id, scope, scope_ref,
          source, source_policy_id, offered_terms_snapshot, authority_basis_snapshot,
          source_pricing_version_id, concession_authority_value,
          guardrail_flag, status, qualifying_action, expires_at,
          communicated_at, evidence_type, evidence_ref,
          granted_by_person_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       returning *`,
      [property_id, person_id, application_id, space_id, scope, scope_ref,
       source, source_policy_id, JSON.stringify(offered_terms_snapshot),
       JSON.stringify(authority_basis), pricing_version_id, value,
       guardrail_flag, status, qualifying_action, expires_at,
       communicated_at, evidence_type, evidence_ref,
       granted_by_person_id]
    );
    const offer = o.rows[0];

    await witness(client, {
      property_id, person_id, type: "lease_offer_created",
      note: `Offer (${source}${status === "draft" ? " · DRAFT — not yet a promise" : ""}) · value ${money(value)} · ${band}${guardrail_flag ? " · FLAGGED" : ""}`,
    });

    return { offer, band, concession_authority_value: value };
  }

  // ── SERVICE: qualifyOffer (server-side clock) ─────────────────────
  async function qualifyOffer(client, { offer_id, action }) {
    if (!QUALIFYING_ACTIONS.includes(action)) {
      throw ledgerError("BAD_INPUT", `action must be one of: ${QUALIFYING_ACTIONS.join(", ")}`);
    }
    const q = await client.query(`select * from lease_offers where id = $1 for update`, [offer_id]);
    if (q.rowCount === 0) throw ledgerError("NOT_FOUND", "offer not found");
    const offer = q.rows[0];
    if (offer.status === "draft") {
      throw ledgerError("DRAFT_NOT_PROMISE",
        "this offer is a draft — it was never evidenced as communicated to the prospect, so it cannot qualify (draft ≠ promise)");
    }
    if (offer.status !== "sent") {
      throw ledgerError("NOT_QUALIFIABLE", `offer is ${offer.status} — only a sent offer can qualify`, { status: offer.status });
    }

    const expiredQ = await client.query(
      `select ($1::timestamptz is not null and $1::timestamptz <= now()) as expired`,
      [offer.expires_at]
    );
    if (expiredQ.rows[0].expired) {
      const upd = await client.query(
        `update lease_offers set status = 'expired', updated_at = now() where id = $1 returning *`,
        [offer_id]);
      await witness(client, {
        property_id: offer.property_id, person_id: offer.person_id,
        type: "lease_offer_expired",
        note: `Offer expired server-side before qualifying (${action} arrived after the deadline)`,
      });
      return { offer: upd.rows[0], qualified: false, reason: "expired" };
    }
    if (action !== offer.qualifying_action) {
      return { offer, qualified: false, reason: "wrong_action" };
    }
    const upd = await client.query(
      `update lease_offers set status = 'earned', earned_at = now(), updated_at = now()
        where id = $1 returning *`, [offer_id]);
    await witness(client, {
      property_id: offer.property_id, person_id: offer.person_id,
      type: "lease_offer_earned",
      note: `Offer earned by ${action} within the window`,
    });
    return { offer: upd.rows[0], qualified: true };
  }

  // ── the calendar contract — HONEST STUB (open ask; wall #1) ───────
  function computeScheduleLines(/* offer, moveInDate */) {
    throw ledgerError("CALENDAR_CONTRACT_MISSING",
      "cannot place dated economic lines — the calendar contract (timing-profile month placement) is not filled yet. It is answered from real lease documents, not computed by assumption.");
  }

  async function findEligibleOfferForApplication(client, application_id) {
    const r = await client.query(
      `select * from lease_offers
        where application_id = $1
          and status in ('sent','earned')
        order by created_at desc`,
      [application_id]
    );
    return r.rows;
  }

  // ── SERVICE: lockLeaseEconomics (J1 — rev 2) ─────────────────────
  // Inside the countersign transaction. rev 2:
  //  · the GRANT_PENDING / GRANT_DENIED lock gates are REMOVED — they
  //    were pre-clearance in soft clothing. (They belong to the future
  //    provisional mode; decision_case_id is retained for it.)
  //  · SCOPED offers resolve their exact space HERE: resolved_space_id
  //    is required, property-wall verified, and the resolution basis is
  //    recorded honestly (segment match is attested, not fake-verified).
  //  · offer↔application binding is strict (an offer cannot silently
  //    attach to the wrong application).
  //  · soft-over-threshold spawns ONE non-blocking review obligation,
  //    atomically with the schedule, idempotent per offer.
  async function lockLeaseEconomics(client, { application_id, offer_id, lines, locked_by_person_id, resolved_space_id = null }) {
    if (!application_id) throw ledgerError("BAD_INPUT", "application_id required");
    if (!offer_id) throw ledgerError("BAD_INPUT", "offer_id required");
    if (!locked_by_person_id) throw ledgerError("BAD_INPUT", "locked_by_person_id required — a human countersigns");
    if (!Array.isArray(lines) || lines.length === 0) {
      throw ledgerError("BAD_INPUT", "lines required — a schedule with no dated lines is not a schedule");
    }

    const appQ = await client.query(`select * from lease_applications where id = $1 for update`, [application_id]);
    if (appQ.rowCount === 0) throw ledgerError("NOT_FOUND", "application not found");
    const application = appQ.rows[0];

    const oQ = await client.query(`select * from lease_offers where id = $1 for update`, [offer_id]);
    if (oQ.rowCount === 0) throw ledgerError("NOT_FOUND", "offer not found");
    let offer = oQ.rows[0];
    if (offer.property_id !== application.property_id) {
      throw ledgerError("PROPERTY_MISMATCH", "offer and application belong to different properties — the wall holds");
    }
    // 2c: strict binding — never silently attach to the wrong application
    if (offer.application_id !== application_id) {
      throw ledgerError("OFFER_NOT_FOR_APPLICATION",
        "this offer is not bound to this application — an offer cannot silently attach to the wrong application");
    }
    if (offer.status === "draft") {
      throw ledgerError("DRAFT_NOT_PROMISE",
        "this offer is a draft — it was never evidenced as communicated, so it cannot lock (draft ≠ promise)");
    }

    // countersign IS the lease_signed qualifying act — earn it inline
    if (offer.status === "sent" && offer.qualifying_action === "lease_signed") {
      const q = await qualifyOffer(client, { offer_id, action: "lease_signed" });
      offer = q.offer;
      if (!q.qualified) {
        throw ledgerError("OFFER_EXPIRED",
          "the offer expired before signing — an expired offer cannot be preserved without reissue");
      }
    }
    if (offer.status !== "earned") {
      throw ledgerError("OFFER_NOT_EARNED",
        `offer is ${offer.status} — only an earned offer locks into a schedule`, { status: offer.status });
    }

    // ── resolve the EXACT space (D5) against the offer's target ────
    let space, space_resolution;
    if (offer.space_id) {
      if (resolved_space_id && resolved_space_id !== offer.space_id) {
        throw ledgerError("SPACE_MISMATCH", "the offer quoted a specific space — the schedule must lock to it");
      }
      space = offer.space_id;
      space_resolution = "exact_offer_bound";
    } else {
      if (!resolved_space_id) {
        throw ledgerError("SPACE_REQUIRED",
          "this offer is scoped, not slot-bound — a resolved space_id is required at lock (an offer never holds a room; the lease chooses one)");
      }
      await mustSpaceOnProperty(client, resolved_space_id, offer.property_id);
      space = resolved_space_id;
      // honest basis: property wall verified always; unit_type/bed_type
      // segment match is ATTESTED (schema has no unit_type source yet)
      space_resolution = offer.scope === "property" ? "property_scope" : "caller_attested_segment";
    }

    // validate lines — shape + D12 consistency
    let reduction = 0;
    for (const ln of lines) {
      if (!ln.effective_month || isNaN(Date.parse(ln.effective_month))) {
        throw ledgerError("BAD_INPUT", "each line needs an effective_month date");
      }
      const amt = Number(ln.amount);
      if (!Number.isFinite(amt)) throw ledgerError("BAD_INPUT", "each line needs a numeric amount");
      if (["concession_credit", "fee_waiver"].includes(ln.line_type)) {
        if (amt >= 0) throw ledgerError("BAD_INPUT", `${ln.line_type} lines must be negative (signed convention)`);
        reduction += -amt;
      } else if (["base_rent", "recurring_fee", "one_time_fee"].includes(ln.line_type)) {
        if (amt < 0) throw ledgerError("BAD_INPUT", `${ln.line_type} lines must be non-negative`);
      } else {
        throw ledgerError("BAD_INPUT", `unknown line_type ${ln.line_type}`);
      }
    }
    reduction = Math.round(reduction * 100) / 100;
    const authorized = Math.round(Number(offer.concession_authority_value) * 100) / 100;
    const isScoped = !offer.space_id;
    if (isScoped) {
      // #4 RE-EVALUATION AT EXACT-SPACE RESOLUTION. A scoped offer authorized
      // an ENVELOPE (a ceiling), because the exact space — and thus the exact
      // economics — was not known when the promise was made. Now the space is
      // resolved and the real lines exist. The final economics must FIT INSIDE
      // the authorized ceiling; they need not equal it (a $2,000 "any Studio"
      // envelope may resolve to $1,700 in the chosen space). Over the ceiling
      // is a genuine authority breach and is refused.
      if (reduction > authorized + 0.001) {
        throw ledgerError("ENVELOPE_EXCEEDED",
          `the resolved economics (${money(reduction)}) exceed the authorized envelope (${money(authorized)}) — the final space costs more than the promise authorized`,
          { reduction, authorized });
      }
    } else if (reduction !== authorized) {
      // bound offer: exact economics were known at promise time → strict D12.
      throw ledgerError("D12_MISMATCH",
        `the schedule's total reduction (${money(reduction)}) must equal the offer's authorized concession value (${money(authorized)}) to the cent — a lease cannot commit economics nobody authorized`,
        { reduction, authorized });
    }

    let schedule;
    try {
      const s = await client.query(
        `insert into lease_economic_schedules
           (property_id, application_id, space_id, space_resolution, status,
            source_offer_id, source_pricing_version_id, locked_by_person_id)
         values ($1,$2,$3,$4,'locked',$5,$6,$7) returning *`,
        [offer.property_id, application_id, space, space_resolution, offer.id,
         offer.source_pricing_version_id, locked_by_person_id]
      );
      schedule = s.rows[0];
    } catch (e) {
      if (e.code === "23505") {
        throw ledgerError("SCHEDULE_EXISTS", "a live economic schedule already exists for this application — amendments, not edits (D7)");
      }
      throw e;
    }

    for (const ln of lines) {
      await client.query(
        `insert into lease_economic_lines
           (schedule_id, effective_month, line_type, amount, source_reference)
         values ($1,$2,$3,$4,$5)`,
        [schedule.id, ln.effective_month, ln.line_type, ln.amount,
         ln.source_reference || `offer:${offer.id}`]
      );
    }

    await client.query(
      `update lease_offers set status = 'locked', updated_at = now() where id = $1`, [offer.id]);

    // ── soft-over-threshold: the NON-BLOCKING review, atomic + idempotent
    let review_obligation = null;
    const basis = offer.authority_basis_snapshot || {};
    if (basis.over_threshold === true) {
      const existing = await client.query(
        `select id from obligations
          where related_id = $1 and related_type = 'lease_offer' and type = 'concession_review'
          limit 1`, [offer.id]);
      if (existing.rowCount === 0) {
        const ev = await witness(client, {
          property_id: offer.property_id, person_id: offer.person_id,
          type: "concession_review_opened",
          note: `Soft-guardrail promise over threshold (${money(authorized)} > ${money(basis.escalation_threshold)}) locked with the lease — non-blocking review opened`,
        });
        const target = await escalationRoleFor(client, offer.property_id, offer.granted_by_person_id);
        try {
          review_obligation = await spawnObligationFromEvent(client, {
            property_id: offer.property_id, person_id: offer.person_id,
            source_event_id: ev,
            module: "management",
            type: "concession_review",
            label: `An agent made a ${money(authorized)} promise over their guardrail — review the pattern and decide what changes going forward (the commitment stands)`,
            assigned_role: target,
            escalates_to_role: "owner",
            priority: "normal",
            related_id: offer.id,
            related_type: "lease_offer",
          });
        } catch (e) {
          if (e.code === "23505") review_obligation = null; // belt: unique index won a race
          else throw e;
        }
      }
    }

    await witness(client, {
      property_id: offer.property_id, person_id: offer.person_id,
      type: "lease_economics_locked",
      note: `Economic schedule locked at countersign · ${lines.length} dated line(s) · reduction ${money(reduction)} · ${space_resolution} · offer ${offer.id}`,
    });

    return { schedule, line_count: lines.length, review_obligation };
  }

  // ── HTTP skin ─────────────────────────────────────────────────────
  const httpStatus = {
    BAD_INPUT: 400, NOT_FOUND: 404, NO_AUTHORITY: 403,
    UNPRICED_SEGMENT: 409, POLICY_UNAVAILABLE: 409, TERM_MISMATCH: 409,
    NOT_QUALIFIABLE: 409, OFFER_NOT_EARNED: 409, OFFER_EXPIRED: 409,
    DRAFT_NOT_PROMISE: 409, OFFER_NOT_FOR_APPLICATION: 409,
    SPACE_REQUIRED: 409, SPACE_MISMATCH: 409, D12_MISMATCH: 409,
    SCHEDULE_EXISTS: 409, NOT_OPEN: 409,
    SPACE_NOT_ON_PROPERTY: 403, PROPERTY_MISMATCH: 403,
    CALENDAR_CONTRACT_MISSING: 501,
    // path-two contracts
    COMMUNICATED_IN_FUTURE: 400, ATTESTATION_OUT_OF_WINDOW: 400,
    ATTESTATION_UNBOUNDED: 400, COMMUNICATED_BEFORE_SCHEDULE: 400,
    ENVELOPE_REQUIRED: 400, ENVELOPE_EXCEEDED: 409,
    PROMISE_NEEDS_EVIDENCE: 400,
  };
  function sendErr(res, e) {
    const s = httpStatus[e.code] || 500;
    const body = { error: e.message, code: e.code || "INTERNAL" };
    if (e.why) body.why = e.why;
    return res.status(s).json(body);
  }
  async function inTx(fn) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const out = await fn(client);
      await client.query("commit");
      return out;
    } catch (e) {
      try { await client.query("rollback"); } catch (_) {}
      throw e;
    } finally { client.release(); }
  }

  app.post("/pricing/:propertyId/publish", dormantWriteGuard, async (req, res) => {
    try {
      const out = await inTx((c) => publishPricing(c, { ...(req.body || {}), property_id: req.params.propertyId }));
      res.status(201).json({
        version_id: out.version.id,
        superseded_version_id: out.superseded_version_id,
        receipt: `Pricing published${out.superseded_version_id ? " — prior version retired; existing locked schedules untouched" : ""}.`,
      });
    } catch (e) { sendErr(res, e); }
  });

  app.get("/pricing/:propertyId/active", async (req, res) => {
    try {
      const out = await inTx((c) => getActivePricing(c, req.params.propertyId));
      res.json(out);
    } catch (e) { sendErr(res, e); }
  });

  app.post("/lease-offers", dormantWriteGuard, async (req, res) => {
    try {
      const out = await inTx((c) => createLeaseOffer(c, req.body || {}));
      if (out.blocked) {
        // #2 exploratory: blocked, NO incident — an agent checking "is this
        // allowed?" did not promise anything. Refuse, record nothing.
        if (out.exploratory) {
          return res.status(403).json({
            blocked: true, exploratory: true, incident_id: null,
            offer_created: false, proposed_value: out.proposed_value, why: out.why,
            receipt: `Not permitted (${out.why}). This was an exploratory check — nothing was promised, so nothing was recorded. Communicate it only if you intend to make the offer.`,
          });
        }
        // #3 committed-403: the response plainly states no valid offer was
        // created, the incident WAS recorded, its id, and resolution state.
        // deduped=true means a prior identical submit already recorded it;
        // under a mid-commit race the row may not yet be visible — still a
        // correct dedupe (no second write), reported honestly.
        if (out.deduped && !out.incident) {
          return res.status(409).json({
            blocked: true, offer_created: false, deduped: true, incident_id: null,
            proposed_value: out.proposed_value, why: out.why,
            receipt: `This exact promise is already being recorded (concurrent submit). No second offer or incident was created.`,
          });
        }
        return res.status(403).json({
          blocked: true,
          offer_created: false,
          incident_id: out.incident.id,
          incident_status: out.incident.status,          // 'open' until resolved
          incident_resolution: out.incident.resolution || null,
          deduped: out.deduped === true,                 // idempotent replay
          proposed_value: out.proposed_value,
          why: out.why,
          receipt: `${out.deduped ? "Already recorded — " : ""}No valid offer was created (${out.why}). Hard guardrails: the binding offer was refused, but the promise was recorded as incident ${out.incident.id} (status: ${out.incident.status}) and routed for resolution. Nothing said on a tour disappears.`,
        });
      }
      const draft = out.offer.status === "draft";
      res.status(201).json({
        offer_id: out.offer.id, band: out.band,
        status: out.offer.status,
        concession_authority_value: out.concession_authority_value,
        guardrail_flag: out.offer.guardrail_flag,
        expires_at: out.offer.expires_at,
        receipt: draft
          ? `DRAFT saved, value ${money(out.concession_authority_value)} — not yet a promise (no communication evidence). It cannot qualify or lock until evidenced.`
          : out.offer.guardrail_flag
            ? `Offer written and honored, value ${money(out.concession_authority_value)} — flagged (outside your grant)${out.band === "soft_flagged_over_threshold" ? "; a management review will open when it locks (the commitment stands)" : ""}.`
            : `Offer created, value ${money(out.concession_authority_value)}.`,
      });
    } catch (e) { sendErr(res, e); }
  });

  app.post("/lease-offers/:id/qualify", dormantWriteGuard, async (req, res) => {
    try {
      const out = await inTx((c) => qualifyOffer(c, { offer_id: req.params.id, action: (req.body || {}).action }));
      res.json({
        offer_id: out.offer.id, status: out.offer.status, qualified: out.qualified,
        receipt: out.qualified ? "Offer earned within the window."
          : out.reason === "expired" ? "Offer expired server-side — the deadline passed before the qualifying action."
          : "That action does not qualify this offer.",
      });
    } catch (e) { sendErr(res, e); }
  });

  app.get("/lease-offers/:id", async (req, res) => {
    try {
      const out = await inTx(async (c) => {
        const r = await c.query(`select * from lease_offers where id = $1`, [req.params.id]);
        if (r.rowCount === 0) throw ledgerError("NOT_FOUND", "offer not found");
        return r.rows[0];
      });
      res.json(out);
    } catch (e) { sendErr(res, e); }
  });

  app.get("/concessions/incidents", async (req, res) => {
    try {
      const out = await inTx(async (c) => {
        if (!req.query.property_id) throw ledgerError("BAD_INPUT", "property_id required");
        const r = await c.query(
          `select i.*, p.name as spoken_by_name
             from concession_incidents i
             left join persons p on p.id = i.spoken_by_person_id
            where i.property_id = $1 and i.status = 'open'
            order by i.recorded_at asc`, [req.query.property_id]);
        return r.rows;
      });
      res.json({ count: out.length, incidents: out });
    } catch (e) { sendErr(res, e); }
  });

  app.post("/concessions/incidents/:id/resolve", dormantWriteGuard, async (req, res) => {
    try {
      const b = req.body || {};
      const out = await inTx((c) => resolveConcessionIncident(c, {
        incident_id: req.params.id, resolution: b.resolution,
        resolved_by_person_id: b.resolved_by_person_id, note: b.note,
      }));
      res.json({
        incident: out,
        receipt: `Resolved: ${out.resolution}. ${out.resolution === "approve"
          ? "Approval does not mint an offer by itself — reissue it through the capture path so the promise carries communication evidence."
          : "The loop is closed; the person who made the promise can see the why."}`,
      });
    } catch (e) { sendErr(res, e); }
  });

  // consequential logic exposed for callers (house pattern)
  app._service = {
    publishPricing, getActivePricing, createLeaseOffer, qualifyOffer,
    lockLeaseEconomics, computeScheduleLines, findEligibleOfferForApplication,
    computeConcessionValue, resolveGuardrailPolicy,
    recordConcessionIncident, resolveConcessionIncident,
  };
  return app;
};
