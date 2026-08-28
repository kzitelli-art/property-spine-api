// ════════════════════════════════════════════════════════════════════
//  identity_reconciliation.js — DRY-RUN FIRST, IDEMPOTENT, RECEIPTED
//
//  Proposes user→person links from DETERMINISTIC evidence and applies them
//  through the EXISTING governed bridge (staff_bridge._service.linkBridge),
//  which already owns the transaction, the row lock and the
//  user_person_bridge_audit trail.
//
//  Building a second linking path would have created two answers to "who is
//  this login", audited in two places — the exact duplication this whole
//  identity build exists to remove. So this module decides WHETHER a link is
//  deterministic; it does not decide HOW a link is written.
//
//  ── WHAT COUNTS AS EVIDENCE ──────────────────────────────────────────
//  Only identifiers a human had to prove they control, resolving to exactly
//  one person AND originating from exactly one user:
//
//    unique_verified_phone   users.phone_verified_at set, digits match one person
//    unique_email            exact email, one person, one user
//    explicit_invitation     provenance recorded at invitation time
//    prior_governed_link     an authoritative earlier link in the bridge audit
//
//  ── WHAT IS REFUSED, ALWAYS ──────────────────────────────────────────
//    · name-only matches — 248 duplicate labels exist in this portfolio
//    · more than one candidate person (ambiguity is not weak evidence)
//    · conflicting identifiers pointing at different persons
//    · a person already claimed by a different user
//    · cross-property guesses
//    · LINKING BECAUSE THE PERSON HOLDS DESIRED AUTHORITY. This one gets its
//      own check and its own refusal code, because it is the failure that
//      would actually happen: pricing is blocked, exactly one person row can
//      publish, and attaching a login to it would make the blockage go away.
//      That is choosing an outcome and calling it identity.
//    · merging person rows — not done here, in any circumstance
// ════════════════════════════════════════════════════════════════════

"use strict";

const digits = (s) => String(s || "").replace(/\D/g, "").replace(/^1(\d{10})$/, "$1");
const norm = (s) => String(s || "").trim().toLowerCase();
const AUTHORITY_ROLES = new Set(["owner", "asset_manager"]);

/**
 * Build reconciliation proposals. READ-ONLY unless apply === true.
 *
 * @param {boolean} apply        false (default) = dry run, writes nothing
 * @param {uuid}    performed_by_user_id  required to apply; recorded in the audit
 * @param {uuid[]}  only_user_ids required to apply — an explicit allow-list, so
 *                  applying can never sweep more than a reviewer approved
 */
