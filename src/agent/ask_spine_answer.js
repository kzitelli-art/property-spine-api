//  ════════════════════════════════════════════════════════════════════
//  ask_spine_answer.js — ASK SPINE, SLICE 2: ANSWER A TYPED QUESTION
//
//  Slice 1 was one button and one question. This is the operator typing
//  a sentence and getting an answer from THIS property's real data.
//
//  ── READ-ONLY, AND STRUCTURALLY SO ──────────────────────────────────
//
//  Every read below is a select. There is no write path in this file and
//  no service here that has one. The model is never given a tool, an
//  identifier to act on, or a route — it is given facts and asked to
//  speak about them. Making Ask Spine able to DO something is a separate
//  slice with its own authority rules; it is not one prompt away.
//
//  ── THE MODEL IS A NARRATOR, NOT A SOURCE ───────────────────────────
//
//  Everything the answer may contain is gathered first, by the same
//  canonical services every other surface reads. The model receives that
//  bundle and the question, and is instructed to answer ONLY from it.
//
//  That is a real constraint, not a hope, and it is why `grounded_on`
//  travels back with every answer: the caller can show what the answer
//  was built from. An answer nobody can trace is the confident-wrong this
//  codebase refuses, and a chat box is the easiest place in a product to
//  ship one.
//
//  ── WHAT HAPPENS WHEN IT CANNOT ANSWER ──────────────────────────────
//
//  It says so. Failure and refusal shapes remain distinguishable by the caller:
//
//    unavailable   the model could not be reached, or no key is set.
//                  NOT an empty answer — the operator is told the
//                  assistant is down, not that nothing is happening.
//    out_of_scope  a real question this slice cannot answer from the
//                  facts it is allowed to read.
//    not_authorized the session lacks the governed domain entitlement.
//    composition_unavailable the requested cross-domain disclosure has
//                  no established composition authority.
//    answered      grounded in the bundle.
//
//  A read failure NEVER arrives shaped like "nothing to report". That
//  distinction is the whole reason this file has three outcomes instead
//  of a string.
//  ════════════════════════════════════════════════════════════════════
"use strict";

const askSpineService = require("./ask_spine_service");
const workOrderRead = require("../surfaces/work_order_status_read");
const complianceRead = require("../asset/compliance_read");
const utilityAskRead = require("../asset/utility_ask_detail.js");
const contractedServiceAskRead = require("../asset/contracted_service_ask_detail.js");
//  ⚠ THE SAME GOVERNED READER, NOT A NEW ONE. No equity_ask_detail.js
//  exists and none is being added here — Ask Spine reads exactly the
//  canonical loadHistory() + position() + standingProjection() the
//  Capital Stack UI reads, the same way compliance is registered below.
//  "One conversational architecture" (CLAUDE.md) means this file is the
//  only place a second Equity reader could quietly appear, so it does not.
const equityPositionService = require("../asset/equity_position_service.js");
const equityPositionRead = require("../asset/equity_position_read.js");
const tenancyStandingRead = require("../tenancy/tenancy_position_read.js");

const MODEL = process.env.ASK_SPINE_MODEL || "claude-opus-5";
/*  THINKING AND THE ANSWER SHARE THIS CEILING. On this model family
 *  thinking is on by default and `max_tokens` caps reasoning PLUS reply,
 *  not the reply alone. The old value here was 700 — sized for a two-line
 *  answer on a model that did not think — and it truncates mid-reasoning
 *  before a word is written. The reply itself is still short; the room is
 *  for the thinking in front of it.  */
const MAX_TOKENS = 4000;
/*  A bounded read-and-narrate task over facts that are already gathered:
 *  decide in-scope or not, then say one honest paragraph. That is not deep
 *  reasoning, and this is a dashboard where latency is felt. Tune by
 *  sweeping against the browser gate rather than by argument.  */
const EFFORT = process.env.ASK_SPINE_EFFORT || "medium";
const MAX_QUESTION = 500;

/*  ══ THE DECISION SHAPE, ENFORCED BY THE API ═══════════════════════
 *
 *  This replaces an assistant-turn prefill of `{`. That trick existed for
 *  a good reason — "a model that starts talking has already escaped the
 *  contract, and salvaging JSON out of prose is how a decline gets parsed
 *  as an answer" — but it was an approximation of a guarantee, and every
 *  current model REFUSES it outright:
 *
 *      400 invalid_request_error — "This model does not support assistant
 *      message prefill. The conversation must end with a user message."
 *
 *  The catch below turned that 400 into `unavailable`, so the surface said
 *  "I couldn't reach the assistant just then" forever. Honest, and
 *  indistinguishable from a real outage — which is exactly why it survived.
 *
 *  Structured outputs are the real mechanism the prefill was imitating: the
 *  API constrains the reply to this schema, so a reply that parses is not
 *  luck. `additionalProperties:false` and the `outcome` enum mean the
 *  two-outcome contract is refused at the wire rather than downstream.
 *
 *  ONLY WHAT THE MODEL DECIDES LIVES HERE. `grounded_on` is absent on
 *  purpose: the server builds it from the facts it gathered, so grounding
 *  is a thing Spine measured, never a thing the model claimed.  */
