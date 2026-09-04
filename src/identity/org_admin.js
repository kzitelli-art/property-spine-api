// org_admin.js — Org-scoped admin surface for org_admin users.
//
// ROUTES (all require valid staff session + platform_role = 'org_admin'
//         AND the session's organization_id matches the resource):
//
//   GET  /org/me                        current org + properties + users
//   GET  /org/roles                     canonical staff role presets
//
//   GET  /org/users                     all users in this org
//   POST /org/users/invite              invite a new user (role-based)
//   PATCH /org/users/:userId            update role / status for a user in this org
//   DELETE /org/users/:userId           remove user from org (deactivate assignments)
//
//   GET  /org/properties                all properties in this org
//   PATCH /org/properties/:propId/team/:assignmentId   update an assignment
//
// AUTH: requireOrgAdmin resolves x-staff-session, checks platform_role = 'org_admin',
//       and binds req.orgId = the user's organization_id for all downstream checks.
//       A user with no organization_id is rejected even if platform_role is correct.

"use strict";

const express = require("express");
const crypto = require("crypto");
const staffSessions = require("./staff_session_service.js");

const ROLE_MODULE_MAP = {
  maintenance_tech:  { allowed: ["maintenance"],                                        primary: ["maintenance"],  can_manage: false },
  leasing_agent:     { allowed: ["leasing"],                                             primary: ["leasing"],      can_manage: false },
  property_manager:  { allowed: ["management","leasing","maintenance"],                  primary: ["management"],   can_manage: false },
  property_admin:    { allowed: ["management","leasing","maintenance","reporting"],       primary: ["management"],   can_manage: true  },
  owner:             { allowed: ["management","leasing","maintenance","reporting","capital"], primary: ["management"], can_manage: true },
};

