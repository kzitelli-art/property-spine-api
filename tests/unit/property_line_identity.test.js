// ════════════════════════════════════════════════════════════════════
//  property_line_identity.test.js
//
//  The seam where a phone number becomes a property's voice, and where an
//  inbound number becomes a person. Four claims, each of which was a live
//  defect in at least one lineage of this repo.
//
//  Two of them were ALREADY CLOSED on the deployed lineage when this was
//  written and are asserted anyway — an assertion that a defect is absent is
//  what stops it coming back on the next merge from a branch that still has
//  it. `main` still carries both.
// ════════════════════════════════════════════════════════════════════

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..", "..");

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log(`  ok    ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail !== undefined ? "  " + JSON.stringify(detail) : ""}`); }
}
/** Source with comments stripped — a mention is not a guard. */
function code(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

console.log("\nPROPERTY LINE IDENTITY\n");

// ══════════════════════════════════════════════════════════════════
console.log("1 · the stale line writer is gone, not documented");
{
  const tenantLink = code("src/comms/tenant_link.js");
  ok("POST /properties/:propertyId/sms-number no longer exists",
    !/router\.post\(\s*["']\/properties\/:propertyId\/sms-number["']/.test(tenantLink));
  ok("and it takes its communication_lines writer with it",
    !/insert\s+into\s+communication_lines/i.test(tenantLink));

  //  WHY it had to go, pinned so the reasoning cannot be lost to a revert:
  //  migration 132's CHECK reads outbound_enabled = (outbound_policy <> 'disabled').
  //  A row with outbound_enabled=false and the default policy 'disabled'
  //  satisfies it — false = false — while being operationally false, because
  //  every other property_facing line is 'proactive'.
  const m132 = fs.readFileSync(path.join(root, "migrations/132_outbound_line_policy.sql"), "utf8");
  ok("the CHECK that made the bad row look fine is still the CHECK",
    /outbound_enabled\s*=\s*\(outbound_policy\s*<>\s*'disabled'\)/.test(m132));

  //  No OTHER door may quietly take over the same job.
  const writers = [];
  const srcDir = path.join(root, "src");
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js")) {
        const rel = path.relative(root, p);
        if (/insert\s+into\s+communication_lines/i.test(code(rel))) writers.push(rel);
      }
    }
  })(srcDir);
  //  communication_lines.js itself is the canonical author and is allowed.
  const unexpected = writers.filter(w => w !== "src/comms/communication_lines.js");
  ok("no unexpected module writes communication_lines", unexpected.length === 0, unexpected);
}

