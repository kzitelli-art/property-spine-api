/* ════════════════════════════════════════════════════════════════════
   gate_ask_spine_readers.js — EVERY GOVERNED DOMAIN THAT REACHES A
   STANDING STATE MUST BE READABLE BY ASK SPINE, OR CARRY AN EXPLICIT
   WAIVER SAYING WHY NOT.

   PHILOSOPHY.md §40.2 makes conversational readability part of a
   domain's Definition of Done, and §40.11 says why that rule cannot be
   left to a document:

       A rule of this shape is exactly what gets quietly dropped under
       schedule pressure.

   A developer can build Debt perfectly against every other rule in
   CLAUDE.md, browser-verify the Debt screen, and legitimately call it
   done — while Debt remains unreachable to anyone who asks for it. This
   gate exists so that outcome goes red instead of shipping.

   ── DISCOVERY, NOT A HAND-MAINTAINED LIST ───────────────────────────
   The domains are DISCOVERED from their canonical standing reads on
   disk, never enumerated by hand. That direction is the whole point.

       a hand-maintained list only knows what someone REMEMBERED to add,
       which is precisely the omission this gate exists to detect

   So `debt_position_read.js` landing on disk registers Debt as a domain
   whether or not anybody updated this file, and an unclassified domain
   fails assertion 1 by existing.

   ── WHAT IS ASSERTED ────────────────────────────────────────────────
   1  Every discovered domain appears in REGISTRY with a state. A new
      domain with no declaration is a FAILURE, not a default.
   2  Every domain declared `registered` is actually gathered by
      `ask_spine_answer.js`. A declaration is not an implementation, and
      a registry that can lie is worse than no registry (§40.11).
   3  Every domain declared `pending` names an owner and the condition
      that clears it. "Pending" with no condition is how a waiver becomes
      permanent — §18 already refuses this for temporary components and
      the same refusal applies here.
   4  `waived` requires a reason. It is deliberately harder to type than
      `pending`.

   ── IT TESTS ITS OWN DETECTORS, EVERY RUN ───────────────────────────
   Same discipline as gate_funding_boundary.js: every analyser is a pure
   function of file text, and is fed known-good and known-bad input
   before it is pointed at a real file. A gate that under-detects
   launders the gap into evidence.

   ── IT REPORTS ITS OWN COVERAGE ─────────────────────────────────────
   Zero registered domains is the HONEST state today, and this gate says
   so out loud rather than passing quietly. "0 registered, 2 pending" is
   a statement about scope, not a clean bill of health, and it must never
   read as one.

   CLASS 3 — test / governance infrastructure. Outside the signed-in
   operator workflow. Removal condition: none. It is permanent for as
   long as §40.2 is doctrine.

   Run:  node tests/gates/gate_ask_spine_readers.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const readerCapabilities = require("../../src/shared/reader_capability_contract.js");
const ROOT = path.join(__dirname, "..", "..");

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? "\n          " + detail : "")); }
}

function readIf(rel) {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
}

/*  ══ WHERE STANDING TRUTH LIVES ════════════════════════════════════
 *  A domain becomes conversationally eligible when it grows a canonical
 *  standing read. The repo uses position, establishment and direct read
 *  suffixes for that. Document adapters and funding-chain reads are
 *  explicitly excluded because neither is domain standing.
 *
 *  Funding reads are deliberately NOT in this list. `tax_funding_read.js`
 *  is the same DOMAIN reached through its other chain, not a second
 *  domain, and counting it would report a coverage number twice the
 *  real one. The funding boundary itself is gate_funding_boundary.js.
 *
 *  ── THIS LIST WAS WRONG, AND THE GATE WENT GREEN ANYWAY ────────────
 *  It read ["src/asset"] alone, which quietly meant "Asset Management
 *  domains" while the header claimed EVERY governed domain. Tenancy —
 *  the oldest governed domain in the repo, and the one behind the Rent
 *  Roll — was not merely unregistered, it was UNDISCOVERABLE, so §40.2
 *  could never go red for it. A gate that scans less than it asserts
 *  launders the gap into evidence (CLAUDE.md), and this one did: seven
 *  domains and exit 0 read as coverage of the governed set.
 *
 *  Any directory that OWNS canonical domain truth belongs here. When the
 *  next one lands, add it in the same breath as the read.                */
