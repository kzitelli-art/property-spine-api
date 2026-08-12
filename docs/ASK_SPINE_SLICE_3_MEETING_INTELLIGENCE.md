# Ask Spine Slice 3 — meeting intelligence, design input

Written at the close of the Ask Spine composer thread, as the direct input to the
build of **meeting evidence retrieval**. Nothing here is built. This is the record
of what the owner asked for, what a real transcript proved about it, the four
rulings the owner then froze, the assertion contract those rulings imply, and
**the seam that keeps a conversational surface from dissolving them** (§4).

State at the time of writing:

```text
api main            7ebb400      (PR #97) deployed
app main            bf86673      (PR #57) deployed
migration files     through 161  ledger ceiling NOT confirmed from this session
                                 (no DATABASE_URL here — confirm before writing 162)

api branch   claude/ask-spine-conversational-dash-97bwcx   NOT MERGED
             carries `references[]`, both design docs, and PHILOSOPHY.md §40
app branch   claude/ask-spine-conversational-dash-97bwcx   NOT MERGED
             carries the proof-verdict contract pin
```

The branch heads move; **`NOT MERGED` is the durable fact.** Verify with
`git merge-base --is-ancestor` rather than trusting this block.

**The `references[]` dependency is a release-order item, not cleanup.** See §9.

---

## 1. The objective, as the owner wrote it

Quoted rather than paraphrased, because the framing is the specification:

> A meeting transcript is authoritative evidence of what was said. It is not
> automatically authoritative truth about the property. If someone says "the
> elevator is fixed," Spine can know with confidence that the person said it.
> That statement should not silently overwrite the actual elevator/work-order
> state.

The flow:

```text
meeting → transcript stored in Spine → attributed passages
       → property-scoped retrieval → Ask Spine answer with source
```

The first slice is **read-only**. Meeting statements create and modify nothing.

The questions it must answer, all five of which a real transcript already
supports (see §8):

```text
What did we say about Unit 527?
What did Robert say about the roommate deal?
Did we discuss the freight elevator last week?
When did we last talk about short-term lease pricing?
What was Kandice worried about with the bedroom layout?
```

---

## 2. ⚠ THE CORRECTION A REAL TRANSCRIPT FORCES

The owner supplied the Weekly SOLO call of **Mon, Aug 10 2026** as the demo
reference. It validates the product idea and it falsifies one sentence in the
brief above — the load-bearing one — so the correction is frozen here before any
schema is written.

**The brief says Spine can know *with confidence* that the person said it.**
Read against the artifact, that is one derivation too strong. What Spine holds is
a machine transcription of a recording. Three layers, not one:

```text
what was said                    the fact
what the recording captured      lossy
what the transcriber rendered    lossy AND confidently wrong
```

Not a hypothetical about transcription quality in general. This is what is in
the file the owner sent:

| In the transcript | Almost certainly | Why it matters |
|---|---|---|
| `$29.97` for a three-bedroom | `$2,997` | An economic figure, off by 100× |
| `Amory` / `Anne-Marie` | one person | Two spellings, same call |
| `Indina` / `Adina` | one person | Two spellings, same call |
| `American Spass Door Company` | a real vendor | Mangled proper noun |
| `Bank Cent` | a cleaning vendor | Mangled proper noun |
| `Thailand` (departing) | a staff member's name | Mangled proper noun |
| `the really bad route in the bathrooms` | `rot` | Changes a maintenance fact |
| `Unidentified Speaker` × 8 turns | unknown | The source itself admits ignorance |

Two consecutive `Robert Vernicek` turns at 7:47 and 7:52 are a diarization split
of one utterance. And at 6:55 the speaker flags her own numbers as provisional
inside the recording: *"I don't have Katie's beautiful report"* … *"Let me
confirm."*

### ▶ THE PHRASING RULE — FROZEN

**Until a passage is human-confirmed, Ask Spine says what the transcript records,
not what a person said.**

