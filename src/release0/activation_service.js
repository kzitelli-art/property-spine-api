/* ════════════════════════════════════════════════════════════════════
   release0/activation_service.js — THE cutover activation transaction.

   Step 7 records two facts, once, together:

     1  WHEN Release 0's proof rail became authoritative
     2  WHICH terminal work orders predate it and carry no evaluation

   Fact 2 is only meaningful relative to fact 1, and fact 1 is only safe if
   fact 2 was taken against the population that actually existed. So they
   are ONE transaction. A partial cutover — an instant with no inventory,
   or an inventory attributed to no instant — is worse than none, because
   the reader would then class real history as a defect the system caused
   itself.

   ── THE INSTANT IS CAPTURED, NEVER DERIVED ──────────────────────────

   §19 Ruling 1, and §6.1 calls it "the single most important line in the
   release": the boundary is the instant captured at STEP 6 — after the
   legacy writer can no longer create `closed` rows and the canonical
   writer is verified live.

   `now()` at insertion time is NOT that instant. Between step 6 and step 7
   a `closed` row could be written by a draining instance; a boundary taken
   at insertion would place that row BEFORE the cutover and render it
   legacy_indeterminate — hiding a defect the release itself caused. So
   `activated_at` is a required argument, and this module never reads a
   clock.

   ── BOTH DIRECTIONS, OR IT PROVES NOTHING ───────────────────────────

   §6.2: compare the census set against the live population BOTH ways.

     unexpected = live \ expected    appeared since the census
     missing    = expected \ live    disappeared since the census

   A COUNT IS NEVER SUFFICIENT. One row completed and one deleted between
   census and activation produce a matching count over an entirely
   different population, and the activation would commit a silently wrong
   inventory. Both lists are reported — the first difference does not stop
   the comparison, because an operator deciding whether to re-census needs
   to see the whole shape of the drift.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const SERVICE_NAME = "release0.activation_service";

/*  The census query, in ONE place. tools/step7/census.js imports it rather
 *  than restating it: two copies of "what counts as legacy" is how the
 *  expected set and the live set come to disagree for a reason that is not
 *  drift at all. */
const LEGACY_TERMINAL_SET_SQL = `
  select w.id as work_order_id, w.property_id, w.status,
         (w.completion_photo is not null) as had_column_photo,
         (w.completion_note  is not null) as had_column_note
    from work_orders w
   where w.status in ('complete','closed')
     and not exists (select 1 from work_order_proof_evaluations e
                      where e.work_order_id = w.id
                        and e.property_id   = w.property_id)
   order by w.property_id, w.id`;

function activationError(code, message, extra = {}) {
  const e = new Error(message); e.code = code; Object.assign(e, extra); return e;
}

/*  A row's identity for set comparison. property_id is part of it because
 *  the inventory's primary key is (work_order_id, property_id) — comparing
 *  on work_order_id alone would silently accept a row that moved property,
 *  which the composite FK forbids but which the COMPARISON should not
 *  quietly tolerate either. */
const key = (r) => `${r.work_order_id}::${r.property_id}`;

/*  Read the live set. Exported so a caller can look before it leaps
 *  without duplicating the definition. */
async function readLegacyTerminalSet(client) {
  const { rows } = await client.query(LEGACY_TERMINAL_SET_SQL);
  return rows;
}

/*  Fails closed if migration 137 has not been applied. Step 7 cannot be
 *  attempted against a schema with nowhere to record it, and the failure
 *  must name that rather than surfacing as a missing-relation error. */
async function activationSchemaPresent(client) {
  const { rows } = await client.query(
    `select count(*)::int n from information_schema.tables
      where table_schema = 'public'
        and table_name in ('release_0_activation_history',
                           'release_0_legacy_cutover_inventory')`);
  return rows[0].n === 2;
}

