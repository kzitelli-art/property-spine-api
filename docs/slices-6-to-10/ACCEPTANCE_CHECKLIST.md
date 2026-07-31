# SHARED ACCEPTANCE CHECKLIST — SLICES 6–10

## Repository and deployment

- [ ] API branch recorded
- [ ] API commit recorded
- [ ] API merged SHA recorded
- [ ] API deployed SHA confirmed
- [ ] App branch recorded
- [ ] App commit recorded
- [ ] App merged SHA recorded
- [ ] `window.__PS_BUILD.code_sha` confirmed
- [ ] Merge order documented

## Contract

- [ ] Before/after contract documented
- [ ] Property scope is session-derived
- [ ] Server owns lifecycle/state/ownership/due/action
- [ ] Browser adds no parallel classifier
- [ ] Nulls remain honest
- [ ] Unsupported states are explicit
- [ ] Home counts reconcile with destination

## Data and migrations

- [ ] Real Postgres proof
- [ ] Authenticated HTTP proof
- [ ] Unauthorized request proof
- [ ] Additive migrations only
- [ ] Migration IDs recorded
- [ ] Historical migration replay limitations disclosed

## Browser proof

- [ ] Desktop populated
- [ ] 390px populated
- [ ] Natural empty
- [ ] One subsection empty
- [ ] Failed read
- [ ] Malformed response
- [ ] Unsupported state
- [ ] Retry
- [ ] Failed write leaves record visible
- [ ] Successful write refreshes from server
- [ ] No fixture fallback
- [ ] Zero uncaught page errors other than separately accepted cosmetic assets

## Navigation

- [ ] Every primary action opens canonical destination or command
- [ ] Back returns to correct context
- [ ] Property identity remains correct
- [ ] Direct links remain compatible
- [ ] No dead-end legacy route

## Handback

- [ ] Files changed
- [ ] Test totals
- [ ] Population reconciliation
- [ ] Known unsupported states
- [ ] Screenshots
- [ ] Production acceptance notes
- [ ] Recommendation for next slice
