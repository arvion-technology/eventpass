import test from "node:test";
import assert from "node:assert/strict";
import {
  checkIn, recordCheckIn, nextPass, lastCheckedIn, throughputByHour,
  recentCheckIns, noShows, CHECK_IN_STATUS,
} from "../src/checkin.js";
import { makePassCode, seedSales } from "../src/tickets.js";

const NOW = Date.parse("2026-11-20T18:00:00Z");

const pass = (over = {}) => ({
  id: "P-1",
  code: makePassCode("EV26", "GA", 7),
  sequence: 7,
  tierId: "general",
  holder: "Bikash Adhikari",
  pricePaid: 3500,
  promoCode: null,
  issuedAt: NOW - 10 * 86_400_000,
  status: "valid",
  checkedInAt: null,
  checkedInBy: null,
  ...over,
});

test("a valid pass checks in once and the input object is untouched", () => {
  const original = pass();
  const result = checkIn(original.code, [original], { now: NOW, station: "Gate B" });
  assert.equal(result.ok, true);
  assert.equal(result.status, CHECK_IN_STATUS.CHECKED_IN);
  assert.equal(result.updatedPass.checkedInAt, NOW);
  assert.equal(result.updatedPass.checkedInBy, "Gate B");
  assert.equal(original.checkedInAt, null);
  assert.match(result.message, /Bikash Adhikari/);
});

test("a second scan is reported as a duplicate with the original time", () => {
  const first = NOW - 3 * 60 * 60 * 1000;
  const already = pass({ checkedInAt: first, checkedInBy: "Gate A" });
  const result = checkIn(already.code, [already], { now: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.status, CHECK_IN_STATUS.DUPLICATE);
  assert.equal(result.previousAt, first);
  assert.equal(result.updatedPass, null);
  // The message exposes the local time of the first scan.
  assert.match(result.message, /already inside/);
});

test("an unknown but well-formed code is different from a mistyped one", () => {
  const issued = pass();
  const unknown = checkIn(makePassCode("EV26", "GA", 9999), [issued], { now: NOW });
  assert.equal(unknown.status, CHECK_IN_STATUS.UNKNOWN);

  const typo = issued.code.slice(0, -2) + "ZZ";
  const invalid = checkIn(typo, [issued], { now: NOW });
  assert.equal(invalid.status, CHECK_IN_STATUS.INVALID);
  assert.match(invalid.message, /mistyped/);

  const empty = checkIn("   ", [issued], { now: NOW });
  assert.equal(empty.status, CHECK_IN_STATUS.INVALID);
});

test("cancelled passes are refused", () => {
  const cancelled = pass({ status: "cancelled" });
  const result = checkIn(cancelled.code, [cancelled], { now: NOW });
  assert.equal(result.status, CHECK_IN_STATUS.CANCELLED);
  assert.equal(result.ok, false);
});

test("codes are normalised: lower case and stray spaces are accepted", () => {
  const issued = pass();
  const messy = `  ${issued.code.toLowerCase()} `;
  const result = checkIn(messy, [issued], { now: NOW });
  assert.equal(result.ok, true);
});

test("recordCheckIn updates the pass list and appends one audit entry", () => {
  const issued = pass();
  const result = checkIn(issued.code, [issued], { now: NOW, station: "Gate A" });
  const next = recordCheckIn(result, { passes: [issued], log: [], station: "Gate A" });
  assert.equal(next.passes[0].checkedInAt, NOW);
  assert.equal(next.log.length, 1);
  assert.deepEqual(next.entry, {
    code: issued.code, ts: NOW, station: "Gate A", status: "checked-in", holder: "Bikash Adhikari",
  });

  const failed = checkIn(issued.code, next.passes, { now: NOW });
  const afterFailure = recordCheckIn(failed, { passes: next.passes, log: next.log, station: "Gate A" });
  assert.equal(afterFailure.log.length, 1);
  assert.equal(afterFailure.entry, null);
});

test("nextPass and lastCheckedIn help the station pick what to scan", () => {
  const first = pass({ id: "P-1", checkedInAt: NOW - 60000 });
  const second = pass({ id: "P-2", code: makePassCode("EV26", "GA", 8), sequence: 8 });
  const third = pass({ id: "P-3", code: makePassCode("EV26", "GA", 9), sequence: 9, status: "cancelled" });
  assert.equal(nextPass([first, second, third]).id, "P-2");
  assert.equal(lastCheckedIn([first, second]).id, "P-1");
  assert.equal(nextPass([first, third]), null);
});

test("throughputByHour buckets the audit log by hour", () => {
  const log = [
    { ts: Date.parse("2026-11-20T09:05:00Z"), status: "checked-in" },
    { ts: Date.parse("2026-11-20T09:45:00Z"), status: "checked-in" },
    { ts: Date.parse("2026-11-20T11:10:00Z"), status: "checked-in" },
    { ts: Date.parse("2026-11-20T11:20:00Z"), status: "duplicate" },
  ];
  const rows = throughputByHour(log, { hours: 4, startHour: 8 });
  assert.deepEqual(rows.map((r) => r.count), [0, 2, 0, 1]);
  assert.deepEqual(rows.map((r) => r.hour), [8, 9, 10, 11]);
});

test("recentCheckIns and noShows read the log and pass list", () => {
  const log = [
    { ts: 100, status: "checked-in", holder: "A" },
    { ts: 300, status: "checked-in", holder: "C" },
    { ts: 200, status: "duplicate", holder: "B" },
  ];
  assert.deepEqual(recentCheckIns(log, 2).map((e) => e.holder), ["C", "A"]);

  const passes = [
    pass({ id: "old", issuedAt: 10 }),
    pass({ id: "new", issuedAt: 30 }),
    pass({ id: "inside", issuedAt: 20, checkedInAt: 50 }),
  ];
  assert.deepEqual(noShows(passes).map((p) => p.id), ["old", "new"]);
});

test("the seeded gate state checks in cleanly then reports duplicates", () => {
  const { passes, log } = seedSales({ now: NOW, count: 20, checkedIn: 6 });
  assert.equal(log.length, 6);
  const scanned = passes.find((p) => p.checkedInAt);
  const duplicate = checkIn(scanned.code, passes, { now: NOW });
  assert.equal(duplicate.status, CHECK_IN_STATUS.DUPLICATE);

  const fresh = nextPass(passes);
  const ok = checkIn(fresh.code, passes, { now: NOW });
  assert.equal(ok.status, CHECK_IN_STATUS.CHECKED_IN);
});
