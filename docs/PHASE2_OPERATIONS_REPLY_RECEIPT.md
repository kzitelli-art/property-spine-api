# Phase 2 — reply-only operations line + technician acceptance · PROOF RECEIPT

**Status: PROVEN against real PostgreSQL 16.13 and real HTTP.**
Not merged, not deployed, not production-active.

| | |
|---|---|
| Branch | `claude/conversational-seams-and-technician-loop` |
| Database | PostgreSQL **16.13**, local disposable cluster, `HARNESS_DATABASE_URL` only |
| Migrations claimed | **131**, **132**, **133** — verified free across every remote branch |
| Run at | the commit this document is committed in — **re-prove at whatever SHA merges** |

| Harness | Result | Exit |
|---|---|---|
| `technician_route_proof.db.js` — **real HTTP + real DB** | **48/48** | 0 |
| `technician_acceptance.db.js` | **32/32** | 0 |
| `operations_reply_policy.db.js` | **32/32** | 0 |
| `communication_lines_slice_a.db.js` | **61/61** | 0 |
| `property_line_hardening.db.js` | **41/41** | 0 |
| `migration_ledger_inverse_gate.db.js` | **24/24** | 0 |
| `npm run verify` (6 source gates) | **PASS** | 0 |

---

## 0. A correction to the last update

I reported that no PostgreSQL server existed in this session. **That was wrong.**
A stopped `16 main` cluster was present the whole time; I checked for the client
and for a running server and concluded from the wrong evidence. Starting it took
one command.

Everything the previous receipt listed as *built-but-dormant pending a database*
is now proven, and Slice A's 61/61 has been re-earned at this tree rather than
inherited from `d467808`.

---

## 1. The ruling, made structural

> The operations line may send outbound under a strict `reply_only` policy. Do
> not simply flip `outbound_enabled=true`.

Migration **132** replaces the boolean with a three-state policy —
`disabled` / `reply_only` / `proactive` — and enforces the ruling by
constraint, not by convention:

| The ruling says | The database says |
|---|---|
| operations → `reply_only` | `ck_cl_outbound_policy_by_type` permits an operations line only `disabled` or `reply_only`. **`proactive` is a value it cannot hold.** |
| property-facing → existing policy | backfilled to `proactive`, because that is what they already are. Consent and eligibility gates untouched. |
| no proactive pushes, reminders, broadcasts | not unbuilt features — **rows that cannot exist** |
| no resident messaging from the operations number | trigger refuses any operations-line outbound carrying `person_id` |
| a reply must bind to inbound, sender, thread, reason, key | all five required by trigger; missing any one is refused by name |
| no OTP, no third parties | `reply_reason` is a frozen five-value vocabulary; nothing else is storable |

**This is 130's documented removal, not an exemption.**
`ck_cl_outbound_disabled_slice_a` was written with its own removal condition —
"removed when the technician loop introduces governed outbound" — and what
replaced it is stricter in every direction.

### The conversation thread — a product-model call I made

`conversations.property_id` and `person_id` are both `NOT NULL`, and three later
migrations depend on that. A staff coordination thread has neither a property
(the operations line establishes an *organization*) nor a person (staff are
`users`).

I did **not** loosen the resident model to fit. Intra-organization coordination
and a tenant's communication record are different objects with different
participants and different retention, so they get different tables:
`staff_threads`. `ck_comm_one_thread` makes a comm_event on both a resident
conversation *and* a staff thread unexpressable — that is exactly how a
technician's message would otherwise end up in a resident's record.

**Flagging it because it is a model decision, not a mechanical one.**

### Work Order 1042 did not exist

Your example receipt names a number no work order has. `work_orders` is
identified by uuid, and nobody texts a uuid. Migration **133** adds
`work_order_ref` from a global sequence starting at 1000, defaulted at the
column so no code path can forget it and `NOT NULL` after backfill.

Global rather than per-building on purpose: a technician on two properties
texting "42" would be ambiguous for a reason that is purely our numbering — a
clarification caused by the schema instead of by the world.

---

## 2. The receipt boundary, proven in both directions

```
inbound recorded → authority resolved → canonical service commits
  → operating receipt composed FROM THE COMMITTED ROW
  → outbound reply intent persisted → COMMIT
  → transport attempted → delivery recorded separately
```

`Acceptance recorded. Work Order 1042 is assigned to you and in progress.` is
composed after the write and sent after the commit. Proven:

- **transport fails** → the obligation stays `in_progress` and owned; the intent
  is persisted and marked `failed`; the inbound is flagged for a human. The
  acceptance is never rolled back and the reply is never reported as delivered.
