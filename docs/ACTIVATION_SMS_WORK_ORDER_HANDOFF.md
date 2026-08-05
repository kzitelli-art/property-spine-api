# ACTIVATION PACKET — resident SMS → work order → technician lifecycle → operator action

**For an authorized operator with Render / Neon access. Self-contained: you do
not need the thread that produced this.**

No Claude thread can run any step here. None has a `DATABASE_URL`, Render
access, or a phone. **Do not send, paste or request a production connection
string in any thread.** Where a step produces output, paste back only the
sanitized rows the step names.

The build being activated, its proof, and its two open items are described in
[`RELEASE_SMS_WORK_ORDER_HANDOFF.md`](RELEASE_SMS_WORK_ORDER_HANDOFF.md). Read
§7 of that document before step 1 — one open item changes what the acceptance
script is allowed to do.

---

## Safety classification — applies to every step below

Two scripts are approved as **structurally read-only** for this activation.
Each proves it by attempting a write and being refused before it reads
anything:

```text
tools/ledger_reconcile.js         read-only, proven
tools/property_line_preflight.js  read-only, proven
```

**Nothing else in this repository is approved to run against production.**

- Everything under `tests/` is **write-capable**. Never run any of it from a
  Render shell, and never in any environment where `DATABASE_URL` may point at
  production.
- Most of `tools/` is **write-capable** — it contains seeds, backfills and
  repairs.
- **A filename is not evidence of safety.** `.db.js`, `_proof.js`, `smoke` and
  `test` tell you nothing about whether a script writes.
- Before any manual SQL, make the session structurally read-only first:

  ```sql
  set default_transaction_read_only = on;
  ```

  Every query in this packet is a `select` and will run under that setting. If
  a query in this packet errors because the session is read-only, **stop** —
  it means the query is not what this packet says it is.

---

## Required identity

| | |
|---|---|
| API branch | `claude/conversational-seams-and-technician-loop` @ `1724a19` |
| App branch | `claude/sms-work-order-handoff-qo3s8i` @ `05a4913` |
| API `main` before this | `8330aec` |
| Applied ledger ceiling expected **before** release | **129** |
| Applied ledger ceiling expected **after** release | **135** |
| Releasing | `130`, `131`, `132`, `133`, `134`, `135` — and nothing else |

Reconcile by **merge**. **Never rebase and never force-push** either branch;
both have shared history with `main`.

---

# PART A — RELEASE (steps 1–14)

**Role: release operator.**

## Step 1 — confirm what is actually deployed

```bash
echo $RENDER_GIT_COMMIT
```

Use this, **not** the dashboard branch label. Record it.

## Step 2 — whole-ledger reconciliation, read-only

```bash
DATABASE_URL="<prod>" node tools/ledger_reconcile.js
```

Paste back only: the `applied ceiling` line, the four `✓`/`•` count lines, the
pending list, and the final verdict line. **Do not paste the connection
string.**

**Required:** `EXIT 0` and `✓ RECONCILED`.

**STOP if** any ledger row is missing from the repository, or any genuine
version/name conflict appears. The one legacy exception
(`012 property_noi_goals`) is expected and documented.

## Step 3 — hard prerequisite: migration 129 must already be applied

Read the `applied ceiling` from step 2.

- **Ceiling `129`** → continue to step 4.
- **Ceiling `128`** → **stop.** Migration `129` has not been released. Run
  [`UNBLOCK_1_MIGRATION_129_ACTIVATION.md`](UNBLOCK_1_MIGRATION_129_ACTIVATION.md)
  to completion first, then restart this packet from step 1.
- **Anything else** → stop and report the number.

This is a gate, not a recommendation. Releasing `130`–`135` onto a `128` schema
would apply `129` in the same batch without its own activation receipt.

## Step 4 — confirm the pending set is exactly what you expect

From step 2's pending list, before any merge, the only pending file should be
none (if `129` is applied) — the `130`–`135` files are not on `main` yet.

**STOP if** anything unexpected is pending.

## Step 5 — merge the API branch into `main`, by merge

```bash
git fetch origin
git checkout main && git pull origin main
git merge --no-ff claude/conversational-seams-and-technician-loop
```

Confirm the merged tip contains `1724a19`:

```bash
git log --oneline -1 claude/conversational-seams-and-technician-loop
git merge-base --is-ancestor 1724a19 HEAD && echo "tip is in"
```

Resolve any conflict by merge. **Do not rebase. Do not force-push.**

## Step 6 — push `main`

```bash
git push origin main
```

## Step 7 — merge and push the app branch

In `property-spine-app`:

```bash
git fetch origin
git checkout main && git pull origin main
git merge --no-ff claude/sms-work-order-handoff-qo3s8i
git push origin main
```

