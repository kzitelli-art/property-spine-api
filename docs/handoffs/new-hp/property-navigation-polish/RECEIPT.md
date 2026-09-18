# Property navigation and address presentation — release receipt

**Released 2026-09-16 21:26 UTC.** App `610439db2c7df6a1aad3a2e9dcf1fb26752b843d` is live at Render deployment `dep-dalgimbl550s73b6up1g`. The API is unchanged at `cd7279ebb23865f4e3e7f9c827dd4b5cc52d475f`; production schema remains 187 applied migrations through ceiling 199.

## Result

The app now has one clear route back to the existing governed property picker:

- the current property name in the app bar includes a caret and opens the picker;
- the persistent action says **All properties** instead of the generic **Properties**;
- the property Home screen also includes **Switch property**;
- Home continues to name the current property, while the existing Back control continues to mean one level back inside that property;
- every switch still goes through `POST /operator/properties/select`, server-minted scope, `/operator/me` verification, and the existing property-cache reset. No browser-held property authority was introduced.

The chooser applies a display-only address formatter to the server-authorized rows. It normalizes whitespace, compass direction casing, common street suffixes, and the retained Philadelphia shorthand. The current Temple presentation is:

| Retained value | Presented value |
| --- | --- |
| `1417 n 15 phily` | `1417 N 15th St, Philadelphia` |
| `1325 N 15th Street, Philadelphia` | `1325 N 15th St, Philadelphia` |
| `4233 Chestnut St` | unchanged |
| `4125 Chestnut St` | unchanged |
| `1 Demo Way` | unchanged |

The formatter does not mutate the API payload, cache, property record, canonical key, registry model, or identity. It does not append a city when the source did not supply one.

## Verification

- sanctioned app suite: **72 harnesses / 2,427 passed / 0 failed / 0 red**;
- focused `live_deal_picker.browser.js`: **31 passed / 0 failed** in real Chrome;
- focused proof covers Home → picker, Leasing → picker, authorized order, current-session marking, active and alternate property selection, server-scope agreement, refusal after revoked access, session expiry, delayed-select/sign-out race, list-read failure, and the 402px chooser;
- Render checked out exact commit `610439db2c7df6a1aad3a2e9dcf1fb26752b843d` and reported **Deploy succeeded · Live**;
- `tools/verify_served_assets.js` completed at `2026-09-16T21:26:32.789Z` with `all_match: true` for every served first-party file.

The deployed public sign-in page exposes the new **Switch property** and **All properties** controls. A signed-in production session was not recreated for this release; the signed-in behavior is established by the focused real-browser proof against the full app with sealed session transitions, while served-byte verification establishes the deployed artifact.

## Scope

This was an app navigation and presentation release. It changed no property identity, assignment, module grant, organization, inventory, occupancy, rent, pricing, availability, readiness, lease, knowledge, customer communication, API source, or database schema. The prior rollback app is `3607b3d5891a4a96b6b5183ead875b974863aef9`.
