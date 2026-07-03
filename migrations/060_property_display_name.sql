-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 060 — property display_name (the spoken/shown name)
--
--  WHY: the internal `properties.name` is a load-bearing key. Five live files
--  look the demo property up by the EXACT string "Property Spine Demo Building",
--  so it cannot be renamed. But the AI names the property to prospects and the
--  chrome shows it — where it should read "Solo on Chestnut", not the internal
--  key. This adds an OPTIONAL display name: nullable, so absence = today's exact
--  behavior (coalesce(display_name, name) everywhere it's read). Nothing that
--  keys on `name` is touched. Idempotent.
-- ════════════════════════════════════════════════════════════════════
alter table properties add column if not exists display_name text;

-- Point the Demo Building's spoken name at the real asset. Keyed on the
-- internal name (the load-bearing constant) so it hits exactly that row.
update properties set display_name = 'Solo on Chestnut'
 where name = 'Property Spine Demo Building';
