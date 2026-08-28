// ════════════════════════════════════════════════════════════════════
//  person_ingress.js — THE ONE DOOR A HUMAN ENTERS PROPERTY SPINE THROUGH
//
//      External systems do not tell Spine who a person is.
//      They submit evidence about a person. Spine governs the resolution.
//
//  ── THE DURABLE OBJECT ──────────────────────────────────────────────
//      one human  →  one Spine person_id  →  one continuous identity
//
//  A new lease, renewal, bed transfer, unit transfer, future lease,
//  move-out or later return does NOT create a new Person. Those are new
//  facts and relationships around the same human. `persons.id` is the
//  durable key — not the phone, not the Yardi resident id, not the lease.
//
//  ── THE EVIDENCE HIERARCHY (governing, owner ruling 2026-08-16) ──────
//      Spine person_id            DURABLE IDENTITY — the only one
//      verified phone             very strong identity evidence
//      email / other credentials  supporting evidence
//      name                       label · weak · NEVER creates identity
//      source record id (s000###) source-system evidence / provenance
//      lease · bed · unit         relationship facts · NEVER identity
//
//  A matching phone is extremely strong evidence and is still NOT
//  permission for a blind merge: numbers get reassigned, shared, mistyped
//  and corrected. So ingress owns the decision, and contradiction REFUSES
//  rather than confidently collapsing two people. In normal operation it
//  recognises continuity instead of asking people to recreate it.
//
//  ── WHY THIS FILE EXISTS AT ALL ─────────────────────────────────────
//  Three separate onboarding paths used to `insert into persons`
//  directly, and the rent-roll one keyed person reuse off a LEASE lookup
//  containing a display name. A renewal moved the lease dates, the key
//  missed, and the same human forked into two Spine identities — proven
//  reproducibly in tests/proofs/person_spine_import_audit.db.js.
//
//  The defect was never the missing external-id table. It was that a
//  domain importer held the authority to mint a human at all.
//
//  ── WHAT THIS IS NOT ────────────────────────────────────────────────
//  Not a matcher library, not an identity registry, not a fuzzy matcher,
//  not a dedupe pass, not a merge engine. It resolves, proposes, or
//  refuses. Correction is a separate, deliberately boring writer
//  (person_supersession.js) that moves nothing.
//
//  CLASSIFICATION: Class 1 — permanent product primitive.
// ════════════════════════════════════════════════════════════════════

"use strict";

const DISPOSITIONS = Object.freeze(["resolved", "created", "proposed", "needs_review", "conflicted"]);
const RESOLUTION_KINDS = Object.freeze(["created", "resolved_existing"]);

/*  ── CHANNEL PROFILES ───────────────────────────────────────────────
 *  ONE INGRESS CONTRACT, CHANNEL-SPECIFIC EVIDENCE — not one universal
 *  matching algorithm. The leasing resolver keys on phone and email
 *  because that channel naturally has them; it does not follow that a
 *  rent roll must. A rent roll may legitimately establish "I have a real
 *  resident, I know their source record, their lease and their premises,
 *  and I do not know enough to prove they are an existing Person."
 *
 *  `strong` keys may RESOLVE an existing Person on their own.
 *  `candidate` keys may only SURFACE a candidate for a human.
 *  Anything not listed is evidence recorded, never a match.
 *
 *  A–D of the identity matrix are deliberately NOT encoded here. If the
 *  Yardi identifier is later established to be durable human identity,
 *  it moves from `candidate` to `strong` in ONE LINE of this table and
 *  nothing else in the system changes. That is the test of the
 *  abstraction, and it is the reason this is a table and not an if-tree.
 */
