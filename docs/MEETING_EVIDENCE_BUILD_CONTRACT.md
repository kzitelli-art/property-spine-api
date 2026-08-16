# Meeting Evidence — Build Contract

**Version 1.** Governs how recorded conversation enters Property Spine and what
Spine is permitted to conclude from it.

Doctrine: `PHILOSOPHY.md` §40 (Ask Spine), §40.4 (source authority), §42
(quote, never paraphrase), §43 (recorded conversation as evidence).
Storage receipt: `MEETING_TRANSCRIPT_STORAGE_RECEIPT.md`.

---

## 1. What meetings are, precisely

> **Meetings are the highest-density recurring source of cross-domain operating
> reasoning.**

Not the *only* source of reasoning — texts, emails, calls and work-order notes
carry it too. What makes a meeting distinct is density and span: seventeen
minutes crossing Leasing, Maintenance, staffing, vendors, a resident dispute,
marketing and an owner decision, while preserving **why people thought what they
thought**.

That is something a rent roll or a work-order state cannot give.

**Meetings are not a privileged second truth system.** They are another evidence
source into the same Spine, at `transcript_claim` authority under §40.4, and
nothing about their richness promotes them.

### Two consequences

**Meetings are an orthogonal plane, not a layer.** §36's stack is vertical; one
meeting cuts across it. Which is why a meeting never gets a home of its own — a
reference travels onto the objects it produced (§43), and nothing else in the
system learns what a meeting is.

**Meetings are live requirements research.** §31's question 1 asks what an
authorized person will ask about a domain. The recordings answer it empirically,
week after week. The 2026-08-10 specimen alone names leasing pipeline,
availability by date, short-term pricing, concession authority and structure, a
unit-level dispute with unknown magnitude, occupancy, vendor performance, turn
capability by person, staffing coverage, and a marketing opportunity — with the
operator's own phrasing attached to each.

Collecting meetings is therefore requirements collection, not only evidence
collection, and it compounds.

---

## 2. The corpus we are actually building

Not a collection of transcripts. Four columns:

```text
what was said
    → what Spine believed it meant
        → what a human says it actually meant
            → what operating truth, if any, should have changed
```

Column 1 is evidence and immutable. Column 2 is reproducible and disposable.
Column 3 is the gold label. Column 4 is the only one that ever touches a
canonical service.

**Negative examples are as valuable as positive ones.** *"Spine must NOT
conclude X from these words"* is doctrine, and as instances accumulate they are
promoted into `PHILOSOPHY.md` rather than left in a dataset.

---

## 3. Sequencing — FROZEN

The first unsolved problem is **not** candidate supersession. It is:

> **What is Spine allowed to conclude from a sentence?**

An extractor that cannot tell a proposal from a decision produces garbage, and a
supersession engine over garbage is a sophisticated way to manage garbage.

### The worked example this ruling comes from

The 2026-08-10 roommate discussion is not `question → decision`. It is:

```text
1:20   question              can the one-month-free apply to a 10-month lease?
2:02   constraint            short-term pricing should follow a scaled schedule
2:33   constraint            marketed on 12-month; September move-in is not ideal
3:30   proposal              one month free, structured for two to cover a 3BR
4:01   alternative proposal  take the two non-en-suite bedrooms; reserve the third
4:37   reported constraint   co-ed matching limits who will share
4:46   revised proposal      honour the free month IF they take those two rooms
13:56  conditional authority restated — free rent on the 10-month lease if they
                             work with us to lease the third
14:54  commercial ruling     if they pay full apartment rent they choose rooms
15:09  condition             no guarantee a third is found; on the hook for full
                             rent for the 10 months
15:35  mechanics             free month spread across the term, twos and threes
```

Eleven utterance types in fifteen minutes. Emit a candidate per mention and most
are wrong.

**Unit 527 is the sharper case.** Kandice reports a resident complaint. Robert
does **not** rule on compensation — his operative instruction is *clarify what
they are actually claiming*.

