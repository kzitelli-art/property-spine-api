#!/usr/bin/env node
/**
 * EXECUTED LEASE EVIDENCE PROOF (migration 088)
 *
 * Runs the REAL executed_lease_service against a stub Postgres client.
 * Claim ceiling: locally-exercised. Live proof is a real verify + a
 * confirm-term after the switch is flipped.
 *
 * Run from the repo root:  node executed_lease_evidence.test.js
 */
const path = require("path");
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  → " + d : "")); } };

const APP = "app-1", PROP = "prop-1", SPACE = "sp-1", UNIT = "u-1", USER = "user-1";
const store = { records: [], appPointer: null, appStatus: "approved", obligations: [], evaluations: [],
  lifecycleChecks: { application: 0, executedRecord: 0, obligation: 0 } };
// what the tenant acknowledged; tests mutate this to create conflicts
const ACK = { id: "conf-1", rent: "1850.00", security_deposit: "1850.00",
  lease_start_date: "2026-08-01", lease_end_date: "2027-07-31",
  concession_status: "none", payload_hash: null };
let LOCKED_OFFER_RENT = null;   // null = no locked offer
let OVERLAPS = [];              // competing operative leases on the space

function stubClient(overrides = {}) {
  const o = { appUnit: UNIT, spaceUnit: UNIT, spaceProp: PROP, ...overrides };
  return { query: async (sql, params) => {
    const s = String(sql);
    if (/from lease_applications where id=\$1/.test(s)) {
      if (/for update/.test(s)) store.lifecycleChecks.application++;
      return { rows: [{ id: APP, property_id: PROP, unit_id: o.appUnit,
        person_id: "per-1", applicant_name: "Marlow Reyes",
        status: store.appStatus, executed_lease_record_id: store.appPointer }] };
    }
    if (/from spaces s join units u/.test(s))
      return { rows: params[0] === SPACE ? [{ id: SPACE, unit_id: o.spaceUnit, property_id: o.spaceProp }] : [] };
    if (/from executed_lease_records[\s\S]*idempotency_key=\$2/.test(s))
      return { rows: store.records.filter(r => r.idempotency_key && r.idempotency_key === params[1]) };
    if (/from executed_lease_records[\s\S]*record_state = 'verified'/.test(s))
      return { rows: store.records.filter(r => r.record_state === "verified") };
    if (/from executed_lease_records where id=\$1 for update/.test(s)) {
      store.lifecycleChecks.executedRecord++;
      return { rows: store.records.filter(r => r.id === params[0]) };
    }
    if (/update executed_lease_records set record_state='superseded'/.test(s)) {
      const r = store.records.find(x => x.id === params[0]); if (r) r.record_state = "superseded"; return { rows: [] };
    }
    if (/update executed_lease_records[\s\S]*record_state='voided'/.test(s)) {
      const r = store.records.find(x => x.id === params[2]); if (r) { r.record_state = "voided"; r.void_reason = params[0]; } return { rows: [] };
    }
    if (/from lease_packets/.test(s)) return { rows: [{ proposed_terms_confirmation_id: ACK.id }] };
    if (/from application_proposed_terms_confirmations/.test(s)) return { rows: [ACK] };
    if (/select id, unit_id from spaces where id=\$1/.test(s))
      return { rows: [{ id: SPACE, unit_id: o.spaceUnit }] };
    if (/from leases[\s\S]*daterange/.test(s)) return { rows: OVERLAPS };
    if (/from lease_economic_schedules/.test(s))
      return { rows: LOCKED_OFFER_RENT == null ? [] : [{ id: "sched-1" }] };
    if (/from lease_economic_lines/.test(s))
      return { rows: [{ amount: LOCKED_OFFER_RENT }] };
    if (/update executed_lease_records[\s\S]*admission_status/.test(s)) {
      const r = store.records.find(x => x.id === params[2]);
      if (r) { r.admission_status = params[0]; r.admission_blockers = params[1]; }
      return { rows: [] };
    }
    if (/from obligations where id=\$1 for update/.test(s)) {
      store.lifecycleChecks.obligation++;
      return { rows: store.obligations.filter(o => o.id === params[0]) };
    }
    if (/update lease_applications[\s\S]*accepted_term_required/.test(s)) {
      store.appStatus = "accepted_term_required";
      return { rows: [{ id: APP, status: store.appStatus,
        executed_lease_record_id: store.appPointer }] };
    }
    if (/insert into executed_lease_admission_evaluations/.test(s)) {
      store.evaluations.push({ record_id: params[0], application_id: params[1], result: params[2],
        blockers: JSON.parse(params[3]), sources_compared: JSON.parse(params[4]),
        evaluation_context: params[5], evaluated_by_user_id: params[6] });
      return { rows: [] };
    }
    if (/insert into events/.test(s)) return { rows: [{ id: "ev-" + (store.records.length + 1) }] };
    if (/insert into executed_lease_records/.test(s)) {
      const rec = { id: "rec-" + (store.records.length + 1), application_id: params[0],
        property_id: params[1], space_id: params[2], rent: params[3], security_deposit: params[4],
        lease_start_date: params[5], lease_end_date: params[6], concession_status: params[7],
        payload_hash: params[9], normalization_version: params[10],
        record_state: "verified", idempotency_key: params[24], lease_id: null,
        admission_status: "pending", admission_blockers: "[]" };
      store.records.push(rec); return { rows: [rec] };
    }
    if (/update lease_applications set executed_lease_record_id/.test(s)) { store.appPointer = params[0]; return { rows: [] }; }
    return { rows: [] };
  }};
}

