// Seeds the E2E fixture into the isolated proof DB and prints a REAL session token.
const { Pool } = require('/home/user/property-spine-api/node_modules/pg');
const svc = require('/home/user/property-spine-api/src/identity/staff_session_service.js');
const pool = new Pool({ connectionString: process.env.HARNESS_DATABASE_URL });
const hrs = n => new Date(Date.now() + n*3600e3).toISOString();
(async () => {
  const TAG = 'e2e-' + Date.now();
  const c = await pool.connect();
  let A, u;
  try {
    await c.query('begin');
    A = (await c.query(`insert into properties (name) values ($1) returning id`, ['E2E Property'])).rows[0].id;
    const B = (await c.query(`insert into properties (name) values ($1) returning id`, ['E2E Other'])).rows[0].id;
    u = (await c.query(`insert into users (name,email,phone,role,is_active,status)
      values ('E2E Operator',$1,$2,'property_manager',true,'active') returning id`,
      //  phone must be unique per run: uq_users_phone_normalized collides on a
      //  second seed, which blocked rerunning the ladder after a rebase.
      [TAG+'@e2e.test', '+1724' + String(Date.now()).slice(-7)])).rows[0].id;
    await c.query(`insert into property_team_assignments
      (property_id,user_id,role_title,scope_type,allowed_modules,primary_for_modules,can_manage_roles,active)
      values ($1,$2,'Operator','property',$3,$3,false,true)`, [A, u, ['leasing','maintenance']]);
    const person = (await c.query(`insert into persons (name,lifecycle_status,source) values ('Dana Reed','prospect','e2e') returning id`)).rows[0].id;
    const ob = (m,label,due,user,pid,person_id) => c.query(
      `insert into obligations (property_id,module,type,label,status,due_at,assigned_user_id,person_id)
       values ($1,$2,'proof',$3,'open',$4,$5,$6)`, [pid||A, m, label, due, user||null, person_id||null]);
    await ob('leasing','Call Dana Reed back — 2 days no response', hrs(-48), null, A, person);
    await ob('maintenance','Work order closeout proof missing', hrs(-26));
    await ob('leasing','Tour feedback not recorded', null);
    await ob('leasing','Lease review due tomorrow', hrs(20));
    await ob('leasing','Follow up on application', hrs(-4));
    await ob('leasing','Renewal notice overdue', hrs(-72));
    await ob('accounting','SHOULD NOT APPEAR — unauthorised module', hrs(-99));
    await ob('leasing','SHOULD NOT APPEAR — other property', hrs(-99), null, B);
    await c.query('commit');
  } catch(e){ await c.query('rollback'); throw e; } finally { c.release(); }
  const cc = await pool.connect();
  await cc.query('begin');
  const s = await svc.issueStaffSession(cc, { userId: u, propertyId: A, purpose: 'sms_otp' });
  await cc.query('commit'); cc.release();
  console.log(JSON.stringify({ token: s.session_token, property_id: A, user_id: u }));
  await pool.end();
})();
