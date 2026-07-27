// ════════════════════════════════════════════════════════════════════
//  lease_void_service.js — the missing primitive: retire a lease that
//  never became a tenancy.
//
//  WHY IT EXISTS
//  -------------
//  Nothing in Property Spine could retire a lease. Not a route, not a
//  service, not a helper. So when a hollow `pending` row sat on a space it
//  silently blocked Confirm Term for that unit — the executed lease is
//  recorded, admission returns `overlapping_operative_lease`, the
//  application never reaches `accepted_term_required`, and confirm-term
//  refuses with one opaque 403 four layers from the cause. Six units were
//  in that state; clearing one on 2026-07-26 required raw SQL and owner
//  approval, which is not a mechanism.
//
//  WHAT IT DELIBERATELY IS NOT
//  ---------------------------
//  This is NOT lease cancellation. It cannot end a tenancy, move anyone
//  out, or touch a lease that means something. A lease with a tenant, an
//  application, or an activated economic tenancy is REFUSED — those are
//  real commitments and ending one is a different decision with different
//  consequences (possession, ledger, reporting) that deserves its own
//  service and its own ruling.
//
//  The narrow door is the point. A general "cancel this lease" button
//  would have been quicker to write and would have handed someone the
//  power to end a real tenancy by mistake, to solve a problem caused by
//  six rows that never were one.
//
//  HONEST HISTORY
//  --------------
//  `leases` has no audit table. The void is recorded as an `events` row —
//  the mechanism that does exist — naming the actor, the prior status and
//  the reason. Append, never erase: the lease row is retired in place, so
//  its dates, rent and space remain readable forever.
//
//  CLASS 1 — permanent. A leaseable space must always have a way to say
//  "this one never happened", or the alternative is editing the database
//  by hand, which is what it replaced.
// ════════════════════════════════════════════════════════════════════
"use strict";

// Statuses the overlap check already ignores. Voiding INTO this set is what
// unblocks the space; voiding a lease already in it is a no-op, not an error.
const RETIRED_STATUSES = [
  "cancelled", "terminated", "rescinded", "void", "expired", "superseded",
];

const VOID_REASONS = [
  "never_executed",      // the paperwork never happened
  "created_in_error",    // a bad import or a harness left it behind
  "duplicate",           // a second row for the same real tenancy
  "superseded_by_correction",
];

function httpErr(status, code, message) {
  const e = new Error(message);
  e.httpStatus = status; e.code = code; e.publicMessage = message;
  return e;
}

// ── THE ONE READ THAT DECIDES ───────────────────────────────────────
//  Returns why a lease may NOT be voided, or null if it may. Separated
//  from the write so a caller (or a dry run) can ask without acting.
function refusalReason(lease) {
  if (!lease) return { code: "lease_not_found", message: "No lease with that id." };
  if (RETIRED_STATUSES.includes(lease.lease_status)) {
    return { code: "already_retired", message: `That lease is already ${lease.lease_status}.` };
  }
  const tenants = Array.isArray(lease.tenant_ids) ? lease.tenant_ids.filter(Boolean) : [];
  if (tenants.length > 0) {
    return { code: "lease_has_tenants",
      message: "That lease names a resident. Ending a real tenancy is a different decision — this door only retires leases that never became one." };
  }
  if (lease.application_id) {
    return { code: "lease_has_application",
      message: "That lease came from an application. Correct the application instead; retiring the lease would orphan it." };
  }
  if (lease.economic_tenancy_activated_at) {
    return { code: "economic_tenancy_active",
      message: "That lease has an activated economic tenancy — money has moved against it." };
  }
  return null;
}

// ── THE WRITE ───────────────────────────────────────────────────────
async function voidHollowLease(client, { lease_id, actor_user_id, reason, reason_detail = null }) {
  if (!lease_id) throw httpErr(400, "lease_id_required", "lease_id is required.");
  if (!actor_user_id) {
    throw httpErr(400, "actor_required",
      "Retiring a lease is an attested act by a real staff user.");
  }
  if (!VOID_REASONS.includes(reason)) {
    throw httpErr(400, "reason_required", `reason must be one of: ${VOID_REASONS.join(" | ")}.`);
  }

  const lease = (await client.query(
    "select * from leases where id = $1 for update", [lease_id])).rows[0];

  const refusal = refusalReason(lease);
  if (refusal) throw httpErr(refusal.code === "lease_not_found" ? 404 : 409, refusal.code, refusal.message);

  const prior = lease.lease_status;

  await client.query(
    `update leases set lease_status = 'cancelled', updated_at = now() where id = $1`, [lease_id]);

  // The only history mechanism leases have. Names the actor and the prior
  // status, so the row can be read back to exactly what it was.
  const unit = (await client.query(
    `select u.id from spaces s join units u on u.id = s.unit_id where s.id = $1`,
    [lease.space_id])).rows[0];

  const ev = (await client.query(
    `insert into events (property_id, person_id, unit_id, type, note)
     values ($1, null, $2, 'lease_voided', $3) returning id`,
    [lease.property_id, unit ? unit.id : null,
     `Lease ${lease_id} retired from '${prior}' by user ${actor_user_id} — ${reason}` +
     (reason_detail ? `: ${String(reason_detail).trim()}` : "") +
     `. Term ${String(lease.start_date).slice(0, 10)} to ${String(lease.end_date).slice(0, 10)}.`],
  )).rows[0];

  return {
    voided: true,
    lease_id,
    prior_status: prior,
    lease_status: "cancelled",
    space_id: lease.space_id,
    event_id: ev.id,
    receipt: `Lease retired (was ${prior}). The space is free for a new term; the row and its dates remain readable.`,
  };
}

module.exports = { voidHollowLease, refusalReason, VOID_REASONS, RETIRED_STATUSES };
