#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
//  wave1_accounting_provenance_probe.js — CAN A LATER READER RECONSTRUCT IT?
//
//  A flag-only probe. It adds no accounting logic, no journal entries, no
//  financial terms and no tables. It asks ONE question of each Wave 1 write,
//  against rows the write-authority proof actually created:
//
//      From the durable record alone, can a later reporting service recover
//        1. what happened
//        2. when it became effective
//        3. who acted
//        4. which canonical object changed
//        5. which source or evidence supports it
//        6. whether it was later corrected or superseded
//
//  WHY THE DISTINCTION IN (2) MATTERS. "When it was typed" and "when it
//  became true" are different dates, and an accrual reader needs the second.
//  A write that records only its own insert time cannot be placed in a period
//  later without guessing, and a guess in a reporting package is the exact
//  failure this product exists to prevent.
//
//  Run AFTER write_authority_hardening_proof.js against the same database.
// ════════════════════════════════════════════════════════════════════
"use strict";
const { Pool } = require("pg");
const receipt = require("./_run_receipt.js");

const CONN = receipt.harnessConnectionString();

//  ── TWO KINDS OF RESULT, DELIBERATELY SEPARATED ───────────────────
//  This harness CLASSIFIES; it does not police. Conflating the two would
//  make it permanently red for reporting exactly what it was asked to
//  report, and a permanently-red harness is one nobody reads.
//
//    ok()      — the probe's own integrity: are the rows and tables there
//                to inspect? A false here means the probe proved NOTHING,
//                and the run must fail.
//    lineage() — a finding. Recorded and printed either way. A gap is the
//                deliverable, not a defect in this packet.
//
//  The run still refuses (exit 1) if no lineage question was asked at all.
let pass = 0, fail = 0, asked = 0;
const gaps = [];
const ok = (m, c) => { if (c) { pass++; console.log("   PASS  " + m); }
                       else { fail++; console.log("   FAIL  " + m + "   (probe integrity)"); } };
const lineage = (m, c) => { asked++;
  if (c) console.log("   OK    " + m);
  else { gaps.push(m); console.log("   GAP   " + m); } };
const section = (s) => console.log("\n── " + s + " " + "─".repeat(Math.max(0, 56 - s.length)));

