#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   RELEASE 0 — GATE 8, REAL-HANDSET EVIDENCE INGRESS
   and the durable-attachment / completion-safety receipt for GATE 10.

   The same discipline as the rotation proof: the positive result is
   bound to ONE deliberate act, not to "the newest rows". Both production
   lines are live — an unrelated message in the same minute must not be
   creditable as the test.

   The binding, every condition in one query:

     comm_event      channel sms · direction inbound · occurred_at > T0
                     communication_line_id = the operations line
                     actor_user_id        = the verified tester
                     sms_sid              present (the provider's identity)

     attachment      work_order_id        = work order 1006
                     source_comm_event_id = that comm_event
                     uploaded_by_user_id  = the tester
                     provider twilio · provider_media_id present
                     storage_state stored · content/byte_size/sha256/
                     stored_at all present · verified MIME in the three

   PRESENCE ≠ CONTENTS: storage_state='stored' has a database constraint
   guaranteeing the other fields, and every field is still asserted
   individually — the receipt records what was OBSERVED, not what a
   constraint implies.

   Completion safety is ABSOLUTE, not a delta: work order 1006 has never
   had a completion fact, so after the photo the counts must still be
   zero and the status still open. --before proves the baseline is
   already zero, so nothing needs to be carried between the two runs.

   ── WHAT IS NEVER PRINTED ───────────────────────────────────────────
   phone numbers (last4 only) · media URLs · image bytes · credentials.
   sha256 and byte size ARE printed — they are the durable evidence.

   usage (Render shell):
     STEP 1   TEST_FROM='+1XXXXXXXXXX' node tools/activation/evidence_ingress_proof.js --before
     STEP 2   from the tester handset, send ONE photo, referencing 1006,
              with NO completion language  ("wo 1006 valve photo" is fine)
     STEP 3   TEST_FROM='+1XXXXXXXXXX' node tools/activation/evidence_ingress_proof.js \
                --verify --t0 '<T0 from step 1>'
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const path = require("path");
const { Client } = require("pg");
const { beginProvenReadOnly, refuseNotReadOnly } = require("./_readonly.js");
const { resolveStaffSenderForOrganization } =
  require(path.join(__dirname, "..", "..", "src", "comms", "communication_lines.js"));

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const arg = (f) => { const i = argv.indexOf(f); return i > -1 ? argv[i + 1] : null; };
const FROM = process.env.TEST_FROM;
const WO_REF = 1006;
const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"];
const MAX = 5 * 1024 * 1024;

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };
const sec = (t) => console.log(`\n${"═".repeat(64)}\n  ${t}\n${"═".repeat(64)}`);
const last4 = (n) => n ? "****" + String(n).replace(/\D/g, "").slice(-4) : "(unset)";

/*  The three anchors every mode needs: the work order, its derived
 *  organization, the active operations line, the resolved tester. */
async function anchors(c) {
  const wo = (await c.query(
    `select w.id, w.status, w.property_id, p.organization_id
       from work_orders w join properties p on p.id = w.property_id
      where w.work_order_ref = $1`, [WO_REF])).rows;
  if (wo.length !== 1) return { err: wo.length + " work orders carry ref " + WO_REF };
  const W = wo[0];

  const lines = (await c.query(
    `select id, e164 from communication_lines
      where line_type = 'operations' and status = 'active' and organization_id = $1
      order by id`, [W.organization_id])).rows;
  if (lines.length !== 1) return { err: lines.length + " active operations lines for the organization" };

  const who = await resolveStaffSenderForOrganization(c, {
    organizationId: W.organization_id, fromNumber: FROM });
  if (who.outcome !== "one") return { err: "tester resolution outcome: " + who.outcome };

  const obligation = (await c.query(
    `select id from obligations
      where related_type = 'work_order' and related_id = $1 and property_id = $2
      order by created_at asc limit 1`, [W.id, W.property_id])).rows[0] || null;

  return { W, line: lines[0], tester: who.user, obligation };
}

async function census(c, W, lineId) {
  const q = async (s, a) => Number(Object.values((await c.query(s, a)).rows[0])[0]);
  return {
    line_inbound: await q(
      `select count(*) from comm_events
        where channel='sms' and direction='inbound' and communication_line_id=$1`, [lineId]),
    attachments: await q(
      `select count(*) from work_order_proof_attachments where work_order_id=$1`, [W.id]),
    stored: await q(
      `select count(*) from work_order_proof_attachments
        where work_order_id=$1 and storage_state='stored'`, [W.id]),
    completed: await q(
      `select count(*) from work_order_progress where work_order_id=$1 and kind='completed'`, [W.id]),
    claimed: await q(
      `select count(*) from work_order_progress where work_order_id=$1 and kind='completion_claimed'`, [W.id]),
    status: (await c.query(`select status from work_orders where id=$1`, [W.id])).rows[0].status,
  };
}