/**
 * Record the cutover. ONE transaction, opened by the caller.
 *
 * @param client         an open transaction. This function never commits.
 * @param activated_at   the instant CAPTURED AT STEP 6. Required. Never now().
 * @param captured_by    who/what captured it — an audit fact, not decoration.
 * @param expected       the census set, exactly as the census returned it.
 * @param supersedes_id  null for genesis; the current head for a correction.
 * @param reason         required when superseding.
 */
/*  ── THE EXPECTED CONTAINMENT BOUNDARY ──────────────────────────────
 *
 *  Not a trigger name. These are the clauses the predicate MUST contain
 *  for the activation to be safe, each tied to an attack that broke an
 *  earlier revision (tools/step12/falsify_containment.js):
 *
 *    release_0_activation_current       inert before the cutover
 *    release_0_legacy_cutover_inventory legacy history is exempt
 *    work_order_proof_evaluation_head   a governed completion is admitted
 *    = 'satisfied'                      A1/A2 — a FAILED evaluation is not
 *                                       a completion
 *    R0002                              A3 — inventoried legacy may not
 *                                       leave the terminal state
 *
 *  Checking substance rather than a digest is deliberate: a digest would
 *  make every comment edit in migration 140 a production incident, and
 *  this is a safety precondition, not a change-control mechanism.
 */
const GUARD_FUNCTION = "release_0_assert_completion_truth";
const GUARD_CLAUSES = [
  "release_0_activation_current",
  "release_0_legacy_cutover_inventory",
  "work_order_proof_evaluation_head",
  "'satisfied'",
  "R0002",
];
const GUARD_TRIGGERS = [
  { name: "assert_completion_truth_ins", table: "work_orders" },
  { name: "assert_completion_truth_upd", table: "work_orders" },
  { name: "assert_completion_truth_eval", table: "work_order_proof_evaluations" },
];

async function assertContainmentGuardPresent(client) {
  const fn = (await client.query(
    `select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = $1`, [GUARD_FUNCTION])).rows[0];
  if (!fn) {
    throw activationError("GUARD_ABSENT",
      `migration 140 is not applied: public.${GUARD_FUNCTION}() does not exist. ` +
      "Without it, any writer can commit a terminal work order with no proof the " +
      "moment this activation lands, and the activation cannot be undone.");
  }
  const missing = GUARD_CLAUSES.filter((cl) => !fn.prosrc.includes(cl));
  if (missing.length) {
    throw activationError("GUARD_STALE",
      `public.${GUARD_FUNCTION}() exists but does not enforce: ${missing.join(", ")}. ` +
      "A guard with the right NAME and the wrong body is worse than none, because it " +
      "reads as protection. Re-apply migration 140.");
  }

  const live = (await client.query(
    `select t.tgname, k.relname, t.tgdeferrable, t.tginitdeferred, t.tgconstraint
       from pg_trigger t join pg_class k on k.oid = t.tgrelid
      where not t.tgisinternal and t.tgname = any($1::text[])`,
    [GUARD_TRIGGERS.map((g) => g.name)])).rows;
  for (const want of GUARD_TRIGGERS) {
    const got = live.find((r) => r.tgname === want.name && r.relname === want.table);
    if (!got) {
      throw activationError("GUARD_ABSENT",
        `the containment trigger ${want.name} is missing from ${want.table}. ` +
        "Re-apply migration 140 before activating.");
    }
    if (!got.tgdeferrable || !got.tginitdeferred) {
      throw activationError("GUARD_STALE",
        `${want.name} is not DEFERRABLE INITIALLY DEFERRED. Made immediate it judges ` +
        "each statement instead of the committed state, and would refuse the canonical " +
        "writer depending on its statement order.");
    }
  }
}

