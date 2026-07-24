# PHASE 1 HOOK — THE COMPARISON SLICE

*Spec, Jun 10 2026. The hook: "Run us beside your current system. Upload rent roll +
bank statements. We recreate your reports and show you where we match, differ, or
need review." Everything below is anchored to two real golden properties proven
by hand today. No code ships until it grades against these answer keys.*

-----

## WHAT ALREADY EXISTS (do not rebuild)
- Rent roll ingest + promotion — live, proven
- Bank statement intake → staged claims + vendor registry — being proven now
  (Tower Oct run: expect 69 identified / 26 claimed, exposure $110,901.55)
- Categorize → confirm → money_events → category_report_map → report-read — live
- Exposure board (gross-not-net, honest buckets) — proven pattern

## THE NEW PIECE (the only new build)
**The comparison view**: their actual report uploaded → parsed to line items →
compared against our recreated report-read → per-line verdict.

-----

## GOLDEN PROPERTY 1 — TOWER PLACE (expense categorization proof)
October 2025. Hand-reconciled bank activity vs booked P&L.

Exact ties (must auto-match):
- PECO $28,855.57 = Electric. PGW $2,993.41 = Gas.
- NYCB $295,920.60 = $74,681.03 principal + $153,318.90 interest + $67,920.67 escrow
- NBS $43,139.20 = Mezz interest. Triad $2,372.37 = Elevator Contract.
- Amazon (5 charges, $313.91) + PlumbingSupply ($101.55) = $415.46 = Materials & Supplies, exact

Known truths the comparison must surface, not hide:
- Spotify $18.35/mo booked to General Office (miscoding, recurring)
- Hesta $27,700 check bounced twice (capital acct NSF), paid from operating
- Mortgage late charge $14,796.03 — visible on statement, invisible on P&L
- Legal: $22,217 of checks cleared Oct vs $18,940 booked = TIMING, not error

## GOLDEN PROPERTY 2 — 4233 CHESTNUT (cash/waterfall proof)
October 2025. Lender-controlled cash: lockbox → KeyBank CMA → 9-tier ACORE waterfall.

Exact ties (must auto-match):
- Interest tranches 225,722.24 + 62,409.28 + 8,001.19 = $296,132.71 = P&L Mortgage Interest
- Tax tier $13,995.01 = escrow debit. Insurance tier $14,182.25 = escrow debit.
- Berkadia wire $330,164.14 = sum of tiers. KeyBank stmt ties: 58,185.26 + 454,636.46 − 402,206.20 = 110,615.52

Known truths to surface:
- OpEx shortage: waterfall needed $110,037.04, released $72,042.06 → property ran
  $37,994.98 short. No P&L line shows this.
- CapEx reserve dropped $111,519.04 in October; destination not visible in package.
- Structural fact: KeyBank CMA is FBO-lender — can never be Plaid-linked.
  Statement upload is the universal door. (Question 1: CLOSED — statements, not Plaid.)

-----

## THE COMPARISON CONTRACT

**Unit of comparison:** one property, one month, line totals. Not transaction-level
matching in v1.

**Line matching:** their parsed report line → our report_line via category_report_map.
Their lines with no mapping land in `unmatched_lines` (honest blank, drives a
needs_mapping flag — same pattern as report-read v1). Never fuzzy-merged.

**Per-line verdict — four states, never blended:**
1. `matched` — our total = their total, exact.
2. `timing` — totals differ, but the cash events explaining the gap exist in an
   adjacent month (the Tower legal case). Cash-vs-accrual difference, named as such.
3. `unexplained` — totals differ and no timing story covers it. This is the
   review queue. (Spotify→General Office lives here: we'd recreate it as Software.)
4. `not_visible_in_cash` — their line has no cash counterpart in scope (accruals,
   depreciation, prior-period adjustments). Declared, not guessed.

**Headline:** gross unexplained exposure = sum |unexplained variances|. Never net.
`timing` is context, never canceled against unexplained. Same board rule as
deposits/ledgers.

**Booking profile (v1 = minimal):** per property, per vendor: the line THEY book
it to vs the line WE would. Tower's profile after one month already contains:
Spotify→General Office, all-Verizon→Internet, Amazon→Materials. That's the
"learn how each property is booked" promise with zero new architecture — it's a
read over the comparison results.

## OUT OF SCOPE FOR THIS SLICE
Plaid. Transaction-level matching. Multi-property splits UI. Revenue-side
comparison (rent roll vs their rent income lines — next slice, after expense
side proves). Phase 2 obligations/inbox. Auto-correcting their books.

## DONE MEANS
Tower October uploaded (statement + their monthly report) → comparison renders:
the exact-tie lines `matched`, legal flagged `timing`, Spotify line `unexplained`,
D&A/prior-period `not_visible_in_cash`, headline exposure = gross. With the run
receipt. Then the same pass on 4233 with the waterfall ties matched and the
$37,994.98 opex shortage surfaced in the exception queue.
