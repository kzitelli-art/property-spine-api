// ════════════════════════════════════════════════════════════════════
//  timezone_command.js — the governed "set property operating timezone"
//  command (Slice 9, ruling 1B).
//
//  Migration 123 created the truth. Without an authoring path, every property
//  except the backfilled Demo Building would be permanently unavailable for
//  every dated metric — a column nobody can fill is not configuration, it is
//  a dead end.
//
//  ── AUTHORITY ────────────────────────────────────────────────────────
//  No property-settings capability exists in the capability vocabulary
//  (may_prepare_pricing, may_review_pricing, may_publish_pricing,
//  may_manage_concession_authority, may_read_property). Rather than invent
//  one — and certainly rather than invent browser authority — this command
//  reuses the EXISTING platform administration gate: a staff session whose
//  users.platform_role is re-read from the row and equals 'super_admin'
//  (src/identity/super_admin.js). When a property-settings capability later
//  exists, this moves to it; that is the removal condition.
//
//  ── WHY POSTGRES VALIDITY IS NOT ENOUGH ──────────────────────────────
//  Migration 123's trigger proves pg_timezone_names accepts the name. It does
//  NOT prove Node's Intl.DateTimeFormat can render with the same identifier —
//  the two ship independent tz databases, and Postgres additionally accepts
//  POSIX-style names ('EST5EDT', 'posix/...') that Intl rejects. Storing one
//  of those would satisfy the database and then throw at render time, inside
//  the quiet-hours check, in production. So the command proves BOTH before
//  it writes.
//
//  ── AUDIT ────────────────────────────────────────────────────────────
//  Every change records before, after, the acting person, the authenticated
//  user, when, and why, into property_operating_timezone_changes. Idempotent
//  by (property_id, idempotency_key): a retried command returns the original
//  receipt rather than writing a second history row.
// ════════════════════════════════════════════════════════════════════
"use strict";

function httpErr(status, message, code) {
  const e = new Error(message);
  e.httpStatus = status; e.publicMessage = message; e.code = code || null;
  return e;
}

// Does the Node runtime actually accept this identifier?
function nodeIntlAccepts(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric" }).format(new Date());
    return true;
  } catch (_) { return false; }
}

// Does Postgres accept it? Asked of the database, not assumed.
async function postgresAccepts(pool, tz) {
  const r = await pool.query("select exists(select 1 from pg_timezone_names where name=$1) as ok", [tz]);
  return !!(r.rows[0] && r.rows[0].ok);
}

/**
 * setPropertyOperatingTimezone
 *   pool
 *   { property_id, timezone, actor_user_id, reason, idempotency_key }
 *
 * property_id and actor_user_id come from the authenticated session at the
 * route; this service never accepts them from a body it has not been handed.
 */
async function setPropertyOperatingTimezone(pool, {
  property_id, timezone, actor_user_id, reason = null, idempotency_key = null,
} = {}) {
  if (!pool || typeof pool.query !== "function") throw new TypeError("pool is required");
  if (!property_id) throw httpErr(400, "property_id is required.", "property_id_required");
  if (!actor_user_id) throw httpErr(400, "An authenticated actor is required.", "actor_required");

  const tz = timezone == null ? null : String(timezone).trim();
  if (!tz) throw httpErr(400, "A timezone is required. Clearing an operating timezone is not supported — a property with no operating day cannot be reported on.", "timezone_required");

  // BOTH runtimes, before any write.
  if (!(await postgresAccepts(pool, tz))) {
    throw httpErr(400, `"${tz}" is not a timezone this database recognises.`, "timezone_not_valid_in_postgres");
  }
  if (!nodeIntlAccepts(tz)) {
    throw httpErr(400, `"${tz}" is accepted by the database but cannot be used to render local times in this runtime. Use a full IANA region name such as America/New_York.`, "timezone_not_valid_in_node_runtime");
  }

  const client = await pool.connect();
  try {
    await client.query("begin");

    if (idempotency_key) {
      const prior = (await client.query(
        `select id, before_timezone, after_timezone, changed_at
           from property_operating_timezone_changes
          where property_id=$1 and idempotency_key=$2`,
        [property_id, idempotency_key])).rows[0];
      if (prior) {
        await client.query("rollback");
        return {
          changed: false, idempotent_replay: true,
          property_id, before: prior.before_timezone, after: prior.after_timezone,
          changed_at: prior.changed_at, change_id: prior.id,
        };
      }
    }

    const prop = (await client.query(
      "select id, operating_timezone from properties where id=$1 for update", [property_id])).rows[0];
    if (!prop) { await client.query("rollback"); throw httpErr(404, "No such property.", "property_not_found"); }

    const before = prop.operating_timezone || null;
    if (before === tz) {
      await client.query("rollback");
      return { changed: false, unchanged: true, property_id, before, after: tz };
    }

    // The acting PERSON is the business actor; the user id is authentication
    // provenance. Same distinction Slice 8 ruling 4 settled for pricing.
    const person = (await client.query(
      `select p.id from persons p
        join users u on u.person_id = p.id
       where u.id = $1`, [actor_user_id])).rows[0] || null;

    await client.query(
      "update properties set operating_timezone=$2 where id=$1", [property_id, tz]);

    const change = (await client.query(
      `insert into property_operating_timezone_changes
         (property_id, before_timezone, after_timezone, actor_person_id,
          actor_user_id, reason, idempotency_key)
       values ($1,$2,$3,$4,$5,$6,$7)
       returning id, changed_at`,
      [property_id, before, tz, person ? person.id : null, actor_user_id, reason, idempotency_key]
    )).rows[0];

    await client.query("commit");
    return {
      changed: true, property_id, before, after: tz,
      change_id: change.id, changed_at: change.changed_at,
      actor_person_id: person ? person.id : null,
      actor_user_id, reason: reason || null,
      validated_in: ["postgres", "node_intl"],
    };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally { client.release(); }
}

async function operatingTimezoneHistory(pool, { property_id } = {}) {
  if (!property_id) throw httpErr(400, "property_id is required.", "property_id_required");
  const rows = (await pool.query(
    `select c.id, c.before_timezone, c.after_timezone, c.reason, c.changed_at,
            c.actor_person_id, c.actor_user_id, p.name as actor_name
       from property_operating_timezone_changes c
       left join persons p on p.id = c.actor_person_id
      where c.property_id = $1
      order by c.changed_at desc`, [property_id])).rows;
  return {
    property_id,
    changes: rows.map((r) => ({
      change_id: r.id, before: r.before_timezone, after: r.after_timezone,
      reason: r.reason || null, changed_at: r.changed_at,
      actor: { person_id: r.actor_person_id, name: r.actor_name || null, user_id: r.actor_user_id },
    })),
  };
}

module.exports = {
  setPropertyOperatingTimezone,
  operatingTimezoneHistory,
  nodeIntlAccepts,
  postgresAccepts,
};
