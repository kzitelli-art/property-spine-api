-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 020 — MULTI-NATURE VENDORS
--
--  Some vendors are one thing every time (PECO → utilities). Some are
--  MANY things wearing one name: a management company paid for payroll,
--  fees, AND reimbursements — sometimes inside one wire. For that class,
--  a default category is a polite fiction and a batch proposal is a trap
--  (proven live: three Virtus wires hid inside a batch proposal the
--  review queue could not see — the 2am incident that birthed the
--  vendor-transactions route).
--
--  multi_nature = true means, enforced at the HANDLER level:
--    • the vendor never appears in ready_to_bridge — no batch proposal,
--      regardless of any global default or property rule;
--    • bridge-vendor REFUSES (409) — the shortcut does not exist for
--      this vendor, it cannot be reached by a direct POST either;
--    • bridge-one and bridge-split remain fully available — per-payment
--      human judgment is the ONLY path, by design, not by UI choice.
--
--  Hard rules carried forward:
--    • The flag is set by a HUMAN, explicitly, per vendor. It is never
--      derived from vendor_type — that would be a silent branch.
--    • Teaching only: the flag removes a shortcut; it never creates,
--      categorizes, or deletes money.
--
--  Run AFTER 017 (vendors must exist). Idempotent.
-- ════════════════════════════════════════════════════════════════════

alter table vendors
  add column if not exists multi_nature boolean not null default false;
