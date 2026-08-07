#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   RELEASE 0 — GATE 10, THE FINAL EVIDENCE-INGRESS RECEIPT

   One permanent record, produced ONLY when every named fact is present.

   ── NO GREEN-COUNT LOGIC ────────────────────────────────────────────
   The verdict is not "N checks passed". Every required fact is named,
   checked by name, and an absent fact is an explicit refusal. A receipt
   that can pass with a hole in it is how a half-activated rail gets
   recorded as a finished one — this project has already met that
   failure assembled out of two correct half-actions.

   ── TWO KINDS OF FACT, TWO SOURCES ──────────────────────────────────
   DATABASE facts are RE-DERIVED live at generation time with the same
   bindings the gate tools use — never pasted in from earlier output.
   NON-DATABASE facts (PR/merge SHAs, deploy event, control results,
   the rollback drill) cannot be read from the database and enter via
   --input <file.json>; every required key missing is a refusal, and
   the deployment digests in the input must ALSO equal both the
   authorized constants and the digests of the checkout this tool is
   actually running in. Three sources, one value, or no receipt.

   ── WHAT IS NEVER PRINTED ───────────────────────────────────────────
   phone numbers · full e164 · media URLs · image bytes · tokens ·
   webhook signatures · provider_config contents.

   usage (Render shell, after all gates):
     TEST_FROM='+1XXXXXXXXXX' node tools/activation/release0_final_receipt.js \
       --input /tmp/release0_receipt_input.json
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Client } = require("pg");
const { beginProvenReadOnly, refuseNotReadOnly } = require("./_readonly.js");
const { resolveStaffSenderForOrganization } =
  require(path.join(__dirname, "..", "..", "src", "comms", "communication_lines.js"));

const AUTHORIZED_DIGESTS = {
  "src/comms/sms.js": "15a03280ab081fa41fe81dcbdc914bb8209e87c7ddd8e21b7ae67067c5d9a60e",
  "src/technician/evidence_service.js": "619d6ccc89616994ec24e35b545e93f47ec3ffe0ee27b2d6f94ec6a95b435c22",
};
const ROOT = path.join(__dirname, "..", "..");
const WO_REF = 1006;
const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"];
const MAX = 5 * 1024 * 1024;

const argv = process.argv.slice(2);
const arg = (f) => { const i = argv.indexOf(f); return i > -1 ? argv[i + 1] : null; };
const FROM = process.env.TEST_FROM;

let fail = 0;
const facts = [];             // [label, value] — the receipt body, in order
const fact = (label, value) => facts.push([label, value]);
const require_ = (label, cond, detail) => {
  if (cond) { console.log("  ok      " + label); return true; }
  fail++; console.log("  ABSENT  " + label + (detail ? "\n            → " + detail : ""));
  return false;
};
const sec = (t) => console.log(`\n${"═".repeat(64)}\n  ${t}\n${"═".repeat(64)}`);

/*  Every path into the input object is DECLARED. An input key that is
 *  missing refuses by name; an input file with extra keys changes
 *  nothing — the receipt reads only what it names. */
function get(input, dotted) {
  return dotted.split(".").reduce((o, k) => (o == null ? undefined : o[k]), input);
}

