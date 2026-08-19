// =============================================================
// proof_next_action_resolver.js — Slice 1 headless acceptance proof
//
//   The resolver is a PURE interpreter of already-loaded facts, so this
//   proof needs NO database. It instantiates the applications module with
//   stub deps and drives applicationNext / applicationPosition directly.
//
//   Three proof groups:
//     A. LEGACY LOCK — every two-arg call must return action_code + label
//        BYTE-IDENTICAL to the pre-slice resolver (inline oracle below),
//        with ONE documented exception: packet status 'tenant_in_progress'
//        previously fell through to send_terms_for_review (vocabulary
//        drift); it now correctly reads awaiting_acknowledgment.
//     B. REFINED MATRIX — the buddy-spec acceptance matrix, three-arg.
//     C. POSITION STABILITY — applicationPosition unchanged everywhere.
//
//   Run:   node tools/proofs/proof_next_action_resolver.js
//   (from the repo root; needs only express + the repo's own files)
// =============================================================

const path = require("path");
//  ⚠ PATH REPAIRED. This resolved to the repository ROOT, where
//  applications.js lived before the domain reorganisation moved it to
//  src/applications/. The oracle has therefore thrown on require since
//  that commit — it was not guarding the resolver it exists to guard,
//  and nothing said so because it is not in the *.test.js glob.
const applicationsModule = require(path.join(__dirname, "..", "applications", "applications.js"));

// stub deps — the factory never touches them for pure resolver calls
const stub = {
  pool: { query: async () => { throw new Error("proof: no DB"); }, connect: async () => { throw new Error("proof: no DB"); } },
  spawnObligationFromEvent: async () => { throw new Error("proof: no DB"); },
  satisfyObligation: async () => { throw new Error("proof: no DB"); },
  completeObligation: async () => { throw new Error("proof: no DB"); },
};
const svc = applicationsModule(stub)._service;
const { applicationNext, applicationPosition } = svc;

// ── the PRE-SLICE resolver, verbatim logic — the regression oracle ──────
function oracleNext(app, gate) {
  const pk = gate && gate.packet;
  const gateClosed = gate && ["complete", "completed"].includes(gate.obligation_status);
  const base = { source_type: "lease_application", source_id: app.id,
                 obligation_id: (gate && gate.gate_kind === "terms_review") ? app.terms_review_obligation_id : null,
                 packet_id: pk ? pk.id : null, blocked_reason: null };
  if (app.status === "active") return { ...base, action_code: "active", label: "Lease active. Tenant file open." };
  if (["declined", "withdrawn", "expired"].includes(app.status)) return { ...base, action_code: "closed", label: "Application closed (" + app.status + ")." };
  if (app.status === "accepted_term_required") return { ...base, action_code: "confirm_term", label: "Company accepted — confirm the lease term." };
  if (app.status === "submitted") return { ...base, action_code: "approve", label: "Approve the application." };
  if (!gate) return { ...base, action_code: "review_application", label: "Submit the application." };
  if (gate.gate_kind === "legacy_activation") {
    return { ...base, action_code: "executed_lease_required",
             label: "Executed lease required. (Legacy activation gate — a terms acknowledgment is not an executed lease.)" };
  }
  if (gateClosed) return { ...base, action_code: "executed_lease_required", label: "Executed lease required." };
  if (pk && ["sent", "in_progress"].includes(pk.status)) return { ...base, action_code: "awaiting_acknowledgment", label: "Awaiting the resident's terms acknowledgment." };
  if (pk && pk.status === "submitted") return { ...base, action_code: "executed_lease_required", label: "Executed lease required." };
  return { ...base, action_code: "send_terms_for_review", label: "Send terms for review." };
}

// ── tiny assertion rig ───────────────────────────────────────────────────
let pass = 0, fail = 0; const failures = [];
function ok(name){ pass++; console.log("  ok    " + name); }
function bad(name, d){ fail++; failures.push({ name, bad: [d||""] }); console.log("  FAIL  " + name + (d ? " — " + d : "")); }
function check(name, got, want) {
  const bad = Object.keys(want).filter(k => JSON.stringify(got[k]) !== JSON.stringify(want[k]));
  if (bad.length) { fail++; failures.push({ name, bad: bad.map(k => `${k}: got ${JSON.stringify(got[k])} want ${JSON.stringify(want[k])}`) }); console.log(`  FAIL  ${name}`); bad.forEach(k => console.log(`        · ${k}: got ${JSON.stringify(got[k])}  want ${JSON.stringify(want[k])}`)); }
  else { pass++; console.log(`  ok    ${name}`); }
}