```text
SAY      "The transcript records Robert as saying …"
NOT      "Robert said …"
```

That is not hedging copy. It is the only formulation the evidence supports, and
it is the surface form of the contract in §3.

### And three rules that follow

**1. Quote. Never paraphrase a number, name, or amount out of a passage.**
The answer shows the passage verbatim and lets a human read it. If Ask Spine
renders *"Kandice said the three-bed would be $29.97,"* that is §5
confident-wrong sourced from a genuine passage, and it reads as **more**
trustworthy than an ordinary model error because it carries a citation. A
citation that launders a transcription error is worse than no citation.

**2. `Unidentified Speaker` is preserved, never resolved.** The transcriber
already gave the honest blank. Spine's job is not to spend it. No inference from
adjacent turns, no "probably Kandice."

**3. A speaker label is not a Person.** `Amory` and `Anne-Marie` string-match to
two different people and neither may exist in Spine. Speaker → Person is a
**confirmed mapping**, human-made, stored apart from the segment. Same seam as
`references[]` in the composer slice: the model never resolves an identity, the
server does, and only from something recorded.

None of this weakens the product. It is the argument *for* the read-only
boundary, and it turns the `said → confirmed → decision` ladder from a
nice-to-have into the mechanism where transcription error dies.

---

## 3. The assertion ladder — a data contract, not prose

The owner's ladder, given a shape each tier can be stored and queried in.

**The governing rule: a tier is never inferred from the tier below it.**
Promotion is an act by a person, with a recorded actor and timestamp. Nothing
walks up on its own, ever. And every tier keeps a pointer down, so any answer at
any altitude can be walked back to the verbatim passage.

### TIER 1 · TRANSCRIPT CLAIM

```text
says            "The transcript records Robert Vernicek as saying …"
storage         the segment. Immutable, append-only, never edited.
entered by      ingest
asserts         ONLY that the source rendered these words, under this label,
                at this offset, in this meeting
does NOT assert that the words are correct · that the speaker is that person ·
                that the content is true
Ask Spine may   quote it verbatim with meeting, date, offset and label
may NOT         paraphrase a number or name out of it · restate it as fact ·
                attribute it to a Person without a confirmed mapping
satisfies       "what did we say about X" · "did we discuss X" ·
                "when did we last talk about X"
```

### TIER 2 · CONFIRMED STATEMENT

```text
says            "Kandice Riley said the resident in 527 is seeking compensation."
storage         a SEPARATE row referencing the segment. It never edits the segment.
entered by      a human with authority over the meeting's deal
carries         as_recorded    verbatim, from Tier 1 — permanent
                as_confirmed   the corrected reading
asserts         this person said this, and this is what it says
does NOT assert that what they said is true, or that Spine acts on it
withdrawable    yes — withdrawing removes the assertion, never the evidence
```

`as_recorded` / `as_confirmed` is the whole point of the tier. **This is where
`$29.97` becomes `$2,997` and `Amory` becomes Anne-Marie — and the segment still
reads `$29.97` forever.** A correction that edits the source destroys the only
thing the source was good for.

### TIER 3 · GOVERNED OPERATING TRUTH

```text
says            "Spine currently treats the 10-month roommate concession as an
                 approved leasing instruction."
storage         the DOMAIN's own object — a decision, instruction, standing rule,
                or an Exposure. Never a meeting table.
entered by      the authority for that domain
asserts         Spine will act on this, show this, or constrain against it
walks back      to Tier 2, which walks back to Tier 1
```

**Out of scope for slice 1.** Nothing at this tier is built in the read-only
slice. It is written down so the read-only slice does not foreclose it.

### Two confirmations, not one — do not collapse them

```text
SPEAKER MAPPING       label → Person. Once per label per source. Cheap.
                      Gates whether a person-specific question may reach the
                      segment at all. Does NOT assert the words are right.

STATEMENT CONFIRMATION  Tier 2. Per passage. Expensive.
                        Asserts both the identity and the reading.
```

