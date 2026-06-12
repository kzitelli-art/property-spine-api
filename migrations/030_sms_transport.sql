-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 030 — SMS TRANSPORT (the second door of the text line)
--
--  027 built the connection, 028 built the message loop (browser door).
--  030 adds the columns the SMS door needs. NO new tables — SMS is a
--  TRANSPORT under the existing machinery, not a new message store.
--  comm_events stays the single store; conversations stays the thread.
--
--  properties.sms_number — the property's text line (E.164). This is
--    identity for INBOUND routing: Twilio's "To" resolves to exactly one
--    property. Null = property has no line yet (everything degrades to
--    the link-only behavior, honestly).
--
--  tenant_invites OTP columns — the verification slot 027 deliberately
--    left open. The code itself is NEVER stored — only a salted hash.
--    otp_sent_at rate-limits resends. Wrong-code attempts share the
--    existing failed_attempts counter (5 misses revokes the link, same
--    rule as phone-match — one lockout policy, not two).
--
--  comm_events SMS columns — every message that touched the wire carries
--    its receipt: the Twilio SID, the last known status, and the honest
--    error when a send failed. A failed send is a RECORDED failure on a
--    message that already exists — never a lost message.
--
--  The partial unique index on sms_sid is the webhook dedupe guard:
--  Twilio retries on timeout; a retried MessageSid can never become a
--  second row. Structural wall, not policy.
--
--  NOTE: migrate.js wraps each file in its own begin/commit and records
--  the ledger row. NO transaction control, NO ledger insert here.
-- ════════════════════════════════════════════════════════════════════

alter table properties
  add column if not exists sms_number text;

alter table tenant_invites
  add column if not exists otp_hash text,
  add column if not exists otp_expires_at timestamptz,
  add column if not exists otp_sent_at timestamptz;

alter table comm_events
  add column if not exists sms_sid text,
  add column if not exists sms_status text,
  add column if not exists sms_error text;

create unique index if not exists idx_comm_sms_sid
  on comm_events(sms_sid) where sms_sid is not null;

-- Inbound resolution: Twilio "From" → person. First index on persons.phone.
create index if not exists idx_persons_phone on persons(phone);
