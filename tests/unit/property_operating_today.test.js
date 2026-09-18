// ════════════════════════════════════════════════════════════════════
//  property_operating_today.test.js — "TODAY" IS THE BUILDING'S DAY
//
//  WHAT THIS PROTECTS
//  ------------------
//  The canonical dated reads defaulted an absent as_of with
//
//      new Date().toISOString().slice(0, 10)
//
//  which is the UTC calendar day, and compared dp.as_of against that same
//  UTC day to decide whether a read was "today". Migration 123 had been
//  recording properties.operating_timezone the whole time, and
//  shared/property_timezone.js had been resolving it — the rent roll
//  simply never asked.
//
//  UTC leads America/New_York by 4–5 hours. From roughly 8pm in
//  Philadelphia onward, "today's rent roll" answered for TOMORROW. That
//  is not a cosmetic off-by-one: it lands on lease commencements, lease
//  expirations, notice dates and the 1 August student-housing turnover,
//  which is the single night of the year when the largest number of beds
//  change hands at once.
//
//  It also silently dropped every resident balance, because currentRentRoll
//  renders balances ONLY when the read is today — and after 8pm a read
//  genuinely of today was judged historical.
//
//  NOT A REFUSAL, AND THAT IS DELIBERATE. A property with no configured
//  zone still gets the UTC day. Refusing would take today's rent roll away
//  from every property that has not set one, which is a larger harm than
//  the bug. What changed is that the answer now NAMES its basis, so a read
//  that disagrees with the board at 9pm is answerable.
// ════════════════════════════════════════════════════════════════════
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  ymdInZone, propertyOperatingToday,
} = require("../../src/shared/property_timezone.js");

const root = path.join(__dirname, "..", "..");
let passed = 0;
function test(name, fn) {
  const done = () => { passed += 1; console.log(`PASS ${name}`); };
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      return r.then(done, (e) => {
        console.error(`FAIL ${name}: ${e.stack || e}`); process.exitCode = 1;
      });
    }
    done();
  } catch (error) {
    console.error(`FAIL ${name}: ${error.stack || error}`); process.exitCode = 1;
  }
  return Promise.resolve();
}

//  9:30pm on 1 August in Philadelphia. UTC has already turned over.
const TURNOVER_NIGHT = new Date("2026-08-02T01:30:00Z");
const poolWith = (tz) => ({ query: async () => ({ rows: [{ operating_timezone: tz }] }) });

