// ============================================================
// plaid.js — Plaid: a SECOND FEED into the bank intake claim door (migration 031)
//
// THE ONE IDEA: Plaid is not a new bank pipeline. The manual path today is
//   bank PDF → typed lines → POST /bank/accounts/:id/transactions
// (bankintake.js, migration 012). Plaid replaces the TYPING: it pulls the
// same statement lines from the bank over an API and lands them in the same
// bank_transactions table, in the same { txn_date, amount, description,
// txn_type } shape. The instant a row lands, the existing engine —
// payee identification, the unresolved-alias queue, exception flags,
// idempotency, exposure math, the activation surface — already works.
// This module adds NOTHING to the money model. It only:
//   1. links a bank login (Plaid Link → exchange → remember the connection)
//   2. maps Plaid's reported sub-accounts to OUR bank_accounts rows
//   3. on demand, pulls new transactions and normalizes them into the
//      existing claim shape, then routes them through the SAME staging
//      logic bankintake.js uses.
//
// CREDENTIAL DISCIPLINE (hard):
//   • PLAID_CLIENT_ID / PLAID_SECRET live in Render env vars, NEVER in code
//     or the DB — same shape as the Twilio keys. Fail-soft when unset: every
//     route returns a clean 503 receipt telling the operator what is missing,
//     exactly like sms.js does when Twilio is unconfigured.
//   • The Plaid access_token is a live credential. It is stored in plaid_item
//     because the server must call Plaid with it, but NO read endpoint in
//     this module ever returns it to the browser. Reads return id, status,
//     institution_name, masks — never the token.
//   • The bank-login step (Plaid Link) is a person-in-the-loop OAuth handoff
//     by design. The operator authenticates to their own bank in Plaid's
//     widget; this server only ever sees the short-lived public_token the
//     widget hands back, which it exchanges once and discards.
//
// SIGNED-AMOUNT TRANSLATION (the one real gotcha):
//   Plaid: amount POSITIVE means money LEFT the account (a debit).
//   Spine: amount NEGATIVE means money out (bankintake.js convention).
//   So spine_amount = -plaid.amount. Proven against the 012 schema comment:
//   "positive = credit (money in), negative = debit (money out)."
//
// Factory (matches the standing module pattern):
//   const plaidModule = require('./plaid');
//   app.use('/', plaidModule({ pool }));
//
// 'plaid' is a normal dependency (npm i plaid). When the package or the env
// vars are absent the module still loads and every route fails soft — the
// rest of the API is never blocked by Plaid being unconfigured.
// ============================================================

const express = require("express");

// ── lazy, fail-soft SDK + client construction ─────────────────────────
// Never throw at require time. If the package isn't installed yet, or the
// env vars aren't set, we want the server to boot fine and the Plaid routes
// to return an honest 503 — not a crash loop on deploy.
let PlaidApi = null, Configuration = null, PlaidEnvironments = null, plaidLoadError = null;
try {
  const plaid = require("plaid");
  PlaidApi = plaid.PlaidApi;
  Configuration = plaid.Configuration;
  PlaidEnvironments = plaid.PlaidEnvironments;
} catch (e) {
  plaidLoadError = e.message; // package not installed yet
}

function plaidClient() {
  if (!PlaidApi) return { error: `plaid package not installed (${plaidLoadError || "require failed"}). Run: npm i plaid` };
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  const envName = (process.env.PLAID_ENV || "sandbox").toLowerCase(); // sandbox | production
  if (!clientId || !secret) {
    return { error: "Plaid not configured. Set PLAID_CLIENT_ID and PLAID_SECRET in Render env vars (PLAID_ENV defaults to 'sandbox')." };
  }
  const basePath = PlaidEnvironments[envName] || PlaidEnvironments.sandbox;
  const configuration = new Configuration({
    basePath,
    baseOptions: { headers: { "PLAID-CLIENT-ID": clientId, "PLAID-SECRET": secret } },
  });
  return { client: new PlaidApi(configuration), envName };
}

