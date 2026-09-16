# Property Fact Baseline — standardized model

**Purpose.** Solo was made agent-ready by discovery: a voice interview, five defect
cases, and a live prospect who was overquoted. Nothing carries that forward. This
document turns the Solo demo into a repeatable baseline, so onboarding property #2
is a checklist rather than a rediscovery.

**Status.** Design proposal. Nothing here is built. Every claim below is rooted in
current source at `main` — file and line given so the developer can verify rather
than trust.

**Audience.** The developer implementing it. The owner rulings are collected in §9.

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

**D7 — the universal prompt carries a property-specific fact block.** Not two stray
mentions: a titled, structured block at `agent.js:804-812`, referenced by name from
the rules at `:551` — *"Use the APPROVED SOLO PROFILE only for stable building
facts."*

```text
804  APPROVED SOLO PROFILE (stable building facts you may use directly):
805  - SOLO on Chestnut is at 4233 Chestnut Street in University City.
806  - Layouts: studio, one-bedroom, one-bedroom-with-den, two-bedroom, three-bedroom.
807  - Furnished and unfurnished options exist.
808  - Apartments include in-unit laundry and kitchen appliances.
809  - Amenities: coworking and study spaces, fitness facilities, rooftop space, ...
810  - The fitness center is open 24/7. The GOLF SIMULATOR IS NOT: it keeps separate hours.
811  - Solo is pet friendly, but current restrictions and charges must come from
     VERIFIED PROPERTY FACTS below.
812  - Assistance animals (service animals and ESAs) are NOT pets and are NOT charged...
```

Property #2 inherits Solo's address, layouts, laundry and amenity list as approved
facts. Line `:811` sits one line above *"FEES HAVE EXACTLY ONE APPROVED SOURCE:
VERIFIED PROPERTY FACTS below"* — the block is an exception to the rule printed
directly beneath it.

Only `:812` belongs there: assistance animals are not a property fact, they are
federal law. Everything from `:805` to `:811` is a `fact_key` that already exists —
and `amenities` is now asserted in **three** places: the prompt (`:809`),
`amenities_list` in Corpus A, and `amenities` in Corpus B.

Also `agent.js:671` — *"Solo has sometimes moved people in within a few days when the
unit is ready..."* — a claim about one property's past operating behaviour, in the
shared prompt.

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
  pricing_authority          which source outranks live units (see §9.1)

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
  unit_features              appliances, laundry, HVAC — what is IN the apartment
  layouts                    marketing layout names, bed/bath, mapped to canonical type
  dimensions                 per layout, each marked exact | approximate | marketing_range
  package_handling           who receives, where, notification, after-hours, loss
  virtual_tours              LAYOUT media only — see §4.3
  media                      photos, plans, diagrams — classified, see §4.4

POSITIONING
  positioning                the pitch, the three strongest reasons, the honest tradeoffs
  neighborhood               walkable/transit facts only — never area character, see §8
