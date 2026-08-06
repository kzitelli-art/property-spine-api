# Property Spine — Codebase & Plumbing State
### Technical inventory, 5 August 2026. What exists, where it lives, and what state it is in.

This is a report on the **code**, not the product direction. Every fact below was
read from the repositories, not from prior documents.

---

## 0. Census stamp — this inventory is reproducible

```text
API main   8330aece95e5a242467759e931ffffa7d64816cd
App main   357fb15563cf92d4d40405c298387e6f659c24d5
census     2026-08-05T12:11Z
```

Regenerate with — this prints the category totals, so the prose cannot drift
from the census:

```bash
cur=0; near=0; arch=0; nomb=0; merged=0
for b in $(git for-each-ref --format='%(refname:short)' refs/remotes/origin \
           | grep -v 'origin/main$' | grep -v HEAD); do
  git merge-base origin/main "$b" >/dev/null 2>&1 || { nomb=$((nomb+1)); continue; }
  a=$(git rev-list --count origin/main.."$b")
  [ "$a" -eq 0 ] && { merged=$((merged+1)); continue; }
  bh=$(git rev-list --count "$b"..origin/main)
  if   [ "$bh" -le 1  ]; then cur=$((cur+1))
  elif [ "$bh" -le 13 ]; then near=$((near+1))
  else arch=$((arch+1)); fi
done
printf 'current %d  near %d  archaeology %d  no-merge-base %d  merged %d\n' \
  $cur $near $arch $nomb $merged
```

Result at the stamp above:

```text
55  remote branches, excluding main
27  fully merged (0 ahead)      → deletable, pure cleanup
28  ahead of main               → 5 + 3 + 16 + 4, reconciled below
```

---

## 1. Integration state — 28 branches ahead, **5 real integration candidates**

The raw count overstates the problem. Classified by distance from `main`:

```text
 5  ≤1 commit behind          THE INTEGRATION SURFACE
 3  2–13 commits behind       Slice 10 family — inspect, likely rebase and prove
16  >13 commits behind        archaeology, not integration
 4  no merge base             retire or re-author — cannot be merged at all
──
28  total ahead of main       reconciles exactly

27  additionally fully merged → delete; they are noise in every branch listing
```

**Decisions should be made against the 5, not the 29.**

`main` moved three times during a single evening. Two of my own checks hours
apart returned different tips (`fbd7a3a`, then `8330aec`) — which is why the
stamp above exists.

| API branch | ahead | behind | files |
|---|---:|---:|---:|
| `claude/conversational-seams-and-technician-loop` | **23** | 0 | **61** |
| `claude/slice-10e-browser-acceptance-t0zk33` | **28** | 1 | 22 |
| `claude/slices-1-9-structured-receipts` | **25** | 1 | 31 |
| `claude/sms-work-order-handoff-qo3s8i` | 13 | 0 | 13 |
| `claude/slices-1-9-write-authority-hardening` | 10 | 1 | 10 |
| `claude/slice-10b-dated-position-rows` | 14 | **8** | 11 |
| `claude/slice-10a-forward-rent-roll-audit` | 4 | **13** | 1 |
| `claude/security-release-launch-packet` | 10 | **128** | 2 |
| `archive/slice-9-pre-main-sync-fc23869` | 19 | **185** | 37 |
| 10 × `build-*` / `slice-6/7` branches (Jul 27–31) | 1–16 | **194–225** | 1–44 |
| 4 × branches with **no merge base** | 444–793 | 240 | 0 |

The last group is worth naming: `fix/scheduling-adapter-seam-require`,
`fix/prospect-text-punctuation-and-no-promises`,
`agent/governed-terms-review-big-build` and `tools/qa_provision.js` report
hundreds of commits ahead and **zero changed files** — they share no history
with `main`. They are not branches of this trunk. They cannot be merged; they
can only be retired or re-authored.

**App side:** `main` at `357fb15`, with `operator-ui-system-alignment` (20/69),
`maintenance-home-alignment` (14/69) and `unit-turn-release-candidate` (11/69)
all deep in divergence, plus one branch with no merge base.

