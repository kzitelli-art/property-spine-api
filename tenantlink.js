// ════════════════════════════════════════════════════════════════════
//  TENANT LINK MODULE — tenantlink.js  (Phase 1 of the building text line)
//
//  The product sentence: tenants text their building; the system turns
//  messages into the right operating action. PHASE 1 IS ONLY THE
//  CONNECTION — link-only pilot, no SMS vendor:
//
//    Manager side:
//      GET  /properties/:propertyId/tenant-communications  — connection board
//      POST /occupants/:personId/phone                     — save/normalize phone
//      POST /occupants/:personId/invite                    — create setup link
//
//    Tenant side:
//      GET  /t/setup/:token        — the tenant-facing PAGE (served HTML)
//      GET  /tenant/setup/:token   — setup state (JSON behind the page)
//      POST /tenant/setup/verify   — link-only verification: typed phone must
//                                    match the phone on file. No OTP without a
//                                    vendor; when Twilio lands, the code step
//                                    slots in between these two routes.
//      GET  /tenant/me             — session-scoped self view (own data ONLY)
//
//  Rules carried in code, not comments:
//    • Phone is identity. No usernames, no passwords.
//    • Verification never exposes the phone on file (masked at most).
//    • 5 failed matches revokes the link (failed_attempts guard).
//    • Resending supersedes the old active link.
//    • Invite creates the conversation — the invite IS message #1.
//    • /tenant/me scopes by session only. There is no way to pass a
//      person_id; another tenant's data is unreachable by construction.
//    • Plain receipts everywhere.
// ════════════════════════════════════════════════════════════════════

const express = require("express");
const crypto = require("crypto");

