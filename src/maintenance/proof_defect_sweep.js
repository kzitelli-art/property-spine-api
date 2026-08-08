/* ════════════════════════════════════════════════════════════════════
   maintenance/proof_defect_sweep.js — the scheduled §4.2 sweep.

   Scans for terminal work orders with no proof evaluation and no cutover
   inventory row, and raises the defect obligation through the canonical
   service. It CREATES ONLY: it never updates, never closes, never touches
   a work order.

   ── IT DOES NOT OWN THE PREDICATE. THE READER DOES. ─────────────────

   §3.2.0 requires that the sweep and the reader agree about which rows
   are visible, "so neither can consider a row a defect that the other
   treats as not-yet-due."

   Sharing a SQL string between them would be a copy that can drift. So
   the SQL below is only a PREFILTER — a cheap way to avoid deriving state
   for every work order in the property — and every candidate it produces
   is then confirmed through `deriveProofState`, the same function the
   reader calls. A row the reader would call `legacy_indeterminate` is
   dropped by that confirmation even if the prefilter listed it.

   The prefilter can therefore be WRONG without being unsafe. It can only
   ever cost work, never correctness.

   ── IT REFUSES WITHOUT AN ACTIVATION ────────────────────────────────

   Without a cutover inventory there is nothing separating legacy history
   from a real defect, and a sweep run then would raise an obligation
   against EVERY terminal work order in the property. That is the same
   failure the reader avoids by reporting `unavailable`, except a sweep
   would write it down. It refuses instead.

   ── AND WITHOUT THE IDEMPOTENCY INDEX ───────────────────────────────

   Migration 138 is what makes a duplicate unrepresentable. Without it the
   sweep would insert a fresh obligation on every run and the failure
   would be silent — a growing pile for one work order. Fail closed.

   ── PARTIAL RUNS ARE FINE ───────────────────────────────────────────

   §4.2: a failed run is not compensated or replayed. The next run
   re-derives the same population and converges. Each row is raised in its
   OWN transaction so one bad row cannot roll back the rows before it, and
   the run reports what it could not do rather than throwing the whole
   result away.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const proofState = require("../release0/proof_state.js");
const { raiseProofEvaluationDefect, defectIndexPresent, OBLIGATION_TYPE } =
  require("./proof_defect_service.js");

const SWEEP_NAME = "maintenance.proof_defect_sweep";

/*  PREFILTER ONLY — see the header. Deliberately expressed as the cheap
 *  version of the question, because the expensive authoritative version
 *  runs per candidate immediately afterwards. */
const CANDIDATE_SQL = `
  select w.id as work_order_id, w.property_id, w.unit_id, w.status
    from work_orders w
   where w.status in ('complete','closed')
     and ($1::uuid is null or w.property_id = $1::uuid)
     and not exists (select 1 from work_order_proof_evaluation_head e
                      where e.work_order_id = w.id and e.property_id = w.property_id)
     and not exists (select 1 from release_0_legacy_cutover_inventory i
                      where i.work_order_id = w.id and i.property_id = w.property_id)
   order by w.property_id, w.id
   limit $2`;

/**
 * Run one sweep.
 *
 * @param pool        a pg Pool. Each row gets its own transaction.
 * @param propertyId  optional scope. null sweeps every property.
 * @param limit       safety bound on one run's work.
 * @param dryRun      derive and report, write nothing. The default is TRUE:
 *                    a sweep that writes unless told not to is one
 *                    mis-invocation away from raising obligations against
 *                    production.
 */
async function runProofDefectSweep(pool, {
  propertyId = null, limit = 500, dryRun = true, detectedBy = SWEEP_NAME,
} = {}) {
  const started = { candidates: 0, confirmed: 0, raised: 0, already_open: 0,
                    skipped_not_defect: 0, failed: [] };

  const probe = await pool.connect();
  let candidates;
  try {
    if (!await defectIndexPresent(probe)) {
      throw Object.assign(new Error(
        "uq_obl_proof_eval_missing_open is absent — migration 138 has not been " +
        "applied. Without it every run would insert a duplicate obligation and " +
        "the failure would be silent."), { code: "IDEMPOTENCY_INDEX_MISSING" });
    }
    const authority = await proofState.activationAuthority(probe);
    if (!authority.available) {
      throw Object.assign(new Error(
        `no cutover activation (${authority.reason_code}) — without the inventory ` +
        "there is nothing separating legacy history from a defect, and a sweep " +
        "would raise an obligation against every terminal work order"),
        { code: "ACTIVATION_ABSENT" });
    }
    started.authority = authority;
    candidates = (await probe.query(CANDIDATE_SQL, [propertyId, limit])).rows;
    started.candidates = candidates.length;
  } finally { probe.release(); }

  for (const cand of candidates) {
    const client = await pool.connect();
    try {
      await client.query("begin");

      /*  THE AUTHORITATIVE CHECK, through the reader's own function, and
       *  re-derived inside THIS transaction rather than trusting the
       *  prefilter's snapshot. A work order that gained an evaluation
       *  between the two is no longer a defect, and raising one for it
       *  would be the sweep inventing an accountability fact. */
      const workOrder = (await client.query(
        `select * from work_orders where id = $1 and property_id = $2`,
        [cand.work_order_id, cand.property_id])).rows[0];
      if (!workOrder) { await client.query("rollback"); continue; }

      const authority = await proofState.activationAuthority(client);
      const derived = await proofState.deriveProofState(client, { workOrder, authority });

      if (derived.read_status !== "ok" || derived.state !== "missing_evaluation_defect") {
        //  legacy_indeterminate, satisfied, not_satisfied, or an
        //  unavailable read. NONE of them is a defect. Counted so a run
        //  that skips everything is visible rather than silent.
        started.skipped_not_defect++;
        await client.query("rollback");
        continue;
      }
      started.confirmed++;

      if (dryRun) { await client.query("rollback"); continue; }

      const out = await raiseProofEvaluationDefect(client, {
        work_order_id: cand.work_order_id, property_id: cand.property_id,
        unit_id: cand.unit_id, detected_by: detectedBy,
      });
      await client.query("commit");
      if (out.outcome === "raised") started.raised++; else started.already_open++;
    } catch (e) {
      await client.query("rollback").catch(() => {});
      //  Recorded, not thrown. §4.2: a partial run leaves correct rows and
      //  re-attempts the rest on the next run. Throwing here would discard
      //  the rows that already succeeded.
      started.failed.push({ work_order_id: cand.work_order_id, error: e.message });
    } finally { client.release(); }
  }

  return { ...started, dry_run: dryRun, obligation_type: OBLIGATION_TYPE, sweep: SWEEP_NAME };
}

module.exports = { runProofDefectSweep, CANDIDATE_SQL, SWEEP_NAME };
