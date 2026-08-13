"use strict";

/*
 * A Utility document reader proposes labelled facts. It has no authority:
 * upload -> proposal -> human confirmation -> canonical Utility writer.
 */

const MONTHS = Object.freeze({
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
});

function pad(value) { return String(value).padStart(2, "0"); }

function parseDate(raw) {
  const value = String(raw || "").trim();
  let match = value.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  match = value.match(/\b([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(20\d{2})\b/);
  if (match && MONTHS[match[1].slice(0, 3).toLowerCase()]) {
    return `${match[3]}-${pad(MONTHS[match[1].slice(0, 3).toLowerCase()])}-${pad(match[2])}`;
  }
  match = value.match(/\b(\d{1,2})[- ]([A-Za-z]{3,9})[- ](20\d{2})\b/);
  if (match && MONTHS[match[2].slice(0, 3).toLowerCase()]) {
    return `${match[3]}-${pad(MONTHS[match[2].slice(0, 3).toLowerCase()])}-${pad(match[1])}`;
  }
  return null;
}

function parseMoney(raw) {
  const value = String(raw || "").trim();
  const match = value.match(/\$\s*(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+\.\d{2})\b/)
    || value.match(/\b(\d{1,3}(?:,\d{3})+\.\d{2}|\d+\.\d{2})\b/);
  if (!match) return null;
  const amount = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(amount) && amount >= 0 ? amount.toFixed(2) : null;
}

function parseText(raw) {
  const value = String(raw || "").trim().split(/\s{3,}/)[0].replace(/[|;]+$/, "").trim();
  if (!value || value.length > 160 || /^[-_:.,]+$/.test(value)) return null;
  return value;
}

function parseIdentifier(raw) {
  const value = parseText(raw);
  if (!value) return null;
  const match = value.match(/\b([A-Za-z0-9][A-Za-z0-9 .#/-]{2,78}[A-Za-z0-9])\b/);
  if (!match || !/\d/.test(match[1])) return null;
  return match[1].trim();
}

function parseService(raw) {
  const value = String(raw || "").toLowerCase();
  const choices = [
    [/\b(electric|electricity)\b/, "electricity"],
    [/\b(natural gas|gas)\b/, "natural_gas"],
    [/\bwater\s*(?:and|&)\s*sewer\b/, "water_sewer_combined"],
    [/\bsewer\b/, "sewer"],
    [/\bwater\b/, "water"],
    [/\bsteam|district energy\b/, "steam_district_energy"],
    [/\bfuel oil\b/, "fuel_oil"],
    [/\bpropane\b/, "propane"],
    [/\binternet|data\b/, "internet_data"],
    [/\btelephone|telecom\b/, "telephone_telecom"],
    [/\bwaste|trash\b/, "waste_trash"],
    [/\brecycling\b/, "recycling"],
  ];
  const found = choices.filter(([pattern]) => pattern.test(value));
  return found.length === 1 ? found[0][1] : null;
}

function parseUsage(raw) {
  const value = String(raw || "").trim();
  const match = value.match(/\b(\d+(?:,\d{3})*(?:\.\d+)?)\s*([A-Za-z][A-Za-z0-9^/ -]{0,20})\b/);
  if (!match) return null;
  const quantity = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(quantity) || quantity < 0) return null;
  return { quantity, usage_unit: match[2].trim() };
}

function parseUsageBasis(raw) {
  const value = String(raw || "").toLowerCase();
  if (/\b(actual|observed)\b/.test(value)) return "observed";
  if (/\bestimat(?:e|ed)\b/.test(value)) return "estimated";
  return null;
}

function fromLabel(body, label, parse) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const pattern = new RegExp(`${escaped}\\s*[:#]?\\s*([^\\n]{0,180})`, "gi");
  let match;
  while ((match = pattern.exec(body))) {
    const value = parse(match[1]);
    if (value !== null && value !== undefined && value !== "") return value;
  }
  return null;
}

function labelled(body, labels, parse) {
  for (const label of labels) {
    const value = fromLabel(body, label, parse);
    if (value !== null && value !== undefined && value !== "") return value;
  }
  return null;
}

const STATEMENT_FIELDS = Object.freeze([
  { key: "provider_name", parse: parseText, labels: ["utility provider", "provider name", "provider"] },
  { key: "external_account_identifier", parse: parseIdentifier,
    labels: ["account number", "account no", "account"] },
  { key: "statement_identifier", parse: parseIdentifier,
    labels: ["statement number", "bill number", "invoice number"] },
  { key: "meter_identifier", parse: parseIdentifier,
    labels: ["meter number", "meter no", "meter id"] },
  { key: "service_point_identifier", parse: parseIdentifier,
    labels: ["service point id", "service point", "premise number", "premise id"] },
  { key: "service_class", parse: parseService,
    labels: ["service type", "utility service", "service"] },
  { key: "service_address", parse: parseText,
    labels: ["service address", "service location"] },
  { key: "bill_date", parse: parseDate,
    labels: ["bill date", "statement date", "invoice date"] },
  { key: "due_date", parse: parseDate,
    labels: ["due date", "payment due", "pay by"] },
  { key: "amount_billed", parse: parseMoney,
    labels: ["new charges", "amount billed", "total charges"] },
  { key: "current_amount_due", parse: parseMoney,
    labels: ["current amount due", "amount due", "total due"] },
  { key: "late_fee", parse: parseMoney,
    labels: ["late fee", "late payment charge"] },
  { key: "usage", parse: parseUsage,
    labels: ["total usage", "usage", "consumption"] },
  { key: "usage_basis", parse: parseUsageBasis,
    labels: ["reading type", "usage type", "meter reading type"] },
]);

function readServicePeriod(body) {
  const raw = labelled(body, ["service period", "billing period"], parseText);
  if (!raw) return null;
  const parts = raw.split(/\s+(?:to|through|thru)\s+|\s+[-–—]\s+/i);
  if (parts.length !== 2) return null;
  const start = parseDate(parts[0]);
  const end = parseDate(parts[1]);
  return start && end ? { service_period_start: start, service_period_end: end } : null;
}

function exactAssociations(fields, known = {}) {
  const result = {};
  const account = (known.accounts || []).find((row) =>
    fields.external_account_identifier
      && String(row.external_account_identifier) === fields.external_account_identifier);
  const meter = (known.meters || []).find((row) =>
    fields.meter_identifier && String(row.meter_identifier) === fields.meter_identifier);
  const point = (known.service_points || []).find((row) =>
    fields.service_point_identifier
      && String(row.external_identifier || "") === fields.service_point_identifier);
  if (account) result.account_id = account.id;
  if (meter) result.meter_id = meter.id;
  if (point) result.service_point_id = point.id;
  return result;
}

function propose(text, artifactKind = "utility_statement", known = {}) {
  if (artifactKind !== "utility_statement") {
    return {
      available: false, found_count: 0, fields: {}, unknown: [], associations: {},
      source: "label_scan",
      reason: "Spine only proposes Utility statement facts in this first slice. Record other Utility evidence through human establishment.",
    };
  }
  const body = String(text == null ? "" : text);
  if (!body.trim()) {
    return {
      available: false, found_count: 0, fields: {},
      unknown: STATEMENT_FIELDS.map((field) => field.key)
        .concat(["service_period_start", "service_period_end"]),
      associations: {}, source: "label_scan",
      reason: "Spine could not read text from this statement. Enter what it says and confirm it against the retained file.",
    };
  }

  const fields = {};
  const unknown = [];
  for (const field of STATEMENT_FIELDS) {
    const value = labelled(body, field.labels, field.parse);
    if (value !== null && value !== undefined && value !== "") fields[field.key] = value;
    else unknown.push(field.key);
  }
  const period = readServicePeriod(body);
  if (period) Object.assign(fields, period);
  else unknown.push("service_period_start", "service_period_end");

  const foundCount = Object.keys(fields).length;
  return {
    available: true,
    found_count: foundCount,
    fields,
    unknown,
    associations: exactAssociations(fields, known),
    source: "label_scan",
    reason: foundCount
      ? `Spine read ${foundCount} labelled statement facts. Check each one before confirming; the proposal itself establishes nothing.`
      : "Spine found none of the Utility statement labels it reads. Enter what the statement says and confirm it against the retained file.",
  };
}

module.exports = {
  propose,
  STATEMENT_FIELDS,
  parseDate,
  parseMoney,
  parseIdentifier,
  parseService,
  parseUsage,
  parseUsageBasis,
};
