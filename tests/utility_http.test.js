"use strict";

const assert = require("assert");
const express = require("express");
const utilityRoutes = require("../src/asset/utility_routes.js");

let pass = 0;
function ok(label, condition, detail = "") {
  if (!condition) throw new Error(`${label}${detail ? `: ${detail}` : ""}`);
  pass += 1;
  console.log(`  ok    ${label}`);
}

async function main() {
  const calls = { reads: [], providers: [], queries: [] };
  let readFailure = false;
  const client = {
    async query(sql) { calls.queries.push(String(sql)); return { rows: [] }; },
    release() {},
  };
  const pool = {
    async connect() { return client; },
  };
  const position = {
    contract_version: "utility.v1",
    as_of: "2026-08-13",
    setup_state: "partially_established",
    opening: { setup_state: "partially_established", unresolved: [
      { service: "natural_gas", concept: "applicability", question: "Is natural gas present?" },
    ] },
    standing: { domain: "utility", established_services: 1, services: [] },
    detail: { services: [], accounts: [], meters: [], service_points: [], recent_statements: [] },
  };
  const positionRead = {
    async readPosition(_client, input) {
      calls.reads.push(input);
      if (readFailure) throw new Error("database unavailable");
      return position;
    },
  };
  const utilityService = {
    async establishProvider(_client, input) {
      calls.providers.push(input);
      return { id: "provider-a", property_id: input.property_id, provider_name: input.provider_name };
    },
  };
  const artifacts = {
    MAX_BYTES: 25 * 1024 * 1024,
    async read(_db, id) {
      if (id === "artifact-a") return {
        id, scope_type: "property", scope_id: "property-a",
        original_filename: "statement.pdf", mime_type: "application/pdf",
        content: Buffer.from("%PDF-1.7"),
      };
      if (id === "artifact-b") return {
        id, scope_type: "property", scope_id: "property-b",
        original_filename: "other.pdf", mime_type: "application/pdf",
        content: Buffer.from("%PDF-1.7"),
      };
      return null;
    },
    async store() { throw new Error("not used in this proof"); },
  };

  function requireOperator(req, res, next) {
    const token = req.get("x-staff-session");
    if (!token) return res.status(401).json({ error: "sign in" });
    req.operator = {
      id: "operator-a", property_id: "property-a",
      allowed_modules: token === "entitled" ? ["asset_management"] : [],
    };
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
    if (!req.operator.allowed_modules.includes("asset_management")) {
      return res.status(403).json({ error: "module required" });
    }
    return next();
  }

  const app = express();
  app.use(express.json());
  app.use(utilityRoutes({
    pool, requireOperator, refuseClientAuthority, requireAssetManagementModule,
    positionRead, utilityService, artifacts,
  }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, { token, method = "GET", body } = {}) {
    const headers = {};
    if (token) headers["x-staff-session"] = token;
    if (body) headers["content-type"] = "application/json";
    const response = await fetch(base + path, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    const type = response.headers.get("content-type") || "";
    const result = type.includes("application/json")
      ? await response.json() : Buffer.from(await response.arrayBuffer());
    return { status: response.status, body: result, headers: response.headers };
  }

  try {
    console.log("\nUTILITY HTTP - REAL EXPRESS AUTHORITY PROOFS\n");
    const path = "/operator/asset-management/utilities";

    ok("unauthenticated Utility read refuses", (await request(path)).status === 401);
    ok("unentitled Utility read refuses", (await request(path, { token: "not-entitled" })).status === 403);
    ok("an unentitled request never reaches Utility truth", calls.reads.length === 0);

    const spoof = await request(`${path}?property_id=property-b`, { token: "entitled" });
    ok("client-selected cross-property scope refuses", spoof.status === 403);
    ok("the refusal names the property actually in authority", spoof.body.acting_on === "property-a");

    const valid = await request(path, { token: "entitled" });
    ok("an entitled operator receives the Utility position", valid.status === 200);
    ok("the route supplies only the session property to the governed read",
      calls.reads.length === 1 && calls.reads[0].property_id === "property-a");
    ok("NOT_ESTABLISHED setup gaps survive the HTTP envelope",
      valid.body.opening.unresolved[0].service === "natural_gas");

    const writeSpoof = await request(`${path}/providers`, {
      token: "entitled", method: "POST",
      body: { property_id: "property-b", provider_name: "PECO", provenance_note: "confirmed" },
    });
    ok("a write cannot select another property", writeSpoof.status === 403);
    ok("a refused cross-property write never reaches the writer", calls.providers.length === 0);

    const write = await request(`${path}/providers`, {
      token: "entitled", method: "POST",
      body: { provider_name: "PECO", provenance_note: "operator confirmed" },
    });
    ok("a valid provider confirmation reaches the canonical writer", write.status === 201);
    ok("writer authority is server-derived actor and property",
      calls.providers[0].property_id === "property-a"
        && calls.providers[0].user_id === "operator-a");

    const foreignEvidence = await request(`${path}/evidence/artifact-b`, { token: "entitled" });
    ok("cross-property Utility evidence is indistinguishable from missing", foreignEvidence.status === 404);
    const ownEvidence = await request(`${path}/evidence/artifact-a`, { token: "entitled" });
    ok("same-property retained evidence is openable", ownEvidence.status === 200);
    ok("evidence responses are private and not cached",
      ownEvidence.headers.get("cache-control") === "private, no-store");

    readFailure = true;
    const failed = await request(path, { token: "entitled" });
    ok("a failed Utility read is visible as unavailable, never empty truth", failed.status === 503);
    ok("the failed read does not return an opening or detail payload",
      !(failed.body.opening || failed.body.detail));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log(`\n${pass} assertions passed\n`);
}

main().catch((error) => { console.error(error); process.exit(1); });
