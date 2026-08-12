# Ask Spine Slice 3 — meeting intelligence, design input

Written at the close of the Ask Spine composer thread, as the direct input to the
build of **meeting evidence retrieval**. Nothing here is built. This is the record
of what the owner asked for, what a real transcript proved about it, and the five
decisions that cost a migration if they are made wrong.

State at the time of writing:

```text
api main            7ebb400      (PR #97) deployed
api branch          bcc5446      claude/ask-spine-conversational-dash-97bwcx
                                 NOT merged, NOT deployed — carries `references[]`
app main            bf86673      (PR #57) deployed
app branch          ddfa59c      claude/ask-spine-conversational-dash-97bwcx
                                 NOT merged — carries the proof-verdict contract pin
migration files     through 161  ledger ceiling NOT confirmed from this session
                                 (no DATABASE_URL here — confirm before writing 162)
```

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
supports (see §6):

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
memo. That sentence is the load-bearing one, so it has to be fixed before any
schema is written.

**The memo says Spine can know *with confidence* that the person said it.**
Read against the artifact, that claim is one derivation too strong. What Spine
actually holds is a machine transcription of a recording of what was said.
Three layers, not one:

```text
what was said                    the fact
what the recording captured      lossy
what the transcriber rendered    lossy AND confidently wrong
```

This is not a hypothetical about transcription quality in general. It is what is
in the file the owner sent:

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
in the recording: *"I don't have Katie's beautiful report"* … *"Let me confirm."*

### What follows from this — three rules, not one

**1. Quote. Never paraphrase a number, name, or amount out of a passage.**
The answer shows the passage verbatim and lets a human read it. If Ask Spine
renders "Kandice said the three-bed would be $29.97," that is §5 confident-wrong
sourced from a genuine passage, and it will read as *more* trustworthy than an
ordinary model error because it carries a citation. A citation that launders a
transcription error is worse than no citation.

**2. `Unidentified Speaker` is preserved, never resolved.** The transcriber
already gave the honest blank. Spine's job is to not spend it. No inference from
adjacent turns, no "probably Kandice."

**3. A speaker label is not a Person.** `Amory` and `Anne-Marie` string-match to
two different people and neither may exist in Spine. Speaker → Person is a
**confirmed mapping**, human-made, stored separately from the segment. Until it
is confirmed, the answer says the label the transcript carried and does not link
a Person Card. This is the same seam as `references[]` in the composer slice:
the model never resolves an identity, the server does, and only from something
recorded.

The upside: none of this weakens the product. It is why the read-only boundary
is right, and it converts the memo's `Someone said this → confirmed → decision`
ladder from a nice-to-have into the mechanism that makes the data usable at all.
**The confirmation step is where transcription error dies.**

---

## 3. The five decisions that cost a migration if wrong

### D1 · What container does a meeting attach to?

**Not the property.** Doctrine: Spine onboards a DEAL, and one deal may hold
several properties. A weekly ops call routinely spans them.

The authority rule in the memo — *a person cannot search meetings for properties
they are not authorized to access* — only holds honestly if scope sits at the
**passage**, not the meeting. Scope a multi-property meeting at the meeting level
and both available answers are wrong: return the whole transcript and the
authority boundary leaks; withhold the whole transcript and an authorized
operator loses passages they are entitled to.

```text
meeting            → attaches to the DEAL
transcript segment → immutable, pure evidence, no property column
segment → property/unit reference → SEPARATE, DERIVED, MUTABLE table
retrieval          → filters on the derived layer, never on the evidence
```

Keeping the derivation out of the evidence table is the whole point. The
reference layer will be wrong sometimes and must be correctable **without
touching the record of what was said.**

### D2 · Retrieval mechanism

Recommendation: **Postgres full-text over segments. Not embeddings, not yet.**

You cannot hand forty transcripts to the model, so something must select. Under
a doctrine of honest blank, the deciding property is not recall — it is whether
you can *show why a passage matched*. Full-text can answer that; embeddings
return things no one can explain. "The transcript does not support that" has to
be a provable claim, and it is only provable if the search that failed can be
stated. It is also no new infrastructure.

