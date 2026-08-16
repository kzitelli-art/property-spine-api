#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   forward_leasing_ledger.db.js — the 160-bed Forward Leasing ledger,
   against a real Postgres holding the real Skyline import.

   The claim under test is NOT "the numbers are right". It is:

     · the headline is DERIVED from lease_status, never from a flag
     · signed and pending never merge
     · an unknown rent is NULL and is COUNTED, never coerced to 0
     · a term shape is computed from lease dates, never stored
     · this is a FUTURE-CYCLE read and not occupancy
     · one changed lease moves it with no writer touched

   Run:
     HARNESS_DATABASE_URL=… node tests/forward_leasing_ledger.db.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";
const { Pool } = require("pg");
const receipt = require("./_run_receipt");
const { forwardLeasingPosition, _internal } = require("../src/leasing/forward_leasing_read");
const { datedPropertyPositions } = require("../src/tenancy/dated_positions");

const HARNESS = __filename;
const EXPECTED = 20;
let passed = 0, failed = 0, ran = 0;
const ok = (label, cond, detail) => {
  ran++;
  if (cond) { passed++; console.log("  ok    " + label); }
  else { failed++; console.log("  FAIL  " + label + (detail ? "\n        " + detail : "")); }
};

(async () => {
  //  ⚠ PASS THE URL TO begin(). Without it the banner prints "this harness
  //  needs no database" while the harness is connected to one — a receipt
  //  that misdescribes what it ran against is exactly the kind of green
  //  this repo does not accept.
  const HARNESS_URL = receipt.harnessConnectionString();
  receipt.begin(HARNESS, { url: HARNESS_URL, expected: EXPECTED });
  const pool = new Pool({ connectionString: HARNESS_URL });

  const prop = (await pool.query(
    `select p.id, count(s.id)::int as beds
       from properties p join units u on u.property_id = p.id join spaces s on s.unit_id = u.id
      group by p.id having count(s.id) > 20 order by count(s.id) desc limit 1`)).rows[0];
  if (!prop) { console.log("  no property with enough inventory in this database"); process.exit(2); }

  const CS = "2026-08-01", CE = "2027-07-31";
  const r = await forwardLeasingPosition(pool, {
    property_id: prop.id, cycle_start: CS, cycle_end: CE, cycle_label: "2026–27" });

  // ── 1. THE DENOMINATOR IS CANONICAL INVENTORY ────────────────────
  ok("the denominator is every rentable position, from inventory",
    r.headline.positions === prop.beds && r.ledger.length === prop.beds,
    `read ${r.headline.positions} / ledger ${r.ledger.length} vs inventory ${prop.beds}`);

  // ── 2. THE HEADLINE BALANCES, WITHOUT A RESIDUE BUCKET ───────────
  const sum = r.headline.signed + r.headline.pending + r.headline.remaining + r.headline.unresolved;
  ok("signed + pending + remaining + unresolved = every position",
    sum === r.headline.positions, `${sum} ≠ ${r.headline.positions}`);
  ok("committed is exactly signed + pending, not a third count",
    r.headline.committed === r.headline.signed + r.headline.pending);

  // ── 3. SIGNED ≠ PENDING, STRUCTURALLY ────────────────────────────
  //  A read that merges them cannot answer "how much is ACTUALLY signed",
  //  which is the question the operator headline hides by design.
  ok("signed and pending are separate counts",
    Object.prototype.hasOwnProperty.call(r.headline, "signed") &&
    Object.prototype.hasOwnProperty.call(r.headline, "pending"));
  ok("signed and pending rent are separate money",
    Object.prototype.hasOwnProperty.call(r.economics, "signed_rent") &&
    Object.prototype.hasOwnProperty.call(r.economics, "pending_rent") &&
    r.economics.committed_rent === r.economics.signed_rent + r.economics.pending_rent);
  ok("no ledger row is both signed and pending",
    r.ledger.every((x) => ["signed", "pending", "remaining", "unresolved"].includes(x.commitment_state)));

  // ── 4. UNKNOWN RENT IS NULL AND COUNTED, NEVER ZERO ──────────────
  const zeroRent = r.ledger.filter((x) => x.contracted_rent === 0);
  ok("no ledger row reports a contracted rent of 0",
    zeroRent.length === 0, `${zeroRent.length} rows carry rent 0 instead of null`);
  const committedRows = r.ledger.filter((x) => x.commitment_state === "signed" || x.commitment_state === "pending");
  ok("every committed row states whether its rent is established",
    committedRows.every((x) => x.rent_state === "established" || x.rent_state === "NOT_ESTABLISHED"));
  ok("the unknown-rent count matches the rows",
    r.economics.rent_not_established === committedRows.filter((x) => x.rent_state === "NOT_ESTABLISHED").length);
  ok("economics.complete is false while any committed rent is unknown",
    r.economics.complete === (r.economics.rent_not_established === 0));
  //  THE ONE THAT MATTERS ON THIS DATA. 121 of 122 cycle leases carry no
  //  rent, so a read that coerced null→0 would publish a confident total
  //  that is wrong by the entire amount.
  ok("a committed total of 0 is accompanied by the count that explains it",
    r.economics.committed_rent > 0 || r.economics.rent_not_established > 0 ||
    r.headline.committed === 0);

  // ── 5. TERM SHAPE IS DERIVED, NOT STORED ─────────────────────────
  const cols = (await pool.query(
    `select column_name from information_schema.columns where table_name='leases'`)).rows.map((x) => x.column_name);
  ok("no `semester`/`term_shape`/`cohort` column was added to leases",
    !cols.some((c) => /semester|term_shape|cohort|preleas/i.test(c)),
    cols.filter((c) => /semester|term_shape|cohort|preleas/i.test(c)).join(", "));
  ok("term shape is computed from the lease end date",
    _internal.termShape({ end_date: "2026-12-28" }, CS, CE) === "first_half_only" &&
    _internal.termShape({ end_date: "2027-07-26" }, CS, CE) === "full_cycle" &&
    _internal.termShape({ end_date: null }, CS, CE) === "open_ended");
  ok("every committed row carries a term shape; no remaining row does",
    committedRows.every((x) => x.term_shape) &&
    r.ledger.filter((x) => x.commitment_state === "remaining").every((x) => x.term_shape === null));

  // ── 6. NO SECOND STORE ───────────────────────────────────────────
  const tables = (await pool.query(
    `select table_name from information_schema.tables where table_schema='public'`)).rows.map((x) => x.table_name);
  ok("no forward-leasing or preleased table exists",
    !tables.some((t) => /preleas|forward_leas|leasing_tracker/i.test(t)),
    tables.filter((t) => /preleas|forward_leas|leasing_tracker/i.test(t)).join(", "));

  // ── 7. THE BASIS TRAVELS WITH THE NUMBER ─────────────────────────
  ok("the payload names the commitment basis and its status",
    r.commitment_basis && /overlap/i.test(r.commitment_basis.rule) &&
    /not frozen/i.test(r.commitment_basis.status) && r.commitment_basis.freezes_when);
  ok("the payload says what it does NOT establish, including occupancy",
    Array.isArray(r.does_not_establish) &&
    r.does_not_establish.some((s) => /occupanc/i.test(s)) &&
    r.does_not_establish.some((s) => /pace/i.test(s)));

  // ── 8. IT IS NOT OCCUPANCY ───────────────────────────────────────
  //  Proved by DIFFERENCE, not by assertion: the same property on the
  //  same day gives a different number for "occupied today" than for
  //  "committed for next cycle", and a read that conflated them could
  //  not.
  const dp = await datedPropertyPositions(pool, { property_id: prop.id, as_of: "2026-08-16" });
  const occupiedToday = dp.positions.filter((p) => p.tenancy_state === "contractually_occupied").length;
  ok("the forward committed count is computed independently of today's occupancy",
    typeof occupiedToday === "number" &&
    (occupiedToday !== r.headline.committed || r.headline.remaining !== dp.positions.length - occupiedToday),
    `occupied today ${occupiedToday} vs committed ${r.headline.committed} — if these are ` +
    `structurally identical the read is answering the wrong question`);

  // ── 9. ONE CHANGED LEASE MOVES IT, WITH NO WRITER ────────────────
  const target = r.ledger.find((x) => x.commitment_state === "signed");
  const before = r.headline.committed;
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `update leases set lease_status='cancelled'
        where space_id=$1 and lease_status not in ('cancelled','rescinded','void','superseded','terminated','expired')`,
      [target.space_id]);
    const after = await forwardLeasingPosition(client, {
      property_id: prop.id, cycle_start: CS, cycle_end: CE });
    ok("cancelling a lease moves the committed count with no forward writer",
      after.headline.committed === before - 1,
      `${before} → ${after.headline.committed}, expected ${before - 1}`);
    ok("…and that bed becomes remaining, not merely uncounted",
      after.ledger.find((x) => String(x.space_id) === String(target.space_id)).commitment_state === "remaining");
    await client.query("rollback");
  } finally { client.release(); }

  await pool.end();
  process.exit(receipt.complete({ harness: HARNESS, passed, failed, expectedAtLeast: EXPECTED }));
})().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
