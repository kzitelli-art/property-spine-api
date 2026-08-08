#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   STEP 3 — PRECONDITION READ: WHAT THE STRICT GATE WOULD REFUSE

   Step 3 replaces the completion evidence gate. The new one is narrower
   than the old one on FOUR axes, and only ONE of them was ever counted
   in production:

     1  classification   'unclassified' no longer counts        OPEN (§3.1: 0)
     2  stored bytes     content/byte_size/sha256/stored_at     UNREPRESENTABLE
                         must all be present
     3  MIME             must be jpeg / png / webp              OPEN, NEVER COUNTED
     4  property scope   (work_order_id, property_id) together  UNREPRESENTABLE

   ── AXIS 2 CANNOT BITE, AND THAT IS A CORRECTION ────────────────────

   PR #54 said axis 2 was the dangerous one: the old gate asked only
   `storage_state='stored'`, so a row marked stored with no bytes behind
   it would have passed. That is true of the QUERY and false of the
   DATABASE. `ck_wopa_stored_is_complete` has been part of the table
   definition since 134 created it:

       (storage_state = 'stored' and content, byte_size, sha256 and
        stored_at are ALL present)  OR  (storage_state <> 'stored' and
        all four are null)

   It is a table constraint, not one added later against existing rows,
   so no such row has ever been storable. Axis 2 is unrepresentable in
   exactly the way axis 4 is. Found by trying to plant one and being
   refused by the database — which is the only way to tell an enforced
   rule from a described one.

   That leaves axes 1 and 3 genuinely open. `mime_type` carries NO check
   constraint, so axis 3 is the one nothing has ever bounded — the
   ingest path validates it in application code, which does not speak for
   rows written before that path existed.

   The counts below are kept for ALL FOUR anyway. A constraint proves
   what can be written from now on; only a count proves what is there.

   ── THE QUESTION THIS ANSWERS ───────────────────────────────────────

   Not "how many odd rows exist" — that is trivia. The question is:

       is there an OPEN work order that could be completed today, and
       could NOT be completed after Step 3?

   That set is the entire production risk of Step 3, and if it is empty
   the deploy changes no outcome for any work in flight. If it is not
   empty, each one is a technician who will be told a photo is missing
   when they believe they sent one — which is a refusal to INVESTIGATE,
   never a reason to relax the gate.

   ── READ-ONLY, PROVEN BEFORE IT READS ───────────────────────────────
   Prints counts and work-order references only. Never a phone number,
   never a media URL, never attachment bytes.

   usage (Render shell on the live service, DATABASE_URL already set):
     node tools/steps23/verify_step3_preconditions.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const path = require("path");
const { Client } = require("pg");
const { beginProvenReadOnly, refuseNotReadOnly } =
  require(path.join(__dirname, "..", "activation", "_readonly.js"));

/*  The strict gate's constants, declared here because this tool runs
 *  BEFORE Step 3 merges and cannot import them yet. If the Step 3
 *  evidence service is present, they are checked against it rather than
 *  trusted — a precondition measured against the wrong constants is
 *  worse than no measurement. */
const NEW_MIME = ["image/jpeg", "image/png", "image/webp"];
const NEW_CLASSES = ["repair_photo", "condition"];
const OLD_CLASSES = ["repair_photo", "condition", "unclassified"];

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };

