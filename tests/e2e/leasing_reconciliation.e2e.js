/*  ════════════════════════════════════════════════════════════════════
    LEASING RECONCILIATION GATE

    Five real lifecycle states, four surfaces, nine governed concepts.

    It does NOT compare prose. Each surface is asked what it believes about
    a CONCEPT — the exact space, whether the resident signed, what is
    blocking — and every surface that answers must give the same answer.

    ABSTENTION IS NOT DISAGREEMENT. A surface that does not carry a concept
    returns undefined and is skipped for it. That distinction is the whole
    design: forcing every surface to answer everything would push business
    meaning into surfaces, which is the failure this gate exists to catch.

    A DISAGREEMENT IS NEVER FIXED BY ADDING LOGIC TO A SURFACE. It means one
    surface bypassed the owner of that concept; the fix is to make it read
    the owner.
    ════════════════════════════════════════════════════════════════════ */
const { pool, q, api, ctx, toPacket, residentSigns } = require("./leasing_e2e_lib.js");
const { gatherFacts } = require("../../src/agent/ask_spine_answer.js");
const applicationsModule = require("../../src/applications/applications.js");

//  Ask Spine is handed the SAME canonical application service server.js
//  hands it. Without it the envelope carries no next action — and the gate
//  would record an abstention that is an artefact of the harness rather
//  than a fact about the product.
const noop = async () => {};
const APPLICATIONS_SERVICE = applicationsModule({
  pool, spawnObligationFromEvent: noop, satisfyObligation: noop, completeObligation: noop,
})._service;

const CONCEPTS = [
  "exact_space", "position", "resident_executed", "company_executed",
  "executed_lease", "tenancy", "blocker", "next_action", "owner",
];

const norm = (v) => (v === undefined ? undefined : v === null ? "(null)" : String(v));
const bool = (v) => (v === undefined ? undefined : v ? "yes" : "no");

// ── ONE SURFACE'S BELIEFS ───────────────────────────────────────────
function fromReview(b) {
  if (!b) return {};
  const n = b.next_action, x = b.executed_lease;
  return {
    exact_space: b.space ? norm(b.space.space_label) : undefined,
    resident_executed: b.packet && b.packet.id ? bool(b.packet.resident_executed_at) : undefined,
    company_executed: b.packet && b.packet.id ? bool(b.packet.company_executed_at) : undefined,
    executed_lease: x ? (x.present ? norm(x.activation_status) : "absent") : undefined,
    tenancy: b.lease_id === undefined ? undefined : (b.lease_id ? "committed" : "none"),
    blocker: n ? norm(n.blocker_code) : undefined,
    next_action: n ? `${n.code}/${n.state}` : undefined,
  };
}
function fromStanding(s) {
  if (!s) return {};
  const L = s.lease, n = s.next && s.next.action;
  const work = s.next && s.next.open_work ? s.next.open_work : [];
  return {
    exact_space: s.target ? norm(s.target.space_label) : undefined,
    position: s.current_position ? norm(s.current_position.stage) : undefined,
    resident_executed: L ? bool(L.resident_executed_at) : "no",
    company_executed: L ? bool(L.company_executed_at) : "no",
    executed_lease: L ? (L.executed_lease.present ? norm(L.executed_lease.admission_status) : "absent") : "absent",
    tenancy: norm(s.tenancy.state === "none" ? "none" : "committed"),
    blocker: n ? norm(n.blocker_code) : undefined,
    next_action: n ? `${n.code}/${n.state}` : undefined,
    owner: work.length ? work.map((w) => (w.owner === "UNASSIGNED" ? "UNASSIGNED" : w.owner.name)).sort().join("|") : "(none)",
  };
}
function fromCard(b) {
  if (!b) return {};
  const ls = b.leasing_standing;
  const base = ls ? fromStanding({ ...ls, current_position: null }) : {};
  return { ...base, position: norm(b.stage) };
}
function fromAsk(lp) {
  if (!lp || lp.read_state !== "OK") return {};
  return fromStanding(lp);
}

// ── THE COMPARISON ──────────────────────────────────────────────────
let disagreements = 0;
function reconcile(state, beliefs) {
  console.log(`\n── ${state} ${"─".repeat(Math.max(0, 54 - state.length))}`);
  for (const c of CONCEPTS) {
    const answers = Object.entries(beliefs)
      .map(([surface, b]) => [surface, b[c]])
      .filter(([, v]) => v !== undefined);
    if (!answers.length) { console.log(`   ${c.padEnd(19)} — every surface abstains`); continue; }
    const distinct = [...new Set(answers.map(([, v]) => v))];
    const who = answers.map(([s]) => s).join(", ");
    if (distinct.length === 1) {
      console.log(`   ✓ ${c.padEnd(17)} ${String(distinct[0]).padEnd(34)} (${who})`);
    } else {
      disagreements++;
      console.log(`   ✗ ${c.padEnd(17)} DISAGREEMENT`);
      for (const [s, v] of answers) console.log(`       ${s.padEnd(10)} ${v}`);
    }
  }
}

