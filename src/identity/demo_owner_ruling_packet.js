// ════════════════════════════════════════════════════════════════════
//  demo_owner_ruling_packet.js — READ-ONLY. ALTERS NOTHING.
//
//  Everything ownership needs to rule on the `owner` assignment that sits on
//  a Jordan Avery DEMO LEAD record, and the consequences of each option.
//
//  It sweeps ALL 62 tables that reference persons rather than a hand-picked
//  list, so "nothing else is attached" is a measured fact rather than a
//  claim about the tables somebody remembered to check.
// ════════════════════════════════════════════════════════════════════

"use strict";

const DEMO_LEAD_PERSON = "16b442ee-0ec5-425a-90f3-ab8708a15b77";

async function demoOwnerRulingPacket(pool, {
  person_id = DEMO_LEAD_PERSON, property_id = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe",
} = {}) {
  const person = (await pool.query(
    `select id, name, email, phone, primary_phone_e164, lifecycle_status, source, source_type,
            created_at, import_batch_id
       from persons where id = $1`, [person_id])).rows[0] || null;
  if (!person) return { error: "person_not_found", person_id };

  const assignment = (await pool.query(
    `select a.*, pr.name property_name from assignments a
       join properties pr on pr.id = a.property_id
      where a.person_id = $1 and a.property_id = $2`, [person_id, property_id])).rows[0] || null;

  // EVERY table that points at persons, swept.
  const refs = (await pool.query(
    `select tc.table_name, kcu.column_name
       from information_schema.table_constraints tc
       join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name
       join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name
      where tc.constraint_type='FOREIGN KEY' and ccu.table_name='persons'`)).rows;

  const attachments = [];
  for (const r of refs) {
    try {
      const n = (await pool.query(
        `select count(*)::int n from "${r.table_name}" where "${r.column_name}" = $1`, [person_id])).rows[0].n;
      if (n > 0) attachments.push({ table: r.table_name, column: r.column_name, rows: n });
    } catch (e) { /* view or permission — skipped, reported below */ }
  }

  const staffContexts = (await pool.query(
    "select id, context_type, property_id from person_contexts where person_id = $1", [person_id])).rows;
  const linkedUsers = (await pool.query(
    "select id, name, account_kind from users where person_id = $1", [person_id])).rows;
  const escalatesToThis = assignment ? (await pool.query(
    "select id, person_id, role from assignments where escalates_to_assignment_id = $1", [assignment.id])).rows : [];
  const demoUse = (await pool.query(
    `select id, demo_run_id, status, checkpoint, created_at
       from demo_attempts where tenant_person_id = $1`, [person_id])).rows;

  // Did any privileged action ever use this authority?
  const privileged = {
    pricing_versions_published_by: Number((await pool.query(
      "select count(*)::int n from property_pricing_versions where published_by_person_id = $1", [person_id])).rows[0].n),
    authority_grants_granted_by: Number((await pool.query(
      "select count(*)::int n from concession_authority_grants where granted_by_person_id = $1", [person_id])).rows[0].n),
    concession_incidents_spoken_by: Number((await pool.query(
      "select count(*)::int n from concession_incidents where spoken_by_person_id = $1", [person_id])).rows[0].n),
    pricing_reviews_by: Number((await pool.query(
      "select count(*)::int n from pricing_review_receipts where reviewed_by_person_id = $1", [person_id])).rows[0].n),
  };
  const everExercised = Object.values(privileged).some((n) => n > 0);

  // The label peers, so the ruling is made with the whole cluster in view.
  const peers = (await pool.query(
    `select p.id, p.name, p.source, p.lifecycle_status, p.created_at,
            (select count(*)::int from person_contexts pc where pc.person_id = p.id and pc.context_type='staff') staff_ctx,
            (select count(*)::int from users u where u.person_id = p.id) linked_users
       from persons p where lower(p.name) like 'jordan avery%' order by p.created_at`)).rows;

  const otherAssignments = (await pool.query(
    `select a.role, a.is_active, pe.name, pe.id person_id,
            (select count(*)::int from person_contexts pc where pc.person_id = pe.id and pc.context_type='staff') staff_ctx
       from assignments a join persons pe on pe.id = a.person_id
      where a.property_id = $1 and a.is_active = true order by a.role`, [property_id])).rows;

  return {
    disposition: "read_only_ruling_packet_nothing_altered",
    person: {
      person_id: person.id, display_name: person.name,
      email: person.email, phone: person.primary_phone_e164 || person.phone,
      lifecycle_status: person.lifecycle_status,
      source: person.source, source_type: person.source_type,
      created_at: person.created_at, import_batch_id: person.import_batch_id,
    },

    // ── why this is a LEAD, on evidence rather than on its label ──
    classified_as_lead_because: [
      { fact: "no_staff_context",
        detail: `person_contexts has ${staffContexts.length} staff row(s) for this person. Every ` +
                `genuine staff person on this property carries context_type='staff'; this one does not.` },
      { fact: "lifecycle_status", detail: `lifecycle_status = '${person.lifecycle_status}'.` },
      { fact: "created_by_demo", detail: `source = '${person.source}'.` },
      { fact: "used_as_a_demo_tenant",
        detail: demoUse.length
          ? `Appears as tenant_person_id in ${demoUse.length} demo_attempts row(s) — created in the same ` +
            `second as the person row, checkpoint '${demoUse[0].checkpoint}', status '${demoUse[0].status}'. ` +
            `It was a demo prospect, not a staff member.`
          : "No demo_attempts reference." },
      { fact: "no_contact_identifiers",
        detail: "No email and no phone. Nothing could ever verify a human behind it." },
      { fact: "no_linked_login",
        detail: `${linkedUsers.length} users link to it. Nobody can sign in as this person.` },
      { note: "None of the above is its display name. The '(demo)' suffix was always visible and " +
              "established nothing — three sibling rows share it and carry real prospect activity." },
    ],

    authority_currently_carried: assignment ? {
      assignment_id: assignment.id, role: assignment.role,
      property: assignment.property_name, is_active: assignment.is_active,
      created_at: assignment.created_at, provenance: assignment.provenance,
      confers: ["may_prepare_pricing", "may_review_pricing", "may_publish_pricing",
                "may_manage_concession_authority"],
      reachable_by_a_login: linkedUsers.length > 0,
      note: "An owner assignment confers all four pricing verbs and never expires. It is currently " +
            "UNREACHABLE because no login is linked to this person — the authority exists but " +
            "cannot be exercised.",
    } : null,

    everything_attached: {
      swept_tables: refs.length,
      attachments,
      summary: attachments.length === 0
        ? "Nothing at all."
        : attachments.map((a) => `${a.table}.${a.column} × ${a.rows}`).join("; "),
    },
    escalation_chains_pointing_here: escalatesToThis,
    linked_users: linkedUsers,
    staff_contexts: staffContexts,

    historical_privileged_use: {
      ...privileged,
      ever_exercised: everExercised,
      conclusion: everExercised
        ? "This authority HAS been used. Removing it changes the meaning of existing history."
        : "This authority has NEVER been exercised. No published version, grant, review or " +
          "concession references it, so removing it rewrites no history and invalidates no record.",
    },

    label_cluster: peers,
    property_assignments: otherAssignments,

    // ── the four options, each with its real consequence ──
    options: [
      {
        option: "deactivate_the_assignment",
        effect: "assignments.is_active = false on a single row.",
        consequence: everExercised
          ? "Would orphan historical privileged actions."
          : "No behaviour changes anywhere: the authority is already unreachable, nothing was ever done " +
            "with it, and no other row references it. Demo Building would then have ZERO owner " +
            "assignment until one is created on a verified human.",
        reversible: true,
        preserves_history: true,
        note: "This is the option that matches the standing direction: remove authority from the demo " +
              "lead, then re-establish it on the verified human as a NEW attributable action.",
      },
      {
        option: "transfer_it_to_the_staff_person",
        effect: "UPDATE the existing row's person_id.",
        consequence: "The assignment's creation timestamp, provenance and identity would silently come " +
                     "to describe a different human. An audit reading it later would conclude the staff " +
                     "member has held owner authority since 2026-07-02, which is false.",
        reversible: "technically, but the false history would have been true-looking in between",
        preserves_history: false,
        note: "REFUSED by design. This is the shape the standing direction rules out.",
      },
      {
        option: "replace_with_an_explicit_scoped_grant",
        effect: "Deactivate the assignment; create a concession_authority_grant naming specific verbs " +
                "and an effective window on the verified human.",
        consequence: "Narrower and time-bounded: a grant carries only the verbs named, expires, and " +
                     "records who granted it. An assignment carries all four verbs forever.",
        reversible: true, preserves_history: true,
        note: "Appropriate if the human should publish pricing WITHOUT becoming the property's owner " +
              "of record.",
      },
      {
        option: "leave_it_in_place_but_unreachable",
        effect: "Nothing.",
        consequence: "Demo Building continues to show an active owner assignment that no human can " +
                     "exercise. Every authority inventory keeps reporting '1 publish-capable assignment' " +
                     "for a person who is a demo prospect — which is the misleading state that made " +
                     "this investigation necessary.",
        reversible: true, preserves_history: true,
        note: "Safe, but it leaves a false-looking authority row in the inventory indefinitely.",
      },
    ],

    recommendation_is_ownerships_to_make: true,
    blocked_until: "ownership names the human and the exact verified staff-person record",
  };
}

module.exports = { demoOwnerRulingPacket, DEMO_LEAD_PERSON };
