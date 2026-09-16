# Property Fact Baseline — standardized model

**Purpose.** Solo was made agent-ready by discovery: a voice interview, five defect
cases, and a live prospect who was overquoted. Nothing carries that forward. This
document turns the Solo demo into a repeatable baseline, so onboarding property #2
is a checklist rather than a rediscovery.

**Status.** Design proposal. Nothing here is built. Every claim below is rooted in
current source at `main` — file and line given so the developer can verify rather
than trust.

**Audience.** The developer implementing it. The owner rulings are collected in §7.

---

## 1. What Solo actually is today

Solo is the real property whose **real** policy facts were loaded onto the
**synthetic** demo property. From `tools/seed_solo_facts.js:4-10`:

> "In real onboarding, Spine reads a property's policy source, PROPOSES structured
> facts, and an operator CONFIRMS each through the surface. This seed hand-does that
> confirm step once... They attach to the synthetic DEMO property the agent is
> actually using (**NOT the real Solo property in Neon — that join happens later**)."

So "Solo as demo building" is precise: real facts, synthetic property, and the join
to the real property is unbuilt.

### The storage primitive already exists

`agent_facts`, migration `053_agent_supervised_drafts.sql:111-132`:

```text
property_id          not null, fk properties
space_id             nullable — optional bed/space scope, overrides property level
fact_key             not null, free text
category             not null, free text
rendered_text        not null
source_type          not null, free text
source_record_id     nullable
confirmed_at         nullable
effective_until      nullable
status               not null default 'active'  check (active|retired)
approved_by_user_id  nullable, fk users
```

Two partial unique indexes enforce one active row per key, at property level and at
space level. The read is `src/agent/agent.js:294-314` — `status='active'`,
`space_id is null`, and `effective_until is null or effective_until > now()`.

The doctrine is stated at `053:106-110` and is correct:

> "NOT a shadow rent roll: availability / rent / unit type are resolved LIVE from
> units... **Absence of a fact = unknown → honest handoff** (we do NOT store 'not
> confirmed')."

### There are TWO Solo corpora, and they do not share a vocabulary

This is the finding that matters most.

| | Corpus A | Corpus B |
|---|---|---|
| Where | `tools/seed_solo_facts.js` | `tools/data/demo_solo_agent_facts_v1.json` |
| Rows | 18 | 19 |
| Source | 2026 Field Guide / Solo Handbook + SharePoint library | (referenced at `agent.js:127`) |
| Categories | pets · parking · tours · fees · documents · routing · utilities · insurance · rent · movein · amenities · policies | identity · pricing · policy · process · amenity · availability · communications |

**They overlap on exactly two keys** — `pet_policy` and `renters_insurance`. The rest
are the same facts under different names:

```text
A                      B                        same real-world fact
utilities_policy       utilities                yes
parking_rules          parking_pricing          overlapping
amenities_list         amenities                yes
move_in_process        move_in_requirements     overlapping
required_documents     screening_process        overlapping
office_contact         sms_contact_line         overlapping
fee_policy (one blob)  pricing_application_fee  A is a paragraph;
                       pricing_amenity_fee      B is five itemized keys
                       pricing_security_deposit
                       pricing_admin_fee
                       pricing_telecom_fee
```

Category vocabularies collide on near-synonyms too: `policy` vs `policies`,
`amenity` vs `amenities`.

**Why this is a defect and not a naming nit.** The unique index is on
`(property_id, fact_key)`. It protects the *name*, not the *fact*. So `utilities` and
`utilities_policy` can both be `active` on the same property with different content,
and `resolveContext` reads **both** into the prompt as VERIFIED PROPERTY FACTS. The
database cannot see the conflict, because as far as it knows they are different facts.

Nothing today declares which vocabulary is correct.

---

## 2. Defects found in the scrub

Seven, each independently verifiable.

**D1 — the Solo seed cannot currently write.** `virtual_tours` is in the `FACTS`
array (`seed_solo_facts.js:214`) but absent from `CATEGORY_FOR` (`:73-83`). The insert
passes `CATEGORY_FOR[f.fact_key]` into `category`, which is `not null`. So
`--confirm` raises a not-null violation and the whole transaction rolls back. Dry run
returns before the insert, so it looks fine.
*Fix: add the mapping. It is also the first thing a closed vocabulary would have
caught at load time.*

**D2 — `communication_instructions` is mapped to a category and has no fact.**
`CATEGORY_FOR` declares it (`:75`); `FACTS` never defines it. Dead mapping in the
opposite direction from D1.

**D3 — source attribution is wrong for two of eighteen facts.** Every row is stamped
`source_type = "management_policy"` (`:71`, a single constant), but
`current_concession` and `pricing_premiums` come from *"03. Leasing & Marketing /
Current Pricing & Specials July 2026.pdf"* (`:193-201`) — a pricing sheet, not a
management policy. Provenance is exactly what would settle the sheet-vs-`units`
conflict, and it has been overwritten with a constant.

**D4 — the one fact that must expire, never does.** `agent.js:296-303` honors
`effective_until` and its comment says so plainly:

> "No live fact sets effective_until today, so this changes nothing now and guards
> everything later."

But `current_concession`'s own text is *"Concessions change month to month, so never
state one that isn't in these facts"* (`seed_solo_facts.js:206`), and the seed inserts
it with `effective_until` unset. A July 2026 concession stays quotable in December.
The mechanism is built and honored; no writer populates it.

**D5 — curated facts have no activation boundary, and governed charges do.**
Migration `106_quote_activation_boundary.sql` settled this exact question for
`property_governed_charges`:

> "PUBLICATION IS NOT ACTIVATION... `record_state` — is this approved economic truth?
> `quote_state` — may the live assistant quote it?"

with `ck_gc_live_requires_active_amount`, `ck_gc_live_is_receipted` (activation
requires `activated_at` **and** `activated_by_person_id`), and `uq_gc_one_live_owner`
— one live owner per charge code per property, enforced by index.

`agent_facts` has one axis: `status in ('active','retired')`. A curated fact is
quotable the instant it is inserted. `053` predates `106`, so this is drift, not
disagreement — but the pattern to standardize on is already in the repo.

**D6 — ranges are stored as prose and have already corrupted a live answer.**
`agent.js:126-131`:

> "7 of 19 rows in `demo_solo_agent_facts_v1.json` contain one ('A telecom fee of
> $75-99', 'within 24-48 hours', 'a 15-20% premium'). Rule 2 below turns those into
> '$75, 99'... **which reached live prospects and made a real fee unreadable.**"

A dash-stripper now special-cases ranges. The deeper problem stands: a fee expressed
as a range is not a quotable amount, and storing it in `rendered_text` hides that from
every validator.

**D7 — the universal prompt names Solo.** `agent.js:671` and `:811`:

```text
671  Solo has sometimes moved people in within a few days when the unit is ready...
811  - Solo is pet friendly, but current restrictions and charges must come from
     VERIFIED PROPERTY FACTS below.
```

Property #2 inherits "Solo is pet friendly." Both should be facts, not prompt text —
`:811` is one line above the rule that says charges must come from facts.

---

## 3. The model — part 1: closed vocabularies

Two `create type`-style closed lists, declared as data and enforced by CHECK. This is
what makes D1, D2 and the corpus split unrepresentable rather than merely discouraged.

### 3.1 `fact_key` — the canonical set

Derived by reconciling both Solo corpora. Corpus A's naming wins where it is clearer,
Corpus B's itemization wins for fees.

```text
IDENTITY & ROUTING
  building_identity          name, address, jurisdiction
  office_contact             email, phone, hours
  communication_line         the number prospects reach (was sms_contact_line)

MONEY — one key per quotable amount, never a blob
  fee_application
  fee_amenity
  fee_admin
  fee_security_deposit
  fee_telecom
  fee_pet_onetime
  fee_pet_monthly
  fee_parking_monthly
  fee_access_replacement
  concession_current         MUST carry effective_until
  pricing_premiums
  pricing_authority          which source outranks live units (see §7.1)

POLICY
  policy_pets
  policy_parking
  policy_guests
  policy_noise
  policy_smoking_and_restrictions
  policy_utilities
  policy_renters_insurance
  policy_rent_payment
  policy_unit_transfers

PROCESS
  process_tour
  process_screening          criteria and decision window
  process_required_documents
  process_move_in
  process_lease_terms        published terms offered

PROPERTY
  amenities                  what exists, by location
  furnished_options
  virtual_tours              LAYOUT media only — see §4.3
```

**Migrating Solo is a mapping, not a rewrite.** `fee_policy`'s single paragraph
decomposes into the `fee_*` keys; the `pricing_*` keys from Corpus B map onto them
directly; the synonym pairs in §1 collapse to one side each.

### 3.2 `category` — closed, one level, no synonyms

```text
identity · money · policy · process · property · media
```

Six values. `053`'s comment lists six different ones and the seed uses twelve; both
are superseded by this list. Add the CHECK in the same migration.

### 3.3 `source_class` — replaces free-text `source_type`

Provenance is what resolves conflict (§40.4), so it must be a closed axis:

```text
management_policy      handbook, field guide, community policies
pricing_sheet          dated marketing pricing and specials
crm_faq                CRM-maintained answers
lease_document         the executed lease or addendum
operator_assertion     a staff member typed it and confirmed it
regulatory             jurisdictional requirement
```

D3 is then a load-time error rather than a silent overwrite. Keep `source_record_id`
pointing at the document.

---

## 4. Part 2: value discipline

### 4.1 A quotable amount is not prose

`rendered_text` stays — it is what the agent says. But any `category = 'money'` key
adds structure the validator can see:

```text
amount_cents        integer, nullable
amount_basis        one_time | monthly | per_unit | per_occupant | percent
amount_unresolved   text — why there is no single number
```

**A money fact with `amount_cents` null and `amount_unresolved` set is a valid,
honest fact.** It renders as a defer, never as a number. That is D6 fixed at the
schema instead of in a dash-stripper: `"$75-99"` becomes
`amount_cents = null, amount_unresolved = 'range on source sheet, not a single
governed amount'`, and no formatter can turn it into `"$75, 99"`.

### 4.2 Expiry is required where the fact is dated

`effective_until` becomes **not null for `concession_current`**, enforced by a partial
CHECK. D4 becomes unrepresentable. Every other key may leave it null.

### 4.3 Media is layout media

`virtual_tours` already carries the discipline in prose
(`seed_solo_facts.js:214-232`) — *"Always describe it as the LAYOUT, never their
specific apartment"*, and *"THERE IS NO TWO-BEDROOM TOUR: do not send another layout
as a substitute."* Keep that text. The structural half is that a media fact is keyed
to a **layout**, not a unit, so no code path can resolve one to an apartment.

---

## 5. Part 3: the activation boundary

Extend `106`'s settled pattern to `agent_facts`. Same two questions, same shape:

```text
status        active | retired          is this the current curated row?
quote_state   inactive | live           may the live agent say it?
```

with the three guarantees `106` already proved:

```text
ck_af_live_requires_active      quote_state <> 'live' or status = 'active'
ck_af_live_is_receipted         quote_state <> 'live' or (activated_at is not null
                                  and activated_by_user_id is not null)
uq_af_one_live_owner            unique (property_id, fact_key) where quote_state='live'
```

And `resolveContext` (`agent.js:294`) reads `quote_state = 'live'` instead of
`status = 'active'` — the same change already made for governed charges in the same
function.

**Why this matters for a baseline.** A new property can be loaded, reviewed and
corrected while its agent stays silent. Today, inserting a fact makes it quotable in
the same statement, which is why Solo's facts had to be right on the first write.

---

## 6. Part 4: the readiness gate

This is the artifact that replaces discovery.

### 6.1 A required-fact manifest, declared as data

Per `fact_key`: whether it is required before the agent may talk to a prospect, which
`source_class` values may establish it, and what the agent does when it is absent.

```text
fact_key            required   establishing source_class            absent behaviour
building_identity   yes        management_policy | operator          refuse to speak
communication_line  yes        operator_assertion                    refuse to speak
office_contact      yes        management_policy | operator          refuse to speak
pricing_authority   yes        operator_assertion                    refuse to quote
process_tour        yes        management_policy | operator          defer
process_screening   yes        management_policy                     defer
policy_pets         yes        management_policy | lease_document    defer
policy_utilities    yes        management_policy                     defer
fee_application     yes        pricing_sheet | governed_charge       defer
fee_security_deposit yes       pricing_sheet | lease_document        defer
concession_current  no         pricing_sheet                         say nothing
amenities           no         management_policy                     defer
virtual_tours       no         operator_assertion                    offer in-person
...
```

The three behaviours are distinct and each already exists in the prompt
(`agent.js:538, 743-747`): **defer** (a fact it could look up), **flag** (a human must
act, conversation continues), **handoff** (a person owns the thread). `absent
behaviour` selects among them per key — it does not invent a fourth.

### 6.2 The gate is computed, never a checkbox

One read per property returning, from the manifest against `agent_facts`:

```text
missing        required key with no live row
unconfirmed    live row with confirmed_at null
expired        effective_until in the past
unresolved     money key with amount_cents null and amount_unresolved set
conflicting    two live keys that the manifest marks mutually exclusive
verdict        agent_ready | agent_blocked
```

`confirmed_at` and `approved_by_user_id` already exist, so "a human confirmed this" is
representable today with no schema change.

**No property gets a live lead-facing agent until `verdict = agent_ready`.** That is
the $2,700 overquote, converted into a gate.

### 6.3 It registers with Ask Spine

Per §40.2 a domain is not done until Ask Spine can read it, and the gate output *is*
the compact standing projection (§40.6): current position, important unknowns, next
milestone. An operator should be able to ask *"is the agent ready for Skyline?"* and
get the three missing keys. `tests/gates/gate_ask_spine_readers.js` enforces
registration.

### 6.4 Onboarding replaces the one-time script

`tools/seed_solo_facts.js` is Class 3 with no HTTP surface, and correctly so — it was
moved out of the runtime on 2026-07-28 because `/demo/seed-solo-facts` sat in
`PUBLIC_PREFIXES` with no authentication and could retire 18 live facts including
`fee_policy` (`seed_solo_facts.js:27-45`).

**Do not re-expose it.** The repeatable path is the one the seed's own header
describes: Spine reads the policy source, **proposes** structured facts against the
manifest, an operator **confirms** each through the operator surface, and confirmation
is what sets `quote_state = 'live'`. The seed stays as the demo shortcut it says it
is.

The per-property conflict pack then becomes a **read**, not a hand-written document.
`docs/archive/SOLO_FACTS_PACK.md` is prose, Class 3, and its removal condition points
at `src/shared/facts-seed.js` — **which no longer exists** (it became
`tools/seed_solo_facts.js`), so the condition is unexecutable as written. Solo's pack
becomes the first output of the conflict reader instead.

---

## 7. Owner rulings this needs

**7.1 Is the pricing sheet authoritative over live `units`?** Solo's open conflict:
the sheet says a studio is $1,450–1,600; unit 530 was quoted **$1,687**, which matches
nothing on the sheet; the 2-bed was quoted **$2,700** against a sheet saying $2,600
gross / $2,384 net, with the free month never mentioned — **$316/month worse than
reality** for the number the prospect cared about. This is a per-property question, so
the model gives it a key (`pricing_authority`) rather than a one-time answer.

**7.2 Which term is quoted when the prospect names none?** Open as `CURRENT_STATE`
rows #14 and #27. `src/money/effective_pricing.js:397-402` already returns
`published_terms` — *"With no term supplied the answer is the published menu"* — so
presenting the choice needs no schema change. #27 is the sub-case where a property
publishes no 12-month term. What it must not do is fall back to `terms[0]`.

**7.3 Does the vocabulary in §3 stand?** It is a reconciliation of two real corpora,
not a greenfield list. Adding keys later is cheap; renaming them after a second
property loads is not.

**7.4 When does the real Solo property join the demo facts?** The seed says *"that
join happens later."* The baseline should say whether property #2 loads against a
real property from the start.

---

## 8. Definition of done

- one closed `fact_key` vocabulary, one closed `category` vocabulary, one closed
  `source_class` vocabulary, each enforced by CHECK;
- both Solo corpora reconciled onto it, with a mapping receipt — no fact text retyped;
- money facts carry `amount_cents` / `amount_basis` / `amount_unresolved`, and a range
  is representable only as unresolved;
- `concession_current` cannot be written without `effective_until`;
- `agent_facts` carries `quote_state`, receipted activation, and one live owner per key;
- `resolveContext` reads `quote_state = 'live'`;
- the manifest exists as data, and the readiness gate is computed from it;
- the gate is registered with Ask Spine and proven in the browser;
- `Solo` appears nowhere in `src/agent/agent.js`;
- `tools/seed_solo_facts.js --confirm` succeeds against a scratch database (D1 closed);
- a second property reaches `agent_ready` **without** a voice interview.

That last line is the test of whether this worked. Facts are per-property; register is
not — `docs/archive/AI_VOICE.md` is Class 1 doctrine with three Solo references in 274
lines, and a new property inherits it. If onboarding property #2 requires another
interview, the standardization failed.
