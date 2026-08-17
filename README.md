# Property Spine — API

Node.js/Express API server for Property Spine, a property management platform built around a single core idea: **capture every event once, at the moment it happens, with proof attached — then reporting is a read, not a reconstruction.**

Deployed on [Render](https://render.com), backed by [Neon](https://neon.tech) (Postgres). Frontend lives in [`property-spine-app`](https://github.com/kzitelli-art/property-spine-app).

---

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Set environment variables (copy and fill in)
cp .env.example .env   # or create .env manually — see docs/deployment.md

# 3. Run migrations and start the server
npm start              # prestart runs migrations automatically
```

The server starts on port 3000. `GET /health` returns `{ ok: true }` when the DB is reachable.

---

## Repository layout

```
server.js             — Express entry point; mounts all routers
migrations/           — Numbered SQL migration files + migrate.js runner
schema.sql            — Snapshot of the full schema (reference only)
src/
  agent/              — AI document ingestion (Anthropic Claude)
  applications/       — Rental applications, lease packets, execution
  comms/              — SMS transport, communications boundary, tenant links
  identity/           — Auth: staff sessions, phone OTP, team access
  leasing/            — Leads, tours, conversions, leasing desk
  maintenance/        — Work orders, turnovers, urgency scoring
  money/              — Charges, payments, Plaid bank feed, reporting
  onboarding/         — Property onboarding, deal intake, rent-roll import
  shared/             — Cross-domain utilities and contracts
  surfaces/           — Operator-facing read surfaces (board, desks, portfolio)
  tenancy/            — Move-in, move-out, occupancy, availability
tests/                — Test harnesses and arc/beat scripts
tools/                — Dev utilities
docs/                 — Architecture docs and design specs
```

---

## Documentation

| Doc | What it covers |
|-----|---------------|
| [docs/architecture.md](docs/architecture.md) | How the server is structured, the organ pattern, request flow |
| [docs/data-model.md](docs/data-model.md) | Core schema: property → unit → space → lease hierarchy |
| [docs/auth.md](docs/auth.md) | Staff sessions, phone OTP login, CORS policy |
| [docs/domains.md](docs/domains.md) | What each `src/` domain does and its key files |
| [docs/deployment.md](docs/deployment.md) | Render, environment variables, migrations, Docker |
| [docs/specs/DOCTRINE.md](docs/specs/DOCTRINE.md) | The core design doctrine: claimed vs. proven, the one loop |
| [docs/specs/PROPERTY_SPINE_SPEC.md](docs/specs/PROPERTY_SPINE_SPEC.md) | Comprehensive spec validated against live source |

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | Neon Postgres connection string |
| `ANTHROPIC_API_KEY` | Yes | Claude API key for document ingestion |
| `OPERATOR_KEY` | Yes | Shared secret for operator API routes |
| `OPERATOR_APP_ORIGIN` | Yes | Frontend origin for CORS (`https://your-app.onrender.com`) |
| `READ_AI_CONNECTION_ID` | For Meeting Evidence | Stable UUID for the authorized Read AI connection |
| `READ_AI_WEBHOOK_SIGNING_KEY` | For Meeting Evidence | Base64-encoded Read AI webhook signing key |
| `MEETING_RECEIPT_MODEL` | No | Anthropic model override for receipt extraction |
| `TWILIO_ACCOUNT_SID` | No | SMS OTP delivery |
| `TWILIO_AUTH_TOKEN` | No | SMS OTP delivery |
| `PLAID_CLIENT_ID` | No | Bank feed integration |
| `PLAID_SECRET` | No | Bank feed integration |

See [docs/deployment.md](docs/deployment.md) for full details.

---

## Deploy

```bash
./deploy.sh    # triggers a manual Render deploy via API
```

The production service currently has Render auto-deploy disabled. Merging to
`main` does not release code by itself; run `./deploy.sh` deliberately.
Migrations run automatically on startup via the `prestart` script.
