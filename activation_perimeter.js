// ════════════════════════════════════════════════════════════════════
//  activation_perimeter.js — THE CONTROLLED ACTIVATION PERIMETER
//
//  Reviewer ruling (tenancy-anchor slice, Step 6): before any live route
//  proof, the two gated tenancy routes (countersign, confirm-term) must be
//  reachable ONLY inside an explicit perimeter, fail-closed otherwise:
//
//      enabled mode
//        AND property ∈ approved activation set
//        AND record classified internal_qa (person × THAT property)
//        AND authorized operator
//        AND eligible application state
//      → otherwise 403, deterministically.
//
//  WHY THIS EXISTS: the current dormant gate is a GLOBAL on/off. Flipping
//  COMMITMENT_LEDGER_MODE=enabled to prove concurrency would expose both
//  gated routes across ALL properties and ALL application states before any
//  scoping exists. The perimeter turns "globally on" into "on only for one
//  approved property + one controlled internal-QA record + an authorized
//  operator." A reversible env var does not undo a durable write; the
//  perimeter prevents the durable write from being reachable in the first
//  place except inside the controlled set.
//
//  TWO LAYERS, both fail-closed, in order:
//    Layer 1 — MODE (no DB, no side effects, runs FIRST): reuses the
//      dormant-gate contract. COMMITMENT_LEDGER_MODE must be 'enabled', else
//      403 LEDGER_DORMANT. This preserves the original "cannot be used"
//      guarantee even if Layer 2 has a bug.
//    Layer 2 — PERIMETER (resolves the application, then checks scope): the
//      application's property must be approved; the application's person must
//      hold a CURRENT internal_qa classification in that property; the
//      operator must be authorized; the application must be in an eligible
//      state for the route. Any miss → 403 with a specific reason.
//
//  ABSENCE IS EXPLICIT (matches 076 + communications_boundary): no current
//  internal_qa classification row = NOT permitted. Never assume production;
//  never assume QA. Fail closed on absence and on any DB read failure.
//
//  CLASS: Class 2 temporary adapter. Replacement condition: durable
//  property-level activation capability + the resolved staff-identity/actor
//  binding become the canonical authority for these routes, at which point
//  the env-var allowlist and the operator-key check are replaced by
//  server-derived entitlement. Until then, this is the controlled perimeter.
// ════════════════════════════════════════════════════════════════════

const { resolveMode } = require("./dormant_gate");

// Approved activation set — an explicit, comma-separated allowlist of property
// UUIDs. Absent/empty = NO property is approved (fail closed). A bug cannot
// accidentally activate a property that is not named here.
function approvedPropertyIds() {
  const raw = process.env.ACTIVATION_PROPERTY_IDS || "";
  return new Set(
    raw.split(",").map((s) => s.trim()).filter(Boolean)
  );
}

// The operator-key check the existing operator routes already use. The
// perimeter requires it explicitly here too — being past the dormant gate is
// not the same as being an authorized operator. When the durable
// staff-identity/actor binding lands, this is replaced by server-derived
// entitlement (see replacement condition above).
function operatorAuthorized(req) {
  const provided = req.headers["x-operator-key"];
  const expected = process.env.OPERATOR_KEY;
  return !!expected && provided === expected;
}

// Read the CURRENT internal_qa classification for a person in a property.
// Fail-closed: returns false on absence OR on any read failure. Mirrors the
// communications_boundary read pattern (current row = latest, superseded_at is
// null). We do not assume a column set beyond 076; we check record_class and
// that the row is current.
async function personIsInternalQaInProperty(pool, personId, propertyId) {
  if (!personId || !propertyId) return false;
  try {
    const q = await pool.query(
      `select record_class
         from person_property_classifications
        where person_id = $1
          and property_id = $2
          and (superseded_at is null)
        order by classified_at desc
        limit 1`,
      [personId, propertyId]
    );
    if (q.rows.length === 0) return false;          // UNCLASSIFIED → not permitted
    return q.rows[0].record_class === "internal_qa";
  } catch (_e) {
    // classification table unavailable / column mismatch → fail closed.
    return false;
  }
}

// Build the perimeter guard. `loadApplication(pool, id)` returns the
// application row (or null) so the perimeter can read property_id + person_id
// + status without duplicating the route's own loader. `eligibleStatuses` is
// the set of application statuses this route may run against (route-specific).
//
// Usage on a route:
//   const guard = activationPerimeter({
//     pool,
//     loadApplication: (pool, id) => getApp-equivalent,
//     eligibleStatuses: ["accepted_term_required"],   // confirm-term
//   });
//   router.post("/applications/:id/confirm-term", dormantWriteGuard, guard, handler);
//
// Note: dormantWriteGuard still runs FIRST (Layer 1 in the chain). This guard
// is Layer 2. Mounting both keeps the no-DB mode check ahead of any DB read.
function activationPerimeter({ pool, loadApplication, eligibleStatuses }) {
  const eligible = new Set(eligibleStatuses || []);
  return async function perimeterGuard(req, res, next) {
    // Layer 1 backstop (defensive): even though dormantWriteGuard should
    // precede us, re-check the mode with no DB so this guard is safe if
    // mounted alone.
    if (resolveMode() !== "enabled") {
      return res.status(403).json({
        error: "commitment_ledger_dormant",
        code: "LEDGER_DORMANT",
        receipt: "Activation is dormant. Enabling requires COMMITMENT_LEDGER_MODE=enabled and a separate release decision.",
      });
    }

    // authorized operator (explicit — past the mode gate ≠ authorized).
    if (!operatorAuthorized(req)) {
      return res.status(403).json({
        error: "operator_not_authorized",
        code: "PERIMETER_OPERATOR",
        receipt: "Not an authorized operator for a gated activation route.",
      });
    }

    // resolve the application to get server-derived property + person + status.
    let app = null;
    try {
      app = await loadApplication(pool, req.params.id);
    } catch (_e) {
      app = null;
    }
    if (!app) {
      return res.status(404).json({ receipt: "No application with that id." });
    }

    // property must be in the approved activation set.
    const approved = approvedPropertyIds();
    if (!approved.has(app.property_id)) {
      return res.status(403).json({
        error: "property_not_in_activation_set",
        code: "PERIMETER_PROPERTY",
        receipt: "This application's property is not in the approved activation set. Gated routes run only for explicitly approved properties.",
      });
    }

    // the application's person must hold a CURRENT internal_qa classification
    // in THIS property. Absence = not permitted (fail closed).
    const isQa = await personIsInternalQaInProperty(pool, app.person_id, app.property_id);
    if (!isQa) {
      return res.status(403).json({
        error: "record_not_internal_qa",
        code: "PERIMETER_CLASSIFICATION",
        receipt: "This application's record is not classified internal_qa in this property. Gated routes run only for controlled internal-QA records during activation proof.",
      });
    }

    // eligible application state for this specific route.
    if (eligible.size > 0 && !eligible.has(app.status)) {
      return res.status(409).json({
        error: "application_state_ineligible",
        code: "PERIMETER_STATE",
        receipt: `Application status '${app.status}' is not eligible for this route (expected one of: ${[...eligible].join(", ")}).`,
      });
    }

    // Perimeter satisfied. Attach the resolved app so the handler can reuse it
    // (avoids a second load) without changing the handler's own guarantees.
    req._perimeterApp = app;
    return next();
  };
}

module.exports = {
  activationPerimeter,
  approvedPropertyIds,
  operatorAuthorized,
  personIsInternalQaInProperty,
};
