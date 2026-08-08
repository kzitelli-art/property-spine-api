# Release 0 — HTTP/API acceptance candidate

**⛔ BUILD-AHEAD. Never run against production. Isolated Postgres only.**

Everything proven before this calls functions. **A consumer does not.** It sends a
request with a session header and reads JSON off a socket, and between the reader
and that JSON sit an Express mount, an authority gate, a projection, and
`JSON.stringify` — each of which can silently change the contract while every
service-level proof stays green.

---

## The distinction only the wire can settle

§3.2.1 requires `state` and `satisfied` to be **ABSENT** when the read is
unavailable — not `null`, not `"unavailable"`.

An in-process assertion cannot really settle absent-versus-null; `JSON.parse` can.
So `U4`–`U6` assert against the **response body as received**, and `U7` asserts
against the **raw bytes** that the string `missing_evaluation_defect` does not
appear anywhere in a failed read.

That last one is the worst thing this release could do. If a failed read answered
`missing_evaluation_defect`, **every terminal work order in the property would be
accused of a writer defect at once.**

---

## ⚠ IT FOUND A REAL DEFECT, AND STEP 8 PUT IT THERE

`next_action` is the field the app prints under *"what happens next"*. It was
derived from `proof.satisfied`:

```js
case "completion_claimed":
  return proof.satisfied ? "Close out the work order" : "Obtain repair photo before completion";
```

That line was **correct until Step 8**. Before Step 8, `satisfied` was always a
boolean. Step 8 introduced the proof block where **`satisfied` is ABSENT because
the read did not complete** — and `undefined` is falsy.

So on a failed proof read the API answered:

```json
{ "proof":       { "read_status": "unavailable", "reason_code": "activation_absent" },
  "next_action": "Obtain repair photo before completion" }
```

**One payload, two answers.** The surface says it cannot determine the proof
condition and, in the same breath, tells the operator to go do fieldwork about it.
The app renders `next_action` verbatim (`work-lifecycle-door.js`), so the operator
would read "Proof state unavailable" in one place and a photo instruction in
another, on one screen.

This is precisely the class of confident wrong Release 0 exists to remove, and the
step that exists to remove it is the step that introduced it. **No service-level
proof could see it** — none of them look at `next_action`. It took the consumer's
view to find it.

**Fixed here.** `nextActionFor` now switches on `read_status` and `state`, and
answers `"Proof state unavailable — retry"` when the read did not complete.
`U11`–`U13` assert it over HTTP, `H10`/`H11` are the positive control that the real
instruction still appears on a working read, and the `next-action-from-satisfied`
falsification variant restores the old line and proves the assertions go red.

**It also clears the last one.** `proof.satisfied` now has **zero consumers inside
this API** — it is emitted purely as the frozen §3.4 compatibility field. That is
the precondition for the cleanup release, established as a side effect rather than
claimed.

---

## What it proves

```text
M1–M4   the anti-stub control: the real dependency graph, the real mount,
        the session's property echoed, and a nonexistent route still 404s
U1–U9   with no cutover activation the routes answer 200 and say the READ
        was unavailable; `state` and `satisfied` are ABSENT from the JSON and
        from the bytes; no terminal row is accused of anything
U10–U13 …and nothing DOWNSTREAM invents an instruction from the failed read:
        `next_action` says the read is unavailable, and the list says the
        same thing (see the defect above)
H·×4    all four states arrive over a real socket with the frozen §3.4
        mapping: true · false · null · null
H5–H7   legacy and defect are indistinguishable on `satisfied` alone, `state`
        is the only thing that separates them, and neither was collapsed
        into `satisfied: false`
H8–H9   every state on the wire is one of the four, and all four were
        actually observed — so H8 is not vacuous
H10–H11 the positive control for U11–U13: with a LIVE read the real field
        instruction comes back, and once proof is satisfied it becomes
        "close out" — so the U assertions are about the failed read, not
        about a next_action that stopped saying anything
F0–F5   when the live read THROWS, both routes answer 503 `unavailable`,
        carry no work order, invent no state, and the list does not degrade
        into a short 200
L1–L5   the list carries `state` (§3.3); every work order reports the same
        proof verdict on BOTH routes; the comparison covered every row and
        all four states; lifecycle state and next action agree too
A1–A7   no session → 401 (not an empty 200); a forged token → 401; a
        client-supplied property_id → 403 naming the property actually being
        acted on; another property's work order → 404, never a leaked row
D1–D15  the defect lifecycle end to end through the GOVERNED RAIL and the
        CANONICAL SERVICE, observed through the routes
W1–W2   replaying every read route wrote nothing
```

### D is the section that crosses every boundary at once

`D` never calls the sweep as a function. It **spawns the rail as a child process**
— real argv, real exit code — and then reads the result through HTTP:

```text
D1    the operator's open queue shows no proof-evaluation defect
D2    a bare rail invocation is a DRY RUN and creates nothing
D3    --raise through the rail exits 0
D4–D7 the obligation is now visible on /operator/obligations: linked to the
      work order the reader called a defect, UNASSIGNED, property-scoped
D8–D9 raising it did NOT change the reader's verdict — the reader is a read
D10   the CANONICAL SERVICE (claimCompletion) completes the work
D11   the obligation leaves the operator's OPEN queue
D12   …and is still readable as history — a closed obligation is a fact, not
      an erasure
D13   …closed as 'satisfied', because an evaluation now exists
D14   the SAME route that reported the defect now reports satisfied
D15   the legacy row was never touched by any of it
```

