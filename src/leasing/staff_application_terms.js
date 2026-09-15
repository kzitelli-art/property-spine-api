"use strict";

// Class 1 adapter projection. This parses only an explicitly introduced
// operator terms statement. It owns no authority and performs no writes.

const REQUIRED_KEYS = Object.freeze([
  "rent", "security_deposit", "lease_start_date", "lease_end_date",
  "fees", "concessions",
]);

const MONEY = /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function normalizeMoney(value) {
  const text = String(value || "").trim();
  if (!MONEY.test(text)) return null;
  return Number(text).toFixed(2);
}

function normalizeDate(value) {
  const text = String(value || "").trim();
  if (!DATE.test(text)) return null;
  const date = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text
    ? null : text;
}

function emptyResult() {
  return { recognized: false, values: {}, missing: [...REQUIRED_KEYS], errors: [] };
}

function mergeApplicationTerms(existing = {}, values = {}) {
  const merged = { ...(existing || {}) };
  for (const key of REQUIRED_KEYS) {
    if (Object.prototype.hasOwnProperty.call(values, key)) merged[key] = values[key];
  }
  return merged;
}

function missingApplicationTerms(values = {}) {
  return REQUIRED_KEYS.filter((key) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) return true;
    const value = values[key];
    return value == null || value === "" || (key === "fees" && !Array.isArray(value))
      || (key === "concessions" && (!value || value.status !== "none"));
  });
}

function parseStaffApplicationTerms(text, existing = {}) {
  const raw = String(text || "").trim();
  // The lead-in is an authority boundary: ordinary conversation is not a
  // terms payload and must remain available as conversational evidence.
  const lead = raw.match(/^terms(?:\s+for\s+[^:;?]+)?\s*:\s*(.*)$/i);
  if (!lead) return emptyResult();

  const body = lead[1].trim();
  const out = { recognized: true, values: {}, missing: [], errors: [] };
  if (!body) {
    out.errors.push("terms statement is empty");
    out.missing = missingApplicationTerms(mergeApplicationTerms(existing, out.values));
    return out;
  }
  if (/[?]/.test(body) || /\b(?:what|which|how much|is|are|can|could|should)\b/i.test(body)) {
    out.errors.push("questions are not terms assertions");
  }

  const seen = new Set();
  const clauses = body.split(";").map((part) => part.trim()).filter(Boolean);
  const aliases = [
    ["security_deposit", /^(?:security\s+)?deposit\s+(.+)$/i],
    ["lease_start_date", /^(?:lease\s+)?start(?:\s+date)?\s+(.+)$/i],
    ["lease_end_date", /^(?:lease\s+)?end(?:\s+date)?\s+(.+)$/i],
    ["rent", /^rent\s+(.+)$/i],
    ["fees", /^fees?\s+(.+)$/i],
    ["concessions", /^concessions?\s+(.+)$/i],
  ];

  for (const clause of clauses) {
    const match = aliases.find(([, pattern]) => pattern.test(clause));
    if (!match) {
      out.errors.push(`unrecognized terms field: ${clause}`);
      continue;
    }
    const [key, pattern] = match;
    if (seen.has(key)) {
      out.errors.push(`repeated terms field: ${key}`);
      continue;
    }
    seen.add(key);
    const value = clause.match(pattern)[1].trim();
    if (/\b(?:do\s+not|don't|without|never)\b/i.test(value)
        || (/\bnot\b/i.test(value) && !/^none$/i.test(value))) {
      out.errors.push(`negated terms field: ${key}`);
      continue;
    }
    if (key === "rent" || key === "security_deposit") {
      const normalized = normalizeMoney(value);
      if (normalized == null) out.errors.push(`invalid money for ${key}`);
      else out.values[key] = normalized;
    } else if (key === "lease_start_date" || key === "lease_end_date") {
      const normalized = normalizeDate(value);
      if (normalized == null) out.errors.push(`invalid date for ${key}`);
      else out.values[key] = normalized;
    } else if (key === "fees") {
      if (/^none$/i.test(value)) out.values.fees = [];
      else out.errors.push("structured fees must be established separately; they are not parsed from SMS");
    } else if (key === "concessions") {
      if (/^none$/i.test(value)) out.values.concessions = { status: "none" };
      else out.errors.push("structured concessions must be established separately; they are not parsed from SMS");
    }
  }

  out.missing = missingApplicationTerms(mergeApplicationTerms(existing, out.values));
  return out;
}

module.exports = {
  REQUIRED_KEYS,
  mergeApplicationTerms,
  missingApplicationTerms,
  parseStaffApplicationTerms,
  // Short aliases for callers composing partial SMS observations.
  extract: parseStaffApplicationTerms,
  missingTerms: missingApplicationTerms,
};
