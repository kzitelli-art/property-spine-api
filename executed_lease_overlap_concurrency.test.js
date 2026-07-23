#!/usr/bin/env node
"use strict";

/**
 * OVERLAPPING OPERATIVE LEASE — REAL CONCURRENCY PROOF
 *
 * Uses TWO pg clients and an isolated, uniquely named schema. It proves the
 * spaces.id FOR UPDATE lock serializes concurrent confirmation attempts:
 * transaction B waits; transaction A inserts and commits; B resumes, sees the
 * new lease, and returns overlapping_operative_lease. The schema is dropped in
 * finally, so no Demo Building or product rows are read or written.
 *
 * Run in Render Shell from repo root:
 *   node executed_lease_overlap_concurrency.test.js
 */

const { Pool } = require("pg");
const crypto = require("crypto");
const svc = require("./executed_lease_service");
const { normalizeAndHash } = require("./proposed_terms_service");

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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required. Run this in the Render Shell.");
  process.exit(2);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 4,
});

const suffix = `${process.pid}_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
const schema = `ps_overlap_proof_${suffix}`;
const qSchema = `"${schema}"`;

const ids = {
  space: "11111111-1111-4111-8111-111111111111",
  unit: "22222222-2222-4222-8222-222222222222",
  property: "33333333-3333-4333-8333-333333333333",
  appA: "44444444-4444-4444-8444-444444444441",
  appB: "44444444-4444-4444-8444-444444444442",
  recA: "55555555-5555-4555-8555-555555555551",
  recB: "55555555-5555-4555-8555-555555555552",
  confA: "66666666-6666-4666-8666-666666666661",
  confB: "66666666-6666-4666-8666-666666666662",
  leaseA: "77777777-7777-4777-8777-777777777771",
  personA: "88888888-8888-4888-8888-888888888881",
};

async function setup(admin) {
  await admin.query(`create schema ${qSchema}`);
  await admin.query(`
    create table ${qSchema}.spaces (
      id uuid primary key,
      unit_id uuid not null
    );
    create table ${qSchema}.lease_applications (
      id uuid primary key,
      property_id uuid not null,
      unit_id uuid,
      proposed_terms_confirmation_id uuid
    );
    create table ${qSchema}.executed_lease_records (
      id uuid primary key,
      application_id uuid not null,
      record_state text not null,
      normalization_version int not null,
      payload_hash text not null,
      space_id uuid not null,
      lease_id uuid,
      rent numeric(12,2) not null,
      security_deposit numeric(12,2) not null,
      lease_start_date date not null,
      lease_end_date date not null,
      concession_status text not null
    );
    create table ${qSchema}.lease_packets (
      application_id uuid not null,
      status text not null,
      created_at timestamptz not null default now(),
      proposed_terms_confirmation_id uuid
    );
    create table ${qSchema}.application_proposed_terms_confirmations (
      id uuid primary key,
      rent numeric(12,2) not null,
      security_deposit numeric(12,2) not null,
      lease_start_date date not null,
      lease_end_date date not null,
      concession_status text not null,
      payload_hash text not null
    );
    create table ${qSchema}.leases (
      id uuid primary key,
      property_id uuid,
      application_id uuid,
      space_id uuid not null,
      lease_status text not null,
      start_date date not null,
      end_date date not null,
      tenant_ids uuid[] not null default '{}'::uuid[]
    );
    create table ${qSchema}.lease_economic_schedules (
      id uuid primary key,
      application_id uuid not null,
      status text not null,
      created_at timestamptz not null default now()
    );
    create table ${qSchema}.lease_economic_lines (
      schedule_id uuid not null,
      effective_month date,
      line_type text,
      amount numeric(12,2)
    );
  `);

  const terms = {
    rent: 1850,
    security_deposit: 1850,
    lease_start_date: "2026-08-01",
    lease_end_date: "2027-07-31",
    concession_status: "none",
  };
  const hash = normalizeAndHash(terms).payload_hash;

  await admin.query(
    `insert into ${qSchema}.spaces (id, unit_id) values ($1,$2)`,
    [ids.space, ids.unit]);
  await admin.query(
    `insert into ${qSchema}.lease_applications
       (id, property_id, unit_id, proposed_terms_confirmation_id)
     values ($1,$3,$4,$5), ($2,$3,$4,$6)`,
    [ids.appA, ids.appB, ids.property, ids.unit, ids.confA, ids.confB]);
  await admin.query(
    `insert into ${qSchema}.application_proposed_terms_confirmations
       (id, rent, security_deposit, lease_start_date, lease_end_date,
        concession_status, payload_hash)
     values ($1,1850,1850,'2026-08-01','2027-07-31','none',$3),
            ($2,1850,1850,'2026-08-01','2027-07-31','none',$3)`,
    [ids.confA, ids.confB, hash]);
  await admin.query(
    `insert into ${qSchema}.lease_packets
       (application_id,status,proposed_terms_confirmation_id)
     values ($1,'submitted',$3), ($2,'submitted',$4)`,
    [ids.appA, ids.appB, ids.confA, ids.confB]);
  await admin.query(
    `insert into ${qSchema}.executed_lease_records
       (id, application_id, record_state, normalization_version, payload_hash,
        space_id, lease_id, rent, security_deposit, lease_start_date,
        lease_end_date, concession_status)
     values ($1,$3,'verified',1,$5,$7,null,1850,1850,'2026-08-01','2027-07-31','none'),
            ($2,$4,'verified',1,$5,$7,null,1850,1850,'2026-08-01','2027-07-31','none')`,
    [ids.recA, ids.recB, ids.appA, ids.appB, hash, ids.property, ids.space]);
}

async function setSearchPath(client) {
  await client.query(`set local search_path to ${qSchema}, public`);
}

(async () => {
  console.log("\nOVERLAPPING OPERATIVE LEASE — REAL CONCURRENCY PROOF\n");
  const admin = await pool.connect();
  let a = null;
  let b = null;
  try {
    await setup(admin);
    a = await pool.connect();
    b = await pool.connect();

    await a.query("begin");
    await b.query("begin");
    await setSearchPath(a);
    await setSearchPath(b);

    const first = await svc.computeAdmissionBlockers(a, {
      application_id: ids.appA,
    });
    ok("transaction A sees a clean space before insert",
      !first.blockers.some((x) => x.code === "overlapping_operative_lease"));

    let bSettled = false;
    const secondPromise = svc.computeAdmissionBlockers(b, {
      application_id: ids.appB,
    }).then((value) => {
      bSettled = true;
      return value;
    });

    await sleep(300);
    ok("transaction B waits on the exact space lock", bSettled === false);

    await a.query(
      `insert into leases
         (id, property_id, application_id, space_id, lease_status,
          start_date, end_date, tenant_ids)
       values ($1,$2,$3,$4,'pending','2026-08-01','2027-07-31',$5::uuid[])`,
      [ids.leaseA, ids.property, ids.appA, ids.space, [ids.personA]]);
    await a.query("commit");

    const second = await Promise.race([
      secondPromise,
      sleep(5000).then(() => { throw new Error("transaction B did not resume after A committed"); }),
    ]);
    const overlap = second.blockers.find((x) =>
      x.code === "overlapping_operative_lease");
    ok("transaction B resumes after A commits", bSettled === true);
    ok("transaction B sees the newly committed overlapping lease",
      !!overlap && overlap.competing.some((x) => x.lease_id === ids.leaseA));

    await b.query("rollback");
    const count = await admin.query(
      `select count(*)::int as n from ${qSchema}.leases`);
    ok("exactly one lease exists in the isolated proof schema",
      count.rows[0].n === 1, String(count.rows[0].n));

    console.log("\n" + "-".repeat(62));
    console.log((fail === 0 ? "ALL PASS" : "FAILURES PRESENT") +
      `   ${pass}/${pass + fail}`);
    process.exitCode = fail === 0 ? 0 : 1;
  } finally {
    for (const client of [a, b]) {
      if (!client) continue;
      try { await client.query("rollback"); } catch (_) {}
      client.release();
    }
    try { await admin.query(`drop schema if exists ${qSchema} cascade`); } catch (e) {
      console.error("cleanup warning:", e.message);
      process.exitCode = 1;
    }
    admin.release();
    await pool.end();
  }
})().catch(async (error) => {
  console.error("concurrency proof error:", error);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
