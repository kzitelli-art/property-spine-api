// ════════════════════════════════════════════════════════════════════
//  identity_graph_audit.js — WHO IS WHO, ACROSS THE PORTFOLIO
//
//  READ-ONLY. Classifies every active user against the chain:
//      users → persons → property assignments → authority grants → sessions
//
//  ── DISPLAY NAME IS NOT EVIDENCE ─────────────────────────────────────
//  This audit never resolves identity by name, and it never proposes a link
//  from one. Names are carried only so a human can read the report. The
//  property already contains two person rows both called "Jordan Avery
//  (demo)" holding different roles; a name match there would silently choose
//  which of them owns the building.
//
//  A name IS used for one thing: detecting COLLISION. Two persons sharing a
//  label is a reason to distrust a link, never a reason to make one. That
//  asymmetry is the whole design — names can disqualify, never qualify.
// ════════════════════════════════════════════════════════════════════

"use strict";

const CLASSES = [
  "linked_unique",
  "linked_to_duplicate_person_label",
  "unlinked_but_deterministically_resolvable",
  "unlinked_and_ambiguous",
  "linked_without_property_assignment",
  "linked_to_inactive_person",
  "linked_to_wrong_property_scope",
];

const norm = (s) => String(s || "").trim().toLowerCase();
const digits = (s) => String(s || "").replace(/\D/g, "").replace(/^1(\d{10})$/, "$1");

