# SOLO_FACTS_PACK.md — unresolved source conflicts

**Status:** Class 3 (temporary). **Removal condition:** delete a row once an owner designates the authoritative source and the value is seeded in `src/shared/facts-seed.js`.

`facts-seed.js` states the rule this file implements: *"Values with source conflicts are NOT seeded here — they are held in SOLO_FACTS_PACK.md for Katie to resolve first (honest blank beats confident wrong)."* The file was referenced but did not exist. This is it.

**Everything below is a value the agent may be asked for and must NOT assert** until resolved. Where a floor exists, the agent defers instead of guessing.

---

## 1. Rent — pricing sheet vs live `units` rows ⚠️ COSTING MONEY TODAY

**Authority (proposed): `03. Leasing & Marketing / Current Pricing & Specials July 2026.pdf`.** Dated the current month, titled "Current."

| Type | Sheet, gross | Sheet, net |
|---|---|---|
| S.1UN studio unfurnished | $1,450 | — |
| S.1FN studio furnished | $1,600 | — |
| 1.1UN 1BR unfurnished | $1,800 | — |
| 1.1FN 1BR furnished | $2,000 | — |
| 1.1DN 1BR + den | $2,250 | — |
| 2.2UN 2BR | $2,600 | **$2,384** ($1,192/bed) |
| 3.2UN 3BR | $3,270 | **$2,997** ($999/bed) |

Premiums: +$100 7th floor · +$50 6th floor · +$50 odd-numbered units. **Seeded** (`pricing_premiums`).
Concession: 1 month free on a one-year lease expiring July 2027. **Seeded** (`current_concession`).

**The conflict — live data disagrees with the sheet:**

- The agent quoted a live prospect **$2,700** for the 2-bed (units 402/602, 935 sq ft). Sheet says **$2,600 gross / $2,384 net**. Overquoted by $100, and the free month was never mentioned — so the number he actually cared about was **$316/month better** than what he was told. He went cold partly on value.
- The agent quoted **$1,687** for studio 530. Sheet says $1,450–$1,600. Unit 530 is 5th floor and odd-numbered, so the only applicable premium is +$50 → $1,500 or $1,650. **$1,687 matches nothing on the sheet.**

**Not resolved here on purpose.** Unit rent is read live from `units` by design, and I cannot tell whether the DB reflects real current asking rents, stale seed data, or something the sheet does not capture. Overwriting real rents from a marketing PDF would be the exact "confident wrong" this file exists to prevent.

**Owner decision needed:** is the sheet authoritative over `units`, or does `units` hold something the sheet does not?

---

## 2. Fees — three sources, three answers

The agent currently **DEFERS** on all fee amounts (`agent.js`, "FEES ARE CURRENTLY UNGOVERNED"). Removal condition for that rule is this row being resolved.

| Fee | agent fact seed | `facts-seed.js` | CRM FAQ | SMS template |
|---|---|---|---|---|
| Amenity | $300 ($250 renewal) | $250 ($150 renewal) | — | — |
| Security deposit | $1,000 to one month's rent | — | **one month's rent** | **one month's rent** |
| Pet | $300/pet | $300/pet | **$300 dog / $200 cat** | $300/pet |
| Move-in total | app + deposit + amenity + telecom | — | deposit + first month | — |

Deposit has **three sources agreeing** on "one month's rent" against the seed's range. That one looks resolvable immediately.

---

## 3. Guarantor income multiple — 3x or 5x

- **3x** monthly rent — EOD training report (*"guarantor must make 3x monthly rent, no paystubs required"*)
- **5x** monthly rent — Application Requirements SMS template

Applicant income is 3x rent in both. Only the **guarantor** figure conflicts.

---

## 4. Guest stays — no source at all

The agent told a live prospect his mother could stay **two months** and that it was "totally fine." That is invented. The seeded `guest_policy` covers **amenity-space** guests only (up to two, accompanied). The CRM FAQ lists *"Are guests allowed to stay in my unit for a couple of days?"* as an **unanswered** question.

Needs the lease's actual guest/occupancy term.

---

## 5. Source of income / Section 8 — no source, jurisdictional

Source-of-income is a protected class under the **Philadelphia** Fair Practices Ordinance and is **not** a national rule, so this must be answered per property, not globally. Appears in no source. The `legal:local_law_claim` floor currently blocks the agent from answering it from memory.

---

## 6. Internet provider — asserted, contradicted

The agent told a prospect Flume is **required** and cannot be opted out of, then said a minute later it needed to check. The CRM FAQ says: *"What internet options are available? Flume or Xfinity."*

---

## 7. Golf simulator hours

CRM FAQ: all amenities 24/7 **except** the golf simulator. Its actual hours appear nowhere. The prompt now forbids folding it into a 24/7 claim; the real hours are still unknown.

---

## 8. Matterport tour URLs — ✅ RESOLVED 2026-07-25, one gap remains

Five links supplied by Kameron and each **verified by fetching the space and reading its own title** — not assumed from filename:

| Layout | Space title | URL |
|---|---|---|
| Studio | "Studio at 4233" | `my.matterport.com/show/?m=H5qs9j6vYc5` |
| One bedroom | "One Bedroom at 4233" | `my.matterport.com/show/?m=CbvpwiPGRah` |
| Furnished model 1BR | "Model One Bedroom at 4233" | `my.matterport.com/show/?m=CVU7qPMehm9` |
| One bedroom + den | "One bedroom with Den" | `my.matterport.com/show/?m=QmzDAeTLUmK` |
| Three bedroom 2 bath | "3 Bedroom 2 Bath (650)" | `my.matterport.com/show/?m=tBSRwYtiTMU` |

Seeded as `virtual_tours`. Notes:

- `CVU7qPMehm9` was flagged earlier as possibly belonging to **4125 Chestnut** because a multi-property template flow doc listed it beside that address. Fetching it resolved this: it is 4233's model one-bedroom. The earlier caution was right; the conclusion was wrong.
- The 1BR+den tour is a **fifth** space not present in the `01.Matterports` folder, which holds only four `.web` shortcuts.
- "3 Bedroom 2 Bath (650)" — 650 is a **unit number**, not square footage (a 3BR/2BA at 650 sq ft is not credible, and it matches the 402/530/602 numbering pattern). So that tour was shot in a real apartment, which strengthens the layout-not-unit framing rather than weakening it.

**⚠️ Still open: there is no two-bedroom tour** — the layout prospects ask about most, and the one quoted to a live prospect. The seeded fact explicitly forbids substituting another layout for it. Kameron owns a camera; this is the highest-value shoot available.

---

## 9. Screening criteria — for counsel, not for the prompt

Materials state *"no felonies, no prior evictions, no misdemeanors of a sexual or violent nature."* Blanket criminal-history bans are the subject of specific HUD guidance, and blanket eviction-record screens carry their own exposure. **Not a prompt question.** Flagged so nobody grounds the agent on this language without review.
