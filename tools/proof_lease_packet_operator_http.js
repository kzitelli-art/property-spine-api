// tools/proofs/proof_lease_packet_operator_http.js
// Deployed HTTP proof for the two staff-session routes.
//
// Required:
//   API_BASE_URL
//   PROOF_APPLICATION_ID
// Optional for positive-path checks:
//   PROOF_STAFF_SESSION
//   PROOF_DRAFT_PACKET_ID
// Optional authority checks:
//   PROOF_NO_LEASING_SESSION
//   PROOF_CROSS_PROPERTY_APPLICATION_ID
//   PROOF_CROSS_PROPERTY_PACKET_ID
//
// This harness does not contain or print credentials.

const crypto = require("crypto");
const base = String(process.env.API_BASE_URL || "").replace(/\/$/, "");
const appId = process.env.PROOF_APPLICATION_ID;
if (!base || !appId) {
  console.error("API_BASE_URL and PROOF_APPLICATION_ID are required.");
  process.exit(2);
}

let pass = 0;
function check(name, condition, detail) {
  if (!condition) throw new Error(`${name}${detail ? " — " + detail : ""}`);
  pass += 1;
  console.log("  ok  " + name);
}
async function post(path, session, body = {}) {
  const headers = { "content-type": "application/json" };
  if (session) headers["x-staff-session"] = session;
  const r = await fetch(base + path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await r.json(); } catch (_) {}
  return { status: r.status, json };
}

(async () => {
  const noSession = await post(
    `/operator/leasing/applications/${encodeURIComponent(appId)}/lease-packet`,
    null
  );
  check("no staff session refused", noSession.status === 401, `got ${noSession.status}`);

  if (process.env.PROOF_NO_LEASING_SESSION) {
    const noModule = await post(
      `/operator/leasing/applications/${encodeURIComponent(appId)}/lease-packet`,
      process.env.PROOF_NO_LEASING_SESSION
    );
    check("no leasing entitlement refused", noModule.status === 403, `got ${noModule.status}`);
  }

  if (process.env.PROOF_STAFF_SESSION && process.env.PROOF_CROSS_PROPERTY_APPLICATION_ID) {
    const crossApp = await post(
      `/operator/leasing/applications/${encodeURIComponent(process.env.PROOF_CROSS_PROPERTY_APPLICATION_ID)}/lease-packet`,
      process.env.PROOF_STAFF_SESSION
    );
    check("cross-property application refused", crossApp.status === 403, `got ${crossApp.status}`);
  }

  if (process.env.PROOF_STAFF_SESSION && process.env.PROOF_CROSS_PROPERTY_PACKET_ID) {
    const crossPacket = await post(
      `/operator/leasing/lease-packets/${encodeURIComponent(process.env.PROOF_CROSS_PROPERTY_PACKET_ID)}/send`,
      process.env.PROOF_STAFF_SESSION,
      { idempotency_key: crypto.randomUUID() }
    );
    check("cross-property packet refused", crossPacket.status === 403, `got ${crossPacket.status}`);
  }

  if (process.env.PROOF_STAFF_SESSION) {
    const generated = await post(
      `/operator/leasing/applications/${encodeURIComponent(appId)}/lease-packet`,
      process.env.PROOF_STAFF_SESSION
    );
    check("operator generate route exists", generated.status !== 404, `got ${generated.status}`);
    check("operator generate succeeds", generated.status === 200, JSON.stringify(generated.json));

    const packetId = process.env.PROOF_DRAFT_PACKET_ID ||
      (generated.json && generated.json.packet && generated.json.packet.id);
    check("generate returns packet id", !!packetId);

    const issued = await post(
      `/operator/leasing/lease-packets/${encodeURIComponent(packetId)}/send`,
      process.env.PROOF_STAFF_SESSION,
      { idempotency_key: crypto.randomUUID() }
    );
    check("operator issue route exists", issued.status !== 404, `got ${issued.status}`);
    check("first issue succeeds", issued.status === 200, JSON.stringify(issued.json));
    check("first issue returns URL", !!(issued.json && issued.json.tenant_url));

    const retry = await post(
      `/operator/leasing/lease-packets/${encodeURIComponent(packetId)}/send`,
      process.env.PROOF_STAFF_SESSION,
      { idempotency_key: crypto.randomUUID() }
    );
    check("issue retry succeeds", retry.status === 200, JSON.stringify(retry.json));
    check(
      "issue retry is idempotent",
      retry.json && retry.json.already_issued === true && retry.json.tenant_url === null,
      JSON.stringify(retry.json)
    );
  }

  console.log(`\nPASS — ${pass} deployed HTTP checks.`);
})().catch((e) => {
  console.error("\nFAIL:", e.stack || e);
  process.exit(1);
});