Add vector recall later if FTS demonstrably misses — with the miss recorded.

**The known retrieval hazard, from the sample:** "bed" occurs in the Unit 527
compensation claim (5:07) *and* in a personal exchange about Robert's mattress
(15:51–16:45). A naive match on "bed" returns both, and one of them is not
operating truth in any sense. Not every passage deserves to be retrievable.
Whether that is solved by ranking, by a human marking segments, or by accepting
the noise in slice 1 is an open ruling — but do not discover it in front of an
operator.

### D3 · Speaker attribution provenance

Covered in §2. Store the label exactly as the source gave it, plus how it was
derived. Never promote a diarization guess to a name in an answer.

### D4 · Ingest

Slice 1 accepts a transcript that **already carries speaker labels and
timestamps**. No ASR, no calendar integration, no recording pipeline. The sample
is a standard export and is trivially parseable:

```text
Weekly SOLO Meeting
Mon, Aug 10, 2026

0:03 - Robert Vernicek
Busy is good at right? Still in August? Good leads?
```

`deal_intake_files` is the precedent for file intake.

**Timestamps are relative (`M:SS` from meeting start) and the header carries a
date with no start time.** So a citation is `(meeting, offset)`. Wall-clock is
*derived* and only where a start time is known — otherwise it stays blank rather
than being invented. "Did we discuss the freight elevator last week?" resolves
against the meeting date, not the segment offset.

### D5 · Retention and consent

`ask_spine.js` already wrote the rule this slice has to satisfy:

> The question is NOT recorded — this door has no conversation history and does
> not pretend to. If we later want Spine to remember, that is a durable object
> with a retention decision behind it, not a side effect of answering.

This slice is that durable object, so the retention decision is now due and is
the owner's, not the builder's. Recording consent is jurisdiction-dependent, and
`ADDRESS` already anchors jurisdiction in the model.

Note what the sample contains: a named resident's compensation claim, a
resident's hospitalization, staff departures, and a vendor waiving a charge.
That is the retention question in concrete form, not in the abstract.

---

## 4. What read-only means, precisely

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

That last row is the memo's own elevator example, occurring naturally in the
first real transcript. Within one call the freight elevator is reported fixed and
then reported broken. Anything that wrote statements through to state would have
written both.

---

## 5. What the answer must carry

Reuse the seam the composer slice just built — do not invent a second one.
`references[]` is server-resolved, the model never sees an id, and the renderer
switches on `kind`. A meeting citation is another `kind`:

```text
who said it        the label the transcript carried, with provenance
which meeting      title + date
when in it         the offset, verbatim
the passage        quoted, not summarised
```

If the retrieved passages do not support the question, Ask Spine says so. The
existing `out_of_scope` / grounding machinery already has the vocabulary; §2's
rule is that "I found nothing about that" must be reachable **after** a search
that ran, and be distinguishable from a search that failed.

---

## 6. The five demo questions, against the real sample

Confirmation that the slice is worth building — every one lands on a real
passage:

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

Note that two of these need passages from **different points in one meeting**
(4:01 and 13:56 are the same thread, twelve minutes apart, with a decision at the
end). Retrieval that returns a single best segment answers neither well.

---

## 7. Where the sample lives

**The transcript is NOT committed to this repo.** It contains named residents, a
compensation dispute, a hospitalization and staff matters, and committing it is a
retention decision (D5) that has not been made. It was supplied in the owner's
thread. If it is wanted as a fixture, that is a deliberate act with a redaction
pass, not a side effect of building.

---

## 8. Open — the owner rules these, not the builder

```text
1  Retention: how long are transcripts kept, and who may read one directly
   as opposed to reading a passage Ask Spine surfaced
2  Consent: which jurisdictions, and is a consent fact recorded per meeting
3  Whether every segment is retrievable, or only segments a human has marked
   as operating-relevant (the "Robert's mattress" problem, D2)
4  Whether an unmapped speaker label may appear in an answer at all, or
   whether names require a confirmed Speaker → Person mapping first
```

Not one of these is a schema detail. Each changes what gets built.
