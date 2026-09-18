# Skyline & Greenery — launch readiness, 2026-09-15

**Read this first, about sources.** This session has **no production access**.
Every real-property figure below is the owner's own recorded read of the live
app on **2026-09-14** (`docs/CURRENT_STATE.md` STATE SNAPSHOT). Everything
else is established from source — the exact table, column or environment
variable the code reads. Nothing here is estimated, and nothing synthetic is
quoted as a property's own.

> ⚠ **The $26,350 / 31-position / $78,200 figures in CURRENT_STATE rows 80 and
> 82 are SYNTHETIC fixture values in Skyline's shape.** They are not Skyline's
> and must not be said out loud in this meeting.

---

## 1 · Exact rentable homes and date-specific availability

**Known (Skyline, owner read 2026-09-14):** 160 canonical positions across 72
units. 31 confirmed occupied · 9 pending activation · 20 need review · 14
overlapping lease claims · 1 conflicting occupancy evidence · 13 commenced
awaiting move-in funds.

**Known (Greenery):** legacy inventory reconciliation is recorded as shape-
complete — 105 beds under 64 existing parents, 171 units, 212 total spaces, 64
consumed placeholder IDs, 107 untouched unknown identities. Organization and
source reconciliation are recorded as **still open**.

> ⚠ **THE TWO SKYLINE READINGS ARE BOTH VALID AND UNRECONCILED.** Spine says
> 31 confirmed occupied; the tracker reads ~90.6% preleased (145 signed or
> pending, ~148 occupancy claims). **"31 occupied" is not the building's
> business occupancy**, and the 20 needing review plus 14 overlapping claims
> are **missing evidence, not vacancy**. Nothing may offer those beds.

| | |
|---|---|
| **Missing fact** | Which of the 20 review positions and 14 overlapping claims resolve to occupied, and on what evidence |
| **Who resolves** | Griv (property records / current rent roll) |
| **Blocks** | Any date-specific availability answer. The matcher's candidate set comes from `leaseableApplicationTargets`, so an unresolved position is neither offerable nor honestly showable. |

---

## 2 · Approved pricing and lease configuration

**Known:** only **4** Skyline positions carry trusted rent economics. Trusted
rent requires an uncontested spanning lease with a finite positive amount
(`contributesTrustedRent`).

**Known from source — the packet cannot be produced without these two:**
`generateLeasePacket` resolves its template from `properties.lease_config`
(jsonb) or an approved `lease_template` source artifact. With neither, there
is no signing package for that property.

| | |
|---|---|
| **Missing fact** | (a) the approved lease document per property; (b) the published pricing term menu — one published term is quoted and stated, two or more return the menu for the prospect to choose |
| **Who resolves** | Griv (approved lease form) · Kameron (pricing publication) |
| **Blocks** | (a) blocks signing entirely. (b) caps every Ask Spine matching answer at `likely_fit` — `availableUnits` returns `pricing_term_required` and its own note forbids inferring a term from the dates. |

---

## 3 · Operator and countersigner access

**Known from source — two different tables, both required:**
`property_team_assignments` (property × user, `allowed_modules`,
`can_manage_roles`) **and** `assignments` (person × property, role). The
canonical staff identity resolver reads the second; an operator present in
only the first resolves as `no_assignment_at_property` and is refused.
*Measured today* — it refused exactly that way while building the handoff
proof.

Countersignature authority is separate again: `resolveApprovalAuthority`
admits an operator who either holds `can_manage_roles`, owns the approval
obligation, or matches its assigned role.

| | |
|---|---|
| **Missing fact** | Which named person countersigns for each property, and whether they hold rows in **both** tables |
| **Who resolves** | Kameron (Spine access) · Griv (who is authorized to sign) |
| **Blocks** | Execution. Nothing closes the agreement without it. |

---

## 4 · The working paths, and what switches each one on

**Known from source — seven feature gates are keyed to explicit property-ID
lists, set in the Render environment, not in the database:**

```
LEASING_INTAKE_PROPERTY_IDS        website inquiry capture
AGENT_TOUR_BOOKING_PROPERTY_IDS    the agent booking a tour
AGENT_AUTO_DISPATCH_PROPERTY_IDS   the agent replying without a human
PROSPECT_ACTIVATION_PROPERTY_IDS   prospect-facing activation
ACTIVATION_PROPERTY_IDS            activation machinery
EXECUTED_LEASE_PROPERTY_IDS        executed-lease intake
SYNTHETIC_SEED_PROPERTY_IDS        seeding (must NOT contain a live property)
```

Plus non-property switches: `EXECUTED_LEASE_INTAKE_ENABLED`,
`COMMITMENT_LEDGER_MODE`, `LEASING_INTAKE_SECRET`, `PUBLIC_APPLY_BASE_URL`.

| | |
|---|---|
| **Missing fact** | Which of the seven currently name Skyline's and Greenery's property IDs in production |
| **Who resolves** | Kameron — one read of the Render dashboard answers all seven |
| **Blocks** | Everything upstream of the application. A property absent from `LEASING_INTAKE_PROPERTY_IDS` cannot take a website inquiry at all. **This is the cheapest unknown on the sheet and it gates the whole journey.** |

---

## 5 · Where the journey breaks today — measured, not predicted

Proven on a real database this morning
(`tests/proofs/lease_handoff_durable.db.js`, 13/13):

- An eligible completed application now **durably owes** its own handoff, in
  the submission transaction. A restart between submission and execution
  loses nothing — proven by reading the owed work back through a separate
  connection pool with no shared memory.
- The runner then reaches a deliberate authority boundary and stops:
  preparing a package from the applicant's acknowledged offer writes a
  lineage record **attributed to a named staff actor**
  (`deriveConfirmationFromAuthoredOffer` → `preparation_actor_required`).
- On that refusal the work stays owed, no packet is created, and the
  completed application is untouched.

**So the first actual break is a decision, not a defect: who is the attributed
preparer when no person pressed the button?** The offer's author already made
the commercial decision and is recorded on the offer. Attributing preparation
to them is a one-line change and an authority ruling — Kameron's, not mine.

---

## The five questions for Griv

1. **Skyline occupancy:** for the 20 positions needing review and the 14
   overlapping lease claims — which are genuinely occupied, and what document
   proves it? (These are not vacancies and will not be offered until answered.)
2. **The approved lease form** for each property, as a file we can hold as the
   governed template.
3. **Who countersigns** at each property, by name.
4. **Greenery organization and source reconciliation** — which is the system of
   record for its units, and who owns correcting it?
5. **Which homes may actually be leased first?** A bounded launch inventory
   beats the whole building; neither property has to wait for the other.

**Not questions for Griv — Kameron's, and each is one read:** the seven
property-ID gates in Render, the pricing term publication, and the attributed-
preparer ruling above.
