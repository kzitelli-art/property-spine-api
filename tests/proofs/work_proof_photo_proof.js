// ════════════════════════════════════════════════════════════════════
//  work_proof_photo_proof.js — ONE PHOTO, ONE COMPLETION ACTION
//
//    node tests/proofs/work_proof_photo_proof.js
//
//  The closure slice: a technician opens the work, adds one completion photo,
//  and presses Complete. This harness tries to break that — with the wrong
//  file, the wrong property, the wrong work item, the wrong module, and a
//  failing transaction.
//
//  ── NO DATABASE ─────────────────────────────────────────────────────
//  The attachment service is exercised against a recording double that
//  behaves like Postgres for the queries it issues. That proves the CONTROL
//  FLOW — what is written, in what order, inside whose transaction, and what
//  is refused. It does NOT prove that Postgres enforces the foreign keys and
//  the check constraints, which is stated rather than implied.
// ════════════════════════════════════════════════════════════════════

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const A = require("../../src/maintenance/work_proof_attachment_service");
const PROOF = require("../../src/maintenance/work_proof");
const { makeWorkAcceptanceService } = require("../../src/maintenance/work_acceptance_service");
const INTENT = require("../../src/agent/staff_agent_intent");

let passed = 0, failed = 0;
const fails = [];
const ok = (n, c, d) => { if (c) passed++; else { failed++; fails.push(n + (d ? "  — " + d : "")); } };
const section = (t) => console.log("\n── " + t + " " + "─".repeat(Math.max(0, 60 - t.length)));

const REPO = path.join(__dirname, "..", "..");
const src = (p) => fs.readFileSync(path.join(REPO, p), "utf8");
//  A comment explaining what a file does NOT do must not fail an assertion
//  that the file does not do it. Code only, and for operator copy, only the
//  strings a surface can actually print.
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter((l) => !/^\s*\/\//.test(l)).map((l) => l.replace(/\s\/\/.*$/, "")).join("\n");
//  `a.uploaded_by` prints a person's NAME; it does not print the word
//  "uploaded_by". Member expressions and esc() calls are values, not copy, and
//  leaving them in also breaks a naive quote lexer on concatenated HTML.
const printable = (s) =>
  (code(s)
    .replace(/esc\([^)]*\)/g, "\u0001")
    .replace(/\$\{[^}]*\}/g, "\u0001")
    .replace(/\b[A-Za-z_$][\w$]*\.[\w$.]+/g, "\u0001")
    .match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g) || []).join("\n");
const app = (p) => fs.readFileSync(path.join("/workspace/property-spine-app", p), "utf8");

//  Real magic bytes. A "photo" in this harness is a byte sequence a decoder
//  would accept the header of, not a string pretending to be one.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2048, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2048, 7)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(2048, 7)]);
const PDF = Buffer.concat([Buffer.from("%PDF-1.4"), Buffer.alloc(2048, 7)]);
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(2048, 7)]);
const file = (buf, name, declared) => ({ buffer: buf, originalname: name, mimetype: declared });

// ════════════════════════════════════════════════════════════════════
section("1  UPLOAD AND STORAGE — what is accepted, and what is not");
{
  const cases = [
    ["a real JPEG", file(JPEG, "a.jpg", "image/jpeg"), true, "image/jpeg"],
    ["a real PNG", file(PNG, "a.png", "image/png"), true, "image/png"],
    ["a real WebP", file(WEBP, "a.webp", "image/webp"), true, "image/webp"],
    ["zero bytes", file(Buffer.alloc(0), "a.jpg", "image/jpeg"), false],
    ["a PDF named .jpg and DECLARED image/jpeg", file(PDF, "photo.jpg", "image/jpeg"), false],
    ["a GIF", file(GIF, "a.gif", "image/gif"), false],
    ["6 MB", file(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(6 * 1024 * 1024)]), "a.jpg", "image/jpeg"), false],
    ["no file at all", null, false],
    ["a string instead of a buffer", { buffer: "photo.jpg", originalname: "a.jpg" }, false],
  ];
  for (const [name, f, expect, mime] of cases) {
    const r = A.validateUpload(f);
    ok(`${name} → ${expect ? "accepted" : "REFUSED"}`, r.ok === expect, r.reason || r.mime_type);
    if (expect) ok(`  …and the type comes from the BYTES (${mime})`, r.mime_type === mime, r.mime_type);
  }

  //  The declared type is recorded and explicitly not trusted.
  const r = A.validateUpload(file(PNG, "a.jpg", "image/jpeg"));
  ok("a PNG declared as JPEG is stored as PNG — the bytes win",
     r.ok === true && r.mime_type === "image/png", r.mime_type);
  ok("and the declared type is marked untrusted", r.declared_mime_trusted === false);

  //  Digest.
  const d = A.validateUpload(file(JPEG, "a.jpg", "image/jpeg"));
  ok("a sha256 digest is computed", /^[0-9a-f]{64}$/.test(d.sha256));
  ok("and it is the digest of exactly these bytes",
     d.sha256 === crypto.createHash("sha256").update(JPEG).digest("hex"));

  //  Limits are stated once.
  ok("the size limit is 5 MB", A.MAX_BYTES === 5 * 1024 * 1024, String(A.MAX_BYTES));
  ok("exactly three mime types are allowed",
     A.ALLOWED_MIME.join(",") === "image/jpeg,image/png,image/webp", A.ALLOWED_MIME.join(","));
}

// ════════════════════════════════════════════════════════════════════
section("2  THE ROW RECORDS WHO, WHERE AND WHAT — and never returns bytes");
{
  const svc = A.makeWorkProofAttachmentService();
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      if (/insert into work_proof_attachments/i.test(sql)) {
        return { rows: [{
          id: "att-1", property_id: params[0], unit_id: params[1], work_id: params[2],
          uploaded_by_user_id: params[3], original_filename: params[4],
          mime_type: params[5], byte_size: params[6], sha256: params[7],
          created_at: "2026-07-29T00:00:00Z",
        }] };
      }
      return { rows: [] };
    },
  };

  const p = svc.storeForWork(client, {
    work_id: "w1", property_id: "p1", unit_id: "u1", uploaded_by_user_id: "tech-1",
    file: file(JPEG, "IMG_4021.jpg", "image/jpeg"),
  }).then((row) => {
    ok("the row names the property", row.property_id === "p1");
    ok("the row names the unit", row.unit_id === "u1");
    ok("the row names the work item", row.work_id === "w1");
    ok("the row names the uploader", row.uploaded_by_user_id === "tech-1");
    ok("the original filename is kept for a human", row.original_filename === "IMG_4021.jpg");
    ok("the digest is stored", /^[0-9a-f]{64}$/.test(row.sha256));
    ok("the server-generated time is stored", !!row.created_at);

    //  THE BYTES DO NOT COME BACK.
    ok("the returned row carries NO content", row.content === undefined);
    ok("nor any bytea-shaped field",
       !Object.keys(row).some((k) => /content|bytes|blob|data/i.test(k)), Object.keys(row).join(","));
    const insert = calls.find((c) => /insert into work_proof_attachments/i.test(c.sql));
    ok("the INSERT's returning list excludes content", !/returning[\s\S]*\bcontent\b/i.test(insert.sql));

    //  It is JSON-safe.
    ok("the row serialises without leaking bytes", !/\\u0007|Buffer/.test(JSON.stringify(row)));
  });

  //  A refused file writes nothing.
  const before = calls.length;
  const p2 = svc.storeForWork(client, {
    work_id: "w1", property_id: "p1", unit_id: "u1", uploaded_by_user_id: "tech-1",
    file: file(PDF, "photo.jpg", "image/jpeg"),
  }).then(() => ok("a PDF is refused before any write", false, "it was accepted"))
    .catch(() => {
      ok("a PDF is refused before any write", true);
      ok("and no INSERT was issued for it",
         calls.filter((c) => /insert into work_proof_attachments/i.test(c.sql)).length === 1);
    });

  //  An attachment with no uploader is refused.
  const p3 = svc.storeForWork(client, {
    work_id: "w1", property_id: "p1", unit_id: "u1", file: file(JPEG, "a.jpg"),
  }).then(() => ok("an unattributed attachment is refused", false))
    .catch((e) => ok("an unattributed attachment is refused", /uploader|attributed/i.test(e.message), e.message));

  module.exports.__p2 = Promise.all([p, p2, p3]);
}

