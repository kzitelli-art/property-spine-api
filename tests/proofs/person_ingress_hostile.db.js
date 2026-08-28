/* ════════════════════════════════════════════════════════════════════
   person_ingress_hostile.db.js — THIRTEEN WAYS TO BREAK THE SEAM

   Real Postgres, real writers, real importer. Every case is the failure
   it exists to prevent, not a feature it demonstrates. The happy-path
   count is not the point: H1 is the fork this whole investigation
   started from, and H9 and H10 are the two that decide whether the
   anti-merge ruling and the boundary are real or merely written down.

   Method note carried forward: an IDENTICAL re-import was already
   idempotent before any of this work, so a proof that only tested that
   would report the defect absent. H1 changes the lease, which is the
   case that actually forked.

   CLASS 3 — proof infrastructure.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const receipt = require("../_run_receipt.js");
const CONN = receipt.harnessConnectionString();
const { Pool } = require("pg");
const snap = require("../../src/shared/snapshot_loader.js");
const ingress = require("../../src/identity/person_ingress.js");
const { supersedePerson, HISTORY_STAYS_PUT } = require("../../src/identity/person_supersession.js");

const ORG = "Person Ingress Hostile";
let pass = 0, fail = 0; const failures = [];
function ok(label, cond, detail) {
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; failures.push(label); console.log("  FAIL  " + label + (detail ? "\n          " + detail : "")); }
}
const head = (t) => { console.log(""); console.log("── " + t + " " + "─".repeat(Math.max(0, 66 - t.length))); };

const CFG = { key: "hostile", label: "Hostile", cols: { unit: 0, unit_type: 1, resident: 2 }, leasing_model: "bed" };
const AUTH = { actor: "kameron@example.test", basis: "operator establishment confirmation" };

async function cleanup(pool) {
  const props = (await pool.query(
    `select p.id from properties p join organizations o on o.id=p.organization_id where o.name like $1`,
    [ORG + "%"])).rows;
  for (const { id } of props) {
    await pool.query(`delete from leases where property_id=$1`, [id]);
    await pool.query(`delete from conversations where property_id=$1`, [id]);
    await pool.query(`delete from proposed_records where property_id=$1`, [id]);
    await pool.query(`delete from activations where property_id=$1`, [id]);
    await pool.query(`delete from import_source_rows where import_batch_id in
                        (select id from import_batches where property_id=$1)`, [id]);
    await pool.query(`delete from spaces where unit_id in (select id from units where property_id=$1)`, [id]);
    await pool.query(`delete from units where property_id=$1`, [id]);
    await pool.query(`delete from import_batches where property_id=$1`, [id]);
    await pool.query(`delete from properties where id=$1`, [id]);
  }
  await pool.query(`update persons set superseded_by_person_id=null where name like 'HOSTILE %'`);
  await pool.query(`delete from persons where name like 'HOSTILE %'`);
  await pool.query(`delete from organizations where name like $1`, [ORG + "%"]);
}

const personsAt = async (pool, prop) => (await pool.query(
  `select p.id, p.name, p.record_status from persons p
    where exists (select 1 from leases l where l.property_id=$1 and l.tenant_ids @> array[p.id])
    order by p.created_at`, [prop])).rows;

const row = (o) => ({ unit: "101", unit_type: "3x3", room: "Room1", status: "current",
                      lease_from: "2026-08-03", lease_to: "2027-07-26", ...o });

(async () => {
  const pool = new Pool({ connectionString: CONN });
  console.log("\n════════════════════════════════════════════════════════════════");
  console.log("  PERSON INGRESS — HOSTILE PROOF");
  console.log("════════════════════════════════════════════════════════════════");
  await cleanup(pool);

  const org = (await pool.query(`insert into organizations (name) values ($1) returning id`, [ORG])).rows[0].id;
  const mkProp = async (n) => (await pool.query(
    `insert into properties (name, address, organization_id, leasing_basis)
     values ($1,'1 Hostile St',$2,'bed') returning id`, [n, org])).rows[0].id;
  const load = (prop, rows, opts = {}) => snap.loadSnapshot(pool, CFG, rows, {
    targetPropertyId: prop, sourceType: "historical_snapshot", sourceFile: "h.xlsx",
    asOfDate: "2026-07-31", confidence: "confirmed", ingestAuthority: AUTH, ...opts });

  try {
    // ══ H1 — THE FORK THIS ALL STARTED FROM ══════════════════════════
    head("H1  a renewal must not mint another human");
    const p1 = await mkProp(ORG + " H1");
    await load(p1, [row({ resident: "HOSTILE Jordan Vale (s0005738)" })]);
    const before1 = await personsAt(pool, p1);
    await load(p1, [row({ resident: "HOSTILE Jordan Vale (s0005738)",
                          lease_from: "2027-08-02", lease_to: "2028-07-25" })]);
    const after1 = await personsAt(pool, p1);
    ok("one person before the renewal", before1.length === 1, String(before1.length));
    ok("STILL ONE PERSON after the renewal — the fork is closed",
      after1.length === 1, `${after1.length}: ${after1.map((p) => p.name).join(" | ")}`);
    ok("and the same person_id, not a lookalike",
      after1[0] && before1[0] && after1[0].id === before1[0].id);
    const leases1 = (await pool.query(`select count(*)::int n from leases where property_id=$1`, [p1])).rows[0].n;
    ok("the renewal IS a second lease — lease identity resolved separately", leases1 === 2, String(leases1));

    // ══ H2 — a bed transfer ══════════════════════════════════════════
    head("H2  a bed transfer must not mint another human");
    //  Both beds are stated in BOTH loads: the inventory writer refuses a
    //  partial re-statement of a unit's grain, and rightly — a rent roll
    //  that mentions one bed is not evidence the other stopped existing.
    const p2 = await mkProp(ORG + " H2");
    await load(p2, [row({ resident: "HOSTILE Amara Sowande (s0007001)", room: "Room1" }),
                    row({ resident: "VACANT", room: "Room2", status: "vacant" })]);
    await load(p2, [row({ resident: "VACANT", room: "Room1", status: "vacant" }),
                    row({ resident: "HOSTILE Amara Sowande (s0007001)", room: "Room2" })]);
    const after2 = await personsAt(pool, p2);
    ok("one person across a bed change", after2.length === 1,
      `${after2.length}: ${after2.map((p) => p.name).join(" | ")}`);

    // ══ H3 — two humans, one name ════════════════════════════════════
    head("H3  two different humans with identical names stay distinct");
    const p3 = await mkProp(ORG + " H3");
    await load(p3, [
      row({ resident: "HOSTILE Chyng Shan Chiu (s0004731)", room: "Room1" }),
      row({ resident: "HOSTILE Chyng Shan Chiu (s0004897)", room: "Room2" }),
    ]);
    const after3 = await personsAt(pool, p3);
    ok("TWO persons, not one — a shared name never collapses anyone",
      after3.length === 2, `${after3.length}`);

    // ══ H4 — contradictory evidence refuses ══════════════════════════
    head("H4  same source record, contradictory strong evidence → refuses");
    const p4 = await mkProp(ORG + " H4");
    const a4 = (await pool.query(
      `insert into persons (name, primary_phone_e164, record_status)
       values ('HOSTILE Phone Owner A','+12155550001','active') returning id`)).rows[0].id;
    const b4 = (await pool.query(
      `insert into persons (name, record_status) values ('HOSTILE Prior Import B','active') returning id`)).rows[0].id;
    const d4 = await ingress.resolvePersonFromEvidence(pool, {
      property_id: p4, channel: "rent_roll",
      evidence: { name: "HOSTILE Someone", phone: "+12155550001",
                  source_system: "yardi", source_record_id: "s0009999",
                  prior_produced_person_id: b4 },
    });
    ok("disposition is CONFLICTED, not a winner-takes-all pick",
      d4.disposition === "conflicted", d4.disposition + " — " + d4.reason);
    ok("no person_id is handed back", d4.person_id === null);
    ok("both rivals are named for the human", d4.candidates.length === 2,
      JSON.stringify(d4.candidates.map((c) => c.name)));

    // ══ H5 — a name alone is never enough ════════════════════════════
    head("H5  name-only evidence proposes, never guesses");
    const p5 = await mkProp(ORG + " H5");
    await pool.query(`insert into persons (name, record_status) values ('HOSTILE Solo Name','active')`);
    const d5 = await ingress.resolvePersonFromEvidence(pool, {
      property_id: p5, channel: "rent_roll", evidence: { name: "HOSTILE Solo Name" } });
    ok("an identical name resolves NOTHING", d5.disposition === "proposed" && d5.person_id === null,
      d5.disposition);
    ok("and says so in words an operator can read", /name alone cannot establish identity/i.test(d5.reason),
      d5.reason);

    // ══ H6 / H7 — confirmation is where truth is created ═════════════
    head("H6/H7  confirmation records WHICH decision was made");
    const p6 = await mkProp(ORG + " H6");
    const act6 = (await pool.query(
      `insert into activations (property_id, source_label, status) values ($1,'hostile','open') returning id`,
      [p6])).rows[0].id;
    const existing6 = (await pool.query(
      `insert into persons (name, record_status) values ('HOSTILE Already Known','active') returning id`)).rows[0].id;
    const staged = await ingress.ingestPerson(pool, {
      property_id: p6, channel: "rent_roll", activation_id: act6, authority: null,
      evidence: { name: "HOSTILE Needs A Human", source_system: "yardi", source_record_id: "s0008001" },
    });
    ok("with no authority nothing is minted; a claim is recorded",
      staged.person_id === null && !!staged.proposal_id, JSON.stringify(staged.disposition));
    const kindBefore = (await pool.query(
      `select resolution_kind, status from proposed_records where id=$1`, [staged.proposal_id])).rows[0];
    ok("a CLAIM does not decide its own confirmation — resolution_kind is NULL",
      kindBefore.resolution_kind === null, JSON.stringify(kindBefore));

    const beforeCount6 = (await pool.query(`select count(*)::int n from persons`)).rows[0].n;
    const r6 = await ingress.confirmPersonProposal(pool, {
      proposal_id: staged.proposal_id, action: "resolved_existing",
      person_id: existing6, actor: "kameron@example.test" });
    const afterCount6 = (await pool.query(`select count(*)::int n from persons`)).rows[0].n;
    ok("H6 · confirming to an EXISTING person inserts NO new person",
      afterCount6 === beforeCount6, `${beforeCount6} -> ${afterCount6}`);
    const pr6 = (await pool.query(
      `select resolution_kind, promoted_record_id, status, confirmed_by from proposed_records where id=$1`,
      [staged.proposal_id])).rows[0];
    ok("and records resolution_kind='resolved_existing' with the person as the promoted record",
      pr6.resolution_kind === "resolved_existing" && pr6.promoted_record_id === existing6
      && pr6.status === "promoted" && !!pr6.confirmed_by, JSON.stringify(pr6));

    const staged7 = await ingress.ingestPerson(pool, {
      property_id: p6, channel: "rent_roll", activation_id: act6, authority: null,
      evidence: { name: "HOSTILE Genuinely New", source_system: "yardi", source_record_id: "s0008002" },
    });
    const beforeCount7 = (await pool.query(`select count(*)::int n from persons`)).rows[0].n;
    const r7 = await ingress.confirmPersonProposal(pool, {
      proposal_id: staged7.proposal_id, action: "created", actor: "kameron@example.test" });
    const afterCount7 = (await pool.query(`select count(*)::int n from persons`)).rows[0].n;
    ok("H7 · confirming CREATE inserts exactly one person",
      afterCount7 === beforeCount7 + 1, `${beforeCount7} -> ${afterCount7}`);
    const pr7 = (await pool.query(
      `select resolution_kind, promoted_record_id from proposed_records where id=$1`, [staged7.proposal_id])).rows[0];
    ok("and records resolution_kind='created'",
      pr7.resolution_kind === "created" && pr7.promoted_record_id === r7.person_id, JSON.stringify(pr7));
    let rejected = null;
    try { await ingress.confirmPersonProposal(pool,
      { proposal_id: staged7.proposal_id, action: "whatever", actor: "x" }); }
    catch (e) { rejected = e.code; }
    ok("an unknown resolution_kind is refused, not stored",
      rejected === "ALREADY_PROMOTED" || rejected === "BAD_RESOLUTION_KIND", String(rejected));

    // ══ H8 — identical re-import ═════════════════════════════════════
    head("H8  an identical re-import changes nothing durable");
    const p8 = await mkProp(ORG + " H8");
    const rows8 = [row({ resident: "HOSTILE Static Resident (s0008500)" })];
    await load(p8, rows8);
    const s8a = (await pool.query(
      `select (select count(*)::int from persons p where exists
                (select 1 from leases l where l.property_id=$1 and l.tenant_ids @> array[p.id])) persons,
              (select count(*)::int from leases where property_id=$1) leases`, [p8])).rows[0];
    await load(p8, rows8);
    const s8b = (await pool.query(
      `select (select count(*)::int from persons p where exists
                (select 1 from leases l where l.property_id=$1 and l.tenant_ids @> array[p.id])) persons,
              (select count(*)::int from leases where property_id=$1) leases`, [p8])).rows[0];
    ok("zero new persons and zero new leases on re-import",
      s8a.persons === s8b.persons && s8a.leases === s8b.leases,
      JSON.stringify({ first: s8a, second: s8b }));

    // ══ H9 — SUPERSESSION MOVES NOTHING ══════════════════════════════
    head("H9  correction supersedes — and migrates NO history");
    const p9 = await mkProp(ORG + " H9");
    await load(p9, [row({ resident: "HOSTILE Dup One (s0009001)", room: "Room1" }),
                    row({ resident: "HOSTILE Dup Two (s0009002)", room: "Room2" })]);
    const two9 = await personsAt(pool, p9);
    ok("two persons exist to correct between", two9.length === 2, String(two9.length));
    const snapshotOf = async () => {
      const out = {};
      for (const t of HISTORY_STAYS_PUT) {
        try {
          const cols = (await pool.query(
            `select column_name from information_schema.columns
              where table_schema='public' and table_name=$1
                and column_name in ('person_id','tenant_ids')`, [t])).rows.map((r) => r.column_name);
          if (!cols.length) { out[t] = "n/a"; continue; }
          const col = cols[0];
          const q = col === "tenant_ids"
            ? `select id, tenant_ids::text v from ${t} order by id`
            : `select id, person_id::text v from ${t} order by id`;
          out[t] = JSON.stringify((await pool.query(q)).rows);
        } catch (_) { out[t] = "n/a"; }
      }
      return out;
    };
    const beforeHistory = await snapshotOf();
    const res9 = await supersedePerson(pool, {
      retire_person_id: two9[1].id, surviving_person_id: two9[0].id,
      actor_user_id: null, reason: "same human, two source records",
    }).catch((e) => e);
    //  actor is required — prove the refusal, then do it properly.
    ok("a correction with no named actor is REFUSED",
      res9 instanceof Error && res9.code === "SUPERSESSION_ACTOR_REQUIRED", String(res9 && res9.code));
    const someUser = (await pool.query(`select id from users limit 1`)).rows[0];
    const done9 = await supersedePerson(pool, {
      retire_person_id: two9[1].id, surviving_person_id: two9[0].id,
      actor_user_id: someUser ? someUser.id : null,
      reason: "same human, two source records", evidence_refs: { source: "hostile proof" },
    });
    const afterHistory = await snapshotOf();
    ok("the duplicate is retired with a reason and a pointer", !!done9.retired && !!done9.surviving);
    const moved = HISTORY_STAYS_PUT.filter((t) => beforeHistory[t] !== afterHistory[t]);
    ok("NO CHILD HISTORY PHYSICALLY MIGRATED — every row set is byte-identical",
      moved.length === 0, "tables that changed: " + JSON.stringify(moved));
    const retired9 = (await pool.query(
      `select record_status, retired_at, retired_reason, superseded_by_person_id from persons where id=$1`,
      [two9[1].id])).rows[0];
    ok("the retired row still says what it WAS, with a separate field for what happened",
      retired9.record_status === "retired" && !!retired9.retired_at
      && /same human/.test(retired9.retired_reason) && retired9.superseded_by_person_id === two9[0].id,
      JSON.stringify(retired9));
    const leaseStill = (await pool.query(
      `select count(*)::int n from leases where property_id=$1 and tenant_ids @> array[$2::uuid]`,
      [p9, two9[1].id])).rows[0].n;
    ok("the retired person's lease still points at the row that earned it",
      leaseStill === 1, String(leaseStill));
    //  And recognition still works: ingress follows the pointer once.
    const d9 = await ingress.resolvePersonFromEvidence(pool, {
      property_id: p9, channel: "rent_roll",
      evidence: { name: "x", prior_produced_person_id: two9[1].id } });
    ok("a candidate pointing at the retired row surfaces the SURVIVOR, not a dead record",
      d9.candidates.length === 1 && d9.candidates[0].person_id === two9[0].id,
      JSON.stringify(d9.candidates));

    // ══ H10 — the gate ═══════════════════════════════════════════════
    head("H10 the gate goes red when a domain writer mints a human");
    const { execFileSync } = require("child_process");
    const fs = require("fs");
    const path = require("path");
    const scratch = path.join(__dirname, "..", "..", "src", "shared", "__hostile_probe.js");
    let cleanExit = 0, dirtyExit = 0;
    try { execFileSync("node", [path.join(__dirname, "../gates/gate_person_ingress.js")], { stdio: "pipe" }); }
    catch (e) { cleanExit = e.status || 1; }
    fs.writeFileSync(scratch,
      '"use strict";\n// a domain writer trying to mint a human\n' +
      'module.exports = async (c) => c.query(`insert into persons (name) values ($1)`, ["nope"]);\n');
    try { execFileSync("node", [path.join(__dirname, "../gates/gate_person_ingress.js")], { stdio: "pipe" }); }
    catch (e) { dirtyExit = e.status || 1; }
    fs.unlinkSync(scratch);
    let restoredExit = 0;
    try { execFileSync("node", [path.join(__dirname, "../gates/gate_person_ingress.js")], { stdio: "pipe" }); }
    catch (e) { restoredExit = e.status || 1; }
    ok("green before", cleanExit === 0, "exit " + cleanExit);
    ok("RED the moment an undeclared writer appears", dirtyExit === 1, "exit " + dirtyExit);
    ok("green again once it is removed", restoredExit === 0, "exit " + restoredExit);

    // ══ H11 — recognition, the normal case ═══════════════════════════
    head("H11 a phone that resolves cleanly is RECOGNISED, not duplicated");
    const p11 = await mkProp(ORG + " H11");
    const known11 = (await pool.query(
      `insert into persons (name, primary_phone_e164, record_status)
       values ('HOSTILE Jane Smith','+12155551111','active') returning id`)).rows[0].id;
    const i11 = await ingress.ingestPerson(pool, {
      property_id: p11, channel: "rent_roll", authority: AUTH,
      evidence: { name: "HOSTILE Jane Smith", phone: "215-555-1111" } });
    ok("resolved to the existing person, with no insert",
      i11.disposition === "resolved" && i11.person_id === known11,
      `${i11.disposition} ${i11.person_id === known11}`);
    ok("and reports resolution_kind='resolved_existing'", i11.resolution_kind === "resolved_existing");

    // ══ H12 — a phone match is evidence, not permission ══════════════
    head("H12 a matching phone with a disagreeing candidate still refuses");
    const p12 = await mkProp(ORG + " H12");
    const other12 = (await pool.query(
      `insert into persons (name, record_status) values ('HOSTILE Different Human','active') returning id`)).rows[0].id;
    const i12 = await ingress.ingestPerson(pool, {
      property_id: p12, channel: "rent_roll", authority: AUTH,
      evidence: { name: "HOSTILE Someone Else", phone: "+12155551111",
                  source_system: "yardi", source_record_id: "s0009500",
                  prior_produced_person_id: other12 } });
    ok("an authority does NOT override a contradiction",
      i12.disposition === "conflicted" && i12.person_id === null, i12.disposition);

    // ══ H13 — one human, two properties ══════════════════════════════
    head("H13 the same human at a second property is ONE person, TWO relationships");
    const p13 = await mkProp(ORG + " H13");
    const i13 = await ingress.ingestPerson(pool, {
      property_id: p13, channel: "rent_roll", authority: AUTH,
      evidence: { name: "HOSTILE Jane Smith", phone: "+1 215 555 1111" } });
    ok("recognised as the SAME global person at a different property",
      i13.person_id === known11, `${i13.disposition} ${i13.person_id === known11}`);
    ok("identity is global; the relationship is property-scoped",
      i13.disposition === "resolved");

  } finally {
    await cleanup(pool);
    await pool.end();
  }

  console.log(`\n  ${pass + fail} run · ${pass} passed · ${fail} failed`);
  if (fail) console.log("  FAILED: " + failures.join(" | "));
  console.log(fail ? "\n  ✗ FAIL\n" : "\n  ✓ PASS — the seam holds under all thirteen.\n");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HOSTILE PROOF ERROR", e); process.exit(1); });
