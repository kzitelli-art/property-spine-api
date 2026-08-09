#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   THE RELEASE 0 ACCEPTANCE RECEIPT

   One artifact that states, FROM EVIDENCE, what Release 0 actually did to
   a database. Not a plan, not a checklist — a reading.

       node tools/release0/acceptance_receipt.js            # human
       node tools/release0/acceptance_receipt.js --json     # durable

   ── READ-ONLY, BY CONSTRUCTION ──────────────────────────────────────

   Same discipline as the preflight: everything runs inside
   `BEGIN TRANSACTION READ ONLY`, enforced by the server, then rolled
   back. A receipt that could change what it describes is not a receipt.

   ── IT REFUSES TO ASSERT WHAT IT CANNOT READ ────────────────────────

   Every field is either a fact this run observed or the word UNKNOWN with
   the reason. There is no field that defaults to a hopeful value. In
   particular the RUNNING SHA is a property of the process: run this ON the
   deployed instance or it says so.

   ── AND IT NAMES ITS OWN DEBT ───────────────────────────────────────

   The last section is the proof debt that is NOT dischargeable from a
   database read — the handset completion, the browser verification. A
   receipt that quietly omitted them would read as completeness.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Client } = require("pg");

const ROOT = path.join(__dirname, "..", "..");
const FROZEN = JSON.parse(fs.readFileSync(
  path.join(ROOT, "docs/release0/FROZEN_ARTIFACTS.json"), "utf8"));
const URL = process.env.DATABASE_URL;
const AS_JSON = process.argv.includes("--json");

const R = { generated_from: "database read", unknowns: [] };
const unknown = (field, why) => { R.unknowns.push({ field, why }); return { UNKNOWN: why }; };

