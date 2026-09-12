# Reusable deal onboarding and maintained leasing setup

Owner direction, September 12: the next property must fill existing shelves instead of requiring another Greenery investigation. This contract extends Deal Setup and the maintained leasing domains. It does not create an onboarding database, a universal completion flag, or a new work engine.

## The experience we are building

Give Spine the deal name, property addresses and existing files. Spine retains what was supplied, shows its interpretation beside the existing records, and asks only about missing information, conflicts or decisions. Authorized staff review those questions in context. Each accepted fact goes to the same owner that daily operations and Ask Spine already read. The setup remains accessible when staffing, prices, policies, schedules or source files change.

Start at the deal. A deal can hold several properties; an address anchors each durable physical property. The management organization and property assignments establish operating access. This does not establish the legal owner, landlord, investment interests or financing. Those relationships enter their existing domains when their capabilities are needed.

## Standard shelves and their existing owners

| Shelf | What is supplied or reviewed | Existing authority and destination | What this enables |
|---|---|---|---|
| Deal, properties and operating team | Addresses/aliases, existing property selection, organization custody, confirmed people, duties, backup and approval/signing powers | deal_service, property identity/hierarchy, governed invitations, person bridge, assignments and authority | The correct people operate the correct property; naming a person does not grant access |
| Homes and source records | Retained dated rent roll, unit/bed basis, original labels, layout/space correspondence, current and future claims | source_artifact_service, retained-source adapter/field map, activation_service, snapshot_loader, inventory/tenancy owners | Source-linked inventory and opening tenancy facts; exact availability remains its dated operating read |
| Prices and application/lease terms | Approved prices, effective dates/basis, charges, deposits, guarantor requirements, current lease body and signers | Published pricing, application_offer_terms, lease configuration, packet/signing owners | Quotes and agreements for an exact eligible home under the actor's authority |
| Leasing answers and media | Amenities, furnishings, layouts, dimensions, photos, floor plans, tours, neighborhood guidance and common questions | Existing leasing_knowledge topics/fact writer; operating rules for policies; canonical media/space association where supported | Shared staff/prospect answers with source, scope, audience and history; a representative photo is not an exact-home promise |
| Tours and incoming inquiries | Approved hours, actual host/timezone, location instructions, real form/source identity, permitted response channel | Tour policy/availability/tours; canonical intake, communications and conversation custody | A real inquiry reaches an accountable person and can book an actual slot |
| Ongoing changes and exceptions | New source revisions, expired/conflicting answers, staff turnover, approval changes and missing evidence | Each domain's replacement/history and existing accountable work/obligation owners | Staff maintain the same records after onboarding; UI and Ask reflect the same revision |

Contracts, maintenance and economics keep their existing shelves. They enter the sequence when relevant. An unresolved trash agreement does not itself block capturing a leasing inquiry. An unknown charge, uncertain home or wrong lease form does block the promise that depends on it.

Company practices may be proposed once for repeated use, but applying them to another property still requires the domain's authority, applicability and effective dates. Do not clone an entire property's settings, people, consent or lease terms. A property-specific exception cannot silently supersede an agreement or higher authority. The original physical/property history stays when management changes; staff access is separately reviewed.

## One reusable sequence

1. **Find the existing deal/property before creating one.** Show address and operating organization. Offer only authorized matches. Resolve custody questions before establishing access or uploading against a guessed property.
2. **Collect once.** Keep the source identity, bytes/hash where available, original/as-of date and speaker/author. Returning to the setup must recover the retained source and interpretation; a failed later action must not require reconstructing the input.
3. **Preview the interpretation and effect.** Show source column meanings, original unit/room labels, candidate canonical targets, proposed creations, unmatched/retired references and records absent from this file. Absence is information, never deletion authority.
4. **Resolve only gaps and decisions.** Present the relevant evidence beside the question. Require a named authorized decision for identity, price, policy and signers. Unknown stays unknown. Do not ask the operator to transcribe already supplied amounts or labels.
5. **Use the canonical writer.** Approval and source capture are separate facts. Preserve the original source cells, decisions, attachment IDs, effective dates and prior revisions. Same source/retry is replay; changed source requires retained review rather than an overwrite.
6. **Review the maintained setup in the app.** Open current knowledge, team, tours, pricing, policy, inventory and lease editors from the existing leasing/deal surfaces. Read states, unavailable reads and access refusals remain distinct. Navigating to a shelf does not complete it.
7. **Accept each capability with the actual operator.** Start with inquiry capture and human follow-up. Then tours, exact-home offers, application and signing. Keep the acceptance and recovery receipt with the exact source/version and property. Staff training and a live source connection are not inferred from automated tests.

## Implementation at this checkpoint

