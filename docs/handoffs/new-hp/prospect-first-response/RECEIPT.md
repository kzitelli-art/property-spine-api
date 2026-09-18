# Prospect first response: question-aware opening

## Purpose

The opening message is part of the prospect conversation. It should answer the
question submitted with the lead before inviting a tour, while preserving the
prospect's lower-commitment option to ask questions first.

## Change

`draftFirstResponse()` now receives the original intake message and reads the
current property-wide `agent_facts` shelf through the existing
`leasing_knowledge` reader. The model is told to answer that question first
from approved descriptive facts, then offer a tour openly. Rent, availability,
readiness, fees, dates, exact-home identity and tour times remain outside this
shelf and must come from their existing governed readers. The message text is
still treated as untrusted content, and no new conversation or transport path
was introduced.

The caller passes `b.message` from the existing canonical intake service. This
improves the opening turn for a question such as “Does this building have a
gym?” without changing the ongoing `/agent/inbound` conversation loop or its
human-takeover boundary.

## Evidence

- `tests/unit/first_response_conversation.test.js`: model prompt contains the
  prospect's question and an approved amenity fact; returned text answers first.
- `tests/unit/leasing_knowledge.test.js`: bare rent questions route to the
  governed Economics rail while “rent roll” remains Tenancy.
- `node tests/verify_source_governance.js`: 56/56 gates passed locally.

This is a source candidate until its exact commit passes CI and is deployed.
No property data, Greenery custody, pricing, availability or customer message
was changed.
