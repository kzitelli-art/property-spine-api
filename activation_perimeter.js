// ════════════════════════════════════════════════════════════════════
//  activation_perimeter.js — THE CONTROLLED ACTIVATION PERIMETER
//
//  Reviewer ruling (tenancy-anchor slice, Step 6): the two gated tenancy
//  routes (countersign, confirm-term) may be reachable ONLY inside an
//  explicit perimeter, fail-closed otherwise:
//
//      mode enabled
//        AND property activated (approved set)
//        AND record is internal_qa (person × THAT property, CURRENT)
//        AND authenticated staff session has property/action authority
//        AND application state is eligible
//      → otherwise refuse, deterministically and NON-REVEALINGLY.
//
//  ── OPERATOR AUTHORITY (ruling correction, load-bearing) ──────────────
//  "Authorized operator" is NOT a shared header key. Identity, property
//  entitlement, and role/action authority come from the AUTHENTICATED STAFF
//  SESSION already available to the request:
//    · resolveStaffSession(pool, x-staff-session)  → authenticated user
//    · resolveStaffIdentity(user_id, property_id)  → server-derived active
//      assignment at THIS property (state:'resolved' + role), else a "not
//      entitled" state.
//  A shared activation secret MAY be an additional Class-2 release control,
//  but it can NEVER determine identity, property, or role. If a route does
//  not yet receive canonical operator context, that is a DEPENDENCY, not an
//  excuse to fall back to a header key — the perimeter fails closed.
//
//  ── TWO LAYERS, both fail-closed, in order ────────────────────────────
//    Layer 1 — MODE (no DB, runs FIRST via dormantWriteGuard in the chain).
//    Layer 2 — PERIMETER (this module): authenticated session → server-
//      derived entitlement at the application's property → current
//      internal_qa classification → eligible application state.
//
//  ── PER-PHASE (ruling) ────────────────────────────────────────────────
//  Classification and entitlement are re-checked on EVERY phase. Phase-1
//  (countersign) permission does NOT carry into Phase-2 (confirm-term):
//  each route mounts its own guard and each guard re-reads live state. The
//  handler additionally revalidates under FOR UPDATE — perimeter is early
//  admission; the transaction is final authority.
//
//  ── REFUSAL + AUDIT (ruling) ──────────────────────────────────────────
//  External refusal is STABLE and NON-REVEALING: one opaque 403 that does
//  not disclose whether the application, person, or classification exists.
//  Internally we audit the full decision (actor, property, application,
//  action, decision, reason, timestamp). Secrets are never logged.
//
//  ── COMPONENT CLASS (ruling) ──────────────────────────────────────────
//  Class 1 (PERMANENT): the perimeter LOGIC — consequential writes
//  restricted by property capability + record eligibility + current
//  classification + actor authority. Class 2 (temporary CONFIG source): the
//  env allowlist, the global mode flag, and any extra release secret. Only
//  the config source changes when durable property-activation lands.
// ════════════════════════════════════════════════════════════════════

const { resolveMode } = require("./dormant_gate");
const { resolveStaffSession } = require("./staff_session_service");
const { resolveStaffIdentity } = require("./staff_identity_resolver");

