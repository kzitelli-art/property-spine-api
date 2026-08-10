#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   GATE — EXACTLY ONE PROPERTY WRITER, AND EXACTLY THE KNOWN CALLERS

   Build 0 asked: what is the ONE canonical path by which a client, entity
   and property become durable Spine truth? The measured answer was that
   there was none — four routes created a property and disagreed on
   identity, hierarchy and authority.

   Build 1A-1 collapsed them. This gate now holds the collapse in place:

     THE WRITER    src/identity/property_creation_service.js  — the only
                   product code that may insert into `properties`.
     THE CALLERS   the same four doors, now reaching the service.
     THE HARNESS   one non-route script in src/ that mints its own
                   prefixed rows, registered rather than ignored.

   ── WHAT A FAILURE HERE MEANS ───────────────────────────────────────
   A second writer means a property can come into existence with no
   authenticated actor, no organization, and no creation record — which
   is the exact state Build 1A-1 exists to make unreachable. That is a
   stop condition, not a finding to note and move past.

   ── THE PINS ARE ABOUT BEHAVIOUR, NOT ABOUT NAMES ───────────────────
   Writers do not announce themselves, and neither do lost behaviours.
   B1–B5 read the SERVICE's own source for the three door behaviours the
   collapse promised to preserve and the two authority rules it promised
   to enforce. A merged path that quietly drops the alias-hijack refusal
   would still be "one writer" — and would still be a regression.

   FALSIFIED, not assumed: an unregistered `insert into properties` added
   to another src/ module turns W2 red; deleting the alias-hijack refusal
   from the service turns B1 red. Both were run.

   run:  node tests/gate_property_creation_paths.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src");

/*  ── THE SCOPE IS PART OF THE CLAIM ──────────────────────────────────
 *  This gate scanned `src/` only, and therefore asserted "no product code
 *  outside the canonical service inserts a property" while `POST /properties`
 *  sat in server.js — 3,000+ lines at the repo ROOT, defining routes. Build 0
 *  reported four creation doors; there were five, and this gate laundered the
 *  gap into evidence.
 *
 *  A gate must scan the same scope as the claim it makes. Product code is
 *  `src/` PLUS the root route file. */
const ROOT_ROUTE_FILES = ["server.js"];

const WRITER = "src/identity/property_creation_service.js";

/*  The four doors. Every one is now a CALLER: it resolves an actor and
 *  hands the write to the service. `contributes` is the behaviour that
 *  door brought into the canonical path and that must survive. */
const CALLERS = [
  {
    file: "src/identity/super_admin.js",
    route: "POST /admin/organizations/:id/properties/new",
    source_tag: "super_admin_wizard",
    actor: "req.operator.id (super-admin staff session)",
    contributes: "the organization-bearing hierarchy, and the only live browser caller",
  },
  {
    file: "src/money/bankintake.js",
    route: "POST /bank/onboard-property",
    source_tag: "bank_intake",
    actor: "x-staff-session (added by Build 1A-1; was the shared OPERATOR_KEY)",
    contributes: "canonical-key idempotency — the same key is the same property",
  },
  {
    file: "src/surfaces/owner.js",
    route: "POST /owner/properties/create-from-upload",
    source_tag: "owner_upload",
    actor: "x-staff-session (added by Build 1A-1; was the shared OPERATOR_KEY)",
    contributes: "the alias-hijack refusal, and address→canonical-key derivation",
  },
  {
    file: "server.js",
    route: "POST /properties",
    source_tag: "legacy_properties_route",
    actor: "x-staff-session (added when the door was finally found)",
    contributes: "nothing — a legacy duplicate of the wizard. It is here because " +
                 "Build 0 searched src/ and missed it, and this gate inherited the " +
                 "same blind spot. Collapsed rather than retired: no caller in this " +
                 "repo, but the shared key is held outside it.",
  },
  {
    file: "src/onboarding/dealintake.js",
    route: "POST /deal-intakes/:id/create-property",
    source_tag: "deal_intake",
    actor: "x-staff-session (added by Build 1A-1; was the shared OPERATOR_KEY)",
    contributes: "teach-on-creation — observed labels become resolved aliases",
  },
];

/*  Not a route, and not an authority path — but it lives in `src/` and
 *  can mint a real row. Registered because an unregistered exception is
 *  indistinguishable from an oversight. */
const NON_ROUTE_CREATORS = [
  {
    file: "src/shared/no076_failclosed_check.js",
    prefix: "__CB_NO076__",
    why: "standalone migration-matrix proof script; nothing in the product imports it",
    until: "RETIRE from src/ — relocate under tests/. Deliberately not moved in " +
           "Build 1A-1: gate_harness_isolation.js registers it BY PATH and is " +
           "currently red for unrelated Release 0 reasons, so moving it would " +
           "tangle this slice's evidence with that one's.",
  },
];

