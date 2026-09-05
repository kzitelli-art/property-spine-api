#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   HARNESS — DEAL SETUP OVER REAL HTTP, AGAINST THE REAL server.js

   ── WHY THIS ONE BOOTS server.js ITSELF ─────────────────────────────
   The Build 1A HTTP harness names its own gap in its header: it does not
   boot server.js, because server.js opens Twilio/Anthropic/Plaid clients
   and binds a port, so it rebuilds the gate chain instead. That is a
   proof about a transcription of the gate chain.

   MOUNTING IS NOT REACHABILITY — the /legal/ routes were mounted, and
   still answered "Missing or wrong x-operator-key", because the gate
   allowlists by path and a bare-express harness has no gate at all. This
   build adds `isDealSetupPath()` to that same allowlist, so a harness that
   transcribes the gate would be marking its own homework.

   So this SPAWNS server.js as a child process, with DATABASE_URL pointed
   at the disposable harness database, and talks to it over a real socket.
   The parent sets only HARNESS_DATABASE_URL — never both — so the
   same-target refusal in _run_receipt still protects production.

   Everything crossing this boundary is real: the gate, the middleware
   ordering, multipart upload through multer, the routes, the services,
   the constraints.

   ── WHAT IT PROVES ──────────────────────────────────────────────────
   H1   /deal-setup/* is reachable through the real gate (not 401 on the key)
   H2   …and still requires a human: no session → 401
   H3   create a deal over HTTP
   H4   a member's session is refused, 403
   H5   a body actor field is REJECTED, not ignored (PR #38, frozen)
   H6   another client's deal is 403, not 404 — and never readable
   H7   create a property into the deal, through the 1A canonical service
   H8   upload the REAL FILE by multipart; bytes and digest land
   H9   the same file uploaded twice returns the same artifact
   H10  a PDF renamed .csv is refused with a sayable reason
   H11  open an activation
   H12  read the source: batch + source rows + proposals in one call
   H13  the mapping is reported back — what Spine understood
   H14  confirm a row → a canonical lease exists
   H15  establish the opening position
   H16  the position reads back with its source file named
   H17  PERSISTENCE — after a full server restart the state is identical
   H18  the bare lease writer is contained (410, naming both real paths)
   H19  the ingest promote route rejects a body actor field
   H20  THE JOIN OF THE TWO SIDES: /operator/rent-roll — the staff Rent
        Roll — shows the position established from Deal Setup

   run:  HARNESS_DATABASE_URL="postgres://..." node tests/proofs/deal_setup_http.db.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const http = require("http");
const crypto = require("crypto");
const path = require("path");
const { spawn } = require("child_process");
const { Pool } = require("pg");
const receipt = require("../_run_receipt.js");

const URL = receipt.harnessConnectionString();
const boundary = require("../e2e/proof_boundary");
boundary.manifest();
const pool = new Pool({ connectionString: URL, ssl: false });

const OPERATOR_KEY = "harness-operator-key-" + crypto.randomBytes(4).toString("hex");
const PORT = 3400 + (process.pid % 300);

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? "\n        " + detail : "")); }
  return cond;
};

const TAG = "AMH_" + process.pid;
const N = 200000 + (process.pid % 700000);

// ── the real server, as a child process ────────────────────────────
let child = null;
async function startServer() {
  await boundary.assertDatabase();
  await boundary.portFree(PORT);
    child = spawn(process.execPath, [
      "--require", path.join(__dirname, "../e2e/proof_fence_preload.js"),
      "--require", path.join(__dirname, "../e2e/fake_sms_preload.js"),
      "--require", path.join(__dirname, "../e2e/fake_anthropic_preload.js"),
      path.join(__dirname, "..", "..", "server.js")], {
      env: boundary.serverEnvironment({
        //  The CHILD gets DATABASE_URL; this process never does, so
        //  _run_receipt's same-target refusal stays meaningful.
        DATABASE_URL: URL,
        HARNESS_DATABASE_URL: "",
        OPERATOR_KEY, PORT: String(PORT),
        NODE_ENV: "test",
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const onData = (b) => { out += String(b); };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    let spawnError;
    child.on("error", e => { spawnError = e; });
    try { await boundary.waitServer(`http://127.0.0.1:${PORT}`, () => !spawnError && child.exitCode === null && child.signalCode === null); }
    catch (e) { throw new Error(`${e.message}\n${out}`); }
}
async function stopServer() {
  if (!child) return;
  let forced = false;
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        forced = true;
      }, 5000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      child.kill("SIGTERM");
    });
  }
  child = null;
  await boundary.portFree(PORT);
  if (forced) throw new Error("Owned Deal Setup server required SIGKILL; exit and port cleanup verified");
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => {
  try { await stopServer(); await pool.end(); } finally { process.exit(1); }
});

function request(method, p, { body, headers = {}, raw } = {}) {
  return new Promise((resolve, reject) => {
    const payload = raw !== undefined ? raw
      : body === undefined ? null : Buffer.from(JSON.stringify(body));
    const h = Object.assign(
      raw !== undefined ? {} : { "content-type": "application/json" },
      payload ? { "content-length": payload.length } : {}, headers);
    const req = http.request({ host: "127.0.0.1", port: PORT, method, path: p, headers: h }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        let parsed = null;
        try { parsed = buf.length ? JSON.parse(buf.toString("utf8")) : null; }
        catch (_) { parsed = { _raw: buf.toString("utf8").slice(0, 200) }; }
        resolve({ status: res.statusCode, body: parsed, buffer: buf });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

//  A real multipart body. Built by hand so the bytes on the wire are
//  bytes this harness can state exactly.
function multipart(fieldName, filename, contentType, buffer, extraFields = {}) {
  const boundary = "----spineharness" + crypto.randomBytes(8).toString("hex");
  const parts = [];
  for (const [k, v] of Object.entries(extraFields)) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; ` +
    `filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`));
  parts.push(buffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

const RENT_ROLL = [
  "Unit #,Resident,Mkt Rent,Actual Rent,Lease From,Lease To,Balance",
  "201,\"Delgado, Rosa\",1800,1750,2025-07-01,2026-06-30,0",
  "202,VACANT,1825,,,,",
  "203,\"Haddad, Samir\",1900,1900,2025-02-01,2026-01-31,45.00",
].join("\n");

function appParsedRows(text) {
  const lines = text.split("\n").filter((l) => l.trim());
  const split = (l) => {
    const o = []; let c = "", q = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i];
      if (ch === '"') { if (q && l[i + 1] === '"') { c += '"'; i++; } else q = !q; }
      else if (ch === "," && !q) { o.push(c); c = ""; }
      else c += ch;
    }
    o.push(c); return o;
  };
  const head = split(lines.shift()).map((h) => h.trim());
  return lines.map((l, i) => {
    const cells = split(l); const o = {};
    head.forEach((h, j) => { if (h) o[h] = (cells[j] ?? "").trim(); });
    o.__row_number = i + 2;
    return o;
  });
}

(async () => {
  receipt.begin(__filename, { url: URL, expected: 32 });

  // ── fixtures ─────────────────────────────────────────────────────
  const orgA = (await pool.query(
    `insert into organizations (name, slug) values ($1,$2) returning id`,
    [TAG + " OrgA", TAG.toLowerCase() + "-a"])).rows[0].id;
  const orgB = (await pool.query(
    `insert into organizations (name, slug) values ($1,$2) returning id`,
    [TAG + " OrgB", TAG.toLowerCase() + "-b"])).rows[0].id;
  const person = (await pool.query(
    `insert into persons (name) values ($1) returning id`, [TAG + " Human"])).rows[0].id;

  const mkUser = async (role, org) => (await pool.query(
    `insert into users (name, email, platform_role, organization_id, is_active, status, person_id)
     values ($1,$2,$3,$4,true,'active',$5) returning id`,
    [`${TAG} ${role}`, `${TAG}.${role}.${crypto.randomBytes(3).toString("hex")}@example.test`,
     role, org, person])).rows[0].id;

  const adminA = await mkUser("org_admin", orgA);
  const adminB = await mkUser("org_admin", orgB);
  const member = await mkUser("member", orgA);

  //  A staff session needs an ACTIVE property_team_assignment — the shipped
  //  resolver joins it, so the fixture obeys that rather than routing round it.
  const seat = (await pool.query(
    `insert into properties (name, canonical_key) values ($1,$2) returning id`,
    [TAG + " seat", TAG + "-SEAT"])).rows[0].id;
  const mkSession = async (userId) => {
    const rawTok = crypto.randomBytes(32).toString("base64url");
    await pool.query(
      `insert into property_team_assignments (property_id, user_id, role_title, allowed_modules, active)
       values ($1,$2,'harness',ARRAY['management'],true) on conflict do nothing`, [seat, userId]);
    await pool.query(
      `insert into staff_sessions (user_id, property_id, token, token_digest, issuance_purpose, expires_at)
       values ($1,$2,null,$3,'bootstrap_invite', now() + interval '4 hours')`,
      [userId, seat, crypto.createHash("sha256").update(rawTok, "utf8").digest("hex")]);
    return rawTok;
  };
  const sA = await mkSession(adminA);
  const sB = await mkSession(adminB);
  const sM = await mkSession(member);

  const KEY = { "x-operator-key": OPERATOR_KEY };
  const asA = Object.assign({}, KEY, { "x-staff-session": sA });
  const asB = Object.assign({}, KEY, { "x-staff-session": sB });
  const asM = Object.assign({}, KEY, { "x-staff-session": sM });

  await startServer();
  console.log(`  (real server.js running on :${PORT})\n`);

  // ── H1–H2 · reachability and the human requirement ───────────────
  const noSession = await request("GET", "/deal-setup/deals", { headers: KEY });
  ok("H1  /deal-setup/* passes the real operator-key gate (not a key refusal)",
     noSession.status === 401 && noSession.body && noSession.body.error === "sign_in_required",
     JSON.stringify(noSession.body));
  ok("H2  …and requires a human, saying so",
     /signed-in person/i.test((noSession.body || {}).receipt || ""));

  // ── H3–H6 · deals ─────────────────────────────────────────────────
  const created = await request("POST", "/deal-setup/deals",
    { headers: asA, body: { deal_name: TAG + " SOLO", onboarding_type: "existing_asset" } });
  ok("H3  a deal is created over HTTP",
     created.status === 201 && created.body.deal && created.body.deal.organization_id === orgA,
     JSON.stringify(created.body).slice(0, 200));
  const dealId = created.body.deal.id;

  const byMember = await request("POST", "/deal-setup/deals",
    { headers: asM, body: { deal_name: "nope" } });
  ok("H4  a member's session is refused at the HTTP boundary",
     byMember.status === 403 && byMember.body.reason === "insufficient_platform_role",
     `${byMember.status} ${JSON.stringify(byMember.body)}`);

  const withActor = await request("POST", "/deal-setup/deals",
    { headers: asA, body: { deal_name: "x", confirmed_by: adminB } });
  ok("H5  a body actor field is REJECTED, not ignored",
     withActor.status === 400 && withActor.body.error === "body_actor_field_rejected",
     JSON.stringify(withActor.body));

  const crossRead = await request("GET", `/deal-setup/deals/${dealId}`, { headers: asB });
  ok("H6  another client's deal is refused and never rendered",
     crossRead.status === 403 && !crossRead.body.deal,
     `${crossRead.status} ${JSON.stringify(crossRead.body).slice(0, 120)}`);

  // ══ THE CASE THAT WOULD HAVE BLOCKED THE FIRST PRODUCTION CLICK ═══
  //  A super_admin spans every organization, so resolveCreationScope
  //  correctly refuses to guess and demands one be NAMED. The create form
  //  had no field for one — so the refusal was right and unanswerable.
  //  "Name the organization" from a form with no organization is a dead
  //  end, and dead ends are what the refusal vocabulary exists to prevent.
  const superAdmin = await mkUser("super_admin", null);
  const sSuper = await mkSession(superAdmin);
  const asSuper = Object.assign({}, KEY, { "x-staff-session": sSuper });

  const superNoOrg = await request("POST", "/deal-setup/deals",
    { headers: asSuper, body: { deal_name: TAG + " no org named" } });
  ok("H3b a super_admin naming no organization is still refused",
     superNoOrg.status === 403 && superNoOrg.body.reason === "organization_required",
     `${superNoOrg.status} ${JSON.stringify(superNoOrg.body).slice(0, 140)}`);

  const superOpts = await request("GET", "/deal-setup/organizations", { headers: asSuper });
  ok("H3c …and the surface can ASK what it may choose between",
     superOpts.status === 200 && superOpts.body.must_choose === true
     && (superOpts.body.organizations || []).some((o) => o.id === orgA),
     JSON.stringify(superOpts.body).slice(0, 180));

  const superNamed = await request("POST", "/deal-setup/deals", {
    headers: asSuper, body: { deal_name: TAG + " named", organization_id: orgA } });
  ok("H3d …so naming one from that list works",
     superNamed.status === 201 && superNamed.body.deal.organization_id === orgA,
     `${superNamed.status} ${JSON.stringify(superNamed.body).slice(0, 140)}`);

  //  An org_admin must NOT be asked. Their client comes from the login,
  //  and a picker would imply a choice the write would ignore.
  const adminOpts = await request("GET", "/deal-setup/organizations", { headers: asA });
  ok("H3e an org_admin is told their client, not asked to choose",
     adminOpts.status === 200 && adminOpts.body.must_choose === false
     && (adminOpts.body.organizations || []).length === 1
     && adminOpts.body.organizations[0].id === orgA,
     JSON.stringify(adminOpts.body).slice(0, 180));

  const memberOpts = await request("GET", "/deal-setup/organizations", { headers: asM });
  ok("H3f a member is refused before being shown a form at all",
     memberOpts.status === 403 && memberOpts.body.reason === "insufficient_platform_role",
     `${memberOpts.status} ${JSON.stringify(memberOpts.body).slice(0, 140)}`);

  // ── H7 · a property, through the 1A canonical service ─────────────
  const prop = await request("POST", `/deal-setup/deals/${dealId}/properties/new`, {
    headers: asA,
    body: { name: TAG + " Chestnut", address: `${N} Chestnut St`,
            city: "Philadelphia", state: "PA", zip: "19104" } });
  ok("H7  a property is created into the deal, with a derived identity",
     prop.status === 201 && prop.body.property && prop.body.property.canonical_key
       === `${N}-CHESTNUT`,
     JSON.stringify(prop.body).slice(0, 200));
  const propertyId = prop.body.property.id;

  // ── H8–H10 · the retained file, over multipart ────────────────────
  const fileBuf = Buffer.from(RENT_ROLL, "utf8");
  const trueDigest = crypto.createHash("sha256").update(fileBuf).digest("hex");
  const mp = multipart("file", "SOLO Rent Roll 2026-04-30.csv", "text/csv", fileBuf,
    { source_as_of_date: "2026-04-30" });
  const up = await request("POST", `/deal-setup/deals/${dealId}/properties/${propertyId}/source`,
    { headers: Object.assign({}, asA, mp.headers), raw: mp.body });
  ok("H8  the real file uploads and is retained",
     up.status === 201 && up.body.artifact && up.body.artifact.byte_size === fileBuf.length,
     `${up.status} ${JSON.stringify(up.body).slice(0, 200)}`);
  const artifactId = up.body.artifact && up.body.artifact.id;

  const stored = (await pool.query(
    `select sha256, octet_length(content) as len from source_artifacts where id=$1`,
    [artifactId])).rows[0];
  ok("H8b the stored digest is of the bytes that crossed the wire",
     stored && stored.sha256 === trueDigest && stored.len === fileBuf.length);

  const up2 = await request("POST", `/deal-setup/deals/${dealId}/properties/${propertyId}/source`,
    { headers: Object.assign({}, asA, mp.headers), raw: mp.body });
  ok("H9  the same file uploaded twice is one artifact",
     up2.status === 200 && up2.body.artifact.id === artifactId);

  const pdfBytes = Buffer.concat([Buffer.from("%PDF-1.4\n"), crypto.randomBytes(64)]);
  const badMp = multipart("file", "rentroll.csv", "text/csv", pdfBytes);
  const bad = await request("POST", `/deal-setup/deals/${dealId}/properties/${propertyId}/source`,
    { headers: Object.assign({}, asA, badMp.headers), raw: badMp.body });
  ok("H10 a file whose contents contradict its name is refused, sayably",
     bad.status === 400 && /readable text|contents are/i.test(bad.body.receipt || ""),
     `${bad.status} ${JSON.stringify(bad.body).slice(0, 200)}`);

  // ── H11–H13 · activation ──────────────────────────────────────────
  const act = await request("POST", `/deal-setup/deals/${dealId}/properties/${propertyId}/activation`,
    { headers: asA, body: {} });
  ok("H11 an activation opens", act.status === 201 && act.body.activation.property_id === propertyId,
     JSON.stringify(act.body).slice(0, 160));
  const activationId = act.body.activation.id;

  const read = await request("POST", `/deal-setup/activations/${activationId}/read-source`, {
    headers: asA,
    body: { rows: appParsedRows(RENT_ROLL), source_artifact_id: artifactId,
            source_as_of_date: "2026-04-30" } });
  ok("H12 reading the source produced a batch, evidence rows and proposals",
     read.status === 201 && read.body.import_batch_id && read.body.rows_read === 3,
     `${read.status} ${JSON.stringify(read.body).slice(0, 240)}`);

  ok("H13 the mapping is reported — what Spine understood, and what it did not",
     read.body.mapping && Array.isArray(read.body.mapping.understood)
     && read.body.mapping.understood.some((u) => u.read_as === "unit number")
     && read.body.mapping.understood.some((u) => u.read_as === "actual rent"),
     JSON.stringify(read.body.mapping).slice(0, 240));

  const view = await request("GET", `/deal-setup/activations/${activationId}`, { headers: asA });
  const staged = (view.body.proposals || []).filter((p) => p.status === "staged");
  ok("H13b the review reads back with a row per source row",
     view.status === 200 && view.body.proposals.length === 3 && staged.length >= 2,
     `proposals=${(view.body.proposals || []).length} staged=${staged.length}`);

  // ── H14–H16 · confirm and establish ───────────────────────────────
  for (const p of staged) {
    const c = await request("POST", `/deal-setup/proposals/${p.id}/confirm`, { headers: asA, body: {} });
    if (c.status !== 200) console.log("      (confirm " + p.natural_key + " → " +
      c.status + " " + JSON.stringify(c.body).slice(0, 120) + ")");
  }
  const leaseCount = (await pool.query(
    `select count(*)::int c from leases where property_id=$1 and lease_status='active'`,
    [propertyId])).rows[0].c;
  ok("H14 confirming wrote canonical leases", leaseCount >= 1, `leases=${leaseCount}`);

  const est = await request("POST", `/deal-setup/activations/${activationId}/establish`,
    { headers: asA, body: {} });
  ok("H15 the opening position is established",
     est.status === 201 && est.body.opening_position
     && est.body.opening_position.positions_established >= 1,
     `${est.status} ${JSON.stringify(est.body).slice(0, 220)}`);

  const posRead = await request("GET", `/deal-setup/properties/${propertyId}/opening-position`,
    { headers: asA });
  ok("H16 the position reads back, naming the file it came from",
     posRead.status === 200 && posRead.body.established === true
     && (posRead.body.sources || []).some((s) => s.sha256 === trueDigest),
     JSON.stringify(posRead.body).slice(0, 260));

  //  ── THE API'S OUTPUT KEYS ARE A CONTRACT ──────────────────────────
  //  A blunt identifier sweep during the 159 rename changed this response
  //  key and not the app that reads it, so the deal page showed "Setup in
  //  progress" for a property whose position WAS established. Nothing
  //  threw; the screen was simply wrong, and only a browser caught it.
  //  This pins the shape so the next rename cannot do it silently.
  const dealRead = await request("GET", `/deal-setup/deals/${dealId}`, { headers: asA });
  const propRow = ((dealRead.body || {}).properties || [])[0] || {};
  ok("H16b the deal read returns the established position under its documented key",
     dealRead.status === 200
     && Object.prototype.hasOwnProperty.call(propRow, "opening_tenancy_position_id")
     && Boolean(propRow.opening_tenancy_position_id),
     `keys returned: ${Object.keys(propRow).join(", ")}`);

  // ── H17 · PERSISTENCE ACROSS A REAL RESTART ───────────────────────
  const before = JSON.stringify({
    est: posRead.body.position.positions_established,
    unres: posRead.body.position.positions_unresolved,
    as_of: posRead.body.position.as_of_date,
    sources: (posRead.body.sources || []).map((s) => s.sha256).sort(),
  });
  await stopServer();
  await startServer();
  const afterRead = await request("GET", `/deal-setup/properties/${propertyId}/opening-position`,
    { headers: asA });
  const after = JSON.stringify({
    est: afterRead.body.position.positions_established,
    unres: afterRead.body.position.positions_unresolved,
    as_of: afterRead.body.position.as_of_date,
    sources: (afterRead.body.sources || []).map((s) => s.sha256).sort(),
  });
  ok("H17 the position is identical after a full server restart", before === after,
     `before=${before}\n        after =${after}`);

  const fileBack = await request("GET", `/deal-setup/source/${artifactId}/download`, { headers: asA });
  ok("H17b the exact source file is still downloadable, byte-identical",
     fileBack.status === 200 && Buffer.compare(fileBack.buffer, fileBuf) === 0);

  // ── H18–H19 · containment ─────────────────────────────────────────
  const bare = await request("POST", "/leases", {
    headers: KEY, body: { property_id: propertyId, space_id: seat, rent: 999 } });
  ok("H18 the bare lease writer is contained, naming both real paths",
     bare.status === 410 && bare.body.error === "bare_lease_writer_contained"
     && bare.body.what_you_can_do && bare.body.what_you_can_do.established_from_a_rent_roll,
     `${bare.status} ${JSON.stringify(bare.body).slice(0, 160)}`);

  const promoteActor = await request("POST", "/ingest/00000000-0000-0000-0000-000000000000/promote",
    { headers: KEY, body: { promoted_by: adminA } });
  ok("H19 the retired ingest promote route cannot accept a body actor or promote",
     promoteActor.status === 410 && promoteActor.body.code === "legacy_ingestion_retired",
     `${promoteActor.status} ${JSON.stringify(promoteActor.body).slice(0, 160)}`);

  // ── H20 · THE TWO SIDES SHARE ONE TRUTH ───────────────────────────
  //  The whole point of writing the evidence substrate as well as the
  //  canonical records: a position established in Deal Setup must
  //  appear on the staff Rent Roll, which reads import_batches →
  //  import_source_rows and overlays canonical positions.
  //
  //  /operator/rent-roll derives its property from the SESSION, so the
  //  session has to be seated on the property under test — which is
  //  exactly the rule that makes the read trustworthy.
  const opTok = crypto.randomBytes(32).toString("base64url");
  await pool.query(
    `insert into property_team_assignments (property_id, user_id, role_title, allowed_modules, active)
     values ($1,$2,'manager',ARRAY['management'],true) on conflict do nothing`,
    [propertyId, adminA]);
  await pool.query(
    `insert into staff_sessions (user_id, property_id, token, token_digest, issuance_purpose, expires_at)
     values ($1,$2,null,$3,'bootstrap_invite', now() + interval '4 hours')`,
    [adminA, propertyId, crypto.createHash("sha256").update(opTok, "utf8").digest("hex")]);

  const rr = await request("GET", "/operator/rent-roll",
    { headers: { "x-staff-session": opTok } });
  const rrRows = (rr.body && rr.body.rows) || [];
  ok("H20 the staff Rent Roll shows the sourced position from Deal Setup",
     rr.status === 200 && rr.body.has_data !== false && rrRows.length === 3,
     `${rr.status} has_data=${rr.body && rr.body.has_data} rows=${rrRows.length} ` +
     `receipt=${(rr.body || {}).receipt || ""}`);

  ok("H20b …with the source file it was established from",
     rr.body && rr.body.source && /SOLO Rent Roll 2026-04-30\.csv/.test(
       JSON.stringify(rr.body.source || {})),
     JSON.stringify((rr.body || {}).source || {}).slice(0, 200));

  const withCanonical = rrRows.filter((r) => r.canonical && r.canonical.current);
  ok("H20c …and the canonical leases overlay onto those rows",
     withCanonical.length >= 1,
     `rows with a canonical current lease: ${withCanonical.length}`);

  await stopServer();
  receipt.complete({ harness: __filename, passed: pass, failed: fail, expectedAtLeast: 28 });
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  try { await stopServer(); } catch (cleanupError) { console.error(cleanupError.message); }
  await pool.end().catch(() => {});
  process.exit(1);
});