### Why this is a code problem, not a bookkeeping problem

A proof run is evidence about the tree it ran against. Four branches carry
**green proof runs against trees that no longer exist**. The Slice 10 readiness
sheet records the precise failure already observed: *"the merge that broke this
branch changed no Slice 10 file at all."* Textual cleanliness did not imply
semantic compatibility.

---

## 2. What is actually deployed

```
API   main lineage, healthy, /health answering
App   main lineage, static site, no build step
```

Shipped and verified in production this week:

| Capability | Where |
|---|---|
| Authenticated obligations read | `src/obligations/operator_obligations{,_service}.js` |
| Authenticated self-claim | `src/obligations/operator_obligation_actions.js` |
| Ask Spine attention read | `src/agent/ask_spine{,_service}.js` |
| Obligation failure-vs-empty treatment | app `index.html`, 8 consumers |

Five legacy shared-key obligation routes were removed and proven `404` on the
deployed API. `x-operator-key` no longer appears on any obligation path.

**SUPERSEDED 2026-08-05 evening.** The SMS work-order rail and the
conversational seams **merged to `main` and are deployed** — `a04a1df` confirmed
by `echo $RENDER_GIT_COMMIT`, ledger reconciled at ceiling **136**, `EXIT 0`.

**Deployed is not activated:** `provider_config` is null and no `operations`
line exists, so nothing is reachable by a resident or a technician.

Structured receipts, write-authority hardening and Slice 10 remain on branches.

---

## 3. The authority plumbing

`src/identity/` holds **24 modules**, the largest single concentration of
policy code in the tree. The load-bearing ones:

| Module | Role |
|---|---|
| `staff_session_service.js` | canonical issue/resolve/revoke — `{ id, property_id, allowed_modules }` |
| `actor_context.js` | **users ≠ persons.** A `users` row is a login; a `persons` row is a human. Prevents a session `user_id` being written where a `person_id` belongs |
| `authority_resolution.js` | nine independent proofs, each with veto, deliberately not collapsed into a score |
| `staffbridge.js` | the user↔person bridge |
| `phone_identity.js` | phone → **person** (`persons.primary_phone_e164`), one-phone-one-person |
| `communication_lines.js` | inbound line → organization, authority ceiling, sender |

### There are two authority resolvers over one table

```
Dashboard   resolveStaffSession       →  { id, property_id, allowed_modules }
SMS/ops     boundary → staffUserId
            then actorScope()          →  property_ids ONLY
```

`actorScope` reads the same source of truth —
`property_team_assignments where active = true` — so this is **not** a parallel
authority model. But it returns property ids **without `allowed_modules`**, and
the technician turn gets its module boundary implicitly, from the
`join work_orders` in `candidateWork`.

That is sufficient while the only conversation is maintenance. It stops being
sufficient the moment a second domain is reachable from a conversation.

**Note:** `phone_identity.js` maps a phone to a *person*, and states that the
staff-user bridge "is a separate identity fact." So phone → staff *user* is
resolved at the communications boundary, not by a general resolver.

### Unification cannot flatten the identity model — two findings from the code

An earlier draft of this document proposed unifying on
`{ user_id, property_ids, allowed_modules }`. **Reading `actor_context.js`
shows that shape is wrong in two ways.**

**1. The existing resolver is single-property by construction.**

```js
resolveActorContext(pool, { user_id, property_id, as_of })
  → deny("no_property_context") when property_id is absent
```

It answers *"who is this operator, at this one property?"* The SMS turn needs
*"which properties may this technician operate?"* — a set. These are different
questions, and the SMS path is not simply a duplicate that failed to reuse it.

**2. Read entitlement and act entitlement are already separate — deliberately.**

```js
readEntitlement = "session_scoped"        // does NOT require a person link
if (!user.person_id)
  return deny("session_identity_not_linked_to_a_person", …)
```

The comment states the intent plainly: this *"keeps an unlinked operator able to
use the read-only product while being unable to act as a human."* Reading is
entitled by the session; **acting requires a resolved human.**

