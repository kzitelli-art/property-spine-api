#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const express = require("express");
const receipt = require("./_run_receipt.js");

const signature = require("../src/meeting_evidence/read_ai_signature.js");
const payload = require("../src/meeting_evidence/read_ai_payload.js");
const routes = require("../src/meeting_evidence/meeting_evidence_routes.js");
const service = require("../src/meeting_evidence/meeting_evidence_service.js");

const EXPECTED = 54;
let passed = 0;
let failed = 0;

function ok(label, condition, detail) {
  if (condition) {
    passed++;
    console.log("  ok    " + label);
  } else {
    failed++;
    console.log("  FAIL  " + label + (detail ? "\n          " + detail : ""));
  }
}

function eq(label, actual, expected) {
  ok(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function hmac(raw, keyBase64) {
  return crypto.createHmac("sha256", Buffer.from(keyBase64, "base64")).update(raw).digest("hex");
}

function request(port, method, route, { raw, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: route, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buffer = Buffer.concat(chunks);
        let body = null;
        try { body = JSON.parse(buffer.toString("utf8")); } catch (_) {}
        resolve({ status: res.statusCode, body, buffer });
      });
    });
    req.on("error", reject);
    if (raw) req.write(raw);
    req.end();
  });
}

function uuid(n) {
  return "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
}

function makeFakeDb(connectionId) {
  const state = {
    connections: [{
      id: connectionId,
      provider: "read_ai",
      authorized_by_user_id: uuid(101),
      authorized_at: new Date().toISOString(),
      connection_status: "active",
    }],
    security: [],
    deliveries: [],
    meetings: [],
    bindings: [],
    next: 200,
  };

  function insertDelivery(params) {
    const row = {
      id: uuid(state.next++),
      provider: params[0],
      connection_id: params[1],
      related_delivery_id: params[2],
      provider_request_id: params[3],
      provider_session_id: params[4],
      payload_sha256: params[5],
      byte_length: params[6],
      raw_body: params[7],
      signature_header: params[8],
      delivery_state: params[9],
      provider_payload_metadata: params[10],
      received_at: new Date().toISOString(),
    };
    state.deliveries.push(row);
    return row;
  }

  async function query(sql, params = []) {
    const q = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (["begin", "commit", "rollback"].includes(q)) return { rows: [] };
    if (q.includes("from integration_connections")) {
      return { rows: state.connections.filter((c) =>
        c.id === params[0] && c.provider === params[1] && c.connection_status === "active") };
    }
    if (q.startsWith("insert into meeting_webhook_security_receipts")) {
      state.security.push({
        provider: params[0],
        connection_id: params[1],
        body_sha256: params[2],
        byte_length: params[3],
        refusal_status: params[4],
        request_ip: params[5],
        detail: params[6],
      });
      return { rows: [] };
    }
    if (q.includes("from meeting_provider_deliveries d") && q.includes("d.provider_request_id = $2")) {
      const row = state.deliveries.find((d) =>
        d.connection_id === params[0] && d.provider_request_id === params[1] && !d.related_delivery_id);
      if (!row) return { rows: [] };
      const meeting = state.meetings.find((m) =>
        m.connection_id === row.connection_id && m.provider === row.provider &&
        m.provider_session_id === row.provider_session_id);
      return { rows: [{ ...row, provider_meeting_id: meeting ? meeting.id : null }] };
    }
    if (q.includes("from meeting_provider_deliveries d") && q.includes("d.provider_request_id is null")) {
      const row = state.deliveries.find((d) =>
        d.connection_id === params[0] && !d.provider_request_id &&
        d.payload_sha256 === params[1] && !d.related_delivery_id);
      return { rows: row ? [{ ...row, provider_meeting_id: null }] : [] };
    }
    if (q.startsWith("insert into meeting_provider_deliveries")) {
      const row = insertDelivery(params);
      return { rows: [row] };
    }
    if (q.startsWith("insert into meeting_provider_meetings")) {
      const existing = state.meetings.find((m) =>
        m.connection_id === params[1] && m.provider === params[0] &&
        m.provider_session_id === params[2]);
      if (existing) return { rows: [] };
      const row = {
        id: uuid(state.next++),
        provider: params[0],
        connection_id: params[1],
        provider_session_id: params[2],
        first_delivery_id: params[3],
        first_observed_at: new Date().toISOString(),
        provider_title: params[4],
        provider_started_at_text: params[5],
        provider_ended_at_text: params[6],
        provider_metadata: params[7],
      };
      state.meetings.push(row);
      return { rows: [row] };
    }
    if (q.includes("from meeting_provider_meetings") && q.includes("where connection_id = $1")) {
      const row = state.meetings.find((m) =>
        m.connection_id === params[0] && m.provider === params[1] &&
        m.provider_session_id === params[2]);
      return { rows: row ? [row] : [] };
    }
    if (q.includes("from meeting_provider_meetings") && q.includes("where id = $1")) {
      const row = state.meetings.find((m) => m.id === params[0]);
      return { rows: row ? [row] : [] };
    }
    if (q.startsWith("insert into meeting_property_bindings")) {
      const existing = state.bindings.find((b) =>
        b.provider_meeting_id === params[0] && b.property_id === params[1]);
      if (existing) return { rows: [] };
      const row = {
        id: uuid(state.next++),
        provider_meeting_id: params[0],
        property_id: params[1],
        bound_by_user_id: params[2],
        binding_basis: params[3],
        bound_at: new Date().toISOString(),
      };
      state.bindings.push(row);
      return { rows: [row] };
    }
    if (q.includes("from meeting_property_bindings")) {
      const row = state.bindings.find((b) =>
        b.provider_meeting_id === params[0] && b.property_id === params[1]);
      return { rows: row ? [row] : [] };
    }
    throw new Error("fake db does not recognise SQL: " + q.slice(0, 180));
  }

  const client = { query, release() {} };
  return {
    state,
    async query(sql, params) { return query(sql, params); },
    async connect() { return client; },
  };
}

