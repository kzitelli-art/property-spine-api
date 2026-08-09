#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   STEP 4 — PREFLIGHT.  IS PRODUCTION READY FOR THE HANDSET COMPLETION?

   §7.4 is the release's load-bearing proof, and it happens ONCE with a
   human holding a phone. Everything that can be checked BEFORE that
   moment is checked here, so nothing is discovered while somebody is
   standing in a unit.

   It also CHOOSES THE TARGET. An operator picking a work order on the
   day is how the Gate 8 evidence row nearly got completed by accident —
   1006 already carries a real preserved photo, so a "done" against it
   would close immediately. That work order is excluded by number, and
   every candidate is checked for the conditions that make it safe.

   PROVEN READ-ONLY BEFORE IT READS ANYTHING. This tool cannot write.

   ── WHAT IS NEVER PRINTED ───────────────────────────────────────────
   phone numbers (last4 only) · media URLs · image bytes · credentials.
   Secret PRESENCE is computed and printed as a yes/no that was never a
   shell expansion of the value — `${VAR:-no}` once put a live auth token
   into a screenshot, and it is not used here or anywhere again.

   usage (Render shell):
     TEST_FROM='+1XXXXXXXXXX' node tools/step4/preflight.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const path = require("path");
const { Client } = require("pg");
const { beginProvenReadOnly, refuseNotReadOnly } = require("./_ro.js");
const { resolveStaffSenderForOrganization } =
  require(path.join(__dirname, "..", "..", "src", "comms", "communication_lines.js"));

const FROM = process.env.TEST_FROM;
//  The Gate 8 evidence work order. It holds a real preserved photo, so a
//  "done" against it would complete instantly — and it is the artifact of
//  a different gate. Never the Step 4 target.
const EXCLUDED_REFS = [1006];

let blockers = 0;
const ok = (l, c, d) => { if (c) console.log("  ok    " + l);
  else { blockers++; console.log("  BLOCK " + l + (d ? "\n          → " + d : "")); } return c; };
const note = (l, v) => console.log("  ·     " + l.padEnd(38) + v);
const sec = (t) => console.log(`\n${"═".repeat(66)}\n  ${t}\n${"═".repeat(66)}`);
const last4 = (n) => n ? "****" + String(n).replace(/\D/g, "").slice(-4) : "(unset)";