// ════════════════════════════════════════════════════════════════════
section("3  RESOLUTION IS WORK-SCOPED — one photo cannot close another job");
{
  const svc = A.makeWorkProofAttachmentService();
  //  A double that behaves like the real query: it returns only rows matching
  //  ALL FOUR of id, property, unit and work.
  const STORE = [
    { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", property_id: "p1", unit_id: "u1", work_id: "w1" },
    { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", property_id: "p1", unit_id: "u1", work_id: "w2" },
    { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", property_id: "p2", unit_id: "u9", work_id: "w9" },
  ];
  const client = {
    query: async (sql, params) => {
      if (!/from work_proof_attachments/i.test(sql)) return { rows: [] };
      const [ids, prop, unit, work] = params;
      return { rows: STORE.filter((r) =>
        ids.includes(r.id) && r.property_id === prop && r.unit_id === unit && r.work_id === work) };
    },
  };
  const scope = { property_id: "p1", unit_id: "u1", work_id: "w1" };
  const run = async (refs) => svc.resolveForWork(client, Object.assign({ references: refs }, scope));

  const p = (async () => {
    ok("the attachment for THIS work resolves",
       (await run(["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"])).length === 1);
    ok("an attachment from ANOTHER WORK ITEM does not",
       (await run(["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"])).length === 0);
    ok("an attachment from ANOTHER PROPERTY does not",
       (await run(["cccccccc-cccc-4ccc-8ccc-cccccccccccc"])).length === 0);
    ok("a nonexistent id does not",
       (await run(["dddddddd-dddd-4ddd-8ddd-dddddddddddd"])).length === 0);
    ok("a typed string does not", (await run(["photo.jpg"])).length === 0);
    ok("a bare space does not", (await run([" "])).length === 0);
    ok("a malformed id does not throw, it simply does not resolve",
       (await run(["not-a-uuid", "'; drop table --"])).length === 0);
    ok("mixed valid and invalid resolves only the valid one",
       (await run(["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"])).length === 1);
    ok("an empty list resolves to nothing", (await run([])).length === 0);
  })();
  module.exports.__p3 = p;

  //  The contract is work-scoped in SOURCE, not just in this double.
  const S = src("src/maintenance/work_proof_attachment_service.js");
  ok("the query filters on all four scopes",
     /where id = any\(\$1::uuid\[\]\)[\s\S]{0,120}property_id = \$2 and unit_id = \$3 and work_id = \$4/.test(S));
  ok("there is no property-only resolver left", !/resolveForProperty/.test(S));
  ok("nor in the acceptance service", !/resolveForProperty/.test(src("src/maintenance/work_acceptance_service.js")));
}

// ════════════════════════════════════════════════════════════════════
section("3B  A TYPED REFERENCE IS NOT PROOF — the defect this slice fixes");
{
  //  ADDED AFTER A NEGATIVE-CONTROL RUN. Reverting evaluateProof to count raw
  //  `proof_photos` was caught by work_acceptance_proof and
  //  release_candidate_proof — and NOT by this file, the one named for photo
  //  proof. A harness that cannot fail on its own subject is decoration.
  //  `PROOF` was imported here and never called; now it is exercised.
  const WORK = { id: "w1", property_id: "p1", unit_id: "u1", stage: "paint",
                 work_text: "Paint the living room" };
  const REAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const AVAILABLE = { attachments_available: true };

  //  The original defect, verbatim: a typed space closed the work.
  const typed = PROOF.evaluateProof(WORK,
    { outcome: "completed", proof_photos: [" "], verified_photos: [] }, AVAILABLE);
  ok("a typed space does NOT satisfy proof", typed.satisfied === false, typed.shortfall);
  ok("and it counts zero verified photos", typed.verified_photo_count === 0);

  //  Nor does a plausible-looking id that was never resolved.
  const unresolved = PROOF.evaluateProof(WORK,
    { outcome: "completed", proof_photos: [REAL], verified_photos: [] }, AVAILABLE);
  ok("an unresolved attachment id does NOT satisfy proof", unresolved.satisfied === false);
  ok("the shortfall asks for a photo, not for better text",
     /a completion photo/.test(unresolved.shortfall || ""), unresolved.shortfall);

  //  A RESOLVED attachment does.
  const resolved = PROOF.evaluateProof(WORK,
    { outcome: "completed", proof_photos: [REAL], verified_photos: [REAL] }, AVAILABLE);
  ok("a verified attachment DOES satisfy proof", resolved.satisfied === true, resolved.shortfall);
  ok("and it counts one", resolved.verified_photo_count === 1);

  //  FAIL CLOSED. No store declared → nothing is verified, whatever is passed.
  const noStore = PROOF.evaluateProof(WORK,
    { outcome: "completed", proof_photos: [REAL], verified_photos: [REAL] }, { attachments_available: false });
  ok("with no attachment store, even 'verified' references count for nothing",
     noStore.satisfied === false, noStore.shortfall);
  ok("and it says so rather than telling the operator to add a photo",
     noStore.photo_proof_unavailable === true && /unavailable/i.test(noStore.shortfall || ""));

  //  A caller that forgets the context argument gets the safe answer.
  const noCtx = PROOF.evaluateProof(WORK, { outcome: "completed", verified_photos: [REAL] });
  ok("omitting the context entirely fails closed", noCtx.satisfied === false);

  //  SOURCE: raw proof_photos is never counted.
  const WP = src("src/maintenance/work_proof.js");
  const body = WP.slice(WP.indexOf("function evaluateProof"), WP.indexOf("// Plain-language labels"));
  ok("evaluateProof never reads claim.proof_photos", !/claim\.proof_photos/.test(body));
  ok("it reads claim.verified_photos", /claim\.verified_photos/.test(body));
  ok("gated on attachments_available", /attachmentsAvailable && Array\.isArray\(claim\.verified_photos\)/.test(body));

  //  But the operator's raw input is still KEPT as history.
  ok("the acceptance service still records proof_photos verbatim",
     /proof_photos/.test(src("src/maintenance/work_acceptance_service.js")));
}

// ════════════════════════════════════════════════════════════════════
//  Shared by sections 4 and 4B: the transaction double. Module scope, because
//  atomicity and authority are two questions about the SAME transaction and
//  must be asked of the same recording client.
{
  //  A double that fails at a chosen statement, so the ordering can be
  //  observed rather than assumed.
  //  `modules` is what property_team_assignments would return for this actor.
  //  claimCompletion now asks, so the double must answer — which means every
  //  transaction below states the actor's authority out loud instead of
  //  assuming it.
  function clientThatFailsOn(pattern, modules) {
    const mods = modules === undefined ? ["maintenance"] : modules;
    const issued = [];
    return {
      issued,
      query: async (sql, params) => {
        const s = String(sql);
        issued.push(s.replace(/\s+/g, " ").slice(0, 60));
        if (pattern && pattern.test(s)) throw new Error("simulated failure: " + pattern);
        if (/from property_team_assignments/i.test(s)) {
          //  The real query filters on the module inside SQL, so an actor
          //  without it matches no row.
          //
          //  CORRECTED AFTER A NEGATIVE-CONTROL RUN. This used to test for the
          //  literal `array['maintenance']` and refuse anyone lacking it —
          //  which meant WIDENING the SQL to `maintenance OR management` was
          //  not caught: the token was still there, so the double still
          //  refused a manager the real query would now admit. The double has
          //  to read the predicate, not spot a word in it.
          const wanted = [...s.matchAll(/array\['(\w+)'\]/g)].map((m) => m[1]);
          if (!wanted.length) return { rows: [{ "?column?": 1 }] };
          //  Several module tests joined by OR admit anyone holding any one of
          //  them; a single test admits only holders of that one.
          const satisfied = wanted.length > 1 && /\bor\b/i.test(s)
            ? wanted.some((m) => mods.includes(m))
            : wanted.every((m) => mods.includes(m));
          return { rows: satisfied ? [{ "?column?": 1 }] : [] };
        }
        if (/from unit_triage_required_work/i.test(s) && /where w\.id/i.test(s)) {
          return { rows: [{ id: "w1", property_id: "p1", unit_id: "u1", status: "required",
                            stage: "repair", work_text: "Source and install refrigerator" }] };
        }
        if (/insert into work_proof_attachments/i.test(s)) {
          return { rows: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", property_id: "p1", unit_id: "u1",
                            work_id: "w1", mime_type: "image/jpeg", byte_size: 2052,
                            sha256: "x".repeat(64), created_at: "2026-07-29T00:00:00Z" }] };
        }
        if (/select id from work_proof_attachments/i.test(s)) {
          return { rows: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }] };
        }
        if (/insert into work_completion_claims/i.test(s)) {
          return { rows: [{ id: "claim-1", outcome: "completed", proof_satisfied: true, proof_shortfall: null }] };
        }
        if (/insert into events/i.test(s)) return { rows: [{ id: "ev-1" }] };
        return { rows: [] };
      },
    };
  }
  module.exports.__mkClient = clientThatFailsOn;
}
const clientThatFailsOn = module.exports.__mkClient;

