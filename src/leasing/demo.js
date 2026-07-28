// demo.js — Two-sided live demo ORCHESTRATION layer (first-proof slice).
//
// Owns NO domain truth. Each transition opens ONE transaction, calls the owning
// module's transaction-aware SERVICE (never an Express route), and appends a
// demo_event on the SAME client. Real record write + proof append commit together
// or both roll back.
//
// First-proof slice = reset · state · application-submit · application-approve.
// The remaining lifecycle transitions are added per the compatibility matrix in
// DEMO_052_PLAN.md once each owning module's service boundary is verified.
//
// Mount in server.js AFTER the application submission module (so its _service is in
// scope), e.g. directly under the leasingShadowImport mount:
//   const demoModule = require("./demo");
//   app.use("/", demoModule({ pool, submissionService: __applicationSubmission._service }));
//
// Grounded against live server.js (Jun 29 2026): ids are uuid; application table is
// lease_applications; persons/properties/units/users/events are the real tables.

// tokenHash() removed with the mutating routes (Slice C2) — it only minted
// role-scoped demo tokens for the reset route. Preserved in tools/demo_run_ops.js.

// the legal predecessor each checkpoint advances FROM (server-owned state machine)
const CHECKPOINT_FROM = {
  application_submitted: "application_ready",
  application_approved: "application_submitted",
};

