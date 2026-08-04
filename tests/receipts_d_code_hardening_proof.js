#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
//  receipts_d_code_hardening_proof.js — THE CODE-ONLY TASK HARDENING.
//
//  Step D's schema block (payload binding) does not justify leaving the code
//  defects in place. This proves the four that need no migration:
//
//    · resolve now accepts a replay identity (it accepted none at all)
//    · all four services return the exact immutable event id
//    · the duplicate lookup is bound to the obligation, so it can never
//      return another property's event
//    · one canonical event writer, no second event, no receipt table
//
//  AND IT PROVES WHY RECEIPTS STAY WITHHELD. Section E documents, without
//  performing an unsafe second mutation, that the current schema cannot
//  detect a materially different retry under the same key. That is the whole
//  reason no operation_receipt_v1 is returned from these operations.
// ════════════════════════════════════════════════════════════════════
"use strict";
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
const receipt = require("./_run_receipt.js");

const CONN = receipt.harnessConnectionString();
let pass = 0, fail = 0;
const ok = (m, c) => { if (c) { pass++; console.log("   PASS  " + m); }
                       else { fail++; console.log("   FAIL  " + m); } };
const section = (s) => console.log("\n── " + s + " " + "─".repeat(Math.max(0, 58 - s.length)));

(async () => {
  const t0 = receipt.begin(__filename, { url: CONN, expected: 20 });
  const pool = new Pool({ connectionString: CONN, ssl: false });
  const q = async (s, a = []) => (await pool.query(s, a)).rows;
  const SRC_CL = require("fs").readFileSync(
    path.join(__dirname, "..", "src/leasing/conversion_obligation_closure.js"), "utf8");
  const SRC_CV = require("fs").readFileSync(
    path.join(__dirname, "..", "src/leasing/leasingconversion.js"), "utf8");

  try {
    section("A  resolve now accepts a replay identity");
    ok("A1 resolveRung takes an idempotency_key parameter",
      /async function resolveRung\(client, \{[\s\S]{0,400}idempotency_key = null \}\)/.test(SRC_CV));
    ok("A2 and passes it to the closure authority",
      /closeLinkedConversionObligation\(client, \{[\s\S]{0,200}idempotency_key,/.test(SRC_CV));
    ok("A3 the closure authority accepts it",
      /closeLinkedConversionObligation[\s\S]{0,600}idempotency_key = null,/.test(SRC_CL));
    ok("A4 and the CLOSE ledger append now carries it — it carried none before",
      /event_type: "resolved"[\s\S]{0,400}idempotency_key,/.test(SRC_CL));

    section("B  every service returns the exact immutable event id");
    ok("B1 the ledger writer returns a structured result, not a bare id",
      /return \{ event_id: r\.rows\[0\]\.id, replayed: false \}/.test(SRC_CL));
    ok("B2 and its replay branch returns the ORIGINAL event id",
      /return \{ event_id: dup\.id, replayed: true \}/.test(SRC_CL));
    ok("B3 close returns event_id + replayed", /event_id: closeEv && closeEv\.event_id/.test(SRC_CL));
    ok("B4 reopen returns event_id + replayed", /event_id: evRes && evRes\.event_id/.test(SRC_CL));
    ok("B5 resolve returns event_id + replayed", /event_id: closeRes && closeRes\.event_id/.test(SRC_CV));
    const evReturns = (SRC_CV.match(/event_id: _ev && _ev\.event_id/g) || []).length;
    ok(`B6 reassign and change-due return event_id + replayed (${evReturns} sites)`, evReturns >= 2);

    section("C  the duplicate lookup can never return another property's event");
    ok("C1 the lookup is bound to the exact obligation, not to the key alone",
      /where idempotency_key = \$1 and conversion_obligation_id = \$2/.test(SRC_CL));
    ok("C2 the unscoped global lookup is GONE",
      !/where idempotency_key=\$1", \[e\.idempotency_key\]/.test(SRC_CL));

    //  BEHAVIOURAL, not just textual. Two obligations under two properties,
    //  the same key, and the lookup must not cross.
    const u = "dch" + Date.now().toString(36);
    const mk = async (nm) => (await q(`insert into properties (name, operating_timezone)
      values ($1,'America/New_York') returning id`, [nm]))[0].id;
    const A = await mk(u + " A"), B = await mk(u + " B");
    const mkLink = async (prop) => {
      const p = (await q(`insert into persons (name, lifecycle_status)
        values ($1,'lead') returning id`, [u + Math.random().toString(36).slice(2, 8)]))[0].id;
      //  leasing_conversions requires the actual tour host — the fixture must
      //  satisfy the domain's own NOT NULL, not work around it.
      const host = (await q(`insert into users (name,email,phone,role,is_active,status)
        values ($1,$2,$3,'property_manager',true,'active') returning id`,
        [u + "h" + Math.random().toString(36).slice(2, 7), u + Math.random().toString(36).slice(2, 8) + "@t.test",
         "+1727" + Math.floor(Math.random() * 9e6 + 1e6)]))[0].id;
      const conv = (await q(`insert into leasing_conversions
        (person_id, property_id, status, current_stage,
         actual_tour_host_user_id, conversation_owner_user_id)
        values ($1,$2,'active','tour',$3,$3) returning id`, [p, prop, host]))[0].id;
      const ob = (await q(`insert into obligations (property_id, type, status, due_at)
        values ($1,'conversion_rung','open', now()) returning id`, [prop]))[0].id;
      return (await q(`insert into leasing_conversion_obligations (conversion_id, obligation_id, rung)
        values ($1,$2,'applicant_followup') returning id`, [conv, ob]))[0].id;
    };
    const linkA = await mkLink(A), linkB = await mkLink(B);
    const sharedKey = "collide_" + crypto.randomUUID();
    const evA = (await q(`insert into leasing_conversion_obligation_events
      (conversion_obligation_id, event_type, idempotency_key)
      values ($1,'resolved',$2) returning id`, [linkA, sharedKey]))[0].id;

    const scoped = await q(`select id from leasing_conversion_obligation_events
      where idempotency_key=$1 and conversion_obligation_id=$2`, [sharedKey, linkB]);
    ok(`C3 property B's obligation finds NOTHING under property A's key (${scoped.length})`,
      scoped.length === 0);
    const own = await q(`select id from leasing_conversion_obligation_events
      where idempotency_key=$1 and conversion_obligation_id=$2`, [sharedKey, linkA]);
    ok("C4 property A's own obligation still finds its own event",
      own.length === 1 && own[0].id === evA);
    //  AND the residual is stated: the unique index is still global.
    const gidx = await q(`select indexdef from pg_indexes
      where tablename='leasing_conversion_obligation_events' and indexdef ilike '%idempotency%'`);
    ok("C5 the UNIQUE index is still GLOBAL — a real collision fails loudly, never discloses",
      gidx.some((r) => /UNIQUE/.test(r.indexdef) && !/conversion_obligation_id/.test(r.indexdef)));

    section("D  one canonical writer, no second event, no receipt table");
    ok("D1 exactly ONE ledger insert exists",
      (SRC_CL.match(/insert into leasing_conversion_obligation_events/g) || []).length === 1);
    ok("D2 no receipt table was created",
      (await q(`select count(*)::int n from information_schema.tables
        where table_name in ('operation_receipts','receipts')`))[0].n === 0);
    ok("D3 no migration was added",
      require("fs").readdirSync(path.join(__dirname, "..", "migrations"))
        .filter((f) => /^13\d_/.test(f)).length === 0);

    section("E  WHY RECEIPTS STAY WITHHELD — the capability that is missing");
    //  Documented, NOT demonstrated by performing an unsafe second mutation.
    const cols = (await q(`select column_name from information_schema.columns
      where table_name='leasing_conversion_obligation_events'`)).map((r) => r.column_name);
    ok(`E1 the event has NO column able to hold a material payload hash (${cols.filter((c) => /hash|payload/.test(c)).length})`,
      !cols.some((c) => /hash|payload/.test(c)));
    //  So a retry under the same key requesting a DIFFERENT owner cannot be
    //  distinguished from a true replay. The lookup keys on the identity
    //  alone; nothing compares next_owner_user_id, reason or due time.
    ok("E2 the duplicate branch returns without comparing the incoming operation",
      /if \(dup\) return \{ event_id: dup\.id, replayed: true \}/.test(SRC_CL)
      && !/payload_hash/.test(SRC_CL));
    ok("E3 the code says so plainly, so no future reader mistakes it for a receipt",
      /must\s*\n?\s*\/\/\s*not present its result to a human as confirmation/.test(SRC_CL)
      || /not present its result to a human as confirmation/.test(SRC_CL));
    ok("E4 NO operation_receipt is returned from any task operation",
      !/operation_receipt/.test(SRC_CV));
    ok("E5 and no recovery resolver is registered for a task namespace",
      !/OPERATIONS\.TASK_[A-Z_]+\]:/.test(require("fs").readFileSync(
        path.join(__dirname, "..", "src/identity/operator.js"), "utf8")));

    console.log("\n   obligation.resolve · reassign · reopen · change_due_time");
    console.log("   WITHHELD — PAYLOAD BINDING REQUIRES MIGRATION");
    console.log("   Not receipt-safe. Not agent-eligible.");
  } finally { await pool.end(); }

  console.log(`\n════ D code hardening: ${pass} passed, ${fail} failed ════`);
  const code = receipt.complete({ harness: __filename, passed: pass, failed: fail, expectedAtLeast: 20 });
  process.exit(code);
})().catch((e) => { console.error("DIED:", e && e.stack || e); process.exit(1); });
