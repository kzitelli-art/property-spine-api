#!/usr/bin/env node
"use strict";

/**
 * OVERLAPPING OPERATIVE LEASE — CONTRACT PROOF
 *
 * Runs the REAL executed_lease_service.computeAdmissionBlockers against an
 * in-memory query client. It proves the service:
 *   1) locks the exact spaces row before overlap evaluation;
 *   2) excludes only record.lease_id, never every lease on application_id;
 *   3) blocks a same-application duplicate lease with a different id;
 *   4) does not conflict with the exact post-confirm self lease.
 *
 * Run from repo root:
 *   node executed_lease_overlap_contract.test.js
 */

const Module = require("module");
const path = require("path");
const crypto = require("crypto");

let pass = 0;
let fail = 0;
function ok(name, condition, detail = "") {
  if (condition) {
    pass += 1;
    console.log("  PASS  " + name);
  } else {
    fail += 1;
    console.log("  FAIL  " + name + (detail ? "  → " + detail : ""));
  }
}

// Keep the service's actual normalization dependency shape without requiring
// any other application module in this isolated contract proof.
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "./proposed_terms_service") {
    return {
      normalizeAndHash(input) {
        const canonical = {
          rent: Number(input.rent).toFixed(2),
          security_deposit: Number(input.security_deposit).toFixed(2),
          lease_start_date: String(input.lease_start_date),
          lease_end_date: String(input.lease_end_date),
          concession_status: String(input.concession_status),
        };
        return {
          canonical,
          payload_hash: crypto.createHash("sha256")
            .update(JSON.stringify(canonical)).digest("hex"),
        };
      },
    };
  }
  return originalLoad(request, parent, isMain);
};

const servicePath = path.join(__dirname, "executed_lease_service.js");
const svc = require(servicePath);
Module._load = originalLoad;

const APP_ID = "11111111-1111-4111-8111-111111111111";
const SPACE_ID = "22222222-2222-4222-8222-222222222222";
const UNIT_ID = "33333333-3333-4333-8333-333333333333";
const RECORD_ID = "44444444-4444-4444-8444-444444444444";
const SELF_LEASE_ID = "55555555-5555-4555-8555-555555555555";
const DUPLICATE_LEASE_ID = "66666666-6666-4666-8666-666666666666";
const CONF_ID = "77777777-7777-4777-8777-777777777777";

const canonical = {
  rent: "1850.00",
  security_deposit: "1850.00",
  lease_start_date: "2026-08-01",
  lease_end_date: "2027-07-31",
  concession_status: "none",
};
const payloadHash = crypto.createHash("sha256")
  .update(JSON.stringify(canonical)).digest("hex");

function buildClient({ recordLeaseId = null, leases = [] } = {}) {
  const calls = [];
  const client = {
    calls,
    async query(sql, params = []) {
      const text = String(sql);
      calls.push({ text, params });

      if (/from lease_applications where id=\$1/.test(text)) {
        return { rows: [{
          id: APP_ID,
          property_id: "88888888-8888-4888-8888-888888888888",
          unit_id: UNIT_ID,
          proposed_terms_confirmation_id: CONF_ID,
        }] };
      }
      if (/from executed_lease_records[\s\S]*record_state = 'verified'/.test(text)) {
        return { rows: [{
          id: RECORD_ID,
          application_id: APP_ID,
          record_state: "verified",
          normalization_version: 1,
          payload_hash: payloadHash,
          space_id: SPACE_ID,
          lease_id: recordLeaseId,
          rent: canonical.rent,
          security_deposit: canonical.security_deposit,
          lease_start_date: canonical.lease_start_date,
          lease_end_date: canonical.lease_end_date,
          concession_status: "none",
        }] };
      }
      if (/from lease_packets/.test(text)) {
        return { rows: [{ proposed_terms_confirmation_id: CONF_ID }] };
      }
      if (/from application_proposed_terms_confirmations/.test(text)) {
        return { rows: [{ id: CONF_ID, ...canonical, payload_hash: payloadHash }] };
      }
      if (/select id, unit_id from spaces where id=\$1/.test(text)) {
        return { rows: [{ id: SPACE_ID, unit_id: UNIT_ID }] };
      }
      if (/from leases/.test(text) && /daterange/.test(text)) {
        const excludedId = params[1] || null;
        return {
          rows: leases.filter((lease) =>
            lease.space_id === params[0] && lease.id !== excludedId),
        };
      }
      if (/from lease_economic_schedules/.test(text)) return { rows: [] };
      throw new Error("Unhandled SQL in contract proof: " + text);
    },
  };
  return client;
}

(async () => {
  console.log("\nOVERLAPPING OPERATIVE LEASE — CONTRACT PROOF\n");

  const duplicateSameApplication = {
    id: DUPLICATE_LEASE_ID,
    application_id: APP_ID, // deliberately the SAME application
    space_id: SPACE_ID,
    lease_status: "pending",
    start_date: "2026-09-01",
    end_date: "2027-06-30",
    tenant_ids: [],
  };

  const beforeConfirm = buildClient({
    recordLeaseId: null,
    leases: [duplicateSameApplication],
  });
  const beforeOut = await svc.computeAdmissionBlockers(beforeConfirm, {
    application_id: APP_ID,
  });

  const spaceRead = beforeConfirm.calls.find((c) =>
    /select id, unit_id from spaces where id=\$1/.test(c.text));
  ok("exact spaces row is locked", !!spaceRead && /for update/i.test(spaceRead.text));

  const overlapRead = beforeConfirm.calls.find((c) =>
    /from leases/.test(c.text) && /daterange/.test(c.text));
  ok("overlap SQL excludes an exact lease id", !!overlapRead &&
    /\(\$2::uuid is null or id <> \$2::uuid\)/.test(overlapRead.text));
  ok("overlap SQL does not exclude by application_id", !!overlapRead &&
    !/coalesce\(application_id|application_id::text/.test(overlapRead.text));
  ok("before confirm-term, no lease is excluded", !!overlapRead &&
    overlapRead.params[1] === null);
  ok("same-application duplicate still blocks", beforeOut.blockers.some((b) =>
    b.code === "overlapping_operative_lease" &&
    b.competing.some((c) => c.lease_id === DUPLICATE_LEASE_ID)));

  const exactSelf = {
    ...duplicateSameApplication,
    id: SELF_LEASE_ID,
    lease_status: "active",
  };
  const afterConfirm = buildClient({
    recordLeaseId: SELF_LEASE_ID,
    leases: [exactSelf],
  });
  const afterOut = await svc.computeAdmissionBlockers(afterConfirm, {
    application_id: APP_ID,
  });
  const afterOverlapRead = afterConfirm.calls.find((c) =>
    /from leases/.test(c.text) && /daterange/.test(c.text));
  ok("post-confirm evaluation passes record.lease_id as self exclusion",
    !!afterOverlapRead && afterOverlapRead.params[1] === SELF_LEASE_ID);
  ok("exact self lease does not conflict with itself",
    !afterOut.blockers.some((b) => b.code === "overlapping_operative_lease"));
  ok("sources expose the exact excluded self lease",
    afterOut.sources.overlap_check.excluded_self_lease_id === SELF_LEASE_ID);

  console.log("\n" + "-".repeat(58));
  console.log((fail === 0 ? "ALL PASS" : "FAILURES PRESENT") +
    `   ${pass}/${pass + fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((error) => {
  console.error("contract proof error:", error);
  process.exit(1);
});