const CHANNELS = Object.freeze({
  leasing_intake: {
    strong: ["primary_phone_e164", "legacy_phone", "email"],
    candidate: [],
    note: "Phone identifies the human on this channel; email supports it.",
  },
  rent_roll: {
    //  Phone only when the source actually carries one. The 07/31 Skyline
    //  export carries none, by our own ruling that onboarding does not
    //  onboard contact data — so on that file this list matches nothing
    //  and every resident is honestly proposed.
    strong: ["primary_phone_e164", "legacy_phone"],
    //  A prior import having produced a person from this same source
    //  record is HISTORY, not identity authority. It raises a candidate a
    //  human confirms; it never binds by itself.
    candidate: ["prior_produced_person"],
    note: "Source record id is provenance. A name is never sufficient.",
  },
  staff_bridge: {
    strong: ["email"],
    candidate: [],
    note: "A verified account and a deliberate bridge; not this file's business.",
  },
});

function refuse(code, message, extra = {}) {
  const e = new Error(message);
  e.code = code;
  e.publicMessage = message;
  Object.assign(e, extra);
  return e;
}

//  E.164 exactly as leasing_leads.js normalizes it. One definition of "the
//  same number" or the two paths disagree about the same human.
function normalizePhone(raw) {
  const d = String(raw == null ? "" : raw).replace(/\D/g, "");
  if (!d) return null;
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d[0] === "1") return "+" + d;
  return d.length >= 8 ? "+" + d : null;
}
const normalizeEmail = (e) => {
  const s = String(e == null ? "" : e).trim().toLowerCase();
  return s || null;
};

/*  A retired Person is never resolved TO. If it is the only thing an
 *  identifier still points at, its supersession pointer is followed ONCE
 *  — which is precisely what that pointer is for: recognition without
 *  moving any history. Chains are not walked, because a chain means a
 *  correction was itself corrected and a human should look.  */
async function liveRecord(client, personId) {
  if (!personId) return null;
  const p = (await client.query(
    `select id, name, record_status, superseded_by_person_id from persons where id=$1`,
    [personId])).rows[0];
  if (!p) return null;
  if (p.record_status !== "retired") return { person: p, via_supersession: false };
  if (!p.superseded_by_person_id) return null;
  const s = (await client.query(
    `select id, name, record_status, superseded_by_person_id from persons where id=$1`,
    [p.superseded_by_person_id])).rows[0];
  if (!s || s.record_status === "retired") return null;
  return { person: s, via_supersession: true };
}

/*  ── THE DECISION ───────────────────────────────────────────────────
 *  Pure. Reads only. Writes nothing, ever — so it can be called to
 *  explain a disposition without committing to it.
 *
 *  Returns
 *    disposition   'resolved' | 'proposed' | 'conflicted'
 *    person_id     set only when 'resolved'
 *    candidates    [{person_id, name, basis}] — for a human, never bound
 *    evidence_used which keys actually carried the decision
 *    reason        a sentence an operator can read
 */