// ══════════════════════════════════════════════════════════════════
console.log("\n2 · every outbound message resolves its line through policy");
{
  const boundary = code("src/comms/communications_boundary.js");
  //  ALREADY TRUE on this lineage; `main` still has the policy-blind reader.
  ok("the policy-blind propertyLine() reader is gone",
    !/propertyLine\s*\(/.test(boundary));
  ok("sendPropertySms resolves through the governed resolver",
    /async function sendPropertySms[\s\S]{0,4000}?resolveOutboundLine\(/.test(boundary));
  ok("sendOperationsReply still does too",
    /async function sendOperationsReply[\s\S]{0,4000}?resolveOutboundLine\(/.test(boundary));

  //  The preserved chain, in order. Each of these is a gate the brief named
  //  as must-not-change, so each is pinned by name rather than by trust.
  const send = boundary.slice(boundary.indexOf("async function sendPropertySms"));
  const order = ["resolveOutboundLine(", "resolved.line.e164", "canSendSmsForRecord(", "sms.sendSms("];
  let cursor = -1, inOrder = true;
  for (const token of order) {
    const at = send.indexOf(token);
    if (at < 0 || at < cursor) { inOrder = false; break; }
    cursor = at;
  }
  ok("resolve → canonical from → eligibility gate → transport, in that order", inOrder, order);
  ok("a refusal is stamped rather than falling back to another number",
    /stamp\("refused", `gate:\$\{resolved\.refusal\}`\)/.test(send));
}

// ══════════════════════════════════════════════════════════════════
console.log("\n3 · the live prospect path refuses a conflicted number");
{
  const leads = code("src/leasing/leasing_leads.js");
  //  THE DEFECT: `order by created_at limit 1` silently adopted the OLDEST
  //  person sharing a number, so a reassigned number attached a new
  //  prospect's messages to the previous holder.
  //
  //  Review found the first pass fixed only the canonical branch and left its
  //  legacy-phone and email siblings selecting the first match — the same
  //  ambiguity reaching the same person card through a different door. All
  //  three lookups are therefore pinned BY NAME.
  //
  //  This is the ONE thing §5 structurally cannot check. Its fake client
  //  answers by matching a regex against the SQL text and hands back two rows
  //  regardless of what the query actually asked for, so a returning `limit 1`
  //  would leave every behavioural assertion green. Source covers the query;
  //  behaviour covers the refusal. Neither substitutes for the other.
  //
  //  Each of these three was mutation-checked: reintroducing `limit 1` in that
  //  branch turns that assertion red and only that one.
  const lookups = [
    ["canonical phone", /primary_phone_e164=\$1[\s\S]{0,120}?\)\)\.rows/],
    ["legacy phone",    /regexp_replace\(phone[\s\S]{0,260}?\)\)\.rows/],
    ["email",           /lower\(email\)=lower\(\$1\)[\s\S]{0,120}?\)\)\.rows/],
  ];
  for (const [which, rx] of lookups) {
    const m = leads.match(rx);
    ok(`the ${which} lookup does not take the first row`,
      !!m && !/limit\s+1/i.test(m[0]),
      m ? m[0].replace(/\s+/g, " ") : "lookup statement not found — regex is stale");
  }

  //  Everything else this section used to assert about the refusal — that it
  //  carries its candidates, that it throws, that it is sayable — was asserted
  //  by GREPPING FOR THE SHAPE of the then-current implementation, which is
  //  what let `publicMessage` pass while /leasing/intake rendered
  //  `publicReceipt || message`. Those assertions now live in §5, where the
  //  real resolver is run and the rendered receipt is read. They are not
  //  duplicated here: a source twin of a behavioural assertion only re-pins
  //  the shape, and re-breaks on the next honest refactor without catching
  //  anything the behavioural one missed.

  //  And it now agrees with the canonical resolver, which always refused.
  const ingress = code("src/identity/person_ingress.js");
  ok("the canonical resolver still refuses the same case",
    /disposition: "conflicted"/.test(ingress));

  //  NOT done, deliberately — both are bigger and neither is the defect.
  //  Scoped to the STATEMENT, not the file: an earlier version of this
  //  assertion used /unique[\s\S]*primary_phone_e164/ and matched any file
  //  containing both words anywhere, which is a claim about a search rather
  //  than about the schema. The real index is plain:
  //  `create index if not exists persons_primary_phone_e164_idx`.
  const phoneStatements = fs.readdirSync(path.join(root, "migrations"))
    .flatMap(f => (fs.readFileSync(path.join(root, "migrations", f), "utf8")
      .split(";").filter(st => /primary_phone_e164/.test(st))
      .map(st => ({ file: f, statement: st.replace(/\s+/g, " ").trim().slice(0, 90) }))));
  const uniques = phoneStatements.filter(x => /create\s+unique\s+index|unique\s*\(/i.test(x.statement));
  ok("no unique constraint was added to primary_phone_e164", uniques.length === 0, uniques);
}

