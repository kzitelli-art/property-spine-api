// facts-seed.js — ONE-TIME seed of the REAL Solo policy facts onto the DEMO property.
//
// WHAT THIS IS: the demo shortcut for operating-onboarding's fact layer. In real
// onboarding, Spine reads a property's policy source (here: Katie's "2026 Field Guide /
// Solo Handbook"), PROPOSES structured facts, and an operator CONFIRMS each through the
// surface. This seed hand-does that confirm step once — the values below are pulled
// verbatim from the handbook, so they are verified truth, not invented. They attach to
// the synthetic DEMO property the agent is actually using (NOT the real Solo property in
// Neon — that join happens later). Operators can edit/retire any of these through the
// live operator surface afterward.
//
// SOURCES (all under SharePoint "4233 Chestnut (SOLO)"):
//   • 01. Training & Resources / 2026 Field Guide.pdf                        (original six facts)
//   • 00. All Templates / 03. Move-Ins / 03. SOLO Move-In Guide.pdf          (amenities, rent schedule,
//     insurance, prohibited items, noise, contacts)
//   • 00. All Templates / 07. Resident Resources / Community Policies.pdf    (fobs/keys/lockouts, guests)
//   • 00. All Templates / 02. Letter Templates / Welcome Letter (per-unit PDFs; standardized fields only)
//   • 01. Training & Resources / 02. Leasing Process / SOPs (lead mgmt; application & screening)
// Values with source conflicts are NOT seeded here — they are held in SOLO_FACTS_PACK.md
// for Katie to resolve first (honest blank beats confident wrong).
//
// Mounted under /demo/ (fail-closed on DEMO_MODE, like the other demo doors). Idempotent:
// re-running retires the prior active fact of each key and writes the current one, so it
// never duplicates. Deps: { pool }.

