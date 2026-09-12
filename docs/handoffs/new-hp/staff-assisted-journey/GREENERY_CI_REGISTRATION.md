# Deliberately empty Greenery journey — configured CI registration

September 12, 2026. Base API 6cc9c7f1dcfd961ad7a9d65bfda06847ac9b99df. Runner-only change; no journey JavaScript, product, migration or package edit.

## Change and boundary

.github/workflows/verify.yml:110 already invokes tests/e2e/verify_all.sh. After the activated Skyline phase stops its owned server, a separate Greenery phase generates a fresh UUID (GREENERY_JOURNEY_ID). That distinct run/property identity is passed to the existing boot.sh intake extension (E2E_INTAKE_INACTIVE_PROPERTY_ID), its prospect-activation allowlist, and the existing journey's PROOF_GREENERY_ID. JOURNEY_SHAPE=greenery selects the already-written deliberately empty fixture; PROOF_EVIDENCE_LABEL also includes the UUID.

The variable named INTAKE_INACTIVE is an existing intake-allowlist extension; this phase explicitly prospect-activates the same synthetic ID. boot.sh retains its normal Skyline fixture ID in other feature allowlists. No Greenery price, home, instrument, application or execution configuration is borrowed: this shape is expected to stop truthfully at no eligible home, not complete a lease.

This is a separate sequential server configuration within the runner's nonce-owned disposable database, not another shared or production database. Existing proof_boundary wait/port guard, fake SMS/model preloads, fenced egress, SERVER_PID shutdown, and EXIT nonce cleanup apply. The preceding server is stopped before boot; failure in this required step fails the runner. Its server log is RUN_DIR/greenery-journey-server.log. No local DB or HTTP run was performed for this registration.

## Validation and limit

Windows PowerShell invoked bundled GNU Bash 5.2.37 (x86_64-pc-msys), distributed as:
C:/Users/kamer/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/git/usr/bin/sh.exe

Command: sh.exe -n tests/e2e/verify_all.sh — exit 0. git diff --check — passed. bash.exe is not installed at the corresponding path; the available sh.exe identifies itself as GNU Bash. This checks syntax only. The newly registered Greenery shape is NOT claimed green until QB obtains the new exact-SHA CI result. Prior 30/0 remains historical and does not prove the strengthened registration.

## Existing staff browser hook (read-only finding)

There is no staff_conversation_tour.browser.js invocation in current verify_all.sh or .github workflows. The existing proof is runnable as node tests/e2e/staff_conversation_tour.browser.js with an owned E2E_API_BASE/E2E_SMS_LOG and E2E_APP_ROOT (default ../app-fable-review-20260907), plus installed Chromium/CHROMIUM. It asserts the owned DB/server, serves the actual app at loopback5173 (lines38–41), inserts the synthetic staff session into sessionStorage key __ps_staff_session__ (line58), and clicks actual LEASING desk → open lead conversations → person → Communication (lines59–63). The route handler at44–55 forwards the app's API-origin calls to the owned loopback API and aborts other external origins. It verifies original/follow-up questions, email-only contact, and native booking/ownership; it is not a complete staff application/lease browser journey. No browser file edited or run in this lane.
