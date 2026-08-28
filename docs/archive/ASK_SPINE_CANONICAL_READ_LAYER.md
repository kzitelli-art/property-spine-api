# Ask Spine × Asset Management — the canonical read layer

Design input. **Nothing here is built.** It is the settled output of a design
exchange between the owner, the consultant who wrote the original build spec, and
a source read of the current Ask Spine implementation.

It supersedes nothing. It is the first version of a rule that will outlive it.

State at the time of writing:

```text
api main            7ebb400      (PR #97) deployed
app main            bf86673      (PR #57) deployed
migration files     through 161  ledger ceiling NOT confirmed from this session

api branch   claude/ask-spine-conversational-dash-97bwcx   NOT MERGED
             carries `references[]`, both design docs, and PHILOSOPHY.md §40
app branch   claude/ask-spine-conversational-dash-97bwcx   NOT MERGED
             carries the proof-verdict contract pin
```

The branch heads move; **`NOT MERGED` is the durable fact.** Doctrine sitting on
an unmerged branch is not doctrine — the next thread reads `main`. Verify with
`git merge-base --is-ancestor` rather than trusting this block.

Companion document: **`ASK_SPINE_SLICE_3_MEETING_INTELLIGENCE.md`** — transcript
evidence, the assertion ladder, and the conversational seam. **This document
lands first.** See §2.

---

## 1. The framing — a governed interface, not an AI layer

The owner's words, because the framing is the specification:

> Ask Spine should become a governed interface to Spine, not an AI layer that
> happens to know about modules. The read integration we are discussing is the
> first version of that rule; later the same interface also writes,
> communicates, routes, and acts within authority.

> A domain is not really integrated if the app can display it but the person
> cannot ask Spine for it.

The build sequence that follows, and it is load-bearing:

```text
canonical truth
  → writer
  → canonical read
  → compact standing projection
  → operator UI
  → Ask Spine
  → proof
```

Not: build the entire application, then months later teach a chatbot about it.
Ask Spine is another reader of the Spine. Precedent in this repo:
`dated_positions.js` — *one service, four interpretations* — one altitude up.

### ⚠ 1a. What this framing must NOT be allowed to mean

The direction is right and two boundaries in this repo are already frozen in
source. Recording them here so the framing does not dissolve them by implication.

**The read door does not become the write door.** `ask_spine.js` says so in its
own header, and the reasoning has not changed:

> What would make that sentence true again is Ask Spine being able to DO
> something. That is a different slice with its own authority rules, and it does
> not arrive by adding a route to this file.

**The conversational write path already exists, and it is gated.** The maintenance
examples in the forward-looking list — *"I'm done," "I can't finish, I need a
part"* — are the technician SMS path, which is already live and already the
canonical completion writer:

```text
CANONICAL  src/technician/lifecycle_service.claimCompletion
           called only from src/technician/conversation.js
GATE       gate_completion_writers.js proves there is no third writer
DATABASE   the completion guard is ON — a deferred constraint trigger refuses
           any terminal status without a grounded proof evaluation
```

So a future Ask Spine "I'm done" must **route through `claimCompletion`**, not
become a second writer beside it. Anything else fails `gate_completion_writers`,
and it should. Conversational writes are a **new surface over existing canonical
writers**, never a parallel path to the same durable object.

**The Owner altitude is a reserved name.** The forward list has an owner asking
about occupancy, rent, assessments, insurance and loan maturity. That is the
right direction and it does not mean the owner signs into the staff Ask Spine.
Per `CLAUDE.md`: the Owner / Investor Surface is a different audience and
possibly a different login, and **it must not reuse the Asset Management
entitlement merely because it consumes Asset Management truth.** Ask Spine
serving that altitude later does not collapse the boundary.

**Minor, but this repo has paid for it once:** the forward list mixes operating
*doors* (Maintenance, Leasing) with *compressions* (Manager, Asset Manager,
Owner). `CLAUDE.md` warns explicitly not to merge the two fours. A door is where
work is done; a compression is how truth is said.

---

## 2. Sequencing — this document lands before meeting evidence

Two builds converge on the same composer. Order is not a preference.

```text
1  CANONICAL READS      governed truth · one authority level · no tier machinery
2  MEETING EVIDENCE     transcript claims · strictly lower authority
```

Reversed, transcript passages arrive into a composer that has only ever known one
kind of fact, and the natural move is to add them to the same bag. Then
*"I think the taxes got paid last week"* sits beside `city_payment:
NOT_ESTABLISHED` with nothing structural separating them — which is precisely the
failure the consultant named as critical, arriving by omission rather than by
anyone deciding it.

---

## 3. The fact envelope — authority is part of the shape

**The composer must never receive an undifferentiated bag of facts.** Every fact
carries, structurally:

```text
domain              which governed domain it came from
concept             the fact/concept, in the domain's own vocabulary
value | truth_state the value, or the named absence
source_authority    what this source is AUTHORIZED TO ASSERT
provenance          which canonical read produced it
as_of / occurred_at when it was true, or when it happened
openable            a reference, ONLY if the actor is entitled
```

