import test from "node:test";
import assert from "node:assert/strict";
import {
  DAY, EVENT, TIERS, PROMOS, tierById, tierAvailability, quote, issuePasses,
  validatePromo, validatePromo as _validatePromo, promoByCode, makePassCode,
  verifyPassCode, normalizeCode, checksum, attendanceStats, revenue,
  revenueByTier, seedSales,
} from "../src/tickets.js";

const NOW = Date.parse("2026-11-18T12:00:00Z");

const promo = (over = {}) => ({
  code: "TEST10", kind: "percent", value: 10, appliesTo: null,
  minQty: 1, maxUses: 10, used: 0, expiresAt: NOW + 5 * DAY, ...over,
});

const pass = (over = {}) => ({
  id: "P-1", code: makePassCode("EV26", "GA", 1), sequence: 1, tierId: "general",
  holder: "Aarav Shrestha", pricePaid: 3500, promoCode: null,
  issuedAt: NOW - 5 * DAY, status: "valid", checkedInAt: null, checkedInBy: null,
  ...over,
});

/* ----------------------------------------------------------------- tiers */

test("tierAvailability counts sold passes against capacity", () => {
  const early = tierById("early");
  const passes = [pass({ tierId: "early" }), pass({ id: "P-2", tierId: "early" })];
  const availability = tierAvailability(early, passes);
  assert.equal(availability.sold, 2);
  assert.equal(availability.remaining, 58);
  assert.equal(availability.soldOut, false);
  assert.ok(Math.abs(availability.pct - 2 / 60) < 1e-9);
});

test("a cancelled pass does not count against capacity or revenue", () => {
  const passes = [pass(), pass({ id: "P-2", status: "cancelled" })];
  assert.equal(tierAvailability(tierById("general"), passes).sold, 1);
  assert.equal(revenue(passes), 3500);
});

/* ----------------------------------------------------------------- quote */

