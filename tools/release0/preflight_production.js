#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   RELEASE 0 — THE PRODUCTION PREFLIGHT

   ONE command, READ-ONLY, run against the real database before any
   Release 0 boundary. It answers, from the runtime rather than from a
   note, every question the runbook depends on — and goes HARD RED on a
   contradiction rather than printing a wall an operator has to interpret.

       node tools/release0/preflight_production.js

   ── IT CANNOT WRITE, BY CONSTRUCTION ────────────────────────────────

   Everything runs inside `BEGIN TRANSACTION READ ONLY`, which the SERVER
   enforces, and the transaction is rolled back. A bug in this file cannot
   write to production; it can only fail. `where_are_we.js` established
   that discipline and this keeps it — the difference is that this asks
   the full set of questions, in the order the runbook needs them, and
   scores them.

   ── WHAT IT REFUSES TO GUESS ────────────────────────────────────────

   The running SHA is a property of the PROCESS, not the database. If
   RENDER_GIT_COMMIT / GIT_SHA is not present it says UNKNOWN rather than
   reporting the local checkout's SHA as though it were production's —
   this release has already paid twice for a deploy whose running SHA was
   not the one assumed.

   exit 0  every check green
   exit 1  a contradiction — do not proceed
   exit 2  could not read (no DATABASE_URL, no connection)
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

const bar = "═".repeat(72);
const rows = [];
let red = 0;
const say = (k, v, note) => rows.push({ k, v, note, level: "info" });
const check = (k, okv, v, note) => {
  rows.push({ k, v, note, level: okv ? "ok" : "red" });
  if (!okv) red++;
  return okv;
};
/*  SAFE AND CORRECTLY CONFIGURED ARE DIFFERENT FACTS. A warning does not
 *  block a boundary — it says the deployed configuration is not what the
 *  operator thinks it is, which is worth reading even when the effect is
 *  harmless. Scoring it red would be a false alarm; scoring it green
 *  would hide the drift. */
let warned = 0;
const warn = (k, v, note) => { rows.push({ k, v, note, level: "warn" }); warned++; };

