/*  HOSTILE PROOFS — deliberately falsify the leasing execution path.
    Every case asserts a REFUSAL or a preserved fact, never a success.     */
const { pool, q, api, ctx, toPacket, residentSigns } = require("./leasing_e2e_lib.js");

let pass = 0, fail = 0;
const ok   = (n, d) => { pass++; console.log(`  ✓ ${n}${d ? "  — " + d : ""}`); };
const bad  = (n, d) => { fail++; console.log(`  ✗ ${n}  — ${d}`); };
const head = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);

(async () => {
  const C = await ctx();

  // ═══ 1 · PLACEHOLDER CANNOT EXECUTE ═════════════════════════════
  head("1 · a placeholder cannot be executed");
  {
    const P = await toPacket(C, { bed: C.bedB });
    await residentSigns(P.rawTok);
    try {
      await q("update lease_packets set is_placeholder=true where id=$1", [P.packetId]);
      await q("update lease_packets set status='executed' where id=$1", [P.packetId]);
      bad("placeholder refused", "Postgres accepted an executed placeholder");
    } catch (e) {
      ok("placeholder refused at the database", e.message.split("\n")[0].slice(0, 76));
    }
    await q("update lease_packets set is_placeholder=false where id=$1", [P.packetId]);
  }

  // ═══ 2 · NO INSTRUMENT IDENTITY CANNOT EXECUTE ══════════════════
  head("2 · an instrument with no identity cannot be executed");
  {
    const P = await toPacket(C, { bed: C.bedB });
    await residentSigns(P.rawTok);
    try {
      //  184's trigger fires on UPDATE OF instrument_body_sha256, so stripping
      //  the hash from an already-executed packet is refused by Postgres
      //  before any route is involved. That is the stronger proof.
      await q("update lease_packets set instrument_body_sha256=null where id=$1", [P.packetId]);
      const r = await api("POST", `/operator/leasing/lease-packets/${P.packetId}/company-sign`, { token: C.token, key: "e2e-key", body: {} });
      if (r.status >= 400) ok("unhashed instrument refused at the route", `${r.status} ${r.body.error || ""}`);
      else bad("unhashed instrument refused", `accepted with ${r.status}`);
    } catch (e) {
      ok("the hash cannot be stripped from a signed instrument", e.message.split("\n")[0].slice(0, 70));
    }
  }

  // ═══ 3 · RESIDENT MUST SIGN FIRST ═══════════════════════════════
  head("3 · the company cannot execute before the resident");
  {
    const P = await toPacket(C, { bed: C.bedB });   // sent, NOT signed
    const r = await api("POST", `/operator/leasing/lease-packets/${P.packetId}/company-sign`, { token: C.token, key: "e2e-key", body: {} });
    if (r.status === 409 && r.body.error === "resident_has_not_executed") ok("company blocked before resident", r.body.error);
    else bad("company blocked before resident", `${r.status} ${JSON.stringify(r.body).slice(0,90)}`);
  }

  // ═══ 4 · ANOTHER PROPERTY'S OPERATOR ════════════════════════════
  head("4 · an operator at another property cannot sign");
  {
    const P = await toPacket(C, { bed: C.bedB });
    await residentSigns(P.rawTok);
    const other = (await q(`select id from properties where id <> $1 limit 1`, [C.prop])).rows[0];
    if (!other) { ok("skipped — only one property in this database"); }
    else {
      const sess = require("../../src/identity/staff_session_service.js");
      const cli = await pool.connect(); let tok2;
      try {
        await cli.query("begin");
        await cli.query(`insert into property_team_assignments (user_id, property_id, role_title, allowed_modules, active, can_manage_roles)
                         values ($1,$2,'property_manager','{leasing}',true,false) on conflict do nothing`, [C.mike, other.id]);
        const s = await sess.issueStaffSession(cli, { userId: C.mike, propertyId: other.id, purpose: "bootstrap_invite" });
        tok2 = s.session_token || s.token; await cli.query("commit");
      } catch (e) { await cli.query("rollback"); } finally { cli.release(); }
      const r = await api("POST", `/operator/leasing/lease-packets/${P.packetId}/company-sign`, { token: tok2, key: "e2e-key", body: {} });
      if (r.status === 403) ok("cross-property signature refused", r.body.error);
      else bad("cross-property signature refused", `${r.status} ${JSON.stringify(r.body).slice(0,90)}`);
    }
  }

  // ═══ 5 · NO SESSION AT ALL ══════════════════════════════════════
  head("5 · the company signature requires an authenticated human");
  {
    const P = await toPacket(C, { bed: C.bedB });
    await residentSigns(P.rawTok);
    const r = await api("POST", `/operator/leasing/lease-packets/${P.packetId}/company-sign`, { key: "e2e-key", body: {} });
    if (r.status === 401) ok("anonymous company signature refused", r.body.error);
    else bad("anonymous company signature refused", `${r.status} ${JSON.stringify(r.body).slice(0,90)}`);
  }

  // ═══ 6 · SIGNED TRUTH WINS OVER LATER ECONOMICS ═════════════════
  head("6 · terms re-confirmed after signing — signed truth governs");
  {
    const P = await toPacket(C, { bed: C.bedB, rent: 1025 });
    await residentSigns(P.rawTok);
    //  The office confirms DIFFERENT proposed terms after the resident has
    //  already signed the instrument. The executed lease must record what
    //  was signed, never what was confirmed afterwards.
    const pt2 = await api("POST", `/operator/leasing/applications/${P.appId}/proposed-terms`, { token: C.token, key: "e2e-key", body: {
      rent: 2500, security_deposit: 2500, lease_start_date: "2026-09-01", lease_end_date: "2027-08-31",
      concession_status: "none", idempotency_key: "h2-" + P.appId }});
    const r = await api("POST", `/operator/leasing/lease-packets/${P.packetId}/company-sign`, { token: C.token, key: "e2e-key", body: {} });
    const lid = r.body && r.body.tenancy && r.body.tenancy.lease_id;
    const rec = (await q("select rent from executed_lease_records where source_lease_packet_id=$1", [P.packetId])).rows[0];
    if (rec && Number(rec.rent) === 1025) {
      const l = lid ? (await q("select rent from leases where id=$1", [lid])).rows[0] : null;
      ok("the executed record carries the SIGNED rent",
         `signed 1025 · re-confirmed 2500 (post-terms ${pt2.status}) · record ${rec.rent}${l ? ` · lease ${l.rent}` : " · activation " + (r.body.activation_status || "?")}`);
    } else bad("signed rent governs", `record rent ${rec && rec.rent} · ${JSON.stringify(r.body).slice(0,120)}`);
  }

  // ═══ 7 · REPLAY CONVERGES ═══════════════════════════════════════
  head("7 · replay converges — no duplicate execution or tenancy");
  {
    const before = (await q("select count(*)::int n from leases where property_id=$1", [C.prop])).rows[0].n;
    const pkt = (await q(`select id, application_id from lease_packets where status='executed'
                           and property_id=$1 order by updated_at desc limit 1`, [C.prop])).rows[0];
    const r = await api("POST", `/operator/leasing/lease-packets/${pkt.id}/company-sign`, { token: C.token, key: "e2e-key", body: {} });
    const after = (await q("select count(*)::int n from leases where property_id=$1", [C.prop])).rows[0].n;
    const recs = (await q("select count(*)::int n from executed_lease_records where source_lease_packet_id=$1", [pkt.id])).rows[0].n;
    if (r.status >= 400 && after === before && recs === 1) ok("replay refused, nothing duplicated", `${r.status} ${r.body.error || ""} · leases ${before}→${after} · records ${recs}`);
    else bad("replay converges", `status ${r.status} · leases ${before}→${after} · records ${recs}`);
  }

  // ═══ 8 · OCCUPIED BED — EVIDENCE SURVIVES, TENANCY DOES NOT ═════
  head("8 · a competing lease on an occupied bed blocks, evidence stands");
  {
    const leasesBefore = (await q("select count(*)::int n from leases where property_id=$1", [C.prop])).rows[0].n;
    const P = await toPacket(C, { bed: C.bedB });     // bedB already leased above
    await residentSigns(P.rawTok);
    const r = await api("POST", `/operator/leasing/lease-packets/${P.packetId}/company-sign`, { token: C.token, key: "e2e-key", body: {} });
    const leasesAfter = (await q("select count(*)::int n from leases where property_id=$1", [C.prop])).rows[0].n;
    const rec = (await q("select id from executed_lease_records where source_lease_packet_id=$1", [P.packetId])).rows[0];
    const blocked = r.body && r.body.activation_status === "blocked";
    if (blocked && rec && leasesAfter === leasesBefore) {
      ok("blocked, and the executed lease still stands", `${(r.body.blockers||[]).map(b=>b.code).join(",")} · leases unchanged (${leasesAfter}) · record kept`);
    } else bad("blocked admission preserves evidence", `blocked=${blocked} record=${!!rec} leases ${leasesBefore}→${leasesAfter}`);
  }

  // ═══ 9 · A SUPERSEDED PACKET CANNOT EXECUTE ═════════════════════
  head("9 · a superseded packet cannot be executed");
  {
    const P = await toPacket(C, { bed: C.bedA });
    // regenerate → new version supersedes the sent one
    //  Regeneration of an ISSUED packet is refused unless the caller asks for
    //  a governed new version — the existing mechanism, not a bypass.
    const re = await api("POST", `/operator/leasing/applications/${P.appId}/lease-packet`, { token: C.token, key: "e2e-key", body: { create_new_version: true } });
    const v2 = re.body.packet && re.body.packet.id;
    const old = (await q("select status, superseded_at from lease_packets where id=$1", [P.packetId])).rows[0];
    if (v2 && String(v2) !== String(P.packetId) && old.superseded_at) {
      const oldRead = await api("GET", `/t/lease/${P.rawTok}/data`);
      if (oldRead.status === 404) ok("superseded resident link cannot read the old packet", oldRead.status);
      else bad("superseded resident read refused", `accepted ${oldRead.status}`);

      const oldSubmit = await api("POST", `/t/lease/${P.rawTok}/submit`, { body: {} });
      if (oldSubmit.status === 404) ok("superseded resident link cannot submit the old packet", oldSubmit.status);
      else bad("superseded resident submit refused", `accepted ${oldSubmit.status}`);

      const r = await api("POST", `/operator/leasing/lease-packets/${P.packetId}/company-sign`, { token: C.token, key: "e2e-key", body: {} });
      if (r.status >= 400) ok("superseded packet refused", `${r.status} ${r.body.error || ""}`);
      else bad("superseded packet refused", `accepted ${r.status}`);
    } else bad("supersession happened", `v2=${v2} superseded_at=${old && old.superseded_at}`);
  }

  // ═══ 10 · EXACTLY ONE TENANCY ANCHOR PER CLEAN ADMISSION ════════
  head("10 · a clean admission produces exactly one tenancy anchor");
  {
    const rows = (await q(`select application_id, count(*)::int n from leases
                            where property_id=$1 group by application_id having count(*) > 1`, [C.prop])).rows;
    if (!rows.length) ok("no application carries more than one lease");
    else bad("one anchor per application", JSON.stringify(rows));
  }

  console.log(`\n══════════════════════════════════════════════════════════════`);
  console.log(`  HOSTILE PROOFS: ${pass} passed, ${fail} failed`);
  console.log(`══════════════════════════════════════════════════════════════`);
  await pool.end();
  process.exit(fail ? 2 : 0);
})().catch(async (e) => { console.log("\nDIED: " + e.stack); try { await pool.end(); } catch (_) {} process.exit(1); });
