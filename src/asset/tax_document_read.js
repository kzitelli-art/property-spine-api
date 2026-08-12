/* ════════════════════════════════════════════════════════════════════
   tax_document_read.js — A PROPOSAL ADAPTER. IT HAS NO AUTHORITY.

   Turns the text of a City bill, a filed return or a payment receipt
   into SUGGESTIONS for the human to confirm. Nothing here reaches the
   database. The establish routes write only what a person confirmed, and
   they never consult this file.

   Same contract as `insurance_document_read.js`, one domain over:

       upload  →  read / propose  →  human confirms  →  canonical write

   ── IT READS LABELS AND NAMED PATTERNS. IT DOES NOT GUESS. ──────────
   Every proposal comes from an explicit label — "OPA Number:",
   "Submitted date:", "Amount to Pay:" — or from a NAMED pattern whose
   shape only one thing in a City document has, like the bill's own
   masthead. No positional inference. No "the biggest number is probably
   the tax". Those are the guesses that produce a plausible wrong
   liability nobody notices, and an unnoticed wrong number becomes
   governed truth wearing the operator's name.

   ── BUILT AGAINST REAL DOCUMENTS, NOT AN IMAGINED FORMAT ────────────
   The label sets below come from two specimens in the portfolio:

     City Real Estate Tax bill (2116 Chestnut, 2023)
       REAL ESTATE TAXES 2023 BILL
       OPA Number: 881566975
       TAX DUE ON OR BEFORE FRIDAY, MARCH 31, 2023
       Amount to Pay:   $201,512.97

     Philadelphia BIRT return (Onefive 4233 LLC, 2023)
       Philadelphia Tax ID Number : 2000179694
       Filing Period :   31-Dec-2023
       Submitted date:   29-Mar-2024
       5. Tax Due 2023. (Line 3 minus Line 4)   $0.00
       6. MANDATORY 2024 BIRT Estimated Payment   $0.00

   Two things those specimens taught the parser:

   · A LABEL CAN APPEAR TWICE WITH A VALUE ONLY ONCE. The bill prints
     "OPA Number:" in a column block where extraction separates it from
     its value, and again on the remittance stub where it does not. So
     every occurrence is tried and the first that PARSES wins — taking
     only the first occurrence would have proposed nothing.
   · ZERO IS A REAL TAX FIGURE. The insurance parser refuses non-positive
     money, correctly: a zero premium is nonsense. A BIRT return with
     $0.00 due is ordinary and true, so this parser accepts zero and only
     refuses what has no money shape at all.

   ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────
   No model call — this is the scan half, exactly as in Insurance. No
   APPLICABILITY is ever proposed: whether a tax applies is a human
   determination with a stated basis, and a document that mentions BIRT
   is not a finding that BIRT applies. No filer profile either, for the
   same reason.

   CLASS 1 — permanent product primitive.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const pad = (n) => String(n).padStart(2, "0");

/*  A date only counts when it is UNAMBIGUOUS. 03/04/2026 is refused —
 *  3 April in most of the world, 4 March in the United States, and a tax
 *  period silently off by a month moves which period the money belongs
 *  to. ISO, a written month, or the City's own DD-Mon-YYYY are all
 *  unambiguous; a bare numeric one is not, and the operator can type it.
 */
function parseDate(raw) {
  const s = String(raw || "").trim();
  let m = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  //  31-Dec-2023 — how the City's tax portal prints a filing period.
  m = s.match(/\b(\d{1,2})-([A-Za-z]{3})[a-z]*-(\d{4})\b/);
  if (m && MONTHS[m[2].toLowerCase()]) {
    return `${m[3]}-${pad(MONTHS[m[2].toLowerCase()])}-${pad(m[1])}`;
  }
  //  MARCH 31, 2023 — how the bill prints a due date, usually after a
  //  weekday name the scan simply walks past.
  m = s.match(/\b([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{4})\b/);
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) {
    return `${m[3]}-${pad(MONTHS[m[1].slice(0, 3).toLowerCase()])}-${pad(m[2])}`;
  }
  return null;
}

/*  ZERO IS ACCEPTED. A tax return showing $0.00 due is a real, common
 *  and useful fact — refusing it would leave the operator retyping a
 *  figure the document states plainly. What is still refused is anything
 *  with no money SHAPE: a bare integer in a table of line numbers is not
 *  an amount.
 */
