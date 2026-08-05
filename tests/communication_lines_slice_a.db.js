// ════════════════════════════════════════════════════════════════════
//  communication_lines_slice_a.db.js — REAL POSTGRES + REAL HTTP.
//
//  Slice A of the canonical communication-line model. Migrations 129 and
//  130 are executed VERBATIM against a real database, and the real inbound
//  router is mounted exactly as server.js mounts it and driven over a real
//  socket.
//
//  THE INVARIANT THIS HARNESS EXISTS FOR:
//
//    An organization-owned line establishes ORGANIZATION context and an
//    authority ceiling. IT DOES NOT ESTABLISH PROPERTY CONTEXT.
//
//  It is migration 129's defect on a different axis. There, two properties
//  shared one number and `limit 1` picked arbitrarily. Here one number
//  legitimately spans many properties, and the temptation is to infer
//  "their property" from assignment order, recency, or the fact that the
//  organization happens to own one building today.
//
//  So the hostile cases are the point, not the coverage:
//    · a FULLY RESOLVABLE staff sender texts a property-facing line and
//      still receives no operational authority — proving the CEILING, not
//      the old accident that staff were simply unlookupable;
//    · a single-property organization takes NO shortcut — the case that
//      would pass by luck today and misroute the day a second property is
//      added.
//
//  ── SCHEMA SCOPE, STATED PLAINLY ────────────────────────────────────
//  Tables are built from the verbatim definitions in migrations 001, 090,
//  093 and 030 — the ones this code path touches — and then migrations 129
//  and 130 are run against them unmodified. The FULL production schema is
//  not built, because the migration chain cannot rebuild from empty
//  (012_bank_intake.sql fails on yardi_code — PR #33). That is a known,
//  owned defect outside this slice.
//
//  What it costs: the zero-write assertions are enforced as a full
//  row-count vector over every table present, which covers every table this
//  path can reach. They prove nothing about tables it never touches.
//
//  ── SAFETY ──────────────────────────────────────────────────────────
//   · HARNESS_DATABASE_URL only, no fallback; scratch database, dropped.
//   · Every number is harness-minted in the reserved +1 555 01xx range and
//     every provider id carries a harness prefix. Both asserted.
//   · The SMS double never imports the Twilio client. Zero sends asserted.
// ════════════════════════════════════════════════════════════════════
"use strict";
const http = require("http");
const path = require("path");
const fs = require("fs");
const { Client } = require("pg");
const receipt = require("./_run_receipt");
const lines = require("../src/comms/communication_lines");

const HARNESS = __filename;
const EXPECTED = 51;
let passed = 0, failed = 0, ran = 0;
function ok(label, cond, detail) {
  ran++;
  if (cond) { passed++; console.log("  ok    " + label); }
  else { failed++; console.log("  FAIL  " + label + (detail ? "  →  " + detail : "")); }
}
function section(t) { console.log(`\n── ${t} ${"─".repeat(Math.max(0, 56 - t.length))}`); }

const ADMIN_URL = receipt.harnessConnectionString();
const SCRATCH_DB = `ps_comm_lines_${process.pid}`;
const M = (n) => fs.readFileSync(path.join(__dirname, "..", "migrations", n), "utf8");

const LINE_PROP_A = "+15550101001";
const LINE_PROP_B = "+15550101002";
const LINE_OPS    = "+15550101500";
const LINE_FREE   = "+15550101999";
const PHONE_STAFF_MULTI  = "+15550102001";
const PHONE_STAFF_SINGLE = "+15550102002";
const PHONE_RESIDENT     = "+15550102003";
const SID = "HARNESSSID_";

