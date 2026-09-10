# QB integration — 2026-09-10

Integrated API `dec88db` (HP possession fixes) with `b095728` (knowledge implementation/content), common ancestor `48a85ab`, into isolated branch `codex/qb-integration-20260910`, merge `a3e1421`. Paired app remains `f6dadcc` on `codex/temple-leasing-knowledge-ui`.

Only merge conflict: CURRENT_STATE's dated entries. Preserved both sets, with explicit historical proof levels. No product-code conflict or new product behavior was introduced during integration. The owned Windows test launcher now supplies the same local `e2e-key` as existing boot.sh so the shared possession HTTP proof can exercise its existing route; no production key or ambient credential is used.

Fresh combined-candidate evidence:

- All 55 source-governance gates passed.
- Possession-as-of eight assertions and leasing-knowledge unit checks passed.
- Staff application terms, SMS refusal, application offer terms and Ask terms unit suites passed.
- Fresh owned local Postgres migration chain reached 193.
- `turnover_sibling_cache.db.js`: real HTTP live sibling, lease-only unknown, future arrival/departure, last-bed release passed.
- `leasing_knowledge.e2e.js`: real HTTP writer/read, prospect context, staff SMS webhook/durable fake reply, cross-property refusal, live entitlement, expiry, replacement and retirement passed.
- Paired real app browser against this combined API: editor save, Ask clickable tour, mobile editor and sign-out clearing passed.

Logs are workstation `tmp/qb-*`. Provider/model transports are fenced/fake. These are local proofs; no branch was merged into main and no production schema, content, provider or deployment action was taken. Full 162-assertion historical phone journey and exact-space matching are not newly proven by these focused checks.

Next: reproduce the prospect discovery gap with a free sibling bed and exact-space published rent. Existing target and pricing readers already own these facts. Existing prospect selection still persists a unit, so informational discovery must not silently become an exact-bed commitment.
