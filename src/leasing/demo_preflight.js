// ════════════════════════════════════════════════════════════════════
//  demo_preflight.js — ONE read-only command that answers every
//  "verify this before the room" item from the Jul 23 audit.
//
//  WRITES NOTHING. No INSERT, no UPDATE, no DELETE, no send. Safe to
//  run at any time, including mid-demo.
//
//  STANDALONE. Nothing requires this file, so it cannot crash boot.
//  Only dependency is `pg`, already in the API's node_modules.
//
//  CLASS 3 — test/demo infrastructure outside the operator workflow.
//  Deletes cleanly; nothing in the product depends on it.
//
//  RUN (Render Web Shell, from repo root):   node demo_preflight.js
// ════════════════════════════════════════════════════════════════════
"use strict";

const { Pool } = require("pg");

const { resolveDemoProperty } = require("../shared/demo_property_identity.js");
const DEMO_PROPERTY_ID = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";
const REAL_SOLO_ID     = "9e2bb96e-08e2-41db-81c2-91055ceb50a3";
const TZ               = "America/New_York";

// Each check runs independently. One failure never kills the rest —
// an unreachable table returns an honest UNKNOWN, not a crash.
const findings = [];
function note(status, line, detail) {
  findings.push({ status, line, detail: detail || null });
}
const fmtTime = (d) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  }).format(new Date(d));

async function safe(label, fn) {
  try { return await fn(); }
  catch (e) {
    note("UNKNOWN", `${label} could not be read.`, e.message);
    return null;
  }
}

// ── 1. ENVIRONMENT ───────────────────────────────────────────────────
//  Prints values for the four gates. NEVER prints a secret — Twilio and
//  the operator key are reported as present/absent only.
function checkEnv() {
  const demoMode  = (process.env.DEMO_MODE || "").toLowerCase();
  const liveSms   = (process.env.DEMO_INTAKE_LIVE_SMS || "").toLowerCase();
  const sendMode  = (process.env.SMS_SEND_MODE || "").trim();
  const allowRaw  = process.env.PROSPECT_ACTIVATION_PROPERTY_IDS || "";

  // Parsed exactly the way leasingleads.js parses it — comma split, trimmed.
  const allow = new Set(allowRaw.split(",").map(s => s.trim()).filter(Boolean));

  demoMode === "true"
    ? note("OK", "DEMO_MODE=true — public intake door is open, slot seed runs at boot.")
    : note("STOP", `DEMO_MODE is "${process.env.DEMO_MODE ?? "(unset)"}" — /demo/intake returns 403 and no slots are seeded.`);

  liveSms === "true"
    ? note("OK", "DEMO_INTAKE_LIVE_SMS=true — a form submission attempts a real text.")
    : note("STOP", `DEMO_INTAKE_LIVE_SMS is "${process.env.DEMO_INTAKE_LIVE_SMS ?? "(unset)"}" — the AI opening is PREPARED but never sent. No phone will buzz.`);

  sendMode === "customer_care"
    ? note("OK", "SMS_SEND_MODE=customer_care — agent sends allowed for production-classified, opted-in people.")
    : note("STOP", `SMS_SEND_MODE is "${sendMode || "(unset → disabled)"}" — autonomous agent replies will refuse.`);

  allow.has(DEMO_PROPERTY_ID)
    ? note("OK", "PROSPECT_ACTIVATION_PROPERTY_IDS includes the Demo Building — a consenting web lead gets production + opted_in at intake.")
    : note("STOP", `PROSPECT_ACTIVATION_PROPERTY_IDS does not list the Demo Building. Value: "${allowRaw || "(unset)"}" — leads will be captured but never textable.`);

  if (allow.has(REAL_SOLO_ID)) {
    note("STOP", "PROSPECT_ACTIVATION_PROPERTY_IDS contains the REAL Solo property id. Remove it before any live intake.");
  }

  const twilio = Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
  twilio ? note("OK", "Twilio credentials present.")
         : note("STOP", "Twilio credentials missing — transport is off regardless of send mode.");

  process.env.OPERATOR_KEY
    ? note("OK", "OPERATOR_KEY present (needed for the move-in calls).")
    : note("NOTE", "OPERATOR_KEY not set in this shell's env.");
}

