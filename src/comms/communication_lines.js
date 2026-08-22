/* ════════════════════════════════════════════════════════════════════
   communication_lines.js — THE CANONICAL LINE RESOLVER.

   The receiving line is the wall. Every inbound message resolves the LINE
   before the SENDER, and the line — not the sender — establishes the
   authority ceiling. The sender's identity may LOWER what is appropriate.
   It may never RAISE the ceiling the line established.

   This module is the only thing that reads or activates line storage. Per
   doctrine Ruling 3 nothing else may: callers ask it to resolve an inbound
   line, resolve an outbound line for a purpose, state a line's authority,
   or perform the one governed first activation of an operations line.

   ── THE BOUNDARY THIS MODULE EXISTS TO HOLD ─────────────────────────

   AN ORGANIZATION-OWNED LINE ESTABLISHES ORGANIZATION CONTEXT AND AN
   AUTHORITY CEILING. IT DOES NOT ESTABLISH PROPERTY CONTEXT.

   A staff member may work at several properties. Knowing who texted, and
   which company they texted, does not determine which building they meant.

   This is migration 129's defect on a different axis. There, two properties
   shared one number and `limit 1` picked arbitrarily. Here one number
   legitimately spans many properties, and the temptation is to infer "their
   property" from assignment order, most-recent activity, or the fact that
   the organization happens to own only one building today.

   So resolvePropertyContextForStaff NEVER reads the organization's property
   list. Property context comes from the SENDER'S OWN active assignments or
   an explicit work reference — never from the organization. An
   organization with one property must travel the same explicit path as an
   organization with fifty, because the shortcut works right up until the
   second building and then silently misroutes.

   ── STAFF LOOKUP IS NOW PERMITTED, AND WHY ──────────────────────────

   Doctrine Ruling 4: staff identity lookup may not be added to this
   boundary until the ceiling is structural. Migration 130 makes it so — a
   property_facing line carrying operational authority is not a
   configuration that can be inserted. Before 130, "staff texting a property
   line gain no authority" held only because staff were unresolvable here;
   that was an accident, and this module would have destroyed it.

   ── SLICE A IS INBOUND-ONLY ─────────────────────────────────────────

   No operational action is performed here and no outbound is sent.
   resolveOutboundLine exists for property-facing sends, which already
   happen; operations lines carry outbound_enabled=false, enforced by a
   database constraint, and refuse.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const { normalizePropertyLine } = require("./property_line");

/*  ELIGIBILITY. `status = 'active'` and nothing else — the exact predicate
 *  of uq_communication_lines_active_e164 and its sibling indexes.
 *
 *  This is the 129 rule restated: the set the database keeps unique must be
 *  exactly the set the resolver reads. If either changes, both change in
 *  the same commit or the guarantee silently decouples. */
const ACTIVE = "active";

const LINE_COLUMNS = `
  id, e164, line_type, property_id, organization_id,
  authority_ceiling, permitted_audience,
  inbound_enabled, outbound_enabled, outbound_policy, status
`;

/*  OUTBOUND POLICY (migration 132, owner ruling 2026-08-04).
 *
 *    disabled     sends nothing
 *    reply_only   may answer an inbound message on the same line
 *    proactive    may originate
 *
 *  An operations line can never hold 'proactive' — the database refuses it
 *  (ck_cl_outbound_policy_by_type), so proactive assignment pushes,
 *  reminders and staff broadcasts are not unbuilt features, they are rows
 *  that cannot exist. This vocabulary must stay identical to the check
 *  constraint's; if either changes, both change in the same commit. */
const OUTBOUND_POLICIES = ["disabled", "reply_only", "proactive"];

function activationRefusal(httpStatus, reason, receipt, detail = {}) {
  const error = new Error(receipt);
  error.httpStatus = httpStatus;
  error.refusalReason = reason;
  error.publicMessage = receipt;
  error.detail = detail;
  return error;
}

/*  lineAuthority — pure. What this line permits, stated from the line
 *  itself and from nothing else. Never consults the sender. */
function lineAuthority(line) {
  if (!line) return null;
  return {
    lineType: line.line_type,
    authorityCeiling: line.authority_ceiling,
    permittedAudience: line.permitted_audience,
    grantsOperationalAuthority: line.authority_ceiling === "operational",
    establishesPropertyContext: line.line_type === "property_facing",
  };
}

/*  resolveInboundLine — zero, one and many, each said out loud.
 *
 *    'unresolvable'  the received number cannot be normalized, so it can
 *                    never match a configured line.
 *    'none'          no line is configured for it.
 *    'inactive'      a line EXISTS for this number but is suspended or
 *                    retired. Distinct from 'none' because the repair
 *                    differs — configuration exists and was turned off, or
 *                    a number was reassigned. Fails closed identically.
 *    'one'           exactly one active line.
 *    'many'          more than one. There is no correct answer available,
 *                    so there is no answer. Never a pick.
 *
 *  NO `limit`. The count IS the finding. `line` is null for every outcome
 *  except 'one', so a caller that forgets to branch gets null rather than
 *  an arbitrary line — failing closed must not depend on the caller having
 *  read the documentation. */
