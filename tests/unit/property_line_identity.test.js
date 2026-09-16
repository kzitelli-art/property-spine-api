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
  //  THE DEFECT: `order by created_at limit 1` on the canonical phone key
  //  silently adopted the OLDEST person sharing a number, so a reassigned
  //  number attached a new prospect's messages to the previous holder.
  ok("the canonical phone lookup no longer takes the first row",
    !/primary_phone_e164=\$1[\s\S]{0,40}limit 1/.test(leads));
  ok("more than one match is refused, not ranked",
    /byCanon\.length > 1/.test(leads) && /person_identity_conflicted/.test(leads));
  ok("the refusal carries both candidates for a human to resolve",
    /candidates: byCanon\.map/.test(leads));
  ok("it throws, so the enclosing transaction writes nothing partial",
    /throw Object\.assign\([\s\S]{0,200}person_identity_conflicted/.test(leads));
  ok("the refusal is sayable to a person, not a schema word",
    /This phone number is on more than one person record/.test(leads));

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

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
