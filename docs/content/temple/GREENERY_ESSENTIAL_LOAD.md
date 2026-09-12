# Greenery essentials — six attributed drafts ready to stage

Prepared September 12, 2026 against API `d45d768`. No publication, new owner approval, production identity read, runtime change or schema change. Existing writer/reader/Ask behavior is unchanged.

## What is prepared

The existing `leasing-content.json` now has `staging_sets.greenery_essentials`, selecting six existing cards: amenities, layouts, photos, floor plans, virtual tours and common questions. It is bound to addressed Greenery UUID `a29181cd-3ba1-461c-aead-cd989add1d11`, retained from QB's September 11 identity read. This preserves the existing property's durable identity, not another same-name row.

Each selected card preserves its previous draft. Prior source check dates remain intact, with September 12 verifications appended. All ten Skyline cards and Greenery's other four cards are unchanged. These are **source-attributed drafts**, not Mike-confirmed policy or current exact-home facts.

The substantive changes are direct public 05/08 studio rendering links, freshly reachable representative Matterports, and an address/amenities FAQ without the stale manager contact. No new knowledge store or import writer was added.

## Fresh source checks

| Source | Supported result | Boundary retained |
|---|---|---|
| [Official amenities](https://www.templegreenery.com/ameneties-near-temple) | In-unit laundry, dishwasher, lockers, fob access and garage described | No cost, guaranteed security, access hours or blanket balcony entitlement imported |
| [Studio page](https://www.templegreenery.com/studio-apartment-near-temple) | 05/08 renderings and public gallery; 05 described as balcony studio | General amenities page's every-unit balcony claim is not adopted |
| [One-bedroom page](https://www.templegreenery.com/one-bedroom-apartment-near-temple) | Published 04/06/14 model descriptions and illustrations | No exact apartment mapping, dimensions or furnishing charge |
| [Two-bedroom page](https://www.templegreenery.com/two-bedroom-apartment-near-temple) | Published model illustrations, 01 street-facing and 12 two-balcony description | 02/16 paragraph still inconsistently says one-bedroom; no inferred correction |
| [Amber listing](https://amberstudent.com/places/the-greenery-philadelphia-2408064848211) | HTTP 200; both retained Matterport model IDs remain in listing HTML | Third-party listing association, not exact-home authority or approved prices/policies |
| [Junior 1BR Matterport](https://my.matterport.com/show/?m=H8eLkJVRrQT) and [2BR/2BA Matterport](https://my.matterport.com/show/?m=D3SQQ8uqFix) | Direct HTML requests returned 200 with expected model titles | Web opener failed; direct HTTP verified metadata only. No full walkthrough, room measurement or offered-home association claimed |
| [Contact page](https://www.templegreenery.com/contact-us) | Address corroborates 1325 North 15th Street, Philadelphia PA 19121 | Page still names John Franco and Fall/Winter 2025–2026. Name and phone deliberately excluded as current contact |

Published diagrams are marketing renderings. Fifteen private unit-group files remain in the retained workspace floor-plan inventory, not in public prospect payloads. Source filenames are not a canonical mapping. Tour title areas conflict with general website area figures; the selected virtual-tour wording omits the numeric areas rather than resolving the conflict by guesswork.

## Stage through the existing mechanism

Obtain a fresh authenticated `GET /operator/agent-facts` response while scoped to the verified Greenery property. Save the response privately, without its session token, then run:

```text
node tools/stage_leasing_content.js greenery_essentials a29181cd-3ba1-461c-aead-cd989add1d11 agent-facts-response.json > greenery-essential-plan.json
```

The unchanged tool requires packet UUID, explicit target and response property ID to agree. It emits six existing writer requests for a missing set, skips identical current cards, and prepares named replacements for changed/expired cards. It makes no network call. Review wording and dated evidence before any currently authorized Greenery staff actor publishes. A stale replacement must stop on 409; never fall back to create. Initial create has no absent-only concurrency precondition, so use one publishing actor and re-read before writing.

Offline assertions passed: six selected existing-writer payloads with documented source type and no fabricated confirmation timestamp; wrong-property refusal; unchanged repeat skip; all six previous drafts and 14 untouched cards preserved; no stale manager contact, private SharePoint link, dollar amount or numerical room area in selected wording. `git diff --check` passed. No runtime code changed, so no new database cluster or migration run was needed.

The writer records the actual publishing actor and confirmation time. Packet provenance is retained beside the request, not falsely supplied as a bound `source_record_id`; dated public source links remain in the wording. After any future authorized publication, workspace coverage and Ask should read the same `agent_facts` rows through their existing readers. **No fresh Greenery DB/HTTP/browser/Ask run was performed in this data-only lane.** Existing runtime proofs are evidence for the unchanged mechanism, not a claim that these cards are live.

## What still needs Mike or a canonical source

1. **Current leasing contact:** who handles Greenery inquiries, which publicly shareable phone/address should display, and whether the website contact details should be replaced. A website name does not assign work to Mike.
2. **Current amenities and furnishing package:** confirm the website's laundry, dishwasher, lockers, garage and optional furnishing descriptions remain accurate; identify any home-specific exceptions. Prices and access rules belong in their governed owners.
3. **Exact-home media mapping:** associate the 05/08 and other renderings with canonical homes, resolve the 02/16 bedroom-text conflict, and verify the apartment/layout shown in each Matterport. Existing representative links can remain useful without this mapping.
4. **Missing media and measurements:** is there a studio Matterport or newer photo set? Provide verified room dimensions only for the measured home; the present tour labels and website area statements conflict.
5. **Practical operating instructions:** confirmed laundry/package access, current key pickup/unloading instructions and after-hours contacts. Older welcome packets are historical evidence, not current instructions.

Current availability, rents, fees, parking amounts, qualification/accommodation policy, lease terms and tour slots remain with their canonical owners. They are deliberately not filled by this descriptive packet. Staff neighborhood favorites also remain unconfirmed; third-party recommendations are not silently attributed to Mike.