async function resolveInboundLine(q, receivedNumber) {
  const e164 = normalizePropertyLine(receivedNumber);
  if (!e164) {
    return { outcome: "unresolvable", line: null, candidates: [], e164: null };
  }

  const { rows } = await q.query(
    `select ${LINE_COLUMNS} from communication_lines
      where e164 = $1 and status = $2
      order by id`,
    [e164, ACTIVE]
  );

  if (rows.length === 1) return { outcome: "one", line: rows[0], candidates: rows, e164 };
  if (rows.length > 1) return { outcome: "many", line: null, candidates: rows, e164 };

  /*  Nothing active. Distinguish "never configured" from "configured and
   *  turned off" — an inactive line is a fact about configuration, and
   *  reporting it as unknown would hide a real operator action. */
  const inactive = await q.query(
    `select ${LINE_COLUMNS} from communication_lines
      where e164 = $1 and status <> $2
      order by id`,
    [e164, ACTIVE]
  );
  if (inactive.rows.length) {
    return { outcome: "inactive", line: null, candidates: inactive.rows, e164 };
  }
  return { outcome: "none", line: null, candidates: [], e164 };
}

/*  resolveOutboundLine — a line, or a REASON. Never a fallback number.
 *
 *  Preserves the existing no_property_line discipline: with no configured
 *  line the send refuses rather than falling back to a Messaging Service
 *  default. A fallback `from` is a message that appears to come from a
 *  building it did not come from.
 *
 *  ── REPLY-BOUND SENDS (migration 132) ───────────────────────────────
 *  A 'reply_only' line refuses unless the caller names the inbound message
 *  being answered. The refusal is here as well as in the database trigger
 *  deliberately: the resolver is what a send path asks BEFORE composing,
 *  so an unbound reply is refused before a message body exists rather than
 *  at insert time with the text already written. The trigger is the
 *  control; this is the early, honest answer. */
async function resolveOutboundLine(
  q, { propertyId = null, organizationId = null, replyToCommEventId = null } = {}
) {
  if ((propertyId == null) === (organizationId == null)) {
    return { line: null, refusal: "ambiguous_outbound_owner", policy: null };
  }

  const { rows } = propertyId
    ? await q.query(
        `select ${LINE_COLUMNS} from communication_lines
          where property_id = $1 and line_type = 'property_facing' and status = $2`,
        [propertyId, ACTIVE])
    : await q.query(
        `select ${LINE_COLUMNS} from communication_lines
          where organization_id = $1 and line_type = 'operations' and status = $2`,
        [organizationId, ACTIVE]);

  if (rows.length === 0) return { line: null, refusal: "no_property_line", policy: null };
  if (rows.length > 1) return { line: null, refusal: "ambiguous_line", policy: null };

  const line = rows[0];
  const policy = line.outbound_policy;

  if (policy === "disabled") return { line: null, refusal: "outbound_not_enabled", policy };
  if (policy === "reply_only" && !replyToCommEventId) {
    return { line: null, refusal: "reply_only_requires_inbound", policy };
  }
  return { line, refusal: null, policy };
}

/*  readOperationsLineForOrganization — display uses the same line owner as
 *  routing and activation. Zero, one and many stay explicit; a screen never
 *  gets permission to choose one row from an ambiguous configuration. */
async function readOperationsLineForOrganization(q, organizationId) {
  if (!organizationId) return { outcome: "not_connected", line: null, candidates: [] };
  const { rows } = await q.query(
    `select ${LINE_COLUMNS}, created_at
       from communication_lines
      where organization_id = $1 and line_type = 'operations' and status = $2
      order by created_at, id`,
    [organizationId, ACTIVE]
  );
  if (rows.length === 1) return { outcome: "connected", line: rows[0], candidates: rows };
  if (rows.length > 1) return { outcome: "ambiguous", line: null, candidates: rows };
  return { outcome: "not_connected", line: null, candidates: [] };
}

/*  activateOperationsLine — the one governed first write.
 *
 *  This deliberately cannot replace, transfer, suspend or retire a line. Those
 *  are different operating events with different history and consent questions.
 *  The narrow command makes only the posture the database already permits:
 *
 *      organization-owned · operational · staff · inbound · reply_only
 *
 *  The actor is re-read inside the transaction. The super-admin HTTP boundary
 *  is not treated as a permanent fact after it has run once. */
