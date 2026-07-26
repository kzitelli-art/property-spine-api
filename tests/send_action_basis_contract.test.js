// ════════════════════════════════════════════════════════════════════
//  send_action_basis_contract.test.js — authority is not a display string.
//
//  WHAT THIS PROTECTS
//  ------------------
//  resolveSendActionBasis decides who may prepare or send an application
//  link. It used to read `property_team_assignments.role_title` — a
//  free-text label an operator types. Live values were "Admin",
//  "Demo Leasing Manager", "R3" and "property_manager": exactly ONE of the
//  four matched, so the gate passed almost by accident. The portfolio
//  super-admin was refused; a QA account whose label happened to be typed
//  "property_manager" was allowed.
//
//  That is worse than an ordinary permission bug, because the BOARD offers
//  Send regardless — capability.js never consults ownership. So the screen
//  promised an action the server refused for nearly everyone: the
//  phantom-dispatch failure capability.js was built to prevent, arriving
//  through a gate the capability evaluator cannot see.
//
//  The assertions below are about WHERE AUTHORITY COMES FROM. A1 fails on
//  the old code. C1 is its mirror: a qualifying LABEL on a non-qualifying
//  ROLE must not grant anything, or the string is still authority.
//
//  Real Postgres, always rolled back.
//
//  CLASS 3 — test infrastructure outside the operator workflow.
//  RUN:  DATABASE_URL=... node tests/send_action_basis_contract.test.js
// ════════════════════════════════════════════════════════════════════
"use strict";

const path = require("path");
const { Pool } = require("pg");

const DEMO = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";
const OTHER = "9e2bb96e-08e2-41db-81c2-91055ceb50a3";