const DECISION_SCHEMA = {
  type: "object",
  properties: {
    outcome: { type: "string", enum: ["answered", "out_of_scope"] },
    answer: { type: "string" },
  },
  required: ["outcome", "answer"],
  additionalProperties: false,
};

/*  ══ THE SCOPE, DECLARED ONCE ══════════════════════════════════════
 *
 *  The first version of this slice had no scope at all. A text box was
 *  added and every sentence went to the model with a bundle of facts and
 *  an instruction to answer from them. That instruction bounds the DATA
 *  the model may cite. It does not bound the QUESTION. "Should I raise
 *  rents?" gets a confident, reasonable-sounding answer built from
 *  nothing, and `out_of_scope` only ever fired on an empty or oversized
 *  string — never on a topic.
 *
 *  A text box had quietly turned a governed read into a property chatbot.
 *
 *  So the scope is a CONSTANT, used in three places that must not drift:
 *  the model's instruction, the refusal the operator reads, and the test
 *  that pins both. One definition, no second opinion.
 *
 *  Widening it is a product decision with its own facts to gather. It is
 *  not something a prompt edit should be able to do quietly.  */
const SUPPORTED_SCOPE =
  "the current open work and governed Compliance, Utility, Contracted Services, or " +
  "Preferred/Common Equity records at this property — " +
  "what work is open and who has it, or whether a recorded Compliance item is " +
  "current and why, or this property's governed Utility setup, providers, account and meter map, " +
  "responsibility and recovery arrangement, statement history, known gaps, and " +
  "same-account statement comparisons, or governed service providers, scope, price, term, " +
  "notice decisions, retained evidence, financial observations, and known contract gaps, or " +
  "this property's governed tenancy standing — how many rentable positions there are, how " +
  "many are occupied or open on a date, what is committed next, and what Spine does not know " +
  "about them, or " +
  "who holds equity or preferred equity in this property, on what terms, what has been " +
  "contributed, and what remains unresolved";

//  The refusal is OWNED BY THE SERVER, not written by the model. A model
//  that composes its own decline can talk itself into being helpful, and
//  "I can't really answer that, but generally…" is the failure this
//  outcome exists to prevent.
const OUT_OF_SCOPE_ANSWER =
  "I can only answer about " + SUPPORTED_SCOPE + ". " +
  "Ask me what needs attention, about a recorded Compliance item, how a Utility works here, " +
  "what governs a contracted service, who holds equity here, or where the rent roll stands on a date.";

//  ⚠ EVERY NOUN HERE WAS SINGULAR-ONLY, AND NOBODY ASKS IN THE SINGULAR.
//  `\b(licen[cs]e)\b` does not match "licenses" — the \b needs a non-word
//  character and an "s" is not one. So "is the license current" routed to
//  Compliance and "are the licenses current" fell through to `work`, as
//  did "what inspections are due" and "are the rental licenses up to
//  date". A whole domain was reachable only by operators who happened to
//  ask about exactly one thing.
//
//  Found while adding Tenancy beside it: "are our licenses expiring"
//  started routing to the rent roll, because Tenancy matched a word
//  Compliance could not. Two domains competing for the same sentence is
//  what made a silent gap visible.
const COMPLIANCE_TERMS =
  /\b(compliance|licen[cs]es?|registrations?|inspections?|certificates?|violations?|cure)\b/i;

/*  ⚠ THE WORDS TWO DOMAINS OWN.
 *  renewal · expiring · expiration are Compliance's clock AND Tenancy's.
 *  A licence renews; so does a lease. Left in one regex they were decided
 *  by whichever test ran first, which is not a decision — it is an
 *  accident that changes when someone reorders a function.
 *
 *  So the collision is resolved in the open, by one rule: a clock word
 *  belongs to Compliance UNLESS the sentence also names a tenancy thing.
 *  "when is the next renewal" stays Compliance, exactly as before. "when
 *  do leases start expiring" is a rent roll question and now reads as
 *  one, rather than being refused as a composed question it never was.  */
const CLOCK_TERMS = /\b(renewals?|expir(?:e[sd]?|ing|ation|ations))\b/i;
const UTILITY_TERMS =
  /\b(utilit(?:y|ies)|electric(?:ity)?|gas|water|sewer|meter(?:ed|s|ing)?|submeter(?:ed|s|ing)?|provider account|utility account|account ending|peco|bills? residents)\b/i;
const CONTRACTED_SERVICE_TERMS =
  /\b(contracted services?|service contract|service agreement|vendor agreement|contractor|janitorial|cleaning (?:service|company|vendor|provider)|contracted (?:cleaning )?provider|elevator (?:service|maintenance)|pest control|exterminat(?:or|ion)|trash removal|waste removal|snow removal|landscaping service|security service|service provider)\b/i;
//  ⚠ Deliberately scoped to capital-stack vocabulary, not "equity" alone —
//  a bare "equity" collides with fair-housing/legal usage far more often
//  than it means capital structure in an operator's question.
const EQUITY_TERMS =
  /\b(preferred equity|common equity|equity (?:position|holder|stake)|equity in this property|cap(?:ital)? stack|capital structure|cap table|ownership (?:percent(?:age)?|stake|interest)|preferred return|minimum dividend|side letter|capital contribution|membership interest|capital-stack)\b/i;