(async () => {
  receipt.begin(__filename, { expected: EXPECTED });

  const keyBase64 = Buffer.from("read-ai-test-secret").toString("base64");
  const raw = Buffer.from('{\n  "request_id": "req-1",\n  "session_id": "sess-1"\n}');
  const compact = Buffer.from(JSON.stringify(JSON.parse(raw.toString("utf8"))));
  const valid = hmac(raw, keyBase64);
  const compactDigest = hmac(compact, keyBase64);

  const verified = signature.verifyReadSignature({
    rawBody: raw,
    signatureHeader: valid,
    signingKeyBase64: keyBase64,
  });
  ok("valid HMAC over exact raw bytes verifies", verified.ok === true);
  eq("Read digest is hex HMAC-SHA256", signature.readAiDigestHex(raw, keyBase64), valid);
  ok("canonical JSON digest differs from provider raw-byte digest", compactDigest !== valid);
  ok("signature over reserialized JSON is refused against original bytes",
    signature.verifyReadSignature({
      rawBody: raw,
      signatureHeader: compactDigest,
      signingKeyBase64: keyBase64,
    }).ok === false);
  eq("missing signature is classified distinctly",
    signature.verifyReadSignature({ rawBody: raw, signingKeyBase64: keyBase64 }).reason,
    "missing_signature");
  ok("timing-safe comparison rejects non-hex headers",
    signature.timingSafeHexEqual("sha256=" + valid, valid) === false);

  const parsed = payload.parseVerifiedReadPayload(raw);
  ok("verified payload parser reads JSON after signature", parsed.ok === true);
  eq("request_id is read from provider field only", payload.readReadIdentity(parsed.payload).request_id, "req-1");
  eq("session_id is read from provider field only", payload.readReadIdentity(parsed.payload).session_id, "sess-1");
  ok("malformed JSON is retained-state material, not a parser crash",
    payload.parseVerifiedReadPayload(Buffer.from("{")).ok === false);
  const withDerived = payload.readProviderMetadata({
    request_id: "req-2",
    session_id: "sess-2",
    title: "Weekly Operations Review",
    summary: "Read summary",
    action_items: [],
    key_questions: [],
    topics: [],
    chapters: [],
  });
  eq("provider title is observed as metadata, not property authority",
    withDerived.provider_title, "Weekly Operations Review");
  ok("Read summary is only observed as provider metadata",
    withDerived.metadata.has_summary === true);
  ok("Read action_items are only observed as provider metadata",
    withDerived.metadata.has_action_items === true);
  ok("Read key_questions are only observed as provider metadata",
    withDerived.metadata.has_key_questions === true);
  ok("Read topics are only observed as provider metadata",
    withDerived.metadata.has_topics === true);

  const root = path.join(__dirname, "..");
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const migration = fs.readFileSync(path.join(root, "migrations/175_meeting_evidence_provider_inbox.sql"), "utf8");
  const serviceSrc = fs.readFileSync(path.join(root, "src/meeting_evidence/meeting_evidence_service.js"), "utf8");
  const routeSrc = fs.readFileSync(path.join(root, "src/meeting_evidence/meeting_evidence_routes.js"), "utf8");

  ok("server mounts Read webhook before global JSON parser",
    server.indexOf('readAiWebhook({ pool })') > -1 &&
    server.indexOf('readAiWebhook({ pool })') < server.indexOf('app.use(express.json({ limit: "1mb" })'));
  ok("server mounts governed Meeting Evidence operator routes",
    server.includes("meetingEvidenceModule.operatorRoutes({ pool, anthropic })"));
  ok("provider inbox migration uses BYTEA for exact raw bytes", /raw_body\s+bytea\s+not null/i.test(migration));
  ok("provider inbox stores SHA-256", /payload_sha256/i.test(migration));
  ok("provider inbox stores byte length", /byte_length/i.test(migration));
  ok("provider inbox separates deliveries from provider meetings",
    migration.includes("meeting_provider_deliveries") && migration.includes("meeting_provider_meetings"));
  ok("property evidence is created only by explicit binding table",
    migration.includes("meeting_property_bindings"));
  ok("security refusals stay outside provider delivery evidence",
    migration.includes("meeting_webhook_security_receipts"));
  ok("evidence rows are append-only by database trigger",
    migration.includes("meeting_evidence_append_only_refusal"));
  ok("migration does not weaken source_artifacts",
    !/alter\s+table\s+source_artifacts/i.test(migration));
  ok("service does not call Anthropic", !/anthropic/i.test(serviceSrc));
  ok("service does not import Ask Spine", !/ask_spine/i.test(serviceSrc));
  ok("service has no transcript search surface", !/vector|embedding|rag|search 52 transcripts/i.test(serviceSrc));
  ok("service does not write canonical operating domains",
    !/insert\s+into\s+(obligations|work_orders|leases|property_governed_charges|capital_stack_positions)/i.test(serviceSrc));
  ok("routes resolve staff session for binding/read disclosure",
    routeSrc.includes("resolveStaffSession"));
  ok("routes refuse client property authority",
    routeSrc.includes("property authority is server-derived"));

  let captured = null;
  let called = 0;
  const app = express();
  app.use("/integrations/read-ai/webhook", routes.readAiWebhook({
    pool: {},
    serviceOverride: {
      async receiveReadWebhook(_pool, input) {
        called++;
        captured = input.rawBody;
        return { httpStatus: 202, body: { ok: true, status: "captured" } };
      },
    },
  }));
  app.use("/integrations/read-ai/webhook", routes.readAiWebhookErrorHandler({ pool: {} }));
  app.use(express.json({ limit: "1mb" }));
  const listening = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = listening.address().port;
  const r = await request(port, "POST", "/integrations/read-ai/webhook", {
    raw,
    headers: {
      "content-type": "application/json",
      "content-length": String(raw.length),
      "X-Read-Signature": valid,
    },
  });
  eq("real route returns service status", r.status, 202);
  eq("real route invokes webhook service once", called, 1);
  ok("real route hands service a Buffer", Buffer.isBuffer(captured));
  eq("real route preserves exact raw-body bytes", captured.toString("utf8"), raw.toString("utf8"));

  const tooLarge = Buffer.alloc(service.RAW_BODY_LIMIT_BYTES + 1, 0x61);
  const r2 = await request(port, "POST", "/integrations/read-ai/webhook", {
    raw: tooLarge,
    headers: {
      "content-type": "application/json",
      "content-length": String(tooLarge.length),
      "X-Read-Signature": hmac(tooLarge, keyBase64),
    },
  });
  eq("route-specific raw parser refuses oversize Read payload", r2.status, 413);
  eq("oversize refusal is named", r2.body.status, "refused_body_too_large");
  await new Promise((resolve) => listening.close(resolve));

  const connectionId = uuid(1);
  const fakeDb = makeFakeDb(connectionId);
  const env = {
    READ_AI_CONNECTION_ID: connectionId,
    READ_AI_WEBHOOK_SIGNING_KEY: keyBase64,
  };
  function signedObject(obj) {
    const body = Buffer.from(JSON.stringify(obj));
    return { body, sig: hmac(body, keyBase64) };
  }
  const first = signedObject({
    request_id: "req-live-1",
    session_id: "sess-live-1",
    title: "Weekly Operations Review",
  });
  const firstReceipt = await service.receiveReadWebhook(fakeDb, {
    rawBody: first.body,
    signatureHeader: first.sig,
    env,
  });
  eq("service accepts a valid signed Read delivery", firstReceipt.httpStatus, 202);
  eq("service classifies normal signed delivery as processed_unbound",
    firstReceipt.body.status, "processed_unbound");
  eq("service creates one logical provider delivery", fakeDb.state.deliveries.length, 1);
  eq("service creates one provider meeting from session_id", fakeDb.state.meetings.length, 1);

  const invalidReceipt = await service.receiveReadWebhook(fakeDb, {
    rawBody: first.body,
    signatureHeader: "0".repeat(64),
    env,
  });
  eq("service refuses invalid signature", invalidReceipt.body.status, "refused_invalid_signature");
  eq("invalid signature creates only a security receipt", fakeDb.state.security.length, 1);

  const dup = await service.receiveReadWebhook(fakeDb, {
    rawBody: first.body,
    signatureHeader: first.sig,
    env,
  });
  eq("same request_id and same hash is duplicate_delivery", dup.body.status, "duplicate_delivery");
  eq("duplicate does not create another provider meeting", fakeDb.state.meetings.length, 1);

  const secondDelivery = signedObject({
    request_id: "req-live-2",
    session_id: "sess-live-1",
    title: "Weekly Operations Review",
  });
  const sameMeeting = await service.receiveReadWebhook(fakeDb, {
    rawBody: secondDelivery.body,
    signatureHeader: secondDelivery.sig,
    env,
  });
  eq("different request_id and same session_id is another delivery",
    sameMeeting.body.status, "processed_unbound");
  eq("different request_id and same session_id reuses provider meeting",
    sameMeeting.body.provider_meeting_id, firstReceipt.body.provider_meeting_id);
  eq("same provider session still has one provider meeting", fakeDb.state.meetings.length, 1);

  const changed = signedObject({
    request_id: "req-live-1",
    session_id: "sess-live-1",
    title: "Weekly Operations Review - revised",
  });
  const anomaly = await service.receiveReadWebhook(fakeDb, {
    rawBody: changed.body,
    signatureHeader: changed.sig,
    env,
  });
  eq("same request_id and different hash is provider_anomaly", anomaly.body.status, "provider_anomaly");
  ok("provider anomaly preserves an authenticated body row",
    fakeDb.state.deliveries.some((d) => d.delivery_state === "provider_anomaly" && Buffer.isBuffer(d.raw_body)));

  const malformed = Buffer.from("{");
  const malformedReceipt = await service.receiveReadWebhook(fakeDb, {
    rawBody: malformed,
    signatureHeader: hmac(malformed, keyBase64),
    env,
  });
  eq("authentic malformed JSON is retained as verified_invalid_payload",
    malformedReceipt.body.status, "verified_invalid_payload");

  const unresolved = signedObject({ request_id: "req-no-session" });
  const unresolvedReceipt = await service.receiveReadWebhook(fakeDb, {
    rawBody: unresolved.body,
    signatureHeader: unresolved.sig,
    env,
  });
  eq("authentic payload without session_id is unresolved identity",
    unresolvedReceipt.body.status, "verified_unresolved_identity");

  const binding = await service.bindProviderMeeting(fakeDb, {
    providerMeetingId: firstReceipt.body.provider_meeting_id,
    propertyId: uuid(2),
    boundByUserId: uuid(3),
  });
  eq("manual binding records provider meeting", binding.provider_meeting_id, firstReceipt.body.provider_meeting_id);
  eq("manual binding records target property", binding.property_id, uuid(2));

  process.exit(receipt.complete({
    harness: __filename,
    passed,
    failed,
    expectedAtLeast: EXPECTED,
  }));
})().catch((err) => {
  receipt.died(__filename, err, passed + failed);
  process.exit(1);
});
