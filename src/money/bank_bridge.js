// ============================================================
// bank_bridge.js — The Categorization Rung (migration 017)
//
// THE BRIDGE: staged bank transaction → money_event. Vendor proof became
// identification in bank_intake.js; THIS module turns identification into
// reportable accounting truth — but ONLY through a human confirm, and ONLY
// through the EXISTING obligation lifecycle. Nothing is reimplemented:
// the same spawnObligationFromEvent / satisfyObligation / completeObligation
// helpers money.js uses are injected here and do all the lifecycle work.
//
// THE PRODUCT RULE (continues the bank_intake ladder):
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
//   const bankBridgeModule = require('./bank_bridge');
//   app.use('/', bankBridgeModule({ pool, spawnObligationFromEvent,
//                                   satisfyObligation, completeObligation }));
// ============================================================

const express = require("express");
const { WHAT_FOR } = require("./money"); // ONE vocabulary, not two

// proof inputs — must mirror money.js PROOF_INPUTS exactly
const PROOF_INPUTS = ["what_for", "confirmed_category"];

// eligibility for BATCH bridging — the strictest read.
// parked lines are excluded everywhere ELIGIBLE applies: a human said
// "I don't know yet" — no batch sweep or queue may pick it back up
// until it's unparked or deliberately bridged one-by-one.
const ELIGIBLE = `t.status = 'identified'
              and t.vendor_id is not null
              and t.amount < 0
              and t.exception_reason is null
              and t.money_event_id is null
              and t.parked_at is null`;

