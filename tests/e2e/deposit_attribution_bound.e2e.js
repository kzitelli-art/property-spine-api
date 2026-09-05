/*  ════════════════════════════════════════════════════════════════════
    deposit_attribution_bound.e2e.js — A DEPOSIT PROVES NO MORE CASH THAN
    IT CARRIES.

    POST /payments/:id/link-bank ties a payment to a bank deposit; any
    link makes the payment cash-proven once applied. Nothing asked how
    much of the deposit was already spoken for, or whether amount_matched
    fit the payment, so a 1,500 deposit could prove five 1,000 payments —
    proven collected income the bank never received. Proven here: the
    first full link is accepted; a second full link that would exceed the
    deposit is refused with a sayable receipt and no link written; a
    split that fits is accepted; one cent past the deposit is refused;
    amount_matched above the payment, or not positive, is refused.

    Runs against the REAL server.js the verification parent booted.
    ════════════════════════════════════════════════════════════════════ */
"use strict";
const path = require("path");
const ROOT = path.join(__dirname, "..", "..");
const { Pool } = require(path.join(ROOT, "node_modules", "pg"));

const API = (process.env.E2E_API_BASE || "http://localhost:3000").replace(/\/+$/, "");
const KEY = process.env.E2E_OPERATOR_KEY || "e2e-key";
const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });

let pass = 0, fail = 0;
const ok  = (l, d = "") => { pass++; console.log(`  ✓ ${l}${d ? "  — " + d : ""}`); };
const bad = (l, d = "") => { fail++; console.log(`  ✗ ${l}${d ? "  — " + d : ""}`); };
const check = (l, cond, d) => (cond ? ok(l) : bad(l, d));
const J = (v) => JSON.stringify(v);
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const link = async (paymentId, body) => {
  const r = await fetch(`${API}/payments/${paymentId}/link-bank`, { method: "POST",
    headers: { "content-type": "application/json", "x-operator-key": KEY }, body: J(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const links = async (txnId) => (await one("select count(*)::int as n from payment_bank_links where bank_transaction_id=$1", [txnId])).n;

(async () => {
  const tag = "DAB" + Math.floor(Math.random() * 1e6);
  const prop = (await one("insert into properties (name,address) values ($1,'15 Deposit Way') returning id", [tag + " Deposits"])).id;
  const acct = (await one(`insert into bank_accounts (property_id, account_label, account_last4, bank_name) values ($1,'op','4321','Proof Bank') returning id`, [prop])).id;
  const deposit = (await one(`insert into bank_transactions (bank_account_id, txn_date, description, amount, txn_type)
                              values ($1, current_date, $2, 1500.00, 'deposit') returning id`, [acct, tag + " batch deposit"])).id;
  const pay = async (amount) => (await one(
    `insert into payments (property_id, amount, paid_date, method, status) values ($1,$2,current_date,'check','claimed') returning id`, [prop, amount])).id;
  const p1 = await pay(1000), p2 = await pay(1000), p3 = await pay(1000);

  console.log("\n── 1 · the first payment takes 1,000 of a 1,500 deposit ──");
  const a = await link(p1, { bank_transaction_id: deposit });
  check("link payment 1 (full 1,000) → 200", a.status === 200, `${a.status} ${J(a.body).slice(0, 160)}`);

  console.log("\n── 2 · a second full 1,000 would make the deposit prove 2,000 ──");
  const b = await link(p2, { bank_transaction_id: deposit });
  check("link payment 2 (full 1,000) → 409", b.status === 409, `${b.status} ${J(b.body).slice(0, 200)}`);
  check("…the refusal says what the deposit already proves and what to do", !!(b.body && /already proves 1000\.00/.test(b.body.receipt || "") && /amount_matched|different deposit/.test(b.body.receipt || "")), J(b.body));
  check("…and no link was written", (await links(deposit)) === 1, `links=${await links(deposit)}`);

  console.log("\n── 3 · a split that fits is accepted; one cent past the deposit is not ──");
  const c = await link(p2, { bank_transaction_id: deposit, amount_matched: 500 });
  check("link payment 2 with amount_matched 500 → 200 (deposit now fully attributed)", c.status === 200, `${c.status} ${J(c.body).slice(0, 160)}`);
  const d = await link(p3, { bank_transaction_id: deposit, amount_matched: 0.01 });
  check("link payment 3 with amount_matched 0.01 → 409 (deposit exhausted)", d.status === 409 && (await links(deposit)) === 2, `${d.status} ${J(d.body).slice(0, 160)}`);

  console.log("\n── 4 · a link attributes no more than the payment it proves ──");
  const big = (await one(`insert into bank_transactions (bank_account_id, txn_date, description, amount, txn_type)
                          values ($1, current_date, $2, 5000.00, 'deposit') returning id`, [acct, tag + " large deposit"])).id;
  const e = await link(p3, { bank_transaction_id: big, amount_matched: 2000 });
  check("amount_matched 2,000 on a 1,000 payment → 409", e.status === 409 && /exceeds this payment/.test((e.body && e.body.receipt) || ""), `${e.status} ${J(e.body).slice(0, 160)}`);
  const f = await link(p3, { bank_transaction_id: big, amount_matched: 0 });
  check("amount_matched 0 → 400", f.status === 400, `${f.status} ${J(f.body).slice(0, 160)}`);
  check("…and the large deposit has no links", (await links(big)) === 0);

  await pool.end();
  console.log(`\n══ deposit attribution bound: ${pass} passed, ${fail} failed ══`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