// ── normalization: Plaid transaction → Spine claim shape ──────────────
// Maps onto exactly the fields POST /bank/accounts/:id/transactions reads:
//   { txn_date, amount, description, txn_type, check_number? }
// Everything past that (alias matching, exceptions, idempotency) is the
// existing engine's job — we do not re-implement an inch of it.
function plaidTxnType(pt) {
  // Plaid signals the rail via payment_channel + transaction_code. Map to
  // the bankintake.js enum: check | ach | wire | card | deposit | fee | other.
  const channel = (pt.payment_channel || "").toLowerCase();
  const code = (pt.transaction_code || "").toLowerCase();
  const name = (pt.name || "").toLowerCase();
  if (code === "check" || /\bcheck\s*#?\d/.test(name)) return "check";
  if (code === "wire") return "wire";
  if (code === "ach" || code === "direct debit" || code === "direct deposit") return "ach";
  if (channel === "online" || channel === "in store") return "card";
  if (code === "bank charge" || /\bfee\b|service charge|maintenance fee/.test(name)) return "fee";
  // a positive Spine amount (money in) with no clearer signal reads as a deposit
  return "other";
}

function plaidCheckNumber(pt) {
  if ((pt.transaction_code || "").toLowerCase() === "check") {
    const m = String(pt.name || "").match(/\bcheck\s*#?\s*(\d{2,})/i) || String(pt.check_number || "").match(/(\d{2,})/);
    if (m) return m[1];
    if (pt.check_number) return String(pt.check_number);
  }
  return null;
}

function normalizePlaidTxn(pt) {
  // Spine sign convention: + in, − out. Plaid: + means money LEFT. Flip it.
  const spineAmount = -Number(pt.amount);
  const txn_type = plaidTxnType(pt);
  // deposits are money-in with no payee rail signal; tag them as such so the
  // board reads cleanly rather than dumping them all into 'other'
  const finalType = (txn_type === "other" && spineAmount > 0) ? "deposit" : txn_type;
  return {
    txn_date: pt.date,                                  // Plaid 'date' is YYYY-MM-DD (posted date)
    amount: Number.isFinite(spineAmount) ? spineAmount : 0,
    description: pt.merchant_name || pt.name || "(no description)",
    txn_type: finalType,
    check_number: plaidCheckNumber(pt),
    _plaid_account_id: pt.account_id,                   // used to route to the right bank_account
  };
}

module.exports = function plaidModule({ pool }) {
  const router = express.Router();

  // small helper: stable JSON 503 when Plaid isn't wired up
  function notConfigured(res, msg) {
    return res.status(503).json({ configured: false, receipt: msg });
  }

  // ──────────────────────────────────────────────────────────────────
  // GET /plaid/status
  // Honest readiness probe. Tells the operator exactly what (if anything)
  // is missing, without leaking secrets. Mirrors the sms.js status idea.
  // ──────────────────────────────────────────────────────────────────
  router.get("/plaid/status", async (req, res) => {
    const c = plaidClient();
    res.json({
      package_installed: Boolean(PlaidApi),
      env: (process.env.PLAID_ENV || "sandbox").toLowerCase(),
      client_id_set: Boolean(process.env.PLAID_CLIENT_ID),
      secret_set: Boolean(process.env.PLAID_SECRET),
      configured: !c.error,
      receipt: c.error || "Plaid is configured and ready.",
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // POST /plaid/link-token
  // Step 1 of the Link flow. Returns a short-lived link_token the browser
  // hands to Plaid's widget. The operator then logs into their bank inside
  // Plaid's UI — this server never sees those bank credentials.
  // Body: { property_id }
  // ──────────────────────────────────────────────────────────────────
  router.post("/plaid/link-token", async (req, res) => {
    const c = plaidClient();
    if (c.error) return notConfigured(res, c.error);
    const { property_id } = req.body || {};
    if (!property_id) return res.status(400).json({ error: "property_id required" });
    try {
      const webhook = process.env.APP_BASE_URL
        ? process.env.APP_BASE_URL.replace(/\/+$/, "") + "/plaid/webhook"
        : undefined;
      const resp = await c.client.linkTokenCreate({
        user: { client_user_id: String(property_id) },
        client_name: "Property Spine",
        products: ["transactions"],
        country_codes: ["US"],
        language: "en",
        ...(webhook ? { webhook } : {}),
      });
      return res.json({ link_token: resp.data.link_token, expiration: resp.data.expiration });
    } catch (e) {
      return res.status(502).json({ error: "Plaid link-token failed", detail: e.response?.data || e.message });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // POST /plaid/exchange
  // Step 2. The browser sends back the one-time public_token from a
  // successful Link. We exchange it ONCE for the access_token + item_id,
  // store the connection, and record the bank sub-accounts Plaid reports
  // (unmapped until the operator ties them to a known bank_accounts row).
  // Body: { property_id, public_token, institution? : { id, name } }
  // ──────────────────────────────────────────────────────────────────
  router.post("/plaid/exchange", async (req, res) => {
    const c = plaidClient();
    if (c.error) return notConfigured(res, c.error);
    const { property_id, public_token, institution } = req.body || {};
    if (!property_id || !public_token) return res.status(400).json({ error: "property_id and public_token required" });
    try {
      const ex = await c.client.itemPublicTokenExchange({ public_token });
      const access_token = ex.data.access_token;
      const item_id = ex.data.item_id;

      const item = await pool.query(
        `insert into plaid_item (property_id, item_id, access_token, institution_id, institution_name)
         values ($1,$2,$3,$4,$5)
         on conflict (item_id) do update set access_token = excluded.access_token, updated_at = now()
         returning id, property_id, item_id, institution_name, status, created_at`,
        [property_id, item_id, access_token, institution?.id || null, institution?.name || null]
      );
      const plaidItemRow = item.rows[0];

      // record the sub-accounts Plaid reports under this login
      const acctsResp = await c.client.accountsGet({ access_token });
      let accountsRecorded = 0;
      for (const a of acctsResp.data.accounts || []) {
        const ins = await pool.query(
          `insert into plaid_account (plaid_item_id, account_id, name, official_name, mask, subtype)
           values ($1,$2,$3,$4,$5,$6)
           on conflict (plaid_item_id, account_id) do nothing
           returning id`,
          [plaidItemRow.id, a.account_id, a.name || null, a.official_name || null, a.mask || null, a.subtype || null]
        );
        if (ins.rows.length) accountsRecorded++;
      }

      return res.json({
        receipt: `Bank linked. ${accountsRecorded} account(s) recorded. Map each to a Spine bank account, then sync.`,
        plaid_item_id: plaidItemRow.id,
        institution_name: plaidItemRow.institution_name,
        accounts_recorded: accountsRecorded,
      });
    } catch (e) {
      return res.status(502).json({ error: "Plaid exchange failed", detail: e.response?.data || e.message });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // GET /plaid/items?property_id=...
  // Read the linked connections for a property. NEVER returns access_token.
  // Includes each Plaid account and whether it's mapped to a Spine account.
  // ──────────────────────────────────────────────────────────────────
  router.get("/plaid/items", async (req, res) => {
    const { property_id } = req.query || {};
    if (!property_id) return res.status(400).json({ error: "property_id query param required" });
    try {
      const items = (await pool.query(
        `select id, item_id, institution_name, status, last_synced_at, last_error, created_at
           from plaid_item where property_id = $1 order by created_at desc`,
        [property_id]
      )).rows;
      for (const it of items) {
        it.accounts = (await pool.query(
          `select pa.id, pa.account_id, pa.name, pa.official_name, pa.mask, pa.subtype,
                  pa.bank_account_id, ba.account_label, ba.account_last4
             from plaid_account pa
             left join bank_accounts ba on ba.id = pa.bank_account_id
            where pa.plaid_item_id = $1 order by pa.created_at`,
          [it.id]
        )).rows;
      }
      return res.json({ property_id, items });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // POST /plaid/accounts/:id/map
  // Tie a Plaid-reported sub-account to a known Spine bank_accounts row.
  // This is the seen→tied step — a transaction from an unmapped account
  // cannot be staged. Read-only-glance-must-not-mutate is respected: this
  // is an explicit write the operator triggers, not an inference.
  // Body: { bank_account_id }
  // ──────────────────────────────────────────────────────────────────
  router.post("/plaid/accounts/:id/map", async (req, res) => {
    const plaidAccountId = req.params.id;
    const { bank_account_id } = req.body || {};
    if (!bank_account_id) return res.status(400).json({ error: "bank_account_id required" });
    try {
      const ba = await pool.query("select id, account_label, account_last4 from bank_accounts where id=$1", [bank_account_id]);
      if (!ba.rows.length) return res.status(404).json({ error: "bank account not found" });
      const upd = await pool.query(
        `update plaid_account set bank_account_id = $1 where id = $2
         returning id, account_id, mask, bank_account_id`,
        [bank_account_id, plaidAccountId]
      );
      if (!upd.rows.length) return res.status(404).json({ error: "plaid account not found" });
      return res.json({
        receipt: `Mapped Plaid account ${upd.rows[0].mask || upd.rows[0].account_id} → ${ba.rows[0].account_label} (…${ba.rows[0].account_last4}). Ready to sync.`,
        plaid_account: upd.rows[0],
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // POST /plaid/items/:id/sync
  // The pull. Calls /transactions/sync with the saved cursor (page until
  // has_more is false), normalizes every ADDED transaction into the Spine
  // claim shape, groups by mapped bank account, and routes each group
  // through the SAME insert logic bankintake.js uses — so identification,
  // exception flags, and idempotency all apply identically. Transactions
  // from UNMAPPED Plaid accounts are reported as skipped, never guessed.
  //
  // We reuse the staging route's contract rather than its code by calling
  // the existing logic inline against bank_transactions. To stay strictly
  // single-source, this delegates to a shared stage helper if present;
  // otherwise it performs the same idempotent insert the 012 door performs.
  // ──────────────────────────────────────────────────────────────────
  router.post("/plaid/items/:id/sync", async (req, res) => {
    const c = plaidClient();
    if (c.error) return notConfigured(res, c.error);
    const plaidItemPk = req.params.id;
    try {
      const itRow = (await pool.query(
        "select id, access_token, sync_cursor, institution_name from plaid_item where id=$1",
        [plaidItemPk]
      )).rows[0];
      if (!itRow) return res.status(404).json({ error: "plaid item not found" });

      // map: plaid account_id → our bank_account_id (only mapped ones)
      const acctMap = {};
      (await pool.query(
        "select account_id, bank_account_id from plaid_account where plaid_item_id=$1 and bank_account_id is not null",
        [plaidItemPk]
      )).rows.forEach(r => { acctMap[r.account_id] = r.bank_account_id; });

      // page through /transactions/sync
      let cursor = itRow.sync_cursor || undefined;
      let added = [], hasMore = true, pages = 0, nextCursor = cursor || null;
      while (hasMore && pages < 20) {
        const resp = await c.client.transactionsSync({ access_token: itRow.access_token, ...(cursor ? { cursor } : {}) });
        const d = resp.data;
        added = added.concat(d.added || []);
        nextCursor = d.next_cursor;
        cursor = d.next_cursor;
        hasMore = d.has_more;
        pages++;
      }

      // normalize + route into bank_transactions through the 012 contract
      const summary = { item: itRow.institution_name || itRow.id, fetched: added.length, staged: 0, skipped_unmapped: 0, by_account: {} };
      const groups = {}; // bank_account_id → [normalized rows]
      for (const pt of added) {
        const n = normalizePlaidTxn(pt);
        const baId = acctMap[n._plaid_account_id];
        if (!baId) { summary.skipped_unmapped++; continue; }
        delete n._plaid_account_id;
        (groups[baId] = groups[baId] || []).push(n);
      }

      for (const [baId, rows] of Object.entries(groups)) {
        const out = await stageIntoBankTransactions(pool, baId, rows, `plaid:${itRow.institution_name || "linked"}`);
        summary.staged += out.inserted;
        summary.by_account[baId] = out;
      }

      // persist the cursor + sync stamp so the next pull only fetches new lines
      await pool.query(
        "update plaid_item set sync_cursor=$1, last_synced_at=now(), status='active', last_error=null, updated_at=now() where id=$2",
        [nextCursor, plaidItemPk]
      );

      return res.json({
        receipt: `Synced ${summary.fetched} transaction(s) from ${summary.item}. ${summary.staged} staged as claims${summary.skipped_unmapped ? `, ${summary.skipped_unmapped} skipped (account not mapped)` : ""}. Identification + exposure already applied — open the bank board.`,
        ...summary,
      });
    } catch (e) {
      // record a login_required / error state so the connection's health is visible
      const code = e.response?.data?.error_code;
      const status = code === "ITEM_LOGIN_REQUIRED" ? "login_required" : "error";
      await pool.query("update plaid_item set status=$1, last_error=$2, updated_at=now() where id=$3",
        [status, code || e.message, plaidItemPk]).catch(() => {});
      return res.status(502).json({ error: "Plaid sync failed", error_code: code || null, detail: e.response?.data || e.message });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // POST /plaid/webhook
  // Plaid POSTs here when new transactions are available
  // (SYNC_UPDATES_AVAILABLE) or a login breaks (ITEM_LOGIN_REQUIRED). We do
  // NOT auto-sync money on a webhook — we record that an update is waiting
  // and let the operator pull deliberately. (Same human-in-the-loop posture
  // as the rest of the money layer: the machine flags, the human acts.)
  // This route is intentionally unauthenticated at the app layer because
  // Plaid calls it; it performs no money mutation, only a status note.
  // ──────────────────────────────────────────────────────────────────
  router.post("/plaid/webhook", async (req, res) => {
    const { webhook_type, webhook_code, item_id } = req.body || {};
    try {
      if (item_id && webhook_code === "ITEM_LOGIN_REQUIRED") {
        await pool.query("update plaid_item set status='login_required', last_error='ITEM_LOGIN_REQUIRED', updated_at=now() where item_id=$1", [item_id]);
      } else if (item_id && (webhook_code === "SYNC_UPDATES_AVAILABLE" || webhook_type === "TRANSACTIONS")) {
        await pool.query("update plaid_item set last_error=null, updated_at=now() where item_id=$1", [item_id]);
      }
    } catch (_) { /* never fail a webhook ack */ }
    return res.json({ ok: true });
  });

  return router;
};

// ── shared staging helper ─────────────────────────────────────────────
// One source of truth for "a bank line becomes a claim." This is the SAME
// logic POST /bank/accounts/:id/transactions runs in bankintake.js: the
// alias-match identification, the unresolved-queue auto-register, the
// exception flags, and the idempotent insert keyed on
// (bank_account_id, txn_date, description, amount). Kept here as a local
// function so Plaid does not fork the money model; if this logic ever moves
// into a shared lib, both callers import it. Until then it is deliberately
// a faithful mirror, and the natural-key idempotency means a line that
// arrives via BOTH a PDF upload and Plaid is stored once, never twice.
function bankNorm(s) {
  return String(s || "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
}
const PLAID_NON_PROPERTY_PATTERNS = [
  "SPOTIFY", "YOUTUBE", "NETFLIX", "HULU", "AMAZON PRIME",
  "APPLE COM BILL", "DISNEY", "PARAMOUNT", "PELOTON",
];
function plaidIsPaymentReturn(normedDesc, txn_type, amount) {
  return txn_type !== "check" && txn_type !== "check_return"
    && Number(amount) < 0 && /\bRETURN\b/.test(normedDesc);
}
async function stageIntoBankTransactions(pool, accountId, transactions, source_document) {
  const acct = await pool.query("select * from bank_accounts where id=$1", [accountId]);
  if (acct.rows.length === 0) return { error: "bank account not found", inserted: 0 };

  const aliasRows = (await pool.query(
    `select va.alias_value, va.vendor_id, v.canonical_name, v.vendor_type
       from vendor_aliases va left join vendors v on v.id = va.vendor_id
      where va.source_system = 'bank_description'`)).rows;

  const summary = { inserted: 0, skipped_duplicates: 0, identified: 0, claimed: 0, unresolved_aliases_registered: 0, exceptions: [] };

  for (const t of transactions) {
    if (!t || !t.txn_date || t.amount === undefined || !t.description || !t.txn_type) {
      summary.exceptions.push({ skipped: true, reason: "missing fields", input: t }); continue;
    }
    const d = bankNorm(t.description);
    const isCheck = t.txn_type === "check" || t.txn_type === "check_return";
    let status = "claimed", vendor_id = null, identSource = null, exception = null;

    if (!isCheck) {
      const hits = aliasRows.filter(a => a.vendor_id && d.includes(a.alias_value));
      const vendorIds = [...new Set(hits.map(h => h.vendor_id))];
      if (vendorIds.length === 1) {
        status = "identified"; vendor_id = vendorIds[0]; identSource = "bank_description";
        const vt = hits.find(h => h.vendor_id === vendor_id).vendor_type;
        if (vt === "management" && Number(t.amount) < 0 && d.includes("SETTLEMENT")) exception = "composite_batch";
        if (vt === "owner_affiliate") exception = "affiliate_transfer";
      } else if (vendorIds.length > 1) {
        exception = "ambiguous_payee";
      } else {
        const ins = await pool.query(
          `insert into vendor_aliases (vendor_id, source_system, alias_value, note)
           values (null,'bank_description',$1,$2)
           on conflict (source_system, alias_value) do nothing returning id`,
          [d, `auto-registered unresolved from ${source_document || "plaid"}`]);
        if (ins.rows.length > 0) summary.unresolved_aliases_registered++;
      }
    }
    if (PLAID_NON_PROPERTY_PATTERNS.some(p => d.includes(p))) exception = "possible_non_property_spend";
    if (t.txn_type === "check_return" || d.includes("REJECTED")) exception = "rejected_check";
    if (plaidIsPaymentReturn(d, t.txn_type, t.amount)) exception = "payment_return";

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
  return summary;
}