(async () => {
  await test("the turnover-night instant is two different calendar days", () => {
    assert.equal(ymdInZone(TURNOVER_NIGHT, "UTC"), "2026-08-02");
    assert.equal(ymdInZone(TURNOVER_NIGHT, "America/New_York"), "2026-08-01");
  });

  await test("THE DEFECT, in the old expression's own terms", () => {
    //  This is what every canonical dated read used to do, applied to the
    //  turnover-night instant. No new module involved: the assertion below
    //  holds on any tree, which is what makes it a witness rather than a
    //  restatement of the fix.
    const OLD = TURNOVER_NIGHT.toISOString().slice(0, 10);
    assert.equal(OLD, "2026-08-02");

    //  Philadelphia has not reached 2 August. A leasing agent standing in
    //  the building at 9:30pm on 1 August, asking Spine for today's rent
    //  roll, was shown the day AFTER every 1 August lease commenced.
    assert.notEqual(OLD, ymdInZone(TURNOVER_NIGHT, "America/New_York"));
    assert.equal(ymdInZone(TURNOVER_NIGHT, "America/New_York"), "2026-08-01");
  });

  await test("a configured property gets its own operating day, and says so", async () => {
    const d = await propertyOperatingToday(poolWith("America/New_York"), "p1", TURNOVER_NIGHT);
    assert.deepEqual(d, {
      date: "2026-08-01", basis: "property_local", timezone: "America/New_York",
    });
  });

  await test("an unconfigured property still answers — labelled utc_fallback", () => {
    //  The honest-blank rule cuts both ways: withholding today's rent roll
    //  from a property that never set a zone would be the larger harm.
    return propertyOperatingToday(poolWith(null), "p2", TURNOVER_NIGHT).then((d) => {
      assert.deepEqual(d, { date: "2026-08-02", basis: "utc_fallback", timezone: null });
    });
  });

  await test("a stored zone Intl rejects falls back rather than failing the read", async () => {
    const d = await propertyOperatingToday(poolWith("Mars/Olympus_Mons"), "p3", TURNOVER_NIGHT);
    assert.equal(d.basis, "utc_fallback");
    assert.equal(d.date, "2026-08-02");
  });

  await test("a pool that throws does not take the rent roll down with it", async () => {
    const angry = { query: async () => { throw new Error("connection lost"); } };
    const d = await propertyOperatingToday(angry, "p4", TURNOVER_NIGHT);
    assert.equal(d.basis, "utc_fallback");
  });

  await test("zones behind UTC are handled too, not just ahead", () => {
    //  Same instant, a west-coast building: still 1 August, and the fix must
    //  not silently assume every property is Eastern.
    assert.equal(ymdInZone(TURNOVER_NIGHT, "America/Los_Angeles"), "2026-08-01");
    //  And a zone AHEAD of UTC, where the naive code was accidentally right.
    assert.equal(ymdInZone(TURNOVER_NIGHT, "Europe/Berlin"), "2026-08-02");
  });

  await test("the canonical read actually EXECUTES the resolver, not just mentions it", async () => {
    //  THIS TEST EXISTS BECAUSE THE ONE BELOW WAS NOT ENOUGH.
    //
    //  The source scan below passed for five commits against a
    //  dated_positions.js that called propertyOperatingToday with NOTHING
    //  IMPORTING IT. Every dated read threw ReferenceError on its first
    //  real line, and a test asserting the string was present said so
    //  cheerfully. A source scan proves a string exists; only running the
    //  code proves the code runs.
    //
    //  So: drive the real datedPropertyPositions with a pool that answers
    //  the timezone lookup and then throws a sentinel. Reaching the
    //  sentinel proves control got PAST the call with the binding
    //  resolved. A ReferenceError here is the regression.
    const { datedPropertyPositions } = require("../../src/tenancy/dated_positions.js");
    const SENTINEL = "PAST_THE_TIMEZONE_CALL";
    const pool = {
      query: async (text) => {
        if (/operating_timezone/.test(text)) return { rows: [{ operating_timezone: "America/New_York" }] };
        throw new Error(SENTINEL);
      },
    };
    let caught = null;
    try { await datedPropertyPositions(pool, { property_id: "p1" }); }
    catch (e) { caught = e; }
    assert.ok(caught, "the stub pool must stop the read somewhere");
    assert.ok(!/is not defined/.test(caught.message),
      `datedPropertyPositions cannot resolve its own imports: ${caught.message}`);
    assert.equal(caught.message, SENTINEL,
      "control must reach past the operating-day resolution");
  });

  await test("the canonical dated reads no longer default to the UTC day", () => {
    //  SCOPE, stated: the two reads that answer "what is true now" for a
    //  property. Other surfaces have their own clocks and their own reasons.
    const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    for (const rel of ["src/tenancy/dated_positions.js", "src/surfaces/rent_roll_canonical.js"]) {
      const src = stripComments(fs.readFileSync(path.join(root, rel), "utf8"));
      assert.ok(!/new Date\(\)\.toISOString\(\)\.slice\(\s*0\s*,\s*10\s*\)/.test(src),
        `${rel} still defaults "today" to the UTC calendar day`);
      assert.ok(/propertyOperatingToday/.test(src),
        `${rel} must resolve today through shared/property_timezone.js`);
    }
  });

  process.on("exit", () => {
    if (!process.exitCode) console.log(`${passed} property-operating-day tests passed`);
  });
})();
