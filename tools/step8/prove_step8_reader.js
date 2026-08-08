#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   STEP 8 — PROVE THE FOUR-STATE PROOF READER

   The reader is where every earlier step becomes visible to a human. If
   it collapses legacy history into "proof failed", the release has
   rebuilt the exact ambiguity it exists to remove — a closed work order
   with nothing behind it, indistinguishable from a real one.

   ── WHAT IS PROVEN ──────────────────────────────────────────────────

     E   the four states, each from real rows
     U   `unavailable` is the READ failing, not a fifth state — and
         `state`/`satisfied` are ABSENT, not null
     H   the hole §3.2.0 closed: closed + NOT inventoried must NOT escape
     B   both shapes carry `state` (§3.3), and agree
     C   the frozen compatibility mapping (§3.4), including that legacy
         and defect are BOTH `satisfied: null` and are NOT collapsed
     W   the reader writes nothing, ever (§4.2)

   ⚠ ISOLATED POSTGRES ONLY. Needs schema 137.

   usage:
     bash tools/steps23/baseline_136.sh
     PROVE_DATABASE_URL='...' node tools/steps23/apply_137.js
     STEP8_DATABASE_URL='postgresql://postgres@127.0.0.1:5433/r0scale?sslmode=disable' \
       node tools/step8/prove_step8_reader.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const path = require("path");
const crypto = require("crypto");
const { Client } = require("pg");

const ROOT = path.join(__dirname, "..", "..");
const reader = require(path.join(ROOT, "src/surfaces/work_order_status_read.js"));
const proofState = require(path.join(ROOT, "src/release0/proof_state.js"));
const activation = require(path.join(ROOT, "src/release0/activation_service.js"));
//  migration 140 REFUSES to let recordActivation run without it, so a
//  harness that activates must install it. States the guard forbids are
//  then built inside an explicit withGuardOff() window.
const guardWindow = require("../step12/guard_window.js");
const grounded = require("../step12/grounded_evaluation.js");
const URL = process.env.STEP8_DATABASE_URL;

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };
const sec = (t) => console.log(`\n${"═".repeat(66)}\n  ${t}\n${"═".repeat(66)}`);

const ID = (n) => crypto.createHash("md5").update("step8:" + n).digest("hex")
  .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5");
const ORG = ID("org"), PROP = ID("prop"), TECH = ID("tech");
const STEP6_INSTANT = new Date(Date.parse("2026-08-08T09:15:00.000Z"));

