# Release receipt — migrations 182–187

**19–20 August 2026.** Observed, not inferred. Every line below came from a
command that ran or an endpoint that answered.

```text
production schema ceiling   187
ledger entries              175           (169 + the six released)
application SHA             30cb992c1857889e1fc31e61cbc770f89d106519
SHA resolved from           render_env    (RENDER_GIT_COMMIT — the platform, not a guess)
health                      ok:true       db reachable, started 2026-08-20T00:47:11Z
CI run tied to that code    run 10, conclusion success, 13 of 13 proofs
```

Which finally gives the chain we were after:

```text
known source → automatic proof → known production schema → known deployed application
```

## How it was released

Not schema-first-with-a-gap. That was ruled out by a measured fact: 182–187
are runtime-compatible with the already-running old process and **restart-
incompatible with the old build** — `main`'s own prestart refuses a ledger
carrying entries whose files it lacks. So the old build kept serving but
could not have restarted, and could not have been reverted to.

The Render service had no pre-deploy command field available, so the gate
ran from an operator workstation against production, immediately followed
by a pinned manual deploy of the same reviewed commit. The window was
minutes, on a Starter instance with auto-deploy off.

`tools/release/predeploy_release_gate.js` did the work and was falsified
five ways first: no commit pin refuses; a ledger not at the expected start
refuses; a real duplicate that 183 would reject refuses naming that check;
a clean 181 applies and verifies; a re-run at 187 reports already-released
and exits 0.

## What this does NOT establish

```text
production BEHAVIOUR   still nothing. No application path has been
                       exercised against production. The schema is right
                       and the code is known; what the system DOES there
                       is unproven.
Skyline activation     unchanged. pricing_terms is still 0, so no governed
                       price resolves for any space, and the refusal at
                       no_published_pricing_version remains correct.
```

The next gate is not engineering. It is the pricing-authority ruling: with
`properties_with_publish_authority: 0`, nobody can publish Skyline's rents
even holding the real sheet.
