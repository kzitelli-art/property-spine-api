#!/usr/bin/env node
// tools/qa_provision.js
//
// CLASS 3A  internal-QA setup operation. Establishes controlled test
// authority: a durably classified internal-QA staff identity plus one
// least-privilege active property assignment. This tool and the invite
// issuer (3B) are deliberately SEPARATE authority levels: 3A creates the
// authority; 3B may only issue a credential to authority that already
// exists. Neither tool is a product screen.
//
// GUARANTEES:
//   - the user is born account_kind='internal_qa'  the ONE central QA
//     classification (070). It is never assigned by reclassifying a real
//     account, and this tool refuses to touch any row that is not already
//     internal_qa.
//   - least privilege: exactly the modules you pass (default: leasing).
//   - attributable: account_kind_set_* stamped; ordinary revocation works
//     (deactivate assignment / suspend user  the live resolver kills
//     sessions on the next request, proven).
//   - structurally excluded from ownership already: the 067 eligible-owner
//     rule requires account_kind='human_staff', so internal_qa can never
//     own obligations. Roster/eligible-staff exclusion lands in Slice 5
//     via userIsOperational.
//
// USAGE:
//   DATABASE_URL="<neon url>" node tools/qa_provision.js \
//     --property <property-uuid> [--name "Solo QA Operator [INTERNAL]"] \
//     [--modules leasing] [--yes]

"use strict";
const { Client } = require("pg");
const readline = require("readline");

function arg(name, dflt) {
  const i = process.argv.indexOf("--" + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const YES = process.argv.includes("--yes");

const PROPERTY_ID = arg("property", null);
const NAME = arg("name", "Solo QA Operator [INTERNAL]");
const MODULES = arg("modules", "leasing").split(",").map(s => s.trim()).filter(Boolean);

function die(msg) { console.error("\n  REFUSED: " + msg + "\n"); process.exit(1); }

async function confirm(question) {
  if (YES) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(res => rl.question(question + " (yes/no): ", res));
  rl.close();
  return answer.trim().toLowerCase() === "yes";
}

(async () => {
  if (!process.env.DATABASE_URL) die("DATABASE_URL is not set.");
  if (!PROPERTY_ID) die("--property <uuid> is required (the QA assignment's property).");
  if (MODULES.length === 0) die("--modules must name at least one module.");

  // SSL follows the connection string: Neon URLs carry sslmode=require;
  // a local socket/test database does not. No hardcoded assumption.
  const useSsl = /sslmode=require/.test(process.env.DATABASE_URL);
  const client = new Client({ connectionString: process.env.DATABASE_URL,
                              ssl: useSsl ? { rejectUnauthorized: false } : false });
  await client.connect();

  try {
    const prop = (await client.query(
      `select id, coalesce(display_name, name) as name from properties where id = $1`, [PROPERTY_ID]
    )).rows[0];
    if (!prop) die("No property with that id.");

    // Refuse to collide with a real account: if a user with this exact name
    // exists and is NOT internal_qa, stop  never reclassify a real person.
    const existing = (await client.query(
      `select id, account_kind, status, is_active from users where name = $1`, [NAME]
    )).rows;
    const realCollision = existing.find(u => u.account_kind !== "internal_qa");
    if (realCollision) die(`A non-QA account already uses the name "${NAME}". Pick a different --name.`);

    const proceed = await confirm(
      `Provision internal-QA identity "${NAME}" with modules [${MODULES.join(", ")}] on "${prop.name}"?`
    );
    if (!proceed) die("Not confirmed.");

    await client.query("begin");

    // identity: reuse the existing internal_qa row of this name, else create.
    let qa = existing.find(u => u.account_kind === "internal_qa");
    if (qa) {
      await client.query(
        `update users set is_active = true, status = 'active' where id = $1`, [qa.id]);
    } else {
      qa = (await client.query(
        `insert into users (name, role, is_active, status, account_kind, account_kind_set_at)
         values ($1, 'property_manager', true, 'active', 'internal_qa', now())
         returning id`,
        [NAME]
      )).rows[0];
    }

    // least-privilege active assignment. Constraint-agnostic
    // reactivate-or-insert: works under a FULL unique on the pair OR the
    // partial active-only index; never creates a second (or second-active) row.
    const upd1 = await client.query(
      `update property_team_assignments
          set role_title='Internal QA', allowed_modules=$3,
              primary_for_modules='{}', can_manage_roles=false, updated_at=now()
        where property_id=$1 and user_id=$2 and active=true`,
      [PROPERTY_ID, qa.id, MODULES]);
    if (upd1.rowCount === 0) {
      const upd2 = await client.query(
        `update property_team_assignments
            set active=true, role_title='Internal QA', allowed_modules=$3,
                primary_for_modules='{}', can_manage_roles=false, updated_at=now()
          where id = (select id from property_team_assignments
                       where property_id=$1 and user_id=$2
                       order by updated_at desc nulls last limit 1)`,
        [PROPERTY_ID, qa.id, MODULES]);
      if (upd2.rowCount === 0) {
        await client.query(
          `insert into property_team_assignments
             (property_id, user_id, role_title, scope_type, allowed_modules,
              primary_for_modules, can_manage_roles, active, updated_at)
           values ($1, $2, 'Internal QA', 'property', $3, '{}', false, true, now())`,
          [PROPERTY_ID, qa.id, MODULES]);
      }
    }

    await client.query("commit");

    console.log("\n  Internal-QA authority established.");
    console.log("  user_id:      " + qa.id);
    console.log("  classification: account_kind = internal_qa (central; excluded from");
    console.log("                  operational output via userIsOperational; structurally");
    console.log("                  ineligible for obligation ownership per 067)");
    console.log("  property:     " + prop.name + " (" + PROPERTY_ID + ")");
    console.log("  modules:      " + MODULES.join(", "));
    console.log("  next step:    issue a one-time login proof with tools/issue_operator_invite.js\n");
  } catch (e) {
    try { await client.query("rollback"); } catch (_) {}
    die(e.message);
  } finally {
    await client.end();
  }
})();