(async function main() {
  if (!URL) { console.error("REFUSED: STEP8_DATABASE_URL is not set."); process.exit(1); }
  const c = new Client({ connectionString: URL });
  await c.connect();
  const sentinel = Number((await c.query(
    `select count(*) n from release_0_scale_harness_guard where purpose like 'ISOLATED RELEASE 0%'`
  ).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n);
  if (sentinel !== 1) { console.error("REFUSED: not the isolated baseline."); process.exit(2); }
  const ledger = (await c.query(`select max(version) v from schema_migrations`)).rows[0].v;
  if (ledger !== "137") { console.error(`REFUSED: ledger ${ledger}, expected 137.`); process.exit(2); }
  const dirty = Number((await c.query(`select count(*) n from release_0_activation_history`)).rows[0].n);
  if (dirty > 0) {
    console.error("REFUSED: activation history is not empty. This proof needs to observe");
    console.error("         the reader BEFORE and AFTER activation, and the record is");
    console.error("         append-only. Rebuild the baseline.");
    process.exit(3);
  }
  await c.query("set lock_timeout = '8s'");
  await c.query("set statement_timeout = '60s'");

  /*  Installed BEFORE any row exists, and deliberately before the
   *  activation: migration 140 is inert until an activation row is
   *  present, and everything section U builds below is built with the
   *  guard already in place. Section U passing is that inertness. */
  await guardWindow.installGuard(c);
  const forbidden = (why, fn) => guardWindow.withGuardOff(c, why, fn);

  console.log("STEP 8 — FOUR-STATE PROOF READER — isolated postgres\n");

  await c.query(`insert into organizations (id,name) values ($1,'S8 Org') on conflict (id) do nothing`, [ORG]);
  await c.query(`insert into properties (id,name,organization_id) values ($1,'S8 Property',$2)
                 on conflict (id) do nothing`, [PROP, ORG]);
  await c.query(`insert into users (id,name,phone,role,is_active)
                 values ($1,'Sid Step8','+15415559501','maintenance',true) on conflict (id) do nothing`, [TECH]);

  let seq = 0;
  const mkWo = async ({ status = "open", photo = null, note = null } = {}) => {
    const wo = ID("wo" + (++seq));
    await c.query(`insert into work_orders (id,property_id,title,status,source,completion_photo,completion_note)
                   values ($1,$2,'step8',$3,'step8proof',$4,$5)`, [wo, PROP, status, photo, note]);
    await c.query(`insert into obligations (property_id,related_id,related_type,module,type,label,status)
                   values ($1,$2,'work_order','maintenance','work_order_routing','r','open')`, [PROP, wo]);
    return wo;
  };
  /*  A `satisfied` evaluation must now CITE qualifying evidence — the
   *  guard stopped trusting the word (R0004). `not_satisfied` needs no
   *  evidence: it is a refusal, and a refusal that required proof of the
   *  thing it is refusing would be nonsense. */
  const evaluate = async (wo, state) => {
    if (state === "satisfied") {
      await grounded.groundedSatisfied(c, {
        work_order_id: wo, property_id: PROP, uploaded_by_user_id: TECH,
        evaluated_by_service: "step8proof" });
      return;
    }
    await c.query(`insert into work_order_proof_evaluations
      (work_order_id,property_id,state,evaluated_by_service,rule_version)
      values ($1,$2,$3,'step8proof','x')`, [wo, PROP, state]);
  };
  /*  A GOVERNED COMPLETION NEEDS NO WINDOW — status and evaluation land in
   *  ONE transaction. Either statement alone would commit a terminal row
   *  with no proof, but migration 140's checks are DEFERRED and judge only
   *  the state at COMMIT. This exercises that property instead of merely
   *  asserting it, and it is the same shape the canonical writer uses. */
  const completeGoverned = async (status) => {
    await c.query("begin");
    try {
      const wo = await mkWo({ status });
      await evaluate(wo, "satisfied");
      await c.query("commit");
      return wo;
    } catch (e) { await c.query("rollback").catch(() => {}); throw e; }
  };
  const photo = async (wo) => {
    const att = ID("att" + wo.slice(0, 8)), bytes = Buffer.from([8, 8, 8, 8]);
    await c.query(`insert into work_order_proof_attachments
      (id,work_order_id,property_id,uploaded_by_user_id,provider,provider_media_id,mime_type,
       storage_state,proof_classification,content,byte_size,sha256,stored_at)
      values ($1,$2,$3,$4,'twilio',$5,'image/jpeg','stored','repair_photo',$6,$7,$8,now())`,
      [att, wo, PROP, TECH, "ME" + att.slice(0, 8), bytes, bytes.length,
       crypto.createHash("sha256").update(bytes).digest("hex")]);
  };
  const read = (wo) => reader.readWorkOrderStatus(c, { propertyId: PROP, workOrderId: wo });

  // ══ U — BEFORE ACTIVATION: THE READ IS UNAVAILABLE ═════════════════
  sec("U · WITHOUT AN ACTIVATION, THE READ IS UNAVAILABLE — not a fifth state");
  const preTerminal = await mkWo({ status: "closed", photo: "stub://x/1", note: "n" });
  {
    const s = await read(preTerminal);
    ok("U1  read_status is 'unavailable'", s.proof.read_status === "unavailable",
       JSON.stringify(s.proof.read_status));
    ok("U2  …with reason_code activation_absent",
       s.proof.reason_code === "activation_absent", JSON.stringify(s.proof.reason_code));
    /*  ABSENT, not null. A null `state` would still be a key a consumer
     *  has to interpret; the contract says the key is not there. */
    ok("U3  `state` is ABSENT — not null, not 'unavailable'",
       !("state" in s.proof), JSON.stringify(Object.keys(s.proof)));
    ok("U4  `satisfied` is ABSENT too", !("satisfied" in s.proof));
    ok("U5  it did NOT fall back to missing_evaluation_defect",
       s.proof.state !== "missing_evaluation_defect",
       "a reader deployed before activation would raise a writer-defect on EVERY " +
       "terminal work order the moment it shipped");
    ok("U6  legacy_evidence still travels — presence booleans only",
       s.proof.legacy_evidence.column_photo_present === true &&
       s.proof.legacy_evidence.column_note_present === true &&
       !JSON.stringify(s.proof.legacy_evidence).includes("stub://"),
       JSON.stringify(s.proof.legacy_evidence));
  }

  // ── activate, with the terminal row above in the inventory ──────────
  const census = await activation.readLegacyTerminalSet(c);
  await c.query("begin");
  await activation.recordActivation(c, {
    activated_at: STEP6_INSTANT, captured_by: "step8 proof", expected: census });
  await c.query("commit");
  console.log(`\n  (activated; ${census.length} row(s) inventoried)`);

  // ══ E — THE FOUR STATES ════════════════════════════════════════════
  sec("E · EACH OF THE FOUR STATES, FROM REAL ROWS");
  {
    const s = await read(preTerminal);
    ok("E1  terminal + no evaluation + INVENTORIED → legacy_indeterminate",
       s.proof.read_status === "ok" && s.proof.state === "legacy_indeterminate",
       JSON.stringify({ rs: s.proof.read_status, st: s.proof.state }));

    //  Created AFTER activation, so it is terminal and NOT inventoried.
    //  That is precisely the row migration 140 refuses to let commit, so
    //  the reader can only be shown it with the guard explicitly off.
    const afterCutover = await forbidden(
      "E2 must EXHIBIT missing_evaluation_defect; the guard forbids creating it",
      () => mkWo({ status: "closed" }));
    const d = await read(afterCutover);
    ok("E2  terminal + no evaluation + NOT inventoried → missing_evaluation_defect",
       d.proof.state === "missing_evaluation_defect", JSON.stringify(d.proof.state));

    const done = await completeGoverned("complete");
    const ds = await read(done);
    ok("E3  an evaluation head of `satisfied` → satisfied", ds.proof.state === "satisfied",
       JSON.stringify(ds.proof.state));

    //  Terminal with a FAILED evaluation. Adversarial case A1: the guard
    //  refuses this because Release 0 governs completion, not whether
    //  somebody made a judgement.
    const refused = await forbidden(
      "E4 must EXHIBIT terminal + not_satisfied; the guard forbids it (A1)",
      async () => {
        const wo = await mkWo({ status: "complete" });
        await evaluate(wo, "not_satisfied");
        return wo;
      });
    const rs = await read(refused);
    ok("E4  an evaluation head of `not_satisfied` → not_satisfied",
       rs.proof.state === "not_satisfied", JSON.stringify(rs.proof.state));

    //  The head wins even on a row that is ALSO inventoried — an evaluation
    //  is a stronger fact than membership of a historical set.
    /*  `complete`, not `closed`: post-cutover `closed` is refused outright
     *  (R0003) now that it is historical vocabulary only. E5 is about an
     *  evaluation head outranking inventory membership, and that question
     *  is unchanged by which terminal word the row carries.
     *
     *  `status_at_cutover` matches the row's actual status — the guard
     *  pins an inventoried row to what the census recorded, so a fixture
     *  claiming 'closed' for a `complete` row would be asserting on a
     *  state the census could never have produced. */
    const both = await completeGoverned("complete");
    await c.query(`insert into release_0_legacy_cutover_inventory
      (work_order_id,property_id,status_at_cutover,had_column_photo,had_column_note,activation_id)
      values ($1,$2,'complete',false,false,(select id from release_0_activation_current))
      on conflict do nothing`, [both, PROP]);
    const bs = await read(both);
    ok("E5  an evaluation head OUTRANKS inventory membership",
       bs.proof.state === "satisfied", JSON.stringify(bs.proof.state));

    ok("E6  every state emitted is one of exactly four",
       [s, d, ds, rs, bs].every((x) => proofState.PROOF_STATES.includes(x.proof.state)),
       JSON.stringify([s, d, ds, rs, bs].map((x) => x.proof.state)));
  }

  // ══ N — NOT TERMINAL: PROOF IS NOT YET DUE ═════════════════════════
  sec("N · A WORK ORDER THAT IS NOT TERMINAL IS NEVER A DEFECT");
  {
    const openNoEvidence = await mkWo({ status: "open" });
    const a = await read(openNoEvidence);
    ok("N1  open + no evidence → not_satisfied, never a defect",
       a.proof.state === "not_satisfied", JSON.stringify(a.proof.state));

    const openWithPhoto = await mkWo({ status: "open" });
    await photo(openWithPhoto);
    const b = await read(openWithPhoto);
    ok("N2  open + preserved evidence → satisfied (reflects current evidence)",
       b.proof.state === "satisfied", JSON.stringify(b.proof.state));
    ok("N3  neither is legacy_indeterminate or missing_evaluation_defect",
       ![a, b].some((x) => ["legacy_indeterminate", "missing_evaluation_defect"].includes(x.proof.state)));

    //  §3.1 — the corrected classification array. An unclassified photo is
    //  not proof of a repair, and the READER must agree with the WRITER.
    const openUnclassified = await mkWo({ status: "open" });
    const att = ID("attU"), bytes = Buffer.from([1, 2, 3, 4]);
    await c.query(`insert into work_order_proof_attachments
      (id,work_order_id,property_id,uploaded_by_user_id,provider,provider_media_id,mime_type,
       storage_state,proof_classification,content,byte_size,sha256,stored_at)
      values ($1,$2,$3,$4,'twilio',$5,'image/jpeg','stored','unclassified',$6,$7,$8,now())`,
      [att, openUnclassified, PROP, TECH, "MEu", bytes, bytes.length,
       crypto.createHash("sha256").update(bytes).digest("hex")]);
    const u = await read(openUnclassified);
    ok("N4  an UNCLASSIFIED photo does not make the read satisfied (§3.1)",
       u.proof.state === "not_satisfied", JSON.stringify(u.proof.state) +
       " — the reader still carries the old array and disagrees with the writer");
  }

  // ══ H — THE HOLE §3.2.0 CLOSED ═════════════════════════════════════
  sec("H · CLOSED + NOT INVENTORIED MUST NOT ESCAPE DEFECT DETECTION");
  {
    /*  Revision 3 defined terminal as "complete, or closed FOR AN
     *  INVENTORIED ROW". Under that definition a closed, uninventoried,
     *  unevaluated row was not terminal, escaped the defect state, and
     *  rendered as if the work were merely unstarted — precisely the row a
     *  surviving legacy writer creates after activation. */
    const escapee = await forbidden(
      "H must EXHIBIT the surviving-legacy-writer row the guard now refuses",
      () => mkWo({ status: "closed" }));
    const s = await read(escapee);
    ok("H1  a closed, uninventoried, unevaluated row IS terminal to the reader",
       proofState.isTerminal({ status: "closed" }));
    ok("H2  …and reads missing_evaluation_defect, not a not-yet-due state",
       s.proof.state === "missing_evaluation_defect", JSON.stringify(s.proof.state));
    ok("H3  `complete` and `closed` are both terminal",
       proofState.isTerminal({ status: "complete" }) && proofState.isTerminal({ status: "closed" }) &&
       !proofState.isTerminal({ status: "open" }) && !proofState.isTerminal({ status: "needs_followup" }));
    /*  Strip comments first. The module's own header explains that no
     *  timestamp comparison is used — and says the words "completed_at" to
     *  do it. The first version of this assertion matched that prose and
     *  reported a timestamp comparison that does not exist. Same defect as
     *  a source scan that finds its own tombstones: assert on the LIVE
     *  code, never on the text describing it. */
    const psSrc = require("fs").readFileSync(path.join(ROOT, "src/release0/proof_state.js"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    ok("H4  NO timestamp comparison decides legitimacy, in the LIVE code",
       !/completed_at/.test(psSrc) && !/activated_at\s*[<>]/.test(psSrc),
       "membership is the discriminator; a timestamp comparison reopens the " +
       "missing-completed_at gap");
    ok("H5  …and the stripper left real code behind, so H4 is not vacuous",
       psSrc.includes("deriveProofState") && psSrc.length > 400,
       "the comment stripper ate the module — H4 would pass on an empty string");
  }

  // ══ C — THE FROZEN COMPATIBILITY MAPPING ═══════════════════════════
  sec("C · §3.4 — AND LEGACY IS NOT COLLAPSED INTO DEFECT");
  {
    const rows = {};
    //  `satisfied` is a governed completion and needs no window. The other
    //  three of the four states are, post-activation, states the guard
    //  refuses to let a transaction commit — which is why building this
    //  table takes a guard-off window at all.
    rows.satisfied = (await read(await completeGoverned("complete"))).proof;
    const [refusedWo, defectWo] = await forbidden(
      "C tabulates all four states side by side; two of them are forbidden states",
      async () => {
        const r = await mkWo({ status: "complete" });
        await evaluate(r, "not_satisfied");
        const d = await mkWo({ status: "closed" });
        return [r, d];
      });
    rows.not_satisfied = (await read(refusedWo)).proof;
    rows.legacy = (await read(preTerminal)).proof;
    rows.defect = (await read(defectWo)).proof;

    /*  ── THE COMPATIBILITY FIELD IS RETIRED ────────────────────────
     *  C1–C4 asserted the §3.4 booleans on the wire. The cleanup release
     *  removes `satisfied` from the response entirely, so they now assert
     *  its ABSENCE and check the mapping where it still lives — the
     *  exported constant consumers derive from.
     *
     *  The mapping is not gone. It is the definition; only its
     *  duplication on every response is.  */
    for (const [label, row] of [["satisfied", rows.satisfied],
                                ["not_satisfied", rows.not_satisfied],
                                ["legacy_indeterminate", rows.legacy],
                                ["missing_evaluation_defect", rows.defect]]) {
      ok(`C·${label.padEnd(26)} carries NO \`satisfied\` on the wire`,
         !("satisfied" in row), JSON.stringify(row.satisfied) +
         " — the compatibility field was retired; a consumer derives it from state");
      ok(`C·${label.padEnd(26)} still carries \`state\``, row.state === label,
         JSON.stringify(row.state));
    }
    //  The frozen mapping is still the definition, and still frozen.
    ok("C4a the §3.4 mapping is still exported, unchanged",
       proofState.SATISFIED_FOR.satisfied === true &&
       proofState.SATISFIED_FOR.not_satisfied === false &&
       proofState.SATISFIED_FOR.legacy_indeterminate === null &&
       proofState.SATISFIED_FOR.missing_evaluation_defect === null,
       JSON.stringify(proofState.SATISFIED_FOR) +
       " — retiring the FIELD must not change the MEANING");
    ok("C4b …and null still means null, never false",
       proofState.SATISFIED_FOR.legacy_indeterminate === null &&
       proofState.SATISFIED_FOR.missing_evaluation_defect === null,
       JSON.stringify(rows.defect.satisfied));
    /*  The one that matters. Both are `null`, so `satisfied` alone CANNOT
     *  distinguish them — which is exactly why §3.3 requires `state` on
     *  both shapes. If a consumer had only the boolean it would render
     *  legitimate history and a writer defect identically. */
    ok("C5  legacy and defect are indistinguishable by the MAPPING alone…",
       proofState.SATISFIED_FOR[rows.legacy.state] ===
       proofState.SATISFIED_FOR[rows.defect.state]);
    ok("C6  …and ARE distinguished by `state`",
       rows.legacy.state !== rows.defect.state,
       "legacy history and a writer defect have collapsed into one rendering");
    ok("C7  a defect row with no evidence is NOT reported as 'proof failed'",
       rows.defect.preserved_count === 0 &&
       rows.defect.state === "missing_evaluation_defect" &&
       proofState.SATISFIED_FOR[rows.defect.state] === null,
       "a defect row with no evidence must not read not_satisfied, which an " +
       "evidence-presence boolean would have produced");
  }

  // ══ B — BOTH SHAPES ════════════════════════════════════════════════
  sec("B · §3.3 — THE LIST CARRIES `state` TOO, AND AGREES WITH THE DETAIL");
  {
    const list = await reader.readPropertyWorkOrderStatuses(c, { propertyId: PROP, limit: 100 });
    ok("B1  the list returned rows", list.length > 0, String(list.length));
    ok("B2  every list row carries read_status",
       list.every((r) => typeof r.proof.read_status === "string"));
    ok("B3  every list row carries `state` and `legacy_evidence`",
       list.every((r) => "state" in r.proof && "legacy_evidence" in r.proof),
       JSON.stringify(list.find((r) => !("state" in r.proof)) || null));

    //  The two surfaces must not disagree — that disagreement is what §19
    //  Ruling 2 exists to prevent.
    let agreed = 0, disagreed = [];
    for (const r of list) {
      // eslint-disable-next-line no-await-in-loop
      const d = await read(r.work_order.id);
      if (d.proof.state === r.proof.state && d.proof.satisfied === r.proof.satisfied) agreed++;
      else disagreed.push({ id: r.work_order.id, list: r.proof.state, detail: d.proof.state });
    }
    ok("B4  every list row agrees with its detail read", disagreed.length === 0,
       JSON.stringify(disagreed));
    console.log("        " + agreed + " row(s) compared, list vs detail");
    ok("B5  the list shows more than one distinct state — it is not uniform by accident",
       new Set(list.map((r) => r.proof.state)).size >= 3,
       JSON.stringify([...new Set(list.map((r) => r.proof.state))]));
  }

  // ══ W — THE READER WRITES NOTHING ══════════════════════════════════
  sec("W · §4.2 — THE READER WRITES NOTHING, EVER");
  {
    const before = {};
    for (const t of ["work_orders", "work_order_proof_evaluations",
                     "release_0_legacy_cutover_inventory", "release_0_activation_history",
                     "obligations", "events"]) {
      // eslint-disable-next-line no-await-in-loop
      before[t] = Number((await c.query(`select count(*) n from ${t}`)).rows[0].n);
    }
    await reader.readPropertyWorkOrderStatuses(c, { propertyId: PROP, limit: 100 });
    await read(preTerminal);
    const after = {};
    for (const t of Object.keys(before)) {
      // eslint-disable-next-line no-await-in-loop
      after[t] = Number((await c.query(`select count(*) n from ${t}`)).rows[0].n);
    }
    ok("W1  a full list read and a detail read change NO row count",
       JSON.stringify(before) === JSON.stringify(after), JSON.stringify({ before, after }));

    /*  §4.2 says the reader raises an obligation for a defect. It does NOT
     *  say the READER writes it — a read that writes is a read that cannot
     *  be run twice, cached, or executed on a replica. The sweep is a
     *  separate governed writer and is NOT built here. Asserted so nobody
     *  later "helpfully" adds the insert to the reader. */
    const src = require("fs").readFileSync(path.join(ROOT, "src/release0/proof_state.js"), "utf8");
    ok("W2  the derivation contains no INSERT, UPDATE or DELETE",
       !/\b(insert\s+into|update\s+\w+\s+set|delete\s+from)\b/i.test(src),
       "the reader has started writing — §4.2's obligation is the SWEEP's job");
  }

  // ══ X — THE APP NORMALIZER'S CONTRACT, FROM THE EMITTING SIDE ══════
  sec("X · THE API NEVER EMITS WHAT THE APP CALLS A CONTRACT FAILURE");
  {
    /*  §3.4 names four conditions for the app's normalizer. One is an
     *  EXPECTED condition; three are contract failures — a bug on THIS
     *  side, logged as such by the app.
     *
     *      read_status = "unavailable"          expected, renders unavailable
     *      state present, not one of four       CONTRACT FAILURE
     *      state absent while read_status "ok"  CONTRACT FAILURE
     *      state/satisfied mismatch             CONTRACT FAILURE
     *
     *  The app already proves it HANDLES all four (proof_normalizer_contract
     *  .test.js, step 1). Nothing proved the API cannot PRODUCE the three
     *  failures. Asserted here over every row both shapes emit, because a
     *  contract failure that only appears on one work order in production
     *  is exactly the one nobody catches. */
    const list = await reader.readPropertyWorkOrderStatuses(c, { propertyId: PROP, limit: 100 });
    const details = [];
    for (const r of list) {
      // eslint-disable-next-line no-await-in-loop
      details.push((await read(r.work_order.id)).proof);
    }
    const every = [...list.map((r) => r.proof), ...details];
    ok("X0  there are rows to check, on both shapes", every.length >= 2 * list.length && list.length > 0,
       String(every.length));

    const badState = every.filter(
      (p) => "state" in p && !proofState.PROOF_STATES.includes(p.state));
    ok("X1  never a `state` outside the four", badState.length === 0, JSON.stringify(badState));

    const absentState = every.filter((p) => p.read_status === "ok" && !("state" in p));
    ok("X2  never `state` absent while read_status is 'ok'",
       absentState.length === 0, JSON.stringify(absentState));

    /*  A state/satisfied MISMATCH is unrepresentable once the field is
     *  gone — there is nothing to disagree with. So the assertion becomes
     *  the stronger one the removal makes available: the field never
     *  appears at all, on any shape, in any state. */
    const stillEmitting = every.filter((p) => "satisfied" in p);
    ok("X3  `satisfied` never appears on any shape — a mismatch is now unrepresentable",
       stillEmitting.length === 0, JSON.stringify(stillEmitting));

    const leaky = every.filter(
      (p) => p.read_status === "unavailable" && (("state" in p) || ("satisfied" in p)));
    ok("X4  when unavailable, BOTH keys are absent", leaky.length === 0, JSON.stringify(leaky));

    ok("X5  `legacy_evidence` carries presence booleans and no content",
       every.every((p) => !p.legacy_evidence ||
         (typeof p.legacy_evidence.column_photo_present === "boolean" &&
          typeof p.legacy_evidence.column_note_present === "boolean" &&
          Object.keys(p.legacy_evidence).length === 2)),
       JSON.stringify(every.find((p) => p.legacy_evidence &&
         Object.keys(p.legacy_evidence).length !== 2) || null));
    console.log("        checked " + every.length + " proof blocks across both shapes");
  }

  sec("VERDICT");
  console.log(`  passed ${pass}   failed ${fail}`);
  await c.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(1); });