// fixture builders
const APP = (status, extra) => ({ id: "app-1", status, terms_review_obligation_id: null, activation_obligation_id: null, ...(extra || {}) });
const TR_GATE = (extra) => ({ remaining: ["terms_acknowledged"], obligation_status: "open", gate_kind: "terms_review", packet: null, ...(extra || {}) });

// ═════ GROUP A — LEGACY LOCK (two-arg, oracle-identical) ═════
console.log("\nGROUP A — legacy two-arg lock (oracle comparison)");
const legacyGrid = [
  ["active app",            APP("active"), null],
  ["declined app",          APP("declined"), null],
  ["withdrawn app",         APP("withdrawn"), null],
  ["expired app",           APP("expired"), null],
  ["accepted_term_required",APP("accepted_term_required"), null],
  ["submitted app",         APP("submitted"), null],
  ["lease_ready, no gate",  APP("lease_ready"), null],
  ["legacy activation gate",APP("lease_ready", { activation_obligation_id: "ob-L" }), { remaining: [], obligation_status: "open", gate_kind: "legacy_activation", packet: null }],
  ["gate closed (complete)",APP("lease_ready", { terms_review_obligation_id: "ob-T" }), TR_GATE({ obligation_status: "complete" })],
  ["gate closed (completed)",APP("lease_ready", { terms_review_obligation_id: "ob-T" }), TR_GATE({ obligation_status: "completed" })],
  ["packet sent",           APP("lease_ready", { terms_review_obligation_id: "ob-T" }), TR_GATE({ packet: { id: "pk-1", status: "sent" } })],
  ["packet in_progress",    APP("lease_ready", { terms_review_obligation_id: "ob-T" }), TR_GATE({ packet: { id: "pk-1", status: "in_progress" } })],
  ["packet submitted",      APP("lease_ready", { terms_review_obligation_id: "ob-T" }), TR_GATE({ packet: { id: "pk-1", status: "submitted" } })],
  ["gate open, no packet",  APP("lease_ready", { terms_review_obligation_id: "ob-T" }), TR_GATE()],
  ["gate open, draft packet",APP("lease_ready", { terms_review_obligation_id: "ob-T" }), TR_GATE({ packet: { id: "pk-1", status: "draft" } })],
];
for (const [name, app, gate] of legacyGrid) {
  const got = applicationNext(app, gate);
  const want = oracleNext(app, gate);
  check(`A · ${name}`, got, { action_code: want.action_code, label: want.label,
    obligation_id: want.obligation_id, packet_id: want.packet_id, blocked_reason: null });
  // #2: action_code is the LEGACY alias (== old value), group_code legacy, code mirrors, blocker null
  check(`A · ${name} — legacy aliases`, got, { action_code: want.action_code, group_code: want.action_code, code: got.action_code, blocker_code: null });
}
// the ONE documented legacy change — drift kill:
{
  const got = applicationNext(APP("lease_ready", { terms_review_obligation_id: "ob-T" }), TR_GATE({ packet: { id: "pk-1", status: "tenant_in_progress" } }));
  check("A · DRIFT FIX — tenant_in_progress now awaits (was send_terms_for_review)", got,
    { action_code: "awaiting_acknowledgment", state: "waiting", group_code: "awaiting_acknowledgment" });
}

// ═════ GROUP B — REFINED MATRIX (three-arg) ═════
console.log("\nGROUP B — refined matrix (review facts provided)");
const RV = (o) => ({ confirmation: null, packet: null, currency_status: "not_generated", lineage_matches_current_confirmation: null, ...(o || {}) });
const LR = () => APP("lease_ready", { terms_review_obligation_id: "ob-T" });

check("B · submitted → approve_application/available", applicationNext(APP("submitted"), null, RV()),
  { code: "approve_application", group_code: "approve", state: "available", blocker_code: null });

check("B · lease_ready, no confirmation → confirm_proposed_terms/available", applicationNext(LR(), TR_GATE(), RV()),
  { code: "confirm_proposed_terms", group_code: "send_terms_for_review", state: "available", blocker_code: null });