```text
WRONG    527 resident entitled / not entitled to compensation

RIGHT    reported claim  527 residents say the bathroom-door configuration
                         differs from the floor plan and may affect bed
                         placement
         uncertainty     unclear whether a full-size bed cannot fit at all,
                         or merely not where they intended
         next action     Kandice to clarify the resident's claim
         decision        none yet
```

That capability is more fundamental than supersession, and it is built first.

---

## 4. The interpretation vocabulary — DRAFT, to be refined against real meetings

Minimum distinctions Spine must make before any candidate is operational:

```text
reported fact        someone states something as true of the world
observation          someone reports what they saw or were told
question             asked, not answered
proposal             put forward, not agreed
decision             an authority ruled
instruction          a named next action
commitment           someone undertook to do a thing
unresolved issue     raised and left open
correction/revision  modifies something said earlier
```

Every extracted item carries:

```text
subject              what it is about, bound to a durable object where one
                     exists — property, unit, vendor, work order, lease,
                     person — and UNATTACHED where none does (§43)
relevant time        the time it concerns, distinct from when it was said
speakers             raw labels only, never resolved (§43)
supporting segments  passage ids — the item is fetched by id, never quoted
                     from the model's output (§42)
modifies             a reference to an earlier item, if it revises one
```

### Where §42 binds, and where it does not

The candidate text above — *"527 residents say the bathroom-door configuration
differs from the floor plan"* — **is a paraphrase.** Kandice's actual words were
longer, messier, and contain the hedge that matters. So the extraction layer
produces paraphrase by construction, and §42 forbids paraphrase. Both are true,
and the boundary must be explicit or the rule will be breached by accident.

```text
A CANDIDATE          Spine's INTERPRETATION. Column 2 of §2. Explicitly
                     non-authoritative, always carrying passage ids.
                     MAY summarise.

AN ANSWER            what Spine says on a speaker's behalf.
                     MAY NOT. §42 binds absolutely.
```

**The failure path is a candidate's paraphrase leaking into an answer and
reading as speech.** It is the most likely way §42 gets broken, because the
paraphrase will already exist, already be attached to the right passages, and
already read well.

Three rules follow:

1. **A candidate is never rendered as a quotation**, and never inside quotation
   marks. It is labelled as Spine's reading, or it is not shown.
2. **Candidate text and segment text never share a field.** Different columns,
   different names, different types — so a renderer cannot substitute one for
   the other, and a reviewer can always see both.
3. **Any surface showing a candidate shows the supporting passages with it**,
   verbatim, fetched by id. The interpretation never travels without the words
   it came from.

The gold-corpus review in §5 depends on this: a reviewer marking `overclaimed`
is comparing column 2 against column 1, and cannot do it if the paraphrase has
displaced the record.

### Nested attribution — an open gap

`reported claim` in the 527 example is a claim **about a claim**: a resident's
assertion, relayed by staff, recorded by a transcription system. §40.4's
`source_authority` has one level and does not express this.

Spine must not flatten *"Kandice said the residents say X"* into *"X."*
**Unresolved — decide before the extractor emits reported claims.**

---

## 5. What is released now, and what is not

### Releasable — accretive, and we know we want it

**Immutable raw meeting storage**, conditional on two proofs:

```text
1  migration 169 executes against real Postgres, and the immutability
   trigger is observed REFUSING an UPDATE
2  the parser is proven against a REAL Read AI export file — not pasted
   text
```

Condition 2 is not optional. The parser's grammar was inferred from a transcript
pasted into a chat message, and paste normalises. A real export may carry a BOM,
CRLF, a title or attendee block, or an **en dash instead of a hyphen** in the
separator. Any of those is a whole-file refusal — correct behaviour, and a
silent-to-us pipeline failure on the day it matters.

### Store from the source, never from memory

The following come from the **source artifact**, and are captured from meeting
one because they cannot be reconstructed later:

```text
original export bytes + sha256      the evidence
provider + provider meeting ID      the stable anchor (§29: identity is
provider series ID                  address, not display name)
title as provided
meeting date and provider timestamps / timezone
raw attendee list                   how speaker confirmation eventually works
raw speaker labels                  never normalised
immutable transcript segments       sequence is identity, not the timestamp
```

**Schema for the provider fields is NOT designed yet, deliberately.** Designing
columns for an export nobody has seen is the same error as inventing a date —
see §7. It is designed against the real file, in the same slice that proves the
parser against it.

### NOT released — extraction stays a review layer

Candidate extraction runs, and its output is **not operationally actionable**.
It does not create obligations, work orders, concessions or persons. For the
first several meetings it exists to be reviewed, not consumed.

Nothing is lost by this and something is gained: the corpus accumulates while
immature interpretation is prevented from manufacturing false canonical truth.

**Every extraction run records:** source meeting, model and version, extraction
contract version, run timestamp, and the exact supporting segments. Aug 10 must
be re-runnable in six months with a better extractor **without changing what was
actually said.** Extraction is reproducible; it is never authoritative.

### Review verdicts — the gold labels

Per candidate, a human records one of:

```text
correct · wrong · incomplete · overclaimed · missed
```

`overclaimed` and `missed` are the two that teach the most. `missed` cannot be
captured per-candidate by construction — it requires reviewing the meeting, not
the output.

**Open: who reviews.** This is real operational labour on people with day jobs.
It must be budgeted and named, not assumed.

---

## 6. Then, and only then — candidate lifecycle

Once 5–10 real meetings are reviewed, the supersession shapes are derived from
what actually occurred rather than invented now. Expected, unconfirmed:

```text
decision changed · decision clarified · proposal abandoned ·
unresolved item resolved · fact corrected · commitment fulfilled ·
issue still open
```

An undrained candidate queue becomes exactly the status users learn to manage
cosmetically (§15). That is the failure this stage exists to prevent — but it is
prevented after the vocabulary exists, not before.

---

## 7. The error this contract was written around

The specimen meeting is **Monday 2026-08-10**.

For three commits this repository asserted **2026-08-11** — a Tuesday — in the
parser header, the migration and the storage receipt. Nobody was told that date.
The author needed one, did not have one, and produced a plausible one. It then
propagated into two more files as though it were sourced.

Nothing in a transcript contains its date. That is why the ingest **refuses** a
transcript with no meeting date, why the date must come from the source
artifact, and why §5 above insists on provider identifiers and timestamps from
meeting one.

The failure this build exists to prevent occurred inside the build, in a
comment, and survived three commits and a doctrine review before an operator
caught it.

---

## 8. Frozen rulings

1. Meetings are the highest-density recurring source of cross-domain operating
   reasoning — **not** a privileged second truth system.
2. Interpretation vocabulary precedes candidate lifecycle. Supersession is not
   the first problem.
3. Extraction is reproducible and versioned; it is never authoritative.
4. Extracted candidates are not operationally actionable until reviewed shapes
   exist.
5. The source is never repaired — `$29.97`, "Thailand", "route" all stand (§42).
5a. **Quote, never paraphrase, is absolute in an ANSWER** (§42). A candidate is
   Spine's interpretation and may summarise; it is never rendered as a
   quotation, never shares a field with segment text, and never travels
   without the passages it came from.
6. Speaker labels are never resolved by inference (§43).
7. Meeting date, identity, speakers, bytes, timestamps and provider IDs come
   from the source artifact, never from memory.
8. Property-scoped artifacts only; deal-scoped are out of scope.
9. The cohort gate is per-user, default deny, until a meeting audience model
   exists.

## 9. Open, and named as open

- Nested attribution — a claim about a claim (§4).
- Entitlement composition across domains — §40.8, unsolved.
- Who performs gold-corpus review, and at what cost.
- Cross-meeting comparison — a distinct capability class (§40.10), not claimed,
  and likely wanted by meeting four.
- Speaker confirmation (Tier 2) — until it exists, *"what did Kandice say?"* is
  structurally unanswerable.