async function activateOperationsLine(pool, {
  organizationId = null, phoneNumber = null, actorUserId = null,
} = {}) {
  if (!organizationId) {
    throw activationRefusal(400, "organization_required", "Organization is required.");
  }
  if (!actorUserId) {
    throw activationRefusal(401, "actor_required", "A live super-admin actor is required.");
  }
  const e164 = normalizePropertyLine(phoneNumber);
  if (!e164) {
    throw activationRefusal(400, "invalid_staff_line",
      "Enter a valid US phone number for the staff text line.");
  }

  const client = await pool.connect();
  try {
    await client.query("begin");

    const actor = (await client.query(
      `select id, platform_role, status from users where id = $1 for share`,
      [actorUserId])).rows[0];
    if (!actor || actor.status !== "active" || actor.platform_role !== "super_admin") {
      throw activationRefusal(403, "super_admin_required",
        "Only an active super admin can connect a staff text line.");
    }

    const organization = (await client.query(
      `select o.id, o.name, o.status,
              exists(select 1 from properties p where p.organization_id = o.id) as has_property
         from organizations o
        where o.id = $1
        for update`, [organizationId])).rows[0];
    if (!organization) {
      throw activationRefusal(404, "organization_not_found", "Organization not found.");
    }
    if (organization.status !== "active") {
      throw activationRefusal(409, "organization_not_active",
        "Staff texting can only be connected for an active organization.");
    }
    if (!organization.has_property) {
      throw activationRefusal(409, "organization_has_no_property",
        "Assign at least one property before connecting staff texting.");
    }

    const existing = (await client.query(
      `select ${LINE_COLUMNS}, created_at
         from communication_lines
        where organization_id = $1 and line_type = 'operations' and status = $2
        for update`, [organizationId, ACTIVE])).rows;
    if (existing.length > 1) {
      throw activationRefusal(409, "ambiguous_operations_line",
        "More than one active staff line exists. Nothing changed.");
    }
    if (existing.length === 1) {
      if (existing[0].e164 === e164) {
        await client.query("rollback");
        return Object.freeze({ line: existing[0], already: true,
          receipt: `${organization.name} staff texting is already connected.` });
      }
      throw activationRefusal(409, "operations_line_already_active",
        "This organization already has a staff text line. Replacement requires a separate governed change.",
        { active_line_id: existing[0].id });
    }

    const collision = (await client.query(
      `select id, line_type, property_id, organization_id
         from communication_lines
        where e164 = $1 and status = $2
        for update`, [e164, ACTIVE])).rows[0];
    if (collision) {
      throw activationRefusal(409, "phone_number_already_active",
        "That phone number already belongs to an active communication line. Nothing changed.",
        { active_line_id: collision.id, active_line_type: collision.line_type });
    }

    const note = `Activated by ${actor.id}; authority=platform_role:super_admin`;
    const line = (await client.query(
      `insert into communication_lines
         (e164, line_type, organization_id, authority_ceiling, permitted_audience,
          inbound_enabled, outbound_enabled, outbound_policy, status, notes)
       values ($1, 'operations', $2, 'operational', 'staff', true, true,
               'reply_only', 'active', $3)
       returning ${LINE_COLUMNS}, created_at`,
      [e164, organizationId, note])).rows[0];

    await client.query("commit");
    return Object.freeze({ line, already: false,
      receipt: `${organization.name} staff texting is connected.` });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    if (error && error.code === "23505") {
      throw activationRefusal(409, "communication_line_collision",
        "That staff line conflicts with an active communication line. Nothing changed.");
    }
    throw error;
  } finally {
    client.release();
  }
}

/*  resolveStaffSenderForOrganization — is this sender staff of THIS
 *  organization?
 *
 *  Scoped by organization membership, not by "is a user somewhere". A
 *  resident, a prospect, or a staff member of a different organization all
 *  resolve to 'none' and the caller refuses — invariant 2.
 *
 *  Ambiguity discipline matches the resident path: more than one distinct
 *  user on one phone is never a silent pick between two humans. */
async function resolveStaffSenderForOrganization(q, { organizationId, fromNumber }) {
  const phone = normalizePropertyLine(fromNumber);
  if (!phone || !organizationId) {
    return { outcome: "none", user: null, candidates: [] };
  }

  const { rows } = await q.query(
    `select distinct u.id, u.name, u.role
       from users u
       join property_team_assignments pta
         on pta.user_id = u.id and pta.active = true
       join properties p
         on p.id = pta.property_id and p.organization_id = $1
      where u.is_active = true
        and regexp_replace(coalesce(u.phone,''), '\\D', '', 'g') = regexp_replace($2, '\\D', '', 'g')
      order by u.id`,
    [organizationId, phone]
  );

  if (rows.length === 0) return { outcome: "none", user: null, candidates: [] };
  if (rows.length > 1) return { outcome: "many", user: null, candidates: rows };
  return { outcome: "one", user: rows[0], candidates: rows };
}

