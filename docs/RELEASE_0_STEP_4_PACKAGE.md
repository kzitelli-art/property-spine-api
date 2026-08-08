# Release 0 — Step 4: the handset completion proof package

**§7.4 is the release's load-bearing gate.** Under Option A it is the only way
genuine evidence ever reaches a proof evaluation.

```text
a real handset · a real inbound photo · a real preserved attachment with a
storage state, a MIME type and a digest · claimCompletion completes a real
work order · the operator surface reflects it without operator action
```

It happens **once**, with a human holding a phone. There is no second attempt and
no debugging window. So everything that can be built, proven and falsified before
that moment is built, proven and falsified here.

**Blocked on one thing only: Twilio.** The inbound webhook refuses with 503 before
reading anything when the transport is unconfigured, so no message can reach the
technician turn. Every other condition is checked, and the preflight names the
blocker rather than failing obscurely.

---

## The package

```text
tools/step4/completion_facts.js   the eight facts, checked by name
tools/step4/rehearse.js           proves and FALSIFIES those checks in isolation
tools/step4/preflight.js          production, read-only: can we attempt this?
tools/step4/prove_completion.js   production, read-only: did it happen, and the receipt
tools/step4/_ro.js                the shared proven-read-only guard
```

### The assertions are proven before they meet production

`rehearse.js` drives a real completion through the canonical service against
isolated PostgreSQL and runs the **same functions** `prove_completion.js` will run.
Then it mutates each fact away and proves the matching check goes red.

**Unproven assertions pointed at production is how a green receipt gets written
over a hollow completion.**

```text
tools/step4/rehearse.js   48 / 48   exit 0
```

---

## The eight facts (§4), and how each is observed

```text
F1    the completion claim              work_order_progress kind='completion_claimed',
                                        reported by the bound actor
F1b   …traces to the inbound message    its source_comm_event_id is the bound event
F2    evidence real, preserved,          every evaluated attachment: stored, sha256,
      classified                         byte_size, stored_at, verified MIME, and a
                                         classification in the §3.1 corrected array
F2b   …and the array matches the          the proof and the reader agree about what
      reader's                            counts as proof — two copies that drift is
                                          the §3.1 defect one level up
F3    the proof evaluation               a head exists, state='satisfied'
F3b   …one linear chain                  exactly one genesis; no fork
F4    links fully scoped                 every link carries this work order AND property
F5    status = 'complete'                work_orders.status
F6    the distinct `completed` row       exactly one, and not the same row as F1
F7    the owning obligation closed       complete, resolution 'satisfied', completed_at
F8    the action receipt                 a work_order_completed event naming the
                                          progress row, the work order and the actor
```

Plus the no-parallel-writer set (§4.1, §19c Ruling D):

```text
N1    no legacy `work_order_closed` event for this work order
N2    the completion rests on preserved attachments, not a legacy column string
N3    exactly one governed completion
N4    exactly one evaluation head
```

---

## ⚠ The capstone found something, and it was about our own savepoint

"All eight or none" is a claim about a **transaction**, and PostgreSQL records the
transaction that wrote every row in `xmin`. So the first capstone asserted that all
eight facts share one `xmin` — atomicity read off the rows rather than inferred
from the writer's source.

**A genuine, correct, atomic completion failed it, with three distinct ids.**

Not a bug in the writer. A bug in the assertion. `appendProgress` wraps its insert
in `SAVEPOINT append_progress` — the duplicate-recovery fix deployed earlier in
this release — and **PostgreSQL gives every subtransaction its own xid**:

```sql
begin; insert A; savepoint s; insert B; release s; insert C; commit;
--  A → 996      B → 997 (subtransaction)      C → 996
```

So the two progress rows and their events carry subtransaction ids while the
evaluation, links, status and obligation carry the parent. They still commit
together — that is what a subtransaction *is* — but `xmin` equality cannot see it.

Splitting the claim in two is what makes it honest:

```text
A1   the SAVEPOINT-FREE facts share one transaction id.
     Always available, and exact — nothing separates those four writes.

A2   ALL facts share one COMMIT TIMESTAMP.
     The real atomicity question, since a subtransaction commits with its
     parent. Needs `track_commit_timestamp = on`, which is OFF by default.
     When off, A2 reports INDETERMINATE and says why. It never reports
     "not atomic" because the server could not answer.
```

**An indeterminate capstone is recorded in the receipt, never rounded up to a
pass.** If the owner wants A2 conclusive in production, `track_commit_timestamp`
must be on before the handset test — it is a server setting, not a code change, and
it is the owner's call.

---

## Falsification — every fact can fail