async function recordActivation(client, {
  activated_at, captured_by, expected,
  captured_at_step = "step_6", supersedes_id = null, reason = null,
} = {}) {
  if (!await activationSchemaPresent(client)) {
    throw activationError("SCHEMA_MISSING",
      "migration 137 is not applied — there is nowhere to record a cutover");
  }

  /*  ── THE CONTAINMENT BOUNDARY MUST ALREADY EXIST (migration 140) ────
   *
   *  The activation is the ONE irreversible act in this release: the
   *  history and inventory tables are append-only. The instant it
   *  commits, every terminal-without-proof write becomes a manufactured
   *  accountability obligation. Detecting a missing guard AFTERWARDS is
   *  too late, so the activation refuses to exist without it.
   *
   *  It binds to the PREDICATE'S DEFINITION, not to a trigger name. A
   *  stale or hollowed-out function with the right name would otherwise
   *  satisfy the precondition — and a name is exactly what an
   *  accidental re-run of an older migration would restore.  */
  await assertContainmentGuardPresent(client);

  /*  ── A4: SERIALIZE AGAINST IN-FLIGHT WRITERS ────────────────────────
   *
   *  A transaction that opened BEFORE the cutover, wrote a terminal work
   *  order, and commits AFTER it, is judged by the deferred guard through
   *  its OWN snapshot. At READ COMMITTED the guard's read is fresh and
   *  refuses correctly. At REPEATABLE READ the snapshot is frozen before
   *  the activation existed, so the guard sees the pre-cutover world and
   *  the write COMMITS. Measured, not theorised — it committed.
   *
   *  No SELECT can escape its own snapshot, so this is not fixable inside
   *  the trigger. It is closed from the other side, and the other side is
   *  the right one: the activation is a single deliberate act we control.
   *
   *  SHARE ROW EXCLUSIVE conflicts with the ROW EXCLUSIVE that every
   *  INSERT/UPDATE takes, so this statement cannot complete while any
   *  work_orders writer is in flight. Either that writer commits first —
   *  and its new terminal row makes the exact-set comparison below FAIL,
   *  which is the correct refusal — or it rolls back. There is no third
   *  outcome, and no window between the census and this lock.
   *
   *  lock_timeout is set LOCAL and low: a cutover that hangs behind a
   *  long-running transaction must fail loudly and be retried, never
   *  block production writes indefinitely while somebody waits.  */
  await client.query("set local lock_timeout = '5s'");
  try {
    await client.query("lock table public.work_orders in share row exclusive mode");
  } catch (e) {
    throw activationError("WRITERS_IN_FLIGHT",
      "could not serialize against work_orders writers within 5s: " + (e.code || e.message) +
      ". A transaction is holding a write lock. Activating past it would leave a " +
      "window in which its terminal rows escape the containment guard. Wait for it " +
      "to finish and re-run the census.");
  }

  //  ── THE INSTANT ────────────────────────────────────────────────────
  if (activated_at === undefined || activated_at === null || activated_at === "") {
    throw activationError("BAD_INPUT",
      "activated_at is required and must be the instant captured at step 6. " +
      "This service never reads a clock — see §19 Ruling 1.");
  }
  const instant = activated_at instanceof Date ? activated_at : new Date(activated_at);
  if (Number.isNaN(instant.getTime())) {
    throw activationError("BAD_INPUT",
      `activated_at is not a valid instant: ${JSON.stringify(activated_at)}`);
  }
  /*  A boundary later than the cutover transaction would class rows written
   *  between the two as pre-cutover legacy. Refused rather than clamped: a
   *  clamp would make the persisted instant differ from the captured one,
   *  which is the exact substitution this module exists to prevent.
   *
   *  NOTE ON `now()`: in PostgreSQL it is the TRANSACTION START time, not
   *  the statement time. So this asks "did the instant precede this
   *  transaction", which is stricter than "is it in the future" and is the
   *  ordering §19 Ruling 1 actually wants — step 6 happens, then step 7's
   *  transaction opens. A legitimate captured instant is minutes older.
   *
   *  This turns out to be a SECOND, independent guard against a derived
   *  instant: `new Date()` inside the transaction is always after its start,
   *  so a service that reached for the clock would be refused here even if
   *  the required-argument check above were removed. That is a happy
   *  accident, named rather than relied on — falsify_step7.js has to remove
   *  BOTH to demonstrate the failure mode.  */
  const txStart = (await client.query(`select now() as t`)).rows[0].t;
  if (instant.getTime() > new Date(txStart).getTime()) {
    throw activationError("BAD_INPUT",
      `activated_at (${instant.toISOString()}) is not earlier than this ` +
      `transaction's start (${new Date(txStart).toISOString()}). A boundary ahead ` +
      `of the cutover would class later writes as pre-cutover legacy.`);
  }

  if (!captured_by || !String(captured_by).trim()) {
    throw activationError("BAD_INPUT", "captured_by is required — an unattributed cutover is not a record");
  }
  if (!Array.isArray(expected)) {
    throw activationError("BAD_INPUT",
      "expected must be the census set (an array), supplied by the caller. " +
      "Deriving it here would compare the live population against itself.");
  }
  if (supersedes_id && (!reason || !String(reason).trim())) {
    throw activationError("BAD_INPUT", "a superseding activation requires a non-empty reason");
  }

  //  ── THE COMPARISON, INSIDE THE TRANSACTION ─────────────────────────
  //  Read AFTER the transaction is open so the set cannot move underneath
  //  the insert that follows it.
  const live = await readLegacyTerminalSet(client);
  const liveKeys = new Set(live.map(key));
  const expectedKeys = new Set(expected.map(key));

  const unexpected = live.filter((r) => !expectedKeys.has(key(r)));
  const missing = expected.filter((r) => !liveKeys.has(key(r)));

  if (unexpected.length || missing.length) {
    //  BOTH lists, always. Reporting only the first difference would hide
    //  the compensating-change case that makes counts useless.
    throw activationError("CENSUS_DRIFT",
      `the live population no longer matches the census: ` +
      `${unexpected.length} unexpected, ${missing.length} missing`,
      { unexpected, missing,
        note: "re-run the census and re-authorize. Do NOT widen the comparison." });
  }

  //  ── FACT 1 ─────────────────────────────────────────────────────────
  //  A second genesis is refused by uq_r0ah_genesis and by r0ah_chain_guard;
  //  a forked correction by uq_r0ah_one_successor. Those refusals are the
  //  idempotency contract and are deliberately NOT pre-checked here — a
  //  read-then-write check is a race, and the database's is not.
  const activation = (await client.query(
    `insert into release_0_activation_history
       (activated_at, captured_at_step, captured_by, supersedes_id, reason)
     values ($1,$2,$3,$4,$5) returning *`,
    [instant.toISOString(), captured_at_step, captured_by, supersedes_id, reason])).rows[0];

  //  ── FACT 2 ─────────────────────────────────────────────────────────
  //  Attributed to THIS activation. The composite FK into
  //  work_orders(id, property_id) makes a mismatched pair unrepresentable.
  let inserted = 0;
  for (const r of expected) {
    // eslint-disable-next-line no-await-in-loop
    const res = await client.query(
      `insert into release_0_legacy_cutover_inventory
         (work_order_id, property_id, status_at_cutover, had_column_photo,
          had_column_note, activation_id)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (work_order_id, property_id) do nothing`,
      [r.work_order_id, r.property_id, r.status, !!r.had_column_photo,
       !!r.had_column_note, activation.id]);
    inserted += res.rowCount;
  }

  return {
    outcome: supersedes_id ? "superseded" : "activated",
    activation,
    inventory: { expected: expected.length, inserted,
                 //  A row already present from an earlier partial attempt is
                 //  reported rather than smoothed over.
                 already_present: expected.length - inserted },
    comparison: { live: live.length, expected: expected.length,
                  unexpected: 0, missing: 0 },
    service: SERVICE_NAME,
  };
}

module.exports = {
  SERVICE_NAME, LEGACY_TERMINAL_SET_SQL,
  readLegacyTerminalSet, activationSchemaPresent, recordActivation, activationError,
};
