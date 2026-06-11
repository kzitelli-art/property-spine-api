// ============================================================
// bankbridge.js — The Categorization Rung (migration 017)
//
// THE BRIDGE: staged bank transaction → money_event. Vendor proof became
// identification in bankintake.js; THIS module turns identification into
// reportable accounting truth — but ONLY through a human confirm, and ONLY
// through the EXISTING obligation lifecycle. Nothing is reimplemented:
// the same spawnObligationFromEvent / satisfyObligation / completeObligation
// helpers money.js uses are injected here and do all the lifecycle work.
//
// THE PRODUCT RULE (continues the bankintake ladder):
//   claim + vendor proof                 → identified   (previous rung)
//   identified + HUMAN-CONFIRMED category → money_event, report_ready (THIS rung)
//   identified, no category knowledge     → the human queue (Amazon-class)
//
// HARD RULES THIS MODULE ENFORCES:
//   1. PROPOSE, NEVER SILENTLY CREATE. vendors.default_category only ever
//      produces a PROPOSAL. A money_event is born exclusively inside a
//      human-confirmed POST carrying confirmed_by_person_id.
//   2. DEBITS ONLY. money.js is money-OUT only (amount > 0); the bridge
//      takes bank debits (amount < 0) and writes abs(amount). Credits are
//      out of scope this rung and are SHOWN on the board, never hidden.
//   3. EXCEPTIONS NEVER BATCH. Any non-null exception_reason is excluded
//      from batch eligibility. bridge-one may handle an exception row only
//      with acknowledge_exception:true — except composite_batch, which is
//      BLOCKED outright (a settlement lump is many payments; categorizing
//      it as one line would launder it — that split is a later rung).
//   4. ONE TXN, ONE EVENT, ONCE. money_event_id on the bank transaction is
//      the structural guard; a bridged line can never bridge again.
//   5. CHAINLESS BY DESIGN. Bridge-born events carry NO event_type, so the
//      one human confirm completes the obligation and lands report_ready
//      (the proven v1 path). Approval chains are a later hardening.
//   6. GROSS, NEVER NET. Every board figure is sum(|amount|).
//
// Factory (standing module pattern — same deps as money.js minus reassign):
//   const bankBridgeModule = require('./bankbridge');
//   app.use('/', bankBridgeModule({ pool, spawnObligationFromEvent,
//                                   satisfyObligation, completeObligation }));
// ============================================================

const express = require("express");
const { WHAT_FOR } = require("./money"); // ONE vocabulary, not two

// proof inputs — must mirror money.js PROOF_INPUTS exactly
const PROOF_INPUTS = ["what_for", "confirmed_category"];

// eligibility for BATCH bridging — the strictest read
const ELIGIBLE = `t.status = 'identified'
              and t.vendor_id is not null
              and t.amount < 0
              and t.exception_reason is null
              and t.money_event_id is null`;

