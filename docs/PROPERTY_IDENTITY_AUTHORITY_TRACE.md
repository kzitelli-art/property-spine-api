# Property Identity — Authority Chain Trace

**Status: source-established. The browser half is NOT done and is not claimed.**
Written against `property-spine-api@3efffb6`, `property-spine-app@c6769ba`.

This traces the blocker named in the Rent Roll handoff: one signed-in session
reported Skyline in the chrome while the server-scoped Rent Roll returned Solo.
It does not fix anything. It establishes what each source is *authorized* to
say, so the browser table can be read instead of guessed at.

---

## 1. The chain, as the source actually implements it

```text
sign in / switch
  → POST /operator/properties/select  { property_id }        THE REQUEST
      · the ONE place a body property_id is legitimate
      · issueStaffSession re-reads property_team_assignments FOR SHARE
      · grants or refuses 403; presence in the list is NOT permission
  → a NEW staff_sessions row, bound to ONE property_id             THE GRANT
      · the prior session row is revoked, mint-then-revoke, one txn
  → session_token returned ONCE in the response body
  → every scoped read: resolveStaffSession(x-staff-session)
      → req.operator.property_id
```

`staff_sessions.property_id` is a single column. **Switching is minting.**
There is no "active property preference" that can drift from the session,
because the selection *is* the re-issuance.

## 2. What each of the five sources is authorized to say

```text
SOURCE                      DERIVES FROM                          AUTHORITY
/operator/rent-roll/units   req.operator.property_id              SERVER
                            operator.js:1967 "session only"       canonical
/operator/me                req.operator.property_id              SERVER
                            operator.js:242-264                   canonical
/operator/properties        req.operator.property_id              SERVER
  .active_property_id       operator_properties.js:95             canonical
                            "from the session, never the request"
verifySession()             GET /operator/me with _staffToken     SERVER
                            index.html:8419                       canonical
sessionMeta()               _sessionMeta, in-memory               CLIENT CACHE
                            index.html:8104                       NOT authority
_egAuthScope                set from verifySession's return       CLIENT CACHE
                            index.html:29191                      NOT authority
app bar wordmark            crumbPropertyName()                   SEE §4
                            index.html:12208                      NOT authority
```

### The consequence that rules out one hypothesis

All three server rows read the **same field off the same resolver**. Given one
token, `/operator/me`, `/operator/properties.active_property_id` and
`/operator/rent-roll/units` **cannot disagree**. They are not three authorities;
they are three readers of one.

```text
HYPOTHESIS B — server identity endpoints and governed routes derive property
               from different authority facts
               → RULED OUT at source for these three endpoints.

HYPOTHESIS C — property selection changes a preference without reissuing the
               canonical session
               → DOES NOT APPLY. Selection IS reissuance; there is no
                 preference column to drift.

HYPOTHESIS A — the client held two session states
               → the only remaining class, and it must be ACROSS TIME:
                 two requests carrying different tokens, or one surface
                 rendered before the switch and never refetched.
```

**This is a narrowing, not a verdict.** It says where to look. It does not say
what happened on the screen that was observed.

## 3. Why the proposed truth table cannot settle it as written

```text
SOURCE                    PROPERTY
sessionMeta               ?
verifySession             ?
_egAuthScope / me         ?
active_property_id        ?
rent-roll response        ?
```

Every row reports a **property**. No row reports **which token produced it**.
If §2 is right, the property is a function of the token, so a table of
properties without tokens records the symptom and discards the discriminator.
Two rows disagreeing tells us nothing we do not already know; two rows
disagreeing *while carrying the same token fingerprint* would falsify §2 and
reopen hypothesis B.

The table needs three more columns:

```text
SOURCE   PROPERTY   TOKEN FP   FETCHED AT   LIVE OR CACHED
```

`tools/property_identity_truth_table.console.js` (app repo) emits exactly that.
It re-fetches every server row **in one pass** so the rows are comparable, and
fingerprints the token each call carried.

## 4. What the source says that the handoff's table does not

Two findings from reading the current source. Both change how a row should be
read; neither is a fix and neither is proven against the observed session.

