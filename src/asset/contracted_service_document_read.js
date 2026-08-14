"use strict";

/*
 * Contracted-service document recognition has no canonical authority:
 * retained artifact -> proposal -> human confirmation -> canonical writer.
 */

const MONTHS = Object.freeze({
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
});

const SERVICE_PATTERNS = Object.freeze([
  ["building_cleaning", /\b(?:janitorial|building cleaning|cleaning service)\b/i],
  ["elevator_maintenance", /\b(?:elevator|escalator)\b/i],
  ["fire_alarm_monitoring", /\b(?:fire alarm|alarm monitoring)\b/i],
  ["fire_sprinkler_service", /\b(?:fire sprinkler|sprinkler system)\b/i],
  ["security_concierge", /\b(?:security guard|security services?|concierge)\b/i],
  ["hvac_maintenance", /\b(?:HVAC|heating,? ventilation|air conditioning)\b/i],
  ["waste_removal", /\b(?:trash|waste|recycl(?:e|ing)|rubbish)\b/i],
  ["compactor_rental", /\bcompactor\b/i],
  ["pest_control", /\b(?:pest control|exterminat(?:or|ion))\b/i],
  ["snow_removal", /\b(?:snow removal|snow plow|deicing)\b/i],
  ["landscaping", /\b(?:landscap(?:e|ing)|lawn care|groundskeeping)\b/i],
  ["water_treatment", /\bwater treatment\b/i],
  ["meter_reading", /\bmeter reading\b/i],
  ["parking_operations", /\bparking (?:management|operations?)\b/i],
]);

const DOCUMENT_KIND_BY_ARTIFACT = Object.freeze({
  contracted_service_proposal: "proposal",
  contracted_service_agreement: "agreement",
  contracted_service_statement_of_work: "statement_of_work",
  contracted_service_amendment: "amendment",
  contracted_service_addendum: "addendum",
  contracted_service_renewal_notice: "renewal_notice",
  contracted_service_termination_notice: "termination_notice",
  contracted_service_invoice: "invoice",
  contracted_service_certificate_of_insurance: "certificate_of_insurance",
  contracted_service_service_report: "service_report",
  contracted_service_accounting_report: "accounting_report",
});

function pad(value) { return String(value).padStart(2, "0"); }

function validIsoDate(year, month, day) {
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year)
      || date.getUTCMonth() + 1 !== Number(month)
      || date.getUTCDate() !== Number(day)) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

function parseDate(raw) {
  const value = String(raw || "").trim();
  let match = value.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (match) return validIsoDate(match[1], match[2], match[3]);
  match = value.match(/\b([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b/i);
  if (match && MONTHS[match[1].slice(0, 3).toLowerCase()]) {
    return validIsoDate(match[3], MONTHS[match[1].slice(0, 3).toLowerCase()], match[2]);
  }
  match = value.match(/\b(\d{1,2})[- /]([A-Za-z]{3,9})[- /](20\d{2})\b/i);
  if (match && MONTHS[match[2].slice(0, 3).toLowerCase()]) {
    return validIsoDate(match[3], MONTHS[match[2].slice(0, 3).toLowerCase()], match[1]);
  }
  return null;
}

function compact(value, limit = 240) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text || text.length > limit || /^[-_:.,/]+$/.test(text)) return null;
  return text;
}

function labelledLine(body, labels) {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    const match = body.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*[:#-]?\\s*([^\\n]{1,240})`, "i"));
    if (match) {
      const value = compact(match[1]);
      if (value && !/^(?:_{2,}|n\/?a|not established)$/i.test(value)) return value;
    }
  }
  return null;
}

function labelledDate(body, labels) {
  for (const label of labels) {
    const value = labelledLine(body, [label]);
    const date = parseDate(value);
    if (date) return date;
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    const match = body.match(new RegExp(`${escaped}[^\\n.]{0,80}`, "i"));
    const inline = parseDate(match && match[0]);
    if (inline) return inline;
  }
  return null;
}

function documentKind(body, artifactKind) {
  if (DOCUMENT_KIND_BY_ARTIFACT[artifactKind]) return DOCUMENT_KIND_BY_ARTIFACT[artifactKind];
  const title = String(body || "").slice(0, 500);
  const choices = [
    ["amendment", /\bamendment\b/i], ["addendum", /\baddendum\b/i],
    ["statement_of_work", /\bstatement of work\b|\bSOW\b/i],
    ["proposal", /\bproposal\b|\bquotation\b|\bestimate\b/i],
    ["agreement", /\bagreement\b|\bservice contract\b/i],
    ["invoice", /\binvoice\b/i], ["service_report", /\bservice report\b/i],
  ];
  const match = choices.find(([, pattern]) => pattern.test(title));
  return match ? match[0] : "other";
}

