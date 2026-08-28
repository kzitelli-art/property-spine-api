#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   tenancy_ask_spine.test.js — THE TENANCY SEAM INTO ASK SPINE

   §40.2: a domain is not done until Ask Spine can read it. The DB proof
   (tenancy_standing_read.db.js) shows the READ is right against 160 real
   beds. This shows the SEAM is right: what routes to tenancy, what is
   refused before anything is read, what the model is handed, and what
   happens when the read fails.

   DB-free and model-free by design, same as ask_spine_answer.test.js:
   the database is a stub and the reader is injected, because what is
   under test is the wiring, not the SQL. Whether the model writes a
   good sentence is not something a unit test can decide — but whether
   it was given the truth walls, and whether an unentitled question ever
   reached a read, are exactly what one can.

   ── THE ASSERTION THAT MATTERS MOST ─────────────────────────────────
   §40.8 says unentitled facts never enter model context, and that a
   prompt is not a security boundary. So the refusal is not checked by
   reading the answer text — it is checked by proving the READER WAS
   NEVER CALLED. A filter applied after a read is not entitlement; it is
   a redaction, and redactions leak.

   CLASS 3 — test infrastructure.

       node tests/unit/tenancy_ask_spine.test.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const path = require("path");
const ask = require(path.join(__dirname, "..", "..", "src/agent/ask_spine_answer.js"));
const tenancyRead = require(path.join(__dirname, "..", "..", "src/tenancy/tenancy_position_read.js"));

let pass = 0, fail = 0; const failures = [];
const ok = (l, c, d) => {
  if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; failures.push(l); console.log("  FAIL  " + l + (d ? "\n        " + d : "")); }
  return c;
};

const stubDb = { query: async () => ({ rows: [] }) };

/*  A reader that records every call. The call LOG is the evidence for
 *  the entitlement assertions — "the answer did not mention occupancy"
 *  would pass even if the read happened and the model simply chose not
 *  to use it.  */
function recordingReader(behaviour) {
  const calls = [];
  return {
    calls,
    readTenancyStanding: async (db, args) => {
      calls.push(args);
      if (behaviour instanceof Error) throw behaviour;
      return behaviour;
    },
  };
}

const ESTABLISHED = Object.freeze({
  contract_version: "tenancy_standing.v1",
  capability_classes: { retrieval: { claim: "claimed" } },
  composition_authorization: "unsolved_cross_domain",
  as_of: "2026-07-31",
  truth_walls: tenancyRead.TRUTH_WALLS,
  standing: { truth_state: "ESTABLISHED", why: "160 rentable positions are recorded across 72 units" },
  established_from: { source_file: "RentRoll07_1417.xlsx", source_as_of: "2026-07-31", confidence: "confirmed" },
  position: { units: 72, rentable_positions: 160, occupied: 37, open: 123,
              positions_with_a_known_next: 91, forward_commitments_natively_proven: 0,
              leasing_grain: "bed" },
  unknowns: { occupied_positions_with_no_recorded_rent: 4,
              positions_with_unresolved_occupancy_evidence: 0,
              positions_with_overlapping_lease_claims: 0,
              occupied_positions_proven_only_by_the_opening_import: 37,
              occupied_positions_with_no_linked_resident: 0 },
  next_milestone: { on: "2026-08-03", positions_affected: 91,
                    what: "a committed position begins", all_proven: false },
  does_not_establish: ["Whether an open position can be marketed or leased — that is availability."],
});

const NOT_ESTABLISHED = Object.freeze({
  contract_version: "tenancy_standing.v1",
  capability_classes: { retrieval: { claim: "claimed" } },
  composition_authorization: "unsolved_cross_domain",
  as_of: "2026-07-31",
  truth_walls: tenancyRead.TRUTH_WALLS,
  standing: { truth_state: "NOT_ESTABLISHED", why: "no rentable position is recorded for this property" },
  established_from: null, position: null, unknowns: null, next_milestone: null,
  does_not_establish: ["Anything about occupancy, rent or commitments."],
});

