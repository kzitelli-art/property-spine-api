// ============================================================
// roomowners.js — the room-owner API: a thin, domain-shaped layer over the
// assignments table (004), built for the operator home screen.
//
// WHY THIS EXISTS: the home screen is organized around six ROOMS, and the
// operator thinks "who owns Money for this property?" — NOT "create an
// assignment row with role scope and caps." The assignments table stays the
// backend truth; this module translates between the room language the screen
// speaks and the role language the schema stores. Same pattern as the rest of
// Spine: complicated truth underneath, a simple honest handle on top.
//
// THE ROOM ↔ ROLE MAP (1:1, no collision — see migration 041):
//   management → property_manager     money     → bookkeeper
//   leasing    → leasing              reporting → reporting
//   maintenance → maintenance         capital   → capital
//
// HARD RULES (from the product doctrine):
//   • Speaks person_id, NOT user_id. The assignments table references persons
//     (id, name) — there is no user_id. The API fields are owner_person_id,
//     backup_person_id, escalates_to_person_id, and *_name for display.
//   • NEVER defaults an owner. An unowned room returns status:"unassigned"
//     with null ids. The screen shows UNASSIGNED — the app telling the truth.
//   • Does not hide rooms. All six are always returned, owned or not.
//
// HOW OWNERSHIP IS STORED (mapping to the existing schema):
//   • OWNER of a room  = the active assignment for (property, mapped_role).
//     The partial-unique ux_assign_person_prop_role_active already enforces
//     one active assignment per person+property+role, so "the owner" is the
//     active row for that role on that property.
//   • ESCALATES_TO     = the owner assignment's escalates_to_assignment_id
//     (already in the schema), resolved to its person.
//   • BACKUP           = there is no native backup column. A backup is modeled
//     as a SECOND active assignment in the same role whose provenance is
//     tagged {"room_backup": true}. The owner is the active row WITHOUT that
//     tag (or the one tagged {"room_owner": true} if present). This keeps the
//     backup concept without a schema change; if backups become load-bearing
//     later, promote to a real column (a small migration).
//
// Caps/scope on the written assignment come from orgchart's ROLE_DEFAULTS for
// the mapped role — this module does not invent caps. It is about WHO owns a
// room, not about authority tuning (that stays in orgchart.js).
//
// Factory matches the standing pattern:
//   const roomOwnersModule = require('./roomowners');
//   app.use('/', roomOwnersModule({ pool }));
// ============================================================

const express = require("express");

// ── the canonical room list + room↔role map (single source of truth) ──
const ROOM_ORDER = ["management", "leasing", "maintenance", "money", "reporting", "capital"];
const ROOM_TO_ROLE = {
  management: "property_manager",
  leasing: "leasing",
  maintenance: "maintenance",
  money: "bookkeeper",
  reporting: "reporting",
  capital: "capital",
};
const ROLE_TO_ROOM = Object.fromEntries(Object.entries(ROOM_TO_ROLE).map(([room, role]) => [role, room]));

// role defaults mirror orgchart.js ROLE_DEFAULTS (caps/scope for a fresh
// assignment). New rooms use scope 'all'. Kept local so this module doesn't
// depend on orgchart's internals; values must stay in sync with orgchart.js.
const ROLE_DEFAULTS = {
  property_manager: { spend_cap: 500,  approval_cap: 2500,  scope: "all" },
  maintenance:      { spend_cap: 100,  approval_cap: 0,     scope: "maintenance" },
  leasing:          { spend_cap: 100,  approval_cap: 0,     scope: "leasing" },
  bookkeeper:       { spend_cap: 0,    approval_cap: 0,     scope: "accounting" },
  reporting:        { spend_cap: 0,    approval_cap: 0,     scope: "all" },
  capital:          { spend_cap: 0,    approval_cap: 0,     scope: "all" },
};

