// ════════════════════════════════════════════════════════════════════
//  conversation_clarification_and_receipt.test.js — DB-FREE.
//
//  Phase 1, seams two and three: the clarification/confirmation ladder and
//  receipt composition, extracted out of src/comms/tenant_link.js into
//  src/conversation/clarification.js and src/conversation/receipt.js.
//
//  ── THE ASSERTION THIS HARNESS EXISTS FOR ───────────────────────────
//
//  A successful operating action does not prove a text was delivered. A
//  provider sid does not prove the operating action occurred. Section 10
//  proves those two facts cannot be collapsed — not by convention, but
//  because there is no field in which to collapse them and the object is
//  frozen against acquiring one.
//
//  ── WHAT IT CANNOT PROVE ────────────────────────────────────────────
//
//  IT DOES NOT REPLACE THE RESIDENT SMS PROOFS. resident_sms_work_order_proof.js
//  and resident_sms_route_proof.js build no schema of their own, need a
//  provisioned full-schema database this session does not have, and remain
//  REQUIRED before this merges — docs/UNBLOCK_2_FULL_SCHEMA_HARNESS_DATABASE.md.
//  Wording identity plus exhaustive branch coverage is strong evidence about
//  the composed text; it is not evidence that the route still runs.
//
//  ── THE TRAP THIS HARNESS WAS BUILT AGAINST ─────────────────────────
//
//  A source prohibition that greps a file will happily match the file's own
//  header comment saying it does not do the thing. Both the isolation gate
//  and the intent-extraction harness were fooled by exactly that. Every
//  source assertion below runs against COMMENT-STRIPPED source.
//
//  A check that cannot run is reported as NOT PROVEN and counted separately.
//  It is never reported as ok — an unavailable check is not a passing one.
// ════════════════════════════════════════════════════════════════════
"use strict";
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const receipt = require("../_run_receipt");