Collapsing these makes the product unusable — you would have to confirm every
passage before *"What did Robert say?"* returned anything. With the mapping
confirmed and the passage not, the honest answer is Tier 1 phrasing scoped to a
mapped speaker: *"The transcript records Robert Vernicek as saying …"* That is
the common case, and it works.

---

## 4. The conversational seam — what fluency may and may not decide

The sentence to protect, from the owner, and the one to check any implementation
against:

> **Ask Spine should feel conversational on the surface, while underneath it
> remains extremely literal about authority, provenance, uncertainty, and
> current state.**

All of §4 is one rule wearing seven hats:

```text
THE MODEL GETS FLUENCY OVER WORDING.
IT NEVER GETS AUTHORITY OVER ATTRIBUTION, TIER, CURRENT STATE, RELEVANCE,
OR CONFLICT.
```

Everything load-bearing is decided server-side and handed to the model already
resolved. This is the same seam as `references[]` in the composer slice, and it
is the reason that slice is worth reusing rather than re-deciding: the model
never resolved an identity there either.

### 4.1 · Fluency must not launder tier

The dangerous failure is not that the transcript says `$29.97`. It is Ask Spine
saying *"Robert said the rent was $29.97"* — fluent, cited, and now sounding like
institutional truth. **A model told to be conversational will smooth "the
transcript records" into "said" every time**, because the second is better
English. So the phrasing cannot be left to it.

```text
attribution   "The transcript records Robert Vernicek as saying"   ← SERVER-BUILT
passage       "…"                                                  ← verbatim
tier          1                                                    ← server
```

The model receives the attribution pre-built and is forbidden from constructing
another. It is a writer of things it was handed, not a decider.

**The assertion that pins it, and what turns it red:** retrieve only unconfirmed
passages, then assert the answer contains the Tier 1 formulation and does *not*
contain a bare `<speaker> said`. It goes red the moment someone loosens the
prompt, swaps the model, or lets the model see a raw speaker field. An assertion
that cannot go red is the prefill bug again.

### 4.2 · "What is true now" outranks "what did we say"

*"What's going on with the elevator?"* is a state question. It answers from the
work-order and asset reads. Meeting evidence is **additive and labelled** —
*"it was also discussed in Monday's meeting"* — never substitutive. Meeting
memory must not become a competing source of current state.

**Do not implement this as routing.** A classifier deciding "is this a state
question or a memory question" is a judgement with no edge, and this thread
already paid for one: the `out_of_scope` rule that depended on whether facts were
*sufficient* passed one run and failed the next, unchanged. Instead:

```text
ALWAYS   run the operating reads for an on-subject question
THEN     attach meeting evidence as an additional, separately labelled block
NEVER    let one substitute for the other
```

**And the prohibition that matters most:** if the state read fails, meeting
evidence does **not** fill the hole. `COULD NOT READ: WORK_ORDERS` already
happens in production. Backfilling that gap from what someone said in a meeting
would make the surface look healthier while being less true — a fixture-fallback
in a new costume (§19–20). The grounding line says the read failed. The meeting
passage does not get promoted to cover it.

### 4.3 · Relevance is an entity link, not a similarity score

This is what makes R3 implementable instead of hand-wavy. A segment is
operationally relevant **because it references an operating object** — a unit, a
person, an asset, an obligation, a work order, a vendor — not because its text
scored well against the question.

```text
Unit 527 compensation claim   → unit · resident · potential obligation   IN
Robert's mattress (15:51)     → no operating object at all               OUT
```

That is the "bed" problem closed by structure rather than by ranking.

**But entity linkage alone is not sufficient, and the sample proves it.** The
hospitalization at 8:04 is attached to a real leasing fact — a notice put in,
then cancelled by the resident's mother, and possibly returning. It references a
resident and a notice, so a purely entity-based filter pulls it straight in. The
derived layer therefore needs **two axes, not one**:

```text
OPERATIONAL RELEVANCE   does it reference an operating object?
SENSITIVITY             does it disclose personal, health or family matter?

a segment may be BOTH — and sensitivity wins for conversational retrieval
```

Both axes are derivations. Both live in the mutable layer beside the property
reference (D1), both are correctable, and neither touches the evidence.

### 4.4 · The retrieval unit is a thread, not a chunk

Top-one RAG routinely misses the conclusion. The roommate discussion is the
proof: it opens at 2:02, develops at 4:01, and **the actual ruling lands at
13:56** — twelve minutes later, and it is the part anyone asking the question
wants.

```text
1  match segments
2  expand to the thread they belong to (same entities, same meeting)
3  present in CHRONOLOGICAL order — never score order
4  a later decision or reversal in the thread is always included
```

Score order buries the conclusion in the middle or drops it. Chronological order
also preserves the thing the human needs in order to judge: **which statement
came last.**

### 4.5 · Conflict is an output, not something to resolve

The sample contains one inside a single meeting: at 8:51 the third elevator is
reported running again, and in the same breath the freight elevator stopped
Saturday during ten move-ins.

The model may not pick. It presents both, in order, and says they conflict. Same
entity + incompatible assertions + different offsets → surface both. Reconciling
them is a human act, and if it results in anything durable it is a Tier 2 or
Tier 3 promotion, not a sentence.

### 4.6 · Uncertainty is a first-class answer

Two responses must exist, be reachable, and be *tested* — not left as things the
model might say if it feels appropriately humble:

```text
"The transcript records this, but it has not been confirmed."
"I found two conflicting statements."
```

Staff trust collapses faster from one confident wrong than from twenty honest
blanks. This is §5 at conversational altitude: a neat answer is not the goal.

### 4.7 · What memory may not do on its own

If the owner raises the bedroom-fitting-a-bed concern repeatedly, retrieval is
not the end state — that unresolved risk should eventually reach the leasing team
*at the moment it matters*. That is the Exposure contract in `CLAUDE.md`, and it
must answer all six of its questions including who owns resolving it.

**It arrives by explicit promotion to Tier 3, never by model intuition.** Nothing
in slice 1 builds it. What slice 1 must not foreclose: segments need stable,
addressable ids, so a promotion can point at the exact passage it came from.

---

## 5. The four rulings — FROZEN 2026-08-12. Do not re-litigate.

### R1 · Retention

Keep the source transcript as durable evidence while the property/account remains
active. Retention is an **explicit organization policy**, not hard-coded product
behavior.

**Promoted decisions, obligations, guidance and confirmed facts live
independently of transcript retention.** Consequence for the schema: Tier 2 and
Tier 3 must survive the deletion of Tier 1. They carry a pointer down, so they
must record enough to remain meaningful when the pointer dangles — at minimum
`as_recorded`, the speaker, the meeting identity and the date. A Tier 2 row that
is only a foreign key becomes a blank when the transcript ages out.

### R2 · Consent

**Spine does not record meetings.** It ingests from an approved
recording/transcription source operating under the organization's recording
policy.

**Do not invent a second consent mechanism inside Spine.** There is no
per-meeting consent flag, no consent prompt, no jurisdiction logic in this
slice. What Spine records is *which approved source a meeting came from*. This
supersedes the jurisdiction speculation in the first draft of this document.

### R3 · Retrievability

**No — not every segment is Ask-Spine retrievable.**

```text
FULL TRANSCRIPT        preserved as source evidence, complete, unedited
CONVERSATIONAL         only operationally relevant segments
RETRIEVAL
DIRECT REQUEST         the full transcript remains reachable when asked for
                       from the source explicitly
```

Personal chatter, irrelevant material and clearly non-property content stay out
of Ask Spine unless directly requested from the source transcript.

