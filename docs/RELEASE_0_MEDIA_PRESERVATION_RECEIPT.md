# Release 0 — Twilio media preservation candidate

**Disposition: MEDIA PRESERVATION CANDIDATE PASSED.**

**Built but dormant.** `fetchMedia` exists and is wired, and nothing calls it in
production until an operations line is activated. Not deployed.

```text
production connection opened    NO
production mutation performed   NO
API deployed                    NO
work order 1006 assigned        NO
provider configured             NO
real SMS sent                   NO
real network used in tests      NO
credentials logged or stored    NO
```

---

## 1. What changed

```text
MOD  src/comms/sms.js                   +206   fetchMedia, APP_BASE_URL enforcement
MOD  src/technician/evidence_service.js  +45   verified-MIME boundary, cap passed in
NEW  tests/media_transport.test.js              37 assertions
NEW  tests/media_evidence_integration.test.js   32 assertions, real Postgres
NEW  tests/media_falsify.test.js                12 assertions
```

Nothing else. No canonical writer change, no resident transport change, no
line-resolution change, no migration.

## 2. The transport contract

```text
fetchMedia({ url, mime_type, max_bytes }) → { ok:true, buffer, mime }
                                          | { ok:false, reason }

allowed initial host      api.twilio.com          authenticated
allowed redirect host     mms.twiliocdn.com       NO credentials
scheme                    https only
authentication            HTTP Basic, account SID : auth token, header only
maximum bytes             passed IN from evidence_service.MAX_BYTES (5 MiB)
timeout                   10,000 ms
redirect limit            3
```

**It never throws.** Every failure is a short opaque reason:

```text
transport_not_configured · invalid_media_url · unsupported_media_url
authentication_failed · http_<status> · too_large · unsupported_mime
mime_mismatch · fetch_timeout · empty_body · too_many_redirects
fetch_failed · fetch_aborted · invalid_max_bytes
```

### 2.1 Host matching is explicit, never a suffix

`endsWith("twilio.com")` would accept `evil-twilio.com`. There is no cheap way
to write that check safely, so it is not written. Two governed hostnames are
compared exactly. Proven by T6b (`evil-twilio.com`) and T6c
(`api.twilio.com.evil.example`) — both refused.

### 2.2 Credentials go to exactly one host

`authed = target.hostname === MEDIA_HOST_AUTHENTICATED`, recomputed after every
redirect. The CDN carries its own signature in the URL and must never see the
account credentials. T2 proves the header is present on `api.twilio.com`; T3
proves it is absent on `mms.twiliocdn.com`; T3b proves nothing lands in the path.

### 2.3 The cap is enforced before buffering

```text
Content-Length present and over cap   refused, body never read      T9
no Content-Length, stream crosses cap aborted mid-stream            T10
```

`evidence_service`'s post-fetch `MAX_BYTES` check stays as defense in depth.

## 3. The MIME boundary

`got.mime` was previously ignored, so the stored `mime_type` was the carrier's
webhook claim and nothing had ever compared it to the bytes.

```text
transport         normalizes Content-Type, requires ALLOWED_MIME, and refuses
                  when it differs from the webhook claim
evidence_service  RE-checks both, then stores the VERIFIED value
mismatch          storage_state = fetch_failed, reason = mime_mismatch,
                  content / byte_size / sha256 / stored_at all null
```

Two modules, two checks, and only one of them writes the row. **No sniffing, no
classification, no scoring, no OCR** — this compares two declared media types
and stops.

## 4. APP_BASE_URL is now genuinely required

The module header has always said so. The code fell back to
`${req.protocol}://${req.get("host")}`, which behind a proxy reconstructs
`http://` where Twilio signed `https://` — **every** message then fails with a
correct-looking 403, and a negative control passes for the wrong reason.

```text
absent      → validation false      U1
malformed   → validation false      U2
non-https   → validation false      U3
configured  → reaches the signature check   U4
req.protocol appears nowhere in code        U5   (comment-stripped)
the removed fallback is still EXPLAINED     U5b
```

Guessing the signed URL is worse than refusing to guess.

