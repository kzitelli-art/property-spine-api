/* ════════════════════════════════════════════════════════════════════
   property_line.js — the receiving line IS the property wall.

   Every inbound message resolves the LINE before the SENDER. The sender's
   identity may narrow what is appropriate; it may never establish which
   property's ledger a message belongs to. That order is doctrine
   (COMMUNICATION_LINE_ARCHITECTURE.md §1), and this module owns the one
   step it rests on: turning a received number into exactly one property,
   or refusing.

   ── WHY THIS EXISTS ──────────────────────────────────────────────────

   Inbound resolution was:

       select id, name, address, sms_number
         from properties where sms_number = $1 limit 1

   `limit 1`, no `order by`. If two properties ever held the same number, a
   resident's message bound to an ARBITRARY one — their claim landing on
   another building's ledger, confidently, with no signal.

   The same function already refuses to guess the SENDER: zero or more than
   one eligible person is `needs_human`, "never a silent pick between two
   different humans." So the system declined to guess which human texted,
   then silently guessed which building they texted. That asymmetry is the
   defect. Unknown lines already failed honestly; ambiguous ones did not.

   ── ONE NORMALIZATION ────────────────────────────────────────────────

   Owner ruling 2026-08-03: the existing `normalizePhone` output is the
   canonical stored and compared form. This module is now the single home
   of that function — tenantlink.js imports it rather than keeping the local
   copy it had at :117.

   Three readings were in play before this change:

     · comms/tenantlink.js:117   normalizePhone  — US-only; the ruled canonical form
     · identity/phone_identity   normalizeE164   — same, PLUS a "+" passthrough
                                                   that accepts any already-prefixed
                                                   international string
     · the inbound lookup        (none)          — raw exact match

   So the write path normalized, the read path did not, and the two writers
   disagreed. A line stored in any non-canonical form by a seed, migration,
   admin tool or direct SQL was not mis-routed — it was silently
   UNREACHABLE, because inbound compared raw against a normalized store.

   normalizeE164 remains the canonical normalizer for PERSON identity and is
   deliberately untouched here: a resident's phone and a property's line are
   different facts with different rules, and this slice does not get to
   change person identity. That leaves two phone normalizers in the system
   with different strictness. That is documented debt, not an accident —
   see docs/PROPERTY_LINE_HARDENING.md §7.

   ── WHY SQL DOES NOT REPLICATE THE NORMALIZER ────────────────────────

   Migration 129 does not install a SQL function or generated column that
   re-implements normalization as an ONGOING rule. That would be two
   implementations of one rule — the defect tests/_engine.js stands as a
   warning about. Instead the database enforces the INVARIANT:

     · stored lines must already be in canonical form   (CHECK)
     · at most one property may hold any line           (UNIQUE)

   The application normalizes on the way in; the database guarantees what is
   stored is canonical and unique. Both sides being canonical is what makes
   exact equality the correct comparison at read time — and it is what stops
   a direct write from bypassing uniqueness with alternate formatting.

   The migration's one-time backfill does express the transform in SQL. That
   is a historical transform that runs once and never governs another write,
   not a parallel implementation of a live rule; the CHECK constraint it
   installs is what makes it unrepeatable.

   ── CLASS (§18) ──────────────────────────────────────────────────────

   This module: permanent.
   `properties.sms_number` itself: TEMPORARY ADAPTER — one property-facing
   line per property, incapable of expressing an organisation-owned
   operations line. Retired when the canonical communication-line model
   resolves both inbound and outbound.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

/*  THE CANONICAL FORM. Ruled 2026-08-03: this is `normalizePhone` as it has
 *  existed in tenantlink.js, moved here unchanged so there is one copy.
 *
 *  US numbers only, and it says so by returning null rather than guessing:
 *  a number it cannot normalize can never match a stored line, so a bad
 *  input fails the lookup instead of matching the wrong thing. */
function normalizePropertyLine(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d[0] === "1") return "+" + d;
  return null; // not a US number we can normalize — reject honestly
}

/*  Exactly the set of values normalizePropertyLine can emit. The CHECK
 *  constraint in migration 129 uses the identical pattern, so "canonical"
 *  means the same thing in the application and in the database. */
const CANONICAL_SHAPE = /^\+1[0-9]{10}$/;
const CANONICAL_SHAPE_SQL = "^\\+1[0-9]{10}$";

function isCanonicalPropertyLine(value) {
  return typeof value === "string" && CANONICAL_SHAPE.test(value);
}

/*  resolvePropertyByLine — zero, one and many, each said out loud.
 *
 *    { outcome: 'unresolvable' }  the received number is not one we can
 *        normalize, so it can never match a stored line. Distinct from
 *        'none' because the repair differs: malformed input, not an
 *        unconfigured line. Both fail closed identically.
 *    { outcome: 'none' }          no property holds this line.
 *    { outcome: 'one', property } exactly one — resolve normally.
 *    { outcome: 'many', candidates }
 *        more than one property holds this line. There is no correct answer
 *        available, so there is no answer. Never a pick.
 *
 *  NO `limit`. The count IS the finding — capping the query at one row is
 *  precisely what made the ambiguity invisible.
 *
 *  ELIGIBILITY. `sms_number = $1` and nothing else. Migration 129's unique
 *  index uses the identical predicate (`where sms_number is not null`), so
 *  the set the database keeps unique is exactly the set this resolver reads.
 *  If properties ever gain an archived/inactive flag, BOTH must change in
 *  the same commit or the guarantee silently decouples.
 *
 *  `property` is null for every outcome except 'one', so a caller that
 *  forgets to branch on `outcome` gets a null rather than an arbitrary
 *  building. Failing closed must not depend on the caller having read the
 *  documentation. */
async function resolvePropertyByLine(q, receivedNumber) {
  const line = normalizePropertyLine(receivedNumber);
  if (!line) {
    return { outcome: "unresolvable", property: null, candidates: [], line: null };
  }

  const { rows } = await q.query(
    `select id, name, address, sms_number
       from properties
      where sms_number = $1
      order by id`,
    [line]
  );

  if (rows.length === 0) return { outcome: "none", property: null, candidates: [], line };
  if (rows.length === 1) return { outcome: "one", property: rows[0], candidates: rows, line };
  return { outcome: "many", property: null, candidates: rows, line };
}

module.exports = {
  normalizePropertyLine,
  isCanonicalPropertyLine,
  resolvePropertyByLine,
  CANONICAL_SHAPE,
  CANONICAL_SHAPE_SQL,
};
