#!/usr/bin/env node
// tools/issue_operator_invite.js
//
// CLASS 3B  bootstrap-proof issuer. Issues ONE single-use, expiring,
// digest-stored login proof to an ALREADY-authorized staff user. It creates
// no users, no assignments, no roles, no module entitlements  if the
// authority does not already exist, this tool refuses (3A establishes
// authority; this tool only credentials it).
//
// CREDENTIAL SAFETY:
//   - crypto.randomBytes(32)  256-bit token, base64url.
//   - only sha256(token) is stored. The raw token is printed EXACTLY ONCE,
//     on an interactive terminal, with delivery warnings.
//   - refuses non-interactive stdout by default so the token can never be
//     captured by CI logs, deploy output, or shell pipelines. Override only
//     with PSPINE_ALLOW_NON_TTY=1 (used by the proof harness; dangerous
//     anywhere output is recorded).
//   - never writes the raw token to a file, database field, structured
//     log, or any output intended for automation.
//
// USAGE:
//   DATABASE_URL="<neon url>" node tools/issue_operator_invite.js \
//     --user <user-uuid> --property <property-uuid> [--minutes 60]

"use strict";
const crypto = require("crypto");
const { Client } = require("pg");

function arg(name, dflt) {
  const i = process.argv.indexOf("--" + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const USER_ID = arg("user", null);
const PROPERTY_ID = arg("property", null);
const MINUTES = Math.min(parseInt(arg("minutes", "60"), 10) || 60, 24 * 60); // hard cap 24h

function die(msg) { console.error("\n  REFUSED: " + msg + "\n"); process.exit(1); }

(async () => {
  if (!process.env.DATABASE_URL) die("DATABASE_URL is not set.");
  if (!USER_ID || !PROPERTY_ID) die("--user <uuid> and --property <uuid> are required.");

  // The one-time secret is about to be printed. Refuse anywhere it could be
  // silently recorded.
  if (!process.stdout.isTTY && process.env.PSPINE_ALLOW_NON_TTY !== "1") {
    die("stdout is not an interactive terminal. The invite token is a one-time " +
        "login credential and must not be captured by logs or pipelines. Run this " +
        "in a real terminal (or, for controlled test harnesses only, set " +
        "PSPINE_ALLOW_NON_TTY=1).");
  }

  // SSL follows the connection string: Neon URLs carry sslmode=require;
  // a local socket/test database does not. No hardcoded assumption.
  const useSsl = /sslmode=require/.test(process.env.DATABASE_URL);
  const client = new Client({ connectionString: process.env.DATABASE_URL,
                              ssl: useSsl ? { rejectUnauthorized: false } : false });
  await client.connect();

  try {
    // authority must ALREADY exist  same eligibility rule the issuer and
    // resolver enforce (067: is_active AND status='active') plus an active
    // assignment for exactly this property.
    const u = (await client.query(
      `select id, name, is_active, status from users where id = $1`, [USER_ID]
    )).rows[0];
    if (!u) die("No user with that id. (3A establishes authority; this tool only credentials it.)");
    if (!(u.is_active === true && u.status === "active")) die("That account is not active.");

    const a = (await client.query(
      `select role_title, allowed_modules from property_team_assignments
        where property_id = $1 and user_id = $2 and active = true`,
      [PROPERTY_ID, USER_ID]
    )).rows[0];
    if (!a) die("No ACTIVE assignment for that user on that property. This tool never creates authority.");

    const prop = (await client.query(
      `select coalesce(display_name, name) as name from properties where id = $1`, [PROPERTY_ID]
    )).rows[0];
    if (!prop) die("No property with that id.");

    const rawToken = crypto.randomBytes(32).toString("base64url");
    const digest = crypto.createHash("sha256").update(rawToken, "utf8").digest("hex");

    await client.query(
      `insert into operator_session_invites
         (user_id, property_id, token_digest, issuance_reason, expires_at, issuance_source)
       values ($1, $2, $3, 'bootstrap_invite', now() + ($4 || ' minutes')::interval, 'cli')`,
      [USER_ID, PROPERTY_ID, digest, String(MINUTES)]
    );

    console.log("\n  ============================================================");
    console.log("  ONE-TIME LOGIN PROOF  shown once, never stored or logged.");
    console.log("  Deliver OUT-OF-BAND (in person / voice / disappearing message).");
    console.log("  ============================================================\n");
    console.log("  INVITE TOKEN: " + rawToken + "\n");
    console.log("  for:      " + u.name + " (" + USER_ID + ")");
    console.log("  property: " + prop.name);
    console.log("  modules:  " + (a.allowed_modules || []).join(", "));
    console.log("  expires:  in " + MINUTES + " minutes  ·  single-use  ·  revocable");
    console.log("\n  The recipient signs in by submitting this token at the app's");
    console.log("  Invite Access screen (POST /operator/session).\n");
  } catch (e) {
    die(e.message);
  } finally {
    await client.end();
  }
})();