function signatureRead(body) {
  const signatureLines = String(body || "").split(/\r?\n/)
    .filter((line) => /\b(?:signature|signed by|authorized by)\b/i.test(line));
  const blank = signatureLines.some((line) =>
    /(?:signature|signed by|authorized by)\s*[:#-]?\s*(?:_{2,}|\.{3,}|$)/i.test(line.trim()));
  const datedBlank = /\bdate\s*[:#-]?\s*(?:_{2,}|\.{3,})(?:\s|$)/im.test(body);
  return {
    proposed_execution_state: blank || datedBlank ? "unsigned" : "unverified",
    signature_evidence: blank || datedBlank
      ? "blank_signature_fields_detected" : "execution_not_established_from_text",
  };
}

function serviceClasses(body) {
  return SERVICE_PATTERNS.filter(([, pattern]) => pattern.test(body)).map(([key]) => key);
}

function numberNear(body, pattern) {
  const match = String(body || "").match(pattern);
  return match ? Number(match[1]) : null;
}

function renewalRead(body) {
  const text = String(body || "");
  const automatic = /\b(?:automatically renews?|automatic renewal|auto-renew|successive renewal)\b/i
    .test(text);
  let renewalMonths = null;
  if (automatic) {
    const match = text.match(/(?:renew(?:al|ed|s)?|successive)[^\n.]{0,90}?\b(\d{1,2})\s*[- ]?(year|month)s?\b/i)
      || text.match(/\b(\d{1,2})\s*[- ]?(year|month)s?\b[^\n.]{0,50}?renew/i);
    if (match) renewalMonths = Number(match[1]) * (match[2].toLowerCase() === "year" ? 12 : 1);
  }
  const noticeDays = numberNear(text,
    /\b(\d{1,3})\s*(?:calendar\s+)?days?[^\n.]{0,60}\b(?:written\s+)?notice\b/i)
    || numberNear(text,
      /\b(?:written\s+)?notice\b[^\n.]{0,60}\b(\d{1,3})\s*(?:calendar\s+)?days?\b/i);
  return {
    automatic_renewal: automatic ? true : null,
    renewal_period_months: renewalMonths,
    notice_days: noticeDays,
  };
}

function initialTermRead(body) {
  const text = String(body || "");
  const triggerMatch = text.match(
    /\b(?:commences?|begins?|starts?)\s+(?:on|upon)\s+(?:the\s+)?(?:date\s+(?:the\s+)?(?:service|equipment|locker|printer)\s+is\s+)?(?:installation(?:\s+(?:date|and\s+activation))?|installed\s+and\s+activated)\b/i);
  let months = null;
  const wordValues = { one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const ordinalValues = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
    sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
  const parenthetical = text.match(
    /\b(?:initial\s+term|term)[^\n.]{0,180}?\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\s*\((\d{1,2})\)\s*[- ]?(year|month)s?\b/i);
  const numeric = text.match(
    /\b(?:initial\s+term|term)[^\n.]{0,180}?\b(\d{1,2})\s*[- ]?(year|month)s?\b/i);
  const worded = text.match(
    /\b(?:initial\s+term|term)[^\n.]{0,180}?\b(one|two|three|four|five|six|seven|eight|nine|ten)\s*[- ]?(year|month)s?\b/i);
  const anniversary = text.match(
    /\b(?:(\d{1,2})(?:st|nd|rd|th)|(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth))\s+anniversary\b/i);
  if (parenthetical) {
    months = Number(parenthetical[1]) * (parenthetical[2].toLowerCase() === "year" ? 12 : 1);
  } else if (numeric) {
    months = Number(numeric[1]) * (numeric[2].toLowerCase() === "year" ? 12 : 1);
  } else if (worded) {
    months = wordValues[worded[1].toLowerCase()]
      * (worded[2].toLowerCase() === "year" ? 12 : 1);
  } else if (anniversary) {
    months = Number(anniversary[1] || ordinalValues[anniversary[2].toLowerCase()]) * 12;
  }
  return {
    commencement_trigger: triggerMatch ? compact(triggerMatch[0], 500) : null,
    initial_term_months: months,
  };
}

function priceBasis(text) {
  if (/\bper\s+month|\bmonthly\b/i.test(text)) return "monthly";
  if (/\bper\s+year|\bannual(?:ly)?\b/i.test(text)) return "annual";
  if (/\bper\s+(?:visit|service|occurrence)\b/i.test(text)) return "per_visit";
  if (/\bper\s+hour|\bhourly\b/i.test(text)) return "hourly";
  if (/\bper\s+(?:unit|device|fixture)\b/i.test(text)) return "per_unit";
  return "other";
}

function priceComponents(body) {
  const lines = String(body || "").split(/\r?\n/).filter((line) => /\$\s*\d/.test(line));
  const result = [];
  for (const line of lines.slice(0, 20)) {
    const range = line.match(/\$\s*([\d,]+(?:\.\d{2})?)\s*(?:-|to)\s*\$?\s*([\d,]+(?:\.\d{2})?)/i);
    if (range) {
      result.push({
        price_basis: "variable",
        amount_cents: null,
        description: compact(line, 320),
      });
      continue;
    }
    const amount = line.match(/\$\s*([\d,]+(?:\.\d{2})?)/);
    if (!amount) continue;
    const dollars = Number(amount[1].replace(/,/g, ""));
    if (!Number.isFinite(dollars) || dollars < 0) continue;
    result.push({
      price_basis: priceBasis(line),
      amount_cents: Math.round(dollars * 100),
      description: compact(line, 320),
    });
  }
  return result;
}

function scopeRead(body, classes) {
  const explicit = labelledLine(body, ["scope of work", "services provided", "service scope"]);
  const frequency = String(body || "").match(
    /\b(?:Monday\s*(?:-|through|to)\s*Friday|daily|weekly|biweekly|bi-weekly|monthly|quarterly|annual(?:ly)?|per visit)\b[^\n.]{0,120}/i);
  return {
    scope_summary: explicit || (classes.length ? null : null),
    frequency_summary: compact(frequency && frequency[0]),
  };
}

function propose(text, artifactKind = "contracted_service_document") {
  const body = String(text == null ? "" : text);
  if (!body.trim()) {
    return {
      available: false,
      authority: "proposal_only",
      source: "contracted_service_label_scan",
      fields: {}, term: {}, price_components: [], scope: {},
      unknown: ["document_kind", "execution_state", "provider_name", "service_class"],
      warnings: ["No readable text was available. Retain the file and establish facts manually."],
    };
  }

  const classes = serviceClasses(body);
  const execution = signatureRead(body);
  const kind = documentKind(body, artifactKind);
  const commencement = labelledDate(body,
    ["commencement date", "service commencement", "start date", "effective date"]);
  const initialEnd = labelledDate(body,
    ["initial end date", "expiration date", "end date", "term expires"]);
  const initialTerm = initialTermRead(body);
  const renewal = renewalRead(body);
  const fields = {
    document_kind: kind,
    execution_state: execution.proposed_execution_state,
    provider_name: labelledLine(body,
      ["service provider", "contractor", "vendor", "provider"]),
    customer_name: labelledLine(body, ["customer", "client", "owner"]),
    document_date: labelledDate(body, ["document date", "proposal date", "agreement date", "date"]),
    named_effective_date: labelledDate(body, ["effective date"]),
    service_class: classes.length === 1 ? classes[0] : null,
    service_class_candidates: classes,
  };
  const term = {
    term_authority: "offered",
    commencement_date: commencement,
    commencement_trigger: initialTerm.commencement_trigger,
    initial_end_date: initialEnd,
    initial_term_months: initialTerm.initial_term_months,
    term_kind: ((commencement && initialEnd) || (initialTerm.commencement_trigger
      && initialTerm.initial_term_months)) ? "fixed"
      : (/\bmonth[- ]to[- ]month\b/i.test(body) ? "month_to_month" : "unknown"),
    automatic_renewal: renewal.automatic_renewal,
    renewal_period_months: renewal.renewal_period_months,
    notice_days: renewal.notice_days,
  };
  const unknown = Object.entries(fields)
    .filter(([key, value]) => key !== "service_class_candidates"
      && (value === null || value === undefined || value === ""))
    .map(([key]) => key);
  const prices = priceComponents(body);
  if (!prices.length) unknown.push("price_components");
  const warnings = [
    "Recognition proposes facts only. Confirm every value against the retained artifact.",
    "Execution is never established from extracted text; inspect the complete signature pages.",
  ];
  if (execution.signature_evidence === "blank_signature_fields_detected") {
    warnings.push("Blank signature fields were detected, so this document is proposed as unsigned.");
  }
  if (kind === "invoice" || kind === "accounting_report") {
    warnings.push("Financial evidence does not establish an agreement, its scope, its price, or payment.");
  }

  return {
    available: true,
    authority: "proposal_only",
    source: "contracted_service_label_scan",
    fields,
    term,
    price_components: prices,
    scope: scopeRead(body, classes),
    signature_evidence: execution.signature_evidence,
    unknown,
    warnings,
  };
}

module.exports = {
  propose,
  parseDate,
  documentKind,
  signatureRead,
  serviceClasses,
  priceComponents,
  renewalRead,
  initialTermRead,
};