Confirm `05a4913` is an ancestor of the new tip.

## Step 8 — confirm Render built the exact SHA

In the Render shell:

```bash
echo $RENDER_GIT_COMMIT
```

It must equal the merge commit you pushed in step 6.

## Step 9 — expect the boot to REFUSE, and read what it names

The deploy runs `prestart`, which **verifies and never migrates**. With
`130`–`135` in the build and not in the ledger it will refuse to start and name
them:

```text
✗ REFUSING TO START — the schema does not match this code.
  6 migration(s) in this build are NOT applied to the target database:
    · 130_communication_lines.sql
    · 131_work_acceptance.sql
    · 132_outbound_line_policy.sql
    · 133_work_order_reference.sql
    · 134_technician_lifecycle.sql
    · 135_delivery_attempts.sql
  Ledger ceiling is 129.
```

**This is correct.** Production keeps serving the previous build. A deploy does
not migrate; releasing schema is a separate deliberate act.

**STOP if** it names any file other than those six, or reports a ceiling other
than `129`.

## Step 10 — release migrations 130–135

```bash
MIGRATION_RELEASE=1 EXPECTED_LEDGER_CEILING=129 \
  EXPECTED_SHA=<the merge commit from step 6> \
  node migrations/migrate.js --apply
```

The gate requires you to state the ceiling you read in step 2, so a release
cannot happen without having read the ledger.

**STOP if** it refuses. Do not adjust `EXPECTED_LEDGER_CEILING` to make a
refusal go away — the refusal is the finding.

`132` drops `130`'s outbound ban before it backfills. That ordering is
deliberate and was fixed after it was found fatal on any database that had run
`130`. If `132` errors on a constraint, stop and report the exact message.

## Step 11 — re-run the read-only reconciliation

```bash
DATABASE_URL="<prod>" node tools/ledger_reconcile.js
```

**Required:** `applied ceiling 135`, zero pending, `✓ RECONCILED`, `EXIT 0`.

## Step 12 — confirm the service boots and is healthy

Redeploy or restart. `prestart` should now print:

```text
✓ SCHEMA VERIFIED — <n> migrations, all applied. Ledger ceiling 135.
```

Confirm the service reaches healthy and `echo $RENDER_GIT_COMMIT` still equals
the step-6 merge commit.

## Step 13 — confirm the two communication lines, read-only

```sql
set default_transaction_read_only = on;

select line_type, authority_ceiling, permitted_audience,
       inbound_enabled, outbound_enabled, outbound_policy, status
  from communication_lines
 where status = 'active';
```

Paste back **these columns only**. **Do not paste `e164`** — it is a phone
number.

Required for the test property's organization:

| line_type | authority_ceiling | permitted_audience | inbound | outbound | outbound_policy |
|---|---|---|---|---|---|
| `operations` | `operational` | `staff` | `true` | `true` | **`reply_only`** |
| `property_facing` | `external` | `residents_and_prospects` | `true` | `true` | `proactive` |

**STOP if** the operations line's `outbound_policy` is anything other than
`reply_only`. That is the ruling this build depends on, and the database is
what enforces it.

If the operations row does not exist yet, it must be created as an ordinary
data change — not by a migration and not by a script from `tests/`.

## Step 14 — confirm the acceptance fixtures exist, read-only

```sql
set default_transaction_read_only = on;

-- the technician tester can hold work at the test property
select u.name, pta.active
  from property_team_assignments pta
  join users u on u.id = pta.user_id
 where pta.property_id = '<test property id>' and pta.active = true;

-- the resident tester is a consented test person
select p.name, cp.channel, cp.consent_state
  from persons p
  join contact_preferences cp on cp.person_id = p.id
 where p.id = '<resident tester person id>';
```

Paste back names and states only — **no phone numbers**.

Required: the technician tester has an active assignment, and the resident
tester's `text` consent is `opted_in`.

**The resident tester must be a staff-owned second handset, not a real
resident.** See §7.1 of the release package for why.

---

# PART B — REAL-PHONE ACCEPTANCE (steps 15–18)

**Roles: technician tester, operator tester, resident tester.**

Do not begin until step 12 reports ceiling `135` and the service is healthy.

Record, for every step: the wall-clock time, what was typed, what came back,
and a screenshot of the operator surface. That set is the acceptance receipt.

## Step 15 — the technician half, from a real handset

Open a work order at the test property with the resident tester as the affected
person, and assign it to the technician tester.

From the technician's handset, to the **operations line**, one message at a
time. Wait for each reply before sending the next.

