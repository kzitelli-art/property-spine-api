/*
 * Mixed-grain inventory proof.
 *
 * PROOF_EXPECT_DEFECT=1 is the pinned parent witness: the current writer
 * accepts a source that names Spine's whole-unit placeholder and a room on
 * one unit. The default is the successor contract: the canonical writer
 * refuses that source before it changes inventory or review state.
 *
 * This is a caller-owned disposable database proof. It uses synthetic rows,
 * the retained-source HTTP door when E2E_API_BASE is present, and the same
 * canonical services for the direct controls. It does not create a database,
 * call a provider, or use a fixture fallback.
 */
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const boundary = require("../e2e/proof_boundary.js");
require("../e2e/proof_fence_preload.js");
const { Pool } = require("pg");

const root = path.resolve(process.env.PROOF_BUSINESS_ROOT || path.join(__dirname, "../.."));
const parent = process.env.PROOF_EXPECT_DEFECT === "1";
const activation = require(path.join(root, "src/onboarding/activation_service.js"));
const artifacts = require(path.join(root, "src/onboarding/source_artifact_service.js"));
const deals = require(path.join(root, "src/onboarding/deal_service.js"));
const sessions = require(path.join(root, "src/identity/staff_session_service.js"));
const { materializeRentableSpaces } = require(path.join(root, "src/tenancy/inventory_materialization.js"));
const { datedPropertyPositions } = require(path.join(root, "src/tenancy/dated_positions.js"));
const { unitRentRoll } = require(path.join(root, "src/surfaces/rent_roll_unit_view.js"));
const { readTenancyStanding } = require(path.join(root, "src/tenancy/tenancy_position_read.js"));
const { availabilityRead } = require(path.join(root, "src/surfaces/availability_read.js"));
const { resolveApplicationTarget } = require(path.join(root, "src/applications/application_target_authority.js"));
const snapshotLoader = require(path.join(root, "src/shared/snapshot_loader.js"));

let passed = 0, failed = 0;
const clean = value => String(value == null ? "" : value)
  .replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, "<runtime-id>");
const ok = (label, condition, detail = "") => {
  if (condition) { passed++; console.log("  ok    " + label); }
  else { failed++; console.log("  FAIL  " + label + (detail ? "  ->  " + clean(detail) : "")); }
};
const AS_OF = "2026-07-31";
const HEADER = "Unit,Room,Resident,Market Rent,Actual Rent,Lease From,Lease To\n";
const api = process.env.E2E_API_BASE || null;
const evidence = { mode: parent ? "positive_parent_defect" : "successor", sections: {} };

