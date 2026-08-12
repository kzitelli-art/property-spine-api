/* ════════════════════════════════════════════════════════════════════
   insurance_establishment.db.js — THE HUMAN ESTABLISHMENT PATH, PROVEN
   AGAINST REAL POSTGRES AND REAL AUTHENTICATED HTTP.

   THE ACCEPTANCE CASE is a sentence: an operator with no established
   insurance uploads the policy, confirms what it says, and the existing
   Insurance compartment populates from governed truth — with anything
   the document did not establish visibly missing rather than invented.

   ── THE ASSERTION THAT MATTERS MOST ─────────────────────────────────
   The SHARED POLICY. A master policy names this property on its schedule
   of locations but states no share for it. Before migration 162 that was
   unrepresentable: readPosition is allocation-gated, so a property with
   real recorded coverage and no allocation rendered EXACTLY like a
   property with no insurance at all. Honest partial work was
   indistinguishable from no work, which is §5 failing in the direction
   nobody checks.

   So this file asserts BOTH halves of that state at once:
       coverage established        AND
       allocation honestly missing
   and it asserts that no number was invented to bridge them.

   Harness isolation: HARNESS_DATABASE_URL, required, with the standard
   refusal when it resolves to DATABASE_URL's target. Scoped schema,
   because the full chain cannot rebuild from empty (012_bank_intake /
   yardi_code) — same pattern as insurance_truth.db.js.

     HARNESS_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres \
       node tests/insurance_establishment.db.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const receipt = require("./_run_receipt.js");
const URL_ = receipt.harnessConnectionString();

//  EVERY assertion is counted, and a short run is a FAILED run. A harness
//  that dies halfway prints a clean-looking tail otherwise — this repo has
//  already paid for one that ran zero assertions for 204 commits.
const EXPECTED_ASSERTIONS = 62;
let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? "\n          " + detail : "")); }
}

const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from("binder body\n")]);
const XLSX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(32, 7)]);
const USD = (d) => Math.round(d * 100);

function scopedMigration(file, drops = []) {
  let m = fs.readFileSync(path.join(__dirname, "..", "migrations", file), "utf8");
  m = m.replace(/^begin;\s*/m, "").replace(/commit;\s*$/m, "");
  for (const d of drops) m = m.replace(d, "");
  return m;
}