### 4.1 The wordmark is not sourced from `_egAuthScope` first

The handoff attributes the app bar wordmark to `_egAuthScope, via /operator/me`.
Both writers of `#appbarDeal` (index.html:14017 and `psSyncLiveCrumb`:12238) go
through `crumbPropertyName()`, which resolves in this order:

```text
1  Conversations page mounted → __psLeasing.tileStatus().propertyName
2  __OFFLINE_DEALS lookup, keyed on $('propPick').value      ← FIXTURE
3  frontPropertyName() → _egAuthScope.property_name          ← SERVER, LAST
```

`_egAuthScope` is the **last** resort, reached only when the fixture lookup
misses. The row is right about where Skyline's wordmark came from and wrong as
a general rule — and the difference is per-property, which is §4.2.

### 4.2 The stated reason this is safe is FALSE for Solo

The handoff records item 2 as latent, surviving "only because server ids are
UUIDs and do not match fixture ids." That guard does not hold:

```text
SOLO_ID     = '9e2bb96e-08e2-41db-81c2-91055ceb50a3'   index.html:6183
SOLO_PROPERTY_ID = '9e2bb96e-08e2-41db-81c2-91055ceb50a3'   index.html:8023
                  ↑ THE SAME REAL PRODUCTION UUID
SKYLINE_ID  = 'skyline-1417'                           index.html:6184
                  ↑ a slug; does not match the real Skyline UUID
```

So the chrome resolves its property name through **two different sources
depending on which property is active**:

```text
session bound to SOLO      → step 2 HITS  → fixture string 'Solo on Chestnut'
                             correct BY COINCIDENCE, not by authority
session bound to SKYLINE   → step 2 MISSES → falls to _egAuthScope
                             correct BY AUTHORITY
```

Item 2 is therefore **not purely latent**, and Solo is one of the two properties
in the reported state. A §21 inversion that is currently invisible because the
fixture happens to agree is exactly the shape that becomes visible the moment
the fixture and the server disagree — a rename, a rebrand, a display_name edit.

### 4.3 A signed-in pill click can reach the preview path

`switchProperty()` (index.html:29145) gates the whole mint → verify → clear →
reload sequence behind:

```text
if(_egAuthScope && _egAuthScope.property_id){ ...server path...; return; }
// ── PREVIEW / DEVELOPER PATH (unchanged) ──
sel.value = val; sel.dispatchEvent(new Event('change'));
await loadApp(true);
```

If `_egAuthScope` is null or lacks `property_id` **while a real staff session
exists in `__psLive`**, a pill click falls through to the preview path. That
path assigns `propPick.value` and re-renders. It calls no server, mints no
session, and revokes nothing — so the chrome moves to the clicked property and
the session stays where it was, which is the reported shape.

Whether `_egAuthScope` was actually null in the observed session is **NOT
established** — that is a browser fact and it is column 5 of the table.

## 5. What is not established

```text
which source was wrong in the observed session      NOT ESTABLISHED
whether _egAuthScope was null at the click          NOT ESTABLISHED
whether the rent roll was stale or freshly fetched  NOT ESTABLISHED
whether §4.3 is the mechanism or a second defect    NOT ESTABLISHED
```

No fix is proposed here and none should be written before the table exists.
Patching the wordmark to match the Rent Roll, or the Rent Roll to match the
wordmark, would close the symptom over an unestablished cause.

## 6. Classification

```text
this document                      Class 3 — trace. Removed when the blocker
                                   is closed and its receipt supersedes it.
tools/…truth_table.console.js      Class 3 — diagnostic harness. Removed when
                                   the switch regression exists as a real test.
crumbPropertyName __OFFLINE_DEALS  Class 4 — delete-on-activation scaffolding
  lookup (§4.1/§4.2)               in a signed-in surface. Removal condition:
                                   a signed-in session never consults
                                   __OFFLINE_DEALS for a property name.
switchProperty preview path        Class 3 today, and reachable from a
  (§4.3)                           signed-in shell, which is the defect.
```
