"use strict";

// PROPERTY SPINE MOVE-IN QUEUE v1
//
// Class 1 read projection over the existing canonical move-in state composer.
// It creates no new move-in meaning and exposes no second command path.
// The queue answers only: which lease needs attention, why, who owns the
// remaining delivery work, and what server-authored next action already exists.

const economicTenancy = require("./economic_tenancy_service");

const DEFAULT_WINDOW_DAYS = 60;
const DEFAULT_LIMIT = 100;
const MAX_WINDOW_DAYS = 365;
const MAX_LIMIT = 200;

function boundedInt(value, fallback, min, max) {
  const n = Number.parseInt(String(value == null ? "" : value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

const PRIORITY = Object.freeze({
  active_money_exception: 10,
  delivery_obligation_missing: 15,
  ready_for_handoff: 20,
  keys_not_ready: 30,
  unit_not_ready: 40,
  ready_to_activate: 50,
  funds_outstanding: 60,
  funds_setup_required: 70,
  forward_lease: 80,
  possession_delivered: 90,
});

function priorityFor(state) {
  return Object.prototype.hasOwnProperty.call(PRIORITY, state) ? PRIORITY[state] : 999;
}

function queueClass(state) {
  if (state === "possession_delivered") return "completed";
  if (state === "forward_lease") return "forward";
  if (["ready_for_handoff", "keys_not_ready", "ready_to_activate", "funds_setup_required"].includes(state)) return "actionable";
  return "blocked";
}

function safeTime(value) {
  const t = Date.parse(value || "");
  return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
}

function compareItems(a, b) {
  return priorityFor(a.state) - priorityFor(b.state)
    || safeTime(a.lease && a.lease.start_date) - safeTime(b.lease && b.lease.start_date)
    || String((a.lease && a.lease.unit_number) || "").localeCompare(String((b.lease && b.lease.unit_number) || ""))
    || String((a.lease && a.lease.id) || "").localeCompare(String((b.lease && b.lease.id) || ""));
}

function summarize(items) {
  const out = { needs_attention: 0, actionable: 0, blocked: 0, forward: 0, completed: 0 };
  for (const item of items) {
    const cls = item.queue_class;
    if (Object.prototype.hasOwnProperty.call(out, cls)) out[cls] += 1;
    if (cls !== "completed" && cls !== "forward") out.needs_attention += 1;
  }
  return out;
}

async function readMoveInQueue(client, {
  propertyId,
  windowDays = DEFAULT_WINDOW_DAYS,
  limit = DEFAULT_LIMIT,
  includeCompleted = false,
  composeMoveInState = economicTenancy.composeMoveInState,
} = {}) {
  if (!client || typeof client.query !== "function") throw new Error("move-in queue requires a database client");
  if (!propertyId) throw new Error("move-in queue requires the authenticated property scope");
  if (typeof composeMoveInState !== "function") throw new Error("move-in queue requires the canonical move-in state composer");

  const days = boundedInt(windowDays, DEFAULT_WINDOW_DAYS, 0, MAX_WINDOW_DAYS);
  const rowLimit = boundedInt(limit, DEFAULT_LIMIT, 1, MAX_LIMIT);

  // Candidate discovery is deliberately narrow. It includes:
  //   • pending leases entering the operating window;
  //   • leases carrying an open delivery obligation; and
  //   • recently activated economic tenancies still inside closeout.
  // Historical active leases with no 089 activation fact do not flood the queue.
  const candidateResult = await client.query(
    `select l.id as lease_id,
            er.application_id
       from leases l
       left join lateral (
         select x.application_id
           from executed_lease_records x
          where x.lease_id=l.id and x.record_state='verified'
          order by x.verified_at desc nulls last, x.created_at desc
          limit 1
       ) er on true
      where l.property_id=$1
        and l.lease_status in ('pending','active')
        and l.end_date >= current_date - interval '1 day'
        and (
          (l.lease_status='pending' and l.start_date <= current_date + ($2::int * interval '1 day'))
          or exists (
            select 1 from obligations o
             where o.related_id=l.id and o.related_type='lease'
               and o.type='move_in_delivery' and o.status in ('open','in_progress')
          )
          or (l.lease_status='active' and l.economic_tenancy_activated_at is not null
              and l.economic_tenancy_activated_at >= now() - interval '90 days')
        )
      order by l.start_date asc, l.id asc
      limit $3`,
    [propertyId, days, rowLimit]
  );

  const items = [];
  for (const candidate of candidateResult.rows || []) {
    const state = await composeMoveInState(client, candidate.lease_id);
    if (!state || !state.lease || String(state.lease.property_id) !== String(propertyId)) {
      throw new Error("canonical move-in composer returned an out-of-scope or malformed lease");
    }
    if (!includeCompleted && state.state === "possession_delivered") continue;
    items.push({
      ...state,
      application_id: candidate.application_id || null,
      queue_class: queueClass(state.state),
      priority: priorityFor(state.state),
    });
  }

  items.sort(compareItems);
  const summary = summarize(items);
  return {
    property_id: propertyId,
    generated_at: new Date().toISOString(),
    window_days: days,
    include_completed: includeCompleted === true,
    candidate_limit: rowLimit,
    count: items.length,
    summary,
    items,
  };
}

module.exports = {
  readMoveInQueue,
  _internal: {
    boundedInt,
    priorityFor,
    queueClass,
    compareItems,
    summarize,
    DEFAULT_WINDOW_DAYS,
    DEFAULT_LIMIT,
    MAX_WINDOW_DAYS,
    MAX_LIMIT,
  },
};
