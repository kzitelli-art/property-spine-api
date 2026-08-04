# Slices 1–10 — what was built, and what happens next

Companion to `SLICES_1_TO_10_THREAD_CLOSEOUT.md`, which is the status ledger.
This one is the narrative: what each packet actually is, why it stopped where it
stopped, and what the next thread picks up.

**Nothing here is deployed.** Every packet below is source on a branch.

---

## 1 — Write authority hardening (Slices 1–9)

**The problem.** Two authentication seams existed side by side. `/operator/*`
resolves a real `users` row from `x-staff-session` and derives the actor and
property server-side. `/leasing/*` and `/applications/*` authenticate with a
single portfolio-wide `OPERATOR_KEY` — and then read *who did this* and *which
property* out of the request body. A shared key plus a client-declared identity
is not an identity at all.

**What was built.**

```
refuseClientAssertedAuthority()   one frozen field list, applied at every
                                  active staff write in packet scope
five new session doors            tours/:id/check-in · confirm-prospect ·
                                  reminder · correct-outcome ·
                                  applications/:id/deny
one service, two doors, no fork   canonical services extracted byte-faithfully
                                  and the legacy door repointed at them
```

**The route inventory is the durable artifact.** Forty-three routes in scope —
31 MIGRATE, 8 BLOCKED, 4 OUT OF SCOPE. Of the 31, five doors were built, two are
withheld behind a typed 503, and twenty-four are named and not started.

The eight BLOCKED routes are blocked on one owner input: they have **zero
in-repo consumers**, and nobody can prove from source whether an external caller
depends on them. They are not retired for that reason.

**A correction worth keeping.** The packet published a denominator of 23. It was
wrong; the real figure is 43. The fix was to derive it from the route registry
rather than adjust the arithmetic to fit.

**Two verbs are withheld rather than shipped.** `reminder` and
`correct-outcome` return a typed 503 naming their own defect —
`leasing_tours_status_check` does not permit the status the canonical write
needs. Authority is still enforced *before* the withhold is disclosed, so a
cross-property session gets 403 and not "unavailable".

`write_authority_hardening_proof.js` 143/143 · `wave1_route_existence_probe.js`
19/19 · `wave1_accounting_provenance_probe.js` 4/4 across 54 lineage questions.

---

## 2 — Receipts and immutable action authority

**The question.** After a timeout, can a caller find out whether its write
happened? Twelve active leasing operations were traced.

**The answer: one of twelve.**

```
RECOVERABLE          executed_lease.verify

CODE-HARDENED,       obligation.resolve · reassign · reopen · change_due_time
RECEIPT WITHHELD     replay identity threaded and duplicate lookup bound to the
                     obligation — but nothing binds the key to the PAYLOAD, so a
                     retry asking for a different owner is indistinguishable
                     from a replay

BLOCKED (5)          tour operations — a lookup by
                     tour_events.metadata->>'operation_id' degrades to a
                     sequential scan: 100,068 rows, 2,710 buffers at 110k events

BLOCKED (2)          application decisions — no immutable actor-attributed
                     decision record exists anywhere
```

`operation_receipt_v1` carries **two identities**: `operation_id` is the
caller's replay identity, `receipt_id` is the server's durable domain identity.
There is no receipt table — receipts are reconstructed from durable domain
records, so a receipt cannot outlive the fact it describes.

**Withholding was the deliverable, not a shortfall.** A receipt that only
*appears* recoverable is worse than none: it invites a caller to trust a
completion the system cannot confirm.

**The finding underneath it all:** Property Spine records **current lifecycle
state** well and **immutable action history** unevenly. `events` has no actor
column and no `application_id`. Application approval records no actor anywhere.
That is why "who approved this?" is unanswerable today.

---

## 3 — Conversational Spine, read-only

**One question:** *what should I do today?*

Answered by calling the same governed operator reads the employee would hit by
opening the app — never by querying around them. The ceiling is deliberate: the
briefing can only see what that employee could already see.

**Two separations carry the design.**