A flat `person_id` field in a merged context loses that. Any canonical context
must carry the two entitlements as separate facts:

```text
actor_context:
  organization_id
  user_id                    the credential
  person_id | null           the human
  act_identity_ready         bool — is this credential linked to an
                             attributable human at all?

  identity_source:           PROVENANCE, never a reusable credential
    channel                  web | operations_sms
    session_id               not the session TOKEN
    line_id                  resolved by the boundary
    resolved_sender_id       resolved once, not reinterpreted downstream

  authorized_properties:     scope-level, because authority is not global
    - property_id
      readable_modules
      actionable_modules

  authority_ceiling          per channel
```

**Two separate questions, deliberately not collapsed:**

```text
Is this credential linked to a human capable of attribution?   → actor level
What may this actor read or do, at this property, in this
module?                                                        → scope level
```

`person_id` is **necessary for accountable action, not sufficient authorization
to perform any given action.** An operator may read maintenance at Property A
and act there, read leasing at Property B and not act there, and see a portfolio
summary while able to act on none of it. A global `act_entitlement` flag cannot
express that.

**On credentials:** the adapter consumes the session token or the raw sender
number and returns *verified provenance*. The raw token and the raw phone number
**do not travel into the governed turn.** A turn that can see a reusable
credential is a turn that can leak or replay one.

**Architecture:**

```text
SMS identity adapter ─┐
                      ├→ canonical actor context → governed turn
web session adapter ──┘
```

The adapters prove identity differently. They converge on one context **without
pretending a credential and a human are the same object** — a defect
`actor_context.js` exists specifically to prevent.

---

## 4. The conversational seams — already transport-independent

`src/conversation/` — five modules, described in-source as pure, requiring
nothing and querying nothing:

```
intent.js              what was asked
technician_intent.js   the maintenance intent set
work_reference.js      which record was meant
clarification.js       the narrow question when several match
receipt.js             operatingReceipt({ outcome, result })
```

`work_reference.js` is the strongest piece of design in the tree. Its stated
rule:

> A MESSAGE MAY NEVER ESTABLISH ITS OWN ACTOR OR PROPERTY MERELY BY ASSERTING ONE.

`extractReference` reads an identifier out of text and returns a **claim,
explicitly labelled unverified**. `resolveWorkReference` converts a claim into a
selection only by finding it inside an already-authorized set. **It cannot widen
scope because it has no database handle.** The guarantee is structural, not
disciplinary — the module physically cannot fetch.

`src/technician/` — seven modules implementing the maintenance rail:

```
conversation.js       runOperationsTurn — the operations-line turn
work_selection.js     offerableWork over the actor's own properties
acceptance_service.js lifecycle_service.js evidence_service.js
resident_update.js    operator_actions.js
```

**The turn is currently SMS-shaped, not channel-neutral.** `runOperationsTurn`
takes `{ organizationId, userId, lineId, body, providerMessageId }` — a line id
and a provider message id are transport facts. The seams underneath are already
neutral; the turn wrapper is not.

Two separable things live inside that one call:

```text
TRANSPORT ENVELOPE            GOVERNED TURN
lineId                        actor context
providerMessageId             message body
incoming channel              thread references
delivery metadata             intent
                              authorized candidate records
                              read or action
                              structured result
```

**Extract the middle; do not rewrite the working rail.** The proven SMS path
becomes the extracted turn's *first consumer*, the web surface its second:

```text
SMS adapter   → resolve line and sender → runGovernedTurn(…) → render SMS → record delivery
Web adapter   → resolve staff session   → runGovernedTurn(…) → render dashboard
```

This avoids standing up a second "agent service" beside a technician
conversation that already works and is proven.

---

## 5. Data model as it now stands

- **`obligations`** remains the unit of assignable work. Modules observed in
  source: `leasing · maintenance · money · movein · turnover`.
