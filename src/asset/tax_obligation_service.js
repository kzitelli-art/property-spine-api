/* ════════════════════════════════════════════════════════════════════
   tax_obligation_service.js — THE canonical writer for governed tax
   truth. One place records what a jurisdiction says is owed, whether it
   was filed, and whether it was paid.

   ── IT KNOWS NOTHING ABOUT HOW TAX IS FUNDED ────────────────────────
   No escrow, no lender, no contribution. Funding lives behind
   `gate_funding_boundary.js`, which fails the build if this file reaches
   it. A funded escrow is not a paid tax; only City payment evidence is,
   and only `recordPayment` writes that.

   ── IT CALCULATES NOTHING ───────────────────────────────────────────
   No assessment × rate. No BIRT computation. No NPT computation. No U&O
   derived from a whole-property assessment. What a tax costs is what the
   City says it costs, recorded as evidence. Spine computing a plausible
   number nobody owes is the failure this domain is built to avoid.

   ── FILING AND PAYMENT ARE DIFFERENT VERBS ──────────────────────────
   recordFiling and recordPayment are separate because a filed BIRT
   return does not pay a balance and a payment does not file a return.
   There is no single `markCurrent`.

   CLASS 1 — permanent product primitive.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const rules = require("./philadelphia_tax_rules.js");

const DETERMINATIONS = Object.freeze(["applies", "not_applicable"]);

/*  pg hands back a `date` column as a JS Date at LOCAL midnight, so
 *  String(d).slice(0,10) yields "Mon Jan 01". Built from local components
 *  rather than toISOString(), which shifts the DAY west of UTC — and a tax
 *  due date off by one is not a rounding error. */
