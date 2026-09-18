"use strict";

// Authority grants now require authority that predates the grant being tested.
// This fixture establishes that reviewer directly; the recipient still travels
// through resolveAuthority, which is the production path under test.
async function establishAuthorizedReviewer(pool, {
  userId,
  propertyId,
  label = "Authority reviewer fixture",
} = {}) {
  const user = (await pool.query(
    `select id, person_id, account_kind, is_active
       from users where id=$1`, [userId])).rows[0] || null;
  if (!user || !user.is_active || user.account_kind !== "human_staff") {
    throw new Error("authority reviewer fixture requires an active human_staff login");
  }

  let personId = user.person_id;
  let createdPerson = false;
  if (!personId) {
    personId = (await pool.query(
      `insert into persons (name, source)
       values ($1, 'authority_reviewer_fixture') returning id`, [label])).rows[0].id;
    await pool.query("update users set person_id=$1 where id=$2", [personId, userId]);
    createdPerson = true;
  }

  const context = (await pool.query(
    `select id from person_contexts
      where person_id=$1 and context_type='staff' and active_to is null
        and (property_id is null or property_id=$2)
      limit 1`, [personId, propertyId])).rows[0];
  if (!context) {
    await pool.query(
      `insert into person_contexts
         (person_id, context_type, property_id, created_by_user_id)
       values ($1, 'staff', $2, $3)`, [personId, propertyId, userId]);
  }

  const assignment = (await pool.query(
    `select id from assignments
      where person_id=$1 and property_id=$2 and role in ('owner','asset_manager')
        and is_active=true
      limit 1`, [personId, propertyId])).rows[0];
  if (!assignment) {
    await pool.query(
      `insert into assignments (person_id, property_id, role, is_active, provenance)
       values ($1, $2, 'asset_manager', true, $3)`,
      [personId, propertyId, JSON.stringify({ source: "authority_reviewer_fixture" })]);
  }

  return { personId, createdPerson };
}

module.exports = { establishAuthorizedReviewer };