//  ⚠ "vacant" is deliberately IN this list even though the read refuses to
//  use the word back. Someone asking "how many are vacant" is asking a
//  tenancy question, and routing it to `work` would answer a rent roll
//  question out of the work board. The truth walls travel with the facts,
//  so the answer can say `open` and say why it is not the same claim.
//
//  ⚠ AND the clock words — renewal, expiring, expiration — are NOT here.
//  They are shared with Compliance and are resolved by CLOCK_TERMS above,
//  in questionSubject, where the tie-break is visible. A lease question
//  reaches Tenancy through "lease" and then CLAIMS the clock word; a
//  licence question keeps it. Putting them in both regexes instead would
//  make every such sentence look composed when it is only ambiguous.
const TENANCY_TERMS =
  /\b(rent ?roll|occupanc(?:y|ies)|occupied|vacan(?:t|cy|cies)|leases?\b|leased|leasing|tenanc(?:y|ies)|residents?\b|move[- ]?(?:in|out)s?|beds?\b|who lives|how many (?:units|beds|positions|residents))\b/i;
const EXPLICIT_WORK_TERMS =
  /\b(work[ -]?order|repair|maintenance|technician|task|job|assigned|assignment)\b/i;

function questionSubject(question) {
  const text = String(question || "");
  const tenancyThing = TENANCY_TERMS.test(text);
  //  A clock word with no tenancy noun beside it is Compliance's, exactly
  //  as it has always been. With one, the lease owns it. Stated here so a
  //  reader can see the tie-break instead of inferring it from two regexes.
  const compliance = COMPLIANCE_TERMS.test(text) || (CLOCK_TERMS.test(text) && !tenancyThing);
  const utility = UTILITY_TERMS.test(text);
  const contractedService = CONTRACTED_SERVICE_TERMS.test(text);
  const equity = EQUITY_TERMS.test(text);
  const tenancy = tenancyThing && !contractedService && !equity;
  const work = EXPLICIT_WORK_TERMS.test(text) && !contractedService && !equity && !tenancy;
  if ([compliance, utility, contractedService, equity, tenancy, work].filter(Boolean).length > 1) {
    return "composition_unavailable";
  }
  if (compliance) return "compliance";
  if (utility) return "utility";
  if (contractedService) return "contracted_service";
  if (equity) return "equity";
  if (tenancy) return "tenancy";
  return "work";
}

function withoutDatabaseIds(value) {
  if (Array.isArray(value)) return value.map(withoutDatabaseIds);
  if (!value || typeof value !== "object") return value;
  const clean = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "id" || /_id$/.test(key) || (/_identifier$/.test(key) && !/_masked$/.test(key))) {
      continue;
    }
    clean[key] = withoutDatabaseIds(child);
  }
  return clean;
}

function utilityFactsForModel(standing) {
  return withoutDatabaseIds({
    contract_version: standing.contract_version,
    as_of: standing.as_of,
    setup_state: standing.setup_state,
    established_services: standing.established_services,
    not_applicable_services: standing.not_applicable_services,
    unresolved_services: standing.unresolved_services,
    unresolved_count: standing.unresolved_count,
    services: standing.services,
    next_due_statement: standing.next_due_statement,
    unresolved: standing.unresolved,
    does_not_establish: standing.does_not_establish,
    capabilities: standing.capabilities,
  });
}

function utilityEvidenceReferences(standing) {
  const found = new Map();
  function visit(value, label) {
    if (Array.isArray(value)) {
      for (const child of value) visit(child, label);
      return;
    }
    if (!value || typeof value !== "object") return;
    const nextLabel = value.label ? `${value.label} Utility evidence` : label;
    if (value.source_artifact_id && !found.has(String(value.source_artifact_id))) {
      found.set(String(value.source_artifact_id), {
        label: nextLabel,
        module: "asset_management",
        open: { kind: "utility_evidence", id: value.source_artifact_id },
      });
    }
    for (const child of Object.values(value)) visit(child, nextLabel);
  }
  visit(standing.services || [], "Utility evidence");
  return [...found.values()];
}

/*  The bundle. Bounded on purpose: every field here is something the
 *  operator could already see on a surface they are entitled to, read
 *  through the same services those surfaces use. Nothing is derived a
 *  second time, so Ask Spine cannot disagree with the board about a fact
 *  they both show.  */