module.exports = function tenantLinkModule({ pool }) {
  const router = express.Router();

  // ── helpers ──────────────────────────────────────────────────────────
  function normalizePhone(raw) {
    if (!raw) return null;
    const d = String(raw).replace(/\D/g, "");
    if (d.length === 10) return "+1" + d;
    if (d.length === 11 && d[0] === "1") return "+" + d;
    return null; // not a US number we can normalize — reject honestly
  }
  function maskPhone(e164) {
    if (!e164 || e164.length < 4) return "***";
    const last4 = e164.slice(-4);
    return `(***) ***-${last4}`;
  }
  const newToken = () => crypto.randomBytes(18).toString("base64url");
  const firstName = (n) => (n || "").trim().split(/\s+/)[0] || "there";

  // Active lease + place for a person at a property (or any property).
  async function placeOf(personId, propertyId) {
    const params = [personId];
    let where = `l.lease_status = 'active' and $1 = any(l.tenant_ids)`;
    if (propertyId) { params.push(propertyId); where += ` and l.property_id = $2`; }
    const r = await pool.query(
      `select l.id as lease_id, l.property_id, l.rent, l.balance,
              l.start_date, l.end_date,
              s.id as space_id, s.space_label,
              u.id as unit_id, u.unit_number,
              p.name as property_name, p.address as property_address,
              p.leasing_basis
         from leases l
         join spaces s on s.id = l.space_id
         join units u  on u.id = s.unit_id
         join properties p on p.id = l.property_id
        where ${where}
        order by l.start_date desc nulls last
        limit 1`, params);
    return r.rows[0] || null;
  }

  // ════════════════════════════════════════════════════════════════════
  //  1. MANAGER CONNECTION BOARD
  // ════════════════════════════════════════════════════════════════════
  router.get("/properties/:propertyId/tenant-communications", async (req, res) => {
    try {
      const { propertyId } = req.params;
      const propQ = await pool.query(
        `select id, name, address, leasing_basis from properties where id = $1`,
        [propertyId]);
      if (!propQ.rows.length) {
        return res.status(404).json({ receipt: "No property with that id." });
      }
      const prop = propQ.rows[0];

      // Occupants = persons on active leases at this property.
      const occQ = await pool.query(
        `select per.id as person_id, per.name, per.phone,
                u.unit_number, s.space_label, l.id as lease_id
           from leases l
           join spaces s on s.id = l.space_id
           join units u  on u.id = s.unit_id
           cross join lateral unnest(l.tenant_ids) as t(pid)
           join persons per on per.id = t.pid
          where l.property_id = $1 and l.lease_status = 'active'
          order by u.unit_number, per.name`, [propertyId]);

      const personIds = occQ.rows.map(r => r.person_id);
      let invites = [], sessions = [];
      if (personIds.length) {
        invites = (await pool.query(
          `select distinct on (person_id) person_id, status, expires_at,
                  created_at, conversation_id
             from tenant_invites
            where property_id = $1 and person_id = any($2)
            order by person_id, created_at desc`,
          [propertyId, personIds])).rows;
        sessions = (await pool.query(
          `select distinct person_id from tenant_sessions
            where property_id = $1 and person_id = any($2)
              and revoked = false and expires_at > now()`,
          [propertyId, personIds])).rows;
      }
      const inviteBy = Object.fromEntries(invites.map(i => [i.person_id, i]));
      const liveSession = new Set(sessions.map(s => s.person_id));

      const tenants = occQ.rows.map(r => {
        const inv = inviteBy[r.person_id];
        let status;
        if (liveSession.has(r.person_id) || (inv && inv.status === "used")) status = "connected";
        else if (!r.phone) status = "missing_phone";
        else if (!inv || ["revoked", "superseded"].includes(inv.status)) status = "not_invited";
        else if (inv.status === "active" && new Date(inv.expires_at) < new Date()) status = "expired";
        else if (inv.status === "active") status = "invited";
        else status = "not_invited";
        return {
          person_id: r.person_id, name: r.name, phone: r.phone,
          unit_number: r.unit_number, space_label: r.space_label,
          lease_id: r.lease_id, connection_status: status,
          last_invited_at: inv ? inv.created_at : null,
          conversation_id: inv ? inv.conversation_id : null,
        };
      });

      const count = (s) => tenants.filter(t => t.connection_status === s).length;
      const summary = {
        total_tenants: tenants.length,
        connected: count("connected"),
        invited: count("invited"),
        missing_phone: count("missing_phone"),
        not_invited: count("not_invited"),
        expired: count("expired"),
      };

      // Next action: fix phones first (an invite can't verify without one),
      // then invite, then re-invite expired.
      let next = { action: "none", person_id: null, label: "All occupants are connected." };
      const pick = (s, action, verb) => {
        const t = tenants.find(x => x.connection_status === s);
        if (t && next.action === "none") {
          next = { action, person_id: t.person_id, label: `${verb} ${firstName(t.name)} (unit ${t.unit_number}).` };
        }
      };
      pick("missing_phone", "add_phone", "Add a phone for");
      pick("not_invited", "send_invite", "Send a setup link to");
      pick("expired", "send_invite", "Send a fresh link to");
      if (!tenants.length) next = { action: "none", person_id: null, label: "No occupants on active leases yet — link tenants to leases first." };

      res.json({
        receipt: tenants.length
          ? `${summary.connected} of ${summary.total_tenants} occupants connected at ${prop.name || prop.address}.`
          : `No occupants on active leases at ${prop.name || prop.address}.`,
        property: { id: prop.id, name: prop.name, address: prop.address, leasing_basis: prop.leasing_basis },
        summary, next, tenants,
      });
    } catch (e) {
      console.error("tenant-communications:", e);
      res.status(500).json({ receipt: "Could not load the connection board.", error: e.message });
    }
  });

  // ════════════════════════════════════════════════════════════════════
  //  2. SAVE / FIX PHONE
  // ════════════════════════════════════════════════════════════════════
  router.post("/occupants/:personId/phone", async (req, res) => {
    try {
      const { personId } = req.params;
      const phone = normalizePhone(req.body && req.body.phone);
      if (!phone) {
        return res.status(400).json({
          receipt: "That doesn't look like a valid US phone number. Use 10 digits, like 215-555-1212.",
        });
      }
      const r = await pool.query(
        `update persons set phone = $1, updated_at = now()
          where id = $2 returning id, name`, [phone, personId]);
      if (!r.rows.length) return res.status(404).json({ receipt: "No person with that id." });
      const place = await placeOf(personId, null);
      res.json({
        receipt: `Phone saved for ${firstName(r.rows[0].name)}${place ? ` in unit ${place.unit_number}` : ""}.`,
        person_id: personId, phone,
      });
    } catch (e) {
      console.error("occupant phone:", e);
      res.status(500).json({ receipt: "Could not save the phone.", error: e.message });
    }
  });

  // ════════════════════════════════════════════════════════════════════
  //  3. CREATE SETUP LINK (supersedes old active links; opens the thread)
  // ════════════════════════════════════════════════════════════════════
  router.post("/occupants/:personId/invite", async (req, res) => {
    try {
      const { personId } = req.params;
      const propertyId = req.body && req.body.property_id;
      if (!propertyId) return res.status(400).json({ receipt: "property_id is required." });

      const perQ = await pool.query(`select id, name, phone from persons where id = $1`, [personId]);
      if (!perQ.rows.length) return res.status(404).json({ receipt: "No person with that id." });
      const person = perQ.rows[0];
      if (!person.phone) {
        return res.status(409).json({
          receipt: `Add a phone for ${firstName(person.name)} first — the setup link verifies against it.`,
          fix: "add_phone",
        });
      }
      const place = await placeOf(personId, propertyId);
      if (!place) {
        return res.status(409).json({
          receipt: `${firstName(person.name)} isn't on an active lease at this property — link them to a lease first.`,
        });
      }

      // One conversation per (property, person). The invite is message #1.
      const convo = (await pool.query(
        `insert into conversations (property_id, person_id, unit_id, lease_id)
         values ($1, $2, $3, $4)
         on conflict (property_id, person_id)
         do update set unit_id = excluded.unit_id, lease_id = excluded.lease_id
         returning id`,
        [propertyId, personId, place.unit_id, place.lease_id])).rows[0];

      // Supersede any still-active links — never two live links for one person.
      const token = newToken();
      const inv = (await pool.query(
        `insert into tenant_invites (person_id, property_id, conversation_id, token, expires_at)
         values ($1, $2, $3, $4, now() + interval '7 days')
         returning id, expires_at`,
        [personId, propertyId, convo.id, token])).rows[0];
      await pool.query(
        `update tenant_invites
            set status = 'superseded', superseded_by = $1
          where person_id = $2 and property_id = $3
            and status = 'active' and id <> $1`,
        [inv.id, personId, propertyId]);

      const base = process.env.APP_BASE_URL || `${req.protocol}://${req.get("host")}`;
      const link = `${base}/t/setup/${token}`;
      const propName = place.property_name || place.property_address || "your building";
      const sms_text =
        `Hi ${firstName(person.name)} — this is the ${propName} tenant line. ` +
        `Save this number for rent, maintenance, and building questions. ` +
        `Set up your secure link here: ${link}`;

      // Message #1 of the official thread.
      const msg = (await pool.query(
        `insert into comm_events (property_id, person_id, unit_id, conversation_id,
                                  channel, direction, body)
         values ($1, $2, $3, $4, 'text', 'outbound', $5)
         returning id`,
        [propertyId, personId, place.unit_id, convo.id, sms_text])).rows[0];
      await pool.query(`update conversations set last_message_at = now() where id = $1`, [convo.id]);

      res.json({
        receipt: `Setup link created for ${firstName(person.name)} in unit ${place.unit_number}. Copy the text below and send it from your phone.`,
        person_id: personId, conversation_id: convo.id, invite_id: inv.id,
        link, sms_text, expires_at: inv.expires_at, first_message_id: msg.id,
      });
    } catch (e) {
      console.error("invite:", e);
      res.status(500).json({ receipt: "Could not create the setup link.", error: e.message });
    }
  });

  // ════════════════════════════════════════════════════════════════════
  //  4. SETUP STATE (JSON behind the tenant page)
  // ════════════════════════════════════════════════════════════════════
  async function loadInvite(token) {
    const r = await pool.query(
      `select i.*, per.name as person_name, per.phone as person_phone,
              p.name as property_name, p.address as property_address
         from tenant_invites i
         join persons per on per.id = i.person_id
         join properties p on p.id = i.property_id
        where i.token = $1`, [token]);
    return r.rows[0] || null;
  }
  function inviteState(inv) {
    if (!inv) return "invalid";
    if (inv.status === "used") return "already_verified";
    if (inv.status === "revoked" || inv.status === "superseded") return "revoked";
    if (inv.status === "active" && new Date(inv.expires_at) < new Date()) return "expired";
    return "valid";
  }

  router.get("/tenant/setup/:token", async (req, res) => {
    try {
      const inv = await loadInvite(req.params.token);
      const status = inviteState(inv);
      if (status !== "valid" && status !== "already_verified") {
        return res.json({
          status,
          message: status === "invalid"
            ? "This link isn't recognized."
            : "This link expired or was replaced. Ask your manager for a fresh link.",
        });
      }
      const place = await placeOf(inv.person_id, inv.property_id);
      res.json({
        status,
        property: { name: inv.property_name || inv.property_address },
        tenant: { first_name: firstName(inv.person_name), unit_number: place ? place.unit_number : null },
        message: status === "already_verified"
          ? "You're already connected. Verify your phone again to open your view."
          : `Confirm your phone to connect to the ${inv.property_name || "building"} tenant line.`,
      });
    } catch (e) {
      console.error("setup state:", e);
      res.status(500).json({ status: "error", message: "Could not load this link." });
    }
  });

  // ════════════════════════════════════════════════════════════════════
  //  5. LINK-ONLY VERIFY — typed phone must match the record
  //     (OTP step slots in here when an SMS vendor lands.)
  // ════════════════════════════════════════════════════════════════════
  router.post("/tenant/setup/verify", async (req, res) => {
    try {
      const { token } = req.body || {};
      const typed = normalizePhone(req.body && req.body.phone);
      const inv = await loadInvite(token);
      const status = inviteState(inv);
      if (status === "invalid") return res.status(404).json({ receipt: "This link isn't recognized." });
      if (status === "expired" || status === "revoked") {
        return res.status(410).json({ receipt: "This link expired or was replaced. Ask your manager for a fresh link." });
      }
      if (!typed) {
        return res.status(400).json({ receipt: "That doesn't look like a valid phone number. Use 10 digits." });
      }
      if (typed !== inv.person_phone) {
        const attempts = inv.failed_attempts + 1;
        if (attempts >= 5) {
          await pool.query(`update tenant_invites set failed_attempts=$1, status='revoked' where id=$2`,
            [attempts, inv.id]);
          return res.status(401).json({ receipt: "Too many attempts — this link is now locked. Ask your manager for a fresh one." });
        }
        await pool.query(`update tenant_invites set failed_attempts=$1 where id=$2`, [attempts, inv.id]);
        return res.status(401).json({ receipt: "That phone does not match this invite." });
      }

      // Match — connect. Mark used (idempotent for already_verified re-entry),
      // issue a 30-day session, log the connection on the thread.
      await pool.query(
        `update tenant_invites set status='used', used_at = coalesce(used_at, now()) where id = $1`,
        [inv.id]);
      const sess = (await pool.query(
        `insert into tenant_sessions (person_id, property_id, token, expires_at)
         values ($1, $2, $3, now() + interval '30 days') returning token`,
        [inv.person_id, inv.property_id, newToken()])).rows[0];
      const place = await placeOf(inv.person_id, inv.property_id);
      await pool.query(
        `insert into comm_events (property_id, person_id, unit_id, conversation_id, channel, direction, body)
         values ($1, $2, $3, $4, 'portal', 'inbound', $5)`,
        [inv.property_id, inv.person_id, place ? place.unit_id : null, inv.conversation_id,
         `${firstName(inv.person_name)} verified their phone and connected.`]);

      res.json({
        receipt: `${firstName(inv.person_name)} is connected to the ${inv.property_name || "building"} tenant line.`,
        session: sess.token,
        tenant: {
          person_id: inv.person_id, property_id: inv.property_id,
          unit_id: place ? place.unit_id : null, lease_id: place ? place.lease_id : null,
          conversation_id: inv.conversation_id,
        },
      });
    } catch (e) {
      console.error("verify:", e);
      res.status(500).json({ receipt: "Verification hit an error. Try again." });
    }
  });

  // ════════════════════════════════════════════════════════════════════
  //  6. TENANT SELF VIEW — session-scoped, own data ONLY
  // ════════════════════════════════════════════════════════════════════
  router.get("/tenant/me", async (req, res) => {
    try {
      const token = req.headers["x-tenant-session"] || req.query.session;
      if (!token) return res.status(401).json({ receipt: "No session. Open your setup link again." });
      const sQ = await pool.query(
        `select * from tenant_sessions
          where token = $1 and revoked = false and expires_at > now()`, [token]);
      if (!sQ.rows.length) return res.status(401).json({ receipt: "Session expired. Open your setup link again." });
      const sess = sQ.rows[0];

      const perQ = await pool.query(`select name, phone from persons where id = $1`, [sess.person_id]);
      const place = await placeOf(sess.person_id, sess.property_id);
      if (!place) return res.status(404).json({ receipt: "No active lease found for your account. Contact your manager." });

      const ledger = (await pool.query(
        `select label, kind, amount, occurred_at from ledger_entries
          where lease_id = $1 order by occurred_at desc limit 10`, [place.lease_id])).rows;
      const workOrders = (await pool.query(
        `select id, title, issue_type, description, status, created_at
           from work_orders
          where person_id = $1 and property_id = $2 and status <> 'complete'
          order by created_at desc`, [sess.person_id, sess.property_id])).rows;

      res.json({
        receipt: `Here's your place, ${firstName(perQ.rows[0].name)}.`,
        tenant: { name: perQ.rows[0].name, phone: maskPhone(perQ.rows[0].phone) },
        property: { name: place.property_name, address: place.property_address },
        place: {
          unit_number: place.unit_number, space_label: place.space_label,
          leasing_basis: place.leasing_basis,
          lease_start: place.start_date, lease_end: place.end_date,
          rent_amount: place.rent == null ? null : Number(place.rent),
        },
        balance: { current_balance: place.balance == null ? null : Number(place.balance), ledger },
        open_work_orders: workOrders,
      });
    } catch (e) {
      console.error("tenant/me:", e);
      res.status(500).json({ receipt: "Could not load your view." });
    }
  });

  // ════════════════════════════════════════════════════════════════════
  //  THE TENANT PAGE — served by the API itself (link-only pilot needs
  //  zero hosting). Brand system: Fraunces + IBM Plex on the dark palette.
  // ════════════════════════════════════════════════════════════════════
  router.get("/t/setup/:token", (req, res) => {
    const token = String(req.params.token).replace(/[^A-Za-z0-9_-]/g, "");
    res.set("Content-Type", "text/html").send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Tenant Line Setup</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap');
:root{--bg:#0e1116;--panel:#161a21;--line:#262c38;--ink:#e7e4dd;--ink-dim:#9aa0ab;--ink-faint:#5f6672;
--accent:#d4a056;--confirmed:#6fae7e;--danger:#c97a6d;}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--ink);font-family:'IBM Plex Sans',sans-serif;line-height:1.5;
display:flex;justify-content:center;padding:28px 16px 60px;-webkit-font-smoothing:antialiased}
.wrap{width:100%;max-width:420px}
.serif{font-family:'Fraunces',serif}.mono{font-family:'IBM Plex Mono',monospace}
.card{background:linear-gradient(180deg,var(--panel),#13171e);border:1px solid var(--line);border-radius:14px;padding:20px;margin-bottom:14px}
.kicker{font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--accent);margin-bottom:6px}
h1{font-family:'Fraunces',serif;font-size:22px;font-weight:600;margin-bottom:4px}
.sub{color:var(--ink-dim);font-size:14px}
.lbl{display:block;font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-faint);margin:14px 0 6px}
input{width:100%;background:var(--bg);border:1px solid var(--line);color:var(--ink);padding:12px;border-radius:8px;font-size:16px;font-family:inherit;outline:none}
input:focus{border-color:var(--accent)}
.btn{width:100%;margin-top:14px;background:var(--accent);color:#1a1407;border:none;padding:13px;border-radius:8px;font-size:15px;font-weight:600;font-family:inherit;cursor:pointer}
.btn:disabled{opacity:.5}
.receipt{margin-top:12px;font-size:14px;padding:11px 13px;border-radius:8px;border:1px solid var(--line);display:none}
.receipt.ok{display:block;color:var(--confirmed);border-color:#2c4536;background:#1a2a20}
.receipt.bad{display:block;color:var(--danger);border-color:#4a2e29;background:#241a18}
.row{display:flex;justify-content:space-between;gap:10px;padding:9px 0;border-bottom:1px solid #1e232d;font-size:14px}
.row:last-child{border-bottom:none}
.row .k{color:var(--ink-faint);font-family:'IBM Plex Mono',monospace;font-size:12px}
.row .v{text-align:right}
.section{font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:var(--ink-faint);margin:18px 0 8px}
.bal{font-family:'Fraunces',serif;font-size:34px;font-weight:600}
.hidden{display:none}
</style></head><body><div class="wrap">
<div class="kicker">Property Spine · Tenant Line</div>
<div id="loading" class="card"><div class="sub">Loading your link…</div></div>

<div id="setup" class="card hidden">
  <h1 id="su-title" class="serif">Confirm your phone</h1>
  <div class="sub" id="su-msg"></div>
  <label class="lbl">Your mobile number</label>
  <input id="su-phone" type="tel" inputmode="tel" placeholder="215-555-1212" autocomplete="tel"/>
  <button class="btn" id="su-go">Connect</button>
  <div class="receipt" id="su-receipt"></div>
</div>

<div id="dead" class="card hidden">
  <h1 class="serif">This link isn't usable</h1>
  <div class="sub" id="dead-msg"></div>
</div>

<div id="me" class="hidden">
  <div class="card">
    <h1 class="serif" id="me-prop"></h1>
    <div class="sub" id="me-unit"></div>
    <div class="section">Balance</div>
    <div class="bal" id="me-bal"></div>
    <div class="sub" id="me-rent"></div>
    <div class="section">Lease</div>
    <div class="row"><span class="k">start</span><span class="v" id="me-start"></span></div>
    <div class="row"><span class="k">end</span><span class="v" id="me-end"></span></div>
  </div>
  <div class="card">
    <div class="section" style="margin-top:0">Open maintenance</div>
    <div id="me-wos" class="sub"></div>
  </div>
  <div class="card"><div class="sub">Questions, maintenance, rent — your manager has this thread on file. More is coming here soon.</div></div>
</div>

<script>
const TOKEN = ${JSON.stringify(token)};
const $ = id => document.getElementById(id);
const money = v => v==null ? "—" : "$" + Number(v).toLocaleString(undefined,{minimumFractionDigits:2});
const day = v => v ? new Date(v).toLocaleDateString() : "—";
function show(id){["loading","setup","dead","me"].forEach(x=>$(x).classList.add("hidden"));$(id).classList.remove("hidden");}

async function init(){
  try{
    const r = await fetch("/tenant/setup/"+TOKEN); const d = await r.json();
    if(d.status==="valid"||d.status==="already_verified"){
      $("su-title").textContent = "Hi "+(d.tenant&&d.tenant.first_name||"there")+" 👋";
      $("su-msg").textContent = d.message;
      show("setup");
    } else { $("dead-msg").textContent = d.message||"Ask your manager for a fresh link."; show("dead"); }
  }catch(e){ $("dead-msg").textContent="Could not load this link. Check your connection and try again."; show("dead"); }
}
$("su-go").onclick = async ()=>{
  const btn=$("su-go"); btn.disabled=true; btn.textContent="Connecting…";
  const rc=$("su-receipt"); rc.className="receipt";
  try{
    const r = await fetch("/tenant/setup/verify",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({token:TOKEN, phone:$("su-phone").value})});
    const d = await r.json();
    if(r.ok && d.session){ rc.className="receipt ok"; rc.textContent=d.receipt; await loadMe(d.session); }
    else { rc.className="receipt bad"; rc.textContent=d.receipt||"That didn't work."; }
  }catch(e){ rc.className="receipt bad"; rc.textContent="Connection problem — try again."; }
  btn.disabled=false; btn.textContent="Connect";
};
async function loadMe(session){
  const r = await fetch("/tenant/me",{headers:{"x-tenant-session":session}});
  const d = await r.json();
  if(!r.ok){ return; }
  $("me-prop").textContent = d.property.name || d.property.address;
  $("me-unit").textContent = "Unit "+d.place.unit_number + (d.place.leasing_basis==="bed" && d.place.space_label ? " · "+d.place.space_label : "");
  $("me-bal").textContent = money(d.balance.current_balance);
  $("me-rent").textContent = d.place.rent_amount!=null ? "Rent "+money(d.place.rent_amount)+" / month" : "";
  $("me-start").textContent = day(d.place.lease_start);
  $("me-end").textContent = day(d.place.lease_end);
  $("me-wos").innerHTML = d.open_work_orders.length
    ? d.open_work_orders.map(w=>"<div class='row'><span class='v'>"+(w.title||w.issue_type||"request")+"</span><span class='k'>"+w.status+"</span></div>").join("")
    : "No open requests.";
  setTimeout(()=>show("me"), 600);
}
init();
</script></div></body></html>`);
  });

  return router;
};