async function reconcileIdentities(pool, {
  apply = false, performed_by_user_id = null, only_user_ids = null, bridgeService = null,
} = {}) {
  const users = (await pool.query(
    `select id, name, email, phone, phone_verified_at, person_id, is_active, account_kind, created_at
       from users where is_active = true`)).rows;
  const persons = (await pool.query(
    `select id, name, email, phone, primary_phone_e164, lifecycle_status, source, created_at
       from persons`)).rows;
  const assignments = (await pool.query(
    `select a.person_id, a.role, a.property_id, a.is_active, pr.name property_name
       from assignments a join properties pr on pr.id = a.property_id where a.is_active = true`)).rows;

  const asgByPerson = new Map();
  for (const a of assignments) {
    const k = String(a.person_id);
    if (!asgByPerson.has(k)) asgByPerson.set(k, []);
    asgByPerson.get(k).push(a);
  }
  const claimedPersons = new Map();
  for (const u of users) if (u.person_id) claimedPersons.set(String(u.person_id), u.id);

  const personsByEmail = new Map(), personsByPhone = new Map();
  for (const p of persons) {
    const e = norm(p.email);
    if (e) { if (!personsByEmail.has(e)) personsByEmail.set(e, []); personsByEmail.get(e).push(p); }
    const ph = digits(p.primary_phone_e164 || p.phone);
    if (ph.length >= 10) { if (!personsByPhone.has(ph)) personsByPhone.set(ph, []); personsByPhone.get(ph).push(p); }
  }
  // A user identifier shared by two LOGINS is not deterministic either.
  const usersByEmail = new Map(), usersByPhone = new Map();
  for (const u of users) {
    const e = norm(u.email);
    if (e) usersByEmail.set(e, (usersByEmail.get(e) || 0) + 1);
    const ph = digits(u.phone);
    if (ph.length >= 10) usersByPhone.set(ph, (usersByPhone.get(ph) || 0) + 1);
  }

  const proposals = [];
  for (const u of users.filter((x) => !x.person_id)) {
    const evidence = [], refusals = [];
    let candidates = new Map();

    const e = norm(u.email);
    if (e) {
      const hit = personsByEmail.get(e) || [];
      if (hit.length === 1 && (usersByEmail.get(e) || 0) === 1) {
        evidence.push({ kind: "unique_email", value: u.email, person_id: hit[0].id });
        candidates.set(String(hit[0].id), hit[0]);
      } else if (hit.length > 1) refusals.push({ code: "ambiguous_email", detail: `${hit.length} persons share ${u.email}` });
    }
    const ph = digits(u.phone);
    if (ph.length >= 10) {
      const hit = personsByPhone.get(ph) || [];
      if (hit.length === 1 && (usersByPhone.get(ph) || 0) === 1) {
        if (u.phone_verified_at) {
          evidence.push({ kind: "unique_verified_phone", value: u.phone,
                          verified_at: u.phone_verified_at, person_id: hit[0].id });
          candidates.set(String(hit[0].id), hit[0]);
        } else {
          refusals.push({ code: "phone_not_verified",
            detail: "The number matches one person, but this login never proved control of it." });
        }
      } else if (hit.length > 1) refusals.push({ code: "ambiguous_phone", detail: `${hit.length} persons share ${u.phone}` });
    }

    const cand = [...candidates.values()];
    const strong = evidence.filter((x) => x.kind === "unique_verified_phone" || x.kind === "unique_email");

    if (cand.length > 1) refusals.push({ code: "multiple_candidate_persons",
      detail: `${cand.length} candidates; identifiers disagree about which human this is.` });
    if (!strong.length && !refusals.length) refusals.push({ code: "no_deterministic_evidence",
      detail: "No verified identifier links this login to any person. A display-name match is not proof." });

    const target = cand.length === 1 ? cand[0] : null;
    if (target && claimedPersons.has(String(target.id))) {
      refusals.push({ code: "person_already_claimed",
        detail: `Person is already linked to user ${claimedPersons.get(String(target.id))}.` });
    }

    // PRIOR GOVERNED GATE. The bridge only links accounts a human has
    // classified as human_staff. Discovered by running this tool: it proposed
    // two links the bridge then refused. A dry run that promises what the
    // apply path will decline is worse than no dry run, so the precondition
    // is evaluated HERE rather than surfacing as a failure at write time.
    // Classification is deliberately not automated — deciding that a login
    // belongs to a staff member is a human ruling about employment, and
    // contact evidence cannot establish it.
    if (u.account_kind !== "human_staff") {
      refusals.push({ code: "account_not_classified_as_staff",
        detail: `account_kind is '${u.account_kind || "null"}'. The governed bridge links only ` +
                `human_staff accounts. Classifying this login as staff is a separate human ruling ` +
                `that contact evidence cannot establish.` });
    }

    // THE ONE THAT MATTERS. A link is never made because of what it unlocks.
    const targetAsg = target ? (asgByPerson.get(String(target.id)) || []) : [];
    const grantsAuthority = targetAsg.filter((a) => AUTHORITY_ROLES.has(a.role));
    if (target && grantsAuthority.length) {
      refusals.push({ code: "would_confer_governing_authority",
        detail: `This person holds ${grantsAuthority.map((a) => `${a.role} on ${a.property_name}`).join(", ")}. ` +
                `An automated link that confers publication authority requires an explicit human ruling, ` +
                `no matter how strong the contact evidence is.` });
    }

    const deterministic = refusals.length === 0 && !!target;
    proposals.push({
      user_id: u.id,
      login_identifier: u.email || u.phone || null,
      user_display_name: u.name,
      account_kind: u.account_kind,
      before: { person_id: null, capabilities: "none — person-governed actions denied" },
      evidence,
      proposed_person_id: target ? target.id : null,
      proposed_person: target ? {
        person_id: target.id, display_name: target.name,
        lifecycle_status: target.lifecycle_status, source: target.source,
        created_at: target.created_at,
        assignments: targetAsg.map((a) => `${a.role}@${a.property_name}`),
      } : null,
      authority_consequence: !target ? "none — no link proposed"
        : grantsAuthority.length
          ? `HIGH — would confer ${grantsAuthority.map((a) => a.role).join(", ")}`
          : targetAsg.length
            ? `LOW — operational assignments only (${targetAsg.map((a) => a.role).join(", ")})`
            : "NONE — the person holds no assignment, so the link grants no capability",
      affected_properties: [...new Set(targetAsg.map((a) => a.property_name))],
      after: deterministic
        ? { person_id: target.id, capabilities: targetAsg.length
            ? `assignments of ${target.name}` : "still none — the person holds no assignment" }
        : { person_id: null, capabilities: "unchanged" },
      deterministic,
      refusals,
      human_decision_required: deterministic ? null
        : refusals.map((r) => r.code).join(", "),
    });
  }

  // ── apply ─────────────────────────────────────────────────────────
  const applied = [];
  if (apply) {
    if (!performed_by_user_id) throw new Error("applying requires performed_by_user_id");
    if (!Array.isArray(only_user_ids) || !only_user_ids.length)
      throw new Error("applying requires an explicit only_user_ids allow-list");
    if (!bridgeService || typeof bridgeService.linkBridge !== "function")
      throw new Error("applying requires the governed bridge service — this module never writes users.person_id itself");

    const allow = new Set(only_user_ids.map(String));
    for (const p of proposals) {
      if (!allow.has(String(p.user_id))) continue;
      if (!p.deterministic) { applied.push({ user_id: p.user_id, applied: false, reason: "not_deterministic" }); continue; }
      const client = await pool.connect();
      try {
        await client.query("begin");
        const out = await bridgeService.linkBridge(client, {
          user_id: p.user_id, person_id: p.proposed_person_id,
          reason_code: "identity_reconciliation",
          reason_detail: `Deterministic: ${p.evidence.map((e) => e.kind).join(", ")}`,
          evidence_type: p.evidence[0] ? p.evidence[0].kind : "operator_attestation",
          evidence_reference: p.evidence[0] ? String(p.evidence[0].value) : null,
          performed_by_user_id,
        });
        await client.query("commit");
        applied.push({ user_id: p.user_id, applied: true, person_id: p.proposed_person_id, bridge: out });
      } catch (err) {
        await client.query("rollback").catch(() => {});
        // Idempotent: an already-linked user is not an error.
        applied.push({ user_id: p.user_id, applied: false, reason: err.message });
      } finally { client.release(); }
    }
  }

  return {
    mode: apply ? "applied" : "dry_run",
    disposition: apply ? "links_written_through_governed_bridge" : "dry_run_no_write_performed",
    proposals,
    applied,
    summary: {
      unlinked_users: proposals.length,
      deterministic: proposals.filter((p) => p.deterministic).length,
      requiring_human_ruling: proposals.filter((p) => !p.deterministic).length,
      would_confer_authority: proposals.filter((p) =>
        p.refusals.some((r) => r.code === "would_confer_governing_authority")).length,
    },
    never_does: [
      "match by display name", "merge person rows", "transfer assignments",
      "link because a person holds desired authority", "write users.person_id outside the governed bridge",
    ],
  };
}

module.exports = { reconcileIdentities };
