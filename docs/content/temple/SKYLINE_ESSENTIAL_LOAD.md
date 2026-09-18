# Skyline essentials — ready to stage, not published

September 11, 2026. API base `992a8db`; app release identified by QB as `2c57e71`. No production write or new operator approval occurred in this lane.

## Selected content

Use `skyline_essentials` in the existing `leasing-content.json`. It selects **two existing cards**, `amenities` and `leasing_faq`, from the 20-card Temple packet. The other 18 cards remain deferred, unchanged. Original website wording for the two updated cards is retained under `previous_draft`; this is preparation history, not a second runtime knowledge store.

The source is `docs/SKYLINE_OPERATING_FACTS.md`, confirmed by ownership August 20, 2026, naming Kameron Zitelli and physical inspection by Mike Grivna. This is dated documented confirmation, not a new conversation with Mike. The exact source revision, sections, authority and date are retained in the packet. The public wording also names the source date.

The cards contain the confirmed furniture list and building amenities. Roof deck **existence** does not grant access or override lease restrictions. They do not publish rents, fees, inventory counts, availability, qualification/accommodation policy or the native tour schedule. Those retain their existing canonical owners. Laundry hours, precise furniture allocation to a home and amenity access arrangements remain unestablished here.

## Execute the existing path

1. In the authenticated app, select Skyline, 1417 North 15th Street, Philadelphia, UUID `14e41b7c-e91c-49e8-9651-10c4908a8f6a`. QB supplied this freshly verified production target. The packet is bound to that UUID as data; this lane does not certify a live operator session.
2. Obtain a fresh `GET /operator/agent-facts` response using that staff session and save the response JSON privately. Do not save or log the bearer token. This route returns the server-derived `property_id`, full facts/history and current coverage.
3. Generate the reviewable payloads offline:

   ```text
   node tools/stage_leasing_content.js skyline_essentials 14e41b7c-e91c-49e8-9651-10c4908a8f6a agent-facts-response.json > skyline-essential-plan.json
   ```

   The script sends no requests. It requires the target, packet canonical UUID and authenticated response property ID to agree. A matching name is insufficient. It refuses malformed IDs and invalid expiry values, and includes provenance beside, not inside, each existing writer request.
4. A currently authorized Skyline staff actor reviews the exact plan wording and source, then publishes through the existing knowledge editor or the listed authenticated HTTP requests. `POST /operator/agent-facts` creates a missing card; `/operator/agent-facts/:id/replace` replaces a named active card. The existing route requires operator authentication and Leasing module access; there is no additional designated-reviewer role being invented here. The writer derives property and actual approver from the session. Do not supply another user's ID or backdate publication to the source date.
5. Read again immediately before each write. Unchanged current cards are skipped; expired cards generate a replacement **requiring publication review**, not automatic renewal. Stop on stale replacement `409` and re-read; do not fall back to create. The existing create route can retire a concurrent active same-topic card and has no create-if-absent precondition, so this preparation tool does not claim concurrency-safe unattended importing. Use one publishing operator for this bounded initial load.
6. Re-read `/operator/agent-facts`: confirm these exact two texts and their actual publisher. Ask `does Skyline have laundry?` and `what are the common questions?`. Confirm the answers contain the dated wording. Coverage 2/10 means two current topics, not a complete or production-accepted chatbot. Future edits remain in the same app workspace using replacement/retirement/history.

The writer currently accepts wording/source type, but does **not** bind the packet's provenance object to `source_record_id`. This recipe does not pretend otherwise: retain this packet/plan receipt, and the dated attribution remains in the published wording. `confirmed_at` is omitted from the generated request so the writer records actual publication confirmation time. No prices or policy decisions can be made authoritative by importing them as FAQ text.

## Fresh isolated proof

`tests/e2e/skyline_essential_knowledge.e2e.js` consumes this exact packet and staging function, not substitute content. Only its in-memory canonical property UUID is cloned to the freshly created synthetic property; the unmodified production packet refuses that fixture ID. There is no live override flag. Run only under the existing `tests/e2e/proof_boundary.js` ownership manifest and a nonce-verified full API server with `proof_fence_preload.js`, `fake_sms_preload.js` and `fake_anthropic_preload.js`. With an owned migrated runtime ready:

```text
node tests/e2e/skyline_essential_knowledge.e2e.js
```

Local HP run used fresh PostgreSQL on `127.0.0.1:55443`, API `127.0.0.1:3343`, actual sorted migrations plus existing version-specific preconditions: ceiling 194, 182 ledger entries. Windows adapter used `pg.Client` for SQL and `psql.exe` for precondition files with psql commands, matching the existing chain runner's self-recorded migration exception. No pending DDL or fixture fallback was introduced in signed-in operation.

Passed: two existing-writer HTTP creates; session-derived property/approver; exact workspace text; Ask answers; identical prospect context; unchanged repeat skip; wrong-property staging/HTTP refusal; expiration removes the amenity answer; explicit replacement retires prior wording; stale replay returns 409. Synthetic proof approval is not production or owner approval. Browser, live SMS, production content publication and actual prospect acceptance were not exercised by this proof.

Final rerun also passed mandatory production-packet UUID binding and invalid-expiry refusal. Run nonce `798ce2d6aaa02ede32177be15c7d1b91`, owned database `spine_proof_3c0e344efe51df4405b21b0b`; canonical boundary cleanup verified its removal, then the owned cluster stopped. No SMS/Anthropic/egress attempt logs were produced. Offline CLI emitted the selected two payloads, and a comparison against the base packet proved all 18 unselected cards unchanged. Local replay adapter is workspace `tmp/skyline-essential-replay.js` (run via stdin from this API worktree after canonical boundary bootstrap; not a production command).

Source owners: `src/identity/operator.js:482` (read), `:501` (body normalization), `:535` (create), `:570` (replace); `src/leasing/leasing_knowledge.js` (shared current selection/Ask wording); existing `tests/e2e/leasing_knowledge.e2e.js` supplies the authenticated fixture pattern.
