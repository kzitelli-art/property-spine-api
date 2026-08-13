# Meeting Transcript — Storage Half

**Slice 1, storage only.** A meeting transcript becomes retained, citable
evidence: the file itself plus its ordered turns, each addressable.

**It is not wired to Ask Spine and cannot answer a question.** Retrieval waits
on the canonical fact envelope. Nothing in this slice reads a transcript back
into a conversational surface.

---

## 1. What shipped

```text
migrations/169_meeting_transcript_segments.sql   artifact kind + segments + immutability
src/meetings/meeting_transcript_parser.js        deterministic parser, pure
src/meetings/meeting_transcript_service.js       the canonical writer
src/meetings/meeting_transcript_ingest.js        POST /operator/meetings/transcript
src/onboarding/source_artifact_service.js        + meeting_transcript shape & refusal copy
server.js                                        mounts the ingest door
tests/meeting_transcript.test.js                 43 assertions, incl. the real specimen
tests/meeting_transcript_http_proof.js           31 assertions over real HTTP
tests/fixtures/meeting_transcript_specimen.txt   structural fixture (see §6)
```

## 2. The Eight Questions (§31)

1. **Real-world fact recorded** — a meeting happened on a date, and these
   people said these words in this order.
2. **Canonical service** — `meeting_transcript_service.ingest`. It is the only
   writer of `meeting_transcript_segments`, and it writes nothing else.
3. **Actor and scope** — a staff session. `property_id` and `uploaded_by_user_id`
   are both server-derived; neither is readable from the request.
4. **Durable object** — one `source_artifacts` row (`artifact_kind =
   'meeting_transcript'`) and N `meeting_transcript_segments` rows.
5. **Immutable history** — the segments *are* the history. UPDATE and DELETE are
   refused by a database trigger (`mts_immutable`), same mechanism as
   `lcoe_append_only` in 069.
6. **What else reads it** — **nothing, deliberately.** No surface consumes this
   yet. That is the slice boundary, not an omission.
7. **Missing data** — a transcript with no meeting date is refused. A file that
   cannot be fully parsed is refused whole and writes nothing.
8. **Classification** — see §5.

## 3. What the storage model refuses

| Refusal | Why it exists |
|---|---|
| no meeting date | there is no date inside a transcript; defaulting to upload date makes evidence age equal upload age forever |
| content above the first block | a title or attendee list would be silently dropped, and a silently dropped passage is invisible |
| timestamps going backwards | two recordings concatenated — the order can't be vouched for |
| a block with no speaker, or nothing said | a blank turn is not a turn |
| any non-`.txt` shape | the parser reads one grammar; a stored transcript Spine cannot quote is worse than a refused one |
| a partially-parseable file | **whole-file refusal.** A partial ingest reads as "the meeting did not discuss it" |

Every refusal returns a receipt written for the person holding the file — pinned
by an assertion that no receipt leaks an internal identifier and every one names
a next step. That assertion caught real copy: `unreadable_timestamp` originally
described the problem and told the operator nothing to do about it.

## 4. What it will not do

- **No model in the ingest path.** Segmentation is deterministic parsing. The
  moment a model segments a transcript, the record is the model's reading of the
  meeting rather than the meeting.
- **No repair, ever.** Not the speaker label, not the text. The real specimen
  says `$29.97` where the room meant $2,997, `route` where they said grout, and
  spells one colleague two ways in one meeting. Every one of those is a repair a
  reasonable person would make and Spine has no standing to make: the record is
  lossy in places Spine cannot locate, which makes a correct repair
  indistinguishable from a corruption.
- **No speaker identity.** There is no `person_id` and no confirmed flag on the
  table. A transcript label reading "Robert" is the same evidence level as
  "Unidentified Speaker" — they differ in content, not in standing (§12). The
  projection carries `person_id: null` and `speaker_confirmed: false` from day
  one so that adding confirmation later is not an API contract change.
- **No promotion.** Nothing here creates an obligation, work order, concession
  or person. If this service ever grows a write to another domain's table, that
  boundary has been crossed by accident.
- **No deal-scoped artifacts.** Property scope only. A deal may hold several
  properties, so a deal-scoped meeting reachable from a property session is an
  implicit traversal to another property's material.

## 5. Classification (§18)

| Component | Class | Removal condition |
|---|---|---|
| parser, service, table, trigger, route | **1** permanent | — |
| `MEETING_TRANSCRIPT_INGEST_ENABLED` + user allowlist | **2** | removed when a meeting-level audience model exists and can answer who may hear a given meeting |
| `content bytea` storage | **2** (inherited from 153) | object storage, when volume makes DB storage burdensome |

**The cohort gate is on the USER, not the property.** Entitlement answers *may
this person operate this property*; the cohort gate answers *may meeting
evidence exist for this person at all*. Entitlement cannot answer the second,
and the reason is in the first real specimen: one passage carries an occupancy
confirmation and a resident's hospitalisation in the same breath. There is no
module mapping that separates them. A property allowlist would activate the
property and hand the meeting to everyone assigned to it — the exact outcome the
gate exists to prevent.