module.exports = function factsSeedModule(deps) {
  const { pool } = deps;
  if (!pool) throw new Error("facts-seed requires { pool }");
  const router = require("express").Router();

  const DEMO_MODE = String(process.env.DEMO_MODE || "").toLowerCase() === "true";
  const DEMO_PROP_NAME = "Property Spine Demo Building";
  const DEMO_MGR_EMAIL = "demo-manager@propertyspine.internal";
  const SOURCE = "management_policy"; // the handbook is a management policy document

  const CATEGORY_FOR = {
    pet_policy: "pets", parking_rules: "parking", tour_window: "tours", fee_policy: "fees",
    required_documents: "documents", office_contact: "routing", communication_instructions: "routing",
    // July 2026 expansion — sourced from Katie's SharePoint library (see SOLO_FACTS_PACK.md
    // for the per-fact source receipts): Move-In Guide, Welcome Letter, Community Policies
    // addendum, and the Leasing SOPs.
    utilities_policy: "utilities", renters_insurance: "insurance", rent_payment_policy: "rent",
    move_in_process: "movein", amenities_list: "amenities", noise_policy: "policies",
    guest_policy: "policies", building_restrictions: "policies", entry_access: "fees",
    current_concession: "rent", pricing_premiums: "rent",
  };

  // The REAL Solo facts, verbatim numbers from the 2026 Field Guide. Written as the
  // agent will speak them — plain, accurate, no invented detail.
  const FACTS = [
    {
      fact_key: "pet_policy",
      rendered_text:
        "Pets are welcome. There is a one-time pet fee of $300 and pet rent of $30/month. " +
        "The building is pet-friendly with a rooftop dog run.",
    },
    {
      fact_key: "parking_rules",
      rendered_text:
        "Garage parking is $300/month for an assigned spot (a waitlist may apply). Free bike " +
        "storage racks are available in the garage. There is no free street parking nearby.",
    },
    {
      fact_key: "fee_policy",
      rendered_text:
        "Move-in fees: $50 application fee, $250 amenity fee ($150 at renewal), a $99 admin fee " +
        "per unit (at move-in and renewal), and a security deposit of $1,000 (or up to one month's " +
        "rent, subject to conditions). The security deposit secures your unit and is due within 72 hours " +
        "of approval to hold it. Wifi (Flume) is $40/month. Renter's insurance can be your own " +
        "policy or $15/month through the building. Parking is $300/month; pet fee $300 one-time plus " +
        "$30/month pet rent. All electric building — residents cover electric, water/sewer, and internet " +
        "unless on an all-inclusive furnished package.",
    },
    {
      fact_key: "tour_window",
      rendered_text:
        "Tours start in the lobby and cover the 7th-floor amenities, the rooftop, and model unit #214 " +
        "on the 2nd floor. To set one up, the leasing office arranges a day and time that works for you.",
    },
    {
      fact_key: "required_documents",
      rendered_text:
        "Applications are screened on credit history, criminal background, eviction records, and income, " +
        "with a decision typically in 24–48 hours. You'll need a government-issued photo ID plus one form " +
        "of income verification: your three most recent bank statements, pay stubs from the last three " +
        "months, a signed employment offer letter, or your most recent tax returns. International " +
        "students provide an I-20 and three months of bank statements. If a denial happens, additional " +
        "documents or a guarantor may be an option.",
    },
    {
      fact_key: "office_contact",
      rendered_text:
        "Solo on Chestnut is at 4233 Chestnut Street, Philadelphia, PA 19104. The leasing office handles " +
        "tours, applications, and move-in scheduling — reach them at sololeasing@onefivecap.com or " +
        "(215) 359-1082. Office hours are Monday–Friday, 9:00 AM–4:30 PM ET.",
    },

    // ── July 2026 expansion: prospect-facing facts from Katie's library ──
    {
      fact_key: "utilities_policy",
      rendered_text:
        "The building is all-electric. Water, sewer, wifi, and electricity are billed monthly through " +
        "Conservice, the third-party utility provider — charges are split among roommates and appear on " +
        "the resident portal. Wifi is through FLUME Internet: 1GB service at $40/month, billed on the " +
        "portal. Furnished all-inclusive packages cover utilities.",
    },
    {
      fact_key: "renters_insurance",
      rendered_text:
        "Proof of renter's insurance is required before move-in, with at least $100,000 in liability " +
        "coverage, effective on or before your move-in date. All adults on the lease must be on the same " +
        "policy, or each carry their own meeting the minimum. '4233 Chestnut LLC' must be named as an " +
        "additional interested party. If you'd rather not shop for a policy, coverage is available through " +
        "the building for $15/month.",
    },
    {
      fact_key: "rent_payment_policy",
      rendered_text:
        "Rent is due on the 1st of each month, with a courtesy grace period through the 5th. If payment " +
        "isn't received by end of day on the 5th, a 10% late fee applies to any unpaid base rent. Payments " +
        "are electronic through the resident portal at solochestnut.com (e-check, credit, or debit), " +
        "one-time or recurring. If you're using financial aid, rent is still paid directly to Solo on the " +
        "portal — the building isn't affiliated with any school.",
    },
    {
      fact_key: "move_in_process",
      rendered_text:
        "Move-ins happen during business hours, 9:00 AM–5:00 PM — check in at the leasing office first " +
        "with a government-issued photo ID to get your keys. All move-in charges must be paid in full at " +
        "least three weeks before your move-in date (the office confirms exact timing at lease signing), " +
        "and proof of renter's insurance is required before keys are released. If you can't arrive during " +
        "business hours, coordinate an alternative check-in with the team in advance.",
    },
    {
      fact_key: "amenities_list",
      rendered_text:
        "Amenities by floor: gym and golf simulator on 2, study lounges on 3 and 5, ping-pong lounges on " +
        "4 and 6, and the big 7th-floor amenity level with a co-working lounge, game room, two TV lounges, " +
        "and a study lounge. The rooftop has seating areas and the pet run. Ground floor has package " +
        "lockers, the mail room, and the parking garage.",
    },
    {
      fact_key: "noise_policy",
      rendered_text:
        "Quiet hours follow Philadelphia's noise curfew: 9:00 PM–8:00 AM Sunday through Thursday, and " +
        "11:00 PM–8:00 AM Friday and Saturday. Noise should stay at a respectful volume at all times, and " +
        "residents are responsible for their guests.",
    },
    {
      fact_key: "guest_policy",
      rendered_text:
        "Guests are welcome. In the amenity spaces, residents may bring up to two guests, and guests must " +
        "be accompanied at all times. Guest parking is in designated guest spaces.",
    },
    // ── July 2026 pricing sheet ────────────────────────────────────────────
    // Source: 03. Leasing & Marketing / "Current Pricing & Specials July 2026.pdf".
    // Dated the current month and titled "Current", so it is the rent-and-
    // concession authority. ONLY the unambiguous, single-source values are
    // seeded here. The per-unit-type PRICES are deliberately NOT seeded: they
    // conflict with live `units` rows (the sheet says a studio is $1,450-1,600;
    // unit 530 quoted $1,687 to a live prospect), and unit truth is read LIVE
    // from units by design. That conflict is logged in docs/SOLO_FACTS_PACK.md
    // for an owner to resolve, per this file's own rule.
    {
      fact_key: "current_concession",
      rendered_text:
        "Current special: one month free on a one-year lease that expires in July 2027. Quote the gross " +
        "rent and then say what it works out to with the free month applied, so the net number is never " +
        "a surprise. Concessions change month to month, so never state one that isn't in these facts.",
    },
    // Matterport 3D tours. FLOOR-PLAN media, never unit media: the tour shows
    // the LAYOUT, not the specific apartment someone would lease. Sending one
    // as "here's your apartment" is the media misrepresentation docs/AI_VOICE.md
    // §9 exists to prevent. Only links VERIFIED to belong to this property and
    // this layout are listed; the rest are held in docs/SOLO_FACTS_PACK.md §8.
    {
      fact_key: "virtual_tours",
      rendered_text:
        "3D walkthroughs, one per layout. " +
        "Studio: https://my.matterport.com/show/?m=H5qs9j6vYc5 . " +
        "One bedroom: https://my.matterport.com/show/?m=CbvpwiPGRah . " +
        "Furnished model one bedroom: https://my.matterport.com/show/?m=CVU7qPMehm9 . " +
        "One bedroom with den: https://my.matterport.com/show/?m=QmzDAeTLUmK . " +
        "Three bedroom, two bath: https://my.matterport.com/show/?m=tBSRwYtiTMU . " +
        "Send the one matching the layout they're asking about, when someone wants to see a unit, is " +
        "deciding from out of town, or can't make a tour time. Always describe it as the LAYOUT, never " +
        "their specific apartment: say it's the same floor plan, never 'here's your unit'. The three " +
        "bedroom tour was filmed inside a real occupied-style apartment, so be especially careful not to " +
        "imply it is the one they would get. THERE IS NO TWO-BEDROOM TOUR: if someone asks about the " +
        "two bedroom, do not send another layout as a substitute and do not imply a tour exists. Offer " +
        "the in-person or live video option instead. Live video tours over FaceTime or WhatsApp are " +
        "available Monday to Friday, 9:00 AM to 4:30 PM.",
    },
    {
      fact_key: "pricing_premiums",
      rendered_text:
        "Unit pricing carries location premiums on top of the base price for the layout: $100 more on the " +
        "7th floor, $50 more on the 6th floor, and $50 more for odd-numbered units.",
    },
    {
      fact_key: "building_restrictions",
      rendered_text:
        "The building is smoke-free — cigarettes, vapes, hookahs, and e-cigarettes included. Candles, " +
        "incense, electric heaters, hot plates, air fryers, and grills aren't permitted for fire safety. " +
        "Alcohol isn't permitted for residents under 21.",
    },
    {
      fact_key: "entry_access",
      rendered_text:
        "Each occupant gets one access fob; additional or replacement fobs are $75 each, replacement keys " +
        "are $25, and after-hours lockout service is $25. During office hours the team can help with " +
        "lockouts with valid ID.",
    },
  ];

  router.post("/demo/seed-solo-facts", async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!DEMO_MODE) return res.status(403).json({ error: "Disabled. (Demo-only seed.)" });

    const client = await pool.connect();
    try {
      await client.query("begin");

      const prop = (await client.query(
        "select id from properties where name=$1 order by created_at asc limit 1",
        [DEMO_PROP_NAME]
      )).rows[0];
      if (!prop) throw new Error("No demo property yet — start the demo first.");

      const mgr = (await client.query("select id from users where email=$1 limit 1", [DEMO_MGR_EMAIL])).rows[0]
        || (await client.query("select id from users where role='leasing_manager'::role_name order by created_at asc limit 1")).rows[0];
      const approvedBy = mgr ? mgr.id : null;

      const written = [];
      for (const f of FACTS) {
        // one-active-per-key: retire any existing active fact of this key (property-wide)
        await client.query(
          "update agent_facts set status='retired' where property_id=$1 and fact_key=$2 and status='active' and space_id is null",
          [prop.id, f.fact_key]
        );
        const row = (await client.query(
          `insert into agent_facts
             (property_id, space_id, fact_key, category, rendered_text, source_type, confirmed_at, status, approved_by_user_id)
           values ($1, null, $2, $3, $4, $5, now(), 'active', $6) returning id, fact_key`,
          [prop.id, f.fact_key, CATEGORY_FOR[f.fact_key], f.rendered_text, SOURCE, approvedBy]
        )).rows[0];
        written.push(row.fact_key);
      }

      await client.query("commit");
      return res.json({ ok: true, property_id: prop.id, seeded: written, source: "2026 Field Guide / Solo Handbook" });
    } catch (e) {
      await client.query("rollback");
      return res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  return router;
};