(async () => {
  await boundary.assertDatabase();
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true }).trim();
  const branch = execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8", windowsHide: true }).trim();
  if (parent) {
    assert.equal(sha, "01fac5fb20317f310e2e62bc4e05439f076f39cf");
    assert.equal(branch, "codex/claim-relay-20260907");
    execFileSync("git", ["diff", "--exit-code", "HEAD", "--", "src", "server.js", "migrations"], { cwd: root, windowsHide: true, stdio: "pipe" });
  }
  console.log(`MIXED_GRAIN_PROOF_MODE=${evidence.mode}; BUSINESS_SHA=${sha}; HTTP=${api ? "yes" : "no"}`);

  const pool = new Pool({ connectionString: boundary.manifest().url, ssl: false });
  const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];
  const all = async (sql, args = []) => (await pool.query(sql, args)).rows;
  const errOf = e => ({
    status: e && (e.httpStatus || e.status || null),
    code: e && (e.reason || e.code || e.error || null),
    message: String(e && (e.publicMessage || e.receipt || e.message || e) || ""),
  });
  try {
    const tag = `mixed-grain-${randomUUID()}`;
    const org = await one("insert into organizations(name,slug) values($1,$1) returning id", [tag]);
    const person = await one("insert into persons(name) values('Synthetic Grain Operator') returning id");
    const user = await one(`insert into users(name,email,platform_role,organization_id,person_id,is_active,status,account_kind)
      values('Synthetic Grain Operator',$1,'org_admin',$2,$3,true,'active','human_staff') returning id`, [`${tag}@example.test`, org.id, person.id]);

    async function property(name, basis, preexisting = {}) {
      const deal = await deals.createDeal(pool, { user_id: user.id, deal_name: `${tag}-${name}`, creation_source: "deal_setup_console" });
      const p = await one("insert into properties(name,canonical_key,organization_id,leasing_basis) values($1,$1,$2,$3) returning id", [`${tag}-${name}`, org.id, basis]);
      await deals.addProperty(pool, { user_id: user.id, deal_intake_id: deal.id, property_id: p.id });
      await pool.query("insert into property_team_assignments(property_id,user_id,role_title,allowed_modules,active) values($1,$2,'Proof Manager','{management,leasing}',true)", [p.id, user.id]);
      const c = await pool.connect(); let token;
      try {
        await c.query("begin");
        token = (await sessions.issueStaffSession(c, { userId: user.id, propertyId: p.id, purpose: "sms_otp" })).session_token;
        await c.query("commit");
      } finally { c.release(); }
      const unitIds = {}, spaceIds = {};
      for (const [number, labels] of Object.entries(preexisting)) {
        const u = await one("insert into units(property_id,unit_number) values($1,$2) returning id", [p.id, number]);
        unitIds[number] = u.id;
        const placeholder = await one("select id from spaces where unit_id=$1", [u.id]);
        for (const label of labels) {
          const s = label === "(whole unit)" ? placeholder
            : await one("insert into spaces(unit_id,space_label) values($1,$2) returning id", [u.id, label]);
          spaceIds[`${number}|${label}`] = s.id;
        }
      }
      return { id: p.id, deal: deal.id, token, name, unitIds, spaceIds };
    }

    async function http(token, url, { method = "GET", body = null, form = null } = {}) {
      const headers = { "x-staff-session": token };
      let payload;
      if (form) payload = form;
      else if (method === "POST") { headers["content-type"] = "application/json"; payload = JSON.stringify(body || {}); }
      const r = await fetch(api + url, { method, headers, body: payload, signal: AbortSignal.timeout(30000) });
      let json = null; try { json = await r.json(); } catch (_) { /* refusal may be non-JSON */ }
      return { status: r.status, body: json };
    }

    async function prepare(p, csv, filename = `${p.name}.csv`) {
      if (api) {
        const form = new FormData();
        form.append("file", new Blob([csv], { type: "text/csv" }), filename);
        form.append("source_as_of_date", AS_OF);
        const up = await http(p.token, `/deal-setup/deals/${p.deal}/properties/${p.id}/source`, { method: "POST", form });
        if (!up.body || !up.body.artifact) throw Object.assign(new Error(JSON.stringify(up.body)), { httpStatus: up.status, code: up.body && up.body.error });
        const opened = await http(p.token, `/deal-setup/deals/${p.deal}/properties/${p.id}/activation`, { method: "POST" });
        return { artifact: up.body.artifact, activation: opened.body.activation.id, upload_status: up.status };
      }
      const opened = (await activation.openActivation(pool, { user_id: user.id, deal_intake_id: p.deal, property_id: p.id })).activation;
      const artifact = await artifacts.store(pool, { scope_type: "property", scope_id: p.id, filename, mimetype: "text/csv", buffer: Buffer.from(csv), uploaded_by_user_id: user.id, source_as_of_date: AS_OF });
      return { artifact, activation: opened.id, upload_status: 201 };
    }

    async function readSource(p, prepared) {
      try {
        if (api) {
          const r = await http(p.token, `/deal-setup/activations/${prepared.activation}/read-source`, { method: "POST", body: { source_artifact_id: prepared.artifact.id, source_as_of_date: AS_OF } });
          if (r.status !== 201) return { ok: false, error: { status: r.status, code: r.body && r.body.error, message: String(r.body && (r.body.receipt || r.body.message) || "") }, http: r };
          const review = await http(p.token, `/deal-setup/activations/${prepared.activation}`);
          return { ok: true, act: prepared.activation, proposals: (review.body && review.body.proposals) || [], http: r };
        }
        const out = await activation.ingestRentRoll(pool, { user_id: user.id, deal_intake_id: p.deal, property_id: p.id, activation_id: prepared.activation, source_artifact_id: prepared.artifact.id, source_as_of_date: AS_OF });
        return { ok: true, act: prepared.activation, proposals: (await activation.readActivation(pool, { user_id: user.id, activation_id: prepared.activation })).proposals, service: out };
      } catch (e) { return { ok: false, error: errOf(e) }; }
    }

    async function confirmAll(p, proposals) {
      const results = [];
      for (const q of proposals) {
        if (api) {
          const r = await http(p.token, `/deal-setup/proposals/${q.id}/confirm`, { method: "POST" });
          results.push({ status: r.status, code: r.body && r.body.error || null });
        } else {
          try { await activation.confirmProposal(pool, { user_id: user.id, proposed_id: q.id }); results.push({ status: 200, code: null }); }
          catch (e) { const x = errOf(e); results.push({ status: x.status, code: x.code }); }
        }
      }
      return results;
    }
    async function establish(p, act) {
      if (api) return (await http(p.token, `/deal-setup/activations/${act}/establish`, { method: "POST" })).status;
      await activation.establishOpeningPosition(pool, { user_id: user.id, activation_id: act }); return 201;
    }

    const spacesOf = p => all(`select u.unit_number, s.space_label, s.position_kind from spaces s join units u on u.id=s.unit_id where u.property_id=$1 order by 1,2`, [p.id]);
    const lineageOf = p => all(`select r.row_index, r.raw->>'unit_number' as unit_number,
        coalesce(r.raw->>'space_label', r.raw->>'room') as label,
        r.produced_unit_id is not null as unit_linked,
        (select space_label from spaces where id=r.produced_space_id) as produced_space, r.parse_note
       from import_source_rows r join import_batches b on b.id=r.import_batch_id where b.property_id=$1 order by r.row_index`, [p.id]);
    async function state(p) {
      const r = await one(`select
        (select count(*) from units where property_id=$1)::int as units,
        (select count(*) from spaces s join units u on u.id=s.unit_id where u.property_id=$1)::int as spaces,
        (select count(*) from import_source_rows r join import_batches b on b.id=r.import_batch_id where b.property_id=$1)::int as lineage,
        (select count(*) from proposed_records where property_id=$1)::int as proposals,
        (select count(*) from leases where property_id=$1)::int as leases,
        (select count(*) from opening_tenancy_positions where property_id=$1)::int as baselines,
        (select count(*) from import_batches where property_id=$1)::int as batches`, [p.id]);
      return r;
    }
    async function activationState(p, activationId) {
      return one(`select status, import_batch_id, source_artifact_id
        from activations where id=$1 and property_id=$2`, [activationId, p.id]);
    }
    async function artifactMeta(id) {
      return one(`select original_filename, byte_size::int as byte_size, sha256, source_as_of_date::text as source_as_of_date
        from source_artifacts where id=$1`, [id]);
    }
    const sameState = (a, b) => ["units", "spaces", "lineage", "proposals", "leases", "baselines", "batches"].every(k => Number(a[k]) === Number(b[k]));
    const sameActivation = (a, b) => ["status", "import_batch_id", "source_artifact_id"]
      .every(k => (a && a[k] || null) === (b && b[k] || null));
    const comparatorBaseline = { units:0, spaces:0, lineage:0, proposals:0, leases:0, baselines:0, batches:0 };
    const comparatorActivation = { status:"open", import_batch_id:null, source_artifact_id:null };
    evidence.sections.comparator = { scope: "helper_only" };
    ok("helper-only comparator: a batch-only mutation is unequal", !sameState(comparatorBaseline, { ...comparatorBaseline, batches:1 }));
    ok("helper-only comparator: an activation-link-only mutation is unequal", !sameActivation(comparatorActivation, { ...comparatorActivation, source_artifact_id:"synthetic-artifact-link" }));

    async function reads(p, unit) {
      await pool.query("update spaces set use_type='residential' where use_type is null and unit_id in (select id from units where property_id=$1)", [p.id]);
      const dp = await datedPropertyPositions(pool, { property_id: p.id, as_of: AS_OF });
      const positions = dp.positions.filter(x => x.unit_number === unit).map(x => ({ label: x.space_label, derived_kind: x.position_kind, basis_state: x.basis_state }));
      const rr = await unitRentRoll(pool, { property_id: p.id, as_of: AS_OF });
      const rrUnit = (rr.units || []).find(u => u.unit_number === unit) || null;
      const standing = await readTenancyStanding(pool, { property_id: p.id, as_of: AS_OF });
      const av = await availabilityRead(pool, { property_id: p.id, as_of: AS_OF });
      const avRows = av.rows.filter(r => r.unit_number === unit).map(r => ({ label: r.space_label, marketing_state: r.marketing_state, kind: r.position_kind }));
      const targets = [];
      for (const r of av.rows.filter(r => r.unit_number === unit)) {
        const v = await resolveApplicationTarget(pool, { property_id: p.id, unit_id: r.unit_id, space_id: r.space_id });
        targets.push({ label: r.space_label, offerable: v.offerable === true, refusal: v.refusal_code || null });
      }
      return { positions, rent_roll_positions: rrUnit ? rrUnit.rentable_positions : null, standing_rentable_positions: standing.position && standing.position.rentable_positions, availability: avRows, targets };
    }

    // 1. The retained-source writer, both input orders.
    const S1 = evidence.sections.writer = {};
    for (const [order, rows] of [["whole_then_room", ["401,(whole unit),VACANT,900,,,", "401,Room1,VACANT,900,,,"]], ["room_then_whole", ["402,Room1,VACANT,900,,,", "402,(whole unit),VACANT,900,,,"]]]) {
      const unit = rows[0].split(",")[0];
      const p = await property(order, "bed");
      const prep = await prepare(p, HEADER + rows.join("\n") + "\n");
      const before = await state(p);
      const artifactBefore = await artifactMeta(prep.artifact.id);
      const ing = await readSource(p, prep);
      const after = await state(p);
      const artifactAfter = await artifactMeta(prep.artifact.id);
      S1[order] = { result: ing.error || null, before, after, artifact_preserved: Boolean(artifactAfter && artifactBefore && artifactAfter.sha256 === artifactBefore.sha256 && artifactAfter.byte_size === artifactBefore.byte_size) };
      if (parent) {
        const spaces = await spacesOf(p), lineage = await lineageOf(p);
        const confirms = ing.ok ? await confirmAll(p, ing.proposals) : [];
        const established = ing.ok ? await establish(p, ing.act) : null;
        const rd = await reads(p, unit);
        ok(`1 ${order}: retained-source read accepts the mixed labels`, ing.ok && ing.http ? ing.http.status === 201 : ing.ok, JSON.stringify(ing.error));
        ok(`1 ${order}: writer creates both labels as bed positions`, spaces.length === 2 && spaces.map(s => s.space_label).sort().join("|") === "(whole unit)|Room1" && spaces.every(s => s.position_kind === "bed"));
        ok(`1 ${order}: both source rows retain their own lineage`, lineage.length === 2 && lineage.every(l => l.unit_linked && l.produced_space === l.label));
        ok(`1 ${order}: both proposals confirm and the opening position establishes`, confirms.length === 2 && confirms.every(c => c.status === 200) && established === 201);
        ok(`1 ${order}: canonical reads count two established bed positions`, rd.positions.length === 2 && rd.positions.every(x => x.basis_state === "established" && x.derived_kind === "bed") && rd.rent_roll_positions === 2 && rd.standing_rentable_positions === 2);
        ok(`1 ${order}: availability and application authority offer both positions`, rd.availability.length === 2 && rd.availability.every(r => r.marketing_state === "marketable_now") && rd.targets.length === 2 && rd.targets.every(t => t.offerable));
        if (api) ok(`1 ${order} HTTP: read-source is the real retained-source door`, ing.http.status === 201 && ing.http.body && ing.http.body.import_batch_id);
      } else {
        const message = ing.error && ing.error.message || "";
        ok(`1 ${order}: HTTP read-source refuses with 409`, api ? ing.error && ing.error.status === 409 : ing.error && ing.error.status === 409);
        if (api) ok(`1 ${order}: HTTP refusal is generic refused plus a plain unit-specific review receipt`, ing.error.code === "refused" && new RegExp(`\\b${unit}\\b`).test(message) && /whole.?unit/i.test(message) && /Room1/i.test(message) && /review|source|upload|restate/i.test(message) && !/MIXED_GRAIN_LABELS/.test(message));
        else ok(`1 ${order}: service refusal names MIXED_GRAIN_LABELS`, ing.error && ing.error.code === "MIXED_GRAIN_LABELS");
        ok(`1 ${order}: retained artifact survives the refusal`, S1[order].artifact_preserved);
        ok(`1 ${order}: refusal leaves units, spaces, lineage, proposals, leases and baselines unchanged`, sameState(before, after), `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
        ok(`1 ${order}: no activation baseline was established`, Number(after.baselines) === 0);
      }
    }
    ok("1: parent witness and successor guard use the same two input orders", Object.keys(S1).length === 2);

    // 1b. A valid earlier unit must not survive a later contradiction.
    const composite = await property("valid-then-mixed", "bed");
    const compositePrep = await prepare(composite,
      HEADER + "500,Room1,VACANT,900,,,\n" +
               "501,(whole unit),VACANT,900,,,\n" +
               "501,Room1,VACANT,900,,,\n");
    const compositeBefore = await state(composite);
    const compositeActivationBefore = await activationState(composite, compositePrep.activation);
    const compositeArtifactBefore = await artifactMeta(compositePrep.artifact.id);
    const compositeResult = await readSource(composite, compositePrep);
    const compositeAfter = await state(composite);
    const compositeActivationAfter = await activationState(composite, compositePrep.activation);
    const compositeArtifactAfter = await artifactMeta(compositePrep.artifact.id);

    if (parent) {
      ok("1b parent: valid earlier unit and later mixed unit are accepted on the parent",
        compositeResult.ok === true && compositeResult.proposals.length === 3);
      ok("1b parent: the parent commits both source units",
        compositeAfter.units === 2 && compositeAfter.spaces === 3 && compositeAfter.lineage === 3 && compositeAfter.batches === 1);
      ok("1b parent: activation links the committed batch to the retained artifact",
        compositeActivationAfter && compositeActivationAfter.status === "open" &&
        compositeActivationAfter.import_batch_id && compositeActivationAfter.source_artifact_id === compositePrep.artifact.id);
    } else {
      const msg = compositeResult.error && compositeResult.error.message || "";
      ok("1b successor: later mixed unit refuses the whole retained-source read",
        compositeResult.error && compositeResult.error.status === 409 &&
        (api ? compositeResult.error.code === "refused" : compositeResult.error.code === "MIXED_GRAIN_LABELS"));
      if (api) ok("1b successor HTTP: receipt names the later unit and review action",
        /501/.test(msg) && /whole.?unit/i.test(msg) && /Room1/i.test(msg) && /review|source|restate/i.test(msg) &&
        !/MIXED_GRAIN_LABELS/.test(msg));
      ok("1b successor: the valid earlier unit was rolled back too", sameState(compositeBefore, compositeAfter));
      ok("1b successor: no empty batch or baseline survived", compositeAfter.batches === compositeBefore.batches && compositeAfter.baselines === compositeBefore.baselines);
      ok("1b successor: activation remains open and unlinked", compositeActivationAfter &&
        sameActivation(compositeActivationBefore, compositeActivationAfter));
      ok("1b successor: retained artifact metadata survives", compositeArtifactAfter && compositeArtifactBefore &&
        compositeArtifactAfter.sha256 === compositeArtifactBefore.sha256 &&
        compositeArtifactAfter.byte_size === compositeArtifactBefore.byte_size);
    }

    // 1c. The older generic snapshot entry must reach the same materializer.
    // This direct call is the exported function used by the older /snapshot
    // doors; it is not a replacement for the canonical retained-source proof.
    const legacy = await property("legacy-snapshot-mixed", "bed");
    const legacyBefore = await state(legacy);
    const legacyRows = [
      { unit_number: "600", room: "Room1", status: "vacant" },
      { unit_number: "601", room: "(whole unit)", status: "vacant" },
      { unit_number: "601", room: "Room1", status: "vacant" },
    ];
    const legacyResult = await snapshotLoader.loadSnapshot(pool,
      { ...snapshotLoader.CONFIGS.skyline, key: "synthetic-legacy", source_file: "legacy-mixed.csv",
        source_as_of_date: AS_OF, leasing_model: "bed", confidence: "confirmed" },
      legacyRows,
      { targetPropertyId: legacy.id, sourceFile: "legacy-mixed.csv", sourceAsOfDate: AS_OF,
        leasingModel: "bed", confidence: "confirmed", force: true });
    const legacyAfter = await state(legacy);

    if (parent) {
      ok("1c parent: older loadSnapshot accepts the mixed source", legacyResult.ok === true);
      ok("1c parent: older entry commits the earlier and contradictory units",
        legacyAfter.units === 2 && legacyAfter.spaces === 3 && legacyAfter.batches === 1);
    } else {
      ok("1c successor: older loadSnapshot reaches MIXED_GRAIN_LABELS and reports its legacy wrapper",
        legacyResult.error === "load_failed" && /whole.?unit/i.test(String(legacyResult.detail || "")) &&
        /601/.test(String(legacyResult.detail || "")));
      ok("1c successor: older loadSnapshot rolls back the earlier valid unit too",
        sameState(legacyBefore, legacyAfter));
    }

    // 2. Direct materialization controls. The direct service exposes the
    // machine-readable refusal; the HTTP door deliberately does not.
    const S2 = evidence.sections.materialization = {};
    const pm = await property("materialize", "bed", { "411": ["(whole unit)"], "412": ["(whole unit)"], "413": ["(whole unit)"] });
    const tx = async fn => { const c = await pool.connect(); try { await c.query("begin"); const r = await fn(c); await c.query("commit"); return r; } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); } };
    const mat = async (unit, labels) => {
      const before = await all("select id,space_label,position_kind,use_type from spaces where unit_id=$1 order by id", [pm.unitIds[unit]]);
      try { return { receipt: await tx(c => materializeRentableSpaces(c, { unit_id: pm.unitIds[unit], labels, kind: "bed", use_type: "residential" })), before, after: await all("select id,space_label,position_kind,use_type from spaces where unit_id=$1 order by id", [pm.unitIds[unit]]) }; }
      catch (e) { return { error: errOf(e), before, after: await all("select id,space_label,position_kind,use_type from spaces where unit_id=$1 order by id", [pm.unitIds[unit]]) }; }
    };
    S2.both_orders = { a: await mat("411", ["(whole unit)", "Room1"]), b: await mat("412", ["Room1", "(whole unit)"]) };
    if (parent) {
      ok("2: direct materialization accepts both label orders", S2.both_orders.a.receipt && S2.both_orders.b.receipt);
      ok("2: the placeholder is kept and Room1 is created beside it", S2.both_orders.a.receipt.created.includes("Room1") && S2.both_orders.a.receipt.kept.includes("(whole unit)"));
      const s = await spacesOf(pm); ok("2: both positions are stamped bed", s.filter(x => ["411", "412"].includes(x.unit_number)).every(x => x.position_kind === "bed"));
    } else {
      for (const [label, result] of Object.entries(S2.both_orders)) {
        ok(`2 ${label}: direct materialization refuses MIXED_GRAIN_LABELS`, result.error && result.error.code === "MIXED_GRAIN_LABELS");
        ok(`2 ${label}: refusal leaves the existing placeholder unchanged`, JSON.stringify(result.before) === JSON.stringify(result.after));
      }
    }
    const control = await mat("413", ["Room1"]);
    ok("2 control: a sole named bed still consumes the pristine placeholder", control.receipt && control.receipt.consumed_placeholder && (await spacesOf(pm)).filter(s => s.unit_number === "413").length === 1);

    // 3. Legitimate controls through the same retained-source writer.
    const S3 = evidence.sections.controls = {};
    const run = async (name, basis, csv, preexisting = {}, { confirm = true } = {}) => {
      const p = await property(name, basis, preexisting);
      const prep = await prepare(p, csv);
      const ing = await readSource(p, prep);
      const r = { ingest_error: ing.error, proposals: ing.proposals ? ing.proposals.length : 0, spaces: await spacesOf(p), lineage: (await lineageOf(p)).map(l => ({ label: l.label, unit: l.unit_number, produced: l.produced_space, note: l.parse_note })) };
      if (ing.ok && confirm) { r.confirm = await confirmAll(p, ing.proposals.filter(q => q.status !== "blocked")); r.establish = await establish(p, ing.act); }
      r.property = p; return r;
    };
    S3.single_whole_unit = await run("c1-whole-unit", "unit", HEADER + "501,,VACANT,900,,,\n");
    ok("3 C1: valid by-unit inventory remains one whole-unit position", S3.single_whole_unit.spaces.length === 1 && S3.single_whole_unit.spaces[0].space_label === "(whole unit)" && S3.single_whole_unit.confirm.every(c => c.status === 200));
    S3.sole_bed_ledger_label = await run("c2-sole-bed", "bed", HEADER + "3B,Bed B,VACANT,900,,,\n");
    ok("3 C2: sole ledger-style bed still consumes the placeholder", S3.sole_bed_ledger_label.spaces.length === 1 && S3.sole_bed_ledger_label.spaces[0].space_label === "Bed B" && S3.sole_bed_ledger_label.spaces[0].position_kind === "bed" && S3.sole_bed_ledger_label.confirm[0].status === 200);
    S3.fixture_shape_reread = await run("c2b-fixture-shape", "bed", HEADER + "3B,Bed B,VACANT,900,,,\n", { "3B": ["(whole unit)", "Bed B"] });
    { const rd = await reads(S3.fixture_shape_reread.property, "3B"); S3.fixture_shape_reread.reads = rd; const ph = rd.availability.find(r => /whole/.test(r.label)), bed = rd.availability.find(r => r.label === "Bed B"); ok("3 C2b: existing placeholder beside a bed remains an explicit unresolved read", S3.fixture_shape_reread.spaces.length === 2 && bed && bed.marketing_state === "marketable_now" && ph && ph.marketing_state === "occupancy_unknown"); }
    S3.multi_bed = await run("c3-multi-bed", "bed", HEADER + ["701,Room1,VACANT,900,,,", "701,Room2,VACANT,900,,,", "701,Room3,VACANT,900,,,"].join("\n") + "\n");
    ok("3 C3: three named beds remain three positions", S3.multi_bed.spaces.map(s => s.space_label).join("|") === "Room1|Room2|Room3" && S3.multi_bed.spaces.every(s => s.position_kind === "bed") && S3.multi_bed.confirm.every(c => c.status === 200));
    S3.mixed_property = await run("c4-mixed-property", "bed", HEADER + ["801,(whole unit),VACANT,900,,,", "802,Room1,VACANT,900,,,", "802,Room2,VACANT,900,,,"].join("\n") + "\n");
    { const u801 = S3.mixed_property.spaces.filter(s => s.unit_number === "801"), u802 = S3.mixed_property.spaces.filter(s => s.unit_number === "802"); ok("3 C4: whole-unit and bed units in one property remain valid", u801.length === 1 && u802.length === 2 && S3.mixed_property.confirm.every(c => c.status === 200)); }
    const c5 = await property("c5-history-real", "bed", { "901": ["(whole unit)"] });
    await pool.query("insert into leases(property_id,space_id,tenant_ids,rent,start_date,end_date,lease_status) values($1,$2,$3,850,'2026-01-01','2027-12-31','active')", [c5.id, c5.spaceIds["901|(whole unit)"], [person.id]]);
    const c5ing = await readSource(c5, await prepare(c5, HEADER + "901,Room1,VACANT,900,,,\n"));
    S3.history_blocks_conversion = c5ing;
    ok("3 C5: retained whole-unit history still refuses conversion", !c5ing.ok && /PLACEHOLDER_NOT_PRISTINE|whole-unit grain/i.test(JSON.stringify(c5ing.error)) && (await spacesOf(c5)).length === 1);
    S3.future_only_rooms = await run("c6-future-rooms", "bed", HEADER + "1001,Room1,VACANT,900,,,\nFuture Residents/Applicants\n1001,Room9,Future Person,900,900,2026-09-01,2027-08-31\n1002,Room1,Future Person Two,900,900,2026-09-01,2027-08-31\n", {}, { confirm: false });
    ok("3 C6: future-only rooms and units create no current inventory", S3.future_only_rooms.spaces.length === 1 && S3.future_only_rooms.spaces[0].space_label === "Room1" && S3.future_only_rooms.lineage.filter(x => /discrepancy/.test(x.note || "")).length === 2);
    for (const k of Object.keys(S3)) if (S3[k].property) delete S3[k].property;

    // 4. The historical correction path is run only against the parent
    // defect fixture. Successor mode uses a clearly labelled direct-history
    // fixture and makes no new-source claim about an already bad property.
    const S4 = evidence.sections.correction = {};
    if (parent) {
      const mixed = await property("correction", "bed");
      const mixedIng = await readSource(mixed, await prepare(mixed, HEADER + "421,(whole unit),VACANT,900,,,\n421,Room1,VACANT,900,,,\n"));
      await confirmAll(mixed, mixedIng.proposals); await establish(mixed, mixedIng.act);
      const unitId = (await one("select id from units where property_id=$1 and unit_number='421'", [mixed.id])).id;
      try { await tx(c => materializeRentableSpaces(c, { unit_id: unitId, labels: ["Room1"], kind: "bed" })); S4.materialize = { accepted: true }; }
      catch (e) { S4.materialize = errOf(e); }
      ok("4 parent correction: the existing defect reaches PLACEHOLDER_NOT_PRISTINE", S4.materialize.code === "PLACEHOLDER_NOT_PRISTINE" && /import_source_rows/.test(S4.materialize.message));
    } else {
      const historical = await property("historical-defect-fixture", "bed", { "421": ["(whole unit)", "Room1"] });
      const batch = await one(`insert into import_batches(property_id,source_type,source_file,source_as_of_date,leasing_model,confidence,status)
        values($1,'rent_roll_ledger','historical-defect-fixture.csv',$2,'bed','confirmed','committed') returning id`, [historical.id, AS_OF]);
      await pool.query(`insert into import_source_rows(import_batch_id,row_index,raw,produced_unit_id,produced_space_id,parse_note)
        values($1,1,$2,$3,$4,'explicit historical mixed-grain fixture')`, [batch.id, JSON.stringify({ unit_number: "421", space_label: "(whole unit)" }), historical.unitIds["421"], historical.spaceIds["421|(whole unit)"]]);
      const before = await state(historical);
      try { await tx(c => materializeRentableSpaces(c, { unit_id: historical.unitIds["421"], labels: ["Room1"], kind: "bed" })); S4.historical = { accepted: true }; }
      catch (e) { S4.historical = errOf(e); }
      const after = await state(historical);
      ok("4 successor historical fixture: correction remains held by existing lineage", S4.historical.code === "PLACEHOLDER_NOT_PRISTINE" && /import_source_rows/.test(S4.historical.message));
      ok("4 successor historical fixture: no correction mutation occurs", sameState(before, after));
    }

    if (process.env.PROOF_OUTPUT_DIR) fs.writeFileSync(path.join(process.env.PROOF_OUTPUT_DIR, "mixed-grain-writer-challenge.json"), JSON.stringify({ ...evidence, business_sha: sha, http: Boolean(api) }, null, 2));
  } finally { await pool.end(); }
  console.log(`MIXED_GRAIN_PROOF_PASSED=${passed}; FAILED=${failed}`);
  process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error(clean(error && error.stack || error)); process.exitCode = 1; });