// Class-2 CONFIG source: explicit comma-separated allowlist of activated
// property UUIDs. Absent/empty/malformed = NO property activated (fail closed).
function activatedPropertyIds() {
  const raw = process.env.ACTIVATION_PROPERTY_IDS;
  if (!raw || typeof raw !== "string") return new Set();
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

// Single opaque external refusal. Does NOT reveal which condition failed or
// whether the app/person/classification exists. The reason is audited only.
function refuse(res) {
  return res.status(403).json({ error: "not_permitted", receipt: "This action is not permitted." });
}

// Internal audit line. Records the decision without leaking secrets.
function audit(entry) {
  try {
    console.error("[activation_perimeter] " + JSON.stringify({
      ts: new Date().toISOString(),
      actor_user_id: entry.actor_user_id || null,
      property_id: entry.property_id || null,
      application_id: entry.application_id || null,
      action: entry.action || null,
      decision: entry.decision,
      reason: entry.reason || null,
    }));
  } catch (_e) { /* audit must never throw into the request path */ }
}

// Current internal_qa classification for a person in a property.
// { ok, read_failed }. Absence → ok:false. Read error → ok:false, read_failed:true.
async function currentInternalQa(pool, personId, propertyId) {
  if (!personId || !propertyId) return { ok: false, read_failed: false };
  try {
    const q = await pool.query(
      `select record_class from person_property_classifications
        where person_id = $1 and property_id = $2 and superseded_at is null limit 1`,
      [personId, propertyId]);
    if (q.rows.length === 0) return { ok: false, read_failed: false };
    return { ok: q.rows[0].record_class === "internal_qa", read_failed: false };
  } catch (_e) {
    return { ok: false, read_failed: true };
  }
}

function activationPerimeter({ pool, loadApplication, eligibleStatuses, action, requiredModule }) {
  const eligible = new Set(eligibleStatuses || []);
  const ACTION = action || "gated_activation";
  // ACTION POLICY (ruling caution #2): "assigned here" is NOT "authorized for
  // this consequential write." Lease-term ownership (countersign / confirm-
  // term) is governed by the 'leasing' module (teamaccess ALLOWED_MODULES),
  // owned by the property_manager per migration 047. The perimeter answers
  // "may THIS actor perform THIS action at THIS property?" — module
  // entitlement, not mere assignment. Defaults to 'leasing'.
  const REQUIRED_MODULE = requiredModule || "leasing";

  return async function perimeterGuard(req, res, next) {
    // Layer 1 backstop (no DB): mode must be enabled.
    if (resolveMode() !== "enabled") {
      audit({ action: ACTION, decision: "refused", reason: "mode_dormant" });
      return refuse(res);
    }

    // AUTHENTICATED STAFF SESSION (identity — NOT a header key).
    let session = null;
    try { session = await resolveStaffSession(pool, req.headers["x-staff-session"]); }
    catch (_e) { session = null; }
    if (!session || !session.id) {
      audit({ action: ACTION, decision: "refused", reason: "no_authenticated_session" });
      return refuse(res);
    }

    // Resolve the application (server-derived property + person + status).
    let app = null;
    try { app = await loadApplication(pool, req.params.id); }
    catch (_e) { app = null; }
    if (!app) {
      audit({ actor_user_id: session.id, action: ACTION, decision: "refused",
              reason: "application_not_found", application_id: req.params.id || null });
      return refuse(res);
    }

    // PROPERTY ACTIVATED? The application's OWN property governs; a
    // client-supplied property is irrelevant and never consulted.
    if (!activatedPropertyIds().has(app.property_id)) {
      audit({ actor_user_id: session.id, property_id: app.property_id, application_id: app.id,
              action: ACTION, decision: "refused", reason: "property_not_activated" });
      return refuse(res);
    }

    // ACTOR AUTHORITY: server-derived active assignment at the APPLICATION's
    // property (state:'resolved'). Not the session's claimed property, not a header.
    let identity = null;
    try { identity = await resolveStaffIdentity(pool, { user_id: session.id, property_id: app.property_id }); }
    catch (_e) { identity = null; }
    if (!identity || identity.state !== "resolved") {
      audit({ actor_user_id: session.id, property_id: app.property_id, application_id: app.id,
              action: ACTION, decision: "refused",
              reason: "actor_not_entitled_at_property:" + (identity ? identity.state : "resolve_failed") });
      return refuse(res);
    }

    // ── ACTION AUTHORITY (ruling caution #2): assignment ≠ authority for this
    //    write. Require (a) the session is scoped to the APPLICATION's property
    //    — a session for another property cannot authorize a write here — and
    //    (b) the session holds the module that governs this action ('leasing'
    //    for lease-term countersign/confirm-term). "May this actor do THIS
    //    action here?", not merely "does this person work here?". ──
    const sessionModules = Array.isArray(session.allowed_modules) ? session.allowed_modules : [];
    const propertyScopeOk = session.property_id === app.property_id;
    const hasModule = sessionModules.includes(REQUIRED_MODULE);
    if (!propertyScopeOk || !hasModule) {
      audit({ actor_user_id: session.id, property_id: app.property_id, application_id: app.id,
              action: ACTION, decision: "refused",
              reason: !propertyScopeOk
                ? "session_property_scope_mismatch"
                : "action_not_authorized:missing_module:" + REQUIRED_MODULE });
      return refuse(res);
    }

    // RECORD CLASSIFICATION: current internal_qa for the application's person.
    // Re-checked every phase. Read failure → refuse, audited distinctly.
    const cls = await currentInternalQa(pool, app.person_id, app.property_id);
    if (!cls.ok) {
      audit({ actor_user_id: session.id, property_id: app.property_id, application_id: app.id,
              action: ACTION, decision: "refused",
              reason: cls.read_failed ? "classification_read_failed" : "record_not_internal_qa" });
      return refuse(res);
    }

    // ELIGIBLE APPLICATION STATE (final authority is still the handler under lock).
    if (eligible.size > 0 && !eligible.has(app.status)) {
      audit({ actor_user_id: session.id, property_id: app.property_id, application_id: app.id,
              action: ACTION, decision: "refused", reason: "application_state_ineligible:" + app.status });
      return refuse(res);
    }

    // ADMITTED. Attach authenticated actor + resolved app; handler MUST still
    // revalidate under FOR UPDATE.
    req._perimeterActor = { user_id: session.id, name: session.name || null,
                            role: identity.role || null, assignment_id: identity.assignment_id || null,
                            authorized_module: REQUIRED_MODULE };
    req._perimeterApp = app;
    audit({ actor_user_id: session.id, property_id: app.property_id, application_id: app.id,
            action: ACTION, decision: "admitted" });
    return next();
  };
}

module.exports = { activationPerimeter, activatedPropertyIds, currentInternalQa };
