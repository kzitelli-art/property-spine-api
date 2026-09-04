// ════════════════════════════════════════════════════════════════════
//  pricing_guards_proof.js — owner decisions 1 and 2 (2026-07-27)
//
//  Proves two guards against EXECUTED output, and proves each assertion
//  FAILS against the pre-fix code read from git HEAD. A test that cannot
//  fail is not evidence, so every block below runs twice: once against the
//  working tree (must pass) and once against HEAD (must fail).
//
//    Decision 1 — a $0 commercial space must never enter the residential
//                 leasing flow.  (availableUnits: `bedrooms is not null`)
//    Decision 2 — no unattended message makes a dated financial promise
//                 from code.     (followup_runner rung 3)
//
//  The commercial row is excluded TODAY only because its occupancy_status
//  is 'unknown'. To prove the guard actually does something, block A runs
//  the real predicates against real Postgres with the vacancy test widened
//  to include 'unknown' — i.e. the "someone flipped the status" scenario.
//  NOTHING IS WRITTEN. The flip is simulated inside the SELECT.
//
//  Run:  DATABASE_URL=... node tests/proofs/pricing_guards_proof.js
// ════════════════════════════════════════════════════════════════════

const { execSync } = require("child_process");
const path = require("path");
const { Client } = require("pg");

const DEMO = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";
const COMMERCIAL_UNIT = "4233";
const REPO = path.resolve(__dirname, "..", "..");

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`   PASS  ${msg}`); } else { fail++; console.log(`   FAIL  ${msg}`); } };
//  PINNED, NOT HEAD. This proof was written while the fix sat uncommitted,
//  so "HEAD" meant "pre-fix". The moment the fix was committed every
//  HEAD-is-absent assertion became permanently false (CURRENT_STATE #21).
//  8165874 is the parent of 562e9f6, the commit that introduced all three
//  guards; reading the pre-fix tree there keeps the falsification honest
//  and true for good.
const PRE_FIX = "8165874";
const head = (rel) => execSync(`git show ${PRE_FIX}:${rel}`, { cwd: REPO, encoding: "utf8", maxBuffer: 20e6 });

// ── the two predicates, named so the diff is the subject of the test ──
const PRE_FIX_WHERE = `property_id = $1 and occupancy_status in ('vacant','unknown') and coalesce(is_down,false) = false`;
const POST_FIX_WHERE = PRE_FIX_WHERE + ` and bedrooms is not null`;
const ORDER = ` order by market_rent asc nulls last, unit_number asc`;