module.exports = function demoModule(deps) {
  const { pool, submissionService, applicationsService = null } = deps;
  if (!pool) throw new Error("demo.js requires { pool }");
  if (!submissionService) throw new Error("demo.js requires { submissionService } (= applicationSubmissionModule(...)._service)");

  // run a fn inside ONE transaction; we own begin/commit (NOT the app module's tx()).
  async function tx(fn) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const out = await fn(client);
      await client.query("commit");
      return out;
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
  }

  function httpErr(status, msg) {
    const e = new Error(msg); e.httpStatus = status; e.publicMessage = msg; return e;
  }

  // appendEvent() removed with the mutating routes (Slice C2) — it was the only
  // demo_events writer and every caller was a removed route. Preserved verbatim
  // in tools/demo_run_ops.js.

  // load run + its current (active) attempt; throws 404 if none
  async function loadCurrent(client, slug) {
    const run = (await client.query("select * from demo_runs where slug=$1", [slug])).rows[0];
    if (!run) throw httpErr(404, "No demo run with that slug.");
    const attempt = (await client.query(
      "select * from demo_attempts where demo_run_id=$1 and status='active' order by created_at desc limit 1",
      [run.id]
    )).rows[0];
    return { run, attempt };
  }

  // requireCheckpoint() and advance() removed with the mutating routes
  // (Slice C2). advance() was the only demo_attempts writer; both were called
  // exclusively by removed routes. Preserved verbatim in tools/demo_run_ops.js.
  //
  // With these gone, THIS MODULE CONTAINS NO INSERT, UPDATE OR DELETE AT ALL —
  // it is a read-only projection over demo_runs / demo_attempts / demo_events.

  // ── the composed read: ONE object both phones render (JOIN over real records) ──
  const SCENES = [
    "application_ready","application_submitted","application_approved",
    "lease_terms_ready","lease_sent","tenant_signed","lease_countersigned",
    "move_in_ready","move_in_confirmed","operations","completed",
  ];
  function unlockedFor(checkpoint) {
    // what each side may do next at this checkpoint (role-aware)
    switch (checkpoint) {
      case "application_ready":
        return { tenant: { action: "application-submit", label: "Complete your application" }, manager: null };
      case "application_submitted":
        return { tenant: null, manager: { action: "application-approve", label: "Approve application" } };
      case "application_approved":
        return { tenant: { action: null, label: "Awaiting lease" }, manager: { action: null, label: "Prepare lease" } };
      default:
        return { tenant: null, manager: null };
    }
  }

  async function composeState(client, slug) {
    const { run, attempt } = await loadCurrent(client, slug);
    let records = { person: null, application: null, lease: null, thread: null };
    let timeline = [];
    if (attempt) {
      const person = (await client.query(
        "select id, name from persons where id=$1", [attempt.tenant_person_id]
      )).rows[0];
      records.person = person ? { id: person.id, display_name: person.name } : null;
      if (attempt.application_id) {
        const app = (await client.query(
          "select id, status, applicant_name, rent, deposit, captured from lease_applications where id=$1",
          [attempt.application_id]
        )).rows[0];
        records.application = app ? {
          id: app.id, status: app.status, applicant_name: app.applicant_name,
          rent: app.rent, deposit: app.deposit,
          captured: app.captured || {},
        } : null;
      }
      const ev = await client.query(
        `select sequence_no, event_type, actor_type, source_record_type,
                source_record_id, source_event_id, created_at
           from demo_events where demo_attempt_id=$1 order by sequence_no asc`,
        [attempt.id]
      );
      timeline = ev.rows.map(r => ({
        seq: r.sequence_no, event_type: r.event_type, actor_type: r.actor_type,
        source_record_type: r.source_record_type, source_record_id: r.source_record_id,
        source_event_id: r.source_event_id, at: r.created_at,
      }));
    }
    const checkpoint = attempt ? attempt.checkpoint : null;
    return {
      slug: run.slug,
      property_id: run.property_id,            // for the agent demo bridge (identity resolution)
      unit_id: run.unit_id || null,
      tenant_person_id: attempt ? attempt.tenant_person_id : null,
      attempt_id: attempt ? attempt.id : null,
      attempt_status: attempt ? attempt.status : null,
      checkpoint,
      scene_index: checkpoint ? SCENES.indexOf(checkpoint) : -1,
      scene_total: SCENES.length,
      unlocked_action: checkpoint ? unlockedFor(checkpoint) : { tenant: null, manager: null },
      records,
      timeline,
      updated_at: attempt ? attempt.updated_at : null,
    };
  }

  // ───────────────────────── ROUTES ─────────────────────────
  const router = require("express").Router();

  async function sendState(res, slug) {
    const state = await tx((client) => composeState(client, slug));
    res.json(state);
  }

  // GET state — both phones poll this
  router.get("/demo/runs/:slug/state", async (req, res) => {
    try { await sendState(res, req.params.slug); }
    catch (e) { res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message }); }
  });

  // ── FOUR MUTATING ROUTES REMOVED 2026-07-28 (Slice C2) ──────────────
  //
  //   POST /demo/runs/:slug/seed
  //   POST /demo/runs/:slug/reset
  //   POST /demo/runs/:slug/application-submit
  //   POST /demo/runs/:slug/application-approve
  //
  // This file has ZERO process.env references — no DEMO_MODE, no access code,
  // no confirm token — and mounts under /demo/, which server.js lists in
  // PUBLIC_PREFIXES. All four were therefore reachable UNAUTHENTICATED on the
  // public internet, and all four mutate the shared operating database:
  //
  //   seed    accepted a CLIENT-SUPPLIED property_id, validated only that the
  //           property existed, then wrote property_team_assignments with
  //           can_manage_roles=true on it, and created properties/units/users.
  //           §21 inverted: a client-provided property ID deciding where
  //           authority is granted.
  //   reset   accepted client-supplied manager_user_id and tenant identity and
  //           minted durable persons rows.
  //   submit  overwrote a real persons row name/email/phone from an
  //           unauthenticated body and created a real lease_application.
  //   approve invoked the canonical approveApplication attributed to a real
  //           manager user the caller never authenticated as.
  //
  // They were NOT secured with another access code, a DEMO_MODE check, a slug
  // allowlist, or a no-op — each of those leaves a demo-special write path
  // (§17 "Demo data may exist. Demo paths may not.", §32 stop-sign).
  //
  // The logic is preserved verbatim, UNMOUNTED, as Class 3 tooling in
  // tools/demo_run_ops.js. That file exports an express router and must never
  // be mounted; nothing in src/ may require it.
  //
  // GET /demo/runs/:slug/state above is READ-ONLY and deliberately retained.
  // /demo/rehearsal-reset (demo_reset.js) is a separate module, untouched in
  // this slice: it is multiply gated, writes only through the canonical
  // closeNotFit service, deletes nothing, and ignores client property input.


  // expose for tests / later transitions
  router._service = { composeState, CHECKPOINT_FROM };
  return router;
};
