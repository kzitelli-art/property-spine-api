/*
 * PLAID WEBHOOK VERIFICATION — dedicated real HTTP/Postgres proof
 *
 * The ordinary parent server stays on port 3000 without a Plaid preload.
 * This proof alone starts a second real server on port 3101 with the
 * proof-owned verification-key transport, then tears it down before the
 * runner continues to every existing later proof.
 */
"use strict";

const path = require("path");
module.paths.unshift(path.join(__dirname, "..", "..", "node_modules"));
const crypto = require("crypto");
const net = require("net");
const { spawn } = require("child_process");
const { Pool } = require("pg");
const plaidKeys = require("./plaid_webhook_test_keys");

const ROOT = path.join(__dirname, "..", "..");
const DB = process.env.E2E_DATABASE_URL;
const ORDINARY_BASE = "http://127.0.0.1:3000";
const PLAID_PORT = 3101;
const PLAID_BASE = `http://127.0.0.1:${PLAID_PORT}`;
const KEY = "e2e-key";
const STAMP = `plaid-webhook-${Date.now().toString(36)}`;

if (!DB) throw new Error("E2E_DATABASE_URL is required");

const pool = new Pool({ connectionString: DB });
let bad = 0;
let firstFailure = null;
function must(label, condition, detail = "") {
  if (condition) return console.log(`  ✓ ${label}`);
  bad += 1;
  if (!firstFailure) firstFailure = { label, detail };
  console.error(`  ✗ ${label}${detail ? `\n      ${detail}` : ""}`);
}

function jwtSegment(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function plaidVerification(rawBody, {
  iat = Math.floor(Date.now() / 1000), kid = plaidKeys.TRUSTED_KID,
  alg = "ES256", privateJwk = plaidKeys.TRUSTED_PRIVATE, hashBody = rawBody,
} = {}) {
  const header = jwtSegment({ alg, kid, typ: "JWT" });
  const claims = jwtSegment({
    iat,
    request_body_sha256: crypto.createHash("sha256").update(hashBody).digest("hex"),
  });
  const key = crypto.createPrivateKey({ key: privateJwk, format: "jwk" });
  const signature = crypto.sign(
    "sha256", Buffer.from(`${header}.${claims}`, "ascii"),
    { key, dsaEncoding: "ieee-p1363" }
  );
  return `${header}.${claims}.${signature.toString("base64url")}`;
}

async function plaidPost(rawBody, { verification = null, operatorKey = false } = {}) {
  const headers = { "content-type": "application/json" };
  if (verification) headers["Plaid-Verification"] = verification;
  if (operatorKey) headers["x-operator-key"] = KEY;
  const response = await fetch(PLAID_BASE + "/plaid/webhook", {
    method: "POST", headers, body: rawBody,
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => resolve(true));
    socket.setTimeout(500, () => { socket.destroy(); resolve(true); });
  });
}