- **`work_orders`** exists and hangs off the obligation:
  `join work_orders w on w.id = o.related_id and w.property_id = o.property_id`.
  (An earlier read of mine said work orders did not exist in the codebase. That
  was correct for `main` at the time and is now superseded.)
- **`staff_threads`** is keyed `(organization_id, user_id)` — **not by channel.**
  **A cross-transport thread identity exists. The safe context contract for that
  thread is not yet defined.** Storage identity is not memory semantics: message
  ordering under simultaneous use, which channel produced a turn, whether an
  unfinished SMS clarification surfaces on the dashboard, and how long a record
  reference stays live are all undecided. The governing rule — *the thread may
  retain references and subjects, never operating state* — is a design position,
  not yet an implemented constraint.
- **`comm_events`**, **`conversations`** `(property_id, person_id)`,
  **`delivery_attempts`** (migration 135) carry communication separately from
  operating state.

### Migrations the SMS branch adds

```
130_communication_lines      131_work_acceptance
132_outbound_line_policy     133_work_order_reference
134_technician_lifecycle     135_delivery_attempts
```

Six migrations, unreleased, on a branch 23 commits out. They must land in order
and against the production-derived schema.

---

## 6. Known schema and migration defects

| Defect | State |
|---|---|
| **Chain cannot rebuild from empty.** `001` creates `vendors`; `012` re-declares it under `create table if not exists` (silently skipped) then indexes a column never added. 12 migrations fail from empty | documented, `main`, Appendix H |
| **Duplicate `121`.** Two migrations numbered 121 eight minutes apart; the one in production is the branch-only AI-leasing file, never on `main`. Inert — 0 rows, no release code references it | documented, Appendix J |
| **`deployment.md:76` teaches the anti-pattern.** Instructs authors to use `DO $$ … EXCEPTION WHEN others THEN null; END $$;` and cites `090` as the model | documented, Appendix I |
| **`/health/migrations` does not exist.** Documented in `deployment.md:137–142`; `server.js` defines only `GET /health` | corrected in the security receipt |
| **`129` released** via a docs-only merge on 2026-08-03. `main` boots; health green | resolved |

---

## 7. Proof infrastructure

**178 files in `tests/`** on the integrated branch. The pattern that works, and
the two failures it was built to catch:

- **Execution floors.** A harness names its required behaviours, records each as
  it runs, and asserts in `finally` that every name was observed. Built after a
  deployed boundary rung was found **defined, exported and never invoked** — the
  suite reported green while proving nothing. A pass count cannot detect an
  absent check.
- **Assert on the lie, not the absence.** The obligation failure-state harness
  fails when confident-empty wording coexists with a failed read. It seeds real
  content, forces the failure, then proves the prior content is gone.

**Both production defects found this week were found by a human looking at a
page**, not by a harness: the false empty on failed reads, and `renderMyWork`
calling `items.map(row)` where the function was named `obRow` — throwing
`ReferenceError` the instant it had a row to display, swallowed by an empty
`catch`. That surface had never rendered a single obligation.

---

## 8. App-side plumbing

- **`createLiveLoader` / `LIVE_RESOURCES`** — the manifest now carries
  `askSpineAttention` and `operatorObligations`, both `liveRequired`. Neither
  takes an authoritative parameter; `operatorObligations` accepts `status` as a
  **preference only**. That is the scope-vs-filter pattern in working form.
- **`loadObligationsGuarded` / `obligationsFailed` / `renderObligationsUnavailable`**
  — one failure treatment, eight consumers, proven 61/0 across 8 surfaces plus a
  floor.
- **The Ask Spine composer has no text input.** It is a single `.as-chip`
  button. `_asIsSupported` accepts several phrasings but is **unreachable from
  the UI** — there is no field to type into.
- **`PRODUCTION_ORIGIN` is pinned** in the artifact; the app is served as
  committed static files with no build step, so the file *is* the deployed
  artifact.

---

## 9. The plumbing questions that are open

