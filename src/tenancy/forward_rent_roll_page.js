// ════════════════════════════════════════════════════════════════════
//  forward_rent_roll_page.js — SLICE 10D. BOUNDED TRANSPORT.
//
//  TRANSPORT ONLY. This file changes how rows travel, never what they mean.
//  The summary is computed over the COMPLETE property by the summary
//  authority and is passed through untouched: a page can never become the
//  denominator of a property-level answer.
//
//  STATELESS SIGNED CURSORS. No cursor table, no transport truth store. The
//  cursor is a base64url payload plus an HMAC, so a client can carry it but
//  cannot author one. It is BOUND to the property, the target date, the
//  ordering contract and both contract versions — a cursor minted for one
//  property or one date is refused against another rather than silently
//  restarting at page one.
//
//  CONSISTENCY, STATED HONESTLY — AND THE ORDERING FIELD IS MUTABLE.
//  This is a BEST-EFFORT LIVE CURSOR. Each page is a fresh read; no snapshot
//  spans requests, because a PostgreSQL transaction cannot span HTTP requests
//  and no projection-version store exists to bind to.
//
//  The ordering tuple is (units.unit_number, spaces.id). spaces.id is
//  immutable; **unit_number is NOT** — an operator can rename a unit. So the
//  guarantee must be stated in two parts, and an earlier draft of this file
//  overstated it as "rows never re-serve or reorder":
//
//    · UNDER STATIC DATA, traversal is exact: every row exactly once, in one
//      deterministic order, no duplicate and no omission.
//    · UNDER CONCURRENT CHANGE, a row whose unit_number is edited mid-
//      traversal may be revisited (renamed to a later key) or skipped
//      (renamed to an earlier one). Inserts earlier in the order are not
//      visited; deletions are skipped.
//
//  Display order is kept deliberately: a rent roll ordered by internal UUID
//  is not usable by an operator, and the alternative — ordering primarily by
//  spaces.id — would buy an immutable key at the cost of the surface's whole
//  purpose. The limitation is narrow and disclosed in the page object rather
//  than dressed up as snapshot isolation.
// ════════════════════════════════════════════════════════════════════

"use strict";

const crypto = require("crypto");
const { forwardRentRollSummary } = require("./forward_rent_roll_summary");

const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;
const ORDERING = "unit_number asc, space_id asc";
const ROW_CONTRACT = "forward_rent_roll_rows_v1";
const SUMMARY_CONTRACT = "forward_rent_roll_summary_v1";
const CURSOR_VERSION = "frr_cur_v1";

//  ── SIGNING AUTHORITY ───────────────────────────────────────────────
//  No general-purpose governed signing secret exists in this codebase: staff
//  sessions use random tokens stored in the database, not HMAC. So this
//  introduces CURSOR_SECRET, and governs it rather than defaulting it.
//
//  An earlier draft derived the key from DATABASE_URL when the variable was
//  absent. That is exactly the silent insecure fallback this must not do — it
//  looks configured, and its strength is whatever the connection string
//  happens to be.
//
//    · CURSOR_SECRET set            → used.
//    · absent, NODE_ENV=production  → pagination REFUSES. A cursor that cannot
//                                     be signed under a governed secret is not
//                                     issued at all.
//    · absent, non-production       → a random per-process key, DISCLOSED in
//                                     the page object. Cursors then do not
//                                     survive a restart or span instances, and
//                                     an old one is refused as
//                                     cursor_signature_invalid — a typed
//                                     refusal the contract already carries.
const CONFIGURED_SECRET = process.env.CURSOR_SECRET || null;
const IS_PRODUCTION = String(process.env.NODE_ENV) === "production";
const EPHEMERAL_SECRET = CONFIGURED_SECRET ? null : crypto.randomBytes(32).toString("base64url");
const SECRET = CONFIGURED_SECRET || EPHEMERAL_SECRET;
const SECRET_SOURCE = CONFIGURED_SECRET ? "env_cursor_secret" : "ephemeral_process_key";

const b64u = (s) => Buffer.from(s, "utf8").toString("base64url");
const unb64u = (s) => Buffer.from(String(s), "base64url").toString("utf8");
const sign = (p) => crypto.createHmac("sha256", SECRET).update(p).digest("base64url").slice(0, 32);