```
PRIORITY ≠ AUTHORITY    an item can be urgent and not yours. Five states, not a
                        boolean: assigned_to_you · available_for_you_to_cover ·
                        needs_manager_attention · visible_not_actionable ·
                        blocked_by_missing_information
                        Unknown falls back to "Owner not confirmed" — never to
                        ownership.

FACT ≠ RECOMMENDATION   a fact comes from a canonical read and is attributable.
                        A recommendation is tagged "Suggestion" and must never
                        be phrasable as something the system recorded.
```

Two sections: **My Work** where authority is reliably established, **Property
Watchlist** where it is not and says so. "Today" is property-local, from
`properties.operating_timezone`. A failed source renders as a failed source —
"nothing needs attention" and "I could not find out" are different answers.

**It issues no write, and renders no disabled control.** A greyed-out Complete
button would promise execution is nearly here, and for eleven of twelve
operations it is not. Server 41/41, app 35/35.

---

## 4 — Slice 10, the dated contractual position

The largest packet. A governed answer to: **for this property, on this date,
what is the contractual leasing and rent position of every leaseable space?**

```
forward_rent_roll_rows_v1       one row per spaces.id, space → unit → property
forward_rent_roll_summary_v1    whole-property, computed BEFORE the page is sliced
frr_cur_v1                      stateless HMAC cursor, bound to property, date,
                                ordering and BOTH contract versions
```

Four rent authorities — `dated_economic_line`, a *qualified*
`legacy_lease_rent`, `missing`, `conflict` — and the qualification is the
interesting part: `leases.rent` is one undated number, trustworthy for the month
the lease starts and provably not beyond it. `units.market_rent` is never read.
A missing or conflicting amount is **withheld, never estimated**.

**Scale is measured, not asserted.** 10,000 positions on the selected property,
100,000 on a neighbour, every adverse condition placed beyond ordinal 9,900 so a
page-one summary cannot look clean by accident. Query count is flat — 18 at
10,000 and 18 at 100,000. Page one legitimately withholds its occupancy rate
because of a blocker 9,900 rows away.

**The browser found six real defects that source review had not.** Pagination
was broken in two independent ways: the URL builder discarded the cursor so the
server answered page one again, and the Load more button interpolated the cursor
into a double-quoted `onclick`, so its own quotes closed the attribute and the
button carried no handler at all. Four different rent facts printed one
sentence. Typed blockers never reached the screen.

**And the harness itself nearly shipped a false green** — every geometry
assertion passed against a surface with `display:none`, where each element
measured 0×0. A width assertion over zero-width boxes is true of nothing. It
surfaced only because a real `click()` timed out with *"element is not
visible"*.

Server 90 / 36 / 58 / 62 · browser 96/0 · app suite 779/0.

---

## 5 — Money: deliberately frozen

Exploration ran ahead of the product-boundary question and was stood down. The
thinking is preserved and relabelled rather than deleted:
`MONEY_THINKING_INDEX.md` is the entry point, and
`MONEY_INTEGRATION_DISCOVERY_QUESTIONS.md` §1 is the question that comes first.

**No money code, table or migration exists anywhere in the repository.**

The most durable idea to survive: **recording a fact and assigning it an
accounting treatment are separable acts** — and that would hold even under
"Spine is not the accounting system."

---

## 6 — The merge decision

**Do not merge anything yet. Migration 129 comes first.**

API `main` cannot boot: `129_property_line_uniqueness.sql` is in the build and
in no ledger, so the verify gate refuses and Render keeps serving an older
build. Merging does not make that worse — 129 is already on `main` — but it does
mean **you cannot prove the post-merge `main` boots**, which is the step
everything else rests on. Merging blind also destroys your ability to tell "129
broke it" from "the merge broke it."

