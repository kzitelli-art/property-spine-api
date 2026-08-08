#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   STEP 4 — THE HANDSET COMPLETION PROOF, AND ITS RECEIPT

   §7.4, the release's load-bearing gate:

     a real handset · a real inbound photo · a real preserved attachment
     with a storage state, a MIME type and a digest · claimCompletion
     completes a real work order · the operator surface reflects it
     without operator action

   This is the verification half. `preflight.js` established the
   conditions and printed T0; a human then sent one message.

   ── THE ASSERTIONS ARE ALREADY PROVEN ───────────────────────────────

   Every fact checked here lives in `completion_facts.js`, which
   `rehearse.js` drives against isolated PostgreSQL: eight facts green
   over a genuine completion, then each one mutated away to prove the
   matching check goes red, plus a HOLLOW completion — every outward
   sign, no evaluation — that must be refused. Nothing is being tried out
   for the first time against production.

   ── BOUND TO ONE DELIBERATE ACT ─────────────────────────────────────

   Both production lines are live. Nothing is credited by recency: the
   inbound message must postdate T0, arrive on the operations line, come
   from the resolved tester, and carry the provider's own sid. The work
   order is named on the command line, never discovered.

   ── NO GREEN-COUNT LOGIC ────────────────────────────────────────────

   The receipt is not "N checks passed". Every fact is named and checked
   by name, and a single absent fact refuses the receipt. A receipt that
   can pass with a hole in it is how a half-activated rail gets recorded
   as a finished one.

   PROVEN READ-ONLY BEFORE IT READS ANYTHING. This tool cannot write.

   ── WHAT IS NEVER PRINTED ───────────────────────────────────────────
   phone numbers (last4 only) · media URLs · image bytes · note bodies ·
   message bodies · credentials. sha256 (truncated) and byte size ARE
   printed — they are the durable evidence.

   usage (Render shell):
     TEST_FROM='+1XXXXXXXXXX' node tools/step4/prove_completion.js \
       --wo 1012 --t0 '2026-08-08T18:00:00.000Z'
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const path = require("path");
const { Client } = require("pg");
const { beginProvenReadOnly, refuseNotReadOnly } = require("./_ro.js");
const F = require("./completion_facts.js");
const reader = require(path.join(__dirname, "..", "..", "src/surfaces/work_order_status_read.js"));
const { resolveStaffSenderForOrganization } =
  require(path.join(__dirname, "..", "..", "src", "comms", "communication_lines.js"));

const argv = process.argv.slice(2);
const arg = (f) => { const i = argv.indexOf(f); return i > -1 ? argv[i + 1] : null; };
const FROM = process.env.TEST_FROM;
const WO_REF = arg("--wo");
const T0 = arg("--t0");

let refusals = 0;
const ok = (l, c, d) => { if (c) console.log("  ok    " + l);
  else { refusals++; console.log("  MISS  " + l + (d ? "\n          → " + d : "")); } return c; };
const sec = (t) => console.log(`\n${"═".repeat(66)}\n  ${t}\n${"═".repeat(66)}`);
const last4 = (n) => n ? "****" + String(n).replace(/\D/g, "").slice(-4) : "(unset)";

