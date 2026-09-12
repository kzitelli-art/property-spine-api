// Owned DB/HTTP proof: correct an unsent exact-home offer without erasing history.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const boundary = require("./proof_boundary");
require("./proof_fence_preload");
const { Pool } = require("pg");
const staffSessions = require("../../src/identity/staff_session_service");
const staffIdentity = require("../../src/identity/staff_identity_resolver");

const BASE = process.env.E2E_API_BASE;
const SMS_LOG = process.env.E2E_SMS_LOG;
assert.ok(BASE && SMS_LOG, "E2E_API_BASE and E2E_SMS_LOG are required");

const results = [];
let failed = 0, current = "setup";
function record(ok, label, detail, kind = "check") {
  results.push({ section: current, label, ok, kind, detail: detail === undefined ? null : detail });
  if (!ok && kind === "check") failed++;
  console.log(`  ${kind === "observe" ? "NOTE" : ok ? "PASS" : "FAIL"}  [${current}] ${label}${detail !== undefined ? " | " + JSON.stringify(detail).slice(0, 400) : ""}`);
}
const check = (c, l, d) => { record(!!c, l, d); return !!c; };
const observe = (l, d) => record(true, l, d, "observe");
const need = (c, l, d) => { record(!!c, l, d); if (!c) throw new Error(`need: ${l}`); };
async function section(name, fn) {
  current = name; console.log(`\n== ${name} ==`);
  try { await fn(); }
  catch (e) { record(false, `section aborted: ${e.message}`, null); }
}
const ymd = (d) => d.toISOString().slice(0, 10);
const plusDays = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const plusYear = (s) => { const d = new Date(s + "T00:00:00Z"); d.setUTCFullYear(d.getUTCFullYear() + 1); d.setUTCDate(d.getUTCDate() - 1); return ymd(d); };
async function api(method, route, { token, key = false, body, headers: extra = {} } = {}) {
  const headers = { ...extra };
  if (token) headers["x-staff-session"] = token;
  if (key) headers["x-operator-key"] = "e2e-key";
  let payload;
  if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
  const r = await fetch(BASE + route, { method, headers, body: payload, signal: AbortSignal.timeout(60000) });
  const data = await r.json().catch(() => null);
  return { status: r.status, body: data };
}
function sms() { return fs.existsSync(SMS_LOG) ? fs.readFileSync(SMS_LOG, "utf8").trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []; }
async function waitSms(from, pred) { for (let i = 0; i < 80; i++) { const m = sms().slice(from).find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 50)); } return null; }