(async function main() {
  if (!URL) {
    console.error("REFUSED: DATABASE_URL is not set. This reads the real database and " +
                  "will not invent an answer.");
    process.exit(2);
  }
  const c = new Client({ connectionString: URL });
  try { await c.connect(); }
  catch (e) {
    /*  THE WHOLE SHEET IS MEANT TO BE SHAREABLE.
     *
     *  Every reported fact is a boolean, a count or a name — the leak
     *  canaries in prove_preflight_sms_posture.js hold that for
     *  credentials, provider_config and e164. This one path was the
     *  exception: a connection error carries `host:port` (and, on an
     *  auth failure, the database user), which is infrastructure detail
     *  an operator does not need to paste anywhere to act on it. pg does
     *  not put the password in the message — measured, not assumed — but
     *  "no password" is not the same as "safe to forward".
     *
     *  So the operator sees the class of failure and reads the rest in
     *  their own terminal.
     *
     *  Quoted identifiers are elided WHOLESALE rather than by phrase.
     *  A first version matched only `for user "…"` and let
     *  `role "produser" does not exist` through — Postgres has several
     *  phrasings for the same class of fact (role, database, schema),
     *  and enumerating them is a losing game. In a CONNECTION error
     *  every quoted identifier is infrastructure naming, so all of them
     *  go. */
    const safe = String(e.message || "")
      .replace(/"[^"]*"/g, '"<elided>"')
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<host>")
      .replace(/\b[a-z0-9.-]+\.(?:com|net|org|io|dev|tech|cloud|app)\b/gi, "<host>")
      .replace(/:\d{2,5}\b/g, ":<port>");
    console.error("REFUSED: could not connect — " + safe);
    console.error("  (host and user elided so this line is safe to forward. The full " +
                  "error is in your own terminal's exit status and your client's logs.)");
    process.exit(2);
  }

  /*  THE SERVER ENFORCES IT. `default_transaction_read_only` set locally
   *  would be advisory over a session this file controls; a READ ONLY
   *  transaction is refused by PostgreSQL itself on any write attempt. */
  await c.query("begin transaction read only");
  const q = async (sql, args = []) => (await c.query(sql, args)).rows;
  const one = async (sql, args = []) => (await q(sql, args))[0] || null;
  const exists = async (rel) => !!(await one(`select to_regclass($1) r`, [rel])).r;

  console.log("\n" + bar);
  console.log("  RELEASE 0 — PRODUCTION PREFLIGHT   (read-only transaction)");
  console.log(bar);

  // ── 1 · WHAT IS ACTUALLY RUNNING ──────────────────────────────────
  const sha = process.env.RENDER_GIT_COMMIT || process.env.GIT_SHA || null;

  /*  ── TWO IDENTITIES, NEVER COLLAPSED ──────────────────────────────
   *
   *  Instrumentation can be deployed WITHOUT the product source it
   *  instruments — tools and docs only, no src, no migrations. That is a
   *  legitimate deploy and it is how this preflight first reaches a
   *  production shell. The hazard is what someone concludes afterwards:
   *  a container SHA that is newer than b4e3104 reads like "Release 0
   *  product source is running", and it is not.
   *
   *  So an instrumentation deploy STAMPS the product base it was cut
   *  from, and this reports both. Absent file = an ordinary deploy,
   *  where the container SHA is the product SHA and there is nothing to
   *  distinguish. */
  let instrumentation = null;
  try {
    instrumentation = JSON.parse(fs.readFileSync(
      path.join(ROOT, "docs/release0/INSTRUMENTATION_BASE.json"), "utf8"));
  } catch (_) { /* ordinary deploy */ }
  if (sha) say("running SHA", sha.slice(0, 12) +
    (instrumentation ? "   (container — instrumentation)" : ""));
  else check("running SHA", false, "UNKNOWN",
    "RENDER_GIT_COMMIT / GIT_SHA is not set in THIS process. Run this on the " +
    "deployed instance, or read the SHA from the platform — never assume the local " +
    "checkout is what production is running.");

  if (instrumentation) {
    say("product base SHA", String(instrumentation.product_base_sha || "?").slice(0, 12) +
      "   ← the product source this container actually carries");
    say("Release 0 product source", instrumentation.release_0_product_source_deployed
      ? "DEPLOYED"
      : "NOT DEPLOYED — this container is tools and docs over the base above");
  }

  //  The frozen artifacts, as they exist in THIS checkout.
  const drifted = Object.entries(FROZEN.digests).filter(([rel, want]) => {
    const p = path.join(ROOT, rel);
    return !fs.existsSync(p) ||
      crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex") !== want;
  }).map(([rel]) => rel);
  check("frozen artifacts", drifted.length === 0,
    drifted.length ? `${drifted.length} DRIFTED` : "all match the pinned digests",
    drifted.join(", ") + " — the falsification package describes different bytes");

  // ── 2 · STEP 3, THE CANONICAL WRITER ──────────────────────────────
  const life = fs.readFileSync(path.join(ROOT, "src/technician/lifecycle_service.js"), "utf8");
  check("Step 3 · canonical writer", /recordEvaluation\(/.test(life),
    /recordEvaluation\(/.test(life) ? "claimCompletion records an evaluation" : "ABSENT",
    "the running checkout has no recordEvaluation — the deploy did not carry the merge");

  // ── 3 · THE LEDGER AND THE RELEASE 0 MIGRATIONS ───────────────────
  const ledger = (await one(`select max(version) v from schema_migrations`) || {}).v;
  say("ledger ceiling", String(ledger));
  const applied = new Set((await q(
    `select version from schema_migrations where version in ('138','139','140')`))
    .map((r) => r.version));
  for (const m of ["138", "139", "140"]) {
    say(`migration ${m}`, applied.has(m) ? "APPLIED" : "not applied");
  }

  // ── 4 · THE ACTIVATION BOUNDARY ───────────────────────────────────
  const hasHistory = await exists("public.release_0_activation_history");
  const activation = hasHistory
    ? await one(`select id, activated_at, captured_by from release_0_activation_current`) : null;
  say("activation", activation
    ? `PRESENT · ${activation.activated_at.toISOString()} · by ${activation.captured_by}`
    : "absent");
  const inventory = hasHistory
    ? Number((await one(`select count(*) n from release_0_legacy_cutover_inventory`)).n) : 0;
  say("legacy inventory", `${inventory} row(s) grandfathered`);

  const hasEpoch = await exists("public.release_0_activation_epoch");
  const epoch = hasEpoch ? await one(`select * from release_0_activation_epoch`) : null;
  check("activation epoch", !!epoch && !hasEpoch === false,
    epoch ? (epoch.activation_id ? "stamped" : "present, unstamped (pre-cutover)") : "MISSING",
    "without the singleton epoch row a stale REPEATABLE READ snapshot has nothing to " +
    "serialize against, and can commit a terminal work order the guard never judges");
  if (activation && epoch) {
    check("epoch agrees with the activation",
      String(epoch.activation_id) === String(activation.id),
      String(epoch.activation_id) === String(activation.id) ? "yes" : "DISAGREE",
      `epoch ${epoch.activation_id} vs activation ${activation.id} — the guard would be ` +
      "reading a boundary that is not the one recorded");
  }

  // ── 5 · THE GUARD, EXACTLY ────────────────────────────────────────
  const trg = await q(
    `select t.tgname, t.tgenabled, t.tgdeferrable, t.tginitdeferred, k.relname
       from pg_trigger t join pg_class k on k.oid = t.tgrelid
      where not t.tgisinternal and t.tgname like any (array[
        'assert_completion_truth_%','freeze_cited_evidence_%','stamp_activation_epoch',
        'freeze_activation_epoch'])`);
  const want = ["assert_completion_truth_ins", "assert_completion_truth_upd",
                "assert_completion_truth_eval", "assert_completion_truth_attach",
                "freeze_cited_evidence_upd", "freeze_cited_evidence_del",
                "stamp_activation_epoch", "freeze_activation_epoch"];
  const missing = want.filter((n) => !trg.some((t) => t.tgname === n));
  const disabled = trg.filter((t) => t.tgenabled === "D").map((t) => t.tgname);
  const notDeferred = trg.filter((t) => t.tgname.startsWith("assert_completion_truth") &&
    (!t.tgdeferrable || !t.tginitdeferred)).map((t) => t.tgname);
  check("guard triggers", missing.length === 0 && disabled.length === 0 && notDeferred.length === 0,
    `${trg.length}/${want.length} present` +
    (disabled.length ? ` · ${disabled.length} DISABLED` : "") +
    (notDeferred.length ? ` · ${notDeferred.length} NOT DEFERRED` : ""),
    [missing.length ? "missing: " + missing.join(", ") : "",
     disabled.length ? "DISABLED (present in pg_trigger, never fires): " + disabled.join(", ") : "",
     notDeferred.length ? "not deferred: " + notDeferred.join(", ") : ""]
      .filter(Boolean).join(" · "));

  //  The four canonical functions, by substance.
  const CLAUSES = {
    release_0_assert_completion_truth:
      ["release_0_activation_epoch", "for share", "status_at_cutover",
       "release_0_completion_proof_status", "R0002", "R0003", "R0004"],
    release_0_completion_proof_status:
      ["work_order_proof_evaluation_head", "'satisfied'", "release_0_evidence_qualifies"],
    release_0_evidence_qualifies:
      ["storage_state", "sha256", "stored_at", "proof_classification", "mime_type"],
    release_0_freeze_cited_evidence:
      ["work_order_proof_evaluation_attachments", "R0005"],
    release_0_freeze_activation_epoch: ["activation_id", "R0006"],
  };
  const fnFaults = [];
  for (const [name, cls] of Object.entries(CLAUSES)) {
    // eslint-disable-next-line no-await-in-loop
    const defs = await q(
      `select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname=$1`, [name]);
    if (!defs.length) { fnFaults.push(`${name} MISSING`); continue; }
    for (const d of defs) {
      const miss = cls.filter((cl) => !d.prosrc.includes(cl));
      if (miss.length) fnFaults.push(`${name} lacks ${miss.join(", ")}`);
    }
  }
  check("guard predicates", fnFaults.length === 0,
    fnFaults.length ? `${fnFaults.length} FAULT(S)` : "all four present and correct",
    fnFaults.join(" · ") + " — a function with the right NAME and the wrong body reads " +
    "as protection and is not");

  // ── 6 · THE TERMINAL POPULATION, BY PROOF STATE ───────────────────
  const canScore = fnFaults.length === 0 && await exists("public.work_orders");
  if (canScore) {
    const pop = await q(
      `select w.status,
              public.release_0_completion_proof_status(w.id, w.property_id) proof,
              count(*)::int n
         from work_orders w
        where w.status in ('complete','closed')
        group by 1,2 order by 1,2`);
    say("terminal population", pop.length
      ? pop.map((r) => `${r.status}/${r.proof}=${r.n}`).join("  ") : "none");
  } else {
    say("terminal population", "NOT SCORED — the validator is not installed");
  }

  // ── 7 · THE INVARIANT AUDIT ───────────────────────────────────────
  if (await exists("public.release_0_completion_invariant_violations")) {
    const v = await q(
      `select work_order_id, status, violation
         from release_0_completion_invariant_violations limit 20`);
    check("invariant audit", v.length === 0,
      v.length ? `${v.length} VIOLATION(S)` : "empty — as expected",
      v.map((x) => `${x.work_order_id} ${x.violation}`).join(" · ") +
      " — this population should be EMPTY. A row is a SYSTEM-INTEGRITY event: the " +
      "guard was dropped, deployed late, or bypassed by privileged DDL. It is NOT a " +
      "new obligation against a person. Investigate the boundary, not the employee.");
  } else {
    say("invariant audit", "unavailable — migration 140 not applied");
  }

  // ── 8 · THE LEGACY WRITER ─────────────────────────────────────────
  /*  ⚠ A PRESENCE TEST IS THE WRONG TEST, and it produced a FALSE RED.
   *
   *  Step 6 does not delete the legacy `update … status='closed'`. It puts
   *  an unconditional 409 in front of it, so the write survives in the
   *  file and is unreachable — deliberately, because §1.1.2 calls this
   *  containment rather than a permanent ruling that operator completion
   *  authority is abolished. Testing for the UPDATE's absence reported
   *  STILL OPEN against the branch where the path is closed.
   *
   *  The real fact is the ORDER: the governed refusal must come before
   *  any transaction opens. `legacy_completion_retired` is the contract
   *  token Step 6 introduces, and its position relative to the write is
   *  what makes the path unreachable.  */
  const maint = fs.readFileSync(path.join(ROOT, "src/maintenance/maintenance.js"), "utf8");
  const iRefusal = maint.indexOf("legacy_completion_retired");
  const iWrite = maint.search(/update\s+work_orders[\s\S]{0,120}?status\s*=\s*'closed'/i);
  const legacyClosed = iRefusal >= 0 && (iWrite < 0 || iRefusal < iWrite);
  check("Step 6 · legacy done-path", legacyClosed,
    legacyClosed ? "fails closed before any transaction opens" : "STILL OPEN",
    "the legacy writer can still create `closed` rows: no `legacy_completion_retired` " +
    "refusal ahead of the closing UPDATE in maintenance.js. Capture the activation " +
    "instant only after Step 6 is DEPLOYED (§5.4) — otherwise a draining instance can " +
    "write a `closed` row that lands outside the inventory and reads as a defect the " +
    "release caused itself.");

  // ── 9 · THE LIVE STATUS VOCABULARY ────────────────────────────────
  const vocab = await q(
    `select status, count(*)::int n from work_orders group by 1 order by 2 desc`);
  const KNOWN = ["open", "scheduled", "needs_followup", "closed", "complete"];
  const strange = vocab.filter((r) => !KNOWN.includes(r.status));
  check("status vocabulary", strange.length === 0,
    vocab.map((r) => `${r.status}=${r.n}`).join("  "),
    "UNKNOWN STATUS: " + strange.map((r) => `${r.status} (${r.n})`).join(", ") +
    " — classify each one before activating. If it means the work is finished it " +
    "belongs in the guard's terminal set and the reader's, or that completion escapes " +
    "Release 0 entirely.");

  // ── 10 · IS ACTIVATION SAFE RIGHT NOW? ────────────────────────────
  const blockers = await q(
    `select count(*)::int n from pg_locks l join pg_class k on k.oid = l.relation
      where k.relname = 'work_orders' and l.mode in
            ('RowExclusiveLock','ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock')
        and l.pid <> pg_backend_pid()`);
  const idleTx = await q(
    `select count(*)::int n from pg_stat_activity
      where state in ('idle in transaction','idle in transaction (aborted)')
        and pid <> pg_backend_pid()`);
  check("activation window", Number(blockers[0].n) === 0 && Number(idleTx[0].n) === 0,
    `${blockers[0].n} work_orders writer(s) · ${idleTx[0].n} idle-in-transaction`,
    "the activation takes SHARE ROW EXCLUSIVE … NOWAIT and will refuse immediately " +
    "(WRITERS_IN_FLIGHT). An idle-in-transaction session may also hold a snapshot that " +
    "predates the cutover — that is the B1 shape, and it is refused at ITS commit " +
    "(40001) rather than silently exempted. Wait, then re-run the census.");

  // ── 11 · THE SMS TRANSPORT POSTURE ────────────────────────────────
  //  Owner ruling: record the deployed SMS_SEND_MODE posture BEFORE
  //  transport goes live. Step 4 needs Twilio credentials, and those
  //  credentials are GLOBAL — one account behind both lanes — so the
  //  moment they exist the resident path's only remaining gate is the
  //  send mode. The invariant this scores:
  //
  //      Twilio credentials live + SMS_SEND_MODE disabled
  //        → technician operations replies work
  //        → resident outbound sends are structurally refused
  //
  //  Proven in source by tests/gate_outbound_senders.js (S9:
  //  sendOperationsReply does not consult the mode) and measured in
  //  docs/archive/OUTBOUND_TRIGGER_AUDIT.md. What is NOT proven in source is
  //  that the DEPLOYED environment actually holds that configuration.
  //  This is where that gets read.
  //
  //  ⚠ outbound_policy IS NOT THE CONTROL. Do not read a `reply_only`
  //  on property_facing as protection: the policy trigger returns early
  //  on every resident event (no resident writer sets
  //  communication_line_id), and the resident line resolves from
  //  properties.sms_number, not from communication_lines at all.
  //
  //  ── PRESENCE ONLY, COMPUTED IN JS ─────────────────────────────────
  //  Never a shell expansion, never a selected column. `${VAR:-no}` once
  //  put a live auth token in a screenshot, and provider_config carries
  //  the same class of secret. Booleans leave this function; values do
  //  not.
  const twilioLive = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
  const rawMode = (process.env.SMS_SEND_MODE || "").trim();
  const modeShown = rawMode === "" ? "unset" : rawMode;
  //  The boundary's own vocabulary: unset and any unrecognised value both
  //  resolve to `disabled`. A retired mode string is therefore SAFE, and
  //  scoring it as dangerous would be a false alarm about a fail-closed
  //  default. Only the two live modes can send.
  const LIVE_MODES = ["proof_only", "customer_care"];
  const VALID_MODES = ["disabled", "proof_only", "customer_care"];
  const modeSends = LIVE_MODES.includes(rawMode);
  //  Three states, not two. Unset is the code default and is not drift.
  //  A non-empty value the boundary does not recognise IS drift: it fails
  //  closed, so it is SAFE, but the deployed configuration is not what
  //  whoever set it believes. `internal_qa_autonomous` is the known one —
  //  it was retired, and any deploy still carrying it sends nothing.
  const modeRecognized = rawMode === "" || VALID_MODES.includes(rawMode);

  if (!sha) {
    //  Off-instance, this process's env is NOT production's. Reporting
    //  "unset" here would be the same lie as reporting the local
    //  checkout's SHA as the running one.
    check("SMS posture", false, "UNKNOWN",
      "not running on the deployed instance (no RENDER_GIT_COMMIT/GIT_SHA), so " +
      "SMS_SEND_MODE and the Twilio credentials read here are this shell's, not " +
      "production's. Re-run ON the instance. This must be recorded BEFORE transport " +
      "goes live, not after.");
  } else {
    check("SMS posture", !(twilioLive && modeSends),
      `SMS_SEND_MODE=${modeShown} · twilio credentials ${twilioLive ? "PRESENT" : "absent"}`,
      "UNSAFE COMBINATION: the shared Twilio account is live AND the send mode can " +
      `send (${modeShown}). Every operator door and every inbound reply can reach a ` +
      "real resident phone right now. Set SMS_SEND_MODE to disabled (or unset it) " +
      "BEFORE Step 4, and do not treat outbound_policy as protection — it is not on " +
      "that path. See docs/archive/OUTBOUND_TRIGGER_AUDIT.md.");
    if (twilioLive && !modeSends) {
      say("  → resident sends", "structurally refused at send_mode_disabled");
      say("  → technician replies", "available (sendOperationsReply ignores the mode)");
    }
    if (!twilioLive) {
      say("  → note", "credentials absent. Verify this mode again immediately BEFORE " +
        "adding them — that is the moment the resident path arms.");
    }
    if (!modeRecognized) {
      warn("  → config", `SAFE / CONFIG UNKNOWN — '${modeShown}' is not a mode this ` +
        "build recognises",
        "It fails closed to `disabled`, so nothing can send and this is NOT a " +
        "contradiction. But the deployed configuration is not what whoever set it " +
        "believes: SMS is silently off. `internal_qa_autonomous` is the retired value " +
        "that produces exactly this, and 'the deploy went quiet' is how it presents. " +
        "Set it to `disabled` to say so on purpose, or to a live mode deliberately.");
    }
  }

  //  Would a resident send have a number to originate from? The resident
  //  `from` is properties.sms_number — NOT the communication_lines row.
  const numbered = await one(
    `select count(*)::int total,
            count(*) filter (where sms_number is not null and sms_number <> '')::int numbered
       from properties`);
  say("properties.sms_number", `${numbered.numbered} of ${numbered.total} propert(ies) numbered`,
    null);

  //  The Step 4 blocker itself, read from production rather than from
  //  the 2026-08-06 note. Presence booleans only — no e164, no
  //  provider_config contents.
  if (await exists("public.communication_lines")) {
    const lines = await q(
      `select line_type, status, outbound_policy,
              (provider_config is not null) as provider_configured, count(*)::int n
         from communication_lines group by 1,2,3,4 order by 1,2`);
    if (!lines.length) say("communication lines", "none");
    for (const l of lines) {
      say(`  ${l.line_type}`,
        `${l.n} · ${l.status} · outbound_policy=${l.outbound_policy} · ` +
        `provider ${l.provider_configured ? "CONFIGURED" : "not configured"}`);
    }
    const opsReady = lines.some((l) => l.line_type === "operations" &&
      l.status === "active" && l.provider_configured);
    say("Step 4 transport", opsReady
      ? "an active operations line with a provider is present"
      : "BLOCKED — no active, provider-configured operations line. This is the " +
        "Step 4 blocker, and it is provisioning, not code.");
  } else {
    say("communication lines", "table absent — pre-130 database");
  }

  await c.query("rollback");
  await c.end();

  // ── the sheet ─────────────────────────────────────────────────────
  console.log("");
  for (const r of rows) {
    const mark = r.level === "red" ? "  ⛔" : r.level === "warn" ? "  ⚠ " :
                 r.level === "ok" ? "  ok" : "    ";
    console.log(`${mark}  ${r.k.padEnd(30)} ${r.v}`);
    if ((r.level === "red" || r.level === "warn") && r.note) {
      console.log("        → " + r.note.replace(/\n/g, "\n          "));
    }
  }

  console.log("\n" + bar);
  if (red === 0) {
    console.log("  ✓ NO CONTRADICTIONS. This says what is true right now — it does not");
    console.log("    authorize a boundary. The runbook decides which one is next.");
  } else {
    console.log(`  ⛔ ${red} CONTRADICTION(S). DO NOT PROCEED.`);
    console.log("    Each one above names what it means and what to do. Re-run after fixing.");
  }

  /*  PRINTED IN BOTH BRANCHES, and that is the point.
   *
   *  A first version put this inside the green branch only, so a warning
   *  vanished the moment anything else went red — which is precisely when
   *  someone is reading the sheet most carefully. Caught by
   *  prove_preflight_sms_posture.js P5c against a database that has
   *  ordinary reds; a summary nobody sees is the same as no summary.
   *
   *  It never changes the exit code. A warning that blocked a boundary
   *  would make operators route around the tool, and this class of
   *  warning is configuration hygiene, not safety — the safety score has
   *  already been taken above. */
  if (warned) {
    console.log(`\n  ⚠ ${warned} WARNING(S) above — these do not block anything.`);
    console.log("    Each one means the deployed configuration is not what someone");
    console.log("    thinks it is. Safe and correctly configured are different facts.");
  }
  console.log(bar + "\n");
  process.exit(red === 0 ? 0 : 1);
})().catch((e) => { console.error("\nPREFLIGHT ERROR:\n" + (e && e.stack || e)); process.exit(2); });
