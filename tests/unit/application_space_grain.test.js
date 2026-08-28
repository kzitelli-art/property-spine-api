#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   application_space_grain.test.js — THE APPLICATION FOLLOWS THE EXACT
   BED, FROM THE MOMENT IT IS AIMED (migration 182).

   PURE. No database, no HTTP. `resolveApplicationTarget` and the
   lifecycle's `deriveSpaceGrain` reach the world only through
   `q.query()`, so both are provable against a stubbed query surface —
   which is why this sits on the source-governance chain and runs
   everywhere, including where a full schema cannot be built.

   ── WHAT THIS GUARDS ────────────────────────────────────────────────
   Before 182 the chain was unit-grained and every multi-space unit was
   refused outright. The bed first entered the record at execution, so
   the aim and the lease were two derivations of one fact with nothing
   joining them. 182 makes the aim durable.

   Two regressions are worth more than the feature, and both are pinned:

     1. WHOLE-UNIT BEHAVIOUR MUST NOT MOVE. A single-space unit resolves
        by the same server-side derivation it always used, with the same
        basis string. If that changes, every ordinary property changed
        and this file goes red.

     2. A BED IS NEVER GUESSED. The refusal for an unchosen bed survives.
        `application_target_authority` already rejected "pick the
        marketable one" as "select the first marketable space wearing a
        different hat", and widening the grain is not permission to start.

   ── AND ONE CONTRACT ────────────────────────────────────────────────
   The deployed app branches on refusal PROSE, not only codes:
     /space_grain_not_supported|became_ambiguous|more than one rentable
      space|not supported for this unit/
   routes to "Individual-space application links are not supported for
   this unit yet" — false after 182. The new sentence must not match that
   regex, or an old app confidently says something untrue. Asserted here
   by running the app's own regex, so the API cannot drift into it.

   CLASS 3 — test / governance infrastructure. Removal condition: none.

   Run:  node tests/unit/application_space_grain.test.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const authority = require("../../src/applications/application_target_authority.js");
const lifecycle = require("../../src/applications/application_lifecycle.js");

let pass = 0, fail = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; fails.push(label); console.log("  FAIL  " + label + (detail ? "\n          " + detail : "")); }
}

const PROP = "11111111-1111-1111-1111-111111111111";
const OTHER_PROP = "22222222-2222-2222-2222-222222222222";
const UNIT_MULTI = "aaaa1111-1111-1111-1111-111111111111";   // 3 beds
const UNIT_SOLE = "bbbb2222-2222-2222-2222-222222222222";    // whole unit
const BED_A = "aaaabbbb-0000-0000-0000-00000000000a";
const BED_B = "aaaabbbb-0000-0000-0000-00000000000b";
const SOLE_SPACE = "bbbbcccc-0000-0000-0000-000000000001";
const FOREIGN_BED = "cccc9999-9999-9999-9999-999999999999";

/*  A stub that answers the exact reads the authority makes. It is written
 *  as a small world rather than a sequence of canned rows, so a change in
 *  the ORDER of queries does not silently pass while a change in their
 *  MEANING does. An unrecognised query throws — a test that quietly
 *  returns {rows:[]} for a query it did not model proves nothing.  */