async function resolvePersonFromEvidence(client, { property_id = null, evidence = {}, channel } = {}) {
  const profile = CHANNELS[channel];
  if (!profile) throw refuse("UNKNOWN_INGRESS_CHANNEL", `No ingress profile for channel '${channel}'.`);

  const canon = normalizePhone(evidence.phone);
  const email = normalizeEmail(evidence.email);
  const used = [];
  const hits = new Map();   // person_id -> basis that found it

  const consider = async (key, personId, basis) => {
    const live = await liveRecord(client, personId);
    if (!live) return;
    used.push(key);
    if (!hits.has(live.person.id)) {
      hits.set(live.person.id, { basis, via_supersession: live.via_supersession, name: live.person.name });
    }
  };

  // ── STRONG KEYS ──────────────────────────────────────────────────
  for (const key of profile.strong) {
    if (key === "primary_phone_e164" && canon) {
      const r = (await client.query(
        `select id from persons where primary_phone_e164=$1 order by created_at`, [canon])).rows;
      for (const row of r) await consider(key, row.id, `verified phone ${canon}`);
    }
    if (key === "legacy_phone" && canon) {
      const tail10 = canon.replace(/\D/g, "").slice(-10);
      const cands = (await client.query(
        `select id, phone from persons
          where phone is not null and regexp_replace(phone,'\\D','','g') like $1
          order by created_at`, ["%" + tail10])).rows;
      for (const row of cands) {
        if (normalizePhone(row.phone) === canon) await consider(key, row.id, `phone ${canon}`);
      }
    }
    if (key === "email" && email) {
      const r = (await client.query(
        `select id from persons where lower(email)=lower($1) order by created_at`, [email])).rows;
      for (const row of r) await consider(key, row.id, `email ${email}`);
    }
  }

  //  MORE THAN ONE LIVE PERSON ON STRONG EVIDENCE IS A CONFLICT, NOT A
  //  CONTEST. Picking the oldest would be exactly the confident-wrong
  //  value this repo refuses — and shared or reassigned numbers make this
  //  a real case, not a theoretical one.
  if (hits.size > 1) {
    return {
      disposition: "conflicted",
      person_id: null,
      candidates: [...hits.entries()].map(([id, h]) => ({ person_id: id, name: h.name, basis: h.basis })),
      evidence_used: [...new Set(used)],
      reason: `Strong identity evidence points at ${hits.size} different people. ` +
              `Spine will not choose between them.`,
    };
  }

  const strongMatch = hits.size === 1 ? [...hits.entries()][0] : null;

  // ── CANDIDATE KEYS — surfaced, never bound ───────────────────────
  const candidates = [];
  if (profile.candidate.includes("prior_produced_person") && evidence.prior_produced_person_id) {
    const live = await liveRecord(client, evidence.prior_produced_person_id);
    if (live) {
      candidates.push({
        person_id: live.person.id,
        name: live.person.name,
        basis: `a previous import of source record ` +
               `${evidence.source_system || "?"}:${evidence.source_record_id || "?"} produced this person`,
        via_supersession: live.via_supersession,
      });
    }
  }

  if (strongMatch) {
    const [id, h] = strongMatch;
    //  STRONG EVIDENCE AND A CANDIDATE THAT DISAGREE IS A CONFLICT.
    //  "The phone says Person A, the source record says Person B" is not
    //  a question of which field wins. It is a question for a human.
    const disagreeing = candidates.filter((c) => c.person_id !== id);
    if (disagreeing.length) {
      return {
        disposition: "conflicted",
        person_id: null,
        candidates: [{ person_id: id, name: h.name, basis: h.basis }, ...disagreeing],
        evidence_used: [...new Set(used)],
        reason: `Identity evidence disagrees: ${h.basis} points at one person, ` +
                `while ${disagreeing[0].basis}. Spine will not choose between them.`,
      };
    }
    return {
      disposition: "resolved",
      person_id: id,
      candidates: [],
      evidence_used: [...new Set(used)],
      reason: h.via_supersession
        ? `Recognised by ${h.basis}, through a superseded record.`
        : `Recognised by ${h.basis}.`,
    };
  }

  //  NO STRONG MATCH. A name is never enough — that is the whole ruling —
  //  so this is a proposal whether or not a name arrived, and any
  //  candidate rides along for the human to accept or reject.
  return {
    disposition: "proposed",
    person_id: null,
    candidates,
    evidence_used: [...new Set(used)],
    reason: candidates.length
      ? `No strong identity evidence. ${candidates.length} candidate(s) for review.`
      : `No strong identity evidence in this source. A name alone cannot establish identity.`,
  };
}

/*  ── THE ONLY `insert into persons` IN PROPERTY SPINE ────────────────
 *  Private on purpose: it is reachable through ingestPerson and through
 *  confirmPersonProposal, both of which require an authority. There is no
 *  export that lets a caller create a human without one.  */