function parseMoney(raw) {
  const s = String(raw || "").trim();
  const m = s.match(/\$\s*(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+\.\d{2})\b/)
         || s.match(/\b(\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d+\.\d{2})\b/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  if (!isFinite(n) || n < 0) return null;
  return n.toFixed(2);
}

/*  A City account identifier: OPA numbers and Philadelphia tax IDs are
 *  long digit strings. Refused when short, because "Account: 1" is a
 *  line number and proposing it as an OPA account is worse than blank.
 */
function parseIdentifier(raw) {
  const s = String(raw || "").trim();
  const m = s.match(/\b(\d[\d-]{6,})\b/);
  if (!m) return null;
  return m[1].replace(/-+$/, "");
}

function parseText(raw) {
  const s = String(raw || "").trim().split(/\s{3,}/)[0].replace(/[|;]+$/, "").trim();
  if (!s || s.length > 120) return null;
  if (/^[-–—:_.]+$/.test(s)) return null;
  return s;
}

function parseYear(raw) {
  const d = parseDate(raw);
  if (d) return d.slice(0, 4);
  const m = String(raw || "").match(/\b(20\d{2})\b/);
  return m ? m[1] : null;
}

const PARSERS = { text: parseText, date: parseDate, money: parseMoney,
                  identifier: parseIdentifier, year: parseYear };

/*  ── WHAT EACH KIND OF DOCUMENT IS ALLOWED TO PROPOSE ───────────────
 *  Narrow on purpose, and different per kind: a bill states what is
 *  owed and when, a return states what was filed and on what day. One
 *  merged field list would let a return propose a due date it does not
 *  carry.
 *
 *  `patterns` are named shapes rather than labelled values — the bill's
 *  masthead is the only place its tax year appears, and matching it is
 *  reading the document, not guessing at it.
 */
const KIND_FIELDS = {
  tax_bill: Object.freeze([
    { key: "account_identifier", kind: "identifier",
      labels: ["opa number", "opa account", "account number", "account"] },
    { key: "period_year", kind: "year",
      patterns: [/real estate taxes\s+(20\d{2})\s+bill/i, /(20\d{2})\s+tax\s+bill/i] },
    { key: "due_date", kind: "date",
      labels: ["tax due on or before", "due on or before", "due date", "payment due"] },
    { key: "annual_liability", kind: "money",
      labels: ["amount to pay", "total amount due", "amount due", "total due"] },
  ]),
  tax_return: Object.freeze([
    { key: "account_identifier", kind: "identifier",
      labels: ["philadelphia tax id number", "tax id number", "account number"] },
    { key: "period_year", kind: "year", labels: ["filing period", "for calendar year"] },
    //  The day the City received it. This is what `recordFiling` wants,
    //  and it is the one field an operator most often has to hunt for.
    { key: "filed_at", kind: "date", labels: ["submitted date", "date filed", "filed on"] },
    { key: "annual_liability", kind: "money",
      patterns: [/tax due\s+20\d{2}\.?[^$\n]{0,60}?(\$[\d,]+\.\d{2})/i],
      labels: ["net tax due", "total due including interest and penalty"] },
    //  BIRT Line 6. Proposed as its OWN field because it belongs to a
    //  DIFFERENT requirement — the following year's mandatory estimate —
    //  and merging it into the liability is the defect 167 exists to stop.
    { key: "estimate_next_year", kind: "money",
      patterns: [/mandatory\s+20\d{2}\s*birt estimated payment[^$\n]{0,40}?(\$[\d,]+\.\d{2})/i] },
  ]),
  tax_payment_receipt: Object.freeze([
    { key: "account_identifier", kind: "identifier",
      labels: ["opa number", "account number", "tax id number"] },
    { key: "paid_at", kind: "date",
      labels: ["payment date", "date paid", "posted", "received"] },
    { key: "amount", kind: "money",
      labels: ["amount paid", "payment amount", "amount"] },
    { key: "confirmation_reference", kind: "text",
      labels: ["confirmation number", "confirmation", "receipt number"] },
  ]),
  tax_balance_statement: Object.freeze([
    { key: "account_identifier", kind: "identifier",
      labels: ["opa number", "account number", "tax id number"] },
    { key: "city_balance", kind: "money",
      labels: ["balance due", "total balance", "current balance", "amount due"] },
    { key: "balance_as_of", kind: "date", labels: ["as of", "statement date", "balance as of"] },
  ]),
};
//  The City's account view and its balance statement carry the same three
//  facts under the same labels, so they share one field set rather than a
//  copy that drifts.
KIND_FIELDS.tax_account_statement = KIND_FIELDS.tax_balance_statement;
Object.freeze(KIND_FIELDS);

//  ⚠ NOT HERE, DELIBERATELY. A clearance certificate and an appeal
//  document are compliance evidence about a subject; neither states a
//  liability, a filing or a payment, and letting them propose one is how
//  a certificate comes to paper over an unpaid bill.
const NO_PROPOSAL = Object.freeze({
  tax_clearance_certificate:
    "A clearance certificate is compliance evidence. It does not state what is owed, " +
    "what was filed or what was paid, so Spine proposes nothing from it.",
  tax_appeal_document:
    "An appeal document does not change what is currently owed, so Spine proposes " +
    "nothing from it.",
});

/*  Try EVERY occurrence of a label and take the first that parses.
 *  The City's own bill prints "OPA Number:" once with its value stranded
 *  in another column and once on the remittance stub beside the number —
 *  first-occurrence-only proposed nothing at all. */
function fromLabel(body, label, parse) {
  const re = new RegExp(
    label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")
      + "\\s*[:#]?\\s*([^\\n]{0,120})", "gi");
  let m;
  while ((m = re.exec(body))) {
    const v = parse(m[1]);
    if (v !== null && v !== undefined && v !== "") return v;
  }
  return null;
}

function fromPattern(body, pattern, parse) {
  const m = body.match(pattern);
  if (!m) return null;
  return parse(m[1]);
}

/*  ── PROPOSE ────────────────────────────────────────────────────────
 *  text, kind → { available, fields, unknown, source, reason }
 *
 *  `fields` holds only what a label or a named pattern licensed.
 *  `unknown` names every field the document did not support, so the
 *  surface can say what is missing rather than leaving the operator to
 *  notice an absence.
 */
function propose(text, artifact_kind) {
  const body = String(text == null ? "" : text);
  const spec = KIND_FIELDS[artifact_kind];

  if (!spec) {
    //  NEVER OPENED. Spine does not read this kind of document at all.
    return { available: false, found_count: 0, fields: {}, unknown: [],
             source: "label_scan",
             reason: NO_PROPOSAL[artifact_kind]
               || "Spine does not read this kind of document. Enter what it says — " +
                  "your answers are recorded against the file you uploaded." };
  }
  if (!body.trim()) {
    //  NOTHING TO READ. No text came out of the file at all.
    return { available: false, found_count: 0, fields: {},
             unknown: spec.map((f) => f.key), source: "label_scan",
             reason: "Spine could not read any text out of this document. Enter what " +
                     "it says — your answers are recorded against the file you uploaded." };
  }

  const fields = {}, unknown = [];
  for (const f of spec) {
    const parse = PARSERS[f.kind];
    let v = null;
    for (const p of f.patterns || []) { v = fromPattern(body, p, parse); if (v) break; }
    if (!v) for (const l of f.labels || []) { v = fromLabel(body, l, parse); if (v) break; }
    if (v !== null && v !== undefined && v !== "") fields[f.key] = v;
    else unknown.push(f.key);
  }

  /*  ⚠ `available` MEANS A READ HAPPENED, NOT THAT IT FOUND ANYTHING.
   *  `insurance_document_read.js` already drew that distinction — "a
   *  document Spine read and learned nothing from is a different answer
   *  from a document Spine never opened" — and this adapter shipped with
   *  the opposite meaning. Two sibling adapters using one key for two
   *  things is a §17 defect even while nothing has broken, so they now
   *  agree. `found_count` is what a surface tests to decide whether it
   *  has anything to show. */
  const found = Object.keys(fields).length;
  return {
    available: true,
    found_count: found,
    fields, unknown, source: "label_scan",
    reason: found
      ? `Spine read ${found} field${found === 1 ? "" : "s"} off this document. Check ` +
        `every one before confirming — what gets recorded is what the form holds when ` +
        `you press confirm, not what Spine proposed.`
      : "Spine found none of the labels it looks for in this document. Enter what it " +
        "says — your answers are recorded against the file you uploaded.",
  };
}

module.exports = { propose, KIND_FIELDS, NO_PROPOSAL,
                   parseDate, parseMoney, parseIdentifier, parseYear, parseText };
