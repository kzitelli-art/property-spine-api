// ════════════════════════════════════════════════════════════════════
//  technician_work_selection.test.js — DB-FREE.
//
//  Phase 2, milestone 1: an authenticated technician on an operations line
//  asks for their assigned actionable work, names ONE of it, and accepts it.
//
//  Every decision in that sentence is a refusal waiting to happen, and a
//  refusal that can only be exercised against a provisioned database is a
//  refusal nobody has ever seen fire. This harness fires all of them.
//
//  ── THE SIX THINGS IT PROVES ────────────────────────────────────────
//    identity            no actor, no work — and a partial actor is no actor
//    organization scope  the line's organization is required, never inferred
//    property resolution scope is verified against the actor's OWN assignments
//    eligibility         assignment, relation and status, each refused by name
//    replay safety       the same acceptance twice is a no-op, not an error
//    cross-property      same company is not authority over every building
//
//  ── WHAT IT CANNOT PROVE ────────────────────────────────────────────
//  It does not touch a database, so it says nothing about migration 131's
//  constraints, the FOR UPDATE lock, the unique acceptance key, or the
//  events row. tests/proofs/technician_acceptance.db.js is that proof and it has
//  NEVER RUN — it needs the full-schema database of
//  docs/archive/UNBLOCK_2_FULL_SCHEMA_HARNESS_DATABASE.md.
// ════════════════════════════════════════════════════════════════════
"use strict";
const fs = require("fs");
const path = require("path");
const receipt = require("../_run_receipt");