(async function main() {
  if (!FROM)   { console.error("REFUSED: TEST_FROM is not set."); process.exit(1); }
  if (!WO_REF) { console.error("REFUSED: --wo <work_order_ref> is required. It is NEVER discovered."); process.exit(1); }
  if (!T0)     { console.error("REFUSED: --t0 <instant> is required — it is the binding. Re-run preflight."); process.exit(1); }
  if (Number.isNaN(Date.parse(T0))) { console.error("REFUSED: --t0 is not a parseable instant."); process.exit(1); }
  if (!process.env.DATABASE_URL) { console.error("REFUSED: DATABASE_URL is not set."); process.exit(1); }

  const c = new Client({ connectionString: process.env.DATABASE_URL,
                         ssl: { rejectUnauthorized: false } });
  await c.connect();
  const ro = await beginProvenReadOnly(c, "step4_completion");
  if (!ro.ok) process.exit(await refuseNotReadOnly(c, ro.reason));

  console.log("\nSTEP 4 — HANDSET COMPLETION PROOF  (§7.4)");
  console.log("  work order #" + WO_REF + "   T0 " + T0 + "   tester " + last4(FROM));

  // ── THE BINDING ───────────────────────────────────────────────────
  sec("B · BOUND TO ONE DELIBERATE ACT");
  const wos = (await c.query(
    `select w.id, w.status, w.property_id, p.organization_id, w.work_order_ref
       from work_orders w join properties p on p.id = w.property_id
      where w.work_order_ref = $1`, [WO_REF])).rows;
  ok("B1  exactly one work order carries that reference", wos.length === 1,
     wos.length + " matched");
  if (wos.length !== 1) { await c.end(); process.exit(1); }
  const W = wos[0];

  const lines = (await c.query(
    `select id, e164 from communication_lines
      where line_type='operations' and status='active' and organization_id=$1`,
    [W.organization_id])).rows;
  ok("B2  exactly one active operations line", lines.length === 1, lines.length + " lines");
  if (lines.length !== 1) { await c.end(); process.exit(1); }
  const line = lines[0];

  const who = await resolveStaffSenderForOrganization(c, {
    organizationId: W.organization_id, fromNumber: FROM });
  ok("B3  TEST_FROM resolves to exactly one staff user", who.outcome === "one",
     "outcome: " + who.outcome);
  if (who.outcome !== "one") { await c.end(); process.exit(1); }
  const tester = who.user;

  /*  EVERY condition in one query. Not "the newest inbound message" —
     the one that postdates T0, on this line, from this tester, carrying
     the provider's own identity, and attached to THIS work order. */
  const inbound = (await c.query(
    `select id, occurred_at, sms_sid, direction, channel
       from comm_events
      where channel='sms' and direction='inbound'
        and communication_line_id = $1
        and actor_user_id = $2
        and occurred_at > $3::timestamptz
        and sms_sid is not null
      order by occurred_at asc`, [line.id, tester.id, T0])).rows;
  ok("B4  at least one bound inbound message exists after T0", inbound.length >= 1,
     "nothing arrived on the operations line from this tester after T0 — " +
     "if Twilio is unconfigured the webhook refused before writing anything");
  if (!inbound.length) { await c.end(); process.exit(1); }

  //  The message that CAUSED the completion, identified by the progress
  //  row that cites it — not by being the newest of the bound set.
  const claimRow = (await c.query(
    `select source_comm_event_id from work_order_progress
      where work_order_id=$1 and property_id=$2 and kind='completion_claimed'
        and occurred_at > $3::timestamptz
      order by occurred_at desc limit 1`, [W.id, W.property_id, T0])).rows[0] || null;
  const bound = claimRow && inbound.find((m) => String(m.id) === String(claimRow.source_comm_event_id));
  ok("B5  the completion claim cites one of those bound messages", !!bound,
     claimRow ? "the claim cites a message outside the binding" :
       "no completion_claimed row for this work order after T0");
  const sourceCommEventId = bound ? bound.id : null;
  if (bound) {
    console.log("        inbound " + bound.id + "  @ " + bound.occurred_at.toISOString());
    console.log("        provider sid present: yes");
  }

  // ── THE EIGHT FACTS ───────────────────────────────────────────────
  sec("F · THE EIGHT COMPLETION FACTS (§4) — ALL EIGHT OR NONE");
  const r = await F.checkCompletionFacts(c, {
    work_order_id: W.id, property_id: W.property_id,
    actor_user_id: tester.id, source_comm_event_id: sourceCommEventId });
  for (const f of r.facts) {
    ok(`${f.id.padEnd(4)} ${f.name}`, f.held, f.detail);
    console.log("          " + JSON.stringify(f.observed));
  }
  if (r.atomicityIndeterminate) {
    console.log("\n  NOTE  A2 is INDETERMINATE — " + r.atomicityReason + ".");
    console.log("        A1 still bounds the savepoint-free facts to one transaction.");
    console.log("        This is reported, never rounded up to a pass in the receipt.");
  }

  // ── NO PARALLEL WRITER ────────────────────────────────────────────
  sec("N · NO PARALLEL WRITER (§4.1, §19c Ruling D)");
  const n = await F.checkNoParallelWriter(c, { work_order_id: W.id, property_id: W.property_id });
  for (const f of n.facts) {
    ok(`${f.id.padEnd(4)} ${f.name}`, f.held, f.detail);
    console.log("          " + JSON.stringify(f.observed));
  }

  // ── THE OPERATOR SURFACE ──────────────────────────────────────────
  //  §7.4's last clause: "the operator surface reflects it WITHOUT
  //  operator action". Read through the real reader, inside the same
  //  read-only transaction, so this cannot itself change anything.
  sec("S · THE OPERATOR SURFACE REFLECTS IT — WITHOUT OPERATOR ACTION");
  const s = await reader.readWorkOrderStatus(c, {
    propertyId: W.property_id, workOrderId: W.id });
  ok("S1  the reader reports the work as completed",
     !!s && s.current.state === "completed", s ? s.current.state : "no status row");
  ok("S2  …and nobody had to act for that to be true",
     !!s && s.current.completed_at !== null && s.next_action === null,
     s ? JSON.stringify({ completed_at: s.current.completed_at, next: s.next_action }) : "");
  ok("S3  …the preserved evidence is visible as evidence",
     !!s && s.proof.preserved_count >= 1 && s.proof.not_preserved_count === 0,
     s ? JSON.stringify({ preserved: s.proof.preserved_count,
                          not_preserved: s.proof.not_preserved_count }) : "");

  //  The proof state depends on whether the cutover was activated. Both
  //  answers are correct; which one is expected is not this tool's guess.
  const activated = s && s.proof.read_status === "ok";
  if (activated) {
    //  `state`, never `satisfied`: the compatibility field is being
    //  retired, and this gate gets exactly one attempt.
    ok("S4  …with proof.state = 'satisfied', derived and not stored",
       s.proof.state === "satisfied",
       JSON.stringify({ read_status: s.proof.read_status, state: s.proof.state }));
  } else {
    console.log("  ·     S4  proof.read_status = 'unavailable' (" +
      (s && s.proof.reason_code) + ")");
    console.log("            Correct and expected with no cutover activation (§3.2.1):");
    console.log("            `state` and `satisfied` are ABSENT, not guessed. The §7.4");
    console.log("            surface clause is NOT discharged until Step 7 has run.");
  }

  // ── THE RECEIPT ───────────────────────────────────────────────────
  sec("RECEIPT");
  const complete = refusals === 0 && r.allHeld && n.allHeld;
  if (!complete) {
    console.log("  NO RECEIPT. " + refusals + " named fact(s) absent.");
    console.log("  A receipt that can pass with a hole in it is how a half-activated");
    console.log("  rail gets recorded as a finished one. Nothing is written down.\n");
    await c.end();
    process.exit(1);
  }
  const receipt = {
    gate: "RELEASE 0 · STEP 4 · §7.4 handset completion",
    bound: {
      work_order_ref: W.work_order_ref, work_order_id: W.id, property_id: W.property_id,
      operations_line_id: line.id, tester_user_id: tester.id,
      t0: T0, inbound_comm_event_id: sourceCommEventId,
    },
    facts: [...r.facts, ...n.facts].map((f) => ({ id: f.id, name: f.name, held: f.held })),
    atomicity: {
      parent_side_single_transaction: !r.capstoneIndeterminate,
      all_facts_one_commit: r.atomicityIndeterminate ? "INDETERMINATE" : true,
      indeterminate_reason: r.atomicityReason,
    },
    surface: {
      lifecycle_state: s.current.state,
      proof_read_status: s.proof.read_status,
      proof_state: s.proof.read_status === "ok" ? s.proof.state : null,
      preserved_count: s.proof.preserved_count,
    },
    surface_clause_discharged: !!activated,
    generated_against_ledger: (await c.query(
      `select max(version) v from schema_migrations`)).rows[0].v,
  };
  console.log(JSON.stringify(receipt, null, 2));
  console.log("\n  Every named fact held. This is the release's load-bearing proof.\n");
  if (!activated) {
    console.log("  ⚠ The SURFACE clause is not discharged: with no cutover activation the");
    console.log("    reader cannot derive a proof state. Re-run after Step 7 to close it.\n");
  }
  await c.end();
  process.exit(0);
})().catch((e) => { console.error("\nERROR: " + (e && e.message)); process.exit(1); });