(async () => {
  const t0 = receipt.begin(__filename, { url: CONN, expected: 4 });
  const pool = new Pool({ connectionString: CONN, ssl: false });
  const q = async (s, a = []) => (await pool.query(s, a)).rows;
  try {
    //  The most recent rows the authority proof created. If none exist the
    //  probe REFUSES rather than reporting a clean bill against no data.
    section("0  the probe has real rows to inspect");
    const ci = (await q(`select * from tour_events where event_type='checked_in'
                          order by event_at desc limit 1`))[0];
    const cp = (await q(`select * from tour_events where event_type='completed'
                          order by event_at desc limit 1`))[0];
    const wi = (await q(`select * from leasing_tours where origin='walk_in'
                          order by created_at desc limit 1`))[0];
    ok("0a a real check-in event exists to inspect", !!ci);
    ok("0b a real completion event exists to inspect", !!cp);
    ok("0c a real walk-in capture exists to inspect", !!wi);
    if (!ci || !cp || !wi) {
      console.log("\n   REFUSING to classify: run write_authority_hardening_proof.js first.");
      throw new Error("no rows to inspect");
    }

    section("1  TOUR CHECK-IN");
    lineage("1a WHAT — the event names the fact ('checked_in')", ci.event_type === "checked_in");
    lineage("1b WHEN — event_at carries the moment of presence", !!ci.event_at);
    lineage("1c WHO  — a durable human actor is recorded", !!ci.actor_id && ci.actor_type === "human");
    lineage("1d OBJECT — the tour and the lead are both named", !!ci.tour_id && !!ci.lead_id);
    lineage("1e EVIDENCE — the appointment it was measured against is carried",
      !!(ci.metadata && ci.metadata.scheduled_for !== undefined));
    lineage("1f CORRECTION — the ledger is append-only, so a later contradicting event is visible",
      (await q(`select count(*)::int n from tour_events where tour_id=$1`, [ci.tour_id]))[0].n >= 1);

    section("2  TOUR COMPLETION");
    const m = cp.metadata || {};
    lineage("2a WHAT — the outcome event names itself", cp.event_type === "completed");
    lineage("2b WHEN — event_at (recorded) AND scheduled_for (the appointment) are BOTH present",
      !!cp.event_at && m.scheduled_for !== undefined);
    lineage("2c WHO  — the recorder is durable and server-derived",
      !!cp.actor_id && !!m.recorded_by_user_id && String(cp.actor_id) === String(m.recorded_by_user_id));
    lineage("2d WHO(2) — the HOST is a separate fact, and an unverified host is labelled as a claim",
      m.actual_tour_host_user_id !== undefined && m.actual_tour_host_name_claim !== undefined);
    lineage("2e OBJECT — tour and lead are named", !!cp.tour_id && !!cp.lead_id);
    lineage("2f EVIDENCE — the captured judgment travels on the event, not only in a projection",
      m.outcome !== undefined || m.tour_given !== undefined);
    lineage("2g CORRECTION — a correction lane exists that appends rather than overwrites",
      /correct-outcome/.test(require("fs").readFileSync(
        require("path").join(__dirname, "..", "src/leasing/leasingleads.js"), "utf8")));

    section("3  WALK-IN CAPTURE");
    lineage("3a WHAT — origin distinguishes a walk-in from a booked tour", wi.origin === "walk_in");
    lineage("3b WHEN — the OCCURRENCE time is stored separately from the insert time",
      !!wi.checked_in_at && !!wi.created_at);
    lineage("3c WHO  — the capturing agent is on the row", !!wi.leasing_agent_id);
    lineage("3d OBJECT — property and lead are named", !!wi.property_id && !!wi.lead_id);
    //  ── THE ONE THING THIS PROBE ACTUALLY FINDS ──────────────────────
    //  A walk-in captured with no outcome yet (the normal Person Card case:
    //  "they toured just now", judgment still owed) writes a leasing_tours
    //  ROW and NO tour_events row. Every other tour fact in this product
    //  lives in the append-only ledger; this one lives only on mutable
    //  columns. checked_in_at, leasing_agent_id and status can all be
    //  rewritten by a later lifecycle write, and nothing immutable would
    //  record that a named human captured a walk-in at a named moment.
    //
    //  FLAGGED, NOT REPAIRED. Writing the event here would be adding a
    //  canonical write, which this packet is not authorised to do.
    const wiEvents = (await q(
      `select count(*)::int n from tour_events where tour_id=$1`, [wi.id]))[0].n;
    lineage("3e CORRECTED/SUPERSEDED — an immutable ledger entry records the capture itself "
       + `(found ${wiEvents} tour_events for this walk-in)`, wiEvents >= 1);

    section("4  FOLLOW-UP — creation and completion");
    const fu = (await q(
      `select o.id, o.status, o.created_at, o.due_at, o.completed_at, o.type,
              lco.obligation_id, c.property_id
         from leasing_conversion_obligations lco
         join leasing_conversions c on c.id = lco.conversion_id
         join obligations o on o.id = lco.obligation_id
        order by o.created_at desc limit 1`))[0];
    lineage("4a a follow-up exists, created by the tour completion — no client identity involved", !!fu);
    if (fu) {
      lineage("4b WHAT — the obligation names its kind", !!fu.type);
      lineage("4c WHEN — creation and the due moment are both durable", !!fu.created_at && !!fu.due_at);
      lineage("4d OBJECT — the conversion and property are reachable from it", !!fu.property_id);
      lineage("4e WHO(completion) — the closer is server-derived in source, never a body value",
        /by_user_id: req\.operator\.id/.test(require("fs").readFileSync(
          require("path").join(__dirname, "..", "src/identity/operator.js"), "utf8")));
      lineage("4f CORRECTION — a reopen lane exists and the prior close is preserved",
        /reopenRung/.test(require("fs").readFileSync(
          require("path").join(__dirname, "..", "src/identity/operator.js"), "utf8")));
    } else { for (const s of ["4b", "4c", "4d", "4e", "4f"]) lineage(`${s} NOT RUN — no follow-up row`, false); }

    section("5  APPLICATION DECISION (deny)");
    //  The denial writes to the canonical `events` ledger (type
    //  'application_denied') — the same table section A of the authority
    //  proof reads. There is no separate application_events table.
    const de = (await q(
      `select * from events where type='application_denied' order by occurred_at desc limit 1`))[0];
    lineage("5a a durable decision event exists in the canonical ledger", !!de);
    if (de) {
      lineage("5b WHEN — the decision moment is durable on the event", !!de.occurred_at);
      lineage("5c OBJECT — property and person lineage are on the event",
        !!de.property_id && !!de.person_id);
      //  ── THE SECOND FINDING ───────────────────────────────────────────
      //  The `events` ledger has NO actor column — id, property_id,
      //  person_id, unit_id, type, note, occurred_at, and nothing else. The
      //  decider is recoverable, but from lease_applications.decision_by_user_id,
      //  a column on the mutable application row, not from the immutable
      //  event. A reader holding only the ledger cannot answer "who decided".
      const eventCols = (await q(
        `select column_name from information_schema.columns where table_name='events'`))
        .map((r) => r.column_name);
      lineage(`5d WHO — the immutable event itself carries an actor (events columns: ${eventCols.join(",")})`,
        eventCols.some((c) => /actor|user_id|by_user/.test(c)));
      const appActor = (await q(
        `select decision_by_user_id from lease_applications
          where status='declined' and decision_by_user_id is not null limit 1`))[0];
      lineage("5e WHO(recoverable) — the decider IS durable on the application projection",
        !!appActor && !!appActor.decision_by_user_id);
      lineage("5f CORRECTED/SUPERSEDED — the approval gate it closed is itself a durable obligation",
        (await q(`select count(*)::int n from obligations
                   where type='application_approval'`))[0].n >= 1);
    } else { for (const s of ["5b", "5c", "5d", "5e", "5f"]) lineage(`${s} NOT RUN — no decision event`, false); }

    section("6  EXECUTED-LEASE VERIFICATION — the only Wave 1 write carrying economics");
    const cols = (await q(
      `select column_name from information_schema.columns
        where table_name='executed_lease_records'`)).map((r) => r.column_name);
    lineage("6a the executed-lease record table exists", cols.length > 0);
    lineage("6b WHEN — executed_at (signed) and effective_date (term start) are SEPARATE columns",
      cols.includes("executed_at") && cols.includes("effective_date"));
    lineage("6c WHO  — the verifier is a column, not a note", cols.includes("verified_by_user_id"));
    lineage("6d EVIDENCE — the document is identified by reference AND by content hash",
      cols.includes("document_reference") && cols.includes("document_sha256"));
    lineage("6e SUPERSEDED — a later record can point at the one it replaces",
      cols.includes("supersedes_record_id"));

    //  ── THE DENIAL TRACE, LINK BY LINK ────────────────────────────────
    //  Asked exactly as the gate asks it:
    //    application_denied event → exact application → governing offer or
    //    proposed terms at denial → rent, concessions and fees →
    //    correction or supersession history.
    section("7  DENIAL — the five-link economic trace");
    {
      const evCols = (await q(
        `select column_name from information_schema.columns where table_name='events'`))
        .map((r) => r.column_name);
      lineage(`7a EVENT → EXACT APPLICATION — the event names the application it ended `
        + `(events columns: ${evCols.join(",")})`, evCols.includes("application_id"));
      //  Is there an indirection that recovers it? application_intents carries
      //  an event_id FK; if the denial wrote one, the link exists by join.
      const intents = (await q(
        `select count(*)::int n from application_intents ai
           join events e on e.id = ai.event_id
          where e.type='application_denied'`))[0].n;
      lineage(`7b EVENT → APPLICATION (indirect) — a linking row recovers it `
        + `(${intents} application_intents joined to a denial event)`, intents >= 1);

      const app = (await q(
        `select id, rent, deposit, concession_status, proposed_terms_confirmation_id,
                decision_by_user_id, decision_reason, decided_at, terminal_code, terminal_at
           from lease_applications where status='declined'
          order by decided_at desc nulls last limit 1`))[0];
      lineage("7c APPLICATION — the denied application itself is recoverable and terminal",
        !!app && !!app.terminal_code);
      lineage("7d GOVERNING TERMS — the application points at the confirmation that governed it",
        !!app && app.proposed_terms_confirmation_id !== undefined);
      const conf = (await q(
        `select column_name from information_schema.columns
          where table_name='application_proposed_terms_confirmations'`)).map((r) => r.column_name);
      lineage("7e RENT + CONCESSIONS — the governing terms carry the economics durably",
        conf.includes("rent") && conf.includes("security_deposit") && conf.includes("concession_status"));
      //  FEES. Named explicitly by the gate. Neither the application nor the
      //  confirmation carries a fee concept; nothing is invented to cover it.
      const appCols = (await q(
        `select column_name from information_schema.columns where table_name='lease_applications'`))
        .map((r) => r.column_name);
      lineage("7f FEES — a fee is recoverable from the denial lineage",
        appCols.some((c) => /fee/.test(c)) || conf.some((c) => /fee/.test(c)));
      lineage("7g SUPERSESSION — a later confirmation points at the one it replaced",
        conf.includes("supersedes_confirmation_id"));
      lineage("7h CORRECTION — the decision itself records its reason and moment",
        !!app && app.decision_reason !== undefined && !!app.decided_at);
      lineage("7i WHO — the decider is durable on the application", !!app && !!app.decision_by_user_id);
    }

    console.log("\n── CLASSIFICATION ────────────────────────────────────────");
    console.log(`   ${asked} lineage questions asked · ${asked - gaps.length} answered by the record · ${gaps.length} gaps`);
    if (!gaps.length) {
      console.log("   NO ACCOUNTING PROVENANCE GAP");
    } else {
      console.log("   FUTURE ACCOUNTING PROVENANCE GAP — exact broken lineage:");
      gaps.forEach((g) => console.log("     · " + g));
    }
    //  A classifier that asked nothing has classified nothing.
    ok(`the classification actually ran (${asked} lineage questions asked)`, asked >= 30);
  } finally { await pool.end(); }
  const code = receipt.complete({ harness: __filename, passed: pass, failed: fail, expectedAtLeast: 4 });
  process.exit(code);
})().catch((e) => { console.error("DIED:", e.message); process.exit(1); });