async function waitForHealth(base, child) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child && child.exitCode !== null) return null;
    try {
      const response = await fetch(base + "/health");
      if (response.status === 200) return response.json();
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

(async () => {
  let child = null;
  let plaidItemId = null;
  let serverOutput = "";
  const q = (text, params) => pool.query(text, params);

  try {
    console.log("══ PLAID WEBHOOK VERIFICATION — DEDICATED PROVIDER PROOF ══");
    must("the fake Plaid transport is not loaded into the proof runner",
      !require.cache[require.resolve("./fake_plaid_preload")]);
    const ordinaryHealth = await waitForHealth(ORDINARY_BASE);
    must("the ordinary API server is healthy before the proof-scoped server starts",
      ordinaryHealth && ordinaryHealth.ok === true, JSON.stringify(ordinaryHealth));
    must("the proof-scoped Plaid port starts free", await portIsFree(PLAID_PORT));

    const preload = path.join(__dirname, "fake_plaid_preload.js");
    child = spawn(process.execPath, ["--require", preload, "server.js"], {
      cwd: ROOT,
      env: {
        ...process.env,
        DATABASE_URL: DB,
        OPERATOR_KEY: KEY,
        PORT: String(PLAID_PORT),
        APP_BASE_URL: PLAID_BASE,
        PLAID_CLIENT_ID: "e2e-client-id",
        PLAID_SECRET: "e2e-secret",
        PLAID_ENV: "sandbox",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => { serverOutput = (serverOutput + chunk).slice(-8000); });
    child.stderr.on("data", (chunk) => { serverOutput = (serverOutput + chunk).slice(-8000); });
    const plaidHealth = await waitForHealth(PLAID_BASE, child);
    must("the proof-scoped real server becomes healthy",
      plaidHealth && plaidHealth.ok === true, serverOutput);
    if (!plaidHealth) throw new Error("proof-scoped Plaid server did not start");

    const prop = (await q(
      "select id from properties where name='Skyline E2E' order by created_at desc limit 1"
    )).rows[0].id;
    plaidItemId = `item_${STAMP}`;
    await q(
      `insert into plaid_item
         (property_id,item_id,access_token,status,last_error,updated_at)
       values ($1,$2,$3,'active','WAITING',now()-interval '1 minute')`,
      [prop, plaidItemId, `access-${STAMP}`]
    );
    async function resetPlaidItem() {
      await q(
        `update plaid_item
            set status='active',last_error='WAITING',updated_at=now()-interval '1 minute'
          where item_id=$1`, [plaidItemId]
      );
    }
    async function durableState() {
      const row = (await q(
        "select status,last_error,updated_at from plaid_item where item_id=$1", [plaidItemId]
      )).rows[0];
      const counts = (await q(
        `select
           (select count(*)::int from plaid_account
             where plaid_item_id=(select id from plaid_item where item_id=$1)) as accounts,
           (select count(*)::int from bank_transactions) as bank_transactions,
           (select count(*)::int from events where property_id=$2) as events,
           (select count(*)::int from obligations where property_id=$2) as obligations`,
        [plaidItemId, prop]
      )).rows[0];
      return { ...row, ...counts };
    }

    const loginRaw = JSON.stringify({
      webhook_type: "ITEM", webhook_code: "ITEM_LOGIN_REQUIRED", item_id: plaidItemId,
    });
    async function invalidPlaid(label, rawBody, verification, expectedStatus, operatorKey = false) {
      await resetPlaidItem();
      const before = await durableState();
      const response = await plaidPost(rawBody, { verification, operatorKey });
      const after = await durableState();
      console.log(`  ${label} -> ${response.status} ${JSON.stringify(response.body)}`);
      must(`${label} is refused before the Plaid handler`,
        response.status === expectedStatus && response.body && response.body.ok === false,
        `got ${response.status} ${JSON.stringify(response.body)}`);
      must(`${label} causes zero money, evidence, or plaid_item mutation`,
        JSON.stringify(after) === JSON.stringify(before),
        `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    }

    await invalidPlaid("missing verification even with x-operator-key", loginRaw, null, 401, true);
    await invalidPlaid("malformed verification JWT", loginRaw, "not-a-jwt", 401);
    await invalidPlaid("expired verification JWT", loginRaw, plaidVerification(loginRaw, {
      iat: Math.floor(Date.now() / 1000) - 301,
    }), 401);
    await invalidPlaid("wrong signing key", loginRaw, plaidVerification(loginRaw, {
      privateJwk: plaidKeys.WRONG_PRIVATE,
    }), 401);
    await invalidPlaid("wrong JWT algorithm", loginRaw, plaidVerification(loginRaw, {
      alg: "HS256",
    }), 401);
    await invalidPlaid("raw-body hash mismatch", loginRaw, plaidVerification(loginRaw, {
      hashBody: loginRaw + " ",
    }), 401);
    await invalidPlaid("verification-key fetch failure", loginRaw, plaidVerification(loginRaw, {
      kid: "fetch-fails",
    }), 503);

    await resetPlaidItem();
    const validLogin = plaidVerification(loginRaw);
    const valid = await plaidPost(loginRaw, { verification: validLogin });
    const afterValid = await durableState();
    must("a public verified Plaid delivery needs no operator key and reaches the narrow handler",
      valid.status === 200 && valid.body && valid.body.ok === true
        && afterValid.status === "login_required"
        && afterValid.last_error === "ITEM_LOGIN_REQUIRED",
      `${valid.status} ${JSON.stringify(valid.body)} ${JSON.stringify(afterValid)}`);
    const duplicate = await plaidPost(loginRaw, { verification: validLogin });
    const afterDuplicate = await durableState();
    must("a verified duplicate delivery is acknowledged without a second mutation",
      duplicate.status === 200 && JSON.stringify(afterDuplicate) === JSON.stringify(afterValid),
      `${JSON.stringify(afterValid)} -> ${JSON.stringify(afterDuplicate)}`);

    const updatesRaw = JSON.stringify({
      webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: plaidItemId,
    });
    const updates = await plaidPost(updatesRaw, { verification: plaidVerification(updatesRaw) });
    const afterUpdates = await durableState();
    must("the verified transaction notice only clears the existing Item status note",
      updates.status === 200 && afterUpdates.status === "login_required"
        && afterUpdates.last_error === null
        && afterUpdates.accounts === 0
        && afterUpdates.bank_transactions === afterValid.bank_transactions
        && afterUpdates.events === afterValid.events
        && afterUpdates.obligations === afterValid.obligations,
      JSON.stringify(afterUpdates));
    const duplicateUpdates = await plaidPost(updatesRaw, {
      verification: plaidVerification(updatesRaw),
    });
    const afterDuplicateUpdates = await durableState();
    must("a duplicate transaction notice creates no second status-note mutation",
      duplicateUpdates.status === 200
        && JSON.stringify(afterDuplicateUpdates) === JSON.stringify(afterUpdates),
      `${JSON.stringify(afterUpdates)} -> ${JSON.stringify(afterDuplicateUpdates)}`);
  } catch (error) {
    bad += 1;
    if (!firstFailure) firstFailure = {
      label: "dedicated Plaid proof died",
      detail: String(error && error.message || error),
    };
    console.error("  ✗ dedicated Plaid proof died", error && error.stack || error);
  } finally {
    if (plaidItemId) {
      try { await pool.query("delete from plaid_item where item_id=$1", [plaidItemId]); }
      catch (error) {
        bad += 1;
        if (!firstFailure) firstFailure = { label: "fixture teardown", detail: error.message };
        console.error("  ✗ fixture teardown", error.message);
      }
    }
    await stopChild(child);
    must("the proof-scoped Plaid server is stopped", await portIsFree(PLAID_PORT));
    const ordinaryAfter = await waitForHealth(ORDINARY_BASE);
    must("the ordinary API server remains healthy for every later proof",
      ordinaryAfter && ordinaryAfter.ok === true, JSON.stringify(ordinaryAfter));
    if (plaidItemId) {
      const remaining = await pool.query(
        "select count(*)::int n from plaid_item where item_id=$1", [plaidItemId]
      );
      must("the Plaid webhook fixture is removed", remaining.rows[0].n === 0);
    }
    await pool.end();
  }

  if (firstFailure) {
    console.error(`FIRST RED: ${firstFailure.label}${firstFailure.detail ? ` — ${firstFailure.detail}` : ""}`);
  }
  console.log("════════════════════════════════════════════════════════════");
  console.log(bad === 0
    ? "  ✓ PASS — Plaid webhook verification owns the provider boundary."
    : `  ✗ FAIL — ${bad} Plaid webhook assertion(s) failed.`);
  console.log("════════════════════════════════════════════════════════════");
  process.exitCode = bad === 0 ? 0 : 2;
})();