/*  ── UNGOVERNED, REGISTERED, DECISION OWED ───────────────────────────
 *  A door the collapse did NOT close, because Build 0 never saw it: the
 *  audit searched `src/` and this lives at the repo root. It is the same
 *  defect class as the four that were collapsed — shared key, no actor, no
 *  organization, no address identity, no creation record.
 *
 *  Registered rather than silently tolerated, and printed LOUDLY on every
 *  run. It is not "authorized"; it is measured, named, and awaiting a
 *  decision. If it is still here in six months, that is a choice someone
 *  made, not a thing nobody noticed. */
//  EMPTY, and deliberately kept rather than deleted.
//
//  It held exactly one entry — server.js's POST /properties, the fifth door
//  Build 0 never saw — for as long as it took to decide what to do with it.
//  That door is now a CALLER above. The list stays because the next
//  ungoverned writer someone finds should land here, named and printed
//  loudly on every run, rather than being quietly tolerated or quietly
//  fixed. An empty register is a statement; a missing one is not.
//
//  Entries are pinned by COUNT (`sites`), not just by file: registering a
//  file would otherwise tolerate a SECOND ungoverned writer appearing
//  beside a known one, which is the laundering this gate exists to stop.
const UNGOVERNED = [];

const ORGANIZATION_CREATORS = [
  {
    file: "src/identity/super_admin.js",
    route: "POST /admin/organizations",
    class: "KEEP — already the single path. Legal entities are NOT next: Spine " +
           "onboards a DEAL, and the deal container comes before capital structure. " +
           "See docs/BUILD_1A_CLOSEOUT.md.",
  },
];

let pass = 0, fail = 0;
const ok = (l, c, d) => {
  if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n        " + d : "")); }
  return c;
};

console.log("════════════════════════════════════════════════════════════════");
console.log("  GATE  gate_property_creation_paths.js");
console.log("  checks: one property writer; the known callers; behaviours kept");
console.log("════════════════════════════════════════════════════════════════");
console.log("  ASSERTIONS STARTED\n");

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

/*  ── WHY THIS IS LINE-LOCAL AND NOT A COMMENT STRIPPER ──────────────
 *  The first version blanked `/* … *\/` spans before scanning. Against
 *  server.js that ATE REAL CODE: an unbalanced `/*` inside a string or
 *  regex earlier in the file made the stripper swallow everything up to
 *  the next `*\/`, including the `insert into properties` on line 273 —
 *  so the gate reported the file as clean. A false NEGATIVE, which is the
 *  dangerous direction, produced by the very function whose comment said
 *  false negatives were the dangerous direction.
 *
 *  So: scan the RAW text, and decide per MATCH whether it is prose by
 *  looking only at its own line. A comment line cannot hide code on a
 *  different line, and nothing can be silently erased. "A mention is not
 *  a guard" still holds for the case that actually occurs — a sentence in
 *  a header mentioning the statement. */
function isProse(text, index) {
  const lineStart = text.lastIndexOf("\n", index) + 1;
  const line = text.slice(lineStart, index).trimStart();
  //  The match sits after `//`, or on a `*`/`/*` continuation line.
  return line.startsWith("//") || line.startsWith("*") || line.startsWith("/*");
}

function scanInserts(table) {
  const STMT = new RegExp("insert\\s+into\\s+(?:public\\.)?" + table + "\\b[\\s\\S]{0,600}?`", "gi");
  const found = [];
  const files = [...walk(SRC),
                 ...ROOT_ROUTE_FILES.map((f) => path.join(ROOT, f)).filter(fs.existsSync)];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    const rel = path.relative(ROOT, file);
    for (const m of text.matchAll(STMT)) {
      if (isProse(text, m.index)) continue;          // a header sentence, not a writer
      found.push({ rel, line: text.slice(0, m.index).split("\n").length, stmt: m[0] });
    }
  }
  return found;
}

const propInserts = scanInserts("properties");
const orgInserts = scanInserts("organizations");
//  B1-B5 must be satisfied by behaviour, not by a sentence describing it,
//  so prose lines are dropped — line-by-line, never by span, for the reason
//  in isProse above.
const writerSrc = fs.readFileSync(path.join(ROOT, WRITER), "utf8")
  .split("\n").filter((l) => {
    const t = l.trimStart();
    return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
  }).join("\n");

// ── W1  the scan is not broken ──────────────────────────────────────
ok("W1  the scan found property-insert sites at all", propInserts.length > 0,
   "zero found — the scan is broken and would pass anything");
