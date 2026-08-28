# Source Status Model - §40.4

Status: corrected governing source for source/read/epistemic decomposition.

Facts carry authority in their shape, but authority is not a single ladder.
The prior `source_authority` wording collapsed three different questions:

```text
SOURCE CLASS
where the evidence came from

EPISTEMIC STATUS
what the evidence establishes

READ STATUS
whether a governed read succeeded
```

The canonical implementation source is:

```text
src/governance/status_model.js
```

Rules:

```text
source_class is not a rank.
epistemic_status is not provenance.
read_status does not belong on stored interpretation candidates.
resolution_status is defined once beside this model.
```

Meeting Receipt v0 consumes this model. It does not define local status
synonyms.