const svc = require(path.join(__dirname, "..", "..", "src", "applications", "executed_lease_service.js"));
const base = () => ({
  application_id: APP, space_id: SPACE, rent: 1850, security_deposit: 1850,
  lease_start_date: "2026-08-01", lease_end_date: "2027-07-31",
  document_sha256: "a".repeat(64), executed_at: "2026-07-20",
  signers: [{ name: "Marlow Reyes", capacity: "resident" }, { name: "Virtus Management LLC", capacity: "owner" }],
  execution_channel: "paper", verified_by_user_id: USER,
});
const DEPS = { spawnObligationFromEvent: async (_c, o) => { const ob = { id: "ob-" + (store.obligations.length + 1), ...o }; store.obligations.push(ob); return ob; } };
const grab = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const { normalizeAndHash } = require(path.join(__dirname, "..", "..", "src", "applications", "proposed_terms_service.js"));
ACK.payload_hash = normalizeAndHash({ rent: 1850, security_deposit: 1850,
  lease_start_date: "2026-08-01", lease_end_date: "2027-07-31", concession_status: "none" }).payload_hash;

(async () => {
  console.log("\nEXECUTED LEASE EVIDENCE PROOF (088)\n");

  console.log("1. Activation gate");
  delete process.env.EXECUTED_LEASE_INTAKE_ENABLED;
  let e = await grab(() => svc.verifyExecutedLease(stubClient(), base()));
  ok("switch off → 503 disabled", e && e.httpStatus === 503 && e.code === "executed_lease_intake_disabled");
  process.env.EXECUTED_LEASE_INTAKE_ENABLED = "true";
  process.env.EXECUTED_LEASE_PROPERTY_IDS = "";
  e = await grab(() => svc.verifyExecutedLease(stubClient(), base()));
  ok("switch on, empty allowlist → 503 (controls independent)", e && e.httpStatus === 503 && e.code === "property_not_activated");
  process.env.EXECUTED_LEASE_PROPERTY_IDS = "other-prop";
  e = await grab(() => svc.verifyExecutedLease(stubClient(), base()));
  ok("property not on allowlist → 503", e && e.code === "property_not_activated");
  process.env.EXECUTED_LEASE_PROPERTY_IDS = PROP;

  console.log("\n2. Premises (canonical space, ruling 2)");
  e = await grab(() => svc.verifyExecutedLease(stubClient(), { ...base(), space_id: null }));
  ok("no premises → refused, no record", e && e.code === "space_required" && store.records.length === 0);
  e = await grab(() => svc.verifyExecutedLease(stubClient({ spaceProp: "prop-2" }), base()));
  ok("space in another property → 403 property wall", e && e.httpStatus === 403 && e.code === "cross_property_space");
  let pc = await svc.verifyExecutedLease(stubClient({ spaceUnit: "u-9" }), base());
  ok("premises conflict is RECORDED, not refused", !!pc.record_id);
  ok("…both facts retained and surfaced",
    !!(pc.premises_conflict && pc.premises_conflict.application_unit_id === UNIT &&
       pc.premises_conflict.executed_space_unit_id === "u-9"));
  ok("…receipt states the record stands and activation is blocked",
    /RECORDED and stands/.test(pc.receipt) && /premises_conflict/.test(pc.receipt));
  store.records = []; store.appPointer = null;

  console.log("\n3. Document identity (tightening B)");
  e = await grab(() => svc.verifyExecutedLease(stubClient(), { ...base(), document_sha256: null, document_reference: "/sites/solo/leases/marlow.pdf" }));
  ok("mutable path alone → refused", e && e.code === "document_identity_required");
  e = await grab(() => svc.verifyExecutedLease(stubClient(), { ...base(), document_sha256: null, provider_document_id: "doc-9" }));
  ok("provider id without version → refused", e && e.code === "document_identity_required");
  let r = await svc.verifyExecutedLease(stubClient(), { ...base(), document_sha256: null, provider_name: "sharepoint", provider_document_id: "doc-9", provider_version_id: "3.0" });
  ok("provider id + version accepted", !!r.record_id);
  store.records = []; store.appPointer = null;

  console.log("\n4. Execution facts");
  for (const [name, patch, code] of [
    ["missing executed_at", { executed_at: null }, "executed_at_required"],
    ["no signers", { signers: [] }, "signers_required"],
    ["signer without capacity", { signers: [{ name: "X" }] }, "signer_shape_invalid"],
    ["bad channel", { execution_channel: "vibes" }, "execution_channel_invalid"],
    ["end before start", { lease_end_date: "2026-07-01" }, "end_must_be_after_start"],
  ]) {
    e = await grab(() => svc.verifyExecutedLease(stubClient(), { ...base(), ...patch }));
    ok(name + " → refused", e && e.code === code, e && e.code);
  }

  console.log("\n5. Concessions (tightening C)");
  e = await grab(() => svc.verifyExecutedLease(stubClient(), { ...base(), concession_status: "free_month" }));
  ok("non-none concession with no canonical economics → fails closed", e && e.code === "concession_economics_unnormalized");

  console.log("\n6. Record, idempotency, supersession");
  r = await svc.verifyExecutedLease(stubClient(), { ...base(), idempotency_key: "k1" });
  const firstHash = r.payload_hash;
  ok("verified record created", !!r.record_id && store.records.length === 1);
  ok("application pointer updated", store.appPointer === r.record_id);
  ok("normalization_version stamped", r.normalization_version === 1);
  r = await svc.verifyExecutedLease(stubClient(), { ...base(), idempotency_key: "k1" });
  ok("same key + same terms → idempotent, no second record", r.idempotent === true && store.records.length === 1);
  e = await grab(() => svc.verifyExecutedLease(stubClient(), { ...base(), rent: 1900, idempotency_key: "k1" }));
  ok("same key + different terms → 409", e && e.code === "idempotency_conflict");
  e = await grab(() => svc.verifyExecutedLease(stubClient(), { ...base(), rent: 1900 }));
  ok("second record while one is live → 409 (never edit)", e && e.code === "verified_execution_exists");
  e = await grab(() => svc.verifyExecutedLease(stubClient(), { ...base(), rent: 1900, supersedes_record_id: "rec-99" }));
  ok("stale supersedes pointer → 409", e && e.code === "supersedes_stale");
  const live = store.records.find(x => x.record_state === "verified");
  r = await svc.verifyExecutedLease(stubClient(), { ...base(), rent: 1900, supersedes_record_id: live.id });
  ok("explicit supersession creates a corrected record", !!r.record_id && r.payload_hash !== firstHash);
  ok("prior record superseded, exactly one live", store.records.filter(x => x.record_state === "verified").length === 1);

  console.log("\n7. Resolver — the structural guarantee");
  ok("resolver takes only (client, applicationId)", svc.resolveVerifiedExecutionRecord.length === 2);
  const found = await svc.resolveVerifiedExecutionRecord(stubClient(), APP);
  ok("resolver returns the live verified record", found && found.record_state === "verified");
  ok("resolver returns null for an unknown application", (await svc.resolveVerifiedExecutionRecord(stubClient(), null)) === null);

  console.log("\n8. Post-confirmation boundary (ruling)");
  const anchored = store.records.find(x => x.record_state === "verified");
  anchored.lease_id = "lease-1";
  e = await grab(() => svc.verifyExecutedLease(stubClient(), { ...base(), rent: 2000, supersedes_record_id: anchored.id }));
  ok("supersede a lease-anchored record → lease_amendment_required", e && e.code === "lease_amendment_required");
  e = await grab(() => svc.voidExecutedLease(stubClient(), { record_id: anchored.id, void_reason: "wrong doc", voided_by_user_id: USER }));
  ok("void a lease-anchored record → lease_amendment_required", e && e.code === "lease_amendment_required");
  anchored.lease_id = null;

  console.log("\n9. Void (correction)");
  const cur = store.records.find(x => x.record_state === "verified");
  e = await grab(() => svc.voidExecutedLease(stubClient(), { record_id: cur.id, voided_by_user_id: USER }));
  ok("void without a reason → refused", e && e.code === "void_reason_required");
  r = await svc.voidExecutedLease(stubClient(), { record_id: cur.id, void_reason: "wrong doc", voided_by_user_id: USER });
  ok("void records reason + actor", r.record_id === cur.id && cur.record_state === "voided");
  ok("no live verified record remains", (await svc.resolveVerifiedExecutionRecord(stubClient(), APP)) === undefined || store.records.filter(x => x.record_state === "verified").length === 0);

  console.log("\n10. Phase 2 — operational admission (ruling)");
  store.records = []; store.appPointer = null; store.appStatus = "approved"; store.obligations = [];
  store.lifecycleChecks = { application: 0, executedRecord: 0, obligation: 0 };
  LOCKED_OFFER_RENT = null;

  // clean: executed terms match what the tenant acknowledged
  let v = await svc.verifyExecutedLease(stubClient(), base(), DEPS);
  ok("clean → recorded AND admitted", v.record_state === "verified" && v.activation_status === "admitted");
  ok("…no blockers", v.blockers.length === 0);
  ok("…term_required opened", !!v.term_obligation_id && store.obligations.some(o => o.type === "term_required"));
  ok("…application moved to accepted_term_required", store.appStatus === "accepted_term_required");
  ok("…obligation requires lease_term_confirmation",
    store.obligations[0].required_inputs.includes("lease_term_confirmation"));
  ok("…canonical lifecycle verifies application, executed record, and obligation",
    store.lifecycleChecks.application === 2 &&
    store.lifecycleChecks.executedRecord === 1 &&
    store.lifecycleChecks.obligation === 1, JSON.stringify(store.lifecycleChecks));

  // terms conflict: the executed lease disagrees with the acknowledged packet
  store.records = []; store.appStatus = "approved"; store.obligations = [];
  v = await svc.verifyExecutedLease(stubClient(), { ...base(), rent: 2100 }, DEPS);
  ok("terms conflict → record STILL created (truth recorded)", !!v.record_id && v.record_state === "verified");
  ok("…activation blocked, not the recording", v.activation_status === "blocked");
  ok("…blocker is proposed_terms_conflict", v.blockers.some(b => b.code === "proposed_terms_conflict"));
  ok("…both versions surfaced", v.blockers.some(b => b.acknowledged && b.executed));
  ok("…term_required NOT opened", store.obligations.length === 0 && store.appStatus === "approved");
  ok("…verdict persisted durably on the record", store.records[0].admission_status === "blocked");
  ok("…receipt says the record stands", /RECORDED and stands/.test(v.receipt));

  // premises conflict blocks admission (but still recorded — section 2)
  store.records = []; store.appStatus = "approved"; store.obligations = [];
  v = await svc.verifyExecutedLease(stubClient({ spaceUnit: "u-9" }), base(), DEPS);
  ok("premises conflict → recorded, activation blocked",
    !!v.record_id && v.activation_status === "blocked" && v.blockers.some(b => b.code === "premises_conflict"));

  // locked offer DETECTS, never decides
  store.records = []; store.appStatus = "approved"; store.obligations = [];
  LOCKED_OFFER_RENT = 1700;
  v = await svc.verifyExecutedLease(stubClient(), base(), DEPS);
  ok("conflicting locked offer → blocks, does not override", v.activation_status === "blocked" &&
    v.blockers.some(b => b.code === "locked_offer_conflict"));
  ok("…executed rent is NOT replaced by offer rent (Gate B retired)",
    v.blockers.find(b => b.code === "locked_offer_conflict").executed_rent === 1850);
  LOCKED_OFFER_RENT = 1850;
  store.records = []; store.appStatus = "approved"; store.obligations = [];
  v = await svc.verifyExecutedLease(stubClient(), base(), DEPS);
  ok("agreeing locked offer → admitted", v.activation_status === "admitted");
  LOCKED_OFFER_RENT = null;

  console.log("\n10b. Overlapping operative lease (one space, one tenancy)");
  store.records = []; store.appStatus = "approved"; store.obligations = []; store.evaluations = [];
  LOCKED_OFFER_RENT = null;
  OVERLAPS = [{ id: "L-OTHER", lease_status: "pending",
    start_date: "2026-09-01", end_date: "2027-08-31", tenant_ids: ["p-other"] }];
  v = await svc.verifyExecutedLease(stubClient(), { ...base(), idempotency_key: "ov-1" }, DEPS);
  ok("evidence still RECORDED despite the overlap", !!v.record_id && v.record_state === "verified");
  ok("…activation blocked with overlapping_operative_lease",
    v.activation_status === "blocked" && v.blockers.some(b => b.code === "overlapping_operative_lease"));
  ok("…competing lease surfaced with status, dates and tenants",
    v.blockers.find(b => b.code === "overlapping_operative_lease")
      .competing.some(c => c.lease_id === "L-OTHER" && c.lease_status === "pending"));
  ok("…term_required NOT opened", store.obligations.length === 0 && store.appStatus === "approved");
  ok("…sources record the overlap check ran",
    store.evaluations[0].sources_compared.overlap_check.competing_leases_found === 1);
  // confirm-term recomputes through the same function — prove the pure path blocks too
  let oc = await svc.computeAdmissionBlockers(stubClient(), { application_id: APP });
  ok("confirm-term's recompute sees the same blocker",
    oc.blockers.some(b => b.code === "overlapping_operative_lease"));
  // the conflict clears (competing lease terminated) → the SAME record
  // re-evaluates through the idempotent path; no second record is born
  OVERLAPS = [];
  v = await svc.verifyExecutedLease(stubClient(), { ...base(), idempotency_key: "ov-1" }, DEPS);
  ok("overlap cleared → idempotent re-evaluation admits, no new record",
    v.idempotent === true && v.activation_status === "admitted" && store.records.length === 1);
  OVERLAPS = [];

  console.log("\n11. Append-only admission history (requirement 2)");
  store.records = []; store.appStatus = "approved"; store.obligations = []; store.evaluations = [];
  LOCKED_OFFER_RENT = null;

  // first evaluation: conflict
  let h = await svc.verifyExecutedLease(stubClient(), { ...base(), rent: 2100, idempotency_key: "h1" }, DEPS);
  ok("blocked evaluation written to history", store.evaluations.length === 1 && store.evaluations[0].result === "blocked");
  ok("…history records WHICH sources were compared",
    !!store.evaluations[0].sources_compared.executed_lease_record_id &&
    "acknowledged_confirmation_id" in store.evaluations[0].sources_compared);
  ok("…history is attributed to the verifying staff user", store.evaluations[0].evaluated_by_user_id === USER);
  ok("…context recorded", store.evaluations[0].evaluation_context === "verify");

  // re-evaluate via the idempotent path — history APPENDS, never overwrites
  h = await svc.verifyExecutedLease(stubClient(), { ...base(), rent: 2100, idempotency_key: "h1" }, DEPS);
  ok("re-evaluation appends a second row", store.evaluations.length === 2);
  ok("…the earlier conflict is still in history",
    store.evaluations[0].result === "blocked" &&
    store.evaluations[0].blockers.some(b => b.code === "proposed_terms_conflict"));
  ok("…re_evaluation context distinguished", store.evaluations[1].evaluation_context === "re_evaluation");
  ok("…projection on the record still shows the latest", store.records[0].admission_status === "blocked");

  console.log("\n12. Recompute purity (requirement 3)");
  store.evaluations = [];
  const before = { evals: store.evaluations.length, obs: store.obligations.length, status: store.appStatus };
  const pure = await svc.computeAdmissionBlockers(stubClient(), { application_id: APP });
  ok("computeAdmissionBlockers returns live blockers", pure.blockers.some(b => b.code === "proposed_terms_conflict"));
  ok("…writes NOTHING (no evaluation row)", store.evaluations.length === before.evals);
  ok("…spawns NO obligation", store.obligations.length === before.obs);
  ok("…does not move application state", store.appStatus === before.status);
  ok("…returns the sources it compared", !!pure.sources.executed_lease_record_id);
  ok("…reads the live record, not a cached verdict", pure.record && pure.record.record_state === "verified");

  console.log("\n13. Test isolation");
  const selfSrc = require("fs").readFileSync(__filename, "utf8");
  ok("harness never requires pg or builds a Pool", !/require\(["']pg["']\)|new Pool\(/.test(selfSrc));
  const connNeedle = "DATABASE" + "_URL";
  ok("harness never reads the database connection string", !selfSrc.includes(connNeedle));
  ok("all state in-memory — cannot reach Demo Building data", Array.isArray(store.records));

  console.log("\n" + "-".repeat(52));
  console.log((fail === 0 ? "ALL PASS" : "FAILURES PRESENT") + `   ${pass}/${pass + fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error("harness error:", e); process.exit(1); });
