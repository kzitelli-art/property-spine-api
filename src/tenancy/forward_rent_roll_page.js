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
//  CONSISTENCY, STATED HONESTLY. This is a BEST-EFFORT LIVE CURSOR. Each page
//  is a fresh read; there is no snapshot spanning requests, because a
//  PostgreSQL transaction cannot span HTTP requests and no projection-version
//  store exists to bind to. What is stable is the ORDERING KEY: rows are
//  ordered by (unit_number, spaces.id) and the cursor carries the last key
//  seen, so a row inserted earlier in the order during traversal is simply
//  not visited, and a row deleted mid-traversal is skipped. Neither
//  duplicates nor reorders what has already been returned. That guarantee is
//  disclosed in the response rather than dressed up as snapshot isolation.
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

//  A process secret is sufficient: a cursor is a position marker, not an
//  authorization. Property scope is still enforced from the session on every
//  request, so a forged cursor cannot reach another property's rows even if
//  the signature were defeated.
const SECRET = process.env.CURSOR_SECRET || crypto.createHash("sha256")
  .update("forward_rent_roll_cursor:" + (process.env.DATABASE_URL || "local")).digest("hex");

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

  const page = sorted.slice(start, start + lim.limit);
  const has_more = start + lim.limit < sorted.length;
  const last = page[page.length - 1];

  return {
    ...full,
    rows: page,
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
      consistency_note:
        "Each page is a fresh read. Ordering by (unit_number, space_id) is stable, so a page never "
        + "re-serves or reorders rows already returned; a record inserted earlier in the order during "
        + "traversal is not visited, and one removed mid-traversal is skipped. No snapshot spans requests.",
    },
  };
}

module.exports = {
  forwardRentRollPage, cursorEncode, cursorDecode, resolveLimit,
  PAGE_DEFAULT, PAGE_MAX, ORDERING, CURSOR_VERSION,
};