async function identityGraphAudit(pool, { property_id = null } = {}) {
  const users = (await pool.query(
    `select u.id, u.name, u.email, u.phone, u.phone_verified_at, u.person_id,
            u.role, u.is_active, u.status, u.account_kind, u.created_at, u.auth_provider
       from users u where u.is_active = true order by u.created_at`)).rows;

  const persons = (await pool.query(
    `select p.id, p.name, p.email, p.phone, p.primary_phone_e164, p.phone_verified_at,
            p.lifecycle_status, p.source, p.source_type, p.created_at, p.import_batch_id
       from persons p`)).rows;

  const assignments = (await pool.query(
    `select a.id, a.person_id, a.property_id, a.role, a.is_active, a.created_at,
            pr.name as property_name
       from assignments a join properties pr on pr.id = a.property_id`)).rows;

  const grants = (await pool.query(
    `select g.id, g.person_id, g.property_id, g.effective_from, g.effective_until,
            g.may_publish_public_offers, g.may_edit_pricing, g.may_review_pricing,
            g.may_prepare_pricing, g.may_manage_concession_authority
       from concession_authority_grants g`)).rows;

  const sessions = (await pool.query(
    `select user_id, count(*)::int n, max(created_at) last_created
       from operator_sessions group by user_id`).catch(() => ({ rows: [] }))).rows;

  // ── indexes ───────────────────────────────────────────────────────
  const personById = new Map(persons.map((p) => [String(p.id), p]));
  const asgByPerson = new Map();
  for (const a of assignments) {
    const k = String(a.person_id);
    if (!asgByPerson.has(k)) asgByPerson.set(k, []);
    asgByPerson.get(k).push(a);
  }
  const grantsByPerson = new Map();
  for (const g of grants) {
    const k = String(g.person_id);
    if (!grantsByPerson.has(k)) grantsByPerson.set(k, []);
    grantsByPerson.get(k).push(g);
  }
  const sessByUser = new Map(sessions.map((s) => [String(s.user_id), s]));

  // Label collisions — used ONLY to disqualify, never to match.
  const byLabel = new Map();
  for (const p of persons) {
    const k = norm(p.name);
    if (!k) continue;
    if (!byLabel.has(k)) byLabel.set(k, []);
    byLabel.get(k).push(p);
  }

  // Contact indexes. A contact identifier is evidence ONLY when it resolves
  // to exactly one person; anything else is ambiguity, not a weaker match.
  const byEmail = new Map(), byPhone = new Map();
  for (const p of persons) {
    const e = norm(p.email);
    if (e) { if (!byEmail.has(e)) byEmail.set(e, []); byEmail.get(e).push(p); }
    const ph = digits(p.primary_phone_e164 || p.phone);
    if (ph && ph.length >= 10) { if (!byPhone.has(ph)) byPhone.set(ph, []); byPhone.get(ph).push(p); }
  }

  const rows = users.map((u) => {
    const linked = u.person_id ? personById.get(String(u.person_id)) || null : null;
    const asg = linked ? (asgByPerson.get(String(linked.id)) || []) : [];
    const activeAsg = asg.filter((a) => a.is_active);
    const gr = linked ? (grantsByPerson.get(String(linked.id)) || []) : [];
    const labelPeers = linked ? (byLabel.get(norm(linked.name)) || []).filter((p) => String(p.id) !== String(linked.id)) : [];

    // ── deterministic candidates for an UNLINKED user ──────────────
    // Each rule must land on exactly ONE person to count. Two candidates is
    // not a weaker signal — it is a disqualification, because choosing between
    // them would be a guess wearing the shape of evidence.
    const evidence = [];
    let candidates = [];
    if (!u.person_id) {
      const e = norm(u.email);
      if (e) {
        const hit = byEmail.get(e) || [];
        if (hit.length === 1) evidence.push({ kind: "unique_email", value: u.email, person_id: hit[0].id });
        else if (hit.length > 1) evidence.push({ kind: "ambiguous_email", value: u.email, count: hit.length });
        candidates = candidates.concat(hit);
      }
      const ph = digits(u.phone);
      if (ph && ph.length >= 10) {
        const hit = byPhone.get(ph) || [];
        const verified = !!u.phone_verified_at;
        if (hit.length === 1) {
          evidence.push({ kind: verified ? "unique_verified_phone" : "unique_unverified_phone",
                          value: u.phone, person_id: hit[0].id });
        } else if (hit.length > 1) evidence.push({ kind: "ambiguous_phone", value: u.phone, count: hit.length });
        candidates = candidates.concat(hit);
      }
      candidates = [...new Map(candidates.map((c) => [String(c.id), c])).values()];
    }

    const deterministic = evidence.filter((e) =>
      e.kind === "unique_email" || e.kind === "unique_verified_phone");
    const conflicting = deterministic.length > 1 &&
      new Set(deterministic.map((e) => String(e.person_id))).size > 1;

    // ── classification ────────────────────────────────────────────
    let klass;
    if (!u.person_id) {
      klass = (deterministic.length >= 1 && !conflicting && candidates.length === 1)
        ? "unlinked_but_deterministically_resolvable"
        : "unlinked_and_ambiguous";
    } else if (!linked) {
      klass = "unlinked_and_ambiguous";           // dangling person_id
    } else if (linked.lifecycle_status && /inactive|archiv|delet/i.test(String(linked.lifecycle_status))) {
      klass = "linked_to_inactive_person";
    } else if (labelPeers.length) {
      klass = "linked_to_duplicate_person_label";
    } else if (!activeAsg.length) {
      klass = "linked_without_property_assignment";
    } else if (property_id && !activeAsg.some((a) => String(a.property_id) === String(property_id))) {
      klass = "linked_to_wrong_property_scope";
    } else {
      klass = "linked_unique";
    }

    const pricingRoles = activeAsg.filter((a) => ["owner", "asset_manager"].includes(a.role));
    return {
      user_id: u.id,
      login_identifier: u.email || u.phone || `(name-only: ${u.name})`,
      user_name: u.name,
      account_kind: u.account_kind,
      user_role: u.role,
      user_created_at: u.created_at,
      auth_provider: u.auth_provider,
      person_id: u.person_id || null,
      classification: klass,

      linked_person: linked ? {
        id: linked.id, name: linked.name, email: linked.email,
        phone: linked.primary_phone_e164 || linked.phone,
        lifecycle_status: linked.lifecycle_status,
        source: linked.source, source_type: linked.source_type,
        created_at: linked.created_at, import_batch_id: linked.import_batch_id,
      } : null,

      duplicate_label_peers: labelPeers.map((p) => ({
        person_id: p.id, name: p.name, created_at: p.created_at,
        source_type: p.source_type,
        assignments: (asgByPerson.get(String(p.id)) || [])
          .filter((a) => a.is_active).map((a) => `${a.role}@${a.property_name}`),
      })),

      candidate_persons: candidates.map((c) => ({
        person_id: c.id, name: c.name, email: c.email,
        phone: c.primary_phone_e164 || c.phone, created_at: c.created_at,
        assignments: (asgByPerson.get(String(c.id)) || [])
          .filter((a) => a.is_active).map((a) => `${a.role}@${a.property_name}`),
      })),

      property_assignments: activeAsg.map((a) => ({
        assignment_id: a.id, property_id: a.property_id,
        property: a.property_name, role: a.role,
      })),
      authority_grants: gr.map((g) => ({
        grant_id: g.id, property_id: g.property_id,
        effective_from: g.effective_from, effective_until: g.effective_until,
        verbs: [
          g.may_prepare_pricing || g.may_edit_pricing ? "may_prepare_pricing" : null,
          g.may_review_pricing ? "may_review_pricing" : null,
          g.may_publish_public_offers ? "may_publish_pricing" : null,
          g.may_manage_concession_authority ? "may_manage_concession_authority" : null,
        ].filter(Boolean),
      })),
      sessions: sessByUser.get(String(u.id)) || { n: 0, last_created: null },

      evidence,
      link_is_deterministic: klass === "unlinked_but_deterministically_resolvable"
        || klass === "linked_unique",
      reason: !u.person_id
        ? (conflicting ? "Contact identifiers point at different persons — conflicting evidence, not a weaker match."
          : candidates.length > 1 ? `${candidates.length} candidate persons; choosing one would be a guess.`
          : deterministic.length ? "Exactly one person matches a unique verified contact identifier."
          : "No unique verified contact identifier links this login to any person. A display-name match is not proof.")
        : !linked ? "person_id references a row that does not exist."
        : labelPeers.length ? `${labelPeers.length + 1} person rows share this display name, so the label proves nothing about which is correct.`
        : !activeAsg.length ? "Linked to a person holding no active property assignment."
        : "Linked to exactly one person with active assignments.",

      // What choosing wrong would actually cost.
      authority_consequence: pricingRoles.length
        ? `HIGH — this link carries ${pricingRoles.map((a) => `${a.role} on ${a.property_name}`).join(", ")}, ` +
          `which grants all four pricing verbs including publication.`
        : labelPeers.some((p) => (asgByPerson.get(String(p.person_id || p.id)) || [])
            .some((a) => a.is_active && ["owner", "asset_manager"].includes(a.role)))
          ? "HIGH — a same-labelled person row holds owner/asset-manager authority. Choosing the wrong row would grant publication authority to the wrong human."
          : gr.length ? "MEDIUM — carries explicit authority grants."
          : activeAsg.length ? `LOW — operational assignments only (${activeAsg.map((a) => a.role).join(", ")}).`
          : "NONE — no authority attaches to this link today.",
    };
  });

  const tally = CLASSES.reduce((o, c) => { o[c] = rows.filter((r) => r.classification === c).length; return o; }, {});

  // Person-side label collisions, independent of any user.
  const collisions = [...byLabel.entries()].filter(([, ps]) => ps.length > 1)
    .map(([label, ps]) => ({
      label, count: ps.length,
      persons: ps.map((p) => ({
        person_id: p.id, created_at: p.created_at, source_type: p.source_type,
        lifecycle_status: p.lifecycle_status,
        assignments: (asgByPerson.get(String(p.id)) || []).filter((a) => a.is_active)
          .map((a) => `${a.role}@${a.property_name}`),
        linked_users: users.filter((u) => String(u.person_id) === String(p.id)).map((u) => u.id),
      })),
      carries_authority: ps.some((p) => (asgByPerson.get(String(p.id)) || [])
        .some((a) => a.is_active && ["owner", "asset_manager"].includes(a.role))),
    }))
    .sort((a, b) => (b.carries_authority ? 1 : 0) - (a.carries_authority ? 1 : 0));

  return {
    as_of: new Date().toISOString().slice(0, 10),
    disposition: "read_only_audit_no_links_created",
    totals: {
      active_users: users.length,
      persons: persons.length,
      active_assignments: assignments.filter((a) => a.is_active).length,
      authority_grants: grants.length,
      users_with_person_link: rows.filter((r) => r.person_id).length,
      users_reaching_pricing_authority: rows.filter((r) =>
        r.property_assignments.some((a) => ["owner", "asset_manager"].includes(a.role))).length,
    },
    classification: tally,
    users: rows,
    person_label_collisions: collisions,
    rule: "No classification, candidate or link in this report was derived from a display name. " +
          "Names appear so a human can read it, and are used to DISQUALIFY a link when two persons " +
          "share one — never to create a link.",
  };
}

module.exports = { identityGraphAudit, CLASSES };
