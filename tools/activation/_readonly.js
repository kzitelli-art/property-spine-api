/* ════════════════════════════════════════════════════════════════════
   PROVEN READ-ONLY, FOR TOOLS THAT RUN AGAINST PRODUCTION

   The activation tools connect to the production DATABASE_URL. Three of
   them read and never write. "Reads and never writes" is a claim about
   source code; this makes it a property of the open transaction, proven
   by attempting a write and being refused.

   Lifted from tools/property_line_preflight.js, which carries the two
   lessons this repo paid for:

     · THE PROBE MUST RUN BEFORE ANY READ. A safety check that runs after
       the data has already been read is a report, not a guard.

     · THE PROBE MUST NOT POISON THE TRANSACTION. A failed statement
       aborts the whole block, so every later read dies with "current
       transaction is aborted" — a read-only smoke once aborted itself
       and then reported nothing, which read as a clean run. The
       SAVEPOINT is what makes the probe survivable.

   ── WHY THE ISOLATION LEVEL IS PINNED ───────────────────────────────
   signature_controls.js holds this transaction open while production
   writes rows through its own governed route, and then counts them. At
   REPEATABLE READ the census would be frozen at the opening snapshot,
   every control would report "wrote nothing", and a PASSING security
   control would look like a failing one. That depends on the server's
   default_transaction_isolation — a setting no tool here controls. So it
   is stated rather than inherited.

   READ COMMITTED does NOT weaken the guarantee: read-only is enforced by
   the transaction's read-only mode, not by its isolation level.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

/**
 * Opens a transaction that is proven unable to write, before it reads.
 * Never throws. Returns {ok:true} or {ok:false, reason} — the caller
 * refuses in its own voice, where the operator is already reading.
 */
async function beginProvenReadOnly(client, probeName) {
  const probe = "__ro_probe_" + String(probeName || "activation").replace(/[^a-z0-9_]/gi, "_");
  try {
    await client.query("begin isolation level read committed read only");
  } catch (e) {
    return { ok: false, reason: "could not open a read-only transaction: " + (e.code || e.message) };
  }

  let writable = false;
  try {
    await client.query("savepoint " + probe);
    try {
      //  A temporary table is the least invasive write there is: it
      //  touches no application table, and in a read-only transaction
      //  PostgreSQL refuses it outright.
      await client.query(`create temporary table ${probe} (x int)`);
      writable = true;
    } catch (_) { /* expected — this is the refusal we are proving */ }
    await client.query("rollback to savepoint " + probe);
  } catch (e) {
    //  The savepoint machinery itself failed. Refuse. A check that could
    //  not run is not a check that passed — this repo has already shipped
    //  one guard that reported a SAVEPOINT error as its own refusal and
    //  went green without the probe ever executing.
    return { ok: false, reason: "the write probe could not be run: " + (e.code || e.message) };
  }

  if (writable) {
    return { ok: false, reason: "this transaction ACCEPTED a write — it is not read-only" };
  }
  return { ok: true };
}

/**
 * Prints the standard refusal and closes the client. Returns the exit
 * code so callers can `process.exit(await refuse(...))`.
 */
async function refuseNotReadOnly(client, reason) {
  console.error("\n  ✗ REFUSED — read-only could not be proven.");
  console.error("    " + reason);
  console.error("    Nothing was read. This tool does not run against a database");
  console.error("    it has not proven it cannot write to.\n");
  try { await client.query("rollback"); } catch (_) {}
  try { await client.end(); } catch (_) {}
  return 2;
}

module.exports = { beginProvenReadOnly, refuseNotReadOnly };