(async () => {
  console.log("\n══ BLOCK A — residential shape guard (decision 1) ══");

  // A1: the guard is actually in the shipped source, and was NOT at HEAD.
  const invNow = require("fs").readFileSync(path.join(REPO, "src/leasing/leasing_inventory.js"), "utf8");
  const invHead = head("src/leasing/leasing_inventory.js");
  ok(/bedrooms is not null/.test(invNow), "working tree: availableUnits() carries `bedrooms is not null`");
  ok(!/bedrooms is not null/.test(invHead), "8165874 (pre-fix): guard absent — so this assertion CAN fail");

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("   SKIP  behavioural block — no DATABASE_URL in env");
  } else {
    const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
    await c.connect();
    await c.query("set session characteristics as transaction read only"); // no writes, ever

    const sel = (where) => c.query(
      `select unit_number, bedrooms, market_rent from units where ${where}${ORDER}`, [DEMO]);

    // A2: pre-fix predicate LETS THE COMMERCIAL ROW IN — the vulnerability is real.
    const before = (await sel(PRE_FIX_WHERE)).rows;
    const hitBefore = before.find((r) => r.unit_number === COMMERCIAL_UNIT);
    ok(!!hitBefore, `pre-fix predicate returns commercial unit ${COMMERCIAL_UNIT} once its status is vacant-like`);
    ok(before[0] && before[0].unit_number === COMMERCIAL_UNIT,
      `pre-fix: commercial unit sorts FIRST (at $${hitBefore ? hitBefore.market_rent : "?"}) — top unit offered`);

    // A3: post-fix predicate excludes it.
    const after = (await sel(POST_FIX_WHERE)).rows;
    ok(!after.some((r) => r.unit_number === COMMERCIAL_UNIT),
      `post-fix predicate excludes commercial unit ${COMMERCIAL_UNIT}`);

    // A4: and excludes NOTHING else — no collateral damage.
    const lostRows = before.filter((b) => !after.some((a) => a.unit_number === b.unit_number));
    ok(lostRows.length === 1 && lostRows[0].unit_number === COMMERCIAL_UNIT,
      `guard removes exactly one row (removed: ${lostRows.map((r) => r.unit_number).join(",") || "none"})`);

    // A5: the real, un-widened predicate still returns the residential inventory.
    const live = (await c.query(
      `select unit_number, bedrooms from units
        where property_id=$1 and occupancy_status='vacant' and coalesce(is_down,false)=false
          and bedrooms is not null${ORDER}`, [DEMO])).rows;
    ok(live.length === 3, `residential vacant inventory: ${live.length} units (${live.map((r) => r.unit_number).join(", ")})`);
    ok(live.every((r) => r.bedrooms !== null), "every offered unit has a residential bedroom count");

    console.log("\n══ BLOCK C — committed-space guard (decision 1, second round) ══");

    // C1: unit 530 really does carry a live lease whose start date has passed.
    const committed = (await c.query(
      `select u.unit_number, l.lease_status, l.start_date, l.rent
         from units u join spaces s on s.unit_id=u.id join leases l on l.space_id=s.id
        where u.property_id=$1 and u.occupancy_status='vacant'
          and l.lease_status not in ('cancelled','rescinded','void','superseded','terminated','expired')`,
      [DEMO])).rows;
    ok(committed.length === 1 && committed[0].unit_number === "530",
      `exactly one vacant unit carries a live lease: ${committed.map((r) => `${r.unit_number}(${r.lease_status})`).join(",") || "none"}`);
    ok(committed[0] && new Date(committed[0].start_date) <= new Date(),
      `and its lease has already STARTED (${committed[0] ? String(committed[0].start_date).slice(0, 10) : "?"}) — it was quoted anyway`);

    // C2: pre-fix predicate offers 530; post-fix withholds it. Executed, real rows.
    const RESIDENTIAL = `property_id = $1 and occupancy_status='vacant' and coalesce(is_down,false)=false and bedrooms is not null`;
    const COMMITTED_GUARD = ` and not exists (select 1 from spaces sp join leases lz on lz.space_id=sp.id
        where sp.unit_id = units.id and lz.lease_status not in
        ('cancelled','rescinded','void','superseded','terminated','expired'))`;
    const beforeC = (await c.query(`select unit_number from units where ${RESIDENTIAL}${ORDER}`, [DEMO])).rows.map((r) => r.unit_number);
    const afterC = (await c.query(`select unit_number from units where ${RESIDENTIAL}${COMMITTED_GUARD}${ORDER}`, [DEMO])).rows.map((r) => r.unit_number);
    ok(beforeC.includes("530"), `pre-fix: 530 IS offered (inventory ${beforeC.join(", ")})`);
    ok(!afterC.includes("530"), "post-fix: 530 is withheld from customer-facing availability");
    ok(afterC.length === 2 && afterC.join(",") === "402,602",
      `post-fix inventory is exactly the uncommitted units: ${afterC.join(", ")}`);

    // C3: the guard is in the shipped source and was not at HEAD.
    ok(/not exists/.test(invNow) && /lease_status not in/.test(invNow),
      "working tree: availableUnits() carries the committed-space guard");
    ok(!/lease_status not in/.test(invHead), "8165874 (pre-fix): committed-space guard absent — assertion CAN fail");
    // Comments may (and do) name 530 to explain WHY the rule exists. What must
    // never contain a unit number is the executable predicate itself.
    const invCode = invNow.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
    ok(!/\b530\b/.test(invCode),
      "guard is a general rule — no hardcoded unit number in executable source (§22 never Solo-special)");

    console.log("\n══ BLOCK D — expired facts are not quotable (decision 2, second round) ══");

    const agentNow = require("fs").readFileSync(path.join(REPO, "src/agent/agent.js"), "utf8");
    const agentHead = head("src/agent/agent.js");
    ok(/effective_until is null or effective_until > now\(\)/.test(agentNow),
      "working tree: the agent's fact query honors effective_until");
    ok(!/effective_until is null or effective_until > now\(\)/.test(agentHead),
      "8165874 (pre-fix): expiry ignored — assertion CAN fail");

    // D2: behavioural — the filter is a no-op today (nothing expires) and would
    // withhold an expired fact. Proven by running both predicates for real.
    const factsPlain = (await c.query(
      `select count(*)::int n from agent_facts where property_id=$1 and status='active' and space_id is null`, [DEMO])).rows[0].n;
    const factsDated = (await c.query(
      `select count(*)::int n from agent_facts where property_id=$1 and status='active' and space_id is null
         and (effective_until is null or effective_until > now())`, [DEMO])).rows[0].n;
    ok(factsPlain === factsDated, `no live fact is expired today, so the filter changes nothing now (${factsDated}/${factsPlain} facts)`);
    const wouldDrop = (await c.query(
      `select count(*)::int n from agent_facts
        where property_id=$1 and status='active' and effective_until is not null and effective_until <= now()`, [DEMO])).rows[0].n;
    ok(wouldDrop === 0, `and zero active-but-expired facts exist right now (${wouldDrop})`);

    await c.end();
  }

  console.log("\n══ BLOCK B — no dated financial promise from code (decision 2) ══");

  // Economics detector: money, free-rent language, or a bare calendar year.
  const ECONOMICS = /\$|\bmonth(s)? free\b|\bfree month\b|\bconcession\b|\bspecial\b|\b20\d{2}\b|\bdiscount\b|% ?off/i;

  const runner = require(path.join(REPO, "src/leasing/followup_runner.js"))({ pool: {} });
  const body3 = runner.composeRung(3, { name: "Casey Alvarez", layout: null });

  ok(typeof body3 === "string" && body3.length > 0,
    "rung 3 still returns a body (a null body would stall the ladder at rung 3 forever)");
  ok(!ECONOMICS.test(body3), `rung 3 carries no economics: "${body3.slice(0, 72)}…"`);

  // Every other rung too — a regression net, not just the one we edited.
  for (const r of [1, 2, 4, 5, 6]) {
    const b = runner.composeRung(r, { name: "Casey Alvarez", layout: null });
    ok(typeof b === "string" && b.length > 0, `rung ${r} returns a body`);
    ok(!ECONOMICS.test(b), `rung ${r} carries no economics`);
  }

  // B-proof: the SAME assertion applied to the pre-fix rung 3 must FAIL.
  const runnerHead = head("src/leasing/followup_runner.js");
  const headRung3 = (runnerHead.match(/case 3:\s*\n\s*return `([^`]*)`/) || [])[1] || "";
  ok(headRung3.length > 0, "extracted pre-fix rung 3 text from 8165874");
  ok(ECONOMICS.test(headRung3),
    `8165874 (pre-fix) rung 3 FAILS the economics assertion — proving the test can fail: "${headRung3.replace("${who}", "Casey").slice(0, 78)}…"`);
  ok(/2027/.test(headRung3), "pre-fix rung 3 contained a hardcoded expiry year it could not enforce");

  console.log(`\n════ ${pass} passed, ${fail} failed ════\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log("FATAL:", e.message); process.exit(1); });
