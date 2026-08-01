/* ══════════════════════════════════════════════════════════════════════════
   slice9_evidence_proof.js — Slice 9 steps 2–6, against REAL Postgres.

   Seeds a complete funnel — opportunity → tours (with a reschedule chain) →
   application → approval → executed lease — inside a transaction, then proves
   the rules that are easy to get wrong and impossible to notice:

     · a rescheduled journey is ONE appointment journey, not three tours;
     · a scheduled tour is not a completed tour;
     · a completed tour with no captured outcome stays in the denominator;
     · a cyclic chain is untrackable, never silently resolved;
     · an application with no canonical opportunity link is uncorrelated,
       never matched by name or timing;
     · milestone achievement, not current status — an application that
       advanced past approved still reached it;
     · a zero denominator returns rate null, never 0%;
     · every metric carries a definition version.

   Requires DATABASE_URL. Refuses to report green without it.
   ══════════════════════════════════════════════════════════════════════════ */
"use strict";
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const REPO = path.join(__dirname, "..");
const { resolveOperatingWindow } = require(path.join(REPO, "src/shared/operating_window"));
const { buildMetric, METRIC_DEFINITIONS } = require(path.join(REPO, "src/evidence/metric_contract"));
const { resolveChains } = require(path.join(REPO, "src/evidence/tour_demand"));
const { reached } = require(path.join(REPO, "src/evidence/conversion"));
const { marketEvidenceProjection } = require(path.join(REPO, "src/evidence/evidence_projection"));

let pass = 0, fail = 0;
const ok = (m, c) => { if (c) { pass++; console.log("   PASS  " + m); } else { fail++; console.log("   FAIL  " + m); } };
const section = (t) => console.log("\n── " + t + " " + "─".repeat(Math.max(0, 54 - t.length)));
const uuid = () => crypto.randomUUID();