async function beliefsFor(C, appId, personId, question) {
  const rev  = await api("GET", `/operator/leasing/application-review?application_id=${appId}`, { token: C.token, key: "e2e-key" });
  const st   = await api("GET", `/operator/leasing/standing?person_id=${personId}`, { token: C.token, key: "e2e-key" });
  const card = await api("GET", `/operator/leasing/person-card?person_id=${personId}`, { token: C.token, key: "e2e-key" });
  const f    = await gatherFacts(pool, { property_id: C.prop, allowed_modules: ["leasing"],
                                         subject: "leasing_person", question,
                                         applicationsService: APPLICATIONS_SERVICE });
  if (!f.leasing_person || f.leasing_person.read_state !== "OK") {
    throw new Error(`Ask Spine named-person read did not participate for "${question}": ${JSON.stringify(f.leasing_person || null)}`);
  }
  return {
    review:   fromReview(rev.body),
    standing: fromStanding(st.body && st.body.leasing_standing),
    card:     fromCard(card.body),
    ask:      fromAsk(f.leasing_person),
  };
}

//  Rent Roll and availability are additional reconciliation surfaces where
//  the state is relevant — a COMMITTED tenancy must appear in the rent roll
//  and its bed must stop reading as open.
async function reconcileInventory(C, state, leaseId, spaceId, expectCommitted) {
  const rr = await api("GET", "/operator/rent-roll/canonical", { token: C.token, key: "e2e-key" });
  const av = await api("GET", "/operator/leasing/availability-canonical", { token: C.token, key: "e2e-key" });
  const inRr = leaseId ? JSON.stringify(rr.body || {}).includes(leaseId) : false;
  const avStr = JSON.stringify(av.body || {});
  const bedNamed = avStr.includes(spaceId);
  if (expectCommitted) {
    if (inRr) console.log(`   ✓ rent roll         carries the committed lease`);
    else { disagreements++; console.log(`   ✗ rent roll         a committed tenancy is absent from the rent roll`); }
  }
  console.log(`   · availability      ${bedNamed ? "names this bed" : "does not name this bed"} (context, not asserted)`);
}

(async () => {
  const C = await ctx();
  const uniq = () => "Recon" + Date.now().toString(36) + Math.floor(Math.random() * 999) + " Case";

  // ── 1 · packet sent, resident has not signed ──────────────────────
  const n1 = uniq(); const A = await toPacket(C, { bed: C.bedB, name: n1 });
  const p1 = (await q("select person_id from lease_applications where id=$1", [A.appId])).rows[0].person_id;
  reconcile("STATE 1 · packet sent", await beliefsFor(C, A.appId, p1, `Where is ${n1}?`));

  // ── 2 · resident executed ─────────────────────────────────────────
  await residentSigns(A.rawTok);
  reconcile("STATE 2 · resident executed", await beliefsFor(C, A.appId, p1, `Has ${n1} signed?`));

  // ── 3 · fully executed, tenancy pending ───────────────────────────
  const ex = await api("POST", `/operator/leasing/lease-packets/${A.packetId}/company-sign`, { token: C.token, key: "e2e-key", body: {} });
  reconcile("STATE 3 · fully executed", await beliefsFor(C, A.appId, p1, `Is ${n1} committed?`));
  await reconcileInventory(C, "STATE 3", ex.body && ex.body.tenancy && ex.body.tenancy.lease_id, C.bedB, true);

  // ── 4 · executed, activation blocked (the bed is taken) ───────────
  const n4 = uniq(); const B = await toPacket(C, { bed: C.bedB, name: n4 });
  const p4 = (await q("select person_id from lease_applications where id=$1", [B.appId])).rows[0].person_id;
  await residentSigns(B.rawTok);
  await api("POST", `/operator/leasing/lease-packets/${B.packetId}/company-sign`, { token: C.token, key: "e2e-key", body: {} });
  reconcile("STATE 4 · executed, activation blocked", await beliefsFor(C, B.appId, p4, `What is holding ${n4} up?`));

  // ── 5 · packet superseded ─────────────────────────────────────────
  const n5 = uniq(); const D = await toPacket(C, { bed: C.bedA, name: n5 });
  const p5 = (await q("select person_id from lease_applications where id=$1", [D.appId])).rows[0].person_id;
  await api("POST", `/operator/leasing/applications/${D.appId}/lease-packet`, { token: C.token, key: "e2e-key", body: { create_new_version: true } });
  reconcile("STATE 5 · packet superseded", await beliefsFor(C, D.appId, p5, `Where is ${n5}?`));

  console.log(`\n${"=".repeat(64)}`);
  console.log(disagreements
    ? `  ${disagreements} DISAGREEMENT(S) — the product tells more than one story.`
    : "  ALL SURFACES RECONCILE — one leasing truth, read four ways.");
  console.log("=".repeat(64));
  await pool.end();
  process.exit(disagreements ? 2 : 0);
})().catch(async (e) => { console.log("DIED: " + e.stack); try { await pool.end(); } catch (_) {} process.exit(1); });
