// ════════════════════════════════════════════════════════════════════
//  PERSON FACTS PROOF — migration 092 + the canonical write service
//
//  Everything runs inside ONE transaction that is ALWAYS ROLLED BACK:
//  the migration is applied, a scratch property and person are created,
//  the service is exercised against the real schema, and then the whole
//  thing is undone. Production is untouched — asserted at the end by
//  re-reading the live column list on a fresh connection.
//
//  FALSIFIABLE. Block 4 is the one that matters: it asserts that a
//  retried capture does NOT retire the value it is not going to replace.
//  That is the zero-active-rows bug — retire first, then swallow the
//  duplicate — which would leave the Person Card blank for a fact the
//  system still holds. If recordPersonFact ever moves its idempotency
//  check after the retire, block 4 goes red.
//
//    DATABASE_URL=... node tests/proofs/person_facts_proof.js
// ════════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Client } = require("pg");
const { recordPersonFact } = require("../../src/identity/person_facts");

const MIGRATION = path.join(__dirname, "..", "..", "migrations", "092_person_attributes_provenance.sql");
const PROP = crypto.randomUUID();
const PERSON = crypto.randomUUID();

let pass = 0, fail = 0;
const chk = (n, c, d = "") => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${d}`)); };

async function activeRows(c, key) {
  return (await c.query(
    `select * from person_attributes
      where person_id=$1::uuid and attr_key=$2::text and status='active'
      order by created_at desc`, [PERSON, key])).rows;
}
async function allRows(c, key) {
  return (await c.query(
    `select * from person_attributes
      where person_id=$1::uuid and attr_key=$2::text order by created_at`, [PERSON, key])).rows;
}

// The live shape BEFORE this harness runs. Block 9 asserts the harness
// changed nothing — measured against this baseline, not against any
// particular value. Asserting "092 is unapplied" would have made the file
// permanently red the moment 092 shipped, and a permanently red harness
// stops being read, which is the same failure as one that cannot fail.
async function baseline() {
  const v = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await v.connect();
  const cols = (await v.query(
    `select count(*)::int n from information_schema.columns
      where table_schema='public' and table_name='person_attributes'
        and column_name in ('occurred_at','occurred_at_basis','actor_type','actor_user_id',
                            'claim_strength','verb','source_record_type','supersedes_id',
                            'correction_reason','idempotency_key')`)).rows[0].n;
  const rows = (await v.query(`select count(*)::int n from person_attributes`)).rows[0].n;
  const props = (await v.query(`select count(*)::int n from properties where name like '__PFACT__%'`)).rows[0].n;
  await v.end();
  return { cols, rows, props };
}

async function main() {
  console.log("═══ PERSON FACTS (migration 092 + recordPersonFact) ═══\n");
  const before = await baseline();
  console.log(`  live schema on entry: ${before.cols}/10 provenance columns, ${before.rows} fact rows`);
  console.log(`  migration 092 is ${before.cols === 10 ? "APPLIED" : "NOT YET APPLIED"} on this database\n`);
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  try {
    await c.query("begin");
    await c.query(fs.readFileSync(MIGRATION, "utf8"));
    await c.query(`insert into properties (id,name) values ($1,$2)`, [PROP, `__PFACT__P ${PROP.slice(0, 8)}`]);
    await c.query(`insert into persons (id,name,phone) values ($1,$2,$3)`,
      [PERSON, "__PFACT__ Prospect", "+1555" + Math.floor(1e6 + Math.random() * 8e6)]);

    // ── 1. a fact carries its whole provenance ────────────────────────
    console.log("─── 1. one fact, fully sourced ───");
    const said = new Date(Date.now() - 2 * 3600e3).toISOString();
    const commEventId = crypto.randomUUID();
    const r1 = await recordPersonFact(c, {
      personId: PERSON, propertyId: PROP, attrKey: "budget", attrValue: "2700",
      source: "ai_conversation", sourceRecordType: "comm_event", sourceRecordId: commEventId,
      occurredAt: said, occurredAtBasis: "source_record",
      actorType: "agent", claimStrength: "asserted", verb: "captured",
      idempotencyKey: `captured:comm_event:${commEventId}:budget`,
    });
    chk("the fact is written", r1.written === true, JSON.stringify(r1.skipped_reason));
    const f1 = r1.row || {};
    chk("WHO recorded it is stored", f1.actor_type === "agent", f1.actor_type);
    chk("HOW SURE we are is stored", f1.claim_strength === "asserted", f1.claim_strength);
    chk("WHAT the writer meant is stored", f1.verb === "captured", f1.verb);
    chk("WHICH TABLE the receipt lives in is stored", f1.source_record_type === "comm_event", f1.source_record_type);
    chk("the receipt id is stored", f1.source_ref === commEventId, f1.source_ref);
    chk("WHEN THEY SAID IT is stored, not when we wrote it",
      f1.occurred_at && new Date(f1.occurred_at).toISOString() === said, String(f1.occurred_at));
    chk("...and it is labelled as a real observation, not a proxy",
      f1.occurred_at_basis === "source_record", f1.occurred_at_basis);
    chk("occurred_at is genuinely EARLIER than recorded time",
      new Date(f1.occurred_at) < new Date(f1.created_at));

    // ── 2. an identical value writes nothing (today's behaviour) ──────
    console.log("\n─── 2. an unchanged value still writes nothing ───");
    const r2 = await recordPersonFact(c, {
      personId: PERSON, propertyId: PROP, attrKey: "budget", attrValue: "2700",
      source: "ai_conversation", sourceRecordType: "comm_event", sourceRecordId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(), occurredAtBasis: "recorded_proxy",
      actorType: "agent", verb: "captured",
    });
    chk("identical value → no write", r2.written === false && r2.skipped_reason === "unchanged", JSON.stringify(r2));
    chk("still exactly one row for the key", (await allRows(c, "budget")).length === 1);

    // ── 3. a changed value supersedes, with lineage ───────────────────
    console.log("\n─── 3. a changed value leaves a chain, not an overwrite ───");
    const r3 = await recordPersonFact(c, {
      personId: PERSON, propertyId: PROP, attrKey: "budget", attrValue: "2900",
      source: "human", sourceRecordType: "leasing_tour", sourceRecordId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(), occurredAtBasis: "recorded_proxy",
      actorType: "unattributed", verb: "captured",
    });
    chk("the new value is written", r3.written === true);
    chk("it points BACK at the row it replaced", r3.row.supersedes_id === f1.id, r3.row.supersedes_id);
    chk("the prior value is retired, not deleted", (await allRows(c, "budget")).length === 2);
    chk("exactly one row is active", (await activeRows(c, "budget")).length === 1);
    const hist = await allRows(c, "budget");
    chk("the OLD value is still readable in history",
      hist.some(r => r.attr_value === "2700" && r.status === "retired"));

    // ── 4. THE ZERO-ACTIVE-ROWS GUARD (the falsifiable one) ───────────
    console.log("\n─── 4. a retried capture must not retire what it will not replace ───");
    const dupKey = `captured:comm_event:${commEventId}:budget`;
    const activeBefore = (await activeRows(c, "budget"))[0];
    const r4 = await recordPersonFact(c, {
      personId: PERSON, propertyId: PROP, attrKey: "budget", attrValue: "3100",
      source: "ai_conversation", sourceRecordType: "comm_event", sourceRecordId: commEventId,
      occurredAt: new Date().toISOString(), occurredAtBasis: "recorded_proxy",
      actorType: "agent", verb: "captured", idempotencyKey: dupKey,
    });
    const activeAfter = await activeRows(c, "budget");
    chk("the retry is refused as a duplicate", r4.written === false && r4.skipped_reason === "duplicate", JSON.stringify(r4));
    chk("the current value is STILL ACTIVE (not retired by the refused retry)",
      activeAfter.length === 1 && activeAfter[0].id === activeBefore.id,
      `active=${activeAfter.length}`);
    chk("the current value is unchanged", activeAfter[0] && activeAfter[0].attr_value === "2900", activeAfter[0] && activeAfter[0].attr_value);

    // ── 5. a re-affirmation can now be recorded ───────────────────────
    console.log("\n─── 5. 'they said it again' is finally recordable ───");
    const r5 = await recordPersonFact(c, {
      personId: PERSON, propertyId: PROP, attrKey: "budget", attrValue: "2900",
      source: "human", sourceRecordType: "leasing_tour", sourceRecordId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(), occurredAtBasis: "recorded_proxy",
      actorType: "unattributed", verb: "confirmed",
    });
    chk("an identical value with verb='confirmed' IS written", r5.written === true, JSON.stringify(r5));
    chk("...and is marked as a confirmation, not a change", r5.row.verb === "confirmed", r5.row.verb);

    // ── 6. a correction is distinguishable from a change ──────────────
    console.log("\n─── 6. 'we were wrong' vs 'it changed' ───");
    const r6 = await recordPersonFact(c, {
      personId: PERSON, propertyId: PROP, attrKey: "budget", attrValue: "2400",
      source: "human", sourceRecordType: "leasing_tour", sourceRecordId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(), occurredAtBasis: "recorded_proxy",
      actorType: "unattributed", verb: "corrected", correctionReason: "typo at capture — they said 2400",
    });
    chk("a correction is written with its reason", r6.written === true && r6.row.verb === "corrected");
    chk("the reason is stored", /typo/.test(r6.row.correction_reason || ""), r6.row.correction_reason);
    let threw = null;
    try {
      await recordPersonFact(c, {
        personId: PERSON, propertyId: PROP, attrKey: "pets", attrValue: "cat",
        source: "human", actorType: "unattributed", verb: "corrected",
      });
    } catch (e) { threw = e.message; }
    chk("a correction WITHOUT a reason is refused", !!threw, String(threw));

    // ── 7. an unnamed operator becomes honest, not invented ───────────
    console.log("\n─── 7. an operator with no name ───");
    const r7 = await recordPersonFact(c, {
      personId: PERSON, propertyId: PROP, attrKey: "unit_type", attrValue: "1BR",
      source: "human", sourceRecordType: "leasing_tour", sourceRecordId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(), occurredAtBasis: "recorded_proxy",
      actorType: "operator", actorUserId: null, verb: "captured",
    });
    chk("'operator' with no user id becomes 'unattributed', not a fabricated id",
      r7.written === true && r7.row.actor_type === "unattributed" && r7.row.actor_user_id === null,
      JSON.stringify({ t: r7.row && r7.row.actor_type, u: r7.row && r7.row.actor_user_id }));

    // ── 8. the pre-092 rows are labelled, not invented ────────────────
    console.log("\n─── 8. the 85 existing facts ───");
    const legacy = (await c.query(
      `select count(*)::int n,
              count(*) filter (where occurred_at_basis='recorded_proxy')::int proxy,
              count(*) filter (where actor_type is null)::int no_actor,
              count(*) filter (where claim_strength is null)::int no_strength
         from person_attributes where verb is null`)).rows[0];
    chk("their occurred time is backfilled AND labelled a proxy",
      legacy.proxy === legacy.n && legacy.n > 0, JSON.stringify(legacy));
    chk("their actor is left NULL — never invented", legacy.no_actor === legacy.n, JSON.stringify(legacy));
    chk("their claim strength is left NULL — never invented", legacy.no_strength === legacy.n, JSON.stringify(legacy));

    await c.query("rollback");
    console.log("\n  ROLLED BACK.");
  } catch (e) {
    await c.query("rollback").catch(() => {});
    console.error("\n  PROOF ERROR:", e.message);
    fail++;
  } finally { await c.end(); }

  // ── 9. production really is untouched ───────────────────────────────
  // The invariant is that this harness CHANGED nothing — compared against
  // the shape read on entry, so it holds whether or not 092 has shipped.
  console.log("\n─── 9. production untouched by this harness ───");
  const after = await baseline();
  chk("the live schema is exactly as it was on entry",
    after.cols === before.cols, `before=${before.cols} after=${after.cols}`);
  chk("no fact row was committed",
    after.rows === before.rows, `before=${before.rows} after=${after.rows}`);
  chk("no scratch property committed", after.props === 0, `n=${after.props}`);
  console.log(`  person_attributes row count: ${after.rows}`);

  console.log(`\n═ RESULT: ${pass} passed, ${fail} failed ═`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error("FATAL:", e); process.exit(1); });