const SCOPED_SCHEMA = `
  create extension if not exists pgcrypto;
  do $$ begin
    create type role_name as enum ('owner','asset_manager','property_manager',
      'leasing_agent','maintenance','accountant','ai','system');
  exception when duplicate_object then null; end $$;

  create table organizations (
    id uuid primary key default gen_random_uuid(),
    name text not null, slug text unique,
    status text not null default 'active',
    created_at timestamptz not null default now());

  create table properties (
    id uuid primary key default gen_random_uuid(),
    name text not null, address text, city text, state text, zip text,
    property_type text, leasing_basis text,
    organization_id uuid references organizations(id) on delete set null,
    sms_number text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now());

  create table users (
    id uuid primary key default gen_random_uuid(),
    name text not null, email text unique, phone text,
    role role_name not null default 'property_manager',
    auth_provider text, is_active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now());

  create table property_team_assignments (
    id uuid primary key default gen_random_uuid(),
    property_id uuid not null references properties(id) on delete cascade,
    user_id uuid not null references users(id) on delete cascade,
    role_title text not null,
    scope_type text not null default 'property',
    allowed_modules text[] not null default '{}',
    primary_for_modules text[] not null default '{}',
    can_manage_roles boolean not null default false,
    active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (property_id, user_id));

  create table comm_events (
    id uuid primary key default gen_random_uuid(),
    property_id uuid references properties(id) on delete cascade,
    person_id uuid, unit_id uuid, work_order_id uuid,
    conversation_id uuid,     -- migration 027; 132's ck_comm_one_thread reads it
    channel text not null default 'chat',
    direction text not null default 'inbound',
    body text, transcript text, ai_summary text, sms_sid text,
    needs_human boolean not null default false,
    follow_up_required boolean not null default false,
    occurred_at timestamptz not null default now());
  create unique index idx_comm_sms_sid on comm_events(sms_sid) where sms_sid is not null;

  create table work_orders (id uuid primary key default gen_random_uuid(), property_id uuid);
  create table obligations (id uuid primary key default gen_random_uuid(), property_id uuid);

  --  THE PROPERTY-FACING SENDER PATH. Added after the first run of this
  --  harness produced a FALSE GREEN: without these tables the resident/lead
  --  lookup threw 42P01, the route swallowed it (it acks the provider by
  --  design), and "resolvable staff gains no authority" passed because the
  --  query CRASHED — not because the ceiling held. Columns are the ones
  --  communications_boundary actually reads, from migrations 001/027/038.
  create table persons (
    id uuid primary key default gen_random_uuid(),
    name text, email text, phone text, primary_phone_e164 text,
    lifecycle_status text not null default 'lead',
    created_at timestamptz not null default now());

  create table units (
    id uuid primary key default gen_random_uuid(),
    property_id uuid not null references properties(id) on delete cascade,
    unit_number text,
    created_at timestamptz not null default now());

  create table spaces (
    id uuid primary key default gen_random_uuid(),
    unit_id uuid not null references units(id) on delete cascade,
    space_label text default '(whole unit)',
    created_at timestamptz not null default now());

  create table leases (
    id uuid primary key default gen_random_uuid(),
    property_id uuid not null references properties(id) on delete cascade,
    space_id uuid references spaces(id) on delete restrict,
    tenant_ids uuid[] not null default '{}',
    rent numeric(10,2),
    balance numeric(10,2) not null default 0,
    start_date date, end_date date,
    lease_status text not null default 'active',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now());

  create table tenant_invites (
    id uuid primary key default gen_random_uuid(),
    person_id uuid not null references persons(id) on delete cascade,
    property_id uuid not null references properties(id) on delete cascade,
    token text not null unique,
    status text not null default 'active',
    expires_at timestamptz not null default now() + interval '30 days',
    created_at timestamptz not null default now());

  create table leasing_leads (
    id uuid primary key default gen_random_uuid(),
    person_id uuid not null references persons(id),
    property_id uuid not null references properties(id),
    status text not null default 'new',
    received_at timestamptz not null default now());
`;

