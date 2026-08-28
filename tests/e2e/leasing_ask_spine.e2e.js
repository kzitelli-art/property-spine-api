/*  ASK SPINE — REAL AUTHENTICATED HTTP CONTRACT.

    The parent runner boots the production server against disposable Postgres.
    This proof therefore treats POST /operator/ask-spine/ask — not a direct
    reader call or intercepted dashboard fixture — as the release oracle.

    No live model is called. Every question below is resolved deterministically
    by the server before the model boundary.                                    */
"use strict";

const { randomUUID } = require("crypto");
const fs = require("fs");
const askSpineAnswer = require("../../src/agent/ask_spine_answer.js");
const staffSessions = require("../../src/identity/staff_session_service.js");
const { pool, q, ctx, toPacket, residentSigns, api } = require("./leasing_e2e_lib.js");

(async () => {
  const C = await ctx();
  const NAME = "Zeph" + Date.now().toString(36) + " Quillon";
  const A = await toPacket(C, { bed: C.bedB, name: NAME });
  await residentSigns(A.rawTok);

  let bad = 0;
  let heldApplicationsTable = false;
  let proofObligationId = null;
  let unauthorizedUserId = null;
  const must = (name, cond, detail = "") => {
    if (cond) console.log("  \u2713 " + name);
    else {
      bad++;
      console.log("  \u2717 " + name + (detail ? `\n      ${detail}` : ""));
    }
  };
  const askHttp = (token, question, extraBody = {}, key = null) => api(
    "POST", "/operator/ask-spine/ask",
    { token, key, body: { question, ...extraBody } },
  );
  const noActionClaims = (body) => ![
    "action", "actions", "confirmation", "confirmation_required",
    "receipt", "operating_receipt", "delivery_receipt",
  ].some((key) => Object.prototype.hasOwnProperty.call(body || {}, key));

  try {
    const anthropicLog = process.env.E2E_ANTHROPIC_LOG || "/tmp/property_spine_e2e_anthropic.log";
    const modelCalls = () => fs.existsSync(anthropicLog)
      ? fs.readFileSync(anthropicLog, "utf8").split("\n").filter(Boolean).length
      : 0;
    const callsBeforeCapability = modelCalls();
    const retiredCapability = await api("GET", "/agent/capability");
    must("the retired public Stage-0 model probe is not mounted",
      retiredCapability.status === 404, JSON.stringify(retiredCapability));
    must("the retired probe reaches the Anthropic sentinel zero times",
      modelCalls() === callsBeforeCapability,
      JSON.stringify({ before: callsBeforeCapability, after: modelCalls() }));

    const assignment = (await q(
      `select allowed_modules, primary_for_modules
         from property_team_assignments
        where user_id=$1 and property_id=$2 and active=true`,
      [C.mike, C.prop],
    )).rows[0];
    const serverContext = {
      property_id: C.prop,
      allowed_modules: assignment.allowed_modules,
      operator_user_id: C.mike,
      primary_for_modules: assignment.primary_for_modules,
    };

    console.log("── AUTHENTICATED HTTP CONTRACT ──");
    const signerQuestion = "Which signer is still outstanding?";
    const signer = await askHttp(C.token, signerQuestion);
    must("question-only body + x-staff-session reaches the real route", signer.status === 200,
      JSON.stringify(signer));
    must("the response envelope is exact and carries no action claim",
      Object.keys(signer.body || {}).sort().join(",") ===
        "answer,asked_at,grounded_on,outcome,property_id,references" &&
      noActionClaims(signer.body), JSON.stringify(signer.body));
    must("property scope is echoed from the session",
      signer.body.property_id === C.prop && !Number.isNaN(Date.parse(signer.body.asked_at)));
    must("the canonical property signing read answers deterministically",
      signer.body.outcome === "answered" &&
      signer.body.grounded_on.leasing_signing_read_state === "OK" &&
      signer.body.grounded_on.outstanding_signer_count >= 1 &&
      signer.body.answer.includes(NAME), JSON.stringify(signer.body));
    must("a signer answer has no invented open target",
      Array.isArray(signer.body.references) && signer.body.references.length === 0);

    const sameComposer = await askSpineAnswer.answer(pool, null, {
      ...serverContext,
      question: signerQuestion,
    });
    must("dashboard HTTP and the SMS-owned composer observe the same canonical outcome",
      sameComposer.outcome === signer.body.outcome &&
      sameComposer.answer === signer.body.answer &&
      JSON.stringify(sameComposer.grounded_on) === JSON.stringify(signer.body.grounded_on),
      JSON.stringify({ http: signer.body, shared: sameComposer }));

    const operatorKeyOnly = await askHttp(null, signerQuestion, {}, "e2e-key");
    must("x-operator-key is never a dashboard authentication fallback",
      operatorKeyOnly.status === 401 && /valid operator session/i.test(operatorKeyOnly.body.error || ""),
      JSON.stringify(operatorKeyOnly));

    const wrongProperty = await askHttp(C.token, signerQuestion, { property_id: randomUUID() });
    must("a client property claim is refused before the read",
      wrongProperty.status === 403 && wrongProperty.body.acting_on === C.prop,
      JSON.stringify(wrongProperty));

    const fakeModules = await askHttp(C.token, signerQuestion, { allowed_modules: ["asset_management"] });
    must("client module claims cannot replace the session entitlement",
      fakeModules.status === 200 && fakeModules.body.outcome === "answered" &&
      fakeModules.body.grounded_on.leasing_signing_read_state === "OK",
      JSON.stringify(fakeModules));

    const unauthorized = (await q(
      `insert into users (name, role, is_active, status, account_kind)
       values ($1,'maintenance',true,'active','human_staff') returning id`,
      [`Ask Spine HTTP Unauthorized ${Date.now()}`],
    )).rows[0];
    unauthorizedUserId = unauthorized.id;
    await q(
      `insert into property_team_assignments
         (user_id, property_id, role_title, allowed_modules, primary_for_modules, active, can_manage_roles)
       values ($1,$2,'maintenance','{maintenance}','{}',true,false)`,
      [unauthorizedUserId, C.prop],
    );
    const sessionClient = await pool.connect();
    let unauthorizedToken;
    try {
      await sessionClient.query("begin");
      const issued = await staffSessions.issueStaffSession(sessionClient, {
        userId: unauthorizedUserId,
        propertyId: C.prop,
        purpose: "bootstrap_invite",
      });
      unauthorizedToken = issued.session_token || issued.token;
      await sessionClient.query("commit");
    } catch (e) {
      await sessionClient.query("rollback");
      throw e;
    } finally {
      sessionClient.release();
    }
    const denied = await askHttp(unauthorizedToken, signerQuestion);
    must("an authenticated but unentitled session gets a server-written refusal",
      denied.status === 200 && denied.body.outcome === "not_authorized" &&
      denied.body.grounded_on === null && denied.body.references.length === 0 &&
      noActionClaims(denied.body), JSON.stringify(denied));

    const composition = await askHttp(
      C.token, "How many beds do we have, and what is the loan balance?",
    );
    must("unsupported cross-domain composition is an explicit non-success outcome",
      composition.status === 200 && composition.body.outcome === "composition_unavailable" &&
      composition.body.grounded_on === null && composition.body.references.length === 0 &&
      noActionClaims(composition.body), JSON.stringify(composition));

    const quietUnsupported = await askHttp(C.token, "");
    must("a quiet/unsupported empty question is out_of_scope, never answered",
      quietUnsupported.status === 200 && quietUnsupported.body.outcome === "out_of_scope" &&
      quietUnsupported.body.grounded_on === null && quietUnsupported.body.references.length === 0 &&
      noActionClaims(quietUnsupported.body), JSON.stringify(quietUnsupported));

    console.log("\n── SERVER-RESOLVED REFERENCES + NO RETENTION ──");
    const proofLabel = `HTTP contract person opener ${Date.now()}`;
    proofObligationId = (await q(
      `insert into obligations
         (property_id, person_id, module, type, label, owner_type, assigned_user_id, status, due_at)
       values ($1,$2,'leasing','http_contract_proof',$3,'human',$4,'open','2000-01-01')
       returning id`,
      [C.prop, A.person, proofLabel, C.mike],
    )).rows[0].id;
    const messagesBefore = Number((await q(
      "select count(*)::int n from staff_agent_messages where property_id=$1", [C.prop],
    )).rows[0].n);
    const personalQuestion = "What work is assigned to me?";
    const personal = await askHttp(C.token, personalQuestion);
    const opener = (personal.body.references || []).find((ref) => ref.label === proofLabel);
    must("references are resolved from canonical rows, never parsed from prose",
      personal.status === 200 && personal.body.outcome === "answered" && opener &&
      opener.open.kind === "person" && opener.open.id === A.person,
      JSON.stringify(personal.body));
    const personalShared = await askSpineAnswer.answer(pool, null, {
      ...serverContext,
      question: personalQuestion,
    });
    must("personal attention uses the same composer on dashboard and SMS",
      personalShared.answer === personal.body.answer &&
      JSON.stringify(personalShared.references) === JSON.stringify(personal.body.references));
    const messagesAfter = Number((await q(
      "select count(*)::int n from staff_agent_messages where property_id=$1", [C.prop],
    )).rows[0].n);
    must("dashboard Ask Spine retains no conversation state",
      messagesAfter === messagesBefore, `${messagesBefore} -> ${messagesAfter}`);

    console.log("\n── READER FAILURE IS NOT SUCCESS ──");
    await q("alter table lease_applications rename to lease_applications_http_contract_hold");
    heldApplicationsTable = true;
    const failed = await askHttp(C.token, signerQuestion);
    must("a real Postgres reader failure is client-visible as unavailable",
      failed.status === 200 && failed.body.outcome === "unavailable" &&
      failed.body.grounded_on.leasing_signing_read_state === "READ_FAILED" &&
      failed.body.grounded_on.applications_waiting_on_signature_count === null &&
      failed.body.references.length === 0 && noActionClaims(failed.body),
      JSON.stringify(failed));
    await q("alter table lease_applications_http_contract_hold rename to lease_applications");
    heldApplicationsTable = false;
    const restored = await askHttp(C.token, signerQuestion);
    must("the same canonical read returns to the exact answered state after restoration",
      restored.status === 200 && restored.body.outcome === signer.body.outcome &&
      restored.body.answer === signer.body.answer &&
      JSON.stringify(restored.body.grounded_on) === JSON.stringify(signer.body.grounded_on),
      JSON.stringify(restored));

    console.log("\n── DIRECT READER CONTROL ──");
    const subject = askSpineAnswer.questionSubject(`Has ${NAME} signed?`);
    const facts = await askSpineAnswer.gatherFacts(pool, {
      property_id: C.prop,
      allowed_modules: ["leasing"],
      subject,
      question: `Has ${NAME} signed?`,
    });
    const lp = facts.leasing_person;
    const leak = JSON.stringify(lp).match(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    must("the named leasing read remains OK", lp && lp.read_state === "OK");
    must("the bed is named", lp.target && lp.target.space_label === "Bed B");
    must("the resident signature is visible", !!(lp.lease && lp.lease.resident_executed_at));
    must("the company signature is honestly absent", !(lp.lease && lp.lease.company_executed_at));
    must("no tenancy is claimed", lp.tenancy.state === "none");
    must("no database ids cross the model-context boundary", !leak);
  } finally {
    if (heldApplicationsTable) {
      try { await q("alter table lease_applications_http_contract_hold rename to lease_applications"); }
      catch (e) { console.error("FAILED TO RESTORE lease_applications:", e.message); bad++; }
    }
    if (proofObligationId) {
      try { await q("delete from obligations where id=$1", [proofObligationId]); }
      catch (e) { console.error("proof obligation cleanup failed:", e.message); bad++; }
    }
    if (unauthorizedUserId) {
      try {
        await q("delete from staff_sessions where user_id=$1", [unauthorizedUserId]);
        await q("delete from property_team_assignments where user_id=$1", [unauthorizedUserId]);
        await q("delete from users where id=$1", [unauthorizedUserId]);
      } catch (e) { console.error("proof user cleanup failed:", e.message); bad++; }
    }
    await pool.end();
  }

  console.log("\n" + "═".repeat(66));
  console.log(`  ${bad === 0 ? "\u2713 PASS" : "\u2717 FAIL"} — leasing_ask_spine.e2e.js`);
  console.log("═".repeat(66) + "\n");
  process.exitCode = bad ? 2 : 0;
})().catch(async (e) => {
  console.log("DIED " + e.stack);
  try { await pool.end(); } catch (_) {}
  process.exitCode = 2;
});
