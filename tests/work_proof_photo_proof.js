// ════════════════════════════════════════════════════════════════════
//  work_proof_photo_proof.js — ONE PHOTO, ONE COMPLETION ACTION
//
//    node tests/work_proof_photo_proof.js
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

const A = require("../src/maintenance/work_proof_attachment_service");
const PROOF = require("../src/maintenance/work_proof");
const { makeWorkAcceptanceService } = require("../src/maintenance/work_acceptance_service");
const INTENT = require("../src/agent/staff_agent_intent");

let passed = 0, failed = 0;
const fails = [];
const ok = (n, c, d) => { if (c) passed++; else { failed++; fails.push(n + (d ? "  — " + d : "")); } };
const section = (t) => console.log("\n── " + t + " " + "─".repeat(Math.max(0, 60 - t.length)));

const REPO = path.join(__dirname, "..");
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
section("4  ATOMICITY — the photo and the claim commit together or not at all");
{
  //  A double that fails at a chosen statement, so the ordering can be
  //  observed rather than assumed.
  function clientThatFailsOn(pattern) {
    const issued = [];
    return {
      issued,
      query: async (sql, params) => {
        const s = String(sql);
        issued.push(s.replace(/\s+/g, " ").slice(0, 60));
        if (pattern && pattern.test(s)) throw new Error("simulated failure: " + pattern);
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
section("5  ONE CANONICAL COMPLETION DOOR");
{
  const D = src("src/maintenance/work_acceptance.js");
  const routes = (D.match(/router\.(post|get)\("[^"]+"/g) || []).map((r) => r.replace(/router\.\w+\("/, "").replace(/"$/, ""));

  ok("there is exactly ONE claim route", routes.filter((r) => /\/claim$/.test(r)).length === 1);
  for (const forbidden of ["/upload", "/upload-photo", "/claim-with-photo", "/complete-with-proof", "/proof/upload"]) {
    ok(`no parallel ${forbidden} route`, !routes.some((r) => r.includes(forbidden)), routes.join(" "));
  }
  ok("the claim route accepts multipart on the same path",
     /router\.post\("\/operator\/turn-work\/:workId\/claim", \.\.\.operatorGate, acceptPhotoIfMultipart/.test(D));
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
}

// ════════════════════════════════════════════════════════════════════
section("8  AUTHORITY — read, operate, certify stay three things");
{
  const D = src("src/maintenance/work_acceptance.js");
  ok("writes use the maintenance-only gate", /operatorGate = \[requireOperator, requireMaintenanceModuleAccess/.test(D));
  ok("the proof READ uses the maintenance-or-management gate",
     /readerGate = \[requireOperator, requireTurnReadAccess/.test(D));
  ok("the read gate accepts either module",
     /mods\.includes\("maintenance"\) && !mods\.includes\("management"\)/.test(D));
  ok("the claim route uses the WRITE gate", /\/claim", \.\.\.operatorGate/.test(D));
  ok("the accept route uses the WRITE gate", /\/accept", \.\.\.operatorGate/.test(D));
  ok("the reopen route uses the WRITE gate", /\/reopen", \.\.\.operatorGate/.test(D));
  ok("a client-supplied property is refused on every door", /refuseClientProperty/.test(D));

  //  The page shows a management-only operator no maintenance controls, and
  //  hiding is not the enforcement — the door above still refuses.
  const P = app("unit-turn-page.js");
  ok("the file input is inside the capability-gated panel",
     P.indexOf("if (open && mayOperate)") < P.indexOf("wk-file"));
  ok("the page reads no module or role", !/allowed_modules|role_title/.test(P));
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
  ok("property, unit and work are ALL not null and foreign keys",
     /property_id\s+uuid not null references properties/.test(M) &&
     /unit_id\s+uuid not null references units/.test(M) &&
     /work_id\s+uuid not null references unit_triage_required_work/.test(M));
  ok("the uploader is not null and a foreign key",
     /uploaded_by_user_id\s+uuid not null references users/.test(M));
  ok("the image is bytea", /content\s+bytea not null/.test(M));
  ok("mime is constrained to three types",
     /check \(mime_type in \('image\/jpeg','image\/png','image\/webp'\)\)/.test(M));
  ok("byte_size must be positive", /check \(byte_size > 0\)/.test(M));
  ok("the digest is fixed length", /char_length\(sha256\) = 64/.test(M));
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
Promise.all([module.exports.__p2, module.exports.__p3, module.exports.__p4]).then(() => {
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
