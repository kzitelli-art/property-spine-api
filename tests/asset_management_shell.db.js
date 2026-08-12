/* ════════════════════════════════════════════════════════════════════
   asset_management_shell.db.js — THE ASSET MANAGEMENT DOOR, PROVEN
   against real PostgreSQL and real HTTP.

   Asset Management is the FOURTH operating door. This proves the shell
   tells the truth, and — more importantly — proves the specific ways it
   could lie:

     · that it refuses an unauthenticated caller
     · that it refuses a caller WITHOUT the asset_management module,
       which is the entitlement gate, not a job title
     · that it ADMITS a caller who holds the module but is NOT called an
       asset manager — entitlement and title are different facts, and a
       door that reads the title would silently deny a property manager
       who legitimately holds the module
     · that it refuses a client-supplied property_id rather than ignoring
       it (§21)
     · that it returns FOUR rooms in the canonical order
     · that Revenue reads REAL lease data — not_established with no
       leases, partially_established once a lease carries rent and a term
     · that Capital / Property Obligations / Operating Costs say
       not_established, because no such tables exist
     · THAT NO ROOM EVER RENDERS A CURRENCY-SHAPED TOKEN. This is the
       assertion the slice exists for: the whole point is a shell that
       does not fabricate economics, and "make the screens look complete"
       is exactly how that gets lost later.

   ISOLATION: requires HARNESS_DATABASE_URL and refuses to run against
   anything named like production. Builds its own scoped schema — the
   full chain cannot rebuild from empty (012_bank_intake / yardi_code),
   which predates this work and bounds every proof in this repo.

   Run:
     HARNESS_DATABASE_URL=postgresql://postgres@127.0.0.1:5433/postgres \
       node tests/asset_management_shell.db.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const http = require("http");
const { Pool } = require("pg");
const receipt = require("./_run_receipt.js");

//  THE SAME-TARGET REFUSAL, not merely a required variable.
//
//  An earlier revision of this file checked HARNESS_DATABASE_URL against a
//  name pattern (/prod|neon|render/) and gate_harness_isolation.js failed
//  it, correctly: requiring the variable is not the same as refusing the
//  wrong VALUE. A disposable branch on the same host would have passed a
//  name check and still been production. harnessConnectionString() resolves
//  host/port/database and exits rather than returning on a match.
const URL_ = receipt.harnessConnectionString();

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? "\n          " + detail : "")); }
}

//  A currency-shaped token. Deliberately broad: a bare number is fine
//  (counts are real), but anything wearing a currency symbol or a
//  thousands-separated decimal is a fabricated economic magnitude in a
//  surface that has no economics yet.
const CURRENCYISH = /[$£€]\s?\d|\d{1,3}(,\d{3})+(\.\d{2})?|\b\d+\.\d{2}\b/;

async function main() {
  const pool = new Pool({ connectionString: URL_ });
  const schema = "am_shell_" + Date.now();
  let server, port;

  try {
    await pool.query(`create schema ${schema}`);
    await pool.query(`set search_path to ${schema}`);

    // ── the scoped schema this door actually touches ──────────────────
    await pool.query(`
      create extension if not exists pgcrypto;
      set search_path to ${schema};
      create table properties (
        id uuid primary key default gen_random_uuid(),
        name text, organization_id uuid);
      create table spaces (
        id uuid primary key default gen_random_uuid(),
        property_id uuid references properties(id));
      create table leases (
        id uuid primary key default gen_random_uuid(),
        property_id uuid not null references properties(id),
        space_id uuid references spaces(id),
        rent numeric(10,2),
        start_date date,
        end_date date,
        lease_status text not null default 'active');
    `);

    const propId = (await pool.query(
      `insert into ${schema}.properties (name) values ('Harness Property') returning id`)).rows[0].id;

    // ── a fake session resolver: the door's ONLY identity input ───────
    //  Swapping the resolver rather than minting real sessions keeps this
    //  test about the DOOR. The session shape is copied from what
    //  staff_session_service actually returns and is the contract under
    //  test here.
    const resolverPath = require.resolve("../src/identity/staff_session_service.js");
    const sessions = new Map();
    require.cache[resolverPath] = {
      id: resolverPath, filename: resolverPath, loaded: true,
      exports: {
        resolveStaffSession: async (_pool, token) => sessions.get(token) || null,
      },
    };

    sessions.set("tok-am", {
      id: "u-am", name: "Holds The Module", role: "property_manager",
      property_id: propId, allowed_modules: ["management", "maintenance", "asset_management"],
    });
    sessions.set("tok-noam", {
      id: "u-noam", name: "No Module", role: "asset_manager",
      property_id: propId, allowed_modules: ["management", "leasing"],
    });

    // ── real HTTP, real router ────────────────────────────────────────
    const express = require("express");
    const app = express();
    app.use(express.json());
    // search_path so the door's queries hit the scoped schema
    const scopedPool = new Pool({ connectionString: URL_ });
    scopedPool.on("connect", (c) => c.query(`set search_path to ${schema}`));
    app.use("/", require("../src/surfaces/asset_management.js")({ pool: scopedPool }));

    server = http.createServer(app);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    port = server.address().port;

    const get = (path, token) => new Promise((resolve) => {
      const req = http.request(
        { host: "127.0.0.1", port, path, method: "GET",
          headers: token ? { "x-staff-session": token } : {} },
        (res) => {
          let b = ""; res.on("data", (d) => b += d);
          res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: res.statusCode, body: j, raw: b }); });
        });
      req.on("error", () => resolve({ status: 0, body: null, raw: "" }));
      req.end();
    });

    const PATH = "/operator/asset-management/overview";

    console.log("\n── 1. AUTHORITY ──────────────────────────────────────");

    const anon = await get(PATH, null);
    ok("no session → 401, not an empty result", anon.status === 401,
       `got ${anon.status}`);

    const noMod = await get(PATH, "tok-noam");
    ok("session WITHOUT asset_management module → 403",
       noMod.status === 403, `got ${noMod.status}`);
    ok("the 403 names allowed_modules, so the operator knows what is missing",
       !!(noMod.body && /allowed_modules/.test(noMod.body.error || "")));

    //  THE ENTITLEMENT-NOT-TITLE ASSERTION. tok-noam's role IS
    //  'asset_manager' and it is REFUSED; tok-am's role is
    //  'property_manager' and it is ADMITTED. A door that read the title
    //  would get both of these backwards.
    ok("a caller whose ROLE is asset_manager but lacks the MODULE is refused",
       noMod.status === 403);

    const good = await get(PATH, "tok-am");
    ok("a caller whose role is property_manager but HOLDS the module is admitted",
       good.status === 200, `got ${good.status} ${good.raw.slice(0, 160)}`);

    const spoof = await get(PATH + "?property_id=00000000-0000-0000-0000-000000000123", "tok-am");
    ok("§21 a client-supplied property_id is REFUSED, not ignored",
       spoof.status === 403);
    ok("the refusal states which property it is acting on",
       !!(spoof.body && spoof.body.acting_on === propId));

    console.log("\n── 2. THE FOUR ROOMS ─────────────────────────────────");

    const rooms = (good.body && good.body.rooms) || [];
    ok("exactly four rooms", rooms.length === 4, `got ${rooms.length}`);
    /*  ⚠ THE FOUR DOORS ARE A PRODUCT RULING, PINNED BY KEY AND ORDER.
     *  The previous four — revenue · capital · property_obligations ·
     *  operating_costs — mixed an income category, a capitalisation
     *  structure, a bundle of standing obligations and a bundle of
     *  operating costs at one level, so "what does this property cost to
     *  own" had two rooms and neither had the whole answer. The new four
     *  are cut by QUESTION. */
    ok("canonical order: capital_stack · property_expenses · projects_capex · compliance",
       rooms.map((r) => r.key).join(",")
         === "capital_stack,property_expenses,projects_capex,compliance",
       rooms.map((r) => r.key).join(","));
    //  ⚠ THE OLD DOORS ARE GONE, NOT ALIASED. An alias would leave two
    //  pathways to one room and the next reader would not know which is
    //  canonical.
    ok("Revenue is not a door here — its sources live in Leasing and Management",
       !rooms.some((r) => /revenue/i.test(r.key) || /revenue/i.test(r.label)),
       rooms.map((r) => r.label).join(","));
    ok("neither is Property Obligations, nor Operating Costs",
       !rooms.some((r) => ["property_obligations", "operating_costs"].includes(r.key)));
    ok("every room carries an establishment state",
       rooms.every((r) => ["established", "partially_established", "not_established"].includes(r.establishment)));
    ok("every room says WHY in plain language",
       rooms.every((r) => typeof r.why === "string" && r.why.length > 20));
    ok("every room names what would establish it",
       rooms.every((r) => typeof r.what_would_establish_it === "string" && r.what_would_establish_it.length > 10));
    ok("no room invents an owner — UNASSIGNED until one is recorded",
       rooms.every((r) => r.owner === "UNASSIGNED"));
    //  The response used to carry a scope_note explaining that this door
    //  returns no amounts. That is developer language, and it was rendering
    //  under the desk as product copy. The honest cards say the same thing
    //  in the operator's words; a caveat nobody needs is noise on a surface
    //  whose whole job is calm.
    ok("no developer-facing caveat is emitted at all",
       !("scope_note" in (good.body || {})));
    ok("…and no room leaks proof/shell vocabulary into operator copy",
       rooms.every((r) => !/establishment state only|this door returns|shell/i
         .test([r.belongs, r.establishment_summary, r.why].join(" "))));

    console.log("\n── 2c. COMPARTMENTS — THE PERMANENT SKELETON ─────────");
    //  A room is not an empty-state page waiting to be replaced. It already
    //  breaks into the compartments it will always have, so the operator
    //  knows where Insurance is going to live and the first real one fills
    //  a slot that already exists instead of forcing a redesign.
    //  Capital Stack legitimately holds three. The claim is that a room
    //  is never an empty page waiting to be replaced — it already breaks
    //  into the skeleton it will always have.
    ok("every room carries compartments",
       rooms.every((r) => Array.isArray(r.compartments) && r.compartments.length >= 3),
       JSON.stringify(rooms.map((r) => [r.key, (r.compartments || []).length])));

    const pxc = (rooms.find((r) => r.key === "property_expenses").compartments || [])
      .map((c) => c.key);
    ok("Property Expenses breaks into all nine expense modules, in order",
       pxc.join(",") === "taxes,insurance,payroll_staffing,utilities,contracted_services,"
         + "repairs_maintenance,management_administration,marketing_leasing,"
         + "other_operating_expenses", JSON.stringify(pxc));

    /*  ⚠ A LICENCE FEE IS AN EXPENSE. A LICENCE IS NOT.
     *  The old taxonomy sat licences beside taxes as though they were the
     *  same kind of fact. Compliance status, renewal and evidence belong
     *  to COMPLIANCE; the fee may later be read as an expense. One domain
     *  owns the operational truth and the economic consequence is read
     *  elsewhere — never two truths. */
    ok("⚠ Licenses & Registrations lives under Compliance",
       (rooms.find((r) => r.key === "compliance").compartments || [])
         .some((c) => c.key === "licenses_registrations"));
    ok("⚠ …and NOT under Property Expenses",
       !pxc.some((k) => /licen/i.test(k)), JSON.stringify(pxc));
    ok("Inspections, Certificates and Violations are compliance, not expense",
       ["inspections", "certificates", "violations_cure", "recurring_requirements"]
         .every((k) => (rooms.find((r) => r.key === "compliance").compartments || [])
           .some((c) => c.key === k)));

    /*  ⚠ PROJECTS & CAPEX IS NOT A SECOND WORK-ORDER SYSTEM.
     *  Maintenance owns the work event. This room owns the economic
     *  position of capital work and will reference operating work later;
     *  a work order must never be creatable from inside Asset Management. */
    const pjc = rooms.find((r) => r.key === "projects_capex");
    ok("Projects & CapEx holds the capital view, not work orders",
       (pjc.compartments || []).map((c) => c.key).join(",")
         === "projects,unit_improvements,building_systems,equipment_ff_e,"
           + "capital_reserves_draws",
       JSON.stringify((pjc.compartments || []).map((c) => c.key)));
    ok("⚠ …and its copy says the work event belongs to Maintenance",
       /Maintenance may hold operating work orders/.test(pjc.why), pjc.why);
    ok("no compartment anywhere is a work order",
       !rooms.some((r) => (r.compartments || []).some((c) =>
         /work_order|dispatch|technician/i.test(c.key))));

    /*  ⚠ CAPITAL STACK MAY READ ESCROW. IT MAY NOT WRITE IT.
     *  Tax escrow truth is owned by the Tax module and insurance escrow
     *  by the Insurance module, each behind gate_funding_boundary.js. */
    const cs = rooms.find((r) => r.key === "capital_stack");
    ok("Capital Stack holds Debt · Equity · Reserves & Escrows",
       (cs.compartments || []).map((c) => c.key).join(",")
         === "debt,equity,reserves_escrows");
    ok("⚠ …and reserves are honestly empty — it is not a second escrow writer",
       (cs.compartments || []).find((c) => c.key === "reserves_escrows")
         .establishment === "not_established");

    ok("every compartment carries its own establishment state",
       rooms.every((r) => (r.compartments || []).every((c) =>
         ["established", "partially_established", "not_established"].includes(c.establishment))));
    ok("every compartment says which KIND of thing is missing, not one generic line",
       new Set(rooms.flatMap((r) => (r.compartments || []).map((c) => c.note))).size
         >= rooms.reduce((n, r) => n + (r.compartments || []).length, 0) - 1);
    //  Compartments fill ONE AT A TIME, so a room must be able to hold two
    //  different states at once. Averaging them would lie in both directions.
    ok("no compartment invents an amount",
       !CURRENCYISH.test(JSON.stringify(rooms.map((r) => r.compartments))));

    //  THE SUB-LABELS ARE A PRODUCT RULING, SO THEY ARE PINNED BY NAME.
    //  They are what the room is FOR, and the hierarchy is the whole point
    //  of the shell. A later edit that quietly drops one would change the
    //  product and break nothing — the same failure mode as a renamed
    //  response key. Read them by name, exactly like H16b does.
    const px = rooms.find((r) => r.key === "property_expenses");
    ok("Property Expenses covers Taxes and Insurance",
       (px.covers || []).includes("Taxes") && (px.covers || []).includes("Insurance"),
       JSON.stringify(px.covers));
    ok("…and Payroll & Staffing, Utilities and Contracted Services",
       ["Payroll & Staffing", "Utilities", "Contracted Services"]
         .every((l) => (px.covers || []).includes(l)), JSON.stringify(px.covers));
    ok("Compliance covers Licenses & Registrations",
       (rooms.find((r) => r.key === "compliance").covers || [])
         .includes("Licenses & Registrations"));

    //  The room's honest-empty sentence must cover the WHOLE room. A room
    //  promising licences and compliance in its labels while its copy only
    //  mentions tax and insurance is quietly telling the operator the rest
    //  is handled.
    //  The room's honest-empty sentence must cover the WHOLE room, not
    //  the two modules easiest to name. A room promising seven more
    //  expense types while its copy mentions only tax and insurance is
    //  quietly telling the operator the rest is handled.
    ok("the empty-expenses copy speaks to the whole room, not just tax and insurance",
       /contract|payroll/i.test(px.why) && /(cost|operate)/i.test(px.why), px.why);
    ok("and Compliance's copy speaks to expiry and standing, not to cost",
       /(expiry|expire|cure|good standing)/i.test(
         rooms.find((r) => r.key === "compliance").why),
       rooms.find((r) => r.key === "compliance").why);

    //  THE CARD'S EYEBROW MAY BE SHORTER THAN covers. IT MAY NOT DISAGREE.
    //  The home card drops the "other / catch-all" tail for density; if it
    //  ever advertised something the room does not claim to hold, the desk
    //  would be promising a capability that has no room behind it.
    //  The rule is ABBREVIATE, NEVER INVENT. "Repairs" on the card is the
    //  same item as "Repairs / other" in the room, so exact membership was
    //  the wrong test — it would have forced the card to carry the room's
    //  full catch-all wording. A prefix match still refuses an eyebrow
    //  entry that has no room item behind it, which is the actual risk.
    ok("every eyebrow entry abbreviates a real covers entry — never invents one",
       rooms.every((r) => (r.eyebrow || []).every((e) =>
         (r.covers || []).some((c) => c === e || c.startsWith(e)))),
       JSON.stringify(rooms.map((r) => ({ k: r.key, e: r.eyebrow, c: r.covers }))));

    console.log("\n── 2b. CARD COPY vs ROOM-LEVEL EXPLANATION ───────────");
    //  The card line and the room-level explanation are different jobs and
    //  must not converge. The card is a desk line; the explanation is the
    //  ⏳ Class 4 room-level text that V1 does not render at all and that
    //  relocates to compartment level when Insurance is built.
    ok("every room carries a SHORT establishment_summary for the card",
       rooms.every((r) => typeof r.establishment_summary === "string"
                          && r.establishment_summary.length > 10));
    ok("every room carries a one-line `belongs` describing what goes there",
       rooms.every((r) => typeof r.belongs === "string" && r.belongs.length > 10));
    ok("the card summary is materially SHORTER than the room explanation",
       rooms.every((r) => r.establishment_summary.length < r.why.length),
       JSON.stringify(rooms.map((r) => [r.key, r.establishment_summary.length, r.why.length])));
    //  The specific leak this guards: the card must not quietly become the
    //  room by carrying the setup guidance forward into it.
    ok("no card summary contains the room's 'what would establish it' text",
       rooms.every((r) => !r.establishment_summary.includes(r.what_would_establish_it)));
    /*  ⚠ NARROWED, AND THE NARROWING IS THE POINT.
     *  The rule is that a CARD must not talk about where truth comes from
     *  — Deal Setup, a retained document — because that is room-level
     *  setup guidance at desk altitude. The old pattern also caught the
     *  bare word "certificate", which now mis-fires: Certificates is one
     *  of Compliance's five MODULES, and naming a room's contents on its
     *  card is exactly what every other card does. Matching a module name
     *  is not evidence of document language. */
    ok("no card summary mentions source documents — that belongs in the room",
       rooms.every((r) => !/Deal Setup|loan document|tax bill|retained|uploaded|on file/i
         .test(r.establishment_summary)),
       JSON.stringify(rooms.map((r) => r.establishment_summary)));

    console.log("\n── 3. ESTABLISHMENT IS READ FROM REAL DATA ───────────");

    const byKey = (k) => rooms.find((r) => r.key === k);

    /*  ── EVERY DOOR IS EMPTY ON A PROPERTY WITH NOTHING ─────────────
     *  This harness builds no tax or insurance schema at all, which makes
     *  it the right place to prove the DEFENSIVE path: a navigation read
     *  whose child domain cannot answer must report "not established"
     *  rather than taking the whole desk down. An operator with a broken
     *  module still needs the other three doors.
     */
    ok("Capital Stack is not_established",
       byKey("capital_stack").establishment === "not_established");
    ok("Projects & CapEx is not_established",
       byKey("projects_capex").establishment === "not_established");
    ok("Compliance is not_established",
       byKey("compliance").establishment === "not_established");
    ok("⚠ Property Expenses reports not_established when its modules cannot answer",
       byKey("property_expenses").establishment === "not_established",
       byKey("property_expenses").establishment);
    ok("…and the desk still returns all four doors rather than failing",
       rooms.length === 4 && good.status === 200);
    ok("…and its two live compartments say so individually, not generically",
       (byKey("property_expenses").compartments || [])
         .filter((c) => ["taxes", "insurance"].includes(c.key))
         .every((c) => c.establishment === "not_established"
                       && /No governed/.test(c.note)),
       JSON.stringify((byKey("property_expenses").compartments || []).slice(0, 2)));

    /*  ⚠ A LEASE IS NOT AN ASSET-MANAGEMENT FACT ANY MORE.
     *  Revenue was removed as a door, so rent — which is real, and which
     *  this harness now writes — must move NOTHING here. Leasing and
     *  Management own it. Before the reorganization a lease made a room
     *  partially established; if that ever comes back, Asset Management
     *  has grown a second revenue surface.
     */
    await pool.query(
      `insert into ${schema}.leases (property_id, rent, start_date, end_date, lease_status)
       values ($1, 1850.00, '2026-01-01', '2026-12-31', 'active')`, [propId]);
    const withLease = await get(PATH, "tok-am");
    ok("⚠ a real lease with rent and a term moves NO Asset Management door",
       withLease.body.rooms.every((r) => r.establishment === "not_established"),
       JSON.stringify(withLease.body.rooms.map((r) => [r.key, r.establishment])));
    //  WORD-BOUNDED. The first version matched "rent" inside "cur-RENT-ly"
    //  and reported a leak that was not one — a false alarm in a gate is
    //  the same defect class as a miss, one direction over.
    const LEASEISH = /\b(lease|leases|rent|rents|rental|occupancy|occupied)\b/i;
    ok("…and no room mentions leases, rent or occupancy at all",
       !LEASEISH.test(JSON.stringify(withLease.body.rooms)),
       (JSON.stringify(withLease.body.rooms).match(LEASEISH) || [])[0]);

    console.log("\n── 4. NO FABRICATED ECONOMICS ────────────────────────");
    //  The assertion this slice exists for.
    const whole = JSON.stringify(withLease.body);
    ok("the ENTIRE response contains no currency-shaped token",
       !CURRENCYISH.test(whole),
       CURRENCYISH.test(whole) ? "matched: " + (whole.match(CURRENCYISH) || [])[0] : "");

    //  Even though the database now holds 1850.00, the door must not
    //  surface it. This proves the absence is by construction, not by
    //  there being nothing to leak.
    ok("the lease's real rent (1850.00) is present in the DB but ABSENT from the response",
       !/1850/.test(whole));

    ok("no room exposes an amount field of any kind",
       withLease.body.rooms.every((r) =>
         !("amount" in r) && !("amount_cents" in r) && !("total" in r) && !("currency" in r)));

    console.log("\n── 5. FAILURE IS NOT AN EMPTY RESULT ─────────────────");
    await scopedPool.end();  // break the door's database
    const broken = await get(PATH, "tok-am");
    ok("a failed read returns 503, never 200-with-no-rooms",
       broken.status === 503, `got ${broken.status}`);
    ok("…and does not return a rooms array the surface could render as empty",
       !(broken.body && Array.isArray(broken.body.rooms)));

  } finally {
    if (server) await new Promise((r) => server.close(r));
    try { await pool.query(`drop schema ${schema} cascade`); } catch (_) {}
    await pool.end();
  }

  console.log("\n════════════════════════════════════════════════════════");
  console.log(`  ${pass + fail} assertions · ${pass} passed · ${fail} failed`);
  console.log("════════════════════════════════════════════════════════");
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