const STANDING_READ_DIRS = ["src/asset", "src/tenancy"];
const STANDING_READ_SUFFIXES = ["_position_read.js", "_establishment.js", "_read.js"];
const NON_STANDING_READ_SUFFIXES = ["_document_read.js", "_funding_read.js"];

/*  ══ WHAT IS DELIBERATELY NOT A DOMAIN ══════════════════════════════
 *  `src/surfaces` is full of files that would match every suffix above —
 *  availability_read.js, management_read.js, unit_turn_read.js,
 *  work_order_status_read.js — and not one of them is a domain. They are
 *  PROJECTIONS of domains: a surface composing canonical reads for one
 *  screen. Discovering them would invent four domains that own no truth,
 *  demand four registry entries, and inflate the coverage number with
 *  things that cannot be "registered" because there is nothing behind
 *  them to register.
 *
 *  Excluding a directory silently is how a gate's scope shrinks without
 *  anyone deciding to shrink it. So the exclusion is DECLARED, carries a
 *  reason, and is asserted below to still be load-bearing — if a listed
 *  directory stops producing would-be domains, the exclusion is stale
 *  debt and the gate says so rather than keeping a dead rule.            */
const NOT_DOMAINS = Object.freeze([
  { dir: "src/surfaces",
    reason: "Projections OF domains, not domains. A surface composes canonical " +
            "reads for one screen and owns no truth of its own, so there is " +
            "nothing behind it for Ask Spine to register." },
]);

function domainsFromFilenames(filenames) {
  const found = new Set();
  for (const f of filenames) {
    if (NON_STANDING_READ_SUFFIXES.some((suffix) => f.endsWith(suffix))) continue;
    for (const suffix of STANDING_READ_SUFFIXES) {
      if (f.endsWith(suffix)) {
        found.add(f.slice(0, -suffix.length));
        break;
      }
    }
  }
  return [...found].sort();
}

/*  ══ THE REGISTRY ═══════════════════════════════════════════════════
 *  Every discovered domain must appear here. Three states:
 *
 *    registered  Ask Spine gathers its standing projection today.
 *                Asserted against ask_spine_answer.js — declaring it
 *                does not make it true.
 *    pending     Eligible, not yet wired. Requires `owner` and `clears`.
 *    waived      Deliberately not conversational. Requires `reason`.
 *
 *  Compliance, Utilities, Contracted Services, Debt, and Equity are registered
 *  through governed readers. Insurance and Tax remain pending until their
 *  domain-specific conversational truth walls are built and proven. Cross-domain
 *  composition authorization remains unsolved for every registered domain and
 *  is enforced by the composer rather than used to block single-domain reads.
 *  A green gate reports this split; it does not erase it.  */