const PROP = "prop-1417";
const gather = (over) => ask.gatherFacts(stubDb, {
  property_id: PROP, allowed_modules: ["leasing"], subject: "tenancy",
  question: "how is the rent roll looking", ...over,
});

(async () => {
  console.log("\n" + "═".repeat(66));
  console.log("  TENANCY → ASK SPINE · THE SEAM");
  console.log("═".repeat(66) + "\n");

  // ── R · ROUTING ───────────────────────────────────────────────────
  console.log("  ── R · a tenancy question reaches tenancy ──");
  ok("R1  'what does the rent roll look like' routes to tenancy",
     ask.questionSubject("what does the rent roll look like") === "tenancy");
  ok("R2  'how many beds are occupied right now' routes to tenancy",
     ask.questionSubject("how many beds are occupied right now") === "tenancy");
  ok("R3  'when do leases start expiring' routes to tenancy",
     ask.questionSubject("when do leases start expiring") === "tenancy");
  /*  DELIBERATE. The read refuses to say "vacant" back — open ≠ available
   *  — but someone asking it is asking a TENANCY question. Routing it to
   *  `work` would answer a rent roll question out of the work board, and
   *  the truth walls travel with the facts so the answer can say `open`
   *  and say why that is not the same claim.  */
  ok("R4  'how many units are vacant' routes to tenancy, not to work",
     ask.questionSubject("how many units are vacant") === "tenancy");
  ok("R5  a work-order question is untouched by the new terms",
     ask.questionSubject("what work orders are open") === "work");
  /*  PRECEDENCE, NOT VOCABULARY. `tenancy` is computed with
   *  !contractedService && !equity, so a sentence carrying both a tenancy
   *  word and one of theirs must NOT be swallowed by the newer domain.
   *  These two questions each match TENANCY_TERMS as well.  */
  ok("R6  a contracted-service question is not stolen by 'leasing'",
     ask.questionSubject("who is the cleaning vendor for the leasing office") === "contracted_service");
  ok("R7  an equity question is not stolen by 'residents' or 'units'",
     ask.questionSubject("who holds preferred equity across our units") === "equity");
  /*  ⚠ COMPLIANCE OWNS renewal / expiring / expiration, and Tenancy
   *  deliberately does not claim them. Before this, COMPLIANCE_TERMS could
   *  not match its own plurals and Tenancy could match "expiring", so a
   *  license question routed to the rent roll.  */
  ok("R7b 'are our licenses expiring' is Compliance, not the rent roll",
     ask.questionSubject("are our licenses expiring") === "compliance",
     ask.questionSubject("are our licenses expiring"));
  ok("R7c a lease question CLAIMS the clock word and reaches tenancy",
     ask.questionSubject("when do leases start expiring") === "tenancy",
     ask.questionSubject("when do leases start expiring"));
  ok("R7d a bare clock word with no tenancy noun stays Compliance's, as before",
     ask.questionSubject("when is the next renewal") === "compliance",
     ask.questionSubject("when is the next renewal"));
  ok("R7e Compliance now matches its own plurals",
     ask.questionSubject("what inspections are due") === "compliance"
     && ask.questionSubject("are the rental licenses up to date") === "compliance",
     `${ask.questionSubject("what inspections are due")} / ` +
     `${ask.questionSubject("are the rental licenses up to date")}`);
  //  §40.8 is unsolved repo-wide. A question spanning two domains is
  //  refused, never composed.
  ok("R8  rent roll + compliance in one question is composition_unavailable",
     ask.questionSubject("what is our occupancy and are the licenses current")
       === "composition_unavailable");

  // ── E · ENTITLEMENT PRECEDES INTELLIGENCE (§40.8) ─────────────────
  console.log("\n  ── E · unentitled facts never enter model context ──");
  {
    const reader = recordingReader(ESTABLISHED);
    const facts = await gather({ allowed_modules: ["asset_management"], tenancyReader: reader });
    ok("E1  asset_management alone does NOT entitle tenancy",
       !("tenancy" in facts), JSON.stringify(facts.tenancy));
    ok("E2  …and the canonical read was never called",
       reader.calls.length === 0,
       `the reader ran ${reader.calls.length} time(s) for an unentitled actor — ` +
       "a fact read and then withheld has already left the boundary");
  }
  {
    const reader = recordingReader(ESTABLISHED);
    const out = await ask.answer(stubDb, { messages: { create: async () => { throw new Error("model must not be reached"); } } }, {
      property_id: PROP, allowed_modules: [], question: "what is our occupancy",
      tenancyReader: reader,
    });
    ok("E3  answer() refuses an unentitled tenancy question outright",
       out.outcome === "not_authorized", JSON.stringify(out.outcome));
    ok("E4  …with a sentence an operator can act on, not an error code",
       /not available in your current access/i.test(out.answer || ""), out.answer);
    ok("E5  …the reader was never called",
       reader.calls.length === 0, `${reader.calls.length} call(s)`);
    ok("E6  …and no reference was minted",
       Array.isArray(out.references) && out.references.length === 0);
  }
  {
    const reader = recordingReader(ESTABLISHED);
    const facts = await gather({ allowed_modules: ["management"], tenancyReader: reader });
    ok("E7  management entitles tenancy — the door that resolves the operation",
       !!facts.tenancy && facts.tenancy.read_state === "OK");
    ok("E8  and the property_id is the one the SERVER passed, not the question's",
       reader.calls.length === 1 && reader.calls[0].property_id === PROP,
       JSON.stringify(reader.calls));
  }

  // ── G · WHAT THE MODEL IS HANDED ──────────────────────────────────
  console.log("\n  ── G · the model gets the standing projection, walls attached ──");
  {
    const facts = await gather({ tenancyReader: recordingReader(ESTABLISHED) });
    ok("G1  the compact projection arrives whole",
       facts.tenancy.position.rentable_positions === 160 && facts.tenancy.position.occupied === 37,
       JSON.stringify(facts.tenancy.position));
    ok("G2  the unknowns arrive with it — counts, not a clean number",
       facts.tenancy.unknowns.occupied_positions_with_no_recorded_rent === 4);
    ok("G3  the truth walls travel WITH the facts, not only in the prompt",
       Array.isArray(facts.tenancy.truth_walls)
       && facts.tenancy.truth_walls.some((w) => /occupied ≠ paying/.test(w)));
    ok("G4  the source it was established from travels too",
       facts.tenancy.established_from.source_file === "RentRoll07_1417.xlsx");
    ok("G5  nothing failed, so reads_that_failed stays empty",
       Array.isArray(facts.reads_that_failed) && facts.reads_that_failed.length === 0,
       JSON.stringify(facts.reads_that_failed));
    //  §40.8: a model holding a record id can compose a link Spine did not
    //  resolve. gatherFacts strips them; this proves the tenancy branch is
    //  inside that guarantee and not beside it.
    const withId = JSON.parse(JSON.stringify(ESTABLISHED));
    withId.position.first_space_id = "11111111-1111-1111-1111-111111111111";
    const facts2 = await gather({ tenancyReader: recordingReader(withId) });
    ok("G6  a record id in the read never reaches the model",
       !("first_space_id" in facts2.tenancy.position),
       JSON.stringify(facts2.tenancy.position));
  }

  // ── S · THE SILENCES DO NOT COLLAPSE (§40.7) ──────────────────────
  console.log("\n  ── S · four silences, four different facts ──");
  {
    const facts = await gather({ tenancyReader: recordingReader(NOT_ESTABLISHED) });
    ok("S1  NOT_ESTABLISHED reaches the model as a PROPERTY fact",
       facts.tenancy.standing.truth_state === "NOT_ESTABLISHED"
       && facts.tenancy.read_state === "OK",
       JSON.stringify(facts.tenancy.standing));
    ok("S2  …and is NOT reported as a failed read",
       facts.reads_that_failed.length === 0, JSON.stringify(facts.reads_that_failed));
    ok("S3  …and carries no position block a sentence could read as zero occupancy",
       facts.tenancy.position === null, JSON.stringify(facts.tenancy.position));
  }
  {
    const facts = await gather({ tenancyReader: recordingReader(new Error("connection terminated")) });
    ok("S4  a thrown read becomes READ_FAILED — Spine could not look",
       facts.tenancy.read_state === "READ_FAILED", JSON.stringify(facts.tenancy));
    ok("S5  …it is NOT dressed as NOT_ESTABLISHED",
       facts.tenancy.standing === null, JSON.stringify(facts.tenancy.standing));
    ok("S6  …and it is named in reads_that_failed so the answer must say so",
       facts.reads_that_failed.includes("tenancy"), JSON.stringify(facts.reads_that_failed));
  }
  {
    const timeout = new Error("read timed out"); timeout.code = "READ_TIMED_OUT";
    const facts = await gather({ tenancyReader: recordingReader(timeout) });
    ok("S7  a timeout is its own silence, not a failure",
       facts.tenancy.read_state === "READ_TIMED_OUT"
       && facts.reads_that_failed.includes("tenancy_timed_out"),
       JSON.stringify({ r: facts.tenancy.read_state, f: facts.reads_that_failed }));
  }

  // ── P · THE PROMPT CARRIES THE WALLS AS RULES ─────────────────────
  console.log("\n  ── P · the wording layer is shown the walls it must not cross ──");
  {
    const prompt = ask.systemPrompt("tenancy");
    ok("P1  occupied ≠ paying is a rule, not a hope",
       /occupied is not paying/i.test(prompt));
    ok("P2  rent not recorded is never rent of zero",
       /NEVER a rent of zero/i.test(prompt));
    ok("P3  open ≠ available, and availability is named as the other read",
       /open.*NOT a claim the position can be marketed/is.test(prompt)
       && /availability is a different read/i.test(prompt));
    ok("P4  NOT_ESTABLISHED is explicitly not an empty building",
       /does NOT mean the building is empty/i.test(prompt));
    ok("P5  retrieval only — no comparison, no cause, no invented percentage",
       /Tenancy answers retrieval only/i.test(prompt)
       && /do not explain WHY occupancy is where it is/i.test(prompt)
       && /Do not compute a percentage/i.test(prompt));
    ok("P6  composition is refused in the prompt as well as in the router",
       /Never combine[\s\S]{0,120}Tenancy/i.test(prompt));
    //  The prompt numbers rules and cites them; two rules sharing a number
    //  is how "rule 13" stops meaning anything.
    const numbers = (prompt.match(/^\s*(\d+)\. /gm) || []).map((s) => s.trim());
    ok("P7  every numbered rule has its own number",
       new Set(numbers).size === numbers.length,
       `duplicate rule numbers: ${numbers.filter((n, i) => numbers.indexOf(n) !== i).join(", ")}`);
  }

  // ── C · THE SCOPE SENTENCE ────────────────────────────────────────
  console.log("\n  ── C · a refusal names what Spine CAN do ──");
  ok("C1  the supported scope mentions the rent roll",
     /rent roll|rentable positions/i.test(ask.SUPPORTED_SCOPE), ask.SUPPORTED_SCOPE.slice(0, 80));
  ok("C2  the out-of-scope reply offers tenancy as a thing to ask about",
     /rent roll/i.test(ask.OUT_OF_SCOPE_ANSWER), ask.OUT_OF_SCOPE_ANSWER);
  {
    const out = await ask.answer(stubDb, null, {
      property_id: PROP, allowed_modules: ["leasing"],
      question: "what is our occupancy and are the licenses current",
    });
    ok("C3  the composition refusal lists tenancy among what it can answer separately",
       out.outcome === "composition_unavailable" && /rent roll/i.test(out.answer || ""),
       JSON.stringify(out));
  }

  console.log("\n" + "═".repeat(66));
  console.log(`  ${fail === 0 ? "✓ PASS" : "✗ FAIL"} — ${pass} passed, ${fail} failed`);
  if (fail) console.log("  FAILED: " + failures.join(" | "));
  else {
    console.log("  Tenancy is readable by Ask Spine from the same canonical read the");
    console.log("  ledger uses, entitled before it is read, and unable to say a");
    console.log("  silence it did not observe.");
  }
  console.log("═".repeat(66) + "\n");
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(2); });