**`UNASSIGNED` survives the whole trip.** §4.2 freezes the role and names no
person, and `D6` asserts that over HTTP: `assigned_user_id` is null and
`assigned_role` is `property_manager`. Resolving a human there would invent an
ownership ruling nobody made.

---

## Falsification

Four mutations, each living **outside the service layer** — in the projection, the
route's failure handler, the authority gate, or the derived `next_action`. That is
the whole reason this step exists: no service-level proof can see any of them.

```text
next-action-from-satisfied  the defect this step found, put back
list-drops-state            the list projection carries only `satisfied`
swallow-read-failure        a thrown live read becomes a confident 200
property-from-query         the browser gets to choose the building (§21)
```

`next-action-from-satisfied` deliberately **does not activate the cutover**. The
condition it needs is a proof read that cannot complete, and the honest way to
produce that is to leave the cutover unactivated — the same condition §U proves
against. Staging it any other way would be a falsification of the staging.

```text
--variant next-action-from-satisfied   exit 0
--variant list-drops-state             exit 0
--variant swallow-read-failure         exit 0
--variant property-from-query          exit 0
```

Each compiles the mutation **in memory** and installs it in `require.cache` so the
real router picks it up. The disk is never edited, and `Z1`/`Z2` re-check both
source digests at the end. A mutation whose target string has moved is a
**refusal**, not a pass.

Every variant also asserts `V0` first — the mutated app still serves the route.
**A red assertion from a dead router is a broken harness, not a caught mutation.**

`property-from-query` needs **two** edits (neuter the refusal *and* change where
scope comes from), which is itself worth showing: removing either alone is not a
leak. Its `V3` is the sharpest line in the whole set — the leaked board still
reports `property_id: <session property>`, so the caller is told one building and
shown another, and nothing on the page says so.

---

## Three things this proof got wrong before it got them right

Recorded rather than quietly fixed, because two of them are the kind of mistake
that makes a green suite worthless.

### 1. A default that filled in the very thing under test

`detail(wo, session = SESSION)` meant `detail(wo, undefined)` — the "no session"
case — **silently received a real session**. `A1`/`A2` reported `200` and read as
though the authority gate were wide open.

It was a test defect, not a product defect: the gate was working the whole time.
But **a test whose default supplies the thing it is testing for cannot fail in the
direction it is pointed**, and it would have gone on passing forever. The helpers
now default to `null` and there is a separate `anon()` that sends no header.

### 2. An assertion that passed for the wrong reason

The "live read throws" block originally sat inside `U`, **before activation**. With
no activation the derivation returns `unavailable` before it ever touches the
evaluation head — so parking the head broke nothing, and the list happily answered
`200`.

The assertion was red for a real reason, and the reason was that it was testing an
unreachable path. It is now its own section `F`, **after** activation, and opens
with `F0`: both routes are green immediately before anything is broken, so a later
`503` is the parking and not unrelated breakage.

### 3. "Gone" needed defining

`D11` asserted the obligation disappeared from `/operator/obligations`. It did not —
the unfiltered read returns completed obligations too.

**That is correct behaviour, and the assertion was wrong.** A resolved
accountability item is history; erasing it would destroy the very record the
obligation exists to create. The assertion now reads the **open queue**
(`?status=open`) and `D12` asserts the closed row is *still there* as history.

---

## Proof

```text
tools/step10/prove_http_acceptance.js     63 / 63   exit 0   twice, clean baselines
tools/step10/falsify_http_acceptance.js   4 variants, each exit 0
tools/step9/prove_defect_sweep.js         35 / 35   exit 0   (regression)
tools/step9/prove_defect_lifecycle.js     25 / 25   exit 0   (regression)
tools/step9/prove_sweep_runner.js         23 / 23   exit 0   (regression)
tools/step8/prove_step8_reader.js         41 / 41   exit 0   (regression)
npm run verify (10 gates)                 PASS      exit 0
```

```bash
bash tools/step10/run.sh                      # baseline → 137 → the proof

DB='postgresql://postgres@127.0.0.1:5433/r0scale?sslmode=disable'
for V in next-action-from-satisfied list-drops-state swallow-read-failure property-from-query; do
  bash tools/steps23/baseline_136.sh
  PROVE_DATABASE_URL="$DB" node tools/steps23/apply_137.js
  FALSIFY10_DATABASE_URL="$DB" node tools/step10/falsify_http_acceptance.js --variant "$V"
done
```

**The baseline is rebuilt between every run, not reused.** The proof refuses to
start against a database that already carries an activation — a stale inventory
would silently change which rows are legacy and which are defects, and the suite
would still be green. `tools/step10/run.sh` exists so that is one command and
nobody is tempted to skip it.

---

## What this does NOT establish

```text
NOT proven   production. Nothing was run against it; no obligation exists.
NOT proven   the browser. This is HTTP, not a rendered page — the app
             consumer is the next step, and `satisfied` still has consumers
             that have not been moved to `state`.
NOT proven   the technician SMS boundary as HTTP. The Release 0 completion
             writer's own HTTP door is the Twilio inbound webhook, which
             requires a configured transport and a valid provider signature.
             Twilio is not configured, so D drives claimCompletion through
             the CANONICAL SERVICE and observes the result through the
             routes. That is the honest boundary available today; it is not
             the same as proving the webhook.
NOT built    any scheduler. The rail is still a manual trigger.
proven       the four-state contract, list/detail agreement, both failure
             modes, server-derived authority and the full defect lifecycle,
             over real HTTP against real PostgreSQL at 137 + 138 + 139.
```

## Migration numbers

Unchanged. This candidate adds **no migration** — `138` and `139` remain Release
0's, and the next unrelated migration starts at `140`.