```text
V·F1    delete the completion claim               → F1 red (F1b, F6 legitimately follow)
V·F1b   unlink the claim from its message         → F1b red
V·F2    un-classify the evaluated attachment      → F2 red
V·F2    un-preserve it entirely                   → F2 red
V·F5    leave the work order open                 → F5 red
V·F6    delete the distinct `completed` row       → F6 red (F8 follows)
V·F7    reopen the owning obligation              → F7 red
V·F8    delete the action receipt                 → F8 red
V·A1    touch the work order in a LATER txn       → A1 red
W1      a legacy closeout event exists            → N1 red
W2      a second `completed` row exists           → N3 red
```

Each variant declares the facts that **legitimately** fall with it. Deleting the
claim really does make "traces to its message" and "distinct from the claim"
unanswerable — those are dependencies. Declaring them beats demanding surgical
isolation everywhere (which would be false) or dropping the check (which would let
one mutation quietly redden half the set).

### The hollow completion is built, not mutated

```text
H1   it LOOKS complete — status, both progress rows, obligation, receipt
H2   …and the evaluation facts REFUSE it       (F3, F3b, F2, F4 red)
H3   …so no receipt can be written
H4   a real evaluation cannot be deleted at all — append-only, ENFORCED
```

**This is the scenario Release 0 exists for**, and it had to be *constructed*
rather than produced by mutating a good completion: `work_order_proof_evaluations`
and its link table are append-only, and the database refused every attempt to edit
or delete a genuine evaluation. **The schema refusing the mutation is itself part
of the proof** — every assertion above rests on the evaluation chain being
untamperable, and `H4` shows it is.

Two other schema guards fired during construction and are worth recording:
`ck_wopa_stored_is_complete` refused a half-un-stored attachment (the four durable
fields move with the state or not at all), and the `storage_state` vocabulary
refused an invented value. Both are the database doing its job.

---

## On the day

```bash
#  1 · PREFLIGHT — before anyone sends anything
TEST_FROM='+1XXXXXXXXXX' node tools/step4/preflight.js
```

It checks the ledger and the 137 objects, transport credential **presence**, the
single active operations line, the tester's resolution and active maintenance
assignment, the activation state, and it **chooses a safe target work order** —
then prints `T0`.

**It chooses the target on purpose.** An operator picking one on the day is how
the Gate 8 evidence row nearly got completed by accident: work order **1006** holds
a real preserved photo, so a bare "done" against it would close instantly. It is
excluded by number, and every candidate is checked for already-present completion
facts, an existing evaluation, and an owning obligation to close.

It also refuses a candidate that **already has a stored photo**: that would close
on the first "done" before the tester sent a picture, which proves the writer but
never exercises MMS ingress — and under Option A the ingress is the point.

```bash
#  2 · SEND — one MMS from the tester handset to the operations line:
#            a repair photo, completion language, naming the work order

#  3 · VERIFY
TEST_FROM='+1XXXXXXXXXX' node tools/step4/prove_completion.js \
  --wo <ref> --t0 '<T0 from preflight>'
```

Nothing is credited by recency. The inbound message must postdate `T0`, arrive on
the operations line, come from the resolved tester, carry the provider's own sid,
**and be the message the completion claim actually cites**. The work order is named
on the command line and never discovered.

### Both production tools are proven read-only before they read

They open a read-only transaction and prove it by attempting a write and being
refused, *before* the first read — the shared guard from the activation tools,
re-exported rather than copied. **The completion is performed by the technician's
message through the canonical service. Neither tool writes anything, ever.**

---

## The receipt

Emitted **only** when every named fact holds. Not "N checks passed" — every fact is
named, checked by name, and one absent fact refuses the receipt entirely.

It records the binding (work order, line, tester, T0, inbound event), every fact
with its verdict, the atomicity capstones **including whether A2 was
indeterminate**, the surface state, and the ledger it was generated against.

### One clause may not be dischargeable yet

`prove_completion.js` reports `surface_clause_discharged`. With **no cutover
activation** the reader correctly answers `read_status: "unavailable"` and omits
`state`/`satisfied` (§3.2.1) — so §7.4's *"the operator surface reflects it"*
clause cannot be closed. The tool says so plainly rather than accepting the
unavailable read as a pass.

**Either run Step 7 first, or accept a receipt with that clause open and re-run
afterwards.** That is a sequencing decision, not an engineering one.

---

## What this package does NOT do

```text
NOT done     it has not been run. Twilio is unconfigured; the webhook refuses
             at the door.
NOT done     no production row has been read or written by any of it.
NOT built    it does not send the message. A human and a handset do.
NOT decided  whether Step 7 runs before or after the handset test. The tool
             reports both outcomes honestly; the order is the owner's call.
proven       the assertions themselves, against real PostgreSQL — green over a
             genuine completion, red over every single-fact mutation, and red
             over a hollow completion carrying every outward sign.
```