(async function main() {
  if (!FROM) { console.error("REFUSED: TEST_FROM is not set."); process.exit(1); }
  if (!process.env.DATABASE_URL) { console.error("REFUSED: DATABASE_URL is not set."); process.exit(1); }

  const c = new Client({ connectionString: process.env.DATABASE_URL,
                         ssl: { rejectUnauthorized: false } });
  await c.connect();
  const ro = await beginProvenReadOnly(c, "step4_preflight");
  if (!ro.ok) process.exit(await refuseNotReadOnly(c, ro.reason));

  console.log("\nSTEP 4 PREFLIGHT — the handset completion proof, before anyone sends anything");

  // ── 1. SCHEMA ─────────────────────────────────────────────────────
  sec("1 · SCHEMA");
  const ledger = (await c.query(`select max(version) v from schema_migrations`)).rows[0].v;
  note("migration ledger", ledger);
  ok("1.1  migration 137 is applied — the proof chain exists",
     Number(ledger) >= 137, "the canonical writer cannot record an evaluation below 137");

  const objs = (await c.query(
    `select table_name from information_schema.tables
      where table_schema='public'
        and table_name in ('work_order_proof_evaluations',
                           'work_order_proof_evaluation_attachments',
                           'release_0_activation_history',
                           'release_0_legacy_cutover_inventory')`)).rows.map((r) => r.table_name);
  ok("1.2  every 137 object is present", objs.length === 4, "found: " + objs.join(", "));

  const idx = (await c.query(
    `select 1 from pg_indexes where schemaname='public'
      and indexname='uq_obl_proof_eval_missing_open'`)).rowCount;
  note("migration 138 (defect index)", idx ? "applied" : "NOT applied");
  note("migration 139 (resolution code)", (await c.query(
    `select pg_get_constraintdef(oid) c from pg_constraint
      where conname='ck_oblig_resolution_code'`)).rows.map((r) =>
        /no_longer_applicable/.test(r.c) ? "applied" : "NOT applied")[0] || "constraint absent");
  console.log("        (138/139 are NOT required for the handset proof — the sweep needs them)");

  // ── 2. TRANSPORT ──────────────────────────────────────────────────
  sec("2 · TRANSPORT — the blocker this whole package is waiting on");
  //  PRESENCE ONLY. Computed here, never expanded in a shell.
  const present = (k) => !!(process.env[k] && String(process.env[k]).trim().length > 0);
  const sid = present("TWILIO_ACCOUNT_SID"), tok = present("TWILIO_AUTH_TOKEN");
  note("TWILIO_ACCOUNT_SID", sid ? "present" : "ABSENT");
  note("TWILIO_AUTH_TOKEN", tok ? "present" : "ABSENT");
  ok("2.1  the transport credentials are configured", sid && tok,
     "the inbound webhook refuses with 503 before it reads anything, so no " +
     "message can reach the technician turn. THIS IS THE KNOWN BLOCKER.");

  // ── 3. THE LINE AND THE TESTER ────────────────────────────────────
  sec("3 · THE OPERATIONS LINE AND THE TESTER");
  const lines = (await c.query(
    `select id, e164, organization_id, status from communication_lines
      where line_type='operations' and status='active' order by id`)).rows;
  ok("3.1  exactly one active operations line", lines.length === 1,
     lines.length + " active operations lines — the binding would be ambiguous");
  const line = lines[0];
  if (!line) { console.log("\n  " + blockers + " blocker(s). STOP."); await c.end(); process.exit(1); }
  note("operations line", line.id + "  (" + last4(line.e164) + ")");

  const who = await resolveStaffSenderForOrganization(c, {
    organizationId: line.organization_id, fromNumber: FROM });
  ok("3.2  TEST_FROM resolves to exactly one staff user", who.outcome === "one",
     "resolution outcome: " + who.outcome +
     " — run tools/activation/find_collision_free_tester.js");
  const tester = who.user;
  if (!tester) { console.log("\n  " + blockers + " blocker(s). STOP."); await c.end(); process.exit(1); }
  note("tester user_id", tester.id + "  (" + last4(FROM) + ")");

  const assigns = (await c.query(
    `select a.property_id, p.name, a.allowed_modules, a.active
       from property_team_assignments a join properties p on p.id = a.property_id
      where a.user_id = $1 and a.active = true`, [tester.id])).rows;
  const maintenance = assigns.filter((a) => (a.allowed_modules || []).includes("maintenance"));
  ok("3.3  the tester has an active maintenance assignment",
     maintenance.length >= 1,
     assigns.length + " active assignment(s), " + maintenance.length + " with maintenance — " +
     "the writer refuses an actor who may not operate the property");
  for (const a of maintenance) note("  can operate", a.name + "  " + a.property_id);

  // ── 4. THE ACTIVATION STATE ───────────────────────────────────────
  //  Not a blocker either way. It decides what the READER should say
  //  afterwards, and the proof must know which answer to expect.
  sec("4 · CUTOVER ACTIVATION — decides what the reader should say");
  const act = (await c.query(
    `select id, activated_at from release_0_activation_current`)).rows[0] || null;
  note("activation", act ? act.id + " @ " + act.activated_at.toISOString() : "NONE");
  if (act) {
    console.log("        → after the completion the reader must say proof.state = 'satisfied'");
  } else {
    console.log("        → with NO activation the reader reports read_status = 'unavailable'");
    console.log("          and OMITS state/satisfied. That is correct and expected (§3.2.1),");
    console.log("          but it means the §7.4 surface assertion cannot be made yet.");
    console.log("          Either activate first (Step 7) or accept a partial receipt.");
  }

  // ── 5. A SAFE TARGET ──────────────────────────────────────────────
  sec("5 · CANDIDATE WORK ORDERS — safe to complete with a real handset");
  const props = maintenance.map((a) => a.property_id);
  const cands = props.length ? (await c.query(
    `select w.id, w.work_order_ref, w.title, w.status, w.property_id,
            (select count(*) from work_order_progress g
              where g.work_order_id = w.id and g.kind in ('completed','completion_claimed')) as completion_rows,
            (select count(*) from work_order_proof_evaluations e
              where e.work_order_id = w.id) as evaluations,
            (select count(*) from work_order_proof_attachments a
              where a.work_order_id = w.id and a.storage_state = 'stored') as stored_photos,
            (select count(*) from obligations o
              where o.related_type='work_order' and o.related_id = w.id
                and o.property_id = w.property_id) as obligations
       from work_orders w
      where w.property_id = any($1::uuid[]) and w.status not in ('complete','closed')
      order by w.work_order_ref asc`, [props])).rows : [];

  const safe = cands.filter((w) =>
    !EXCLUDED_REFS.includes(Number(w.work_order_ref)) &&
    Number(w.completion_rows) === 0 && Number(w.evaluations) === 0 &&
    Number(w.obligations) >= 1);

  for (const w of cands) {
    const why = [];
    if (EXCLUDED_REFS.includes(Number(w.work_order_ref))) why.push("EXCLUDED (Gate 8 evidence row)");
    if (Number(w.completion_rows) > 0) why.push("already has completion facts");
    if (Number(w.evaluations) > 0) why.push("already evaluated");
    if (Number(w.obligations) === 0) why.push("no owning obligation to close (F7 would fail)");
    console.log(`  ${why.length ? "  --  " : "  ->  "}#${String(w.work_order_ref).padEnd(6)} ` +
      `${String(w.title).slice(0, 34).padEnd(36)} ${w.status.padEnd(10)} ` +
      `photos:${w.stored_photos}  ${why.join("; ") || "SAFE"}`);
  }
  ok("5.1  at least one safe candidate exists", safe.length >= 1,
     "every open work order is excluded or already carries completion facts — " +
     "create one through the governed create path first");

  /*  A work order with a stored photo ALREADY completes on the first
   *  "done", before the tester sends a picture. That is still a valid
   *  §7.4 proof of the writer, but it is NOT a proof that evidence
   *  arriving by MMS reached the evaluation — which is the whole point
   *  under Option A. Named, not silently allowed.  */
  const clean = safe.filter((w) => Number(w.stored_photos) === 0);
  ok("5.2  at least one candidate has NO stored photo yet",
     clean.length >= 1,
     "every safe candidate already holds preserved evidence, so a bare 'done' " +
     "would close it and the MMS ingress would never be exercised");

  // ── 6. T0 ─────────────────────────────────────────────────────────
  sec("6 · T0 — the binding instant");
  const t0 = (await c.query(`select now() as t`)).rows[0].t.toISOString();
  console.log("  T0   " + t0 + "   (database time)");
  console.log("\n  Carry T0 into the verification. Every row credited to this test must");
  console.log("  postdate it, on this line, from this tester — both production lines are");
  console.log("  live and an unrelated message in the same minute must not be creditable.");

  sec("VERDICT");
  if (blockers === 0 && clean.length) {
    const t = clean[0];
    console.log("  READY.\n");
    console.log("  1. From the tester handset, send ONE MMS to the operations line:");
    console.log(`       a repair photo, with completion language, naming #${t.work_order_ref}`);
    console.log("  2. Then run:\n");
    console.log(`       TEST_FROM='+1XXXXXXXXXX' node tools/step4/prove_completion.js \\`);
    console.log(`         --wo ${t.work_order_ref} --t0 '${t0}'`);
  } else {
    console.log(`  ${blockers} blocker(s). DO NOT SEND ANYTHING YET.`);
    console.log("  Every blocker above is a condition the proof needs, not a warning.");
  }
  console.log("");
  await c.end();
  process.exit(blockers === 0 && clean.length ? 0 : 1);
})().catch((e) => { console.error("\nERROR: " + (e && e.message)); process.exit(1); });