The load-bearing field is not `source`. It is **what that source is authorized to
assert.**

```text
NOW      governed_read

LATER    transcript_claim
         email_claim
         user_assertion
```

**These are not peers, and the ordering is part of the contract.** A transcript
claim may coexist with a governed read; it may never silently upgrade one.

Establish the field now, with one value in it. Cheap today, painful after the
composer has learned to treat all retrieved text alike.

---

## 4. Truth walls — executable, not prompt instructions

The most important refinement in the exchange.

Every domain already enforces distinctions that natural language actively erodes:

```text
escrow funded       ≠  City paid
filed               ≠  paid
coverage discussed  ≠  coverage bound
assessment          ≠  liability
payment established ≠  coverage proven
premium financed    ≠  a different annual cost
unknown applicability ≠ not applicable
```

**The risk is not model disobedience. It is the question's own frame.** *"Are our
taxes paid?"* asks for a binary. The governed truth may be `escrow funding:
established` + `City payment: not established`. Every fluent yes/no answer to that
question is wrong, and a conversational surface inherits the asker's vocabulary
unless something stops it.

A system-prompt instruction is a hope. Three things that hold:

**1. Facts carry their own vocabulary.** Never emit a bare `paid: false`. Emit
`city_payment: NOT_ESTABLISHED`. A named truth state has to be actively erased
rather than passively omitted.

**2. Each domain declares its walls and its dangerous vocabulary as part of the
read contract** — not in a doc. Words that routinely collapse several distinct
facts:

```text
paid · current · covered · filed · funded · complete · insured · done
```

When a question crosses a declared wall, **the server constrains the answer
form** rather than asking the model to remember doctrine:

> The loan escrow is funded. Spine does not have the City tax payment
> established.

That is product behavior, not prompt craftsmanship.

**3. The falsification cases are the specification.** Build these fixtures
*before* the readers, then make the conversational reader survive them:

```text
escrow yes            /  payment unknown
filing yes            /  payment no
applicability unknown /  —
insurance financed    /  coverage unknown
```

Declaring walls as data also means the test suite is generated from the
declaration rather than hand-written per domain — which is what makes it survive
Debt, Compliance and Payroll without re-litigation.

---

## 5. Gather, do not route — and the projection that makes it scale

With two domains, a classifier choosing between them adds machinery and no value,
and it is the same judgement-with-no-edge that made the `out_of_scope` rule flake
run-to-run earlier in this build. Run both standing reads, hand over all governed
facts, answer the question asked. The cross-domain question then falls out for
free rather than needing its own path.

Gather-everything has a phase change around four to six domains. The way through
is **a constraint on domain reads, not a router.**

### The amendment: same canonical service, two projections

The original spec said the same read serves both the screen and Ask Spine.
Directionally right, too strong as written — the screen needs everything to
render a page.

```text
STANDING PROJECTION      small · cheap · safe to gather routinely
                         current position · important unknowns
                         next action / next milestone

DETAIL PROJECTION        richer · called only when the question requires it
```

Future Debt always exposes something compact — balance, rate, maturity, next
milestone, covenant standing, known issue — without shipping every payment,
amendment, reserve movement and loan clause into every conversation. *"Walk me
through the mezz loan"* triggers the deeper read.

That gathers ten domains without inventing a classifier prematurely. Put the
constraint on Debt while Debt is being designed; skip it and gather dies at four.

---

## 6. Silence has four meanings — and they must never collapse

```text
NOT_ESTABLISHED    a fact about the PROPERTY
READ_FAILED        a fact about SPINE
READ_TIMED_OUT     also a fact about Spine, and different again
QUIET              read successfully, nothing needs attention
```

Live example: `COULD NOT READ: WORK_ORDERS` appears in production answers today,
with one reader. Four readers makes it worse.

### The composite invariant — hard

> **Composite silence is only health if every required reader successfully
> returned.**

*"What should I worry about?"* answering "nothing" while Insurance timed out is
false. The composite must know its own coverage:

```text
Taxes       read successfully — no current attention item
Insurance   could not be read
```

**Compute this, do not prompt it.** The composite answer is derived from reader
outcomes in code; if any required reader did not return, the composite is
structurally incapable of saying "nothing." A model asked to remember this will
eventually forget.

### Latency needs a budget now

A slow domain cannot hold conversational responses hostage. Standing readers get
defined timeouts, and **a timeout is a visible system fact, never property
truth.**

**⚠ Contract change, and this repo has been bitten by exactly this.** The
grounding block currently exposes `reads_that_failed`, which cannot express a
timeout. Extending it is an API output-key change — pin it with an assertion that
reads the key by name, or the next identifier sweep breaks it silently, the way
migration 159 broke the deal page.

---

## 7. Entitlements run before intelligence

Hard boundary. This is what makes gather-first safe.

```text
authenticated actor
      ↓