(async () => {
  let admin = null, db = null, server = null, code = 1;
  const sends = [];

  //  THE SENTINEL. The inbound route acks the provider before it awaits
  //  anything and swallows failures by design, so a query that THROWS looks
  //  identical to a clean refusal from the outside: zero rows written, 200
  //  returned. The first run of this harness passed 57/57 that way — the
  //  resident/lead lookup hit 42P01 on tables the scoped schema lacked, and
  //  "resolvable staff gains no authority" was green because the query DIED.
  //
  //  Absence of red is not green. Everything the boundary logs is captured
  //  and a database error anywhere in the run invalidates it.
  const boundaryErrors = [];
  const realError = console.error;
  console.error = (...a) => { boundaryErrors.push(a.map(String).join(" ")); realError(...a); };
  const dbErrors = () => boundaryErrors.filter((m) =>
    /42P01|does not exist|relation .* does not exist|column .* does not exist|syntax error/i.test(m));
  try {
    admin = new Client({ connectionString: ADMIN_URL, ssl: { rejectUnauthorized: false } });
    await admin.connect();
    await admin.query(`drop database if exists ${SCRATCH_DB}`);
    await admin.query(`create database ${SCRATCH_DB}`);
    const dbUrl = (() => { const u = new URL(ADMIN_URL); u.pathname = "/" + SCRATCH_DB; return u.toString(); })();
    db = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await db.connect();
    await db.query(SCOPED_SCHEMA);

    receipt.begin(HARNESS, { url: dbUrl, expected: EXPECTED });
    console.log(`  SCRATCH   ${SCRATCH_DB}`);
    console.log(`  MIGRATIONS 129 and 130 executed verbatim`);
    console.log(`  NUMBERS   harness-minted, +1 555 01xx reserved range only\n`);

    // ── fixtures, pre-migration ──────────────────────────────────────
    const org = (await db.query(
      `insert into organizations (name, slug) values ('Harness Org','harness-org') returning id`)).rows[0];
    const orgSolo = (await db.query(
      `insert into organizations (name, slug) values ('Solo Org','solo-org') returning id`)).rows[0];
    const propA = (await db.query(
      `insert into properties (name, organization_id, sms_number) values ('Prop A',$1,$2) returning id`,
      [org.id, LINE_PROP_A])).rows[0];
    const propB = (await db.query(
      `insert into properties (name, organization_id, sms_number) values ('Prop B',$1,$2) returning id`,
      [org.id, LINE_PROP_B])).rows[0];
    const propSolo = (await db.query(
      `insert into properties (name, organization_id) values ('Solo Prop',$1) returning id`,
      [orgSolo.id])).rows[0];
    const propOrphan = (await db.query(
      `insert into properties (name) values ('No Org Prop') returning id`)).rows[0];

    const staffMulti = (await db.query(
      `insert into users (name,email,phone,role) values ('Multi','m@h.test',$1,'maintenance') returning id`,
      [PHONE_STAFF_MULTI])).rows[0];
    const staffSingle = (await db.query(
      `insert into users (name,email,phone,role) values ('Single','s@h.test',$1,'maintenance') returning id`,
      [PHONE_STAFF_SINGLE])).rows[0];
    await db.query(`insert into property_team_assignments (property_id,user_id,role_title) values ($1,$2,'Tech'),($3,$2,'Tech')`,
      [propA.id, staffMulti.id, propB.id]);
    await db.query(`insert into property_team_assignments (property_id,user_id,role_title) values ($1,$2,'Tech')`,
      [propSolo.id, staffSingle.id]);

    //  THE HOSTILE FIXTURE. This person is BOTH a staff user of the
    //  organization AND a fully resolvable active resident of Prop A, on the
    //  same phone. Texting the property line, they resolve completely — so
    //  the ceiling is the only thing that can hold. Before migration 130 the
    //  invariant held only because staff were unlookupable on this path;
    //  that accident is exactly what this fixture removes.
    const staffPerson = (await db.query(
      `insert into persons (name, phone, primary_phone_e164, lifecycle_status)
       values ('Multi (also a resident)', $1, $1, 'tenant') returning id`,
      [PHONE_STAFF_MULTI])).rows[0];
    const unitA = (await db.query(
      `insert into units (property_id, unit_number) values ($1,'101') returning id`, [propA.id])).rows[0];
    const spaceA = (await db.query(
      `insert into spaces (unit_id) values ($1) returning id`, [unitA.id])).rows[0];
    await db.query(`insert into leases (property_id, space_id, tenant_ids, lease_status) values ($1,$2, array[$3::uuid], 'active')`,
      [propA.id, spaceA.id, staffPerson.id]);
    await db.query(`insert into tenant_invites (person_id, property_id, token, status) values ($1,$2,$3,'used')`,
      [staffPerson.id, propA.id, "harness-token-" + process.pid]);

    // ── run the migrations verbatim ──────────────────────────────────
    await db.query(M("129_property_line_uniqueness.sql"));
    await db.query(M("130_communication_lines.sql"));
    //  132 ships with 130 and the CODE now requires it: the resolver selects
    //  outbound_policy, which only exists after 132. A harness that stopped at
    //  130 was proving a schema this tree cannot run against — it died on the
    //  missing column, correctly. 131 and 133 touch obligations and work
    //  orders and are not on this code path, so they are deliberately absent:
    //  a harness runs the migrations its path needs, not all of them.
    await db.query(M("132_outbound_line_policy.sql"));

    section("MIGRATION 130 · backfill and projection");
    {
      const backfilled = (await db.query(
        `select property_id, e164, line_type, authority_ceiling, permitted_audience, outbound_enabled, outbound_policy, status
           from communication_lines order by e164`)).rows;
      ok("130 backfilled one property_facing line per property holding a number",
        backfilled.length === 2, JSON.stringify(backfilled.map((b) => b.e164)));
      ok("130 backfill set the external ceiling on every property line",
        backfilled.every((b) => b.line_type === "property_facing" &&
          b.authority_ceiling === "external" && b.permitted_audience === "residents_and_prospects"));
      //  RULING 2026-08-04 — 130's blanket ban is replaced by 132's policy.
      //  Property-facing lines are proactive (they already originate setup
      //  links and agent replies); recording them as unable to send would be
      //  a false blank.
      ok("132 left every property line on the proactive resident policy",
        backfilled.every((b) => b.outbound_policy === "proactive" && b.outbound_enabled === true));
      ok("130 created NO operations line — activation is a separate governed act",
        backfilled.every((b) => b.line_type !== "operations"));
    }

    section("CONSTRAINTS · forbidden combinations are unexpressable");
    const refuse = async (sql, params) => {
      try { await db.query(sql, params); return null; } catch (e) { return e; }
    };
    {
      const e = await refuse(
        `insert into communication_lines (e164,line_type,property_id,authority_ceiling,permitted_audience)
         values ($1,'property_facing',$2,'operational','residents_and_prospects')`, [LINE_FREE, propA.id]);
      ok("a property_facing line CANNOT carry operational authority", !!e, e && e.message);
      ok("  ...refused by the posture constraint, not by application code",
        !!e && /ck_cl_posture_coherent/.test(e.message), e && e.message);
    }
    {
      const e = await refuse(
        `insert into communication_lines (e164,line_type,organization_id,authority_ceiling,permitted_audience)
         values ($1,'operations',$2,'external','staff')`, [LINE_FREE, org.id]);
      ok("an operations line CANNOT carry the external ceiling", !!e);
    }
    {
      const e = await refuse(
        `insert into communication_lines (e164,line_type,property_id,organization_id,authority_ceiling,permitted_audience)
         values ($1,'operations',$2,$3,'operational','staff')`, [LINE_FREE, propA.id, org.id]);
      ok("a line cannot have BOTH a property and an organization owner", !!e);
    }
    {
      const e = await refuse(
        `insert into communication_lines (e164,line_type,authority_ceiling,permitted_audience)
         values ($1,'operations','operational','staff')`, [LINE_FREE]);
      ok("an operations line with NO owner is refused", !!e);
    }
    {
      //  A property with no organization has no organization to own an ops
      //  line. There is no column that could attach one.
      const e = await refuse(
        `insert into communication_lines (e164,line_type,property_id,authority_ceiling,permitted_audience)
         values ($1,'operations',$2,'operational','staff')`, [LINE_FREE, propOrphan.id]);
      ok("HOSTILE: a property with no organization CANNOT receive an operations line", !!e);
    }
    {
      //  RULING 2026-08-04. The blanket ban is gone; what replaced it is
      //  stricter, not looser — an operations line may be reply_only, and
      //  PROACTIVE remains a row that cannot exist.
      const e = await refuse(
        `insert into communication_lines (e164,line_type,organization_id,authority_ceiling,permitted_audience,outbound_enabled,outbound_policy)
         values ($1,'operations',$2,'operational','staff',true,'proactive')`, [LINE_FREE, org.id]);
      ok("an operations line can NEVER be proactive", !!e);
      ok("  ...refused by ck_cl_outbound_policy_by_type",
        !!e && /ck_cl_outbound_policy_by_type/.test(e.message));
    }
    {
      const e = await refuse(
        `insert into communication_lines (e164,line_type,property_id,authority_ceiling,permitted_audience)
         values ('555-010-1999','property_facing',$1,'external','residents_and_prospects')`, [propOrphan.id]);
      ok("a non-canonical number cannot be stored", !!e);
    }

    // ── the operations line, created the governed way ────────────────
    await db.query(
      `insert into communication_lines (e164,line_type,organization_id,authority_ceiling,permitted_audience)
       values ($1,'operations',$2,'operational','staff')`, [LINE_OPS, org.id]);
    {
      const e = await refuse(
        `insert into communication_lines (e164,line_type,organization_id,authority_ceiling,permitted_audience)
         values ($1,'operations',$2,'operational','staff')`, [LINE_FREE, org.id]);
      ok("HOSTILE: a SECOND active operations line for the org is refused by the database", !!e);
      ok("  ...refused by uq_cl_one_active_ops_line_per_org",
        !!e && /uq_cl_one_active_ops_line_per_org/.test(e.message), e && e.message);
    }

    section("PROJECTION · one writable truth");
    {
      const p = (await db.query(`select sms_number from properties where id=$1`, [propA.id])).rows[0];
      ok("compatibility projection: display consumers still read properties.sms_number",
        p.sms_number === LINE_PROP_A, p.sms_number);

      const e = await refuse(`update properties set sms_number=$1 where id=$2`, [LINE_FREE, propA.id]);
      ok("HOSTILE: a divergent legacy write is REFUSED", !!e, "the write succeeded");
      ok("  ...with a message naming the canonical model",
        !!e && /READ-ONLY PROJECTION/.test(e.message), e && e.message);

      const e2 = await refuse(`insert into properties (name, sms_number) values ('Sneaky',$1)`, [LINE_FREE]);
      ok("HOSTILE: inserting a property with a line directly is REFUSED", !!e2);

      const e3 = await refuse(`update properties set name='Renamed A' where id=$1`, [propA.id]);
      ok("an unrelated property update still works", e3 === null, e3 && e3.message);

      //  Canonical write flows through to the projection.
      await db.query(`update communication_lines set status='retired', superseded_at=now()
                       where property_id=$1 and status='active'`, [propA.id]);
      const after = (await db.query(`select sms_number from properties where id=$1`, [propA.id])).rows[0];
      ok("retiring the canonical line clears the projection automatically",
        after.sms_number === null, after.sms_number);
      await db.query(
        `insert into communication_lines (e164,line_type,property_id,authority_ceiling,permitted_audience)
         values ($1,'property_facing',$2,'external','residents_and_prospects')`, [LINE_PROP_A, propA.id]);
      const back = (await db.query(`select sms_number from properties where id=$1`, [propA.id])).rows[0];
      ok("re-activating a canonical line restores the projection",
        back.sms_number === LINE_PROP_A);
    }

    section("RESOLUTION · zero, one, many, active vs retired");
    {
      const one = await lines.resolveInboundLine(db, LINE_PROP_A);
      ok("one active line resolves to exactly that line",
        one.outcome === "one" && one.line.property_id === propA.id, one.outcome);
      ok("formatting-equivalent inbound resolves identically",
        (await lines.resolveInboundLine(db, "(555) 010-1001")).line.property_id === propA.id);
      ok("an unconfigured number resolves to 'none'",
        (await lines.resolveInboundLine(db, LINE_FREE)).outcome === "none");
      ok("an unnormalizable number resolves to 'unresolvable'",
        (await lines.resolveInboundLine(db, "not-a-number")).outcome === "unresolvable");

      //  HOSTILE: a retired row sharing a number with an active one.
      const retiredCount = Number((await db.query(
        `select count(*)::int n from communication_lines where e164=$1 and status='retired'`,
        [LINE_PROP_A])).rows[0].n);
      ok("a retired line shares the number with the active one (history preserved)",
        retiredCount === 1, `retired rows=${retiredCount}`);
      ok("HOSTILE: the retired row does NOT participate in resolution",
        one.candidates.length === 1 && one.candidates[0].status === "active");

      const opsLine = await lines.resolveInboundLine(db, LINE_OPS);
      ok("the operations line resolves and carries the operational ceiling",
        opsLine.outcome === "one" && lines.lineAuthority(opsLine.line).authorityCeiling === "operational");
      ok("the operations line establishes NO property context",
        opsLine.line.property_id === null &&
        lines.lineAuthority(opsLine.line).establishesPropertyContext === false);

      //  inactive: suspend the solo property's line after configuring one
      await db.query(
        `insert into communication_lines (e164,line_type,property_id,authority_ceiling,permitted_audience,status)
         values ($1,'property_facing',$2,'external','residents_and_prospects','suspended')`,
        [LINE_FREE, propSolo.id]);
      const inact = await lines.resolveInboundLine(db, LINE_FREE);
      ok("a suspended line resolves to 'inactive', not 'none'", inact.outcome === "inactive", inact.outcome);
      ok("  ...and yields no line", inact.line === null);
    }

    section("PROPERTY CONTEXT · the organization never chooses a building");
    {
      const staff = await lines.resolveStaffSenderForOrganization(db,
        { organizationId: org.id, fromNumber: PHONE_STAFF_MULTI });
      ok("a staff sender resolves within their own organization", staff.outcome === "one");

      const notStaff = await lines.resolveStaffSenderForOrganization(db,
        { organizationId: org.id, fromNumber: PHONE_RESIDENT });
      ok("a non-staff sender does not resolve on the operations line", notStaff.outcome === "none");

      const foreign = await lines.resolveStaffSenderForOrganization(db,
        { organizationId: orgSolo.id, fromNumber: PHONE_STAFF_MULTI });
      ok("staff of ANOTHER organization do not resolve here", foreign.outcome === "none");

      //  HOSTILE 1 — multiple assignments, no property may be chosen.
      const many = await lines.resolvePropertyContextForStaff(db,
        { organizationId: org.id, userId: staffMulti.id });
      ok("HOSTILE: staff with 2 assignments → 'many', NO property selected",
        many.outcome === "many" && many.propertyId === null, JSON.stringify(many.outcome));
      const clar = lines.clarificationFor(many);
      ok("  ...and the smallest useful clarification is produced",
        !!clar && clar.reason === "property_context_ambiguous" && clar.options.length === 2);
      ok("  ...naming only the sender's OWN properties, never the org's portfolio",
        clar.options.every((o) => [propA.id, propB.id].includes(o.property_id)));

      //  HOSTILE 2 — the single-property organization. This is the case that
      //  would pass by luck and misroute the day a second property appears.
      const single = await lines.resolvePropertyContextForStaff(db,
        { organizationId: orgSolo.id, userId: staffSingle.id });
      ok("HOSTILE: a single-property organization resolves through the SAME explicit path",
        single.outcome === "one" && single.source === "assignment", JSON.stringify(single));
      ok("  ...from the SENDER'S assignment, not from the organization's property list",
        single.propertyId === propSolo.id);

      //  Proof that the org's property list is not the source: give the solo
      //  org a second property that the sender is NOT assigned to. If
      //  resolution consulted the organization, this would now be ambiguous.
      const extra = (await db.query(
        `insert into properties (name, organization_id) values ('Solo Prop 2',$1) returning id`,
        [orgSolo.id])).rows[0];
      const stillOne = await lines.resolvePropertyContextForStaff(db,
        { organizationId: orgSolo.id, userId: staffSingle.id });
      ok("PROPERTY: adding an org property the sender is unassigned to changes nothing",
        stillOne.outcome === "one" && stillOne.propertyId === propSolo.id,
        JSON.stringify(stillOne));

      //  Explicit work reference wins, and stays organization-scoped.
      const wo = (await db.query(
        `insert into work_orders (property_id) values ($1) returning id`, [propB.id])).rows[0];
      const byRef = await lines.resolvePropertyContextForStaff(db,
        { organizationId: org.id, userId: staffMulti.id, workOrderId: wo.id });
      ok("an explicit work-order reference resolves property context",
        byRef.outcome === "explicit_reference" && byRef.propertyId === propB.id);
      const foreignWo = await lines.resolvePropertyContextForStaff(db,
        { organizationId: orgSolo.id, userId: staffSingle.id, workOrderId: wo.id });
      ok("a work order in ANOTHER organization resolves nothing",
        foreignWo.outcome === "none");
      await db.query(`delete from work_orders where id=$1`, [wo.id]);
      await db.query(`delete from properties where id=$1`, [extra.id]);
    }

    // ── real HTTP ────────────────────────────────────────────────────
    section("REAL HTTP · through the mounted router");
    const express = require("express");
    const smsDouble = {
      enabled: () => true, validateWebhook: () => true,
      sendSms: async (a) => { sends.push(a); return { sid: SID + "OUT" }; },
    };
    const commBoundary = require(path.join(__dirname, "../src/comms/communications_boundary.js"))({
      pool: db, sms: smsDouble });
    const { makeWorkOrderService } = require(path.join(__dirname, "../src/maintenance/work_order_service.js"));
    const { spawnObligationFromEvent, satisfyObligation } = require(path.join(__dirname, "./_engine.js"));
    const { transitionObligation } = require(path.join(__dirname, "../src/shared/obligation_transitions.js"));
    const tenantLinkModule = require(path.join(__dirname, "../src/comms/tenantlink.js"));
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.use("/", tenantLinkModule({
      pool: db, anthropic: { messages: { create: async () => ({ content: [{ text: "{}" }] }) } },
      INGEST_MODEL: "harness", sms: smsDouble, commBoundary,
      workOrderService: makeWorkOrderService({ spawnObligationFromEvent, satisfyObligation, transitionObligation }),
      getAgentService: () => null }));
    server = app.listen(0);
    const port = server.address().port;

    const inbound = (to, from, sid) => new Promise((resolve, reject) => {
      const b = `MessageSid=${encodeURIComponent(sid)}&From=${encodeURIComponent(from)}` +
                `&To=${encodeURIComponent(to)}&Body=${encodeURIComponent("the sink is leaking")}`;
      const r = http.request({ host: "127.0.0.1", port, path: "/communications/inbound-sms", method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(b) } },
        (res) => { let d = ""; res.on("data", (x) => { d += x; }); res.on("end", () => resolve({ status: res.statusCode, body: d })); });
      r.on("error", reject); r.write(b); r.end();
    });

    const vector = async () => {
      const t = (await db.query(
        "select table_name from information_schema.tables where table_schema='public' order by 1")).rows;
      const o = {};
      for (const { table_name } of t) {
        o[table_name] = Number((await db.query(`select count(*)::int n from "${table_name}"`)).rows[0].n);
      }
      return o;
    };

    {
      //  HOSTILE: a FULLY RESOLVABLE staff member texts a PROPERTY-FACING
      //  line. Before 130 this passed only because staff were unlookupable
      //  here. Now staff ARE resolvable — and the ceiling must still hold.
      const before = await vector();
      const res = await inbound(LINE_PROP_A, PHONE_STAFF_MULTI, SID + "STAFF_ON_PROP");
      const after = await vector();
      ok("HTTP HOSTILE: resolvable staff on a property line — route answers", res.status === 200);

      //  THE PATH MUST HAVE EXECUTED. Without this the next three assertions
      //  are satisfied by a crash.
      ok("HTTP HOSTILE: the sender path RAN — no database error was swallowed",
        dbErrors().length === 0, JSON.stringify(dbErrors().slice(0, 2)));
      //  "FULLY RESOLVABLE" has to be demonstrated, not assumed — it is the
      //  entire premise of the test. resolveInboundSmsContext returns context
      //  and deliberately writes nothing for the RESOLVED case (runInbound
      //  records the event once, downstream), so the proof of resolution is
      //  the context itself, not a row.
      const staffCtx = await commBoundary.resolveInboundSmsContext({
        To: LINE_PROP_A, From: PHONE_STAFF_MULTI, MessageSid: SID + "CTX_PROBE", body: "leak" });
      ok("HTTP HOSTILE: the staff sender is FULLY RESOLVABLE on the property line",
        !!staffCtx.property && !!staffCtx.person && staffCtx.ambiguous === false,
        JSON.stringify({ property: !!staffCtx.property, person: !!staffCtx.person, ambiguous: staffCtx.ambiguous }));
      ok("HTTP HOSTILE: they resolve to the CORRECT property — this is not a lookup failure",
        staffCtx.property.id === propA.id);

      //  ...and having fully resolved, they still get the external ceiling.
      const lineRow = await lines.resolveInboundLine(db, LINE_PROP_A);
      const auth = lines.lineAuthority(lineRow.line);
      ok("HTTP HOSTILE: a fully resolvable STAFF member on a property line gets the EXTERNAL ceiling",
        auth.authorityCeiling === "external" && auth.grantsOperationalAuthority === false);
      ok("HTTP HOSTILE: the property line grants no operational authority regardless of sender",
        auth.permittedAudience === "residents_and_prospects");
      ok("HTTP HOSTILE: no outbound to a staff member on a property line", sends.length === 0);
    }

    {
      //  Staff with MANY assignments texts the OPERATIONS line.
      const before = await vector();
      const res = await inbound(LINE_OPS, PHONE_STAFF_MULTI, SID + "OPS_MULTI");
      const after = await vector();
      ok("HTTP: operations line answers the provider", res.status === 200);
      ok("HTTP HOSTILE: multi-assignment staff on the ops line writes NOTHING",
        JSON.stringify(before) === JSON.stringify(after),
        `${JSON.stringify(before)} vs ${JSON.stringify(after)}`);
      ok("HTTP HOSTILE: no property-scoped record was created",
        Number((await db.query("select count(*)::int n from comm_events")).rows[0].n) === 0);
      ok("HTTP: no outbound sent from the operations line (inbound-only)", sends.length === 0);
    }

    {
      //  A resident texting the operations line gains nothing.
      const before = await vector();
      await inbound(LINE_OPS, PHONE_RESIDENT, SID + "OPS_RESIDENT");
      const after = await vector();
      ok("HTTP HOSTILE: a resident on the operations line writes NOTHING",
        JSON.stringify(before) === JSON.stringify(after));
    }

    {
      //  A suspended line, over HTTP.
      const before = await vector();
      await inbound(LINE_FREE, PHONE_RESIDENT, SID + "INACTIVE");
      const after = await vector();
      ok("HTTP: an inactive line writes NOTHING",
        JSON.stringify(before) === JSON.stringify(after));
    }

    section("SAFETY");
    {
      ok("no real SMS: zero sends attempted across the entire run", sends.length === 0, JSON.stringify(sends));
      const all = (await db.query(
        `select e164 from communication_lines union select sms_number from properties where sms_number is not null`)).rows;
      ok("every configured number is in the harness-reserved +1 555 01xx range",
        all.every((r) => /^\+1555010\d{4}$/.test(r.e164)), JSON.stringify(all.map((r) => r.e164)));
      const sids = (await db.query(`select sms_sid from comm_events where sms_sid is not null`)).rows;
      ok("every provider id in the database is harness-minted",
        sids.every((r) => r.sms_sid.startsWith(SID)), JSON.stringify(sids));
      ok("the SMS double never imported a real transport", typeof smsDouble.sendSms === "function" && sends.length === 0);
      ok("RUN VALIDITY: no swallowed database error anywhere in the run",
        dbErrors().length === 0, JSON.stringify(dbErrors().slice(0, 3)));
    }

    code = receipt.complete({ harness: HARNESS, passed, failed, expectedAtLeast: EXPECTED });
  } catch (e) {
    code = receipt.died(HARNESS, e, ran);
  } finally {
    try { if (server) server.close(); } catch { /* closing */ }
    try { if (db) await db.end(); } catch { /* closing */ }
    try { if (admin) { await admin.query(`drop database if exists ${SCRATCH_DB}`); await admin.end(); } }
    catch (e) { console.error("  ! cleanup incomplete: " + e.message); }
  }
  process.exit(code);
})();
