/* ════════════════════════════════════════════════════════════════════
   audit_fixes_source_level.db.js — THE EIGHT FIXES THAT WERE ONLY READ

   CURRENT_STATE #54 recorded eight 2026-09-04 fixes as "verified by
   reading, NOT EXERCISED". This harness exercises each one against the
   real schema (HARNESS_DATABASE_URL, same-target guarded), through the
   shipped module's own exported entry point — a service function, or the
   real router over a real socket — and reads the database back rather
   than trusting a return value.

     (a) activation_service      a duplicate natural key is COUNTED and NAMED
     (b) leasing_scheduling      a second booking with its own start is a
                                 second tour, not an affirmation of the first
     (c) lease_packets           a completed field cannot be completed again
     (d) application_lifecycle   applicant-typed rent/deposit are labelled
                                 term_source = 'application_capture'
     (e) pricing_lifecycle       a term with no length is refused, never
                                 defaulted to 12 months
     (f) governed_charge_cutover the receipt says what was actually approved
     (g) communications_boundary a sender matched on primary_phone_e164 is
                                 answered at that number
     (h) meeting_receipt_workflow the recipient-scope refusal runs BEFORE any
                                 durable write

   Each block states what the pre-fix code did; the assertion is the
   difference. Rung earned: LOCALLY_EXERCISED against real Postgres for
   service-level blocks, HTTP_PROVEN (real router, real socket) for (c).
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { Pool } = require("pg");
const express = require("express");
const receipt = require("../_run_receipt");

const ROOT = path.resolve(__dirname, "..", "..");
const R = (p) => require(path.join(ROOT, p));
const URL_ = receipt.harnessConnectionString();
const EXPECTED = 14;

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  ok    " + name); }
  else { fail++; console.log("  FAIL  " + name); if (detail !== undefined) console.log("        " + String(detail).slice(0, 400)); }
};
const sha256 = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");
const parseCsv = (text) => {
  const lines = text.split("\n").filter((l) => l.trim());
  const split = (l) => { const out = []; let cell = "", q = false;
    for (let i = 0; i < l.length; i++) { const ch = l[i];
      if (ch === '"') { if (q && l[i + 1] === '"') { cell += '"'; i++; } else q = !q; }
      else if (ch === "," && !q) { out.push(cell); cell = ""; } else cell += ch; }
    out.push(cell); return out; };
  const header = split(lines.shift()).map((h) => h.trim());
  return lines.map((l, i) => { const cells = split(l); const o = {};
    header.forEach((h, j) => { if (h) o[h] = (cells[j] ?? "").trim(); }); o.__row_number = i + 2; return o; });
};

(async () => {
  receipt.begin(__filename, { url: URL_, expected: EXPECTED });
  const pool = new Pool({ connectionString: URL_, ssl: false });
  const q = (s, p) => pool.query(s, p);
  const one = async (s, p) => (await q(s, p)).rows[0];
  const TAG = "src-level-" + Date.now(), SUF = String(Date.now()).slice(-6);

  const org = (await one(`insert into organizations (name, slug) values ($1,$2) returning id`, [TAG, TAG])).id;
  const human = (await one(`insert into persons (name) values ($1) returning id`, [TAG + " human"])).id;
  const admin = (await one(
    `insert into users (name,email,platform_role,organization_id,is_active,status,person_id)
     values ($1,$2,'org_admin',$3,true,'active',$4) returning id`, [TAG + " admin", TAG + "@proof.test", org, human])).id;
  const prop = (await one(`insert into properties (name, organization_id) values ($1,$2) returning id`, [TAG + " prop", org])).id;
  //  pricing/cutover authority for the human: an owner assignment (FULL_AUTHORITY_ROLES)
  await q(`insert into assignments (property_id, person_id, role, is_active) values ($1,$2,'owner',true)`, [prop, human]);

  // ── (d) applicant-typed terms carry their origin ─────────────────────
  {
    const app = R("src/applications/application_lifecycle");
    const applicant = (await one(`insert into persons (name) values ($1) returning id`, [TAG + " applicant"])).id;
    const c = await pool.connect(); let withTerms, withoutTerms;
    try {
      await c.query("begin");
      withTerms = await app.createSubmittedApplication(c, { property_id: prop, person_id: applicant, applicant_name: "Proof Applicant", rent: 1500, deposit: 1500 });
      await c.query("commit"); await c.query("begin");
      const second = (await c.query(`insert into persons (name) values ($1) returning id`, [TAG + " applicant 2"])).rows[0].id;
      withoutTerms = await app.createSubmittedApplication(c, { property_id: prop, person_id: second, applicant_name: "Proof Applicant 2" });
      await c.query("commit");
    } catch (e) { await c.query("rollback"); withTerms = withoutTerms = { error: e.message }; } finally { c.release(); }
    const a = withTerms.application_id && await one(`select term_source, rent from lease_applications where id=$1`, [withTerms.application_id]);
    const b = withoutTerms.application_id && await one(`select term_source, rent from lease_applications where id=$1`, [withoutTerms.application_id]);
    ok("(d) rent typed at birth is stored with term_source = 'application_capture' (was null: terms of no origin)",
       a && a.term_source === "application_capture" && Number(a.rent) === 1500, JSON.stringify(a || withTerms));
    ok("(d) an application that states no terms carries no term_source", b && b.term_source === null, JSON.stringify(b || withoutTerms));
  }

  // ── (e) a term with no length is refused, never defaulted ────────────
  {
    const pl = R("src/money/pricing_lifecycle");
    let threw = null, saved = null;
    try { saved = await pl.saveDraft(pool, { property_id: prop, person_id: human, proposal: { terms: [{ unit_type_id: null, legacy_label: "1BR", base_rent: 1000 }] } }); }
    catch (e) { threw = e; }
    ok("(e) saveDraft refuses a term with no lease_term_months as term_length_required (was: published a 12-month price nobody proposed)",
       threw && threw.code === "term_length_required" && threw.httpStatus === 400, threw ? `${threw.code} ${threw.message}` : JSON.stringify(saved));
    const drafts = await one(`select count(*)::int n from pricing_terms t join property_pricing_versions v on v.id = t.pricing_version_id where v.property_id=$1`, [prop]);
    ok("(e) …and no pricing term was written", drafts.n === 0, `terms=${drafts.n}`);
  }

  // ── (b) the same prospect, a different start, is a different tour ───
  {
    const svc = R("src/leasing/leasing_scheduling")({ pool })._service;
    const c = await pool.connect();
    const ingest = async (id, start) => { await c.query("begin");
      const out = await svc.ingestSourceEvent(c, { source_event_id: id, event_type: "created",
        occurrences: [{ property_id: prop, prospect_name: "Proof Prospect", prospect_email: `prospect-${SUF}@proof.test`, scheduled_start: start, scheduled_end: null, appointment_type: "tour" }] });
      await c.query("commit"); return out; };
    let first, second;
    try { first = await ingest(TAG + "-evt-1", "2027-03-01T15:00:00Z"); second = await ingest(TAG + "-evt-2", "2027-03-08T15:00:00Z"); }
    catch (e) { await c.query("rollback").catch(() => {}); first = second = { error: e.message }; } finally { c.release(); }
    const tours = (await q(`select scheduled_start from scheduled_tours where property_id=$1 order by scheduled_start`, [prop])).rows;
    ok("(b) a second booking for the same prospect with its own start is a SECOND tour (was: affirmed onto the first, its date lost)",
       first.results && first.results[0].action === "created" && second.results && second.results[0].action === "created" && tours.length === 2,
       `actions=${first.results && first.results[0].action}/${second.results && second.results[0].action} tours=${tours.length} ${first.error || ""}`);
  }

  // ── (a) a duplicate natural key is counted and named ────────────────
  {
    const dealService = R("src/onboarding/deal_service.js"), activation = R("src/onboarding/activation_service.js"), artifacts = R("src/onboarding/source_artifact_service.js");
    let ing, err = null;
    try {
      const deal = await dealService.createDeal(pool, { user_id: admin, deal_name: TAG + " deal", creation_source: "asset_management_console" });
      await dealService.addProperty(pool, { user_id: admin, deal_intake_id: deal.id, property_id: prop });
      const csv = ["Unit #,Resident,Mkt Rent,Actual Rent,Lease From,Lease To,Security Deposit,Balance,Notes",
        "101,\"Alvarez, Maria\",1500,1450,2025-06-01,2026-05-31,1450,0,",
        "101,\"Alvarez, Maria\",1500,1450,2025-06-01,2026-05-31,1450,0,the same position again",
        "102,VACANT,1550,,,,,,ready"].join("\n");
      const art = await artifacts.store(pool, { scope_type: "property", scope_id: prop, filename: "rent-roll.csv", mimetype: "text/csv", buffer: Buffer.from(csv), uploaded_by_user_id: admin, authority_basis: "platform_role:org_admin", source_as_of_date: "2026-04-30" });
      const act = (await activation.openActivation(pool, { user_id: admin, deal_intake_id: deal.id, property_id: prop })).activation;
      ing = await activation.ingestRentRoll(pool, { user_id: admin, deal_intake_id: deal.id, property_id: prop, activation_id: act.id, rows: parseCsv(csv), source_artifact_id: art.id, source_as_of_date: "2026-04-30" });
    } catch (e) { err = e; }
    ok("(a) a second source row for one rentable position is counted as duplicate_position and NAMED (was: swallowed by `do nothing` while the staged count still rose)",
       ing && ing.counts && ing.counts.duplicate_position === 1 && Array.isArray(ing.duplicate_positions) && ing.duplicate_positions[0] === "101" && ing.counts.staged === 2,
       err ? err.message : JSON.stringify(ing && { counts: ing.counts, duplicate_positions: ing.duplicate_positions }));
    ok("(a) …and the receipt says so out loud", ing && /1 duplicate row/.test(ing.receipt || ""), ing && ing.receipt);
  }

  // ── (f) the publication receipt binds only what was approved ─────────
  {
    const cut = R("src/money/governed_charge_cutover");
    let pub = null, err = null;
    try {
      await q(`insert into property_governed_charges (property_id, charge_code, display_label, economic_class, cadence, obligation, applicability_basis, applicability_scope, incurred_on_event, applies_to_new_lease, applies_to_renewal, applies_to_transfer, waivable, effective_from, record_state, source_provenance, amount, assessed_per)
               values ($1,'fee.administration','Administration fee','one_time_fee','one_time','required','Per unit','property','move_in',true,true,false,false,'2026-08-01','draft','proof_fixture',99,'unit')`, [prop]);
      await cut.recordRuling(pool, { property_id: prop, user_id: admin, charge_code: "fee.administration", ruling: "new_lease_only" });
      pub = await cut.approveAndPublish(pool, { property_id: prop, user_id: admin, charge_code: "fee.administration" });
    } catch (e) { err = e; }
    ok("(f) publishing with NO approved digest records approved_terms_digest = null and approval_bound_to_terms = false (was: the current digest, as if approval had been bound to it)",
       pub && pub.receipt && pub.receipt.approved_terms_digest === null && pub.receipt.approval_bound_to_terms === false
         && typeof pub.receipt.published_terms_digest === "string" && pub.receipt.published_terms_digest.length > 10,
       err ? `${err.code || ""} ${err.message} ${err.blockers ? JSON.stringify(err.blockers) : ""}` : JSON.stringify(pub));
  }

  // ── (g) the reply reaches the number that matched ────────────────────
  {
    const TO = "+1215555" + SUF.slice(0, 4), FROM = "+1267555" + SUF.slice(2, 6);
    await q(`insert into communication_lines (e164,line_type,property_id,authority_ceiling,permitted_audience) values ($1,'property_facing',$2,'external','residents_and_prospects')`, [TO, prop]);
    const lead = (await one(`insert into persons (name, primary_phone_e164) values ($1,$2) returning id`, [TAG + " lead", FROM])).id;
    await q(`insert into leasing_leads (person_id, property_id, status) values ($1,$2,'new')`, [lead, prop]);
    const cb = R("src/comms/communications_boundary")({ pool, sms: { enabled: false } });
    let ctx, err = null;
    try { ctx = await cb.resolveInboundSmsContext({ To: TO, From: FROM, MessageSid: "SM" + SUF + "proof", body: "hi" }); } catch (e) { err = e; }
    ok("(g) a person matched on primary_phone_e164 with phone null is resolved…", ctx && ctx.person && ctx.person.id === lead && ctx.ambiguous === false, err ? err.message : JSON.stringify(ctx && { person: ctx.person, ambiguous: ctx.ambiguous }));
    ok("(g) …and carries THAT number as the reply phone (was: phone null → every reply failed no_recipient)", ctx && ctx.person && ctx.person.phone === FROM, ctx && ctx.person && ctx.person.phone);
  }

  // ── (h) the scope refusal comes before any durable write ─────────────
  {
    const wf = R("src/meeting_evidence/meeting_receipt_workflow");
    let ensured = false, threw = null;
    try {
      await wf.generateOwnerReceiptFromProviderMeeting({ db: pool, extractor: async () => ({}), providerMeetingId: "pm-" + SUF, propertyId: prop, initiatedByUserId: admin,
        intendedRecipientPersonId: "00000000-0000-0000-0000-000000000001",
        evidence: { readBoundProviderTranscript: async () => ({ meeting_occurred_at: new Date(), occurred_at_source: "provider" }) },
        receipts: { loadPropertyPeople: async () => [], ensureCanonicalMeeting: async () => { ensured = true; throw new Error("reached the canonical write"); }, recordExtractionAttemptOutcome: async () => {} } });
    } catch (e) { threw = e; }
    ok("(h) an out-of-scope recipient is refused 403 receipt_recipient_out_of_scope", threw && threw.httpStatus === 403 && threw.code === "receipt_recipient_out_of_scope", threw && `${threw.httpStatus} ${threw.code} ${threw.message}`);
    ok("(h) …BEFORE ensureCanonicalMeeting runs (was: a 403 that left a canonical meeting and a transcript version behind it)", ensured === false, `ensured=${ensured}`);
  }

  // ── (c) a completed packet field stands ──────────────────────────────
  {
    const resident = (await one(`insert into persons (name) values ($1) returning id`, [TAG + " resident"])).id;
    const app = (await one(`insert into lease_applications (property_id, person_id, applicant_name, status) values ($1,$2,'Proof Resident','submitted') returning id`, [prop, resident])).id;
    const token = "tok-" + TAG;
    const pk = (await one(`insert into lease_packets (property_id, application_id, status, tenant_token_hash, tenant_token_expires_at) values ($1,$2,'sent',$3, now()+interval '1 day') returning id`, [prop, app, sha256(token)])).id;
    const field = (await one(`insert into lease_packet_fields (lease_packet_id, field_key, section_key, label, field_type, required) values ($1,'ack_1','terms','I acknowledge','acknowledgment',true) returning id`, [pk])).id;
    const mod = R("src/applications/lease_packets")({ pool, satisfyObligation: async () => ({}), completeObligation: async () => ({}) });
    const a = express(); a.use("/", mod); const srv = http.createServer(a); await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const post = async (v) => { const r = await fetch(`${base}/t/lease/${token}/fields/${field}/complete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: v }) }); let b = null; try { b = await r.json(); } catch (_) {} return { status: r.status, body: b }; };
    const r1 = await post("I agree"); const f1 = await one(`select completed, completed_at, field_value from lease_packet_fields where id=$1`, [field]);
    await new Promise((r) => setTimeout(r, 25));
    const r2 = await post("something else"); const f2 = await one(`select completed, completed_at, field_value from lease_packet_fields where id=$1`, [field]);
    srv.close();
    ok("(c) the first completion is accepted (200) and recorded", r1.status === 200 && f1.completed === true && f1.field_value === "I agree", `${r1.status} ${JSON.stringify(f1)}`);
    ok("(c) a second completion is refused 409 and the record STANDS — value, time untouched (was: silently overwritten, signer included)",
       r2.status === 409 && f2.field_value === "I agree" && String(f2.completed_at) === String(f1.completed_at), `${r2.status} ${JSON.stringify(r2.body)} ${JSON.stringify(f2)}`);
  }

  await pool.end();
  process.exit(receipt.complete({ harness: __filename, passed: pass, failed: fail, expectedAtLeast: EXPECTED }));
})().catch((e) => { process.exit(receipt.died(__filename, e, pass + fail)); });
