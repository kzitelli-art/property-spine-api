// =============================================================
// proof_review_next_action_seam.js — Slice 1 composition-seam proof
//
//   Drives the REAL buildReviewDetail with the REAL canonical resolvers
//   (applicationsService.outstanding + applicationNext) over a fake pg
//   client seeded with known states. No database. This exercises the
//   exact composition operator.js performs on GET application-review.
//
//   Run:   node tools/proofs/proof_review_next_action_seam.js
// =============================================================

const path = require("path");
const applicationsModule = require(path.join(__dirname, "..", "src", "applications", "applications.js"));
const { buildReviewDetail } = require(path.join(__dirname, "..", "src", "applications", "application_review.js"));

const stub = {
  pool: { query: async () => { throw new Error("proof: pool untouched"); } },
  spawnObligationFromEvent: async () => {}, satisfyObligation: async () => {}, completeObligation: async () => {},
};
const svc = applicationsModule(stub)._service;

// fake client: pattern-match the SQL, answer from the seeded scenario.
// Instrumented (#1): counts current-packet reads so we can assert single-read.
function fakeClient(sc) {
  const counters = { packetReads: 0 };
  const c = {
    _counters: counters,
    query: async (sql, params) => {
      const s = String(sql);
      if (s.includes("from lease_applications where id"))            return { rows: sc.app ? [sc.app] : [] };
      if (s.includes("from lease_packets")) { counters.packetReads++; return { rows: sc.packet ? [sc.packet] : [] }; }
      if (s.includes("from application_proposed_terms_confirmations")) return { rows: sc.confirmation ? [sc.confirmation] : [] };
      if (s.includes("from obligations where id"))                   return { rows: sc.obligation ? [sc.obligation] : [] };
      if (s.includes("from lease_economic_schedules"))               return { rows: [] };
      if (s.includes("from lease_economic_lines"))                   return { rows: [] };
      throw new Error("fakeClient: unmapped SQL → " + s.slice(0, 80));
    },
  };
  return c;
}

const RESOLVERS = { loadGate: svc.outstanding, resolveNext: svc.applicationNext };
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log("  ok    " + n); };
const bad = (n, d) => { fail++; console.log("  FAIL  " + n + (d ? " — " + d : "")); };
async function expectNext(name, sc, want, resolvers = RESOLVERS) {
  const client = fakeClient(sc);
  const out = await buildReviewDetail(client, sc.app.id, sc.app.property_id, resolvers);
  out.__packetReads = client._counters.packetReads;
  const na = out.next_action;
  if (want === null) { (na === null) ? ok(name) : bad(name, "expected null next_action, got " + JSON.stringify(na)); return out; }
  if (!na) { bad(name, "next_action missing"); return out; }
  const wrong = Object.keys(want).filter(k => JSON.stringify(na[k]) !== JSON.stringify(want[k]));
  wrong.length ? bad(name, wrong.map(k => `${k}: got ${JSON.stringify(na[k])} want ${JSON.stringify(want[k])}`).join("; ")) : ok(name);
  return out;
}