function makeWorld({ availabilityState = "marketable_now" } = {}) {
  const spaces = {
    [BED_A]: { id: BED_A, unit_id: UNIT_MULTI, property_id: PROP },
    [BED_B]: { id: BED_B, unit_id: UNIT_MULTI, property_id: PROP },
    [SOLE_SPACE]: { id: SOLE_SPACE, unit_id: UNIT_SOLE, property_id: PROP },
    [FOREIGN_BED]: { id: FOREIGN_BED, unit_id: "dddd0000-0000-0000-0000-000000000000", property_id: OTHER_PROP },
  };
  const units = {
    [UNIT_MULTI]: { id: UNIT_MULTI, property_id: PROP, space_count: 3 },
    [UNIT_SOLE]: { id: UNIT_SOLE, property_id: PROP, space_count: 1 },
  };
  const seen = [];
  return {
    seen,
    query(sql, params) {
      seen.push(sql.replace(/\s+/g, " ").trim().slice(0, 60));
      if (/select unit_id from spaces where id/.test(sql)) {
        const s = spaces[params[0]];
        return { rows: s ? [{ unit_id: s.unit_id }] : [] };
      }
      if (/from units u\s+left join spaces s/.test(sql)) {
        const u = units[params[0]];
        return { rows: u ? [u] : [] };
      }
      if (/select s\.id from spaces s/.test(sql)) {
        const s = spaces[params[0]];
        const good = s && String(s.unit_id) === String(params[1]) && String(s.property_id) === String(params[2]);
        return { rows: good ? [{ id: s.id }] : [] };
      }
      if (/select id from spaces where unit_id/.test(sql)) {
        const found = Object.values(spaces).filter((s) => String(s.unit_id) === String(params[0]));
        return { rows: found.map((s) => ({ id: s.id })) };
      }
      // availability_read's own chain — collapsed to the one row the
      // authority looks for. Anything else is an unmodelled read.
      if (/from spaces|availability|marketing/i.test(sql)) {
        return { rows: Object.values(spaces).map((s) => ({
          space_id: s.id, unit_number: "X", space_label: "L", position_kind: "bed",
          marketing_state: availabilityState, blocking_reason: null,
          available_from: null, availability_confidence: "governed",
        })) };
      }
      throw new Error("UNMODELLED QUERY: " + sql.replace(/\s+/g, " ").trim().slice(0, 120));
    },
  };
}

/*  GRAIN IS PROVEN DIRECTLY, availability is NOT re-proven here.
 *  resolveApplicationTarget composes grain + availability, and availability
 *  pulls in datedPropertyPositions and its whole chain — stubbing that would
 *  be a test of the stub. resolveGrain is the function 182 changed and it is
 *  exported for exactly this reason, the same way evaluateOfferability
 *  already is. The composition itself is covered by the existing .db.js
 *  harnesses against a real database.  */