server-derived property scope
      ↓
ENTITLED DOMAIN READERS ONLY
      ↓
governed fact envelope
      ↓
composer
```

**Unentitled facts never enter model context.** If they do, the only thing
between them and a leak is a prompt instruction.

**Openable references are minted server-side, from entitled facts** — never by
finding a domain name in the answer text and linking it afterward. Same seam as
`references[]` in the composer slice: the model never resolves an identity, the
server does, and only from something recorded.

Nothing about server-derived property scope changes. A client-supplied
`property_id` is refused, not ignored.

---

## 8. Definition of Done, and the gate that keeps it

Doctrine, for `PHILOSOPHY.md` §33 — not only for this build doc, because left
here it survives Debt and is forgotten by Compliance:

> **A canonical Spine domain is not complete until its governed standing state is
> available to Ask Spine for entitled users.**

Every governed domain needs conversational **reads**. Not every module needs
conversational **writes**.

Enforce it mechanically. A source-governance gate should assert that every
conversationally eligible domain has:

```text
canonical reader · standing projection · Ask Spine registration
authority metadata · entitlement declaration
```

**Prerequisite, and it is a real one:** a gate must scan the same scope as the
claim it asserts, or it launders the gap into evidence. There is no definitive
domain registry today — modules arrive as `allowed_modules` on a session. **The
registry has to exist before the gate means anything.**

**The cost stays visible in estimates.** Ask Spine support is part of building a
domain, not free polish afterward. This rule is exactly the kind that gets
quietly dropped under schedule pressure.

### Reuse the attention path

`GET /operator/ask-spine/attention` already composes across modules with
entitlement filtering. Taxes and Insurance feed **that**. Do not build a second
portfolio/attention engine.

And do not invent comparability between domains:

```text
GOOD   Insurance   Renewal approaching — progress not established
       Taxes       BIRT applicability not established

BAD    #1 BIRT
       #2 Insurance
```

Group by domain and let genuine due dates and severity states speak. An invented
ordering is an unsupported assertion about priority.

---

## 9. Retrieval versus causal explanation

Different capability classes. Do not let the second be inherited by assumption.

```text
"What is our debt service?"        governed retrieval
"Why did debt service increase?"   causal attribution
```

The second requires Spine to connect a changed result to a **recorded** cause —
rate reset, principal event, amendment, new financing terms. Per `PHILOSOPHY.md`,
a cause may only be asserted if it walks back to a recorded fact.

**Debt Build 1 promises retrieval and preserves the causal hooks. It does not
claim causal explanation.**

---

## 10. First build — Taxes and Insurance only

No generic universal agent framework. Source-read the current implementation and
wire two existing, proven domains through it, to get real specimens before
abstracting.

```text
Ask Spine
├── operating / work-order facts     EXISTING
├── insurance facts                  NEW
├── tax facts                        NEW
└── meeting context                  LATER (companion doc)
```

Not Debt. Not every Asset Management room.

Insurance must answer at minimum: what's our insurance · are we insured · when
does it renew · what does it cost · how are we paying for it · is it financed ·
do we have insurance issues. Do not collapse coverage standing, coverage stack,
annual cost, monthly accrual, renewal standing, funding mechanism, financing, and
known gaps into one another. **Premium financed does not change annual cost.
Payment established does not prove coverage.**

Taxes must answer at minimum: what are our property taxes · how much · when due ·
are they paid · are they escrowed · what filings are outstanding · tax issues ·
BIRT / NPT / U&O status. Preserve every wall in §4.

---

## 11. Proof

Real specimen — SOLO, already the Asset Management specimen. Browser rung, per
§33: for operator workflows, browser verification is part of done.

Each answer verified for: correct property · correct canonical value · correct
truth state · no inferred blank · funding/economic walls preserved · module link
opens · unauthorized actor cannot retrieve it.

**And falsify it.** Construct the §4 fixture states deliberately and prove Ask
Spine refuses to round them into confident answers. A green assertion that cannot
go red is worthless — this build already shipped one, an assertion that the
answer-shape prefill was *present*, which passed for the entire period during
which Ask Spine could not answer a single question.

---

## 12. Carried forward

The rule this exchange actually produced, larger than Taxes and Insurance:

> **Spine should be built conversation-ready.** Every domain exposes its governed
> state in a way a human can reach without knowing where it lives in the
> application. The app remains the durable visual interface. Ask Spine becomes
> the universal conversational interface over the same truth.

Different people, different authority, different domains; one pattern — ask the
property, and Spine returns only the truth it actually knows.

That should influence Debt from the first schema decision, not become an
integration task after Debt is "finished."

**One item neither side has addressed, recorded rather than chased:** what Ask
Spine does when two *governed* domains disagree. With two domains there is no
conflict; with ten there will be. The rule is likely the same as for transcript
conflict — surface both, never reconcile in prose — but it is not decided, and it
is not in scope for Taxes and Insurance.