(async () => {
  console.log("\nSEAM — buildReviewDetail × canonical resolver");

  // ── Jordan's real persisted state ──────────────────────────────────────
  const jordanApp = {
    id: "34340426", property_id: "a50fbdd0", person_id: "p1", unit_id: "u1", unit_label: null,
    status: "lease_ready", applicant_name: "Jordan Avery",
    rent: 2000, deposit: 500, lease_start_date: "2026-08-20", lease_end_date: "2027-08-29",
    concession_status: "none", terms_review_obligation_id: "66c2092a", activation_obligation_id: null,
    proposed_terms_confirmation_id: "b34a6083",
    term_source: "operator_proposed_terms", terms_completed_at: "2026-07-20",
  };
  const jordanPacket = {
    id: "8be7fd75", version: 1, status: "sent", is_placeholder: false,
    terms_json: JSON.stringify({ lease_start_date: "2026-08-20", lease_end_date: "2027-08-29",
      monthly_rent: 2000, security_deposit: 500, concession_status: "none", unit_id: "u1", resident_names: "Jordan Avery" }),
    sent_at: "2026-07-20T21:33:36Z", tenant_token_expires_at: "2026-08-03", tenant_submitted_at: null,
    voided_at: null, void_reason: null, superseded_at: null,
    proposed_terms_confirmation_id: null, // historical: generated before the FK stamp
    created_at: "2026-07-20", updated_at: "2026-07-20",
  };
  const jordanScenario = {
    app: jordanApp, packet: jordanPacket,
    confirmation: { id: "b34a6083", source: "operator_proposed_terms", rent: 2000, security_deposit: 500,
      lease_start_date: "2026-08-20", lease_end_date: "2027-08-29", concession_status: "none",
      actor_user_id: "71c21c48", created_at: "2026-07-20T21:28:41Z" },
    obligation: { required_inputs: ["terms_acknowledged"], status: "open" },
  };

  const out1 = await expectNext("Jordan (sent, null lineage) → await/waiting, no blocker, warning unproven",
    jordanScenario,
    { code: "await_resident_acknowledgment", group_code: "awaiting_acknowledgment", action_code: "awaiting_acknowledgment",
      state: "waiting", blocker_code: null, warning_code: "issued_packet_lineage_unproven",
      packet_id: "8be7fd75", obligation_id: "66c2092a" });
  // #1 — single current-packet read for the whole request
  (out1.__packetReads === 1) ? ok("Jordan — exactly ONE lease_packets read (single-read invariant)")
    : bad("Jordan — single-read invariant", "packetReads=" + out1.__packetReads + " (expected 1)");
  // response shape intact alongside next_action:
  (out1.packet && out1.packet.lifecycle_status === "sent" && out1.proposed_terms_confirmation
   && out1.proposed_terms_confirmation.id === "b34a6083" && out1.packet.status === "current")
    ? ok("Jordan — existing detail fields intact (packet lifecycle, confirmation, back-compat status)")
    : bad("Jordan — existing detail fields intact", JSON.stringify({ p: out1.packet, c: out1.proposed_terms_confirmation }).slice(0, 200));

  // ── Confirm stage: lease_ready, gate open, no confirmation, no packet ──
  const outC = await expectNext("post-approve, nothing else → confirm_proposed_terms / available",
    { app: { ...jordanApp, id: "app-B", proposed_terms_confirmation_id: null, rent: null, deposit: null,
             lease_start_date: null, lease_end_date: null },
      packet: null, confirmation: null,
      obligation: { required_inputs: ["terms_acknowledged"], status: "open" } },
    { code: "confirm_proposed_terms", group_code: "send_terms_for_review", action_code: "send_terms_for_review", state: "available", blocker_code: null });
  (outC.__packetReads === 1) ? ok("confirm stage — exactly ONE lease_packets read")
    : bad("confirm stage — single-read", "packetReads=" + outC.__packetReads);

  // ── Generate stage: confirmation exists, no packet ─────────────────────
  const outG = await expectNext("confirmed, no packet → generate_terms_review_packet / available",
    { app: { ...jordanApp, id: "app-C" }, packet: null,
      confirmation: jordanScenario.confirmation,
      obligation: { required_inputs: ["terms_acknowledged"], status: "open" } },
    { code: "generate_terms_review_packet", state: "available" });
  // #1 — the packet:null sentinel case. A truthiness check would re-query here.
  (outG.__packetReads === 1) ? ok("generate stage (packet:null) — exactly ONE lease_packets read (sentinel, not truthiness)")
    : bad("generate stage — single-read on null packet", "packetReads=" + outG.__packetReads + " (a truthiness check would give 2)");

  // ── Issue stage: matching current draft ────────────────────────────────
  await expectNext("current matching draft → issue_terms_review_link / available",
    { app: { ...jordanApp, id: "app-D" },
      packet: { ...jordanPacket, status: "draft", sent_at: null, proposed_terms_confirmation_id: "b34a6083" },
      confirmation: jordanScenario.confirmation,
      obligation: { required_inputs: ["terms_acknowledged"], status: "open" } },
    { code: "issue_terms_review_link", state: "available", blocker_code: null });

  // ── Historical draft, null lineage → honestly blocked ──────────────────
  await expectNext("historical draft, null lineage → blocked packet_lineage_unproven",
    { app: { ...jordanApp, id: "app-E" },
      packet: { ...jordanPacket, status: "draft", sent_at: null, proposed_terms_confirmation_id: null },
      confirmation: jordanScenario.confirmation,
      obligation: { required_inputs: ["terms_acknowledged"], status: "open" } },
    { code: "issue_terms_review_link", state: "blocked", blocker_code: "packet_lineage_unproven" });

  // ── Submitted app → approve_application ────────────────────────────────
  await expectNext("submitted app → approve_application / available",
    { app: { ...jordanApp, id: "app-F", status: "submitted", terms_review_obligation_id: null,
             proposed_terms_confirmation_id: null },
      packet: null, confirmation: null, obligation: null },
    { code: "approve_application", group_code: "approve", state: "available" });

  // ── Resolver unwired (older server.js) → honest null, detail still whole ─
  const out2 = await expectNext("resolvers absent → next_action is honest null", jordanScenario, null, null);
  (out2.packet && out2.packet.id === "8be7fd75") ? ok("unwired — detail response otherwise intact")
    : bad("unwired — detail response otherwise intact");

  console.log("\n──────────────────────────────────────────────");
  console.log(`RESULT  ${pass} passed · ${fail} failed`);
  if (fail) process.exit(1);
  console.log("");
  console.log("What this proves, in plain language:");
  console.log(" · The Application Review read now returns ONE server-authored");
  console.log("   next_action, computed by the same canonical resolver every");
  console.log("   queue uses — through the exact composition the live route runs.");
  console.log(" · Jordan's real record answers: awaiting the resident's");
  console.log("   acknowledgment. The confirm→generate→issue stages each answer");
  console.log("   with their own precise action.");
  console.log(" · A historical packet with unproven lineage is blocked honestly,");
  console.log("   never silently treated as current.");
  console.log(" · On an older server without the wiring, next_action is an honest");
  console.log("   null and the rest of the response is untouched.");
  process.exit(0);
})().catch(e => { console.error("PROOF CRASHED:", e); process.exit(1); });