const REGISTRY = {
  compliance: {
    state: "registered",
    capability_classes: readerCapabilities.retrievalOnly(
      "canonical Compliance standing and recorded derivation basis"),
    composition_authorization: "unsolved_cross_domain",
  },
  utility: {
    state: "registered",
    capability_classes: readerCapabilities.retrievalOnly(
      "canonical Utility standing and recorded derivation basis"),
    composition_authorization: "unsolved_cross_domain",
    governed_detail: true,
  },
  contracted_service: {
    state: "registered",
    capability_classes: readerCapabilities.retrievalOnly(
      "canonical Contracted Services standing, evidence, and recorded derivation basis"),
    composition_authorization: "unsolved_cross_domain",
    governed_detail: true,
  },
  insurance: {
    state: "pending",
    owner: "asset management",
    capability_classes: readerCapabilities.retrievalOnly(
      "canonical insurance standing and recorded derivation basis"),
    composition_authorization: "unsolved_cross_domain",
    clears: "Ask Spine gathers the insurance standing projection — coverage " +
            "standing, annual cost, renewal, funding mechanism, known gaps — " +
            "with the §40.5 walls preserved (financed ≠ paid, payment ≠ coverage), " +
            "after §40.8 cross-domain composition authorization is governed.",
  },
  tax: {
    state: "pending",
    owner: "asset management",
    capability_classes: readerCapabilities.retrievalOnly(
      "canonical tax standing and recorded derivation basis"),
    composition_authorization: "unsolved_cross_domain",
    clears: "Ask Spine gathers the tax standing projection — obligation set, " +
            "amounts, next milestone, filing and payment standing — with the " +
            "§40.5 walls preserved (escrow funded ≠ City paid, filed ≠ paid), " +
            "after §40.8 cross-domain composition authorization is governed.",
  },
  //  ⚠ DEBT DECLARED ITSELF. Nobody remembered to add this — the gate went
  //  red the moment debt_position_read.js landed, which is the entire point
  //  of discovering domains from disk rather than from a list. The rule
  //  worked before anyone had to obey it.
  //
  //  Debt now gathers the same loadHistory() + position() +
  //  standingProjection() pipe as the Capital Stack screen. The compact
  //  projection preserves W1-W9 and entitlement is checked before the read.
  //  Cross-domain composition remains unavailable, exactly as it does for
  //  every other registered domain.
  debt: {
    state: "registered",
    //  Matches docs/archive/DEBT_READ_CONTRACT_AND_SCHEMA.md and the header of
    //  debt_routes.js exactly: retrieval claimed, comparison and causal
    //  explanation explicitly not — a portfolio comparison needs a basis
    //  (per unit, per SF, per dollar of value) that is a model nobody
    //  recorded, and §38 forbids rendering it as a recorded fact.
    capability_classes: readerCapabilities.retrievalOnly(
      "canonical Debt standing — position(instrument, as_of) over governed history"),
    composition_authorization: "unsolved_cross_domain",
  },
  //  ⚠ EQUITY IS NOW REGISTERED. The canonical read, the route, and the
  //  Capital Stack UI (split into Preferred Equity / Common Equity
  //  compartments) are live; Ask Spine gathers the SAME
  //  loadHistory()/position()/standingProjection() call — see
  //  src/agent/ask_spine_answer.js's "equity" subject. No new reader was
  //  built for this; "one conversational architecture" (CLAUDE.md) means
  //  Ask Spine is the same governed pipe the screen uses, never a second
  //  one. Composition authorization is still unsolved cross-domain, same
  //  as every other registered domain.
  equity: {
    state: "registered",
    //  Matches docs/EQUITY_READ_CONTRACT_AND_SCHEMA.md: retrieval
    //  claimed narrowly, comparison and causal explanation explicitly
    //  not. Equity claims LESS than Debt did at the same build stage on
    //  purpose — the specimen property itself shows a well-governed
    //  preferred position beside a common tier with no named holder at
    //  the next tier up, and claiming broad retrieval would
    //  misrepresent that.
    capability_classes: readerCapabilities.retrievalOnly(
      "canonical Equity standing — position(property, as_of) over governed history, " +
      "including derived coverage gaps and open conflicts, never a synthesized cap table"),
    composition_authorization: "unsolved_cross_domain",
  },
  //  ⚠ TENANCY WAS INVISIBLE TO THIS GATE UNTIL THE SCAN DIRS WERE FIXED.
  //  It is the oldest governed domain here and the one the Rent Roll renders,
  //  and it sat outside §40.2 enforcement entirely — not declared pending,
  //  not waived, simply unseen. That is the failure mode this gate exists to
  //  prevent, and it happened to the gate itself.
  //
  //  Registered, not pending: readTenancyStanding calls datedPropertyPositions
  //  — the SAME canonical service the Rent Roll screen reads. No second
  //  occupancy reader was built for Ask Spine, which is what "one
  //  conversational architecture" means in practice.
  tenancy: {
    state: "registered",
    //  Matches src/tenancy/tenancy_position_read.js exactly. Retrieval only:
    //  comparison needs a basis (per bed, per season, against what) that is a
    //  model nobody recorded, and causal explanation needs linkage between a
    //  turn, a notice and a vacancy that tenancy does not record. Neither may
    //  be implicitly promised because occupancy sounds comparable.
    capability_classes: readerCapabilities.retrievalOnly(
      "canonical tenancy standing — dated rentable positions, occupancy, known forward " +
      "commitments, and the opening source they were established from"),
    composition_authorization: "unsolved_cross_domain",
  },
};

