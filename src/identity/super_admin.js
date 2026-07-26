// super_admin.js — Platform-level super admin surface.
//
// ROUTES (all require valid staff session + platform_role = 'super_admin'):
//
//   GET  /admin/organizations              list all orgs (id, name, slug, plan, status, counts)
//   POST /admin/organizations              create a new org
//   GET  /admin/organizations/:id          org detail + properties + users
//   PATCH /admin/organizations/:id         update org metadata (name, plan, status, notes)
//   POST /admin/organizations/:id/properties  assign an existing property to an org
//   POST /admin/organizations/:orgId/invite   create/invite the first admin user for an org
//
//   GET  /admin/users                      list all users platform-wide
//   PATCH /admin/users/:id                 update platform_role or organization_id
//
//   GET  /admin/platform                   high-level platform stats
//
// AUTH: The requireSuperAdmin middleware resolves the x-staff-session header,
// then checks users.platform_role = 'super_admin'. Any other session → 403.
// Super admin sessions are property-scoped like all staff sessions (the session
// resolver requires a property assignment), so super admins still need a property
// assignment for their session token — they get one from migration 090.

"use strict";

const express = require("express");
const staffSessions = require("./staff_session_service.js");

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

module.exports = function superAdminModule({ pool }) {
  if (!pool) throw new Error("super_admin.js requires { pool }");
  const router = express.Router();

  // ── Auth middleware ──────────────────────────────────────────────────────
  async function requireSuperAdmin(req, res, next) {
    const token = req.get("x-staff-session");
    if (!token) return res.status(401).json({ error: "Staff session required." });
    const session = await staffSessions.resolveStaffSession(pool, token);
    if (!session) return res.status(401).json({ error: "Invalid or expired session." });

    // Re-read platform_role from the users row (not cached in session)
    const u = (await pool.query(
      `select platform_role, organization_id from users where id = $1`,
      [session.id]
    )).rows[0];
    if (!u || u.platform_role !== "super_admin") {
      return res.status(403).json({ error: "Super admin access required." });
    }
    req.operator = session;
    req.operator.platform_role = "super_admin";
    next();
  }

  // ── GET /admin/platform — high-level stats ───────────────────────────────
  router.get("/admin/platform", requireSuperAdmin, async (req, res) => {
    try {
      const [orgs, props, users] = await Promise.all([
        pool.query(`select count(*) from organizations`),
        pool.query(`select count(*) from properties`),
        pool.query(`select count(*) from users where status = 'active'`),
      ]);
      res.json({
        organizations: Number(orgs.rows[0].count),
        properties: Number(props.rows[0].count),
        active_users: Number(users.rows[0].count),
      });
    } catch (e) {
      console.error("admin/platform error", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /admin/organizations ─────────────────────────────────────────────
  router.get("/admin/organizations", requireSuperAdmin, async (req, res) => {
    try {
      const rows = (await pool.query(
        `select o.id, o.name, o.slug, o.plan, o.status, o.owner_email, o.owner_name,
                o.created_at,
                count(distinct p.id) as property_count,
                count(distinct u.id) as user_count
           from organizations o
           left join properties p on p.organization_id = o.id
           left join users u on u.organization_id = o.id and u.status = 'active'
          group by o.id
          order by o.created_at desc`
      )).rows;
      res.json(rows.map(r => ({
        ...r,
        property_count: Number(r.property_count),
        user_count: Number(r.user_count),
      })));
    } catch (e) {
      console.error("admin/organizations list error", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /admin/organizations ────────────────────────────────────────────
  router.post("/admin/organizations", requireSuperAdmin, async (req, res) => {
    try {
      const { name, plan = "starter", owner_email, owner_name, phone, address, city, state, notes } = req.body || {};
      if (!name || !String(name).trim()) return res.status(400).json({ error: "name is required." });

      const slug = slugify(name);
      // Ensure slug uniqueness by appending a short suffix if needed
      const existing = (await pool.query(`select id from organizations where slug = $1`, [slug])).rows[0];
      const finalSlug = existing ? `${slug}-${Date.now().toString(36)}` : slug;

      const org = (await pool.query(
        `insert into organizations (name, slug, plan, owner_email, owner_name, phone, address, city, state, notes)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         returning *`,
        [name.trim(), finalSlug, plan, owner_email || null, owner_name || null,
         phone || null, address || null, city || null, state || null, notes || null]
      )).rows[0];

      res.status(201).json(org);
    } catch (e) {
      console.error("admin/organizations create error", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /admin/organizations/:id ─────────────────────────────────────────
  router.get("/admin/organizations/:id", requireSuperAdmin, async (req, res) => {
    try {
      const org = (await pool.query(`select * from organizations where id = $1`, [req.params.id])).rows[0];
      if (!org) return res.status(404).json({ error: "Organization not found." });

      const [properties, users] = await Promise.all([
        pool.query(
          `select id, coalesce(display_name, name) as name, address, city, state,
                  sms_number, created_at
             from properties where organization_id = $1 order by name`,
          [org.id]
        ),
        pool.query(
          `select u.id, u.name, u.email, u.phone, u.platform_role, u.status,
                  u.role, u.created_at
             from users u
            where u.organization_id = $1
            order by u.created_at`,
          [org.id]
        ),
      ]);

      res.json({ ...org, properties: properties.rows, users: users.rows });
    } catch (e) {
      console.error("admin/organizations get error", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── PATCH /admin/organizations/:id ───────────────────────────────────────
  router.patch("/admin/organizations/:id", requireSuperAdmin, async (req, res) => {
    try {
      const { name, plan, status, owner_email, owner_name, phone, address, city, state, notes } = req.body || {};
      const org = (await pool.query(`select id from organizations where id = $1`, [req.params.id])).rows[0];
      if (!org) return res.status(404).json({ error: "Organization not found." });

      const updated = (await pool.query(
        `update organizations
            set name        = coalesce($1, name),
                plan        = coalesce($2, plan),
                status      = coalesce($3, status),
                owner_email = coalesce($4, owner_email),
                owner_name  = coalesce($5, owner_name),
                phone       = coalesce($6, phone),
                address     = coalesce($7, address),
                city        = coalesce($8, city),
                state       = coalesce($9, state),
                notes       = coalesce($10, notes),
                updated_at  = now()
          where id = $11
          returning *`,
        [name || null, plan || null, status || null, owner_email || null, owner_name || null,
         phone || null, address || null, city || null, state || null, notes || null,
         req.params.id]
      )).rows[0];

      res.json(updated);
    } catch (e) {
      console.error("admin/organizations patch error", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /admin/organizations/:id/properties ─────────────────────────────
  // Assigns an existing unassigned property to this org.
  router.post("/admin/organizations/:id/properties", requireSuperAdmin, async (req, res) => {
    try {
      const { property_id } = req.body || {};
      if (!property_id) return res.status(400).json({ error: "property_id is required." });

      const org = (await pool.query(`select id from organizations where id = $1`, [req.params.id])).rows[0];
      if (!org) return res.status(404).json({ error: "Organization not found." });

      const prop = (await pool.query(`select id, name from properties where id = $1`, [property_id])).rows[0];
      if (!prop) return res.status(404).json({ error: "Property not found." });

      await pool.query(
        `update properties set organization_id = $1, updated_at = now() where id = $2`,
        [org.id, property_id]
      );
      res.json({ ok: true, property_id, organization_id: org.id });
    } catch (e) {
      console.error("admin/org assign property error", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /admin/roles ─────────────────────────────────────────────────────
  router.get("/admin/roles", requireSuperAdmin, async (req, res) => {
    try {
      const rows = (await pool.query(
        `select key, label, allowed_modules, primary_modules, can_manage_roles, description
           from staff_roles order by sort_order`
      )).rows;
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /admin/organizations/:orgId/invite ──────────────────────────────
  // Body: { name, phone, email, property_id, role_key, platform_role }
  // role_key: one of the staff_roles keys (defaults to 'property_admin')
  // platform_role: 'org_admin' | 'member' (defaults to 'member')
  router.post("/admin/organizations/:orgId/invite", requireSuperAdmin, async (req, res) => {
    try {
      const { name, phone, email, property_id, role_key = "property_admin", platform_role = "member" } = req.body || {};
      if (!name || !phone) return res.status(400).json({ error: "name and phone are required." });
      if (!property_id) return res.status(400).json({ error: "property_id is required — the user logs into a specific property." });

      const allowed_platform_roles = ["org_admin", "member"];
      if (!allowed_platform_roles.includes(platform_role)) {
        return res.status(400).json({ error: `platform_role must be one of: ${allowed_platform_roles.join(", ")}` });
      }

      const org = (await pool.query(`select id, name from organizations where id = $1`, [req.params.orgId])).rows[0];
      if (!org) return res.status(404).json({ error: "Organization not found." });

      const prop = (await pool.query(
        `select id from properties where id = $1 and organization_id = $2`,
        [property_id, org.id]
      )).rows[0];
      if (!prop) return res.status(400).json({ error: "Property does not belong to this organization." });

      // Resolve role preset
      const roleRow = (await pool.query(`select * from staff_roles where key = $1`, [role_key])).rows[0];
      const preset = roleRow || {
        label: "Property Admin", key: "property_admin",
        allowed_modules: ["management","leasing","maintenance","reporting"],
        primary_modules: ["management"], can_manage_roles: true,
      };

      const normalizedPhone = phone.replace(/\D/g, "").replace(/^1/, "");
      const e164 = "+1" + normalizedPhone;

      // Upsert the user
      let user;
      if (email && email.trim()) {
        user = (await pool.query(
          `insert into users (name, email, phone, role, auth_provider, platform_role, organization_id, is_active, status)
           values ($1, $2, $3, 'property_manager', 'phone_otp', $4, $5, true, 'active')
           on conflict (email) do update
             set name = excluded.name, phone = excluded.phone,
                 platform_role = excluded.platform_role,
                 organization_id = excluded.organization_id,
                 is_active = true, status = 'active', updated_at = now()
           returning id, name, email, phone`,
          [name.trim(), email.trim(), e164, platform_role, org.id]
        )).rows[0];
      } else {
        user = (await pool.query(
          `insert into users (name, phone, role, auth_provider, platform_role, organization_id, is_active, status)
           values ($1, $2, 'property_manager', 'phone_otp', $3, $4, true, 'active')
           on conflict (phone) do update
             set name = excluded.name, platform_role = excluded.platform_role,
                 organization_id = excluded.organization_id,
                 is_active = true, status = 'active', updated_at = now()
           returning id, name, email, phone`,
          [name.trim(), e164, platform_role, org.id]
        )).rows[0];
      }

      // Upsert property_team_assignments with canonical role preset
      await pool.query(
        `insert into property_team_assignments
           (property_id, user_id, role_title, role_key, scope_type, allowed_modules,
            primary_for_modules, can_manage_roles, active)
         values ($1, $2, $3, $4, 'property', $5, $6, $7, true)
         on conflict (property_id, user_id) do update
           set role_title        = excluded.role_title,
               role_key          = excluded.role_key,
               allowed_modules   = excluded.allowed_modules,
               primary_for_modules = excluded.primary_for_modules,
               can_manage_roles  = excluded.can_manage_roles,
               active            = true,
               updated_at        = now()`,
        [property_id, user.id, preset.label, preset.key,
         preset.allowed_modules, preset.primary_modules, preset.can_manage_roles]
      );

      res.status(201).json({
        ok: true,
        user: { id: user.id, name: user.name, email: user.email, phone: user.phone },
        organization_id: org.id,
        property_id,
        role_key: preset.key,
        platform_role,
        note: "User provisioned. They can now log in via phone OTP at the operator app.",
      });
    } catch (e) {
      console.error("admin/org invite error", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /admin/users ─────────────────────────────────────────────────────
  router.get("/admin/users", requireSuperAdmin, async (req, res) => {
    try {
      const rows = (await pool.query(
        `select u.id, u.name, u.email, u.phone, u.role, u.platform_role,
                u.status, u.is_active, u.organization_id, u.created_at,
                o.name as organization_name,
                count(distinct a.property_id) as property_count
           from users u
           left join organizations o on o.id = u.organization_id
           left join property_team_assignments a on a.user_id = u.id and a.active = true
          group by u.id, o.name
          order by u.created_at desc`
      )).rows;
      res.json(rows.map(r => ({ ...r, property_count: Number(r.property_count) })));
    } catch (e) {
      console.error("admin/users list error", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── PATCH /admin/users/:id ───────────────────────────────────────────────
  router.patch("/admin/users/:id", requireSuperAdmin, async (req, res) => {
    try {
      const { platform_role, organization_id, status } = req.body || {};
      const allowed_roles = ["super_admin", "member"];
      if (platform_role && !allowed_roles.includes(platform_role)) {
        return res.status(400).json({ error: `platform_role must be one of: ${allowed_roles.join(", ")}` });
      }

      const updated = (await pool.query(
        `update users
            set platform_role   = coalesce($1, platform_role),
                organization_id = coalesce($2, organization_id),
                status          = coalesce($3, status),
                updated_at      = now()
          where id = $4
          returning id, name, email, platform_role, organization_id, status`,
        [platform_role || null, organization_id || null, status || null, req.params.id]
      )).rows[0];

      if (!updated) return res.status(404).json({ error: "User not found." });
      res.json(updated);
    } catch (e) {
      console.error("admin/users patch error", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /admin/properties — unassigned properties ───────────────────────
  router.get("/admin/properties", requireSuperAdmin, async (req, res) => {
    try {
      const rows = (await pool.query(
        `select id, coalesce(display_name, name) as name, address, city, state,
                organization_id, sms_number, created_at
           from properties
          order by organization_id nulls first, name`
      )).rows;
      res.json(rows);
    } catch (e) {
      console.error("admin/properties list error", e);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
