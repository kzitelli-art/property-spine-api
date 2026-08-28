# Build 1 — classifying the existing Ask Spine path

> ## ⚠ STATUS — 2026-08-12. HISTORICAL CLASSIFICATION. COUNTS ARE STALE.
>
> `ask_spine.js` is no longer 81 lines with one route — it carries two, and the
> POST answers typed questions. The classification method here is sound; the
> inventory it produced is out of date. **Do not quote its counts.**
>
> Doctrine that now governs Ask Spine: `PHILOSOPHY.md` §40.

**The one source-grounded audit required before code** (ruling 21). Read against
the RC tree `f6873d7`, not against memory.

The rule being applied: *"existing Ask Spine code" ≠ "governing Build 1
architecture."* Slice 1 shipped `maintenance.attention`, which §3 marks
**intentionally unfrozen**. Its plumbing is good. Its product semantics must not
become load-bearing for a frozen intent.

## What exists

```text
src/agent/ask_spine.js           81 lines   one route, GET /operator/ask-spine/attention
src/agent/ask_spine_service.js  143 lines   attention(), MAX_ITEMS, MODULE_TO_DESK
server.js:3059                              mounted — this is DEPLOYED behaviour
```

---

## REUSE — plumbing, and it is genuinely good

| | what | why it is reusable |
|---|---|---|
| `requireOperator` | resolves `x-staff-session` → operator, else 401 | server-derived identity. Build 1's authority requirement is the same one |
| `refuseClientProperty` | a client `property_id` that differs gets **403**, not silence | it refuses rather than quietly ignoring, so a caller cannot believe it chose the scope. Exactly ruling 16 |
| `gate = [requireOperator, refuseClientProperty]` | composition | one seam, applied per route |
| the `catch` posture | a read failure returns 500, never an empty result | *"A failure is a failure. It must never reach the browser shaped like an empty result."* This is ruling 5's UNAVAILABLE-vs-VALID_EMPTY doctrine already written down |
| `total_open` counted over the **same predicate** as the page | cap honesty | the pattern ruling 7 requires. The *number* is attention's; the *pattern* is right |
| navigation-only-where-a-verified-opener-exists | `navigationFor` returns `null` rather than guessing | ruling 15's "canonical navigation target if one already exists" |

Module entitlement also already comes from the session (`allowed_modules`), and an
operator with none gets an honest empty with `scope_note`, not an error and not
everything.

## DO NOT MAKE LOAD-BEARING — product semantics

| | what | why not |
|---|---|---|
| `attention()` | `maintenance.attention`, **unfrozen** (§3). Reads `obligations`, not work orders | different domain, different question, no frozen contract |
| ranking: overdue → unassigned → due-soonest | an obligation triage order | Build 1 ranks nothing (ruling 15: no ranking, priority or attention under "supporting records") |
| `reasonFor()` | attention's reason vocabulary | not the five answer outcomes |
| `MODULE_TO_DESK` / desk navigation | obligation→desk map | Build 1 navigates to a **work order**; the map does not contain that case |
| `MAX_ITEMS = 5` | attention's page size | **see the correction below** |

### Correction to my own earlier advice on the cap

In `BUILD_1_FIRST_CAPABILITY.md` (T4) I wrote *"reuse the existing `MAX_ITEMS` — do
not introduce a second cap constant."* Against ruling 11 that is **wrong in
detail**: `result_cap` is a **field of the intent contract**, so each intent
declares its own and freezes it. Sharing one module-level constant across intents
would mean changing one intent's cap silently changes another's, and neither
contract digest would move.

The correct rule, and the one being followed: *one cap **mechanism**, one cap
**value per frozen contract**.* `MAX_ITEMS` stays exactly where it is, owned by
attention. Build 1's cap lives in its contract.

## MISSING — what Build 1 needs and Slice 1 does not have

Slice 1 *"records nothing"*, by design. So none of this exists yet:

1. **Durable read receipts.** No table, no service. Ruling 12 requires one, and
   ruling 17 makes a failed receipt write fail the whole execution. This needs a
   migration — **141 is free**, checked across every remote branch, no collision.
2. **Intent contracts** — slug, version, digest, predicate, required sources,
   evidence-time rules, cap, supported and withheld conclusions, renderer contract.
3. **Coverage judgement** — read statuses → coverage state, computed not chosen.
4. **A controlled renderer** — structured conclusion codes → operator language.
5. **A contract-freeze gate** — extending `FROZEN_ARTIFACTS.json` +
   `gate_release0_frozen.js`'s runner, not a parallel framework (ruling 11).

## CONFLICT CHECK — none found

Ruling 21 asks for any real conflict between the frozen Build 1 contract and
currently deployed behaviour, surfaced *before* changing production.

**There is none.** Build 1 adds a route to an existing door. It does not read
`obligations`, does not touch `attention()`, does not alter `MAX_ITEMS`,
`MODULE_TO_DESK`, the gate, or the mount. Deployed attention behaviour is unchanged
by this build, byte for byte.

One thing worth recording rather than acting on: `ask_spine_service.js`'s own header
documents that `GET /obligations` in `server.js` is **unauthenticated and takes
`property_id` from the query string**, so omitting it returns obligations across
every property. Slice 1 correctly declined to reuse that route and re-expressed its
query logic instead. That route is still there. It is a real exposure, it is
**outside Build 1's fence**, and it is named here so it is not lost —
`docs/ASK_SPINE_SOURCE_AUDIT.md` already tracks it as a separate security lane.

## The seam Build 1 builds on

```text
ask_spine.js         gate (REUSED, unchanged)
   ├── /attention              → attention()              unfrozen, untouched
   └── /completion-proof-gaps  → executor(contract, …)    frozen, new
```

One door, one authority seam, two capabilities that share no product semantics.