if (!process.env.DATABASE_URL) {
  console.error("\nDATABASE_URL is required. This proof asserts against real Postgres and will not fake a pass.\n");
  process.exit(1);
}
const asPool = (c) => ({ query: (...a) => c.query(...a) });

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  section("A  contract rules, in isolation");
  {
    const w = { state: "ok", property_id: "p", operating_timezone: "America/New_York",
      window_start_local: "2026-08-01", window_end_local: "2026-08-31",
      window_start_utc: "2026-08-01T04:00:00.000Z", window_end_utc: "2026-09-01T04:00:00.000Z",
      as_of_utc: "2026-08-15T00:00:00.000Z" };
    const zero = buildMetric({ metric_code: "s9.lead_demand.opportunities_received.v1", window: w, numerator: 0, denominator: 0 });
    ok("zero denominator ⇒ rate null, never 0%", zero.rate === null && zero.denominator === 0);
    const third = buildMetric({ metric_code: "s9.conversion.all_opportunity_to_completed_tour.v1", window: w, numerator: 8, denominator: 24 });
    ok("rate is a DECIMAL 0–1, not a formatted percentage", third.rate === 0.333333);
    ok("definition_version is derived from the code, so they cannot drift", third.definition_version === "v1");
    ok("cohort basis and dedup key travel with the number",
      !!third.cohort_basis && third.deduplication_key === "leasing_leads.id");
    const noTz = buildMetric({ metric_code: "s9.lead_demand.opportunities_received.v1",
      window: { state: "unavailable", reason: "property_operating_timezone_not_configured" }, numerator: 5, denominator: 10 });
    ok("no timezone ⇒ unavailable, and the number is withheld",
      noTz.state === "unavailable" && noTz.rate === null && noTz.numerator === null);
    let refused = false;
    try { buildMetric({ metric_code: "s9.made_up_metric.v1", window: w }); } catch (_) { refused = true; }
    ok("an unregistered metric cannot be published", refused);
    ok("every registered metric code carries an explicit version",
      Object.keys(METRIC_DEFINITIONS).every((c) => /\.v\d+$/.test(c)));
  }

  section("B  reschedule chains and milestone logic, in isolation");
  {
    const chain = resolveChains([
      { id: "a", rescheduled_from: null }, { id: "b", rescheduled_from: "a" }, { id: "c", rescheduled_from: "b" },
    ]);
    ok("a 3-leg reschedule chain resolves to ONE root",
      new Set([...chain.rootById.values()]).size === 1 && chain.untrackable.size === 0);
    const cyc = resolveChains([{ id: "x", rescheduled_from: "y" }, { id: "y", rescheduled_from: "x" }]);
    ok("a cyclic chain is untrackable, not silently resolved", cyc.untrackable.size === 2);
    const orphan = resolveChains([{ id: "o", rescheduled_from: "missing" }]);
    ok("a broken parent is untrackable", orphan.untrackable.has("o"));

    ok("milestone: countersigned still REACHED approved", reached("countersigned", "approved"));
    ok("milestone: submitted has NOT reached approved", !reached("submitted", "approved"));
    ok("milestone: draft has not reached submitted", !reached("draft", "submitted"));
  }

  const c = await pool.connect();
  try {
    await c.query("begin");
    const P = asPool(c);
    const prop = (await c.query("select id from properties limit 1")).rows[0].id;
    await c.query("update properties set operating_timezone='America/New_York' where id=$1", [prop]);

    const win = await resolveOperatingWindow(P, {
      property_id: prop, start_local: "2026-08-01", end_local: "2026-08-31",
      as_of: "2026-09-15T00:00:00Z",
    });
    ok("window is property-local and half-open",
      win.window_start_utc === "2026-08-01T04:00:00.000Z" && win.window_end_utc === "2026-09-01T04:00:00.000Z");

    // ── seed a full funnel ──────────────────────────────────────────
    const mkPerson = async (n) => { const id = uuid();
      await c.query("insert into persons (id,name,phone) values ($1,$2,$3)", [id, n, "+1555" + Math.floor(1e6 + Math.random() * 8e6)]); return id; };
    const mkLead = async (pid, at, resp) => { const id = uuid();
      await c.query("insert into leasing_leads (id,person_id,property_id,status,received_at,first_response_at) values ($1,$2,$3,'new',$4,$5)",
        [id, pid, prop, at, resp]); return id; };
    const mkTour = async (lead, status, createdAt, completedAt, from) => { const id = uuid();
      await c.query(`insert into leasing_tours (id,lead_id,property_id,status,created_at,completed_at,rescheduled_from)
                     values ($1,$2,$3,$4,$5,$6,$7)`, [id, lead, prop, status, createdAt, completedAt, from || null]); return id; };

    const AUG = "2026-08-10T15:00:00Z";
    // Opportunity 1: reschedules twice, then completes. ONE journey.
    const p1 = await mkPerson("Resched Prospect");
    const l1 = await mkLead(p1, AUG, "2026-08-10T15:02:00Z");
    const t1a = await mkTour(l1, "rescheduled", AUG, null, null);
    const t1b = await mkTour(l1, "rescheduled", "2026-08-11T15:00:00Z", null, t1a);
    await mkTour(l1, "completed", "2026-08-12T15:00:00Z", "2026-08-14T18:00:00Z", t1b);
    // Opportunity 2: scheduled only — demand, NOT conversion.
    const p2 = await mkPerson("Scheduled Only");
    const l2 = await mkLead(p2, AUG, null);
    await mkTour(l2, "scheduled", AUG, null, null);
    // Opportunity 3: completed tour, no outcome captured.
    const p3 = await mkPerson("No Outcome");
    const l3 = await mkLead(p3, AUG, "2026-08-10T16:00:00Z");
    await mkTour(l3, "completed", AUG, "2026-08-13T18:00:00Z", null);

    const out = await marketEvidenceProjection(P, {
      property_id: prop, start_local: "2026-08-01", end_local: "2026-08-31", as_of: "2026-09-15T00:00:00Z",
    });
    const td = out.sections.tour_demand, ld = out.sections.lead_demand, cv = out.sections.conversion;

    section("C  tour demand — the journey, not the row");
    ok("three opportunities produced THREE journeys, not five tours", td.counts.appointment_journeys === 3);
    ok("booking attempts are reported separately and DO count every leg", td.counts.booking_attempts === 5);
    ok("reschedules are counted", td.counts.reschedule_count === 2);
    ok("two journeys completed", td.counts.completed === 2);
    ok("a scheduled-only journey is NOT completed", td.counts.scheduled === 1);
    ok("a completed tour with no captured outcome is counted as unknown", td.counts.outcome_unknown === 2);
    ok("outcome-capture denominator is completed journeys, not all journeys",
      td.metrics.outcome_capture.denominator === 2);
    ok("missing outcomes are NOT excluded from the denominator",
      td.metrics.outcome_capture.numerator === 0 && td.metrics.outcome_capture.rate === 0);

    section("D  lead demand — typed facts only");
    ok("three opportunities received in the window", ld.counts.opportunities_received === 3);
    ok("first-response coverage counts only recorded responses", ld.counts.first_response_present === 2);
    ok("a missing first response is an unknown, not a zero", ld.counts.first_response_missing === 1);
    ok("the non-additive attribution model is disclosed on the section",
      ld.attribution_model === "multi_touch_non_additive");
    ok("free-text intent is structurally excluded, not merely unused",
      ld.excluded_by_ruling.some((s) => /parsed budget/.test(s)));

    section("E  conversion — origin cohorts");
    ok("funnel 1 denominator is opportunities received in the window",
      cv.metrics.f1all.denominator === 3);
    ok("funnel 1 numerator counts opportunities that reached a COMPLETED tour",
      cv.metrics.f1all.numerator === 2);
    ok("funnel 1 rate is the decimal, not a percentage string",
      Math.abs(cv.metrics.f1all.rate - 0.666667) < 1e-6);
    ok("a scheduled-only opportunity is reported PENDING, not failed",
      cv.metrics.f1all.pending_count === 1);
    ok("funnel 2 denominator is journeys completed IN the window",
      cv.metrics.f2.denominator === 2);
    ok("no application yet ⇒ funnel 2 numerator zero with a real denominator",
      cv.metrics.f2.numerator === 0 && cv.metrics.f2.rate === 0);
    ok("every conversion metric carries a definition version",
      Object.values(cv.metrics).every((m) => /^v\d+$/.test(m.definition_version)));

    section("F  correlation is canonical or untrackable");
    const appUn = uuid();
    await c.query(`insert into lease_applications (id,property_id,person_id,status,created_at)
                   values ($1,$2,$3,'submitted',$4)`, [appUn, prop, p2, AUG]);
    const out2 = await marketEvidenceProjection(P, {
      property_id: prop, start_local: "2026-08-01", end_local: "2026-08-31", as_of: "2026-09-15T00:00:00Z" });
    ok("an application with no leasing_lead_id is UNCORRELATED, not matched by person",
      out2.sections.conversion.correlation.uncorrelated_count >= 1);
    ok("uncorrelated applications remain visible in coverage facts",
      out2.sections.conversion.correlation.applications_total >= 1);
    ok("it is NOT counted into funnel 2's numerator by inference",
      out2.sections.conversion.metrics.f2.numerator === 0);

    section("G  milestone achievement beats current status");
    const appOk = uuid();
    await c.query(`insert into lease_applications (id,property_id,person_id,leasing_lead_id,status,created_at,decided_at)
                   values ($1,$2,$3,$4,'countersigned',$5,$6)`,
      [appOk, prop, p1, l1, "2026-08-16T12:00:00Z", "2026-08-20T12:00:00Z"]);
    const out3 = await marketEvidenceProjection(P, {
      property_id: prop, start_local: "2026-08-01", end_local: "2026-08-31", as_of: "2026-09-15T00:00:00Z" });
    ok("an application that advanced to countersigned still counts as SUBMITTED",
      out3.sections.conversion.metrics.f3.denominator === 2);
    ok("and still counts as having REACHED approved",
      out3.sections.conversion.metrics.f3.numerator === 1);
    ok("a correlated application now converts its completed journey",
      out3.sections.conversion.metrics.f2.numerator === 1);
    ok("funnel 4 cohort is approvals dated inside the window",
      out3.sections.conversion.metrics.f4.denominator === 1);
    ok("no executed lease yet ⇒ funnel 4 numerator zero, pending reported",
      out3.sections.conversion.metrics.f4.numerator === 0 && out3.sections.conversion.metrics.f4.pending_count === 1);

    section("H  the three absent domains stay absent");
    ok("rent survey is not_connected", out3.sections.rent_survey.state === "not_connected");
    ok("listings is not_connected", out3.sections.listings.state === "not_connected");
    ok("market context is not_connected", out3.sections.market_context.state === "not_connected");
    ok("no sample rows are invented for them",
      !out3.sections.rent_survey.rows && !out3.sections.listings.rows);

    section("I  no timezone ⇒ every section refuses, none invents UTC");
    await c.query("update properties set operating_timezone=null where id=$1", [prop]);
    const noTz = await marketEvidenceProjection(P, {
      property_id: prop, start_local: "2026-08-01", end_local: "2026-08-31" });
    ok("window state is unavailable with the shared reason",
      noTz.window.state === "unavailable" && noTz.window.reason === "property_operating_timezone_not_configured");
    ok("lead demand refuses", noTz.sections.lead_demand.state === "unavailable");
    ok("tour demand refuses", noTz.sections.tour_demand.state === "unavailable");
    ok("conversion refuses", noTz.sections.conversion.state === "unavailable");
    ok("no UTC-bucketed substitute is produced", noTz.window.start_utc === null);

    await c.query("rollback");
  } finally { c.release(); }

  section("J  nothing survived the rollback");
  const left = (await pool.query(
    "select count(*)::int n from leasing_tours where status='rescheduled'")).rows[0].n;
  ok("seeded tours did not persist", left === 0);

  await pool.end();
  console.log(`\n════ ${pass} passed, ${fail} failed ════\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nPROOF CRASHED:", e.message, "\n"); process.exit(1); });