/*  ══ IS A DOMAIN ACTUALLY GATHERED? ═════════════════════════════════
 *  Text analysis of the composer's gather stage. Deliberately crude and
 *  deliberately comment-blind: prose must not be able to satisfy this.
 *  A domain counts as gathered when the gather source both REQUIRES a
 *  module carrying the domain name and assigns a fact key for it —
 *  either alone is too weak. Requiring without assigning is a dead
 *  import; assigning without requiring is a literal.                   */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/*  ⚠ THE KEY MUST BE THE DOMAIN'S OWN, EXACTLY.
 *
 *  This read `facts\.${domain}\w*\s*=` and the trailing `\w*` was not
 *  serving anything — every domain in the composer assigns its bare name
 *  — while it quietly accepted any key STARTING with the domain name as
 *  proof of a gather. tests/scenarios/ask_spine_reader_gate_falsification.js found
 *  it by renaming `facts.tenancy` to `facts.tenancy_unwired`: the gather
 *  was gone, the facts never reached the model, and this gate stayed
 *  green. A detector that accepts a lookalike is a detector that cannot
 *  fail, which is the shape of every under-detecting gate in CLAUDE.md.
 *
 *  Anchored on both ends now. A domain that genuinely needs a suffixed
 *  key is a convention change to make deliberately, in this function,
 *  not something a rename gets to do by accident.                       */
function gathersDomain(gatherSrc, domain) {
  const code = stripComments(gatherSrc);
  const required = new RegExp(`require\\([^)]*${domain}[^)]*\\)`).test(code);
  const assigned = new RegExp(`facts\\.${domain}\\s*=`).test(code);
  return required && assigned;
}

function gathersGovernedDetail(gatherSrc, domain) {
  const code = stripComments(gatherSrc);
  const required = new RegExp(`require\\([^)]*${domain}[^)]*\\)`).test(code);
  const invoked = /\.readForQuestion\s*\(/.test(code);
  const questionBound = /readForQuestion\s*\([^)]*\{[\s\S]*?question[\s\S]*?\}\s*\)/.test(code);
  return required && invoked && questionBound;
}

console.log("\n════════════════════════════════════════════════════════════════");
console.log("  ASK SPINE READER REGISTRATION — §40.2 / §40.11");
console.log("════════════════════════════════════════════════════════════════\n");

/*  ── 0. THE DETECTORS ARE TESTED BEFORE THEY ARE TRUSTED ──────────── */
console.log("  ── detector self-test ──");
{
  ok("domainsFromFilenames finds a position read",
     domainsFromFilenames(["debt_position_read.js"]).join() === "debt");
  ok("domainsFromFilenames finds an establishment read",
     domainsFromFilenames(["tax_establishment.js"]).join() === "tax");
  ok("domainsFromFilenames dedupes a domain with both reads",
     domainsFromFilenames(["tax_position_read.js", "tax_establishment.js"]).join() === "tax");
  ok("domainsFromFilenames ignores a funding read",
     domainsFromFilenames(["tax_funding_read.js"]).length === 0);
  ok("domainsFromFilenames finds a direct canonical read",
     domainsFromFilenames(["compliance_read.js"]).join() === "compliance");
  ok("domainsFromFilenames ignores a document adapter",
     domainsFromFilenames(["compliance_document_read.js"]).length === 0);
  ok("domainsFromFilenames ignores an unrelated file",
     domainsFromFilenames(["philadelphia_tax_rules.js"]).length === 0);
  //  THE EXCLUSION IS DOING REAL WORK, AND THIS PROVES IT. A surface file
  //  is indistinguishable from a domain read BY NAME — the suffix matcher
  //  happily turns availability_read.js into a domain called
  //  "availability". Only the directory list keeps it out, which is
  //  exactly why that list is declared rather than assumed.
  ok("domainsFromFilenames CANNOT tell a surface projection from a domain read",
     domainsFromFilenames(["availability_read.js", "work_order_status_read.js"]).join() ===
       "availability,work_order_status");

  ok("gathersDomain detects a real gather",
     gathersDomain(`const r = require("../asset/debt_position_read.js"); facts.debt = r.read();`, "debt"));
  ok("gathersDomain rejects a require with no assignment",
     !gathersDomain(`const r = require("../asset/debt_position_read.js");`, "debt"));
  ok("gathersDomain rejects an assignment with no require",
     !gathersDomain(`facts.debt = {};`, "debt"));
  //  THE ONE THE FALSIFICATION HARNESS CAUGHT. A key that merely starts
  //  with the domain name is a different key, and the facts under it
  //  never reach the model under the name the prompt rules use.
  ok("gathersDomain rejects a LOOKALIKE fact key",
     !gathersDomain(`const r = require("../asset/debt_position_read.js"); facts.debt_unwired = r.read();`,
                    "debt"));
  //  THE ONE THAT MATTERS. A comment promising the work is not the work.
  ok("gathersDomain is not satisfied by a comment",
     !gathersDomain(`// TODO: require debt_position_read and set facts.debt = ...`, "debt"));
  ok("gathersDomain is not satisfied by a block comment",
     !gathersDomain(`/* facts.debt = require("../asset/debt_position_read.js") */`, "debt"));
  ok("gathersGovernedDetail detects a question-bound canonical detail read",
     gathersGovernedDetail(
       `const r=require("../asset/utility_ask_detail.js"); r.readForQuestion(db,{question});`,
       "utility"));
  ok("gathersGovernedDetail rejects a detail reader mentioned only in a comment",
     !gathersGovernedDetail(
       `const r=require("../asset/utility_ask_detail.js"); // r.readForQuestion(db,{question})`,
       "utility"));
}