1. **Two authority resolvers, and the unification is not a flattening.**
   The naive shape `{ user_id, property_ids, allowed_modules }` is **rejected**
   for the reasons in §3 — it erases the credential/human split and the
   read-versus-act distinction the code already enforces.

   The actual problem:

   > Define one canonical actor-context contract serving **both** a
   > selected-property read *and* an authorized-property-set discovery, while
   > preserving credential identity, optional human identity, per-property
   > module scope, separate read-versus-act eligibility, and identity
   > provenance without carrying reusable credentials.

   Settle it before a second transport exists to encode a second answer.
2. **The turn is not channel-neutral.** `runOperationsTurn` carries `lineId` and
   `providerMessageId`. Extract the middle; leave transport facts at the edge.
3. **`work_order_status_read.js` takes `(workOrderId, propertyId)` — no actor.**
   Correct for an operator surface. Before it serves a second consumer it needs
   an actor-aware projection computed server-side, never filtered on the way out.
4. **Ranking rules are unversioned.** Ask Spine's four tiers are a `case`
   expression inline in SQL. Today's ordering is not reproducible after the next
   edit; a versioned rule must stamp its version on the answer.
5. **Generated language — leading resolution, no longer fully open.**

   > **The model produces no user-visible factual prose.**
   >
   > It returns intent, extracted references, ambiguity, requested operation and
   > structured slots. Governed services return facts, provenance, receipts and
   > actions. **The channel renderer produces every visible word.**

   That includes **clarification prompts and confirmations**, wherever
   practical. A model kept away from status language can still misstate a
   consequence — and these are materially different sentences:

   ```text
   "Send the resident an update."          ← about to happen
   "Record that the resident was updated." ← already happened
   ```

   The action contract and its template state which one is about to occur.
   Generated prose must not.

   The turn returns named fields; each channel renders them through a finite
   template set. So:

   ```text
   finding_state:   leak_stopped_reported
   remaining_work:  valve_required
   proof_state:     missing
   status:          open
   ```

   may render *"Dana reported that the leak is stopped. A valve is still
   required. The work order remains open because completion proof has not been
   recorded."* — and **cannot** render *"The repair is complete."*

   The existing proof philosophy survives unchanged: assert the structured
   fields and the finite renderer, not every sentence a model might produce.

   Natural language keeps the work it is actually good at — understanding *"the
   heater thing"*, resolving *"the other one"*, deciding clarification is
   needed, recognising *"let them know I'm coming"*, choosing the governed read
   or action. It does **not** initially paraphrase status, completion, proof,
   ownership, delivery, priority or financial truth.

6. **Ranking versioning needs two artifacts, and the version must be
   immutable.** An addressable policy definition holding the ordered rules, and
   a stamped receipt on every answer:

   ```text
   ranking_policy_id · ranking_version · policy_digest
   priority_class · priority_reason_code · priority_facts · ranked_at
   ```

   > **A published ranking version is immutable. Any change to the hierarchy
   > creates a new version.**

   A name alone reproduces nothing — `maintenance_attention_v1` only explains a
   past answer if nobody can later edit what v1 *means*. The digest (or an
   immutable commit reference) is what makes the receipt verifiable rather than
   merely labelled.

   The interface shows *"Overdue and unassigned"*, with *"Ranked using
   Maintenance Attention v1"* on expand. Prominent in the durable receipt, quiet
   in the UI.

---

## 10. What the code says about sequencing

Not a plan — an observation about dependencies actually present in the source:

- `conversational-seams-and-technician-loop` and `sms-work-order-handoff` both
  modify `tenantlink.js`. The convergence design already records this: parallel
  work here produces **a semantic conflict, not a textual one**.
- Six unreleased migrations sit on the conversational branch. Nothing downstream
  of them can be proven against production-derived schema until they land in
  order.
- `slices-1-9-write-authority-hardening` is 10 ahead / 1 behind and touches 10
  files — the smallest merge on the board, and the readiness sheet argues it
  should land **first**, because merging it later would invalidate any proof run
  taken before it.
- Fourteen branches are 128–240 commits behind. They are not integration
  candidates. They are either already-merged content, or abandoned work whose
  value is now archaeological.

