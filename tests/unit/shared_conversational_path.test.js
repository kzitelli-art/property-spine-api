// ════════════════════════════════════════════════════════════════════
//  shared_conversational_path.test.js
//
//  One rule under test: whether a message arrived from the website or from
//  SMS must not change Spine's property knowledge or business logic for the
//  same authorized person.
//
//  The two channels legitimately differ in one way that is NOT a divergence:
//  SMS also carries technicians, so it has a technician rail the web door
//  does not have. Work reports and change requests staying on that rail is
//  the adapter doing its job. What must never differ is where a LEASING
//  question or a LEASING action ends up.
// ════════════════════════════════════════════════════════════════════

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..", "..");

const { routeStaffSmsTurn } = require(path.join(root, "src/conversation/staff_sms_router"));
const staffLeasingIntent = require(path.join(root, "src/leasing/staff_sms_intent"));
const leasingKnowledge = require(path.join(root, "src/leasing/leasing_knowledge"));
const { resolveLeasingContext } = require(path.join(root, "src/agent/leasing_context_resolver"));

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log(`  ok    ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail !== undefined ? "  " + JSON.stringify(detail) : ""}`); }
}

/** Source with comments stripped — a mention is not a guard. */
function code(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

//  The four intents the web message door treats as actions, read out of the
//  shipped source rather than restated, so this test fails if that set moves.
const askSpineSrc = code("src/agent/ask_spine.js");
const WEB_ACTION_INTENTS = new Set(
  (askSpineSrc.match(/MESSAGE_ACTION_INTENTS = new Set\(\[([^\]]+)\]/) || [, ""])[1]
    .split(",").map(s => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean)
);

/** Where the WEB message door sends this prose. */
function webDestination(text) {
  const intent = staffLeasingIntent.readStaffLeasingIntent(text);
  return WEB_ACTION_INTENTS.has(intent.intent) ? "leasing" : "ask_spine";
}

console.log("\nSHARED CONVERSATIONAL PATH\n");

// ══════════════════════════════════════════════════════════════════
console.log("A · channel consistency — the same question reaches the same reader");
{
  ok("the web action set was read from source, not restated",
    WEB_ACTION_INTENTS.size === 4 && WEB_ACTION_INTENTS.has("send_application"),
    [...WEB_ACTION_INTENTS]);

  //  Property-knowledge questions an operator actually types. Every one of
  //  these must reach the governed read on BOTH channels.
  const knowledgeQuestions = [
    "what are the amenities",
    "whats our pet policy",
    "hows the gym",
    "is there parking",
    "what is our pet policy",
    "what are the layouts",
  ];
  for (const q of knowledgeQuestions) {
    const sms = routeStaffSmsTurn({ text: q, attachments: [] }).destination;
    const web = webDestination(q);
    ok(`both channels read: "${q}"`, sms === "ask_spine" && web === "ask_spine", { sms, web });
  }

  //  THE DEFECT THIS CLOSES. "whats our pet policy" reached the governed read
  //  on the web and fell to the technician rail over SMS, because the router
  //  asked only askSpineAnswer.questionSubject (which answers "work") and
  //  never asked the leasing knowledge registry it already imported.
  //  ⚠ THIS ASSERTION USED TO SCAN SOURCE FOR A STRING, and passed while the
  //  code it named did nothing. The registry is reached through
  //  questionSubject, which calls isKnowledgeRead on its first line — so the
  //  claim worth testing is BEHAVIOURAL: the router must send a contracted
  //  knowledge question to the read path, however it gets there.
  ok("the SMS router sends a contracted knowledge question to the read path",
    routeStaffSmsTurn({ text: "whats our pet policy", attachments: [] }).destination === "ask_spine");
  ok("and the shared subject classifier agrees, so both rails see one answer",
    require(path.join(root, "src/agent/ask_spine_answer")).questionSubject("whats our pet policy") === "leasing_knowledge");
  ok("a contracted question is recognised as a knowledge read",
    leasingKnowledge.isKnowledgeRead("whats our pet policy") === true);
  ok("the uncontracted form still is",
    leasingKnowledge.isKnowledgeRead("what is our pet policy") === true);

  //  ...and the widening did not swallow the technician rail.
  const workTurns = [
    "the dog chewed the carpet",
    "whats broken in 3B",
    "update the pet policy",
    "the gym door is jammed",
    "send the amenities list to Maria",
  ];
  for (const w of workTurns) {
    ok(`a work turn stays off the read path: "${w}"`,
      routeStaffSmsTurn({ text: w, attachments: [] }).destination !== "ask_spine",
      routeStaffSmsTurn({ text: w, attachments: [] }).destination);
  }
  ok("an attachment is always a technician turn",
    routeStaffSmsTurn({ text: "whats our pet policy", attachments: [{ url: "x" }] }).destination === "technician");
}

// ══════════════════════════════════════════════════════════════════
console.log("\nB · shared action behaviour — one writer, reached from both channels");
{
  const server = code("server.js");
  const smsAction = code("src/leasing/staff_sms_action.js");
  const governedRead = code("src/comms/staff_governed_read.js");
  const tenantLink = code("src/comms/tenant_link.js");

  ok("the web door does not own an application writer of its own",
    !/insert\s+into\s+applications/i.test(askSpineSrc) && !/sendPropertySms\(/.test(askSpineSrc));
  ok("the web door reaches the action through an injected instance",
    /conversationalApplicationAction\(\)\.run\(/.test(askSpineSrc));
  ok("server.js injects the SAME action the SMS path uses",
    /conversationalApplicationAction:\s*\(\)\s*=>\s*__staffLeasingAction/.test(server), );
  ok("both channels classify with the one leasing intent parser",
    /staff_sms_intent/.test(askSpineSrc) && /staff_sms_intent/.test(smsAction));

  //  The SAME governed read, with the SAME capabilities. An earlier shape of
  //  this gap would have been SMS quietly getting fewer options than the web.
  for (const opt of ["mintComplianceReference", "applicationsService"]) {
    ok(`the web read passes ${opt}`, new RegExp(opt).test(askSpineSrc));
    ok(`the SMS read passes ${opt}`, new RegExp(opt).test(tenantLink));
  }
  ok("the SMS adapter forwards its ask options into the shared answer service",
    /askSpineAnswer\.answer\(/.test(governedRead) && /\.\.\.askOptions/.test(governedRead));

  //  Confirmation is deliberately NOT prose on the web: the browser returns a
  //  server-issued token to a separately named door. That is a narrower
  //  surface than SMS, not a different writer.
  ok("the web confirmation door exists and is opaque",
    /application-send\/confirm/.test(askSpineSrc) && /exactBody\(req, \["confirmation"\]\)/.test(askSpineSrc));
  ok("the web confirmation door uses the same action instance",
    (askSpineSrc.match(/conversationalApplicationAction\(\)\.run\(/g) || []).length >= 2);
  ok("confirm_application is not a web prose action",
    !WEB_ACTION_INTENTS.has("confirm_application"));
}

// ══════════════════════════════════════════════════════════════════
console.log("\nC · follow-up understanding — established context, used only when it bears");
{
  //  The canonical vocabulary, CHECK-constrained in the schema.
  const recorded = {
    unit_type:  { value: "2BR",     source: "ai_conversation", recorded_at: "2026-09-16T10:00:00Z" },
    move_month: { value: "August",  source: "ai_conversation", recorded_at: "2026-09-16T10:00:00Z" },
    budget:     { value: "$2,500",  source: "ai_conversation", recorded_at: "2026-09-16T10:00:00Z" },
  };
  const sel = m => resolveLeasingContext({ message: m, propertyId: "p1", personAttributes: recorded });

  const opening = sel("I need a 2BR in August under $2,500.");
  ok("the opening turn is a governed search", opening.needsPricing && opening.needsInventory);

  const follow = sel("what about furnished?");
  ok("an elliptical follow-up carries the established context",
    ["unit_type", "move_month", "budget"].every(k => k in follow.established),
    Object.keys(follow.established));
  ok("the follow-up still reaches the amenities shelf",
    follow.factKeys.includes("amenities"), follow.factKeys);

  //  THE COUNTER-CASE THE SPEC NAMES. A stored budget must not turn an
  //  unrelated question into a pricing search.
  const unrelated = sel("how do I get a package that was delivered");
  ok("an unrelated question does not become a pricing search", unrelated.needsPricing === false);
  ok("an unrelated question does not become an inventory search", unrelated.needsInventory === false);
  ok("an unrelated question carries none of the recorded profile",
    Object.keys(unrelated.established).length === 0, unrelated.established);

  //  And the same with NOTHING recorded — the flags must be identical, which
  //  is what proves the flags come from this turn's words alone.
  const bare = resolveLeasingContext({ message: "how do I get a package that was delivered", propertyId: "p1" });
  ok("recorded facts never change the capability flags",
    bare.needsPricing === unrelated.needsPricing && bare.needsInventory === unrelated.needsInventory);

  //  Vocabulary: only the six keys the schema can hold are ever carried.
  const junk = sel2 => resolveLeasingContext({ message: "what about furnished?", propertyId: "p1", personAttributes: sel2 });
  const withJunk = junk({ budget: { value: "$2,500" }, max_rent: { value: "$9,999" }, bedrooms: { value: "9" } });
  ok("a key the schema cannot hold is ignored",
    "budget" in withJunk.established && !("max_rent" in withJunk.established) && !("bedrooms" in withJunk.established),
    Object.keys(withJunk.established));
  ok("a blank value is not a recorded preference",
    Object.keys(junk({ budget: { value: "   " } }).established).length === 0);

  //  Provenance survives, because the answer may need to say where it came from.
  ok("source and recorded_at travel with the value",
    follow.established.budget.source === "ai_conversation" && !!follow.established.budget.recorded_at);
}

// ══════════════════════════════════════════════════════════════════
console.log("\nD · isolation and honest gaps");
{
  const agentSrc = code("src/agent/agent.js");
  const inventorySrc = code("src/leasing/leasing_inventory.js");

  ok("the agent reads prospect facts through the canonical inventory read",
    /inventory\.readProspectFacts\(/.test(agentSrc));
  ok("there is no second prospect-attribute query in the agent",
    !/from\s+person_attributes/i.test(agentSrc));
  ok("the canonical read is scoped to person AND property",
    /where person_id = \$1 and status = 'active'/.test(inventorySrc)
    && /\(property_id = \$2 or property_id is null\)/.test(inventorySrc));
  ok("the read is bounded to the declared prospect keys",
    /attr_key = any\(\$3\)/.test(inventorySrc));

  //  READ_FAILED must never collapse into "they told us nothing" (§40.7).
  ok("a failed prospect read is carried as its own state",
    /established_read_failed/.test(agentSrc));
  ok("and the prompt says so rather than implying nothing was recorded",
    /could NOT be read this turn/.test(agentSrc)
    && /Do not treat that as them having told us nothing/.test(agentSrc));

  //  No invented specificity from free text.
  ok("the prompt forbids sharpening a stated month or budget",
    /a stated month is not a lease date/.test(agentSrc)
    && /Never invent a/.test(agentSrc));

  //  No cross-channel identity invention.
  ok("this slice builds no identity inference from a typed name or phone",
    !/infer.*phone|match.*by name/i.test(code("src/agent/leasing_context_resolver.js")));
}

// ══════════════════════════════════════════════════════════════════
console.log("\nE · existing protections still in place");
{
  const agentSrc = code("src/agent/agent.js");
  ok("economic sources are still exempt from narrowing",
    /isEconomic\(f\)\s*\|\|\s*leasingContextResolver\.selects\(/.test(agentSrc));
  ok("the stale-check call sites still read live and unnarrowed",
    (agentSrc.match(/resolveContext\(client, \{ property_id: conv\.property_id \}\)/g) || []).length >= 1);
  ok("no migration was added by this work",
    !fs.existsSync(path.join(root, "migrations/200_shared_conversational_path.sql")));
}

// ══════════════════════════════════════════════════════════════════
console.log("\nF · vocabulary drift guards — so a guessed name cannot ship again");
{
  //  The defect this makes unrepeatable: nine attribute names were guessed
  //  from an example prompt and eight matched nothing. A name that does not
  //  exist fails SILENTLY — the prospect simply appears to have said nothing.
  //  These read the schema and the governed write list and compare.
  const resolverMod = require(path.join(root, "src/agent/leasing_context_resolver"));
  const migration = fs.readFileSync(path.join(root, "migrations/061_person_attributes.sql"), "utf8");
  const check = (migration.match(/attr_key\s+text\s+not null\s+check\s*\(attr_key in\s*\(([^)]*)\)/i) || [])[1];
  const schemaKeys = (check || "").split(",").map(x => x.trim().replace(/^'|'$/g, "")).filter(Boolean).sort();

  ok("the migration's CHECK was actually parsed", schemaKeys.length === 6, schemaKeys);
  ok("ATTR_KEYS matches the schema exactly, in both directions",
    JSON.stringify([...resolverMod.ATTR_KEYS].sort()) === JSON.stringify(schemaKeys),
    { declared: [...resolverMod.ATTR_KEYS].sort(), schema: schemaKeys });

  //  The canonical reader must not ask for a key the column cannot hold.
  const inventory = require(path.join(root, "src/leasing/leasing_inventory"))({ pool: { query: async () => ({ rows: [] }) } });
  ok("the canonical prospect read stays inside the schema vocabulary",
    inventory.PROSPECT_FACT_KEYS.every(k => schemaKeys.includes(k)),
    inventory.PROSPECT_FACT_KEYS);

  //  Every fact key the intent table names must be one an operator can
  //  actually write, or be declared legacy on purpose.
  const operatorSrc = code("src/identity/operator.js");
  const writable = new Set([
    ...((operatorSrc.match(/const FACT_KEYS = \[([^\]]+)\]/) || [, ""])[1]
      .split(",").map(x => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean)),
    ...Object.keys(leasingKnowledge.TOPICS),
  ]);
  ok("the governed write vocabulary was parsed", writable.size >= 17, writable.size);

  const named = new Set();
  for (const spec of resolverMod.INTENTS) for (const k of spec.factKeys) named.add(k);
  const orphans = [...named].filter(k => !writable.has(k) && !resolverMod.LEGACY_FACT_KEYS.includes(k));
  ok("every fact key the resolver names is writable or declared legacy", orphans.length === 0, orphans);

  const staleLegacy = resolverMod.LEGACY_FACT_KEYS.filter(k => !named.has(k));
  ok("no legacy declaration outlives the key that needed it", staleLegacy.length === 0, staleLegacy);

  //  And the categories it filters on must be ones the writer assigns.
  const categories = new Set();
  for (const spec of resolverMod.INTENTS) for (const c of spec.categories) categories.add(c);
  const knownCategories = new Set(["pets", "parking", "tours", "fees", "documents", "routing", "leasing_knowledge", "pricing"]);
  ok("every category the resolver filters on is one the writer assigns",
    [...categories].every(c => knownCategories.has(c)), [...categories]);
}

// ══════════════════════════════════════════════════════════════════
console.log("\nG · the contraction fix has a way back that needs no build");
{
  //  isSelfRead reaches further than it looks: it feeds isKnowledgeRead,
  //  which feeds questionSubject, which routes EVERY governed read on both
  //  rails. A predicate with that reach needs a switch, like the resolver's.
  const reload = (value) => {
    delete require.cache[require.resolve(path.join(root, "src/leasing/leasing_knowledge"))];
    if (value === null) delete process.env.LEASING_KNOWLEDGE_CONTRACTIONS;
    else process.env.LEASING_KNOWLEDGE_CONTRACTIONS = value;
    return require(path.join(root, "src/leasing/leasing_knowledge"));
  };
  ok("unset, contractions are recognised", reload(null).isKnowledgeRead("whats our pet policy") === true);
  ok("off, the pre-fix behaviour returns", reload("off").isKnowledgeRead("whats our pet policy") === false);
  ok("off does not break the uncontracted form", reload("off").isKnowledgeRead("what is our pet policy") === true);
  for (const v of ["OFF", " off "]) {
    ok(`the switch is tolerant of ${JSON.stringify(v)}`, reload(v).isKnowledgeRead("hows the gym") === false);
  }
  for (const v of ["on", "", "true"]) {
    ok(`only "off" disables it, not ${JSON.stringify(v)}`, reload(v).isKnowledgeRead("hows the gym") === true);
  }
  reload(null);
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