// ══════════════════════════════════════════════════════════════════
console.log("\n4 · the second inbound door, and a documented setting that did nothing");
{
  const intake = code("src/onboarding/intake.js");
  //  ALREADY CLOSED here; CURRENT_STATE defect #10 describes the open form.
  ok("/intake/twilio is retired to a deterministic wall",
    /router\.post\("\/intake\/twilio"/.test(intake) && /status\(410\)/.test(intake));
  ok("it parses no provider body before refusing",
    !/express\.urlencoded[\s\S]{0,200}intake\/twilio/.test(intake));
  ok("the spoofable phone allowlist is gone entirely",
    !/INTAKE_ALLOWED_NUMBERS/.test(intake));

  //  A mention is not a guard, and a documented setting nothing reads is a
  //  mention that looks like a control.
  const srcAll = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js")) srcAll.push(fs.readFileSync(p, "utf8"));
    }
  })(path.join(root, "src"));
  srcAll.push(fs.readFileSync(path.join(root, "server.js"), "utf8"));
  const readsIt = srcAll.some(t => /process\.env\.TWILIO_FROM_NUMBER/.test(t));
  const docsIt = /^TWILIO_FROM_NUMBER=/m.test(fs.readFileSync(path.join(root, "docs/deployment.md"), "utf8"));
  ok("TWILIO_FROM_NUMBER is not documented as settable while unread by code",
    !(docsIt && !readsIt), { documented: docsIt, read_by_code: readsIt });
}

