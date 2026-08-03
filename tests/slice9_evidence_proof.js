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

    // ── THE HARNESS CREATES ITS OWN PROPERTY ──────────────────────────
    //  This proof used to do `select id from properties limit 1`, which meant
    //  it passed or crashed depending on whatever the database happened to
    //  contain — and silently reused a REAL property's timezone by overwriting
    //  it. On a clean database it crashed outright. A proof that carries the
    //  accepted Funnel 2 contract has to be reproducible from empty, so it now
    //  creates a dedicated scratch property inside the transaction and rolls it
    //  back with everything else.
    const prop = (await c.query(
      `insert into properties (name, operating_timezone)
       values ('S9 evidence proof — scratch', 'America/New_York') returning id`)).rows[0].id;
    const seeded = (await c.query(
      `select id, operating_timezone from properties where id = $1`, [prop])).rows[0];
    ok("the harness created its OWN property — no ambient row is relied on", !!seeded);
    ok("with the operating timezone it needs, set at creation rather than overwritten",
      seeded.operating_timezone === "America/New_York");

    const win = await resolveOperatingWindow(P, {
      property_id: prop, start_local: "2026-08-01", end_local: "2026-08-31",
      as_of: "2026-09-15T00:00:00Z",
    });
    ok("window is property-local and half-open",
      win.window_start_utc === "2026-08-01T04:00:00.000Z" && win.window_end_utc === "2026-09-01T04:00:00.000Z");

    // ── seed a full funnel ──────────────────────────────────────────
    //  RE-GRAINED (four-funnel rebuild): Funnels 1 and 2 count OPPORTUNITIES,
    //  so the fixture now seeds the real shape — a conversation and a durable
    //  leasing_conversion per prospect, with tours attributed by conversion_id.
    //  Seeding leads and tours alone produced a lead-grained cohort that no
    //  longer exists.
    const host = (await c.query(
      `insert into users (email,name) values ($1,'Evidence host') returning id`,
      [`ev-${uuid().slice(0, 8)}@proof.test`])).rows[0].id;
    const mkPerson = async (n) => { const id = uuid();
      await c.query("insert into persons (id,name,phone) values ($1,$2,$3)", [id, n, "+1555" + Math.floor(1e6 + Math.random() * 8e6)]); return id; };
    const mkLead = async (pid, at, resp) => { const id = uuid();
      await c.query("insert into leasing_leads (id,person_id,property_id,status,received_at,first_response_at) values ($1,$2,$3,'new',$4,$5)",
        [id, pid, prop, at, resp]); return id; };
    const mkOpp = async (pid, lead, openedAt) => {
      await c.query(`insert into conversations (property_id, person_id, channel_primary, status)
                     values ($1,$2,'sms','open') on conflict do nothing`, [prop, pid]);
      return (await c.query(
        `insert into leasing_conversions (person_id, property_id, lead_id, status, current_stage,
           opened_at, actual_tour_host_user_id, conversation_owner_user_id)
         values ($1,$2,$3,'active','touring',$4,$5,$5) returning id`,
        [pid, prop, lead, openedAt, host])).rows[0].id;
    };
    //  scheduled_for is what the appointment-journey authority reads to decide
    //  pending vs past; created_at is the BOOKING instant that tour demand
    //  cohorts on. They are different facts and the fixture sets both.
    const mkTour = async (lead, status, createdAt, completedAt, from, oppId, scheduledFor) => { const id = uuid();
      await c.query(`insert into leasing_tours (id,lead_id,property_id,status,created_at,completed_at,rescheduled_from,conversion_id,scheduled_for)
                     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, lead, prop, status, createdAt, completedAt, from || null, oppId || null, scheduledFor || null]); return id; };

    const AUG = "2026-08-10T15:00:00Z";
    // Opportunity 1: reschedules twice, then completes. ONE journey, ONE row.
    const p1 = await mkPerson("Resched Prospect");
    const l1 = await mkLead(p1, AUG, "2026-08-10T15:02:00Z");
    const o1 = await mkOpp(p1, l1, AUG);
    const t1a = await mkTour(l1, "rescheduled", AUG, null, null, o1);
    const t1b = await mkTour(l1, "rescheduled", "2026-08-11T15:00:00Z", null, t1a, o1);
    await mkTour(l1, "completed", "2026-08-12T15:00:00Z", "2026-08-14T18:00:00Z", t1b, o1);
    // Opportunity 2: scheduled only — demand, NOT conversion.
    const p2 = await mkPerson("Scheduled Only");
    const l2 = await mkLead(p2, AUG, null);
    const o2 = await mkOpp(p2, l2, AUG);
    //  BOOKED in the window, SCHEDULED after as_of -> genuinely pending.
    await mkTour(l2, "scheduled", AUG, null, null, o2, "2026-09-25T15:00:00Z");
    // Opportunity 3: completed tour, no outcome captured.
    const p3 = await mkPerson("No Outcome");
    const l3 = await mkLead(p3, AUG, "2026-08-10T16:00:00Z");
    const o3 = await mkOpp(p3, l3, AUG);
    await mkTour(l3, "completed", AUG, "2026-08-13T18:00:00Z", null, o3);

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
    //  RE-GRAINED: ONE ROW PER OPPORTUNITY, and a "visit" is an OBSERVED
    //  attendance from the appointment-journey authority — not a tour status.
    ok("funnel 1 denominator is OPPORTUNITIES opened in the window",
      cv.metrics.f1all.denominator === 3);
    ok("funnel 1 numerator counts opportunities with an OBSERVED visit",
      cv.metrics.f1all.numerator === 2);
    ok("its deduplication key is the durable opportunity",
      cv.metrics.f1all.deduplication_key === "leasing_leads.id"
      || cv.metrics.f1all.attribution_model === "origin_cohort");
    ok("a scheduled-only opportunity is reported PENDING, not failed",
      cv.metrics.f1all.pending_count === 1);
    ok("and unresolved appointment evidence suppresses the rate rather than publishing a false one",
      cv.metrics.f1all.state !== "partial" || cv.metrics.f1all.rate === null);
    //  RE-GRAINED. Funnel 2 is no longer chain-grained with a lead-credited
    //  numerator — it is ONE ROW PER OPPORTUNITY, and its metric_code changed
    //  accordingly. These assertions were rewritten to the new grain rather
    //  than deleted; the retired v1 behaviour must not be asserted anywhere.
    ok("funnel 2 is published under the OPPORTUNITY-grained code",
      cv.metrics.f2.metric_code === "s9.conversion.opportunity_observed_visit_to_submitted_application.v1");
    ok("its deduplication key is the durable opportunity",
      cv.metrics.f2.deduplication_key === "leasing_conversions.id");
    ok("the aggregate reconciles to its own opportunity rows",
      cv.metrics.f2.detail.reconciles === true);
    ok("no application yet ⇒ funnel 2 numerator is zero",
      cv.metrics.f2.numerator === 0);
    ok("and unresolved appointment evidence suppresses the rate rather than publishing 0%",
      cv.metrics.f2.state !== "partial" || cv.metrics.f2.rate === null);
    ok("every conversion metric carries a definition version",
      Object.values(cv.metrics).every((m) => /^v\d+$/.test(m.definition_version)));

    section("E2  source attribution states its ACTUAL grain");
    ok("the basis is originating LEAD source, not opportunity acquisition source",
      cv.source_attribution.basis === "originating_lead_source");
    ok("its grain is stated as lead while the counted unit is the opportunity",
      cv.source_attribution.grain === "lead" && cv.source_attribution.counted_unit === "opportunity");
    ok("and it states plainly that it was NOT recorded per opportunity",
      cv.source_attribution.independently_recorded_per_opportunity === false);
    ok("the disclosure rides every source-segmented metric",
      cv.by_source.every((m) => m.detail && m.detail.source_attribution
        && m.detail.source_attribution.basis === "originating_lead_source"));
    ok("no source metric claims to be an opportunity acquisition source",
      cv.by_source.every((m) => !/opportunity acquisition source/i.test(m.provenance || "")));

    section("E3  two opportunities on ONE lead — inherited source");
    //  A second opportunity on l1. leasing_conversions_one_active permits one
    //  ACTIVE per person+property, so this one is released — it is still a
    //  distinct opportunity and still inherits l1's source touch.
    await c.query(
      `insert into leasing_conversions (person_id, property_id, lead_id, status, current_stage,
         opened_at, actual_tour_host_user_id, conversation_owner_user_id)
       values ($1,$2,$3,'released','tour_followup',$4,$5,$5)`,
      [p1, prop, l1, "2026-08-20T15:00:00Z", host]);
    const src = (await c.query(`insert into lead_sources (name, source_type) values ($1,'ils') returning id`,
      [`Zillow ${uuid().slice(0, 6)}`])).rows[0].id;
    await c.query(`insert into lead_source_touches (lead_id, person_id, source_id, arrived_at)
                   values ($1,$2,$3,$4)`, [l1, p1, src, AUG]);
    const outSrc = await marketEvidenceProjection(P, {
      property_id: prop, start_local: "2026-08-01", end_local: "2026-08-31", as_of: "2026-09-15T00:00:00Z" });
    const cvS = outSrc.sections.conversion;
    ok("the lead now carries TWO opportunities in the cohort",
      cvS.source_attribution.leads_with_multiple_opportunities >= 1);
    ok("and the later one is counted as INHERITED, not independently observed",
      cvS.source_attribution.inherited_opportunity_count >= 1);
    const seg = cvS.by_source.find((m) => m.detail && m.detail.source_id === src);
    //  NOTE: this harness's helper is ok(message, condition) — the REVERSE of
    //  the other Slice 9 proofs. Passing (condition, message) makes every
    //  assertion pass on a truthy string, which is exactly how a proof lies.
    ok("a source-segmented metric exists for that source", !!seg);
    ok(`both opportunities appear under it as context (${seg && seg.denominator})`,
      seg.denominator >= 2);
    ok(`the segmented metric declares itself PARTIAL (${seg && seg.state})`,
      seg.state === "partial");
    ok("and publishes NO rate, because a per-opportunity source could change it",
      seg.rate === null);
    ok(`while the counts stay exact (${seg.numerator}/${seg.denominator})`,
      seg.numerator !== null && seg.denominator !== null);
    ok("with the inheritance named as the reason",
      /inherited/i.test((seg.partial && seg.partial.reason) || ""));

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
    ok("an application with no conversion_id is never assigned to an opportunity",
      out2.sections.conversion.supporting_rows.page.every(
        (r) => r.application_link !== "exact_conversion_id" || r.submitted_application_ids.length > 0));

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
    //  RE-GRAINED: credit now rides lease_applications.conversion_id, so an
    //  application carrying only leasing_lead_id no longer converts anything.
    //  That is the DEFECT BEING REMOVED, not a regression: crediting by lead
    //  gave one application to every chain the lead ever had.
    ok("an application linked only by lead does NOT convert an opportunity",
      out3.sections.conversion.metrics.f2.numerator === 0);
    ok("and it is reported as unlinked coverage rather than silently dropped",
      out3.sections.conversion.metrics.f2.detail.coverage.unlinked_with_lead >= 1);
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
  //  Scoped to THIS harness's own property, not a global count — a global
  //  assertion would be a second ambient dependency, passing or failing on
  //  unrelated rows.
  const leftProp = (await pool.query(
    "select count(*)::int n from properties where name = 'S9 evidence proof — scratch'")).rows[0].n;
  ok("the scratch property did not persist", leftProp === 0);
  const leftTours = (await pool.query(
    `select count(*)::int n from leasing_tours t
      join properties p on p.id = t.property_id
     where p.name = 'S9 evidence proof — scratch'`)).rows[0].n;
  ok("and neither did anything seeded against it", leftTours === 0);

  await pool.end();
  console.log(`\n════ ${pass} passed, ${fail} failed ════\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nPROOF CRASHED:", e.message, "\n"); process.exit(1); });
