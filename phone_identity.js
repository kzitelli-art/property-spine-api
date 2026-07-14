// ════════════════════════════════════════════════════════════════════
//  phone_identity.js — the ONE canonical phone normalizer for identity.
//
//  Person identity in the leasing domain dedups on a canonical E.164 phone
//  (persons.primary_phone_e164). Before this, several modules each carried
//  their own (byte-identical, but separately maintained) normalizer, and some
//  person-creation paths deduped on the RAW `phone` string — so the same human
//  in a different format ("7243098434" vs "+17243098434" vs "(724) 309-8434")
//  minted a NEW person, violating the one-phone-one-person rule.
//
//  This module is the single source of truth for that normalization. Callers
//  normalize an inbound phone to its canonical form and dedup on it.
//
//  SCOPE (doctrine): this is an identity SIGNAL for LEASING prospect intake —
//  not a universal "same phone = same human in every context" merge. The
//  staff-user durable-person bridge is a separate identity fact and does not
//  use this for silent merging.
// ════════════════════════════════════════════════════════════════════

// Returns canonical E.164 (US-centric: bare 10-digit → +1XXXXXXXXXX,
// 1+10 digit → +1..., already-+ passed through trimmed) or null when the input
// can't be resolved to a phone. Deliberately conservative: an unrecognized
// shape returns null rather than a guessed number.
function normalizeE164(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d[0] === "1") return "+" + d;
  if (String(raw).startsWith("+")) return String(raw).trim();
  return null;
}

module.exports = { normalizeE164 };