async function main() {
  const pool = new Pool({ connectionString: URL_ });
  const schema = "ins_estab_" + Date.now();
  let server, port, c, scoped;

  try {
    await pool.query(`create schema ${schema}`);
    c = await pool.connect();
    await c.query(`set search_path to ${schema}`);

    await c.query(`
      create extension if not exists pgcrypto;
      create table users (id uuid primary key default gen_random_uuid(), name text);
      create table properties (id uuid primary key default gen_random_uuid(), name text);
      create table deal_intakes (id uuid primary key default gen_random_uuid());
      create table deal_intake_properties (
        id uuid primary key default gen_random_uuid(),
        intake_id uuid references deal_intakes(id),
        property_id uuid references properties(id),
        status text not null default 'current');
      create table leases (id uuid primary key default gen_random_uuid(),
        property_id uuid references properties(id),
        monthly_rent numeric, start_date date);
      create table source_artifacts (
        id uuid primary key default gen_random_uuid(),
        scope_type text not null,
        scope_id uuid not null,
        original_filename text not null,
        mime_type text,
        artifact_kind text not null default 'other',
        byte_size bigint,
        sha256 text,
        content bytea,
        stored_at timestamptz default now(),
        uploaded_at timestamptz not null default now(),
        source_as_of_date date,
        uploaded_by_user_id uuid references users(id),
        uploaded_by_basis text);
    `);
    await c.query(scopedMigration("161_insurance_economic_truth.sql",
      [/alter table source_artifacts[\s\S]*?;\s*$/m]));
    await c.query(scopedMigration("162_insurance_coverage_participation.sql"));

    const uid = (await c.query(`insert into users (name) values ('Asset Ops') returning id`)).rows[0].id;
    const skyline = (await c.query(`insert into properties (name) values ('Skyline') returning id`)).rows[0].id;
    const other = (await c.query(`insert into properties (name) values ('Other Property') returning id`)).rows[0].id;
    const intake = (await c.query(`insert into deal_intakes default values returning id`)).rows[0].id;
    await c.query(`insert into deal_intake_properties (intake_id, property_id) values ($1,$2)`,
                  [intake, skyline]);

    // ── REAL HTTP, REAL ROUTER ─────────────────────────────────────────
    //  Only the session RESOLVER is stubbed — the one seam that would
    //  otherwise require the whole staff-identity chain in a scoped schema.
    //  Everything the slice is about (authority checks, the writers, the
    //  transaction, the reads) is the real shipped code.
    const SESSIONS = {
      entitled:   { id: uid, property_id: skyline, allowed_modules: ["asset_management", "leasing"] },
      unentitled: { id: uid, property_id: skyline, allowed_modules: ["leasing"] },
    };
    const resolverPath = require.resolve("../src/identity/staff_session_service.js");
    require.cache[resolverPath] = { id: resolverPath, filename: resolverPath, loaded: true,
      exports: { resolveStaffSession: async (_p, t) => SESSIONS[t] || null } };

    const express = require("express");
    const app = express();
    app.use(express.json());
    scoped = new Pool({ connectionString: URL_ });
    scoped.on("connect", (cl) => cl.query(`set search_path to ${schema}`));
    app.use("/", require("../src/surfaces/asset_management.js")({ pool: scoped }));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    port = server.address().port;

    function request({ method, path: p, token, json, multipart }) {
      return new Promise((resolve) => {
        const headers = {};
        if (token) headers["x-staff-session"] = token;
        let payload = null;
        if (json) {
          payload = Buffer.from(JSON.stringify(json));
          headers["content-type"] = "application/json";
        } else if (multipart) {
          const B = "----spineproof" + Date.now();
          const parts = [];
          if (multipart.file) {
            parts.push(Buffer.from(
              `--${B}\r\nContent-Disposition: form-data; name="file"; filename="${multipart.file.name}"\r\n` +
              `Content-Type: ${multipart.file.type}\r\n\r\n`));
            parts.push(multipart.file.bytes);
            parts.push(Buffer.from("\r\n"));
          }
          for (const [k, v] of Object.entries(multipart.fields || {})) {
            parts.push(Buffer.from(
              `--${B}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
          }
          parts.push(Buffer.from(`--${B}--\r\n`));
          payload = Buffer.concat(parts);
          headers["content-type"] = `multipart/form-data; boundary=${B}`;
        }
        if (payload) headers["content-length"] = payload.length;
        const req = http.request({ host: "127.0.0.1", port, path: p, method, headers }, (res) => {
          let b = ""; res.on("data", (d) => b += d);
          res.on("end", () => {
            let j = null; try { j = JSON.parse(b); } catch (_) {}
            resolve({ status: res.statusCode, body: j, raw: b });
          });
        });
        if (payload) req.write(payload);
        req.end();
      });
    }
    const post = (p, opts) => request({ method: "POST", path: p, ...opts });
    const get = (p, token = "entitled") => request({ method: "GET", path: p, token });

    const EVIDENCE = "/operator/asset-management/insurance/evidence";
    const ESTABLISH = "/operator/asset-management/insurance/establish";
    const DASHBOARD = "/operator/asset-management/insurance";

    console.log("\n── 1. THE STARTING STATE IS HONESTLY EMPTY ───────────");

    let d = await get(DASHBOARD + "?period=2026-06");
    ok("the compartment reads 200 before anything is established", d.status === 200);
    ok("establishment reads not_established", d.body.establishment === "not_established",
       JSON.stringify(d.body.establishment));
    ok("participates is false", d.body.participates === false);
    const cell = (b, k) => (b.position || []).find((x) => x.key === k);
    ok("COVERAGE is blank, not zero", cell(d.body, "coverage").value === null,
       JSON.stringify(cell(d.body, "coverage")));
    ok("ANNUAL COST is blank, not zero", cell(d.body, "annual_cost").value === null);

    console.log("\n── 2. AUTHORITY, BEFORE ANY WRITE ────────────────────");

    let r = await post(ESTABLISH, { json: { coverages: [{}] } });
    ok("no session is refused 401", r.status === 401, JSON.stringify(r.body));

    r = await post(ESTABLISH, { token: "unentitled", json: { coverages: [{}] } });
    ok("a signed-in operator WITHOUT the module is refused 403",
       r.status === 403, JSON.stringify(r.body));
    ok("...and is told it is the module, not the job title", r.status === 403 &&
       /allowed_modules|module/i.test(r.body.error || ""), JSON.stringify(r.body));

    //  §21 and the rule frozen in PR #38: REFUSED, not ignored.
    r = await post(ESTABLISH, { token: "entitled",
      json: { property_id: other, program: {}, coverages: [{}] } });
    ok("a body property_id for ANOTHER property is REFUSED, not ignored",
       r.status === 403, JSON.stringify(r.body));
    ok("...and the refusal names the property actually being acted on",
       r.status === 403 && String(r.body.acting_on) === String(skyline), JSON.stringify(r.body));

    //  The multipart route judges authority AFTER multer, because req.body
    //  does not exist before it. If the ordinary gate order had been used
    //  the claimed property would read undefined and pass.
    r = await post(EVIDENCE, { token: "entitled",
      multipart: { file: { name: "b.pdf", type: "application/pdf", bytes: PDF },
                   fields: { property_id: other, artifact_kind: "insurance_binder" } } });
    ok("a body property_id on the MULTIPART route is refused too",
       r.status === 403, JSON.stringify(r.body));

    console.log("\n── 3. EVIDENCE: A BINDER IS A PDF ────────────────────");

    r = await post(EVIDENCE, { token: "entitled",
      multipart: { file: { name: "roll.xlsx", type: "application/vnd.ms-excel", bytes: XLSX },
                   fields: { artifact_kind: "insurance_binder" } } });
    ok("a spreadsheet is refused as an insurance binder", r.status === 422, JSON.stringify(r.body));
    ok("...with insurance copy, not rent-roll copy",
       r.status === 422 && /binder as a PDF/i.test(r.body.receipt || "") &&
       !/rent roll/i.test(r.body.receipt || ""), JSON.stringify(r.body));

    r = await post(EVIDENCE, { token: "entitled",
      multipart: { file: { name: "2026 binder.pdf", type: "application/pdf", bytes: PDF },
                   fields: { artifact_kind: "insurance_binder" } } });
    ok("the binder PDF is accepted and retained", r.status === 201, JSON.stringify(r.body));
    const artifactId = r.body && r.body.artifact && r.body.artifact.id;
    ok("an artifact id comes back", !!artifactId);
    ok("Spine says plainly it has NOT read the document",
       r.body.proposal && r.body.proposal.available === false &&
       /has not read/i.test(r.body.proposal.reason || ""), JSON.stringify(r.body.proposal));

    const stored = (await c.query(
      `select scope_type, scope_id, artifact_kind from source_artifacts where id = $1`,
      [artifactId])).rows[0];
    ok("the artifact is scoped to the SERVER-DERIVED property",
       stored && String(stored.scope_id) === String(skyline) && stored.scope_type === "property",
       JSON.stringify(stored));

    console.log("\n── 4. REFUSALS THE SERVICES OWN, REACHING THE OPERATOR ");

    const COV = {
      coverage_type: "property", carrier_name: "Ally",
      coverage_period_start: "2026-03-01", coverage_period_end: "2027-03-01",
      premium_cents: USD(1000000),
    };

    r = await post(ESTABLISH, { token: "entitled", json: { artifact_id: artifactId,
      program: { program_name: "2026 Property", term_start: "2026-03-01", term_end: "2027-03-01" },
      coverages: [COV] } });
    ok("establishing with NO CURRENCY is refused by name",
       r.status === 422 && r.body.error === "CURRENCY_NOT_ESTABLISHED", JSON.stringify(r.body));
    ok("...and the refusal is sayable to a human",
       /currency/i.test(r.body.receipt || "") && /will not assume/i.test(r.body.receipt || ""),
       JSON.stringify(r.body.receipt));

    r = await post(ESTABLISH, { token: "entitled", json: { artifact_id: artifactId,
      program: { program_name: "P", term_start: "2026-03-01", term_end: "2027-03-01",
                 currency_code: "USD" },
      coverages: [{ ...COV, allocation: { allocated_amount_cents: USD(400000),
        allocation_class: "stated", allocation_basis: "tiv_prorata",
        effective_from: "2026-03-01", provenance_note: "n" } }] } });
    ok("a COMPUTED basis recorded as `stated` is refused",
       r.status === 422 && r.body.error === "STATED_NEEDS_EXTERNAL_BASIS", JSON.stringify(r.body));

    r = await post(ESTABLISH, { token: "entitled", json: { artifact_id: artifactId,
      program: { program_name: "P", term_start: "2026-03-01", term_end: "2027-03-01",
                 currency_code: "USD" },
      coverages: [{ ...COV, allocation: { allocated_amount_cents: USD(9999999),
        allocation_class: "stated", allocation_basis: "broker_stated",
        effective_from: "2026-03-01", provenance_note: "n" } }] } });
    ok("allocating MORE than the coverage costs is refused",
       r.status === 422 && r.body.error === "OVER_ALLOCATED", JSON.stringify(r.body));

    const leaked = (await c.query(`select count(*)::int n from insurance_programs`)).rows[0].n;
    ok("NOTHING was written by any refused establish — the transaction rolled back",
       leaked === 0, `insurance_programs rows = ${leaked}`);

    console.log("\n── 5. THE SHARED POLICY — THE STATE THAT DID NOT EXIST ");

    //  A master policy names this property. It does NOT state its share.
    r = await post(ESTABLISH, { token: "entitled", json: { artifact_id: artifactId,
      period: "2026-06",
      program: { program_name: "2026 Portfolio Property", term_start: "2026-03-01",
                 term_end: "2027-03-01", currency_code: "USD" },
      coverages: [{ ...COV, observed_as_of: "2026-03-01",
        identifiers: [{ identifier_value: "01-CPK-104720-02", issued_by: "carrier" }] }] } });
    ok("coverage with NO stated share is ACCEPTED, not refused", r.status === 201,
       JSON.stringify(r.body));
    ok("the receipt says the share is still needed",
       /still need/i.test(r.body.receipt || ""), JSON.stringify(r.body.receipt));
    ok("...and promises Spine will not estimate it",
       /will not estimate/i.test(r.body.receipt || ""), JSON.stringify(r.body.receipt));
    ok("the write reports the share as NOT established",
       r.body.established[0].share_established === false, JSON.stringify(r.body.established));
    ok("participation is true while the position is not",
       r.body.participates === true && r.body.position_established === false,
       JSON.stringify({ p: r.body.participates, pos: r.body.position_established }));

    //  ── BOTH HALVES, ON THE DASHBOARD, AT ONCE ─────────────────────
    d = await get(DASHBOARD + "?period=2026-06");
    const sec = (k) => (d.body.sections || []).find((s) => s.key === k);

    ok("the compartment is no longer not_established",
       d.body.establishment === "partially_established", JSON.stringify(d.body.establishment));
    ok("COVERAGE STACK reports the coverage as ESTABLISHED",
       sec("coverage_stack").establishment === "established",
       JSON.stringify(sec("coverage_stack").establishment));
    ok("...and shows the real carrier from the document",
       (sec("coverage_stack").rows[0] || {}).carrier === "Ally",
       JSON.stringify(sec("coverage_stack").rows[0]));
    ok("...and marks that row's share as not established",
       sec("coverage_stack").rows[0].share_established === false);

    ok("ECONOMIC POSITION stays not_established — no share, no economics",
       sec("economic_position").establishment === "not_established",
       JSON.stringify(sec("economic_position").establishment));
    ok("ANNUAL COST is still BLANK — never zero, never the whole policy's total",
       cell(d.body, "annual_cost").value === null, JSON.stringify(cell(d.body, "annual_cost")));
    ok("MONTHLY ACCRUAL is still blank", cell(d.body, "monthly_accrual").value === null);
    ok("COVERAGE counts the policy the property is named on",
       cell(d.body, "coverage").value === "1 active", JSON.stringify(cell(d.body, "coverage")));
    ok("NEXT RENEWAL is reported even with no share established",
       cell(d.body, "next_renewal").value === "2027-03-01",
       JSON.stringify(cell(d.body, "next_renewal")));

    //  The missing share is NAMED where the economics are read.
    const aw = sec("economic_position").awaiting_allocation;
    ok("the missing share is surfaced as an item, not a silence",
       Array.isArray(aw) && aw.length === 1, JSON.stringify(aw));
    ok("...it says what it is about", aw[0].label === "Property");
    ok("...it says why Spine cannot stand behind it",
       /has not been established/i.test(aw[0].why || ""), JSON.stringify(aw[0].why));
    ok("...it says what would resolve it", /share/i.test(aw[0].resolved_by || ""),
       JSON.stringify(aw[0].resolved_by));
    ok("...and its magnitude is UNKNOWN rather than a fabricated number",
       aw[0].property_share === null, JSON.stringify(aw[0].property_share));

    //  The whole-policy total must never leak into a property figure.
    const asText = JSON.stringify(d.body);
    ok("the whole policy's $10,000,000 total appears nowhere as this property's cost",
       !/10,000,000|1000000000/.test(asText.replace(/"coverage_total_cents":\d+/g, "")),
       "a policy-level total reached a property-level field");

    console.log("\n── 6. THE SAME DOCUMENT CANNOT ESTABLISH TWICE ───────");

    r = await post(ESTABLISH, { token: "entitled", json: { artifact_id: artifactId,
      program: { program_name: "2026 Portfolio Property", term_start: "2026-03-01",
                 term_end: "2027-03-01", currency_code: "USD" },
      coverages: [COV] } });
    ok("re-establishing from the SAME artifact is refused 409", r.status === 409,
       JSON.stringify(r.body));
    const progCount = (await c.query(`select count(*)::int n from insurance_programs`)).rows[0].n;
    ok("...so a double-click cannot double the property's annual cost",
       progCount === 1, `insurance_programs rows = ${progCount}`);

    console.log("\n── 7. EVIDENCE FROM ANOTHER PROPERTY IS NOT USABLE ───");

    const foreign = (await c.query(
      `insert into source_artifacts (scope_type, scope_id, original_filename, artifact_kind,
         uploaded_by_user_id)
       values ('property',$1,'someone elses binder.pdf','insurance_binder',$2) returning id`,
      [other, uid])).rows[0].id;
    r = await post(ESTABLISH, { token: "entitled", json: { artifact_id: foreign,
      program: { program_name: "X", term_start: "2026-03-01", term_end: "2027-03-01",
                 currency_code: "USD" },
      coverages: [COV] } });
    ok("citing ANOTHER property's document is refused 403", r.status === 403,
       JSON.stringify(r.body));
    ok("...authentication answered WHO, not WHOSE evidence",
       /different property/i.test(r.body.receipt || ""), JSON.stringify(r.body.receipt));

    console.log("\n── 8. ESTABLISHING WITH A STATED SHARE ───────────────");

    const r2 = await post(EVIDENCE, { token: "entitled",
      multipart: { file: { name: "gl policy.pdf", type: "application/pdf",
                           bytes: Buffer.concat([PDF, Buffer.from("GL")]) },
                   fields: { artifact_kind: "insurance_policy" } } });
    const artifact2 = r2.body.artifact.id;

    r = await post(ESTABLISH, { token: "entitled", json: { artifact_id: artifact2,
      period: "2026-06",
      program: { program_name: "2026 GL", term_start: "2026-03-01", term_end: "2027-03-01",
                 currency_code: "USD" },
      coverages: [{ coverage_type: "general_liability", carrier_name: "Ally",
        coverage_period_start: "2026-03-01", coverage_period_end: "2027-03-01",
        premium_cents: USD(120000), observed_as_of: "2026-03-01",
        allocation: { allocated_amount_cents: USD(24000), allocation_class: "stated",
          allocation_basis: "broker_stated", effective_from: "2026-03-01" } }] } });
    ok("a coverage WITH a broker-stated share is established", r.status === 201,
       JSON.stringify(r.body));
    ok("the write reports that share as established",
       r.body.established[0].share_established === true);

    d = await get(DASHBOARD + "?period=2026-06");
    ok("ECONOMIC POSITION now reports partially_established — one share known, one not",
       sec("economic_position").establishment === "partially_established",
       JSON.stringify(sec("economic_position").establishment));
    ok("ANNUAL COST is now a real number from the STATED share",
       /24,000\.00/.test(String(cell(d.body, "annual_cost").value || "")),
       JSON.stringify(cell(d.body, "annual_cost")));
    ok("MONTHLY ACCRUAL divides by the coverage term",
       /2,000\.00/.test(String(cell(d.body, "monthly_accrual").value || "")),
       JSON.stringify(cell(d.body, "monthly_accrual")));
    ok("COVERAGE now counts both policies",
       cell(d.body, "coverage").value === "2 active", JSON.stringify(cell(d.body, "coverage")));
    ok("the still-unallocated property policy remains listed as awaiting",
       sec("economic_position").awaiting_allocation.length === 1,
       JSON.stringify(sec("economic_position").awaiting_allocation));

    console.log("\n── 9. THE WALL HOLDS ─────────────────────────────────");

    ok("CASH & FINANCING still reads NOT ESTABLISHED after a successful establishment",
       sec("cash_financing").establishment === "not_established",
       JSON.stringify(sec("cash_financing").establishment));
    ok("PAYMENT is still blank in the position strip",
       cell(d.body, "payment").value === null, JSON.stringify(cell(d.body, "payment")));
    ok("the establish response never claims cash is established",
       r.body.cash_established === false, JSON.stringify(r.body.cash_established));

    console.log("\n── 10. IT WROTE THROUGH THE CANONICAL WRITERS ────────");

    const partRows = (await c.query(
      `select p.*, a.original_filename
         from insurance_coverage_properties p
         left join source_artifacts a on a.id = p.observed_in_artifact_id
        where p.property_id = $1 order by p.recorded_at`, [skyline])).rows;
    ok("a participation row exists per established coverage", partRows.length === 2,
       `got ${partRows.length}`);
    ok("participation is attributed to the authenticated operator",
       partRows.every((x) => String(x.recorded_by_user_id) === String(uid)));
    ok("participation points at the document it was observed in",
       partRows.every((x) => !!x.observed_in_artifact_id), JSON.stringify(partRows.map(x=>x.original_filename)));

    const alloc = (await c.query(
      `select count(*)::int n from insurance_property_allocations where property_id=$1`,
      [skyline])).rows[0].n;
    ok("exactly ONE allocation exists — the one the document stated", alloc === 1, `got ${alloc}`);

    const idf = (await c.query(
      `select identifier_value from insurance_coverage_identifiers`)).rows;
    ok("the policy number was retained verbatim, unnormalised",
       idf.some((x) => x.identifier_value === "01-CPK-104720-02"), JSON.stringify(idf));

    const memb = (await c.query(
      `select deal_membership_id from insurance_property_allocations where property_id=$1`,
      [skyline])).rows[0];
    ok("the allocation stamped Deal membership at origin", !!memb.deal_membership_id);

  } finally {
    //  RELEASE BEFORE end(), or pool.end() waits on the checked-out client
    //  forever and the run reads like a hung query rather than a hung test.
    if (c) c.release();
    if (server) await new Promise((r) => server.close(r));
    if (scoped) await scoped.end();
    try { await pool.query(`drop schema ${schema} cascade`); } catch (_) {}
    await pool.end();
  }

  const total = pass + fail;
  console.log("\n════════════════════════════════════════════════════════");
  console.log(`  ${total} assertions · ${pass} passed · ${fail} failed`);
  if (total < EXPECTED_ASSERTIONS) {
    console.log(`  ✗ RUN INVALID — expected ${EXPECTED_ASSERTIONS}, ran ${total}.`);
    console.log("    A short run is a failed run: the harness stopped early.");
    console.log("════════════════════════════════════════════════════════");
    process.exit(1);
  }
  console.log("════════════════════════════════════════════════════════");
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("\nHARNESS DIED:", e); process.exit(1); });