(async function main() {
  if (!URL) { console.error("REFUSED: DATABASE_URL is not set."); process.exit(2); }
  const c = new Client({ connectionString: URL });
  try { await c.connect(); } catch (e) {
    console.error("REFUSED: could not connect — " + e.message); process.exit(2); }
  await c.query("begin transaction read only");
  const q = async (s, a = []) => (await c.query(s, a)).rows;
  const one = async (s, a = []) => (await q(s, a))[0] || null;
  const has = async (rel) => !!(await one(`select to_regclass($1) r`, [rel])).r;
  /*  `to_regclass` finds RELATIONS. A first version used it for the
   *  validator function too, so the receipt reported "the canonical
   *  validator is not installed" while the guard that CALLS it was armed —
   *  a contradiction inside the receipt itself. */
  const hasFn = async (name) => Number((await one(
    `select count(*)::int n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
      where ns.nspname='public' and p.proname=$1`, [name])).n) > 0;

  // 1 · WHAT IS RUNNING
  const sha = process.env.RENDER_GIT_COMMIT || process.env.GIT_SHA;
  /*  An instrumentation deploy carries tools and docs over a product
   *  base it does NOT contain. Both identities travel, or a container
   *  SHA newer than the base reads as "the product source is running". */
  try {
    R.instrumentation_base = JSON.parse(fs.readFileSync(
      path.join(ROOT, "docs/release0/INSTRUMENTATION_BASE.json"), "utf8"));
  } catch (_) { R.instrumentation_base = null; }

  R.running_sha = sha || unknown("running_sha",
    "RENDER_GIT_COMMIT/GIT_SHA absent from this process — run the receipt ON the " +
    "deployed instance; the local checkout is not evidence of what production runs");
  R.frozen_artifacts = {
    revision: FROZEN.revision || null,
    drifted: Object.entries(FROZEN.digests).filter(([rel, want]) => {
      const p = path.join(ROOT, rel);
      return !fs.existsSync(p) ||
        crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex") !== want;
    }).map(([rel]) => rel),
  };

  // 2 · MIGRATION / LEDGER
  R.ledger_ceiling = (await one(`select max(version) v from schema_migrations`) || {}).v || null;
  R.release_0_migrations = Object.fromEntries((await q(
    `select version, true applied from schema_migrations where version in ('138','139','140')`))
    .map((r) => [r.version, true]));
  for (const m of ["138", "139", "140"]) if (!(m in R.release_0_migrations)) R.release_0_migrations[m] = false;

  // 3 · THE CANONICAL WRITER
  const life = fs.readFileSync(path.join(ROOT, "src/technician/lifecycle_service.js"), "utf8");
  R.canonical_writer = /recordEvaluation\(/.test(life)
    ? "technician/lifecycle_service.claimCompletion — records the proof evaluation " +
      "and the status change in one transaction"
    : unknown("canonical_writer", "this checkout has no recordEvaluation in claimCompletion");
  R.old_writers_impossible = {
    legacy_operator_done_path: (() => {
      const maint = fs.readFileSync(path.join(ROOT, "src/maintenance/maintenance.js"), "utf8");
      const iRef = maint.indexOf("legacy_completion_retired");
      const iWr = maint.search(/update\s+work_orders[\s\S]{0,120}?status\s*=\s*'closed'/i);
      return iRef >= 0 && (iWr < 0 || iRef < iWr)
        ? "refused (409 legacy_completion_retired) before any transaction opens"
        : "STILL OPEN — Step 6 is not in this build";
    })(),
    post_cutover_closed: R.release_0_migrations["140"]
      ? "refused by migration 140 (R0003) regardless of which build serves"
      : "not enforced — migration 140 is not applied",
  };

  // 4 · THE ACTIVATION
  const act = (await has("public.release_0_activation_history"))
    ? await one(`select id, activated_at, captured_by, captured_at_step
                   from release_0_activation_current`) : null;
  R.activation = act ? {
    id: act.id, instant: act.activated_at.toISOString(),
    captured_by: act.captured_by, captured_at_step: act.captured_at_step,
  } : "NOT ACTIVATED — Release 0's proof rail is not yet authoritative";

  R.grandfathered_population = (await has("public.release_0_legacy_cutover_inventory"))
    ? await q(`select status_at_cutover, count(*)::int n
                 from release_0_legacy_cutover_inventory group by 1 order by 1`)
    : [];

  // 5 · THE CONTAINMENT GUARD
  const trg = await q(
    `select t.tgname, t.tgenabled, t.tgdeferrable, t.tginitdeferred
       from pg_trigger t join pg_class k on k.oid = t.tgrelid
      where not t.tgisinternal and t.tgname like any (array[
        'assert_completion_truth_%','freeze_cited_evidence_%','freeze_activation_epoch',
        'stamp_activation_epoch'])`);
  R.containment_guard = {
    triggers_installed: trg.length,
    triggers_expected: 8,
    disabled: trg.filter((t) => t.tgenabled === "D").map((t) => t.tgname),
    not_deferred: trg.filter((t) => t.tgname.startsWith("assert_") &&
      (!t.tgdeferrable || !t.tginitdeferred)).map((t) => t.tgname),
    epoch: (await has("public.release_0_activation_epoch"))
      ? await one(`select activation_id, activated_at from release_0_activation_epoch`)
      : unknown("containment_guard.epoch", "release_0_activation_epoch does not exist"),
  };
  R.containment_guard.armed = R.containment_guard.triggers_installed === 8 &&
    R.containment_guard.disabled.length === 0 &&
    !!(R.containment_guard.epoch && R.containment_guard.epoch.activation_id);

  // 6 · THE INVARIANT AUDIT
  R.invariant_audit = (await has("public.release_0_completion_invariant_violations"))
    ? await q(`select work_order_id, status, proof_status, violation
                 from release_0_completion_invariant_violations limit 50`)
    : unknown("invariant_audit", "migration 140 is not applied — the view does not exist");
  R.invariant_audit_note =
    "EMPTY IS THE EXPECTED ANSWER. A row is a SYSTEM-INTEGRITY event — guard dropped, " +
    "deployed late, or bypassed by privileged DDL. It is NOT a new obligation against " +
    "a person: §4.2 keeps its narrow semantics and raises for one class only.";

  // 7 · EVIDENCE IMMUTABILITY
  R.evidence_immutability = trg.some((t) => t.tgname === "freeze_cited_evidence_upd")
    ? "cited proof attachments are frozen entirely (R0005, immediate, UPDATE and " +
      "DELETE). Proof that justified a completion is historical: correct it by adding " +
      "new truth, never by rewriting the old evidence."
    : unknown("evidence_immutability", "the freeze triggers are not installed");

  // 8 · WHAT THE READER SAYS
  if (await hasFn("release_0_completion_proof_status")) {
    R.reader = await q(
      `select w.status,
              public.release_0_completion_proof_status(w.id, w.property_id) proof,
              count(*)::int n
         from work_orders w where w.status in ('complete','closed')
        group by 1,2 order by 1,2`);
  } else R.reader = unknown("reader", "the canonical validator is not installed");

  // 9 · WHAT THE OPERATOR SEES
  R.operator_contract = {
    field_of_record: "proof.state — one of satisfied · not_satisfied · " +
      "legacy_indeterminate · missing_evaluation_defect",
    read_failure: "read_status='unavailable' with state and satisfied ABSENT, never null",
    retired: "proof.satisfied has left the wire; the §3.4 mapping is exported so a " +
      "consumer can still derive it",
  };

  // 10 · WHAT IS DELIBERATELY OUTSIDE RELEASE 0
  R.outside_release_0 = [
    "the full eight-fact completion transaction is the canonical service's, not the " +
      "database's — 140 prevents terminal/proof divergence and protects the evidence " +
      "behind that proof, and no more",
    "a governed operator/manager completion surface (§1.1.2 — containment, not a " +
      "permanent ruling)",
    "reopening pre-cutover work — inventoried legacy status is frozen",
    "retention / privacy / storage lifecycle for cited evidence — PARKED, and when " +
      "taken up, redaction must be new truth rather than a rewrite",
    "any scheduler: the §4.2 sweep is a governed MANUAL runner",
  ];

  /*  10b · THE SMS TRANSPORT POSTURE AT THE MOMENT OF THE RECEIPT
   *
   *  Owner ruling: the deployed SMS_SEND_MODE posture is recorded before
   *  transport goes live. It belongs in the receipt as well as the
   *  preflight, because the receipt is the artifact someone reads a year
   *  later to answer "what was true when Release 0 landed" — and
   *  "resident messaging was structurally off during the handset proof"
   *  is exactly that kind of fact.
   *
   *  The invariant:
   *      Twilio credentials live + SMS_SEND_MODE disabled
   *        → technician operations replies work
   *        → resident outbound sends structurally refused
   *
   *  PRESENCE ONLY. Booleans and a mode name; never a credential, never
   *  provider_config, never an e164. */
  const twilioLive = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
  const rawMode = (process.env.SMS_SEND_MODE || "").trim();
  //  Unset and unrecognised both resolve to `disabled` in the boundary,
  //  so only the two live modes can send. A retired mode string is safe.
  const modeSends = ["proof_only", "customer_care"].includes(rawMode);
  //  Safe and correctly configured are different facts. A value the build
  //  does not recognise fails closed — safe — but means the deployed
  //  configuration is not what whoever set it believes.
  const modeRecognized = rawMode === "" ||
    ["disabled", "proof_only", "customer_care"].includes(rawMode);
  R.sms_posture = sha ? {
    send_mode: rawMode === "" ? "unset" : rawMode,
    mode_can_send: modeSends,
    mode_recognized: modeRecognized,
    config_state: modeRecognized ? "configured" : "CONFIG UNKNOWN — value not recognised by this build",
    twilio_credentials_present: twilioLive,
    resident_sends: modeSends ? "POSSIBLE" : "structurally refused at send_mode_disabled",
    technician_replies: twilioLive ? "available (sendOperationsReply ignores the mode)"
                                   : "transport absent",
    read_from: "the deployed process environment",
  } : unknown("sms_posture",
    "not running on the deployed instance — this process's environment is not " +
    "production's, and reporting it as the deployed posture would be the same " +
    "error as reporting the local checkout's SHA as the running one");

  //  Whether a resident send would even have a number to originate from.
  //  properties.sms_number is a READ-ONLY PROJECTION of the active
  //  property_facing communication line; retiring that line NULLs it and
  //  sendPropertySms refuses with no_property_line.
  const numbered = await one(
    `select count(*)::int total,
            count(*) filter (where sms_number is not null and sms_number <> '')::int numbered
       from properties`);
  R.resident_lines_numbered = numbered
    ? `${numbered.numbered} of ${numbered.total}`
    : unknown("resident_lines_numbered", "properties unreadable");

  // 11 · THE DEBT THIS RECEIPT CANNOT DISCHARGE
  R.remaining_proof_debt = [
    { item: "Step 4 · the handset completion", status: "BLOCKED on Twilio transport",
      why: "a real MMS from a real phone through the operations line. Packaged and " +
           "rehearsed 48/48 in isolation; nothing about the test design should need " +
           "debugging in production." },
    { item: "browser verification of the operator surface", status: "OWED",
      why: "§33 makes browser verification part of done for operator workflows. A " +
           "database read cannot discharge it." },
    { item: "production deploy verification of Step 3", status: "OWED",
      why: "the running SHA must be read from the deployed instance, not assumed." },
  ];

  /*  ── CONTRADICTIONS THE RECEIPT MUST NOT PRINT SIDE BY SIDE ───────
   *
   *  A receipt that lists "140 not applied" one line above "guard ARMED"
   *  has stated two incompatible things and left the reader to notice.
   *  In production that exact pair means the DDL was applied BY HAND
   *  without the migration release — the ledger and the schema disagree,
   *  and the next deploy will refuse to boot on the unapplied migration. */
  R.contradictions = [];
  const guardPresent = R.containment_guard.triggers_installed > 0;
  if (guardPresent && !R.release_0_migrations["140"]) {
    R.contradictions.push(
      "migration 140's DDL is PRESENT but the ledger does not record it as applied. " +
      "In production that means it was applied by hand without the migration release: " +
      "the schema and the ledger disagree, and prestart will REFUSE TO BOOT on the " +
      "next deploy. Run the migration release so the ledger matches the schema.");
  }
  if (R.activation !== null && typeof R.activation === "object" &&
      R.containment_guard.epoch && !R.containment_guard.epoch.activation_id) {
    R.contradictions.push(
      "an activation is recorded but the epoch is UNSTAMPED. The reader classifies " +
      "every terminal row while the guard stays inert — two meanings of truth. " +
      "Investigate before completing anything else.");
  }
  if (Array.isArray(R.invariant_audit) && R.invariant_audit.length > 0) {
    R.contradictions.push(
      `${R.invariant_audit.length} committed work order(s) violate the completion ` +
      "invariant. This is a SYSTEM-INTEGRITY event, not an obligation against a person.");
  }

  await c.query("rollback");
  await c.end();

  if (AS_JSON) { console.log(JSON.stringify(R, null, 2)); process.exit(0); }

  const bar = "═".repeat(72);
  const P = (k, v) => console.log("  " + k.padEnd(26) + " " + v);
  console.log("\n" + bar);
  console.log("  RELEASE 0 — ACCEPTANCE RECEIPT   (read-only)");
  console.log(bar + "\n");
  P("running SHA", (typeof R.running_sha === "string" ? R.running_sha.slice(0, 12) : "UNKNOWN") +
    (R.instrumentation_base ? "   (container — instrumentation)" : ""));
  if (R.instrumentation_base) {
    P("product base SHA", String(R.instrumentation_base.product_base_sha || "?").slice(0, 12));
    P("R0 product source", R.instrumentation_base.release_0_product_source_deployed
      ? "DEPLOYED" : "NOT DEPLOYED — tools and docs over the base above");
  }
  P("frozen artifacts", R.frozen_artifacts.drifted.length
    ? "DRIFTED: " + R.frozen_artifacts.drifted.join(", ")
    : `revision ${R.frozen_artifacts.revision} · all match`);
  P("ledger ceiling", R.ledger_ceiling);
  P("migrations 138/139/140", Object.entries(R.release_0_migrations)
    .map(([k, v]) => `${k}${v ? "✓" : "✗"}`).join(" "));
  P("canonical writer", typeof R.canonical_writer === "string"
    ? R.canonical_writer.split(" — ")[0] : "UNKNOWN");
  P("legacy done-path", R.old_writers_impossible.legacy_operator_done_path);
  P("post-cutover `closed`", R.old_writers_impossible.post_cutover_closed);
  console.log("");
  if (typeof R.activation === "string") P("activation", R.activation);
  else {
    P("activation instant", R.activation.instant);
    P("captured by", `${R.activation.captured_by} (at ${R.activation.captured_at_step})`);
  }
  P("grandfathered", R.grandfathered_population.length
    ? R.grandfathered_population.map((r) => `${r.n} × ${r.status_at_cutover}`).join(", ")
    : "none");
  console.log("");
  P("containment guard", R.containment_guard.armed ? "ARMED"
    : `${R.containment_guard.triggers_installed}/8 triggers` +
      (R.containment_guard.disabled.length ? ` · DISABLED: ${R.containment_guard.disabled}` : "") +
      (R.containment_guard.epoch && R.containment_guard.epoch.activation_id
        ? "" : " · epoch unstamped"));
  P("evidence immutability", typeof R.evidence_immutability === "string"
    ? "cited proof is frozen (R0005)" : "NOT INSTALLED");
  P("invariant audit", Array.isArray(R.invariant_audit)
    ? (R.invariant_audit.length === 0 ? "EMPTY — as expected"
       : `⛔ ${R.invariant_audit.length} VIOLATION(S)`) : "unavailable");
  console.log("");
  console.log("  what the database says about terminal work:");
  if (Array.isArray(R.reader)) {
    for (const r of R.reader) console.log(`      ${r.status}/${r.proof} = ${r.n}`);
    if (!R.reader.length) console.log("      (no terminal work orders)");
  } else console.log("      unavailable");

  /*  The posture is REPORTED, not scored. The preflight is where the
   *  stop condition lives, because it runs BEFORE a boundary; a receipt
   *  that exited 1 on a live send mode would keep failing forever once
   *  customer_care is legitimately on, which is a gate that fails the
   *  fix. This records what was true, loudly, and decides nothing. */
  console.log("\n  ── SMS TRANSPORT POSTURE ────────────────────────────────────────");
  if (typeof R.sms_posture === "object" && R.sms_posture.send_mode) {
    const unsafe = R.sms_posture.mode_can_send && R.sms_posture.twilio_credentials_present;
    P("  SMS_SEND_MODE", R.sms_posture.send_mode +
      (unsafe ? "   ⛔ CAN SEND"
              : R.sms_posture.mode_recognized ? "" : "   ⚠ SAFE / CONFIG UNKNOWN"));
    if (!R.sms_posture.mode_recognized) {
      console.log("      → not a mode this build recognises. It fails closed to");
      console.log("        `disabled`, so SMS is silently off rather than unsafe.");
    }
    P("  twilio credentials", R.sms_posture.twilio_credentials_present ? "PRESENT" : "absent");
    P("  resident sends", R.sms_posture.resident_sends);
    P("  technician replies", R.sms_posture.technician_replies);
    P("  resident lines numbered", R.resident_lines_numbered);
    if (unsafe) {
      console.log("      → the shared Twilio account is live AND the send mode can send.");
      console.log("        outbound_policy is NOT protection on that path — see");
      console.log("        docs/OUTBOUND_TRIGGER_AUDIT.md.");
    }
  } else {
    P("  SMS posture", "UNKNOWN — not read on the deployed instance");
  }

  console.log("\n  ── REMAINING PROOF DEBT ─────────────────────────────────────────");
  for (const d of R.remaining_proof_debt) console.log(`    ${d.status.padEnd(24)} ${d.item}`);
  console.log("\n  ── DELIBERATELY OUTSIDE RELEASE 0 ───────────────────────────────");
  for (const o of R.outside_release_0) console.log("    · " + o.split(" — ")[0]);

  if (R.contradictions.length) {
    console.log("\n  ⛔ CONTRADICTIONS ───────────────────────────────────────────────");
    for (const x of R.contradictions) console.log("    · " + x.replace(/\n/g, "\n      "));
  }

  if (R.unknowns.length) {
    console.log("\n  ── WHAT THIS RECEIPT COULD NOT READ ─────────────────────────────");
    for (const u of R.unknowns) console.log(`    ${u.field}: ${u.why}`);
  }
  console.log("\n" + bar + "\n");
  process.exit(R.contradictions.length ? 1 : 0);
})().catch((e) => { console.error("\nRECEIPT ERROR:\n" + (e && e.stack || e)); process.exit(2); });
