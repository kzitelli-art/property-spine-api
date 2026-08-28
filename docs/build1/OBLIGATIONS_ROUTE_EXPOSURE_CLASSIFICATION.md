# `/obligations` — exposure classification

**Verdict: not a live exposure. Already closed, and continuously asserted.
Parked, with the reason recorded.**

A bounded pass, answering only the four questions asked. Nothing about obligations
or authority was redesigned, and nothing was folded into Build 1.

---

## The four questions

**1 · Is the route in the deployed server path?**
**No.** There is no registration of a bare `/obligations` path anywhere:

```bash
grep -nE 'app\.(get|post|patch|put|delete)\(\s*"/obligations' server.js     # no match
grep -rnE 'router\.(get|post|patch|put|delete)\(\s*"/obligations[^s]' src/  # no match
```

`server.js:745` and `:760` carry explicit RETIRED blocks in place of the old
`GET /obligations`, `GET /obligations/:id` and
`PATCH /obligations/:id/{claim,satisfy,complete}`.

**2 · Does it return real property-scoped operating data?**
Not applicable — the route does not exist. Its replacement,
`GET /operator/obligations`, does return real operating data and is
**session-gated**: `resolveStaffSession` on `x-staff-session`, plus a
`refuseClientAuthority` middleware, exactly the seam Ask Spine reuses.

**3 · Can an unauthenticated caller choose another property's ID?**
No, on both counts. There is no unauthenticated caller — and the historical defect
was not "unauthenticated" but **portfolio-wide shared `OPERATOR_KEY`** while taking
property scope from the request. Any key holder could read across every property.
That is the defect the security lane closed.

**4 · What fields are exposed?**
None by the retired route. The replacement exposes obligations for the **session's**
property only.

---

## It is asserted, not merely believed

`tests/scenarios/smoke_release3.deployed.js` B1–B5 run against the **deployed** instance and
require all five legacy doors to be gone:

```text
B1  legacy door gone: GET   /obligations
B2  legacy door gone: GET   /obligations/:id
B3  legacy door gone: PATCH /obligations/:id/claim
B4  legacy door gone: PATCH /obligations/:id/satisfy
B5  legacy door gone: PATCH /obligations/:id/complete
```

`tests/proofs/operator_obligations_security_proof.db.js` covers the same paths against a
real database. So this is not a one-time fix that could silently regress: a
reintroduction turns the deployed smoke red.

Two of the five were deliberately **not** replaced — the detail read and
`satisfy`/`complete` had no product caller, and rebuilding them behind new URLs
would have preserved attack surface for workflows that do not exist. See
`docs/SECURITY_OBLIGATIONS_ROUTE.md`.

---

## The correction I owe

I reported this as an open exposure — *"`GET /obligations` in `server.js` is still
unauthenticated and takes `property_id` from the query string"* — and that was
wrong. I repeated a **comment** in `src/agent/ask_spine_service.js` instead of
checking the source. The comment was written at Slice 1 time, was true then, and
outlived the fix in the present tense.

That comment is now corrected in place, because a **stale security claim in a
governing comment is its own hazard**: it sends the next reader hunting for a
closed exposure, and — worse — it trains people to skim past exactly the sentence
that would matter if a real one ever appeared.

The general lesson, which is the same one this release keeps teaching: a comment is
not evidence. `grep` for the registration, not for the prose about it.