- **transport throws** → treated as a failed delivery like any other, same
  result. (The resident path's §15.2 lesson, applied here from the start.)
- **the service refuses** → no success receipt exists to send; the composer
  returns a null text and the turn rolls back rather than acknowledging
  something that may not exist.

---

## 3. Every proof you asked for

| Required | Where | Result |
|---|---|---|
| authorized technician accepts assigned work | route proof §1 | obligation `in_progress`, owned, one immutable event, one reply-bound intent |
| unauthorized technician changes nothing | §3 | byte-identical row-count vector before/after; nothing on the wire |
| property-facing line grants no staff authority | Slice A 61/61 | unchanged — a fully resolvable staff sender still gets `authority_ceiling='external'` |
| ambiguous property or work context asks | §4, §5 | clarification, never a pick; the answer names no work they cannot see |
| replay does not duplicate acceptance or reply | §2 | redelivery writes **nothing** — proven as a full row-count vector |
| stale work state refused | §7 | completed work and another technician's work both untouched |
| acceptance commits when delivery fails | §8 | both the failing and the throwing transport |
| failed acceptance never produces a success receipt | §5, receipt harness §9 | eight refusal paths return `text: null` |
| no real credentials, numbers or sends | §10 | reserved `+1 (212) 555-01xx` asserted over every row; every sid harness-minted; the double never imports Twilio |

Plus the three governed reference sources, each proven separately: **explicit**
(and that it outranks the thread), **thread**, **assignment** — and that a
message may never establish its own actor or property by asserting one.

---

## 4. ⚠ Two defects this round found in my own work

**1. `"accept 1042"` extracted no reference at all.**
The extractor required a `wo`/`#`/`ticket` prefix or a message that was *only* a
number. The single most likely thing a technician types matched neither.

The first run of the route proof was **green anyway** — with exactly one
assigned item, the turn fell through to the `assignment` source and produced the
right answer for the wrong reason. Fixed in two places: the extractor now takes
a standalone 3–8 digit number (safe because migration 133 starts refs at 1000,
while counts people write in sentences are one or two digits), and the proof now
plants a **decoy** second item so a lucky fallback can never pass for an explicit
reference.

**2. Migration 132 had an ordering bug that would have failed in production.**
It backfilled `outbound_enabled = true` *before* dropping 130's blanket ban. On
an empty table that passes, because the backfill updates nothing — which is why
two harnesses missed it. On any database that has actually run 130 — every real
one, since 130 backfills a line per property holding a number — the migration
dies.

`communication_lines_slice_a.db.js` caught it. The ban is now lifted first, with
its replacement installed in the same transaction, so there is no committed
state in which outbound is ungoverned.

---

## 5. Still not proven, and why

**`resident_sms_work_order_proof.js` and `resident_sms_route_proof.js` have
still never run against these changes.** Local PostgreSQL did not clear them:
they build no schema of their own and need a full-schema copy.

I re-attempted the full migration chain from empty against real PostgreSQL
16.13. It stops exactly where it is documented to:

```
STOPPED at 012_bank_intake.sql
   column "yardi_code" does not exist
```

So `docs/UNBLOCK_2_FULL_SCHEMA_HARNESS_DATABASE.md` stands unchanged — those two
need a disposable branch of production, and **that is now the only outstanding
proof blocker on this branch.** Everything else it listed is done.

---

## 6. Before this merges

1. The two resident proofs, against a disposable branch of production.
2. Migration **129** activated (`docs/UNBLOCK_1_MIGRATION_129_ACTIVATION.md`).
3. **130, 131, 132, 133** re-confirmed free immediately before merge.
4. Release order **129 → 130 → 131 → 132 → 133**, each with a fresh
   `EXPECTED_LEDGER_CEILING`.
5. Every proof re-run at the exact SHA that merges.

---

## 7. Next — the technician lifecycle

The acceptance turn is the skeleton every following verb reuses: resolve
authority → resolve exactly one authorized work order → canonical service →
operating receipt from the committed row → reply-bound outbound → delivery
recorded separately.

```
on my way → no access / blocked → findings → photos
  → governed completion → verified resident update
```

Two of those need decisions the model does not yet answer, and I will raise them
when the work reaches them rather than now: **photos** need durable media
storage the operations line has no rail for, and **the verified resident update**
must cross from the operations line to the property-facing line — the one place
where a technician's action legitimately becomes a resident-facing message, and
the place where "the operations line does not impersonate the resident thread"
has to be enforced structurally rather than remembered.
