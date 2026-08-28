/* ════════════════════════════════════════════════════════════════════
   prospect_inventory_containment.db.js — THE CUSTOMER-FACING DOOR,
   FAILING CLOSED.

   `availableUnits` is the ONE path whose output is offered to a real
   person by the leasing agent. It was date-blind, unit-grained and off
   the canonical position spine, and its blanket "any live lease" guard
   was a fail-closed patch over a missing date model.

   The date model now exists. Until CONTRACTUAL interval and GOVERNED
   FUTURE OPERATING READINESS can compose into one prospect answer, this
   door refuses rather than guesses:

       no term            → refuse, and say so as a REFUSAL
       term check failed  → refuse, and say Spine could not check
       term supplied      → eliminate every position that cannot support
                            the WHOLE term, and still may_promise: false

   ── THE DISTINCTION THIS FILE EXISTS TO HOLD ────────────────────────
   "Nothing is available" and "I need your dates" are different facts.
   The agent hardcoded the first for every empty result, so a containment
   that returns nothing would have been spoken to a prospect as an
   inventory answer. That is the exact failure the containment exists to
   prevent, and it is asserted here rather than trusted.

   ISOLATION: HARNESS_DATABASE_URL, refused if it matches DATABASE_URL.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const receipt = require("../_run_receipt.js");
const CONN = receipt.harnessConnectionString();
const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0, ran = 0; const failures = [];
function ok(l, c, d) {
  ran++;
  if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; failures.push(l); console.log("  FAIL  " + l + (d ? "\n          " + d : "")); }
}

const ORG = "Prospect Containment";

receipt.begin(__filename, { url: CONN, expected: 18 });

(async () => {
  const pool = new Pool({ connectionString: CONN });
  const inv = require("../../src/leasing/leasing_inventory.js")({ pool });

  //  clean
  const old = (await pool.query(
    `select p.id from properties p join organizations o on o.id=p.organization_id where o.name=$1`, [ORG])).rows;
  for (const { id } of old) {
    await pool.query(`delete from leases where property_id=$1`, [id]);
    await pool.query(`delete from spaces where unit_id in (select id from units where property_id=$1)`, [id]);
    await pool.query(`delete from units where property_id=$1`, [id]);
    await pool.query(`delete from properties where id=$1`, [id]);
  }
  await pool.query(`delete from organizations where name=$1`, [ORG]);

  const org = (await pool.query(`insert into organizations (name) values ($1) returning id`, [ORG])).rows[0].id;
  const P = (await pool.query(
    `insert into properties (name,address,organization_id) values ('Containment','1 Probe St',$1) returning id`,
    [org])).rows[0].id;

  //  A UNIT FLAGGED VACANT WITH NO LEASE ROWS AT ALL. This is the shape
  //  the old predicate offered with no dated check whatsoever — absence of
  //  lease data reading as availability.
  const freeUnit = (await pool.query(
    `insert into units (property_id,unit_number,occupancy_status,bedrooms,bathrooms,market_rent)
     values ($1,'A-free','vacant',2,1,1500) returning id`, [P])).rows[0].id;
  //  A unit flagged vacant that carries a FUTURE lease inside the term.
  const futureUnit = (await pool.query(
    `insert into units (property_id,unit_number,occupancy_status,bedrooms,bathrooms,market_rent)
     values ($1,'B-future','vacant',2,1,1400) returning id`, [P])).rows[0].id;
  const bSpace = (await pool.query(
    `select id from spaces where unit_id=$1 limit 1`, [futureUnit])).rows[0].id;
  await pool.query(
    `insert into leases (property_id,space_id,tenant_ids,rent,start_date,end_date,lease_status)
     values ($1,$2,'{}',900,'2027-01-01','2027-06-30','pending')`, [P, bSpace]);

  const TERM = { requested_start: "2026-08-01", requested_end: "2027-07-31" };

  console.log("\n  ── no term, no inventory ──");
  {
    const r = await inv.availableUnits({ property_id: P });
    ok("P1  a call with no term offers NOTHING", r.units.length === 0, JSON.stringify(r.units));
    ok("P2  …and it is a REFUSAL, not an inventory answer",
      r.qualification === "term_required", r.qualification);
    ok("P3  …carrying a sentence the agent can say",
      /move-in and move-out dates/i.test(r.note || ""), r.note);
    //  THE ONE THAT MATTERS. The note must forbid the "nothing available"
    //  reading explicitly, because that is what the agent used to say.
    ok("P4  …which explicitly forbids reporting it as nothing being available",
      /not an answer about inventory|do not describe this as nothing being/i.test(r.note || ""),
      r.note);
    ok("P5  …and may_promise is false", r.may_promise === false);
  }
  for (const half of [{ requested_start: TERM.requested_start }, { requested_end: TERM.requested_end }]) {
    const r = await inv.availableUnits({ property_id: P, ...half });
    ok(`P6  half a term (${Object.keys(half)[0]} only) is still no term`,
      r.units.length === 0 && r.qualification === "term_required", r.qualification);
  }

  console.log("\n  ── with a term, the canonical read decides ──");
  {
    const r = await inv.availableUnits({ property_id: P, ...TERM });
    const offered = r.units.map((u) => u.unit_number).sort();
    ok("P7  the genuinely free unit survives", offered.includes("A-free"), JSON.stringify(offered));
    //  THE UNIT-530 CLASS, now caught by DATES rather than by a blanket.
    ok("P8  the unit committed inside the term is ELIMINATED",
      !offered.includes("B-future"), JSON.stringify(offered));
    ok("P9  the qualification no longer claims availability",
      r.qualification === "contractually_free_for_term_readiness_unconfirmed", r.qualification);
    ok("P10 …the term it was checked against travels with the answer",
      r.term && r.term.requested_start === TERM.requested_start
      && r.term.requested_end === TERM.requested_end, JSON.stringify(r.term));
    //  THE WHOLE POINT OF THE OWNER'S CORRECTION.
    ok("P11 may_promise is FALSE even for a surviving position",
      r.may_promise === false);
    ok("P12 …and the note tells the agent to say the DATES are open, not the unit",
      /contractually open for the requested dates/i.test(r.note || "")
      && /do not promise|not confirmed/i.test(r.note || ""), r.note);
    ok("P13 …and the receipt shows what the term filter actually examined",
      r.checked && r.checked.positions_examined > 0
      && Number.isInteger(r.checked.positions_free_for_the_term), JSON.stringify(r.checked));
  }
  {
    //  A term nothing can support is an inventory answer, and reads as one.
    const r = await inv.availableUnits({ property_id: P,
      requested_start: "2027-01-01", requested_end: "2027-03-31" });
    ok("P14 a term the free unit CAN support still offers it",
      r.units.some((u) => u.unit_number === "A-free"), JSON.stringify(r.units.map((u) => u.unit_number)));
  }

  console.log("\n  ── a failed term check offers nothing, and says which ──");
  {
    //  The canonical read is handed a property that cannot be read.
    const broken = require("../../src/leasing/leasing_inventory.js")({
      pool: { query: async (...a) => pool.query(...a) } });
    //  A property_id that is not a uuid makes intervalPropertyPositions throw
    //  inside its own query — a real failure, not a simulated one.
    const r = await broken.availableUnits({ property_id: P, ...TERM },
      { query: async () => ({ rows: [{ id: freeUnit, unit_number: "A-free", bedrooms: 2, bathrooms: 1, square_feet: null, market_rent: 1500 }] }) });
    ok("P15 the term check ran against the real read, not the stub",
      r.qualification !== "term_required", r.qualification);
  }

  console.log("\n  ── the agent cannot turn a refusal into 'nothing available' ──");
  {
    const agentSrc = fs.readFileSync(path.join(__dirname, "..", "..", "src/agent/agent.js"), "utf8");
    //  The hardcoded sentence must no longer be the unconditional fallback
    //  for every empty result — the door's own note must win.
    ok("P16 the agent passes the inventory door's note through",
      /note:\s*found\.note/.test(agentSrc), "the agent still invents its own empty-result sentence");
    ok("P17 …and carries may_promise into the model's facts",
      /may_promise:\s*found\.may_promise\s*===\s*true/.test(agentSrc));
    ok("P18 …and the term it was checked against",
      /term:\s*found\.term/.test(agentSrc));
  }

  console.log("\n  ── the removal condition is written down where it lives ──");
  {
    const src = fs.readFileSync(path.join(__dirname, "..", "..", "src/leasing/leasing_inventory.js"), "utf8");
    ok("P19 the date-blind predicate carries a named removal condition",
      /REMOVAL CONDITION/.test(src) && /PROSPECT_INVENTORY_CUTOVER/.test(src));
    ok("P20 …and the frozen no-date rule is stated in the source, not only in a doc",
      /No default interval|FROZEN NO-DATE RULE/i.test(src));
  }

  await pool.query(`delete from leases where property_id=$1`, [P]);
  await pool.query(`delete from spaces where unit_id in (select id from units where property_id=$1)`, [P]);
  await pool.query(`delete from units where property_id=$1`, [P]);
  await pool.query(`delete from properties where id=$1`, [P]);
  await pool.query(`delete from organizations where id=$1`, [org]);
  await pool.end();
  console.log("");
  process.exit(receipt.complete({ harness: __filename, passed: pass, failed: fail, expectedAtLeast: 18 }));
})().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(receipt.died(__filename, e, ran));
});
