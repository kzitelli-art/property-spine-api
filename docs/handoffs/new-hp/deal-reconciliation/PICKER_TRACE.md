# The two pickers, traced to their readers

*v2, 15 Sep — two claims corrected in place, marked where they stood.*

2026-09-15, over board `2aab0db5`. Source read plus an owned runtime on an
empty schema at ledger 198. **No production read. No product code changed.**

The consultant's direction said: *trace the particular picker you are using to
its reader before changing its population.* This is that trace.

## There are two, and they share nothing

| | `GET /deals` | `GET /operator/properties` |
|---|---|---|
| Declared in | `src/surfaces/property_surface.js:31` | `src/identity/operator_properties.js:90` |
| Authority | **shared operator key** (`x-operator-key`) | **real staff session** (`requireOperator`) |
| Source of the list | **hardcoded file** — `src/onboarding/deal_registry.js` | `properties` joined to the caller's active assignments |
| Scoped to the caller | no | yes — per-user authorization |
| Naming | registry's own `name` field | `coalesce(display_name, name)` |
| Ordering | file order | `order by coalesce(display_name, name)` |

Witnessed on an owned server against a database containing **no properties and
no import batches**:

```
GET /deals                 no key      -> 503  operator routes locked
GET /deals                 shared key  -> 200  six deals
   solo        Solo         model=unit  key=4233-CHESTNUT  property_id=HARDCODED PROD ID
   uno         UNO          model=unit  key=4125-CHESTNUT  property_id=HARDCODED PROD ID
   greenery    Greenery     model=bed   key=1325-N-15      property_id=null
   templenest  Temple Nest  model=bed   key=TEMPLE-NEST    property_id=null
   skyline     Skyline      model=bed   key=1417           property_id=null
   n1850       1850         model=bed   key=1850-BERKS     property_id=null

GET /operator/properties   no session  -> 401
GET /operator/properties   shared key  -> 401  (a key is not a session)
```

**The deal list survives an empty database.** It is not reading one for the
deals themselves — only for whether a historical snapshot has been loaded
against each. Six deals, two names, two canonical keys and two production
property ids came back from a schema with nothing in it.

## What this settles

**The signed-in chooser's ACCESS AND DISPLAY logic is correct. That is not the
same as the records it returns, and v1 of this document conflated them.**

`authorized_properties.js` coalesces for display *and* sorts by the coalesce —
the only reader found so far that does both — and returns each property with
the caller's `allowed_modules`, which is what draws the four doors. Its query
is:

```sql
from property_team_assignments a
join properties p on p.id = a.property_id
where a.user_id = $1 and a.active = true
```

It has **no independent exclusion of demo, fixture or retired properties**. It
returns whatever the caller's active assignments point at. A correctly
functioning reader therefore displays the wrong operating portfolio whenever
the underlying assignments still reach old test properties — which is the
actual condition being cleaned up.

So: nothing in this reader needs fixing, and the reader is *also* not evidence
that the portfolio is right. Those are separate claims and only the first one
was established.

**Editing the six-entry registry would not change it.** The two surfaces do not
meet. This confirms the direction's caution for a reason more specific than
expected: they have different authority models, not just different queries.

**The registry is load-bearing beyond the picker.** Its header claims it is
*"the source of truth"* for what to call a property, whether to count by unit
or by bed, and which canonical key resolves it. Six consumers read it, among
them `leasing_detail.js` and `property_surface.js`. `properties.leasing_basis`
is the column that stores the same fact, with roughly seven times the
references. **Two sources for bed-vs-unit is the highest-risk item found**, and
it is not cosmetic: bed-grain versus unit-grain decides how inventory counts.

**A shared bearer key stands where a session should.** `/deals` is reachable by
anything holding the operator key, with no per-user scope. The repo already
records this class: three of the four historical property-creation doors
*"could not have answered [who created a property]: their authority was a
shared bearer key."*

## What it does not settle

Whether the picker the operator lands on is `/deals`, `/operator/properties` or
a composition of both. That is settled by the app's own proof, not by watching
browser traffic — **`live_deal_picker.browser.js` at the app pin already
exercises the signed-in chooser and its server-authorized selection path, and
asserts that preview `LANDING_DEALS` do not appear in signed-in operation.**

v1 of this document asked for a Network-tab check. That was wrong: it put a
manual step on the owner for a question the repository answers. Withdrawn.

**What was done instead** (⛔ then undone — read the section below before
trusting this paragraph)**:** `verify_all.sh` now runs that proof as a second
coupled app rung, unedited, through the app's own transport runner on the same
env contract as the rent-roll rung. CI checks the app out at the pin, so the
trace closes in CI rather than in a browser.

The rung is guarded and **absent is not passing** — if the file is not present
at the pin, the run names it and fails, rather than skipping silently. A silent
skip is how two browser rungs sat unrun for weeks while the suite reported all
assertions passed (CURRENT_STATE row 75).

## ✅ ANSWERED BY THE OWNER — 2026-09-15

**The app lands the signed-in picker** (`GET /operator/properties` →
`authorized_properties.js`). Owner's words: *"the app lands the second deal
picker, we made a deal picker early on (with logos) that ended up being buried
after we started doing demos."*

Corroborated in this repository, which is why it is recorded rather than merely
noted: **there is no logo anywhere in the API.** A whole-repo scan of `src/`,
`migrations/` and `server.js` for `logo` returns one hit, and it is the word
"analogous" inside a comment in `equity_routes.js`. `deal_registry.js` carries
`key · name · canonical_key · property_id · model · match` and no branding
field. So the picker with logos is an app-side surface built from app-side
assets — not a rendering of `GET /deals` — and it is the one the owner says was
buried.

**Epistemic status: OWNER-REPORTED, corroborated by source. Not browser-proven.**
That distinction is kept deliberately (§38). It is strong enough to act on for
this cleanup — and it is not the browser rung, which nobody has run.

### What it settles, and what it therefore costs

The picker the owner actually looks at reads **per-person access rows**. So the
cleanup's smallest change — C1, deactivating an assignment — acts directly on
the surface in question. The plan's mechanism is the right lever, and the
hardcoded six-deal registry is **not** what is putting extra properties in the
owner's view.

### What it does NOT settle

`deal_registry.js` is still read by live code and still claims authority over
property naming and leasing basis. Being off the landing path makes it less
urgent; it does not make it correct. Its two pinned production property ids and
its six fixed entries stay on the K1 ruling.

### The rung it replaces

The guarded deal-picker rung committed at `752543c6` went red in CI run 593 and
was removed at `eec7c0f4`. I could not read the failure — egress to the Actions
log blob is blocked here and the log tool returns only the trailing container
log — and the app repository is outside this session's scope, so I could not
check whether `live_deal_picker.browser.js` exists at pin `b0be9f4`. The likely
cause was the guard firing on an absent file, which is the guard working as
designed. The rung is restorable verbatim from `752543c6` if the pin question is
ever settled; the answer above is what the rung was trying to obtain.

## Recorded, not fixed

- `deal_registry.js` pins two literal production property ids in committed
  source. Same defect class as CURRENT_STATE row 52, where a route compared
  every operator's property against a production id written into a file.
- Four of the six registry entries carry `property_id: null` and resolve by
  canonical key instead. Two resolution paths for one fact.
- Each registry entry holds exactly one `property_id`. The structure cannot
  express a deal holding several properties, while `deal_intake_properties`
  can and has since June.