Default is deny. Both switches unset means the door is shut.

## 6. Proof — what was measured, and what was not

**Reached:**

- **Unit, 43 assertions** — `node tests/meeting_transcript.test.js`. Pure; no DB,
  no model.
- **Real specimen** — the parser was run over the actual Weekly Solo transcript
  of 2026-08-11: **96 turns, 4 speaker labels, 5 timestamp collisions, 2,624
  words, running to 17:16.** Parses whole; sequence contiguous; collisions
  preserved as distinct turns; re-parsing yields identical references.
- **Real HTTP, 31 assertions** — `node tests/meeting_transcript_http_proof.js`.
  Real express app, real router, real multipart requests over a real socket.
- **All 19 source-governance gates pass** — `npm run verify`. Both new proofs
  are on that path.

**NOT reached — do not describe this as deployed:**

- **Not proven against real Postgres.** No `DATABASE_URL` in this environment.
  The HTTP proof uses a scripted stub, which is what makes "no insert ran" an
  assertable fact — but it means migration 169's DDL, the CHECK constraints, the
  unique index and the immutability trigger have **never executed**.
- **Not browser verified.** There is no UI. The route is reachable only by a
  direct multipart POST.

**The real Weekly Solo transcript is deliberately NOT in this repo.** It contains
a resident's health information and a compensation dispute; committing it would
put both in git permanently for the sake of a fixture. The committed specimen
reproduces every structural property — duplicate timestamps, an unidentified
speaker, consecutive turns from one person, a multi-line turn, a suspicious
number, a misspelling — and none of the content. Run the real one with
`--file <path>`.

## 7. ⚠ A deploy does NOT migrate

Migration **169 is not in the ledger**. `prestart` runs `migrate.js` in
verify-only mode, so merging this and hitting deploy produces a **failed deploy**
— Render keeps the previous instance live and the API looks fine while the
schema is simply absent.

```
MIGRATION_RELEASE=1 EXPECTED_LEDGER_CEILING=<read from the ledger> \
  EXPECTED_SHA=<deployed sha> node migrations/migrate.js --apply
```

## 8. A defect this build found in itself

`refuseClientProperty` was copied from `ask_spine.js`, where it sits in front of
the handler and works because `express.json()` has already populated `req.body`.
On this **multipart** route nothing had parsed the body at that point, so
`req.body.property_id` was `undefined`, the check passed vacuously, and a
cross-property `property_id` returned **201**.

The guard was real. Middleware order made it inert — which is worse than no
guard, because the route reads as protected. Only a real HTTP request found it;
source inspection would not have, and the unit proof did not.

The HTTP proof is on the standard gate path for exactly this reason.

## 9. Corrections to earlier claims in this thread

- Timestamp collisions in the real specimen: **five**, not four. Counted by eye
  first, which missed `15:09`. The parser counted them.
- Turn count: **96**, not the ~110 estimated by eye.
- Token estimate for one meeting: ~2,624 words, so roughly **4k tokens**, not the
  15–20k estimated earlier — off by about 4×. This extends the runway for
  whole-transcript retrieval well past one meeting.

## 10. Open, and deliberately not built

- `docs/ASK_SPINE_SLICE_3_MEETING_INTELLIGENCE.md` and
  `docs/ASK_SPINE_CANONICAL_READ_LAYER.md` are referenced by the Slice 3 update
  but **exist in no branch or commit of this repo**. Searched: `docs/`, `src/`,
  `migrations/`, `server.js`, `git log --all --name-only`, all branches.
- The fact envelope (`source_authority`, `transcript_claim`, `READ_FAILED`,
  `READ_TIMED_OUT`, four silences) exists nowhere in source. Retrieval consumes
  it and therefore waits for it.
- Speaker confirmation (Tier 2) — its own table, one row per (artifact, label),
  carrying who confirmed and when. Not built.
- Meeting-level audience model — the condition that retires the cohort gate.

## 11. §42 — where the quote rule binds

PHILOSOPHY §42 (*Recorded Speech Is Quoted, Never Paraphrased*) is doctrine as
of this slice. The storage half already satisfies its storage-side obligations:

- segments are immutable at the database, so a quotation cannot drift
- nothing in the ingest path repairs the text
- `readSegments` returns `verbatim_text` straight off the row, pinned by an
  assertion that the projection does not repair the number it carries

**The structural enforcement point is not built, because the code it constrains
does not exist yet.** §42 requires that the retrieval reply carry passage
identifiers and no field the words could travel in — that is a response schema,
and it lands with the retrieval slice.

**Condition:** the first commit that sends transcript text to a model must
introduce that schema in the same commit, and pin it with an assertion that the
model's reply has no text-bearing field. Shipping retrieval with the rule as a
prompt instruction would be §42's own stated failure mode, and migration 092's
lesson repeated: a contract at the read layer, unbacked at the storage layer.