async function gatherFacts(db, {
  property_id, allowed_modules, subject = "work", mintComplianceReference,
  complianceReader = complianceRead, utilityReader = utilityAskRead,
  contractedServiceReader = contractedServiceAskRead, question = "",
  //  Injectable for tests, same reasoning as the other readers above —
  //  the SAME canonical service/read pair the Capital Stack UI calls,
  //  never a second reader built for Ask Spine.
  equityService = equityPositionService, equityRead = equityPositionRead,
  tenancyReader = tenancyStandingRead,
}) {
  const facts = {
    property_id,
    gathered_at: new Date().toISOString(),
    question_subject: subject,
    __refs: [],
  };
  const failures = [];

  if (subject === "work") {
    try {
      const a = await askSpineService.attention(db, { property_id, allowed_modules });
      facts.attention = {
        total_open: a.total_open,
        scope_note: a.scope_note,
        items: (a.items || []).map((i) => ({
          label: i.label, module: i.module, type: i.type,
          due_at: i.due_at, is_overdue: i.is_overdue, is_unassigned: i.is_unassigned,
        })),
      };
    /*  ── WHAT THE ANSWER REFERS TO, AS RECORDS ──────────────────────
     *  The prose above is the model's. These are not: each is an item
     *  the attention service already resolved to a durable target
     *  (`navigationFor`), carried through untouched so the caller can
     *  open the actual thing.
     *
     *  ON `__refs`, AND WHY IT IS NOT IN `items`: the model is never
     *  given a record id. It has no use for one, and a model holding
     *  ids is a model that can put an id in a sentence — at which point
     *  a link is a thing it composed rather than a thing Spine
     *  resolved. The two are different epistemic classes (§38) and only
     *  one of them is safe to click. The key is stripped explicitly
     *  when the facts are serialised for the model; see `answer`.  */
      facts.__refs = (a.items || [])
        .filter((i) => i.open && i.open.kind && i.open.id)
        .map((i) => ({
          label: i.label,
          module: i.module,
          due_at: i.due_at,
          is_overdue: !!i.is_overdue,
          is_unassigned: !!i.is_unassigned,
          open: { kind: i.open.kind, id: i.open.id },
        }));
    } catch (e) { failures.push("attention"); }

    try {
      const wo = await workOrderRead.readPropertyWorkOrderStatuses(db,
        { propertyId: property_id, limit: 50 });
      const list = (wo && wo.work_orders) || [];
      facts.work_orders = {
        count: list.length,
        items: list.map((w) => ({
          reference: w.work_order && w.work_order.reference,
          unit: (w.work_order && w.work_order.unit_number) || "common area",
          title: w.work_order && w.work_order.title,
          state: w.current && w.current.state,
          accountable: w.current && w.current.accountable === "UNASSIGNED"
            ? "UNASSIGNED"
            : (w.current && w.current.accountable && w.current.accountable.name) || null,
          assigned_to: w.current && w.current.assigned_to ? w.current.assigned_to.name : null,
          next_action: w.next_action || null,
          opened_at: w.work_order && w.work_order.opened_at,
        })),
      };
    } catch (e) { failures.push("work_orders"); }
  }

  if (subject === "compliance") {
    try {
      const standing = await complianceReader.readComplianceStanding(db, {
        property_id,
        as_of: new Date().toISOString().slice(0, 10),
        mintReference: mintComplianceReference,
      });
      facts.compliance = {
        contract_version: standing.contract_version,
        capability_classes: standing.capability_classes,
        composition_authorization: standing.composition_authorization,
        as_of: standing.as_of,
        coverage: standing.coverage,
        items: standing.items.map((item) => ({
          entity: {
            type: item.entity.type,
            compliance_type: item.entity.compliance_type,
            label: item.entity.label,
          },
          standing: item.standing,
          why: item.why,
          evidence: item.evidence.map((entry) => ({ role: entry.role, label: entry.label })),
          unresolved: item.unresolved,
          next: item.next,
          attention: item.attention,
          reference_roles: (item.references || []).map((reference) => reference.role),
        })),
      };
      facts.__refs = standing.references.map((reference) => ({
        label: reference.label,
        module: "compliance",
        open: {
          kind: reference.role === "canonical_record"
            ? "compliance_record" : "compliance_source",
          token: reference.opener.token,
        },
      }));
    } catch (e) { failures.push("compliance"); }
  }

  // Entitlement excludes the facts themselves, not merely their links.
  if (subject === "utility" && (allowed_modules || []).includes("asset_management")) {
    try {
      const governed = await utilityReader.readForQuestion(db, {
        property_id,
        allowed_modules,
        question,
      });
      facts.utility = {
        ...governed.standing,
        read_state: governed.read_state,
        attention_state: governed.attention_state,
        detail_mode: governed.mode,
        detail: governed.detail,
      };
      facts.__refs = (facts.__refs || []).concat(governed.references || []);
    } catch (e) {
      const state = e && e.code === "READ_TIMED_OUT" ? "READ_TIMED_OUT" : "READ_FAILED";
      facts.utility = {
        read_state: state,
        attention_state: null,
        detail_mode: utilityReader.detailRequest(question).mode,
        detail: null,
      };
      failures.push(state === "READ_TIMED_OUT" ? "utility_timed_out" : "utility");
    }
  }

  if (subject === "contracted_service"
      && (allowed_modules || []).includes("asset_management")) {
    try {
      const governed = await contractedServiceReader.readForQuestion(db, {
        property_id,
        allowed_modules,
        question,
      });
      facts.contracted_service = {
        ...governed.standing,
        read_state: governed.read_state,
        attention_state: governed.attention_state,
        detail_mode: governed.mode,
        detail: governed.detail,
      };
      facts.__refs = (facts.__refs || []).concat(governed.references || []);
    } catch (e) {
      const state = e && e.code === "READ_TIMED_OUT" ? "READ_TIMED_OUT" : "READ_FAILED";
      facts.contracted_service = {
        read_state: state,
        attention_state: null,
        detail_mode: contractedServiceReader.detailRequest(question).mode,
        detail: null,
      };
      failures.push(state === "READ_TIMED_OUT"
        ? "contracted_service_timed_out" : "contracted_service");
    }
  }

  //  ⚠ THE SAME GOVERNED READER, GATHERED THE SAME WAY THE UI GATHERS IT —
  //  loadHistory() then position()/standingProjection(), never a second
  //  derivation. NOT_ESTABLISHED and a read failure stay two different
  //  facts here exactly as they do on screen (§40.7): an empty property
  //  reads facts.equity.standing.truth_state === NOT_ESTABLISHED; a
  //  broken read reads facts.equity.read_state === READ_FAILED. Neither
  //  is ever collapsed into the other.
  if (subject === "equity" && (allowed_modules || []).includes("asset_management")) {
    try {
      const history = await equityService.loadHistory(db, property_id);
      if (!history.positions.length) {
        facts.equity = {
          read_state: "OK",
          as_of: new Date().toISOString().slice(0, 10),
          positions: [],
          standing: { truth_state: equityRead.NOT_ESTABLISHED,
            why: "no capital-stack position is established for this property in Spine" },
        };
      } else {
        const asOf = new Date().toISOString().slice(0, 10);
        const reading = equityRead.position(history, asOf);
        facts.equity = withoutDatabaseIds({
          read_state: "OK",
          as_of: reading.as_of,
          standing: equityRead.standingProjection(reading),
          positions: reading.positions,
          conflicts: reading.conflicts,
          coverage_gaps: reading.coverage_gaps,
        });
      }
    } catch (e) {
      facts.equity = { read_state: "READ_FAILED" };
      failures.push("equity");
    }
  }

  //  ⚠ THE SAME GOVERNED READER THE LEDGER USES, one step compressed.
  //  readTenancyStanding calls datedPropertyPositions — the exact service
  //  the Rent Roll screen reads — so there is no second occupancy logic and
  //  no way for the sentence and the screen to disagree about the same
  //  building on the same day. What arrives here is the compact standing
  //  projection, not the 160-row payload: counts, unknowns and the nearest
  //  dated change. Detail is a second read and is deliberately not offered.
  //
  //  NOT_ESTABLISHED and a failed read stay two different facts (§40.7): a
  //  property with no inventory reads standing.truth_state ===
  //  'NOT_ESTABLISHED'; a broken read reads read_state === 'READ_FAILED'.
  //  Neither is ever collapsed into the other, and neither is a zero.
  if (subject === "tenancy"
      && ((allowed_modules || []).includes("leasing")
          || (allowed_modules || []).includes("management"))) {
    try {
      const standing = await tenancyReader.readTenancyStanding(db, { property_id });
      facts.tenancy = withoutDatabaseIds({ ...standing, read_state: "OK" });
    } catch (e) {
      const state = e && e.code === "READ_TIMED_OUT" ? "READ_TIMED_OUT" : "READ_FAILED";
      facts.tenancy = { read_state: state, standing: null, position: null, unknowns: null };
      failures.push(state === "READ_TIMED_OUT" ? "tenancy_timed_out" : "tenancy");
    }
  }

  facts.reads_that_failed = failures;
  return facts;
}