module.exports = function bankBridgeModule({ pool, spawnObligationFromEvent, satisfyObligation, completeObligation }) {
  const router = express.Router();

  // earned-autonomy decision helpers (migration 044). The bridge OWNS the
  // money-event birth path; this only answers "may this line auto-confirm?"
  // and "revoke on override." Same pool, no duplicate lifecycle.
  const { decideAutoConfirm, revokeOnOverride } = require("../applications/autoconfirm").helpers({ pool });

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
    //    Bridging also AUTO-UNPARKS: resolution is the unpark; no stale
    //    "needs review" survives a real answer. Trail kept via events.
    if (setMarker) {
      await client.query(
        `update bank_transactions
            set money_event_id = $1,
                parked_at = null, parked_by_person_id = null, parked_note = null
          where id = $2`,
        [moneyEventId, txn.id]);
      if (txn.parked_at) {
        await client.query(
          `insert into events (property_id, type, note) values ($1,'txn_unparked',$2)`,
          [property_id, `auto-unparked by bridge (resolved as ${confirmed_category}) — was parked with note: ${txn.parked_note || "(none)"} (bank_txn ${txn.id})`]);
      }
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

      // category resolution is layered: property rule beats global default.
      // The board's ready/queue split uses the RESOLVED category, so a
      // property rule can pull a vendor INTO ready_to_bridge (or change
      // the proposal) for this property only.
      const ready = (await pool.query(
        `select v.id as vendor_id, v.canonical_name,
                coalesce(vpc.default_category, v.default_category) as effective_category,
                (vpc.default_category is not null) as has_property_rule,
                count(*)::int as txns, coalesce(sum(abs(t.amount)),0)::numeric(14,2) as gross
           from bank_transactions t
           join vendors v on v.id = t.vendor_id
           left join vendor_property_categories vpc
             on vpc.vendor_id = v.id and vpc.property_id = $2
          where t.bank_account_id = any($1) and ${ELIGIBLE}
            and v.multi_nature = false
            and coalesce(vpc.default_category, v.default_category) is not null
          group by v.id, v.canonical_name, vpc.default_category, v.default_category
          order by gross desc`, [accts, propertyId])).rows;

      // line items for ready vendors — the UI needs rows, not just counts.
      // Same eligibility as the aggregate above, attached per vendor below.
      const readyLines = ready.length === 0 ? [] : (await pool.query(
        `select t.id as bank_transaction_id, t.vendor_id, t.txn_date,
                t.description, t.amount, t.exception_reason
           from bank_transactions t
           join vendors v on v.id = t.vendor_id
           left join vendor_property_categories vpc
             on vpc.vendor_id = v.id and vpc.property_id = $2
          where t.bank_account_id = any($1) and ${ELIGIBLE}
            and v.multi_nature = false
            and coalesce(vpc.default_category, v.default_category) is not null
          order by t.txn_date`, [accts, propertyId])).rows;
      const linesByVendor = {};
      for (const l of readyLines) {
        (linesByVendor[l.vendor_id] = linesByVendor[l.vendor_id] || []).push({
          bank_transaction_id: l.bank_transaction_id,
          txn_date: l.txn_date,
          description: l.description,
          amount: l.amount,
          exception_reason: l.exception_reason || null,
        });
      }

      const queue = (await pool.query(
        `select t.id as bank_transaction_id, t.txn_date, t.description,
                t.amount, v.id as vendor_id, v.canonical_name, v.multi_nature
           from bank_transactions t
           join vendors v on v.id = t.vendor_id
           left join vendor_property_categories vpc
             on vpc.vendor_id = v.id and vpc.property_id = $2
          where t.bank_account_id = any($1) and ${ELIGIBLE}
            and (v.multi_nature
                 or coalesce(vpc.default_category, v.default_category) is null)
          order by abs(t.amount) desc`, [accts, propertyId])).rows;

      const exceptions = (await pool.query(
        `select t.exception_reason, count(*)::int as txns,
                coalesce(sum(abs(t.amount)),0)::numeric(14,2) as gross
           from bank_transactions t
          where t.bank_account_id = any($1) and t.status = 'identified'
            and t.money_event_id is null and t.exception_reason is not null
            and t.exception_reason <> 'payment_return'
          group by t.exception_reason order by gross desc`, [accts])).rows;

      // payment returns are FINDINGS with their own home — any status,
      // since a return may sit claimed (no alias) or identified (processor
      // matched). One home, never double-counted in exception_rows.
      // Slice 2: each line carries its CONFIRMED pairing aggregate. paired
      // means human-confirmed RC entries summing to the cent (the confirm
      // gate guarantees the sum); anything else is UNPAIRED EXPOSURE.
      const returns = (await pool.query(
        `select t.id as bank_transaction_id, t.txn_date, t.description,
                t.amount, t.status, v.canonical_name as vendor,
                t.parked_at, t.parked_note,
                coalesce(p.rc_count, 0)::int as rc_count,
                coalesce(p.paired_total, 0)::numeric(14,2) as paired_total,
                coalesce(p.repaid_count, 0)::int as repaid_count
           from bank_transactions t
           left join vendors v on v.id = t.vendor_id
           left join (
                select bank_transaction_id,
                       count(*) as rc_count,
                       sum(amount) as paired_total,
                       count(repay_transaction_id) as repaid_count
                  from rc_pairings
                 where status = 'confirmed'
                 group by bank_transaction_id
           ) p on p.bank_transaction_id = t.id
          where t.bank_account_id = any($1)
            and t.exception_reason = 'payment_return'
            and t.money_event_id is null
          order by t.txn_date`, [accts])).rows;

      // parked lines — needs_review (migration 023). Visible as their own
      // block. THE INVARIANT: parking moves a line out of the WORK queues
      // only; its gross never leaves unproven exposure. Oldest first —
      // the longer something sits parked, the louder it should read.
      const parked = (await pool.query(
        `select t.id as bank_transaction_id, t.txn_date, t.description,
                t.amount, t.status, t.exception_reason,
                t.parked_at, t.parked_note,
                pe.name as parked_by,
                extract(day from now() - t.parked_at)::int as days_parked
           from bank_transactions t
           left join persons pe on pe.id = t.parked_by_person_id
          where t.bank_account_id = any($1)
            and t.parked_at is not null
            and t.money_event_id is null
          order by t.parked_at asc`, [accts])).rows;

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
          proposed_category: r.effective_category,
          rule_source: r.has_property_rule ? "property" : "global",
          txns: r.txns, gross: Number(r.gross),
          transactions: linesByVendor[r.vendor_id] || [],
          confirm_via: `POST /bank/properties/${propertyId}/bridge-vendor { vendor_id, confirmed_by_person_id }`,
        })),
        human_queue: queue.map(q => ({
          bank_transaction_id: q.bank_transaction_id, vendor_id: q.vendor_id,
          vendor: q.canonical_name, txn_date: q.txn_date,
          description: q.description, amount: q.amount,
          multi_nature: q.multi_nature === true,
          queue_reason: q.multi_nature === true
            ? "multi-nature vendor — this vendor varies payment to payment; per-payment judgment only, batch refused by design"
            : "no category knowledge for this vendor",
          confirm_via: `POST /bank/transactions/${q.bank_transaction_id}/bridge-one { confirmed_by_person_id, confirmed_category }`,
        })),
        human_queue_gross: Number(queue.reduce((s, q) => s + Math.abs(Number(q.amount)), 0).toFixed(2)),
        parked: {
          txns: parked.length,
          gross: Number(parked.reduce((s, p) => s + Math.abs(Number(p.amount)), 0).toFixed(2)),
          lines: parked.map(p => ({
            bank_transaction_id: p.bank_transaction_id,
            txn_date: p.txn_date, description: p.description, amount: p.amount,
            status: p.status, exception_reason: p.exception_reason || null,
            parked_note: p.parked_note, parked_by: p.parked_by || null,
            parked_at: p.parked_at, days_parked: p.days_parked,
            unpark_via: `POST /bank/transactions/${p.bank_transaction_id}/unpark`,
          })),
          note: "PARKED IS NOT RESOLVED. These left the work queues because a human said 'I don't know yet' — their gross is still unproven exposure. Only proof (a bridge, a pairing) resolves; bridging auto-unparks. Oldest first: age is the heat.",
        },
        payment_returns: (() => {
          const paired = returns.filter(r => r.rc_count > 0);
          const unpaired = returns.filter(r => r.rc_count === 0);
          const grossOf = (rows) => Number(rows.reduce((s, r) => s + Math.abs(Number(r.amount)), 0).toFixed(2));
          return {
            txns: returns.length,
            gross: grossOf(returns),
            paired: { txns: paired.length, gross: grossOf(paired) },
            unpaired_exposure: {
              txns: unpaired.length, gross: grossOf(unpaired),
              note: "THE HEADLINE. Returns with no confirmed RC pairing — including any orphan with no book entry anywhere (the 9/11 $100 class). Exposure until paired or resolved; it never nets, never vanishes.",
            },
            lines: returns.map(r => ({
              bank_transaction_id: r.bank_transaction_id,
              txn_date: r.txn_date,
              description: r.description,
              amount: r.amount,
              status: r.status,
              vendor: r.vendor || null,
              paired: r.rc_count > 0,
              rc_count: r.rc_count,
              repaid_count: r.repaid_count,
              parked: r.parked_at != null,
              parked_note: r.parked_note || null,
              pair_via: r.rc_count > 0 ? null
                : `POST /bank/transactions/${r.bank_transaction_id}/rc-pairings { entries:[{rc_number, rc_date, tenant_code, amount}] } then /confirm`,
            })),
            note: "FINDINGS, not expense work items. Tenant payment clawbacks — revenue moving backward. bridge-one and bridge-split refuse these by design (409, no acknowledgement override). Pairing with Yardi RC entries is the resolution path; confirm refuses unless entries sum to the bank line to the cent.",
          };
        })(),
        excluded_visible: {
          exception_rows: exceptions.map(e => ({ ...e, gross: Number(e.gross) })),
          credits_not_bridged: { txns: credits.txns, gross: Number(credits.gross),
            note: "deposits/credits are out of scope this rung — money.js is money-OUT only" },
          still_claimed: { txns: claimed.txns, gross: Number(claimed.gross),
            note: "no vendor proof yet — previous rung's exposure, not bridgeable",
            detail_via: `GET /bank/properties/${propertyId}/claimed-items` },
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
  // POST /bank/properties/:id/vendors/:vendorId/category   (migration 019)
  // TEACH a vendor its category FOR ONE PROPERTY ONLY — the override
  // that beats the global default at this asset and nowhere else.
  // Body: { default_category }  — pass null to clear (global resumes).
  // Teaching changes PROPOSALS only; it never creates money.
  // ──────────────────────────────────────────────────────────────────
  router.post("/bank/properties/:id/vendors/:vendorId/category", async (req, res) => {
    const propertyId = req.params.id;
    const vendorId = req.params.vendorId;
    const { default_category } = req.body || {};
    try {
      const prop = await pool.query("select id from properties where id = $1", [propertyId]);
      if (prop.rowCount === 0) return res.status(404).json({ error: "property not found" });
      const v = await pool.query(
        "select id, canonical_name, default_category from vendors where id = $1", [vendorId]);
      if (v.rowCount === 0) return res.status(404).json({ error: "vendor not found" });
      const vendor = v.rows[0];

      // null clears the rule — the global default resumes, explicitly
      if (default_category === null || default_category === undefined) {
        const del = await pool.query(
          `delete from vendor_property_categories
            where vendor_id = $1 and property_id = $2 returning default_category`,
          [vendorId, propertyId]);
        return res.json({
          vendor: vendor.canonical_name,
          property_id: propertyId,
          cleared: del.rowCount > 0 ? del.rows[0].default_category : null,
          now_effective: vendor.default_category || null,
          note: del.rowCount > 0
            ? "Property rule cleared — the global default (if any) resumes for this property."
            : "No property rule existed — nothing to clear.",
        });
      }

      const allowed = await validCategories();
      if (!allowed.includes(default_category)) {
        return res.status(400).json({ error: "default_category must be a mapped report category (or null to clear)", allowed });
      }
      const up = await pool.query(
        `insert into vendor_property_categories (vendor_id, property_id, default_category)
         values ($1, $2, $3)
         on conflict (vendor_id, property_id)
         do update set default_category = excluded.default_category, updated_at = now()
         returning *`, [vendorId, propertyId, default_category]);
      return res.json({
        rule: up.rows[0],
        vendor: vendor.canonical_name,
        global_default: vendor.default_category || null,
        note: "Property rule set. Teaching only — board proposals for THIS property use this; other properties keep the global default. No money was created.",
      });
    } catch (e) {
      console.error("property-vendor-category error", e);
      return res.status(500).json({ error: e.message });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // POST /bank/vendors/:id/multi-nature   (migration 020)
  // Mark a vendor as MANY THINGS WEARING ONE NAME (a management company
  // paid for payroll, fees, and reimbursements). Effect, enforced at the
  // handler level: never in ready_to_bridge, bridge-vendor refuses 409,
  // bridge-one / bridge-split remain the only paths. Set by a HUMAN,
  // explicitly — never derived from vendor_type (that would be a silent
  // branch). Teaching only: removes a shortcut, never creates money.
  // Body: { multi_nature: true | false }
  // ──────────────────────────────────────────────────────────────────
  router.post("/bank/vendors/:id/multi-nature", async (req, res) => {
    const vendorId = req.params.id;
    const { multi_nature } = req.body || {};
    if (typeof multi_nature !== "boolean") {
      return res.status(400).json({ error: "multi_nature must be true or false — explicit, never implied" });
    }
    try {
      const r = await pool.query(
        `update vendors set multi_nature = $1 where id = $2
         returning id, canonical_name, vendor_type, default_category, multi_nature`,
        [multi_nature, vendorId]);
      if (r.rowCount === 0) return res.status(404).json({ error: "vendor not found" });
      const vendor = r.rows[0];
      return res.json({
        vendor,
        note: multi_nature
          ? "Marked multi-nature. Batch confirm is now refused for this vendor at the handler level; its lines route to per-payment judgment. Any default_category is kept but dormant — it resumes if the flag is cleared."
          : "Flag cleared. The vendor can batch again where a default or property rule exists.",
      });
    } catch (e) {
      console.error("multi-nature error", e);
      return res.status(500).json({ error: e.message });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // GET /bank/properties/:id/vendor-category-rules
  // READ-ONLY. Every property rule at this asset, beside the global
  // default it overrides — so divergence is visible, never silent.
  // ──────────────────────────────────────────────────────────────────
  router.get("/bank/properties/:id/vendor-category-rules", async (req, res) => {
    try {
      const rows = (await pool.query(
        `select vpc.vendor_id, v.canonical_name, vpc.default_category as property_category,
                v.default_category as global_default, vpc.updated_at
           from vendor_property_categories vpc
           join vendors v on v.id = vpc.vendor_id
          where vpc.property_id = $1
          order by v.canonical_name`, [req.params.id])).rows;
      return res.json({
        property_id: req.params.id,
        count: rows.length,
        rules: rows.map(r => ({
          vendor_id: r.vendor_id, vendor: r.canonical_name,
          property_category: r.property_category,
          global_default: r.global_default,
          diverges: r.global_default !== null && r.global_default !== r.property_category,
          updated_at: r.updated_at,
        })),
      });
    } catch (e) {
      console.error("vendor-category-rules error", e);
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
        "select id, canonical_name, default_category, multi_nature from vendors where id = $1", [vendor_id]);
      if (v.rowCount === 0) { await client.query("rollback"); return res.status(404).json({ error: "vendor not found" }); }
      const vendor = v.rows[0];

      // THE HANDLER-LEVEL BLOCK: multi-nature vendors never batch. Not a
      // hidden button — the shortcut does not exist. (Born from the 2am
      // incident: three wires hid inside this vendor's batch proposal.)
      if (vendor.multi_nature === true) {
        await client.query("rollback");
        return res.status(409).json({
          error: "multi-nature vendor — batch confirm refused by design",
          vendor: vendor.canonical_name,
          note: "this vendor is many things wearing one name (payroll, fees, reimbursements); a single-category batch would launder that. Per-payment judgment only.",
          per_payment_via: {
            list: `GET /bank/properties/${propertyId}/vendor-transactions?vendor=${encodeURIComponent(vendor.canonical_name)}`,
            single: "POST /bank/transactions/:id/bridge-one",
            split: "POST /bank/transactions/:id/bridge-split",
          },
        });
      }

      // resolution: explicit (the human) > property rule > global default
      const pr = await client.query(
        `select default_category from vendor_property_categories
          where vendor_id = $1 and property_id = $2`, [vendor_id, propertyId]);
      const propertyRule = pr.rowCount > 0 ? pr.rows[0].default_category : null;
      const cat = confirmed_category || propertyRule || vendor.default_category;
      const category_source = confirmed_category ? "explicit"
                            : propertyRule ? "property_rule" : "global_default";
      if (!cat) {
        await client.query("rollback");
        return res.status(409).json({
          error: "no category to confirm — no property rule, no global default, and none was passed",
          hint: `teach it globally (POST /bank/vendors/${vendor_id}/default-category), for this property only (POST /bank/properties/${propertyId}/vendors/${vendor_id}/category), or handle lines one-by-one (bridge-one)`,
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
        category_source,
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
      if (txn.exception_reason === "payment_return") {
        await client.query("rollback");
        return res.status(409).json({
          error: "payment_return is blocked — this debit is a tenant payment clawback (revenue moving backward), not an expense; no category can make it one, and no acknowledgement overrides this",
          note: "the Virtus rule: the descriptor names the PROCESSOR, not the counterparty. Pairing returns with their Yardi RC entries is the next slice of this rung.",
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
      if (txn.exception_reason === "payment_return") {
        await client.query("rollback");
        return res.status(409).json({
          error: "payment_return is blocked from splitting — a return decomposes into tenant RC entries (revenue side), never into expense categories",
          note: "RC pairing is the next slice of the payment_return rung; until then this line is correctly stuck",
        });
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
      // marker once, pointing at the first allocation — the group's handle.
      // Auto-unpark here too: a confirmed split is a resolution.
      await client.query(
        `update bank_transactions
            set money_event_id = $1,
                parked_at = null, parked_by_person_id = null, parked_note = null
          where id = $2`, [ids[0], txnId]);
      if (txn.parked_at) {
        await client.query(
          `insert into events (property_id, type, note) values ($1,'txn_unparked',$2)`,
          [txn.property_id, `auto-unparked by split (${allocations.length} allocations) — was parked with note: ${txn.parked_note || "(none)"} (bank_txn ${txnId})`]);
      }

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

  // ──────────────────────────────────────────────────────────────────
  // GET /bank/properties/:id/vendor-transactions?vendor=<name fragment>
  // READ-ONLY. Lists a vendor's UNBRIDGED debit transactions regardless
  // of board bucket (human queue, batch proposal, or exception) so the
  // per-payment flows can target them individually. Born at 2am when
  // three wires hid inside a batch proposal the queue view couldn't see.
  // ──────────────────────────────────────────────────────────────────
  router.get("/bank/properties/:id/vendor-transactions", async (req, res) => {
    const vendor = String(req.query.vendor || "").trim();
    if (!vendor) return res.status(400).json({ error: "vendor query param required (name fragment)" });
    try {
      const accts = await accountIds(req.params.id);
      if (accts.length === 0) return res.status(404).json({ error: "no bank accounts registered for this property" });
      const rows = (await pool.query(
        `select t.id as bank_transaction_id, t.txn_date, t.description, t.amount,
                t.status, t.exception_reason, v.canonical_name as vendor
           from bank_transactions t join vendors v on v.id = t.vendor_id
          where t.bank_account_id = any($1) and t.money_event_id is null
            and t.amount < 0 and v.canonical_name ilike '%' || $2 || '%'
          order by t.txn_date desc`, [accts, vendor])).rows;
      return res.json({ vendor_query: vendor, count: rows.length, transactions: rows });
    } catch (e) {
      console.error("vendor-transactions error", e);
      return res.status(500).json({ error: e.message });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // POST /bank/properties/:id/reidentify
  // Re-runs stage-time alias matching on CLAIMED, non-check, unbridged
  // lines. Exists because vendor seeding teaches the registry but never
  // rewrites history — this is the explicit, logged retro pass. Same
  // norm(), same includes() logic, same one-vendor-only rule as intake.
  // ──────────────────────────────────────────────────────────────────
  const normDesc = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
  router.post("/bank/properties/:id/reidentify", async (req, res) => {
    try {
      const accts = await accountIds(req.params.id);
      if (accts.length === 0) return res.status(404).json({ error: "no bank accounts registered for this property" });
      const aliasRows = (await pool.query(
        `select va.alias_value, va.vendor_id, v.vendor_type
           from vendor_aliases va join vendors v on v.id = va.vendor_id
          where va.source_system = 'bank_description'`)).rows;
      const claimed = (await pool.query(
        `select id, description, amount from bank_transactions
          where bank_account_id = any($1) and status = 'claimed'
            and money_event_id is null and txn_type not in ('check','check_return')`,
        [accts])).rows;
      let identified = 0; const outcomes = [];
      for (const t of claimed) {
        const d = normDesc(t.description);
        const hits = aliasRows.filter(a => d.includes(a.alias_value));
        const vendorIds = [...new Set(hits.map(h => h.vendor_id))];
        if (vendorIds.length === 1) {
          const vt = hits.find(h => h.vendor_id === vendorIds[0]).vendor_type;
          const except = vt === "owner_affiliate" ? "affiliate_transfer"
                       : (vt === "management" && Number(t.amount) < 0 && d.includes("SETTLEMENT")) ? "composite_batch" : null;
          await pool.query(
            `update bank_transactions
                set status='identified', vendor_id=$2, identification_source='bank_description',
                    exception_reason = coalesce($3, exception_reason)
              where id=$1`, [t.id, vendorIds[0], except]);
          identified++; outcomes.push({ id: t.id, description: t.description, outcome: "identified" });
        } else if (vendorIds.length > 1) {
          outcomes.push({ id: t.id, description: t.description, outcome: "ambiguous", vendors: vendorIds.length });
        }
      }
      return res.json({ scanned: claimed.length, identified, outcomes });
    } catch (e) {
      console.error("reidentify error", e);
      return res.status(500).json({ error: e.message });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // GET /bank/properties/:id/claimed-items   (NEW — open issue #5)
  // READ-ONLY. The claimed pile, LINE BY LINE, each carrying WHY it is
  // stuck. The categorization-board shows the claimed aggregate; this is
  // the detail underneath it. Exists because of the "that's everything"
  // trap: an empty review queue read as done while real dollars sat
  // invisible in claimed.
  //
  // IDENTIFY IS NOT COMMIT: this route runs the SAME alias matching as
  // reidentify (same normDesc, same includes(), same one-vendor rule)
  // but writes NOTHING. It only reports what reidentify WOULD do.
  //
  // Stuck reasons (each names the action that unsticks it):
  //   check_awaiting_register_join — payee lives on the check, not the
  //     statement description; needs the check-register join.
  //   alias_now_matches — registry learned this vendor AFTER staging;
  //     POST /reidentify will pick it up.
  //   ambiguous_aliases — multiple vendors match; human resolution, never
  //     a guess.
  //   no_alias_match — nobody knows this payee yet; teach a vendor alias,
  //     then reidentify.
  // ──────────────────────────────────────────────────────────────────
  router.get("/bank/properties/:id/claimed-items", async (req, res) => {
    const propertyId = req.params.id;
    try {
      const accts = await accountIds(propertyId);
      if (accts.length === 0) return res.status(404).json({ error: "no bank accounts registered for this property" });

      const rows = (await pool.query(
        `select t.id as bank_transaction_id, t.txn_date, t.description,
                t.amount, t.txn_type, t.source_document
           from bank_transactions t
          where t.bank_account_id = any($1) and t.status = 'claimed'
            and t.money_event_id is null
          order by abs(t.amount) desc`, [accts])).rows;

      // alias table read ONCE — same source reidentify uses
      const aliasRows = (await pool.query(
        `select va.alias_value, va.vendor_id, v.canonical_name
           from vendor_aliases va join vendors v on v.id = va.vendor_id
          where va.source_system = 'bank_description'`)).rows;

      const items = rows.map(t => {
        const isCredit = Number(t.amount) > 0;
        let stuck_reason, unstick_via, would_match = null;
        if (t.txn_type === "check" || t.txn_type === "check_return") {
          stuck_reason = "check_awaiting_register_join";
          unstick_via = "check-register join (payee lives on the check, not the statement)";
        } else {
          const d = normDesc(t.description);
          const hits = aliasRows.filter(a => d.includes(a.alias_value));
          const vendorIds = [...new Set(hits.map(h => h.vendor_id))];
          if (vendorIds.length === 1) {
            stuck_reason = "alias_now_matches";
            would_match = hits.find(h => h.vendor_id === vendorIds[0]).canonical_name;
            unstick_via = `POST /bank/properties/${propertyId}/reidentify`;
          } else if (vendorIds.length > 1) {
            stuck_reason = "ambiguous_aliases";
            would_match = [...new Set(hits.map(h => h.canonical_name))].join(" | ");
            unstick_via = "human resolution — multiple vendors match, never a guess";
          } else {
            stuck_reason = "no_alias_match";
            unstick_via = "teach a vendor alias (bank_description), then reidentify";
          }
        }
        return {
          bank_transaction_id: t.bank_transaction_id,
          txn_date: t.txn_date,
          description: t.description,
          amount: Number(t.amount),
          txn_type: t.txn_type,
          is_credit: isCredit,
          source_document: t.source_document || null,
          stuck_reason,
          would_match,
          unstick_via,
        };
      });

      const by_reason = {};
      for (const it of items) {
        if (!by_reason[it.stuck_reason]) by_reason[it.stuck_reason] = { txns: 0, gross: 0 };
        by_reason[it.stuck_reason].txns += 1;
        by_reason[it.stuck_reason].gross = Number((by_reason[it.stuck_reason].gross + Math.abs(it.amount)).toFixed(2));
      }

      return res.json({
        property_id: propertyId,
        claimed: {
          txns: items.length,
          gross: Number(items.reduce((s, t) => s + Math.abs(t.amount), 0).toFixed(2)),
        },
        by_reason,
        items,
        note: "READ-ONLY — identify is not commit; nothing here mutates. An empty review queue is NOT done while this pile is non-zero.",
      });
    } catch (e) {
      console.error("claimed-items error", e);
      return res.status(500).json({ error: e.message });
    }
  });

  // ════════════════════════════════════════════════════════════════
  //  NEEDS_REVIEW — the parked state (migration 023)
  //
  //  "I don't know yet — park it with a note." A state, not an absence.
  //  THE INVARIANT: parking never resolves and never reduces exposure —
  //  it moves a line out of the WORK queues into its own visible block,
  //  note + who + when + age attached. Bridging auto-unparks (the
  //  resolution IS the unpark). The note is MANDATORY: parking without
  //  a note is just hiding, and hiding is the thing this system fights.
  // ════════════════════════════════════════════════════════════════

  // ──────────────────────────────────────────────────────────────────
  // POST /bank/transactions/:id/park
  // Body: { parked_by_person_id, note }
  // Allowed on ANY unbridged line (claimed, identified, exception-
  // flagged, payment_return — the 9/11 orphan is the canonical case).
  // Re-parking replaces the note; the events trail keeps the old one.
  // ──────────────────────────────────────────────────────────────────
  router.post("/bank/transactions/:id/park", async (req, res) => {
    const { parked_by_person_id, note } = req.body || {};
    if (!parked_by_person_id) {
      return res.status(400).json({ error: "parked_by_person_id required — parking is a deliberate human act" });
    }
    if (!note || !String(note).trim()) {
      return res.status(400).json({ error: "note required — 'park it WITH A NOTE'. What do you know, what's missing, where would the answer live?" });
    }
    const client = await pool.connect();
    try {
      await client.query("begin");
      const t = await client.query(
        `select t.*, ba.property_id
           from bank_transactions t
           join bank_accounts ba on ba.id = t.bank_account_id
          where t.id = $1 for update of t`, [req.params.id]);
      if (t.rowCount === 0) { await client.query("rollback"); return res.status(404).json({ error: "bank transaction not found" }); }
      const txn = t.rows[0];
      if (txn.money_event_id) {
        await client.query("rollback");
        return res.status(409).json({ error: "already bridged — resolved lines don't park", money_event_id: txn.money_event_id });
      }
      const wasParked = txn.parked_at != null;
      await client.query(
        `update bank_transactions
            set parked_at = now(), parked_by_person_id = $1, parked_note = $2
          where id = $3`,
        [parked_by_person_id, String(note).trim(), txn.id]);
      await client.query(
        `insert into events (property_id, type, note) values ($1,$2,$3)`,
        [txn.property_id,
         wasParked ? "txn_park_note_updated" : "txn_parked",
         wasParked
           ? `park note replaced on ${txn.txn_date instanceof Date ? txn.txn_date.toISOString().slice(0,10) : txn.txn_date} $${Math.abs(Number(txn.amount)).toFixed(2)} — old: "${txn.parked_note}" new: "${String(note).trim()}" (bank_txn ${txn.id})`
           : `parked: ${txn.txn_date instanceof Date ? txn.txn_date.toISOString().slice(0,10) : txn.txn_date} $${Math.abs(Number(txn.amount)).toFixed(2)} ${txn.description.slice(0,60)} — "${String(note).trim()}" (bank_txn ${txn.id})`]);
      await client.query("commit");
      return res.status(wasParked ? 200 : 201).json({
        receipt: `${wasParked ? "note updated" : "parked"}: $${Math.abs(Number(txn.amount)).toFixed(2)} — "${String(note).trim()}"`,
        note: "parked is NOT resolved — this line stays in unproven exposure and appears in the board's parked block until proof arrives. Bridging it later auto-unparks.",
      });
    } catch (e) {
      try { await client.query("rollback"); } catch (_) {}
      console.error("park error", e);
      return res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // POST /bank/transactions/:id/unpark — back to the queue, trail kept.
  // No body needed: unparking just returns the line to active work.
  // ──────────────────────────────────────────────────────────────────
  router.post("/bank/transactions/:id/unpark", async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const t = await client.query(
        `select t.*, ba.property_id
           from bank_transactions t
           join bank_accounts ba on ba.id = t.bank_account_id
          where t.id = $1 for update of t`, [req.params.id]);
      if (t.rowCount === 0) { await client.query("rollback"); return res.status(404).json({ error: "bank transaction not found" }); }
      const txn = t.rows[0];
      if (!txn.parked_at) {
        await client.query("rollback");
        return res.status(409).json({ error: "not parked — nothing to unpark" });
      }
      await client.query(
        `update bank_transactions
            set parked_at = null, parked_by_person_id = null, parked_note = null
          where id = $1`, [txn.id]);
      await client.query(
        `insert into events (property_id, type, note) values ($1,'txn_unparked',$2)`,
        [txn.property_id,
         `unparked: ${txn.txn_date instanceof Date ? txn.txn_date.toISOString().slice(0,10) : txn.txn_date} $${Math.abs(Number(txn.amount)).toFixed(2)} — was: "${txn.parked_note}" (bank_txn ${txn.id})`]);
      await client.query("commit");
      return res.json({
        receipt: `unparked — back in the active queues`,
        was_note: txn.parked_note,
      });
    } catch (e) {
      try { await client.query("rollback"); } catch (_) {}
      console.error("unpark error", e);
      return res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // GET /bank/properties/:id/parked — the parked board, oldest first.
  // READ-ONLY. This is Josephine's catch-up list, structural: every
  // line a human looked at and couldn't close, with the note, the
  // person, and the age. Age is the heat — nothing rots silently.
  // ──────────────────────────────────────────────────────────────────
  router.get("/bank/properties/:id/parked", async (req, res) => {
    try {
      const accts = await accountIds(req.params.id);
      if (accts.length === 0) return res.status(404).json({ error: "no bank accounts registered for this property" });
      const rows = (await pool.query(
        `select t.id as bank_transaction_id, t.txn_date, t.description, t.amount,
                t.status, t.exception_reason, t.parked_at, t.parked_note,
                pe.name as parked_by,
                extract(day from now() - t.parked_at)::int as days_parked
           from bank_transactions t
           left join persons pe on pe.id = t.parked_by_person_id
          where t.bank_account_id = any($1)
            and t.parked_at is not null and t.money_event_id is null
          order by t.parked_at asc`, [accts])).rows;
      return res.json({
        parked: {
          txns: rows.length,
          gross: Number(rows.reduce((s, r) => s + Math.abs(Number(r.amount)), 0).toFixed(2)),
        },
        oldest_days: rows.length ? rows[0].days_parked : null,
        items: rows,
        note: "READ-ONLY. Parked is not resolved — every dollar here is still unproven exposure. Resolve by bridging (auto-unparks) or unpark to return it to the queue.",
      });
    } catch (e) {
      console.error("parked board error", e);
      return res.status(500).json({ error: e.message });
    }
  });

  // ════════════════════════════════════════════════════════════════
  //  RC PAIRINGS — payment_return rung, slice 2 (migration 022)
  //
  //  Revenue-side ONLY: every route here refuses any transaction not
  //  flagged payment_return. No money_event is ever born here — a
  //  return decomposes into tenant RC entries, never into expenses.
  //
  //  The flow: propose entries (replaceable draft, proves nothing) →
  //  human confirm (HARD GATE: integer-cents sum to the bank line, a
  //  2-of-3 batch can never read as done) → paired, leaves the board's
  //  unpaired exposure. Unpair keeps the trail (rejected, not deleted).
  //  link-repay attaches the re-pay credit per RC row (the t0005237
  //  case), exact-amount-gated.
  // ════════════════════════════════════════════════════════════════

  // shared: load + validate the return line. Returns {txn} or writes the
  // refusal and returns null. Caller owns the client/locking when needed.
  async function loadReturnLine(client, txnId, res, { forUpdate = false } = {}) {
    const t = await client.query(
      `select t.*, ba.property_id
         from bank_transactions t
         join bank_accounts ba on ba.id = t.bank_account_id
        where t.id = $1 ${forUpdate ? "for update of t" : ""}`, [txnId]);
    if (t.rowCount === 0) {
      res.status(404).json({ error: "bank transaction not found" });
      return null;
    }
    const txn = t.rows[0];
    if (txn.exception_reason !== "payment_return") {
      res.status(409).json({
        error: "not a payment_return line — RC pairing is revenue-side only",
        exception_reason: txn.exception_reason || null,
        note: "expense lines bridge through bridge-one / bridge-split; pairing exists exclusively for tenant payment clawbacks",
      });
      return null;
    }
    if (Number(txn.amount) >= 0) {
      res.status(409).json({ error: "payment_return pairing applies to the DEBIT (the clawback); credits link via link-repay", amount: txn.amount });
      return null;
    }
    return txn;
  }

  const toCents = (x) => Math.round(Number(x) * 100);

  // ──────────────────────────────────────────────────────────────────
  // GET /bank/transactions/:id/rc-pairings — READ-ONLY readout.
  // Identify is not commit: nothing here mutates.
  // ──────────────────────────────────────────────────────────────────
  router.get("/bank/transactions/:id/rc-pairings", async (req, res) => {
    try {
      const txn = await loadReturnLine(pool, req.params.id, res);
      if (!txn) return;
      const rows = (await pool.query(
        `select id, rc_number, rc_date, tenant_code, amount, status,
                repay_transaction_id, confirmed_at, note
           from rc_pairings where bank_transaction_id = $1
          order by status, rc_date, rc_number`, [txn.id])).rows;
      const live = rows.filter(r => r.status !== "rejected");
      const liveCents = live.reduce((s, r) => s + toCents(r.amount), 0);
      const bankCents = Math.abs(toCents(txn.amount));
      return res.json({
        bank_transaction_id: txn.id,
        txn_date: txn.txn_date, description: txn.description,
        bank_amount: (bankCents / 100).toFixed(2),
        pairings: rows,
        live_total: (liveCents / 100).toFixed(2),
        gap: ((bankCents - liveCents) / 100).toFixed(2),
        paired: live.length > 0 && live.every(r => r.status === "confirmed") && liveCents === bankCents,
        note: "READ-ONLY. paired=true only when every live row is confirmed and the sum ties to the cent.",
      });
    } catch (e) {
      console.error("rc-pairings read error", e);
      return res.status(500).json({ error: e.message });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // POST /bank/transactions/:id/rc-pairings — PROPOSE entries.
  // A proposal is a replaceable DRAFT: re-proposing wipes prior proposed
  // rows and inserts fresh (idempotent re-runs, no duplicates). It
  // proves NOTHING — the response shows the gap honestly and never
  // auto-confirms. Refused outright once confirmed rows exist.
  // Body: { entries: [{ rc_number, rc_date, tenant_code?, amount, note? }] }
  // ──────────────────────────────────────────────────────────────────
  router.post("/bank/transactions/:id/rc-pairings", async (req, res) => {
    const { entries } = req.body || {};
    if (!Array.isArray(entries) || entries.length < 1) {
      return res.status(400).json({ error: "entries array of at least 1 required — [{rc_number, rc_date, tenant_code, amount}]" });
    }
    for (const [i, e] of entries.entries()) {
      if (!e || !e.rc_number || !e.rc_date || !(Number(e.amount) > 0)) {
        return res.status(400).json({ error: `entry ${i}: rc_number, rc_date, and amount > 0 are required`, got: e || null });
      }
    }
    const seen = new Set();
    for (const e of entries) {
      if (seen.has(String(e.rc_number))) {
        return res.status(400).json({ error: "duplicate rc_number within payload", rc_number: e.rc_number });
      }
      seen.add(String(e.rc_number));
    }

    const client = await pool.connect();
    try {
      await client.query("begin");
      const txn = await loadReturnLine(client, req.params.id, res, { forUpdate: true });
      if (!txn) { await client.query("rollback"); return; }

      const confirmed = await client.query(
        "select count(*)::int as n from rc_pairings where bank_transaction_id = $1 and status = 'confirmed'", [txn.id]);
      if (confirmed.rows[0].n > 0) {
        await client.query("rollback");
        return res.status(409).json({
          error: "already paired — confirmed RC entries exist; unpair first to re-propose",
          unpair_via: `POST /bank/transactions/${txn.id}/rc-pairings/unpair { confirm: "${txn.id}" }`,
        });
      }

      // drafts are replaceable; rejected rows (history) are untouched
      await client.query(
        "delete from rc_pairings where bank_transaction_id = $1 and status = 'proposed'", [txn.id]);

      const inserted = [];
      for (const e of entries) {
        const r = await client.query(
          `insert into rc_pairings
             (bank_transaction_id, rc_number, rc_date, tenant_code, amount, status, note)
           values ($1,$2,$3,$4,$5,'proposed',$6)
           returning id, rc_number, rc_date, tenant_code, amount`,
          [txn.id, String(e.rc_number), e.rc_date, e.tenant_code || null,
           Number(e.amount), e.note || null]);
        inserted.push(r.rows[0]);
      }

      const bankCents = Math.abs(toCents(txn.amount));
      const propCents = inserted.reduce((s, r) => s + toCents(r.amount), 0);
      await client.query("commit");
      return res.status(201).json({
        bank_transaction_id: txn.id,
        proposed: inserted,
        bank_amount: (bankCents / 100).toFixed(2),
        proposed_total: (propCents / 100).toFixed(2),
        gap: ((bankCents - propCents) / 100).toFixed(2),
        ready_to_confirm: propCents === bankCents,
        note: propCents === bankCents
          ? "sums to the cent — confirm to pair"
          : "DOES NOT SUM — confirm will refuse (409) until the gap is zero. Honest blank beats forced fit.",
        confirm_via: `POST /bank/transactions/${txn.id}/rc-pairings/confirm { confirmed_by_person_id }`,
      });
    } catch (e) {
      try { await client.query("rollback"); } catch (_) {}
      console.error("rc-pairings propose error", e);
      return res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // POST /bank/transactions/:id/rc-pairings/confirm — THE HARD GATE.
  // The anti-Mark mechanism of this slice: proposed entries must sum to
  // the bank line EXACTLY, compared in integer cents. A partially-paired
  // batch (2 of 3 RCs) is refused — it can never read as done.
  // Body: { confirmed_by_person_id }
  // ──────────────────────────────────────────────────────────────────
  router.post("/bank/transactions/:id/rc-pairings/confirm", async (req, res) => {
    const { confirmed_by_person_id } = req.body || {};
    if (!confirmed_by_person_id) {
      return res.status(400).json({ error: "confirmed_by_person_id required — a human must confirm" });
    }
    const client = await pool.connect();
    try {
      await client.query("begin");
      const txn = await loadReturnLine(client, req.params.id, res, { forUpdate: true });
      if (!txn) { await client.query("rollback"); return; }

      const already = await client.query(
        "select count(*)::int as n from rc_pairings where bank_transaction_id = $1 and status = 'confirmed'", [txn.id]);
      if (already.rows[0].n > 0) {
        await client.query("rollback");
        return res.status(409).json({ error: "already paired — confirmed entries exist; unpair first if this is wrong" });
      }

      const proposed = (await client.query(
        `select id, rc_number, rc_date, tenant_code, amount
           from rc_pairings
          where bank_transaction_id = $1 and status = 'proposed'
          for update`, [txn.id])).rows;
      if (proposed.length === 0) {
        await client.query("rollback");
        return res.status(409).json({ error: "nothing proposed — propose RC entries first",
          propose_via: `POST /bank/transactions/${txn.id}/rc-pairings { entries:[...] }` });
      }

      const bankCents = Math.abs(toCents(txn.amount));
      const propCents = proposed.reduce((s, r) => s + toCents(r.amount), 0);
      if (propCents !== bankCents) {
        await client.query("rollback");
        return res.status(409).json({
          error: "REFUSED — proposed entries do not sum to the bank line. A partial pairing can never read as done.",
          bank_amount: (bankCents / 100).toFixed(2),
          proposed_total: (propCents / 100).toFixed(2),
          gap: ((bankCents - propCents) / 100).toFixed(2),
          note: "fix the proposal (add the missing RC, correct an amount) or leave the line as honest unpaired exposure",
        });
      }

      await client.query(
        `update rc_pairings
            set status = 'confirmed', confirmed_by_person_id = $1, confirmed_at = now()
          where bank_transaction_id = $2 and status = 'proposed'`,
        [confirmed_by_person_id, txn.id]);

      // durable trail — the pairing is an explained finding now
      const rcList = proposed.map(p => `RC ${p.rc_number}${p.tenant_code ? ` (${p.tenant_code})` : ""} $${Number(p.amount).toFixed(2)}`).join(" + ");
      await client.query(
        `insert into events (property_id, type, note) values ($1,'payment_return_paired',$2)`,
        [txn.property_id,
         `$${(bankCents / 100).toFixed(2)} return ${txn.txn_date instanceof Date ? txn.txn_date.toISOString().slice(0,10) : txn.txn_date} paired to the cent: ${rcList} (bank_txn ${txn.id})`]);

      await client.query("commit");
      return res.status(201).json({
        receipt: `${proposed.length} RC entr${proposed.length === 1 ? "y" : "ies"} confirmed — $${(bankCents / 100).toFixed(2)} ties to the cent`,
        bank_transaction_id: txn.id,
        pairings: proposed.map(p => ({ ...p, status: "confirmed" })),
        note: "paired. This line leaves unpaired exposure on the board. No money_event was born — a return is revenue moving backward, never an expense.",
      });
    } catch (e) {
      try { await client.query("rollback"); } catch (_) {}
      console.error("rc-pairings confirm error", e);
      return res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // POST /bank/transactions/:id/rc-pairings/unpair — undo a confirm.
  // Trail-preserving: rows go to 'rejected', never deleted, so the
  // history of the first attempt survives a re-propose. Mirrors the
  // unbridge confirm pattern: confirm must equal the bank txn id.
  // Body: { confirm: "<bank_transaction_id>", note? }
  // ──────────────────────────────────────────────────────────────────
  router.post("/bank/transactions/:id/rc-pairings/unpair", async (req, res) => {
    const { confirm, note } = req.body || {};
    const client = await pool.connect();
    try {
      await client.query("begin");
      const txn = await loadReturnLine(client, req.params.id, res, { forUpdate: true });
      if (!txn) { await client.query("rollback"); return; }
      if (confirm !== txn.id) {
        await client.query("rollback");
        return res.status(403).json({ error: "confirm must equal the bank transaction id", bank_transaction_id: txn.id });
      }
      const upd = await client.query(
        `update rc_pairings
            set status = 'rejected',
                note = case when $2::text is null then note
                            else coalesce(note || ' | ', '') || 'unpaired: ' || $2 end
          where bank_transaction_id = $1 and status = 'confirmed'
          returning rc_number`, [txn.id, note || null]);
      if (upd.rowCount === 0) {
        await client.query("rollback");
        return res.status(409).json({ error: "not paired — no confirmed entries to unpair" });
      }
      await client.query(
        `insert into events (property_id, type, note) values ($1,'payment_return_unpaired',$2)`,
        [txn.property_id,
         `pairing rejected on bank_txn ${txn.id} (${upd.rowCount} RC entr${upd.rowCount === 1 ? "y" : "ies"})${note ? ` — ${note}` : ""}`]);
      await client.query("commit");
      return res.json({
        receipt: `${upd.rowCount} confirmed entr${upd.rowCount === 1 ? "y" : "ies"} → rejected (trail kept)`,
        note: "line returns to unpaired exposure on the board; re-propose when the right entries are known",
      });
    } catch (e) {
      try { await client.query("rollback"); } catch (_) {}
      console.error("rc-pairings unpair error", e);
      return res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // POST /bank/rc-pairings/:id/link-repay — the return→re-pay link.
  // The t0005237 case: $1,938.38 return on 9/05, $1,938.38 CHECKscan
  // deposit on 9/09 — the tenant re-paid after the bounce. Per RC row,
  // so each tenant in a batch can re-pay separately.
  // GATES: repay must be a CREDIT, same property, and match the RC row
  // amount to the cent. A mismatched link awaits live evidence — until
  // then exact-or-refuse.
  // Body: { repay_transaction_id }
  // ──────────────────────────────────────────────────────────────────
  router.post("/bank/rc-pairings/:id/link-repay", async (req, res) => {
    const { repay_transaction_id } = req.body || {};
    if (!repay_transaction_id) {
      return res.status(400).json({ error: "repay_transaction_id required" });
    }
    const client = await pool.connect();
    try {
      await client.query("begin");
      const p = await client.query(
        `select rp.*, ba.property_id
           from rc_pairings rp
           join bank_transactions t on t.id = rp.bank_transaction_id
           join bank_accounts ba on ba.id = t.bank_account_id
          where rp.id = $1 for update of rp`, [req.params.id]);
      if (p.rowCount === 0) { await client.query("rollback"); return res.status(404).json({ error: "pairing row not found" }); }
      const row = p.rows[0];
      if (row.status === "rejected") {
        await client.query("rollback");
        return res.status(409).json({ error: "pairing row is rejected — link the live row instead" });
      }
      if (row.repay_transaction_id && row.repay_transaction_id !== repay_transaction_id) {
        await client.query("rollback");
        return res.status(409).json({ error: "already linked to a different re-pay transaction", linked: row.repay_transaction_id });
      }
      if (row.repay_transaction_id === repay_transaction_id) {
        await client.query("rollback");
        return res.json({ receipt: "already linked — no change", repay_transaction_id });
      }
      const rep = await client.query(
        `select t.id, t.amount, t.txn_date, t.description, ba.property_id
           from bank_transactions t
           join bank_accounts ba on ba.id = t.bank_account_id
          where t.id = $1`, [repay_transaction_id]);
      if (rep.rowCount === 0) { await client.query("rollback"); return res.status(404).json({ error: "repay transaction not found" }); }
      const repay = rep.rows[0];
      if (Number(repay.amount) <= 0) {
        await client.query("rollback");
        return res.status(409).json({ error: "re-pay must be a CREDIT (money in)", amount: repay.amount });
      }
      if (repay.property_id !== row.property_id) {
        await client.query("rollback");
        return res.status(409).json({ error: "re-pay belongs to a different property", repay_property: repay.property_id, return_property: row.property_id });
      }
      if (toCents(repay.amount) !== toCents(row.amount)) {
        await client.query("rollback");
        return res.status(409).json({
          error: "re-pay amount does not match this RC entry to the cent — exact-or-refuse until a live mismatch case teaches otherwise",
          rc_amount: Number(row.amount).toFixed(2),
          repay_amount: Number(repay.amount).toFixed(2),
        });
      }
      await client.query(
        "update rc_pairings set repay_transaction_id = $1 where id = $2",
        [repay_transaction_id, row.id]);
      await client.query("commit");
      return res.json({
        receipt: `re-pay linked: RC ${row.rc_number}${row.tenant_code ? ` (${row.tenant_code})` : ""} $${Number(row.amount).toFixed(2)} ↔ ${repay.txn_date instanceof Date ? repay.txn_date.toISOString().slice(0,10) : repay.txn_date} credit`,
        note: "the return→re-pay story is now structural, not anecdotal",
      });
    } catch (e) {
      try { await client.query("rollback"); } catch (_) {}
      console.error("link-repay error", e);
      return res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // GET /bank/properties/:id/repay-candidates?amount=1938.38
  // READ-ONLY finder for link-repay: credit lines of this property
  // matching the RC amount to the cent. Identify is not commit —
  // candidates are surfaced for a human to link, never auto-linked.
  // ──────────────────────────────────────────────────────────────────
  router.get("/bank/properties/:id/repay-candidates", async (req, res) => {
    const amount = Number(req.query.amount);
    if (!(amount > 0)) return res.status(400).json({ error: "amount query param > 0 required" });
    try {
      const accts = await accountIds(req.params.id);
      if (accts.length === 0) return res.status(404).json({ error: "no bank accounts registered for this property" });
      const rows = (await pool.query(
        `select t.id as bank_transaction_id, t.txn_date, t.description, t.amount,
                ba.account_label,
                exists (select 1 from rc_pairings rp where rp.repay_transaction_id = t.id) as already_linked
           from bank_transactions t
           join bank_accounts ba on ba.id = t.bank_account_id
          where t.bank_account_id = any($1) and t.amount > 0
            and round(t.amount * 100) = round($2::numeric * 100)
          order by t.txn_date`, [accts, amount])).rows;
      return res.json({
        amount: amount.toFixed(2),
        candidates: rows,
        note: "READ-ONLY — exact-cents credit matches. A human links via POST /bank/rc-pairings/:id/link-repay; nothing here auto-links.",
      });
    } catch (e) {
      console.error("repay-candidates error", e);
      return res.status(500).json({ error: e.message });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  //  AUTO-CONFIRM LANDING (migration 044) — the real-time path.
  //  Sweeps a property's eligible UNBRIDGED lines and, for each, asks
  //  autoconfirm.decideAutoConfirm whether the (vendor, property) switch
  //  is on AND the amount is inside the learned band. Auto-eligible lines
  //  bridge through the SAME bridgeTxn lifecycle every human confirm uses —
  //  but stamped confirm_method='auto' + the authorizing rule, and with
  //  confirmed_by = the human who GRANTED the switch (not a live click).
  //  Out-of-band or no-switch lines are LEFT for the human queue. This is
  //  the "fires when a Plaid row lands" entry point — call it after a pull.
  //
  //  Body: { acting_as_person_id? }  — optional override of the recorded
  //         grantor for the confirmed_by stamp; defaults to the rule's
  //         auto_confirm_by (the human who earned+granted the autonomy).
  //  It NEVER auto-confirms a multi-nature vendor (same handler block as
  //  bridge-vendor) and NEVER an exception/credit line (ELIGIBLE guard).
  // ──────────────────────────────────────────────────────────────────
  router.post("/bank/properties/:id/bridge-auto", async (req, res) => {
    const propertyId = req.params.id;
    const client = await pool.connect();
    try {
      await client.query("begin");

      const prop = await client.query("select id from properties where id = $1", [propertyId]);
      if (prop.rowCount === 0) { await client.query("rollback"); return res.status(404).json({ error: "property not found" }); }

      // candidate lines: eligible (unbridged, non-exception, debits), with a
      // known vendor, at this property. Locked for the txn.
      const txns = (await client.query(
        `select t.* from bank_transactions t
          where t.bank_account_id in (select id from bank_accounts where property_id = $1)
            and t.vendor_id is not null and ${ELIGIBLE}
          order by t.txn_date for update`, [propertyId])).rows;

      const auto = [];
      const left = [];
      for (const txn of txns) {
        // multi-nature vendors are never auto-confirmed — fetch nature + name
        const v = await client.query(
          "select id, canonical_name, multi_nature from vendors where id = $1", [txn.vendor_id]);
        if (v.rowCount === 0) { left.push({ id: txn.id, reason: "vendor_row_missing" }); continue; }
        const vendor = v.rows[0];
        if (vendor.multi_nature === true) { left.push({ id: txn.id, reason: "multi_nature" }); continue; }

        const decision = await decideAutoConfirm(client, {
          property_id: propertyId, vendor_id: vendor.id, amount: txn.amount });

        if (!decision.auto) {
          left.push({ id: txn.id, vendor: vendor.canonical_name, reason: decision.reason,
                      ...(decision.band ? { band: decision.band, amount: decision.amount } : {}) });
          continue;
        }

        // resolve the human who granted autonomy → confirmed_by stamp
        const ruleRow = await client.query(
          "select auto_confirm_by from vendor_property_categories where id = $1", [decision.rule_id]);
        const grantor = (req.body && req.body.acting_as_person_id) || ruleRow.rows[0]?.auto_confirm_by || null;
        if (!grantor) { left.push({ id: txn.id, vendor: vendor.canonical_name, reason: "no_grantor_on_rule" }); continue; }

        const meId = await bridgeTxn(client, {
          txn, vendorName: vendor.canonical_name, property_id: propertyId,
          confirmed_category: decision.confirmed_category,
          confirmed_by_person_id: grantor, what_for: "other", mode: "auto_confirm",
          extraProv: { auto_confirm: true, rule_id: decision.rule_id },
        });
        // stamp HOW it was confirmed + which rule authorized it
        await client.query(
          `update money_events set confirm_method = 'auto', auto_confirm_rule_id = $1 where id = $2`,
          [decision.rule_id, meId]);
        auto.push({ bank_txn: txn.id, money_event: meId, vendor: vendor.canonical_name,
                    category: decision.confirmed_category, amount: Math.abs(Number(txn.amount)) });
      }

      await client.query("commit");
      res.status(201).json({
        property_id: propertyId,
        auto_confirmed: auto.length,
        auto_gross: Number(auto.reduce((s, a) => s + a.amount, 0).toFixed(2)),
        auto,
        left_for_human: left.length,
        left,
        note: "Auto-confirmed lines bridged through the same obligation lifecycle as a human confirm, stamped confirm_method='auto'. Out-of-band and un-switched lines were left for the human queue — today's behavior.",
      });
    } catch (e) {
      await client.query("rollback");
      console.error("bridge-auto error:", e);
      res.status(500).json({ error: "auto-confirm landing failed", detail: e.message });
    } finally {
      client.release();
    }
  });

  return router;
};
