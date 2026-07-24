# Authentication & Authorization

## Overview

There are three separate auth surfaces. They do not share tokens or middleware.

| Surface | Routes | Mechanism |
|---------|--------|-----------|
| Staff operator session | `/operator/*` | `x-staff-session` header → staff session token |
| Operator API key gate | Everything else (not public) | `x-operator-key` header |
| Tenant portal | `/tenant/*`, `/t/*` | Invitation token + tenant session |

---

## Staff login flow (phone OTP)

```
Browser                          API                              Twilio
  │                               │                                 │
  ├─ POST /auth/sms/start ───────>│                                 │
  │  { phone_number }             │─ lookup user + assignment ──>DB │
  │                               │<─ user found, assignment found  │
  │                               │─ mint team_invites row ────>DB  │
  │                               │─ sendPropertySms ─────────────>│
  │<─ { token, delivery:"sms_sent"│                    OTP text ──>phone
  │                               │                                 │
  ├─ POST /auth/sms/verify ──────>│                                 │
  │  { token, code }              │─ verify OTP hash ──────────>DB  │
  │                               │─ issue staff_session ──────>DB  │
  │<─ { session_token, user, property, allowed_modules }            │
```

The token returned by `/auth/sms/start` is the `team_invites.token`. The browser must pass it to `/auth/sms/verify`. The OTP code is hashed with the token as pepper (`sha256(code + token)`) so the hash leaking doesn't compromise the code.

### Rate limiting
- 60-second resend floor: if a fresh code exists, `/auth/sms/start` returns 429 with the existing `token` in the body so the browser can proceed to verify without requesting a new code.
- 5 failed attempts locks the invite: `team_invites.failed_attempts >= 5` → 423.

### Login property selection
`/auth/sms/start` picks which property to scope the session to:
```sql
select property_id from property_team_assignments
where user_id=$1 and active=true
order by can_manage_roles desc, updated_at desc
limit 1
```
Admin users have their Demo Building assignment set to `updated_at = now() + '1 year'` so it always wins and routes OTP through the property that has an SMS number.

---

## Staff sessions

`src/identity/staff_session_service.js` — Class 1 session design:

- Token is a random UUID. The **digest** (sha256) is stored in `staff_sessions`, never the raw token.
- The browser holds the raw token; the server holds only the digest.
- Sessions are property-scoped: `staff_sessions.property_id` is set at issue time.
- `verifySession()` hashes the presented token and compares to the stored digest.
- Sessions expire (configurable TTL, default 12 hours).

---

## CORS policy

```js
// /operator/* — fail-closed
const operatorCors = cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);            // server-to-server allowed
    if (origin === OPERATOR_APP_ORIGIN) return cb(null, true);
    return cb(null, false);                        // anything else: denied
  },
  allowedHeaders: ['content-type', 'x-staff-session'],
  credentials: false,
});

// Everything else — permissive (routes carry their own auth)
const generalCors = cors({ allowedHeaders: [...], methods: [...] });
```

`OPERATOR_APP_ORIGIN` must be set in Render's environment to the exact frontend URL (e.g. `https://property-spine-app.onrender.com`). If unset, all cross-origin `/operator/*` requests are denied.

---

## Operator key gate

All routes not in the public allowlist require:
```
x-operator-key: <value of OPERATOR_KEY env var>
```

Public allowlist (no key needed — each carries own auth):
- `/health`
- `/auth/*` — phone OTP
- `/tenant/*`, `/t/*` — tenant portal
- `/public/*` — public review
- `/intake/*` — field capture
- `/demo/*` — demo session
- `/operator/*` — staff session (own auth)
- `/applications/submit-public` — applicant submit (invitation token)

---

## Admin users

Admin users (`tmysl@me.com`, `kz8434@gmail.com`) are seeded by migration `090`. They are assigned to all properties with:
- `allowed_modules = ['management','leasing','maintenance','reporting']`
- `can_manage_roles = true`
- `scope_type = 'portfolio'`

Their `role` in the `users` table starts as `property_manager` (the `admin` enum value is added by the migration but cannot be used in the same transaction as the INSERT in Postgres 12+). The `property_team_assignments` row is the true source of access authority — not the `users.role` column.

---

## Tenant portal auth

Tenants access their lease packet via a signed invitation link (`/t/:token`). The token is a `team_invites` row. Acceptance provisions the tenant session and marks the invite accepted. Tenant sessions are separate from staff sessions and carry no operator privileges.