async function createPerson(client, { evidence, authority }) {
  if (!authority || !authority.actor) {
    throw refuse("INGRESS_AUTHORITY_REQUIRED",
      "A Person can only be created under a named authority.");
  }
  const canon = normalizePhone(evidence.phone);
  const email = normalizeEmail(evidence.email);
  //  names_seen from the first sighting. leasing_shadow_import already uses
  //  this as a source-alias history; the rent-roll path never populated it,
  //  so a name variant across exports left no trace at all.
  const seen = evidence.name
    ? [{ name: evidence.name, source: evidence.source_system || evidence.channel || null,
         first_seen_at: new Date().toISOString(), last_seen_at: new Date().toISOString() }]
    : [];
  const p = (await client.query(
    `insert into persons
       (name, phone, email, primary_phone_e164, lifecycle_status, leasing_stage,
        source, import_batch_id, source_type, source_as_of_date, confidence, names_seen)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) returning *`,
    [evidence.name || null, evidence.phone || canon || null, email, canon,
     evidence.lifecycle_status || "lead", evidence.leasing_stage || "lead",
     evidence.source || evidence.channel || null,
     evidence.import_batch_id || null, evidence.source_type || null,
     //  source_as_of_date was passed to the importer and never persisted on
     //  the person, so a person could not say which dated source asserted it.
     evidence.source_as_of_date || null, evidence.confidence || null,
     JSON.stringify(seen)])).rows[0];
  return p;
}

/*  Record the proposal. The CLAIM layer (migration 040) already carries
 *  every state this needs — staged / needs_review / conflicted / confirmed
 *  / promoted — plus conflict_group_id, evidence_refs, confirmed_by and
 *  per-source-row uniqueness. No new state machine is invented here.
 *
 *  resolution_kind is deliberately NOT set. It is NULL until confirmation,
 *  because a claim may not decide its own confirmation.  */
async function writeProposal(client, { activation_id, property_id, evidence, decision, status }) {
  if (!activation_id) return null;   // no activation to hang a claim on
  const naturalKey = evidence.source_system && evidence.source_record_id
    ? `${evidence.source_system}:${evidence.source_record_id}`
    : (evidence.import_source_row_id ? `row:${evidence.import_source_row_id}` : null);
  const payload = {
    evidence: {
      name: evidence.name || null,
      source_system: evidence.source_system || null,
      source_record_id: evidence.source_record_id || null,
      channel: evidence.channel || null,
      has_phone: !!normalizePhone(evidence.phone),
      has_email: !!normalizeEmail(evidence.email),
    },
    //  Candidates are EVIDENCE and live here, not in a column. There may be
    //  zero, one or several later, and a candidate_person_id column would
    //  quietly cap that at one.
    candidates: decision.candidates,
    recommendation: decision.disposition,
    evidence_used: decision.evidence_used,
  };
  const refs = [evidence.import_source_row_id, evidence.import_batch_id].filter(Boolean);
  const r = await client.query(
    `insert into proposed_records
       (activation_id, property_id, module, target_type, natural_key,
        payload_json, normalized_json, evidence_refs, status, status_reason,
        import_source_row_id)
     values ($1,$2,'leasing','person',$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$9)
     on conflict do nothing
     returning id`,
    [activation_id, property_id, naturalKey, JSON.stringify(payload),
     JSON.stringify(evidence.normalized || {}), JSON.stringify(refs),
     status, decision.reason, evidence.import_source_row_id || null]);
  return r.rows[0] ? r.rows[0].id : null;
}

/*  ── DECIDE AND ACT ─────────────────────────────────────────────────
 *  The seam every importer calls instead of writing a person.
 *
 *  `authority` is what separates "a file arrived" from "a human
 *  established opening truth". Present and the policy clean → the same
 *  confirmation that establishes the opening row permits the Person it
 *  implies, so an operator is not asked to sign 128 times for a judgment
 *  they already made. Absent → nothing is minted; a claim is recorded.
 */
