#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   mkfixture.js — one signed-in operator, for a browser proof to drive.

   CLASS 3 — harness infrastructure. Mints an organization, a person, an
   org_admin, a property seat, an active team assignment and a staff
   session, and prints the RAW session token so a browser proof can seed
   it the way the product does (sessionStorage).

   It goes through `harnessConnectionString()`, so it requires
   HARNESS_DATABASE_URL and refuses when that resolves to the same
   host/port/database as DATABASE_URL. There is one refusal in this repo
   and this uses it rather than carrying a second copy.

   The assignment is not decoration: the shipped session resolver JOINS
   property_team_assignments, so a session with no active seat resolves to
   nothing. The fixture obeys the shipped rule rather than routing round it.

   REMOVAL CONDITION — delete when browser proofs can obtain a session
   through the real sign-in flow against a disposable database.

   run:  HARNESS_DATABASE_URL="postgres://..." node tools/harness/mkfixture.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const crypto = require("crypto");
const { Pool } = require("pg");
const { harnessConnectionString } = require("../../tests/_run_receipt.js");

const pool = new Pool({ connectionString: harnessConnectionString() });

(async () => {
  const TAG = "AMBROWSER_" + Date.now().toString(36);

  const org = (await pool.query(
    `insert into organizations (name, slug) values ($1,$2) returning id`,
    [TAG + " Client", TAG.toLowerCase()])).rows[0].id;

  const person = (await pool.query(
    `insert into persons (name) values ($1) returning id`, [TAG + " Owner"])).rows[0].id;

  const user = (await pool.query(
    `insert into users (name, email, platform_role, organization_id, is_active, status, person_id)
     values ($1,$2,'org_admin',$3,true,'active',$4) returning id`,
    [TAG + " Admin", TAG.toLowerCase() + "@example.test", org, person])).rows[0].id;

  const seat = (await pool.query(
    `insert into properties (name, canonical_key) values ($1,$2) returning id`,
    [TAG + " seat", TAG + "-SEAT"])).rows[0].id;

  await pool.query(
    `insert into property_team_assignments (property_id, user_id, role_title, allowed_modules, active)
     values ($1,$2,'manager',ARRAY['management'],true) on conflict do nothing`, [seat, user]);

  //  Digest at rest, raw token to the caller — the same shape the shipped
  //  issuance writes, so the shipped resolver is what answers it.
  const token = crypto.randomBytes(32).toString("base64url");
  await pool.query(
    `insert into staff_sessions (user_id, property_id, token, token_digest, issuance_purpose, expires_at)
     values ($1,$2,null,$3,'bootstrap_invite', now() + interval '6 hours')`,
    [user, seat, crypto.createHash("sha256").update(token, "utf8").digest("hex")]);

  console.log(JSON.stringify({ token, org, user, seat }));
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
