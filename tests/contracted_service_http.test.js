"use strict";

const assert = require("assert");
const express = require("express");
const routes = require("../src/asset/contracted_service_routes.js");

let passed = 0;
function ok(label, condition) {
  assert(condition, label); passed += 1; console.log(`  ok    ${label}`);
}

async function main() {
  const calls = { reads: [], writes: [], queries: [], extracted: [] };
  let readFailure = false;
  let failTerm = false;
  const client = {
    async query(sql) { calls.queries.push(String(sql)); return { rows: [] }; },
    release() {},
  };
  const pool = { async connect() { return client; } };
  const position = {
    contract_version: "contracted_service.v1", setup_state: "partially_established",
    opening: { unresolved: [{ concept: "coverage_review" }] },
    standing: { engagement_count: 1 }, detail: { engagements: [] },
  };
  const positionRead = {
    async readPosition(_client, input) {
      calls.reads.push(input);
      if (readFailure) throw new Error("database unavailable");
      return position;
    },
  };
  function writer(name, result) {
    return async (_client, input) => {
      calls.writes.push([name, input]);
      if (name === "recordTerm" && failTerm) {
        const error = new Error("an executed agreement is required");
        error.code = "EXECUTED_GOVERNING_SOURCE_REQUIRED";
        throw error;
      }
      return { id: `${name}-a`, ...result };
    };
  }
  const contractedService = {
    contractedServiceError(code, message) { const error = new Error(message); error.code = code; return error; },
    recordCoverageReview: writer("recordCoverageReview"),
    recordRequirement: writer("recordRequirement"),
    establishProvider: writer("establishProvider", { provider_name: "Provider One" }),
    createEngagement: writer("createEngagement"),
    confirmDocument: writer("confirmDocument"),
    recordTerm: writer("recordTerm"),
    recordScope: writer("recordScope"),
    recordPriceComponent: writer("recordPriceComponent"),
    recordLocation: writer("recordLocation"),
    recordFinancialObservation: writer("recordFinancialObservation"),
    linkDecision: writer("linkDecision"),
    async findProviderCandidates(_client, input) {
      calls.writes.push(["findProviderCandidates", input]);
      return [{ id: "provider-existing", provider_name: input.provider_name }];
    },
  };
  const artifacts = {
    MAX_BYTES: 25 * 1024 * 1024,
    async store(_db, input) {
      return { id: "artifact-uploaded", original_filename: input.filename,
        artifact_kind: input.artifact_kind, deduplicated: false };
    },
    async read(_db, id) {
      if (id === "artifact-a") return { id, scope_type: "property", scope_id: "property-a",
        original_filename: "agreement.pdf", mime_type: "application/pdf", content: Buffer.from("PDF") };
      if (id === "artifact-b") return { id, scope_type: "property", scope_id: "property-b",
        original_filename: "other.pdf", mime_type: "application/pdf", content: Buffer.from("PDF") };
      return null;
    },
  };
  async function fileToText(file) {
    calls.extracted.push(file);
    return "SERVICE AGREEMENT\nProvider: Provider One\nSignature: __________";
  }
  const documentRead = {
    propose(text, kind) { return { available: true, text, kind, authority: "proposal_only" }; },
  };

  function requireOperator(req, res, next) {
    const token = req.get("x-staff-session");
    if (!token) return res.status(401).json({ error: "sign in" });
    req.operator = { id: "operator-a", property_id: "property-a",
      allowed_modules: token === "entitled" ? ["asset_management"] : [] };
    return next();
  }
  function refuseClientAuthority(req, res, next) {
    const claimed = (req.query && req.query.property_id) || (req.body && req.body.property_id);
    if (claimed && claimed !== req.operator.property_id) {
      return res.status(403).json({ error: "server-derived property", acting_on: req.operator.property_id });
    }
    return next();
  }
  function requireAssetManagementModule(req, res, next) {
    return req.operator.allowed_modules.includes("asset_management")
      ? next() : res.status(403).json({ error: "module required" });
  }

  const app = express();
  app.use(express.json());
  app.use(routes({ pool, requireOperator, refuseClientAuthority, requireAssetManagementModule,
    positionRead, contractedService, artifacts, fileToText, documentRead }));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, { token, method = "GET", body } = {}) {
    const headers = {};
    if (token) headers["x-staff-session"] = token;
    if (body) headers["content-type"] = "application/json";
    const response = await fetch(base + path, { method, headers,
      body: body ? JSON.stringify(body) : undefined });
    const type = response.headers.get("content-type") || "";
    return { status: response.status, headers: response.headers,
      body: type.includes("application/json") ? await response.json()
        : Buffer.from(await response.arrayBuffer()) };
  }

  try {
    console.log("\nCONTRACTED SERVICES HTTP - REAL EXPRESS AUTHORITY PROOFS\n");
    const path = "/operator/asset-management/contracted-services";
    ok("unauthenticated reads refuse", (await request(path)).status === 401);
    ok("unentitled reads refuse", (await request(path, { token: "other" })).status === 403);
    ok("refused reads never reach domain truth", calls.reads.length === 0);
    const spoof = await request(`${path}?property_id=property-b`, { token: "entitled" });
    ok("client-selected property scope refuses", spoof.status === 403
      && spoof.body.acting_on === "property-a");
    const valid = await request(path, { token: "entitled" });
    ok("the read uses only the staff session property", valid.status === 200
      && calls.reads[0].property_id === "property-a");
    ok("unresolved truth survives the HTTP envelope", valid.body.opening.unresolved.length === 1);

    const writeSpoof = await request(`${path}/providers`, { token: "entitled", method: "POST",
      body: { property_id: "property-b", provider_name: "Provider One" } });
    ok("writes cannot select another property", writeSpoof.status === 403);
    const write = await request(`${path}/providers`, { token: "entitled", method: "POST",
      body: { provider_name: "Provider One", provenance_note: "Operator confirmed" } });
    const providerWrite = calls.writes.find(([name]) => name === "establishProvider");
    ok("writer actor and property come from the session", write.status === 201
      && providerWrite[1].property_id === "property-a" && providerWrite[1].user_id === "operator-a");

    const confirm = await request(`${path}/confirm`, { token: "entitled", method: "POST", body: {
      source_artifact_id: "artifact-a", provenance_note: "Confirmed against retained agreement",
      requirement: { service_class: "elevator_maintenance",
        determination: "contracted_service_required", effective_from: "2026-01-01" },
      provider: { provider_name: "Fujitec" },
      engagement: { service_class: "elevator_maintenance" },
      document: { document_kind: "agreement", execution_state: "executed" },
      term: { term_authority: "governing", term_kind: "fixed",
        commencement_date: "2026-01-01", initial_end_date: "2026-12-31" },
      scope: { scope_summary: "Quarterly elevator service", effective_from: "2026-01-01" },
      price_components: [{ price_basis: "monthly", amount_cents: 15000 }],
    } });
    ok("one confirmation composes the canonical fact writers", confirm.status === 201
      && ["recordRequirement", "establishProvider", "createEngagement", "confirmDocument",
        "recordTerm", "recordScope", "recordPriceComponent"]
        .every((name) => calls.writes.some(([called]) => called === name)));
    ok("nested facts cannot override session authority", calls.writes
      .filter(([name]) => name !== "findProviderCandidates")
      .every(([, input]) => input.property_id === "property-a" && input.user_id === "operator-a"));
    ok("the composed confirmation commits as one transaction",
      calls.queries.includes("begin") && calls.queries.includes("commit"));

    const impossible = await request(`${path}/confirm`, { token: "entitled", method: "POST", body: {
      provenance_note: "Operator confirmed",
      requirement: { service_class: "building_cleaning", determination: "managed_in_house",
        effective_from: "2026-01-01" },
      provider_id: "provider-existing",
    } });
    ok("in-house truth cannot carry a contractor engagement", impossible.status === 422);

    const start = calls.queries.length;
    failTerm = true;
    const failed = await request(`${path}/confirm`, { token: "entitled", method: "POST", body: {
      source_artifact_id: "artifact-a", provenance_note: "Operator confirmed",
      provider_id: "provider-existing", engagement: { service_class: "building_cleaning" },
      document: { document_kind: "proposal", execution_state: "unsigned" },
      term: { term_authority: "governing", term_kind: "fixed",
        commencement_date: "2026-01-01", initial_end_date: "2026-12-31" },
    } });
    failTerm = false;
    const transaction = calls.queries.slice(start);
    ok("unsigned governing terms return a governed refusal", failed.status === 422);
    ok("a failed confirmation rolls back without commit",
      transaction.includes("rollback") && !transaction.includes("commit"));

    ok("foreign evidence is indistinguishable from missing",
      (await request(`${path}/evidence/artifact-b`, { token: "entitled" })).status === 404);
    const evidence = await request(`${path}/evidence/artifact-a`, { token: "entitled" });
    ok("same-property evidence opens privately", evidence.status === 200
      && evidence.headers.get("cache-control") === "private, no-store");

    const form = new FormData();
    form.append("artifact_kind", "contracted_service_agreement");
    form.append("file", new Blob(["%PDF-1.7"], { type: "application/pdf" }), "service-agreement.pdf");
    const uploadedResponse = await fetch(base + `${path}/evidence`, {
      method: "POST", headers: { "x-staff-session": "entitled" }, body: form,
    });
    const uploaded = await uploadedResponse.json();
    ok("multipart evidence is retained before recognition", uploadedResponse.status === 201
      && uploaded.artifact.id === "artifact-uploaded");
    ok("recognition receives Multer's original filename", calls.extracted.length === 1
      && calls.extracted[0].originalname === "service-agreement.pdf"
      && !Object.prototype.hasOwnProperty.call(calls.extracted[0], "filename"));
    ok("recognition remains proposal-only through the route",
      uploaded.proposal.authority === "proposal_only");

    const candidates = await request(`${path}/provider-candidates?name=Fujitec`, { token: "entitled" });
    ok("provider reuse is a visible candidate, not a silent merge",
      candidates.status === 200 && candidates.body.candidates.length === 1);

    readFailure = true;
    const unavailable = await request(path, { token: "entitled" });
    ok("failed reads return unavailable instead of empty truth", unavailable.status === 503
      && !unavailable.body.opening);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  console.log(`\n${passed} assertions passed\n`);
}

main().catch((error) => { console.error(error); process.exit(1); });
