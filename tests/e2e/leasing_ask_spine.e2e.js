/*  ASK SPINE — LEASING AT THE GRAIN OF ONE PERSON.
    Proves ROUTING, ENTITLEMENT, ADDRESSING and the FOUR SILENCES against a
    real database. It does NOT prove the model-composed sentence: that needs
    ANTHROPIC_API_KEY, which this environment does not have. What is proven
    here is everything that decides WHAT THE MODEL IS ALLOWED TO SEE.        */
const { gatherFacts, questionSubject } = require("../../src/agent/ask_spine_answer.js");
const { pool, q, ctx, toPacket, residentSigns, api } = require("./leasing_e2e_lib.js");
(async () => {
  const C = await ctx();
  const NAME = "Zeph" + Date.now().toString(36) + " Quillon";
  const A = await toPacket(C, { bed: C.bedB, name: NAME });
  await residentSigns(A.rawTok);
  const ask = async (question, modules) => {
    const subject = questionSubject(question);
    const f = await gatherFacts(pool, { property_id: C.prop, allowed_modules: modules, subject, question });
    const lp = f.leasing_person;
    return `${String(subject).padEnd(15)} ${lp ? lp.read_state : "(no leasing facts)"}`;
  };
  console.log("── FACT GATHERING ──");
  console.log("  entitled, named    :", await ask(`Has ${NAME} signed?`, ["leasing"]));
  console.log("  NOT entitled       :", await ask(`Has ${NAME} signed?`, ["maintenance"]));
  console.log("  no such person     :", await ask("Where is Absolutely Nobody?", ["leasing"]));
  console.log("  ambiguous          :", await ask("what's holding this up", ["leasing"]));
  const f = await gatherFacts(pool, { property_id: C.prop, allowed_modules: ["leasing"], subject: "leasing_person", question: `Has ${NAME} signed?` });
  const lp = f.leasing_person;
  console.log("\n── THE FACTS HANDED TO THE MODEL ──");
  console.log("  subject      ", lp.subject_name);
  console.log("  bed          ", lp.target && lp.target.space_label);
  console.log("  resident     ", lp.lease && lp.lease.resident_executed_at ? "SIGNED" : "not signed");
  console.log("  company      ", lp.lease && lp.lease.company_executed_at ? "SIGNED" : "not signed");
  console.log("  executed     ", lp.lease && lp.lease.executed_lease.present);
  console.log("  tenancy      ", lp.tenancy.state);
  console.log("  uncertainty  ", lp.uncertainty.length ? lp.uncertainty.map(u=>u.kind).join(",") : "settled");
  const leak = JSON.stringify(lp).match(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  console.log("  contains ids?", leak ? "YES — LEAK" : "no");
  let bad = 0;
  const must = (name, cond) => { if (cond) console.log("  \u2713 " + name); else { bad++; console.log("  \u2717 " + name); } };
  console.log("\n\u2500\u2500 ASSERTIONS \u2500\u2500");
  must("no database ids reach the model", !leak);
  must("the bed is named", lp.target && lp.target.space_label === "Bed B");
  must("the resident signature is visible", !!(lp.lease && lp.lease.resident_executed_at));
  must("the company signature is honestly absent", !(lp.lease && lp.lease.company_executed_at));
  must("no tenancy is claimed", lp.tenancy.state === "none");
  process.exitCode = bad ? 2 : 0;
  await pool.end();
})().catch(async e => { console.log("DIED " + e.stack); try { await pool.end(); } catch(_){} });