check("B · confirmation, no packet → generate_terms_review_packet/available",
  applicationNext(LR(), TR_GATE(), RV({ confirmation: { id: "conf-1" } })),
  { code: "generate_terms_review_packet", group_code: "send_terms_for_review", state: "available", blocker_code: null });

check("B · matching current draft packet → issue_terms_review_link/available",
  applicationNext(LR(), TR_GATE({ packet: { id: "pk-1", status: "draft" } }),
    RV({ confirmation: { id: "conf-1" }, packet: { id: "pk-1", status: "draft", proposed_terms_confirmation_id: "conf-1" }, currency_status: "current", lineage_matches_current_confirmation: true })),
  { code: "issue_terms_review_link", group_code: "send_terms_for_review", state: "available", blocker_code: null, packet_id: "pk-1" });

check("B · sent packet → await_resident_acknowledgment/waiting",
  applicationNext(LR(), TR_GATE({ packet: { id: "pk-1", status: "sent" } }),
    RV({ confirmation: { id: "conf-1" }, packet: { id: "pk-1", status: "sent", proposed_terms_confirmation_id: "conf-1" }, currency_status: "current", lineage_matches_current_confirmation: true })),
  { code: "await_resident_acknowledgment", group_code: "awaiting_acknowledgment", state: "waiting", blocker_code: null });

check("B · stale draft packet → blocked packet_stale",
  applicationNext(LR(), TR_GATE({ packet: { id: "pk-1", status: "draft" } }),
    RV({ confirmation: { id: "conf-1" }, packet: { id: "pk-1", status: "draft", proposed_terms_confirmation_id: "conf-1" }, currency_status: "stale", lineage_matches_current_confirmation: true })),
  { code: "issue_terms_review_link", state: "blocked", blocker_code: "packet_stale" });

check("B · lineage mismatch → blocked packet_confirmation_mismatch",
  applicationNext(LR(), TR_GATE({ packet: { id: "pk-1", status: "draft" } }),
    RV({ confirmation: { id: "conf-2" }, packet: { id: "pk-1", status: "draft", proposed_terms_confirmation_id: "conf-1" }, currency_status: "current", lineage_matches_current_confirmation: false })),
  { code: "issue_terms_review_link", state: "blocked", blocker_code: "packet_confirmation_mismatch" });

check("B · NULL lineage (historical) → blocked packet_lineage_unproven — null is NOT a match",
  applicationNext(LR(), TR_GATE({ packet: { id: "pk-1", status: "draft" } }),
    RV({ confirmation: { id: "conf-1" }, packet: { id: "pk-1", status: "draft", proposed_terms_confirmation_id: null }, currency_status: "current", lineage_matches_current_confirmation: false })),
  { code: "issue_terms_review_link", state: "blocked", blocker_code: "packet_lineage_unproven" });

check("B · lineage precedence over staleness (mismatch + stale → mismatch)",
  applicationNext(LR(), TR_GATE({ packet: { id: "pk-1", status: "draft" } }),
    RV({ confirmation: { id: "conf-2" }, packet: { id: "pk-1", status: "draft", proposed_terms_confirmation_id: "conf-1" }, currency_status: "stale", lineage_matches_current_confirmation: false })),
  { blocker_code: "packet_confirmation_mismatch" });

check("B · packet with NO confirmation → confirm blocked inconsistent_application_state",
  applicationNext(LR(), TR_GATE({ packet: { id: "pk-1", status: "draft" } }),
    RV({ confirmation: null, packet: { id: "pk-1", status: "draft", proposed_terms_confirmation_id: null }, currency_status: "current" })),
  { code: "confirm_proposed_terms", state: "blocked", blocker_code: "inconsistent_application_state" });

check("B · tenant_in_progress packet → await/waiting (one vocabulary)",
  applicationNext(LR(), TR_GATE({ packet: { id: "pk-1", status: "tenant_in_progress" } }),
    RV({ confirmation: { id: "conf-1" }, packet: { id: "pk-1", status: "tenant_in_progress", proposed_terms_confirmation_id: "conf-1" }, currency_status: "current", lineage_matches_current_confirmation: true })),
  { code: "await_resident_acknowledgment", state: "waiting" });

check("B · resident-submitted packet → executed_lease_required",
  applicationNext(LR(), TR_GATE({ packet: { id: "pk-1", status: "submitted" } }),
    RV({ confirmation: { id: "conf-1" }, packet: { id: "pk-1", status: "submitted", proposed_terms_confirmation_id: "conf-1" }, currency_status: "current", lineage_matches_current_confirmation: true })),
  { code: "executed_lease_required" });

