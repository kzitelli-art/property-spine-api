// ============================================================
// bank_intake.js — Bank Intake: the onboarding/training rung (migration 012)
//
// SEPARATE from money.js on purpose. money.js owns money EVENTS (operator
// captures spend, approval chain, report_ready). THIS module owns the other
// direction: real BANK artifacts come in, every line is staged as a CLAIM,
// and nothing becomes "identified money movement" without payee proof.
//
// THE PRODUCT RULE (locked):
//   bank transaction                       → claim
//   claim + vendor/payee proof             → identified money movement
//   claim + GL/category proof (NEXT rung)  → reportable accounting line
//   anything missing proof                 → visible exposure (GROSS, not net)
//
// HARD RULES THIS MODULE ENFORCES:
//   1. Checks are NEVER identified from amount/date/description. The bank
//      statement carries no payee for checks (proven on the real Flagstar
//      statement). A check stays 'claimed' until the Yardi check-register
//      join proves its payee — number AND amount must both match.
//   2. Unknown electronic payees are auto-registered in the unresolved
//      alias queue (vendor_id null) — seen, never guessed. Same pattern as
//      the property registry (011).
//   3. Ambiguity attaches nothing. Two alias hits → 'ambiguous_payee',
//      stays claimed. Two statement checks with the same number (the real
//      capex Check-1151-rejected-twice case) → no join, stays claimed.
//   4. report_ready is unreachable in this rung. Vendor proof ≠ category
//      proof. The board reports report_ready: 0 with the reason.
//   5. The headline is gross_unidentified_exposure = sum(|amount|) of
//      claimed lines. Never net — offsetting errors must not read clean.
//
// THIS IS THE ONBOARDING PASS, not the ongoing monthly workflow. One
// historical package teaches the property's money language (account
// aliases, vendor codes, check-register behavior, recurring payees).
// The ongoing flow (new txn → match trained registry → human confirms)
// builds on these same tables in the next rung.
//
// Factory (matches the standing module pattern):
//   const bankIntakeModule = require('./bank_intake');
//   app.use('/', bankIntakeModule({ pool }));
// ============================================================

const express = require("express");
const staffSessions = require("../identity/staff_session_service.js");     // Build 1A-1: a key is not an actor
const propertyCreation = require("../identity/property_creation_service.js"); // Build 1A-1: THE property write