// ── 2. THE PROPERTY AND ITS LINE ─────────────────────────────────────
async function checkProperty(pool) {
  const byId = await safe("Demo Building row", async () =>
    (await pool.query(
      `select id, name, coalesce(display_name, name) as display_name, sms_number
         from properties where id = $1`, [DEMO_PROPERTY_ID])).rows[0]);

  if (!byId) {
    note("STOP", "The Demo Building property row was not found by id. Nothing downstream can work.");
    return null;
  }
  note("OK", `Property found: "${byId.display_name}" (name column: "${byId.name}").`);

  byId.sms_number
    ? note("OK", `Property SMS line: ${byId.sms_number} — this is the "from" every send derives server-side.`)
    : note("STOP", "Property has no sms_number. The outbound gate refuses with no_property_line and never falls back to the Messaging Service default.");

  //  /demo/intake used to find the property by NAME with
  //  `order by created_at asc limit 1`. It now goes through the one
  //  identity module, which refuses rather than choosing. This check
  //  asks the SAME question the form now asks, so a drift here is a
  //  drift there.
  const identity = await safe("identity resolution", () => resolveDemoProperty(pool));

  if (!identity) {
    note("STOP", "Could not resolve the demo property identity at all.");
  } else if (identity.status === "ambiguous") {
    note("STOP", `${identity.receipt} /demo/intake REFUSES rather than filing leads ` +
      `against whichever row is oldest — which is correct, and it also means the ` +
      `public form is down until the identity is adjudicated or ` +
      `DEMO_PROPERTY_ID / DEMO_PROPERTY_CANONICAL_KEY is configured.`);
  } else if (identity.status !== "resolved") {
    note("STOP", `${identity.receipt} /demo/intake will 409 — the form will fail for everyone.`);
  } else if (identity.property_id !== DEMO_PROPERTY_ID) {
    note("STOP", `Identity resolves to a DIFFERENT property (${identity.property_id}). The form would file leads against the wrong building.`);
  } else {
    note("OK", `The public form resolves to this same property, via ${identity.via}.`);
  }
  return byId;
}

// ── 3. TOUR SLOTS ────────────────────────────────────────────────────
//  The agent can only offer what exists. Empty here = the conversation
//  reaches "let's book a tour" and then has nothing to say.
async function checkSlots(pool) {
  const rows = await safe("tour_availability", async () =>
    (await pool.query(
      `select starts_at from tour_availability
        where property_id = $1 and status = 'open' and starts_at > now()
        order by starts_at`, [DEMO_PROPERTY_ID])).rows);
  if (!rows) return;

  if (rows.length === 0) {
    note("STOP", "ZERO open future tour slots. The agent will have nothing to offer. Restart the API (boot re-seeds) or run: node seeds/seed_demo_slots.js --days 7");
    return;
  }
  const next = rows.slice(0, 3).map(r => fmtTime(r.starts_at)).join("  ·  ");
  note("OK", `${rows.length} open future slot(s). Next three (${TZ}): ${next}`);
  if (rows.length < 6) {
    note("NOTE", "Fewer than six slots left — restart the API to top the window back up before the room.");
  }
}