test("quote prices a plain order", () => {
  const result = quote({ tierId: "general", qty: 2 }, { passes: [], now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.subtotal, 7000);
  assert.equal(result.discount, 0);
  assert.equal(result.total, 7000);
  assert.equal(result.promo, null);
});

test("a percentage promo applies to the tier it names", () => {
  const result = quote({ tierId: "early", qty: 2, promoCode: "EARLY10" }, { passes: [], now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.subtotal, 5000);
  assert.equal(result.discount, 500);
  assert.equal(result.total, 4500);
});

test("a fixed promo requires its minimum quantity", () => {
  const one = quote({ tierId: "general", qty: 1, promoCode: "NEPAL500" }, { passes: [], now: NOW });
  assert.equal(one.ok, false);
  assert.match(one.errors[0], /at least 2/);

  const two = quote({ tierId: "general", qty: 2, promoCode: "NEPAL500" }, { passes: [], now: NOW });
  assert.equal(two.ok, true);
  assert.equal(two.discount, 500);
  assert.equal(two.total, 6500);
});

test("promo restrictions are enforced: tier, expiry and remaining uses", () => {
  const tierMismatch = quote({ tierId: "early", qty: 1, promoCode: "STUDENT20" }, { passes: [], now: NOW });
  assert.equal(tierMismatch.ok, false);
  assert.match(tierMismatch.errors[0], /does not apply/);

  const expired = validatePromo(promo({ expiresAt: NOW - DAY }), { tierId: "general", qty: 1, subtotal: 1000, now: NOW });
  assert.equal(expired.ok, false);
  assert.match(expired.error, /expired/);

  const used = validatePromo(promo({ used: 10, maxUses: 10 }), { tierId: "general", qty: 1, subtotal: 1000, now: NOW });
  assert.equal(used.ok, false);
  assert.match(used.error, /fully redeemed/);
});

test("quote refuses to oversell a tier or take silly quantities", () => {
  const early = TIERS[0];
  const nearlyFull = Array.from({ length: early.capacity - 1 }, (_, i) => pass({ id: `P-${i}`, tierId: "early" }));
  const over = quote({ tierId: "early", qty: 2 }, { passes: nearlyFull, now: NOW });
  assert.equal(over.ok, false);
  assert.match(over.errors[0], /Only 1/);

  assert.equal(quote({ tierId: "general", qty: 0 }, { now: NOW }).ok, false);
  assert.equal(quote({ tierId: "general", qty: 11 }, { now: NOW }).ok, false);
  assert.equal(quote({ tierId: "nope", qty: 1 }, { now: NOW }).ok, false);
});

test("promo lookup is case-insensitive and trims whitespace", () => {
  assert.equal(promoByCode(PROMOS, " early10 ")?.code, "EARLY10");
  assert.equal(promoByCode(PROMOS, "missing"), null);
  assert.equal(promoByCode(PROMOS, ""), null);
});

/* ------------------------------------------------------------ pass codes */

test("pass codes carry a checksum that catches a typo", () => {
  const code = makePassCode("EV26", "GA", 42);
  assert.equal(code, "EV26-GA-0042-" + checksum("EV26-GA-0042"));
  assert.equal(verifyPassCode(code).valid, true);
  assert.deepEqual(verifyPassCode(code.toLowerCase()).tierId, "general");

  const typo = code.slice(0, -2) + (code.endsWith("00") ? "01" : "00");
  const checked = verifyPassCode(typo);
  assert.equal(checked.valid, false);
  assert.equal(checked.reason, "checksum");

  assert.equal(verifyPassCode("not-a-code").reason, "format");
  assert.equal(normalizeCode(" ev26-ga-0042-ab "), "EV26-GA-0042-AB");
});

test("issuePasses writes codes, splits the total and consumes the promo once", () => {
  const promos = [promo({ code: "TEN", value: 10, maxUses: 5, used: 0 })];
  const result = issuePasses(
    { tierId: "general", qty: 2, promoCode: "TEN" },
    { passes: [], promos, now: NOW },
  );
  assert.equal(result.ok, true);
  assert.equal(result.passes.length, 2);
  assert.deepEqual(result.passes.map((p) => p.sequence), [1, 2]);
  assert.equal(result.passes[0].pricePaid + result.passes[1].pricePaid, 6300);
  assert.equal(result.quote.discount, 700);
  assert.equal(result.promos.find((p) => p.code === "TEN").used, 1);
  assert.equal(verifyPassCode(result.passes[0].code).valid, true);
  assert.match(result.passes[0].code, /^EV26-GA-0001-[0-9A-Z]{2}$/);
});

test("issuePasses refuses an invalid order and issues nothing", () => {
  const result = issuePasses({ tierId: "vip", qty: 25 }, { passes: [], now: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.passes.length, 0);
  assert.equal(result.quote.ok, false);
});

/* ------------------------------------------------------------- attendance */

test("attendanceStats separates sold, scanned and no-show by tier", () => {
  const passes = [
    pass({ id: "P-1", tierId: "general", checkedInAt: NOW - 60000 }),
    pass({ id: "P-2", tierId: "general" }),
    pass({ id: "P-3", tierId: "vip", checkedInAt: NOW - 120000 }),
  ];
  const stats = attendanceStats(passes);
  assert.equal(stats.issued, 3);
  assert.equal(stats.checkedIn, 2);
  assert.equal(stats.noShow, 1);
  assert.ok(Math.abs(stats.rate - 2 / 3) < 1e-9);
  const general = stats.byTier.find((t) => t.tier.id === "general");
  assert.equal(general.issued, 2);
  assert.equal(general.checkedIn, 1);
  assert.equal(general.rate, 0.5);
});

test("revenueByTier totals what was actually paid, not list price", () => {
  const passes = [
    pass({ id: "P-1", tierId: "early", pricePaid: 2250 }),
    pass({ id: "P-2", tierId: "early", pricePaid: 2500 }),
    pass({ id: "P-3", tierId: "vip", pricePaid: 7500 }),
  ];
  const rows = revenueByTier(passes);
  assert.equal(rows.find((r) => r.tier.id === "early").revenue, 4750);
  assert.equal(rows.find((r) => r.tier.id === "vip").revenue, 7500);
  assert.equal(revenue(passes), 12250);
});

test("the seeded event is deterministic and consistent", () => {
  const a = seedSales({ now: NOW, count: 36, checkedIn: 12 });
  const b = seedSales({ now: NOW, count: 36, checkedIn: 12 });
  assert.equal(a.passes.length, 36);
  assert.equal(a.passes.filter((p) => p.checkedInAt).length, 12);
  assert.equal(a.log.length, 12);
  assert.equal(JSON.stringify(a.passes), JSON.stringify(b.passes));
  assert.ok(a.passes.every((p) => verifyPassCode(p.code).valid));
  assert.equal(new Set(a.passes.map((p) => p.holder)).size <= 36, true);
  assert.deepEqual(Object.keys(a.promos).length, PROMOS.length);
});