// ── normalization: ONE function, used for aliases and descriptions ────
// upper-case, every run of non-alphanumerics collapses to a single space.
function norm(s) {
  return String(s || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

// ── owner-facing exception patterns ──────────────────────────────────
// Streaming/consumer-subscription strings on a PROPERTY operating account.
// These are flags for the owner, not verdicts — an identified Verizon bill
// is normal; an identified Spotify charge is the 4125 commingling pattern.
// Deliberately narrow: AMAZON PRIME is flagged, AMAZON MKTPL is not
// (marketplace orders are routinely property supplies).
const NON_PROPERTY_PATTERNS = [
  "SPOTIFY", "YOUTUBE", "NETFLIX", "HULU", "AMAZON PRIME",
  "APPLE COM BILL", "DISNEY", "PARAMOUNT", "PELOTON",
];

// ── payment-return detection (the Virtus rule, Jun 11 2026) ──────────
// An ELECTRONIC debit whose descriptor carries the word RETURN is, until a
// human proves otherwise, a PAYMENT CLAWBACK — revenue moving backward, not
// an expense. Proven on real data: six "External Withdrawal VIRTUSMANAGEMENT
// - Return ..." lines decomposed to the cent into Yardi RC tenant-return
// entries; the alias match had identified the PROCESSOR as the counterparty.
// Deliberately narrow: the literal word RETURN, electronic debits only.
// Checks have their own path (check_return / bounce pair — later slice).
function isPaymentReturn(normedDesc, txn_type, amount) {
  return txn_type !== "check" && txn_type !== "check_return"
      && Number(amount) < 0
      && /\bRETURN\b/.test(normedDesc);
}

module.exports = function bankIntakeModule({ pool }) {
  const router = express.Router();

  // ──────────────────────────────────────────────────────────────────
  // POST /bank/onboard-property
  // Entry door for a property that may not exist yet (Tower Place is not
  // one of the three production properties). Upserts by canonical_key —
  // address-anchored identity, same anchor the registry (011) enforces.
  // Body: { name, canonical_key, address?, organization_id? }
  // Header: x-staff-session (REQUIRED as of Build 1A-1)
  //
  // ── WHY THIS ROUTE NOW NEEDS A SESSION ───────────────────────────
  // It used to sit behind the shared OPERATOR_KEY alone, which meant a
  // property — durable Spine truth every board and report reads — could
  // be created with no attributable human and no organization. Build 0
  // measured that (docs/archive/BUILD_0_ONBOARDING_AUTHORITY_AUDIT.md §2B) and
  // Build 1A-1 closes it: the write is now the canonical service's, and
  // the service refuses without a session-resolved actor.
  //
  // The key gate above still applies; this is strictly narrower. Nothing
  // in the deployed app called this route (measured across index.html and
  // every app module), so no live surface loses a capability.
  //
  // The canonical-key IDEMPOTENCY this route pioneered is preserved
  // exactly — same key means the same property, never a duplicate — and
  // gains a cross-organization refusal it did not have.
  // ──────────────────────────────────────────────────────────────────
  router.post("/bank/onboard-property", async (req, res) => {
    const { name, canonical_key, address, organization_id } = req.body || {};
    if (!name || !canonical_key) {
      return res.status(400).json({ error: "name and canonical_key required (canonical_key is address-anchored, e.g. 1400-BUTTONWOOD)" });
    }
    try {
      const session = await staffSessions.resolveStaffSession(pool, req.get("x-staff-session"));
      if (!session) {
        return res.status(401).json({
          error: "A staff session is required to create a property.",
          reason: "no_authenticated_actor",
          receipt: "Send x-staff-session. The operator key authenticates the caller, not the human — " +
                   "and creating a property records who did it.",
        });
      }
      const out = await propertyCreation.createProperty(pool, {
        actor: { user_id: session.id },
        organization_id: organization_id || null,
        name, address, canonical_key,
        source: "bank_intake",
        idempotent: true,          // the behaviour this door contributed
      });
      return res.json({ property: out.property, created: out.created, receipt: out.receipt });
    } catch (e) {
      if (e.httpStatus) {
        return res.status(e.httpStatus).json({ error: e.publicMessage, reason: e.refusalReason, ...e.detail });
      }
      return res.status(500).json({ error: e.message, hint: "if this is a column error, the properties table shape differs from baseline — paste this error back" });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // POST /bank/accounts
  // Register a bank account with BOTH its names — the bank's current name
  // and the GL's historical name ("Tower - Operating - NYCB" vs Flagstar).
  // Body: { property_id, account_label, account_last4, bank_name, gl_name?, account_role }
  // ──────────────────────────────────────────────────────────────────
  router.post("/bank/accounts", async (req, res) => {
    const { property_id, account_label, account_last4, bank_name, gl_name, account_role } = req.body || {};
    if (!property_id || !account_label || !account_last4 || !bank_name) {
      return res.status(400).json({ error: "property_id, account_label, account_last4, bank_name required" });
    }
    try {
      const r = await pool.query(
        `insert into bank_accounts (property_id, account_label, account_last4, bank_name, gl_name, account_role)
         values ($1,$2,$3,$4,$5,coalesce($6,'operating'))
         on conflict (property_id, account_last4)
         do update set account_label=excluded.account_label, bank_name=excluded.bank_name,
                       gl_name=excluded.gl_name, account_role=excluded.account_role
         returning *`,
        [property_id, account_label, account_last4, bank_name, gl_name || null, account_role || null]
      );
      return res.json({ bank_account: r.rows[0] });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // POST /bank/vendors/seed
  // Seed the vendor registry from the property's OWN Yardi rec / check
  // register — the answer key teaches the registry, never the other way.
  // Body: { vendors: [{ name, yardi_code?, vendor_type?, bank_aliases?: [] }] }
  // bank_aliases are the tokens this payee appears as in BANK descriptions.
  // Idempotent: re-seeding upserts, never duplicates.
  // ──────────────────────────────────────────────────────────────────
  router.post("/bank/vendors/seed", async (req, res) => {
    const { vendors } = req.body || {};
    if (!Array.isArray(vendors) || vendors.length === 0) {
      return res.status(400).json({ error: "vendors array required" });
    }
    const results = [];
    try {
      for (const v of vendors) {
        if (!v || !v.name) { results.push({ skipped: true, reason: "no name", input: v }); continue; }
        const name = String(v.name).trim();
        const code = v.yardi_code ? String(v.yardi_code).trim() : null;
        const vtype = v.vendor_type || "vendor";
        let row;
        if (code) {
          const r = await pool.query(
            `insert into vendors (canonical_name, yardi_code, vendor_type)
             values ($1,$2,$3)
             on conflict (yardi_code) where yardi_code is not null
             do update set canonical_name=excluded.canonical_name, vendor_type=excluded.vendor_type
             returning *`, [name, code, vtype]);
          row = r.rows[0];
        } else {
          const r = await pool.query(
            `insert into vendors (canonical_name, yardi_code, vendor_type)
             values ($1,null,$2)
             on conflict (lower(canonical_name)) where yardi_code is null
             do update set vendor_type=excluded.vendor_type
             returning *`, [name, vtype]);
          row = r.rows[0];
        }
        const aliases = [];
        for (const a of (v.bank_aliases || [])) {
          const av = norm(a);
          if (!av) continue;
          await pool.query(
            `insert into vendor_aliases (vendor_id, source_system, alias_value, note)
             values ($1,'bank_description',$2,$3)
             on conflict (source_system, alias_value)
             do update set vendor_id=excluded.vendor_id
             returning id`, [row.id, av, `seeded from rec answer key for ${name}`]);
          aliases.push(av);
        }
        // the yardi_rec alias (the literal "v0000xxx - Name" form) for traceability
        if (code) {
          await pool.query(
            `insert into vendor_aliases (vendor_id, source_system, alias_value)
             values ($1,'yardi_rec',$2)
             on conflict (source_system, alias_value) do update set vendor_id=excluded.vendor_id`,
            [row.id, norm(`${code} - ${name}`)]);
        }
        results.push({ vendor_id: row.id, name: row.canonical_name, yardi_code: row.yardi_code, vendor_type: row.vendor_type, bank_aliases: aliases });
      }
      return res.json({ seeded: results.length, vendors: results });
    } catch (e) {
      return res.status(500).json({ error: e.message, progress: results });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // POST /bank/accounts/:id/transactions
  // Stage statement lines as CLAIMS. Resolution at stage time:
  //   • checks / check_returns → ALWAYS stay 'claimed' (rule 1)
  //   • electronic lines → match normalized description against the
  //     bank_description alias registry:
  //       exactly one vendor matches → identified (source: bank_description)
  //       multiple vendors match     → claimed + exception 'ambiguous_payee'
  //       zero matches               → claimed + auto-registered unresolved alias
  //   • exception flags applied regardless of identification:
  //       non-property merchant pattern → possible_non_property_spend
  //       'REJECTED' / check_return     → rejected_check
  //       management-vendor settlement debit → composite_batch (a lump that
  //         contains many vendor payments — contents unproven at this grain)
  //       owner_affiliate vendor        → affiliate_transfer
  // Body: { source_document, transactions: [{txn_date, description, amount, txn_type, check_number?}] }
  // Idempotent via the natural-key unique index — re-staging inserts nothing.
  // ──────────────────────────────────────────────────────────────────
  router.post("/bank/accounts/:id/transactions", async (req, res) => {
    const accountId = req.params.id;
    const { source_document, transactions } = req.body || {};
    if (!Array.isArray(transactions) || transactions.length === 0) {
      return res.status(400).json({ error: "transactions array required" });
    }
    try {
      const acct = await pool.query("select * from bank_accounts where id=$1", [accountId]);
      if (acct.rows.length === 0) return res.status(404).json({ error: "bank account not found" });

      // pull the alias registry once (small) — matching happens in JS so the
      // logic is one readable block, not a SQL trick
      const aliasRows = (await pool.query(
        `select va.alias_value, va.vendor_id, v.canonical_name, v.vendor_type
           from vendor_aliases va
           left join vendors v on v.id = va.vendor_id
          where va.source_system = 'bank_description'`)).rows;

      const summary = { inserted: 0, skipped_duplicates: 0, identified: 0, claimed: 0, unresolved_aliases_registered: 0, exceptions: [] };

      for (const t of transactions) {
        if (!t || !t.txn_date || t.amount === undefined || !t.description || !t.txn_type) {
          summary.exceptions.push({ skipped: true, reason: "missing fields", input: t });
          continue;
        }
        const d = norm(t.description);
        const isCheck = t.txn_type === "check" || t.txn_type === "check_return";

        let status = "claimed", vendor_id = null, identSource = null, exception = null;

        if (!isCheck) {
          const hits = aliasRows.filter(a => a.vendor_id && d.includes(a.alias_value));
          const vendorIds = [...new Set(hits.map(h => h.vendor_id))];
          if (vendorIds.length === 1) {
            status = "identified"; vendor_id = vendorIds[0]; identSource = "bank_description";
            const vt = hits.find(h => h.vendor_id === vendor_id).vendor_type;
            // composite batch: a management-company settlement DEBIT is a lump
            // of many vendor payments — payee identified, contents unproven
            if (vt === "management" && Number(t.amount) < 0 && d.includes("SETTLEMENT")) {
              exception = "composite_batch";
            }
            if (vt === "owner_affiliate") exception = "affiliate_transfer";
          } else if (vendorIds.length > 1) {
            exception = "ambiguous_payee"; // ambiguity attaches nothing
          } else {
            // unseen payee → unresolved queue (seen, never guessed)
            const ins = await pool.query(
              `insert into vendor_aliases (vendor_id, source_system, alias_value, note)
               values (null,'bank_description',$1,$2)
               on conflict (source_system, alias_value) do nothing
               returning id`,
              [d, `auto-registered unresolved from ${source_document || "statement"}`]);
            if (ins.rows.length > 0) summary.unresolved_aliases_registered++;
          }
        }
        // exception flags that apply regardless of identification
        if (NON_PROPERTY_PATTERNS.some(p => d.includes(p))) exception = "possible_non_property_spend";
        if (t.txn_type === "check_return" || d.includes("REJECTED")) exception = "rejected_check";
        // payment_return wins precedence: a clawback is never an expense,
        // whatever else the descriptor looks like
        if (isPaymentReturn(d, t.txn_type, t.amount)) exception = "payment_return";

        const ins = await pool.query(
          `insert into bank_transactions
             (bank_account_id, txn_date, description, amount, txn_type, check_number,
              status, vendor_id, identification_source, exception_reason, source_document)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           on conflict (bank_account_id, txn_date, description, amount) do nothing
           returning id`,
          [accountId, t.txn_date, String(t.description).trim(), t.amount, t.txn_type,
           t.check_number ? String(t.check_number) : null,
           status, vendor_id, identSource, exception, source_document || null]);

        if (ins.rows.length === 0) { summary.skipped_duplicates++; continue; }
        summary.inserted++;
        if (status === "identified") summary.identified++; else summary.claimed++;
        if (exception) summary.exceptions.push({ txn: `${t.txn_date} ${t.description}`.slice(0, 80), amount: t.amount, exception });
      }
      return res.json({ account: acct.rows[0].account_label, ...summary });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // POST /bank/accounts/:id/register-join
  // The check-register answer key joins checks to payees. A join requires
  // check_number match AND exact amount match — both, or it does not join.
  // Outcomes per row:
  //   joined            — one statement check, number+amount match → identified
  //   amount_mismatch   — number matches, amount doesn't → flagged, stays claimed
  //   ambiguous_check_number — >1 statement check with this number → NO guess
  //   not_on_statement  — register row with no statement line (outstanding /
  //                       prior period) → recorded as an orphan for the
  //                       cross-account story board
  // Body: { rows: [{ check_number, amount, payee_name, yardi_code? }] }
  // ──────────────────────────────────────────────────────────────────
  router.post("/bank/accounts/:id/register-join", async (req, res) => {
    const accountId = req.params.id;
    const { rows } = req.body || {};
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: "rows array required: [{check_number, amount, payee_name, yardi_code?}]" });
    }
    const outcomes = [];
    try {
      for (const row of rows) {
        if (!row || !row.check_number || row.amount === undefined || !row.payee_name) {
          outcomes.push({ outcome: "skipped", reason: "missing fields", input: row }); continue;
        }
        const checkNo = String(row.check_number);
        const amt = Number(row.amount);

        const txns = (await pool.query(
          `select * from bank_transactions
            where bank_account_id=$1 and txn_type='check' and check_number=$2`,
          [accountId, checkNo])).rows;

        if (txns.length === 0) {
          await pool.query(
            `insert into check_register_orphans (bank_account_id, check_number, payee_name, yardi_code, amount, reason)
             values ($1,$2,$3,$4,$5,'not_on_statement')
             on conflict (bank_account_id, check_number, amount) do nothing`,
            [accountId, checkNo, row.payee_name, row.yardi_code || null, Math.abs(amt)]);
          outcomes.push({ check_number: checkNo, payee: row.payee_name, amount: amt, outcome: "not_on_statement" });
          continue;
        }
        if (txns.length > 1) {
          // the real capex case: Check 1151 debited twice (rejected twice).
          // Two statement lines, one register identity → no join, no guess.
          await pool.query(
            `insert into check_register_orphans (bank_account_id, check_number, payee_name, yardi_code, amount, reason)
             values ($1,$2,$3,$4,$5,'ambiguous_check_number')
             on conflict (bank_account_id, check_number, amount) do nothing`,
            [accountId, checkNo, row.payee_name, row.yardi_code || null, Math.abs(amt)]);
          outcomes.push({ check_number: checkNo, payee: row.payee_name, outcome: "ambiguous_check_number", statement_lines: txns.length });
          continue;
        }
        const txn = txns[0];
        if (Math.abs(Number(txn.amount)).toFixed(2) !== Math.abs(amt).toFixed(2)) {
          await pool.query(
            `update bank_transactions set exception_reason='amount_mismatch' where id=$1`, [txn.id]);
          outcomes.push({ check_number: checkNo, payee: row.payee_name, outcome: "amount_mismatch",
                          statement_amount: txn.amount, register_amount: amt });
          continue;
        }
        // proof complete: upsert the vendor, identify the claim
        let vrow;
        if (row.yardi_code) {
          const r = await pool.query(
            `insert into vendors (canonical_name, yardi_code, vendor_type)
             values ($1,$2,$3)
             on conflict (yardi_code) where yardi_code is not null
             do update set canonical_name=excluded.canonical_name
             returning *`,
            [String(row.payee_name).trim(), String(row.yardi_code).trim(),
             String(row.yardi_code).trim().startsWith("t") ? "tenant" : "vendor"]);
          vrow = r.rows[0];
        } else {
          const r = await pool.query(
            `insert into vendors (canonical_name, yardi_code, vendor_type)
             values ($1,null,'vendor')
             on conflict (lower(canonical_name)) where yardi_code is null
             do update set canonical_name=vendors.canonical_name
             returning *`, [String(row.payee_name).trim()]);
          vrow = r.rows[0];
        }
        const except = vrow.vendor_type === "owner_affiliate" ? "affiliate_transfer" : null;
        await pool.query(
          `update bank_transactions
              set status='identified', vendor_id=$2, identification_source='check_register_join',
                  exception_reason = coalesce($3, exception_reason)
            where id=$1`, [txn.id, vrow.id, except]);
        outcomes.push({ check_number: checkNo, payee: vrow.canonical_name, amount: txn.amount, outcome: "joined" });
      }
      const counts = outcomes.reduce((m, o) => { m[o.outcome] = (m[o.outcome] || 0) + 1; return m; }, {});
      return res.json({ rows_processed: rows.length, counts, outcomes });
    } catch (e) {
      return res.status(500).json({ error: e.message, progress: outcomes });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // GET /bank/accounts/:id/board
  // The per-account truth board. Headline = gross_unidentified_exposure
  // (sum of |amount| of claimed lines) — NEVER net. report_ready is 0 by
  // construction this rung, and the board says why.
  // ──────────────────────────────────────────────────────────────────
  router.get("/bank/accounts/:id/board", async (req, res) => {
    try {
      const acct = (await pool.query("select * from bank_accounts where id=$1", [req.params.id])).rows[0];
      if (!acct) return res.status(404).json({ error: "bank account not found" });

      const agg = (await pool.query(
        `select status, count(*)::int as n, coalesce(sum(abs(amount)),0)::numeric(14,2) as gross
           from bank_transactions where bank_account_id=$1 group by status`, [req.params.id])).rows;
      const by = Object.fromEntries(agg.map(r => [r.status, r]));

      const claimedLines = (await pool.query(
        `select txn_date, description, amount, txn_type, check_number, exception_reason
           from bank_transactions where bank_account_id=$1 and status='claimed'
           order by txn_date`, [req.params.id])).rows;

      const exceptions = (await pool.query(
        `select exception_reason, count(*)::int as n, coalesce(sum(abs(amount)),0)::numeric(14,2) as gross
           from bank_transactions where bank_account_id=$1 and exception_reason is not null
           group by exception_reason order by gross desc`, [req.params.id])).rows;

      const topPayees = (await pool.query(
        `select v.canonical_name, v.vendor_type, count(*)::int as txns,
                coalesce(sum(abs(t.amount)),0)::numeric(14,2) as gross
           from bank_transactions t join vendors v on v.id=t.vendor_id
          where t.bank_account_id=$1 and t.status='identified'
          group by v.canonical_name, v.vendor_type order by gross desc limit 15`, [req.params.id])).rows;

      const gross_unidentified = Number(by.claimed ? by.claimed.gross : 0);
      return res.json({
        account: { label: acct.account_label, last4: acct.account_last4, bank: acct.bank_name, gl_name: acct.gl_name, role: acct.account_role },
        totals: {
          transactions: agg.reduce((s, r) => s + r.n, 0),
          identified: by.identified ? by.identified.n : 0,
          identified_gross: Number(by.identified ? by.identified.gross : 0),
          claimed: by.claimed ? by.claimed.n : 0,
        },
        gross_unidentified_exposure: gross_unidentified,
        fully_identified: gross_unidentified === 0,
        report_ready: 0,
        report_ready_note: "vendor proof only — GL/category proof is the next rung; nothing here rolls into a report yet",
        unidentified_lines: claimedLines,
        exceptions,
        top_identified_payees: topPayees,
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // GET /bank/properties/:id/board
  // Property-level board: every account's summary + CROSS-ACCOUNT STORIES —
  // claimed checks in one account matched by |amount| to register orphans
  // in a DIFFERENT account of the same property. Surfaced for review, never
  // auto-concluded. (The real story: capex Check 1151 rejected twice ↔
  // operating register check 1977, Hesta Renovations, same $27,700.)
  // ──────────────────────────────────────────────────────────────────
  router.get("/bank/properties/:id/board", async (req, res) => {
    try {
      const accounts = (await pool.query(
        "select * from bank_accounts where property_id=$1 order by account_role", [req.params.id])).rows;
      if (accounts.length === 0) return res.status(404).json({ error: "no bank accounts registered for this property" });

      const perAccount = [];
      for (const a of accounts) {
        const agg = (await pool.query(
          `select status, count(*)::int as n, coalesce(sum(abs(amount)),0)::numeric(14,2) as gross
             from bank_transactions where bank_account_id=$1 group by status`, [a.id])).rows;
        const by = Object.fromEntries(agg.map(r => [r.status, r]));
        perAccount.push({
          bank_account_id: a.id, label: a.account_label, role: a.account_role, last4: a.account_last4,
          transactions: agg.reduce((s, r) => s + r.n, 0),
          identified: by.identified ? by.identified.n : 0,
          claimed: by.claimed ? by.claimed.n : 0,
          gross_unidentified_exposure: Number(by.claimed ? by.claimed.gross : 0),
        });
      }

      const stories = (await pool.query(
        `select t.txn_date, t.description, t.amount, t.check_number as statement_check,
                ta.account_label as statement_account,
                o.check_number as register_check, o.payee_name, o.amount as register_amount,
                oa.account_label as register_account
           from bank_transactions t
           join bank_accounts ta on ta.id = t.bank_account_id
           join check_register_orphans o on abs(t.amount) = o.amount
           join bank_accounts oa on oa.id = o.bank_account_id
          where ta.property_id = $1 and oa.property_id = $1
            and t.txn_type in ('check','check_return') and t.status = 'claimed'
            and t.bank_account_id <> o.bank_account_id
          order by o.amount desc`, [req.params.id])).rows;

      const totalExposure = perAccount.reduce((s, a) => s + a.gross_unidentified_exposure, 0);
      return res.json({
        property_id: req.params.id,
        accounts: perAccount,
        gross_unidentified_exposure: Number(totalExposure.toFixed(2)),
        fully_identified: totalExposure === 0,
        cross_account_stories: stories.map(s => ({
          note: `Statement check ${s.statement_check || "?"} in ${s.statement_account} (${s.txn_date.toISOString ? s.txn_date.toISOString().slice(0,10) : s.txn_date}, ${s.amount}) matches register check ${s.register_check} to ${s.payee_name} ($${s.register_amount}) in ${s.register_account} — same amount, different accounts. Review: likely the same payment moved or reissued. Not auto-concluded.`,
          statement: { account: s.statement_account, check: s.statement_check, date: s.txn_date, amount: s.amount, description: s.description },
          register: { account: s.register_account, check: s.register_check, payee: s.payee_name, amount: s.register_amount },
        })),
        unresolved_payee_queue: (await pool.query(
          `select alias_value, note from vendor_aliases
            where vendor_id is null and source_system='bank_description'
            order by created_at desc limit 25`)).rows,
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // POST /bank/accounts/:id/flag-returns
  // Backfill for lines staged BEFORE the payment_return class existed
  // (the six live Virtus lines). Scans non-bridged ELECTRONIC debits;
  // any line matching the return pattern gets exception_reason =
  // 'payment_return'. Lines already carrying a DIFFERENT exception are
  // reported, never silently overridden — the human resolves those.
  // Idempotent: a second run flags nothing new.
  // ──────────────────────────────────────────────────────────────────
  router.post("/bank/accounts/:id/flag-returns", async (req, res) => {
    try {
      const acct = (await pool.query("select * from bank_accounts where id=$1", [req.params.id])).rows[0];
      if (!acct) return res.status(404).json({ error: "bank account not found" });

      const candidates = (await pool.query(
        `select id, txn_date, description, amount, exception_reason
           from bank_transactions
          where bank_account_id = $1
            and money_event_id is null
            and txn_type not in ('check','check_return')
            and amount < 0
          order by txn_date`, [req.params.id])).rows;

      const flagged = [], conflicting = [];
      let alreadyFlagged = 0;
      for (const c of candidates) {
        if (!/\bRETURN\b/.test(norm(c.description))) continue;
        if (c.exception_reason === "payment_return") { alreadyFlagged++; continue; }
        if (c.exception_reason) {
          conflicting.push({
            bank_transaction_id: c.id, txn_date: c.txn_date,
            description: String(c.description).slice(0, 80), amount: c.amount,
            existing_exception: c.exception_reason,
            note: "matches return pattern but already carries a different flag — not overridden, resolve by hand",
          });
          continue;
        }
        await pool.query(
          `update bank_transactions set exception_reason='payment_return' where id=$1`, [c.id]);
        flagged.push({
          bank_transaction_id: c.id, txn_date: c.txn_date,
          description: String(c.description).slice(0, 80), amount: c.amount,
        });
      }

      return res.json({
        account: acct.account_label,
        flagged_count: flagged.length,
        flagged_gross: Number(flagged.reduce((s, f) => s + Math.abs(Number(f.amount)), 0).toFixed(2)),
        flagged,
        already_flagged: alreadyFlagged,
        conflicting_exceptions: conflicting,
        note: "payment_return lines leave the expense queues entirely; bridging them is refused by design. Pairing with Yardi RC entries is the next slice.",
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // POST /bank/properties/:id/bank-reset
  // Harness-only guarded reset: deletes this property's bank transactions,
  // orphans, and accounts so the onboarding pass can re-run clean. Vendors
  // and aliases are KEPT — they are the trained registry, the point of the
  // exercise. Requires the property's canonical_key as the confirm token.
  // ──────────────────────────────────────────────────────────────────
  router.post("/bank/properties/:id/bank-reset", async (req, res) => {
    const { confirm } = req.body || {};
    try {
      const p = (await pool.query("select canonical_key from properties where id=$1", [req.params.id])).rows[0];
      if (!p) return res.status(404).json({ error: "property not found" });
      if (!confirm || confirm !== p.canonical_key) {
        return res.status(403).json({ error: "confirm must equal the property's canonical_key", expected_shape: "e.g. 1400-BUTTONWOOD" });
      }
      const accts = (await pool.query("select id from bank_accounts where property_id=$1", [req.params.id])).rows.map(r => r.id);
      let txns = 0, orphans = 0;
      if (accts.length > 0) {
        txns = (await pool.query("delete from bank_transactions where bank_account_id = any($1)", [accts])).rowCount;
        orphans = (await pool.query("delete from check_register_orphans where bank_account_id = any($1)", [accts])).rowCount;
        await pool.query("delete from bank_accounts where property_id=$1", [req.params.id]);
      }
      return res.json({ reset: true, deleted: { transactions: txns, orphans, accounts: accts.length }, kept: "vendors + aliases (the trained registry)" });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  return router;
};