---

---

## 11. Front-end implications of the current plumbing *(provisional)*

What the plumbing above demands of the experience. Layout specifics, prompt
sets, the full ranking hierarchy, notification behaviour, confirmation classes
and role differences are **deliberately not decided here** — they belong to the
operational questions.

### A. Property Home needs a real input, not a blank chat page

Today's element is a fixed chip with an unreachable phrase recognizer. The next
surface needs one prominent composer, visible active property, a short
conversation, persistent structured results, direct canonical actions, and
visible unavailable/partial states — **without the open work disappearing into
the thread**:

```text
PROPERTY + USER CONTEXT
SPINE ANSWER          short, structured
SUPPORTING WORK       persistent cards / rows / records
CONVERSATION          follow-up turns
COMPOSER              Ask about this property…
```

Conversation explains and controls the work. **The cards preserve the work.**

### B. The response *contract* carries four layers — the interface need not

```text
1  Direct answer      what Spine can truthfully say
2  Supporting facts   work orders, units, people, evidence, timestamps
3  Coverage state     what was checked, unavailable, unauthorized, unsupported
4  Available action   open · assign · retry · send update · add proof · review
```

**This is a contract requirement, not a layout requirement.** *"Who owns this?"*
should still feel like a one-line answer. Supporting records, coverage and
actions may be collapsed, or absent entirely where they add nothing. The direct
answer leads; coverage stays quiet but discoverable when it matters.

### C. Empty, unavailable, partial and unsupported must be distinct states

The eight-consumer guarded treatment must survive unchanged. The conversational
surface needs **structured states in the renderer**, not four different
sentences:

```text
valid_empty    "No recorded open work matched this question."
unavailable    "I couldn't read open work right now."   [Retry]
partial        see the answerability rule below
unsupported    "Spine does not yet have a governed read for that."
```

`partial` is new — the aggregate case the current two-state treatment has no
vocabulary for. **It is also the most dangerous state**, because a partial
answer delivered in a complete answer's tone is exactly the confident-wrong this
system exists to prevent. It needs a coverage judgement, not just a label:

```text
coverage_state:
  complete                    every required source answered
  partial_safe                a source failed, but not one the question needed
  insufficient_for_conclusion a REQUIRED source failed
```

The distinction, concretely:

```text
partial_safe
  "I found the status of Work Order 1042. Resident-message delivery
   was unavailable."
  → the missing source does not block the core question

insufficient_for_conclusion
  "I could not determine everything requiring attention — leasing
   obligations were unavailable."
  → results may still be shown, but NOT as the property's priority list
```

**Broad intents must declare required coverage.** A missing required domain
downgrades or refuses the aggregate conclusion. This is the conversational
equivalent of never turning a failed read into an empty answer — and it is the
form that rule has to take once one answer spans several sources.

### D. Resolved references — preview before *consequential* action, not before navigation

*"Open the other one"* should **open the record immediately**, provided the
destination clearly shows which record was resolved:

```text
Unit 302 · Work Order 1042
```

Making someone confirm a navigation is friction, not safety. The preview
requirement belongs to **writes and outbound communication** — assignment,
messaging, completion, reopening — where the record *and the recipient* must be
named before confirmation.

### E. Show receipts, never machinery — and never one green tick

```text
Operating result:      update recorded
Communication result:  delivery pending
```

The single strongest lesson from the SMS build. The dashboard must not collapse
these into one success state.

### F. Channel continuity visible, not magical

*"Continued from Operations SMS"* is honest. Silently merging transport state,
or implying a failed SMS was a failed operating action, is not. Each message and
receipt keeps a quiet channel source.

### G. The model does not reach the renderer

The browser renders a **structured response contract**, not assistant-authored
markup:

```text
answer_state · answer_blocks · supporting_records
coverage · actions · receipts · ranking_version
```

This bounds hallucination risk and front-end drift with the same mechanism.

---

*Read directly from `kzitelli-art/property-spine-api` and
`kzitelli-art/property-spine-app`. Census stamp in §0.*
