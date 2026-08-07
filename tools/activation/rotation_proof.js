#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   RELEASE 0 — TOKEN ROTATION, POSITIVELY PROVEN

   ⚠ WHY THIS EXISTS AS A TOOL AND NOT AS INSTRUCTIONS
   The obvious proof — "text the number, then look at the newest SMS
   rows" — is WRONG here. Both production lines are live. An unrelated
   resident message arriving in the same minute would look exactly like a
   successful rotation. That is a false positive on a security control,
   run under time pressure, during an outage window.

   The proof is bound to ONE deliberately unique message:

     a NEW comm_events row
     direction   = inbound
     channel     = sms
     occurred_at > T0            captured BEFORE promotion
     body        = the exact nonce
     sms_sid     is not null     the provider's own identity

   An old row, an outbound row, or an unrelated resident SMS does not
   count. No matching row means rotation is NOT proven.

   ── THE NONCE IS NOT A SECRET, AND IS NOT KEPT ──────────────────────
   It identifies one message. It is printed here so it can be sent, and
   it is deliberately absent from the receipt fields, because the receipt
   records that a message was attributed — not what it said.

   usage, in the Render shell:

     STEP 1, BEFORE promoting the token
       node tools/activation/rotation_proof.js --before

     STEP 2, after Render restarts, send the nonce from the tester handset

     STEP 3
       node tools/activation/rotation_proof.js --verify \
         --t0 '<T0 from step 1>' --nonce '<nonce from step 1>'
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const crypto = require("crypto");
const { Client } = require("pg");
const { beginProvenReadOnly, refuseNotReadOnly } = require("./_readonly.js");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const arg = (f) => { const i = argv.indexOf(f); return i > -1 ? argv[i + 1] : null; };

async function db() {
  if (!process.env.DATABASE_URL) { console.error("REFUSED: DATABASE_URL is not set."); process.exit(1); }
  const c = new Client({ connectionString: process.env.DATABASE_URL,
                         ssl: { rejectUnauthorized: false } });
  await c.connect();

  //  This tool only ever reads. Prove that against the open transaction
  //  BEFORE reading, so the proof is a property of the session and not a
  //  claim about the source.
  const ro = await beginProvenReadOnly(c, "rotation_proof");
  if (!ro.ok) process.exit(await refuseNotReadOnly(c, ro.reason));
  return c;
}

(async function main() {
  if (has("--before")) {
    const c = await db();
    //  DATABASE time, not this process's clock. The comparison later is
    //  against occurred_at, which the database writes.
    const t0 = (await c.query("select now() as t0")).rows[0].t0.toISOString();
    const nonce = "R0 ROTATION CHECK " + crypto.randomBytes(4).toString("hex").toUpperCase();

    //  Recorded so the verify step can prove the row is NEW rather than
    //  merely present.
    const before = (await c.query(
      "select count(*) n from comm_events where channel='sms' and direction='inbound'")).rows[0].n;

    console.log("═".repeat(64));
    console.log("  ROTATION PROOF — STEP 1 of 3.  NOTHING HAS ROTATED YET.");
    console.log("═".repeat(64));
    console.log("\n  T0     " + t0);
    console.log("  NONCE  " + nonce);
    console.log("  inbound sms rows before: " + before);
    console.log("\n  Keep both values. Then, IN THIS ORDER:");
    console.log("    1  promote the secondary token to Primary in Twilio");
    console.log("       ⚠ the exposed token dies at this instant");
    console.log("    2  update TWILIO_AUTH_TOKEN in Render and let it restart");
    console.log("    3  wait for a healthy restart");
    console.log("    4  from the authorized operations-line tester handset, send");
    console.log("       EXACTLY this text:\n");
    console.log("         " + nonce + "\n");
    console.log("    5  node tools/activation/rotation_proof.js --verify \\");
    console.log(`         --t0 '${t0}' --nonce '${nonce}'`);
    await c.end();
    return;
  }

  if (has("--verify")) {
    const t0 = arg("--t0"), nonce = arg("--nonce");
    if (!t0 || !nonce) { console.error("REFUSED: --t0 and --nonce are both required."); process.exit(1); }
    const c = await db();

    //  Every condition in ONE query. A row that satisfies four of five is
    //  not partial evidence — it is a different message.
    const { rows } = await c.query(
      `select id, occurred_at, direction, channel, (sms_sid is not null) as has_sid
         from comm_events
        where channel = 'sms'
          and direction = 'inbound'
          and occurred_at > $1::timestamptz
          and body = $2
          and sms_sid is not null
        order by occurred_at asc`, [t0, nonce]);

    console.log("═".repeat(64));
    console.log("  ROTATION PROOF — VERIFY");
    console.log("═".repeat(64));

    if (rows.length === 0) {
      //  Say WHY it failed, precisely, without widening the proof.
      const anyNew = (await c.query(
        `select count(*) n from comm_events
          where channel='sms' and occurred_at > $1::timestamptz`, [t0])).rows[0].n;
      console.log("\n  ROTATION NOT PROVEN\n");
      console.log("  No inbound sms row after T0 carries that exact nonce with a provider sid.");
      console.log("  Other sms rows since T0: " + anyNew
                  + (Number(anyNew) > 0 ? "   ← unrelated traffic, NOT evidence" : ""));
      console.log("\n  Most likely causes, in order:");
      console.log("    · Render has not finished restarting with the new token");
      console.log("    · TWILIO_AUTH_TOKEN in Render does not match the promoted Primary");
      console.log("    · the text was sent to the wrong number, or altered in transit");
      console.log("    · signature validation is failing → the route 403s and writes nothing");
      console.log("\n  The old token is already dead. There is no rollback to it.");
      console.log("  Re-check the Render value and restart, then send the nonce again.");
      await c.end();
      process.exit(1);
    }

    if (rows.length > 1) {
      console.log("\n  ⚠ " + rows.length + " matching rows — the nonce was sent more than once.");
      console.log("  Using the FIRST. Rotation is proven either way.");
    }

    const r = rows[0];
    console.log("\n  ROTATION PROVEN\n");
    console.log("  A signed inbound message was accepted and attributed AFTER promotion.");
    console.log("  That is only possible if the running server holds the new Primary token.");
    console.log("\n  RECEIPT FIELDS — record these, and nothing else:\n");
    console.log("    comm_event_id     " + r.id);
    console.log("    occurred_at       " + r.occurred_at.toISOString());
    console.log("    direction         " + r.direction);
    console.log("    channel           " + r.channel);
    console.log("    sms_sid present   " + (r.has_sid ? "yes" : "no"));
    console.log("\n  The message body is deliberately NOT a receipt field. The receipt");
    console.log("  records that a message was attributed, not what it said.");
    await c.end();
    return;
  }

  console.error("usage: rotation_proof.js --before");
  console.error("       rotation_proof.js --verify --t0 <iso> --nonce <text>");
  process.exit(1);
})().catch(e => { console.error("\nERROR: " + (e.code || e.message)); process.exit(1); });
