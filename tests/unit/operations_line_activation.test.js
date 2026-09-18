#!/usr/bin/env node
"use strict";

const assert = require("assert");
const {
  activateOperationsLine,
  readOperationsLineForOrganization,
} = require("../../src/comms/communication_lines");

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

function fixture(overrides = {}) {
  const state = {
    actor: { id: "actor-1", platform_role: "super_admin", status: "active" },
    organization: { id: "org-1", name: "OneFive Management", status: "active", has_property: true },
    lines: [],
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
        return { rows: state.organization && state.organization.id === params[0]
          ? [state.organization] : [] };
      }
      if (compact.includes("where organization_id = $1") && compact.includes("line_type = 'operations'")) {
        return { rows: state.lines.filter((line) => line.organization_id === params[0]
          && line.line_type === "operations" && line.status === "active") };
      }
      if (compact.includes("where e164 = $1 and status = $2")) {
        return { rows: state.lines.filter((line) => line.e164 === params[0]
          && line.status === params[1]) };
      }
      if (compact.startsWith("insert into communication_lines")) {
        const line = {
          id: `line-${state.lines.length + 1}`,
          e164: params[0],
          line_type: "operations",
          property_id: null,
          organization_id: params[1],
          authority_ceiling: "operational",
          permitted_audience: "staff",
          inbound_enabled: true,
          outbound_enabled: true,
          outbound_policy: "reply_only",
          status: "active",
          created_at: "2026-08-22T00:00:00Z",
          notes: params[2],
        };
        state.lines.push(line);
        return { rows: [line] };
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
  await test("invalid numbers fail before a transaction", async () => {
    const { pool, state } = fixture();
    await refused(activateOperationsLine(pool, {
      organizationId: "org-1", phoneNumber: "not a phone", actorUserId: "actor-1",
    }), 400, "invalid_staff_line");
    assert.equal(state.released, 0);
  });

  await test("the command re-checks live super-admin standing", async () => {
    const { pool, state } = fixture({ actor: { id: "actor-1", platform_role: "member", status: "active" } });
    await refused(activateOperationsLine(pool, {
      organizationId: "org-1", phoneNumber: "215-555-0100", actorUserId: "actor-1",
    }), 403, "super_admin_required");
    assert.equal(state.lines.length, 0);
    assert.ok(state.rolledBack >= 1);
  });

  await test("an organization needs a property before it gets a staff line", async () => {
    const { pool, state } = fixture({ organization: {
      id: "org-1", name: "OneFive Management", status: "active", has_property: false,
    } });
    await refused(activateOperationsLine(pool, {
      organizationId: "org-1", phoneNumber: "215-555-0100", actorUserId: "actor-1",
    }), 409, "organization_has_no_property");
    assert.equal(state.lines.length, 0);
  });

  await test("first activation writes the one fixed safe posture", async () => {
    const { pool, state } = fixture();
    const out = await activateOperationsLine(pool, {
      organizationId: "org-1", phoneNumber: "(215) 555-0100", actorUserId: "actor-1",
    });
    assert.equal(out.already, false);
    assert.equal(out.line.e164, "+12155550100");
    assert.equal(out.line.line_type, "operations");
    assert.equal(out.line.authority_ceiling, "operational");
    assert.equal(out.line.permitted_audience, "staff");
    assert.equal(out.line.outbound_policy, "reply_only");
    assert.equal(out.line.outbound_enabled, true);
    assert.match(out.line.notes, /actor-1/);
    assert.equal(state.committed, 1);
    assert.equal(state.released, 1);
  });

  await test("the same activation is idempotent", async () => {
    const existing = { id: "line-1", e164: "+12155550100", line_type: "operations",
      organization_id: "org-1", status: "active", outbound_policy: "reply_only" };
    const { pool, state } = fixture({ lines: [existing] });
    const out = await activateOperationsLine(pool, {
      organizationId: "org-1", phoneNumber: "2155550100", actorUserId: "actor-1",
    });
    assert.equal(out.already, true);
    assert.equal(out.line.id, "line-1");
    assert.equal(state.lines.length, 1);
    assert.equal(state.committed, 0);
  });

  await test("replacement is refused by the activation command", async () => {
    const { pool, state } = fixture({ lines: [{ id: "line-1", e164: "+12155550101",
      line_type: "operations", organization_id: "org-1", status: "active" }] });
    await refused(activateOperationsLine(pool, {
      organizationId: "org-1", phoneNumber: "2155550100", actorUserId: "actor-1",
    }), 409, "operations_line_already_active");
    assert.equal(state.lines.length, 1);
  });

  await test("a resident-line collision is refused", async () => {
    const { pool, state } = fixture({ lines: [{ id: "resident-line", e164: "+12155550100",
      line_type: "property_facing", property_id: "property-1", organization_id: null,
      status: "active" }] });
    await refused(activateOperationsLine(pool, {
      organizationId: "org-1", phoneNumber: "2155550100", actorUserId: "actor-1",
    }), 409, "phone_number_already_active");
    assert.equal(state.lines.length, 1);
  });

  await test("the organization display read refuses to choose among multiple lines", async () => {
    const lines = [
      { id: "line-1", organization_id: "org-1" },
      { id: "line-2", organization_id: "org-1" },
    ];
    const out = await readOperationsLineForOrganization({
      async query(sql, params) {
        assert.match(sql, /line_type = 'operations'/);
        assert.deepEqual(params, ["org-1", "active"]);
        return { rows: lines };
      },
    }, "org-1");
    assert.equal(out.outcome, "ambiguous");
    assert.equal(out.line, null);
    assert.equal(out.candidates.length, 2);
  });

  console.log(`\n${passed} passed, ${process.exitCode ? 1 : 0} failed`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