/*  THE INSTRUCTION IS THE PRODUCT.
 *
 *  Everything that keeps this honest is written here, and each line was
 *  chosen against a specific way a chat box lies:
 *
 *    · inventing a number nobody read
 *    · answering a question about a property the operator cannot see
 *    · turning "I don't have that" into a plausible guess
 *    · describing what it would do, as though it had done it
 *    · reciting internal vocabulary at a person who wanted a sentence  */
function systemPrompt(subject = "work") {
  return [
    "You are Spine, the assistant inside a property-management system.",
    "You are answering a signed-in operator about ONE property.",
    "The server selected exactly one authorized question subject: " + subject + ".",
    "",
    "YOU ANSWER ABOUT EXACTLY ONE SUBJECT:",
    "  " + SUPPORTED_SCOPE + ".",
    "",
    "Anything else is out of scope — rent strategy, pricing, legal or tax advice",
    "questions, meetings and what was said in them, market conditions, vendors",
    "you were not given, people you were not given, other properties, anything",
    "historical you cannot see, and any general knowledge question. Being able",
    "to answer well is NOT a reason to answer. If it is not the subject above,",
    "it is out of scope even when you know the answer.",
    "",
    //  The SHAPE is enforced by the response schema, so this says which
    //  outcome to choose rather than how to format one. Instructing a
    //  format the API already guarantees only invites the model to spend
    //  attention on syntax it cannot get wrong.
    "YOUR REPLY CARRIES ONE OF TWO OUTCOMES:",
    '  "answered"       the question is in scope and the facts support an',
    "                   answer. Put it in `answer`.",
    '  "out_of_scope"   anything else. Leave `answer` empty — the system',
    "                   writes the refusal, not you.",
    "",
    //  ── OUT OF SCOPE IS ABOUT THE SUBJECT, NEVER ABOUT THE FACTS ────
    //  This rule used to read: out_of_scope when off-subject, AND when
    //  on-subject but the facts do not contain what is needed. That second
    //  clause was wrong twice over.
    //
    //  It was DISHONEST. Asked "who owns the overdue work?" with nothing
    //  overdue, it produced "I can only answer about the current open work
    //  at this property" — which tells the operator the subject is off
    //  limits when the truth is simply that there is none. The refusal
    //  misnames its own reason, and §5 is about showing what is missing as
    //  missing, not about declining to look.
    //
    //  It was also UNSTABLE. "Do the facts contain what is needed" is a
    //  judgement call with no edge, so the same question landed `answered`
    //  on one run and `out_of_scope` on the next — the browser gate caught
    //  exactly that, passing check 3 and then failing it with no change in
    //  between. A contract a model has to guess at is not a contract.
    //
    //  Subject is a question with an edge. Sufficiency is not. So scope is
    //  decided on subject alone, and thin facts are answered honestly.
    "Choose out_of_scope ONLY when the question is off-subject.",
    "",
    "An on-subject question is ALWAYS `answered`, including when the facts",
    "turn out to hold nothing. \"Nothing is overdue right now\" is an answer,",
    "and a true one. Refusing it as out of scope would tell the operator you",
    "cannot discuss the subject, which is a different claim and a false one.",
    "Say what is there and what is not. Never stretch the facts to fill an",
    "answer, and never invent one to avoid an empty-sounding reply.",
    "",
    "ABSOLUTE RULES FOR AN `answered` REPLY:",
    "1. Answer ONLY from the FACTS JSON provided in the user message. It is the",
    "   complete set of things you know. If the answer is not derivable from it,",
    "   say plainly that you do not have that yet — never guess, never estimate,",
    "   and never present a plausible number as a real one.",
    "2. You cannot take actions. You cannot assign, message, schedule, close or",
    "   change anything. If asked to, say what you can see and that doing it is",
    "   not something you can do yet. Do not describe an action as though you",
    "   performed it.",
    "3. If `reads_that_failed` is non-empty, say that part of the picture could",
    "   not be read. Do not report a failed read as 'nothing to report' — those",
    "   are different facts and confusing them is the worst thing you can do.",
    "   For Utilities, READ_FAILED means Spine could not read it; READ_TIMED_OUT",
    "   means the read exceeded its bound; QUIET means the read succeeded and",
    "   nothing requires attention. None of those means there are no accounts.",
    "   The same failure and quiet-state distinctions apply to Contracted Services.",
    "4. Nothing being open is a real, good answer. Say it plainly and stop.",
    "   Do not manufacture concerns to seem useful.",
    "5. The FACTS contain only one authorized subject. Never combine Compliance,",
    "   Utilities, Contracted Services, Equity or Tenancy with work, residents,",
    "   finances or any absent domain. Composition authority",
    "   is not established merely because each domain could be read separately.",
    "6. For Compliance, item standing is not a property-wide legal conclusion.",
    "   An expiration date is not a renewal obligation, and a date-only next event",
    "   is not work that needs action. Preserve those distinctions exactly.",
    "   If a Compliance item has `source_artifact` in `reference_roles`, the interface",
    "   will show an Open source control below your answer. When asked to show the",
    "   document, say to use that source link below. Never say the source cannot be",
    "   opened or sent from here, and never claim that you personally opened it.",
    "7. For Utilities, a statement is not a provider payment; a resident recovery",
    "   method is not a resident collection; a collection is not a provider payment;",
    "   a provider is not a billing administrator; and a submeter is not a provider",
    "   account. Preserve NOT_ESTABLISHED exactly as unknown, never as none or no.",
    "8. Utility statement comparison is allowed only from the governed statement facts.",
    "   Do not invent weather, occupancy, rates, leaks, equipment behavior, or any",
    "   causal explanation. If no governed causal fact exists, say the cause is not",
    "   established even when the amounts changed.",
    "9. For Contracted Services, a proposal or unsigned document is not an executed",
    "   agreement; an accounting observation or invoice is not a contract price; a",
    "   service report is not proof that every scope obligation was completed; and a",
    "   renewal date is not a notice deadline unless the governing event and offset are",
    "   established. Preserve NOT_ESTABLISHED exactly as unknown, never as none or no.",
    "10. Contracted Services comparison and causal explanation are unavailable unless",
    "   the governed read explicitly establishes that capability. Never infer performance,",
    "   price competitiveness, savings, or payment from the retained evidence.",
    "11. For Equity, a position's accrued preferred balance is NEVER computed — it is",
    "   always not established, even when a rate and a contribution amount are both",
    "   known. Do not multiply a rate by time or by an amount to produce one.",
    "12. For Equity, a Minimum-Dividend-shaped schedule (a stepped rate observed from a",
    "   secondary source) is a different fact from the position's governed preferred",
    "   return. If its relationship to that return is not established, say exactly that —",
    "   never guess additive, offset, or any other relationship from the schedule's shape.",
    "13. For Equity, an override or side letter that is recorded but not executed is a",
    "   real fact you may mention, but it does not describe the position's current",
    "   settled terms. Say it is recorded and not yet applied; never describe it as",
    "   though it were in effect.",
    "14. For Equity, an unnamed holder or an unrecorded ownership percentage is a",
    "   coverage gap, not a property fact you may fill in. Never guess a holder's",
    "   identity or a missing percentage, and never imply a cap table is complete.",
    "15. For Tenancy, these words are NOT interchangeable and the facts keep them",
    "   apart: occupied is not paying — a position can be contractually occupied with",
    "   no rent recorded at all, and that count is given to you. Rent not recorded is",
    "   NEVER a rent of zero; say unknown. `open` means no lease spans that date and is",
    "   NOT a claim the position can be marketed — availability is a different read",
    "   with different inputs. A committed future position is not a locked one unless",
    "   the facts say locked.",
    "16. For Tenancy, NOT_ESTABLISHED means the property has recorded no rentable",
    "   positions at all — it does NOT mean the building is empty, and it is not zero",
    "   occupancy. A READ_FAILED tenancy read means Spine could not look; say that,",
    "   and never report either one as a vacant building.",
    "17. Tenancy answers retrieval only. Do not compare this property to another, to a",
    "   prior period, or to a market, and do not explain WHY occupancy is where it is —",
    "   no causal linkage is recorded. Do not compute a percentage the facts do not",
    "   carry; the counts are given for a reason.",
    "",
    "HOW TO SOUND:",
    "· Talk like a competent colleague, not a database. Short sentences.",
    "· Lead with the answer. No preamble, no restating the question.",
    "· Refer to work by unit and issue ('Unit 631, broken toilet'), and include",
    "  the work-order number when you have it.",
    "· Never use internal vocabulary: obligation, proof evaluation, canonical",
    "  writer, lifecycle state, accountable rail, module entitlement. Say who",
    "  has it, what is happening, and what is next.",
    "· 'UNASSIGNED' means nobody has taken it. Say 'nobody has taken this yet'.",
    "· Assigned and accepted are different. Someone can be assigned and not have",
    "  accepted; say 'waiting for X to accept', not 'X is working on it'.",
    "· Under 120 words unless the operator asked for a list.",
  ].join("\n");
}

