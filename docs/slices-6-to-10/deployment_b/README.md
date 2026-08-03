# Deployment B — staged, deliberately OUTSIDE `migrations/`

`migrations/migrate.js` applies **every** `NNN_*.sql` physically present in the
deployed checkout:

```js
fs.readdirSync(MIGRATIONS_DIR).filter(f => /^\d{3}_.*\.sql$/.test(f))
```

It has no Deployment-A / Deployment-B selector, and adding an
environment-controlled ceiling would be a weaker gate than physical absence.

So `125_application_lifecycle_enforcement.sql` lives **here**, where the runner
cannot see it. Shipping it inside `migrations/` on the Deployment A branch
would apply it during A and recreate the exact rolling-instance failure the
split exists to prevent.

## Sequence

1. **Deployment A** — migrations 123 + 124 (expansion **+ compatibility
   authoring**), the canonical lifecycle writer, all eight writer cutovers, the
   corrected evidence API. **No 125 file anywhere under `migrations/`.**
2. Deploy, prove A1–A5, and confirm every active instance is running A.
3. **Deployment B** — branch from the then-current `main`, `git mv` this file
   into `migrations/`, and ship it as the only lifecycle-enforcement change.
4. Prove B1–B3.
5. Freeze the evidence API contract, then build the renderer.

## What 125 does

Drops the temporary compatibility trigger installed by 124 and replaces it with
strict refusal-based enforcement: milestone authoring required on INSERT and
UPDATE by status **group** (not label), write-once milestones, terminal status
immutable entirely, and terminal correspondence as a standing table constraint.
