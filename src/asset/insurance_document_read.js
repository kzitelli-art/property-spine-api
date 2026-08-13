/* ════════════════════════════════════════════════════════════════════
   insurance_document_read.js — A PROPOSAL ADAPTER. IT HAS NO AUTHORITY.

   Turns the text of a policy or binder into SUGGESTIONS for the human to
   confirm. Nothing here reaches the database. The establish route writes
   only what a person confirmed, and it never consults this file.

   ── IT READS LABELS. IT DOES NOT GUESS. ─────────────────────────────
   Every proposal comes from an explicit label in the document —
   "Policy Number:", "Effective Date:", "Total Premium:". If the label is
   absent, the field is UNKNOWN and stays blank on the form.

   No positional inference. No "the first date is probably the start". No
   "the largest number is probably the premium". Those are the guesses
   that produce a plausible wrong premium the operator does not notice,
   and an unnoticed wrong number becomes governed truth wearing their
   name. §5: honest blank beats confident wrong, and it beats it hardest
   where a human is about to press confirm.

   ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────
   No model call. src/identity/identify.js does "scan-first +
   model-fallback" and this is the scan half only. The fallback is a
   separate, deliberate act: it needs a key, a prompt, a cost, and its own
   proof that a hallucinated premium cannot reach a confirm screen looking
   like a reading. Adding it here to feel finished would be exactly the
   extraction subsystem this slice was told not to become.

   THE SEAM IS READY FOR IT. `propose()` returns the same shape either
   way, so a model pass becomes another source of candidate fields behind
   the same contract — and the same rule: a suggestion, never a write.

   ── NO ALLOCATION IS EVER PROPOSED ──────────────────────────────────
   The property's SHARE is never suggested, even when a document appears
   to state one. A share is the number that becomes this property's
   economic cost, and the difference between "the broker stated it" and
   "we computed it" is an epistemic distinction (§38) that a text scan
   cannot make. The human states the share and says where it came from.

   CLASS 1 — permanent product primitive. The scan is not scaffolding;
   the absent model fallback is a named future addition, not a stub.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const { retrievalOnly } = require("../shared/reader_capability_contract.js");

//  Every field this adapter is willing to propose, and the labels that
//  license it. Order matters only in that the first match wins.
const FIELDS = Object.freeze([
  { key: "program_name", kind: "text",
    labels: ["program name", "policy title", "program"] },
  { key: "carrier_name", kind: "text",
    labels: ["carrier", "insurer", "insurance company", "underwritten by"] },
  { key: "broker_name", kind: "text",
    labels: ["broker", "producer", "agency", "agent"] },
  { key: "policy_number", kind: "text",
    labels: ["policy number", "policy no", "policy #", "certificate number"] },
  { key: "coverage_period_start", kind: "date",
    labels: ["effective date", "policy period from", "inception date", "effective from"] },
  { key: "coverage_period_end", kind: "date",
    labels: ["expiration date", "expiry date", "policy period to", "effective to"] },
  { key: "premium", kind: "money",
    labels: ["total premium", "annual premium", "premium"] },
  { key: "taxes", kind: "money", labels: ["taxes", "surplus lines tax", "tax"] },
  { key: "fees", kind: "money", labels: ["fees", "policy fee", "inspection fee"] },
  { key: "broker_fee", kind: "money", labels: ["broker fee", "brokerage fee", "producer fee"] },
]);

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
};

function pad(n) { return String(n).padStart(2, "0"); }

/*  A date only counts when it is UNAMBIGUOUS.
 *
 *  03/04/2026 is refused: it is 3 April in most of the world and 4 March
 *  in the United States, and a policy period silently off by a month
 *  moves which period the expense belongs to. An ISO date or a written
 *  month is unambiguous; a bare numeric one is not, and the operator can
 *  simply type it.
 */