const HARNESS = __filename;
const EXPECTED = 150;
let passed = 0, failed = 0, notProven = 0;
const ok = (label, cond, detail) => {
  if (cond) { passed++; console.log("  ok    " + label); }
  else { failed++; console.log("  FAIL  " + label + (detail ? "  →  " + detail : "")); }
};
//  Neither pass nor fail. Loud, counted, and printed in the summary so the
//  run cannot be read as clean.
const unproven = (label, why) => { notProven++; console.log("  ????  NOT PROVEN  " + label + "  →  " + why); };
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 56 - t.length))}`);
const throws = (fn, code) => {
  try { fn(); return false; } catch (e) { return code ? e.code === code : true; }
};

const clar = require("../../src/conversation/clarification");
const rcpt = require("../../src/conversation/receipt");

const ROOT = path.join(__dirname, "..", "..");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const CLAR_SRC = read("src/conversation/clarification.js");
const RCPT_SRC = read("src/conversation/receipt.js");
const TL_SRC = read("src/comms/tenant_link.js");
const CLAR_CODE = strip(CLAR_SRC), RCPT_CODE = strip(RCPT_SRC), TL_CODE = strip(TL_SRC);

//  The revision this work was extracted FROM. Pinned, not HEAD~1: this branch
//  will grow more commits and the baseline must not drift with it.
const PRE_EXTRACTION_SHA = "bf84eb4";

// ── FIXTURES ────────────────────────────────────────────────────────
const PROP = "11111111-1111-1111-1111-111111111111";
const OTHER_PROP = "22222222-2222-2222-2222-222222222222";
const WO = "33333333-3333-3333-3333-333333333333";
const openRow = (over = {}) => Object.assign({
  obligation_id: "ob-1", work_order_id: WO, property_id: PROP,
  question_event_id: "ce-1", question_body: "Is water actively leaking right now, or is it a slow drip?",
}, over);
const ctx = { unitLabel: "Unit 4B" };
const woRow = (over = {}) => Object.assign({
  id: WO, urgency_status: "regular", field_category: "plumbing",
}, over);

//  THE FROZEN WORDING TABLE. Every resident-facing sentence the conversational
//  path can produce, as it stood before the extraction. Section 1 proves the
//  composer still emits exactly these, and that these are not invented here —
//  each one is cross-checked against the pre-extraction source.
const WORDING = {
  hold_ambiguous_open_set:
    "Thanks — you have more than one open request with us, so I'm passing this to the team to make sure it lands on the right one.",
  hold_unrecognized_answer:  "Got it — your manager will follow up with you right here.",
  hold_answer_to_resolved:   "Thanks — your manager will follow up with you right here.",
  append_escalated:
    "Thank you — I've marked this as an emergency and management has been notified in the system. If there is immediate danger to anyone, call 911 first.",
  append_resolved_regular:
    "Thanks — that helps. Your Unit 4B request is recorded as a routine repair and stays open with the team.",
  append_unresolved:         "Thanks — I've added that to your request. Your manager will follow up here.",
  opened_emergency:
    "Emergency received — management has been notified in the system. If there is immediate danger to anyone, call 911 first.",
  opened_needs_confirmation: "Got it — I've opened a request for Unit 4B. Is it actively flooding right now?",
  opened_regular:            "Got it — plumbing request opened for Unit 4B. We'll keep you updated right here.",
  balance_missing:           "Your balance isn't loaded in the system yet — your manager will confirm it here.",
  balance_paid_up:           "You're all paid up — current balance $0.00. Rent is $1450.00/month.",
  balance_owed:              "Your current balance is $250.00.",
};

receipt.begin(HARNESS, { expected: EXPECTED });

let code = 1;
try {

// ════════════════════════════════════════════════════════════════════
section("1. RESIDENT WORDING — UNCHANGED BY THE EXTRACTION");
// ════════════════════════════════════════════════════════════════════
{
  const op = (outcome, result) => rcpt.operatingReceipt({ outcome, result, context: ctx }).text;

  ok("hold · ambiguous open set",
    op("held_for_human", { reasonCode: "ambiguous_open_set" }) === WORDING.hold_ambiguous_open_set);
  ok("hold · unrecognized answer",
    op("held_for_human", { reasonCode: "unrecognized_answer" }) === WORDING.hold_unrecognized_answer);
  ok("hold · not actionable — same wording as an unrecognized answer",
    op("held_for_human", { reasonCode: "not_actionable" }) === WORDING.hold_unrecognized_answer);
  ok("hold · answer to a question already resolved — DIFFERENT opening word, preserved",
    op("held_for_human", { reasonCode: "answer_to_resolved" }) === WORDING.hold_answer_to_resolved);
  ok("the two hold wordings are genuinely different (a copy-paste would pass everything above)",
    WORDING.hold_unrecognized_answer !== WORDING.hold_answer_to_resolved);

  ok("append · escalated to emergency",
    op("clarification_appended", { workOrder: woRow(), outcome: "escalated_emergency" }) === WORDING.append_escalated);
  ok("append · resolved as regular (carries the unit label)",
    op("clarification_appended", { workOrder: woRow(), outcome: "resolved_regular" }) === WORDING.append_resolved_regular);
  ok("append · unresolved",
    op("clarification_appended", { workOrder: woRow(), outcome: "unresolved" }) === WORDING.append_unresolved);
  ok("append · already emergency falls to the same neutral wording",
    op("clarification_appended", { workOrder: woRow(), outcome: "already_emergency" }) === WORDING.append_unresolved);

  const dec = (over) => Object.assign({ urgency_status: "regular", emergency_type: null,
    clarifying_question: null, requiresConfirmation: false, basis: "b" }, over);
  ok("opened · emergency",
    op("work_order_opened", { workOrder: woRow({ urgency_status: "emergency" }),
      decision: dec({ urgency_status: "emergency", emergency_type: "active_leak" }) }) === WORDING.opened_emergency);
  ok("opened · needs confirmation (carries the governed question verbatim)",
    op("work_order_opened", { workOrder: woRow({ urgency_status: "needs_confirmation" }),
      decision: dec({ urgency_status: "needs_confirmation", clarifying_question: "Is it actively flooding right now?" }) })
      === WORDING.opened_needs_confirmation);
  ok("opened · regular (category read BACK from the committed row)",
    op("work_order_opened", { workOrder: woRow(), decision: dec() }) === WORDING.opened_regular);
  ok("opened · underscore category becomes a slash, exactly once",
    op("work_order_opened", { workOrder: woRow({ field_category: "heat_ac" }), decision: dec() })
      === "Got it — heat/ac request opened for Unit 4B. We'll keep you updated right here.");
  ok("opened · missing category falls back to 'maintenance'",
    op("work_order_opened", { workOrder: woRow({ field_category: null }), decision: dec() })
      === "Got it — maintenance request opened for Unit 4B. We'll keep you updated right here.");
  ok("opened · no lease place → 'your unit'",
    rcpt.operatingReceipt({ outcome: "work_order_opened", result: { workOrder: woRow(), decision: dec() }, context: null }).text
      === "Got it — plumbing request opened for your unit. We'll keep you updated right here.");

  ok("balance · not loaded",
    op("balance_read", { balance: null, rent: "1450.00" }) === WORDING.balance_missing);
  ok("balance · paid up, with rent",
    op("balance_read", { balance: "0.00", rent: "1450.00" }) === WORDING.balance_paid_up);
  ok("balance · owed, no rent on file",
    op("balance_read", { balance: "250.00", rent: null }) === WORDING.balance_owed);
  //  pg returns numeric as a STRING. "0.00" is truthy, so the rent line SHOWS.
  //  Converting to Number before the test would silently drop it — this is the
  //  exact trap the verbatim move was there to avoid.
  ok("balance · rent of '0.00' still prints (raw-string truthiness preserved)",
    op("balance_read", { balance: "10.00", rent: "0.00" }) === "Your current balance is $10.00. Rent is $0.00/month.");
  ok("balance · numeric rent of 0 does NOT print (same test, different type — as before)",
    op("balance_read", { balance: "10.00", rent: 0 }) === "Your current balance is $10.00.");
}

// ── the frozen table is not invented here ────────────────────────────
{
  let prior = null;
  try {
    //  bf84eb4 predates the tenantlink.js → tenant_link.js rename, so the
    //  pinned path is the OLD name on purpose — it is a git history reference.
    prior = execSync(`git show ${PRE_EXTRACTION_SHA}:src/comms/tenantlink.js`,
      { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString();
  } catch { /* reported below as NOT PROVEN, never as ok */ }

  if (!prior) {
    unproven(`every frozen sentence appears in the pre-extraction source (${PRE_EXTRACTION_SHA})`,
      `revision ${PRE_EXTRACTION_SHA} is unreachable — run 'git fetch --unshallow' and re-run`);
  } else {
    //  Compare on the invariant part of each sentence: the template segments
    //  around the interpolated unit label, balance and question.
    const fragments = [
      WORDING.hold_ambiguous_open_set, WORDING.hold_unrecognized_answer, WORDING.hold_answer_to_resolved,
      WORDING.append_escalated, WORDING.append_unresolved, WORDING.opened_emergency, WORDING.balance_missing,
      "Thanks — that helps. Your ${unitLabel} request is recorded as a routine repair and stays open with the team.",
      "Got it — I've opened a request for ${unitLabel}. ${clarifying_question}",
      "request opened for ${unitLabel}. We'll keep you updated right here.",
      "You're all paid up — current balance $${bal.toFixed(2)}.",
      "Your current balance is $${bal.toFixed(2)}.",
      " Rent is $${Number(place.rent).toFixed(2)}/month.",
    ];
    const missing = fragments.filter((f) => !prior.includes(f));
    ok(`all ${fragments.length} resident sentences exist verbatim in ${PRE_EXTRACTION_SHA} (nothing was reworded)`,
      missing.length === 0, missing.length ? "absent: " + JSON.stringify(missing.slice(0, 2)) : null);
    ok("the pre-extraction source is genuinely the pre-extraction source",
      !prior.includes("conversation/receipt") && !prior.includes("conversation/clarification"));
  }
}

// ════════════════════════════════════════════════════════════════════
section("2. ONE IMPLEMENTATION — NO DUPLICATED LOGIC IN TENANTLINK");
// ════════════════════════════════════════════════════════════════════
{
  //  Scoped to the CONVERSATIONAL PATH — processInboundClaim through the end of
  //  the inbound-SMS route. Other surfaces in this file (the structured
  //  maintenance form, operator reply routes) have their own wording and their
  //  own send handling; they are not this seam and claiming them would be a
  //  false positive. See docs/CONVERSATIONAL_SEAMS_RECEIPT.md §5.
  const CONV = TL_CODE.slice(TL_CODE.indexOf("async function processInboundClaim"),
                             TL_CODE.indexOf('router.get("/tenant/thread"'));
  ok("the conversational region was located for inspection", CONV.length > 4000, String(CONV.length));

  //  Comment-stripped, and matched on the WHOLE sentence: a 40-character prefix
  //  collides with the maintenance form's near-identical emergency line, which
  //  is a different surface. The first cut of this assertion did exactly that.
  const FIXED = ["hold_ambiguous_open_set", "hold_unrecognized_answer", "hold_answer_to_resolved",
                 "append_escalated", "append_unresolved", "opened_emergency", "balance_missing"];
  const dupes = FIXED.filter((k) => CONV.includes(WORDING[k]));
  ok(`the conversational path keeps NO copy of any of the ${FIXED.length} fixed resident sentences`,
    dupes.length === 0, dupes.join(", "));
  const TEMPLATES = ["request is recorded as a routine repair", "I've opened a request for",
                     "request opened for", "all paid up — current balance", "Your current balance is",
                     "Rent is $", "added that to your request"];
  const dupeTemplates = TEMPLATES.filter((t) => CONV.includes(t));
  ok(`nor any of the ${TEMPLATES.length} interpolated sentence templates`,
    dupeTemplates.length === 0, dupeTemplates.join(" | "));

  ok("tenant_link keeps NO local clarification ladder",
    !/pending\.length\s*>\s*1/.test(TL_CODE) && !/verdict\s*===\s*"answers_question"/.test(TL_CODE)
    && !/verdict\s*===\s*"both"/.test(TL_CODE));
  ok("tenant_link keeps NO local §7.4 confirmation override",
    !/urgency_status\s*=\s*"needs_confirmation"/.test(TL_CODE));
  //  The wire result may be read in exactly ONE place: as the argument that
  //  builds a delivery receipt. Any other read of it is the conversational path
  //  forming its own opinion about delivery, which is the collapse this seam
  //  exists to prevent.
  //  EVERY read must be a receipt-building read. Counting to exactly ONE was
  //  wrong the moment a second door appeared (the operations line): the rule
  //  is "no read forms its own opinion about delivery", not "one read".
  const wireReads = (CONV.match(/wire\.sent/g) || []).length;
  const wireReadsIntoReceipt = (CONV.match(/deliveryReceipt\(wire\.sent/g) || []).length;
  ok("every read of the wire result builds a delivery receipt and nothing else",
    wireReads >= 1 && wireReads === wireReadsIntoReceipt && !/if\s*\(!wire\.sent\)/.test(CONV),
    `wire.sent read ${wireReads}×, ${wireReadsIntoReceipt}× into a delivery receipt`);

  ok("tenant_link IMPORTS the clarification seam and CALLS it",
    /require\(["']\.\.\/conversation\/clarification["']\)/.test(TL_CODE)
    && /clarification\.assessOpenClarification\s*\(/.test(TL_CODE)
    && /clarification\.assessConsequentialInterpretation\s*\(/.test(TL_CODE));
  ok("tenant_link IMPORTS the receipt seam and CALLS all three composers",
    /require\(["']\.\.\/conversation\/receipt["']\)/.test(TL_CODE)
    && /operatingReceipt\s*\(/.test(TL_CODE) && /deliveryReceipt\s*\(/.test(TL_CODE)
    && /composeReceipt\s*\(/.test(TL_CODE));

  //  Delegation is not enough on its own: a second caller must be able to
  //  reach the same code without dragging SMS along.
  ok("clarification.js requires NOTHING — no transport, no database, no model",
    !/require\s*\(/.test(CLAR_CODE));
  ok("receipt.js requires NOTHING — no transport, no database, no model",
    !/require\s*\(/.test(RCPT_CODE));

  const seamFiles = fs.readdirSync(path.join(ROOT, "src", "conversation")).sort();
  ok("the conversation seam directory holds exactly the extracted seams",
    seamFiles.join(",") === "clarification.js,intent.js,receipt.js,technician_intent.js,work_reference.js", seamFiles.join(","));
}

// ════════════════════════════════════════════════════════════════════
section("3. CLARIFICATION — WHAT IT MAY NEVER DO");
// ════════════════════════════════════════════════════════════════════
{
  ok("never reads a person identifier — obligations.person_id cannot be mistaken for the reporter",
    !/person_id/.test(CLAR_CODE));
  //  \bo\. and not /o\.person_id/ — the first cut matched the tail of
  //  `convo.person_id` in an unrelated route and reported a false defect.
  ok("tenant_link's pending-clarification query is still NOT keyed on obligations.person_id",
    /ce\.person_id\s*=\s*\$2/.test(TL_CODE) && !/\bo\.person_id/.test(TL_CODE));
  ok("never touches authority, roles, staff or entitlement",
    !/(authority|entitlement|\brole\b|\bstaff\b|assignment)/i.test(CLAR_CODE));
  ok("holds no property list and performs no lookup",
    !/properties|candidates|SELECT|select /i.test(CLAR_CODE.replace(/scope\.property_id|row\.property_id|property_id/g, "")));

  const r = clar.assessOpenClarification({ scope: { property_id: PROP }, open: [] });
  const keys = Object.keys(r).join(",");
  ok("no decision carries an actor, a person or an authority field",
    !/person|actor|authority|role|staff/i.test(keys), keys);
}

// ════════════════════════════════════════════════════════════════════
section("4. CLARIFICATION LADDER — EVERY BRANCH");
// ════════════════════════════════════════════════════════════════════
{
  const step1 = (open) => clar.assessOpenClarification({ scope: { property_id: PROP }, open });

  // ── QUESTION_NOT_DELIVERED ───────────────────────────────────────
  //  A PRE-EXISTING PRODUCTION DEFECT, found by Gate A against a
  //  production-derived schema. A clarification question whose delivery
  //  failed is absent from `open` — correctly, since a reply cannot answer
  //  a question the resident never received. But that absence used to read
  //  as "nothing outstanding", so an ambiguous reply became a NEW WORK
  //  ORDER with needs_human unset, and the ambiguity verdict was never
  //  consulted at all.
  //
  //  Failure to deliver a clarification cannot turn ambiguity into
  //  operating truth.
  {
    const undel = (o = {}) => openRow(Object.assign({ sms_status: "failed" }, o));
    const both = (open, undelivered) =>
      clar.assessOpenClarification({ scope: { property_id: PROP }, open, undelivered });

    const notSent = both([], [undel()]);
    ok("an UNDELIVERED question holds for a human, never proposes new work",
      notSent.action === "hold_for_human" && notSent.state === "question_not_delivered",
      `${notSent.action}/${notSent.state}`);
    ok("...and says a human is required — this module's own call",
      notSent.requiresHuman === true);
    ok("...naming the fact it does not have",
      notSent.missingFact === "a_question_the_resident_actually_received", notSent.missingFact);
    ok("...and proposes nothing to append to",
      notSent.target === null && notSent.needs === null);

    ok("a DELIVERED question still wins — the reply is read against it",
      both([openRow()], [undel()]).needs === "answer_verdict");
    ok("neither delivered nor undelivered is still the prior-resolution question",
      both([], []).needs === "prior_resolution_check");
    ok("omitting `undelivered` entirely keeps the old behaviour",
      clar.assessOpenClarification({ scope: { property_id: PROP }, open: [] }).needs
        === "prior_resolution_check");

    //  An unreadable set is not an empty set — the same rule `open` follows.
    ok("an unreadable undelivered set is REFUSED, not treated as none",
      throws(() => clar.assessOpenClarification(
        { scope: { property_id: PROP }, open: [], undelivered: "nope" }), "undelivered_not_an_array"));

    //  Every delivery state the query selects on must reach the same hold.
    ok("every failed delivery state holds identically",
      ["failed", "refused", "undelivered"].every((s) =>
        both([], [undel({ sms_status: s })]).state === "question_not_delivered"));

    // ── NO HOLD MAY BE SILENT ────────────────────────────────────────
    //  `question_not_delivered` reached `held()`, which composes an
    //  operating receipt — and the receipt vocabulary had no text for it,
    //  so it REFUSED, `speak()` threw, and the resident's claim was flagged
    //  while the resident was told NOTHING. Adding one string fixed that
    //  instance; this gate is what stops the next one, by reading the hold
    //  states out of the seam's own source rather than from a list someone
    //  has to remember to update.
    const CLAR_SRC = require("fs").readFileSync(
      require("path").join(__dirname, "../../src/conversation/clarification.js"), "utf8");
    const holdStates = [...new Set(
      (CLAR_SRC.match(/state:\s*"([a-z_]+)",\s*action:\s*"hold_for_human"/g) || [])
        .map((m) => m.match(/"([a-z_]+)"/)[1]))];
    ok(`the seam declares ${holdStates.length} hold states, and they were found in source`,
      holdStates.length >= 5, holdStates.join(", "));
    const silent = holdStates.filter((s) =>
      rcpt.operatingReceipt({
        outcome: "held_for_human", result: { reasonCode: s }, context: { unitLabel: "your unit" },
      }).refusal === "unknown_hold_reason");
    ok("EVERY hold state the seam can produce composes a receipt — no hold is silent",
      silent.length === 0, silent.join(", ") || "none");
  }

  const many = step1([openRow(), openRow({ obligation_id: "ob-2", work_order_id: "wo-2" })]);
  ok("more than one outstanding → ambiguous_open_set", many.state === "ambiguous_open_set");
  ok("more than one outstanding → hold, never a choice", many.action === "hold_for_human" && many.target === null);
  ok("more than one outstanding → names the missing fact", many.missingFact === "which_open_request");
  ok("more than one outstanding → this module positively requires a human", many.requiresHuman === true);

  const one = step1([openRow()]);
  ok("exactly one outstanding → no terminal action yet", one.action === null && one.state === null);
  ok("exactly one outstanding → names the determination the caller must perform",
    one.needs === "answer_verdict" && one.missingFact === "whether_reply_answers_open_question");
  ok("exactly one outstanding → hands back the EXACT question we asked", one.question === openRow().question_body);

  const answered = clar.resolveAnswerVerdict({ pending: one, answerVerdict: "answers_question" });
  ok("answers_question → append to the existing work order", answered.action === "append_to_existing");
  ok("answers_question → the target is the caller's OWN row, by identity", answered.target === one.target);
  ok("answers_question → does NOT decide the human question (the service does)",
    answered.requiresHuman === null);

  const separate = clar.resolveAnswerVerdict({ pending: one, answerVerdict: "separate_problem" });
  ok("separate_problem → propose new work, with no target",
    separate.action === "propose_new_action" && separate.target === null && separate.state === "separate_problem");

  for (const v of ["both", "unclear", "", null, undefined, "ANSWERS_QUESTION", "yes", 1, {}]) {
    const t = clar.resolveAnswerVerdict({ pending: one, answerVerdict: v });
    ok(`verdict ${JSON.stringify(v)} → hold, never an action on a record`,
      t.action === "hold_for_human" && t.target === null && t.requiresHuman === true);
  }

  //  THE STRUCTURAL CLAIM: with something outstanding, new work is
  //  unreachable except through an explicit separate_problem verdict.
  const reachable = ["answers_question", "separate_problem", "both", "unclear", "", null, undefined, "junk", 0, [], {}]
    .filter((v) => clar.resolveAnswerVerdict({ pending: one, answerVerdict: v }).action === "propose_new_action");
  ok("with a clarification outstanding, ONLY separate_problem can propose new work",
    reachable.length === 1 && reachable[0] === "separate_problem", JSON.stringify(reachable));

  const none = step1([]);
  ok("nothing outstanding → the prior-resolution check is named, not skipped",
    none.needs === "prior_resolution_check" && none.action === null);
  const resolved = clar.resolvePriorResolution({ pending: none, priorAnsweredResolved: true });
  ok("nothing outstanding + a question already settled → hold, not a new request",
    resolved.state === "answer_to_resolved" && resolved.action === "hold_for_human" && resolved.requiresHuman === true);
  const clean = clar.resolvePriorResolution({ pending: none, priorAnsweredResolved: false });
  ok("nothing outstanding + nothing settled → the ordinary path",
    clean.state === "none" && clean.action === "propose_new_action");

  ok("every decision is frozen — a caller cannot edit the verdict it was handed",
    Object.isFrozen(many) && Object.isFrozen(answered) && Object.isFrozen(clean));
  ok("every terminal state is declared in the published vocabulary",
    [many, answered, separate, resolved, clean].every((d) => clar.CLARIFICATION_STATES.includes(d.state)));
  ok("every action is declared in the published vocabulary",
    [many, answered, separate, resolved, clean].every((d) => clar.GOVERNED_ACTIONS.includes(d.action)));
}

// ════════════════════════════════════════════════════════════════════
section("5. STALE OR MISMATCHED CONTEXT — FAILS HONESTLY");
// ════════════════════════════════════════════════════════════════════
{
  const s = { property_id: PROP };
  ok("a row from ANOTHER property is refused, not silently dropped",
    throws(() => clar.assessOpenClarification({ scope: s, open: [openRow({ property_id: OTHER_PROP })] }), "row_out_of_scope"));
  ok("a row with nothing to append to is refused",
    throws(() => clar.assessOpenClarification({ scope: s, open: [openRow({ work_order_id: null })] }), "row_without_target"));
  ok("a malformed row is refused",
    throws(() => clar.assessOpenClarification({ scope: s, open: [null] }), "row_malformed"));
  ok("an unreadable open set is NOT an empty open set",
    throws(() => clar.assessOpenClarification({ scope: s, open: null }), "open_not_an_array")
    && throws(() => clar.assessOpenClarification({ scope: s, open: "none" }), "open_not_an_array"));
  ok("no scope → refusal; clarification state is never evaluated outside a property scope",
    throws(() => clar.assessOpenClarification({ open: [] }), "scope_missing")
    && throws(() => clar.assessOpenClarification({ scope: {}, open: [] }), "scope_missing"));

  //  Refusal, not degradation: dropping the bad row would turn "there is an
  //  open question" into "open a new request".
  ok("a mismatched row never degrades into propose_new_action",
    throws(() => clar.assessOpenClarification({ scope: s, open: [openRow({ property_id: OTHER_PROP })] })));

  for (const q of [null, undefined, "", "   ", 42]) {
    const u = clar.assessOpenClarification({ scope: s, open: [openRow({ question_body: q })] });
    ok(`an outstanding question we cannot quote (${JSON.stringify(q)}) → hold, never judged`,
      u.state === "unusable_question_context" && u.action === "hold_for_human"
      && u.missingFact === "the_question_we_asked");
  }

  const one = clar.assessOpenClarification({ scope: s, open: [openRow()] });
  const none = clar.assessOpenClarification({ scope: s, open: [] });
  ok("step 2a cannot be called out of order", throws(() => clar.resolveAnswerVerdict({ pending: none, answerVerdict: "answers_question" }), "out_of_order"));
  ok("step 2b cannot be called out of order", throws(() => clar.resolvePriorResolution({ pending: one, priorAnsweredResolved: true }), "out_of_order"));
  ok("step 2a refuses a terminal decision as its input", throws(() => clar.resolveAnswerVerdict({ pending: none, answerVerdict: "both" }), "out_of_order"));
}

// ════════════════════════════════════════════════════════════════════
section("6. DUPLICATE ANSWERS DO NOT DUPLICATE THE CANONICAL ACTION");
// ════════════════════════════════════════════════════════════════════
{
  const s = { property_id: PROP };
  //  First answer: the obligation is open, so there is one outstanding row.
  const first = clar.resolveAnswerVerdict({
    pending: clar.assessOpenClarification({ scope: s, open: [openRow()] }), answerVerdict: "answers_question" });
  ok("first answer appends to the existing work order",
    first.action === "append_to_existing" && first.target.work_order_id === WO);

  //  The append closed the obligation, so the SAME answer arriving again finds
  //  nothing outstanding — and cannot reach new work without the check.
  const again = clar.assessOpenClarification({ scope: s, open: [] });
  ok("the same answer arriving again reaches NO action on its own",
    again.action === null && again.needs === "prior_resolution_check");
  const second = clar.resolvePriorResolution({ pending: again, priorAnsweredResolved: true });
  ok("with the question already settled, the duplicate is held — no second work order",
    second.action === "hold_for_human" && second.state === "answer_to_resolved");

  //  A caller that FORGETS to look must not get a negative result for free.
  ok("an unperformed prior-resolution check is refused, not read as 'no'",
    throws(() => clar.resolvePriorResolution({ pending: again }), "check_not_performed")
    && throws(() => clar.resolvePriorResolution({ pending: again, priorAnsweredResolved: null }), "check_not_performed")
    && throws(() => clar.resolvePriorResolution({ pending: again, priorAnsweredResolved: "no" }), "check_not_performed")
    && throws(() => clar.resolvePriorResolution({ pending: again, priorAnsweredResolved: 0 }), "check_not_performed"));
  ok("skipping the check leaves NO action to take (step 1 alone proposes nothing)",
    again.action === null && !clar.GOVERNED_ACTIONS.includes(again.action));
}

// ════════════════════════════════════════════════════════════════════
section("7. CONSEQUENTIAL INTERPRETATION — §7.4");
// ════════════════════════════════════════════════════════════════════
{
  const { classifyUrgency } = require("../../src/maintenance/maintenance_urgency.js");
  const A = clar.assessConsequentialInterpretation;

  const invented = A({ classification: "emergency",
    urgency: { urgency: "regular", basis: "no emergency signals detected — routine request",
               emergency_type: null, clarifying_question: null } });
  ok("model says emergency, classifier found no type → confirmation, NOT an invented emergency",
    invented.urgency_status === "needs_confirmation" && invented.emergency_type === null);
  ok("...and it asks something", invented.clarifying_question === clar.DEFAULT_CONFIRMATION_QUESTION);
  ok("...and the classifier's basis passes through untouched",
    invented.basis === "no emergency signals detected — routine request");
  ok("...and it is marked as requiring confirmation", invented.requiresConfirmation === true);

  const real = A({ classification: "emergency",
    urgency: { urgency: "emergency", basis: "active leak / flooding reported",
               emergency_type: "active_leak", clarifying_question: null } });
  ok("a classifier-established emergency stands, with its type",
    real.urgency_status === "emergency" && real.emergency_type === "active_leak" && real.requiresConfirmation === false);

  const alreadyAsking = A({ classification: "emergency",
    urgency: { urgency: "needs_confirmation", basis: "leak reported without active/severity detail",
               emergency_type: null, clarifying_question: "Is water actively leaking or flooding right now, or is it a slow/minor drip?" } });
  ok("an existing clarifying question is NOT replaced by the default",
    alreadyAsking.clarifying_question === "Is water actively leaking or flooding right now, or is it a slow/minor drip?");

  const routine = A({ classification: "maintenance",
    urgency: { urgency: "regular", basis: "b", emergency_type: null, clarifying_question: null } });
  ok("a routine maintenance reading is left alone",
    routine.urgency_status === "regular" && routine.requiresConfirmation === false);

  ok("an emergency with no type is refused rather than passed to the service",
    throws(() => A({ classification: "maintenance",
      urgency: { urgency: "emergency", basis: "b", emergency_type: null, clarifying_question: null } }),
      "emergency_without_type"));
  ok("a confirmation that asks nothing is refused",
    throws(() => A({ classification: "maintenance",
      urgency: { urgency: "needs_confirmation", basis: "b", emergency_type: null, clarifying_question: null } }),
      "confirmation_without_question"));
  ok("a confirmation asserting the very type it is unsure of is refused",
    throws(() => A({ classification: "maintenance",
      urgency: { urgency: "needs_confirmation", basis: "b", emergency_type: "active_leak", clarifying_question: "q?" } }),
      "unconfirmed_type_asserted"));
  ok("no urgency input at all is refused", throws(() => A({ classification: "emergency" }), "urgency_missing"));

  //  Against the real classifier, over real resident sentences: an emergency
  //  decision ALWAYS carries the fact that makes it actionable.
  const corpus = ["water is pouring through the ceiling", "I smell gas in the kitchen", "the outlet is sparking",
    "my door won't lock", "sewage is backing up into the tub", "the smoke alarm keeps chirping",
    "there is a slow drip under the sink", "no power in half the apartment", "the fridge is loud",
    "there's smoke coming from the vent", "someone broke in last night", "small crack in the window"];
  let bad = [];
  for (const text of corpus) {
    for (const classification of ["emergency", "maintenance"]) {
      const d = A({ classification, urgency: classifyUrgency(text) });
      if (d.urgency_status === "emergency" && !d.emergency_type) bad.push(text);
      if (d.urgency_status === "needs_confirmation" && !d.clarifying_question) bad.push(text);
    }
  }
  ok(`over ${corpus.length} real reports × 2 classifications, no emergency is ever typeless and no confirmation ever silent`,
    bad.length === 0, bad.join(" | "));
}

// ════════════════════════════════════════════════════════════════════
section("8. RECEIPT — PURE OVER THE COMMITTED RESULT");
// ════════════════════════════════════════════════════════════════════
{
  const dec = (over) => Object.assign({ urgency_status: "regular", emergency_type: null,
    clarifying_question: null, requiresConfirmation: false, basis: "b" }, over);

  for (const key of ["body", "message", "inbound", "text", "classification", "personId", "smsSid"]) {
    ok(`the resident's message cannot be smuggled in as '${key}'`,
      throws(() => rcpt.operatingReceipt({ outcome: "held_for_human", result: { reasonCode: "not_actionable" }, [key]: "x" }),
        "unknown_key"));
  }
  ok("nor hidden inside context",
    throws(() => rcpt.operatingReceipt({ outcome: "held_for_human", result: { reasonCode: "not_actionable" },
      context: { unitLabel: "Unit 1", body: "x" } }), "unknown_key"));
  ok("nor inside the committed result",
    throws(() => rcpt.operatingReceipt({ outcome: "clarification_appended",
      result: { workOrder: woRow(), outcome: "unresolved", body: "x" } }), "unknown_key"));

  //  The row is the truth. What was REQUESTED is not.
  const diverged = rcpt.operatingReceipt({ outcome: "work_order_opened", context: ctx,
    result: { workOrder: woRow({ urgency_status: "regular" }),
              decision: dec({ urgency_status: "emergency", emergency_type: "active_leak" }) } });
  ok("a committed row that differs from the decision is described AS COMMITTED",
    diverged.text === WORDING.opened_regular);
  ok("...and the divergence is stated, not swallowed", diverged.divergedFromDecision === true);
  ok("...and it forces a human", diverged.requiresHuman === true);

  const dedup = rcpt.operatingReceipt({ outcome: "work_order_opened", context: ctx,
    result: { workOrder: woRow(), decision: dec(), deduped: true } });
  ok("an idempotent create is reported as deduped, not as created", dedup.serviceOutcome === "deduped");

  ok("a needs_confirmation open IS a question to the resident",
    rcpt.operatingReceipt({ outcome: "work_order_opened", context: ctx,
      result: { workOrder: woRow({ urgency_status: "needs_confirmation" }),
                decision: dec({ urgency_status: "needs_confirmation", clarifying_question: "q?" }) } })
      .isClarificationQuestion === true);
  //  An append can leave a work order in needs_confirmation without our having
  //  asked anything new. Marking that outbound as a question would make every
  //  later resident message look like an answer to it.
  ok("an append that leaves the work order unconfirmed is NOT a question we asked",
    rcpt.operatingReceipt({ outcome: "clarification_appended", context: ctx,
      result: { workOrder: woRow({ urgency_status: "needs_confirmation" }), outcome: "unresolved" } })
      .isClarificationQuestion === false);

  ok("the service's human verdict is reported in BOTH directions",
    rcpt.operatingReceipt({ outcome: "clarification_appended", context: ctx,
      result: { workOrder: woRow(), outcome: "unresolved" } }).requiresHuman === true
    && rcpt.operatingReceipt({ outcome: "clarification_appended", context: ctx,
      result: { workOrder: woRow(), outcome: "escalated_emergency" } }).requiresHuman === false);

  ok("only a durable write reports itself as committed",
    rcpt.operatingReceipt({ outcome: "work_order_opened", context: ctx, result: { workOrder: woRow(), decision: dec() } }).committed === true
    && rcpt.operatingReceipt({ outcome: "balance_read", context: ctx, result: { balance: null, rent: null } }).committed === false
    && rcpt.operatingReceipt({ outcome: "held_for_human", context: ctx, result: { reasonCode: "not_actionable" } }).committed === false);

  ok("an unknown outcome is refused outright",
    throws(() => rcpt.operatingReceipt({ outcome: "work_order_closed", result: {} }), "unknown_outcome"));
  ok("every operating receipt is frozen",
    Object.isFrozen(diverged) && Object.isFrozen(dedup));
}