/*  resolvePropertyContextForStaff — THE BOUNDARY.
 *
 *  An operations line told us the ORGANIZATION. It did not tell us the
 *  building. This resolves the building, explicitly, from one of the three
 *  governed sources — and refuses rather than guessing.
 *
 *    'explicit_reference'  a canonical work order or obligation named it.
 *                          Strongest: the sender said which work they meant.
 *    'one'                 the sender holds exactly ONE active assignment.
 *    'none'                the sender holds no active assignment.
 *    'many'                the sender works at several properties. There is
 *                          no correct answer available. Ask.
 *
 *  ⚠ THIS FUNCTION NEVER READS THE ORGANIZATION'S PROPERTY LIST.
 *  Scope comes from the SENDER'S OWN assignments or an explicit work
 *  reference. Resolving "the org owns one property, so that's the one"
 *  would work until the second property and then silently misroute — and
 *  it would make the organization number choose a building, which it must
 *  never do. An organization with one property travels this same path. */
async function resolvePropertyContextForStaff(
  q, { organizationId, userId, workOrderId = null, obligationId = null,
       messageText = null } = {}
) {
  if (!organizationId || !userId) {
    return { outcome: "none", propertyId: null, candidates: [], source: null };
  }

  //  1. An explicit canonical work reference. Still organization-scoped:
  //     naming a work order at another company's property resolves nothing.
  if (workOrderId || obligationId) {
    const ref = await q.query(
      `select p.id as property_id
         from ${workOrderId ? "work_orders w" : "obligations w"}
         join properties p on p.id = w.property_id and p.organization_id = $2
        where w.id = $1`,
      [workOrderId || obligationId, organizationId]
    );
    if (ref.rows.length === 1) {
      return {
        outcome: "explicit_reference",
        propertyId: ref.rows[0].property_id,
        candidates: ref.rows,
        source: workOrderId ? "work_order" : "obligation",
      };
    }
    return { outcome: "none", propertyId: null, candidates: [], source: "unmatched_reference" };
  }

  //  2. The sender's own active assignments, inside this organization.
  const { rows } = await q.query(
    `select distinct p.id as property_id, p.name, pta.allowed_modules, pta.primary_for_modules
       from property_team_assignments pta
       join properties p
         on p.id = pta.property_id and p.organization_id = $2
      where pta.user_id = $1 and pta.active = true
      order by p.id`,
    [userId, organizationId]
  );

  if (rows.length === 0) return { outcome: "none", propertyId: null, candidates: [], source: "assignment" };
  if (rows.length > 1) {
    const words = ` ${String(messageText || "").toLowerCase()
      .replace(/[^a-z0-9]+/g, " ").trim()} `;
    const named = rows.filter((row) => {
      const name = String(row.name || "").toLowerCase()
        .replace(/[^a-z0-9]+/g, " ").trim();
      return name && words.includes(` ${name} `);
    });
    // Exact normalized names only. If one property name contains another,
    // both match and this remains ambiguous rather than picking the longer.
    if (named.length === 1) {
      return {
        outcome: "one",
        propertyId: named[0].property_id,
        allowedModules: named[0].allowed_modules || [],
        primaryForModules: named[0].primary_for_modules || [],
        candidates: rows,
        source: "message_property_name",
      };
    }
    return { outcome: "many", propertyId: null, candidates: rows, source: "assignment" };
  }
  return {
    outcome: "one",
    propertyId: rows[0].property_id,
    allowedModules: rows[0].allowed_modules || [],
    primaryForModules: rows[0].primary_for_modules || [],
    candidates: rows,
    source: "assignment",
  };
}

/*  clarificationFor — the smallest useful question, and nothing else.
 *
 *  When property context is missing or ambiguous, Spine asks rather than
 *  acts. It never lists the organization's buildings — that would leak the
 *  portfolio to whoever texted, and it would invite the sender to pick a
 *  property they have no assignment to. Only the sender's own candidates
 *  are namable, and only when there is more than one. */
function clarificationFor(context) {
  if (!context || context.outcome === "one" || context.outcome === "explicit_reference") return null;
  if (context.outcome === "many") {
    return {
      reason: "property_context_ambiguous",
      question: "Which property is this about?",
      options: context.candidates.map((c) => ({ property_id: c.property_id, name: c.name })),
    };
  }
  return {
    reason: "property_context_absent",
    question: "Which property is this about?",
    options: [],
  };
}

module.exports = {
  resolveInboundLine,
  resolveOutboundLine,
  readOperationsLineForOrganization,
  activateOperationsLine,
  lineAuthority,
  resolveStaffSenderForOrganization,
  resolvePropertyContextForStaff,
  clarificationFor,
  ACTIVE,
  OUTBOUND_POLICIES,
};
