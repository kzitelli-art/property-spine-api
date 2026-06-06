# Property Spine — Backend v1

This is the first real backend: a Postgres database holding the full spine, and a tiny API server with two working endpoints. **The schema expresses the whole thesis; the built endpoints stay narrow.** That split is deliberate — schema is cheap to get right now and painful to retrofit later; endpoints are the opposite.

## What's here

- `schema.sql` — the full data model as Postgres tables (validated against the real Postgres grammar)
- `server.js` — minimal Express API: create property, read properties, health check
- `package.json` — server dependencies

## The design decisions (so the next coder understands the *why*)

**One loop underneath everything:** Event → Obligation → Required Input → Clock → Escalation → Proof → Completed Record. Every module (leasing, maintenance, controls) is that loop pointed at a different domain.

**The spine tables** (property → unit → space → person → lease → ledger → event → comm_event) are the durable backbone. A few invariants are baked in:
- A lease attaches to a **space**, never directly to a unit. This is what lets whole-unit and by-the-bed leasing share one code path. Enforced by foreign key (`leases.space_id`).
- Every unit automatically gets one space, via a database trigger (`ensure_unit_space`). The app enforces it too; the trigger guarantees it even if something writes around the app.
- A **person is durable** — `lifecycle_status` changes (lead → applicant → tenant → past) but the record is never replaced.

**Obligations are the engine.** Ownership works at two levels, both present from day one:
- `assigned_role` (e.g. `leasing_agent`) — role-level ownership
- `assigned_user_id` (e.g. Katie, nullable) — specific-person ownership
- Same for escalation: `escalates_to_role` + `escalates_to_user_id` (nullable)

One event can spawn multiple obligations for different roles — a Unit 304 conflict creates separate obligations for leasing, maintenance, the PM, and (only if it goes material) the owner.

**The clock is real:** `due_at` exists now. Read-time logic only — `now() > due_at` means overdue; an AI-owned obligation that goes overdue escalates to a human. No background jobs yet.

**Notification columns exist but the behavior does not.** `notification_channel`, `requires_acknowledgment`, `escalation_interval_minutes`, etc. are reserved so the schema doesn't fight Twilio/email/phone later — but none of that is wired today. Schema room, no behavior.

**Property Controls are first-class.** Rental license, certificate of occupancy, insurance, taxes, lender reports, permits, inspections — each is a control that, when expiring or due, becomes an event that spawns an obligation through the *same loop*. This is what turns "property management software" into a control system. Table exists now; behavior built later.

**A document is more than a file.** The `documents` table can point at the obligation it satisfies (`satisfies_obligation_id`) and the dates that drive a control. Shape now, behavior later.

**Users table is minimal on purpose.** Enough that obligations can belong to real people, not just roles. No real auth today — `auth_provider` and related columns are reserved for when staff login gets built.

## Setup — what you do vs. what's done

The code is written and tested. What's left needs your accounts (they need your email + card on file; all have free tiers, ~$0 today):

1. **Neon** (Postgres database) — create an account, create one project/database, copy the connection string (starts with `postgresql://`).
2. **Apply the schema** — in the Neon SQL editor, paste the contents of `schema.sql` and run it. This creates every table.
3. **GitHub** — create a repo, push this `backend/` folder to it.
4. **Render** — create a Web Service pointing at the GitHub repo. Set one environment variable: `DATABASE_URL` = your Neon connection string. Render runs `npm start`.

Once deployed, test it:
```
GET  https://your-app.onrender.com/health        → { ok: true, db_time: ... }
POST https://your-app.onrender.com/properties     → { "name": "The Felix" }
GET  https://your-app.onrender.com/properties     → [ { id, name, ... } ]
```

When `/health` returns `ok: true` and a POST then GET round-trips a property, the backend is real. Everything after that is the same pattern repeated for each table.

## Security note (matters the moment this is real)

The `DATABASE_URL` is a password to your database. For local testing it's fine, but in production it lives **only** as an environment variable in Render — never in the code, never committed to GitHub, never pasted into chat. If it ever leaks, rotate it in Neon immediately.