```

**Seven of these came from the September 2026 two-property review packet, not from
Solo** (§11). Solo's corpora are thin on descriptive and experiential facts because
they were assembled from a policy handbook; the packet was assembled from an operator
interview, which surfaces what prospects actually ask. `unit_features` is where
Solo's laundry belongs — it is currently asserted in the prompt (D7).

**Migrating Solo is a mapping, not a rewrite.** `fee_policy`'s single paragraph
decomposes into the `fee_*` keys; the `pricing_*` keys from Corpus B map onto them
directly; the synonym pairs in §1 collapse to one side each.

### 3.2 `category` — closed, one level, no synonyms

```text
identity · money · policy · process · property · media · positioning
```

Seven values. `053`'s comment lists six different ones and the seed uses twelve; both
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

**Two additions the review packet forces.**

*Source identity is a digest, not a filename.* The packet pins the governing Skyline
lease by SHA256 and rules that *"a newer Repaired file with different fee fields must
not supersede the governing source by filename or date alone."* It also caught a file
named as one property's lease template that is actually another property's lease, for
a different address and term. So a source record carries its **`sha256`** — the
primitive already exists at `work_order_proof_attachments.sha256`
(`134_technician_lifecycle.sql`) — and a fact cites the digest it was drawn from.

*A rejected source must be recorded as rejected.* `source_class` is an allowlist, and
an allowlist cannot say "we looked at this and it must not be used." The packet's
`do-not-use` list is real operating knowledge: a 2023 investor update's occupancy and
demographic statements, an offline May 2026 app snapshot with stale resident data, a
mislabeled lease template, website dollar amounts, stale specials, COVID-era rules,
camera counts, safety claims, blanket balcony claims. **A rejected source that is not
recorded gets re-ingested by the next person.** Add `source_rejections`: the
document, its digest, why it is not usable, who ruled, when.

### 3.4 `fact_usability` — what a present fact actually establishes

A fact existing is not a fact being usable. The Ask Spine charter froze this axis for
maintenance reads (`docs/archive/ASK_SPINE_BUILD_CONTRACT.md` §8); it applies here
unchanged, and reusing it is the cross-domain reuse that charter asked for.

```text
present_and_valid         usable as stated
present_but_unverified    recorded, but nothing establishes it
present_but_incomplete    partially established — some layouts, not all
present_but_conflicting   two sourced claims disagree and no ruling exists
missing                   absent → the agent defers (053's own doctrine)
```

**`present_but_unverified` and `present_but_conflicting` are the two that earn their
keep**, and the two-property review packet produced clean examples of each:

- *unverified* — a Matterport **labelled** 590 square feet, where the packet notes
  "that label is not a verified measurement of a specific apartment";
- *conflicting* — a junior 1BR tour labelled 700 SF against a website saying more
  than 715, and a 2BR/2BA labelled 1,032 against more than 1,050.

Both are silent to the prospect. Only the second records **what the two claims were**,
which is the difference between a conflict somebody already investigated and one the
next reviewer rediscovers.

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

### 4.3 Media carries its class and its reach

The review packet's media table is the shape to build, not prose to paraphrase. Every
asset row:

```text
asset_class        photograph | rendering | measured_plan | diagram | virtual_tour
reach              exact_home | representative
layout_ref         the marketing layout it shows
canonical_type_id  the Property Spine unit type it maps to — NULL until mapped
example_units      exact units of that type, when known
last_verified      a date, because links rot
approved_disclosure  the sentence that must accompany it
approved_by / at
```

**`reach = representative` is the default and `exact_home` must be earned.** The
packet states the reason plainly: galleries and diagrams *"do not by themselves prove
the condition, view, furniture package, or plan of an exact available home."* Solo
reached the same rule from the other direction and wrote it into prose
(`seed_solo_facts.js:214-232`). One field replaces both.

An unmapped asset — `canonical_type_id` null — is **not sendable**. The packet lists
"an exact-home photo, plan, dimension, or tour association that has not been mapped to
canonical inventory" among the things that must not be used as leasing truth.

The prose discipline Solo already wrote stays — *"Always describe it as the LAYOUT,
never their specific apartment"*, and *"THERE IS NO TWO-BEDROOM TOUR: do not send
another layout as a substitute and do not imply a tour exists"*
(`seed_solo_facts.js:214-232`). `reach` makes it structural; the sentence makes it
sayable. Neither replaces the other.

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

### 6.1b Every fact has a steward and a next-review date

The review packet demands this per shelf — *"future update owner"* — and again per
property: knowledge steward, final accountable approver, approval date, **next review
date**, review cadence. My model had `approved_by_user_id` and nothing else, which
answers who approved it and not who keeps it true.

```text
steward_user_id     who keeps this fact current — never null on a live fact
next_review_at      when it must be looked at again
approved_by_user_id who approved it (exists)
confirmed_at        when (exists)
```

This is the Exposure contract in `CLAUDE.md` applied to a fact: *"who owns resolving
it — or `UNASSIGNED`."* A fact with no steward is an unowned claim being made to
prospects, which is the same defect class as an unowned obligation.

`next_review_at` is distinct from `effective_until`. Expiry says *this stops being
true*; review says *somebody must look at this again*. A concession has both. An
amenity list has only the second.

### 6.2 The gate is computed, never a checkbox

One read per property returning, from the manifest against `agent_facts`:

```text
missing        required key with no live row
unconfirmed    live row with confirmed_at null
expired        effective_until in the past
unresolved     money key with amount_cents null and amount_unresolved set
conflicting    two live keys that the manifest marks mutually exclusive
unstewarded    live fact with no steward_user_id
overdue        live fact past next_review_at
unmapped_media asset with canonical_type_id null
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

## 7. Staff intake — the questions prospects actually ask

This is the form. It exists so a property manager can sit down once and produce the
fact layer, instead of the agent discovering gaps on a live prospect.

**Three rules for whoever fills it in.**

1. **Write plain facts, not sentences for the bot.** "Pet fee $300 one-time, $30/mo,
   no breed restrictions, 50 lb limit" is a good answer. The register comes from
   `docs/archive/AI_VOICE.md`, which is Class 1 doctrine and already written — staff
   supply the meat, the agent supplies the voice.
2. **"We don't know yet" is a valid answer and is better than a guess.** An absent
   fact makes the agent defer. A wrong fact reaches a prospect. `agent_facts`'
   own doctrine: *absence of a fact = unknown → honest handoff*
   (`053_agent_supervised_drafts.sql:106-110`).
3. **A range is not an answer.** "$75–99" is what made a real Solo fee unreadable to
   live prospects (`agent.js:126-131`). If the number genuinely varies, say what it
   varies *by* — floor, layout, term — and that becomes structure, not prose (§4.1).

Sources for this list: both Solo corpora, the seven benchmark cases in
`AI_VOICE.md` §5, and the questions any prospect asks that neither corpus covers.
Solo's own facts establish it is student-adjacent housing — 4233 Chestnut St,
Philadelphia 19104, with an I-20 path for international students and a financial-aid
note in the rent policy — so the student-market block in §7.4 is not speculative.

### 7.1 Tier 1 — required before the agent speaks to anyone

Twelve. Without these the readiness gate (§6.2) returns `agent_blocked`.

| Prospect asks | Staff supply | `fact_key` |
|---|---|---|
| "What building is this? Where is it?" | Legal/marketing name, full street address, ZIP | `building_identity` |
| "Who do I talk to? What are your hours?" | Leasing email, phone, office hours + timezone | `office_contact` |
| "Is this the right number to text?" | The number prospects reach, and whether it is monitored after hours | `communication_line` |
| "How much is it?" | **Which source wins when the pricing sheet and the system disagree** — see §9.1 | `pricing_authority` |
| "Can I see it? When?" | Where tours start, what they cover, how one is booked, tour hours | `process_tour` |
| "Will I get approved?" | Credit / income / background criteria, income multiple or minimum, decision window | `process_screening` |
| "What do I need to apply?" | Exact document list, and the alternates you accept | `process_required_documents` |
| "What lease lengths do you offer?" | Every term actually offered, whether 12 months exists (§9.2), and any short-term premium **as a single number, not a range** | `process_lease_terms` |
| "What's due up front?" | Application fee, admin fee, amenity fee, security deposit — **each as its own number** | `fee_application`, `fee_admin`, `fee_amenity`, `fee_security_deposit` |
| "Do you allow pets?" | Fee, monthly rent, **weight and breed limits**, where they can go | `policy_pets` |
| "What utilities do I pay?" | Which are included, which are billed, who bills them | `policy_utilities` |
| "Do I need renter's insurance?" | Required or not, minimum liability, who must be named | `policy_renters_insurance` |

Solo has all twelve except `pricing_authority`, and its `process_lease_terms` exists
only as a range in Corpus B. Its `policy_pets` is missing **weight and breed
limits** — the seeded text says
pet-friendly with a rooftop run and gives the fees, but nothing bounds the animal.
That is the most-asked pet follow-up and today the agent has to defer on it.

### 7.2 Tier 2 — asked constantly; the agent defers without them

| Prospect asks | Staff supply | `fact_key` |
|---|---|---|
| "Is there parking? Is it guaranteed?" | Monthly cost, assigned or not, waitlist, guest parking, street reality | `policy_parking`, `fee_parking_monthly` |
| "Any specials right now?" | The concession, the terms it applies to, **and the date it ends** | `concession_current` |
| "When is rent due? What if I'm late?" | Due date, grace period, late fee and how it is calculated, how to pay | `policy_rent_payment` |
| "What's the move-in process?" | Hours, where to check in, what must be paid and when, what is needed for keys | `process_move_in` |
| "What amenities are there?" | What exists and where — by floor, if that is how it reads | `amenities` |
| "Is there laundry?" | In-unit, on-floor, or a room — and whether it costs anything | `amenities` |
| "Is it quiet? What are quiet hours?" | The posted hours. Nothing about who lives there — see §8 | `policy_noise` |
| "Can I have guests? Overnight?" | Guest limits in units and amenity spaces, escort rules, guest parking | `policy_guests` |
| "Can I smoke? Vape? Grill on the balcony?" | Smoke-free or not, prohibited items, any fire-safety list | `policy_smoking_and_restrictions` |
| "Is it furnished? What comes with it?" | Furnished options, exactly what is included, price difference | `furnished_options` |
| "Can I see it if I'm out of town?" | Which layouts have 3D tours, whether live video is offered and when | `virtual_tours` |
| "Do you charge for a replacement key or fob?" | Fob, key and lockout charges, and office-hours help | `fee_access_replacement` |
| "Is there a fee for internet/cable?" | Provider, speed, monthly charge, whether it is optional | `fee_telecom` |

Solo covers most of this, but two answers live in the wrong place. **Laundry** is in
neither corpus — it is asserted in the prompt itself (`agent.js:808`, *"Apartments
include in-unit laundry and kitchen appliances"*), which means property #2 inherits
it. And `lease_terms` exists only in Corpus B, phrased as *"short-term or
month-to-month is available at a **15-20% premium**"* — a range, so it is one of the
seven rows behind defect D6 and is not a quotable number.

### 7.3 Tier 3 — asked often enough to be worth pre-answering

| Prospect asks | Staff supply |
|---|---|
| "What's available and when?" | Nothing — availability is read **live** from `units` and must never be curated here (`053:106-108`). Corpus B breaks this: `availability_as_of` says availability *"reflects the property's May 31, 2026 operating report"* — a curated availability snapshot, now months stale, with no `effective_until` |
| "Can I transfer units later?" | Whether transfers are allowed, any fee, timing |
| "Can I sublet for the summer?" | Allowed or not, approval path, any fee |
| "What happens if I need to break the lease?" | Early-termination terms, notice period, fee |
| "How much will it go up at renewal?" | Whether you state a policy at all, or defer every time |
| "Is there storage? A package room? An elevator?" | What exists |
| "Is there A/C? How is it heated?" | System type, who controls it, who pays |
| "How do I get my packages?" | Lockers, mail room, front desk hours |
| "Trash and recycling?" | Where, when, any rules |
| "Is the building accessible?" | Unit and common-area accessibility. **Answer factually — do not deflect** (`agent.js:729`) |

### 7.4 Student-market block

Solo's own facts establish this market, so these are not optional there. Any property
near a campus needs the same set.

| Prospect asks | Staff supply |
|---|---|
| "Do I lease a bedroom or the whole apartment?" | Per-bed or per-unit. `agent_facts.space_id` already models bed-level scope (`053:114`), and Solo's fee text says charges are "split among roommates" |
| "Are roommates on one lease or separate?" | Joint or several liability, and whether you screen each roommate |
| "Do you match roommates?" | Yes/no and how |
| "Do you have academic-year leases?" | Terms that align to a school year, if any |
| "I have no credit / I'm international — can I still apply?" | Guarantor policy, international path, what you accept in place of credit |
| "My parents will cosign — how?" | Cosigner or guarantor process, what they must supply |
| "I'm paying with financial aid — is that OK?" | Whether aid timing is accommodated, and who rent is actually paid to |
| "How far is campus? Is there a shuttle?" | Distance and transit facts you can stand behind |

Solo answers the international path (I-20 plus three months of bank statements) and
the financial-aid question (paid to the building on the portal, not affiliated with
any school). It does **not** answer per-bed vs per-unit, roommate liability,
guarantors, or academic-year terms — and those are the four a student asks first.

### 7.5 Legal-weight questions — required, and never inferred

These carry statutory exposure and the prompt already forbids answering them from
general knowledge. `agent.js:717`:

> "Source-of-income and voucher protection, security deposit caps and return
> deadlines, notice periods, guest and occupancy limits, late fee limits, lease break
> terms, rent regulation: all of these vary by city and state. **NEVER** state one
> from general knowledge, **NEVER** infer one from another property, and **NEVER**
> quote a statute or a deadline. If it is not in VERIFIED PROPERTY FACTS for THIS
> property, you do not have it."

So each of these must be supplied per property, by someone who knows the
jurisdiction, with `source_class = regulatory` or `lease_document`:

| Prospect asks | Why it must be a fact |
|---|---|
| "Do you accept housing vouchers / Section 8?" | Source-of-income protection is local law and varies. Asked constantly and cannot be guessed. |
| "How many people can live in a unit?" | Occupancy limits are jurisdictional, and the answer brushes familial status. |
| "When do I get my deposit back?" | Caps and return deadlines are statutory. |
| "How much notice do I have to give?" | Notice periods are statutory. |
| "What's the late fee, exactly?" | Late-fee ceilings are regulated in some jurisdictions. |

Solo states a 10% late fee after a grace period through the 5th. Whether that is
lawful in Philadelphia is a jurisdiction question, not a policy question — and it is
stamped `management_policy` today rather than `regulatory` (defect D3).

---

## 8. Questions that must NOT become facts

Some of the most-asked questions must never be answered from the fact layer, however
politely a prospect asks. This list is as load-bearing as the one above, and it comes
straight out of the Solo benchmark cases.

**Resident characterization.** `AI_VOICE.md` Case A draws the line precisely: your
own words about the gym — *"a nice, comfortable crowd usually"* — were ruled
**unsendable**, while *"it rarely feels packed"* is fine.

> "*How full a room is* is an occupancy observation and is fine; *what the people in
> it are like* is a resident characterization and is not."

So: "What kind of people live here?", "Is it mostly students?", "Are there a lot of
families?", "What's the crowd like?" → describe the building, never the residents.

**Protected-class questions.** Case C is the template: a prospect asked whether
children were okay and a live thread answered with a counter-question and never said
yes.

> "**The word 'okay' gets answered before anything else.** That reads as hedging, and
> hedging on a protected class is the failure."

Affirm first, then help. Never route to a fact, never deflect, never qualify.

**Safety and neighborhood character.** "Is the neighborhood safe?", "Is there
crime?", "Is it safe for a woman living alone?" — there is no fact that answers these
honestly, and a reassurance is a liability. State what the building has (fob access,
staffed hours, cameras if they exist) and nothing about the area's character.

**Anything the property has not recorded.** Per `agent.js:816`, fees have exactly one
approved source, and an unrecorded fee is a defer — *"do not estimate it, do not
infer it from a similar fee, do not carry over a number from another building or an
earlier conversation, and do not pick whichever figure you saw first."*

**Utility cost estimates.** "Roughly how much is electric?" is asked constantly and
cannot be answered. Who bills it is a fact; what it will cost is not.

---
## 9. Owner rulings this needs

**9.1 Is the pricing sheet authoritative over live `units`?** Solo's open conflict:
the sheet says a studio is $1,450–1,600; unit 530 was quoted **$1,687**, which matches
nothing on the sheet; the 2-bed was quoted **$2,700** against a sheet saying $2,600
gross / $2,384 net, with the free month never mentioned — **$316/month worse than
reality** for the number the prospect cared about. This is a per-property question, so
the model gives it a key (`pricing_authority`) rather than a one-time answer.

**9.2 Which term is quoted when the prospect names none?** Open as `CURRENT_STATE`
rows #14 and #27. `src/money/effective_pricing.js:397-402` already returns
`published_terms` — *"With no term supplied the answer is the published menu"* — so
presenting the choice needs no schema change. #27 is the sub-case where a property
publishes no 12-month term. What it must not do is fall back to `terms[0]`.

**9.3 Does the vocabulary in §3 stand?** It is a reconciliation of two real corpora
plus the two-property review packet, not a greenfield list. Adding keys later is
cheap; renaming them after a property loads is not. **See §11.5 step 2 — do not
freeze it until the packet comes back**, because a vocabulary derived from one
property is a guess and one derived from three is a standard.

**9.4 When does the real Solo property join the demo facts?** The seed says *"that
join happens later."* The baseline should say whether property #2 loads against a
real property from the start.

---

## 10. Definition of done

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
- the `APPROVED SOLO PROFILE` block is gone, and `Solo` appears nowhere in
  `src/agent/agent.js` except where federal law is being stated;
- `tools/seed_solo_facts.js --confirm` succeeds against a scratch database (D1 closed);
- the §7 intake form has been completed once, by staff, for a property that is not Solo;
- a second property reaches `agent_ready` **without** a voice interview.

That last line is the test of whether this worked. Facts are per-property; register is
not — `docs/archive/AI_VOICE.md` is Class 1 doctrine with three Solo references in 274
lines, and a new property inherits it. If onboarding property #2 requires another
interview, the standardization failed.

---

## 11. Reconciliation with the two-property review packet

A parallel framework exists: the **Skyline and Greenery Leasing Knowledge Review**,
dated 16 September 2026 — an operator-facing review packet built from a 15 September
operator interview, the current property websites and a retained source library.
Skyline stands at five of ten descriptive shelves; Greenery at zero of ten.

**The two are not competing standards.** The packet is the *intake instrument*, this
document is the *system model*, and each fixes a real gap in the other. The packet's
own scope line already draws the same boundary as `053`:

```text
packet: "what belongs here"        →  agent_facts   descriptive, curated, stewarded
packet: "what stays governed        →  units (availability, rent)
         elsewhere"                    property_governed_charges (fees)
                                       lease documents (terms)
                                       policy documents (screening, legal)
```

### 11.1 Ten shelves mapped to the vocabulary

| Packet shelf | `fact_key` |
|---|---|
| 1 Leasing highlights | `positioning` |
| 2 Layouts and light | `layouts` |
| 3 Furniture and appliances | `furnished_options`, `unit_features` |
| 4 Amenities and access | `amenities`, `policy_guests`, `fee_access_replacement` |
| 5 Dimensions | `dimensions` |
| 6 Photos and floor plans | `media` |
| 7 Virtual tours | `virtual_tours` |
| 8 Packages and common questions | `package_handling` |
| 9 Neighborhood recommendations | `neighborhood` |
| 10 Move-in guidance | `process_move_in`, `policy_utilities`, `fee_telecom` |

Seven of those keys did not exist in §3.1 before this reconciliation. They are absent
from both Solo corpora because Solo's facts came from a policy handbook, and a
handbook does not contain the questions a prospect asks.

### 11.2 What this model adopts from the packet

1. **Stewardship** (§6.1b) — every shelf carries a future update owner, and every
   property a steward, an accountable approver, a next review date and a cadence.
2. **Source identity by digest** (§3.3) — the packet pins the governing lease by
   SHA256 and refuses a newer file that differs in its fee fields, on the grounds
   that a filename and a date are not identity.
3. **A recorded rejected-source list** (§3.3) — an allowlist cannot express "we
   examined this and it must not be used."
4. **Media class and reach** (§4.3) — asset class, exact-home versus
   representative, and the mapping to canonical inventory without which an asset is
   not sendable.

### 11.3 What the packet should adopt from this model

1. **Shelf 10 already drifted.** It is *"Move in guidance"* for Skyline and *"Move in
   utilities and internet"* for Greenery. Two properties, ten shelves each, and the
   tenth means different things. That is precisely how Solo's two corpora diverged
   (§1). Ten shelves is the right shape; they need one frozen list of names.

2. **"Leave unknown" discards the conflict.** The packet handles conflict exactly
   right at the moment of review — *"Do not approve either until reconciled"*, *"do
   not resolve them from memory or publish a blended number"* — but the recorded
   outcome is *unknown*, which loses **what the two claims were**. Greenery's
   dimensions are the case: a junior 1BR Matterport labelled 700 SF against a website
   saying more than 715, and a 2BR/2BA labelled 1,032 against more than 1,050. Stored
   as unknown, the next reviewer rediscovers the conflict from scratch.

   `present_but_conflicting` (§3.4) keeps both claims and
   their sources while refusing to answer. Same silence to the prospect, no lost work.

3. **A signed packet is not an activation.** The certification says approval *"applies
   only to items marked correct or corrected."* Nothing between the signature and a
   live quote enforces that — which is the exact gap migration `106` was written to
   close for governed charges. The certification block **is**
   `activated_at` + `activated_by`; it needs to land in a column (§5).

4. **Ten shelves at 10/10 still cannot quote.** The shelves deliberately exclude
   money, screening and lease terms, and correctly so. But that means shelf coverage
   alone cannot gate the agent: a property could reach 10/10 and still have no
   application fee, no deposit and no lease terms. The readiness gate (§6.2) has to
   span both halves, which is why §7.1's Tier 1 mixes descriptive and governed keys.

### 11.4 Two live defects the packet found

Worth carrying into `CURRENT_STATE` as property-onboarding defects rather than living
only in a review document:

- **A mislabeled lease source.** A file named as one property's lease template is
  actually a different property's lease, for another address and term. Filename-based
  source resolution would have used it.
- **A layout page video pointing at an unrelated title**, which "must not be used as
  a unit tour." A media asset whose `reach` and `layout_ref` were never established.

### 11.5 Sequencing

The packet is ahead and should not wait for the schema. It is fillable now, and its
answers are the input the model needs.

```text
1.  Packet returns filled, per property.
2.  Freeze the vocabularies (§3) against what actually came back — the packet is
    the second real corpus, and the vocabulary should be reconciled against two
    properties rather than one.
3.  Build the manifest and gate (§6) so the filled packet has somewhere to land.
4.  Migrate Solo onto it, as a mapping and not a retype.
5.  Load Skyline and Greenery through the gate. Neither goes live below agent_ready.
```

Step 2 is the reason not to freeze §3.1 this week. A vocabulary derived from one
property is a guess; derived from three, it is a standard.