This ruling is why the retrieval hazard in D2 is closed: *"bed"* matches both the
Unit 527 compensation claim (5:07) and a personal exchange about Robert's
mattress (15:51–16:45). Only the first is operationally relevant.

**Two consequences the ruling settles by itself.** Relevance is a *derivation*,
so it lives in a separate mutable layer beside the property reference (D1) and
never in the evidence. And under-inclusion is the safe failure — a segment
wrongly excluded is still in the transcript and still reachable by direct
request, while a segment wrongly included is noise inside an operator answer. So
the marking defaults to excluding, and it must be visible and correctable.

**One detail the ruling leaves to the build:** what performs the marking — a
human pass, a classifier, or a heuristic. Any of the three satisfies the ruling
provided the output is a correctable derived layer and the full transcript stays
intact underneath.

### R4 · Unmapped speakers

Allowed in **generic** meeting answers as `Unidentified Speaker`, with meeting
and timestamp. Never infer identity.

**An unidentified segment cannot satisfy a person-specific question.**

```text
"What did we say about the freight elevator?"    unidentified segments MAY appear
"What did Kandice say about the layout?"         they MAY NOT — a confirmed
                                                 speaker mapping is required
```

This lands on the same mechanism as §3: person-specific retrieval is gated on the
speaker mapping. The ruling and the ladder are one rule, not two bolted together.

---

## 6. The five decisions that cost a migration if wrong

### D1 · What container does a meeting attach to?

**Not the property.** Doctrine: Spine onboards a DEAL, and one deal may hold
several properties. A weekly ops call routinely spans them.

The authority rule — *a person cannot search meetings for properties they are not
authorized to access* — only holds honestly if scope sits at the **passage**, not
the meeting. Scope a multi-property meeting at the meeting level and both
available answers are wrong: return the whole transcript and the authority
boundary leaks; withhold it and an authorized operator loses passages they are
entitled to.

```text
meeting            → attaches to the DEAL
transcript segment → immutable, pure evidence, no property column
segment → property/unit reference → SEPARATE, DERIVED, MUTABLE table
segment → operational relevance    → the same derived layer (R3)
retrieval          → filters on the derived layer, never on the evidence
```

The reference layer will be wrong sometimes and must be correctable **without
touching the record of what was said.**

### D2 · Retrieval mechanism

Recommendation: **Postgres full-text over the retrievable segments. Not
embeddings, not yet.**

Something must select — you cannot hand forty transcripts to the model. Under a
doctrine of honest blank the deciding property is not recall, it is whether you
can *show why a passage matched*. Full-text can answer that; embeddings return
things no one can explain. "The transcript does not support that" has to be a
provable claim, and it is only provable if the search that failed can be stated.
It is also no new infrastructure.

Add vector recall later if FTS demonstrably misses — with the miss recorded.

R3 shrinks the corpus this searches, which improves precision before any ranking
work is done.

### D3 · Speaker attribution provenance

Store the label exactly as the source gave it, plus how it was derived. Never
promote a diarization guess to a name. See §3 for the mapping/confirmation split
and R4 for what an unmapped label may satisfy.

### D4 · Ingest

Slice 1 accepts a transcript that **already carries speaker labels and
timestamps** from an approved source (R2). No ASR, no calendar integration, no
recording pipeline. The sample is a standard export and is trivially parseable:

```text
Weekly SOLO Meeting
Mon, Aug 10, 2026

0:03 - Robert Vernicek
Busy is good at right? Still in August? Good leads?
```

`deal_intake_files` is the precedent for file intake.

**Timestamps are relative (`M:SS` from meeting start) and the header carries a
date with no start time.** A citation is therefore `(meeting, offset)`.
Wall-clock is *derived* and only where a start time is known — otherwise it stays
blank rather than being invented. *"Did we discuss the freight elevator last
week?"* resolves against the meeting date, not the segment offset.

### D5 · Retention and consent

Ruled — see R1 and R2. `ask_spine.js` already wrote the rule this slice has to
satisfy:

