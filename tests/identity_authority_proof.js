// ════════════════════════════════════════════════════════════════════
//  identity_authority_proof.js — the permanent identity & authority invariants
//
//  A user is a CREDENTIAL. A person is a HUMAN. Everything here defends that
//  line, independently of Pricing.
//
//  Constructed cases + the live portfolio audit. Writes nothing.
//  Run: DATABASE_URL=... node tests/identity_authority_proof.js
// ════════════════════════════════════════════════════════════════════

"use strict";
const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");
const REPO = path.resolve(__dirname, "..");
const DEMO = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";
const OTHER_PROP = "9e2bb96e-08e2-41db-81c2-91055ceb50a3";
const OWNER_PERSON = "16b442ee-0ec5-425a-90f3-ab8708a15b77";   // owner on Demo
const PM_PERSON = "bfa835d8-4b6e-4065-8327-8f2cfe95b49b";      // property_manager on Demo
const PM_USER = "492f97b0-5e76-4197-b110-c0afb0e64e15";        // linked to PM_PERSON
const QA_USER = "e9a7659f-ee1a-4bde-9e0c-02c6632ff066";        // unlinked

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("   PASS  " + m); } else { fail++; console.log("   FAIL  " + m); } };
const sec = (s) => console.log("\n== " + s + " ==");

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) { console.log("FATAL: DATABASE_URL required"); process.exit(1); }
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

  const { resolveActorContext, actorReceipt, FULL_AUTHORITY_ROLES } = require(path.join(REPO, "src/identity/actor_context"));
  const { identityGraphAudit } = require(path.join(REPO, "src/identity/identity_graph_audit"));
  const { reconcileIdentities } = require(path.join(REPO, "src/identity/identity_reconciliation"));
  const { pricingAuthority } = require(path.join(REPO, "src/money/pricing_authority"));
  const { saveDraft, submitReview } = require(path.join(REPO, "src/money/pricing_lifecycle"));

  sec("A USER IS NOT A PERSON");
  const linkedCtx = await resolveActorContext(pool, { user_id: PM_USER, property_id: DEMO });
  ok(linkedCtx.ok, "a linked user resolves");
  ok(String(linkedCtx.user.user_id) !== String(linkedCtx.person.person_id),
    "the user id and the person id are DIFFERENT values, carried separately");
  ok(linkedCtx.user.user_id === PM_USER && linkedCtx.person.person_id === PM_PERSON,
    "each is the value it should be, not the other");
  const r = actorReceipt(linkedCtx, "may_publish_pricing");
  ok(r.session_user_id === PM_USER && r.acting_person_id === PM_PERSON,
    "a privileged receipt names BOTH the acting user and the acting person");
  ok(/credential/.test(r.attribution_rule), "and states which is which");

  sec("AN UNLINKED USER CANNOT ACT AS A HUMAN");
  const unlinked = await resolveActorContext(pool, { user_id: QA_USER, property_id: DEMO });
  ok(!unlinked.ok && unlinked.failure_reason === "session_identity_not_linked_to_a_person",
    "the QA operator is refused, by name");
  ok(unlinked.reconciliation_required === true, "and is flagged as needing reconciliation");
  ["may_prepare_pricing", "may_review_pricing", "may_publish_pricing", "may_manage_concession_authority"]
    .forEach((v) => ok(unlinked.capabilities[v] === false, `${v} is denied`));

  sec("READ ENTITLEMENT IS SEPARATE FROM WRITE AUTHORITY");
  ok(unlinked.capabilities.may_read_property === true,
    "an unlinked user KEEPS read entitlement — the product still works");
  ok(unlinked.property_entitlement === "session_scoped",
    "and that entitlement comes from the session, not from a person");

  sec("A LINKED USER GETS ONLY THE LINKED PERSON'S ASSIGNMENTS");
  ok(linkedCtx.assignments.length === 1 && linkedCtx.assignments[0].role === "property_manager",
    `the PM user receives exactly the PM assignment (${linkedCtx.assignments.map((a) => a.role).join(",")})`);
  ok(linkedCtx.capabilities.may_publish_pricing === false,
    "A PROPERTY MANAGER GETS NO PRICING PUBLICATION AUTHORITY — managing is not pricing");
  ok(linkedCtx.capabilities.may_prepare_pricing === false, "nor preparation");
  ok(!FULL_AUTHORITY_ROLES.has("property_manager"), "property_manager is not in the authority role set");
  ok(linkedCtx.failure_reason === "no_governed_authority_on_this_property",
    "and the denial is stated");

  sec("DUPLICATE LABELS GRANT NOTHING");
  // Four person rows share "Jordan Avery (demo)"; ONE holds owner. The linked
  // user points at a fifth, differently-labelled row.
  const dupes = (await pool.query(
    "select id from persons where lower(name)=lower('Jordan Avery (demo)')")).rows;
  ok(dupes.length === 4, `${dupes.length} person rows share that label`);
  const ownerHolders = (await pool.query(
    `select person_id from assignments where property_id=$1 and is_active=true and role='owner'`, [DEMO])).rows;
  ok(ownerHolders.length === 1 && String(ownerHolders[0].person_id) === OWNER_PERSON,
    "exactly one of them holds the owner assignment");
  const ownerUsers = (await pool.query("select id from users where person_id=$1", [OWNER_PERSON])).rows;
  ok(ownerUsers.length === 0, "NO user is linked to the owner-holding row — the label bought nothing");
  const ctxSrc = fs.readFileSync(path.join(REPO, "src/identity/actor_context.js"), "utf8")
    .split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  ok(!/persons[^)]*name\s*=|lower\(p?\.?name\)|ilike/i.test(ctxSrc),
    "actor_context never queries persons by name");

  sec("AUTHORITY IS PROPERTY-SCOPED");
  const crossProp = await resolveActorContext(pool, { user_id: PM_USER, property_id: OTHER_PROP });
  ok(crossProp.assignments.length === 0,
    "the same user on another property carries NO assignments");
  ok(crossProp.capabilities.may_publish_pricing === false, "and no publication authority");
  ok(/property_id = \$2/.test(fs.readFileSync(path.join(REPO, "src/identity/actor_context.js"), "utf8")),
    "assignments are FILTERED IN THE QUERY — cross-property rows are never loaded into memory");

  sec("GRANTS ARE VERB-SCOPED AND WINDOWED");
  const grantCols = (await pool.query(
    `select column_name from information_schema.columns where table_name='concession_authority_grants'`)).rows
    .map((x) => x.column_name);
  ["may_prepare_pricing", "may_review_pricing", "may_publish_public_offers", "may_manage_concession_authority"]
    .forEach((c) => ok(grantCols.includes(c), `the grant carries an explicit ${c} column`));
  const src = fs.readFileSync(path.join(REPO, "src/identity/actor_context.js"), "utf8");
  ok(/effective_from <= \$3/.test(src) && /effective_until is null or effective_until > \$3/.test(src),
    "a grant is only read inside its effective window — expired grants are never loaded");

  sec("FAILURE FAILS CLOSED");
  const deadPool = { query: async () => { throw new Error("db down"); } };
  const dead = await resolveActorContext(deadPool, { user_id: PM_USER, property_id: DEMO });
  ok(!dead.ok && dead.failure_reason === "identity_read_failed", "a failed IDENTITY read denies");
  ok(Object.values(dead.capabilities).every((v) => v === false), "with every capability false");
  let calls = 0;
  const flakyPool = { query: async (q) => {
    calls++;
    if (calls === 1) return { rows: [{ id: PM_USER, name: "x", person_id: PM_PERSON, is_active: true }] };
    throw new Error("db down");
  } };
  const flaky = await resolveActorContext(flakyPool, { user_id: PM_USER, property_id: DEMO });
  ok(!flaky.ok && flaky.failure_reason === "authority_read_failed", "a failed AUTHORITY read denies");
  ok(flaky.capabilities.may_publish_pricing === false, "with publication denied");
  const nobody = await resolveActorContext(pool, { user_id: null, property_id: DEMO });
  ok(!nobody.ok && nobody.failure_reason === "no_session_user", "no session user is a denial");
  const noProp = await resolveActorContext(pool, { user_id: PM_USER, property_id: null });
  ok(!noProp.ok && noProp.failure_reason === "no_property_context", "no property context is a denial");

  sec("NO BROWSER-SUPPLIED IDENTITY CAN SUBSTITUTE");
  const opSrc = fs.readFileSync(path.join(REPO, "src/identity/operator.js"), "utf8");
  const pricingRoutes = opSrc.split("\n").filter((l) => /operator\/pricing|actor-context/.test(l));
  ok(pricingRoutes.length > 0, "the pricing and actor routes exist");
  ok(!/resolveActorContext\(pool, \{\s*user_id:\s*(req\.body|b\.)/.test(opSrc),
    "no route resolves an actor from a request body");
  ok(/user_id: req\.operator\.id,\s*\/\/ SESSION ONLY/.test(opSrc),
    "the actor route takes user_id from the SESSION, explicitly");
  ok(!/property_id:\s*(req\.body|b)\.property_id/.test(
      opSrc.slice(opSrc.indexOf("/operator/pricing"), opSrc.indexOf("/operator/rent-roll/institutional"))),
    "no pricing route accepts a body-supplied property");

  sec("PRICING CONSUMES THE SHARED CONTEXT");
  const paSrc = fs.readFileSync(path.join(REPO, "src/money/pricing_authority.js"), "utf8");
  ok(/require\("\.\.\/identity\/actor_context"\)/.test(paSrc),
    "pricing_authority delegates to actor_context");
  ok(!/select person_id from users/.test(paSrc),
    "and no longer resolves users to persons itself");
  const qaAuth = await pricingAuthority(pool, { property_id: DEMO, user_id: QA_USER });
  ok(!qaAuth.may_publish_pricing && qaAuth.denied_reason === "session_identity_not_linked_to_a_person",
    "pricing reports the SAME reason the actor context gives");
  const pmAuth = await pricingAuthority(pool, { property_id: DEMO, user_id: PM_USER });
  ok(!pmAuth.may_publish_pricing && pmAuth.session_user_id === PM_USER,
    "and carries the session user id for the receipt");

  sec("PERSON-GOVERNED WRITES ARE REFUSED FOR AN UNLINKED USER");
  let e1 = null;
  try { await saveDraft(pool, { property_id: DEMO, user_id: QA_USER, proposal: {} }); }
  catch (e) { e1 = e.code; }
  ok(e1 === "not_authorized_to_prepare", "saveDraft refuses an unlinked session");
  let e2 = null;
  try { await submitReview(pool, { property_id: DEMO, user_id: QA_USER, proposal: {}, decision: "approved" }); }
  catch (e) { e2 = e.code; }
  ok(e2 === "not_authorized_to_review", "submitReview refuses an unlinked session");
  let e3 = null;
  try { await saveDraft(pool, { property_id: DEMO, user_id: PM_USER, proposal: {} }); }
  catch (e) { e3 = e.code; }
  ok(e3 === "not_authorized_to_prepare", "and refuses a linked PROPERTY MANAGER too");

  sec("RECONCILIATION REFUSES WHAT IT MUST");
  const rec = await reconcileIdentities(pool, { apply: false });
  ok(rec.disposition === "dry_run_no_write_performed", "the dry run writes nothing");
  ok(rec.proposals.every((p) => p.deterministic === false || p.evidence.length > 0),
    "no proposal exists without evidence");
  ok(rec.proposals.every((p) => !p.evidence.some((e) => /name/i.test(e.kind))),
    "no evidence kind is name-based");
  ok(rec.summary.deterministic === 0,
    `zero links are currently applicable (${rec.summary.requiring_human_ruling} need a human ruling)`);
  ok(rec.proposals.some((p) => p.refusals.some((x) => x.code === "account_not_classified_as_staff")),
    "unclassified accounts are refused BEFORE proposing, matching what the bridge would do");
  const recSrc = fs.readFileSync(path.join(REPO, "src/identity/identity_reconciliation.js"), "utf8");
  ok(/would_confer_governing_authority/.test(recSrc),
    "linking because a person holds desired authority has its own refusal");
  // Scan EXECUTABLE source: the prose above legitimately says "merge person
  // rows — not done here", and matching that would fail on its own disclaimer.
  const recExec = recSrc.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  ok(!/update\s+users\s+set[^;]*person_id/i.test(recExec),
    "the tool never writes users.person_id itself — only the governed bridge does");
  ok(!/delete\s+from\s+persons|update\s+persons\s+set/i.test(recExec),
    "and never merges, rewrites or deletes a person row");
  ok(/bridgeService\.linkBridge/.test(recExec),
    "every applied link goes through the existing governed bridge and its audit trail");
  let applyErr = null;
  try { await reconcileIdentities(pool, { apply: true, performed_by_user_id: QA_USER }); }
  catch (e) { applyErr = e.message; }
  ok(/allow-list/.test(applyErr || ""), "applying without an explicit allow-list is refused");

  sec("LIVE PORTFOLIO AUDIT");
  const audit = await identityGraphAudit(pool, { property_id: DEMO });
  ok(audit.disposition === "read_only_audit_no_links_created", "the audit creates nothing");
  ok(audit.totals.users_reaching_pricing_authority === 0,
    "ZERO users portfolio-wide reach pricing authority — the blocker is real and unchanged");
  ok(audit.person_label_collisions.length > 0,
    `${audit.person_label_collisions.length} duplicate person labels exist — names cannot be identity`);
  ok(audit.person_label_collisions.filter((c) => c.carries_authority).length === 1,
    "exactly one label collision carries authority");
  ok(/was derived from a display name/i.test(audit.rule)
     && /never to create a link/i.test(audit.rule),
    "the audit states its own rule: names may disqualify a link, never create one");

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