module.exports = function orgAdminModule({ pool }) {
  if (!pool) throw new Error("org_admin.js requires { pool }");
  const router = express.Router();

  // ── Auth middleware ──────────────────────────────────────────────────────
  async function requireOrgAdmin(req, res, next) {
    const token = req.get("x-staff-session");
    if (!token) return res.status(401).json({ error: "Staff session required." });
    const session = await staffSessions.resolveStaffSession(pool, token);
    if (!session) return res.status(401).json({ error: "Invalid or expired session." });

    const u = (await pool.query(
      `select platform_role, organization_id from users where id = $1`,
      [session.id]
    )).rows[0];

    if (!u || u.platform_role !== "org_admin") {
      return res.status(403).json({ error: "Org admin access required." });
    }
    if (!u.organization_id) {
      return res.status(403).json({ error: "Your account is not linked to an organization." });
    }

    req.operator = session;
    req.operator.platform_role = "org_admin";
    req.orgId = u.organization_id;
    next();
  }

  // ── GET /org/me ─────────────────────────────────────────────────────────
  router.get("/org/me", requireOrgAdmin, async (req, res) => {
    try {
      const org = (await pool.query(`select * from organizations where id = $1`, [req.orgId])).rows[0];
      if (!org) return res.status(404).json({ error: "Organization not found." });

      const [properties, users] = await Promise.all([
        pool.query(
          `select id, coalesce(display_name, name) as name, address, city, state, sms_number, created_at
             from properties where organization_id = $1 order by name`,
          [req.orgId]
        ),
        pool.query(
          `select u.id, u.name, u.email, u.phone, u.platform_role, u.status,
                  count(distinct a.property_id) as property_count
             from users u
             left join property_team_assignments a on a.user_id = u.id and a.active = true
            where u.organization_id = $1
            group by u.id
            order by u.created_at`,
          [req.orgId]
        ),
      ]);

      res.json({
        ...org,
        properties: properties.rows,
        users: users.rows.map(r => ({ ...r, property_count: Number(r.property_count) })),
      });
    } catch (e) {
      console.error("org/me error", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /org/roles ───────────────────────────────────────────────────────
  router.get("/org/roles", requireOrgAdmin, async (req, res) => {
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

  // ── GET /org/users ───────────────────────────────────────────────────────
  router.get("/org/users", requireOrgAdmin, async (req, res) => {
    try {
      const rows = (await pool.query(
        `select u.id, u.name, u.email, u.phone, u.platform_role, u.status, u.created_at,
                json_agg(json_build_object(
                  'assignment_id', a.id,
                  'property_id', a.property_id,
                  'property_name', coalesce(p.display_name, p.name),
                  'role_title', a.role_title,
                  'role_key', a.role_key,
                  'allowed_modules', a.allowed_modules,
                  'can_manage_roles', a.can_manage_roles,
                  'active', a.active
                ) order by p.name) filter (where a.id is not null) as assignments
           from users u
           --  Only assignments on THIS organization's properties. Filtering the
           --  property join alone left other orgs' assignment rows in the
           --  aggregate with property_name null and everything else intact.
           left join property_team_assignments a
                  on a.user_id = u.id
                 and a.property_id in (select id from properties where organization_id = $1)
           left join properties p on p.id = a.property_id
          where u.organization_id = $1
          group by u.id
          order by u.created_at`,
        [req.orgId]
      )).rows;
      res.json(rows);
    } catch (e) {
      console.error("org/users error", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /org/users/invite ───────────────────────────────────────────────
  // Body: { name, phone, email, property_id, role_key }
  router.post("/org/users/invite", requireOrgAdmin, async (req, res) => {
    try {
      const { name, phone, email, property_id, role_key } = req.body || {};
      if (!name || !phone) return res.status(400).json({ error: "name and phone are required." });
      if (!property_id) return res.status(400).json({ error: "property_id is required." });
      if (!role_key || !ROLE_MODULE_MAP[role_key]) {
        return res.status(400).json({ error: `role_key must be one of: ${Object.keys(ROLE_MODULE_MAP).join(", ")}` });
      }

      // Verify property belongs to this org
      const prop = (await pool.query(
        `select id, coalesce(display_name, name) as name from properties where id = $1 and organization_id = $2`,
        [property_id, req.orgId]
      )).rows[0];
      if (!prop) return res.status(400).json({ error: "Property does not belong to your organization." });

      const preset = ROLE_MODULE_MAP[role_key];
      const normalizedPhone = phone.replace(/\D/g, "").replace(/^1/, "");
      const e164 = "+1" + normalizedPhone;
      const e164Digits = e164.replace(/\D/g, "");
      const emailNorm = email && email.trim() ? email.trim() : null;

      //  ── AN EXISTING ACCOUNT MUST ALREADY BE THIS ORGANIZATION'S ──────
      //  The upsert below overwrites organization_id and the sign-in phone.
      //  Applied to another organization's user that is an account move and
      //  a takeover in one statement: their login number becomes the
      //  caller's, and /auth/sms/start then texts the code to the caller.
      //  An org admin's authority ends at their organization; an account
      //  outside it — another org's, or one with no org at all, which is
      //  where the platform admins live — is refused, never adopted.
      const existing = (await pool.query(
        `select id, organization_id
           from users
          where ($1::text is not null and email = $1)
             or (phone is not null and regexp_replace(phone, '\\D', '', 'g') = $2)
          order by ($1::text is not null and email = $1) desc
          limit 1`,
        [emailNorm, e164Digits]
      )).rows[0];
      if (existing && String(existing.organization_id) !== String(req.orgId)) {
        return res.status(409).json({
          error: "user_belongs_to_another_organization",
          receipt: "An account with that email or phone already exists outside your organization. " +
                   "Invites cannot move an account between organizations; ask a platform admin.",
        });
      }

      // Upsert user — conflict on phone (unique) if no email, otherwise email
      let user;
      if (emailNorm) {
        user = (await pool.query(
          `insert into users (name, email, phone, role, auth_provider, platform_role, organization_id, is_active, status)
           values ($1, $2, $3, 'property_manager', 'phone_otp', 'member', $4, true, 'active')
           on conflict (email) do update
             set name = excluded.name, phone = excluded.phone,
                 organization_id = excluded.organization_id,
                 is_active = true, status = 'active', updated_at = now()
           returning id, name, email, phone`,
          [name.trim(), emailNorm, e164, req.orgId]
        )).rows[0];
      } else {
        //  The only unique index on users.phone is the PARTIAL EXPRESSION
        //  index from migration 035, so the conflict target must name that
        //  expression and repeat its predicate. `on conflict (phone)` matched
        //  no index and raised 42P10 on every phone-only invite.
        user = (await pool.query(
          `insert into users (name, phone, role, auth_provider, platform_role, organization_id, is_active, status)
           values ($1, $2, 'property_manager', 'phone_otp', 'member', $3, true, 'active')
           on conflict ((regexp_replace(phone, '\\D', '', 'g')))
             where phone is not null and length(regexp_replace(phone, '\\D', '', 'g')) >= 10
           do update
             set name = excluded.name, organization_id = excluded.organization_id,
                 is_active = true, status = 'active', updated_at = now()
           returning id, name, email, phone`,
          [name.trim(), e164, req.orgId]
        )).rows[0];
      }

      // Upsert property_team_assignments with canonical role preset
      const roles = (await pool.query(`select label from staff_roles where key = $1`, [role_key])).rows[0];
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
        [property_id, user.id, roles ? roles.label : role_key,
         role_key, preset.allowed, preset.primary, preset.can_manage]
      );

      res.status(201).json({
        ok: true,
        user: { id: user.id, name: user.name, email: user.email, phone: user.phone },
        property_id,
        role_key,
        note: "User provisioned. They can log in via phone OTP.",
      });
    } catch (e) {
      //  The email matched one account and the phone another: the upsert
      //  updated the first and the phone index refused. Say which, do not 500.
      if (e && e.code === "23505") {
        return res.status(409).json({
          error: "phone_belongs_to_another_account",
          receipt: "That phone number already signs in a different account. One line, one person.",
        });
      }
      console.error("org/users/invite error", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── PATCH /org/users/:userId ─────────────────────────────────────────────
  // Update platform_role (only org_admin→member) or status for users in this org
  router.patch("/org/users/:userId", requireOrgAdmin, async (req, res) => {
    try {
      const { status, platform_role } = req.body || {};

      // Verify user belongs to this org
      const target = (await pool.query(
        `select id, platform_role from users where id = $1 and organization_id = $2`,
        [req.params.userId, req.orgId]
      )).rows[0];
      if (!target) return res.status(404).json({ error: "User not found in your organization." });

      // Org admin cannot promote to super_admin
      if (platform_role && !["org_admin", "member"].includes(platform_role)) {
        return res.status(403).json({ error: "Org admins can only set org_admin or member roles." });
      }

      const updated = (await pool.query(
        `update users
            set platform_role = coalesce($1, platform_role),
                status        = coalesce($2, status),
                updated_at    = now()
          where id = $3
          returning id, name, email, phone, platform_role, status`,
        [platform_role || null, status || null, req.params.userId]
      )).rows[0];

      res.json(updated);
    } catch (e) {
      console.error("org/users patch error", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── DELETE /org/users/:userId ────────────────────────────────────────────
  // Deactivates all property assignments for this user within the org
  router.delete("/org/users/:userId", requireOrgAdmin, async (req, res) => {
    try {
      const target = (await pool.query(
        `select id from users where id = $1 and organization_id = $2`,
        [req.params.userId, req.orgId]
      )).rows[0];
      if (!target) return res.status(404).json({ error: "User not found in your organization." });

      await pool.query(
        `update property_team_assignments a
            set active = false, updated_at = now()
           from properties p
          where a.property_id = p.id
            and p.organization_id = $1
            and a.user_id = $2`,
        [req.orgId, req.params.userId]
      );

      res.json({ ok: true, user_id: req.params.userId, note: "All property assignments deactivated." });
    } catch (e) {
      console.error("org/users delete error", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /org/properties ──────────────────────────────────────────────────
  router.get("/org/properties", requireOrgAdmin, async (req, res) => {
    try {
      const rows = (await pool.query(
        `select p.id, coalesce(p.display_name, p.name) as name, p.address, p.city, p.state,
                p.sms_number, p.created_at,
                count(distinct a.user_id) filter (where a.active = true) as active_user_count
           from properties p
           left join property_team_assignments a on a.property_id = p.id
          where p.organization_id = $1
          group by p.id
          order by p.name`,
        [req.orgId]
      )).rows;
      res.json(rows.map(r => ({ ...r, active_user_count: Number(r.active_user_count) })));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── PATCH /org/properties/:propId/team/:assignmentId ────────────────────
  // Org admin can update role_key / active on any assignment within their org
  router.patch("/org/properties/:propId/team/:assignmentId", requireOrgAdmin, async (req, res) => {
    try {
      const { role_key, active } = req.body || {};

      // Verify property belongs to org
      const prop = (await pool.query(
        `select id from properties where id = $1 and organization_id = $2`,
        [req.params.propId, req.orgId]
      )).rows[0];
      if (!prop) return res.status(404).json({ error: "Property not found in your organization." });

      if (role_key && !ROLE_MODULE_MAP[role_key]) {
        return res.status(400).json({ error: `role_key must be one of: ${Object.keys(ROLE_MODULE_MAP).join(", ")}` });
      }

      const preset = role_key ? ROLE_MODULE_MAP[role_key] : null;
      const roleLabel = role_key
        ? ((await pool.query(`select label from staff_roles where key = $1`, [role_key])).rows[0] || {}).label || role_key
        : null;

      const updated = (await pool.query(
        `update property_team_assignments
            set role_key          = coalesce($1, role_key),
                role_title        = coalesce($2, role_title),
                allowed_modules   = coalesce($3, allowed_modules),
                primary_for_modules = coalesce($4, primary_for_modules),
                can_manage_roles  = coalesce($5, can_manage_roles),
                active            = coalesce($6, active),
                updated_at        = now()
          where id = $7 and property_id = $8
          returning *`,
        [
          role_key || null,
          roleLabel,
          preset ? preset.allowed : null,
          preset ? preset.primary : null,
          preset ? preset.can_manage : null,
          active != null ? active : null,
          req.params.assignmentId,
          req.params.propId,
        ]
      )).rows[0];

      if (!updated) return res.status(404).json({ error: "Assignment not found." });
      res.json(updated);
    } catch (e) {
      console.error("org/properties/team patch error", e);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