// ── #2: refined mode preserves the legacy action_code alias ───────────────
console.log("\n#2 — legacy action_code alias preserved in refined mode");
check("#2 · refined confirm → code precise, action_code legacy",
  applicationNext(LR(), TR_GATE(), RV()),
  { code: "confirm_proposed_terms", action_code: "send_terms_for_review", group_code: "send_terms_for_review" });
check("#2 · refined approve → code precise, action_code legacy 'approve'",
  applicationNext(APP("submitted"), null, RV()),
  { code: "approve_application", action_code: "approve", group_code: "approve" });
check("#2 · refined await → code precise, action_code legacy",
  applicationNext(LR(), TR_GATE({ packet: { id: "pk-1", status: "sent" } }),
    RV({ confirmation: { id: "c" }, packet: { id: "pk-1", status: "sent", proposed_terms_confirmation_id: "c" }, currency_status: "current", lineage_matches_current_confirmation: true })),
  { code: "await_resident_acknowledgment", action_code: "awaiting_acknowledgment" });

// ── #3: ISSUED packets are NEVER blocked — anomalies are WARNINGS ──────────
console.log("\n#3 — issued packets stay await/waiting; anomalies are warnings, not blockers");
const issued = (pkStatus, rvExtra) => applicationNext(LR(), TR_GATE({ packet: { id: "pk-1", status: pkStatus } }),
  RV({ confirmation: { id: "conf-1" }, packet: { id: "pk-1", status: pkStatus, ...(rvExtra.pk || {}) },
       currency_status: rvExtra.currency || "current", lineage_matches_current_confirmation: rvExtra.lineage }));

check("#3 · sent + stale → await/waiting, NO blocker, warning issued_packet_stale",
  issued("sent", { currency: "stale", lineage: true, pk: { proposed_terms_confirmation_id: "conf-1" } }),
  { code: "await_resident_acknowledgment", state: "waiting", blocker_code: null, warning_code: "issued_packet_stale" });

check("#3 · sent + mismatched lineage → await/waiting, NO blocker, warning mismatch",
  issued("sent", { currency: "current", lineage: false, pk: { proposed_terms_confirmation_id: "conf-OTHER" } }),
  { code: "await_resident_acknowledgment", state: "waiting", blocker_code: null, warning_code: "issued_packet_confirmation_mismatch" });

check("#3 · sent + null lineage → await/waiting, NO blocker, warning unproven",
  issued("sent", { currency: "current", lineage: false, pk: { proposed_terms_confirmation_id: null } }),
  { code: "await_resident_acknowledgment", state: "waiting", blocker_code: null, warning_code: "issued_packet_lineage_unproven" });

check("#3 · tenant_in_progress + stale → await/waiting, NO blocker, warning stale",
  issued("tenant_in_progress", { currency: "stale", lineage: true, pk: { proposed_terms_confirmation_id: "conf-1" } }),
  { code: "await_resident_acknowledgment", state: "waiting", blocker_code: null, warning_code: "issued_packet_stale" });

check("#3 · tenant_in_progress + mismatch → await/waiting, NO blocker, warning mismatch",
  issued("tenant_in_progress", { currency: "current", lineage: false, pk: { proposed_terms_confirmation_id: "conf-OTHER" } }),
  { code: "await_resident_acknowledgment", state: "waiting", blocker_code: null, warning_code: "issued_packet_confirmation_mismatch" });

check("#3 · sent + clean lineage → await/waiting, NO blocker, NO warning",
  issued("sent", { currency: "current", lineage: true, pk: { proposed_terms_confirmation_id: "conf-1" } }),
  { code: "await_resident_acknowledgment", state: "waiting", blocker_code: null, warning_code: null });

// ── #2: ONLY a draft is issuable — voided/unknown never reach Issue ────────
console.log("\n#2 — strict draft allowlist before Issue");
check("#2 · VOIDED packet → NOT issuable, blocked packet_voided, code regenerate",
  applicationNext(LR(), TR_GATE({ packet: { id: "pk-1", status: "voided" } }),
    RV({ confirmation: { id: "conf-1" }, packet: { id: "pk-1", status: "voided", proposed_terms_confirmation_id: "conf-1" }, currency_status: "current", lineage_matches_current_confirmation: true })),
  { code: "generate_terms_review_packet", state: "blocked", blocker_code: "packet_voided" });

