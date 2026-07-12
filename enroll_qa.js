// One-off: enroll a person as internal_qa (classification + opted_in consent)
// through the CANONICAL enrollInternalQa operation — not raw SQL.
// Usage (Render shell):
//   node enroll_qa.js <person_id> <property_id> <actor_user_id>
const { Pool } = require("pg");
const commsBoundaryFactory = require("./communications_boundary.js");

const person_id = process.argv[2];
const property_id = process.argv[3];
const actor_user_id = process.argv[4];

if (!person_id || !property_id || !actor_user_id) {
  console.error("usage: node enroll_qa.js <person_id> <property_id> <actor_user_id>");
  process.exit(1);
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const cb = commsBoundaryFactory({ pool, sms: null });
  try {
    const out = await cb.enrollInternalQa({ person_id, property_id, actor_user_id, reason: "QA proof: application SMS send" });
    console.log("ENROLLED:", JSON.stringify(out, null, 2));
  } catch (e) {
    console.error("ENROLL FAILED:", e.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
