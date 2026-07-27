// ════════════════════════════════════════════════════════════════════
//  activation_perimeter.js — THE CONTROLLED ACTIVATION PERIMETER
//
//  Reviewer ruling (tenancy-anchor slice, Step 6): the two gated tenancy
//  routes (countersign, confirm-term) may be reachable ONLY inside an
//  explicit perimeter, fail-closed otherwise:
//
//      mode enabled
//        AND property activated (approved set)
//        AND record carries a CURRENT ELIGIBLE class (person × THAT property)
//            — see currentEligibleClass; the list is imported from
//              capability.js so this gate and the application gate cannot
//              disagree about who is eligible
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
//      eligible classification → eligible application state.
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

// Current ELIGIBLE classification for a person in a property.
// { ok, read_failed }. Absence → ok:false. Read error → ok:false, read_failed:true.
//
// THE SECOND HALF OF THE DEADLOCK (merged 2026-07-26).
// This read used to be `record_class === "internal_qa"`, hardcoded. The
// application-link gate had the mirror-image rule, and between them a person
// could be application-eligible or admission-eligible but never both — so a
// `production` prospect could be SENT an application and could never become a
// resident. Closing one end left the wall standing at the other.
//
// The two questions stay separate functions — "may we send them an
// application?" is not "may this tenancy be admitted?" — but they read the
// SAME list, imported rather than restated, so they cannot drift into
// disagreeing about which classes are eligible at all.
//
// It remains an ALLOWLIST with exact matching and no normalization: an
// unclassified person is refused (absence of a decision is not permission),
// and a class nobody named is refused rather than admitted by default.
//
// NOT checked here, deliberately: consent. STOP/opt-out governs whether the
// product may MESSAGE someone; it has no bearing on whether a lease they
// signed may be recorded. Recording a fact is not composing an outbound.
//  CLASS NO LONGER GATES ADMISSION (owner ruling 2026-07-26).
//  This read has been through three shapes in one day, which is itself the
//  argument for the ruling:
//    1. record_class === 'internal_qa'      — deadlocked against the comms
//       boundary, which demanded 'production' for the same person.
//    2. a shared allowlist with capability.js — the two gates agreed, but a
//       field with three jobs still gated whether anything worked.
//    3. this — class is out of eligibility entirely.
//  Admission asks the same two questions as every other gate: did they say
//  yes, and is this property switched on. The property half is already
//  enforced above by ACTIVATION_PROPERTY_IDS, so what remains here is
//  consent.
//
//  Read failure still fails closed and is still audited distinctly — an
//  unreadable answer is not a yes.
async function currentEligibleClass(pool, personId, propertyId) {
  if (!personId || !propertyId) return { ok: false, read_failed: false };
  try {
    const q = await pool.query(
      `select consent_state from contact_preferences
        where person_id = $1 and channel = 'text' limit 1`,
      [personId]);
    if (q.rows.length === 0) return { ok: false, read_failed: false };
    return { ok: q.rows[0].consent_state === "opted_in", read_failed: false };
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

    // ── ACTOR ENTITLEMENT + ACTION AUTHORITY (from the SESSION). ──
    // The session ONLY resolves because resolveStaffSession joined an ACTIVE
    // property_team_assignments row for this user at the session's property —
    // so a resolved session IS proof of active assignment, and it carries the
    // live role_title + allowed_modules FROM that same assignment row.
    // (Do NOT re-check via resolveStaffIdentity: that reads a DIFFERENT table,
    // 'assignments', keyed by person_id — a user present in
    // property_team_assignments may have no row there, which would wrongly read
    // as 'not_assigned_here'. property_team_assignments is the canonical grain
    // for property-team module authority, and it is what the session validates.)
    //
    // Require (a) the session is scoped to the APPLICATION's property — a
    // session for another property cannot authorize a write here — and (b) the
    // session holds the module governing this action ('leasing' for lease-term
    // countersign/confirm-term). "May this actor do THIS action here?", not
    // merely "does this person work here?".
    const sessionModules = Array.isArray(session.allowed_modules) ? session.allowed_modules : [];
    const propertyScopeOk = session.property_id === app.property_id;
    const hasModule = sessionModules.includes(REQUIRED_MODULE);
    if (!propertyScopeOk || !hasModule) {
      audit({ actor_user_id: session.id, property_id: app.property_id, application_id: app.id,
              action: ACTION, decision: "refused",
              reason: !propertyScopeOk
                ? "session_property_scope_mismatch:" + session.property_id
                : "action_not_authorized:missing_module:" + REQUIRED_MODULE });
      return refuse(res);
    }

    // RECORD CLASSIFICATION: current internal_qa for the application's person.
    // Re-checked every phase. Read failure → refuse, audited distinctly.
    const cls = await currentEligibleClass(pool, app.person_id, app.property_id);
    if (!cls.ok) {
      audit({ actor_user_id: session.id, property_id: app.property_id, application_id: app.id,
              action: ACTION, decision: "refused",
              reason: cls.read_failed ? "consent_read_failed" : "no_consent" });
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
                            role: session.role || null, role_title: session.role_title || null,
                            authorized_module: REQUIRED_MODULE };
    req._perimeterApp = app;
    audit({ actor_user_id: session.id, property_id: app.property_id, application_id: app.id,
            action: ACTION, decision: "admitted" });
    return next();
  };
}

module.exports = { activationPerimeter, activatedPropertyIds, currentEligibleClass };
