# The two pickers, traced to their readers

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

**The signed-in chooser is correct and is not the problem.**
`authorized_properties.js` coalesces for display *and* sorts by the coalesce —
the only reader found so far that does both. It returns each property with the
caller's `allowed_modules`, which is what draws the four doors. Nothing about
it needs fixing.

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

Whether the picker Kameron actually lands on is `/deals`, `/operator/properties`
or a client-side composition of both. **That answer is in the app repo**
(`property-spine-app`, pinned `b0be9f4`), which was not read here. The
Network-tab evidence from 15 Sep shows the dashboard calling `properties` and
`me`, which points at the authenticated chooser — but one screenshot is not a
trace, and the deal-picker landing page was not captured.

**Next concrete step:** on the deal-picker page, DevTools → Network → reload,
and read which of the two is called. That is a thirty-second answer to the one
question this trace could not reach from the API side.

## Recorded, not fixed

- `deal_registry.js` pins two literal production property ids in committed
  source. Same defect class as CURRENT_STATE row 52, where a route compared
  every operator's property against a production id written into a file.
- Four of the six registry entries carry `property_id: null` and resolve by
  canonical key instead. Two resolution paths for one fact.
- Each registry entry holds exactly one `property_id`. The structure cannot
  express a deal holding several properties, while `deal_intake_properties`
  can and has since June.