console.log("        " + propInserts.length + " property insert site(s), " +
            orgInserts.length + " organization insert site(s)\n");

// ── W2  exactly one product writer ──────────────────────────────────
const allowed = new Set([WRITER, ...NON_ROUTE_CREATORS.map((c) => c.file),
                         ...UNGOVERNED.map((c) => c.file)]);
const unregistered = propInserts.filter((f) => !allowed.has(f.rel))
  .map((f) => f.rel + ":" + f.line);

for (const f of propInserts) {
  if (f.rel === WRITER) console.log("  ok    " + f.rel + ":" + f.line + "  THE WRITER");
  else if (UNGOVERNED.some((c) => c.file === f.rel))
    console.log("  ⚠     " + f.rel + ":" + f.line + "  UNGOVERNED — decision owed");
  else if (allowed.has(f.rel)) console.log("  ok    " + f.rel + ":" + f.line + "  registered non-route harness");
}
if (propInserts.some((f) => f.rel === WRITER)) pass++;

ok("W2  NO UNREGISTERED property writer exists (see the UNGOVERNED list below)",
   unregistered.length === 0,
   unregistered.join("\n        ") +
   "\n        → a second writer means a property can exist with no authenticated actor," +
   "\n          no organization and no creation record. That is the state Build 1A-1" +
   "\n          made unreachable. STOP.");

// ── W3  the writer is still there ───────────────────────────────────
ok("W3  the canonical writer still writes", propInserts.some((f) => f.rel === WRITER),
   WRITER + " no longer inserts a property — the collapse has been undone");

// ── W3b  a registered ungoverned file may not GROW ──────────────────
for (const c of UNGOVERNED) {
  const n = propInserts.filter((f) => f.rel === c.file).length;
  ok("W3b " + c.file + " still has exactly " + c.sites + " ungoverned writer, not more",
     n === c.sites,
     "measured " + n + ", registered " + c.sites +
     "\n        → a NEW ungoverned writer appeared beside a known one. Registering a" +
     "\n          file must never become a licence to add to it. STOP.");
}

// ── W4  the non-route creator stays confined to its own prefix ──────
for (const c of NON_ROUTE_CREATORS) {
  const stmts = propInserts.filter((f) => f.rel === c.file).map((f) => f.stmt).join("\n");
  ok("W4  " + path.basename(c.file) + " creates only its own '" + c.prefix + "' rows",
     stmts.includes(c.prefix),
     "it now writes a property row with no distinguishing prefix, from a script with" +
     "\n        no authenticated actor and no organization. That is a creation path. STOP.");
}

// ── W5  no unregistered organization creator ────────────────────────
const unregOrg = orgInserts.filter((f) => !ORGANIZATION_CREATORS.some((c) => c.file === f.rel))
  .map((f) => f.rel + ":" + f.line);
ok("W5  NO unregistered organization-creation path exists in src/", unregOrg.length === 0,
   unregOrg.join("\n        ") +
   "\n        → two answers to 'who is the customer'. STOP.");