(async () => {
  await boundary.assertDatabase();
  const pool = new Pool({ connectionString: boundary.manifest().url, ssl: false });
  const q = (sql, args = []) => pool.query(sql, args);
  const one = async (sql, args = []) => (await q(sql, args)).rows[0];
  const nonce = randomUUID().slice(0, 8);
  const numBase = 2000000 + (parseInt(nonce.slice(0, 6), 16) % 7000000);
  const num = (k) => "+1215" + String(numBase + k);
  const session = async (userId, propertyId) => (await staffSessions.issueStaffSession(pool, { userId, propertyId, purpose: "bootstrap_invite" })).session_token;
  const F = {};
  const dates = { start: plusDays(30) }; dates.end = plusYear(dates.start);

  // Governed invite + OTP acceptance (the real staff onboarding door).
  async function inviteAndAccept({ token, propertyId, phone, name, role_key, person_id = null }) {
    const from = sms().length;
    const invite = await api("POST", `/properties/${propertyId}/team-invites`, { token, body: { invited_name: name, phone_number: phone, role_key, scope_type: "property", ...(person_id ? { person_id } : {}) } });
    if (invite.status >= 400) return { invite };
    const joinToken = String(invite.body.link || "").split("/join/")[1];
    const start = await api("POST", "/auth/sms/start", { body: { token: joinToken } });
    let code = null;
    if (invite.body.delivery === "sms_sent") { const t = await waitSms(from, (m) => m.to === phone && /access code is \d{6}/.test(m.body || "")); code = t ? t.body.match(/access code is (\d{6})/)[1] : null; }
    else if (start.body && start.body.dev_code) code = start.body.dev_code;
    const verify = code ? await api("POST", "/auth/sms/verify", { body: { token: joinToken, code } }) : { status: 0, body: null };
    return { invite, joinToken, verify, delivery: invite.body.delivery };
  }
  try {
    // ── property and staff ───────────────────────────────────────────
    await section("property-and-staff", async () => {

        F.property = await one("select id, organization_id, name from properties where name in ('Skyline E2E','Property Spine Demo Building') order by created_at desc limit 1");
        need(!!F.property, "Skyline-shaped fixture property exists");
        if (!F.property.organization_id) {
          const org = await one("insert into organizations (name,slug) values ($1,$2) returning id", [`Journey Org ${nonce}`, `journey-org-${nonce}`]);
          await q("update properties set organization_id=$2 where id=$1", [F.property.id, org.id]); F.property.organization_id = org.id;
        }
        await q("update properties set operating_timezone=coalesce(operating_timezone,'America/New_York') where id=$1", [F.property.id]);
        // The fixture's manager is the retained instrument's company signer.
        F.manager = await one("select u.id, u.person_id from users u join property_team_assignments pta on pta.user_id=u.id and pta.property_id=$1 and pta.active and pta.can_manage_roles where u.name='Mike Grivna' and u.is_active=true order by u.created_at limit 1", [F.property.id]);
        need(!!F.manager, "fixture manager (instrument company signer) exists");
        if (!F.manager.person_id) {
          // Fixture identity for the manager, exactly as the CI suite does it, before any action.
          const p = await one("insert into persons (name,source) values ('Journey manager identity','journey_fixture') returning id");
          await q("update users set person_id=$2, account_kind='human_staff' where id=$1", [F.manager.id, p.id]);
          await q("insert into assignments (person_id,property_id,role,provenance) values ($1,$2,'property_manager',$3)", [p.id, F.property.id, JSON.stringify({ source: "journey_fixture" })]);
        }
        // Lines: the fixture property line must be able to send (CI does the same in SQL).
        await q("update communication_lines set outbound_enabled=true, outbound_policy='proactive' where property_id=$1 and line_type='property_facing' and status='active'", [F.property.id]);
        if (!(await one("select 1 from communication_lines where property_id=$1 and line_type='property_facing' and status='active'", [F.property.id]))) {
          await q(`insert into communication_lines (e164,line_type,property_id,authority_ceiling,permitted_audience,inbound_enabled,outbound_enabled,outbound_policy,status) values ('+12155559999','property_facing',$1,'external','residents_and_prospects',true,true,'proactive','active')`, [F.property.id]);
        }
        F.unit = await one("select id, unit_number from units where property_id=$1 and unit_number='3B' limit 1", [F.property.id]);
        F.bedB = await one("select id, space_label from spaces where unit_id=$1 and space_label='Bed B'", [F.unit.id]);
        need(F.unit && F.bedB, "fixture unit 3B with established Bed B exists");
        await q("update spaces set use_type='residential' where unit_id=$1", [F.unit.id]);
        // Fixture SQL before any action: a prior suite run may have executed a lease on this bed;
        // it is retired with the inventory vocabulary (leasing_inventory.js), never deleted.
        await q("update leases set lease_status='cancelled' where property_id=$1 and space_id=$2 and lease_status not in ('cancelled','rescinded','void','superseded','terminated','expired')", [F.property.id, F.bedB.id]);
        // The known foreign property/home and scoped session are fixtures,
        // established before the governed staff invite and prospect actions.
        const foreign = await one("insert into properties(name,organization_id) values($1,$2) returning id",[`Draft correction foreign ${nonce}`,F.property.organization_id]);
        const foreignUnit = await one("insert into units(property_id,unit_number) values($1,'Foreign home') returning id",[foreign.id]);
        F.foreignSpace = await one("select id from spaces where unit_id=$1",[foreignUnit.id]);
        await q("insert into property_team_assignments(property_id,user_id,role_title,allowed_modules,active,can_manage_roles) values($1,$2,'property_manager','{leasing}',true,true)",[foreign.id,F.manager.id]);
        F.foreignToken = await session(F.manager.id,foreign.id);
      F.managerTok = await session(F.manager.id, F.property.id);
      // The leasing agent (Mike-shaped) joins through the governed door.
      F.agentPhone = num(1);
      const made = await inviteAndAccept({ token: F.managerTok, propertyId: F.property.id, phone: F.agentPhone, name: `Mike (journey) ${nonce}`, role_key: "leasing_agent" });
      need(made.verify && made.verify.status === 200, "the leasing agent joins through the governed invite and OTP", { invite: made.invite && made.invite.status, delivery: made.delivery, verify: made.verify && made.verify.status, body: made.verify && made.verify.body });
      F.agent = { id: made.verify.body.user.id, tok: made.verify.body.session_token };
      const id = await staffIdentity.resolveStaffIdentity(pool, { user_id: F.agent.id, property_id: F.property.id });
      check(id.state === "resolved", "the agent resolves as staff at the property", { state: id.state });
      const mid = await staffIdentity.resolveStaffIdentity(pool, { user_id: F.manager.id, property_id: F.property.id });
      check(mid.state === "resolved", "the manager resolves as staff at the property", { state: mid.state, basis: mid.basis });
    });
    need(F.agent && F.managerTok, "staff ready");
    const P = F.property.id;

    // ── 1 · website inquiry ─────────────────────────────────────────
    await section("inquiry", async () => {
      F.prospect = { name: `Journey Prospect ${nonce}`, phone: num(2), email: `prospect-${nonce}@example.test` };
      await q("insert into lead_sources (name,source_type) values ($1,'website') on conflict do nothing", ["Website"]);
      const key = `form-${nonce}`;
      F.inquiryMessage = `Can you send me the floor plan for journey ${nonce}?`;
      const body = { property_id: P, name: F.prospect.name, email: F.prospect.email, phone: F.prospect.phone, source: "Website", source_lead_id: `sq-${nonce}`, response_channel: "website", message: F.inquiryMessage, attempt_sms: false, sms_consent: true };
      const first = await api("POST", "/leasing/intake", { headers: { "x-intake-secret": "e2e-intake", "Idempotency-Key": key }, body });
      need(first.status === 200 && first.body.person_id && first.body.lead_id && first.body.conversation_id, "the authenticated website inquiry is captured once", { status: first.status, body: first.body });
      F.person = first.body.person_id; F.lead = first.body.lead_id; F.conversation = first.body.conversation_id;
      const again = await api("POST", "/leasing/intake", { headers: { "x-intake-secret": "e2e-intake", "Idempotency-Key": key }, body });
      check(again.status === 200 && again.body.replayed === true && again.body.person_id === F.person && again.body.lead_id === F.lead && again.body.conversation_id === F.conversation, "a relay redelivery replays the same person, lead and conversation", { replayed: again.body && again.body.replayed });
      const consent = await one("select consent_state from contact_preferences where person_id=$1 and channel='text'", [F.person]);
      check(consent && consent.consent_state === "opted_in", "the form's positive consent is recorded (no consent would leave the prospect untextable)", consent);
      check(sms().filter((m) => m.to === F.prospect.phone).length === 0, "capture sent nothing to the prospect");
    });

    // ── 2 · staff ownership ─────────────────────────────────────────
    await section("ownership", async () => {
      need(F.conversation, "conversation exists");
      const take = await api("POST", `/operator/conversations/${F.conversation}/take-over`, { token: F.agent.tok, body: {} });
      need(take.status === 200, "the agent takes ownership of the inquiry", { status: take.status, body: take.body });
      const detail = await api("GET", `/operator/leasing/conversations/${F.conversation}`, { token: F.agent.tok });
      check(detail.status === 200 && detail.body.human_owner && detail.body.human_owner.user_id === F.agent.id, "the conversation detail names the agent as accountable owner", { owner: detail.body && detail.body.human_owner && detail.body.human_owner.user_id === F.agent.id });
      check(detail.status === 200 && (detail.body.messages || []).some((m) => m.channel === "website" && m.direction === "inbound" && m.body === F.inquiryMessage), "the conversation reads the original website question from communications");
      const inquiry = await api("POST", "/operator/ask-spine/ask", { token: F.agent.tok, body: { question: `Show website inquiries for ${F.prospect.name}.` } });
      check(inquiry.status === 200 && inquiry.body.property_id === P && inquiry.body.grounded_on?.inquiry_read_state === "OK" && typeof inquiry.body.answer === "string" && inquiry.body.answer.includes(F.inquiryMessage), "Ask Spine reads the same original website question through its scoped inquiry read");
      const again = await api("POST", `/operator/conversations/${F.conversation}/take-over`, { token: F.agent.tok, body: {} });
      observe("repeating the take-over by the same owner", { status: again.status });
      const other = await api("POST", `/operator/conversations/${F.conversation}/take-over`, { token: F.managerTok, body: {} });
      check(other.status === 409, "a second staff member cannot take an owned inquiry away silently", { status: other.status });
      const ask = await api("POST", "/operator/ask-spine/ask", { token: F.agent.tok, body: { question: "What needs my attention?" } });
      observe("the agent's personal Ask read after taking ownership", { outcome: ask.body && ask.body.outcome, open_items: ask.body && ask.body.grounded_on && ask.body.grounded_on.personal_open_items });
    });

    // ── 3 · native tour from the conversation ───────────────────────
    await section("tour", async () => {
      need(F.conversation, "conversation exists");
      const starts = new Date(Date.now() + 2 * 86400000), ends = new Date(starts.getTime() + 3600000);
      const slot = await api("POST", "/leasing/availability", { token: F.agent.tok, key: true, body: { property_id: P, starts_at: starts.toISOString(), ends_at: ends.toISOString(), unit_id: F.unit ? F.unit.id : null, leasing_agent_id: F.agent.id, capacity: 1, idempotency_key: `slot-${nonce}` } });
      need(slot.status===200 && slot.body.slot?.id,"the fixture has a native slot for the prospect",{status:slot.status});
      const k = `book-${nonce}`;
      const booked = await api("POST", `/operator/leasing/conversations/${F.conversation}/book-tour`, { token: F.agent.tok, body: { slot_id: slot.body.slot.id, idempotency_key: k } });
      need(booked.status === 200 && booked.body.tour_id, "the agent books the prospect onto a native slot from the conversation", { status: booked.status, body: booked.body });
      F.tour = booked.body.tour_id;
      const replay = await api("POST", `/operator/leasing/conversations/${F.conversation}/book-tour`, { token: F.agent.tok, body: { slot_id: slot.body.slot.id, idempotency_key: k } });
      check(replay.status === 200 && replay.body.idempotent && replay.body.tour_id === F.tour, "a repeated booking returns the same tour", { status: replay.status });
      const tour = await one("select lead_id, property_id from leasing_tours where id=$1", [F.tour]);
      check(tour.lead_id === F.lead && tour.property_id === P, "the tour is on the same lead and property");
      check(sms().filter((m) => m.to === F.prospect.phone).length === 0, "booking sent no message");
      const checkin = await api("POST", `/leasing/tours/${F.tour}/check-in`, { key: true, body: { actor_id: F.agent.id } });
      check(checkin.status < 400, "tour check-in", { status: checkin.status });
      const done = await api("POST", `/operator/leasing/tours/${F.tour}/complete`, { token: F.agent.tok, body: { actual_tour_host_user_id: F.agent.id, preferred_unit_id: F.unit ? F.unit.id : undefined, feedback: { standing: "ready_to_apply", notes: "Wants Bed B" }, idempotency_key: `done-${nonce}` } });
      need(done.status === 200, "the agent records the actual outcome as ready to apply", { status: done.status, body: done.body });
      const again = await api("POST", `/operator/leasing/tours/${F.tour}/complete`, { token: F.agent.tok, body: { actual_tour_host_user_id: F.agent.id, feedback: { standing: "ready_to_apply" }, idempotency_key: `done-${nonce}` } });
      check(again.status === 200 && again.body.replayed === true, "re-saving the same outcome replays instead of recording twice", { status: again.status });
      F.conversion = await one("select id, person_id from leasing_conversions where origin_tour_id=$1 and property_id=$2", [F.tour, P]);
      need(F.conversion && F.conversion.person_id === F.person, "the outcome opened the conversion for the same person");
      const followup = await one("select o.assigned_user_id from leasing_conversion_obligations l join obligations o on o.id=l.obligation_id where l.conversion_id=$1 and l.rung='tour_followup' and l.outcome is null", [F.conversion.id]);
      check(followup && followup.assigned_user_id === F.agent.id, "post-tour follow-up is the agent's accountable work");
    });

    await section("draft-correction", async () => {
      const terms = { space_id:F.bedB.id, rent:1250, security_deposit:1025, lease_start_date:dates.start, lease_end_date:dates.end, fees:[], concessions:{status:"none"}, idempotency_key:`wrong-${nonce}` };
      const save = (body, token=F.managerTok) => api("POST",`/operator/leasing/conversions/${F.conversion.id}/application-offer`,{token,body});
      const creation = await Promise.all([save(terms),save({...terms,idempotency_key:`competing-create-${nonce}`})]);
      need(creation.filter(r=>r.status===200).length===1 && creation.filter(r=>r.status===409 && r.body.error==='APPLICATION_OFFER_ALREADY_EXISTS').length===1,"concurrent first creates establish exactly one draft",creation.map(r=>({status:r.status,error:r.body?.error})));
      const wrong = creation.find(r=>r.status===200);
      need(wrong.body.application_offer_id && wrong.body.application_terms.rent==='1250.00',"manager saves the mistaken 1250 draft");
      const before = await one("select count(*)::int n from application_invitations where conversion_id=$1",[F.conversion.id]);
      need(before.n===0,"no invitation exists before the correction");
      const proposal = () => api('POST','/operator/ask-spine/message',{token:F.agent.tok,body:{message:`Send ${F.prospect.name} the application for Unit 3B, Bed B.`}});
      const oldProposal = await proposal();
      need(oldProposal.status===200 && oldProposal.body.confirmation?.token,"old draft can be reviewed before the correction");
      const correctedTerms = {...terms,rent:1025,supersedes_application_offer_id:wrong.body.application_offer_id,idempotency_key:`correct-${nonce}`};
      const unauthorized = await save(correctedTerms,F.agent.tok);
      check(unauthorized.status===403 && unauthorized.body.error==='NO_APPLICATION_OFFER_AUTHORITY',"leasing access cannot correct manager-authored economics");
      const wrongSpace = await save({...correctedTerms,space_id:F.foreignSpace.id});
      check(wrongSpace.status===409,"correction cannot move the offer to another exact home");
      const foreignActor = await save(correctedTerms,F.foreignToken);
      check(foreignActor.status===404,"the manager's session at another property cannot revise this conversion");
      const correctionRequests = [correctedTerms,{...correctedTerms,idempotency_key:`competing-correction-${nonce}`}];
      const corrections = await Promise.all(correctionRequests.map(body=>save(body)));
      need(corrections.filter(r=>r.status===200).length===1 && corrections.filter(r=>r.status===409).length===1,"concurrent corrections append one successor",corrections.map(r=>({status:r.status,error:r.body?.error})));
      const winner = corrections.findIndex(r=>r.status===200), correct=corrections[winner], winningTerms=correctionRequests[winner];
      need(correct.body.application_offer_id!==wrong.body.application_offer_id && correct.body.application_terms.rent==='1025.00' && correct.body.draft_revision===true && correct.body.applicant_review_required===false,"manager corrects the unsent draft to 1025 without applicant review");
      const retry = await save(winningTerms);
      check(retry.status===200 && retry.body.idempotent===true && retry.body.application_offer_id===correct.body.application_offer_id,"correction retry returns its retained successor");
      const conflict = await save({...winningTerms,rent:1050});
      check(conflict.status===409 && conflict.body.error==='APPLICATION_OFFER_IDEMPOTENCY_CONFLICT',"same correction key cannot carry changed terms");
      const history = (await q("select id,supersedes_application_offer_id,offered_terms_snapshot,authority_basis_snapshot,granted_by_person_id,created_at from lease_offers where id=any($1::uuid[]) order by created_at",[[wrong.body.application_offer_id,correct.body.application_offer_id]])).rows;
      check(history.length===2 && history[0].offered_terms_snapshot.application_terms.rent==='1250.00' && history[1].offered_terms_snapshot.application_terms.rent==='1025.00' && history[1].supersedes_application_offer_id===history[0].id && history[1].authority_basis_snapshot.actor_user_id===F.manager.id && history[1].granted_by_person_id===history[1].authority_basis_snapshot.acting_person_id && !!history[1].created_at,"prior terms survive with attributed and dated successor lineage");
      const stale = await api('POST','/operator/ask-spine/application-send/confirm',{token:F.agent.tok,body:{confirmation:oldProposal.body.confirmation.token}});
      check(stale.status===409 && stale.body.outcome==='APPLICATION_TERMS_REVIEW_REQUIRED',"confirmation for old rent refuses after the correction",stale);
      const duplicate = await Promise.all([save({...terms,rent:1025,idempotency_key:`duplicate-a-${nonce}`}),save({...terms,rent:1100,idempotency_key:`duplicate-b-${nonce}`})]);
      check(duplicate.every(r=>r.status===409),"concurrent unnamed drafts cannot branch the existing offer",duplicate.map(r=>({status:r.status,body:r.body})));
      const currentOffers = await one("select count(*)::int n from lease_offers o where property_id=$1 and person_id=$2 and space_id=$3 and source='application_proposal' and not exists(select 1 from lease_offers child where child.supersedes_application_offer_id=o.id)",[P,F.person,F.bedB.id]);
      check(currentOffers.n===1,"exactly one current draft remains",currentOffers);
      const after = await one("select count(*)::int n from application_invitations where conversion_id=$1",[F.conversion.id]);
      check(after.n===0,"correction does not create an invitation");
      check(sms().filter(m=>m.to===F.prospect.phone).length===0,"correction sends no prospect message");
      const currentProposal = await proposal();
      need(currentProposal.status===200 && currentProposal.body.confirmation?.token && String(currentProposal.body.receipt).includes('1,025'),"fresh proposal reads corrected current rent",currentProposal);
      const sent = await api('POST','/operator/ask-spine/application-send/confirm',{token:F.agent.tok,body:{confirmation:currentProposal.body.confirmation.token}});
      need(sent.status===200 && sent.body.sent===true,"fresh confirmation sends the corrected offer through the existing command",sent);
      const invitation = await one('select application_offer_id,space_id from application_invitations where conversion_id=$1',[F.conversion.id]);
      check(invitation.application_offer_id===correct.body.application_offer_id && invitation.space_id===F.bedB.id,"invitation binds the corrected offer and exact bed");
      const afterSendRevision = await save({...terms,rent:1100,supersedes_application_offer_id:correct.body.application_offer_id,idempotency_key:`after-send-${nonce}`});
      check(afterSendRevision.status===200 && afterSendRevision.body.applicant_review_required===true && afterSendRevision.body.draft_revision===false,"after an invitation the existing applicant-review revision path remains");
      const sentMessages = sms().filter(m=>m.to===F.prospect.phone);
      check(sentMessages.length===1 && /\/t\/application\//.test(sentMessages[0].body),"the sequence has one deliberate application send and no correction messages");
    });
  } finally { await pool.end(); }
  console.log(`Draft offer correction: ${results.filter(r=>r.ok&&r.kind==='check').length} passed, ${failed} failed`);
  process.exitCode = failed?1:0;
})().catch(e=>{console.error(e);process.exitCode=1;});