function parseDate(raw) {
  const s = String(raw || "").trim();
  let m = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  m = s.match(/\b([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})\b/);
  if (m && MONTHS[m[1].toLowerCase()]) {
    return `${m[3]}-${pad(MONTHS[m[1].toLowerCase()])}-${pad(m[2])}`;
  }
  m = s.match(/\b(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\b/);
  if (m && MONTHS[m[2].toLowerCase()]) {
    return `${m[3]}-${pad(MONTHS[m[2].toLowerCase()])}-${pad(m[1])}`;
  }
  return null;
}

/*  Money as the operator will see it in the form — a decimal string, not
 *  cents. The browser converts to integer cents at confirm time, in one
 *  place, so there is a single conversion in the whole path.
 *
 *  Refused when the number carries no decimal AND no thousands separator:
 *  "Premium 4" in a table of limits is not a premium, and proposing $4.00
 *  is worse than proposing nothing.
 */
function parseMoney(raw) {
  const s = String(raw || "").trim();
  const m = s.match(/\$?\s*(\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d+\.\d{2})\b/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  if (!isFinite(n) || n <= 0) return null;
  return n.toFixed(2);
}

function parseText(raw) {
  const s = String(raw || "").trim()
    //  Stop at the next label on the same line — PDF text extraction
    //  frequently runs two columns together.
    .split(/\s{3,}/)[0]
    .replace(/[|;]+$/, "")
    .trim();
  if (!s || s.length > 120) return null;
  //  A label with nothing after it is not a value.
  if (/^[-–—:_.]+$/.test(s)) return null;
  return s;
}

const PARSERS = { text: parseText, date: parseDate, money: parseMoney };

/*  ── PROPOSE ────────────────────────────────────────────────────────
 *  text → { available, fields, unknown, source }
 *
 *  `fields` holds only what a label licensed. `unknown` names every field
 *  the document did not support, so the surface can say what is missing
 *  rather than leaving the operator to notice absence.
 */
function propose(text) {
  const body = String(text == null ? "" : text);
  const fields = {};

  if (body.trim()) {
    //  Line-oriented: a label binds to the value on ITS line. Scanning the
    //  whole document for "the nearest number after the word premium"
    //  reaches across page breaks and table cells and is how a scan starts
    //  inventing things.
    const lines = body.split(/\r?\n/);
    for (const field of FIELDS) {
      if (fields[field.key] !== undefined) continue;
      for (const line of lines) {
        const low = line.toLowerCase();
        let hit = null;
        for (const label of field.labels) {
          const at = low.indexOf(label);
          if (at === -1) continue;
          //  The label must be followed by a separator, or it is a word in
          //  a sentence rather than a field on a form.
          const after = line.slice(at + label.length);
          if (!/^\s*[:\-–—]\s*|^\s{2,}/.test(after)) continue;
          hit = after.replace(/^\s*[:\-–—]\s*/, "");
          break;
        }
        if (hit === null) continue;
        const value = PARSERS[field.kind](hit);
        if (value !== null) { fields[field.key] = value; break; }
      }
    }
  }

  const found = Object.keys(fields);
  const unknown = FIELDS.map((f) => f.key).filter((k) => !(k in fields));

  return {
    //  `available` says a READ HAPPENED, not that it found everything. A
    //  document Spine read and learned nothing from is a different answer
    //  from a document Spine never opened, and the operator is told which.
    available: true,
    fields,
    unknown,
    //  Named so the surface can say where a suggestion came from. §38:
    //  a proposal is not a recorded fact and must not look like one.
    source: "document_scan",
    capability_classes: retrievalOnly("explicit labels in retained insurance document text"),
    found_count: found.length,
    //  THE SHARE IS NEVER PROPOSED. Stated here so the absence is a
    //  decision on the record rather than something nobody got to.
    never_proposed: ["allocation", "share", "currency_code"],
  };
}

module.exports = { propose, FIELDS, parseDate, parseMoney, parseText };
