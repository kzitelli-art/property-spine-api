// ════════════════════════════════════════════════════════════════════
//  authority_resolution_proof.js — the controlled path, before the ruling
//
//  Proves the authority tool refuses everything it must, the ruling packet is
//  read-only, the privileged actor contract cannot be forged, and the pricing
//  rehearsal stops exactly where authority stops.
//
//  Run: DATABASE_URL=... node tests/authority_resolution_proof.js
// ════════════════════════════════════════════════════════════════════

"use strict";
const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");
const REPO = path.resolve(__dirname, "..");
const DEMO = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";
const OTHER = "9e2bb96e-08e2-41db-81c2-91055ceb50a3";
const DEMO_LEAD = "16b442ee-0ec5-425a-90f3-ab8708a15b77";
const STAFF_PERSON = "bfa835d8-4b6e-4065-8327-8f2cfe95b49b";
const STAFF_USER = "492f97b0-5e76-4197-b110-c0afb0e64e15";
const QA_USER = "e9a7659f-ee1a-4bde-9e0c-02c6632ff066";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("   PASS  " + m); } else { fail++; console.log("   FAIL  " + m); } };
const sec = (s) => console.log("\n== " + s + " ==");
const failed = (r, id) => r.receipt.evidence.find((c) => c.id === id && !c.passed);

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) { console.log("FATAL: DATABASE_URL required"); process.exit(1); }
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

  const { resolveAuthority } = require(path.join(REPO, "src/identity/authority_resolution"));
  const { demoOwnerRulingPacket } = require(path.join(REPO, "src/identity/demo_owner_ruling_packet"));
  const pac = require(path.join(REPO, "src/identity/privileged_actor_contract"));
  const { rehearseVersionOne } = require(path.join(REPO, "src/money/pricing_rehearsal"));

  sec("AUTHORITY RESOLUTION — dry run refuses what it must");
  const base = { property_id: DEMO, reviewer_user_id: QA_USER, reason: "harness",
                 requested_role: "owner" };

  const noUser = await resolveAuthority(pool, { spec: { ...base, person_id: STAFF_PERSON } });
  ok(noUser.disposition === "dry_run_no_write_performed", "the dry run writes nothing");
  ok(noUser.would_apply === false && !!failed(noUser, "user_is_real_login"), "no login is refused");

  const demoLead = await resolveAuthority(pool, { spec: { ...base, user_id: STAFF_USER, person_id: DEMO_LEAD } });
  ok(demoLead.would_apply === false, "the demo lead is refused as an authority subject");
  ok(!!failed(demoLead, "person_is_classified_staff"), "…because it carries no governed staff context");
  ok(!!failed(demoLead, "person_is_not_a_counterparty"), "…and because it was a demo TENANT");
  ok(/tenant in \d+ demo run/i.test(failed(demoLead, "person_is_not_a_counterparty").detail),
    "the refusal cites the demo_attempts evidence, not the label");

  const unclassified = await resolveAuthority(pool, { spec: { ...base, user_id: QA_USER, person_id: STAFF_PERSON } });
  ok(!!failed(unclassified, "person_is_classified_staff"),
    "an account that is not human_staff is refused");
  ok(unclassified.outstanding_sequence_steps[0] === "classify_account_as_human_staff",
    "and the tool names classification as the outstanding FIRST step");
  ok(unclassified.outstanding_sequence_steps.length >= 2,
    `the write sequence is kept separate (${unclassified.outstanding_sequence_steps.join(" → ")})`);

  const crossProp = await resolveAuthority(pool, {
    spec: { ...base, property_id: OTHER, user_id: STAFF_USER, person_id: STAFF_PERSON } });
  ok(!!failed(crossProp, "person_entitled_to_property"), "a cross-property proposal is refused");

  const conflict = await resolveAuthority(pool, {
    spec: { ...base, user_id: STAFF_USER, person_id: STAFF_PERSON, requested_role: "owner" } });
  ok(!!failed(conflict, "no_silent_overwrite"),
    "an existing property_manager assignment is never silently overwritten");

  const badRole = await resolveAuthority(pool, {
    spec: { ...base, user_id: STAFF_USER, person_id: STAFF_PERSON, requested_role: "property_manager" } });
  ok(!!failed(badRole, "proposal_is_property_scoped"),
    "property_manager is refused as an authority-bearing role");

  const noReview = await resolveAuthority(pool, {
    spec: { property_id: DEMO, user_id: STAFF_USER, person_id: STAFF_PERSON, requested_role: "owner" } });
  ok(!!failed(noReview, "reviewed_and_not_name_based"), "an unreviewed proposal is refused");

  let applyErr = null;
  try { await resolveAuthority(pool, { spec: { ...base, user_id: STAFF_USER, person_id: DEMO_LEAD }, apply: true }); }
  catch (e) { applyErr = e.message; }
  ok(/refused/.test(applyErr || ""), "apply THROWS rather than writing when any check fails");
  const arSrc = fs.readFileSync(path.join(REPO, "src/identity/authority_resolution.js"), "utf8")
    .split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  ok(!/update\s+users\s+set|insert\s+into\s+person_contexts|update\s+persons/i.test(arSrc),
    "the tool never classifies, links or edits a person — authority only");
  ok(!/lower\(.*name.*\)|ilike|name\s*=/i.test(arSrc), "no comparison reads a display name");

  sec("DEMO OWNER RULING PACKET — read-only");
  const pk = await demoOwnerRulingPacket(pool, {});
  ok(pk.disposition === "read_only_ruling_packet_nothing_altered", "the packet alters nothing");
  ok(pk.everything_attached.swept_tables > 50,
    `all ${pk.everything_attached.swept_tables} person-referencing tables were swept, not a hand-picked list`);
  ok(pk.everything_attached.attachments.length === 2,
    `exactly ${pk.everything_attached.attachments.length} attachments exist portfolio-wide`);
  ok(pk.everything_attached.attachments.some((a) => a.table === "assignments"),
    "one is the owner assignment itself");
  ok(pk.everything_attached.attachments.some((a) => a.table === "demo_attempts"),
    "the other is a demo_attempts row — it was the demo TENANT");
  ok(pk.historical_privileged_use.ever_exercised === false,
    "this authority has NEVER been exercised — removing it rewrites no history");
  ok(pk.authority_currently_carried.reachable_by_a_login === false,
    "and it is unreachable: no login is linked to it");
  ok(pk.options.length === 4, "all four options are presented");
  ok(pk.options.find((o) => o.option === "transfer_it_to_the_staff_person").preserves_history === false,
    "transfer is shown as NOT preserving history");
  ok(/false/i.test(pk.options.find((o) => o.option === "transfer_it_to_the_staff_person").consequence),
    "…because the row's timestamp and provenance would silently describe a different human");
  ok(pk.recommendation_is_ownerships_to_make === true, "the packet does not choose");
  ok(pk.classified_as_lead_because.some((r) => r.fact === "no_staff_context"),
    "the lead classification rests on the absence of a governed staff context");

  sec("PRIVILEGED ACTOR CONTRACT — an actor cannot be forged");
  let e1 = null;
  try { pac.requireResolvedActor(DEMO_LEAD); } catch (e) { e1 = e.code; }
  ok(e1 === "bare_person_id_supplied", "a bare person id is refused");
  let e2 = null;
  try { pac.requireResolvedActor({ acting_person_id: DEMO_LEAD, kind: "human" }); } catch (e) { e2 = e.code; }
  ok(e2 === "unresolved_actor", "a hand-built impostor object is refused");
  // The attack this closes: spread a REAL actor and swap the person.
  const real = pac.systemActor("seed");
  ok(pac.isResolvedActor(real) === true, "a minted actor passes");
  ok(pac.isResolvedActor({ ...real }) === false,
    "a SPREAD COPY fails — membership is a registry, not a property, so it cannot be copied");
  ok(pac.isResolvedActor({ ...real, acting_person_id: DEMO_LEAD }) === false,
    "and a spread copy with a SWAPPED PERSON fails — identity is not mutable by one spread");
  ok(Object.isFrozen(real), "a minted actor is frozen, so the original cannot be edited either");
  const sys = pac.systemActor("migration", { property_id: DEMO });
  ok(pac.isResolvedActor(sys) && sys.acting_person_id === null,
    "a system actor is valid and explicitly has NO human");
  ok(sys.authority_basis === "system:migration", "and names its own authority basis");
  let e3 = null;
  try { await pac.actorFromSession(pool, { user_id: QA_USER, property_id: DEMO, verb: "may_publish_pricing" }); }
  catch (e) { e3 = e.code; }
  ok(e3 === "session_identity_not_linked_to_a_person",
    "actorFromSession refuses an unlinked session — the only mint reads the session");
  const pacSrc = fs.readFileSync(path.join(REPO, "src/identity/privileged_actor_contract.js"), "utf8");
  ok(!/module\.exports[^}]*SEAL/.test(pacSrc), "the seal symbol is never exported");
  ok(pac.LEDGER_MIGRATION.target.includes("commitmentledger"),
    "the ledger migration plan travels with the contract");
  ok(/LATENT, not live/.test(pac.LEDGER_MIGRATION.risk_today),
    "and states honestly that the defect is latent, not live");

  sec("PRICING REHEARSAL — stops where authority stops, leaves nothing");
  const before = (await pool.query(
    `select (select count(*)::int from property_pricing_versions) v,
            (select count(*)::int from pricing_terms) t,
            (select count(*)::int from pricing_review_receipts) r`)).rows[0];
  const reh = await rehearseVersionOne(pool, { property_id: DEMO, user_id: QA_USER });
  ok(reh.disposition === "rehearsal_rollback_only_nothing_published", "the rehearsal publishes nothing");
  ok(reh.runnable === false && reh.stopped_at === "may_prepare_pricing",
    `it stops at ${reh.stopped_at} — the exact gate ownership must resolve`);
  ok(reh.steps.find((s) => s.step === "verified_staff_person").passed === false,
    "and reports WHY: the session is not linked to a verified person");
  ok(/constructed/i.test(reh.economics.note), "the economics are declared constructed, not chosen");
  ok(reh.economics.base_rent === 1234, "and are obviously not a real rent");
  ok(reh.unchanged.published_version === true, "no published version exists after the run");
  ok(reh.unchanged.future_rent_roll_projected_positions === true, "no Future Rent Roll total changed");
  ok(reh.unchanged.concessions_active === true, "no concession became active");
  ok(/adapter is still dark/.test(reh.unchanged.live_ai_consumer), "no live AI consumer changed");
  const after = (await pool.query(
    `select (select count(*)::int from property_pricing_versions) v,
            (select count(*)::int from pricing_terms) t,
            (select count(*)::int from pricing_review_receipts) r`)).rows[0];
  ok(JSON.stringify(before) === JSON.stringify(after),
    `pricing tables are byte-identical before and after (${JSON.stringify(after)})`);

  sec("STANDING GUARANTEES");
  const asg = (await pool.query(
    "select role, is_active from assignments where person_id=$1 and property_id=$2", [DEMO_LEAD, DEMO])).rows[0];
  ok(asg && asg.role === "owner" && asg.is_active === true,
    "the demo lead's owner assignment is UNCHANGED — not transferred, not deactivated");
  const leadUsers = (await pool.query("select id from users where person_id=$1", [DEMO_LEAD])).rows;
  ok(leadUsers.length === 0, "no login was linked to the demo lead");
  const grants = Number((await pool.query("select count(*)::int n from concession_authority_grants")).rows[0].n);
  ok(grants === 0, "no authority grant was created");
  const persons = Number((await pool.query("select count(*)::int n from persons")).rows[0].n);
  ok(persons === 900, `no person row was merged or removed (${persons})`);

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