function cursorEncode({ property_id, as_of, unit_number, space_id }) {
  const payload = b64u(JSON.stringify({
    v: CURSOR_VERSION, p: property_id, d: as_of, o: ORDERING,
    rc: ROW_CONTRACT, sc: SUMMARY_CONTRACT, u: unit_number, s: space_id,
  }));
  return payload + "." + sign(payload);
}

//  Every refusal names its own reason. A cursor that cannot be honoured must
//  never quietly become "start again from the beginning" — that silently
//  re-serves rows the caller already has and hides the mismatch.
function cursorDecode(cursor, { property_id, as_of }) {
  if (typeof cursor !== "string" || !cursor.includes(".")) {
    return { error: "cursor_malformed", detail: "The cursor is not a well-formed value." };
  }
  const [payload, sig] = cursor.split(".");
  if (sign(payload) !== sig) {
    return { error: "cursor_signature_invalid", detail: "The cursor was not issued by this service." };
  }
  let d;
  try { d = JSON.parse(unb64u(payload)); }
  catch (_) { return { error: "cursor_malformed", detail: "The cursor payload could not be read." }; }
  if (d.v !== CURSOR_VERSION) return { error: "cursor_version_mismatch", detail: "The cursor was issued under a different cursor version." };
  if (d.rc !== ROW_CONTRACT || d.sc !== SUMMARY_CONTRACT) {
    return { error: "cursor_contract_mismatch", detail: "The cursor was issued under a different contract version." };
  }
  if (d.o !== ORDERING) return { error: "cursor_ordering_mismatch", detail: "The cursor was issued under a different ordering contract." };
  if (String(d.p) !== String(property_id)) return { error: "cursor_property_mismatch", detail: "The cursor was issued for a different property." };
  if (String(d.d) !== String(as_of)) return { error: "cursor_date_mismatch", detail: "The cursor was issued for a different target date." };
  return { after: { unit_number: d.u, space_id: d.s } };
}

//  Clamp rather than reject a merely large limit, but refuse a nonsensical
//  one: a caller asking for 500 wants "as many as allowed", while a caller
//  sending "abc" or -1 has a bug that should surface.
function resolveLimit(raw) {
  if (raw === undefined || raw === null || raw === "") return { limit: PAGE_DEFAULT };
  const n = Number(raw);
  if (!Number.isInteger(n)) return { error: "limit_invalid", detail: "limit must be a whole number." };
  if (n < 1) return { error: "limit_invalid", detail: "limit must be at least 1." };
  return { limit: Math.min(n, PAGE_MAX), clamped: n > PAGE_MAX };
}

const orderKey = (r) => [String(r.unit_number || ""), String(r.space_id)];
const afterKey = (r, after) => {
  const [u, s] = orderKey(r);
  if (u !== after.unit_number) return u > after.unit_number;
  return s > String(after.space_id);
};

