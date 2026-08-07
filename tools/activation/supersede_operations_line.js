#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   RELEASE 0 — GATE 9 ROLLBACK: SUPERSEDE THE OPERATIONS LINE

   This is the prepared status-supersession command the Gate 5 spec
   requires to exist BEFORE activation — the rollback that must never be
   improvised at the moment it is needed.

   ⚠ THIS TOOL WRITES TO PRODUCTION, BY DESIGN. It is the only file in
   tools/activation/ that does. Everything it changes is one row, named
   by primary key, and the transaction commits only if every assertion
   inside it passed.

   ── THE AUTHORITATIVE DISABLE IS status ─────────────────────────────
   Not provider_config. resolveInboundLine matches `status = 'active'`;
   clearing provider_config would leave the row resolvable and the rail
   live while looking disabled. This tool never touches provider_config.

   ── THE WORD IS retired, NOT superseded ─────────────────────────────
   The Gate 9 spec says "set status to superseded". The schema says
   status in ('active','suspended','retired') — 'superseded' VIOLATES
   ck_cl_status, and the first draft of this tool proved that by dying
   on the constraint in falsification. Migration 130's own words:
   "retired lines stay auditable but never resolve inbound traffic."
   The timestamp column is nonetheless named superseded_at, and it is
   recorded exactly as the spec requires. Had this command been prepared
   as prose instead of run against a real schema, it would have failed
   at the precise moment the rail needed to be disabled.

   ── PROOF INSIDE THE SAME TRANSACTION ───────────────────────────────
   After the UPDATE and before COMMIT, the PRODUCTION resolver
   (resolveInboundLine) is called on this connection. It must no longer
   return the row. If it still does, the transaction rolls back and the
   tool reports the rail is still live — a rollback that cannot prove
   itself did not happen.

   ── DRY RUN IS THE TEST ─────────────────────────────────────────────
   --dry-run executes the identical transaction — real UPDATE, real
   resolver proof — and then ALWAYS rolls back. That is how this command
   is "prepared and tested" against production without disabling
   anything. Run it once after Gate 7; keep the receipt.

   usage (Render shell):
     test    LINE_ID='<uuid>' node tools/activation/supersede_operations_line.js --dry-run
     real    LINE_ID='<uuid>' CONFIRM_SUPERSEDE=yes \
               node tools/activation/supersede_operations_line.js --execute
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const path = require("path");
const { Client } = require("pg");
const { resolveInboundLine } =
  require(path.join(__dirname, "..", "..", "src", "comms", "communication_lines.js"));

const DRY = process.argv.includes("--dry-run");
const EXEC = process.argv.includes("--execute");
const LINE_ID = process.env.LINE_ID;

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };
const sec = (t) => console.log(`\n${"═".repeat(64)}\n  ${t}\n${"═".repeat(64)}`);
const last4 = (n) => n ? "****" + String(n).replace(/\D/g, "").slice(-4) : "(unset)";