check("#2 · UNKNOWN packet status → NOT issuable, blocked packet_status_not_issuable",
  applicationNext(LR(), TR_GATE({ packet: { id: "pk-1", status: "weird_future_status" } }),
    RV({ confirmation: { id: "conf-1" }, packet: { id: "pk-1", status: "weird_future_status", proposed_terms_confirmation_id: "conf-1" }, currency_status: "current", lineage_matches_current_confirmation: true })),
  { code: "generate_terms_review_packet", state: "blocked", blocker_code: "packet_status_not_issuable" });

check("#2 · voided packet even with perfect lineage/currency → still NOT available",
  applicationNext(LR(), TR_GATE({ packet: { id: "pk-1", status: "voided" } }),
    RV({ confirmation: { id: "conf-1" }, packet: { id: "pk-1", status: "voided", proposed_terms_confirmation_id: "conf-1" }, currency_status: "current", lineage_matches_current_confirmation: true })),
  { state: "blocked" }); // must NOT be 'available', must NOT be issue_terms_review_link
// hard invariant: no non-draft packet ever yields an available Issue
for (const st of ["voided", "weird_future_status", "archived", ""]) {
  const r = applicationNext(LR(), TR_GATE({ packet: { id: "pk-1", status: st } }),
    RV({ confirmation: { id: "conf-1" }, packet: { id: "pk-1", status: st, proposed_terms_confirmation_id: "conf-1" }, currency_status: "current", lineage_matches_current_confirmation: true }));
  const violates = (r.code === "issue_terms_review_link" && r.state === "available");
  violates ? bad(`#2 · INVARIANT — status '${st}' must never be available-Issue`) : ok(`#2 · invariant — status '${st}' is not available-Issue (got ${r.code}/${r.state})`);
}
check("#2 · a REAL draft with clean lineage IS issuable (control)",
  applicationNext(LR(), TR_GATE({ packet: { id: "pk-1", status: "draft" } }),
    RV({ confirmation: { id: "conf-1" }, packet: { id: "pk-1", status: "draft", proposed_terms_confirmation_id: "conf-1" }, currency_status: "current", lineage_matches_current_confirmation: true })),
  { code: "issue_terms_review_link", state: "available", blocker_code: null });

check("B · gate closed wins over review facts",
  applicationNext(LR(), TR_GATE({ obligation_status: "complete" }),
    RV({ confirmation: { id: "conf-1" } })),
  { code: "executed_lease_required" });

check("B · legacy activation gate wins over review facts",
  applicationNext(APP("lease_ready", { activation_obligation_id: "ob-L" }),
    { remaining: [], obligation_status: "open", gate_kind: "legacy_activation", packet: null }, RV()),
  { code: "executed_lease_required" });

check("B · active app + review → complete", applicationNext(APP("active"), null, RV()),
  { code: "active", state: "complete" });

check("B · obligation_id passthrough on terms_review gate",
  applicationNext(LR(), TR_GATE(), RV()), { obligation_id: "ob-T" });

check("B · review packet authority — review says null even if gate carries one → packet_id null",
  applicationNext(LR(), TR_GATE({ packet: { id: "pk-GATE", status: "draft" } }),
    RV({ confirmation: { id: "conf-1" }, packet: null, currency_status: "not_generated" })),
  { packet_id: null, code: "generate_terms_review_packet" });

