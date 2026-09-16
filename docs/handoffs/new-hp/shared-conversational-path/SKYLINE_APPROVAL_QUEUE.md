# Skyline — leasing knowledge approval queue

**Prepared 2026-09-16. Nothing here is published. No fact in this file has been
written to `agent_facts`, and none may be until a named operator approves it
through the existing property-scoped editor.**

## What this is, and what it is not

The shared conversational path now reaches the same governed knowledge from the
website and from SMS. That closes a code gap. It does not create knowledge:
where Skyline has no approved fact, both channels correctly say so, and that is
the behaviour to keep.

This queue names **which questions Skyline cannot currently answer**, so an
operator can decide what is worth recording. It deliberately proposes no
wording. Drafting the answer here would make this file a second, ungoverned
source of property truth, and the whole point of the existing editor is that
there is exactly one.

## How this was derived, and its limits

⚠ **This session had no production database or API access.** The coverage below
is read from the committed production review
[`../property-knowledge-onboarding/LIVE_PROPERTY_ACCESS_AND_REVIEW_20260916.md`](../property-knowledge-onboarding/LIVE_PROPERTY_ACCESS_AND_REVIEW_20260916.md),
recorded by the operator who performed that live session on 16 September.

That review covers the **ten descriptive shelves** only. It says nothing about
the seven governed keys in the second table, so their status at Skyline is
**unknown here, not absent** — confirm before acting on that section.

## The ten descriptive shelves

Per the 16 September production read-back: **five of ten**.

| Shelf | Skyline | A prospect asks |
|---|---|---|
| `leasing_highlights` | ✅ recorded | "why this building?" |
| `amenities` | ✅ recorded | "is there a gym / laundry / roof deck?" |
| `leasing_faq` | ✅ recorded | "is wifi included?", "can I sublet?" |
| `layouts` | ✅ recorded | "what layouts do you have?" |
| `neighborhood` | ✅ recorded | "what's around?" |
| `dimensions` | ⛔ missing | "how big is the bedroom?" |
| `photos` | ⛔ missing | "can I see pictures?" |
| `floor_plans` | ⛔ missing | "can I see a floor plan?" |
| `virtual_tours` | ⛔ missing | "is there a Matterport?" |
| `move_in_guidance` | ⛔ missing | "where do I pick up keys?" |

The review is explicit that exact-home photo, floor-plan, dimension and
Matterport associations **remain unestablished** pending the media mapping. Those
four are therefore not simply unwritten — they are blocked on a mapping decision,
and recording a representative image as if it showed a particular home would be
the wrong fix.

## The seven governed keys — status unconfirmed

These are the keys the operator editor writes outside the ten shelves. They
carry the most-asked prospect questions, and **none of them is covered by the
16 September review**, so each needs a live read before anyone decides whether
it is a gap.

| Key | Category | A prospect asks | Why it matters most |
|---|---|---|---|
| `pet_policy` | `pets` | "can I bring my dog?" | The single most common opening question. |
| `parking_rules` | `parking` | "is there parking?" | Partly served today by the `amenities` shelf. |
| `tour_window` | `tours` | "can I see it Saturday?" | Without it the agent cannot state when tours happen. |
| `fee_policy` | `fees` | "what fees are there?" | ⚠ Economic. Amounts belong in governed charges, not here. |
| `required_documents` | `documents` | "what do I need to apply?" | Blocks the completeness question already on the Griv list. |
| `office_contact` | `routing` | "where's the office?" | |
| `communication_instructions` | `routing` | "how do I reach someone?" | |

## Two questions the code still cannot route, whatever is approved

Found while measuring channel parity, and recorded rather than fixed, because
widening pattern coverage was explicitly out of scope for this work:

- **"do we allow dogs"** and **"wheres the office"** are not recognised as
  knowledge reads on the SMS rail, because `leasing_knowledge.topicsFor` covers
  only the ten descriptive shelves — `pet_policy` and `office_contact` are not
  among them. Recording those facts will not by itself make the SMS rail route
  the question to them.
- The fix is a small addition to the shared registry, not to either channel.
  **It is not done here.** Whoever picks it up should note that the same
  question already routes correctly on the web, so this is a rail gap rather
  than a knowledge gap.

## The rule this queue exists to protect

Missing information stays unknown. It does not become *"no"*, *"free"*, or
*"not available"*, and it is never answered from the demo property or from
another building. An operator reading this queue is deciding what to **record**,
not what the agent should **say** in the meantime — the agent already says it
cannot confirm, which is correct and should remain correct after approval too
for anything left unrecorded.