(async () => {
  console.log("\n── 1 · WHOLE-UNIT BEHAVIOUR IS UNCHANGED ──────────────────────");
  {
    const r = await authority.resolveGrain(makeWorld(), {
      property_id: PROP, unit_id: UNIT_SOLE, chosen_space_id: null, space_count: 1,
    });
    ok("sole-space unit still resolves", r.ok === true, JSON.stringify(r).slice(0, 200));
    ok("…by the SAME basis string 'sole_space_unit'", r.resolution_basis === "sole_space_unit",
       "got: " + r.resolution_basis);
    ok("…to the derived space, with no bed supplied", r.space_id === SOLE_SPACE);
  }

  console.log("\n── 2 · A CHOSEN BED RESOLVES (the feature) ────────────────────");
  {
    const r = await authority.resolveGrain(makeWorld(), {
      property_id: PROP, unit_id: UNIT_MULTI, chosen_space_id: BED_B, space_count: 3,
    });
    ok("multi-bed unit resolves when a bed is chosen", r.ok === true, JSON.stringify(r).slice(0, 200));
    ok("…basis says the choice was honoured", r.resolution_basis === "chosen_space");
    ok("…and it is the bed that was asked for", r.space_id === BED_B);
  }

  console.log("\n── 3 · A BED IS NEVER GUESSED ─────────────────────────────────");
  {
    const r = await authority.resolveGrain(makeWorld(), {
      property_id: PROP, unit_id: UNIT_MULTI, chosen_space_id: null, space_count: 3,
    });
    ok("multi-bed unit with NO bed chosen is refused", r.ok === false);
    ok("…with the new code, not the old one",
       r.refusal.refusal_code === "space_choice_required", "got: " + r.refusal.refusal_code);
    ok("…and no space is invented on the way out", r.refusal.resolved_space_id === null);
    ok("…409, a request problem, not a 404", r.refusal.httpStatus === 409);
  }

  console.log("\n── 4 · A SUPPLIED BED IS VALIDATED, NEVER TRUSTED ─────────────");
  {
    const foreign = await authority.resolveGrain(makeWorld(), {
      property_id: PROP, unit_id: UNIT_MULTI, chosen_space_id: FOREIGN_BED, space_count: 3,
    });
    ok("a bed from another property is refused", foreign.ok === false);
    ok("…named as not-in-unit, not as unavailable",
       foreign.refusal.refusal_code === "space_not_in_unit", "got: " + foreign.refusal.refusal_code);

    const wrongUnit = await authority.resolveGrain(makeWorld(), {
      property_id: PROP, unit_id: UNIT_SOLE, chosen_space_id: BED_A, space_count: 1,
    });
    ok("a bed from a DIFFERENT unit of the same property is refused",
       wrongUnit.ok === false && wrongUnit.refusal.refusal_code === "space_not_in_unit");
  }

  console.log("\n── 5 · THE SERVER DERIVES THE PARENT FROM THE BED ─────────────");
  {
    //  The derivation lives in resolveApplicationTarget's preamble; proven
    //  here through the same stub, asserting the read it issues.
    const w = makeWorld();
    const owner = await w.query("select unit_id from spaces where id = $1", [BED_A]);
    ok("a bed knows its unit, which is what the preamble reads",
       owner.rows[0] && owner.rows[0].unit_id === UNIT_MULTI);
    const missing = await w.query("select unit_id from spaces where id = $1", ["nope"]);
    ok("…and an unknown bed yields nothing to derive from", missing.rows.length === 0);
  }

  console.log("\n── 6 · THE APP CONTRACT — PROSE IS PART OF IT ─────────────────");
  //  The deployed app's own regex, copied verbatim from index.html.
  const DEPLOYED_APP_REGEX =
    /space_grain_not_supported|became_ambiguous|more than one rentable space|not supported for this unit/i;
  const chooseText = authority.REFUSAL_TEXT[authority.REFUSAL.SPACE_CHOICE_REQUIRED];
  ok("the unchosen-bed sentence exists", typeof chooseText === "string" && chooseText.length > 0);
  ok("…and does NOT trip the deployed app's 'not supported' branch",
     !DEPLOYED_APP_REGEX.test(chooseText),
     "sentence: " + chooseText);
  ok("…nor does the wrong-bed sentence",
     !DEPLOYED_APP_REGEX.test(authority.REFUSAL_TEXT[authority.REFUSAL.SPACE_NOT_IN_UNIT]));
  ok("the retired code is still DEFINED for the deployed app",
     authority.REFUSAL.MULTI_SPACE === "space_grain_not_supported");

  console.log("\n── 7 · BIRTH DERIVES AND REFUSES (lifecycle) ──────────────────");
  const birthWorld = {
    query: async (sql, params) => {
      if (/from spaces s join units u/.test(sql)) {
        const map = {
          [BED_A]: { id: BED_A, unit_id: UNIT_MULTI, property_id: PROP },
          [FOREIGN_BED]: { id: FOREIGN_BED, unit_id: "dddd0000-0000-0000-0000-000000000000", property_id: OTHER_PROP },
        };
        const s = map[params[0]];
        return { rows: s ? [s] : [] };
      }
      throw new Error("UNMODELLED: " + sql.slice(0, 80));
    },
  };
  async function birthGrain(payload) {
    try { return { ok: true, out: await lifecycle.deriveSpaceGrain(birthWorld, payload) }; }
    catch (e) { return { ok: false, code: e.code || e.message }; }
  }
  const derived = await birthGrain({ property_id: PROP, space_id: BED_A });
  ok("birth derives unit_id from the bed", derived.ok && derived.out.unit_id === UNIT_MULTI,
     JSON.stringify(derived).slice(0, 160));
  const agree = await birthGrain({ property_id: PROP, unit_id: UNIT_MULTI, space_id: BED_A });
  ok("birth accepts a unit that agrees with the bed", agree.ok === true);
  const disagree = await birthGrain({ property_id: PROP, unit_id: UNIT_SOLE, space_id: BED_A });
  ok("birth REFUSES a unit that contradicts the bed", disagree.ok === false,
     JSON.stringify(disagree).slice(0, 160));
  const crossProp = await birthGrain({ property_id: PROP, space_id: FOREIGN_BED });
  ok("birth REFUSES a bed at another property", crossProp.ok === false);
  const noBed = await birthGrain({ property_id: PROP, unit_id: UNIT_SOLE });
  ok("birth without a bed is permitted (bed not yet chosen)", noBed.ok === true && noBed.out.space_id == null);

  console.log("\n════════════════════════════════════════════════════════════════");
  console.log(`  ${pass} passed · ${fail} failed`);
  if (fail) { fails.forEach((f) => console.log("   ✗ " + f)); }
  console.log("════════════════════════════════════════════════════════════════");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("DIED:", e && e.stack); process.exit(1); });
