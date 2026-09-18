/*  ==========================================================================
    deposit_attribution_serialized.e2e.js -- ONE DEPOSIT, ONE SERIAL CAP CHECK.

    The deposit-cap check and payment_bank_links insert must serialize on the
    bank_transactions row. This real-HTTP proof uses a FOR NO KEY UPDATE lock because
    it is compatible with the foreign-key KEY SHARE lock taken by the old
    insert path, but conflicts with the endpoint's FOR NO KEY UPDATE lock.

    Normal mode proves all of the following:
      * the request is blocked on the fixture row by this harness connection,
        identified through the server's isolated application_name and
        pg_blocking_pids (a delay is not accepted as lock evidence);
      * a competing committed attribution is visible when the request resumes,
        so the request returns 409 and writes no link;
      * two simultaneous HTTP requests for 1,000 against a fresh 1,500 deposit
        produce exactly one 200 and one 409, after which a fitting 500 succeeds.

    PROOF_EXPECT_DEFECT=1 is for the exact parent revision. It passes only when
    the request positively returns 200 and its link is committed while the
    compatible blocker is still held. Setup failures and timeouts are failures,
    not substitutes for evidence of the defect.

    Required environment:
      E2E_DATABASE_URL
      E2E_API_BASE (E2E_BASE_URL is accepted as the standard fallback)
      E2E_SERVER_APPLICATION_NAME (set the server PGAPPNAME to the same value)
    ========================================================================== */
"use strict";

const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const boundary = require("./proof_boundary");
const ROOT = path.join(__dirname, "..", "..");
const { Client } = require(path.join(ROOT, "node_modules", "pg"));

const DATABASE_URL = process.env.E2E_DATABASE_URL;
const API = (process.env.E2E_API_BASE || process.env.E2E_BASE_URL || "").replace(/\/+$/, "");
const KEY = process.env.E2E_OPERATOR_KEY || "e2e-key";
const SERVER_APP = process.env.E2E_SERVER_APPLICATION_NAME;
const EXPECT_DEFECT = process.env.PROOF_EXPECT_DEFECT === "1";
const HTTP_TIMEOUT_MS = 20000;
const LOCK_EVIDENCE_TIMEOUT_MS = 7000;
const SETTLE_TIMEOUT_MS = 8000;