| PR | | Merge now | Why |
|---|---|---|---|
| API #38 | authority hardening | **not yet** | green and based on current `main`, but you cannot prove the result boots. First in line once 129 clears. |
| APP #34 | authority hardening (app) | **not yet** | pairs with #38. **Deploy the API side first** — a hardened API ignores a field an old app still sends, but an old API may still *read* a field a hardened app has stopped sending. |
| API #37 | Slice 10 | **no** | must be re-integrated and re-proven against the post-#38 `main`. Its proof belongs to a tree that will no longer exist. |
| APP #33 | Slice 10E | **no** | needs the API route contract deployed first, plus the four security gates and 10F reactivation. |
| API #39 | receipts + briefing | **no** | opened for review only. Stacked on #38 — it retargets to `main` automatically when #38 lands. |
| APP #35 | read-and-recommend | **no** | same: review only, stacked on #34. |

### The order

```
 1  release migration 129 through the SMS lane
 2  prove API main boots
 3  merge API #38 → deploy → verify
 4  integrate the new main into #37, rerun ALL gates and Slice 10 proofs,
    update the candidate SHA
 5  merge API #37 → deploy
 6  prove entitlement, strict as_of, and Forward Rent Roll against an
    authenticated real property
 7  security gates: repositories private · forks checked · suspension verified
    in a private window · allowlisted artifact only
 8  merge APP #34 → deploy
 9  merge APP #33 → deploy ONLY the allowlisted artifact
10  production desktop and 390px acceptance
11  record the exact deployed API and app SHAs
```

**Do not merge Slice 10 into a known non-booting release path to call the source
landed.**

---

## 7 — Follow-ups, by thread

**Slice 10 Production Release** — steps 1–11 above. Nothing else.

**Forward Economics / Forward NOI** — start at
`SLICE_10_TO_FORWARD_NOI_HANDOFF.md`. The first decision is keeping the
projection contract separate from the contractual-position contract, because a
scenario input never has an honest blank; it always has a default. Open owner
question: do recurring lease charges such as parking and pet rent belong in a
broader contractual-revenue total?

**Conversational Spine** — continue from the accepted read-only briefing. Do not
broaden write execution until durable, payload-bound receipts exist. The natural
next step is coverage, not capability.

**Schema and Migration Repair** — migration 129, then the four frozen
dependencies. Review them together because 129 blocks all schema work; **merge
them separately**, because one combined migration nobody can review is worse
than four that can be.

```
1  tour ledger verb repair            vocabulary / projection
2  tour operation receipt authority   access path + immutable walk-in capture
3  application decision authority     missing immutable actor-attributed record
4  task payload binding               missing material hash
```

Also queued and untouched: the harness-isolation debt register — 87 scripts
building a connection from `DATABASE_URL` with no guard, 67 of them
write-capable. Frozen and failing on growth, **not repaired**. Do not
mass-replace across 87 files; that would create 87 unexecuted safety claims.

**Money Integration Discovery** — slowly, separately, product boundary first.
Talk to whoever does the books before designing anything.

---

## 8 — Traps this thread paid for

Worth carrying forward, because each cost real time and each is cheap to repeat.

**A proof is evidence for the tree it ran against.** `fbd7a3a` changed no Slice
10 file and still turned the branch red, by tightening a gate. Textually clean
merges can break a branch.

**A guard that runs and proves nothing is worse than no guard.** Three harnesses
compared two database URLs as *strings* — which a different user or a trailing
`sslmode` defeats while still resolving to the same database. A gate that
detects guards by grepping for an identifier can be satisfied by a decorative
mention; check by execution.

**Check the timestamp before believing a proof artifact.** A sixteen-hour-old
`acceptance.out` reading `96 passed, 0 failed` nearly became this run's
evidence. It survived because a wait-loop written as `while pgrep -f <pattern>`
matched the very shell running it. The re-run produced the *same* number — which
is exactly why it mattered.

**A measurement you scoped by assumption is a measurement of your assumption.**
The app-suite counter reported 219 because ten of eighteen harnesses used
formats it could not parse and were counted as zero. `0 pass 0 fail exit 0` is
what a vacuous measurement looks like.

**A grep match is discovery evidence, not a conclusion.** A consumer search
reported 181 call sites because truncating routes at `:param` made
`/applications/:id/approve` match every `/applications/` string. It was
discarded and re-derived, not adjusted.

---

**No product code. No migration. No money implementation. No conversational
implementation.**
