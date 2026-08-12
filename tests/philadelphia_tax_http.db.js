/* ════════════════════════════════════════════════════════════════════
   philadelphia_tax_http.db.js — THE WHOLE TAX SLICE THROUGH REAL HTTP,
   AGAINST REAL POSTGRESQL.

   THE ACCEPTANCE CASE: an asset manager opens a Philadelphia property
   whose taxes Spine knows nothing about, and — without leaving the
   screen — confirms what applies, records the City's bill, records how
   it is funded, and ends holding four rows that are true.

   ── WHAT ONLY THIS RUNG CATCHES ─────────────────────────────────────
   The DB proof asserts the writers and the reads. It cannot catch a
   route that accepts a body property_id, a refusal that reaches a person
   as a constraint violation, or a response key renamed out from under
   the app. Those are contract facts, and a contract is only real over
   HTTP.

   ── THE REFUSALS ARE THE POINT ──────────────────────────────────────
   §21: a client-supplied property is REFUSED, not ignored. An operator
   without the module is refused. An entity this property does not reach
   is refused. And an escrow, however healthy, never makes a bill paid —
   asserted here through the same JSON an app would read.

     HARNESS_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres \
       node tests/philadelphia_tax_http.db.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const receipt = require("./_run_receipt.js");
const URL_ = receipt.harnessConnectionString();

const EXPECTED_ASSERTIONS = 106;
let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? "\n          " + detail : "")); }
}

const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from("city bill body\n")]);
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
  const schema = "phl_tax_http_" + Date.now();
  let server, port, c, scoped;

  try {
    await pool.query(`create schema ${schema}`);
    c = await pool.connect();
    await c.query(`set search_path to ${schema}`);

    await c.query(`
      create extension if not exists pgcrypto;
      create table users (id uuid primary key default gen_random_uuid(), name text);
      create table properties (id uuid primary key default gen_random_uuid(), name text);
      create table leases (id uuid primary key default gen_random_uuid(),
        property_id uuid references properties(id),
        rent numeric, start_date date, lease_status text default 'active');
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
    const dropKindCheck = [/alter table source_artifacts drop constraint[\s\S]*$/m];
    await c.query(scopedMigration("164_legal_entities.sql", dropKindCheck));
    await c.query(scopedMigration("165_philadelphia_tax_position.sql", dropKindCheck));
    await c.query(scopedMigration("166_tax_funding.sql", dropKindCheck));
    //  167 — payment identity. Without it a payment satisfies every
    //  requirement on its obligation, which is the defect it exists to close.
    await c.query(scopedMigration("167_tax_payment_identity.sql"));

    const entities = require("../src/entity/legal_entity_service.js");

    const uid = (await c.query(
      `insert into users (name) values ('Asset Ops') returning id`)).rows[0].id;
    const prop = (await c.query(
      `insert into properties (name) values ('1850 N 18th') returning id`)).rows[0].id;
    const other = (await c.query(
      `insert into properties (name) values ('4233 Chestnut') returning id`)).rows[0].id;

    const holdings = await entities.establishEntity(c, {
      legal_name: "1850 N 18th Holdings LLC", entity_type: "llc",
      provenance_note: "operating agreement", user_id: uid });
    await entities.relateToProperty(c, {
      legal_entity_id: holdings.id, property_id: prop, relationship_type: "owner",
      effective_from: "2024-01-01", provenance_note: "deed", user_id: uid });

    //  An entity this property does NOT reach.
    const stranger = await entities.establishEntity(c, {
      legal_name: "Unrelated Partners LP", entity_type: "lp",
      provenance_note: "noted elsewhere", user_id: uid });
    await entities.relateToProperty(c, {
      legal_entity_id: stranger.id, property_id: other, relationship_type: "owner",
      effective_from: "2024-01-01", provenance_note: "deed", user_id: uid });

    // ── REAL HTTP, REAL ROUTER ─────────────────────────────────────────
    //  Only the session RESOLVER is stubbed. Authority checks, writers,
    //  transactions and reads are all the real shipped code.
    const SESSIONS = {
      entitled:   { id: uid, property_id: prop, allowed_modules: ["asset_management"] },
      unentitled: { id: uid, property_id: prop, allowed_modules: ["leasing"] },
      elsewhere:  { id: uid, property_id: other, allowed_modules: ["asset_management"] },
    };
    const resolverPath = require.resolve("../src/identity/staff_session_service.js");
    require.cache[resolverPath] = { id: resolverPath, filename: resolverPath, loaded: true,
      exports: { resolveStaffSession: async (_p, t) => SESSIONS[t] || null } };

    const express = require("express");
    const app = express();
    //  Production mounts this at server.js:123. A harness without it
    //  turns every JSON body into undefined and the proof asserts a
    //  different product than the one that ships.
    app.use(express.json());
    scoped = new Pool({ connectionString: URL_ });
    scoped.on("connect", (cl) => cl.query(`set search_path to ${schema}`));
    /*  `fileToText` is the same injected seam production uses (server.js
     *  supplies a PDF extractor). Here it hands back the bytes as text —
     *  the PDF library is not what this proof is about, and the route,
     *  the reader and the proposal contract are all the real shipped
     *  code. Stated, not silent. */
    app.use("/", require("../src/surfaces/asset_management.js")({
      pool: scoped,
      fileToText: async ({ buffer }) => buffer.toString("utf8"),
    }));
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

    const B = "/operator/asset-management/taxes";
    const AS_OF = "2026-08-12";
    const row = (b, t) => b.rows.find((r) => r.tax_type === t);

    console.log("\n── 1. THE STARTING STATE IS HONESTLY EMPTY ───────────");

    let r = await get(`${B}?as_of=${AS_OF}`);
    ok("the compartment answers 200", r.status === 200, r.raw.slice(0, 200));
    /*  ⚠ AN API OUTPUT KEY IS A CONTRACT, AND `room` JUST MOVED.
     *  Taxes was re-homed from Property Obligations to Property Expenses
     *  by the AM reorganization. This assertion caught the rename the
     *  moment the surface changed — which is the whole reason it reads
     *  the key by name rather than checking the shape. Migration 159
     *  renamed a response key with no such assertion and the deal page
     *  silently showed the wrong state for a day. */
    ok("it names itself, so a surface never has to guess",
       r.body.compartment === "taxes" && r.body.room === "property_expenses",
       JSON.stringify({ compartment: r.body.compartment, room: r.body.room }));
    ok("FOUR rows, one per Philadelphia tax", r.body.rows.length === 4);
    ok("and Commercial Trash is not one of them",
       !JSON.stringify(r.body.rows).toLowerCase().includes("trash"));
    ok("the four are Real Estate Tax, BIRT, NPT and U&O",
       r.body.rows.map((x) => x.tax_type).join(",") === "real_estate,birt,npt,uo",
       r.body.rows.map((x) => x.tax_type).join(","));
    ok("every row starts NOT ESTABLISHED — absence is not 'does not apply'",
       r.body.rows.every((x) => x.applicability === "not_established"));
    ok("the headline cannot outrun the evidence",
       r.body.overall === "not_established", r.body.overall);
    ok("and it says which taxes it is waiting on",
       /Real Estate Tax, BIRT, NPT, U&O/.test(r.body.overall_why || ""), r.body.overall_why);
    //  STANDING legitimately has a value — "Not established" IS the
    //  answer. Every cell that would hold a NUMBER or a DATE is blank
    //  with a reason, and none of them is a zero or a dash.
    ok("Standing says 'Not established' rather than going blank",
       r.body.position.find((p) => p.key === "standing").value === "Not established");
    ok("every money and date cell is blank WITH A REASON, never zero",
       r.body.position.filter((p) => p.key !== "standing")
         .every((p) => p.value === null && !!p.awaiting),
       JSON.stringify(r.body.position));
    ok("totals are null, not 0 — nothing is known yet",
       r.body.totals.annual_liability_cents === null
       && r.body.totals.monthly_accrual_cents === null);
    //  ⚠ AN UNANSWERED TAX MAKES THE TOTAL PARTIAL TOO. The first version
    //  counted only APPLICABLE obligations missing an amount, so a property
    //  with one established bill and three unanswered taxes showed a
    //  confident total with no caveat. A browser proof caught it.
    ok("all four taxes count as unanswered, and that alone marks it partial",
       r.body.totals.taxes_not_established === 4 && r.body.totals.is_partial === true,
       JSON.stringify(r.body.totals));
    ok("funding is unknown for all four, never defaulted to paid directly",
       r.body.funding_summary.unknown_for.length === 4
       && r.body.funding_summary.established === false);

    //  ── THE CORRECTION THAT MATTERS THIS YEAR ────────────────────────
    ok("U&O is reported as still live — only the exemption ended",
       r.body.uo_exemption.annual_exemption_available === false
       && /remains active/.test(r.body.uo_exemption.note), JSON.stringify(r.body.uo_exemption));
    ok("and the exemption's end date is stated, not implied",
       r.body.uo_exemption.ended_on === "2026-01-01");

    console.log("\n── 2. AUTHORITY IS SERVER-DERIVED (§21) ──────────────");

    ok("no session is refused", (await get(B, null)).status === 401);
    ok("a session without the module is refused",
       (await get(B, "unentitled")).status === 403);

    r = await get(`${B}?property_id=${other}`);
    ok("§21 a client-supplied property is REFUSED, not ignored", r.status === 403,
       String(r.status));
    ok("and the refusal says which property it IS acting on",
       r.body.acting_on === prop, JSON.stringify(r.body));

    r = await post(`${B}/applicability`, { token: "entitled", json: {
      property_id: other, tax_type: "real_estate", determination: "applies",
      basis: "x", provenance_note: "x" } });
    ok("§21 holds on the WRITE path too", r.status === 403, String(r.status));

    r = await post(`${B}/applicability`, { token: "unentitled", json: {
      tax_type: "real_estate", determination: "applies", basis: "x",
      provenance_note: "x" } });
    ok("an unentitled operator cannot write either", r.status === 403);

    console.log("\n── 3. EVIDENCE FIRST, AND IT ESTABLISHES NOTHING ─────");

    r = await post(`${B}/evidence`, { token: "entitled", multipart: {
      file: { name: "2026 RE tax bill.pdf", type: "application/pdf", bytes: PDF },
      fields: { artifact_kind: "tax_bill" } } });
    ok("a City bill is retained", r.status === 201 && !!r.body.artifact.id, r.raw.slice(0, 200));
    ok("and the receipt says a document on file is not yet a governed fact",
       /not yet a governed fact/.test(r.body.receipt), r.body.receipt);
    const billId = r.body.artifact.id;

    r = await post(`${B}/evidence`, { token: "entitled", multipart: {
      file: { name: "rent roll.xlsx", type: "application/vnd.ms-excel", bytes: XLSX },
      fields: { artifact_kind: "tax_bill" } } });
    ok("a spreadsheet offered as a tax bill is refused", r.status === 422);
    ok("and the refusal is sayable to the person who chose the file",
       /Upload the bill or notice the City issued/.test(r.body.receipt), r.body.receipt);

    r = await post(`${B}/evidence`, { token: "entitled", multipart: {
      file: { name: "portal export.csv", type: "text/csv", bytes: Buffer.from("a,b\n1,2\n") },
      fields: { artifact_kind: "tax_account_statement" } } });
    ok("but the City's own portal export IS accepted as an account statement",
       r.status === 201, r.raw.slice(0, 200));

    r = await get(`${B}?as_of=${AS_OF}`);
    ok("storing evidence changed nothing about the position",
       r.body.overall === "not_established");

    console.log("\n── 4. APPLICABILITY IS A HUMAN DETERMINATION ─────────");

    r = await post(`${B}/applicability`, { token: "entitled", json: {
      tax_type: "real_estate", determination: "applies",
      basis: "Philadelphia property; OPA account on the City bill.",
      effective_from: "2024-01-01", artifact_id: billId } });
    ok("Real Estate Tax is confirmed to apply", r.status === 201, r.raw.slice(0, 250));
    ok("and the receipt says applicability is not the obligation",
       /obligation itself is not established/.test(r.body.receipt), r.body.receipt);

    r = await post(`${B}/applicability`, { token: "entitled", json: {
      tax_type: "real_estate", determination: "not_applicable",
      basis: "changed my mind", effective_from: "2024-01-01",
      provenance_note: "x" } });
    ok("restating it for the same date demands a CORRECTION, not a second answer",
       r.status === 422 && r.body.error === "CORRECTION_REQUIRED", r.raw.slice(0, 200));
    ok("and the refusal names both options in plain words",
       /say why the earlier determination was wrong|from when the world actually changed/
         .test(r.body.receipt), r.body.receipt);

    r = await post(`${B}/applicability`, { token: "entitled", json: {
      tax_type: "birt", determination: "applies", basis: "x", provenance_note: "x" } });
    ok("BIRT with no entity named is refused — it is owed by the taxpayer",
       r.status === 422 && r.body.error === "SUBJECT_REQUIRED", r.raw.slice(0, 200));

    r = await post(`${B}/applicability`, { token: "entitled", json: {
      tax_type: "birt", determination: "applies", basis: "x", provenance_note: "x",
      legal_entity_id: stranger.id } });
    ok("an entity this property does not reach is refused",
       r.status === 403 && r.body.error === "ENTITY_NOT_RELATED", r.raw.slice(0, 200));

    for (const [t, d, basis, ent] of [
      ["uo", "not_applicable", "Entirely residential; no commercial use of the premises.", null],
      ["birt", "applies", "The owning entity conducts business in Philadelphia.", holdings.id],
      ["npt", "not_applicable", "The owner is an LLC filing BIRT.", holdings.id],
    ]) {
      const rr = await post(`${B}/applicability`, { token: "entitled", json: {
        tax_type: t, determination: d, basis, legal_entity_id: ent,
        effective_from: "2024-01-01", provenance_note: "asset manager review" } });
      if (rr.status !== 201) ok(`applicability for ${t}`, false, rr.raw.slice(0, 200));
    }

    r = await get(`${B}?as_of=${AS_OF}`);
    ok("with all four answered, the headline stops saying NOT ESTABLISHED",
       r.body.overall !== "not_established", `${r.body.overall} — ${r.body.overall_why}`);
    ok("two are recorded as not applicable, with a stated basis",
       r.body.rows.filter((x) => x.state === "not_applicable").length === 2
       && r.body.rows.filter((x) => x.state === "not_applicable")
            .every((x) => !!x.applicability_basis));
    ok("Real Estate Tax now wants its obligation",
       row(r.body, "real_estate").state === "action_required",
       row(r.body, "real_estate").why_not_current);

    console.log("\n── 5. THE CITY'S BILL, RECORDED — NEVER COMPUTED ─────");

    r = await post(`${B}/obligation`, { token: "entitled", json: {
      tax_type: "real_estate", period_year: 2026,
      account_identifier: "OPA 881234567",
      annual_liability_cents: USD(14203.00), assessment_cents: USD(1014500),
      artifact_id: billId } });
    ok("the 2026 obligation and its liability are established", r.status === 201,
       r.raw.slice(0, 250));
    ok("and the receipt says Spine records what the City says, never computes it",
       /does not compute a bill/.test(r.body.receipt), r.body.receipt);
    const reObl = r.body.obligation_id;

    r = await post(`${B}/obligation`, { token: "entitled", json: {
      tax_type: "real_estate", period_year: 2026, provenance_note: "again" } });
    ok("a second 2026 Real Estate obligation is refused as a duplicate",
       r.status === 422 && r.body.error === "ALREADY_ESTABLISHED", r.raw.slice(0, 200));

    //  BIRT 2025 for the entity — ONE obligation, surfacing on this property.
    r = await post(`${B}/obligation`, { token: "entitled", json: {
      tax_type: "birt", period_year: 2025, legal_entity_id: holdings.id,
      provenance_note: "prior-year return in hand" } });
    ok("the entity's BIRT obligation is established with no amount yet",
       r.status === 201 && r.body.liability_id === null, r.raw.slice(0, 250));
    ok("and it says the amount stays unknown until the bill arrives",
       /amount stays unknown/.test(r.body.receipt), r.body.receipt);
    const birtObl = r.body.obligation_id;

    r = await get(`${B}?as_of=${AS_OF}`);
    const re = row(r.body, "real_estate");
    ok("the due date comes from the jurisdiction's clocks, not from a form",
       re.next_due === null && re.state === "overdue", `${re.state} / ${re.next_due}`);
    ok("the annual liability is reported, and pre-formatted for the surface",
       re.annual_liability_cents === USD(14203.00) && re.annual_liability === "$14,203.00",
       re.annual_liability);
    ok("the monthly accrual is the governed liability over its own period",
       re.monthly_accrual_cents === Math.round(USD(14203.00) / 12), String(re.monthly_accrual_cents));
    ok("the total is marked PARTIAL, because BIRT has no amount yet",
       r.body.totals.is_partial === true
       && r.body.totals.obligations_with_unknown_amount === 1,
       JSON.stringify(r.body.totals));
    ok("the entity is named on the screen, because BIRT belongs to it",
       r.body.entities.length === 1 && r.body.entities[0].legal_name.includes("Holdings"));

    console.log("\n── 6. FUNDING — AND IT CANNOT PAY ANYTHING ───────────");

    //  ── A DEDUP DEFECT THIS RUNG CAUGHT ───────────────────────────
    //  Offering the SAME BYTES again under a different kind resolves to
    //  the existing row. The response must report the kind Spine HOLDS,
    //  not the kind that was asked for — otherwise it tells someone their
    //  escrow statement is on file as an escrow statement when it is not.
    r = await post(`${B}/funding/evidence`, { token: "entitled", multipart: {
      file: { name: "same bytes.pdf", type: "application/pdf", bytes: PDF },
      fields: { artifact_kind: "tax_escrow_statement" } } });
    ok("identical bytes resolve to the file already on record", r.status === 200
       && r.body.artifact.deduplicated === true, r.raw.slice(0, 200));
    ok("and the response reports the STORED kind, not the requested one",
       r.body.artifact.artifact_kind === "tax_bill", r.body.artifact.artifact_kind);
    ok("the receipt says so, so nobody thinks the escrow statement is filed",
       /held as tax bill/.test(r.body.receipt), r.body.receipt);

    const ESCROW_PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"),
                                      Buffer.from("servicer escrow statement\n")]);
    r = await post(`${B}/funding/evidence`, { token: "entitled", multipart: {
      file: { name: "escrow statement.pdf", type: "application/pdf", bytes: ESCROW_PDF },
      fields: { artifact_kind: "tax_escrow_statement" } } });
    ok("a servicer escrow statement is retained on the funding side",
       r.status === 201, r.raw.slice(0, 200));
    const escArt = r.body.artifact.id;
    ok("and the receipt says it never says a bill was paid",
       /never says a bill was paid/.test(r.body.receipt), r.body.receipt);

    r = await post(`${B}/funding/evidence`, { token: "entitled", multipart: {
      file: { name: "2026 bill.pdf", type: "application/pdf", bytes: PDF },
      fields: { artifact_kind: "tax_bill" } } });
    ok("a City bill offered as funding evidence is refused — wrong side of the wall",
       r.status === 422 && r.body.error === "unsupported_artifact_kind");

    r = await post(`${B}/funding`, { token: "entitled", json: {
      tax_type: "real_estate", funding_method: "lender_escrow",
      effective_from: "2024-01-01", artifact_id: escArt,
      escrow: { monthly_contribution_cents: USD(1250) } } });
    ok("an escrow with no holder named is refused",
       r.status === 422 && r.body.error === "ESCROW_HOLDER_REQUIRED", r.raw.slice(0, 200));

    r = await post(`${B}/funding`, { token: "entitled", json: {
      tax_type: "real_estate", funding_method: "lender_escrow",
      effective_from: "2024-01-01", artifact_id: escArt,
      escrow: { lender_name: "Berkadia", servicer_name: "Cenlar FSB",
                escrow_account_reference: "ESC-88412",
                monthly_contribution_cents: USD(1250.00) } } });
    ok("the escrow is recorded", r.status === 201, r.raw.slice(0, 250));
    ok("⚠ the response says, in the payload, that the liability did not move",
       r.body.tax_liability_changed === false && r.body.tax_payment_recorded === false);
    ok("and the receipt says it in words too",
       /nothing here says a bill was paid/.test(r.body.receipt), r.body.receipt);
    const arrId = r.body.arrangement_id;

    r = await post(`${B}/funding/${arrId}/balance`, { token: "entitled", json: {
      observed_on: "2026-08-01", balance_cents: USD(18400.00), artifact_id: escArt } });
    ok("a balance well over the bill is recorded", r.status === 201, r.raw.slice(0, 250));
    ok("and the receipt refuses the assumption the number invites",
       /not that any bill has been paid/.test(r.body.receipt), r.body.receipt);

    r = await post(`${B}/funding/${arrId}/disbursement`, { token: "entitled", json: {
      obligation_id: birtObl, disbursed_on: "2026-03-28",
      amount_cents: USD(14203.00), artifact_id: escArt } });
    ok("a disbursement pointed at the wrong bill is refused",
       r.status === 422 && r.body.error === "OBLIGATION_MISMATCH", r.raw.slice(0, 200));

    r = await post(`${B}/funding/${arrId}/disbursement`, { token: "entitled", json: {
      obligation_id: reObl, disbursed_on: "2026-03-28",
      amount_cents: USD(14203.00), reference: "RE TAX DISB 03/28", artifact_id: escArt } });
    ok("the servicer's disbursement is recorded as a funding fact", r.status === 201,
       r.raw.slice(0, 250));
    ok("and the receipt says the bill stays unpaid without City evidence",
       /stays unpaid in Spine until there is City payment evidence/.test(r.body.receipt),
       r.body.receipt);

    console.log("\n── 7. THE SCREEN, WITH A FUNDED ESCROW AND AN UNPAID BILL ──");

    r = await get(`${B}?as_of=${AS_OF}`);
    const reFunded = row(r.body, "real_estate");
    ok("⚠ THE ROW STILL READS OVERDUE. A funded escrow is not a payment.",
       reFunded.state === "overdue", reFunded.state);
    ok("the funding sits BESIDE the row, under its own key",
       reFunded.funding.funding_method === "lender_escrow"
       && reFunded.funding.escrow.servicer_name === "Cenlar FSB");
    ok("the contribution is rendered as cash to a servicer, never as the accrual",
       reFunded.funding.escrow.monthly_contribution === "$1,250.00"
       && reFunded.monthly_accrual !== reFunded.funding.escrow.monthly_contribution);
    ok("the balance carries the day it was true and how old it is",
       reFunded.funding.escrow.balance.observed_on === "2026-08-01"
       && reFunded.funding.escrow.balance.days_old === 11);
    ok("the disagreement is on the row, where somebody will see it",
       reFunded.unevidenced_disbursements.length === 1);
    ok("and it names what would resolve it",
       /City receipt/.test(reFunded.unevidenced_disbursements[0].resolves));
    ok("the strip's Funding cell is a LABEL, never an amount",
       r.body.position.find((p) => p.key === "funding").value === "Paid from lender escrow");
    ok("the three taxes with no arrangement report UNKNOWN funding",
       r.body.funding_summary.unknown_for.map((u) => u.tax_type).sort().join(",")
         === "birt,npt,uo",
       JSON.stringify(r.body.funding_summary.unknown_for));
    ok("and their rows say so in words, never 'paid directly'",
       row(r.body, "birt").funding === null
       && /has not been established/.test(row(r.body, "birt").funding_awaiting));

    console.log("\n── 8. FILING IS NOT PAYING ───────────────────────────");

    r = await post(`${B}/obligation/${birtObl}/filing`, { token: "entitled", json: {
      filed_at: "2026-04-10", filing_kind: "return", provenance_note: "filed by the accountant" } });
    ok("the BIRT return is recorded as filed", r.status === 201, r.raw.slice(0, 250));
    ok("and the receipt says filing does not pay the balance",
       /Filing does not pay the balance/.test(r.body.receipt), r.body.receipt);

    //  ── FILED IS ITS OWN STATE, AND IT IS NOT CURRENT ─────────────
    //  On the day the return is due, a filed BIRT with no payment reads
    //  FILED — distinct from overdue and distinct from paid, with the
    //  detail naming which half is outstanding.
    r = await get(`${B}?as_of=2026-04-15`);
    ok("on its due date a filed-but-unpaid return reads FILED, never current",
       row(r.body, "birt").state === "filed", row(r.body, "birt").state);
    ok("and it says which half is outstanding",
       row(r.body, "birt").detail === "Payment outstanding");
    ok("the whole position cannot read current while a balance is outstanding",
       r.body.overall !== "current", r.body.overall);

    //  Four months later the balance is simply late.
    r = await get(`${B}?as_of=${AS_OF}`);
    ok("months past the due date the same obligation reads OVERDUE",
       row(r.body, "birt").state === "overdue", row(r.body, "birt").state);
    ok("filing never satisfied the payment — the reason says the balance",
       /balance/i.test(row(r.body, "birt").why_not_current || ""),
       row(r.body, "birt").why_not_current);

    console.log("\n── 9. CITY EVIDENCE IS WHAT MOVES IT ─────────────────");

    r = await post(`${B}/evidence`, { token: "entitled", multipart: {
      file: { name: "city receipt.pdf", type: "application/pdf", bytes: PDF },
      fields: { artifact_kind: "tax_payment_receipt" } } });
    const receiptArt = r.body.artifact.id;

    r = await post(`${B}/obligation/${reObl}/payment`, { token: "entitled", json: {
      paid_at: "2026-03-30", amount_cents: USD(14203.00), paid_by: "lender_escrow",
      confirmation_reference: "PHL-2026-88412", artifact_id: receiptArt } });
    ok("the City payment is recorded", r.status === 201, r.raw.slice(0, 250));
    ok("and the receipt distinguishes who remitted from what proves it",
       /remitted by the lender's escrow, and evidenced by the City/.test(r.body.receipt),
       r.body.receipt);

    r = await get(`${B}?as_of=${AS_OF}`);
    ok("only now does Real Estate Tax read PAID",
       row(r.body, "real_estate").state === "paid");
    ok("and the escrow's disbursement now reports City evidence",
       row(r.body, "real_estate").funding.arrangement_id === arrId
       && row(r.body, "real_estate").unevidenced_disbursements.length === 0);

    console.log("\n── 10. AN APPEAL CHANGES NOTHING ABOUT WHAT IS OWED ──");

    const before = JSON.stringify(row((await get(`${B}?as_of=${AS_OF}`)).body, "real_estate")
      .annual_liability_cents);
    r = await post(`${B}/obligation/${reObl}/appeal`, { token: "entitled", json: {
      opened_on: "2026-09-01", provenance_note: "BRT appeal filed" } });
    ok("an appeal is recorded", r.status === 201, r.raw.slice(0, 200));
    ok("and the receipt says the liability is unchanged",
       /liability is unchanged/.test(r.body.receipt), r.body.receipt);

    r = await get(`${B}?as_of=${AS_OF}`);
    ok("the liability really is unchanged",
       JSON.stringify(row(r.body, "real_estate").annual_liability_cents) === before);
    ok("and the open appeal is visible on the row",
       row(r.body, "real_estate").appeal_open === true);

    console.log("\n── 11. A CLEARANCE THAT DISAGREES IS SURFACED ────────");

    //  2025 BIRT has a filed return and no payment — it is not current.
    //  A clearance certificate claiming the City is satisfied through
    //  2026 is a real disagreement between two pieces of evidence.
    r = await post(`${B}/clearance`, { token: "entitled", json: {
      issued_on: "2026-08-01", verified_through: "2026-12-31",
      certificate_reference: "TC-2026-771", provenance_note: "City portal" } });
    ok("the clearance is recorded as compliance evidence", r.status === 201,
       r.raw.slice(0, 250));

    r = await get(`${B}?as_of=${AS_OF}`);
    ok("it never manufactures a missing fact — BIRT still reads overdue",
       row(r.body, "birt").state === "overdue", row(r.body, "birt").state);
    ok("and the clearance is reported with its own validity window",
       r.body.clearance.verified_through === "2026-12-31"
       && r.body.clearance.still_valid === true);
    //  ⚠ TWO PIECES OF EVIDENCE DISAGREEING. A live certificate saying
    //  the City is satisfied, beside an obligation Spine reads as
    //  overdue. Surfaced, never quietly resolved in either direction.
    ok("the disagreement between certificate and obligation is SURFACED",
       r.body.clearance.conflicts_with.includes("BIRT"),
       JSON.stringify(r.body.clearance));
    ok("and the headline still reflects the obligation, not the certificate",
       r.body.overall === "overdue", r.body.overall);

    console.log("\n── 12. THE TAXPAYER DEAD END IS CLOSED ───────────────");

    /*  Until this route existed, BIRT and NPT could not be established
     *  from a property whose entity was not already in the database by
     *  hand. The sheet explained the problem honestly and offered no way
     *  out of it, which is still a dead end. */
    r = await post("/operator/asset-management/legal-entity", { token: "entitled", json: {
      legal_name: "Chestnut Holdings LLC", entity_type: "llc",
      relationship_type: "owner", effective_from: "2026-01-01" } });
    ok("an entity with no provenance is refused", r.status === 422
       && r.body.error === "PROVENANCE_REQUIRED", r.raw.slice(0, 200));

    r = await post("/operator/asset-management/legal-entity", { token: "entitled", json: {
      property_id: other, legal_name: "Chestnut Holdings LLC",
      effective_from: "2026-01-01", provenance_note: "deed" } });
    ok("§21 a client-supplied property is refused on this route too",
       r.status === 403, String(r.status));

    r = await post("/operator/asset-management/legal-entity", { token: "unentitled", json: {
      legal_name: "Chestnut Holdings LLC", effective_from: "2026-01-01",
      provenance_note: "deed" } });
    ok("an unentitled operator cannot name a taxpayer", r.status === 403);

    r = await post("/operator/asset-management/legal-entity", { token: "entitled", json: {
      legal_name: "Chestnut Holdings LLC", entity_type: "llc",
      formation_jurisdiction: "PA", relationship_type: "owner",
      effective_from: "2026-01-01", provenance_note: "deed recorded 2026-01-04" } });
    ok("a taxpayer is established and related in one act", r.status === 201
       && !!r.body.legal_entity_id && !!r.body.relationship_id, r.raw.slice(0, 250));
    ok("⚠ …and it establishes NO tax fact — the response says so",
       r.body.tax_truth_established === false
       && /does not yet say which taxes apply/.test(r.body.receipt), r.body.receipt);
    ok("the property now reaches two taxpayers",
       r.body.entities.length === 2, JSON.stringify(r.body.entities.map((e) => e.legal_name)));

    r = await get(`${B}?as_of=${AS_OF}`);
    ok("…and the taxes screen sees the new one immediately",
       r.body.entities.some((e) => e.legal_name === "Chestnut Holdings LLC"));

    console.log("\n── 13. THE DOCUMENT IS READ, AND PROPOSES ONLY ───────");

    /*  The extracted text of a REAL City Real Estate Tax bill. The
     *  reader has its own pure test; what this rung proves is that the
     *  proposal actually reaches an operator over HTTP, and that nothing
     *  it proposed was written. */
    const REAL_BILL = Buffer.concat([Buffer.from("%PDF-1.7\n"),
      fs.readFileSync(path.join(__dirname, "fixtures", "tax",
        "2116_chestnut_ret_bill_2023.txt"))]);

    r = await post(`${B}/evidence`, { token: "entitled", multipart: {
      file: { name: "2023 RET bill.pdf", type: "application/pdf", bytes: REAL_BILL },
      fields: { artifact_kind: "tax_bill" } } });
    ok("a real City bill is retained and READ", r.status === 201
       && r.body.proposal && r.body.proposal.found_count === 4, r.raw.slice(0, 300));
    ok("…the OPA number reaches the operator",
       r.body.proposal.fields.account_identifier === "881566975",
       JSON.stringify(r.body.proposal.fields));
    ok("…so does the amount to pay, and the March 31 date",
       r.body.proposal.fields.annual_liability === "201512.97"
       && r.body.proposal.fields.due_date === "2023-03-31");
    ok("…and the proposal names itself a proposal, to be checked",
       r.body.proposal.source === "label_scan"
       && /Check every one before confirming/.test(r.body.proposal.reason));

    //  ⚠ NOTHING PROPOSED WAS WRITTEN. Uploading is retention, not a
    //  claim, and the position must be untouched by it.
    const afterScan = await get(`${B}?as_of=${AS_OF}`);
    ok("⚠ reading a document established NO tax fact",
       !afterScan.body.rows.some((x) => x.period_label === "2023"),
       JSON.stringify(afterScan.body.rows.map((x) => x.period_label)));

    r = await post(`${B}/evidence`, { token: "entitled", multipart: {
      file: { name: "clearance.pdf", type: "application/pdf",
              bytes: Buffer.concat([Buffer.from("%PDF-1.7\n"),
                Buffer.from("TAX CLEARANCE CERTIFICATE  Amount to Pay: $500.00")]) },
      fields: { artifact_kind: "tax_clearance_certificate" } } });
    ok("a clearance certificate is retained but proposes nothing",
       r.status === 201 && r.body.proposal.available === false);
    ok("…and says why, instead of looking like a failed read",
       /compliance evidence/.test(r.body.proposal.reason), r.body.proposal.reason);

    console.log("\n── 14. THE OTHER PROPERTY SEES NONE OF IT ────────────");

    r = await get(`${B}?as_of=${AS_OF}`, "elsewhere");
    ok("a different property's screen is honestly empty",
       r.status === 200 && r.body.overall === "not_established");
    ok("no obligation, liability or escrow leaks across the property boundary",
       r.body.rows.every((x) => x.obligation_id === null && x.funding === null)
       && r.body.funding_summary.established === false);

  } finally {
    if (server) await new Promise((r) => server.close(r));
    if (scoped) await scoped.end();
    if (c) {
      try { await c.query(`drop schema ${schema} cascade`); } catch (_) {}
      c.release();
    }
    await pool.end();
  }

  console.log("\n════════════════════════════════════════════════════════════════");
  console.log(`  ASSERTIONS COMPLETE · ${pass + fail} run · ${pass} passed · ${fail} failed`);
  if (pass + fail !== EXPECTED_ASSERTIONS) {
    console.log(`  ✗ FAIL — expected ${EXPECTED_ASSERTIONS} assertions, ran ${pass + fail}.`);
    process.exit(1);
  }
  if (fail) { console.log("  ✗ FAIL"); process.exit(1); }
  console.log("  ✓ PASS — four rows, through real HTTP, with nothing invented.");
  console.log("════════════════════════════════════════════════════════════════");
}

main().catch((e) => { console.error(e); process.exit(1); });
