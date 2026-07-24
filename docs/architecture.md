# Architecture

## Overview

Property Spine API is a Node.js/Express monolith. One process, one `server.js` entry point, one Postgres connection pool. All domain logic lives in `src/` organized by domain, not by layer.

```
Request → Express → CORS middleware → auth gate → router → domain module → pool → Postgres (Neon)
```

---

## The organ pattern

Every domain module is a **factory function** that receives shared dependencies and returns an Express router:

```js
module.exports = function domainModule({ pool, anthropic, sms }) {
  const router = express.Router();
  router.get('/some-route', async (req, res) => { ... });
  return router;
};
```

`server.js` instantiates the pool and shared services once, then calls each factory and mounts the returned router:

```js
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const sms = smsModule();
app.use(leasingModule({ pool, sms }));
app.use(maintenanceModule({ pool }));
// ...
```

This means:
- No global state leaks between modules
- Dependencies are explicit and testable
- Adding a new domain = write a factory, mount it

---

## Request flow

1. **CORS** — `/operator/*` routes get a fail-closed policy allowing only `OPERATOR_APP_ORIGIN`. All other routes use permissive CORS (they carry their own auth).
2. **Operator key gate** — routes not in the public allowlist require `x-operator-key` header matching `OPERATOR_KEY`. `/auth/*`, `/tenant/*`, `/public/*`, `/intake/*`, `/demo/*`, and `/operator/*` are exempt (each carries its own auth).
3. **Route handler** — domain logic, DB queries via `pool`, response.

---

## Auth layers

There are three distinct auth surfaces (see [auth.md](auth.md) for full detail):

| Surface | Mechanism | Who uses it |
|---------|-----------|-------------|
| Operator API (`/operator/*`) | Staff session token (`x-staff-session`) | Browser frontend |
| Operator API gate (everything else) | `x-operator-key` header | Server-to-server / dev tools |
| Tenant portal (`/tenant/*`, `/t/*`) | Invitation token + session | Tenants/applicants |

---

## The one loop

Every module is the same loop pointed at a different domain:

```
Event → Obligation → Required Input → Clock → Escalation → Proof → Completed Record
```

- **Leasing:** lead arrives → tour obligation → application → lease execution → move-in
- **Maintenance:** work order created → technician obligation → completion → proof photo
- **Money:** charge scheduled → payment received → bank match → report-ready
- **Controls:** license expiring → renewal obligation → document upload → confirmed

The `obligations` table is the engine. Every `obligation` has an owner role, an optional specific user, a `due_at`, and a proof requirement.

---

## Key architectural decisions

**Leases attach to spaces, not units.** A unit always has at least one space (enforced by the `ensure_unit_space` DB trigger). This lets whole-unit and by-the-bed leasing share one code path.

**Claimed vs. proven.** Facts enter as claims. Only structural ties a human signed upgrade a claim to truth. AI can suggest; humans confirm. Nothing hits reporting until it is confirmed. See [docs/specs/DOCTRINE.md](specs/DOCTRINE.md).

**Communications boundary.** All outbound SMS goes through `src/comms/communications_boundary.js`. A property must have an `sms_number` configured to send staff OTP. No fallback, no silent failure — `sendPropertySms` returns a `wire.sent` boolean and a reason.

**Migrations are the only way to change the schema.** No hand-editing in the Neon console. `prestart` runs `node migrations/migrate.js` on every boot. See [migrations/README.md](../migrations/README.md).

**Identity is exact, never guessed.** The `registry.js` module resolves strings to canonical property records. If it can't resolve, it surfaces ambiguity to a human — it never picks one.

---

## File map

```
server.js                    — entry: pool, middleware, router mounts
migrations/migrate.js        — migration runner (runs on every boot)
src/
  identity/
    staff_session_service.js — issues/validates staff session tokens (digest at rest)
    teamaccess.js            — phone OTP login: /auth/sms/start + /auth/sms/verify
    operator.js              — /operator/* routes: session gate, /operator/me
    operator_session_bootstrap.js — invite-code bootstrap (legacy/dev)
    registry.js              — property identity resolution
  leasing/
    leasing_desk.js          — main leasing surface router
    leasing_desk_loader.js   — data loading for the leasing desk
    leasing_lifecycle_service.js — lease state machine
    leasingleads.js          — prospect capture and lead management
  maintenance/
    maintenance.js           — work orders, urgency, turn tracking
    work_order_service.js    — work order lifecycle
  money/
    money.js                 — charges, payments, ledger
    bankbridge.js            — Plaid bank feed integration
    reporting.js             — T-12 and financial report generation
  comms/
    communications_boundary.js — the ONE outbound SMS gate
    sms.js                   — Twilio transport (fail-soft when unconfigured)
    tenantlink.js            — tenant portal session and links
  agent/
    agent.js                 — AI ingestion via Anthropic Claude SDK
  surfaces/
    board.js                 — portfolio-level read surface
    management.js            — management desk surface
    portfolio.js             — cross-property portfolio view
```
