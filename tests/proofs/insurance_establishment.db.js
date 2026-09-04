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
       node tests/proofs/insurance_establishment.db.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const receipt = require("../_run_receipt.js");
const URL_ = receipt.harnessConnectionString();

//  EVERY assertion is counted, and a short run is a FAILED run. A harness
//  that dies halfway prints a clean-looking tail otherwise — this repo has
//  already paid for one that ran zero assertions for 204 commits.
const EXPECTED_ASSERTIONS = 141;
let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? "\n          " + detail : "")); }
}

const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from("binder body\n")]);
const XLSX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(32, 7)]);
const USD = (d) => Math.round(d * 100);

function scopedMigration(file, drops = []) {
  let m = fs.readFileSync(path.join(__dirname, "..", "..", "migrations", file), "utf8");
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
    //  163 is the FUNDING side. Applied here so the accrual can be proven
    //  unmoved BY funding rather than merely unmoved while funding is absent.
    await c.query(scopedMigration("163_insurance_funding.sql",
      [/alter table source_artifacts drop constraint[\s\S]*$/m]));

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
    const resolverPath = require.resolve("../../src/identity/staff_session_service.js");
    require.cache[resolverPath] = { id: resolverPath, filename: resolverPath, loaded: true,
      exports: { resolveStaffSession: async (_p, t) => SESSIONS[t] || null } };

    const express = require("express");
    const app = express();
    app.use(express.json());
    scoped = new Pool({ connectionString: URL_ });
    scoped.on("connect", (cl) => cl.query(`set search_path to ${schema}`));
    app.use("/", require("../../src/surfaces/asset_management.js")({ pool: scoped, //  The shell now REQUIRES fileToText at construction (compliance_http). Nothing
      //  here uploads a compliance document, so a stand-in that refuses is honest.
      fileToText: async () => { throw new Error("fileToText is not exercised by this harness"); } }));
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
       //  The shell now requires a fileToText at construction (compliance_http),
       //  so "no reader at all" is no longer a mountable state; the reachable
       //  honest degradation is "kept the document but could not read it".
       /has not read|could not read/i.test(r.body.proposal.reason || ""), JSON.stringify(r.body.proposal));

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

    console.log("\n── 11. THE READER PROPOSES; IT NEVER WRITES ──────────");

    /*  ── WHAT IS PROVEN HERE, AND WHAT IS NOT ────────────────────────
     *  propose() is a pure function and is proven directly, which gives
     *  far better coverage of its judgement than one sample document
     *  would. What is NOT re-proven here is PDF bytes → text: that is
     *  server.js's existing `fileToText`, already carrying the rent-roll
     *  path in production, and it is injected rather than reimplemented.
     *  Say it that way rather than implying the whole chain was exercised.
     */
    const reader = require("../../src/asset/insurance_document_read.js");

    const POLICY_TEXT = [
      "COMMERCIAL PROPERTY POLICY",
      "Carrier: Ally Insurance Company",
      "Broker: USI Insurance Services",
      "Policy Number: 01-CPK-104720-02",
      "Effective Date: 2026-03-01",
      "Expiration Date: 2027-03-01",
      "Total Premium: $100,000.00",
      "Broker Fee: $1,500.00",
      "Schedule of locations attached.",
    ].join("\n");

    const read = reader.propose(POLICY_TEXT);
    ok("a labelled policy yields proposals", read.available && read.found_count > 0,
       JSON.stringify(read.fields));
    ok("the carrier is read from its label", read.fields.carrier_name === "Ally Insurance Company",
       JSON.stringify(read.fields.carrier_name));
    ok("the policy number is read VERBATIM, not normalised",
       read.fields.policy_number === "01-CPK-104720-02", JSON.stringify(read.fields.policy_number));
    ok("dates are read as ISO", read.fields.coverage_period_start === "2026-03-01"
       && read.fields.coverage_period_end === "2027-03-01", JSON.stringify(read.fields));
    ok("the premium is read as a decimal string, not cents",
       read.fields.premium === "100000.00", JSON.stringify(read.fields.premium));

    //  ── THE REFUSALS THAT MATTER MORE THAN THE READS ────────────────
    ok("NO SHARE is ever proposed, even from a document that states one",
       reader.propose(POLICY_TEXT + "\nProperty Allocation: $40,000.00").fields.share === undefined);
    ok("no currency is proposed — the service refuses a missing one by name " +
       "and a scan must not defeat that",
       read.fields.currency_code === undefined);

    ok("an AMBIGUOUS numeric date is refused rather than guessed",
       reader.propose("Effective Date: 03/04/2026").fields.coverage_period_start === undefined,
       "03/04/2026 is 3 April or 4 March depending on the reader");
    ok("…while a written month is unambiguous and is accepted",
       reader.propose("Effective Date: March 1, 2026").fields.coverage_period_start === "2026-03-01");

    ok("a bare integer beside the word premium is NOT read as money",
       reader.propose("Premium 4").fields.premium === undefined);
    ok("a label with no value proposes nothing",
       reader.propose("Carrier:").fields.carrier_name === undefined);
    ok("the word appearing in a sentence is not a labelled field",
       reader.propose("The carrier will invoice the premium annually.").found_count === 0,
       JSON.stringify(reader.propose("The carrier will invoice the premium annually.").fields));

    const empty = reader.propose("");
    ok("an unreadable document proposes nothing and says so",
       empty.available === true && empty.found_count === 0 && empty.unknown.length > 0);
    ok("every unproposed field is NAMED as unknown, not silently absent",
       read.unknown.includes("program_name"), JSON.stringify(read.unknown));

    //  ── THE ROUTE, WITH A READER PRESENT ────────────────────────────
    //  A second mount, because the first was built without a reader on
    //  purpose — that is the honest-degradation case section 3 asserts.
    const app2 = express();
    app2.use(express.json());
    app2.use("/", require("../../src/surfaces/asset_management.js")({
      pool: scoped,
      //  Stands in for server.js's fileToText at its real injection point.
      //  Bytes → text is that function's job and is not re-proven here.
      fileToText: async () => POLICY_TEXT,
    }));
    const server2 = http.createServer(app2);
    await new Promise((r) => server2.listen(0, "127.0.0.1", r));
    const port2 = server2.address().port;
    try {
      const up = await new Promise((resolve) => {
        const B = "----spineproof2";
        const body = Buffer.concat([
          Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="file"; ` +
                      `filename="scanned.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
          Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from("x")]),
          Buffer.from(`\r\n--${B}\r\nContent-Disposition: form-data; name="artifact_kind"\r\n\r\n` +
                      `insurance_policy\r\n--${B}--\r\n`),
        ]);
        const rq = http.request({ host: "127.0.0.1", port: port2,
          path: "/operator/asset-management/insurance/evidence", method: "POST",
          headers: { "x-staff-session": "entitled",
                     "content-type": `multipart/form-data; boundary=${B}`,
                     "content-length": body.length } }, (res) => {
          let b = ""; res.on("data", (d) => b += d);
          res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch (_) {}
            resolve({ status: res.statusCode, body: j }); });
        });
        rq.write(body); rq.end();
      });
      ok("the evidence route returns proposals when a reader is present",
         up.status === 201 && up.body.proposal && up.body.proposal.available === true,
         JSON.stringify(up.body && up.body.proposal));
      ok("…and they are labelled as suggestions, not facts",
         /suggestions, not facts/i.test((up.body.proposal || {}).reason || ""),
         JSON.stringify((up.body.proposal || {}).reason));
      ok("…and the share is still not among them",
         up.body.proposal.fields && up.body.proposal.fields.share === undefined);

      //  THE POINT OF THE WHOLE ADAPTER: reading changed nothing durable.
      const progsAfter = Number((await c.query(
        `select count(*)::int n from insurance_programs`)).rows[0].n);
      ok("reading a document wrote NOTHING — the count is unchanged by the scan",
         progsAfter === 2, `insurance_programs rows = ${progsAfter}`);
    } finally {
      await new Promise((r) => server2.close(r));
    }

    console.log("\n── 12. GOOD STANDING IS DERIVED, NEVER STORED ────────");

    const standing = require("../../src/asset/insurance_standing.js");
    //  One in-force property policy, 2026-03-01 → 2027-03-01, evidenced.
    const TERM = [{ coverage_id: "c1", coverage_type: "property", carrier_name: "Ally",
                    coverage_period_start: "2026-03-01", coverage_period_end: "2027-03-01",
                    observed_in_artifact_id: "a1" }];
    const at = (d, cov) => standing.standingOf({ coverages: cov || TERM, asOf: d });

    //  ── THE DETERMINISTIC PROGRESSION ────────────────────────────────
    ok("well outside the window reads CURRENT", at("2026-06-01").state === "current",
       JSON.stringify(at("2026-06-01").state));
    ok("…and names no milestone", at("2026-06-01").milestone === null);

    ok("91 days out is still CURRENT — the window has not opened",
       at("2026-11-30").state === "current", `days=${at("2026-11-30").days_to_expiry}`);
    ok("90 days out enters RENEWAL APPROACHING",
       at("2026-12-01").state === "renewal_approaching" && at("2026-12-01").milestone === 90,
       JSON.stringify(at("2026-12-01")));
    ok("60 days out reports the 60 milestone", at("2027-01-01").milestone === 60,
       `days=${at("2027-01-01").days_to_expiry}`);
    ok("45 days out reports the 45 milestone", at("2027-01-15").milestone === 45,
       `days=${at("2027-01-15").days_to_expiry}`);
    ok("30 days out reports the 30 milestone", at("2027-01-30").milestone === 30,
       `days=${at("2027-01-30").days_to_expiry}`);
    ok("the TIGHTEST band wins — 44 days is inside 45, not 60",
       standing.milestoneFor(44) === 45);

    //  ── NEVER HEALTHY FROM ABSENCE. THE POINT OF THE WHOLE SLICE. ────
    ok("the day after expiry is EXPIRED, not current",
       at("2027-03-02").state === "expired", JSON.stringify(at("2027-03-02").state));
    ok("…and it says no bound term exists after it",
       at("2027-03-02").bound_next_term === null && /no bound term/i.test(at("2027-03-02").why),
       JSON.stringify(at("2027-03-02").why));
    ok("no coverage at all is COVERAGE NOT CONFIRMED, never CURRENT",
       standing.standingOf({ coverages: [], asOf: "2026-06-01" }).state === "coverage_not_confirmed");
    ok("…and it never reads as a healthy blank",
       standing.standingOf({ coverages: [] }).state !== "current");

    //  ── A BOUND NEXT TERM RESTORES CONFIRMED COVERAGE ────────────────
    //  And note what a bound term IS: another coverage, established the
    //  ordinary way. There is no "renewed" flag to set.
    const RENEWED = TERM.concat([{ coverage_id: "c2", coverage_type: "property",
      carrier_name: "Ally", coverage_period_start: "2027-03-01",
      coverage_period_end: "2028-03-01", observed_in_artifact_id: "a2" }]);
    ok("inside the window WITH a bound successor reads CURRENT again",
       at("2027-01-30", RENEWED).state === "current", JSON.stringify(at("2027-01-30", RENEWED)));
    ok("…and it names the bound term rather than merely going quiet",
       at("2027-01-30", RENEWED).bound_next_term.starts === "2027-03-01");
    ok("…and reports no milestone, because nothing is approaching",
       at("2027-01-30", RENEWED).milestone === null);

    //  A DIFFERENT coverage type is not a successor. This is the failure
    //  that would let a property read CURRENT while its Property policy
    //  lapses behind a bound GL policy.
    const WRONG_TYPE = TERM.concat([{ coverage_id: "c3", coverage_type: "general_liability",
      carrier_name: "Lantern", coverage_period_start: "2027-03-01",
      coverage_period_end: "2028-03-01", observed_in_artifact_id: "a3" }]);
    ok("a bound GL policy does NOT renew the Property policy",
       at("2027-01-30", WRONG_TYPE).state === "renewal_approaching",
       JSON.stringify(at("2027-01-30", WRONG_TYPE).state));

    //  The soonest expiry governs — not the longest-dated policy.
    const TWO = [
      { coverage_id: "p", coverage_type: "property", coverage_period_start: "2026-03-01",
        coverage_period_end: "2028-03-01", observed_in_artifact_id: "a" },
      { coverage_id: "g", coverage_type: "general_liability", coverage_period_start: "2026-03-01",
        coverage_period_end: "2026-09-01", observed_in_artifact_id: "a" },
    ];
    ok("the SOONEST expiry governs standing, not the longest-dated policy",
       at("2026-08-01", TWO).state === "renewal_approaching"
       && at("2026-08-01", TWO).next_expiry === "2026-09-01", JSON.stringify(at("2026-08-01", TWO)));

    //  ── AND OVER REAL HTTP ───────────────────────────────────────────
    //  The property established a 2026-03-01 → 2027-03-01 property policy
    //  in section 5 and a GL policy in section 8, neither with a successor.
    const s1 = await get(DASHBOARD + "?period=2026-06&as_of=2026-06-01");
    ok("the dashboard emits standing", !!s1.body.standing, JSON.stringify(s1.body.standing));
    ok("…reading CURRENT well outside the window",
       s1.body.standing.state === "current", JSON.stringify(s1.body.standing));

    const s2 = await get(DASHBOARD + "?period=2027-01&as_of=2027-01-30");
    ok("…and RENEWAL APPROACHING at 30 days, over real HTTP",
       s2.body.standing.state === "renewal_approaching" && s2.body.standing.milestone === 30,
       JSON.stringify(s2.body.standing));
    ok("…naming what would resolve it",
       /policy or binder/i.test(s2.body.standing.resolved_by || ""),
       JSON.stringify(s2.body.standing.resolved_by));
    ok("…and refusing to accept a quote as coverage",
       /quote/i.test(s2.body.standing.resolved_by || ""),
       JSON.stringify(s2.body.standing.resolved_by));

    //  STANDING IS NOT GATED ON ALLOCATION. The property policy has no
    //  share established and the property is still insured by it.
    ok("standing is independent of whether the share is known",
       s1.body.standing.in_force.length === 2
       && s1.body.awaiting_allocation_count === 1,
       JSON.stringify({ inForce: s1.body.standing.in_force.length,
                        awaiting: s1.body.awaiting_allocation_count }));

    //  as_of may move the clock. It may NOT move the property.
    const spoofDate = await get(DASHBOARD + "?as_of=2027-03-02");
    ok("as_of moves the clock and the state follows it",
       spoofDate.body.standing.state === "expired", JSON.stringify(spoofDate.body.standing.state));
    const spoofProp = await request({ method: "GET",
      path: DASHBOARD + "?property_id=" + other, token: "entitled" });
    ok("a client-supplied property on the standing read is still REFUSED",
       spoofProp.status === 403, JSON.stringify(spoofProp.body));

    console.log("\n── 13. FUNDING CANNOT MOVE WHAT INSURANCE COSTS ──────");

    /*  THE ASSERTION SLICE B EXISTS TO SURVIVE.
     *
     *  The June 2026 Skyline workpaper computed the property's annual
     *  insurance cost FROM the financing stream. Everything below records
     *  funding in every shape it comes in — direct, escrowed, financed
     *  with a down payment and twelve installments and a finance charge —
     *  and asserts the insurance position is BYTE-IDENTICAL before and
     *  after each one.
     *
     *  Not "close". Identical. The accrual reads the coverage and the
     *  allocation; it cannot see a funding table, and the boundary gate
     *  makes that a build failure rather than a promise.
     */
    const FUNDING = "/operator/asset-management/insurance/funding";
    /*  THE COST-BEARING SURFACE, and PAYMENT is deliberately not in it.
     *
     *  PAYMENT names the MECHANISM and is supposed to change when funding
     *  is recorded — that is the cell's whole job. Including it would make
     *  these assertions fail for the one correct reason and would blunt
     *  the claim being made, which is narrower and sharper: funding cannot
     *  move what insurance COSTS.
     *
     *  A separate assertion below proves PAYMENT is the ONLY thing that
     *  moved, so excluding it here concedes nothing. */
    const COST_CELLS = ["coverage", "annual_cost", "monthly_accrual", "next_renewal"];
    const positionOf = async () => {
      const r = await get(DASHBOARD + "?period=2026-06");
      return JSON.stringify({
        cost: r.body.position.filter((p) => COST_CELLS.includes(p.key)),
        economic: (r.body.sections || []).find((x) => x.key === "economic_position").rows,
      });
    };
    const paymentOf = async () => {
      const r = await get(DASHBOARD + "?period=2026-06");
      return (r.body.position.find((p) => p.key === "payment") || {}).value;
    };

    //  The GL coverage from section 8 is the one with a stated share, so
    //  it is the one carrying real economics to disturb.
    const glCovId = (await c.query(
      `select id from insurance_coverages where coverage_type = 'general_liability'`)).rows[0].id;

    const BEFORE = await positionOf();
    ok("cash is unknown while the economics are already valid",
       (await get(DASHBOARD + "?period=2026-06")).body.funding_established === false);

    //  ── REFUSALS FIRST ───────────────────────────────────────────────
    let f = await post(FUNDING, { token: "entitled", json: {
      coverage_id: glCovId, funding_method: "direct", effective_from: "2026-03-01",
      provenance_note: "confirmed with the owner",
      finance: { finance_provider: "AFCO" } } });
    ok("a DIRECT arrangement carrying a finance agreement is refused",
       f.status === 422 && f.body.error === "DIRECT_HAS_NO_INSTRUMENT", JSON.stringify(f.body));

    f = await post(FUNDING, { token: "entitled", json: {
      coverage_id: glCovId, funding_method: "premium_financed", effective_from: "2026-03-01",
      provenance_note: "x", finance: {} } });
    ok("premium financing with no provider is refused by name",
       f.status === 422 && f.body.error === "FINANCE_PROVIDER_REQUIRED", JSON.stringify(f.body));

    f = await post(FUNDING, { token: "entitled", json: {
      coverage_id: glCovId, funding_method: "direct", effective_from: "2026-03-01" } });
    ok("funding with no provenance is refused",
       f.status === 422 && f.body.error === "PROVENANCE_REQUIRED", JSON.stringify(f.body));

    f = await post(FUNDING, { token: "unentitled", json: { coverage_id: glCovId } });
    ok("an operator without the module cannot record funding", f.status === 403);
    f = await post(FUNDING, { token: "entitled", json: {
      property_id: other, coverage_id: glCovId, funding_method: "direct",
      effective_from: "2026-03-01", provenance_note: "x" } });
    ok("a body property_id on the funding route is REFUSED, not ignored", f.status === 403,
       JSON.stringify(f.body));

    ok("no refused write moved the insurance position",
       (await positionOf()) === BEFORE);

    //  ── DIRECT ───────────────────────────────────────────────────────
    f = await post(FUNDING, { token: "entitled", json: {
      coverage_id: glCovId, funding_method: "direct", effective_from: "2026-03-01",
      provenance_note: "confirmed with the owner", period: "2026-06" } });
    ok("a DIRECT arrangement is recorded", f.status === 201, JSON.stringify(f.body));
    ok("…and the response says outright that insurance cost did not change",
       f.body.insurance_cost_changed === false);
    ok("…and the receipt says the two are separate facts",
       /separate facts/i.test(f.body.receipt || ""), JSON.stringify(f.body.receipt));
    ok("DIRECT DID NOT MOVE THE INSURANCE POSITION — byte-identical",
       (await positionOf()) === BEFORE);
    //  ONE cell moved, and it is the one that describes funding.
    ok("…and PAYMENT is the ONLY cell that moved, naming the mechanism",
       (await paymentOf()) === "Paid directly", JSON.stringify(await paymentOf()));

    //  ── PREMIUM FINANCED: DOWN PAYMENT, 11 INSTALLMENTS, FINANCE CHARGE
    //  The exact shape the workpaper derived a monthly expense from.
    f = await post(FUNDING, { token: "entitled", json: {
      coverage_id: glCovId, funding_method: "premium_financed",
      effective_from: "2026-04-01", provenance_note: "IPFS agreement on file",
      period: "2026-06",
      finance: { finance_provider: "AFCO Credit", agreement_reference: "AF-2026-118",
                 down_payment_cents: USD(23100), principal_financed_cents: USD(96000),
                 finance_charge_cents: USD(7400), installment_count: 11,
                 installment_cents: USD(9400), first_payment_date: "2026-05-01" } } });
    ok("a PREMIUM FINANCED arrangement is recorded", f.status === 201, JSON.stringify(f.body));
    ok("PREMIUM FINANCING DID NOT MOVE THE INSURANCE POSITION — byte-identical",
       (await positionOf()) === BEFORE);

    const withFin = await get(DASHBOARD + "?period=2026-06");
    const cashSec = (withFin.body.sections || []).find((x) => x.key === "cash_financing");
    ok("Cash & Financing now reads established", cashSec.establishment === "established",
       JSON.stringify(cashSec.establishment));
    const finRow = cashSec.rows.find((r) => r.method === "premium_financed");
    ok("…and renders the financing distinctly from the other methods",
       !!finRow && finRow.method_label === "Premium financed", JSON.stringify(finRow && finRow.method_label));
    ok("…naming the provider", finRow.finance.provider === "AFCO Credit");
    ok("…and the total of payments, as a FINANCING figure",
       /126,500\.00/.test(String(finRow.finance.total_of_payments)),
       JSON.stringify(finRow.finance.total_of_payments));

    //  ── THE FINANCE CHARGE IS NOT INSURANCE EXPENSE ─────────────────
    const posCells = withFin.body.position.reduce((m, x) => (m[x.key] = x.value, m), {});
    ok("ANNUAL COST is still the allocated premium, not premium + finance charge",
       /24,000\.00/.test(String(posCells.annual_cost)), JSON.stringify(posCells.annual_cost));
    ok("MONTHLY ACCRUAL is still premium ÷ coverage term, not an installment",
       /2,000\.00/.test(String(posCells.monthly_accrual)), JSON.stringify(posCells.monthly_accrual));
    ok("the $9,400 INSTALLMENT never appears as a monthly insurance figure",
       !/9,400\.00/.test(String(posCells.monthly_accrual)));
    const econRows = JSON.stringify(
      (withFin.body.sections || []).find((x) => x.key === "economic_position").rows);
    ok("the $7,400 FINANCE CHARGE appears nowhere in the economic section",
       !/7,400/.test(econRows), econRows.slice(0, 200));
    //  23,100 is chosen to collide with NOTHING on the economic side. An
    //  earlier draft used 24,000, which is also the GL policy's allocated
    //  annual cost — so the assertion could not tell a leak from the
    //  correct figure and passed for the wrong reason.
    ok("…nor the $23,100 down payment", !/23,100|2310000/.test(econRows), econRows.slice(0, 200));

    //  ── ESCROW ───────────────────────────────────────────────────────
    const propCovId = (await c.query(
      `select id from insurance_coverages where coverage_type = 'property'`)).rows[0].id;
    f = await post(FUNDING, { token: "entitled", json: {
      coverage_id: propCovId, funding_method: "lender_escrow", effective_from: "2026-03-01",
      provenance_note: "servicer statement", period: "2026-06",
      escrow: { lender_name: "Regional Bank", servicer_name: "Cenlar" } } });
    ok("an ESCROW arrangement is recorded", f.status === 201, JSON.stringify(f.body));
    ok("ESCROW DID NOT MOVE THE INSURANCE POSITION — byte-identical",
       (await positionOf()) === BEFORE);

    const all = await get(DASHBOARD + "?period=2026-06");
    const cash2 = (all.body.sections || []).find((x) => x.key === "cash_financing");
    //  Two coverages, two live methods. The `direct` slice recorded
    //  earlier on the GL coverage is GONE from the live read, and that is
    //  the effective-dating working: financing that coverage from April
    //  closed the direct slice. A mid-term change moves the future and
    //  leaves the past readable — it does not accumulate contradictory
    //  live answers for one coverage.
    ok("the methods that ARE live render distinctly, side by side",
       new Set(cash2.rows.map((r) => r.method)).size === cash2.rows.length
       && cash2.rows.some((r) => r.method === "lender_escrow")
       && cash2.rows.some((r) => r.method === "premium_financed"),
       JSON.stringify(cash2.rows.map((r) => r.method)));
    ok("…and financing a coverage SUPERSEDED its earlier direct slice, " +
       "rather than leaving two live answers",
       !cash2.rows.some((r) => r.method === "direct"),
       JSON.stringify(cash2.rows.map((r) => r.method)));
    const closed = (await c.query(
      `select effective_to from insurance_funding_arrangements
        where funding_method = 'direct'`)).rows[0];
    ok("…and the superseded direct slice is CLOSED, not deleted — " +
       "last month's answer stays true",
       !!closed && !!closed.effective_to, JSON.stringify(closed));
    const escRow = cash2.rows.find((r) => r.method === "lender_escrow");
    ok("…and escrow names its lender and servicer",
       escRow.escrow.lender_name === "Regional Bank" && escRow.escrow.servicer_name === "Cenlar");

    //  ── FUNDING A POLICY THIS PROPERTY IS NOT ON ────────────────────
    const foreignCov = (await c.query(
      `insert into insurance_coverages (program_id, coverage_type, coverage_period_start,
         coverage_period_end, premium_cents, established_by_user_id)
       select program_id,'umbrella_excess','2026-03-01','2027-03-01',100,$1
         from insurance_coverages limit 1 returning id`, [uid])).rows[0].id;
    f = await post(FUNDING, { token: "entitled", json: {
      coverage_id: foreignCov, funding_method: "direct", effective_from: "2026-03-01",
      provenance_note: "x" } });
    ok("funding a coverage this property is not named on is refused",
       f.status === 422 && f.body.error === "PARTICIPATION_REQUIRED", JSON.stringify(f.body));

    //  ── CORRECTION PRESERVES PRIOR TRUTH ────────────────────────────
    const arrId = finRow.arrangement_id;
    f = await post(FUNDING + "/" + arrId + "/correct", { token: "entitled", json: {
      funding_method: "premium_financed", revision_reason: "finance charge transcribed wrong",
      provenance_note: "corrected IPFS agreement", period: "2026-06",
      finance: { finance_provider: "AFCO Credit", down_payment_cents: USD(24000),
                 principal_financed_cents: USD(96000), finance_charge_cents: USD(7100),
                 installment_count: 11, installment_cents: USD(9400) } } });
    ok("a correction is accepted and requires a reason", f.status === 201, JSON.stringify(f.body));
    ok("CORRECTING FUNDING DID NOT MOVE THE INSURANCE POSITION — byte-identical",
       (await positionOf()) === BEFORE);
    const priorStill = (await c.query(
      `select finance_charge_cents from premium_finance_agreements a
         join insurance_funding_arrangements r on r.id = a.arrangement_id
        where r.id = $1`, [arrId])).rows[0];
    ok("the superseded claim is preserved and still readable",
       Number(priorStill.finance_charge_cents) === USD(7400),
       JSON.stringify(priorStill));
    const liveNow = (await get(DASHBOARD + "?period=2026-06")).body.sections
      .find((x) => x.key === "cash_financing").rows.find((r) => r.method === "premium_financed");
    ok("…while the live read shows the corrected figure",
       /7,100\.00/.test(String(liveNow.finance.finance_charge)),
       JSON.stringify(liveNow.finance.finance_charge));
    ok("…and marks it as corrected rather than silently replacing it",
       liveNow.corrected === true);

    f = await post(FUNDING + "/" + arrId + "/correct", { token: "entitled", json: {
      funding_method: "direct" } });
    ok("a correction with no reason is refused", f.status === 422
       && f.body.error === "REASON_REQUIRED", JSON.stringify(f.body));

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