// ════════════════════════════════════════════════════════════════════
section("9. A REFUSED CANONICAL WRITE PRODUCES NO SUCCESS RECEIPT");
// ════════════════════════════════════════════════════════════════════
{
  const dec = { urgency_status: "regular", emergency_type: null, clarifying_question: null,
    requiresConfirmation: false, basis: "b" };
  const cases = [
    ["a create that returned nothing", { outcome: "work_order_opened", result: null }, "no_committed_object"],
    ["a create that returned no work order", { outcome: "work_order_opened", result: { decision: dec } }, "no_committed_object"],
    ["a create whose row has no id", { outcome: "work_order_opened", result: { workOrder: { urgency_status: "regular" }, decision: dec } }, "no_committed_object"],
    ["a create with no governing decision", { outcome: "work_order_opened", result: { workOrder: woRow() } }, "no_governing_decision"],
    ["a confirmation with nothing to ask", { outcome: "work_order_opened",
      result: { workOrder: woRow({ urgency_status: "needs_confirmation" }),
                decision: { urgency_status: "needs_confirmation", clarifying_question: null } } }, "confirmation_without_question"],
    ["an append that returned nothing", { outcome: "clarification_appended", result: null }, "no_committed_object"],
    ["an append whose row has no id", { outcome: "clarification_appended", result: { workOrder: {}, outcome: "unresolved" } }, "no_committed_object"],
    ["a hold with an unrecognised reason", { outcome: "held_for_human", result: { reasonCode: "made_up" } }, "unknown_hold_reason"],
  ];
  for (const [label, input, refusalCode] of cases) {
    const r = rcpt.operatingReceipt(Object.assign({ context: ctx }, input));
    ok(`${label} → nothing is said (text null, refusal '${refusalCode}')`,
      r.text === null && r.refusal === refusalCode && r.committed === false && r.object === null);
  }

  //  And the caller treats an honest blank as a failure rather than sending it.
  ok("tenant_link REFUSES to proceed on a refused receipt, rolling the claim back",
    /r\.text === null/.test(TL_CODE) && /throw new Error\(`receipt refused/.test(TL_CODE));
}

// ════════════════════════════════════════════════════════════════════
section("10. OPERATING ≠ DELIVERY — THE LOAD-BEARING SEPARATION");
// ════════════════════════════════════════════════════════════════════
{
  const dec = { urgency_status: "regular", emergency_type: null, clarifying_question: null,
    requiresConfirmation: false, basis: "b" };
  const operating = rcpt.operatingReceipt({ outcome: "work_order_opened", context: ctx,
    result: { workOrder: woRow(), decision: dec } });

  //  A committed action whose text never reached the resident.
  const failedWire = rcpt.deliveryReceipt({ state: "failed", providerRef: "SM_HARNESS_1", failureReason: "undelivered" });
  const composed = rcpt.composeReceipt({ operating, delivery: failedWire });
  ok("a transport failure does not revise the operating receipt",
    composed.operating.committed === true && composed.operating.text === WORDING.opened_regular
    && composed.operating.object.id === WO);
  ok("...and the delivery failure is separately visible, with its reason",
    composed.delivery.delivered === false && composed.delivery.failureReason === "undelivered");
  ok("A PROVIDER SID DOES NOT MAKE A MESSAGE DELIVERED",
    composed.delivery.providerRef === "SM_HARNESS_1" && composed.delivery.delivered === false);
  ok("...nor does it say anything about the operating action",
    !JSON.stringify(composed.operating).includes("SM_HARNESS_1"));

  //  The mirror: delivered, but nothing was committed.
  const refused = rcpt.operatingReceipt({ outcome: "work_order_opened", result: null, context: ctx });
  const delivered = rcpt.deliveryReceipt({ state: "delivered", providerRef: "SM_HARNESS_2" });
  const mirror = rcpt.composeReceipt({ operating: refused, delivery: delivered });
  ok("A DELIVERED MESSAGE DOES NOT MAKE AN OPERATING ACTION HAPPEN",
    mirror.delivery.delivered === true && mirror.operating.committed === false && mirror.operating.text === null);

  ok("delivered is derived from the state alone",
    rcpt.deliveryReceipt({ state: "not_attempted" }).delivered === false
    && rcpt.deliveryReceipt({ state: "failed", failureReason: "x" }).delivered === false
    && rcpt.deliveryReceipt({ state: "delivered" }).delivered === true);
  ok("not_attempted is neither delivered nor failed",
    rcpt.deliveryReceipt({ state: "not_attempted" }).attempted === false);
  ok("an unexplained failure is refused",
    throws(() => rcpt.deliveryReceipt({ state: "failed" }), "failure_without_reason"));
  ok("'nothing happened' cannot carry evidence that something did",
    throws(() => rcpt.deliveryReceipt({ state: "not_attempted", providerRef: "SM1" }), "not_attempted_with_evidence")
    && throws(() => rcpt.deliveryReceipt({ state: "not_attempted", failureReason: "x" }), "not_attempted_with_evidence"));
  ok("an unknown delivery state is refused",
    throws(() => rcpt.deliveryReceipt({ state: "queued" }), "unknown_state"));

  //  There is nowhere to put a merged verdict, and no way to add one.
  ok("the composed receipt has EXACTLY two keys", Object.keys(composed).join(",") === "operating,delivery");
  ok("no merged verdict field exists at any level",
    ["ok", "success", "sent", "complete", "done", "handled", "worked"].every((k) =>
      !(k in composed) && !(k in composed.operating) && !(k in composed.delivery)));
  ok("the composed receipt is frozen against acquiring one", (() => {
    try { composed.ok = true; } catch { /* strict mode throws; either way it must not stick */ }
    return !("ok" in composed);
  })());
  ok("a hand-built object cannot pose as an operating receipt",
    throws(() => rcpt.composeReceipt({ operating: { text: "done", committed: true }, delivery: failedWire }),
      "not_an_operating_receipt"));
  ok("a hand-built object cannot pose as a delivery receipt",
    throws(() => rcpt.composeReceipt({ operating, delivery: { delivered: true } }), "not_a_delivery_receipt"));
  ok("a delivery receipt cannot be passed as the operating one",
    throws(() => rcpt.composeReceipt({ operating: failedWire, delivery: failedWire }), "not_an_operating_receipt"));
  ok("neither half may be omitted",
    throws(() => rcpt.composeReceipt({ operating })) && throws(() => rcpt.composeReceipt({ delivery: failedWire })));
  ok("nothing else may ride along in the composition",
    throws(() => rcpt.composeReceipt({ operating, delivery: failedWire, ok: true }), "unknown_key"));

  //  And the live path composes both doors rather than assuming one.
  ok("the SMS door composes a delivery receipt from the wire result",
    /state:\s*"delivered"/.test(TL_CODE) && /state:\s*"failed"/.test(TL_CODE)
    && /composed\.delivery\.delivered/.test(TL_CODE));
  ok("the portal door states not_attempted rather than implying delivery",
    /state:\s*"not_attempted"/.test(TL_CODE));
}

// ════════════════════════════════════════════════════════════════════
section("11. WORK-ORDER WRITES STAY IN THE CANONICAL SERVICE");
// ════════════════════════════════════════════════════════════════════
{
  const files = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (e.name.endsWith(".js")) files.push(p);
  });
  walk(path.join(ROOT, "src"));

  const creators = files.filter((f) => /insert\s+into\s+work_orders/i.test(strip(fs.readFileSync(f, "utf8"))))
    .map((f) => path.relative(ROOT, f).replace(/\\/g, "/")).sort();
  ok("work orders are CREATED in exactly one place — the canonical service",
    creators.join(",") === "src/maintenance/work_order_service.js", creators.join(","));

  //  Direct UPDATEs outside the service are pre-existing operator surfaces,
  //  outside this slice. The register is pinned so a NEW one fails here rather
  //  than being discovered later; it is not a claim that these are correct.
  const updaters = files.filter((f) => /update\s+work_orders/i.test(strip(fs.readFileSync(f, "utf8"))))
    .map((f) => path.relative(ROOT, f).replace(/\\/g, "/")).sort();
  //  Four now. src/technician/lifecycle_service.js was ADDED deliberately: it
  //  is the canonical writer of field facts and of governed completion, and it
  //  is the only place the technician path can move a work order. The register
  //  grows only with a named reason, never silently.
  //
  //  FIVE. src/maintenance/not_done_service.js is the not-done UPDATE that was
  //  already here, RELOCATED — not a new writer. It lived inline inside the
  //  closeout route in maintenance.js, which the signed-in operator app cannot
  //  reach: that route is gated by the shared operator key and carries no
  //  property scope. Extracting it is what let the new
  //  POST /operator/work-orders/:id/not-done record the same fact through one
  //  implementation instead of a second copy behind an authenticated path.
  //
  //  maintenance.js REMAINS on the register — it still updates work orders on
  //  other paths — so this entry is genuinely an additional FILE and not a
  //  moved one. That is exactly why the count is restated rather than made
  //  flexible: the gate is supposed to make somebody write this paragraph.
  ok("no NEW unexplained direct work-order updater appeared (register pinned at 5 files)",
    updaters.join(",") === "src/comms/tenant_link.js,src/maintenance/maintenance.js,"
      + "src/maintenance/not_done_service.js,"
      + "src/maintenance/work_order_service.js,src/technician/lifecycle_service.js",
    updaters.join(","));

  ok("neither conversational seam contains SQL of any kind",
    !/(insert\s+into|update\s+\w+\s+set|delete\s+from|select\s+\w)/i.test(CLAR_CODE)
    && !/(insert\s+into|update\s+\w+\s+set|delete\s+from|select\s+\w)/i.test(RCPT_CODE));

  //  The conversational path itself creates work orders ONLY through the service.
  const claim = TL_CODE.slice(TL_CODE.indexOf("async function processInboundClaim"),
                              TL_CODE.indexOf("async function runInbound"));
  ok("processInboundClaim was located for inspection", claim.length > 500);
  ok("processInboundClaim issues NO SQL of its own",
    !/insert\s+into|update\s+\w+\s+set|client\.query/i.test(claim));
  ok("processInboundClaim reaches work orders ONLY through the canonical service",
    /workOrderService\.createWorkOrder\(/.test(claim) && /workOrderService\.appendClarification\(/.test(claim));
}

  code = receipt.complete({ harness: HARNESS, passed, failed, expectedAtLeast: EXPECTED });
  if (notProven > 0) {
    console.error(`  ⚠  ${notProven} check(s) NOT PROVEN — see above. This run is not clean.`);
    if (code === 0) code = 3;
    console.error("  EXIT      " + code + "   (unproven checks are not passing checks)\n");
  }
} catch (e) {
  code = receipt.died(HARNESS, e, passed + failed);
}
process.exit(code);