module.exports = function roomOwnersModule({ pool }) {
  const router = express.Router();

  // helper: resolve a person's display name
  async function personName(client, personId) {
    if (!personId) return null;
    const r = await client.query("select name from persons where id=$1", [personId]);
    return r.rows[0]?.name || null;
  }

  // helper: build the room-owner view for one property
  async function readRoomOwners(client, propertyId) {
    // pull all active assignments for this property in the mapped roles
    const rows = (await client.query(
      `select a.id, a.person_id, a.role, a.escalates_to_assignment_id, a.provenance,
              p.name as person_name
         from assignments a
         join persons p on p.id = a.person_id
        where a.property_id = $1 and a.is_active = true
          and a.role = any($2)`,
      [propertyId, Object.values(ROOM_TO_ROLE)]
    )).rows;

    // group by role → room; separate owner from backup by provenance tag
    const byRoom = {};
    for (const room of ROOM_ORDER) byRoom[room] = { owner: null, backup: null };

    for (const r of rows) {
      const room = ROLE_TO_ROOM[r.role];
      if (!room) continue;
      const isBackup = r.provenance && r.provenance.room_backup === true;
      if (isBackup) {
        byRoom[room].backup = r;
      } else {
        // first non-backup active row is the owner (unique index makes this safe)
        if (!byRoom[room].owner) byRoom[room].owner = r;
        else byRoom[room].backup = byRoom[room].backup || r; // defensive
      }
    }

    // resolve escalation person names (one extra lookup per owned room)
    const rooms = {};
    const missing = [];
    for (const room of ROOM_ORDER) {
      const { owner, backup } = byRoom[room];
      let escalatesToPersonId = null, escalatesToName = null;
      if (owner?.escalates_to_assignment_id) {
        const esc = (await client.query(
          `select a.person_id, p.name from assignments a
             join persons p on p.id = a.person_id where a.id=$1`,
          [owner.escalates_to_assignment_id]
        )).rows[0];
        if (esc) { escalatesToPersonId = esc.person_id; escalatesToName = esc.name; }
      }
      const assigned = Boolean(owner);
      if (!assigned) missing.push(room);
      rooms[room] = {
        owner_person_id: owner?.person_id || null,
        owner_name: owner?.person_name || null,
        backup_person_id: backup?.person_id || null,
        backup_name: backup?.person_name || null,
        escalates_to_person_id: escalatesToPersonId,
        escalates_to_name: escalatesToName,
        role: ROOM_TO_ROLE[room],
        status: assigned ? "assigned" : "unassigned",
      };
    }

    return {
      property_id: propertyId,
      rooms,
      all_assigned: missing.length === 0,
      missing,
    };
  }

  // ──────────────────────────────────────────────────────────────────
  // GET /properties/:property_id/room-owners
  // The home-screen read. Always returns all six rooms; unowned ones come
  // back status:"unassigned" with null ids (never defaulted, never hidden).
  // ──────────────────────────────────────────────────────────────────
  router.get("/properties/:property_id/room-owners", async (req, res) => {
    const propertyId = req.params.property_id;
    try {
      const prop = await pool.query("select id from properties where id=$1", [propertyId]);
      if (!prop.rows.length) return res.status(404).json({ error: "property not found" });
      const view = await readRoomOwners(pool, propertyId);
      return res.json(view);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // PUT /properties/:property_id/room-owners/:room
  // Assign (or reassign) the owner of one room. Writes/updates the active
  // assignment for the mapped role. Optional backup + escalation.
  // Body: {
  //   owner_person_id: "<uuid>",            (required)
  //   backup_person_id: "<uuid>",           (optional)
  //   escalates_to_person_id: "<uuid>"      (optional — resolved to that
  //                                          person's assignment in any role
  //                                          on this property)
  // }
  // ──────────────────────────────────────────────────────────────────
  router.put("/properties/:property_id/room-owners/:room", async (req, res) => {
    const propertyId = req.params.property_id;
    const room = String(req.params.room || "").toLowerCase();
    const { owner_person_id, backup_person_id, escalates_to_person_id } = req.body || {};

    const role = ROOM_TO_ROLE[room];
    if (!role) return res.status(400).json({ error: `unknown room '${room}'. Valid: ${ROOM_ORDER.join(", ")}` });
    if (!owner_person_id) return res.status(400).json({ error: "owner_person_id required" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // validate property + people exist
      const prop = await client.query("select id from properties where id=$1", [propertyId]);
      if (!prop.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "property not found" }); }
      const owner = await client.query("select id, name from persons where id=$1", [owner_person_id]);
      if (!owner.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "owner person not found" }); }

      const defaults = ROLE_DEFAULTS[role];

      // resolve escalation: the target person's active assignment on this
      // property (any role). If they have none yet, escalation is left null
      // rather than invented.
      let escalatesToAssignmentId = null;
      if (escalates_to_person_id) {
        const esc = await client.query(
          `select id from assignments
            where property_id=$1 and person_id=$2 and is_active=true
            order by created_at limit 1`,
          [propertyId, escalates_to_person_id]
        );
        escalatesToAssignmentId = esc.rows[0]?.id || null;
      }

      // ── deactivate any existing active OWNER rows for this role (the prior
      //    owner steps down) — but leave backup rows alone for now.
      await client.query(
        `update assignments set is_active=false
          where property_id=$1 and role=$2 and is_active=true
            and coalesce((provenance->>'room_backup')::boolean, false) = false`,
        [propertyId, role]
      );

      // ── insert the new owner assignment
      const ownerRow = (await client.query(
        `insert into assignments
           (person_id, property_id, role, spend_cap, approval_cap, scope,
            escalates_to_assignment_id, is_active, provenance)
         values ($1,$2,$3,$4,$5,$6,$7,true,$8)
         returning id, person_id`,
        [owner_person_id, propertyId, role, defaults.spend_cap, defaults.approval_cap,
         defaults.scope, escalatesToAssignmentId,
         JSON.stringify({ room_owner: true, source: "room-owners-api" })]
      )).rows[0];

      // ── handle backup: deactivate prior backups, insert new if provided
      if (backup_person_id) {
        const bk = await client.query("select id from persons where id=$1", [backup_person_id]);
        if (!bk.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "backup person not found" }); }
        await client.query(
          `update assignments set is_active=false
            where property_id=$1 and role=$2 and is_active=true
              and coalesce((provenance->>'room_backup')::boolean, false) = true`,
          [propertyId, role]
        );
        await client.query(
          `insert into assignments
             (person_id, property_id, role, spend_cap, approval_cap, scope, is_active, provenance)
           values ($1,$2,$3,$4,$5,$6,true,$7)
           on conflict do nothing`,
          [backup_person_id, propertyId, role, defaults.spend_cap, defaults.approval_cap,
           defaults.scope, JSON.stringify({ room_backup: true, source: "room-owners-api" })]
        );
      }

      await client.query("COMMIT");

      // return the fresh view of this room
      const view = await readRoomOwners(pool, propertyId);
      return res.json({
        receipt: `${room} now owned by ${owner.rows[0].name}.`,
        room,
        owner_assignment_id: ownerRow.id,
        room_owners: view.rooms[room],
        all_assigned: view.all_assigned,
        missing: view.missing,
      });
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      // surface the role CHECK violation cleanly if migration 041 isn't applied
      if (String(e.message).includes("ck_assign_role")) {
        return res.status(409).json({
          error: "role not accepted by the database. Migration 041 (widen roles) may not be applied yet.",
          detail: e.message,
        });
      }
      return res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  return router;
};
