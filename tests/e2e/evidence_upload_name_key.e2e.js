/*  ════════════════════════════════════════════════════════════════════
    evidence_upload_name_key.e2e.js — A TAX BILL OR UTILITY STATEMENT
    UPLOADED AS A PDF IS READ AS ONE.

    fileToText (src/agent/document_ingest.js) dispatches on
    file.originalname — .pdf through the PDF reader, .xlsx/.csv through
    the spreadsheet reader, .docx through Word, anything else as utf-8 of
    the raw bytes. The tax and utility evidence doors built the file as
    { filename } instead, so every document uploaded there fell through to
    utf-8 of its bytes: the document reader scanned a compressed PDF for
    its labels, found none, and the operator retyped what the file plainly
    said. The other four evidence doors passed originalname. The artifact
    store admits only PDF for tax_bill and utility_statement, so PDF is the
    reachable case. Proven here through both real upload routes with two
    committed PDFs (tests/e2e/fixtures, rendered from four-line HTML by
    headless Chromium) whose text carries the labels each reader looks for.

    Runs against the REAL server.js the verification parent booted.
    ════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..", "..");
const { Pool } = require(path.join(ROOT, "node_modules", "pg"));
const staffSessions = require(path.join(ROOT, "src/identity/staff_session_service.js"));

const API = (process.env.E2E_API_BASE || "http://localhost:3000").replace(/\/+$/, "");
const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
const FIXTURES = path.join(__dirname, "fixtures");

let pass = 0, fail = 0;
const ok  = (l, d = "") => { pass++; console.log(`  ✓ ${l}${d ? "  — " + d : ""}`); };
const bad = (l, d = "") => { fail++; console.log(`  ✗ ${l}${d ? "  — " + d : ""}`); };
const check = (l, cond, d) => (cond ? ok(l) : bad(l, d));
const J = (v) => JSON.stringify(v);
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];

async function upload(url, session, fixture, kind) {
  const fd = new FormData();
  fd.append("artifact_kind", kind);
  fd.append("file", new Blob([fs.readFileSync(path.join(FIXTURES, fixture))], { type: "application/pdf" }), fixture);
  const r = await fetch(`${API}${url}`, { method: "POST", headers: { "x-staff-session": session }, body: fd });
  return { status: r.status, body: await r.json().catch(() => null) };
}

(async () => {
  const tag = "EUN" + Math.floor(Math.random() * 1e6);
  const prop = (await one("insert into properties (name,address) values ($1,'16 Evidence Ct') returning id", [tag + " Evidence"])).id;
  const user = (await one(
    `insert into users (name,email,role,is_active,status,account_kind)
     values ($1,$2,'asset_manager',true,'active','human_staff') returning id`, [tag + " AM", `${tag}@example.com`])).id;
  await pool.query(
    `insert into property_team_assignments (property_id,user_id,role_title,scope_type,allowed_modules,primary_for_modules,can_manage_roles,active)
     values ($1,$2,'Asset Manager','property','{asset_management,management}','{management}',false,true)`, [prop, user]);
  const c = await pool.connect();
  let session;
  try { await c.query("begin"); session = (await staffSessions.issueStaffSession(c, { userId: user, propertyId: prop, purpose: "sms_otp" })).session_token; await c.query("commit"); }
  catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }

  console.log("\n── 1 · a tax bill PDF ──");
  const tax = await upload("/operator/asset-management/taxes/evidence", session, "tax_bill_labels.pdf", "tax_bill");
  const tp = (tax.body && tax.body.proposal) || {};
  check("POST …/taxes/evidence (.pdf) → 201 (or 200 when the same bytes are already on file), document retained", (tax.status === 201 || tax.status === 200) && tax.body && tax.body.artifact && tax.body.artifact.id, `${tax.status} ${J(tax.body).slice(0, 200)}`);
  check("…the reader read the PDF's TEXT, not its bytes: annual_liability 1234.56 proposed", tp.available === true && tp.fields && tp.fields.annual_liability === "1234.56", J(tp));
  check("…with the account, year and due date the document states", !!tp.fields && tp.fields.account_identifier === "881234501" && tp.fields.period_year === "2026" && tp.fields.due_date === "2026-03-31", J(tp.fields));

  console.log("\n── 2 · a utility statement PDF ──");
  const util = await upload("/operator/asset-management/utilities/evidence", session, "utility_statement_labels.pdf", "utility_statement");
  const up = (util.body && util.body.proposal) || {};
  check("POST …/utilities/evidence (.pdf) → 201 (or 200 deduplicated), document retained", (util.status === 201 || util.status === 200) && util.body && util.body.artifact && util.body.artifact.id, `${util.status} ${J(util.body).slice(0, 200)}`);
  check("…the reader read the PDF's text: provider PECO and current_amount_due 210.55 proposed", up.available === true && up.fields && up.fields.provider_name === "PECO" && up.fields.current_amount_due === "210.55", J(up));
  check("…found_count counts the labelled lines (was 0 — compressed bytes scanned for labels)", Number(up.found_count) >= 5, `found_count=${up.found_count}`);

  await pool.end();
  console.log(`\n══ evidence upload name key: ${pass} passed, ${fail} failed ══`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
