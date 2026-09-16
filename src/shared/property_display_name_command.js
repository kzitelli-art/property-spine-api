// ════════════════════════════════════════════════════════════════════
// Governed property display-name command.
//
// `properties.name` remains the internal identity used by legacy routes.
// This changes only the human-facing `display_name`, records its previous
// value, and re-reads the actor's platform authority inside the transaction.
// ════════════════════════════════════════════════════════════════════
"use strict";

function commandError(status, message, code) {
  const e = new Error(message);
  e.httpStatus = status;
  e.publicMessage = message;
  e.code = code;
  return e;
}

function cleanDisplayName(value) {
  const name = value == null ? "" : String(value).trim();
  if (!name) {
    throw commandError(400,
      "Enter the name staff should see for this property. The display name cannot be blank.",
      "display_name_required");
  }
  if (name.length > 160) {
    throw commandError(400, "Use a display name of 160 characters or fewer.", "display_name_too_long");
  }
  return name;
}

async function setPropertyDisplayName(pool, {
  property_id, display_name, actor_user_id, reason = null, idempotency_key = null,
} = {}) {
  if (!pool || typeof pool.connect !== "function") throw new TypeError("pool is required");
  if (!property_id) throw commandError(400, "Choose a property before changing its display name.", "property_id_required");
  if (!actor_user_id) throw commandError(401, "Sign in again before changing a property name.", "actor_required");
  const after = cleanDisplayName(display_name);
  const key = idempotency_key == null ? null : String(idempotency_key).trim() || null;

  const client = await pool.connect();
  try {
    await client.query("begin");

    // Current database state is the authority. The share lock makes a
    // concurrent demotion wait until this decision commits or rolls back.
    const actor = (await client.query(
      `select u.id, u.person_id, u.platform_role, u.is_active, u.status
         from users u where u.id=$1 for share`, [actor_user_id])).rows[0];
    if (!actor || actor.platform_role !== "super_admin"
        || actor.is_active !== true || actor.status !== "active") {
      await client.query("rollback");
      throw commandError(403,
        "Super admin access is required to change the name shown for a property.",
        "super_admin_required");
    }

    const property = (await client.query(
      `select id, name, display_name, canonical_key
         from properties where id=$1 for update`, [property_id])).rows[0];
    if (!property) {
      await client.query("rollback");
      throw commandError(404, "That property no longer exists. Refresh the property list.", "property_not_found");
    }

    // The property lock serializes commands for one property. Re-read the
    // command receipt only after that lock so concurrent duplicate requests
    // replay the first result instead of slipping through as merely unchanged.
    if (key) {
      const prior = (await client.query(
        `select id, before_display_name, after_display_name, changed_at,
                actor_person_id, actor_user_id, reason
           from property_display_name_changes
          where property_id=$1 and idempotency_key=$2`, [property_id, key])).rows[0];
      if (prior) {
        if (prior.after_display_name !== after) {
          await client.query("rollback");
          throw commandError(409,
            "That request key was already used for a different display name. Refresh and try again.",
            "idempotency_conflict");
        }
        await client.query("rollback");
        return {
          changed: false, idempotent_replay: true, property_id,
          before: prior.before_display_name, after: prior.after_display_name,
          change_id: prior.id, changed_at: prior.changed_at,
          actor_person_id: prior.actor_person_id, actor_user_id: prior.actor_user_id,
          reason: prior.reason || null,
        };
      }
    }

    const before = property.display_name || null;
    if (before === after) {
      await client.query("rollback");
      return {
        changed: false, unchanged: true, property_id,
        internal_name: property.name, canonical_key: property.canonical_key || null,
        before, after,
      };
    }

    await client.query("update properties set display_name=$2, updated_at=now() where id=$1", [property_id, after]);
    const change = (await client.query(
      `insert into property_display_name_changes
         (property_id, before_display_name, after_display_name, actor_person_id,
          actor_user_id, authority_basis, reason, idempotency_key)
       values ($1,$2,$3,$4,$5,'platform_role:super_admin',$6,$7)
       returning id, changed_at`,
      [property_id, before, after, actor.person_id || null, actor_user_id, reason, key])).rows[0];

    await client.query("commit");
    return {
      changed: true, property_id, internal_name: property.name,
      canonical_key: property.canonical_key || null, before, after,
      change_id: change.id, changed_at: change.changed_at,
      actor_person_id: actor.person_id || null, actor_user_id,
      authority_basis: "platform_role:super_admin", reason: reason || null,
    };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function propertyDisplayNameHistory(pool, { property_id } = {}) {
  if (!property_id) throw commandError(400, "Choose a property first.", "property_id_required");
  const changes = (await pool.query(
    `select c.id, c.before_display_name, c.after_display_name,
            c.actor_person_id, c.actor_user_id, c.authority_basis,
            c.reason, c.changed_at, p.name as actor_name
       from property_display_name_changes c
       left join persons p on p.id=c.actor_person_id
      where c.property_id=$1
      order by c.changed_at desc, c.id desc`, [property_id])).rows;
  return {
    property_id,
    changes: changes.map((c) => ({
      change_id: c.id, before: c.before_display_name, after: c.after_display_name,
      authority_basis: c.authority_basis, reason: c.reason || null,
      changed_at: c.changed_at,
      actor: { person_id: c.actor_person_id || null, name: c.actor_name || null, user_id: c.actor_user_id },
    })),
  };
}

module.exports = { setPropertyDisplayName, propertyDisplayNameHistory, cleanDisplayName };
