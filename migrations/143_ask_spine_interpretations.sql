-- ════════════════════════════════════════════════════════════════════
--  143 — ASK SPINE INTERPRETATIONS
--
--  Build 2 · what Spine understood, and what the operator corrected it
--  to. One small structured record, not a conversation log.
--
--  ── WHY NOT JUST KEEP THE CHAT ─────────────────────────────────────
--
--  "No, I meant who accepted it" is a correction of an INTERPRETATION,
--  and the pair matters: the original reading, the correction, and the
--  relationship between them. Chat text is not an audit trail — it
--  cannot say which governed intent a turn resolved to, and it invites
--  reconstruction later. This table records the three things that are
--  actually load-bearing and nothing else.
--
--  ── IT IS NOT CONVERSATION MEMORY ──────────────────────────────────
--
--  Deliberately no thread, no ordering beyond time, no summary, no
--  embedding, no state machine. `corrects_id` is a single link to the
--  interpretation being corrected. Long-term memory is not being built
--  here, and a second task system is explicitly out of scope.
--
--  ── APPEND-ONLY ────────────────────────────────────────────────────
--
--  A correction ADDS a row pointing at the original. It never edits it.
--  Overwriting the prior interpretation would destroy exactly the pair
--  that makes the correction meaningful. Same `forbid_mutation()` the
--  proof evaluations and read receipts use — one append-only mechanism
--  in this codebase, not three.
--
--  ── A CLARIFICATION IS NOT AN ANSWER ───────────────────────────────
--
--  `resolution` records `resolved | clarification_required | unsupported`.
--  Only a `resolved` row can carry a read receipt, because only a
--  resolved intent produced a decision-grade answer. That is enforced by
--  ck_asi_receipt_requires_resolution rather than remembered.
-- ════════════════════════════════════════════════════════════════════

create table if not exists public.ask_spine_interpretations (
  id                uuid primary key default gen_random_uuid(),

  --  SCOPE AND ACTOR — server-derived, never client-supplied
  property_id       uuid        not null references public.properties(id),
  actor_user_id     uuid            null references public.users(id),
  staff_session_id  uuid            null,

  --  WHAT WAS ASKED, AND WHAT SPINE UNDERSTOOD
  question_text     text        not null,
  resolution        text        not null,
  intent_slug       text            null,
  resolution_reason text            null,

  --  THE CORRECTION LINK. A correction is a NEW row that names the one
  --  it corrects; the original is never touched.
  corrects_id       uuid            null references public.ask_spine_interpretations(id),

  --  The answer this interpretation led to, when it led to one.
  read_receipt_id   uuid            null references public.ask_spine_read_receipts(id),

  created_at        timestamptz not null default now(),

  constraint ck_asi_resolution
    check (resolution in ('resolved', 'clarification_required', 'unsupported')),

  --  A resolved reading names an intent; the other two must not, because
  --  naming one would imply an answer that was never produced.
  constraint ck_asi_slug_matches_resolution
    check ((resolution = 'resolved') = (intent_slug is not null)),

  --  Only a resolved reading can carry a receipt.
  constraint ck_asi_receipt_requires_resolution
    check (read_receipt_id is null or resolution = 'resolved'),

  --  A row may not correct itself into a loop of one.
  constraint ck_asi_no_self_correction
    check (corrects_id is null or corrects_id <> id)
);

create index if not exists idx_asi_property_time
  on public.ask_spine_interpretations (property_id, created_at desc);
create index if not exists idx_asi_corrects
  on public.ask_spine_interpretations (corrects_id) where corrects_id is not null;

drop trigger if exists no_update_asi on public.ask_spine_interpretations;
create trigger no_update_asi before update on public.ask_spine_interpretations
  for each row execute function public.forbid_mutation();
drop trigger if exists no_delete_asi on public.ask_spine_interpretations;
create trigger no_delete_asi before delete on public.ask_spine_interpretations
  for each row execute function public.forbid_mutation();

comment on table public.ask_spine_interpretations is
  'Build 2: what Spine understood a question to mean, and the corrections that '
  'followed. Append-only — a correction adds a row naming the one it corrects, and '
  'never edits it. Not conversation memory: no thread, no summary, no state.';
