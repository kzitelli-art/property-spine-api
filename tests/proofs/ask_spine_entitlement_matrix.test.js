// ════════════════════════════════════════════════════════════════════
//  ask_spine_entitlement_matrix.test.js — §40.8, one cell at a time.
//
//  "Entitlements precede intelligence. Unentitled facts never enter model
//   context; a prompt is not a security boundary."
//
//  WHAT THIS PROVES, AND WHAT IT DOES NOT
//  --------------------------------------
//  The reachability detector (gate_ask_spine_readers.js) proves a question
//  REACHES a domain's gather branch. It says nothing about what an
//  UNENTITLED session gets once it arrives. That was the stated weakness of
//  the reachability lane, and this file is the answer to it.
//
//  For each of the 8 registered domains, one sentence from its own declared
//  `reached_by`, crossed with six module sets, asserted against the
//  `entitled_by` declaration in the registry. 8 × 6 = 48 cells. Every cell
//  must be exactly one of:
//
//      absent            the branch never ran
//      NOT_AUTHORIZED    the branch ran and refused, sayably
//      a real read       OK · NOT_ESTABLISHED · READ_FAILED · READ_TIMED_OUT
//
//  and the third is permitted ONLY where the declaration entitles it.
//
//  SOURCE-ONLY, like the gate. gatherFacts is called directly with a db
//  whose every use throws, so a read that needs the database announces
//  itself as READ_FAILED rather than quietly succeeding against a fixture.
//  Per-domain reader reach is counted separately — see REACH below — because
//  "the database was not touched" is a weaker claim than "this domain's
//  canonical reader was never invoked", and only the second is the §40.8
//  property. They are asserted apart.
//
//  OUT OF SCOPE, deliberately:
//    · cross-domain composition authorization — §40.8 records it UNSOLVED
//      and this file does not pretend otherwise. One question pulling two
//      entitled domains into one answer is not tested here.
//    · the HTTP /ask door and its session resolution. This proves the
//      composer's own gate, not the transport that feeds it. Where the two
//      layers disagree, the disagreement itself is asserted below.
//
//  CLASS 1 — permanent.
// ════════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");
const ask = require("../../src/agent/ask_spine_answer.js");

const GATE = path.join(__dirname, "..", "gates", "gate_ask_spine_readers.js");

let passed = 0, failed = 0;
const lines = [];
function ok(name, cond, detail) {
  if (cond) { passed++; lines.push(`  ok    ${name}`); }
  else { failed++; lines.push(`  FAIL  ${name}`); if (detail) lines.push(`          ${detail}`); }
}

/*  ── THE DECLARATION, READ FROM THE REGISTRY ─────────────────────────
 *  Parsed from source rather than required: the gate runs its assertions
 *  and calls process.exit on load, so requiring it would run the gate
 *  inside this proof. The gate parses the composer's source for the same
 *  reason; this is the same idiom pointed the other way.               */
