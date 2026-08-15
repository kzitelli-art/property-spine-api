# Equity declarations

Real declaration files for `establish_position.js` go here, one per
property — the same role `tools/debt/declarations/4125_480010465.json`
plays for Debt.

**Empty on purpose.** No real Equity governing document has been confirmed
as retained in production as a `source_artifacts` row yet, so there is
nothing to declare truthfully. A declaration written without that
confirmation would be exactly the "load unexplained literals into
production" failure `establish_position.js`'s own header describes —
provenance is the whole point, and it cannot be invented here to make this
directory look less empty than it is.

Before writing a declaration:

1. Confirm the real documents (Interest Holder LLC OA, Holdings LLC OA,
   MSC's HoldCo Pay Schedule, and anything needed to resolve MSC's
   Minimum Dividend relationship — specifically OA §1.49) are retained in
   production and hashed.
2. Write the declaration citing those real hashes, one retained artifact
   per canonical row, following the shape `establish_position.js`
   validates.
3. Dry-run it, review the rows it would write, then `--apply`.

See `docs/release/EQUITY_174_RUN_CARD.md` for the full sequence this fits
into, and `docs/EQUITY_READ_CONTRACT_AND_SCHEMA.md` for why MSC's Minimum
Dividend relationship specifically cannot be declared as anything but
`not_established` from a survey paraphrase — the tool enforces this, not
just this note.