/*  ── 1. DISCOVER, THEN DEMAND A DECLARATION ───────────────────────── */
console.log("\n  ── discovery ──");
const discovered = [];
for (const dir of STANDING_READ_DIRS) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) {
    ok(`${dir} is present`, false, "standing-read directory is missing");
    continue;
  }
  discovered.push(...domainsFromFilenames(fs.readdirSync(abs)));
}
const domains = [...new Set(discovered)].sort();
console.log(`        ${domains.length} domain(s) with a canonical standing read: ` +
            (domains.join(", ") || "none"));

/*  ── THE EXCLUSIONS ARE A DECISION, NOT AN OVERSIGHT ──────────────── */
console.log("\n  ── directories deliberately NOT scanned ──");
for (const x of NOT_DOMAINS) {
  const abs = path.join(ROOT, x.dir);
  console.log(`        ${x.dir} — ${x.reason}`);
  ok(`${x.dir} exclusion names a reason`, !!(x.reason && x.reason.trim().length > 20));
  ok(`${x.dir} is not also scanned as a domain directory`,
     !STANDING_READ_DIRS.includes(x.dir),
     "a directory cannot be both a source of domains and excluded from being one");
  if (!fs.existsSync(abs)) {
    ok(`${x.dir} exists`, false,
       "the exclusion points at a directory that is gone — delete it, or the gate " +
       "is carrying a rule about nothing");
    continue;
  }
  //  A STALE EXCLUSION IS DEBT, SAME AS A STALE REGISTRY ENTRY. If this
  //  directory stopped producing would-be domains, the exclusion is no
  //  longer keeping anything out and should be removed rather than left
  //  as a rule nobody can evaluate.
  const wouldHaveMatched = domainsFromFilenames(fs.readdirSync(abs));
  ok(`${x.dir} exclusion is still load-bearing`, wouldHaveMatched.length > 0,
     `nothing in ${x.dir} would be discovered as a domain any more — the exclusion ` +
     `no longer excludes anything. Remove it from NOT_DOMAINS.`);
  console.log(`           keeps ${wouldHaveMatched.length} non-domain(s) out: ` +
              wouldHaveMatched.join(", "));
  //  And it must be keeping out things that are NOT real domains. If a
  //  genuine domain ever moved into a surfaces directory, this exclusion
  //  would hide it from §40.2 — the exact laundering this gate refuses.
  const hidden = wouldHaveMatched.filter((d) => Object.prototype.hasOwnProperty.call(REGISTRY, d));
  ok(`${x.dir} does not hide a declared domain`, hidden.length === 0,
     `${hidden.join(", ")} is declared in the registry AND lives in an excluded ` +
     `directory. Either it is a domain and the directory is wrong, or it is a ` +
     `projection and the registry is wrong. It cannot be both.`);
}

for (const d of domains) {
  ok(`${d} is declared in the Ask Spine registry`,
     Object.prototype.hasOwnProperty.call(REGISTRY, d),
     `${d} grew a canonical standing read and was never classified. ` +
     `Per §40.2 it is not done. Declare it registered, pending or waived.`);
}

/*  Registry entries for domains that no longer exist are stale, and a
 *  stale entry is how a registry starts describing a repo that is not
 *  there any more.                                                     */
