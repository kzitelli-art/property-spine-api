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
// SOURCE: 4233 Chestnut (SOLO) / 01. Training & Resources / 2026 Field Guide.pdf
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
        "Move-in fees: $50 application fee, $300 amenity fee ($250 at renewal), a $99 admin fee " +
        "per unit (at move-in and renewal), and a security deposit of $1,000 (or up to one month's " +
        "rent, subject to conditions). Wifi (Flume) is $40/month. Renter's insurance can be your own " +
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
        "Applications are screened on credit, criminal background, eviction history, and income, with a " +
        "decision typically in 24–48 hours. For income verification we accept 3 months of pay stubs, an " +
        "employment offer letter, tax filings, or an I-20 for student visa holders. A guarantor may be an " +
        "option if needed.",
    },
    {
      fact_key: "office_contact",
      rendered_text:
        "Solo on Chestnut is at 4233 Chestnut Street, Philadelphia. The leasing office handles tours, " +
        "applications, and move-in scheduling; front desk hours vary by day.",
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