async function ingestPerson(client, {
  property_id = null, evidence = {}, channel, authority = null, activation_id = null,
} = {}) {
  const ev = { ...evidence, channel };
  const decision = await resolvePersonFromEvidence(client, { property_id, evidence: ev, channel });

  if (decision.disposition === "resolved") {
    return { ...decision, resolution_kind: "resolved_existing", proposal_id: null };
  }

  if (decision.disposition === "conflicted") {
    const proposal_id = await writeProposal(client,
      { activation_id, property_id, evidence: ev, decision, status: "conflicted" });
    return { ...decision, person_id: null, proposal_id, resolution_kind: null };
  }

  //  PROPOSED. A candidate present means a human should look, even under an
  //  authority: "somebody already imported this source record as a person"
  //  is exactly the case where silently creating a second one is the bug.
  if (decision.candidates.length) {
    const proposal_id = await writeProposal(client,
      { activation_id, property_id, evidence: ev, decision, status: "needs_review" });
    return { ...decision, disposition: "needs_review", person_id: null, proposal_id, resolution_kind: null };
  }

  if (!authority) {
    const proposal_id = await writeProposal(client,
      { activation_id, property_id, evidence: ev, decision, status: "staged" });
    return { ...decision, person_id: null, proposal_id, resolution_kind: null };
  }

  const person = await createPerson(client, { evidence: ev, authority });
  return {
    disposition: "created",
    person_id: person.id,
    candidates: [],
    evidence_used: decision.evidence_used,
    reason: `Created under ${authority.basis || "a governed confirmation"}: ` + decision.reason,
    resolution_kind: "created",
    proposal_id: null,
  };
}

/*  ── CONFIRMATION ───────────────────────────────────────────────────
 *      source proposes  →  Spine/human resolves  →  durable truth
 *
 *  The action is RECEIVED AND VALIDATED here, never read back off the
 *  proposal. A claim that carried its own verdict would have collapsed
 *  proposal into confirmation, which is the one boundary this seam holds.
 *
 *  resolution_kind and promoted_record_id are written in the SAME
 *  statement, so a promotion can never exist without the institutional
 *  fact of HOW it was resolved. Five years from now that answers: did
 *  Spine create this human from this evidence, or recognise the evidence
 *  as belonging to a Person it already knew?
 */
async function confirmPersonProposal(client, {
  proposal_id, action, person_id = null, actor, authority = null,
} = {}) {
  if (!actor) throw refuse("CONFIRMATION_ACTOR_REQUIRED", "A confirmation must name its actor.");
  if (!RESOLUTION_KINDS.includes(action)) {
    throw refuse("BAD_RESOLUTION_KIND",
      `action must be one of ${RESOLUTION_KINDS.join(", ")} — got '${action}'.`);
  }
  const pr = (await client.query(
    `select * from proposed_records where id=$1 for update`, [proposal_id])).rows[0];
  if (!pr) throw refuse("PROPOSAL_NOT_FOUND", "That proposal does not exist.");
  if (pr.target_type !== "person") {
    throw refuse("WRONG_TARGET_TYPE",
      `This confirmation is for a person proposal, not '${pr.target_type}'.`);
  }
  if (pr.status === "promoted") {
    throw refuse("ALREADY_PROMOTED", "That proposal is already promoted.",
      { promoted_record_id: pr.promoted_record_id });
  }

  let resolved;
  if (action === "resolved_existing") {
    if (!person_id) throw refuse("PERSON_REQUIRED", "Resolving to an existing Person requires which one.");
    //  VALIDATED, not trusted. A retired record cannot receive a new
    //  relationship, and a caller naming one is corrected rather than obeyed.
    const live = await liveRecord(client, person_id);
    if (!live) throw refuse("PERSON_NOT_RESOLVABLE",
      "That Person does not exist, or is retired with no surviving record.");
    resolved = live.person.id;
  } else {
    const ev = (pr.payload_json && pr.payload_json.evidence) || {};
    const normalized = pr.normalized_json || {};
    const person = await createPerson(client, {
      evidence: { ...normalized, ...ev, name: ev.name || normalized.name || null },
      authority: authority || { actor, basis: "operator confirmation" },
    });
    resolved = person.id;
  }

  await client.query(
    `update proposed_records
        set status='promoted', promoted_record_id=$1, resolution_kind=$2,
            confirmed_by=$3, confirmed_at=now(), updated_at=now()
      where id=$4`,
    [resolved, action, String(actor), proposal_id]);

  return { proposal_id, person_id: resolved, resolution_kind: action };
}

module.exports = {
  resolvePersonFromEvidence,
  ingestPerson,
  confirmPersonProposal,
  CHANNELS,
  DISPOSITIONS,
  RESOLUTION_KINDS,
  normalizePhone,
};
