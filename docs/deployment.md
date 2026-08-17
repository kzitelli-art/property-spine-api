# Deployment

## Production stack

| Component | Service |
|-----------|---------|
| API server | [Render](https://render.com) — Web Service, auto-deploys on push to `main` |
| Database | [Neon](https://neon.tech) — serverless Postgres, connection pooling enabled |
| SMS | Twilio (optional — OTP falls back gracefully when unconfigured) |
| Bank feed | Plaid (optional) |
| AI ingestion | Anthropic Claude API |

---

## Environment variables

Set these in Render's Environment tab (never commit them):

```bash
# Required
DATABASE_URL=postgresql://...          # Neon connection string with ?sslmode=require
ANTHROPIC_API_KEY=sk-ant-...           # Claude API key for document ingestion
OPERATOR_KEY=<random secret>           # Shared key for operator API gate
OPERATOR_APP_ORIGIN=https://your-frontend.onrender.com  # Exact frontend URL for CORS

# Optional — SMS OTP delivery
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_FROM_NUMBER=+1...              # Usually not needed; sms_number is per-property

# Optional — Plaid bank feed
PLAID_CLIENT_ID=...
PLAID_SECRET=...
PLAID_ENV=sandbox                     # or 'production'

# Optional — Read AI Meeting Evidence
# Both values are required before the public webhook accepts evidence.
READ_AI_CONNECTION_ID=<stable UUID>
READ_AI_WEBHOOK_SIGNING_KEY=<provider key, Base64-encoded>
MEETING_RECEIPT_MODEL=claude-sonnet-4-6  # optional model override

# Render deploy script (for deploy.sh)
RENDER_API_KEY=rnd_...
RENDER_SERVICE_ID=srv-...
```

---

## Startup sequence

Every deploy runs:
```
npm start
  → prestart: node migrations/migrate.js   (runs any unapplied migrations)
  → node server.js                         (starts Express on port 3000)
```

Migrations are idempotent — running them on a database that's already up to date is safe.

---

## Migrations

Schema changes go through numbered SQL files in `migrations/`. Never hand-edit the Neon console.

```bash
# Apply all pending migrations (runs automatically on start)
node migrations/migrate.js

# Apply against a specific database
DATABASE_URL="postgresql://..." node migrations/migrate.js
```

Files are numbered `001`, `002`, ..., `090`, etc. The `schema_migrations` table tracks which have run. See [migrations/README.md](../migrations/README.md) for full detail.

### Adding a migration

1. Create `migrations/NNN_description.sql` (next number in sequence)
2. Write idempotent SQL (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`, etc.)
3. Test locally, then push to `main` — Render will apply it on next deploy

**Special case — `ALTER TYPE ... ADD VALUE`:** Postgres does not allow using a newly added enum value in the same transaction as an `INSERT` referencing it. Use a `DO $$ BEGIN ... EXCEPTION WHEN others THEN null; END $$;` block, then a separate `UPDATE` in the next statement. See `migrations/090_admin_users.sql` for the pattern.

---

## Manual deploy

```bash
./deploy.sh    # triggers a Render deploy via API without pushing code
```

Requires `RENDER_API_KEY` and `RENDER_SERVICE_ID` in `.env` or environment.

## Activating Read AI Meeting Evidence

The Meeting Evidence code is dormant unless both Read AI variables above are
configured. Activation is deliberately explicit:

1. Generate one stable UUID for `READ_AI_CONNECTION_ID` and configure it with
   the Base64-encoded provider signing key in Render.
2. Deploy the API, then authorize that connection once through
   `POST /operator/meeting-evidence/read-ai/connection` using a real
   `x-staff-session`.
3. Configure Read AI to post to
   `https://property-spine-api.onrender.com/integrations/read-ai/webhook`.
4. Use the `provider_meeting_id` from the authenticated webhook receipt to call
   `POST /operator/meeting-evidence/provider-meetings/:id/bind` with the staff
   session for the intended property.
5. Confirm `GET /operator/meeting-evidence/release-readiness`, then generate the
   draft through
   `POST /operator/meeting-evidence/provider-meetings/:id/owner-receipt`.

The webhook verifies `X-Read-Signature` over the exact raw request bytes before
parsing JSON. A verified meeting remains unbound and unavailable to property
reads until step 4; binding authority is always derived from the staff session.

---

## Local development

### Direct (no Docker)

```bash
npm install
# Set DATABASE_URL in .env pointing to Neon (or a local Postgres)
npm start
```

### Docker Compose (local Postgres)

```bash
docker-compose up
```

This starts:
- `db` — Postgres 16 on port 5432 (credentials: `spine`/`spine`, db: `property_spine`)
- `api` — the API server on port 3000, connected to the local Postgres

The compose file overrides `DATABASE_URL` with the local container connection. All other env vars (Anthropic key, etc.) are read from `.env`.

```bash
# First run — migrations apply automatically
docker-compose up

# Rebuild after dependency changes
docker-compose up --build

# Stop and remove containers
docker-compose down
```

---

## Neon notes

- Connection pooling: use the **pooled** connection string (contains `-pooler` in the hostname) for the API. Direct strings are for migrations and one-off queries.
- SSL is required: `?sslmode=require&channel_binding=require` on the connection string.
- The `pool` in `server.js` is configured with `ssl: { rejectUnauthorized: false }` to work with Neon's certificate chain.

---

## Checking a deploy

```bash
# Health check
curl https://property-spine-api.onrender.com/health
# → { "ok": true, "db_time": "..." }

```

### Checking which migrations have run

This page used to say:

```bash
curl -H "x-operator-key: $OPERATOR_KEY" \
  https://property-spine-api.onrender.com/health/migrations   # DOES NOT EXIST
```

**There is no such route.** Nothing in `server.js` or `src/` defines it, and
there never was — the endpoint would return the API's 404. It was found while
looking for a way to take the migration census before a release, which is the
one moment this page most needed to be right: it sends you to a URL, you get an
error, and the natural reading is "the service is down" rather than "the
documentation is wrong."

Read the ledger from the instance instead, where `DATABASE_URL` already exists:

```bash
node tools/release0/gate1_production_census.js
```

It reports the running SHA, the ledger ceiling, which migrations are applied,
what is pending, and — using `migrations/ledger_verdict.js`, the same classifier
`prestart` runs — whether this build would boot against that database at all. It
proves read-only before it reads, applies nothing, and prints nothing containing
the connection string.
