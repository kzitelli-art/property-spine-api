# RELEASE 0 EVIDENCE INGRESS — ENGINEERING READY, AWAITING OWNER HANDSET ACTIONS

**Date** 2026-08-07 · engineering-only work complete per consultant authorization

## What is deployed

```text
tools PR                #46
PR head                 9a002d3fe858f590cd2476a6c242d5b075eccd51
merge SHA               884436b5db89563669bc4c4debadcdc1cd390980
base (previous deploy)  dd054d2a3ea0adf540ab58d5b18ff232873707ea   ← rollback target
files                   14 — tools/activation/ (11), governance register, two receipts
production bytes        UNCHANGED — zero diffs under src/, server.js, migrations/, package.json
authorized digests      15a03280…c5d9a60e (sms.js) · 619d6ccc…5b435c22 (evidence_service.js)
```

This container has no egress to Render or Twilio (verified: HTTP 000), so the
deploy event, boot health, and every production read below are observed in the
**Render shell only**. Nothing in this document claims them observed already.

## Proof state (isolated ceiling-136 baseline)

```text
gate_tools_falsify.sh        52 / 52   two identical clean runs
readonly_falsify.js          15 / 15
verify_signature_generation   6 / 6
source governance             PASS on both branches
```

Standing schema corrections preserved: rollback vocabulary is `retired`
(`superseded` violates `ck_cl_status`); operations lines are organization-scoped
structurally; user-phone ambiguity is impossible under
`uq_users_phone_normalized` — the tested identity failures are a deactivated
tester and a resident sharing the phone.

## The Render-shell sequence (owner, in order)

Every command below is one line. Stop at the first non-zero exit.

**1 — Deployment binding (Gate 2/3).** Digests, transport contract,
`APP_BASE_URL`, post-deploy invariants, in one read-only pass:

```bash
cd /opt/render/project/src && node tools/activation/verify_deployment.js
```

**2 — Fixture preflight (Gate 4).** Your tester's phone never leaves the shell:

```bash
TEST_FROM='+1XXXXXXXXXX' node tools/activation/technician_fixture_proof.js --pre
```

**3 — OWNER ACTION 1: assign 1006.** In the app: Work Orders → open the
RELEASE 0 CONTROLLED FIXTURE (ref 1006) → **Assign** → choose the tester.
Before: it shows UNASSIGNED. Success: the door confirms "assigned to <tester>.
They still need to accept it." Never by SQL — the read-back refuses SQL-only
assignments by design.

**4 — Assignment read-back:**

```bash
TEST_FROM='+1XXXXXXXXXX' node tools/activation/technician_fixture_proof.js --post
```

**5 — Signature controls (Gate 7).** Writes one governed text-only event
through the production route; census before/after:

```bash
TEST_FROM='+1XXXXXXXXXX' TEST_TO='+1YYYYYYYYYY' node tools/activation/signature_controls.js
```

**6 — Rollback drill (Gate 9, dry run — always rolls back).** Print the line id
first so no UUID travels through chat, then use it in the same shell:

```bash
node -e "const{Client}=require('pg');(async()=>{const c=new Client({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});await c.connect();console.log((await c.query(\"select id from communication_lines where line_type='operations' and status='active'\")).rows);await c.end();})()"
LINE_ID='<the id printed above>' node tools/activation/supersede_operations_line.js --dry-run
```

**7 — Evidence window (Gate 8):**

```bash
TEST_FROM='+1XXXXXXXXXX' node tools/activation/evidence_ingress_proof.js --before
```

**8 — OWNER ACTION 2: one photo.** From the tester handset, to the operations
number, send exactly:

```text
WO 1006 evidence photo
```

with one attached image. No "done", "complete", "finished" — the tool refuses
the run if completion vocabulary appears in the received body.

**9 — Verify (Gate 8):** the `--before` output prints this command with its T0
filled in; run it as printed.

**10 — Final receipt (Gate 10).** `release0_final_receipt.js --input <json>`
with the deploy facts from step 1's output and the control results from step 5.
Every named fact must be present or there is no receipt. The input template is
small enough to paste when needed.

## Explicitly NOT done, per the hard scope fence

Work order 1006 not assigned · no SMS/MMS sent · no line changed · no Twilio
configuration touched · no real retirement · migration 137 neither run nor
created · canonical writer not deployed · Step 2 not begun · no proof
evaluations · `THREAD_HANDOFF.md` not updated (it lives on main; the deploy
authorization covered the tools package only — update it with the next
authorized merge).

## Outbound honesty (standing rule for the proof)

Inbound reception and durable storage are load-bearing. An outbound reply
intent is recorded as an observable fact: provider acceptance is reported,
handset delivery is **never claimed without a delivery receipt**. A2P
registration for the second number continues in parallel and blocks nothing
here.