async function forwardRentRollPage(pool, { property_id, as_of = null, limit, cursor } = {}) {
  if (IS_PRODUCTION && !CONFIGURED_SECRET) {
    return { error: "cursor_secret_not_configured",
             detail: "Paged transport requires CURSOR_SECRET to be configured. Cursors are not issued unsigned." };
  }
  const lim = resolveLimit(limit);
  if (lim.error) return { error: lim.error, detail: lim.detail };

  //  The summary authority computes the COMPLETE property. The page is taken
  //  from its rows afterwards, so no page can influence a total.
  const full = await forwardRentRollSummary(pool, { property_id, as_of });
  if (full.state !== "ok") return { ...full, page: null };

  const sorted = [...full.rows].sort((a, b) => {
    const [au, as_] = orderKey(a), [bu, bs] = orderKey(b);
    return au === bu ? (as_ < bs ? -1 : as_ > bs ? 1 : 0) : (au < bu ? -1 : 1);
  });

  let start = 0;
  if (cursor !== undefined && cursor !== null && cursor !== "") {
    const dec = cursorDecode(cursor, { property_id, as_of: full.summary.target_date });
    if (dec.error) return { error: dec.error, detail: dec.detail };
    start = sorted.findIndex((r) => afterKey(r, dec.after));
    if (start < 0) start = sorted.length;
  }

  //  COMPLETE-PROPERTY STATISTICS, computed before slicing. The route needs
  //  coverage and the deprecated compatibility totals to describe the WHOLE
  //  property; if it derived them from the page they would silently become
  //  page-scoped, which is the exact failure bounded transport is meant to
  //  avoid. Counted here because this is the last place that sees every row.
  const all = full.rows;
  const countBy = (fn) => all.filter(fn).length;
  const complete_stats = {
    positions: all.length,
    contractually_locked: countBy((r) => r.position_state === "contractually_locked"),
    covered_unproven: countBy((r) => r.position_state === "covered_unproven"),
    successor_pending_not_locked: countBy((r) => r.position_state === "successor_pending_not_locked"),
    open_or_uncovered: countBy((r) => r.position_state === "open" || r.position_state === "open_or_uncovered"),
    contested: countBy((r) => r.conflict_state === "conflicted"),
    locked_with_known_economics: countBy((r) => r.evidence_state === "contractually_supported"),
    locked_economics_unavailable: countBy((r) => r.evidence_state === "incomplete"),
    monthly_contractual_rent_known: Math.round(all.reduce((sum, r) =>
      sum + (r.evidence_state === "contractually_supported" && r.contractual_rent != null
        ? Number(r.contractual_rent) : 0), 0) * 100) / 100,
    locked_proof_split: {
      native_verified: countBy((r) => r.position_state === "contractually_locked" && r.proof_basis === "native_verified"),
      confirmed_opening_import: countBy((r) => r.position_state === "contractually_locked" && r.proof_basis === "confirmed_opening_import"),
    },
    denominator_known: countBy((r) => r.denominator_class !== "unknown"),
    denominator_unknown: countBy((r) => r.denominator_class === "unknown"),
    occupancy_conflict: countBy((r) => r.coverage.occupancy === "conflict"),
    occupancy_complete: countBy((r) => r.coverage.occupancy === "complete"),
    economics_complete: countBy((r) => r.evidence_state === "contractually_supported"),
    economics_qualified_legacy: countBy((r) => r.evidence_state === "qualified_legacy"),
    economics_incomplete: countBy((r) => r.evidence_state === "incomplete"),
    economics_conflict: countBy((r) => r.evidence_state === "conflicting"),
    existing_action: countBy((r) => r.resolution_state === "existing_action"),
    action_conflict: countBy((r) => r.resolution_state === "conflict"),
    no_canonical_action: countBy((r) => r.resolution_state === "no_canonical_action"),
  };

  const page = sorted.slice(start, start + lim.limit);
  const has_more = start + lim.limit < sorted.length;
  const last = page[page.length - 1];

  return {
    ...full,
    rows: page,
    complete_stats,
    page: {
      limit: lim.limit,
      returned: page.length,
      has_more,
      next_cursor: has_more && last
        ? cursorEncode({ property_id, as_of: full.summary.target_date,
                         unit_number: String(last.unit_number || ""), space_id: String(last.space_id) })
        : null,
      ordering: ORDERING,
      default_limit: PAGE_DEFAULT,
      max_limit: PAGE_MAX,
      ...(lim.clamped ? { limit_clamped_from: Number(limit) } : {}),
      consistency: "best_effort_live",
      ordering_fields: [
        { field: "units.unit_number", mutable: true },
        { field: "spaces.id", mutable: false },
      ],
      static_data_guarantee:
        "Under static data a full traversal returns every position exactly once, in one deterministic order, "
        + "with no duplicate and no omission.",
      concurrent_change_limitation:
        "No snapshot spans requests. unit_number is mutable, so a position renamed during a multi-request "
        + "traversal may be revisited or skipped. Positions inserted earlier in the order are not visited; "
        + "positions removed are skipped. This is not snapshot isolation and is not claimed as such.",
      cursor_signing: SECRET_SOURCE,
      ...(SECRET_SOURCE === "ephemeral_process_key"
        ? { cursor_signing_note: "CURSOR_SECRET is not configured, so cursors are signed with a per-process key: they do not survive a restart and do not span instances." }
        : {}),
    },
  };
}

module.exports = {
  forwardRentRollPage, cursorEncode, cursorDecode, resolveLimit,
  PAGE_DEFAULT, PAGE_MAX, ORDERING, CURSOR_VERSION, SECRET_SOURCE,
};