let passed = 0;
let failed = 0;
const ok = (label, detail = "") => {
  passed++;
  console.log(`  PASS  ${label}${detail ? " -- " + detail : ""}`);
};
const bad = (label, detail = "") => {
  failed++;
  console.log(`  FAIL  ${label}${detail ? " -- " + detail : ""}`);
};
const check = (label, condition, detail = "") => condition ? ok(label, detail) : bad(label, detail);
const section = (label) => console.log(`\n-- ${label} ${"-".repeat(Math.max(0, 64 - label.length))}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (value) => JSON.stringify(value);

function requireEnvironment() {
  const missing = [];
  if (!DATABASE_URL) missing.push("E2E_DATABASE_URL");
  if (!API) missing.push("E2E_API_BASE or E2E_BASE_URL");
  if (!SERVER_APP) missing.push("E2E_SERVER_APPLICATION_NAME");
  if (missing.length) throw new Error(`required environment missing: ${missing.join(", ")}`);
}

async function one(client, sql, params = []) {
  return (await client.query(sql, params)).rows[0];
}

function startLink(paymentId, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`HTTP deadline exceeded (${HTTP_TIMEOUT_MS}ms)`)), HTTP_TIMEOUT_MS);
  const state = { done: false, value: null, error: null, controller, promise: null };
  state.promise = fetch(`${API}/payments/${paymentId}/link-bank`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-operator-key": KEY },
    body: json(body),
    signal: controller.signal,
  }).then(async (response) => ({
    status: response.status,
    body: await response.json().catch(() => null),
  })).then((value) => {
    state.done = true;
    state.value = value;
    return value;
  }, (error) => {
    state.done = true;
    state.error = error;
    throw error;
  }).finally(() => clearTimeout(timer));
  // The state is polled before the request is awaited. Attach a handler now so
  // an early network failure cannot become an unhandled rejection.
  state.promise.catch(() => {});
  return state;
}

async function waitForState(state, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!state.done && Date.now() < deadline) await sleep(25);
  return state.done;
}

async function settleAfterRelease(state) {
  if (!state) return;
  if (!(await waitForState(state, SETTLE_TIMEOUT_MS))) state.controller.abort(new Error("request did not settle after blocker release"));
  await state.promise.catch(() => {});
}

async function createFixture(client, suffix) {
  const tag = `DAS-${suffix}-${crypto.randomUUID()}`;
  const propertyId = (await one(client,
    "insert into properties (name,address) values ($1,'16 Serialized Way') returning id",
    [tag])).id;
  const accountId = (await one(client,
    `insert into bank_accounts (property_id, account_label, account_last4, bank_name)
     values ($1,'operating','9472','Serialization Proof Bank') returning id`,
    [propertyId])).id;
  const depositId = (await one(client,
    `insert into bank_transactions (bank_account_id, txn_date, description, amount, txn_type)
     values ($1,current_date,$2,1500.00,'deposit') returning id`,
    [accountId, tag])).id;
  const payment = async (amount) => (await one(client,
    `insert into payments (property_id, amount, paid_date, method, status)
     values ($1,$2,current_date,'check','claimed') returning id`,
    [propertyId, amount])).id;
  return {
    propertyId,
    depositId,
    p1: await payment(1000),
    p2: await payment(1000),
    p3: await payment(500),
  };
}

async function attribution(client, depositId) {
  return one(client,
    `select count(*)::int as links,
            coalesce(sum(coalesce(l.amount_matched, p.amount)),0)::numeric(14,2) as amount
       from payment_bank_links l
       join payments p on p.id=l.payment_id
      where l.bank_transaction_id=$1`,
    [depositId]);
}

async function findExactBlockedServer(observer, blockerPid) {
  const rows = (await observer.query(
    `select pid, application_name, state, wait_event_type, wait_event,
            pg_blocking_pids(pid) as blockers, query
       from pg_stat_activity
      where datname=current_database()
        and application_name=$1
        and pid<>pg_backend_pid()
        and state='active'`,
    [SERVER_APP])).rows.filter((row) =>
      Array.isArray(row.blockers) && row.blockers.includes(blockerPid) &&
      /from\s+bank_transactions\s+t/i.test(row.query || "") &&
      /for\s+no\s+key\s+update\s+of\s+t/i.test(row.query || ""));
  return rows;
}

async function waitForBlockedServer(observer, blockerPid, requestState) {
  const deadline = Date.now() + LOCK_EVIDENCE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (requestState.done) return [];
    const rows = await findExactBlockedServer(observer, blockerPid);
    if (rows.length) return rows;
    await sleep(40);
  }
  return [];
}

async function serializedCheckpoint(observer, blocker) {
  const fixture = await createFixture(observer, "checkpoint");
  let blockerOpen = false;
  let request = null;
  try {
    await blocker.query("begin");
    blockerOpen = true;
    await blocker.query("select id from bank_transactions where id=$1 for no key update", [fixture.depositId]);
    const blockerPid = (await one(blocker, "select pg_backend_pid() as pid")).pid;
    request = startLink(fixture.p1, { bank_transaction_id: fixture.depositId });

    if (EXPECT_DEFECT) {
      section("expected-defect checkpoint on the parent revision");
      const completedUnderBlocker = await waitForState(request, LOCK_EVIDENCE_TIMEOUT_MS);
      check("HTTP request completed while the compatible FOR NO KEY UPDATE lock was still held",
        completedUnderBlocker,
        completedUnderBlocker ? "" : "request timed out; no defect was positively evidenced");
      if (completedUnderBlocker) {
        check("the under-blocker response was 200",
          !request.error && request.value && request.value.status === 200,
          request.error ? request.error.message : json(request.value));
        const committed = await one(observer,
          "select count(*)::int as n from payment_bank_links where payment_id=$1 and bank_transaction_id=$2",
          [fixture.p1, fixture.depositId]);
        check("the P1 link was committed before the blocker was released", committed.n === 1, `links=${committed.n}`);
        if (!request.error && request.value && request.value.status === 200 && committed.n === 1) {
          ok("EXPECTED DEFECT EVIDENCED: the cap check was not serialized");
        }
      }
      return fixture.propertyId;
    }

    section("serialized checkpoint and committed competitor");
    const blocked = await waitForBlockedServer(observer, blockerPid, request);
    check("the P1 HTTP request remained unresolved while the row lock was held", !request.done,
      request.done ? (request.error ? request.error.message : json(request.value)) : "");
    check("exactly one isolated server backend was blocked in the deposit locking query",
      blocked.length === 1, `matches=${blocked.length}`);
    check("pg_blocking_pids identifies this proof's blocker backend",
      blocked.length === 1 && blocked[0].blockers.includes(blockerPid),
      blocked.length ? `server_pid=${blocked[0].pid} blockers=${json(blocked[0].blockers)}` : `blocker_pid=${blockerPid}`);

    if (blocked.length !== 1 || request.done) {
      bad("lock checkpoint established before authoring the competitor",
        "refusing to treat delay, setup failure, or an early response as serialization proof");
      return fixture.propertyId;
    }
    const sessionRecords = fs.readFileSync(process.env.E2E_SESSION_LOG, "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const actualSession = sessionRecords.find(r => r.pid === blocked[0].pid && r.run === boundary.manifest().nonce);
    if (!actualSession || actualSession.isolation !== "read committed") throw new Error("READ COMMITTED was not proven on the actual blocked server session");
    ok("actual blocked server transaction isolation is READ COMMITTED", `server_pid=${actualSession.pid}`);

    await blocker.query(
      `insert into payment_bank_links (payment_id, bank_transaction_id, amount_matched)
       values ($1,$2,1000.00)`,
      [fixture.p2, fixture.depositId]);
    await blocker.query("commit");
    blockerOpen = false;

    const settled = await waitForState(request, SETTLE_TIMEOUT_MS);
    check("P1 settled after the blocker committed", settled,
      settled ? "" : `deadline=${SETTLE_TIMEOUT_MS}ms`);
    check("P1 re-read the committed attribution and returned 409",
      settled && !request.error && request.value.status === 409,
      request.error ? request.error.message : json(request.value));

    const p1Link = await one(observer,
      "select count(*)::int as n from payment_bank_links where payment_id=$1 and bank_transaction_id=$2",
      [fixture.p1, fixture.depositId]);
    const total = await attribution(observer, fixture.depositId);
    check("no P1 link was written", p1Link.n === 0, `links=${p1Link.n}`);
    check("the deposit has exactly the competing P2 attribution of 1000.00",
      total.links === 1 && Number(total.amount) === 1000,
      `links=${total.links} attributed=${total.amount}`);
    return fixture.propertyId;
  } finally {
    if (blockerOpen) await blocker.query("rollback").catch(() => {});
    await settleAfterRelease(request);
  }
}

async function simultaneousHttpCheckpoint(observer) {
  const fixture = await createFixture(observer, "two-http");
  section("two simultaneous HTTP requests share one deposit cap");
  const first = startLink(fixture.p1, { bank_transaction_id: fixture.depositId });
  const second = startLink(fixture.p2, { bank_transaction_id: fixture.depositId });
  try {
    await Promise.allSettled([first.promise, second.promise]);
    const statuses = [first.value && first.value.status, second.value && second.value.status].sort((a, b) => a - b);
    check("two 1000 requests against 1500 yield exactly one 200 and one 409",
      !first.error && !second.error && statuses[0] === 200 && statuses[1] === 409,
      `statuses=${json(statuses)} errors=${json([first.error && first.error.message, second.error && second.error.message])}`);
    const capped = await attribution(observer, fixture.depositId);
    check("the simultaneous pair committed one link totaling 1000.00",
      capped.links === 1 && Number(capped.amount) === 1000,
      `links=${capped.links} attributed=${capped.amount}`);

    const fitting = startLink(fixture.p3, {
      bank_transaction_id: fixture.depositId,
      amount_matched: 500,
    });
    await fitting.promise.catch(() => {});
    check("a fresh fitting 500 request succeeds", !fitting.error && fitting.value.status === 200,
      fitting.error ? fitting.error.message : json(fitting.value));
    const full = await attribution(observer, fixture.depositId);
    check("the deposit finishes exactly capped at 1500.00",
      full.links === 2 && Number(full.amount) === 1500,
      `links=${full.links} attributed=${full.amount}`);
    return fixture.propertyId;
  } finally {
    await settleAfterRelease(first);
    await settleAfterRelease(second);
  }
}

(async () => {
  requireEnvironment();
  await boundary.assertDatabase();
  const observer = new Client({ connectionString: DATABASE_URL, application_name: "deposit-serialization-observer" });
  const blocker = new Client({ connectionString: DATABASE_URL, application_name: "deposit-serialization-blocker" });
  await observer.connect();
  await blocker.connect();
  try {
    const observerIsolation = (await observer.query("show transaction_isolation")).rows[0].transaction_isolation;
    const blockerIsolation = (await blocker.query("show transaction_isolation")).rows[0].transaction_isolation;
    console.log(`Server isolation assumption: SHOW transaction_isolation=${observerIsolation}; server and proof use the same database connection settings.`);
    if (observerIsolation !== "read committed" || blockerIsolation !== "read committed") {
      throw new Error(`unsupported transaction isolation: observer=${observerIsolation}, blocker=${blockerIsolation}; this proof requires READ COMMITTED`);
    }
    ok("transaction isolation was recorded and is READ COMMITTED");

    await serializedCheckpoint(observer, blocker);
    if (!EXPECT_DEFECT) await simultaneousHttpCheckpoint(observer);
  } finally {
    await blocker.query("rollback").catch(() => {});
    // Retain fixture receipts until the parent drops its uniquely owned DB.
    await blocker.end().catch(() => {});
    await observer.end().catch(() => {});
  }

  console.log(`\n==== deposit attribution serialization: ${passed} passed, ${failed} failed ====`);
  process.exit(failed ? 1 : 0);
})().catch((error) => {
  console.error("\nHARNESS ERROR:", error && error.stack ? error.stack : error);
  process.exit(1);
});