// ══════════════════════════════════════════════════════════════════
//  5 · BEHAVIOURAL — the refusal is RUN, not grepped
//
//  Review's sharpest finding: section 3 asserts source text, so the intended
//  refusal could pass its test while never reaching a caller. It did exactly
//  that — the error set `publicMessage` while /leasing/intake renders
//  `publicReceipt || message`.
//
//  These drive the REAL resolveOrCreatePerson. Driving the whole HTTP intake
//  would need a real database; a fake pool broad enough to satisfy its
//  preamble is a database reimplemented badly, and the first attempt here
//  proved it — every case "failed" on a missing lead_sources row, and the
//  control case PASSED for the wrong reason. Stated rather than faked: the
//  end-to-end HTTP assertion is an owed rung, not a claimed one.
// ══════════════════════════════════════════════════════════════════
async function behavioural() {
  console.log("\n5 · the refusal, exercised through the real resolver");

  const TWO = [
    { id: "aaaaaaaa-0000-0000-0000-000000000001", name: "Older Record", phone: "+12155550100", primary_phone_e164: "+12155550100", email: "dup@example.com" },
    { id: "bbbbbbbb-0000-0000-0000-000000000002", name: "Newer Record", phone: "215-555-0100", primary_phone_e164: "+12155550100", email: "dup@example.com" },
  ];

  const mod = require(path.join(root, "src/leasing/leasing_leads"))({
    pool: { connect: async () => ({ query: async () => ({ rows: [] }), release() {} }), query: async () => ({ rows: [] }) },
    anthropic: null, INGEST_MODEL: "test",
    spawnObligationFromEvent: async () => ({ id: "ob" }),
    completeObligation: async () => {}, leasingLifecycle: {},
  });
  const resolve = mod.__test__ && mod.__test__.resolveOrCreatePerson;
  ok("the resolver is reachable for a behavioural test", typeof resolve === "function");
  if (typeof resolve !== "function") { console.log(`\n  ${passed} passed, ${failed} failed\n`); process.exit(1); }

  /** A client answering only the three lookups the resolver performs. */
  const clientFor = ({ canonical = [], legacy = [], email = [] }) => ({
    async query(sql) {
      const q = String(sql);
      if (/primary_phone_e164=\$1/.test(q)) return { rows: canonical };
      if (/regexp_replace\(phone/.test(q)) return { rows: legacy };
      if (/lower\(email\)=lower\(\$1\)/.test(q)) return { rows: email };
      return { rows: [] };
    },
  });

  const attempt = async (rows, input) => {
    try { const r = await resolve(clientFor(rows), input); return { threw: false, r }; }
    catch (e) { return { threw: true, e }; }
  };

  //  ── the branch the first pass left choosing the first row
  {
    const r = await attempt({ legacy: TWO }, { name: "New Prospect", phone: "+1 215 555 0100" });
    ok("legacy-phone ambiguity refuses instead of choosing",
      r.threw && r.e.code === "person_identity_conflicted", r.threw ? r.e.code : "did not throw");
    if (r.threw) {
      ok("it answers 409", r.e.httpStatus === 409, r.e.httpStatus);
      //  THE CONTRACT THE ENDPOINT ACTUALLY RENDERS: publicReceipt || message.
      ok("publicReceipt is set — the field /leasing/intake reads",
        typeof r.e.publicReceipt === "string" && r.e.publicReceipt.length > 0, r.e.publicReceipt);
      const rendered = r.e.publicReceipt || r.e.message;
      ok("the rendered receipt names no phone number",
        !/\d{3}[^a-zA-Z]{0,3}\d{4}/.test(rendered), rendered);
      ok("the rendered receipt names no candidate",
        !/Older Record|Newer Record/.test(rendered), rendered);
      ok("the raw message is safe too, in case a caller renders it",
        !/215/.test(r.e.message), r.e.message);
      ok("candidates ride on the error for the operator surface only",
        Array.isArray(r.e.conflictCandidates) && r.e.conflictCandidates.length === 2,
        r.e.conflictCandidates);
      ok("the evidence type is named", r.e.conflictEvidence === "legacy_phone", r.e.conflictEvidence);
    }
  }

  //  ── the third branch, which the first pass also left choosing
  {
    const r = await attempt({ email: TWO }, { name: "New Prospect", email: "dup@example.com" });
    ok("email ambiguity refuses instead of choosing",
      r.threw && r.e.conflictEvidence === "email", r.threw ? r.e.conflictEvidence : "did not throw");
  }

  //  ── the branch the first pass DID fix, still fixed
  {
    const r = await attempt({ canonical: TWO }, { name: "New Prospect", phone: "+1 215 555 0100" });
    ok("canonical-phone ambiguity still refuses",
      r.threw && r.e.conflictEvidence === "canonical_phone", r.threw ? r.e.conflictEvidence : "did not throw");
  }

  //  ── THE CONTROL. One match is not ambiguity, and this must pass for the
  //  right reason — an earlier version of this case passed because EVERY case
  //  threw, which proves nothing about the refusal being targeted.
  {
    const r = await attempt({ canonical: [TWO[0]] }, { name: "New Prospect", phone: "+1 215 555 0100" });
    ok("a single match resolves normally and does NOT refuse",
      !r.threw && r.r && r.r.person && r.r.person.id === TWO[0].id && r.r.createdPerson === false,
      r.threw ? r.e.message : (r.r && { id: r.r.person && r.r.person.id, created: r.r.createdPerson }));
  }
  {
    const r = await attempt({}, { name: "Nobody Yet", phone: "+1 215 555 0199" });
    ok("no match at all still creates, rather than refusing",
      !r.threw, r.threw ? r.e.message : "no throw");
  }

  //  ── the inquiry is retained rather than lost
  //
  //  Three assertions that used to live here — that retention runs on a fresh
  //  connection after the rollback, that it attaches to no person, and that a
  //  failed retention never becomes a success — were SOURCE SCANS of the
  //  then-current implementation, and one of them went red the moment the
  //  wording changed while the behaviour was fine. All three are now proven
  //  against a real database and a real HTTP request in
  //  tests/proofs/leasing_identity_conflict_http.db.js (§2 and §6), where
  //  a temporary CHECK makes the retention genuinely fail and the receipt is
  //  read back off the wire. Behaviour proves behaviour.
  //
  //  What stays is the one claim that proof structurally cannot make: it can
  //  see that an obligation exists, not HOW it was written. A direct
  //  `insert into obligations` would satisfy every assertion over there while
  //  bypassing the §11 writer and its vocabularies.
  {
    const src = code("src/leasing/leasing_leads.js");
    ok("the review task goes through the canonical obligation writer, not a direct insert",
      /obligations\.spawnObligationFromEvent\(c2,/.test(src) && !/insert into obligations/i.test(src));
    //  Same reasoning, the other direction: the retained evidence must be a
    //  comm_event written person-less. A behavioural proof sees a null
    //  person_id; only source shows nothing later fills it in.
    ok("the retained inquiry is written with no person, by construction",
      /insert into comm_events[\s\S]{0,400}values \(\$1, null, null, null/.test(src));
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}
behavioural();