module.exports = function bankBridgeModule({ pool, spawnObligationFromEvent, satisfyObligation, completeObligation }) {
  const router = express.Router();

  // ── the report vocabulary is DATA: valid categories = category_report_map
  async function validCategories(client) {
    const r = await (client || pool).query(
      "select confirmed_category from category_report_map order by sort_order");
    return r.rows.map(x => x.confirmed_category);
  }

  // ── accounts of a property (the bridge is property-scoped) ──────────
  async function accountIds(property_id) {
    const r = await pool.query(
      "select id from bank_accounts where property_id = $1", [property_id]);
    return r.rows.map(x => x.id);
  }

  // ──────────────────────────────────────────────────────────────────
  // THE CORE: one staged transaction → one money_event, through the
  // SHARED engine. Runs inside the caller's open transaction. Returns
  // the new money_event id.
  // Order: source event → money_event → obligation → satisfy ×2 →
  //        complete → flip report_ready → mark the bank line bridged.
  // ──────────────────────────────────────────────────────────────────
  async function bridgeTxn(client, { txn, vendorName, property_id, confirmed_category, confirmed_by_person_id, what_for, mode, amountOverride, extraProv, setMarker = true }) {
    const amt = amountOverride !== undefined ? Number(amountOverride) : Math.abs(Number(txn.amount));
    const amtLabel = `$${amt.toFixed(2)}`;

    // 1) durable source event — an obligation must be born from an event
    const srcEv = await client.query(
      `insert into events (property_id, type, note)
       values ($1,'money_out_logged',$2) returning id`,
      [property_id,
       `${amtLabel} money-out — ${vendorName} [bank_bridge:${mode}] (bank_txn ${txn.id})`]);
    const sourceEventId = srcEv.rows[0].id;

    // 2) the money event — bank-born, chainless, provenance carries the link
    const provenance = JSON.stringify({
      source: "bank_bridge",
      mode,                                   // 'vendor_batch' | 'single' | 'split'
      bank_transaction_id: txn.id,
      bank_account_id: txn.bank_account_id,
      source_document: txn.source_document || null,
      identification_source: txn.identification_source || null,
      exception_reason: txn.exception_reason || null,
      ...(extraProv || {}),
    });
    const ins = await client.query(
      `insert into money_events
         (property_id, amount, vendor, occurred_on, source_kind, status,
          event_type, approval_stage, what_for, proposed_category, provenance)
       values ($1,$2,$3,$4,'bank_statement','unverified',
               null, null, $5, $6, $7)
       returning id`,
      [property_id, amt, vendorName, txn.txn_date, what_for, confirmed_category, provenance]);
    const moneyEventId = ins.rows[0].id;

    // 3) the obligation — SHARED engine, proof inputs owed
    const obligation = await spawnObligationFromEvent(client, {
      property_id,
      unit_id: null,
      source_event_id: sourceEventId,
      related_id: moneyEventId,
      related_type: "money_event",
      module: "money",
      type: "classification",
      label: `Explain a ${amtLabel} expense — ${vendorName} (bank bridge)`,
      owner_type: "human",
      assigned_role: "accountant",
      escalates_to_role: null,
      status: "open",
      priority: "normal",
      severity: "normal",
      required_inputs: PROOF_INPUTS,
    });
    await client.query(
      "update money_events set obligation_id = $1 where id = $2",
      [obligation.id, moneyEventId]);

    // 4) satisfy both proof inputs — the human confirm covers both halves
    for (const [input, proof] of [
      ["what_for", { what_for, source: "vendor_identity" }],
      ["confirmed_category", { confirmed_category, confirmed_by_person_id, source: `bank_bridge_${mode}` }],
    ]) {
      try {
        await satisfyObligation(client, { obligation_id: obligation.id, input, proof });
      } catch (e) {
        if (e.code !== "NOT_OUTSTANDING") throw e;
      }
    }

    // 5) complete — chainless, so the confirm closes the loop (proven v1 path)
    await completeObligation(client, {
      obligation_id: obligation.id,
      completed_by: confirmed_by_person_id,
    });

    // 6) flip report_ready + record who confirmed
    await client.query(
      `update money_events
          set confirmed_category = $1, status = 'report_ready',
              verified_by_person_id = $2, verified_at = now()
        where id = $3`,
      [confirmed_category, confirmed_by_person_id, moneyEventId]);

    // 7) the structural guard — this line can never bridge again.
    //    (splits set the marker ONCE, after all allocations land)
    if (setMarker) {
      await client.query(
        "update bank_transactions set money_event_id = $1 where id = $2",
        [moneyEventId, txn.id]);
    }

    return moneyEventId;
  }

  // ──────────────────────────────────────────────────────────────────
  // GET /bank/properties/:id/categorization-board
  // The propose view. THREE truths, all gross:
  //   ready_to_bridge — vendors WITH default_category: proposal + count + gross
  //   human_queue     — identified vendors WITHOUT category knowledge,
  //                     one line each (the Amazon-class — the product thesis)
  //   excluded        — credits, exception rows, still-claimed lines:
  //                     visible, never silently dropped
  // ──────────────────────────────────────────────────────────────────
  router.get("/bank/properties/:id/categorization-board", async (req, res) => {
    const propertyId = req.params.id;
    try {
      const accts = await accountIds(propertyId);
      if (accts.length === 0) return res.status(404).json({ error: "no bank accounts registered for this property" });

      const ready = (await pool.query(
        `select v.id as vendor_id, v.canonical_name, v.default_category,
                count(*)::int as txns, coalesce(sum(abs(t.amount)),0)::numeric(14,2) as gross
           from bank_transactions t join vendors v on v.id = t.vendor_id
          where t.bank_account_id = any($1) and ${ELIGIBLE}
            and v.default_category is not null
          group by v.id, v.canonical_name, v.default_category
          order by gross desc`, [accts])).rows;

      const queue = (await pool.query(
        `select t.id as bank_transaction_id, t.txn_date, t.description,
                t.amount, v.id as vendor_id, v.canonical_name
           from bank_transactions t join vendors v on v.id = t.vendor_id
          where t.bank_account_id = any($1) and ${ELIGIBLE}
            and v.default_category is null
          order by abs(t.amount) desc`, [accts])).rows;

      const exceptions = (await pool.query(
        `select t.exception_reason, count(*)::int as txns,
                coalesce(sum(abs(t.amount)),0)::numeric(14,2) as gross
           from bank_transactions t
          where t.bank_account_id = any($1) and t.status = 'identified'
            and t.money_event_id is null and t.exception_reason is not null
          group by t.exception_reason order by gross desc`, [accts])).rows;

      const credits = (await pool.query(
        `select count(*)::int as txns, coalesce(sum(abs(amount)),0)::numeric(14,2) as gross
           from bank_transactions
          where bank_account_id = any($1) and status = 'identified'
            and money_event_id is null and amount > 0`, [accts])).rows[0];

      const claimed = (await pool.query(
        `select count(*)::int as txns, coalesce(sum(abs(amount)),0)::numeric(14,2) as gross
           from bank_transactions
          where bank_account_id = any($1) and status = 'claimed'`, [accts])).rows[0];

      const bridged = (await pool.query(
        `select count(*)::int as txns, coalesce(sum(abs(amount)),0)::numeric(14,2) as gross
           from bank_transactions
          where bank_account_id = any($1) and money_event_id is not null`, [accts])).rows[0];

      return res.json({
        property_id: propertyId,
        ready_to_bridge: ready.map(r => ({
          vendor_id: r.vendor_id, vendor: r.canonical_name,
          proposed_category: r.default_category, txns: r.txns, gross: Number(r.gross),
          confirm_via: `POST /bank/properties/${propertyId}/bridge-vendor { vendor_id, confirmed_by_person_id }`,
        })),
        human_queue: queue.map(q => ({
          bank_transaction_id: q.bank_transaction_id, vendor_id: q.vendor_id,
          vendor: q.canonical_name, txn_date: q.txn_date,
          description: q.description, amount: q.amount,
          confirm_via: `POST /bank/transactions/${q.bank_transaction_id}/bridge-one { confirmed_by_person_id, confirmed_category }`,
        })),
        human_queue_gross: Number(queue.reduce((s, q) => s + Math.abs(Number(q.amount)), 0).toFixed(2)),
        excluded_visible: {
          exception_rows: exceptions.map(e => ({ ...e, gross: Number(e.gross) })),
          credits_not_bridged: { txns: credits.txns, gross: Number(credits.gross),
            note: "deposits/credits are out of scope this rung — money.js is money-OUT only" },
          still_claimed: { txns: claimed.txns, gross: Number(claimed.gross),
            note: "no vendor proof yet — previous rung's exposure, not bridgeable" },
        },
        bridged_so_far: { txns: bridged.txns, gross: Number(bridged.gross) },
        note: "Proposals only. Nothing becomes a money_event without a human confirm.",
      });
    } catch (e) {
      console.error("categorization-board error", e);
      return res.status(500).json({ error: e.message });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // POST /bank/vendors/:id/default-category
  // TEACH a vendor its category (PECO → utilities). Validated against
  // category_report_map — the vocabulary is data. Pass null to unlearn.
  // Teaching changes PROPOSALS only; it never creates money.
  // Body: { default_category }
  // ──────────────────────────────────────────────────────────────────
  router.post("/bank/vendors/:id/default-category", async (req, res) => {
    const vendorId = req.params.id;
    const { default_category } = req.body || {};
    try {
      if (default_category !== null && default_category !== undefined) {
        const allowed = await validCategories();
        if (!allowed.includes(default_category)) {
          return res.status(400).json({ error: "default_category must be a mapped report category (or null to clear)", allowed });
        }
      }
      const r = await pool.query(
        `update vendors set default_category = $1 where id = $2
         returning id, canonical_name, yardi_code, vendor_type, default_category`,
        [default_category ?? null, vendorId]);
      if (r.rowCount === 0) return res.status(404).json({ error: "vendor not found" });
      return res.json({ vendor: r.rows[0],
        note: "Teaching only — future board proposals use this. No money was created." });
    } catch (e) {
      console.error("default-category error", e);
      return res.status(500).json({ error: e.message });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // POST /bank/properties/:id/bridge-vendor
  // PER-VENDOR BATCH CONFIRM — the receipt reads like the October
  // hand-proof: "all PECO → utilities, confirmed." One transaction wraps
  // the whole batch: all land or none do.
  // Body: { vendor_id, confirmed_by_person_id, confirmed_category?, what_for? }
  //   confirmed_category overrides the vendor default for THIS batch only.
  // ──────────────────────────────────────────────────────────────────
  router.post("/bank/properties/:id/bridge-vendor", async (req, res) => {
    const propertyId = req.params.id;
    const { vendor_id, confirmed_by_person_id, confirmed_category = null, what_for = "other" } = req.body || {};
    if (!vendor_id) return res.status(400).json({ error: "vendor_id required" });
    if (!confirmed_by_person_id) {
      return res.status(400).json({ error: "confirmed_by_person_id required — a human must confirm" });
    }
    if (!WHAT_FOR.includes(what_for)) {
      return res.status(400).json({ error: "what_for must be one of", allowed: WHAT_FOR });
    }

    const client = await pool.connect();
    try {
      await client.query("begin");

      const prop = await client.query("select id from properties where id = $1", [propertyId]);
      if (prop.rowCount === 0) { await client.query("rollback"); return res.status(404).json({ error: "property not found" }); }

      const v = await client.query(
        "select id, canonical_name, default_category from vendors where id = $1", [vendor_id]);
      if (v.rowCount === 0) { await client.query("rollback"); return res.status(404).json({ error: "vendor not found" }); }
      const vendor = v.rows[0];

      const cat = confirmed_category || vendor.default_category;
      if (!cat) {
        await client.query("rollback");
        return res.status(409).json({
          error: "no category to confirm — vendor has no default_category and none was passed",
          hint: `teach it (POST /bank/vendors/${vendor_id}/default-category) or handle lines one-by-one (bridge-one)`,
        });
      }
      const allowed = await validCategories(client);
      if (!allowed.includes(cat)) {
        await client.query("rollback");
        return res.status(400).json({ error: "confirmed_category must be a mapped report category", got: cat, allowed });
      }

      // the eligible lines, locked — exceptions and credits never batch
      const txns = (await client.query(
        `select t.* from bank_transactions t
          where t.bank_account_id in (select id from bank_accounts where property_id = $1)
            and t.vendor_id = $2 and ${ELIGIBLE}
          order by t.txn_date for update`, [propertyId, vendor_id])).rows;

      if (txns.length === 0) {
        await client.query("rollback");
        return res.json({ vendor: vendor.canonical_name, confirmed_category: cat,
          bridged: 0, gross: 0, money_event_ids: [],
          note: "no eligible lines (already bridged, exception-flagged, credits, or none identified for this vendor at this property)" });
      }

      const ids = [];
      let gross = 0;
      for (const txn of txns) {
        const meId = await bridgeTxn(client, {
          txn, vendorName: vendor.canonical_name, property_id: propertyId,
          confirmed_category: cat, confirmed_by_person_id, what_for, mode: "vendor_batch",
        });
        ids.push(meId);
        gross += Math.abs(Number(txn.amount));
      }

      await client.query("commit");
      return res.status(201).json({
        receipt: `all ${vendor.canonical_name} → ${cat}, confirmed`,
        vendor: vendor.canonical_name,
        confirmed_category: cat,
        confirmed_by_person_id,
        bridged: ids.length,
        gross: Number(gross.toFixed(2)),
        money_event_ids: ids,
        note: "Each line is its own money_event, born through the shared obligation lifecycle, now report_ready.",
      });
    } catch (e) {
      try { await client.query("rollback"); } catch (_) {}
      console.error("bridge-vendor error", e);
      return res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // POST /bank/transactions/:id/bridge-one
  // The ONE-BY-ONE queue — the Amazon-class path, and the only path for
  // exception-flagged rows (with explicit acknowledgement). composite_batch
  // is blocked outright: a lump is many payments; splitting is a later rung.
  // Body: { confirmed_by_person_id, confirmed_category, what_for?,
  //         acknowledge_exception? }
  // ──────────────────────────────────────────────────────────────────
  router.post("/bank/transactions/:id/bridge-one", async (req, res) => {
    const txnId = req.params.id;
    const { confirmed_by_person_id, confirmed_category, what_for = "other", acknowledge_exception = false } = req.body || {};
    if (!confirmed_by_person_id) {
      return res.status(400).json({ error: "confirmed_by_person_id required — a human must confirm" });
    }
    if (!confirmed_category) {
      return res.status(400).json({ error: "confirmed_category required — this is the human-judgment path; nothing is proposed here" });
    }
    if (!WHAT_FOR.includes(what_for)) {
      return res.status(400).json({ error: "what_for must be one of", allowed: WHAT_FOR });
    }

    const client = await pool.connect();
    try {
      await client.query("begin");

      const t = await client.query(
        `select t.*, ba.property_id, v.canonical_name
           from bank_transactions t
           join bank_accounts ba on ba.id = t.bank_account_id
           left join vendors v on v.id = t.vendor_id
          where t.id = $1 for update of t`, [txnId]);
      if (t.rowCount === 0) { await client.query("rollback"); return res.status(404).json({ error: "bank transaction not found" }); }
      const txn = t.rows[0];

      // eligibility, with SPECIFIC refusals — never a vague no
      if (txn.money_event_id) {
        await client.query("rollback");
        return res.status(409).json({ error: "already bridged", money_event_id: txn.money_event_id });
      }
      if (txn.status !== "identified" || !txn.vendor_id) {
        await client.query("rollback");
        return res.status(409).json({ error: "not vendor-proven — only identified lines bridge", status: txn.status,
          hint: "resolve the payee in the previous rung first (alias registry or check-register join)" });
      }
      if (Number(txn.amount) >= 0) {
        await client.query("rollback");
        return res.status(409).json({ error: "credit/deposit — out of scope; money.js is money-OUT only", amount: txn.amount });
      }
      if (txn.exception_reason === "composite_batch") {
        await client.query("rollback");
        return res.status(409).json({
          error: "composite_batch is blocked — this lump contains many vendor payments; categorizing it as one line would launder it",
          note: "splitting a settlement batch into its constituent payments is a later rung",
        });
      }
      if (txn.exception_reason && !acknowledge_exception) {
        await client.query("rollback");
        return res.status(409).json({
          error: "exception-flagged line — pass acknowledge_exception:true to bridge it anyway",
          exception_reason: txn.exception_reason,
          note: "the flag is the finding (e.g. possible_non_property_spend = the Spotify pattern). Acknowledging records that a human saw it and categorized it deliberately.",
        });
      }

      const allowed = await validCategories(client);
      if (!allowed.includes(confirmed_category)) {
        await client.query("rollback");
        return res.status(400).json({ error: "confirmed_category must be a mapped report category", got: confirmed_category, allowed });
      }

      const meId = await bridgeTxn(client, {
        txn, vendorName: txn.canonical_name, property_id: txn.property_id,
        confirmed_category, confirmed_by_person_id, what_for, mode: "single",
      });

      await client.query("commit");
      return res.status(201).json({
        receipt: `${txn.canonical_name} ${txn.txn_date instanceof Date ? txn.txn_date.toISOString().slice(0,10) : txn.txn_date} $${Math.abs(Number(txn.amount)).toFixed(2)} → ${confirmed_category}, confirmed`,
        money_event_id: meId,
        exception_acknowledged: txn.exception_reason || null,
        note: "money_event born through the shared obligation lifecycle, now report_ready.",
      });
    } catch (e) {
      try { await client.query("rollback"); } catch (_) {}
      console.error("bridge-one error", e);
      return res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // POST /bank/transactions/:id/bridge-split
  // ONE bank transaction → MULTIPLE accounting allocations. The Virtus
  // case: a $52,870.29 wire that is payroll + management fee + R&M at
  // once. HARD RULE: allocations must sum to the bank amount EXACTLY,
  // to the cent — compared in integer cents so float drift can't lie.
  // Each allocation is its own money_event through the full shared
  // lifecycle, all sharing provenance.split_group; the marker points at
  // the first allocation; unbridge undoes the WHOLE group atomically.
  // composite_batch IS allowed here (with acknowledge_exception): a
  // human-attested split is the honest decomposition of a lump — the
  // thing bridge-one's single-category block exists to prevent.
  // Body: { confirmed_by_person_id, allocations:[{confirmed_category,
  //         amount, label?}], what_for?, acknowledge_exception? }
  // ──────────────────────────────────────────────────────────────────
  router.post("/bank/transactions/:id/bridge-split", async (req, res) => {
    const txnId = req.params.id;
    const { confirmed_by_person_id, allocations, what_for = "other", acknowledge_exception = false } = req.body || {};
    if (!confirmed_by_person_id) {
      return res.status(400).json({ error: "confirmed_by_person_id required — a human must confirm" });
    }
    if (!Array.isArray(allocations) || allocations.length < 2) {
      return res.status(400).json({ error: "allocations array of at least 2 required — for a single category use bridge-one" });
    }
    if (!WHAT_FOR.includes(what_for)) {
      return res.status(400).json({ error: "what_for must be one of", allowed: WHAT_FOR });
    }

    const client = await pool.connect();
    try {
      await client.query("begin");

      const t = await client.query(
        `select t.*, ba.property_id, v.canonical_name
           from bank_transactions t
           join bank_accounts ba on ba.id = t.bank_account_id
           left join vendors v on v.id = t.vendor_id
          where t.id = $1 for update of t`, [txnId]);
      if (t.rowCount === 0) { await client.query("rollback"); return res.status(404).json({ error: "bank transaction not found" }); }
      const txn = t.rows[0];

      if (txn.money_event_id) {
        await client.query("rollback");
        return res.status(409).json({ error: "already bridged", money_event_id: txn.money_event_id });
      }
      if (txn.status !== "identified" || !txn.vendor_id) {
        await client.query("rollback");
        return res.status(409).json({ error: "not vendor-proven — only identified lines bridge", status: txn.status });
      }
      if (Number(txn.amount) >= 0) {
        await client.query("rollback");
        return res.status(409).json({ error: "credit/deposit — out of scope; money.js is money-OUT only", amount: txn.amount });
      }
      if (txn.exception_reason && !acknowledge_exception) {
        await client.query("rollback");
        return res.status(409).json({
          error: "exception-flagged line — pass acknowledge_exception:true to split it",
          exception_reason: txn.exception_reason,
        });
      }

      // validate allocations: categories mapped, amounts positive, SUM EXACT
      const allowed = await validCategories(client);
      const cents = (x) => Math.round(Number(x) * 100);
      let sumCents = 0;
      for (const a of allocations) {
        if (!a || !a.confirmed_category || !(Number(a.amount) > 0)) {
          await client.query("rollback");
          return res.status(400).json({ error: "each allocation needs confirmed_category and a positive amount", got: a });
        }
        if (!allowed.includes(a.confirmed_category)) {
          await client.query("rollback");
          return res.status(400).json({ error: "confirmed_category must be a mapped report category", got: a.confirmed_category, allowed });
        }
        sumCents += cents(a.amount);
      }
      const txnCents = Math.abs(cents(txn.amount));
      if (sumCents !== txnCents) {
        await client.query("rollback");
        return res.status(400).json({
          error: "allocations must equal the bank transaction total exactly",
          bank_amount: (txnCents / 100).toFixed(2),
          allocations_total: (sumCents / 100).toFixed(2),
          remaining: ((txnCents - sumCents) / 100).toFixed(2),
        });
      }

      const split_group = require("crypto").randomUUID();
      const ids = [];
      for (let i = 0; i < allocations.length; i++) {
        const a = allocations[i];
        const meId = await bridgeTxn(client, {
          txn, vendorName: txn.canonical_name, property_id: txn.property_id,
          confirmed_category: a.confirmed_category, confirmed_by_person_id, what_for,
          mode: "split", amountOverride: Number(a.amount), setMarker: false,
          extraProv: { split_group, allocation_index: i + 1, allocation_count: allocations.length,
                       allocation_label: a.label || null },
        });
        ids.push(meId);
      }
      // marker once, pointing at the first allocation — the group's handle
      await client.query("update bank_transactions set money_event_id = $1 where id = $2", [ids[0], txnId]);

      await client.query("commit");
      return res.status(201).json({
        receipt: `${txn.canonical_name} $${(txnCents/100).toFixed(2)} split ${allocations.length} ways — ` +
                 allocations.map(a => `${a.confirmed_category} $${Number(a.amount).toFixed(2)}`).join(" + ") + ", confirmed",
        split_group,
        money_event_ids: ids,
        marker_money_event_id: ids[0],
        exception_acknowledged: txn.exception_reason || null,
        note: "Each allocation is its own money_event, report_ready. Undo removes the whole group.",
      });
    } catch (e) {
      try { await client.query("rollback"); } catch (_) {}
      console.error("bridge-split error", e);
      return res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // POST /bank/transactions/:id/unbridge
  // GUARDED correction path. Deletes the linked money_event + obligation
  // and returns the bank line to bridgeable — ONLY if the money_event's
  // provenance says source='bank_bridge' (a hand-entered money_event can
  // never be deleted from here), and ONLY with the money_event id passed
  // back as the confirm token (forces a look at what is being deleted).
  // Durable events (money_out_logged) stay in history — append-only audit.
  // Body: { confirm: <money_event_id> }
  // ──────────────────────────────────────────────────────────────────
  router.post("/bank/transactions/:id/unbridge", async (req, res) => {
    const txnId = req.params.id;
    const { confirm } = req.body || {};
    const client = await pool.connect();
    try {
      await client.query("begin");
      const t = await client.query(
        "select id, money_event_id from bank_transactions where id = $1 for update", [txnId]);
      if (t.rowCount === 0) { await client.query("rollback"); return res.status(404).json({ error: "bank transaction not found" }); }
      const meId = t.rows[0].money_event_id;
      if (!meId) { await client.query("rollback"); return res.status(409).json({ error: "not bridged — nothing to undo" }); }
      if (confirm !== meId) {
        await client.query("rollback");
        return res.status(403).json({ error: "confirm must equal the linked money_event id", money_event_id: meId });
      }
      const me = await client.query(
        "select id, obligation_id, provenance from money_events where id = $1 for update", [meId]);
      const prov0 = me.rows[0] ? me.rows[0].provenance : null;
      const prov = prov0 && typeof prov0 === "object" ? prov0 : (prov0 ? JSON.parse(prov0) : null);
      const provSource = prov ? prov.source : null;
      if (provSource !== "bank_bridge") {
        await client.query("rollback");
        return res.status(403).json({ error: "refusing — money_event was not bank-bridge-born", provenance_source: provSource });
      }

      // the events to remove: the marker alone, or the WHOLE split group
      let targets;
      if (prov.mode === "split" && prov.split_group) {
        targets = (await client.query(
          `select id, obligation_id from money_events
            where provenance->>'split_group' = $1 for update`, [prov.split_group])).rows;
      } else {
        targets = [{ id: meId, obligation_id: me.rows[0].obligation_id }];
      }

      await client.query("update bank_transactions set money_event_id = null where id = $1", [txnId]);

      const childTables = (await client.query(
        `select table_name from information_schema.tables
          where table_schema = 'public'
            and table_name = any($1)`,
        [["obligation_inputs", "obligation_proofs", "obligation_events"]])).rows;

      for (const tgt of targets) {
        if (tgt.obligation_id) {
          await client.query("update money_events set obligation_id = null where id = $1", [tgt.id]);
          for (const row of childTables) {
            await client.query(`delete from ${row.table_name} where obligation_id = $1`, [tgt.obligation_id]);
          }
          await client.query("delete from obligations where id = $1", [tgt.obligation_id]);
        }
        await client.query("delete from money_events where id = $1", [tgt.id]);
      }

      await client.query(
        `insert into events (property_id, type, note)
         select ba.property_id, 'money_out_logged',
                'UNBRIDGED money_event ' || $2::text || ' (bank_txn ' || $1::text || ') — correction, line returned to bridgeable'
           from bank_transactions t join bank_accounts ba on ba.id = t.bank_account_id
          where t.id = $1::uuid`, [txnId, meId]);

      await client.query("commit");
      return res.json({ unbridged: txnId,
        deleted_money_events: targets.map(t => t.id),
        was_split: !!(prov.mode === "split"),
        note: "Line is bridgeable again. Audit events left in history." });
    } catch (e) {
      try { await client.query("rollback"); } catch (_) {}
      console.error("unbridge error", e);
      return res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  return router;
};
