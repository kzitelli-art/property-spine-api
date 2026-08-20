# Skyline — established business facts

`14e41b7c-e91c-49e8-9651-10c4988a8f6a` · Skyline Apartments · 1417 N 15th, Philadelphia
**72 units · 160 rentable bed positions · leasing_basis `bed`**

Everything below is **owner statement, 20 August 2026**, recorded as such.
Where the committed source corroborates it, that is noted. Nothing here has
been written to production.

## Established

```text
PRICING GRAIN      per bed, always. Never quoted per unit.
                   ✓ corroborated: each source row is one room carrying
                     "Total Beds":"1.00" and its own market_rent
FURNISHING         fully furnished
UTILITIES          all utilities INCLUDING INTERNET paid by landlord
UTILITY FEE        $500 one-time — or the resident may amortize it monthly
PARKING            available at additional charge   ← amount not yet stated
PETS               not allowed
```

### Rents — per bed

| our code | label | new-lease rent / bed | beds |
|---|---|---|---|
| `2BR` | 2 Bedroom | **850** | 112 |
| `3BR-1BA` | 3 Bedroom / 1 Bath | **750** | 36 |
| `3BR-1.5BA` | 3 Bedroom / 1.5 Bath | **775** | 12 |

The per-bed shape is what makes 3-bed cheaper than 2-bed coherent, and it
sits next to the rent roll's own per-room `market_rent` of 875.

## Where each fact belongs

`properties.lease_config` requires exactly six keys (`REQUIRED_CONFIG_KEYS`
in `leasepackets.js`). Packet generation fails closed naming any that are
missing — never a plausible default.

```text
landlord_entity          ✗ STILL NEEDED — which legal entity leases Skyline?
application_fee          ✗ STILL NEEDED
amenity_fee              ✗ STILL NEEDED
utility_responsibility   ✓ ANSWERED — landlord pays all utilities incl. internet
late_fee                 ✗ STILL NEEDED
notice_requirement       ✗ STILL NEEDED — days' notice to renew or vacate
```

The remaining facts are not among the six required keys and need placing
deliberately rather than jammed into them:

```text
furnished        a durable property/type attribute. Solo's config carries
                 extra keys beyond the six (rent_payment_location,
                 telecom_fee, insurance_note), so an additional configured
                 term is the existing pattern.
$500 utility fee lease_economic_lines.line_type already admits BOTH
                 'one_time_fee' and 'recurring_fee', so the fee and its
                 amortized form are each expressible. Whether a RESIDENT
                 CHOOSES between them during application is a product
                 behaviour, not just a vocabulary — unverified.
parking          an optional add-on, not a flat lease fee. Needs an amount,
                 and whether it is per bed, per space or per vehicle.
no pets          a policy statement; belongs in the lease instrument's terms
                 rather than in pricing.
```

## Still outstanding before pricing can publish

The publication contract refuses an incomplete proposal, so these are hard
requirements, not preferences:

```text
renewal rent per type    'renewal_pricing_not_addressed' — never inherited
lease term(s)            one term or several? 12 months?
effective date           published ≠ effective; a version dated ahead
                         correctly refuses to quote until that date
offered / not-offered    assumed all three offered unless stated
```

## Not established, and not invented

```text
the 1 bath vs 1.5 bath distinction
    Owner knowledge. The source is SILENT — units.bedrooms and
    units.bathrooms are NULL for all 72 units, square footage is null/0,
    and the rent roll's "Unit/Room Type" column carries the bare code with
    no legend. Recorded under the ruling receipt
    skyline_owner_statement_2026-08-20_source_silent_on_bath_distinction.
```