/**
 * Answer a typed question about one property.
 *
 * @param anthropic  the shared SDK client (injected — this module holds no key)
 * @returns { outcome, answer, grounded_on, model }
 */
async function answer(db, anthropic, {
  property_id, allowed_modules, question, mintComplianceReference, complianceReader,
  utilityReader, contractedServiceReader, equityService, equityRead, tenancyReader,
}) {
  if (!property_id) throw new Error("ask_spine.answer requires a server-derived property_id");

  const q = String(question || "").trim();
  if (!q) {
    return { outcome: "out_of_scope", answer: "Ask me something about this property's work.",
             grounded_on: null };
  }
  if (q.length > MAX_QUESTION) {
    return { outcome: "out_of_scope",
             answer: `That question is longer than I can take in (${MAX_QUESTION} characters). Try a shorter one.`,
             grounded_on: null };
  }

  const subject = questionSubject(q);
  if (subject === "composition_unavailable") {
    return {
      outcome: "composition_unavailable",
      //  A REFUSAL MUST NAME WHAT IT CAN DO. This listed three subjects
      //  while the router had five, so someone asking about the rent roll
      //  AND compliance was told Spine handles compliance, utilities,
      //  contracted services and work — a list their own question was
      //  missing from, which reads as "I don't do that" rather than
      //  "not both at once".
      answer: "I can answer about the rent roll, Compliance, Utilities, Contracted Services, " +
              "equity, or open work separately, but I can't combine them in one answer yet.",
      grounded_on: null,
      references: [],
    };
  }
  const modules = Array.isArray(allowed_modules) ? allowed_modules.map(String) : [];
  //  ENTITLEMENT PRECEDES INTELLIGENCE (§40.8). Refused HERE, before any
  //  fact is read — never filtered out of an answer the model already saw.
  //  Tenancy is entitled on the doors where the work actually happens:
  //  Leasing records it, Management resolves it. Asset Management is
  //  deliberately NOT sufficient — an asset manager without a leasing or
  //  management assignment has no operating claim on resident-level tenancy
  //  at this property, and widening that is a product decision, not a
  //  convenience.
  if (subject === "tenancy"
      && !modules.includes("leasing") && !modules.includes("management")) {
    return {
      outcome: "not_authorized",
      answer: "The rent roll is not available in your current access for this property.",
      grounded_on: null,
      references: [],
    };
  }
  if (["compliance", "utility", "contracted_service", "equity"].includes(subject)
      && !modules.includes("asset_management")) {
    const label = subject === "compliance" ? "Compliance"
      : subject === "utility" ? "Utilities"
      : subject === "equity" ? "Preferred Equity or Common Equity" : "Contracted Services";
    return {
      outcome: "not_authorized",
      answer: `${label} is not available in your current access for this property.`,
      grounded_on: null,
      references: [],
    };
  }

  //  NO KEY IS NOT AN EMPTY ANSWER. Without this the operator would ask a
  //  question and get silence, which reads as "nothing is happening here".
  if (!anthropic) {
    return { outcome: "unavailable",
             answer: "I can't answer right now — the assistant isn't reachable. " +
                     "The rest of the dashboard is unaffected.",
             grounded_on: null };
  }

  const facts = await gatherFacts(db, {
    property_id, allowed_modules: modules, subject,
    mintComplianceReference, complianceReader, utilityReader,
    contractedServiceReader, equityService, equityRead, tenancyReader, question: q,
  });

  let text = "";
  try {
    const ai = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt(subject),
      //  The shape is enforced here, not coaxed. See DECISION_SCHEMA.
      output_config: { format: { type: "json_schema", schema: DECISION_SCHEMA }, effort: EFFORT },
      //  ENDS ON THE USER TURN. Nothing may follow it — see DECISION_SCHEMA
      //  for what the assistant prefill that used to sit here cost.
      messages: [
        //  `__refs` is STRIPPED HERE. The model gets labels and dates and
        //  never a record id — see gatherFacts for why a model holding ids
        //  is a model that can compose a link Spine did not resolve.
        { role: "user",
          content: `QUESTION SUBJECT: ${subject}\nFACTS:\n`
                   + `${JSON.stringify(facts, (k, v) => (k === "__refs" ? undefined : v), 2)}`
                   + `\n\nOPERATOR ASKED: ${q}` },
      ],
    });
    text = (ai.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  } catch (e) {
    //  The model failed. Say that. An operator who is told "nothing needs
    //  attention" when the assistant actually fell over has been lied to.
    console.error("ask-spine/answer model error", e && e.message);
    return { outcome: "unavailable",
             answer: "I couldn't reach the assistant just then. Try again in a moment.",
             grounded_on: null };
  }

  /*  THE SERVER DECIDES THE OUTCOME, NOT THE PROSE.
   *
   *  Before this, the model returned free text and every non-empty reply
   *  was treated as `answered`. A decline written as a sentence — "I can't
   *  really answer that, but generally…" — was indistinguishable from a
   *  grounded answer, to this code and therefore to the operator.
   *
   *  Now the reply must PARSE and must carry one of exactly two outcomes.
   *  Anything else is `unavailable`: a model that did not follow the
   *  contract is a model whose answer cannot be trusted, and guessing what
   *  it meant is the whole failure mode.  */
  let decision = null;
  try { decision = JSON.parse(text); } catch (_) { decision = null; }

  if (!decision || (decision.outcome !== "answered" && decision.outcome !== "out_of_scope")) {
    console.error("ask-spine/answer: model did not return a valid decision");
    return { outcome: "unavailable",
             answer: "I couldn't put an answer together just then. Try again in a moment.",
             grounded_on: null };
  }

  if (decision.outcome === "out_of_scope") {
    //  The server's words, every time. See OUT_OF_SCOPE_ANSWER.
    return { outcome: "out_of_scope", answer: OUT_OF_SCOPE_ANSWER, grounded_on: null };
  }

  const body = String(decision.answer || "").trim();
  if (!body) {
    return { outcome: "unavailable",
             answer: "I couldn't put an answer together just then. Try again in a moment.",
             grounded_on: null };
  }

  return {
    outcome: "answered",
    answer: body,
    model: MODEL,
    //  THE RECORDS THE ANSWER IS ABOUT. Server-resolved, never parsed out
    //  of the prose: matching names in model output back to rows would
    //  invent a link every time two people share a first name, and would
    //  make the surface's most clickable element its least trustworthy.
    //  Empty is a legitimate answer — an operator can read the prose and
    //  simply have nothing to open.
    references: facts.__refs || [],
    //  What the answer was built from. The caller shows this so a claim
    //  is checkable — the counts, not the rows, because the rows are
    //  already on the surfaces the operator can open.
    grounded_on: {
      open_items: facts.attention ? facts.attention.total_open : null,
      work_orders: facts.work_orders ? facts.work_orders.count : null,
      compliance_items: facts.compliance ? facts.compliance.items.length : null,
      compliance_as_of: facts.compliance ? facts.compliance.as_of : null,
      composition_authorization: facts.compliance
        ? facts.compliance.composition_authorization : null,
      utility_setup_state: facts.utility ? facts.utility.setup_state : null,
      utility_services: facts.utility ? facts.utility.established_services : null,
      utility_read_state: facts.utility ? facts.utility.read_state : null,
      utility_detail_mode: facts.utility ? facts.utility.detail_mode : null,
      contracted_service_setup_state: facts.contracted_service
        ? facts.contracted_service.setup_state : null,
      contracted_service_engagements: facts.contracted_service
        ? facts.contracted_service.engagement_count : null,
      contracted_service_read_state: facts.contracted_service
        ? facts.contracted_service.read_state : null,
      contracted_service_detail_mode: facts.contracted_service
        ? facts.contracted_service.detail_mode : null,
      equity_position_count: facts.equity ? facts.equity.positions.length : null,
      equity_read_state: facts.equity ? facts.equity.read_state : null,
      equity_coverage_gap_count: facts.equity && facts.equity.coverage_gaps
        ? facts.equity.coverage_gaps.length : null,
      tenancy_standing: facts.tenancy && facts.tenancy.standing
        ? facts.tenancy.standing.truth_state : null,
      tenancy_read_state: facts.tenancy ? facts.tenancy.read_state : null,
      tenancy_as_of: facts.tenancy ? facts.tenancy.as_of : null,
      tenancy_rentable_positions: facts.tenancy && facts.tenancy.position
        ? facts.tenancy.position.rentable_positions : null,
      reads_that_failed: facts.reads_that_failed,
      gathered_at: facts.gathered_at,
    },
  };
}

module.exports = {
  answer, gatherFacts, questionSubject, systemPrompt, MODEL, SUPPORTED_SCOPE, OUT_OF_SCOPE_ANSWER,
};