## 5. Test results

```text
media_transport.test.js              37 passed   0 failed   exit 0
media_evidence_integration.test.js   32 passed   0 failed   exit 0
media_falsify.test.js                12 passed   0 failed   exit 0
source-governance gate (7 gates)      PASS       exit 0
server boot                           BOOT OK
scale proof regression                65 / 20 / 18 passed, 0 failed
```

### 5.1 Integration — durable evidence

```text
E1-E9   stored · one row · byte-exact content · exact byte_size
        · sha256 = digest of the bytes · stored_at present
        · VERIFIED mime stored · counts as preserved evidence
E10     served png against a jpeg claim → fetch_failed / mime_mismatch
```

### 5.2 Integration — every failure stays honest

Authentication failure, oversized response, MIME mismatch, unsupported MIME,
non-200 and timeout each produce:

```text
storage_state  fetch_failed
content        null      byte_size  null
sha256         null      stored_at  null
preserved      0         reason names the actual cause
```

### 5.3 Redelivery

```text
R1  first delivery stores
R2  redelivery reported as replayed
R3  still exactly ONE attachment row
R4  the redelivery made NO further HTTP request
R5  the surviving row is the stored one, unchanged
```

### 5.4 Evidence is not completion

```text
P1  the attachment was stored
P2  work-order status UNCHANGED
P3  completed progress-event count UNCHANGED        (0 → 0)
P4  completion-claim count UNCHANGED                (0 → 0)
P5  ingestProviderMedia writes to ONE table only
```

**A technician's photo is attributed evidence. It is not a decision, a
completion, an acceptance, or a clearance.**

## 6. Falsification

Each protection removed **in memory** — the source files are never edited, and
B6 proves `sms.js` is byte-identical before and after.

```text
1  authentication removed        no Authorization sent          → T2 red
2  streaming cap removed         6 MiB buffer returned          → T10 red
3  actual MIME ignored           png accepted for a jpeg claim  → T14 red
4  credentials forwarded         CDN receives Authorization     → T3 red
5  req.protocol fallback back    guesses http://…  instead of
                                 refusing                       → U1 red
```

Each falsification **refuses to run if its pattern does not match**, so a
removal that silently changed nothing cannot be reported as unfalsifiable.

## 7. Two defects found by running it

**7.1 An abort-ordering defect in production code.** On cap crossing the code
called `res.destroy()` before resolving. `destroy()` emits `aborted`
synchronously, so the `aborted` handler won the race and the returned reason
was `fetch_aborted` — true, but a worse diagnosis than the one we already knew.
The outcome is now settled before the stream is destroyed.

**7.2 A test that matched its own explanation.** `U5` asserted `req.protocol`
appears nowhere in `sms.js` and failed — on the comment explaining the removed
fallback. Same class as a consumer scan flagging its own prose. It now strips
comments and asserts against code, with `U5b` requiring the explanation to
survive.

## 8. provider_config — owner-ruled, recorded, NOT applied

```json
{ "schema_version": 1, "provider": "twilio", "credentials_source": "environment",
  "media_auth": "basic", "webhook_path": "/communications/inbound-sms" }
```

Never stored there: account SID, auth token, phone number, webhook signature,
messaging-service secret.

**Line-resolution behaviour is unchanged by this build.** The runtime's
authoritative disable remains `status != active`. Clearing `provider_config` is
**not** rollback and is not described as rollback anywhere.

## 9. Classification (§18)

| Component | Class | Removal condition |
|---|---|---|
| `sms.fetchMedia` | 1 — permanent | Never. It is the only path from a carrier media reference to durable evidence. |
| The verified-MIME boundary | 1 — permanent | Never. |
| `APP_BASE_URL` enforcement | 1 — permanent | Never. It closes a fail-for-the-wrong-reason trap. |
| The three test files | 1 — permanent | Never. They are what keeps the above true. |

---

**MEDIA PRESERVATION CANDIDATE PASSED.**

Stopping before deployment. The next owner ruling authorizes the dormant API
deployment and the reissue of the SMS activation packet.
