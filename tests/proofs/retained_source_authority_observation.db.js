/*
 * Retained-source authority observation.
 *
 * PROOF_SOURCE_AUTH_EXPECT_DEFECT=1 (or the wrapper's PROOF_EXPECT_DEFECT=1)
 * is the positive parent observation: the current read doors allow same-org
 * actors without target-property assignment or a relevant module. The default
 * successor mode keeps same-org org-admin and relevant-module controls while
 * requiring a member outside the target property or module to be refused.
 *
 * The parent mode deliberately records current deal-wide visibility as an
 * observation. It does not turn that observation into a permanent role policy.
 *
 * This proof observes the existing Deal Setup activation metadata read and
 * source download for synthetic actors. It requires metadata and bytes to
 * agree and keeps the retained artifact itself as the only source of bytes.
 *
 * The caller owns the nonce-marked disposable database and the already-booted
 * loopback API. Fixture writes are synthetic setup only; the HTTP probes are
 * GETs. No provider, production, or real-user action is involved.
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const boundary = require("../e2e/proof_boundary.js");
require("../e2e/proof_fence_preload.js");
const { Pool } = require("pg");

const root = path.resolve(process.env.PROOF_BUSINESS_ROOT || path.join(__dirname, "../.."));
const parent = process.env.PROOF_SOURCE_AUTH_EXPECT_DEFECT === "1" || process.env.PROOF_EXPECT_DEFECT === "1";
const api = String(process.env.E2E_API_BASE || "").replace(/\/+$/, "");
if (!api) throw new Error("E2E_API_BASE is required; this observation has no service fallback");

const activation = require(path.join(root, "src/onboarding/activation_service.js"));
const artifacts = require(path.join(root, "src/onboarding/source_artifact_service.js"));
const deals = require(path.join(root, "src/onboarding/deal_service.js"));

let passed = 0;
let failed = 0;
const ok = (label, condition) => {
  if (condition) { passed++; console.log(`  ok    ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}`); }
};

const AS_OF = "2026-07-31";
const SOURCE = Buffer.from(
  "Unit,Room,Resident,Market Rent,Actual Rent,Lease From,Lease To\n" +
  "900,Room1,VACANT,900,,,\n",
  "utf8"
);
const UTILITY_SOURCE = Buffer.from("%PDF-1.4\nSynthetic Utility Statement\n", "utf8");
const CONTRACTED_SOURCE = Buffer.from("%PDF-1.4\nSynthetic Contracted Service Other\n", "utf8");

async function main() {
  await boundary.assertDatabase();
  const manifest = boundary.manifest();
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true }).trim();
  const branch = execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8", windowsHide: true }).trim();
  if (parent) {
    assert.equal(sha, "c8dc7d1c011de50cbca9417491e88e36d61c3d1e");
    execFileSync("git", ["diff", "--exit-code", "HEAD", "--", "src", "server.js", "migrations"], {
      cwd: root, windowsHide: true, stdio: "pipe",
    });
  }
  console.log(`RETAINED_SOURCE_AUTH_MODE=${parent ? "positive_parent_observation" : "successor"}; BUSINESS_SHA=${sha}; BRANCH=${branch}; HTTP=yes`);

  const pool = new Pool({ connectionString: manifest.url, ssl: false });
  const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];

  async function user(role, org, name) {
    const person = await one("insert into persons(name) values($1) returning id", [name]);
    return one(`insert into users(name,email,platform_role,organization_id,person_id,is_active,status,account_kind)
      values($1,$2,$3,$4,$5,true,'active','human_staff') returning id`,
      [name, `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}@example.test`, role, org, person.id]);
  }

  async function assignment(userId, propertyId, modules, active = true) {
    await pool.query(`insert into property_team_assignments
        (property_id,user_id,role_title,allowed_modules,active)
      values($1,$2,'synthetic observation',$3,$4)
      on conflict (property_id,user_id) do update
        set allowed_modules=excluded.allowed_modules, active=excluded.active`,
      [propertyId, userId, modules, active]);
  }

  async function session(userId, propertyId, modules,
    { expires = "4 hours", revoked = false, assignmentActive = true } = {}) {
    const token = crypto.randomBytes(32).toString("base64url");
    await assignment(userId, propertyId, modules, assignmentActive);
    await pool.query(`insert into staff_sessions
        (user_id,property_id,token,token_digest,issuance_purpose,expires_at,revoked)
      values($1,$2,null,$3,'bootstrap_invite',now()+$4::interval,$5)`,
      [userId, propertyId, crypto.createHash("sha256").update(token, "utf8").digest("hex"), expires, revoked]);
    return token;
  }

  async function request(pathname, token, { method = "GET", body: requestBody = undefined } = {}) {
    const headers = { "x-staff-session": token };
    const init = { method, headers, signal: AbortSignal.timeout(30000) };
    if (requestBody !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(requestBody);
    }
    const response = await fetch(api + pathname, {
      ...init,
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    let body = null;
    if ((response.headers.get("content-type") || "").includes("json") && bytes.length) {
      try { body = JSON.parse(bytes.toString("utf8")); } catch (_) { body = null; }
    }
    return { status: response.status, body, bytes };
  }

  try {
    const tag = `retained-auth-${crypto.randomUUID()}`;
    const orgA = (await one("insert into organizations(name,slug) values($1,$1) returning id", [`${tag}-a`])).id;
    const orgB = (await one("insert into organizations(name,slug) values($1,$1) returning id", [`${tag}-b`])).id;

    const adminA = await user("org_admin", orgA, `${tag}-admin-a`);
    const maintenanceA = await user("member", orgA, `${tag}-maintenance-a`);
    const memberBBoth = await user("member", orgA, `${tag}-member-b-both`);
    const memberBMaintenance = await user("member", orgA, `${tag}-member-b-maintenance`);
    const memberBManagement = await user("member", orgA, `${tag}-member-b-management`);
    const memberBLeasing = await user("member", orgA, `${tag}-member-b-leasing`);
    const assetManagerB = await user("member", orgA, `${tag}-asset-manager-b`);
    const outside = await user("org_admin", orgB, `${tag}-outside`);
    const superOutside = await user("super_admin", orgB, `${tag}-super-outside`);
    const expired = await user("member", orgA, `${tag}-expired`);
    const revoked = await user("member", orgA, `${tag}-revoked`);
    const inactiveAssignment = await user("member", orgA, `${tag}-inactive-assignment`);
    const targetAssignedSessionA = await user("member", orgA, `${tag}-target-assigned-session-a`);
    const inactiveTargetSessionA = await user("member", orgA, `${tag}-inactive-target-session-a`);

    const propertyA = (await one(`insert into properties(name,canonical_key,organization_id,leasing_basis)
      values($1,$1,$2,'bed') returning id`, [`${tag}-property-a`, orgA])).id;
    const targetPropertyName = `${tag}-property-b`;
    const propertyB = (await one(`insert into properties(name,canonical_key,organization_id,leasing_basis)
      values($1,$1,$2,'bed') returning id`, [`${tag}-property-b`, orgA])).id;
    const propertyC = (await one(`insert into properties(name,canonical_key,organization_id,leasing_basis)
      values($1,$1,$2,'bed') returning id`, [`${tag}-property-c`, orgB])).id;

    const deal = await deals.createDeal(pool, {
      user_id: adminA.id, deal_name: `${tag}-deal`, creation_source: "deal_setup_console",
    });
    await deals.addProperty(pool, { user_id: adminA.id, deal_intake_id: deal.id, property_id: propertyB });
    const opened = (await activation.openActivation(pool, {
      user_id: adminA.id, deal_intake_id: deal.id, property_id: propertyB,
    })).activation;
    const artifact = await artifacts.store(pool, {
      scope_type: "property", scope_id: propertyB,
      filename: `${tag}-rent-roll.csv`, mimetype: "text/csv", buffer: SOURCE,
      uploaded_by_user_id: adminA.id, source_as_of_date: AS_OF,
    });
    const descriptor = await artifacts.describe(pool, artifact.id);
    assert.equal(descriptor.scope_type, "property");
    assert.equal(String(descriptor.scope_id), String(propertyB));
    assert.equal(descriptor.artifact_kind, "rent_roll");
    const ingested = await activation.ingestRentRoll(pool, {
      user_id: adminA.id, deal_intake_id: deal.id, property_id: propertyB,
      activation_id: opened.id, source_artifact_id: artifact.id, source_as_of_date: AS_OF,
    });
    assert.ok(ingested && ingested.import_batch_id);

    // These are domain-owned retained artifacts for the asset-management
    // read doors. The rent roll above is deliberately the wrong domain for
    // both routes; each positive control uses distinct bytes and kind.
    const utilityArtifact = await artifacts.store(pool, {
      scope_type: "property", scope_id: propertyB,
      filename: `${tag}-utility-statement.pdf`, mimetype: "application/pdf",
      buffer: UTILITY_SOURCE, uploaded_by_user_id: adminA.id,
      authority_basis: "asset_management_module", artifact_kind: "utility_statement",
    });
    const contractedArtifact = await artifacts.store(pool, {
      scope_type: "property", scope_id: propertyB,
      filename: `${tag}-contracted-other.pdf`, mimetype: "application/pdf",
      buffer: CONTRACTED_SOURCE, uploaded_by_user_id: adminA.id,
      authority_basis: "asset_management_module", artifact_kind: "contracted_service_other",
    });
    const utilityDescriptor = await artifacts.describe(pool, utilityArtifact.id);
    const contractedDescriptor = await artifacts.describe(pool, contractedArtifact.id);
    assert.equal(utilityDescriptor.artifact_kind, "utility_statement");
    assert.equal(contractedDescriptor.artifact_kind, "contracted_service_other");

    const adminAToken = await session(adminA.id, propertyA, ["management"]);
    const maintenanceAToken = await session(maintenanceA.id, propertyA, ["maintenance"]);
    const memberBToken = await session(memberBBoth.id, propertyB, ["management", "leasing"]);
    const memberBMaintenanceToken = await session(memberBMaintenance.id, propertyB, ["maintenance"]);
    const memberBManagementToken = await session(memberBManagement.id, propertyB, ["management"]);
    const memberBLeasingToken = await session(memberBLeasing.id, propertyB, ["leasing"]);
    const assetManagerBToken = await session(assetManagerB.id, propertyB, ["asset_management"]);
    const outsideToken = await session(outside.id, propertyC, ["management"]);
    const superOutsideToken = await session(superOutside.id, propertyC, ["management"]);
    const expiredToken = await session(expired.id, propertyA, ["management"], { expires: "-1 minute" });
    const revokedToken = await session(revoked.id, propertyA, ["management"], { revoked: true });
    const inactiveAssignmentToken = await session(inactiveAssignment.id, propertyB, ["management"], { assignmentActive: false });
    const targetAssignedSessionAToken = await session(targetAssignedSessionA.id, propertyA, ["maintenance"]);
    await assignment(targetAssignedSessionA.id, propertyB, ["management"]);
    const inactiveTargetSessionAToken = await session(inactiveTargetSessionA.id, propertyA, ["maintenance"]);
    await assignment(inactiveTargetSessionA.id, propertyB, ["management"], false);

    const actors = [
      { label: "org_admin_same_org_session_A", role: "org_admin", modules: "management", active: true, token: adminAToken, userId: adminA.id, guard: "same_org_admin", expectedTarget: "absent", expectedModules: [] },
      { label: "member_same_org_maintenance_only_session_A", role: "member", modules: "maintenance", active: true, token: maintenanceAToken, userId: maintenanceA.id, guard: "outside_property", expectedTarget: "absent", expectedModules: [] },
      { label: "member_same_org_assigned_B", role: "member", modules: "management+leasing", active: true, token: memberBToken, userId: memberBBoth.id, guard: "target_control", expectedTarget: "live", expectedModules: ["management", "leasing"] },
      { label: "member_assigned_B_maintenance_only", role: "member", modules: "maintenance", active: true, token: memberBMaintenanceToken, userId: memberBMaintenance.id, guard: "irrelevant_module", expectedTarget: "live", expectedModules: ["maintenance"] },
      { label: "member_assigned_B_management_only", role: "member", modules: "management", active: true, token: memberBManagementToken, userId: memberBManagement.id, guard: "target_control", expectedTarget: "live", expectedModules: ["management"] },
      { label: "member_assigned_B_leasing_only", role: "member", modules: "leasing", active: true, token: memberBLeasingToken, userId: memberBLeasing.id, guard: "target_control", expectedTarget: "live", expectedModules: ["leasing"] },
      { label: "org_admin_cross_org", role: "org_admin", modules: "management", active: true, token: outsideToken, userId: outside.id, guard: "cross_org", expectedTarget: "absent", expectedModules: [] },
      { label: "super_admin_cross_org", role: "super_admin", modules: "management", active: true, token: superOutsideToken, userId: superOutside.id, guard: "super_admin", expectedTarget: "absent", expectedModules: [] },
      { label: "member_target_B_management_assignment_session_A", role: "member", modules: "maintenance@A+management@B", active: true, token: targetAssignedSessionAToken, userId: targetAssignedSessionA.id, guard: "target_assignment", expectedTarget: "live", expectedModules: ["management"] },
      { label: "member_target_B_inactive_assignment_session_A", role: "member", modules: "maintenance@A+management@B-inactive", active: true, token: inactiveTargetSessionAToken, userId: inactiveTargetSessionA.id, guard: "inactive_target_assignment", expectedTarget: "inactive", expectedModules: ["management"] },
      { label: "member_expired_session", role: "member", modules: "management", active: false, token: expiredToken, userId: expired.id, guard: "invalid_session", expectedTarget: "absent", expectedModules: [] },
      { label: "member_revoked_session", role: "member", modules: "management", active: false, token: revokedToken, userId: revoked.id, guard: "invalid_session", expectedTarget: "absent", expectedModules: [] },
      { label: "member_inactive_target_assignment", role: "member", modules: "management", active: false, token: inactiveAssignmentToken, userId: inactiveAssignment.id, guard: "inactive_assignment", expectedTarget: "inactive", expectedModules: ["management"] },
    ];

    for (const actor of actors) {
      const metadata = await request(`/deal-setup/activations/${opened.id}`, actor.token);
      const download = await request(`/deal-setup/source/${artifact.id}/download`, actor.token);
      const opening = await request(`/deal-setup/properties/${propertyB}/opening-position`, actor.token);
      const targetAssignment = await one(`select active, allowed_modules
        from property_team_assignments where user_id=$1 and property_id=$2`, [actor.userId, propertyB]);
      const observedTargetModules = targetAssignment && targetAssignment.active
        ? (targetAssignment.allowed_modules || []).join("+") : "none";
      const observedTargetAssignment = Boolean(targetAssignment && targetAssignment.active);
      const observedTargetState = !targetAssignment ? "absent" : targetAssignment.active ? "live" : "inactive";
      const metadataAllowed = metadata.status === 200
        && metadata.body && metadata.body.activation
        && String(metadata.body.activation.property_id) === String(propertyB)
        && metadata.body.source && metadata.body.source.sha256 === descriptor.sha256
        && Number(metadata.body.source.byte_size) === SOURCE.length;
      const bytesAllowed = download.status === 200 && Buffer.compare(download.bytes, SOURCE) === 0;
      const metadataAndBytesAgree = metadataAllowed === bytesAllowed;
      const openingPayload = opening.status === 200 && opening.body && opening.body.established === false
        ? "unestablished" : "unavailable";
      const expectedOpeningStatus = actor.guard === "inactive_assignment" || !actor.active
        ? 401
        : actor.guard === "outside_property" || actor.guard === "irrelevant_module" || actor.guard === "inactive_target_assignment"
          ? (parent ? 200 : 403)
          : actor.guard === "cross_org" ? 403 : 200;

      console.log(`OBS actor=${actor.label}; role=${actor.role}; modules=${actor.modules}; ` +
        `active_session=${actor.active}; activation_status=${metadata.status}; ` +
        `download_status=${download.status}; target_assignment=${observedTargetAssignment}; ` +
        `target_modules=${observedTargetModules}; opening_status=${opening.status}; ` +
        `opening_payload=${openingPayload}; metadata_ok=${metadataAllowed}; bytes_ok=${bytesAllowed}`);
      ok(`${actor.label}: activation metadata and source bytes agree`, metadataAndBytesAgree);
      ok(`${actor.label}: target assignment state is fixture-intended`, observedTargetState === actor.expectedTarget);
      if (observedTargetAssignment) {
        const actualModules = [...(targetAssignment.allowed_modules || [])].sort();
        const expectedModules = [...actor.expectedModules].sort();
        ok(`${actor.label}: live target modules are fixture-intended`,
          JSON.stringify(actualModules) === JSON.stringify(expectedModules));
      }
      ok(`${actor.label}: opening-position status matches the actor boundary`, opening.status === expectedOpeningStatus);
      if (opening.status === 200) {
        ok(`${actor.label}: opening-position fixture truth is explicitly unestablished`, openingPayload === "unestablished");
      }

      if (actor.label === "member_same_org_assigned_B") {
        ok("assigned-B owner control: retained rent-roll metadata and bytes are readable", metadataAllowed && bytesAllowed);
      }
      if (actor.label === "org_admin_same_org_session_A") {
        ok("same-org org-admin global control: retained rent-roll metadata and bytes are readable", metadataAllowed && bytesAllowed);
      }
      if (actor.guard === "target_assignment") {
        ok("live target-B management assignment: valid session-A member remains a positive read control", metadataAllowed && bytesAllowed);
      }
      if (actor.guard === "inactive_target_assignment") {
        const expected = parent ? metadataAllowed && bytesAllowed : metadata.status === 403 && download.status === 403;
        ok(`${actor.label}: ${parent ? "parent records current broad read" : "successor refuses inactive target assignment"}`, expected);
      }
      if (actor.label === "member_assigned_B_management_only" || actor.label === "member_assigned_B_leasing_only") {
        ok(`${actor.label}: relevant module remains a positive read control`, metadataAllowed && bytesAllowed);
      }
      if (actor.label === "member_assigned_B_maintenance_only") {
        const expected = parent ? metadataAllowed && bytesAllowed : metadata.status === 403 && download.status === 403;
        ok(`${actor.label}: ${parent ? "parent records current broad read" : "successor refuses irrelevant module"}`, expected);
      }
      if (actor.label === "member_same_org_maintenance_only_session_A") {
        const expected = parent ? metadataAllowed && bytesAllowed : metadata.status === 403 && download.status === 403;
        ok(`${actor.label}: ${parent ? "parent records current outside-property read" : "successor refuses outside-property member"}`, expected);
      }
      if (actor.label === "org_admin_cross_org") {
        ok("cross-org actor: both existing doors refuse", metadata.status === 403 && download.status === 403);
      }
      if (actor.label === "super_admin_cross_org") {
        ok("cross-org super-admin authority: retained rent-roll metadata and bytes are readable", metadataAllowed && bytesAllowed);
      }
      if (actor.guard === "inactive_assignment") {
        ok("inactive target assignment: session is refused at both doors", metadata.status === 401 && download.status === 401);
      } else if (!actor.active) {
        ok(`${actor.label}: expired or revoked session is refused at both doors`, metadata.status === 401 && download.status === 401);
      }
    }

    // The browser's open action is a second read boundary. Exercise the
    // negative actors against the existing route and verify that a refusal
    // does not create or reopen any activation state.
    const openPath = `/deal-setup/deals/${deal.id}/properties/${propertyB}/activation`;
    for (const label of [
      "member_same_org_maintenance_only_session_A",
      "member_assigned_B_maintenance_only",
      "member_target_B_inactive_assignment_session_A",
    ]) {
      const actor = actors.find((candidate) => candidate.label === label);
      const before = Number((await one(
        "select count(*)::int as n from activations where deal_id=$1 and property_id=$2",
        [deal.id, propertyB])).n);
      const response = await request(openPath, actor.token, { method: "POST", body: {} });
      const after = Number((await one(
        "select count(*)::int as n from activations where deal_id=$1 and property_id=$2",
        [deal.id, propertyB])).n);
      const expectedStatus = parent ? response.status === 200 : response.status === 403;
      ok(`${label}: open activation ${parent ? "records current broad access" : "refuses unauthorized actor"}`, expectedStatus);
      ok(`${label}: open activation leaves activation count unchanged`, after === before);
    }

    // Asset-management evidence has its own domain doors. The existing
    // routes scope by property and module but currently do not filter the
    // retained artifact kind; parent mode records those exact bytes, while
    // successor mode requires a wrong-domain rent roll to look absent.
    const assetEvidenceCases = [
      {
        label: "utilities",
        path: "/operator/asset-management/utilities/evidence/",
        positiveId: utilityArtifact.id,
        positiveBytes: UTILITY_SOURCE,
      },
      {
        label: "contracted_services",
        path: "/operator/asset-management/contracted-services/evidence/",
        positiveId: contractedArtifact.id,
        positiveBytes: CONTRACTED_SOURCE,
      },
    ];
    for (const domain of assetEvidenceCases) {
      const wrongDomain = await request(domain.path + artifact.id, assetManagerBToken);
      const positive = await request(domain.path + domain.positiveId, assetManagerBToken);
      const expectedWrongStatus = parent ? 200 : 404;
      ok(`${domain.label}: asset-management member wrong-domain rent roll status`, wrongDomain.status === expectedWrongStatus);
      if (parent) {
        ok(`${domain.label}: parent wrong-domain read returns exact retained bytes`, Buffer.compare(wrongDomain.bytes, SOURCE) === 0);
      }
      ok(`${domain.label}: asset-management member legitimate artifact status`, positive.status === 200);
      ok(`${domain.label}: legitimate artifact returns exact retained bytes`, positive.status === 200
        && Buffer.compare(positive.bytes, domain.positiveBytes) === 0);
    }

    // Reverse-domain controls: Deal Setup's retained-source door must not
    // become a generic document download for asset-owned evidence.
    const managementActor = actors.find((candidate) => candidate.label === "member_assigned_B_management_only");
    for (const [label, artifactId, bytes] of [
      ["utility_statement", utilityArtifact.id, UTILITY_SOURCE],
      ["contracted_service_other", contractedArtifact.id, CONTRACTED_SOURCE],
    ]) {
      const reverse = await request(`/deal-setup/source/${artifactId}/download`, managementActor.token);
      const expectedStatus = parent ? 200 : 404;
      ok(`Deal Setup reverse-domain ${label} status`, reverse.status === expectedStatus);
      if (parent) ok(`Deal Setup parent reverse-domain ${label} returns exact bytes`, Buffer.compare(reverse.bytes, bytes) === 0);
    }

    if (!parent && failed === 0 && process.env.PROOF_OUTPUT_DIR) {
      const byLabel = Object.fromEntries(actors.map((actor) => [actor.label, actor]));
      const privateState = {
        proof: "source_auth",
        version: 1,
        deal_id: deal.id,
        target_property_id: propertyB,
        target_property_name: targetPropertyName,
        expected_authorized_property_id: propertyB,
        actors: [
          { label: "outside_target", token: byLabel.member_same_org_maintenance_only_session_A.token, expected_open_status: 403 },
          { label: "maintenance_only_target", token: byLabel.member_assigned_B_maintenance_only.token, expected_open_status: 403 },
          { label: "assigned_target_management", token: byLabel.member_assigned_B_management_only.token, expected_open_status: 200 },
          { label: "assigned_target_leasing", token: byLabel.member_assigned_B_leasing_only.token, expected_open_status: 200 },
          { label: "org_admin", token: byLabel.org_admin_same_org_session_A.token, expected_open_status: 200 },
        ],
      };
      const outputDir = path.resolve(process.env.PROOF_OUTPUT_DIR);
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(
        path.join(outputDir, "source-auth-state.private.json"),
        JSON.stringify(privateState, null, 2) + "\n",
        { encoding: "utf8", mode: 0o600 },
      );
      console.log("RETAINED_SOURCE_AUTH_PRIVATE_FIXTURE=written");
    }

    console.log(`RETAINED_SOURCE_AUTH_PASSED=${passed}; FAILED=${failed}`);
    process.exitCode = failed ? 1 : 0;
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  console.error("RETAINED_SOURCE_AUTH_OBSERVATION_FAILED");
  process.exitCode = 1;
});