| # | Text exactly this | Expect back |
|---|---|---|
| 15.1 | `what do I have` | The work they hold, named in plain words. No codes. |
| 15.2 | `got it` | Acceptance, confirmed by name — not a reference number. If they hold more than one job, expect **a question**, not a menu. That is correct behaviour. |
| 15.3 | `on my way` | Acknowledgement. **The resident tester should receive** *"Your technician is on the way for the …"* |
| 15.4 | `couldn't get in` | Acknowledgement. **The resident tester should receive** *"The technician could not access the unit. Please reply with the best way to coordinate entry."* |
| 15.5 | `back on site, valve was corroded` | Recorded as a finding. **The resident tester must receive nothing.** Findings are internal by default. |
| 15.6 | `all done` | A **claim**, not a closure. Expect to be told a photo is required. **The resident tester must receive nothing** — `completion_claimed` is not resident-safe. |
| 15.7 | Send a **photo**, with any caption | The photo is evidence; the caption is **not** a finding. |
| 15.8 | `all done` | Now the governed service closes it. **The resident tester should receive** *"The repair has been completed."* |

**STOP if** the resident tester receives anything at 15.5 or 15.6, or if any
message the technician typed reaches the resident in their own words. Either is
a containment failure, not a cosmetic one.

## Step 16 — the operator half, in a browser

Sign in as the operator tester at the test property and open
**Maintenance → Work Orders**.

| # | Do this | Expect |
|---|---|---|
| 16.1 | Read the queue | Three bands. The count at the top matches **Needs action**. |
| 16.2 | Press **Assign** on an unowned row | A picker offering **only** staff assigned to this property. |
| 16.3 | Choose someone and confirm | Receipt: *"… is assigned to …. They still need to accept it."* The row then reads *"Waiting for … to accept."* |
| 16.4 | Press **Review** on a claim-without-proof row | The detail opens, says the technician reports the work finished, and names the missing photo. **Nothing is written.** |
| 16.5 | Press **Ask …** on that detail | Receipt: *"Photo request prepared for …."* Delivery is reported **separately** and is never claimed as delivered by the act of pressing. The technician's handset receives the request. |
| 16.6 | Press **Ask …** a second time | *"… is already prepared."* **No second text arrives.** |
| 16.7 | **Coordinate entry** | **See the note below — do not press this against a real resident.** |
| 16.8 | Press **Retry** on a row showing *Resident completion text failed* | Receipt. No new work order, no new message, no new completion event. The attempt is attributed to you. |
| 16.9 | Reload after a successful retry | The exception clears from that row and it moves to **Recently completed**. |

**16.7 — `Coordinate entry` is held pending an owner ruling.** The resident is
already sent the coordinate-entry sentence automatically when no access is
reported, and this control sends byte-identical text a second time
(release package §7.1). Exercise it **only** against the staff-owned resident
tester handset, note that two identical messages arrive, and record that as the
evidence for the ruling. **Do not press it against a real resident.**

## Step 17 — the resident half

From the resident tester handset, confirm across the whole run:

- Every message received was one of the three resident-safe sentences.
- No technician wording, no internal note, no finding, and no reference code
  appeared.
- Nothing arrived from the operations line. All resident traffic came from the
  property line.

**STOP if** anything else arrived.

## Step 18 — capture the receipt

Assemble and keep:

- Screenshots of the queue and of one detail, before and after step 16.
- The technician's message thread.
- The resident's message thread.
- Steps 2, 11 and 12 output, sanitized.
- The exact `RENDER_GIT_COMMIT`, the merge commit, and the wall-clock window.

This is what makes the release *browser verified and phone verified* rather
than *deployed*.

---

# PART C — STOP AND ROLLBACK (step 19)

## Step 19 — rollback

**Schema is not rolled back.** Migrations `130`–`135` are additive: new tables,
new columns, new constraints on new tables. Reverting them is a bigger risk
than leaving them.

To take the behaviour out of service without touching schema, in order of
increasing scope:

1. **Silence the operations line.** Set its `outbound_policy` to `disabled`.
   The technician conversation still records facts; nothing replies. This is
   the smallest containment and it is enforced by the database.
2. **Take the line inbound-off.** Set `inbound_enabled = false` on the
   operations line.
3. **Revert the app merge only.** The operator controls disappear; the API and
   the technician path are untouched.
4. **Revert the API merge.** The code goes; the schema stays at `135`, and the
   boot gate will then refuse, because the ledger is ahead of the build. If you
   go this far, expect that and plan for it before you push.

**Stop conditions — halt immediately and do not continue:**

- Any resident receives a technician's own words.
- Any resident-facing message appears on the operations line.
- The operations line's `outbound_policy` reads anything but `reply_only`.
- A work order shows closed without preserved proof.
- The ledger reconciliation reports anything other than `✓ RECONCILED`.
- The boot verify names a pending migration after step 10.