> The question is NOT recorded — this door has no conversation history and does
> not pretend to. If we later want Spine to remember, that is a durable object
> with a retention decision behind it, not a side effect of answering.

This slice is that durable object. R1 is that decision.

---

## 7. What read-only means, precisely

A meeting statement must not create, modify, close or contradict:

```text
work orders · obligations · leases and leasing records · people
occupancy or availability figures · policies · rules · financial records
proof evaluations · any canonical operating truth
```

The sample is full of statements that would be tempting to write through, and
every one of them is a reason not to:

| Said in the meeting | Why it must not write |
|---|---|
| "Anne-Marie is putting in a ticket for that today with Schindler" | An intent to create a work order. May never have happened. |
| "occupied at 95%… seven available… three leases out and three pending" | Will conflict with leasing's own numbers, and the speaker said "Let me confirm" |
| "He said no charge" (garage door sensor) | An economic fact with no invoice behind it |
| "They got the third elevator with the belts running again" | Then it stopped again the same weekend, in the same meeting |

That last row is the owner's own elevator example, occurring naturally in the
first real transcript. Within one call the freight elevator is reported fixed and
then reported broken. Anything writing statements through to state would have
written both.

---

## 8. What the answer must carry, and the five demo questions

Reuse the seam the composer slice built — do not invent a second one.
`references[]` is server-resolved, the model never sees an id, and the renderer
switches on `kind`. A meeting citation is another `kind`:

```text
who said it        the label the transcript carried, with provenance
which meeting      title + date
when in it         the offset, verbatim
the passage        quoted, never summarised
which tier         Tier 1 or Tier 2 — this selects the phrasing (§2)
```

If the retrieved passages do not support the question, Ask Spine says so. The
existing grounding machinery already has the vocabulary; the rule is that "I
found nothing about that" must be reachable **after a search that ran**, and stay
distinguishable from a search that failed.

Confirmation that the slice is worth building — every demo question lands on a
real passage:

```text
Unit 527                    Kandice, 5:07  floor plan vs built layout, bathroom
                                           door on a different wall, resident
                                           seeking compensation
Robert / roommate deal      Robert, 4:01   take the two non-en-suite bedrooms,
                                           keep the en suite for a third
                            Robert, 13:56  and the ruling he then gives
short-term lease pricing    Robert, 2:02   scaled pricing for shorter terms
freight elevator            Kandice, 8:51  stopped during 10 Saturday move-ins,
                                           Tim reset attempts, Schindler ticket
Kandice / bedroom layout    Kandice, 5:07  and 6:13, the 50s line differing too
```

Two of these need passages from **different points in one meeting** — 4:01 and
13:56 are one thread twelve minutes apart, with the decision at the end.
Retrieval that returns a single best segment answers neither well.

Both person-specific questions in that list require a confirmed speaker mapping
before they may be answered at all (R4).

---

## 9. Release order — a dependency, not cleanup

**RULED.** The citation UI depends on an API contract that is not in production.

```text
`references[]`   written, tested, pushed on
                 claude/ask-spine-conversational-dash-97bwcx
                 NOT in origin/main · NOT deployed
```

The meeting slice **must not pretend citation UI is live** until that contract is
merged. Build against the branch contract, or merge the dependency first. Never
build against production behavior that does not yet exist.

This is the mirror of Open Ruling 2 in `CLAUDE.md` — there, a new API field
requires the app to ship first; here, a UI requires the API field to exist. The
general rule under both: **the thing that depends ships second, and "it will be
there by then" is not a release plan.**

---

## 10. Where the sample lives

**The transcript is NOT committed to this repo.** It names a resident
compensation dispute, a hospitalization, staff departures and a vendor waiving a
charge. Committing it is a retention act, and R1 makes retention an explicit
organization policy rather than a side effect of a build. It was supplied in the
owner's thread. If it is wanted as a fixture, that is a deliberate act with a
redaction pass.