// ════════════════════════════════════════════════════════════════════
console.log("\n  ── CALLERS · each door reaches the service, with an actor ──");
// ════════════════════════════════════════════════════════════════════
for (const c of CALLERS) {
  const src = fs.readFileSync(path.join(ROOT, c.file), "utf8");
  const callsService = /propertyCreation\.createProperty\s*\(/.test(src)
    && /require\(["'][^"']*property_creation_service[^"']*["']\)/.test(src);
  const namesItself = src.includes(`"${c.source_tag}"`);
  //  A door that calls the service but never resolves a human is a door
  //  that will be refused at runtime — better to catch it here.
  const resolvesActor = /resolveStaffSession\s*\(/.test(src) || /req\.operator\.id/.test(src);

  ok("C   " + c.route,
     callsService && namesItself && resolvesActor,
     [!callsService ? "does not call the canonical service" : null,
      !namesItself ? `does not name its source tag '${c.source_tag}'` : null,
      !resolvesActor ? "does not resolve an authenticated actor" : null]
       .filter(Boolean).join("; ") +
     "\n        → a door that writes without naming itself cannot be attributed," +
     "\n          and a door with no actor cannot be authorised.");
}

//  The service's source tags and the callers' must be the same set, in
//  both directions: an orphan tag in the service is a door nobody uses,
//  and a tag no caller declares means the register has drifted.
//  Derived from the register, not hardcoded — a literal list here would
//  drift silently the moment a caller was added, which is exactly what
//  happened when the fifth door was collapsed.
const tagRe = new RegExp('"(' + CALLERS.map((c) => c.source_tag).join("|") + ')"', "g");
const tagsInService = (writerSrc.match(tagRe) || []).map((s) => s.replace(/"/g, ""));
const declared = new Set(CALLERS.map((c) => c.source_tag));
ok("C5  the service's creation-source list and the callers agree exactly",
   [...declared].every((t) => tagsInService.includes(t))
     && [...new Set(tagsInService)].every((t) => declared.has(t)),
   "service: " + JSON.stringify([...new Set(tagsInService)]) +
   "  callers: " + JSON.stringify([...declared]));

// ════════════════════════════════════════════════════════════════════
console.log("\n  ── BEHAVIOURS · what the collapse promised to preserve ──");
// ════════════════════════════════════════════════════════════════════
//  Read out of the SHIPPED service. "One writer" is not the whole
//  promise: the merged path had to keep the best behaviour of each door,
//  not the average of them.

ok("B1  owner.js's ALIAS-HIJACK REFUSAL survived the collapse",
   /alias_conflict/.test(writerSrc)
     && /confidence\s*=\s*'resolved'/.test(writerSrc)
     && /rollback/.test(writerSrc),
   "the service no longer refuses to re-point a string already resolved elsewhere." +
   "\n        That refusal was the best identity behaviour of the four doors.");

ok("B2  bankintake's CANONICAL-KEY IDEMPOTENCY survived the collapse",
   /idempotent/.test(writerSrc) && /created:\s*false/.test(writerSrc),
   "the same canonical key can now produce a duplicate property");

ok("B3  dealintake's TEACH-ON-CREATION survived the collapse",
   /insert into property_aliases/i.test(writerSrc) && /aliases_taught/.test(writerSrc),
   "observed identity strings are no longer taught at creation");

ok("B4  identity is derived from the address, or its absence is EXPLAINED",
   /deriveCanonicalKey/.test(writerSrc)
     && /canonical_key_absent_reason/.test(writerSrc),
   "a keyless property is silent again — Build 1B's activation object reads" +
   "\n        canonical_key_absent_reason to show identity as Missing");

ok("B5  the scope rule is enforced in the service, not at the doors",
   /organization_scope_violation/.test(writerSrc)
     && /insufficient_platform_role/.test(writerSrc)
     && /no_authenticated_actor/.test(writerSrc),
   "an authority rule that lives in a route is an authority rule three other" +
   "\n        routes do not have. That was the Build 0 defect.");

//  The containment must be provable, not merely present. A refusal
//  nobody has seen fire is a refusal nobody has seen.
const PROOFS = ["tests/property_creation_canonical.db.js", "tests/property_creation_http.db.js"];
const missing = PROOFS.filter((p) => !fs.existsSync(path.join(ROOT, p)));
ok("B6  both proofs of this path still exist in the tree", missing.length === 0,
   "missing: " + missing.join(", ") +
   "\n        → Build 0 measured ZERO coverage on these routes. Losing it again is" +
   "\n          the regression, not the absence.");

console.log("\n  ── REGISTER ──");
console.log("    WRITER  " + WRITER);
for (const c of CALLERS) {
  console.log("    CALLER  " + c.route);
  console.log("      file:        " + c.file + "   [" + c.source_tag + "]");
  console.log("      actor:       " + c.actor);
  console.log("      contributes: " + c.contributes);
}
for (const c of NON_ROUTE_CREATORS) {
  console.log("    HARNESS IN src/  " + c.file + "   (prefix " + c.prefix + ")");
  console.log("      why:   " + c.why);
  console.log("      until: " + c.until);
}
for (const c of ORGANIZATION_CREATORS) {
  console.log("    ORGANIZATION  " + c.route + "   " + c.file);
}
if (UNGOVERNED.length) {
  console.log("\n  ══ UNGOVERNED · DECISION OWED ══════════════════════════════");
  for (const c of UNGOVERNED) {
    console.log("    ⚠  " + c.route + "   [" + c.file + "]");
    console.log("       why:   " + c.why);
    console.log("       risk:  " + c.risk);
    console.log("       until: " + c.until);
  }
  console.log("  ═══════════════════════════════════════════════════════════");
}

console.log("\n  Audit:   docs/BUILD_0_ONBOARDING_AUTHORITY_AUDIT.md");
console.log("  Receipt: docs/BUILD_1A1_PROPERTY_CREATION_COLLAPSE.md");

console.log("\n════════════════════════════════════════════════════════════════");
console.log(`  ASSERTIONS COMPLETE · ${pass + fail} run · ${pass} passed · ${fail} failed`);
console.log("  " + (fail === 0 ? "✓ PASS" : "✗ FAIL") + " — gate_property_creation_paths.js");
console.log("  EXIT      " + (fail === 0 ? 0 : 1));
console.log("════════════════════════════════════════════════════════════════\n");
process.exit(fail === 0 ? 0 : 1);