(async function main() {
  if (!FROM) { console.error("REFUSED: TEST_FROM is not set."); process.exit(1); }
  if (!process.env.DATABASE_URL) { console.error("REFUSED: DATABASE_URL is not set."); process.exit(1); }

  const c = new Client({ connectionString: process.env.DATABASE_URL,
                         ssl: { rejectUnauthorized: false } });
  await c.connect();
  const ro = await beginProvenReadOnly(c, "evidence_ingress");
  if (!ro.ok) process.exit(await refuseNotReadOnly(c, ro.reason));

  const a = await anchors(c);
  if (a.err) {
    console.error("\n  REFUSED: " + a.err);
    console.error("  Gate 4 must pass before Gate 8 is attempted.");
    await c.end(); process.exit(1);
  }
  const { W, line, tester, obligation } = a;

  if (has("--before")) {
    const t0 = (await c.query("select now() as t")).rows[0].t.toISOString();
    const c0 = await census(c, W, line.id);
    sec("GATE 8 — STEP 1 of 3.  NOTHING HAS BEEN SENT YET.");
    console.log("  T0              " + t0 + "   (database time)");
    console.log("  work_order_id   " + W.id);
    console.log("  operations line " + line.id + "  (" + last4(line.e164) + ")");
    console.log("  tester user_id  " + tester.id + "  (" + last4(FROM) + ")");
    console.log("  census          " + JSON.stringify(c0));
    ok("B1  work order " + WO_REF + " is open", c0.status === "open", c0.status);
    ok("B2  completion baseline is already zero (completed)", c0.completed === 0, String(c0.completed));
    ok("B3  completion baseline is already zero (claimed)", c0.claimed === 0, String(c0.claimed));
    console.log("\n  Now, from the tester handset, send ONE photo to the operations");
    console.log("  number. The text must reference " + WO_REF + " and contain NO completion");
    console.log("  language — no done, complete, finished, or equivalent.");
    console.log("\n  Then:");
    console.log("    TEST_FROM='<tester phone>' node tools/activation/evidence_ingress_proof.js \\");
    console.log(`      --verify --t0 '${t0}'`);
    await c.end();
    process.exit(fail === 0 ? 0 : 1);
  }

  if (has("--verify")) {
    const t0 = arg("--t0");
    if (!t0) { console.error("REFUSED: --t0 is required — it is what makes the proof bound."); process.exit(1); }

    sec("GATE 8 — THE BOUND COMMUNICATION EVENT");
    const evs = (await c.query(
      `select id, occurred_at, sms_sid, body
         from comm_events
        where channel = 'sms' and direction = 'inbound'
          and communication_line_id = $1
          and actor_user_id = $2
          and occurred_at > $3::timestamptz
          and sms_sid is not null
        order by occurred_at asc`, [line.id, tester.id, t0])).rows;
    ok("V1  exactly ONE bound inbound event from the tester after T0",
       evs.length === 1,
       evs.length === 0
         ? "no matching event — not restarted? signature failing? wrong number?"
         : evs.length + " events match — the run is ambiguous; re-run --before and send once");
    const E = evs[0] || null;
    if (E) {
      console.log("  comm_event_id   " + E.id);
      console.log("  occurred_at     " + E.occurred_at.toISOString());
      console.log("  provider sid    " + (E.sms_sid ? "present" : "MISSING"));
      const lower = String(E.body || "").toLowerCase();
      const completionWords = ["done", "complete", "completed", "finished", "finish"]
        .filter((w) => new RegExp("\\b" + w + "\\b").test(lower));
      ok("V2  the message carries NO completion language", completionWords.length === 0,
         "found: " + completionWords.join(", ") + " — the test subject is evidence, not completion");
    }

    sec("THE DURABLE ATTACHMENT");
    const atts = E ? (await c.query(
      `select * from work_order_proof_attachments
        where work_order_id = $1 and source_comm_event_id = $2
        order by received_at asc`, [W.id, E.id])).rows : [];
    ok("A1  exactly ONE attachment from that event, on work order " + WO_REF,
       atts.length === 1, String(atts.length));
    const A = atts[0] || null;
    if (A) {
      ok("A2  provider is twilio", A.provider === "twilio", String(A.provider));
      ok("A3  provider media identity present", !!A.provider_media_id);
      ok("A4  storage_state is stored — not referenced, not fetch_failed",
         A.storage_state === "stored", A.storage_state);
      ok("A5  content bytes present", A.content !== null && A.content !== undefined);
      ok("A6  byte_size > 0 and <= 5 MiB",
         Number(A.byte_size) > 0 && Number(A.byte_size) <= MAX, String(A.byte_size));
      ok("A7  sha256 present", typeof A.sha256 === "string" && /^[0-9a-f]{64}$/.test(A.sha256),
         String(A.sha256).slice(0, 20));
      ok("A8  stored_at present", !!A.stored_at);
      ok("A9  verified MIME is one of " + ALLOWED_MIME.join(" | "),
         ALLOWED_MIME.includes(A.mime_type), A.mime_type);
      ok("A10 uploaded by the verified tester", A.uploaded_by_user_id === tester.id,
         String(A.uploaded_by_user_id));
      ok("A11 attachment property matches the work order", A.property_id === W.property_id,
         String(A.property_id));
    }

    // ── OUTBOUND HONESTY — reported, never asserted ────────────────────
    //  The operations turn may create a reply intent on this reply_only
    //  line. Twilio ACCEPTING a message is not a handset RECEIVING one —
    //  "accepted ≠ delivered" is the same truth-telling distinction the
    //  rest of Spine is built on, so the receipt records what happened
    //  and claims nothing more. None of this can fail the run: outbound
    //  delivery is an observable operating fact, not a Gate 8 condition.
    sec("OUTBOUND REPLY — observed, not required");
    const outs = (await c.query(
      `select id, sms_status, provider_status, (sms_sid is not null) as has_sid
         from comm_events
        where channel = 'sms' and direction = 'outbound'
          and communication_line_id = $1 and occurred_at > $2::timestamptz
        order by occurred_at asc`, [line.id, t0])).rows;
    if (outs.length === 0) {
      console.log("  no outbound reply intent recorded on this line in the window");
    } else {
      for (const o of outs) {
        const st = o.provider_status || o.sms_status || "(no provider status)";
        console.log("  reply intent " + o.id);
        console.log("    provider accepted   " + (o.has_sid ? "yes (sid present)" : "no sid recorded"));
        console.log("    provider status     " + st);
        console.log("    handset delivery    " + (/^delivered$/i.test(String(st))
          ? "delivery receipt present"
          : "NOT CLAIMED — no delivery receipt"));
      }
    }

    sec("COMPLETION SAFETY — the photo changed nothing");
    const c1 = await census(c, W, line.id);
    ok("S1  status unchanged — still open", c1.status === "open", c1.status);
    ok("S2  completed progress events still ZERO", c1.completed === 0, String(c1.completed));
    ok("S3  completion claims still ZERO", c1.claimed === 0, String(c1.claimed));
    const evalTable = (await c.query(
      `select count(*) n from information_schema.tables
        where table_schema='public' and table_name='work_order_proof_evaluations'`)).rows[0].n;
    ok("S4  proof-evaluation table still absent (migration 137 has not run)",
       Number(evalTable) === 0, "the table EXISTS — a migration ran; stop");

    sec("GATE 10 RECEIPT FIELDS");
    if (fail === 0 && E && A) {
      console.log("  provider MessageSid       " + E.sms_sid);
      console.log("  communication event ID    " + E.id);
      console.log("  work order ID             " + W.id);
      console.log("  obligation ID             " + (obligation ? obligation.id : "(none)"));
      console.log("  attachment ID             " + A.id);
      console.log("  storage state             " + A.storage_state);
      console.log("  verified MIME             " + A.mime_type);
      console.log("  byte size                 " + A.byte_size);
      console.log("  sha256                    " + A.sha256);
      console.log("  stored at                 " + A.stored_at.toISOString());
      console.log("  tester user ID            " + tester.id);
      console.log("  operations line ID        " + line.id);
      console.log("  organization ID           " + W.organization_id);
      console.log("  property ID               " + W.property_id);
      console.log("  status before/after       open / " + c1.status);
      console.log("  completed before/after    0 / " + c1.completed);
      console.log("  claims before/after       0 / " + c1.claimed);
      console.log("  phone value recorded      no");
      console.log("  media URL recorded        no");
      console.log("  image bytes recorded      no");
    } else {
      console.log("  (withheld — receipt fields are only printed from a clean pass)");
    }

    sec("VERDICT");
    console.log(`  passed ${pass}   failed ${fail}`);
    console.log(fail === 0
      ? "\n  EVIDENCE INGRESS PROVEN — durable attachment exists, completion is untouched."
      : "\n  NOT PROVEN. Fix the failure and re-run --before; a fresh T0 keeps the binding honest.");
    await c.end();
    process.exit(fail === 0 ? 0 : 1);
  }

  console.error("usage: evidence_ingress_proof.js --before");
  console.error("       evidence_ingress_proof.js --verify --t0 <iso>");
  process.exit(1);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(1); });