const GATE_SRC = fs.readFileSync(GATE, "utf8");
function declarationFor(domain) {
  const at = GATE_SRC.search(new RegExp(`\\n  ${domain}: \\{`));
  if (at === -1) return null;
  const block = GATE_SRC.slice(at, at + 2600);
  const ent = block.match(/entitled_by:\s*\[([^\]]*)\]/);
  if (!ent) return null;
  const modules = [...ent[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  const diverges = /composer_divergence:\s*\{/.test(block.slice(0, block.indexOf("capability_classes")));
  return { modules, diverges };
}

const MODULE_SETS = [
  { label: "[]", modules: [] },
  { label: "leasing", modules: ["leasing"] },
  { label: "management", modules: ["management"] },
  { label: "maintenance", modules: ["maintenance"] },
  { label: "asset_management", modules: ["asset_management"] },
  { label: "all five", modules: ["leasing", "management", "maintenance", "asset_management", "accounting"] },
];

//  One sentence per domain, taken from that domain's own declared
//  reached_by so the two proofs cannot drift apart.
const DOMAINS = [
  "prospect_match", "maintenance", "compliance", "utility",
  "contracted_service", "debt", "equity", "tenancy",
];
function sentenceFor(domain) {
  const at = GATE_SRC.search(new RegExp(`\\n  ${domain}: \\{`));
  const block = GATE_SRC.slice(at, at + 2600);
  const arr = block.match(/reached_by:\s*\[([\s\S]*?)\]/);
  const first = arr && arr[1].match(/"([^"]+)"/);
  return first ? first[1] : null;
}

const REAL_READ = new Set(["OK", "NOT_ESTABLISHED", "READ_FAILED", "READ_TIMED_OUT"]);

//  A db whose every use throws. A domain that needs the database cannot
//  quietly succeed here; it surfaces as READ_FAILED, which is a REAL read
//  and therefore a disclosure — exactly what an unentitled cell must not
//  produce. Synthetic throughout; this proof owns no data.
function hostileDb() {
  const seen = { queries: 0 };
  return { db: { query() { seen.queries++; throw new Error("this proof must not touch a database"); } }, seen };
}

async function cell(domain, modules) {
  const sentence = sentenceFor(domain);
  const subject = ask.questionSubject(sentence);
  const { db, seen } = hostileDb();
  const facts = await ask.gatherFacts(db, {
    property_id: "p-synthetic-1",
    allowed_modules: modules,
    subject,
    question: sentence,
  });
  const value = facts[domain];
  const silence = facts.composite_silence || {};
  return {
    sentence, subject, value, queries: seen.queries,
    state: value === undefined ? "absent" : (value.read_state || "no read_state"),
    countedInSilence: JSON.stringify(silence).includes(`"${domain}"`),
  };
}

const TABLE = [];

async function main() {
  console.log("\n  ── THE MATRIX · 8 domains × 6 module sets ──");
  for (const domain of DOMAINS) {
    const decl = declarationFor(domain);
    ok(`${domain} declares entitled_by`, decl && decl.modules.length > 0,
      "a registered domain with no declared entitlement cannot be checked");
    if (!decl) continue;

    const row = { domain, cells: [] };
    for (const set of MODULE_SETS) {
      const r = await cell(domain, set.modules);
      const entitled = set.modules.some((m) => decl.modules.includes(m));
      const gotFact = r.state !== "absent" && r.state !== "NOT_AUTHORIZED";
      row.cells.push({ set: set.label, entitled, state: r.state, gotFact,
        countedInSilence: r.countedInSilence, subject: r.subject });

      //  ── 1. THE SHAPE OF EVERY CELL ────────────────────────────────
      ok(`${domain} · ${set.label} · is absent, NOT_AUTHORIZED, or a real read`,
        r.state === "absent" || r.state === "NOT_AUTHORIZED" || REAL_READ.has(r.state),
        `read_state=${JSON.stringify(r.state)}`);

      if (entitled) {
        //  ── 2a. AN ENTITLED SET GETS A READ ─────────────────────────
        ok(`${domain} · ${set.label} · ENTITLED, so the branch runs`,
          r.state !== "absent" && r.state !== "NOT_AUTHORIZED",
          `entitled by ${JSON.stringify(decl.modules)} but read_state=${JSON.stringify(r.state)}`);
      } else if (decl.diverges) {
        //  ── 2b. A DECLARED DIVERGENCE ───────────────────────────────
        //  The composer and the door disagree, the disagreement is
        //  declared in the registry, and this cell pins TODAY'S behaviour
        //  so the gap is tracked rather than silently green. Delete the
        //  declaration and this goes red; fix the composer and it also
        //  goes red, which is how a fix announces itself.
        ok(`${domain} · ${set.label} · UNENTITLED but divergence is DECLARED (open gap, pinned)`,
          gotFact,
          "the declared divergence no longer reproduces — re-check the composer and update the registry");
      } else {
        //  ── 2c. AN UNENTITLED SET GETS NO FACT ──────────────────────
        ok(`${domain} · ${set.label} · UNENTITLED, so no fact enters context`,
          !gotFact,
          `read_state=${JSON.stringify(r.state)} — an unentitled session received a ${domain} fact`);

        //  ── 3. AN UNENTITLED DOMAIN IS NOT A SILENCE OF THE PROPERTY ─
        //  §40.7. Not knowing because you may not ask is not the property
        //  being unreadable. If an unentitled domain counted as pending or
        //  unread, every restricted session would read as BLIND and the
        //  four silences would have collapsed into one.
        ok(`${domain} · ${set.label} · absence is not counted as a silence of the property`,
          !r.countedInSilence,
          `composite_silence names ${domain}`);
      }
    }
    TABLE.push(row);
  }

  /*  ── 4. THE DIVERGENCE IS BOUNDED AT THE DOOR ────────────────────────
   *  The one cell group where gatherFacts discloses without a guard is
   *  survivable only because answer() refuses first. That claim is not
   *  taken on trust: it is exercised, with a complete synthetic standing
   *  shape that WOULD be disclosed if the door let it through.          */
  console.log("\n  ── THE DIVERGENCE, BOUNDED AT THE DOOR ──");
  const SYNTHETIC_LABEL = "SYNTHETIC-LICENCE-0001";
  const syntheticStanding = {
    contract_version: "v-synthetic", capability_classes: { retrieval: true },
    composition_authorization: "unsolved", as_of: "2026-09-14", coverage: {},
    items: [{
      entity: { type: "licence", compliance_type: "rental_licence", label: SYNTHETIC_LABEL },
      standing: "current", why: "synthetic fixture",
      evidence: [{ role: "canonical_record", label: "SYNTHETIC-DOC-1" }],
      unresolved: null, next: "synthetic renewal", attention: "none", references: [],
    }],
    references: [],
  };
  const complianceReader = { async readComplianceStanding() { return syntheticStanding; } };

  const direct = await ask.gatherFacts(hostileDb().db, {
    property_id: "p-synthetic-1", allowed_modules: [], subject: "compliance",
    question: "are our licenses current", complianceReader,
  });
  ok("gatherFacts called directly with ZERO modules DOES disclose compliance facts (the gap, pinned)",
    JSON.stringify(direct.compliance || {}).includes(SYNTHETIC_LABEL),
    "the gap no longer reproduces — update the registry declaration");

  const door = await ask.answer(hostileDb().db, null, {
    property_id: "p-synthetic-1", allowed_modules: [],
    question: "are our licenses current", complianceReader,
  });
  ok("…but the /ask door refuses first, so nothing is disclosed through it",
    door && door.outcome === "not_authorized"
      && !JSON.stringify(door).includes(SYNTHETIC_LABEL),
    JSON.stringify(door).slice(0, 160));
  ok("…and the refusal is SAYABLE — it names the domain and the access",
    typeof door.answer === "string" && /Compliance/.test(door.answer)
      && /access/i.test(door.answer),
    JSON.stringify(door.answer));

  /*  ── 5. WHAT "NO DATABASE" IS AND IS NOT ─────────────────────────────
   *  The unentitled debt cell touches no database at all. The unentitled
   *  maintenance cell DOES — `work` also gathers the attention queue, which
   *  is scoped by module inside its own service. So "the db was untouched"
   *  is not the §40.8 property and is not asserted as one; what matters is
   *  that no DEBT fact appeared, which cell 2c above already asserts.   */
  const debtUnentitled = await cell("debt", ["leasing"]);
  ok("an unentitled Asset Management question reaches no database at all",
    debtUnentitled.queries === 0, `queries=${debtUnentitled.queries}`);
  const maintUnentitled = await cell("maintenance", []);
  ok("an unentitled maintenance question still touches the db for the module-scoped attention queue, and yields no maintenance fact",
    maintUnentitled.queries > 0 && maintUnentitled.state === "absent",
    `queries=${maintUnentitled.queries} state=${maintUnentitled.state}`);

  // ── the table, which is the deliverable ────────────────────────────
  const w = 20;
  console.log("\n  ── 8 × 6 ─────────────────────────────────────────────────────");
  console.log("  " + "domain".padEnd(w) + MODULE_SETS.map((s) => s.label.padEnd(17)).join(""));
  for (const row of TABLE) {
    console.log("  " + row.domain.padEnd(w)
      + row.cells.map((c) => `${c.entitled ? "E" : "·"} ${c.state}`.padEnd(17)).join(""));
  }
  console.log("  (E = entitled by the declaration · · = not)");

  const bar = "─".repeat(70);
  console.log(`\n${bar}\nASK SPINE ENTITLEMENT MATRIX — §40.8, ONE CELL AT A TIME\n${bar}`);
  console.log(lines.join("\n"));
  console.log(`\n${bar}`);
  console.log(`${passed}/${passed + failed} passed` + (failed ? `  —  ${failed} failure(s)` : ""));
  console.log(failed
    ? "Fix the failures above."
    : "Every unentitled cell is absent or refused. One divergence is declared, not hidden.");
  console.log(`${bar}\n`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
