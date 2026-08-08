# RELEASE 0 — EVIDENCE INGRESS PROVEN

**Closed** 2026-08-08 · production, real handset, real bytes

An identified technician sent real evidence through a governed staff line, and
Property Spine preserved it durably **without declaring the work complete.**

## The authoritative receipt

The receipt is the output of `tools/activation/release0_final_receipt.js`,
which is deterministic and re-runnable. It re-derives every database fact live
at generation time and **refuses to print anything at all** unless every named
fact is present — there is no partial receipt, and no verdict computed from a
count of green checks. Its existence is the proof.

```bash
TEST_FROM='<tester phone>' node tools/activation/release0_final_receipt.js \
  --input /tmp/r0_input.json
```

Identifiers, digests and timestamps are deliberately **not transcribed into this
document**. Three separate identifiers were mis-copied by hand during this
release (a corrupted UUID in transit, a wrong user id read off a screenshot, a
hardcoded person id that silently matched nothing). Re-derive; never transcribe.

## What was proven, gate by gate

```text
Gate 0   credential rotation            PASS   bound-nonce protocol, positively proven
Gate 1   clean branch                   PASS   six authorized files, digests bound
Gate 2   deployment binding             PASS   26 checks, running bytes = reviewed bytes
Gate 3   deployed transport contract    PASS   13 contract checks
Gate 4   technician fixture             PASS   18 checks, governed assignment attributed
Gate 5   operations-line activation     PASS   already satisfied; org-scoped shape is the legal one
Gate 6   webhook configuration          PASS   read back, string-equal
Gate 7   signature controls             PASS   13 checks, A credited because B passed
Gate 8   real-handset evidence ingress  PASS   17 checks, durable attachment, completion untouched
Gate 9   rollback drill                 PASS    9 checks, real transaction, rolled back
Gate 10  final receipt                  PASS   every named fact present
```

## The three facts that matter

**The bytes are real.** `storage_state = stored`, with content, byte size,
SHA-256 and `stored_at` all present, and a MIME verified against what the
carrier actually served rather than what it claimed. Before this release every
MMS landed `referenced` with no bytes at all, so proof could never be satisfied.

**Completion did not move.** Status `open → open`, completed events `0 → 0`,
completion claims `0 → 0`, proof evaluations `0 → 0` (table absent — migration
137 has not run). The attachment may exist; completion may not.

**Delivery is not claimed.** The operations line produced an outbound reply
intent, the provider accepted it, and the receipt records
`handset delivery NOT CLAIMED — no delivery receipt`. Accepted is not delivered,
and the system says so rather than rounding up.

## What the build found on the way

Each of these was found by a check refusing, not by reading code:

- **A silent attribution defect.** `req.operator.user_id` did not exist, so every
  governed maintenance action — assign, ask-photo, coordinate-entry, retry —
  recorded what happened and to whom but never **by whom**. Fixed in PR #48;
  `gate_operator_session_fields.js` closes the class by parsing the session's
  real shape from the resolver's own source.

- **A live identity collision.** The tester's mobile was simultaneously a staff
  identity on the operations rail and a reachable prospect identity on the
  resident rail. Gate 4 blocked, correctly. Resolved by closing a fabricated
  opportunity **through the governed leasing route**, not by editing identity
  data to make a check pass. A second instance was then found on another staff
  member. Both are recorded in `IDENTITY_HYGIENE_REGISTER.md`.

- **A measurement method that under-reported.** An `information_schema`
  foreign-key walk reported "67 tables checked, 0 rows attached" and that was
  published as proof a record was inert. It was not — a plainly declared FK was
  missed. Ask the question production asks, against the rows production reads.

- **Three schema truths the spec's wording missed.** The rollback status
  vocabulary is `retired`, not `superseded` (the spec's word violates a check
  constraint, and the first draft died on it). Operations lines are
  organization-scoped structurally. User-phone ambiguity is impossible under a
  partial unique index, so the reachable identity failures are different ones
  than the spec anticipated.

- **The product cannot reassign work.** Once assigned, the Work Orders door
  offers no way to move it — deliberate, and commented as such, but it means a
  technician going on leave has no governed handoff path. Worked around here by
  calling the same route the button calls. Worth a product decision.

## Scope held

```text
migration 137 run or created    NO
canonical completion writer     NO
Step 2 begun                    NO
work order 1006 closed          NO
proof evaluations created       NO
property-facing line touched    NO
resident communication produced NO
```

## Never recorded

Twilio token · account credentials · technician phone · operations number ·
`provider_config` contents · image bytes · media URL · webhook signature.

## Standing items, not blockers

- **A2P 10DLC registration** for the second number, and status-callback
  configuration — parallel, and neither gates inbound reception or durable
  storage.
- **H-1 / H-3** phone-keyed identity collision between the staff directory and
  the leasing pipeline. Currently QA data with no real counterparties, so no
  live consequence — but the *mechanism* is unaddressed, and cleaning the two
  rows would remove today's symptoms while leaving it in place.
- **The anonymous assignment event** from before PR #48 is preserved exactly as
  it is. The action happened and its actor was not captured. That is history,
  not a defect to backfill.