// ── 4. WHOSE SEND BUTTON IS HOT ──────────────────────────────────────
//  Under customer_care, a send requires record_class='production' AND
//  opted_in consent. These are the people a button press can really text.
async function checkHotRecipients(pool) {
  const rows = await safe("production-classified people", async () =>
    (await pool.query(
      `select p.id, p.name, c.record_class,
              coalesce(cp.consent_state, 'none') as consent
         from person_property_classifications c
         join persons p on p.id = c.person_id
         left join contact_preferences cp
                on cp.person_id = p.id and cp.channel = 'text'
        where c.property_id = $1
          and c.superseded_at is null
          and c.record_class = 'production'
        order by p.name`, [DEMO_PROPERTY_ID])).rows);
  if (!rows) return;

  const hot = rows.filter(r => r.consent === "opted_in");
  if (hot.length === 0) {
    note("NOTE", "No production + opted_in people yet. Expected before the first consenting form submission.");
  } else {
    note("HOT", `${hot.length} person(s) can receive a REAL text right now:`);
    for (const r of hot) note("HOT", `    · ${r.name || "(no name)"}  ${r.id}`);
    note("NOTE", "Do not press Send on any of these casually.");
  }
  const captured = rows.length - hot.length;
  if (captured > 0) {
    note("NOTE", `${captured} production person(s) are NOT opted_in — captured, but no text will go out.`);
  }
}

// ── 5. LATEST INTAKE — did the last form submission activate? ─────────
async function checkLastLead(pool) {
  const row = await safe("most recent lead", async () =>
    (await pool.query(
      `select l.id, l.created_at, p.id as person_id, p.name,
              (select record_class from person_property_classifications
                where person_id = p.id and property_id = l.property_id
                  and superseded_at is null limit 1) as record_class,
              (select consent_state from contact_preferences
                where person_id = p.id and channel = 'text' limit 1) as consent
         from leasing_leads l
         join persons p on p.id = l.person_id
        where l.property_id = $1
        order by l.created_at desc limit 1`, [DEMO_PROPERTY_ID])).rows[0]);
  if (!row) { note("NOTE", "No leads on the Demo Building yet."); return; }

  const when = fmtTime(row.created_at);
  if (row.record_class === "production" && row.consent === "opted_in") {
    note("OK", `Most recent lead — ${row.name || "(no name)"} at ${when} — activated correctly (production + opted_in).`);
  } else {
    note("STOP", `Most recent lead — ${row.name || "(no name)"} at ${when} — did NOT activate. class="${row.record_class || "none"}" consent="${row.consent || "none"}". This is the unchecked-consent-box failure: captured, never textable.`);
  }
}

// ── RECEIPT ──────────────────────────────────────────────────────────
function printReceipt() {
  const bar = "─".repeat(68);
  console.log(`\n${bar}\nPROPERTY SPINE — DEMO PREFLIGHT\n${bar}\n`);

  const order = ["STOP", "HOT", "NOTE", "OK", "UNKNOWN"];
  const label = { STOP: "STOP  ", HOT: "HOT   ", NOTE: "note  ", OK: "ok    ", UNKNOWN: "?     " };
  for (const s of order) {
    for (const f of findings.filter(x => x.status === s)) {
      console.log(`${label[s]}${f.line}`);
      if (f.detail) console.log(`      ${f.detail}`);
    }
  }

  const stops = findings.filter(f => f.status === "STOP").length;
  const unknown = findings.filter(f => f.status === "UNKNOWN").length;
  console.log(`\n${bar}`);
  if (stops === 0 && unknown === 0) {
    console.log("READY — every gate the live-text path depends on is open.");
    console.log("Next: submit the public form from a phone and watch it buzz.");
  } else {
    console.log(`${stops} blocker(s), ${unknown} unreadable check(s).`);
    console.log("Fix the STOP lines above in order. Nothing was changed by this script.");
  }
  console.log(`${bar}\n`);
  process.exitCode = stops > 0 ? 1 : 0;
}

// ── MAIN ─────────────────────────────────────────────────────────────
(async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set in this shell. Run from the Render Web Shell.");
    process.exitCode = 1;
    return;
  }
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  try {
    checkEnv();
    const prop = await checkProperty(pool);
    if (prop) {
      await checkSlots(pool);
      await checkHotRecipients(pool);
      await checkLastLead(pool);
    }
  } catch (e) {
    note("UNKNOWN", "Preflight stopped early.", e.message);
  } finally {
    printReceipt();
    await pool.end().catch(() => {});
  }
})();