Baseline API f4e59eb (receipt-only above live1320c2c) and app4fd0af8 were inspected.

**Existing:** Deal Setup's source retention, canonical source parsing, row/resident review, opening tenancy position, corrected-source lineage, staff invitations and domain-specific editors/readers. The ten-topic leasing knowledge contract already reports current/missing/expired/retired coverage and guided questions. It expressly does not declare onboarding completeness.

**Current bounded build:** a maintained Leasing setup overview in the signed-in property, composing existing live read adapters for knowledge, tours and lease configuration, with navigation to the established editors and other setup doors. It records no second checklist state or approvals. App candidate b677df5 has 19 counted Chromium component assertions and desktop/mobile visual review with explicit read stubs; the component evidence is not a real-property acceptance. A separate Deal Setup change exposes the existing authorized-property picker and original retained-source download. Its final combined release receipt establishes what shipped; this specification alone is not release evidence.

**Component classification:** Leasing setup and Deal Setup navigation are Class 1, permanent app projections over existing domain owners. The browser harnesses and sanitized inputs are Class 3, outside signed-in operation. There is no temporary truth bridge, no new canonical owner, and no new Ask registration: answers remain available through the existing knowledge/operating domain readers. Future inventory-resolution work requires its own source, writer, read and Ask review before implementation.

**Not yet implemented:** a general document/transcript intake that automatically selects and fills all shelves, pre-materialization inventory identity decisions, the full in-app source-connection wizard/receipt, designated topic reviewer assignments, company-practice inheritance and a complete no-developer onboarding rehearsal. Existing research packets are proposed inputs, not active app knowledge. Do not describe the current overview as a complete self-service onboarding product.

## Greenery becomes a generic inventory contract

The observed first consequential boundary is POST /deal-setup/activations/:id/read-source. activation_service.ingestRentRoll calls loadLedgerSnapshot; its current-row exact-label miss can insert a new unit before a human confirms a tenancy proposal. The real-label Greenery rehearsal proves the derived bare-stem export creates46 extra units and matches18 same-text legacy records. It does not prove that those18 are the correct physical parents. Prefixing the derived Unit column changes the outcome, but a property-specific prefix rule would repeat the problem elsewhere.

Required next inventory slice, kept separate from retirement:

- One shared planning/resolution helper used by preview and by the transactional apply. Reuse the same parser, field map, current-inventory predicate and resolver; no second matching algorithm in the browser.
- When existing inventory is present, an unmatched current label needs an explicit selected existing unit ID or an explicitly approved new unit. Show exact-match hierarchy and provenance as review evidence too. Do not infer physical equivalence from spelling, totals or a prefix heuristic.
- Bind the review to retained artifact hash, source key, chosen target, actor/authority and inventory fingerprint. Revalidate at apply. A stale target, changed inventory, removed assignment, foreign property or retired-only target refuses before inventory writes. force is not identity approval.
- Use the existing claim/decision ledger and source evidence links for the versioned interpretation. Preserve payload_json/raw/_source_cells; produced_unit_id and produced_space_id retain canonical attachment. Do not put machine-readable identity decisions in free-text batch notes.
- Confirmation must consume/revalidate the governed attachment. The occupied confirmation branch currently has a missing-unit creation fallback; fixing ingest alone must not leave that route able to recreate a renamed or retired identity.
- Records absent from a source remain visible. Reconciliation/retirement uses the existing retirement owner after a separate authorized physical-identity decision. No blanket107 retirement.

This is an audited build contract, not a deployed safeguard. Claude's separate retirement review must reuse it without overlapping implementation custody.

## Proof that the next property is repeatable

Completion requires a second operator, using the ordinary app, to onboard an unfamiliar synthetic deal/property from a sanitized retained packet without developer-chosen UUIDs, direct SQL correction or bespoke source edits. The packet is a test input; no sample property may appear as fallback in signed-in operation.

The acceptance must cover a fresh property and one with existing inventory; different unit-label conventions; unit and supported bed basis; known/missing/contested values; exact repeated upload; corrected revision with retained history; partial failure/retry; stale/foreign/retired mappings; existing phone-only staff across properties; no assumed SMS consent; expired/replaced answers and source conflicts. Preview must make no operating writes. An approved genuinely new home is created once; a selected existing home retains its identity.

The operator must return later, change a fact in its existing editor, and see the same revised fact in UI and authorized Ask. An unreadable or unauthorized shelf stays unavailable/access-required, never empty or complete. The real property's own controlled inquiry-to-lease acceptance remains a separate release gate.

Each completed launch setup step therefore yields its reusable source/mapping/review/retry receipt. A Greenery-only workaround does not close a framework requirement. A later property should supply different evidence, not require a new importer, prompt branch or workflow.
