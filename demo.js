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

const crypto = require("crypto");

function tokenHash(raw) {
  return crypto.createHash("sha256").update(String(raw)).digest("hex");
}

// the legal predecessor each checkpoint advances FROM (server-owned state machine)
const CHECKPOINT_FROM = {
  application_submitted: "application_ready",
  application_approved: "application_submitted",
};

module.exports = function demoModule(deps) {
  const { pool, submissionService } = deps;
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

  // append the next demo_event on the SAME client, gap-free sequence within the attempt
  async function appendEvent(client, attempt_id, ev) {
    const seq = await client.query(
      "select coalesce(max(sequence_no),0)+1 as n from demo_events where demo_attempt_id=$1",
      [attempt_id]
    );
    const n = seq.rows[0].n;
    await client.query(
      `insert into demo_events
         (demo_attempt_id, sequence_no, event_type, actor_type, actor_person_id,
          actor_user_id, actor_role, source_module, source_record_type, source_record_id,
          source_event_id, payload_json)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [attempt_id, n, ev.event_type, ev.actor_type, ev.actor_person_id ?? null,
       ev.actor_user_id ?? null, ev.actor_role ?? null, ev.source_module ?? null,
       ev.source_record_type ?? null, ev.source_record_id ?? null,
       ev.source_event_id ?? null, JSON.stringify(ev.payload_json || {})]
    );
    return n;
  }

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

  // require the attempt to be at the expected checkpoint before a transition writes
  function requireCheckpoint(attempt, expected) {
    if (!attempt) throw httpErr(409, "No active attempt — reset the demo to begin.");
    if (attempt.checkpoint !== expected) {
      throw httpErr(409, `Not allowed at checkpoint '${attempt.checkpoint}'. Expected '${expected}'.`);
    }
  }

  async function advance(client, attempt_id, checkpoint) {
    await client.query(
      "update demo_attempts set checkpoint=$2, updated_at=now() where id=$1",
      [attempt_id, checkpoint]
    );
  }

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

  // RESET — close current attempt, open a fresh one with a fresh synthetic person,
  // fresh role-scoped tokens; PRESERVES old attempts + their events.
  router.post("/demo/runs/:slug/reset", async (req, res) => {
    try {
      const out = await tx(async (client) => {
        const run = (await client.query("select * from demo_runs where slug=$1", [req.params.slug])).rows[0];
        if (!run) throw httpErr(404, "No demo run with that slug.");

        // close any active attempt
        await client.query(
          "update demo_attempts set status='reset', closed_at=now(), updated_at=now() where demo_run_id=$1 and status='active'",
          [run.id]
        );

        // a manager must exist (real users row). use provided, else first user.
        // a manager must exist (real users row). prefer an explicit one, then a
        // leasing_manager (the role the application_approval gate routes to), then
        // any user as a last resort. seed creates a leasing_manager so this resolves.
        const mgrId = (req.body && req.body.manager_user_id)
          ? req.body.manager_user_id
          : (
              (await client.query(
                "select id from users where role='leasing_manager'::role_name order by created_at asc limit 1"
              )).rows[0]?.id
              || (await client.query("select id from users order by created_at asc limit 1")).rows[0]?.id
            );
        if (!mgrId) throw httpErr(409, "No users row to act as manager — POST /demo/runs/:slug/seed first (it creates one).");

        // fresh synthetic tenant person (a real persons row; lifecycle 'lead')
        const name = (req.body && req.body.tenant_name) || "Jordan Avery (demo)";
        const phone = (req.body && req.body.tenant_phone) || null;
        const person = (await client.query(
          `insert into persons (name, phone, source, lifecycle_status, leasing_stage)
           values ($1,$2,'demo','lead','lead') returning id`,
          [name, phone]
        )).rows[0];

        // fresh role-scoped tokens (return raw once; store only hashes)
        const tenantTok = crypto.randomBytes(24).toString("hex");
        const mgrTok = crypto.randomBytes(24).toString("hex");

        const attempt = (await client.query(
          `insert into demo_attempts
             (demo_run_id, status, checkpoint, tenant_person_id, manager_user_id,
              manager_role, tenant_token_hash, manager_token_hash)
           values ($1,'active','application_ready',$2,$3,'leasing_manager',$4,$5)
           returning id`,
          [run.id, person.id, mgrId, tokenHash(tenantTok), tokenHash(mgrTok)]
        )).rows[0];

        await appendEvent(client, attempt.id, {
          event_type: "demo_reset", actor_type: "system",
          payload_json: { tenant_person_id: person.id },
        });

        return { attempt_id: attempt.id, tenant_token: tenantTok, manager_token: mgrTok };
      });
      res.json(out); // raw tokens returned ONCE for link building
    } catch (e) { res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message }); }
  });

  // APPLICATION SUBMIT — tenant completes the REAL application via the app service
  // APPLICATION SUBMIT — tenant completes the REAL application via the app service.
  // Full field set: identity/contact land on the persons row AND in the application's
  // `captured` JSON; rent/deposit are real columns. Nothing faked — every field
  // persists on the real lease_applications record.
  router.post("/demo/runs/:slug/application-submit", async (req, res) => {
    try {
      await tx(async (client) => {
        const { attempt } = await loadCurrent(client, req.params.slug);
        requireCheckpoint(attempt, "application_ready");

        const b = req.body || {};
        const fullName = (b.applicant_name || "").trim() || "Jordan Avery";
        const email    = (b.email || "").trim() || null;
        const phone    = (b.phone || "").trim() || null;

        // the rich applicant detail → application.captured (JSON the table is built for)
        const captured = {
          email, phone,
          date_of_birth:   (b.date_of_birth || "").trim() || null,
          current_address: (b.current_address || "").trim() || null,
          employer:        (b.employer || "").trim() || null,
          job_title:       (b.job_title || "").trim() || null,
          monthly_income:  b.monthly_income != null && b.monthly_income !== "" ? Number(b.monthly_income) : null,
          occupants:       b.occupants != null && b.occupants !== "" ? Number(b.occupants) : null,
          desired_move_in: (b.desired_move_in || "").trim() || null,
          pets:            typeof b.pets === "boolean" ? b.pets : ((b.pets || "") === "yes"),
        };
        const rent    = b.rent != null && b.rent !== "" ? Number(b.rent) : null;
        const deposit = b.deposit != null && b.deposit !== "" ? Number(b.deposit) : null;

        // keep the real person row in step with what the applicant just told us
        await client.query(
          `update persons set
             name  = $2,
             email = coalesce($3, email),
             phone = coalesce($4, phone),
             updated_at = now()
           where id = $1`,
          [attempt.tenant_person_id, fullName, email, phone]
        );

        const result = await submissionService.submitApplicationService(client, {
          property_id: (await client.query(
            "select property_id from demo_runs where id=$1", [attempt.demo_run_id]
          )).rows[0].property_id,
          person_id: attempt.tenant_person_id,
          applicant_name: fullName,
          unit_id: (await client.query(
            "select unit_id from demo_runs where id=$1", [attempt.demo_run_id]
          )).rows[0].unit_id || null,
          rent, deposit,
          captured,
          source: "applicant",
        });
        // submitApplicationService returns { application, approval_obligation_id, ... }
        // — NOT the application row directly. Read the nested application.
        const app = result.application;
        if (!app || !app.id) throw httpErr(500, "Application service returned no application record.");

        await client.query(
          "update demo_attempts set application_id=$2, updated_at=now() where id=$1",
          [attempt.id, app.id]
        );
        await appendEvent(client, attempt.id, {
          event_type: "application_submitted", actor_type: "tenant",
          actor_person_id: attempt.tenant_person_id,
          source_module: "application_submission", source_record_type: "lease_application",
          source_record_id: app.id,
          payload_json: { applicant_name: app.applicant_name },
        });
        await advance(client, attempt.id, "application_submitted");
      });
      await sendState(res, req.params.slug);
    } catch (e) { res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message }); }
  });

  // APPLICATION APPROVE — manager approves via the REAL service (closes the gate)
  router.post("/demo/runs/:slug/application-approve", async (req, res) => {
    try {
      await tx(async (client) => {
        const { attempt } = await loadCurrent(client, req.params.slug);
        requireCheckpoint(attempt, "application_submitted");
        if (!attempt.application_id) throw httpErr(409, "No application on this attempt.");

        const app = (await client.query(
          "select * from lease_applications where id=$1", [attempt.application_id]
        )).rows[0];
        if (!app) throw httpErr(404, "Application record missing.");

        await submissionService.closeApprovalGate(client, {
          app, by_user_id: attempt.manager_user_id, decision: "approved",
        });

        await appendEvent(client, attempt.id, {
          event_type: "application_approved", actor_type: "manager",
          actor_user_id: attempt.manager_user_id, actor_role: attempt.manager_role,
          source_module: "application_submission", source_record_type: "lease_application",
          source_record_id: app.id, payload_json: { decision: "approved" },
        });
        await advance(client, attempt.id, "application_approved");
      });
      await sendState(res, req.params.slug);
    } catch (e) { res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message }); }
  });

  // SEED — create (or confirm) the demo_run row for a slug, pointed at a REAL
  // property + a REAL unit IN THE BACKEND DB. Idempotent (slug is unique; the demo
  // property is found by its marker name and reused). No demo_attempt is created
  // here — reset does that.
  //
  // Property resolution order:
  //   1. explicit body.property_id (must exist) — pin to a real property if you have one
  //   2. else: a dedicated demo property (name 'Property Spine Demo Building'),
  //      created with one demo unit if it doesn't exist yet.
  // This removes any dependency on the offline app's IDs — those do NOT exist in the
  // backend DB. The demo owns its own property, matching the "dedicated DEMO property"
  // guardrail in the plan.
  router.post("/demo/runs/:slug/seed", async (req, res) => {
    try {
      const out = await tx(async (client) => {
        const slug = req.params.slug;
        const DEMO_PROP_NAME = "Property Spine Demo Building";
        let propertyId = (req.body && req.body.property_id) || null;
        let unitId = (req.body && req.body.unit_id) || null;

        if (propertyId) {
          const p = (await client.query(
            "select id from properties where id=$1", [propertyId]
          )).rows[0];
          if (!p) throw httpErr(404, "No property with that id in the backend DB — omit property_id to use the demo property.");
        } else {
          // find or create the dedicated demo property
          let prop = (await client.query(
            "select id from properties where name=$1 order by created_at asc limit 1",
            [DEMO_PROP_NAME]
          )).rows[0];
          if (!prop) {
            prop = (await client.query(
              `insert into properties (name, address, city, state, zip, property_type)
                 values ($1,'1 Demo Way','Philadelphia','PA','19104','multifamily')
               returning id`,
              [DEMO_PROP_NAME]
            )).rows[0];
          }
          propertyId = prop.id;
        }

        // resolve a unit on that property (pin one, else first, else create one)
        if (unitId) {
          const u = (await client.query(
            "select id from units where id=$1 and property_id=$2", [unitId, propertyId]
          )).rows[0];
          if (!u) throw httpErr(404, "That unit_id is not on that property.");
        } else {
          let u = (await client.query(
            "select id from units where property_id=$1 order by unit_number asc limit 1",
            [propertyId]
          )).rows[0];
          if (!u) {
            u = (await client.query(
              `insert into units (property_id, unit_number, bedrooms, bathrooms, square_feet, market_rent)
                 values ($1,'101',1,1,650,1500) returning id`,
              [propertyId]
            )).rows[0];
          }
          unitId = u.id;
        }

        const run = (await client.query(
          `insert into demo_runs (slug, property_id, unit_id)
             values ($1,$2,$3)
           on conflict (slug) do update
             set property_id = excluded.property_id,
                 unit_id     = excluded.unit_id
           returning id, slug, property_id, unit_id`,
          [slug, propertyId, unitId]
        )).rows[0];

        // ensure a leasing_manager user exists for reset to use as the approver.
        // the application_approval gate routes to role 'leasing_manager' (047 enum),
        // so the demo manager should hold that role. find-or-create by a marker email.
        const DEMO_MGR_EMAIL = "demo-manager@propertyspine.internal";
        let mgr = (await client.query(
          "select id from users where email=$1 limit 1", [DEMO_MGR_EMAIL]
        )).rows[0];
        if (!mgr) {
          mgr = (await client.query(
            `insert into users (name, email, phone, role)
               values ('Demo Leasing Manager', $1, null, 'leasing_manager'::role_name)
             returning id`,
            [DEMO_MGR_EMAIL]
          )).rows[0];
        }

        return { seeded: true, run, manager_user_id: mgr.id };
      });
      res.json(out);
    } catch (e) { res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message }); }
  });

  // expose for tests / later transitions
  router._service = { composeState, CHECKPOINT_FROM };
  return router;
};