function isoDay(d) {
  if (!d) return null;
  if (typeof d === "string") return d.slice(0, 10);
  if (!(d instanceof Date)) return null;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const FILING_KINDS = Object.freeze(["return", "estimate", "extension", "amended_return"]);
const PAID_BY = Object.freeze(["property", "lender_escrow", "other"]);

function taxError(code, message, extra = {}) {
  const e = new Error(message); e.code = code; Object.assign(e, extra); return e;
}

function requireProvenance(artifact, note, what) {
  if (!artifact && !(note && String(note).trim())) {
    throw taxError("PROVENANCE_REQUIRED",
      `${what} requires provenance: a document, or a note recording where this came ` +
      "from. A tax fact that cannot say where it came from cannot be defended later.");
  }
}

function requireCents(name, v, { positive = false } = {}) {
  if (v === null || v === undefined) return null;
  if (!Number.isInteger(v) || v < 0 || (positive && v <= 0)) {
    throw taxError("BAD_INPUT",
      `${name} must be a ${positive ? "positive" : "non-negative"} integer of cents`);
  }
  return v;
}

/*  The subject shape is decided by the tax type, not by the caller. The
 *  schema enforces it too; this exists so the refusal is SAYABLE rather
 *  than a check-constraint violation reaching someone holding a bill. */
function resolveSubject(tax_type, { property_id, legal_entity_id }) {
  const kind = rules.SUBJECT_KIND[tax_type];
  if (!kind) throw taxError("BAD_INPUT", `unknown tax type ${JSON.stringify(tax_type)}`);
  if (kind === "property") {
    if (!property_id) {
      throw taxError("SUBJECT_REQUIRED",
        `${rules.TAX_LABEL[tax_type]} is owed by the PROPERTY. It needs a property, ` +
        "not a legal entity.");
    }
    if (legal_entity_id) {
      throw taxError("WRONG_SUBJECT",
        `${rules.TAX_LABEL[tax_type]} is owed by the property, not by a legal entity.`);
    }
    return { property_id, legal_entity_id: null };
  }
  if (!legal_entity_id) {
    throw taxError("SUBJECT_REQUIRED",
      `${rules.TAX_LABEL[tax_type]} is owed by the TAXPAYER — a legal entity — not by ` +
      "the property. Establish the entity that files it first.");
  }
  if (property_id) {
    throw taxError("WRONG_SUBJECT",
      `${rules.TAX_LABEL[tax_type]} is owed by a legal entity, not by the property. ` +
      "Relate the obligation to properties instead of making one its subject.");
  }
  return { property_id: null, legal_entity_id };
}

/*  ── ESTABLISH AN OBLIGATION ────────────────────────────────────────
 *  `related_property_ids` is how an ENTITY obligation reaches the
 *  properties it should surface on. It stays ONE obligation: an entity
 *  holding two properties has one BIRT return, not two.
 */
async function establishObligation(client, {
  tax_type, period_year, period_month = null,
  property_id = null, legal_entity_id = null,
  related_property_ids = null,
  account_identifier = null,
  source_artifact_id = null, provenance_note = null, user_id,
} = {}) {
  if (!rules.TAX_TYPES.includes(tax_type)) {
    throw taxError("BAD_INPUT", `tax_type must be one of ${rules.TAX_TYPES.join(", ")}`);
  }
  if (!user_id) throw taxError("BAD_INPUT", "user_id is required");
  requireProvenance(source_artifact_id, provenance_note, "a tax obligation");

  const period = rules.periodFor(tax_type, { year: period_year, month: period_month });
  if (!period) {
    throw taxError("PERIOD_REQUIRED",
      rules.CADENCE[tax_type] === "monthly"
        ? `${rules.TAX_LABEL[tax_type]} is monthly — it needs a year and a month.`
        : `${rules.TAX_LABEL[tax_type]} is annual — it needs a tax year.`);
  }

  const subject = resolveSubject(tax_type, { property_id, legal_entity_id });

  if (subject.legal_entity_id) {
    const ent = (await client.query(
      `select id from legal_entities where id = $1`, [subject.legal_entity_id])).rows[0];
    if (!ent) throw taxError("NOT_FOUND", "legal entity not found");
  }

  let obl;
  try {
    obl = (await client.query(
      `insert into tax_obligations
         (jurisdiction, tax_type, liable_property_id, liable_legal_entity_id,
          period_start, period_end, account_identifier,
          source_artifact_id, provenance_note, recorded_by_user_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
      [rules.JURISDICTION, tax_type, subject.property_id, subject.legal_entity_id,
       period.period_start, period.period_end, account_identifier,
       source_artifact_id, provenance_note, user_id])).rows[0];
  } catch (e) {
    if (/uq_tax_obl_(entity|property)_period/.test(e.message)) {
      throw taxError("ALREADY_ESTABLISHED",
        `${rules.TAX_LABEL[tax_type]} for ${period.label} is already established for this ` +
        "subject. Correct the existing obligation rather than creating a second one.");
    }
    throw e;
  }

  //  ONE OBLIGATION, MANY PROPERTIES. A property-subject obligation
  //  relates to its own property so a single read serves both shapes.
  const related = subject.property_id
    ? [subject.property_id]
    : (Array.isArray(related_property_ids) ? related_property_ids : []);
  for (const pid of related) {
    await client.query(
      `insert into tax_obligation_properties (obligation_id, property_id)
       values ($1,$2) on conflict do nothing`, [obl.id, pid]);
  }

  return { ...obl, period_label: period.label, related_property_ids: related };
}

/*  Relate an existing entity obligation to another property. Still one
 *  obligation — this is the operation that must NOT duplicate it. */
async function relateObligationToProperty(client, { obligation_id, property_id }) {
  if (!obligation_id || !property_id) {
    throw taxError("BAD_INPUT", "obligation_id and property_id are required");
  }
  await client.query(
    `insert into tax_obligation_properties (obligation_id, property_id)
     values ($1,$2) on conflict do nothing`, [obligation_id, property_id]);
}

/*  ── APPLICABILITY — A HUMAN DETERMINATION, ALWAYS ──────────────────
 *  ⚠ THERE IS NO INFERENCE PATH INTO THIS FUNCTION.
 *  Not from entity_type, not from a property being residential, not from
 *  the absence of commercial space. Philadelphia exempts corporations
 *  from NPT — and that is a reason for somebody to establish the finding,
 *  never the finding itself. `basis` is mandatory because a "not
 *  applicable" with no stated reason cannot be re-examined.
 */
async function confirmApplicability(client, {
  tax_type, determination, basis,
  property_id = null, legal_entity_id = null,
  effective_from, effective_to = null,
  source_artifact_id = null, provenance_note = null,
  supersedes_id = null, revision_reason = null, user_id,
} = {}) {
  if (!rules.TAX_TYPES.includes(tax_type)) {
    throw taxError("BAD_INPUT", `tax_type must be one of ${rules.TAX_TYPES.join(", ")}`);
  }
  if (!DETERMINATIONS.includes(determination)) {
    throw taxError("BAD_INPUT",
      `determination must be one of ${DETERMINATIONS.join(", ")}. There is no "unknown" — ` +
      "an unknown applicability is the ABSENCE of a determination, not a value.");
  }
  if (!(basis && String(basis).trim())) {
    throw taxError("BASIS_REQUIRED",
      "an applicability determination requires a stated basis. Without one, nobody can " +
      "re-examine it — and `not applicable` is the one that will be questioned.");
  }
  if (!effective_from) throw taxError("BAD_INPUT", "effective_from is required");
  if (!user_id) throw taxError("BAD_INPUT", "user_id is required");
  requireProvenance(source_artifact_id, provenance_note, "an applicability determination");

  const subject = resolveSubject(tax_type, { property_id, legal_entity_id });

  //  ⚠ A SAME-DAY RESTATEMENT IS A CORRECTION, NOT A NEW SLICE.
  //  Closing a slice at its own start date is impossible (effective_to
  //  must exceed effective_from), so without this the prior determination
  //  would stay live alongside the new one and the property would be both
  //  `applies` and `not_applicable` at once. Naming it forces the caller
  //  to say WHY the earlier determination was wrong.
  const live = (await client.query(
    `select id, effective_from, determination from tax_obligation_applicability
      where tax_type = $1
        and coalesce(subject_property_id::text, subject_legal_entity_id::text) = $2
        and effective_to is null and supersedes_id is null
      limit 1`,
    [tax_type, String(subject.property_id || subject.legal_entity_id)])).rows[0];
  if (live && !supersedes_id) {
    const from = live.effective_from instanceof Date
      ? live.effective_from.toISOString().slice(0, 10) : String(live.effective_from).slice(0, 10);
    if (from >= String(effective_from)) {
      throw taxError("CORRECTION_REQUIRED",
        `${rules.TAX_LABEL[tax_type]} is already determined "${live.determination}" from ` +
        `${from}. Restating it for the same date is a CORRECTION — say why the earlier ` +
        "determination was wrong, or date the new one from when the world actually changed.");
    }
  }

  //  Close the live determination for this subject and type before
  //  opening the next. Applicability changes when the world does.
  await client.query(
    `update tax_obligation_applicability
        set effective_to = $3
      where tax_type = $1
        and coalesce(subject_property_id::text, subject_legal_entity_id::text) = $2
        and effective_to is null and effective_from < $3
        and not exists (select 1 from tax_obligation_applicability s
                         where s.supersedes_id = tax_obligation_applicability.id)`,
    [tax_type, String(subject.property_id || subject.legal_entity_id), effective_from]);

  const { rows } = await client.query(
    `insert into tax_obligation_applicability
       (jurisdiction, tax_type, subject_property_id, subject_legal_entity_id,
        determination, basis, effective_from, effective_to,
        source_artifact_id, provenance_note, supersedes_id, revision_reason,
        confirmed_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,
    [rules.JURISDICTION, tax_type, subject.property_id, subject.legal_entity_id,
     determination, String(basis).trim(), effective_from, effective_to,
     source_artifact_id, provenance_note, supersedes_id, revision_reason, user_id]);
  return rows[0];
}

/*  ── THE GOVERNED LIABILITY ─────────────────────────────────────────
 *  What the City says is owed. `assessment_cents` is recorded because it
 *  appears on the bill and explains the figure — it never produces it.
 */
async function recordLiability(client, {
  obligation_id, annual_liability_cents, due_date,
  assessment_cents = null, city_balance_cents = null, balance_as_of = null,
  currency_code = "USD",
  source_artifact_id = null, provenance_note = null,
  supersedes_id = null, revision_reason = null, user_id,
} = {}) {
  if (!obligation_id) throw taxError("BAD_INPUT", "obligation_id is required");
  if (!due_date) throw taxError("BAD_INPUT", "due_date is required");
  if (!user_id) throw taxError("BAD_INPUT", "user_id is required");
  requireCents("annual_liability_cents", annual_liability_cents);
  if (annual_liability_cents === null || annual_liability_cents === undefined) {
    throw taxError("BAD_INPUT", "annual_liability_cents is required");
  }
  requireCents("assessment_cents", assessment_cents);
  requireCents("city_balance_cents", city_balance_cents);
  requireProvenance(source_artifact_id, provenance_note, "a tax liability");
  if (supersedes_id && !(revision_reason && String(revision_reason).trim())) {
    throw taxError("REASON_REQUIRED",
      "correcting a liability requires a reason. Without one the record cannot explain " +
      "why the earlier figure changed — an adjusted City bill and a transcription error " +
      "are very different stories.");
  }

  const obl = (await client.query(
    `select id from tax_obligations where id = $1`, [obligation_id])).rows[0];
  if (!obl) throw taxError("NOT_FOUND", "tax obligation not found");

  const { rows } = await client.query(
    `insert into tax_liabilities
       (obligation_id, annual_liability_cents, assessment_cents,
        city_balance_cents, balance_as_of, due_date, currency_code,
        source_artifact_id, provenance_note, supersedes_id, revision_reason,
        recorded_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
    [obligation_id, annual_liability_cents, assessment_cents,
     city_balance_cents, balance_as_of, due_date, currency_code,
     source_artifact_id, provenance_note, supersedes_id, revision_reason, user_id]);
  return rows[0];
}

async function recordFiling(client, {
  obligation_id, filed_at, filing_kind = "return", confirmation_reference = null,
  source_artifact_id = null, provenance_note = null, user_id,
} = {}) {
  if (!obligation_id) throw taxError("BAD_INPUT", "obligation_id is required");
  if (!filed_at) throw taxError("BAD_INPUT", "filed_at is required");
  if (!FILING_KINDS.includes(filing_kind)) {
    throw taxError("BAD_INPUT", `filing_kind must be one of ${FILING_KINDS.join(", ")}`);
  }
  if (!user_id) throw taxError("BAD_INPUT", "user_id is required");
  requireProvenance(source_artifact_id, provenance_note, "a tax filing");

  const { rows } = await client.query(
    `insert into tax_filings
       (obligation_id, filed_at, filing_kind, confirmation_reference,
        source_artifact_id, provenance_note, recorded_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7) returning *`,
    [obligation_id, filed_at, filing_kind, confirmation_reference,
     source_artifact_id, provenance_note, user_id]);
  return rows[0];
}

/*  ── PAYMENT. THIS IS WHAT `PAID` MEANS. ───────────────────────────
 *  Evidence the City was paid. `paid_by = 'lender_escrow'` records WHO
 *  remitted — it does not make the escrow the proof, and no escrow
 *  balance anywhere can call this function.
 *
 *  ── AND IT MUST SAY WHICH REQUIREMENT IT PAYS ─────────────────────
 *  Migration 167's whole point. An obligation can carry several payment
 *  requirements on the same day — the City's BIRT return prints the
 *  year's balance and the following year's mandatory estimate as
 *  separate lines — and money against one of them is not money against
 *  the other.
 *
 *  Where there is exactly ONE payment requirement there is no ambiguity,
 *  so the writer fills it in. Where there are several it REFUSES rather
 *  than guessing, and the refusal names the choices.
 */
async function recordPayment(client, {
  obligation_id, paid_at, amount_cents, paid_by = null,
  satisfies_requirement = null,
  confirmation_reference = null,
  source_artifact_id = null, provenance_note = null, user_id,
} = {}) {
  if (!obligation_id) throw taxError("BAD_INPUT", "obligation_id is required");
  if (!paid_at) throw taxError("BAD_INPUT", "paid_at is required");
  requireCents("amount_cents", amount_cents, { positive: true });
  if (amount_cents === null || amount_cents === undefined) {
    throw taxError("BAD_INPUT", "amount_cents is required");
  }
  if (paid_by !== null && !PAID_BY.includes(paid_by)) {
    throw taxError("BAD_INPUT", `paid_by must be one of ${PAID_BY.join(", ")}`);
  }
  if (!user_id) throw taxError("BAD_INPUT", "user_id is required");
  requireProvenance(source_artifact_id, provenance_note, "a tax payment");

  const obl = (await client.query(
    `select id, tax_type, period_start, birt_filer_profile
       from tax_obligations where id = $1`, [obligation_id])).rows[0];
  if (!obl) throw taxError("NOT_FOUND", "tax obligation not found");

  const options = rules.milestonesFor(obl.tax_type, isoDay(obl.period_start),
    { birt_filer_profile: obl.birt_filer_profile })
    .filter((m) => m.kind === "payment");

  let key = satisfies_requirement;
  if (!key) {
    if (options.length === 1) {
      //  UNAMBIGUOUS. One requirement, so naming it adds nothing a caller
      //  could get wrong. Real Estate Tax and U&O land here.
      key = options[0].key;
    } else {
      throw taxError("REQUIREMENT_REQUIRED",
        `${rules.TAX_LABEL[obl.tax_type]} has ${options.length} separate payment ` +
        `requirements, so a payment has to say which one it is for: ` +
        `${options.map((m) => `${m.label} (${m.key})`).join("; ")}. Money against one ` +
        "of them is not money against the others.");
    }
  } else if (!options.some((m) => m.key === key)) {
    throw taxError("UNKNOWN_REQUIREMENT",
      `"${key}" is not a payment requirement of this ` +
      `${rules.TAX_LABEL[obl.tax_type]} obligation.` +
      (options.length
        ? ` It carries: ${options.map((m) => m.key).join(", ")}.`
        : " It carries none — its requirements are not established yet."));
  }

  const { rows } = await client.query(
    `insert into tax_payments
       (obligation_id, paid_at, amount_cents, paid_by, satisfies_requirement,
        confirmation_reference, source_artifact_id, provenance_note,
        recorded_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
    [obligation_id, paid_at, amount_cents, paid_by, key, confirmation_reference,
     source_artifact_id, provenance_note, user_id]);
  return rows[0];
}

/*  ── THE BIRT FILER PROFILE ─────────────────────────────────────────
 *  Whether the mandatory estimated payment for the following year
 *  applies to this taxpayer in this year. A DETERMINATION, never an
 *  inference — not from entity_type, not from a formation date, and not
 *  from the absence of a prior return in Spine, since a business that
 *  has filed in Philadelphia for a decade can still be new to us.
 */
async function setBirtFilerProfile(client, {
  obligation_id, birt_filer_profile, basis, user_id,
} = {}) {
  if (!obligation_id) throw taxError("BAD_INPUT", "obligation_id is required");
  if (!rules.BIRT_FILER_PROFILES.includes(birt_filer_profile)) {
    throw taxError("BAD_INPUT",
      `birt_filer_profile must be one of ${rules.BIRT_FILER_PROFILES.join(", ")}`);
  }
  if (!(basis && String(basis).trim())) {
    throw taxError("BASIS_REQUIRED",
      "recording a filer profile requires a stated basis. It decides whether a " +
      "MANDATORY payment exists, and a determination nobody can re-examine is not " +
      "one Spine will stand behind.");
  }
  if (!user_id) throw taxError("BAD_INPUT", "user_id is required");

  const { rows } = await client.query(
    `update tax_obligations
        set birt_filer_profile = $2, birt_filer_profile_basis = $3
      where id = $1 and tax_type = 'birt'
      returning *`,
    [obligation_id, birt_filer_profile, String(basis).trim()]);
  if (!rows[0]) {
    throw taxError("NOT_FOUND",
      "no BIRT obligation with that id. A filer profile belongs to BIRT — it is the " +
      "tax whose estimated payment depends on it.");
  }
  return rows[0];
}

/*  An appeal is a real operating fact that changes NOTHING about the
 *  current liability. Recorded beside it, never on it. */
async function openAppeal(client, {
  obligation_id, opened_on, source_artifact_id = null, provenance_note = null, user_id,
} = {}) {
  if (!obligation_id || !opened_on) {
    throw taxError("BAD_INPUT", "obligation_id and opened_on are required");
  }
  if (!user_id) throw taxError("BAD_INPUT", "user_id is required");
  const { rows } = await client.query(
    `insert into tax_appeals (obligation_id, opened_on, source_artifact_id,
       provenance_note, recorded_by_user_id)
     values ($1,$2,$3,$4,$5) returning *`,
    [obligation_id, opened_on, source_artifact_id, provenance_note, user_id]);
  return rows[0];
}

/*  Clearance is COMPLIANCE EVIDENCE, not a fifth tax. It may strengthen a
 *  standing read; it may never manufacture a missing obligation fact. */
async function recordClearance(client, {
  property_id = null, legal_entity_id = null,
  issued_on, verified_through, certificate_reference = null,
  source_artifact_id = null, provenance_note = null, user_id,
} = {}) {
  if (!issued_on || !verified_through) {
    throw taxError("BAD_INPUT", "issued_on and verified_through are required");
  }
  if ((property_id ? 1 : 0) + (legal_entity_id ? 1 : 0) !== 1) {
    throw taxError("BAD_INPUT", "a clearance names exactly one subject");
  }
  if (!user_id) throw taxError("BAD_INPUT", "user_id is required");
  requireProvenance(source_artifact_id, provenance_note, "a tax clearance");

  const { rows } = await client.query(
    `insert into tax_clearances
       (jurisdiction, subject_property_id, subject_legal_entity_id,
        issued_on, verified_through, certificate_reference,
        source_artifact_id, provenance_note, recorded_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
    [rules.JURISDICTION, property_id, legal_entity_id, issued_on, verified_through,
     certificate_reference, source_artifact_id, provenance_note, user_id]);
  return rows[0];
}

module.exports = {
  DETERMINATIONS, FILING_KINDS, PAID_BY,
  establishObligation, relateObligationToProperty, confirmApplicability,
  recordLiability, recordFiling, recordPayment, openAppeal, recordClearance,
  setBirtFilerProfile, taxError, isoDay,
};