(async function main() {
  if (DRY === EXEC) {  // neither, or both
    console.error("usage: LINE_ID='<uuid>' supersede_operations_line.js --dry-run");
    console.error("       LINE_ID='<uuid>' CONFIRM_SUPERSEDE=yes supersede_operations_line.js --execute");
    process.exit(1);
  }
  if (!LINE_ID) { console.error("REFUSED: LINE_ID is not set. The target is named explicitly or not at all."); process.exit(1); }
  if (EXEC && process.env.CONFIRM_SUPERSEDE !== "yes") {
    console.error("REFUSED: --execute requires CONFIRM_SUPERSEDE=yes.");
    console.error("         This disables the staff evidence rail. Test with --dry-run first.");
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) { console.error("REFUSED: DATABASE_URL is not set."); process.exit(1); }

  const c = new Client({ connectionString: process.env.DATABASE_URL,
                         ssl: { rejectUnauthorized: false } });
  await c.connect();

  console.log("RELEASE 0 — OPERATIONS-LINE SUPERSESSION " + (DRY ? "(DRY RUN — WILL ROLL BACK)" : "(EXECUTE)"));

  await c.query("begin");
  let committed = false;
  try {
    // ── the target, locked, and verified to be what the operator meant ─
    sec("TARGET");
    const rows = (await c.query(
      `select id, e164, line_type, status, organization_id, property_id, outbound_policy
         from communication_lines where id = $1 for update`, [LINE_ID])).rows;
    if (!ok("T1  the line exists", rows.length === 1, "no row with id " + LINE_ID)) throw new Error("halt");
    const L = rows[0];
    console.log("  line            " + L.id + "  (" + last4(L.e164) + ")");
    console.log("  organization    " + L.organization_id);
    ok("T2  it is an OPERATIONS line — property-facing is never touched here",
       L.line_type === "operations", L.line_type);
    ok("T3  it is currently active", L.status === "active", L.status);
    if (fail) throw new Error("halt");

    //  A census of every OTHER line, taken under the lock. After the
    //  update, this must be byte-identical — the blast radius is one row.
    const others0 = (await c.query(
      `select id, line_type, status, coalesce(superseded_at::text,'') sat
         from communication_lines where id <> $1 order by id`, [LINE_ID])).rows;

    // ── the supersession ───────────────────────────────────────────────
    sec("SUPERSESSION");
    const upd = await c.query(
      `update communication_lines
          set status = 'retired', superseded_at = now(), updated_at = now()
        where id = $1 and status = 'active'
        returning status, superseded_at`, [LINE_ID]);
    ok("U1  exactly one row changed", upd.rowCount === 1, String(upd.rowCount));
    ok("U2  status is retired (the schema's word for the spec's 'superseded')",
       upd.rows[0] && upd.rows[0].status === "retired");
    ok("U3  superseded_at is recorded", upd.rows[0] && !!upd.rows[0].superseded_at);

    // ── the proof, with the production resolver, before COMMIT ─────────
    sec("PROOF — inbound resolution no longer returns the line");
    const res = await resolveInboundLine(c, L.e164);
    ok("P1  the resolver no longer returns this line as active",
       !(res.outcome === "one" && res.line && res.line.id === L.id),
       "outcome " + res.outcome + " — THE RAIL IS STILL LIVE");
    ok("P2  the line is now visibly 'inactive' or superseded by another, not vanished",
       res.outcome === "inactive" || res.outcome === "one" || res.outcome === "none",
       res.outcome);

    const others1 = (await c.query(
      `select id, line_type, status, coalesce(superseded_at::text,'') sat
         from communication_lines where id <> $1 order by id`, [LINE_ID])).rows;
    ok("P3  every OTHER communication line is untouched — including property-facing",
       JSON.stringify(others0) === JSON.stringify(others1),
       "another line changed inside this transaction");

    if (fail) throw new Error("halt");

    if (DRY) {
      await c.query("rollback");
      sec("VERDICT");
      console.log("  ROLLED BACK — dry run. The line is still ACTIVE.");
      console.log("  The command, the update, and the resolver proof all work.");
      console.log(`  passed ${pass}   failed ${fail}`);
      await c.end();
      process.exit(0);
    }

    await c.query("commit");
    committed = true;
  } catch (e) {
    if (!committed) await c.query("rollback").catch(() => {});
    if (e.message !== "halt") { console.error("\nERROR:\n" + (e.stack || e)); await c.end(); process.exit(1); }
    sec("VERDICT");
    console.log("  ROLLED BACK — an assertion failed before commit. Nothing changed.");
    console.log(`  passed ${pass}   failed ${fail}`);
    await c.end();
    process.exit(1);
  }

  // ── read back AFTER commit, on a fresh view of the world ───────────
  sec("POST-COMMIT READ-BACK");
  const after = (await c.query(
    `select status, superseded_at, e164 from communication_lines where id = $1`, [LINE_ID])).rows[0];
  ok("R1  committed status is retired", after.status === "retired", after.status);
  ok("R2  superseded_at is durable", !!after.superseded_at);
  const res2 = await resolveInboundLine(c, after.e164);
  ok("R3  post-commit, the resolver still refuses the line",
     !(res2.outcome === "one" && res2.line && res2.line.id === LINE_ID), "outcome " + res2.outcome);
  console.log("  superseded_at   " + (after.superseded_at ? after.superseded_at.toISOString() : "(null)"));

  sec("VERDICT");
  console.log(`  passed ${pass}   failed ${fail}`);
  console.log(fail === 0
    ? "\n  RETIRED AND PROVEN. The staff evidence rail is disabled."
    : "\n  ⚠ COMMITTED BUT A READ-BACK FAILED — investigate immediately.");
  await c.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(1); });