for (const d of Object.keys(REGISTRY)) {
  ok(`registry entry ${d} corresponds to a real standing read`,
     domains.includes(d),
     `${d} is declared but has no *_position_read.js or *_establishment.js`);
}

/*  ── 2. A DECLARATION IS NOT AN IMPLEMENTATION ────────────────────── */
console.log("\n  ── declared `registered` must actually be wired ──");
const GATHER = "src/agent/ask_spine_answer.js";
const gatherSrc = readIf(GATHER);
if (gatherSrc === null) {
  ok(`${GATHER} is present`, false, "the Ask Spine composer is missing");
} else {
  const registered = Object.entries(REGISTRY).filter(([, v]) => v.state === "registered");
  if (!registered.length) {
    console.log("        none declared registered — nothing to verify here");
  }
  for (const [d] of registered) {
    ok(`${d} declared registered AND gathered in ${GATHER}`,
       gathersDomain(gatherSrc, d),
       `${d} claims registration the composer does not implement`);
  }
  for (const [d, declaration] of registered.filter(([, v]) => v.governed_detail)) {
    ok(`${d} declared governed detail AND question-bound in ${GATHER}`,
       gathersGovernedDetail(gatherSrc, d),
       `${d} claims governed detail but the composer does not invoke its question-bound reader`);
  }
}

/*  ── 3. PENDING AND WAIVED MUST CARRY THEIR TERMS ─────────────────── */
console.log("\n  ── waivers must name an owner and an exit ──");
for (const [d, v] of Object.entries(REGISTRY)) {
  ok(`${d} has a valid state`,
     ["registered", "pending", "waived"].includes(v.state), `state=${v.state}`);
  if (v.state === "registered" || v.state === "pending") {
    let capabilityValid = true;
    try { readerCapabilities.validate(v.capability_classes, `${d}.capability_classes`); }
    catch (_) { capabilityValid = false; }
    ok(`${d} declares retrieval without claiming comparison or cause`,
       capabilityValid && v.capability_classes.retrieval.claim === "claimed"
       && v.capability_classes.comparison.claim === "not_claimed"
       && v.capability_classes.causal_explanation.claim === "not_claimed");
    ok(`${d} records cross-domain composition authorization as unsolved`,
       v.composition_authorization === "unsolved_cross_domain");
  }
  if (v.state === "pending") {
    ok(`${d} pending names an owner`, !!(v.owner && v.owner.trim()));
    ok(`${d} pending names the condition that clears it`,
       !!(v.clears && v.clears.trim().length > 20),
       "convenience is not a replacement condition (§18)");
  }
  if (v.state === "waived") {
    ok(`${d} waived names a reason`,
       !!(v.reason && v.reason.trim().length > 20));
  }
}

/*  ── COVERAGE, SAID OUT LOUD ──────────────────────────────────────── */
const counts = { registered: 0, pending: 0, waived: 0 };
for (const v of Object.values(REGISTRY)) if (counts[v.state] !== undefined) counts[v.state]++;

console.log("\n════════════════════════════════════════════════════════════════");
console.log("  COVERAGE — NOT A PASS/FAIL NUMBER, A SCOPE STATEMENT");
console.log(`    domains with a canonical standing read   ${domains.length}`);
console.log(`    registered with Ask Spine                ${counts.registered}`);
console.log(`    pending                                  ${counts.pending}`);
console.log(`    waived                                   ${counts.waived}`);
if (counts.registered === 0 && domains.length > 0) {
  console.log("\n    ⚠ ZERO domains are conversationally readable. Every governed");
  console.log("      domain below is browser-verified as a SCREEN and not done as");
  console.log("      a DOMAIN (§40.2). This gate passing means the gap is DECLARED,");
  console.log("      not closed. Do not cite this exit code as coverage.");
}

console.log("\n════════════════════════════════════════════════════════════════");
console.log(`  ASSERTIONS COMPLETE · ${pass + fail} run · ${pass} passed · ${fail} failed`);
if (fail) {
  console.log("  ✗ FAIL — a governed domain is unreachable to Ask Spine and undeclared.");
  console.log("  EXIT      1");
  console.log("════════════════════════════════════════════════════════════════");
  process.exit(1);
}
console.log("  ✓ PASS — every domain with standing truth is classified.");
console.log("  EXIT      0");
console.log("════════════════════════════════════════════════════════════════");