(async function main() {
  if (!process.env.DATABASE_URL) { console.error("REFUSED: DATABASE_URL is not set."); process.exit(1); }

  //  Check the declared constants against Step 3's source when it exists.
  try {
    const ev = require(path.join(__dirname, "..", "..", "src/technician/evidence_service.js"));
    if (ev.COMPLETION_EVIDENCE_MIME && ev.COMPLETION_EVIDENCE_CLASSIFICATIONS) {
      const mimeMatch = JSON.stringify([...ev.COMPLETION_EVIDENCE_MIME].sort())
                     === JSON.stringify([...NEW_MIME].sort());
      const classMatch = JSON.stringify([...ev.COMPLETION_EVIDENCE_CLASSIFICATIONS].sort())
                      === JSON.stringify([...NEW_CLASSES].sort());
      if (!mimeMatch || !classMatch) {
        console.error("REFUSED: this tool's copy of the strict gate no longer matches the");
        console.error("         evidence service. Measuring against stale constants would");
        console.error("         report the wrong risk. Update the tool.");
        process.exit(2);
      }
      console.log("  (constants verified against the deployed evidence service)\n");
    }
  } catch (_) { /* pre-Step-3: the service does not export them yet */ }

  //  Neon requires TLS; the isolated harness does not offer it. Keyed off
  //  the connection string so this tool can be exercised before it is
  //  pointed at production — an untested production tool is how a
  //  hardcoded id once matched nothing and reported a clean run.
  const insecureLocal = /sslmode=disable/.test(process.env.DATABASE_URL);
  const c = new Client({ connectionString: process.env.DATABASE_URL,
                         ssl: insecureLocal ? false : { rejectUnauthorized: false } });
  await c.connect();
  const ro = await beginProvenReadOnly(c, "verify_step3_pre");
  if (!ro.ok) process.exit(await refuseNotReadOnly(c, ro.reason));

  console.log("STEP 3 — PRECONDITION READ  (read-only proven)\n");

  //  ── THE AXES, COUNTED ─────────────────────────────────────────────
  //  Every count is over rows the OLD gate accepts, because a row the old
  //  gate already refuses cannot represent a completion that stops working.
  const q = async (sql, params = []) => Number((await c.query(sql, params)).rows[0].n);

  const oldEligible = await q(
    `select count(*) n from work_order_proof_attachments
      where storage_state = 'stored' and proof_classification = any($1::text[])`, [OLD_CLASSES]);
  console.log("  attachments the OLD gate accepts: " + oldEligible + "\n");

  const axis1 = await q(
    `select count(*) n from work_order_proof_attachments
      where storage_state = 'stored' and proof_classification = 'unclassified'`);
  ok("A1  axis 1 — 'unclassified' stored attachments", axis1 === 0,
     axis1 + " exist. §3.1 recorded zero; that is no longer true.");

  const axis2 = await q(
    `select count(*) n from work_order_proof_attachments
      where storage_state = 'stored' and proof_classification = any($1::text[])
        and (content is null or byte_size is null or sha256 is null or stored_at is null)`,
    [OLD_CLASSES]);
  ok("A2  axis 2 — stored rows MISSING bytes/size/sha256/stored_at", axis2 === 0,
     axis2 + " row(s) are marked stored with no complete byte record behind them");

  const axis3 = await q(
    `select count(*) n from work_order_proof_attachments
      where storage_state = 'stored' and proof_classification = any($1::text[])
        and (mime_type is null or not (mime_type = any($2::text[])))`,
    [OLD_CLASSES, NEW_MIME]);
  ok("A3  axis 3 — stored rows with a MIME outside jpeg/png/webp", axis3 === 0,
     axis3 + " row(s) carry a MIME the strict gate does not accept");

  //  Axis 4 is structural: a composite FK on (work_order_id, property_id)
  //  into work_orders(id, property_id) makes the mismatch unrepresentable.
  //  Counted anyway — "the schema prevents it" is a claim worth checking
  //  against the rows rather than against the DDL.
  const axis4 = await q(
    `select count(*) n from work_order_proof_attachments a
       join work_orders w on w.id = a.work_order_id
      where a.property_id is distinct from w.property_id`);
  ok("A4  axis 4 — attachments whose property disagrees with their work order",
     axis4 === 0, axis4 + " exist, which the composite FK should make impossible");

  // ── THE ONLY QUESTION THAT MATTERS ─────────────────────────────────
  //  An OPEN work order with evidence the old gate accepts and the new
  //  gate does not. Anything already complete cannot regress: Step 3
  //  refuses a second completion, it does not re-evaluate the first.
  const atRisk = await c.query(
    `select w.id, w.work_order_ref, w.status,
            count(*) filter (where a.storage_state = 'stored'
              and a.proof_classification = any($1::text[]))                        as old_ok,
            count(*) filter (where a.storage_state = 'stored'
              and a.content is not null and a.byte_size is not null
              and a.sha256 is not null  and a.stored_at is not null
              and a.mime_type = any($2::text[])
              and a.proof_classification = any($3::text[]))                        as new_ok
       from work_orders w
       join work_order_proof_attachments a
         on a.work_order_id = w.id and a.property_id = w.property_id
      where w.status not in ('complete','closed')
      group by w.id, w.work_order_ref, w.status
     having count(*) filter (where a.storage_state = 'stored'
              and a.proof_classification = any($1::text[])) > 0
        and count(*) filter (where a.storage_state = 'stored'
              and a.content is not null and a.byte_size is not null
              and a.sha256 is not null  and a.stored_at is not null
              and a.mime_type = any($2::text[])
              and a.proof_classification = any($3::text[])) = 0
      order by w.work_order_ref`,
    [OLD_CLASSES, NEW_MIME, NEW_CLASSES]);

  ok("R1  NO open work order loses its ability to complete", atRisk.rows.length === 0,
     atRisk.rows.length + " open work order(s) could be completed today and could NOT " +
     "after Step 3.\n          Investigate each attachment row — do NOT relax the gate.");
  for (const r of atRisk.rows) {
    console.log(`        · #${r.work_order_ref || r.id}  status=${r.status}  ` +
                `old_ok=${r.old_ok} new_ok=${r.new_ok}`);
  }

  //  Context, not a gate: how much work is even in a position to care.
  const openWithEvidence = await q(
    `select count(distinct w.id) n from work_orders w
       join work_order_proof_attachments a on a.work_order_id = w.id
      where w.status not in ('complete','closed') and a.storage_state = 'stored'`);
  console.log("\n  open work orders holding stored evidence at all: " + openWithEvidence);

  console.log(`\n  passed ${pass}   failed ${fail}`);
  if (fail === 0) {
    console.log("\n  Step 3 changes no outcome for any work currently in flight.");
  } else {
    console.log("\n  Step 3 WOULD change an outcome. Read the rows above before deploying.");
    console.log("  A technician told a photo is missing when they sent one is a defect to");
    console.log("  investigate, never a reason to widen the gate.");
  }
  await c.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(1); });