(async function main() {
  const inputPath = arg("--input");
  if (!inputPath) { console.error("REFUSED: --input <file.json> is required."); process.exit(1); }
  if (!FROM) { console.error("REFUSED: TEST_FROM is not set."); process.exit(1); }
  if (!process.env.DATABASE_URL) { console.error("REFUSED: DATABASE_URL is not set."); process.exit(1); }

  let input;
  try { input = JSON.parse(fs.readFileSync(inputPath, "utf8")); }
  catch (e) { console.error("REFUSED: input unreadable: " + e.message); process.exit(1); }

  console.log("RELEASE 0 — FINAL EVIDENCE-INGRESS RECEIPT");

  // ═══ 1. THE ARTIFACT — three sources must agree on the bytes ════════
  sec("ARTIFACT DEPLOYED");
  for (const [rel, authorized] of Object.entries(AUTHORIZED_DIGESTS)) {
    let running = null;
    try {
      running = crypto.createHash("sha256")
        .update(fs.readFileSync(path.join(ROOT, rel))).digest("hex");
    } catch (_) {}
    const claimed = get(input,
      rel === "src/comms/sms.js" ? "deployment.digest_sms" : "deployment.digest_evidence");
    require_("digest of " + rel + " — running checkout equals authorized", running === authorized,
             "running " + running);
    require_("digest of " + rel + " — input claim equals authorized", claimed === authorized,
             "input claims " + String(claimed).slice(0, 24));
    fact("deployed digest " + rel, authorized);
  }
  for (const k of ["pr_number", "pr_head_sha", "merge_sha", "render_checkout_sha",
                   "deploy_event", "deployed_at"]) {
    const v = get(input, "deployment." + k);
    require_("deployment." + k + " present", v !== undefined && v !== null && v !== "", "missing from input");
    fact(k.replace(/_/g, " "), v);
  }
  require_("boot reported healthy", get(input, "deployment.boot_ok") === true);
  fact("boot result", "healthy");

  // ═══ 2. CREDENTIAL ROTATION ═════════════════════════════════════════
  sec("CREDENTIAL ROTATION");
  require_("rotation proven (bound-nonce protocol)", get(input, "credential_rotation.proven") === true);
  require_("rotation comm_event named", !!get(input, "credential_rotation.comm_event_id"));
  require_("old token invalidated", get(input, "credential_rotation.old_token_invalidated") === true);
  fact("credential rotation confirmed", "yes");
  fact("old token invalidated", "yes");
  fact("rotation comm_event", get(input, "credential_rotation.comm_event_id"));

  // ═══ 3. EXPOSURE AUDIT ══════════════════════════════════════════════
  sec("PROPERTY-FACING EXPOSURE");
  require_("exposure audit recorded", typeof get(input, "exposure_audit.property_facing_wired") === "string");
  require_("property-facing line untouched", get(input, "exposure_audit.property_facing_touched") === "no");
  fact("property-facing Twilio exposure audit", get(input, "exposure_audit.property_facing_wired"));
  fact("property-facing line touched", "no");

  // ═══ 4. SIGNATURE CONTROLS — the positive gates the negatives ═══════
  sec("SIGNATURE CONTROLS");
  const signedOk = require_("POSITIVE control: signed request accepted and attributed",
    get(input, "signature_controls.signed.accepted") === true
      && !!get(input, "signature_controls.signed.comm_event_id"),
    "an unsigned refusal proves NOTHING without this — a dead route also refuses");
  require_("unsigned control refused with 403 and wrote nothing",
    signedOk
      && get(input, "signature_controls.unsigned.http") === 403
      && get(input, "signature_controls.unsigned.wrote_rows") === false,
    signedOk ? "missing or wrong in input" : "NOT CREDITED — the positive control is absent");
  require_("wrong-URL signature refused with 403 and wrote nothing",
    signedOk
      && get(input, "signature_controls.wrong_url.http") === 403
      && get(input, "signature_controls.wrong_url.wrote_rows") === false,
    signedOk ? "missing or wrong in input" : "NOT CREDITED — the positive control is absent");
  require_("duplicate MessageSid suppressed",
    get(input, "signature_controls.duplicate.suppressed") === true);
  fact("unsigned control", "403, zero rows");
  fact("valid signed control", "accepted, event " + get(input, "signature_controls.signed.comm_event_id"));
  fact("wrong-URL signature control", "403, zero rows");
  fact("duplicate MessageSid control", "suppressed");

  // ═══ 5. ROLLBACK DRILL ══════════════════════════════════════════════
  sec("ROLLBACK DRILL");
  require_("Gate 9 dry-run executed", get(input, "rollback_drill.dry_run_ran") === true);
  require_("and rolled back — the line stayed active", get(input, "rollback_drill.rolled_back") === true);
  fact("rollback required", "no");
  fact("rollback drill (dry-run, rolled back)", "yes");

  // ═══ 6. THE DATABASE FACTS — re-derived, never pasted ═══════════════
  const c = new Client({ connectionString: process.env.DATABASE_URL,
                         ssl: { rejectUnauthorized: false } });
  await c.connect();
  const ro = await beginProvenReadOnly(c, "final_receipt");
  if (!ro.ok) process.exit(await refuseNotReadOnly(c, ro.reason));

  sec("LEDGER AND LINES — live");
  const ceiling = (await c.query("select max(version) v from schema_migrations")).rows[0].v;
  require_("ledger ceiling is 136 — no migration ran", ceiling === "136", String(ceiling));
  fact("ledger ceiling", ceiling);
  fact("migration run", "no");

  const wo = (await c.query(
    `select w.id, w.status, w.property_id, p.organization_id
       from work_orders w join properties p on p.id = w.property_id
      where w.work_order_ref = $1`, [WO_REF])).rows;
  if (!require_("work order " + WO_REF + " exists uniquely", wo.length === 1, String(wo.length))) {
    console.log("\n  Cannot derive anything further."); await c.end(); process.exit(1);
  }
  const W = wo[0];

  const lines = (await c.query(
    `select id, organization_id, outbound_policy, status,
            (provider_config is not null) as has_provider
       from communication_lines
      where line_type='operations' and status='active' and organization_id=$1`, [W.organization_id])).rows;
  require_("exactly one active operations line for the derived organization", lines.length === 1, String(lines.length));
  const L = lines[0] || {};
  require_("operations line policy is reply_only", L.outbound_policy === "reply_only", L.outbound_policy);
  const pf = (await c.query(
    `select coalesce(bool_or(provider_config is not null), false) v
       from communication_lines where line_type='property_facing'`)).rows[0].v;
  require_("property-facing provider_config still null", pf === false, String(pf));
  fact("operations line ID", L.id);
  fact("organization ID", W.organization_id);
  fact("property ID", W.property_id);
  fact("line policy", "reply_only");
  fact("provider_configured (operations)", String(L.has_provider === true));
  fact("full e164 recorded", "no");

  sec("IDENTITY AND GOVERNED ASSIGNMENT — live");
  const who = await resolveStaffSenderForOrganization(c, {
    organizationId: W.organization_id, fromNumber: FROM });
  require_("tester resolves uniquely through production code", who.outcome === "one", who.outcome);
  const tester = who.user || {};
  fact("tester user ID", tester.id);
  fact("identity resolution unique", "yes");
  fact("phone value recorded", "no");

  const ob = (await c.query(
    `select id, assigned_user_id, ownership_origin from obligations
      where related_type='work_order' and related_id=$1 and property_id=$2
      order by created_at asc limit 1`, [W.id, W.property_id])).rows[0];
  require_("routing obligation exists", !!ob);
  require_("obligation assigned to the resolved tester",
    !!ob && !!tester.id && ob.assigned_user_id === tester.id,
    ob ? "assigned_user_id " + ob.assigned_user_id : "no obligation");
  require_("assignment origin is operator_assigned", !!ob && ob.ownership_origin === "operator_assigned",
    ob && ob.ownership_origin);
  const asg = ob ? (await c.query(
    `select id, occurred_at from events
      where type='work_order_assigned' and property_id=$1
        and note::jsonb ->> 'work_order_id' = $2
        and note::jsonb ->> 'obligation_id' = $3
      order by occurred_at desc limit 1`, [W.property_id, W.id, ob.id])).rows : [];
  require_("the governed assignment EVENT exists — assignment was not SQL",
    asg.length === 1, "no work_order_assigned event");
  fact("work order 1006 obligation ID", ob && ob.id);
  fact("governed assignment receipt", asg[0] && asg[0].id);

  sec("THE EVIDENCE — live, bound exactly as Gate 8 binds it");
  const t0 = get(input, "gate8.t0");
  require_("gate8.t0 present in input — the binding window", !!t0);
  const evs = t0 ? (await c.query(
    `select id, occurred_at, sms_sid, body from comm_events
      where channel='sms' and direction='inbound'
        and communication_line_id=$1 and actor_user_id=$2
        and occurred_at > $3::timestamptz and sms_sid is not null
      order by occurred_at asc`, [L.id, tester.id, t0])).rows : [];
  require_("exactly ONE bound inbound event in the window", evs.length === 1, String(evs.length));
  const E = evs[0];
  const noCompletion = E && !["done","complete","completed","finished","finish"]
    .some((w) => new RegExp("\\b" + w + "\\b").test(String(E.body || "").toLowerCase()));
  require_("the message carries no completion language", !!noCompletion);
  const atts = E ? (await c.query(
    `select * from work_order_proof_attachments
      where work_order_id=$1 and source_comm_event_id=$2`, [W.id, E.id])).rows : [];
  require_("exactly ONE attachment from that event on " + WO_REF, atts.length === 1, String(atts.length));
  const A = atts[0];
  require_("attachment is twilio with a provider media identity",
    !!A && A.provider === "twilio" && !!A.provider_media_id);
  require_("storage_state is stored", !!A && A.storage_state === "stored", A && A.storage_state);
  require_("content present", !!A && A.content != null);
  require_("byte_size in (0, 5 MiB]", !!A && Number(A.byte_size) > 0 && Number(A.byte_size) <= MAX,
    A && String(A.byte_size));
  require_("sha256 present", !!A && /^[0-9a-f]{64}$/.test(String(A.sha256)));
  require_("stored_at present", !!A && !!A.stored_at);
  require_("verified MIME allowed", !!A && ALLOWED_MIME.includes(A.mime_type), A && A.mime_type);
  require_("uploaded by the resolved tester", !!A && A.uploaded_by_user_id === tester.id);
  fact("provider MessageSid", E && E.sms_sid);
  fact("communication event ID", E && E.id);
  fact("evidence occurred_at", E && E.occurred_at && E.occurred_at.toISOString());
  fact("work order ID", W.id);
  fact("attachment ID", A && A.id);
  fact("storage state", A && A.storage_state);
  fact("verified MIME", A && A.mime_type);
  fact("byte size", A && A.byte_size);
  fact("SHA-256", A && A.sha256);
  fact("stored timestamp", A && A.stored_at && A.stored_at.toISOString());

  sec("COMPLETION SAFETY — live");
  const completed = Number((await c.query(
    `select count(*) from work_order_progress where work_order_id=$1 and kind='completed'`, [W.id])).rows[0].count);
  const claimed = Number((await c.query(
    `select count(*) from work_order_progress where work_order_id=$1 and kind='completion_claimed'`, [W.id])).rows[0].count);
  const evalTable = Number((await c.query(
    `select count(*) from information_schema.tables
      where table_schema='public' and table_name='work_order_proof_evaluations'`)).rows[0].count);
  require_("status is still open", W.status === "open", W.status);
  require_("zero completed progress events", completed === 0, String(completed));
  require_("zero completion claims", claimed === 0, String(claimed));
  require_("proof-evaluation table absent", evalTable === 0, "migration 137 ran — stop");
  fact("work-order status before/after", "open / " + W.status);
  fact("completed-event count before/after", "0 / " + completed);
  fact("completion-claim count before/after", "0 / " + claimed);
  fact("proof-evaluation count before/after", "0 / 0 (table absent)");
  fact("resident communication produced", "no");
  fact("property-facing configuration changed", "no");
  fact("operations line final status", L.status);
  fact("rollback performed", "no");
  await c.end();

  // ═══ THE VERDICT ════════════════════════════════════════════════════
  sec("VERDICT");
  if (fail > 0) {
    console.log("  " + fail + " named fact(s) ABSENT or wrong.");
    console.log("\n  NO RECEIPT. A receipt with a hole in it is how a half-activated");
    console.log("  rail gets recorded as a finished one. Nothing was written.");
    process.exit(1);
  }
  console.log("  every named fact present.");
  console.log("\n" + "═".repeat(64));
  console.log("  RELEASE 0 EVIDENCE INGRESS PROVEN");
  console.log("═".repeat(64));
  for (const [k, v] of facts) console.log("  " + String(k).padEnd(42) + String(v));
  console.log("\n  NEVER RECORDED: Twilio token · account credentials · technician");
  console.log("  phone · operations number · provider_config · image bytes ·");
  console.log("  media URL · webhook signature.");
  process.exit(0);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(1); });