let passed = 0, failed = 0;
const lines = [];
function ok(label, cond, detail) {
  if (cond) { passed++; lines.push(`  ok    ${label}`); }
  else { failed++; lines.push(`  FAIL  ${label}${detail ? "\n          " + detail : ""}`); }
}
function section(t) { lines.push(`\n  ── ${t} ${"─".repeat(Math.max(0, 52 - t.length))}`); }

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required — this contract is about a real assignment read.");
    process.exitCode = 2; return;
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  // The module fails closed without the conversion closure authority, which
  // server.js normally supplies. resolveSendActionBasis never touches it —
  // this stub exists only to let the closure construct.
  // The module returns an express router and hangs its services off
  // router._service — the same object applicationSubmission.js calls.
  const conversion = require(path.join(__dirname, "..", "src", "leasing", "leasingconversion.js"))({
    pool,
    closureAuthority: { closeLinkedConversionObligation: async () => { throw new Error("not used by this contract"); } },
  })._service;
  const client = await pool.connect();

  try {
    await client.query("begin");

    // role  = users.role, the structural enum (the authority)
    // title = property_team_assignments.role_title, free text (a label)
    const mkUser = async (name, role, {
      title = "whatever the operator typed", modules = ["leasing"],
      property = DEMO, active = true, userActive = true,
    } = {}) => {
      const u = (await client.query(
        `insert into users (name, role, is_active, status)
         values ($1,$2,$3,$4) returning id`,
        [name, role, userActive, userActive ? "active" : "disabled"])).rows[0];
      await client.query(
        `insert into property_team_assignments (property_id, user_id, role_title, allowed_modules, active)
         values ($1,$2,$3,$4,$5)`, [property, u.id, title, modules, active]);
      return u.id;
    };

    const basis = (actor, property = DEMO, owner = null) =>
      conversion.resolveSendActionBasis(client, {
        actor_user_id: actor, property_id: property, stored_owner_user_id: owner,
      });

    // ════ A · THE FIX ════════════════════════════════════════════════
    section("A · authority comes from the role");

    const admin = await mkUser("Contract Admin", "property_manager", { title: "Admin" });
    const a1 = await basis(admin);
    ok("A1. THE FIX — a property_manager titled \"Admin\" is covered (fails on the old string match)",
      a1.allowed === true && a1.basis === "role_coverage", JSON.stringify(a1));

    const lm = await mkUser("Contract LM", "leasing_manager", { title: "Demo Leasing Manager" });
    const a2 = await basis(lm);
    ok("A2. a leasing_manager with a decorative title is covered",
      a2.allowed === true, JSON.stringify(a2));

    const legacy = await mkUser("Contract Legacy", "property_manager", { title: "property_manager" });
    const a3 = await basis(legacy);
    ok("A3. the account that worked before still works — no regression",
      a3.allowed === true, JSON.stringify(a3));

    // ════ B · OWNERSHIP STILL WINS ═══════════════════════════════════
    section("B · the owner path is untouched");

    const agent = await mkUser("Contract Agent", "leasing_agent", { title: "property_manager" });
    const b1 = await basis(agent, DEMO, agent);
    ok("B1. the stored owner is allowed on ownership alone, whatever their role",
      b1.allowed === true && b1.basis === "owner", JSON.stringify(b1));

    const b2 = await basis(null, DEMO, null);
    ok("B2. no actor is refused — never anonymous authority",
      b2.allowed === false && b2.reason === "no_actor", JSON.stringify(b2));

    // ════ C · THE STRING GRANTS NOTHING ══════════════════════════════
    //  The mirror of A1. If these pass only because the values happen to
    //  line up, the label is still authority and the bug is still here.
    section("C · a label grants nothing");

    const c1 = await basis(agent);
    ok("C1. THE MIRROR — a leasing_agent TITLED \"property_manager\" is REFUSED",
      c1.allowed === false && c1.reason === "not_owner_no_role_coverage", JSON.stringify(c1));

    const noModule = await mkUser("Contract NoModule", "property_manager", { modules: ["maintenance"] });
    const c2 = await basis(noModule);
    ok("C2. the right role without the leasing module is refused — entitlement is separate",
      c2.allowed === false, JSON.stringify(c2));

    const inactiveAssign = await mkUser("Contract Inactive", "property_manager", { active: false });
    const c3 = await basis(inactiveAssign);
    ok("C3. an INACTIVE assignment covers nothing",
      c3.allowed === false, JSON.stringify(c3));

    const disabled = await mkUser("Contract Disabled", "property_manager", { userActive: false });
    const c4 = await basis(disabled);
    ok("C4. a disabled user covers nothing, even with a live assignment row",
      c4.allowed === false, JSON.stringify(c4));

    // ════ D · THE PROPERTY WALL ══════════════════════════════════════
    section("D · the property wall");

    const elsewhere = await mkUser("Contract Elsewhere", "property_manager", { property: OTHER });
    const d1 = await basis(elsewhere, DEMO);
    ok("D1. a manager at ANOTHER property covers nothing here",
      d1.allowed === false, JSON.stringify(d1));
    const d2 = await basis(elsewhere, OTHER);
    ok("D2. ...and does cover at the property they are actually assigned to",
      d2.allowed === true, JSON.stringify(d2));

  } catch (e) {
    failed++; lines.push(`  FAIL  harness threw: ${e.message}`);
  } finally {
    try { await client.query("rollback"); } catch (_) {}
    client.release();
    await pool.end().catch(() => {});
  }

  const bar = "─".repeat(66);
  console.log(`\n${bar}\nSEND ACTION BASIS — AUTHORITY IS NOT A DISPLAY STRING\n${bar}`);
  console.log(lines.join("\n"));
  console.log(`\n${bar}`);
  console.log(`${passed}/${passed + failed} passed` + (failed ? `  —  ${failed} failure(s)` : ""));
  console.log(failed
    ? "Rolled back; nothing persisted. Fix the failures above and re-run."
    : "Renaming a job title cannot grant or remove authority.");
  console.log(`${bar}\n`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error("harness error:", e); process.exitCode = 1; });