const HARNESS = __filename;
const EXPECTED = 68;
let passed = 0, failed = 0;
const ok = (label, cond, detail) => {
  if (cond) { passed++; console.log("  ok    " + label); }
  else { failed++; console.log("  FAIL  " + label + (detail ? "  →  " + detail : "")); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 56 - t.length))}`);
const throws = (fn, code) => { try { fn(); return false; } catch (e) { return code ? e.code === code : true; } };

const sel = require("../../src/technician/work_selection");
const ROOT = path.join(__dirname, "..", "..");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const SEL_SRC = strip(fs.readFileSync(path.join(ROOT, "src/technician/work_selection.js"), "utf8"));
const SVC_SRC = strip(fs.readFileSync(path.join(ROOT, "src/technician/acceptance_service.js"), "utf8"));
const MIG = fs.readFileSync(path.join(ROOT, "migrations/131_work_acceptance.sql"), "utf8");

const DANA = "user-dana", SAM = "user-sam";
const ORG = "org-1", OTHER_ORG = "org-2";
const P1 = "prop-1", P2 = "prop-2", P_FOREIGN = "prop-foreign";
const actor = (over = {}) => Object.assign({ userId: DANA, organizationId: ORG, assignedPropertyIds: [P1, P2] }, over);
const row = (over = {}) => Object.assign({
  obligation_id: "ob-1", work_order_id: "wo-1", related_type: "work_order",
  property_id: P1, assigned_user_id: DANA, accepted_by_user_id: null, status: "open",
}, over);

receipt.begin(HARNESS, { expected: EXPECTED });

let code = 1;
try {

// ════════════════════════════════════════════════════════════════════
section("1. IDENTITY — NO ACTOR, NO WORK");
// ════════════════════════════════════════════════════════════════════
{
  ok("no actor at all is refused",
    throws(() => sel.offerableWork({ candidates: [] }), "actor_missing"));
  ok("an actor with no user id is refused",
    throws(() => sel.offerableWork({ actor: { organizationId: ORG, assignedPropertyIds: [] }, candidates: [] }), "actor_missing"));
  ok("an actor with no organization is refused — the line established it and the scope must state it",
    throws(() => sel.offerableWork({ actor: { userId: DANA, assignedPropertyIds: [] }, candidates: [] }), "actor_organization_missing"));
  ok("an ABSENT scope is not an open scope",
    throws(() => sel.offerableWork({ actor: { userId: DANA, organizationId: ORG }, candidates: [] }), "actor_scope_missing")
    && throws(() => sel.offerableWork({ actor: { userId: DANA, organizationId: ORG, assignedPropertyIds: null }, candidates: [] }), "actor_scope_missing"));
  ok("an EMPTY scope offers nothing rather than everything",
    sel.offerableWork({ actor: actor({ assignedPropertyIds: [] }), candidates: [row()] }).offerable.length === 0);
  ok("an unreadable candidate set is not an empty one",
    throws(() => sel.offerableWork({ actor: actor(), candidates: null }), "candidates_not_an_array"));
  ok("acceptance eligibility refuses the same partial actors",
    throws(() => sel.acceptanceEligibility({ row: row() }), "actor_missing")
    && throws(() => sel.acceptanceEligibility({ actor: { userId: DANA, organizationId: ORG }, row: row() }), "actor_scope_missing"));
}

// ════════════════════════════════════════════════════════════════════
section("2. ELIGIBILITY — EACH REFUSAL NAMED");
// ════════════════════════════════════════════════════════════════════
{
  const check = (over, reason) => {
    const r = sel.offerableWork({ actor: actor(), candidates: [row(over)] });
    return r.offerable.length === 0 && r.refused.length === 1 && r.refused[0].reason === reason;
  };
  ok("somebody else's obligation is not mine to see", check({ assigned_user_id: SAM }, "not_assigned_to_actor"));
  ok("an unassigned obligation is not mine either", check({ assigned_user_id: null }, "not_assigned_to_actor"));
  ok("an obligation about something other than a work order", check({ related_type: "lease" }, "not_work_order_related"));
  ok("a work-order obligation with no work order", check({ work_order_id: null }, "not_work_order_related"));
  ok("a completed obligation is not actionable", check({ status: "complete" }, "not_actionable_status"));
  ok("an escalated obligation is not actionable", check({ status: "escalated" }, "not_actionable_status"));
  ok("an open obligation IS offerable",
    sel.offerableWork({ actor: actor(), candidates: [row()] }).offerable.length === 1);
  ok("work already in progress stays visible to its owner",
    sel.offerableWork({ actor: actor(), candidates: [row({ status: "in_progress" })] }).offerable.length === 1);

  ok("every refusal reason is in the published vocabulary",
    sel.offerableWork({ actor: actor(), candidates: [
      row({ assigned_user_id: SAM }), row({ related_type: "lease" }),
      row({ status: "complete" }), row({ property_id: P_FOREIGN }),
    ] }).refused.every((f) => sel.INELIGIBILITY.includes(f.reason)));

  //  "You have nothing" and "you have things you may not take" are different
  //  answers, and a surface that conflates them tells a technician their
  //  queue is empty when it is not.
  const blocked = sel.offerableWork({ actor: actor(), candidates: [row({ assigned_user_id: SAM })] });
  ok("having candidates but none offerable is stated separately from having none",
    blocked.hasCandidatesButNoneOfferable === true
    && sel.offerableWork({ actor: actor(), candidates: [] }).hasCandidatesButNoneOfferable === false);
  ok("nothing is dropped silently — every refused row is reported with a reason",
    blocked.refused.length === 1 && blocked.refused[0].obligation_id === "ob-1");
  ok("results are frozen", Object.isFrozen(blocked) && Object.isFrozen(blocked.offerable));
  ok("a malformed candidate row is refused, not skipped",
    throws(() => sel.offerableWork({ actor: actor(), candidates: [null] }), "row_malformed")
    && throws(() => sel.offerableWork({ actor: actor(), candidates: [{ work_order_id: "wo-1" }] }), "row_malformed"));
}

// ════════════════════════════════════════════════════════════════════
section("3. CROSS-PROPERTY REFUSAL");
// ════════════════════════════════════════════════════════════════════
{
  ok("a building this technician does not work at is refused by name",
    sel.offerableWork({ actor: actor(), candidates: [row({ property_id: P_FOREIGN })] })
      .refused[0].reason === "property_outside_actor_scope");
  ok("...and it is refused for ACCEPTANCE too, not only for display",
    sel.acceptanceEligibility({ actor: actor(), row: row({ property_id: P_FOREIGN }) }).verdict === "property_outside_actor_scope");
  ok("assignment to one property does not carry to a sibling",
    sel.offerableWork({ actor: actor({ assignedPropertyIds: [P1] }), candidates: [row({ property_id: P2 })] })
      .offerable.length === 0);
  ok("the actor's own two properties both resolve",
    sel.offerableWork({ actor: actor(), candidates: [row({ property_id: P1 }), row({ obligation_id: "ob-2", property_id: P2 })] })
      .offerable.length === 2);

  //  The scope is VERIFIED, never derived. The module cannot read an
  //  organization's property list because it cannot read anything.
  ok("the module reaches for no data source of its own",
    !/require\s*\(/.test(SEL_SRC) && !/\bquery\s*\(/.test(SEL_SRC));
  ok("the module never reads an organization's property list",
    !/organization_id/.test(SEL_SRC) && !/properties\b/.test(SEL_SRC));
}

// ════════════════════════════════════════════════════════════════════
section("4. SELECTION — THEY MUST NAME IT");
// ════════════════════════════════════════════════════════════════════
{
  const offerable = [row(), row({ obligation_id: "ob-2", work_order_id: "wo-2", property_id: P2 })];

  ok("no work at all is said as such",
    sel.selectReferencedWork({ offerable: [], reference: { workOrderId: "wo-1" } }).outcome === "none_offerable");

  //  THE DOCTRINE POINT. One offerable item is not evidence they meant it.
  //  Same rule that stops an organization number choosing a building.
  ok("ONE offerable item is still not selected without a reference",
    sel.selectReferencedWork({ offerable: [row()], reference: null }).outcome === "no_reference");
  ok("...nor with an empty reference",
    sel.selectReferencedWork({ offerable: [row()], reference: {} }).outcome === "no_reference");

  ok("naming a work order selects exactly it",
    sel.selectReferencedWork({ offerable, reference: { workOrderId: "wo-2" } }).selected.obligation_id === "ob-2");
  ok("naming an obligation selects exactly it",
    sel.selectReferencedWork({ offerable, reference: { obligationId: "ob-1" } }).selected.work_order_id === "wo-1");
  ok("naming something that is not theirs to take is NOT 'you have no work'",
    sel.selectReferencedWork({ offerable, reference: { workOrderId: "wo-999" } }).outcome === "reference_not_offerable");
  ok("naming two things is two selections, and is refused",
    throws(() => sel.selectReferencedWork({ offerable, reference: { workOrderId: "wo-1", obligationId: "ob-1" } }),
      "ambiguous_reference_shape"));
  ok("a reference matching more than one is ambiguous, never a pick",
    sel.selectReferencedWork({ offerable: [row(), row({ obligation_id: "ob-3" })],
      reference: { workOrderId: "wo-1" } }).outcome === "ambiguous_reference");
  ok("an unreadable offer set is refused",
    throws(() => sel.selectReferencedWork({ offerable: null, reference: { workOrderId: "wo-1" } }), "offerable_not_an_array"));
  ok("every selection outcome is in the published vocabulary",
    [[], [row()]].every((o) => sel.SELECTION_OUTCOMES.includes(sel.selectReferencedWork({ offerable: o, reference: null }).outcome)));

  //  There is deliberately no ordinal reference. "The first one" depends on a
  //  list this module never sent and cannot prove the technician saw.
  ok("no ordinal reference exists to be exploited",
    !/ordinal|firstOne|\bindex\b|position/i.test(SEL_SRC));
}

// ════════════════════════════════════════════════════════════════════
section("5. ACCEPTANCE ELIGIBILITY AND REPLAY SAFETY");
// ════════════════════════════════════════════════════════════════════
{
  const E = (over) => sel.acceptanceEligibility({ actor: actor(), row: row(over) });

  ok("an open obligation assigned to me at my property is acceptable", E().verdict === "eligible" && E().eligible === true);
  ok("somebody else's is refused", E({ assigned_user_id: SAM }).verdict === "not_assigned_to_actor");
  ok("a non-work-order obligation is refused", E({ related_type: "turnover" }).verdict === "not_work_order_related");

  //  REPLAY. The same technician accepting the same work again has changed
  //  nothing. That is a no-op with an honest name, not an error.
  const mine = E({ status: "in_progress", accepted_by_user_id: DANA });
  ok("accepting my own accepted work again is a NO-OP, not an error",
    mine.verdict === "already_accepted_by_actor" && mine.eligible === false && mine.isNoop === true);

  const theirs = E({ status: "in_progress", accepted_by_user_id: SAM });
  ok("work somebody else already accepted is a genuine conflict",
    theirs.verdict === "already_accepted_by_another" && theirs.isNoop === false);
  ok("...and a conflict is never reported as a no-op", theirs.isNoop === false && mine.isNoop === true);

  ok("in-flight work with no acceptance record is refused as not_open",
    E({ status: "in_progress" }).verdict === "not_open");
  ok("completed work is refused before anything else is considered",
    E({ status: "complete" }).verdict === "not_open");
  ok("the ownership check runs BEFORE the acceptance check — someone else's accepted work is first of all not mine",
    E({ assigned_user_id: SAM, status: "in_progress", accepted_by_user_id: SAM }).verdict === "not_assigned_to_actor");
  ok("every verdict is in the published vocabulary",
    [E(), mine, theirs, E({ status: "complete" }), E({ property_id: P_FOREIGN })]
      .every((v) => sel.ACCEPTANCE_VERDICTS.includes(v.verdict)));
  ok("no verdict is both ineligible and silent — an ineligible verdict is always named",
    [E({ assigned_user_id: SAM }), E({ property_id: P_FOREIGN }), theirs].every((v) => !v.eligible && !!v.verdict));
}

// ════════════════════════════════════════════════════════════════════
section("6. THE CANONICAL WRITE — ONE PLACE, SERVER-DERIVED");
// ════════════════════════════════════════════════════════════════════
{
  const files = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (e.name.endsWith(".js")) files.push(p);
  });
  walk(path.join(ROOT, "src"));

  //  THE CLAIM IS ABOUT WORK-ORDER ACCEPTANCE, SO THE SCAN MUST BE TOO.
  //  `accepted_by_user_id` is not a name this domain owns — `activations`
  //  carries one too, meaning "a human accepted this source document
  //  version". Matching the column name alone made an unrelated domain
  //  look like a second technician-acceptance door. Resolve each write to
  //  the table its UPDATE targets, and assert per table: work-order
  //  acceptance stays single-writer, and every other table's writes are
  //  LISTED rather than silently tolerated, so a real second door here
  //  cannot hide behind a rename.
  const acceptanceWritesByTable = new Map();
  for (const f of files) {
    const src = strip(fs.readFileSync(f, "utf8"));
    const rel = path.relative(ROOT, f).replace(/\\/g, "/");
    const re = /accepted_by_user_id\s*=\s*\$/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const before = src.slice(0, m.index);
      const upd = before.match(/update\s+([a-z_][a-z0-9_]*)[\s\S]*$/i);
      const table = upd ? upd[1].toLowerCase() : "(no enclosing update)";
      if (!acceptanceWritesByTable.has(table)) acceptanceWritesByTable.set(table, new Set());
      acceptanceWritesByTable.get(table).add(rel);
    }
  }
  const listOf = (t) => [...(acceptanceWritesByTable.get(t) || [])].sort().join(",");

  ok("work-order acceptance is written in exactly one place",
    listOf("obligations") === "src/technician/acceptance_service.js", listOf("obligations"));
  ok("no acceptance write escapes an UPDATE the scan can resolve to a table",
    !acceptanceWritesByTable.has("(no enclosing update)"),
    listOf("(no enclosing update)"));
  ok("every OTHER table carrying an accepted_by_user_id write is named, not hidden",
    [...acceptanceWritesByTable.keys()].filter((t) => t !== "obligations").sort().join(",")
      === "activations",
    [...acceptanceWritesByTable.keys()].filter((t) => t !== "obligations").sort()
      .map((t) => `${t}: ${listOf(t)}`).join(" · "));

  ok("the service does not re-implement eligibility — it imports the proven module",
    /require\(["']\.\/work_selection["']\)/.test(SVC_SRC) && /acceptanceEligibility\s*\(/.test(SVC_SRC)
    && !/function acceptanceEligibility/.test(SVC_SRC));

  //  §21 — a scope that arrives as an argument is a request, not a fact.
  ok("the service DERIVES the actor's scope instead of accepting it",
    /property_team_assignments/.test(SVC_SRC) && !/assignedPropertyIds\s*=\s*[a-z]+\.assignedPropertyIds/.test(SVC_SRC));
  ok("the service locks the row before deciding anything", /for update/i.test(SVC_SRC));
  ok("the UPDATE is itself guarded on the state it believes it is changing",
    /status = 'open' and accepted_at is null/.test(SVC_SRC));
  ok("a concurrent duplicate is converted to a replay, not an error", /23505/.test(SVC_SRC));
  ok("an immutable history row is written", /insert into events/.test(SVC_SRC) && /work_accepted/.test(SVC_SRC));
  ok("the service sends nothing",
    !/sendSms|sendPropertySms|twilio/i.test(SVC_SRC));
  ok("the service does not touch the free-text work_orders.assigned_to column",
    !/assigned_to/.test(SVC_SRC));
}

// ════════════════════════════════════════════════════════════════════
section("7. MIGRATION 131 — WHAT IT MAKES UNEXPRESSABLE");
// ════════════════════════════════════════════════════════════════════
{
  ok("acceptance and its time move together", /ck_oblig_acceptance_paired/.test(MIG)
    && /\(accepted_by_user_id is null\) = \(accepted_at is null\)/.test(MIG));
  ok("the accepter IS the owner — 'accepted by Dana, assigned to Sam' cannot exist",
    /ck_oblig_accepter_is_owner/.test(MIG) && /assigned_user_id = accepted_by_user_id/.test(MIG));
  ok("accepted work is never open work", /ck_oblig_accepted_not_open/.test(MIG)
    && /accepted_at is null or status <> 'open'/.test(MIG));
  ok("a key without an acceptance cannot be stored", /ck_oblig_acceptance_key_requires_acceptance/.test(MIG));
  ok("one acceptance per inbound message, enforced by the DATABASE",
    /create unique index if not exists uq_obligations_acceptance_key/.test(MIG)
    && /where acceptance_key is not null/.test(MIG));
  ok("every column added is nullable, so no existing obligation changes meaning",
    !/add column if not exists \w+ [^;]*not null/i.test(MIG));
  ok("it does NOT lift the Slice A outbound ban", !/ck_cl_outbound_disabled_slice_a/.test(MIG.replace(/^--.*$/gm, "")));
  ok("it is transactional", /^begin;/m.test(MIG) && /^commit;/m.test(MIG));

  //  131 is claimed only here. 130 belongs to Slice A.
  const files = fs.readdirSync(path.join(ROOT, "migrations")).filter((f) => /^131.*\.sql$/.test(f));
  ok("exactly one file claims 131", files.length === 1 && files[0] === "131_work_acceptance.sql", files.join(","));
}

  code = receipt.complete({ harness: HARNESS, passed, failed, expectedAtLeast: EXPECTED });
} catch (e) {
  code = receipt.died(HARNESS, e, passed + failed);
}
process.exit(code);