// ════════════════════════════════════════════════════════════════════
section("4  ATOMICITY — the photo and the claim commit together or not at all");
{

  const ATT = A.makeWorkProofAttachmentService();
  const mk = () => makeWorkAcceptanceService({
    spawnObligationFromEvent: async () => ({}), attachmentService: ATT,
  });

  //  The ORDER: attachment insert, then resolution, then the claim.
  const c1 = clientThatFailsOn(null);
  const p1 = mk().claimCompletion(c1, {
    work_id: "w1", property_id: "p1", actor_user_id: "tech-1", outcome: "completed",
    functional_confirmation: "it cools now", proof_file: file(JPEG, "a.jpg", "image/jpeg"),
  }).then(() => {
    const att = c1.issued.findIndex((s) => /insert into work_proof_attachments/i.test(s));
    const res = c1.issued.findIndex((s) => /select id from work_proof_attachments/i.test(s));
    const clm = c1.issued.findIndex((s) => /insert into work_completion_claims/i.test(s));
    ok("the attachment is written first", att > -1 && att < res, `att=${att} res=${res}`);
    ok("then resolved", res > -1 && res < clm, `res=${res} clm=${clm}`);
    ok("then the claim is written", clm > -1);
    ok("all three are issued on the SAME client — one transaction",
       att > -1 && res > -1 && clm > -1);
  }).catch((e) => ok("the happy path completes", false, e.message));

  //  A FAILING CLAIM must not leave the attachment behind. Because both run on
  //  the caller's transaction, the rollback is the caller's — there is no
  //  cleanup path to get wrong.
  const c2 = clientThatFailsOn(/insert into work_completion_claims/i);
  const p2 = mk().claimCompletion(c2, {
    work_id: "w1", property_id: "p1", actor_user_id: "tech-1", outcome: "completed",
    functional_confirmation: "it cools now", proof_file: file(JPEG, "a.jpg", "image/jpeg"),
  }).then(() => ok("a failing claim propagates", false, "it resolved"))
    .catch(() => {
      ok("a failing claim propagates the error to the caller", true);
      ok("and the attachment insert was on the same transaction, so it rolls back with it",
         c2.issued.some((s) => /insert into work_proof_attachments/i.test(s)));
      ok("no completion claim survives", !c2.issued.some((s) => /update unit_triage_required_work/i.test(s)));
    });

  //  A FAILING ATTACHMENT INSERT must record no claim at all.
  const c3 = clientThatFailsOn(/insert into work_proof_attachments/i);
  const p3 = mk().claimCompletion(c3, {
    work_id: "w1", property_id: "p1", actor_user_id: "tech-1", outcome: "completed",
    functional_confirmation: "it cools now", proof_file: file(JPEG, "a.jpg", "image/jpeg"),
  }).then(() => ok("a failing attachment insert aborts the completion", false, "it resolved"))
    .catch(() => {
      ok("a failing attachment insert aborts the completion", true);
      ok("and NO completion claim was written",
         !c3.issued.some((s) => /insert into work_completion_claims/i.test(s)));
    });

  //  A PROOF-SHORT CLAIM still records, and leaves the work open.
  const c4 = clientThatFailsOn(null);
  const p4 = mk().claimCompletion(c4, {
    work_id: "w1", property_id: "p1", actor_user_id: "tech-1", outcome: "completed",
    functional_confirmation: "it cools now",
  }).then((out) => {
    ok("a claim with no photo is still RECORDED", c4.issued.some((s) => /insert into work_completion_claims/i.test(s)));
    ok("and the work is NOT closed", out.closed === false);
    ok("and the shortfall names the missing photo", /photo/i.test(out.proof.shortfall || ""), out.proof.shortfall);
    ok("and no attachment was written", !c4.issued.some((s) => /insert into work_proof_attachments/i.test(s)));
  }).catch((e) => ok("a proof-short claim records", false, e.message));

  module.exports.__p4 = Promise.all([p1, p2, p3, p4]);

  //  STRUCTURAL: the service writes through the caller's client, never a pool.
  const ACC = src("src/maintenance/work_acceptance_service.js");
  ok("claimCompletion takes the caller's client", /async function claimCompletion\(client, spec\)/.test(ACC));
  ok("the attachment is stored through that same client",
     /attachmentService\.storeForWork\(client,/.test(ACC));
  ok("and resolved through it too", /attachmentService\.resolveForWork\(client,/.test(ACC));
  ok("the attachment service never opens its own connection",
     !/pool\.connect|new Pool|require\("pg"\)/.test(src("src/maintenance/work_proof_attachment_service.js")));
  ok("property and unit come from the WORK ROW, never the request",
     /work_id: w\.id, property_id: w\.property_id, unit_id: w\.unit_id/.test(ACC));
}

// ════════════════════════════════════════════════════════════════════
section("4B  MAINTENANCE IS REQUIRED TO RECORD A COMPLETION");
{
  //  The ruled model splits READ from OPERATE. The structured door already
  //  required maintenance; the staff-agent door admits maintenance OR
  //  management and could confirm a work_completion proposal straight into
  //  claimCompletion. Two doors, two answers to "may this person close a
  //  job", and the conversational one was weaker.
  //
  //  The check now lives in the CANONICAL SERVICE, so both doors — and
  //  anything written later — pass it. These assertions call the service
  //  directly: no route, no session, no middleware.
  const ATT2 = A.makeWorkProofAttachmentService();
  const mk2 = () => makeWorkAcceptanceService({
    spawnObligationFromEvent: async () => ({}), attachmentService: ATT2,
  });

  const p4b = (async () => {
    for (const [who, mods] of [["management-only", ["management"]],
                               ["no modules at all", []],
                               ["leasing-only", ["leasing"]]]) {
      const c = clientThatFailsOn(null, mods);
      let err = null;
      try {
        await mk2().claimCompletion(c, {
          work_id: "w1", property_id: "p1", actor_user_id: "mgr-1", outcome: "completed",
          functional_confirmation: "it cools now", proof_file: file(JPEG, "a.jpg", "image/jpeg"),
        });
      } catch (e) { err = e; }
      ok(`a ${who} actor is REFUSED`, !!err, err && err.message);
      ok(`  …with 403, not 400 or 500`, err && err.httpStatus === 403, err && String(err.httpStatus));
      ok(`  …and the message explains what is needed`,
         err && /maintenance-module access/.test(err.message), err && err.message);
      ok(`  …and says nothing was recorded`,
         err && /Nothing was recorded/.test(err.message));
      //  NOTHING SURVIVES THE REFUSAL.
      const wrote = (re) => c.issued.some((x) => re.test(x));
      ok(`  …no photo was stored`, !wrote(/insert into work_proof_attachments/i), c.issued.join(" | "));
      ok(`  …no completion claim was written`, !wrote(/insert into work_completion_claims/i));
      ok(`  …no event was written`, !wrote(/insert into events/i));
      ok(`  …no obligation was closed`, !wrote(/update obligations/i));
      ok(`  …no work state changed`, !wrote(/update unit_triage_required_work/i));
    }

    //  A MAINTENANCE actor still completes normally.
    const good = clientThatFailsOn(null, ["maintenance"]);
    const out = await mk2().claimCompletion(good, {
      work_id: "w1", property_id: "p1", actor_user_id: "tech-1", outcome: "completed",
      functional_confirmation: "it cools now", proof_file: file(JPEG, "a.jpg", "image/jpeg"),
    });
    ok("a maintenance actor completes through the canonical service", !!out.claim);
    ok("and the photo was stored",
       good.issued.some((x) => /insert into work_proof_attachments/i.test(x)));

    //  maintenance + management is still maintenance.
    const both = clientThatFailsOn(null, ["maintenance", "management"]);
    const out2 = await mk2().claimCompletion(both, {
      work_id: "w1", property_id: "p1", actor_user_id: "pm-1", outcome: "completed",
      functional_confirmation: "it cools now", proof_file: file(JPEG, "a.jpg", "image/jpeg"),
    });
    ok("an actor holding BOTH modules completes normally", !!out2.claim);

    //  AUTHORITY IS DECIDED BEFORE ANYTHING ELSE IS READ.
    const order = clientThatFailsOn(null, ["management"]);
    try {
      await mk2().claimCompletion(order, {
        work_id: "w1", property_id: "p1", actor_user_id: "mgr-1", outcome: "completed",
        proof_file: file(JPEG, "a.jpg", "image/jpeg"),
      });
    } catch (_) {}
    const loaded = order.issued.findIndex((x) => /from unit_triage_required_work/i.test(x));
    const asked = order.issued.findIndex((x) => /from property_team_assignments/i.test(x));
    ok("the work row is loaded first, so property comes from IT",
       loaded > -1 && loaded < asked, order.issued.join(" | "));
    ok("and authority is the very next thing asked",
       asked === loaded + 1, order.issued.join(" | "));
    ok("the refusal is the LAST statement issued — nothing followed it",
       asked === order.issued.length - 1, order.issued.join(" | "));
  })();
  module.exports.__p4b = p4b;

  //  SOURCE: the check is in the service, keyed on the work row and the actor.
  const SVC = src("src/maintenance/work_acceptance_service.js");
  ok("the service defines assertMaintenanceOperator", /async function assertMaintenanceOperator/.test(SVC));
  ok("it requires the maintenance module in SQL",
     /allowed_modules @> array\['maintenance'\]::text\[\]/.test(SVC));
  ok("and an ACTIVE assignment", /active=true/.test(SVC));
  //  REPLACED AFTER A NEGATIVE-CONTROL RUN. The previous form was a long
  //  brittle regex over the whole function body that matched nothing and
  //  therefore passed unconditionally. Read the ONE query instead.
  const authQuery = SVC.slice(SVC.indexOf("async function assertMaintenanceOperator"),
                              SVC.indexOf("//  Is this item actionable"));
  ok("the completion authority query names exactly one module",
     (authQuery.match(/array\['(\w+)'\]/g) || []).length === 1,
     (authQuery.match(/array\['(\w+)'\]/g) || []).join(","));
  ok("and that module is maintenance", /array\['maintenance'\]/.test(authQuery));
  ok("management does NOT appear in it", !/management/.test(authQuery.replace(/\/\/.*$/gm, "")));
  ok("there is no OR widening it", !/\bor allowed_modules\b/.test(authQuery));
  //  The ACCEPTANCE query is separate and deliberately still broader — a
  //  manager may assign and accept work. Only recording completion narrowed.
  const acceptQuery = SVC.slice(SVC.indexOf("async function assertEligible"),
                                SVC.indexOf("async function assertMaintenanceOperator"));
  ok("acceptance eligibility is a DIFFERENT, broader query",
     /array\['management'\]/.test(acceptQuery));
  ok("so narrowing completion did not narrow acceptance",
     acceptQuery.indexOf("or allowed_modules") > -1);
  ok("claimCompletion calls it with the WORK ROW's property",
     /assertMaintenanceOperator\(client, \{ property_id: w\.property_id, user_id: actor_user_id \}\)/.test(SVC));
  const claimBody = SVC.slice(SVC.indexOf("async function claimCompletion"), SVC.indexOf("// ── REOPEN"));
  ok("and calls it BEFORE the photo is stored",
     claimBody.indexOf("assertMaintenanceOperator") < claimBody.indexOf("storeForWork"));
  ok("and before the claim is inserted",
     claimBody.indexOf("assertMaintenanceOperator") < claimBody.indexOf("insert into work_completion_claims"));

  //  THE AGENT DOOR STILL ADMITS MANAGEMENT — it just cannot complete.
  const AGENT = src("src/agent/staff_agent.js");
  ok("the staff-agent door still admits management for its other purposes",
     /mods\.includes\("maintenance"\) && !mods\.includes\("management"\)/.test(AGENT));
  ok("and its completion branch goes through the canonical service",
     /workAcceptanceService\.claimCompletion/.test(src("src/agent/staff_agent_service.js")));
  ok("so the agent inherits the refusal rather than defining its own",
     !/allowed_modules @> array\['maintenance'\]/.test(src("src/agent/staff_agent_service.js")));
}

// ════════════════════════════════════════════════════════════════════
section("5  ONE CANONICAL COMPLETION DOOR");
{
  const D = src("src/maintenance/work_acceptance.js");
  const routes = (D.match(/router\.(post|get)\("[^"]+"/g) || []).map((r) => r.replace(/router\.\w+\("/, "").replace(/"$/, ""));

  ok("there is exactly ONE claim route", routes.filter((r) => /\/claim$/.test(r)).length === 1);
  for (const forbidden of ["/upload", "/upload-photo", "/claim-with-photo", "/complete-with-proof", "/proof/upload"]) {
    ok(`no parallel ${forbidden} route`, !routes.some((r) => r.includes(forbidden)), routes.join(" "));
  }
  ok("the claim route accepts multipart on the same path",
     /router\.post\("\/operator\/turn-work\/:workId\/claim",\s*\.\.\.claimGate, acceptPhotoIfMultipart/.test(D));
  ok("multer runs ONLY for multipart", /multipart\\\/form-data.*test\(String\(req\.headers\["content-type"\]/.test(D));
  ok("a JSON claim never touches multer", /if \(!\/multipart[\s\S]{0,80}return next\(\);/.test(D));
  ok("exactly one file field is accepted", /upload\.single\("photo"\)/.test(D));
  ok("an oversized file is refused in operator language", /Keep it under 5 MB/.test(D));
  ok("a second file is refused", /LIMIT_UNEXPECTED_FILE/.test(D));
  ok("the file reaches the service as proof_file", /proof_file: req\.file \|\| null/.test(D));

  //  Server wiring: this workflow's own 5 MB limit, one file.
  const SRV = src("server.js");
  ok("the completion door gets its own multer limit",
     /fileSize: 5 \* 1024 \* 1024, files: 1/.test(SRV));
  ok("and does not reuse the shared 25 MB uploader", /upload: proofUpload/.test(SRV));
  ok("the attachment service is injected into the acceptance service",
     /attachmentService: workProofAttachmentService/.test(SRV));
}

// ════════════════════════════════════════════════════════════════════
section("6  THE GOVERNED READ — the only way bytes leave");
{
  const D = src("src/maintenance/work_acceptance.js");
  ok("one read route exists", /router\.get\("\/operator\/turn-work\/:workId\/proof\/:attachmentId"/.test(D));
  ok("it uses the READER gate — maintenance OR management", /:attachmentId", \.\.\.readerGate/.test(D));
  ok("the reader gate requires an active session", /requireOperator/.test(D));
  ok("property comes from the session", /property_id: req\.operator\.property_id/.test(D));
  ok("work and attachment come from the path", /work_id: req\.params\.workId[\s\S]{0,80}attachment_id: req\.params\.attachmentId/.test(D));
  ok("cross-property and cross-work give ONE indistinguishable answer",
     /if \(!row\) return res\.status\(404\)\.json\(\{ error: "No proof photo here\." \}\)/.test(D));
  ok("the content type is the STORED one", /res\.setHeader\("Content-Type", row\.mime_type\)/.test(D));
  ok("sniffing is disabled", /X-Content-Type-Options", "nosniff"/.test(D));
  ok("it is not cached", /Cache-Control", "private, no-store"/.test(D));
  ok("it is sandboxed", /Content-Security-Policy", "default-src 'none'; sandbox"/.test(D));
  ok("a driver error never reaches the client",
     /catch \(e\) \{[\s\S]{0,200}The proof photo could not be read\./.test(D));
  ok("there is no attachment LIST route", !/\/proof"|\/attachments"/.test(D));
  ok("there is no delete route", !/router\.delete/.test(D));

  //  The service re-checks scope in its own query — two independent refusals.
  const S = src("src/maintenance/work_proof_attachment_service.js");
  ok("readForWork filters on property AND work",
     /where id=\$1 and property_id=\$2 and work_id=\$3/.test(S));
  ok("a malformed attachment id returns nothing rather than throwing",
     /if \(!\/\^\[0-9a-f\]\{8\}/.test(S));
}

// ════════════════════════════════════════════════════════════════════
section("7  SAFE METADATA ON THE PAGE — never bytes");
{
  const S = src("src/maintenance/work_proof_attachment_service.js");
  const R = src("src/surfaces/unit_turn_read.js");
  ok("metadataForWork selects no content column",
     /select a\.id, a\.mime_type, a\.byte_size, a\.created_at/.test(S) &&
     !/select[^;]*a\.content/.test(S));
  ok("it returns a path, not a URL", /view_path: `\/operator\/turn-work\//.test(S));
  ok("no host, signature or credential is in the path",
     !/https?:\/\/|signature|token=|expires=/.test(code(S)));
  ok("the aggregate read forwards that metadata", /proof_photos: proofByWork\.get/.test(R));
  ok("and takes it from the attachment service", /workProofAttachmentService\.metadataForWork/.test(R));
  ok("the read never selects bytes itself", !/\bcontent\b/.test(code(R)));

  //  ADDED AFTER A NEGATIVE-CONTROL RUN. The assertions above read the SQL.
  //  Adding `content: r.content` to the RETURN SHAPE passed all of them — the
  //  select stayed clean and a bytea still reached JSON. "Do not expose
  //  database bytea values in JSON" is an explicit prohibition, so it is
  //  checked on the value that actually leaves, not only on the query.
  const svc7 = A.makeWorkProofAttachmentService();
  const p7 = (async () => {
    //  A hostile double: every row carries bytes, under several plausible names.
    const db = { query: async () => ({ rows: [{
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", mime_type: "image/jpeg", byte_size: 2052,
      created_at: "2026-07-29T00:00:00Z", uploaded_by_user_id: "user-1", uploaded_by_name: "Ray",
      content: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      bytes: Buffer.from([0xff, 0xd8]), data: Buffer.from([0xff, 0xd8]),
    }] }) };
    const meta = await svc7.metadataForWork(db, { work_id: "w1" });
    ok("metadataForWork returns one entry", meta.length === 1);
    const keys = Object.keys(meta[0]);
    ok("no returned key is content/bytes/data",
       !keys.some((k) => /^(content|bytes|data|buffer)$/i.test(k)), keys.join(","));
    //  Serialise it the way Express would and look for a Buffer anywhere.
    const asJson = JSON.stringify(meta);
    ok("no Buffer survives JSON serialisation", !/"type":"Buffer"/.test(asJson), asJson.slice(0, 120));
    ok("and no raw byte array either", !/\bdata":\s*\[\s*\d/.test(asJson));
    ok("what IS returned is only safe metadata",
       keys.sort().join(",") === "attachment_id,byte_size,mime_type,uploaded_at,uploaded_by,view_path",
       keys.sort().join(","));
    ok("byte_size is a number, not the bytes", typeof meta[0].byte_size === "number");
  })();
  module.exports.__p7 = p7;
}

// ════════════════════════════════════════════════════════════════════
section("8  AUTHORITY — read, operate, read proof, certify: four answers");
{
  const D = src("src/maintenance/work_acceptance.js");
  ok("writes use the maintenance-only gate", /operatorGate = \[requireOperator, requireMaintenanceModuleAccess/.test(D));
  ok("the proof READ uses the maintenance-or-management gate",
     /readerGate = \[requireOperator, requireTurnReadAccess/.test(D));
  ok("the read gate accepts either module",
     /mods\.includes\("maintenance"\) && !mods\.includes\("management"\)/.test(D));
  //  ── ORDER, NOT JUST MEMBERSHIP ───────────────────────────────────
  //  refuseClientProperty reads req.body.property_id. Multer creates
  //  req.body. Running the refusal first meant it judged an empty object on
  //  every multipart claim — enforcement that silently did nothing.
  ok("the claim gate is maintenance-only",
     /const claimGate = \[requireOperator, requireMaintenanceModuleAccess\]/.test(D));
  ok("authentication runs before multer", /\.\.\.claimGate, acceptPhotoIfMultipart/.test(D));
  ok("so an unauthenticated caller can never make the server parse 5 MB",
     D.indexOf("const claimGate = [requireOperator") < D.indexOf("acceptPhotoIfMultipart, refuseClientProperty"));
  ok("the property refusal runs AFTER multipart parsing",
     /acceptPhotoIfMultipart, refuseClientProperty/.test(D));
  ok("and it is still the SAME refusal, not a second one",
     (D.match(/function refuseClientProperty/g) || []).length === 1);
  ok("the refusal still compares against the session property",
     /String\(claimed\) !== String\(req\.operator\.property_id\)/.test(D));
  ok("a matching property_id is allowed through but is never authority",
     /claimed && String\(claimed\) !== String\(req\.operator\.property_id\)/.test(D));
  ok("and the service still takes property from the WORK ROW",
     /property_id: w\.property_id/.test(src("src/maintenance/work_acceptance_service.js")));
  ok("the accept route uses the WRITE gate", /\/accept", \.\.\.operatorGate/.test(D));
  ok("the reopen route uses the WRITE gate", /\/reopen", \.\.\.operatorGate/.test(D));
  ok("a client-supplied property is refused on every door", /refuseClientProperty/.test(D));

  //  ── THE READ EMITS THE WHOLE MATRIX ──────────────────────────────
  //
  //    maintenance only                       read ✓  operate ✓  proof ✓  certify ✗
  //    management only, no manager authority  read ✓  operate ✗  proof ✓  certify ✗
  //    management only, manager or delegated  read ✓  operate ✗  proof ✓  certify ✓ (gate actionable)
  //    maintenance + management, delegated    read ✓  operate ✓  proof ✓  certify ✓ (gate actionable)
  //    neither                                read ✗  operate ✗  proof ✗  certify ✗
  //
  //  Four different questions, not one ladder. Operating is maintenance;
  //  certifying is a management authority maintenance never confers; reading
  //  the proof is either. Rank grants none of them.
  const R8 = src("src/surfaces/unit_turn_read.js");
  ok("the read emits may_operate_work on the maintenance module",
     /may_operate_work: mods\.includes\("maintenance"\)/.test(R8));
  ok("and may_read_proof on EITHER module",
     /may_read_proof: mods\.includes\("maintenance"\) \|\| mods\.includes\("management"\)/.test(R8));
  ok("which is exactly the gate the proof route applies",
     /!mods\.includes\("maintenance"\) && !mods\.includes\("management"\)/.test(D));
  ok("certification is NOT derived from the module list alone",
     /may_perform_readiness_walk: gate\.gate\.actionable && authority\.authorized/.test(R8));
  ok("holding maintenance never confers certification",
     !/may_perform_readiness_walk:[^,]*mods\.includes\("maintenance"\)/.test(R8));
  ok("and the read says why a walk is unavailable, not just that it is",
     /why_no_readiness_walk/.test(R8));
  ok("the reason distinguishes 'gate not actionable' from 'not your authority'",
     /The readiness gate is not actionable yet/.test(R8) &&
     /eligible manager assignment or an explicit delegation/.test(R8));
  ok("why_no_work_controls tells a manager what they CAN still do",
     /Management access can read this turn and view completion photos/.test(R8));
  ok("and the enforcement note names the service, not only the doors",
     /refused inside the canonical service itself/.test(R8));

  //  The page shows a management-only operator no maintenance controls, and
  //  hiding is not the enforcement — the door above still refuses, and the
  //  canonical service refuses independently of every door.
  const P = app("unit-turn-page.js");
  ok("the file input is inside the capability-gated panel",
     P.indexOf("if (open && mayOperate)") < P.indexOf("wk-file"));
  ok("the page reads no module or role", !/allowed_modules|role_title/.test(P));

  //  ── THE UI IS FROZEN, AND IT ALREADY SAYS THE RIGHT THING ────────
  //  A management-only operator never sees Complete, so the 403 is a
  //  belt-and-braces case rather than the normal one — but if it ever fires,
  //  the server sentence must reach the operator unaltered. It does, through
  //  the existing error path. NO APP CHANGE WAS NEEDED for this hardening.
  ok("a failed write is rendered from the SERVER message",
     /e\.publicMessage \|\| e\.message/.test(P));
  ok("under an honest headline", /headline \|\| "Not recorded\."/.test(P));
  ok("the app invents no authorization copy of its own",
     !/maintenance-module access/.test(P));
  ok("the completion action still sends exactly one file on one request",
     /photo: file/.test(P) && (P.match(/claimWorkCompletion\(/g) || []).length === 2);
  ok("still one file input", (P.match(/wk-file/g) || []).length >= 1 && !/wk-file-2|photos\[\]/.test(P));
  ok("still one Complete button", (P.match(/wk-done/g) || []).length >= 1);
  //  `uploaded_at` / `uploaded_by` are metadata field names on the stored
  //  photo, not an upload affordance — and the comments explaining that there
  //  is no upload step must not fail an assertion that there is no upload step.
  ok("no upload button, attachment screen or progress step appeared",
     !/(Upload|Save Photo|Attach|Add file)\s*(<\/button|")/i.test(code(P)) &&
     !/attachmentScreen|progressStep|mediaLibrary|uploadPhoto|savePhoto/i.test(code(P)));
}

// ════════════════════════════════════════════════════════════════════
section("9  THE UI — one file input, one Complete");
{
  const P = app("unit-turn-page.js");
  const IDX = app("index.html");

  ok("there is exactly ONE file input", (P.match(/type="file"/g) || []).length === 1);
  ok("it accepts only the three image types",
     /accept="image\/jpeg,image\/png,image\/webp"/.test(P));
  ok("it opens the camera on a phone", /capture="environment"/.test(P));
  ok("there is no free-text photo field", !/wk-photo|Photo reference/.test(P));
  ok("there is no separate Save Photo button", !/Save photo|Upload photo|Save Photo/i.test(printable(P)));
  ok("there is no separate proof screen", !/renderProof|proofScreen/.test(P));
  ok("Complete is disabled until a photo is chosen", /blockedByPhoto \|\| S\.busy \? " disabled"/.test(P));
  ok("and says so plainly rather than erroring later",
     /Add one completion photo to close this work\./.test(P));
  ok("the button says Complete work", /Complete work<\/button>/.test(P));
  ok("a chosen photo says 'Photo ready'", /Photo ready/.test(P));
  ok("with a small preview", /ut-thumb/.test(P) && /createObjectURL/.test(P));
  ok("the functional confirmation appears only when required",
     /needs_functional_confirmation\) \{[\s\S]{0,140}wk-conf/.test(P));

  //  NO INTERNAL VOCABULARY.
  const shown = printable(P);
  for (const word of ["attachment", "upload", "storage", "bytea", "mime", "MIME", "sha256", "multipart"]) {
    ok(`the page never PRINTS "${word}"`, !new RegExp(word, "i").test(shown), word);
  }
  ok("no attachment id is rendered", !/attachment_id/.test(shown));

  //  RETRY KEEPS THE PHOTO.
  ok("the chosen file is held in memory", /photoFile: \{\}/.test(P));
  ok("and only cleared after the server accepts it",
     /function onSuccess\(\)[\s\S]{0,400}delete S\.photoFile\[i\]/.test(P));
  ok("the clear happens in the success callback, not before the request",
     P.indexOf("photo: file") < P.indexOf("delete S.photoFile[i]"));
  ok("a failure does not show the work as closed", /S\.error = e/.test(P));

  //  ONE REQUEST.
  ok("the file rides on the completion request", /photo: file/.test(P));
  ok("the write layer sends multipart when a file is present",
     /var fileField = spec\.file && params\[spec\.file\]/.test(IDX));
  ok("and JSON when there is not", /body = JSON\.stringify\(spec\.buildBody\(params\)\)/.test(IDX));
  ok("the browser sets the multipart boundary", /headers = \{ 'accept': 'application\/json', 'x-staff-session'/.test(IDX));
  ok("the claim action declares its file field", /file: 'photo', fileField: 'photo'/.test(IDX));
  ok("there is no second upload action registered",
     !/uploadPhoto:|uploadProof:|saveAttachment:/.test(IDX));

  //  The governed image is FETCHED with the session, not set as a src.
  ok("proof images are fetched with the staff session", /async function proofImage\(params\)/.test(IDX));
  ok("and refused honestly on 403/404", /The proof photo is not available\./.test(IDX));
  ok("the page renders the fetched blob", /proofImage\(\{ viewPath: path \}\)/.test(P));
  ok("and says so when it cannot be loaded", /The completion photo could not be loaded\./.test(P));
}

// ════════════════════════════════════════════════════════════════════
section("10  MIGRATION 118 — narrow, and not applied");
{
  const M = src("migrations/118_work_proof_attachments.sql");
  ok("one table is created", (M.match(/create table if not exists/gi) || []).length === 1);
  ok("named work_proof_attachments", /create table if not exists work_proof_attachments/.test(M));
  for (const col of ["id", "property_id", "unit_id", "work_id", "uploaded_by_user_id",
                     "original_filename", "mime_type", "byte_size", "sha256", "content", "created_at"]) {
    ok(`column present: ${col}`, new RegExp("\\b" + col + "\\s").test(M));
  }
  ok("the primary key is a uuid", /id\s+uuid primary key default gen_random_uuid\(\)/.test(M));
  ok("property, unit and work are ALL not null",
     /property_id\s+uuid not null references properties/.test(M) &&
     /unit_id\s+uuid not null references units/.test(M) &&
     /work_id\s+uuid not null/.test(M));

  //  ── THE SCOPE IS ONE FACT, NOT THREE ──────────────────────────────
  //  Three separate keys proved three objects EXIST. They did not prove they
  //  belong together: work at property A + unit at property B + property A all
  //  satisfied their own key while describing an attachment that belongs to
  //  nothing. The composite key makes that combination unrepresentable, in
  //  Postgres, including through raw SQL that never touches the service.
  ok("a composite foreign key ties work, property and unit together",
     /foreign key \(work_id, property_id, unit_id\)\s*\n\s*references unit_triage_required_work \(id, property_id, unit_id\)/.test(M));
  ok("it cascades with the work item", /references unit_triage_required_work \(id, property_id, unit_id\)\s*\n\s*on delete cascade/.test(M));
  ok("and the parent has the unique index the key needs",
     /create unique index if not exists uq_utrw_id_property_unit\s*\n\s*on unit_triage_required_work \(id, property_id, unit_id\)/.test(M));
  ok("the index is created BEFORE the table that references it",
     M.indexOf("uq_utrw_id_property_unit") < M.indexOf("create table if not exists work_proof_attachments"));
  ok("the weaker single-column work key is gone — the composite contains it",
     !/work_id\s+uuid not null references unit_triage_required_work\(id\)/.test(M));
  ok("property and unit keep their own keys — different tables",
     /references properties\(id\)/.test(M) && /references units\(id\)/.test(M));
  ok("the uploader is not null and a foreign key",
     /uploaded_by_user_id\s+uuid not null references users/.test(M));
  ok("the image is bytea", /content\s+bytea not null/.test(M));
  ok("mime is constrained to three types",
     /check \(mime_type in \('image\/jpeg','image\/png','image\/webp'\)\)/.test(M));
  ok("byte_size must be positive", /check \(byte_size > 0\)/.test(M));
  ok("byte_size is bounded at 5 MB in the schema too",
     /check \(byte_size <= 5 \* 1024 \* 1024\)/.test(M));
  ok("and byte_size must EQUAL the stored bytes",
     /check \(byte_size = octet_length\(content\)\)/.test(M));
  ok("the digest must be lowercase hex, exactly 64",
     new RegExp("check \\(sha256 ~ '\\^\\[0-9a-f\\]\\{64\\}\\$'\\)").test(M));
  ok("and the old length-only check is gone — 64 spaces used to pass",
     !/char_length\(sha256\) = 64/.test(M));
  ok("created_at is server-generated", /created_at\s+timestamptz not null default now\(\)/.test(M));

  //  WHAT MUST NOT BE THERE.
  for (const forbidden of ["description", "caption", "tag", "category", "document_type",
                           "status", "deleted_at", "archived_at", "storage_url", "bucket"]) {
    ok(`no ${forbidden} column`, !new RegExp("^\\s+" + forbidden + "\\s", "m").test(M), forbidden);
  }
  ok("no delete route exists anywhere", !/router\.delete/.test(src("src/maintenance/work_acceptance.js")));
  ok("the storage adapter names its replacement condition",
     /REPLACEMENT CONDITION[\s\S]{0,200}object storage/.test(M));
  ok("and classifies contract vs adapter",
     /Class 1, permanent product primitive/.test(M) && /Class 2, temporary storage adapter/.test(M));
  ok("the number is marked provisional", /PROVISIONAL/.test(M));
  ok("and it says nothing has been applied", /NOT APPLIED ANYWHERE/.test(M));

  //  Untouched neighbours.
  ok("intake_media is not modified", !/intake_media/.test(M));
  ok("documents is not modified", !/\bdocuments\b/.test(M));
  const migs = fs.readdirSync(path.join(REPO, "migrations")).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
  ok("the ceiling is now 118", migs[migs.length - 1].startsWith("118"), migs[migs.length - 1]);
  ok("and there is no 119", !migs.some((f) => f.startsWith("119")));
}

// ════════════════════════════════════════════════════════════════════
section("10B  THE MIGRATION'S VERDICTS — stated as rows, not as prose");
{
  const M = src("migrations/118_work_proof_attachments.sql");
  //  Each SQL constraint is mirrored here as the predicate it is, and
  //  candidate rows are run through it. This says WHAT POSTGRES WOULD DO
  //  and asserts the constraint that would do it is present in the file.
  //
  //  IT DOES NOT PROVE POSTGRES DOES IT. No server has parsed this file.
  //  These verdicts become real at the first migration run against the
  //  owner's baseline, and not one moment sooner.

  //  The parent rows the composite key points at.
  const WORK_ROWS = [{ id: "w1", property_id: "p1", unit_id: "u1" },
                     { id: "w2", property_id: "p2", unit_id: "u2" }];

  //  fk_wpa_work_scope: (work_id, property_id, unit_id) must match a row.
  const scopeOk = (r) => WORK_ROWS.some((w) =>
    w.id === r.work_id && w.property_id === r.property_id && w.unit_id === r.unit_id);
  //  ck_wpa_size_matches_content, the 5 MB bound, and the digest format.
  const sizeMatches = (r) => r.byte_size === r.content.length;
  const sizeBounded = (r) => r.byte_size > 0 && r.byte_size <= 5 * 1024 * 1024;
  const digestOk = (r) => /^[0-9a-f]{64}$/.test(r.sha256);
  const accepted = (r) => scopeOk(r) && sizeMatches(r) && sizeBounded(r) && digestOk(r);

  const GOOD_DIGEST = "a".repeat(64);
  const row = (over) => Object.assign({
    work_id: "w1", property_id: "p1", unit_id: "u1",
    byte_size: 2052, content: Buffer.alloc(2052), sha256: GOOD_DIGEST,
  }, over);

  ok("a matching work/property/unit row is ACCEPTED", accepted(row()) === true);

  //  Every id below is REAL. Only the combination is wrong — which is
  //  exactly the row three separate foreign keys used to allow.
  ok("work w1 with property p2 is REFUSED (real ids, wrong combination)",
     accepted(row({ property_id: "p2" })) === false);
  ok("work w1 with unit u2 is REFUSED", accepted(row({ unit_id: "u2" })) === false);
  ok("work w2 under property p1 is REFUSED", accepted(row({ work_id: "w2" })) === false);
  ok("and the fully-consistent other work item is accepted",
     accepted(row({ work_id: "w2", property_id: "p2", unit_id: "u2" })) === true);
  ok("three separate keys would have allowed the bad combination",
     ["w1", "p2", "u2"].every((id) =>
       WORK_ROWS.some((w) => w.id === id || w.property_id === id || w.unit_id === id)));

  ok("a byte_size that disagrees with the bytes is REFUSED",
     accepted(row({ byte_size: 99 })) === false);
  ok("understating the size is refused too",
     accepted(row({ byte_size: 1, content: Buffer.alloc(2052) })) === false);
  ok("oversized bytes are REFUSED",
     accepted(row({ byte_size: 6 * 1024 * 1024, content: Buffer.alloc(6 * 1024 * 1024) })) === false);
  ok("exactly 5 MB is accepted — the bound is inclusive",
     accepted(row({ byte_size: 5 * 1024 * 1024, content: Buffer.alloc(5 * 1024 * 1024) })) === true);
  ok("zero bytes are REFUSED", accepted(row({ byte_size: 0, content: Buffer.alloc(0) })) === false);

  ok("a malformed digest is REFUSED", accepted(row({ sha256: "not-a-digest" })) === false);
  ok("64 SPACES are refused — the old length check accepted them",
     accepted(row({ sha256: " ".repeat(64) })) === false);
  ok("an UPPERCASE digest is refused — one canonical form",
     accepted(row({ sha256: "A".repeat(64) })) === false);
  ok("63 hex characters are refused", accepted(row({ sha256: "a".repeat(63) })) === false);
  ok("65 hex characters are refused", accepted(row({ sha256: "a".repeat(65) })) === false);

  //  And the constraints that would deliver those verdicts are in the file.
  ok("the composite scope key is declared",
     /constraint fk_wpa_work_scope/.test(M));
  ok("the size-matches-content constraint is declared",
     /constraint ck_wpa_size_matches_content/.test(M));
  ok("the 5 MB bound is declared", /byte_size <= 5 \* 1024 \* 1024/.test(M));
  ok("the digest format is declared", M.includes("[0-9a-f]{64}"));
  ok("NOTHING here has run against Postgres — the file is unapplied",
     /NOT APPLIED ANYWHERE/.test(M));
}

// ════════════════════════════════════════════════════════════════════
section("10C  THE DOOR REFUSES TO START WHEN THE PHOTO PATH IS UNWIRED");
{
  //  The real router, really constructed. Not a regex over source.
  const makeDoor = require("../../src/maintenance/work_acceptance");
  const multer = require("multer");
  const ATT_OK = { storeForWork() {}, resolveForWork() {}, readForWork() {} };
  const SVC_OK = { acceptWork() {}, claimCompletion() {}, readWorkState() {},
                   readUnitFlow() {}, workExceptions() {}, proposeCommitment() {}, reopenWork() {} };
  const build = (over) => {
    try {
      return { router: makeDoor(Object.assign({
        pool: {}, upload: multer({ storage: multer.memoryStorage() }),
        workProofAttachmentService: ATT_OK, workAcceptanceService: SVC_OK,
      }, over)), error: null };
    } catch (e) { return { router: null, error: e.message }; }
  };

  ok("a fully wired door builds", build({}).error === null, build({}).error);

  const noMulter = build({ upload: null });
  ok("NO multer → refuses to build", noMulter.error !== null);
  ok("  …and names upload", /requires upload/.test(noMulter.error || ""), noMulter.error);
  ok("  …and says the photo could never be received",
     /never be received/.test(noMulter.error || ""));
  ok("a multer-shaped object without .single() is also refused",
     build({ upload: {} }).error !== null);

  for (const fn of ["storeForWork", "resolveForWork", "readForWork"]) {
    const partial = Object.assign({}, ATT_OK);
    delete partial[fn];
    const r = build({ workProofAttachmentService: partial });
    ok(`attachment service missing ${fn} → refuses to build`, r.error !== null);
    ok(`  …and names ${fn}`, new RegExp(fn).test(r.error || ""), r.error);
  }
  const none = build({ workProofAttachmentService: null });
  ok("NO attachment service at all → refuses to build", none.error !== null);
  ok("  …and explains the whole path depends on it",
     /completion path works without all three/.test(none.error || ""), none.error);

  //  ── AND THE REAL MIDDLEWARE ORDER, FROM THE REAL ROUTER ─────────
  const r = build({}).router;
  const layer = r.stack.find((l) => l.route && l.route.path.endsWith("/claim"));
  const names = layer.route.stack.map((x) => x.name);
  ok("the claim route exists", !!layer);
  ok("authentication is first", names[0] === "requireOperator", names.join(" -> "));
  ok("module entitlement is second — before any 5 MB is parsed",
     names[1] === "requireMaintenanceModuleAccess", names.join(" -> "));
  ok("multipart parsing is third", names[2] === "acceptPhotoIfMultipart", names.join(" -> "));
  ok("the property refusal runs AFTER parsing, when req.body exists",
     names[3] === "refuseClientProperty", names.join(" -> "));
  ok("and the handler runs last", names.length === 5, names.join(" -> "));
  ok("the read gate is NOT on the claim route",
     !names.includes("requireTurnReadAccess"), names.join(" -> "));

  //  The other write routes keep the original order — they are JSON only.
  for (const p of ["/accept", "/reopen"]) {
    const l = r.stack.find((x) => x.route && x.route.path.endsWith(p));
    const n = l.route.stack.map((x) => x.name);
    ok(`${p} still refuses a client property before its handler`,
       n[2] === "refuseClientProperty", n.join(" -> "));
    ok(`${p} never touches multer`, !n.includes("acceptPhotoIfMultipart"), n.join(" -> "));
  }

  //  The governed READ uses the reader gate, not the write gate.
  const pr = r.stack.find((x) => x.route && x.route.path.includes("/proof/"));
  const pn = pr.route.stack.map((x) => x.name);
  ok("the proof read admits management via requireTurnReadAccess",
     pn.includes("requireTurnReadAccess"), pn.join(" -> "));
  ok("and does NOT require the maintenance module",
     !pn.includes("requireMaintenanceModuleAccess"), pn.join(" -> "));
}

// ════════════════════════════════════════════════════════════════════
section("11  CLASSIFIER — one unit, or a question");
{
  const ctx = { unit_id: "u1", open_work: [
    { id: "w1", work_text: "Source and install refrigerator", stage: "repair", status: "required" }] };

  const two = INTENT.classifyIntent("There are cockroaches in 304 and 305.", {});
  ok("two distinct units → unclear", two.intent === "unclear", two.intent);
  ok("and it asks which", /which unit/i.test(two.clarification || ""), two.clarification);
  ok("naming both in the question", /304/.test(two.clarification) && /305/.test(two.clarification));
  ok("and no unit is chosen", two.unit_ref === null);
  ok("the unknown says why", two.unknowns.some((u) => /names 2 units/i.test(u)));

  ok("the same unit twice is still one unit",
     INTENT.classifyIntent("There are cockroaches in 304 and 304.", {}).intent === "initial_triage");
  ok("one explicit unit still works",
     INTENT.classifyIntent("304 is empty. There are cockroaches behind the refrigerator.", {}).intent === "initial_triage");
  ok("the open page supplies the unit",
     INTENT.classifyIntent("There are cockroaches behind the refrigerator.", ctx).intent === "initial_triage");
  ok("no unit anywhere still asks which",
     INTENT.classifyIntent("There are cockroaches behind the refrigerator.", {}).intent === "unclear");
  ok("bare concrete conditions remain confirmable",
     ["The bedroom window is cracked.", "There is water under the kitchen sink.",
      "The living-room carpet is stained."].every((m) => INTENT.classifyIntent(m, ctx).intent === "initial_triage"));
  ok("vague conditions remain unclear",
     ["It is bad.", "Needs work.", "There is an issue."].every((m) => INTENT.classifyIntent(m, ctx).intent === "unclear"));
  ok("multi-unit is decided BEFORE any branch, so no intent slips past",
     src("src/agent/staff_agent_intent.js").indexOf("allRefs.length > 1") <
     src("src/agent/staff_agent_intent.js").indexOf("any(t, S.correction)"));
}

// ════════════════════════════════════════════════════════════════════
section("12  SCOPE STAYED CLOSED");
{
  const { execSync } = require("child_process");
  const changed = execSync("git diff --name-only 3d98222", { cwd: REPO }).toString().trim().split("\n").filter(Boolean);
  const untracked = execSync("git ls-files --others --exclude-standard", { cwd: REPO }).toString().trim().split("\n").filter(Boolean);
  const all = changed.concat(untracked);

  ok("intake.js is untouched", !all.includes("src/onboarding/intake.js"));
  ok("migration 014 (intake_media) is untouched", !all.includes("migrations/014_intake.sql"));
  ok("migration 001 (documents) is untouched", !all.includes("migrations/001_baseline.sql"));
  ok("only ONE migration was added",
     all.filter((f) => f.startsWith("migrations/")).length === 1,
     all.filter((f) => f.startsWith("migrations/")).join(","));
  ok("and it is 118", all.some((f) => f === "migrations/118_work_proof_attachments.sql"));
  ok("readiness is untouched", !all.includes("src/maintenance/readiness_service.js"));
  ok("availability is untouched", !all.includes("src/surfaces/availability_read.js"));
  ok("the sequence engine is untouched", !all.includes("src/maintenance/turn_sequence.js"));

  //  No generalisation.
  const S = src("src/maintenance/work_proof_attachment_service.js");
  ok("no list operation", !/function list|listAll|findAll/.test(code(S)));
  ok("no delete operation", !/function delete|remove/i.test(code(S)));
  ok("no caption, tag or category", !/caption|tag|category/i.test(code(S)));
  ok("no external storage", !/s3|S3Client|cloudinary|signed|presigned|bucket/i.test(code(S)));
  ok("no scoring or vision", !/score|vision|classify|detect/i.test(code(S)));
  ok("exactly one image is accepted per completion",
     /files: 1/.test(src("server.js")) && /upload\.single\("photo"\)/.test(src("src/maintenance/work_acceptance.js")));
}

// ════════════════════════════════════════════════════════════════════
Promise.all([module.exports.__p2, module.exports.__p3, module.exports.__p4,
             module.exports.__p4b, module.exports.__p7]).then(() => {
  section("RESULT");
  console.log("  assertions passed: " + passed);
  console.log("  assertions failed: " + failed);
  if (fails.length) { console.log("\n  FAILURES:"); fails.forEach((f) => console.log("   ✗ " + f)); }
  console.log("");
  console.log("  PROOF LEVEL: Source-complete, Built but dormant.");
  console.log("  The attachment service ran against a recording double, not Postgres.");
  console.log("  Foreign keys, check constraints and transaction rollback are WRITTEN and");
  console.log("  reachable; that the database enforces them is unproven until the baseline");
  console.log("  arrives. No file was ever uploaded over HTTP and no browser rendered this.");
  process.exit(failed > 0 ? 1 : 0);
}).catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