// ═════ #1 — outstanding() single-read sentinel (unit level) ═════
console.log("\n#1 — outstanding() reuses preloaded packet (sentinel, not truthiness)");
async function countPacketReads(opts) {
  let reads = 0;
  const fc = { query: async (sql) => {
    const s = String(sql);
    if (s.includes("from obligations")) return { rows: [{ required_inputs: ["terms_acknowledged"], status: "open" }] };
    if (s.includes("from lease_packets")) { reads++; return { rows: [] }; }
    return { rows: [] };
  }};
  const app = { id: "x", terms_review_obligation_id: "o1", activation_obligation_id: null };
  await svc.outstanding(fc, app, opts);
  return reads;
}
async function run_check_1() {
  const withNull = await countPacketReads({ packet: null });
  const withPk   = await countPacketReads({ packet: { id: "pk", status: "draft" } });
  const withNone = await countPacketReads(undefined);
  (withNull === 0) ? ok("#1 · {packet:null} → ZERO packet reads (null still means 'loaded')") : bad("#1 · {packet:null}", `got ${withNull} reads, expected 0`);
  (withPk === 0)   ? ok("#1 · {packet:{...}} → ZERO packet reads (reuse)") : bad("#1 · {packet:obj}", `got ${withPk} reads, expected 0`);
  (withNone === 1) ? ok("#1 · no opts → exactly ONE packet read (standalone self-load)") : bad("#1 · no opts", `got ${withNone} reads, expected 1`);
}
check("J · Jordan (sent packet, null lineage) → await/waiting, no blocker, warning issued_packet_lineage_unproven",
  applicationNext(
    APP("lease_ready", { terms_review_obligation_id: "66c2092a" }),
    TR_GATE({ packet: { id: "8be7fd75", version: 1, status: "sent" } }),
    RV({ confirmation: { id: "b34a6083" },
         packet: { id: "8be7fd75", status: "sent", proposed_terms_confirmation_id: null, sent_at: "2026-07-20T21:33:36Z" },
         currency_status: "current", lineage_matches_current_confirmation: false })),
  { code: "await_resident_acknowledgment", action_code: "awaiting_acknowledgment", group_code: "awaiting_acknowledgment",
    state: "waiting", blocker_code: null, warning_code: "issued_packet_lineage_unproven", packet_id: "8be7fd75", obligation_id: "66c2092a" });

// ═════ GROUP C — applicationPosition stability ═════
console.log("\nGROUP C — applicationPosition unchanged");
const posOracle = (app, gate) => {
  const n = oracleNext(app, gate);
  switch (n.action_code) {
    case "active": return "active";
    case "closed": return "closed_" + app.status;
    case "confirm_term": return "accepted_term_required";
    case "approve": case "review_application": return "pre_approval";
    case "send_terms_for_review": return "approved_terms_pending";
    case "awaiting_acknowledgment": return "approved_awaiting_acknowledgment";
    case "executed_lease_required":
      return (gate && gate.gate_kind === "legacy_activation") ? "legacy_pre_execution" : "terms_acknowledged_execution_required";
    default: return "pre_approval";
  }
};
for (const [name, app, gate] of legacyGrid) {
  const got = applicationPosition(app, gate);
  const want = posOracle(app, gate);
  if (got === want) { pass++; console.log(`  ok    C · ${name} → ${got}`); }
  else { fail++; failures.push({ name: `C · ${name}`, bad: [`position: got ${got} want ${want}`] }); console.log(`  FAIL  C · ${name}: got ${got} want ${want}`); }
}

// ═════ RECEIPT ═════
// ═════ RECEIPT (await the async #1 sentinel checks first) ═════
(async () => {
  await run_check_1();
  console.log("\n──────────────────────────────────────────────");
  console.log(`RESULT  ${pass} passed · ${fail} failed`);
  if (fail) { console.log("FAILED CHECKS:"); failures.forEach(f => { console.log(" ·", f.name); f.bad.forEach(b => console.log("    ", b)); }); process.exit(1); }
console.log("");
console.log("What this proves, in plain language:");
console.log(" · All legacy two-argument behavior is byte-identical to the pre-slice");
console.log("   resolver — action_code and label unchanged — with EXACTLY ONE");
console.log("   intentional compatibility exception: a packet in 'tenant_in_progress'");
console.log("   previously returned the wrong action (send_terms_for_review) and now");
console.log("   correctly reads as awaiting acknowledgment. That is the sole change.");
console.log(" · Legacy consumers reading action_code still see the old vocabulary;");
console.log("   the new precise value lives in `code`; `group_code` mirrors the legacy.");
console.log(" · With review facts, the server names exactly one next action per");
console.log("   stage: approve → confirm → generate → issue → await.");
console.log(" · 'What is next' and 'why it is blocked' are separate facts. A PENDING");
console.log("   action can be blocked (stale/mismatch/unproven draft packet); an");
console.log("   ALREADY-ISSUED packet is never blocked — its anomalies surface as");
console.log("   warning_code, because there is no pending action to prevent.");
console.log(" · A historical packet with no lineage is never treated as a match.");
console.log(" · Jordan's real issued record: awaiting the resident's acknowledgment,");
console.log("   no blocker, with an honest issued_packet_lineage_unproven warning.");
console.log(" · applicationPosition is unchanged everywhere.");
process.exit(0);
})();
