#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { transferOperationsLine } = require("../src/comms/communication_lines");

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

function operationsLine(overrides = {}) {
  return {
    id: "source-line",
    e164: "+15413058509",
    line_type: "operations",
    property_id: null,
    organization_id: "source-org",
    authority_ceiling: "operational",
    permitted_audience: "staff",
    inbound_enabled: true,
    outbound_enabled: true,
    outbound_policy: "reply_only",
    status: "active",
    notes: "original activation",
    created_at: "2026-08-07T00:00:00Z",
    superseded_at: null,
    ...overrides,
  };
}

function fixture(overrides = {}) {
  const state = {
    actor: { id: "actor-1", platform_role: "super_admin", status: "active" },
    organizations: {
      "target-org": { id: "target-org", name: "OneFive Management", status: "active", has_property: true },
      "source-org": { id: "source-org", name: "Demo ORG", status: "active", has_property: true },
    },
    lines: [operationsLine()],
    committed: 0,
    rolledBack: 0,
    released: 0,
    ...overrides,
  };

  const client = {
    async query(sql, params = []) {
      const compact = String(sql).replace(/\s+/g, " ").trim();
      if (compact === "begin") return { rows: [] };
      if (compact === "commit") { state.committed += 1; return { rows: [] }; }
      if (compact === "rollback") { state.rolledBack += 1; return { rows: [] }; }
      if (compact.includes("from users where id = $1 for share")) {
        return { rows: state.actor && state.actor.id === params[0] ? [state.actor] : [] };
      }
      if (compact.includes("from organizations o") && compact.includes("for update")) {
        const organization = state.organizations[params[0]];
        return { rows: organization ? [organization] : [] };
      }
      if (compact.includes("from communication_lines")
          && compact.includes("where id = $1") && compact.includes("for update")) {
        return { rows: state.lines.filter((line) => line.id === params[0]) };
      }
      if (compact.includes("where e164 = $1 and status = $2")) {
        return { rows: state.lines.filter((line) =>
          line.e164 === params[0] && line.status === params[1]) };
      }
      if (compact.includes("where organization_id = $1")
          && compact.includes("line_type = 'operations'")) {
        return { rows: state.lines.filter((line) =>
          line.organization_id === params[0]
          && line.line_type === "operations"
          && line.status === params[1]) };
      }
      if (compact.startsWith("update communication_lines")) {
        const line = state.lines.find((candidate) =>
          candidate.id === params[0] && candidate.status === params[2]);
        if (!line) return { rows: [], rowCount: 0 };
        line.status = "retired";
        line.superseded_at = "2026-08-22T12:00:00Z";
        line.notes = `${line.notes}\n${params[1]}`;
        return { rows: [{ id: line.id, status: line.status, superseded_at: line.superseded_at }], rowCount: 1 };
      }
      if (compact.startsWith("insert into communication_lines")) {
        const line = operationsLine({
          id: `line-${state.lines.length + 1}`,
          e164: params[0],
          organization_id: params[1],
          notes: params[2],
          created_at: "2026-08-22T12:00:01Z",
        });
        state.lines.push(line);
        return { rows: [line], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${compact}`);
    },
    release() { state.released += 1; },
  };
  return { state, pool: { async connect() { return client; } } };
}

async function refused(promise, status, reason) {
  let error = null;
  try { await promise; } catch (caught) { error = caught; }
  assert.ok(error, `expected ${reason} refusal`);
  assert.equal(error.httpStatus, status);
  assert.equal(error.refusalReason, reason);
}

(async () => {
  await test("one transaction retires the source and activates the same number for the target", async () => {
    const { pool, state } = fixture();
    const out = await transferOperationsLine(pool, {
      sourceLineId: "source-line",
      targetOrganizationId: "target-org",
      actorUserId: "actor-1",
    });
    const source = state.lines.find((line) => line.id === "source-line");
    const target = state.lines.find((line) => line.id === out.line.id);
    assert.equal(out.already, false);
    assert.equal(out.retiredLineId, source.id);
    assert.equal(source.status, "retired");
    assert.ok(source.superseded_at);
    assert.match(source.notes, /actor-1.*target-org.*source-line/);
    assert.equal(target.e164, source.e164);
    assert.equal(target.organization_id, "target-org");
    assert.equal(target.status, "active");
    assert.equal(target.outbound_policy, "reply_only");
    assert.equal(state.committed, 1);
    assert.equal(state.released, 1);
  });

  await test("retrying the completed transfer returns the current target line", async () => {
    const { pool, state } = fixture();
    const first = await transferOperationsLine(pool, {
      sourceLineId: "source-line", targetOrganizationId: "target-org", actorUserId: "actor-1",
    });
    const second = await transferOperationsLine(pool, {
      sourceLineId: "source-line", targetOrganizationId: "target-org", actorUserId: "actor-1",
    });
    assert.equal(second.already, true);
    assert.equal(second.line.id, first.line.id);
    assert.equal(state.lines.length, 2);
  });

  await test("an existing target line refuses the transfer without retiring the source", async () => {
    const source = operationsLine();
    const target = operationsLine({
      id: "target-line", e164: "+12155550100", organization_id: "target-org",
    });
    const { pool, state } = fixture({ lines: [source, target] });
    await refused(transferOperationsLine(pool, {
      sourceLineId: source.id, targetOrganizationId: "target-org", actorUserId: "actor-1",
    }), 409, "target_operations_line_already_active");
    assert.equal(source.status, "active");
    assert.equal(state.lines.length, 2);
  });

  await test("a property-facing line can never be transferred through the staff command", async () => {
    const source = operationsLine({
      line_type: "property_facing", organization_id: null, property_id: "property-1",
      authority_ceiling: "external", permitted_audience: "residents_and_prospects",
    });
    const { pool } = fixture({ lines: [source] });
    await refused(transferOperationsLine(pool, {
      sourceLineId: source.id, targetOrganizationId: "target-org", actorUserId: "actor-1",
    }), 409, "source_line_not_operations");
    assert.equal(source.status, "active");
  });

  await test("the HTTP transfer derives target organization and actor from the route", async () => {
    const root = path.join(__dirname, "..");
    const admin = fs.readFileSync(path.join(root, "src", "identity", "super_admin.js"), "utf8");
    const start = admin.indexOf('router.post("/admin/organizations/:id/operations-line/transfer"');
    const route = admin.slice(start, admin.indexOf("// ── PATCH /admin/organizations/:id", start));
    assert.ok(start > 0);
    assert.match(route, /requireSuperAdmin/);
    assert.match(route, /transferOperationsLine/);
    assert.match(route, /targetOrganizationId:\s*req\.params\.id/);
    assert.match(route, /actorUserId:\s*req\.operator\.id/);
    assert.match(route, /source_line_id/);
    assert.doesNotMatch(route, /targetOrganizationId:\s*req\.body|actorUserId:\s*req\.body/);
  });

  console.log(`\n${passed} passed, ${process.exitCode ? 1 : 0} failed`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
