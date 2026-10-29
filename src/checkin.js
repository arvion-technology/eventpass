/**
 * EventPass check-in station.
 *
 * One rule matters more than the UI: a pass can be checked in once. The scan
 * function returns a status instead of throwing, so the station can show the
 * difference between "already inside at 18:42" and "this code does not exist".
 */

import { normalizeCode, verifyPassCode } from "./tickets.js";

export const CHECK_IN_STATUS = {
  CHECKED_IN: "checked-in",
  DUPLICATE: "duplicate",
  UNKNOWN: "unknown",
  INVALID: "invalid",
  CANCELLED: "cancelled",
};

/**
 * Try to check one code in.
 *
 * @param {string} rawCode
 * @param {object[]} passes
 * @param {{now?:number, station?:string}} [options]
 * @returns {{ok:boolean, status:string, message:string, pass:object|null,
 *            updatedPass:object|null, at:number|null, previousAt:number|null}}
 */
export function checkIn(rawCode, passes, { now = Date.now(), station = "Gate A" } = {}) {
  const code = normalizeCode(rawCode);
  if (!code) {
    return { ok: false, status: CHECK_IN_STATUS.INVALID, message: "Enter a pass code.", pass: null, updatedPass: null, at: null, previousAt: null };
  }

  const verified = verifyPassCode(code);
  if (!verified.valid) {
    return {
      ok: false,
      status: CHECK_IN_STATUS.INVALID,
      message: verified.reason === "checksum" ? "That code looks mistyped, check the last two characters." : "That is not an EventPass code.",
      pass: null, updatedPass: null, at: null, previousAt: null,
    };
  }

  const pass = passes.find((p) => p.code === code) ?? null;
  if (!pass) {
    return { ok: false, status: CHECK_IN_STATUS.UNKNOWN, message: "No pass with that code was issued.", pass: null, updatedPass: null, at: null, previousAt: null };
  }
  if (pass.status === "cancelled") {
    return { ok: false, status: CHECK_IN_STATUS.CANCELLED, message: "This pass was cancelled.", pass, updatedPass: null, at: null, previousAt: null };
  }
  if (pass.checkedInAt) {
    return {
      ok: false,
      status: CHECK_IN_STATUS.DUPLICATE,
      message: `${pass.holder} is already inside, first scanned at ${new Date(pass.checkedInAt).toISOString().slice(11, 16)}.`,
      pass,
      updatedPass: null,
      at: null,
      previousAt: pass.checkedInAt,
    };
  }

  const updatedPass = { ...pass, checkedInAt: now, checkedInBy: station };
  return {
    ok: true,
    status: CHECK_IN_STATUS.CHECKED_IN,
    message: `${pass.holder} checked in.`,
    pass,
    updatedPass,
    at: now,
    previousAt: null,
  };
}

/** Apply a successful result to the pass list and append to the audit log. */
export function recordCheckIn(result, { passes, log = [], station = "Gate A" }) {
  if (!result.ok || !result.updatedPass) return { passes, log, entry: null };
  const nextPasses = passes.map((p) => (p.id === result.updatedPass.id ? result.updatedPass : p));
  const entry = {
    code: result.updatedPass.code,
    ts: result.at,
    station,
    status: result.status,
    holder: result.updatedPass.holder,
  };
  return { passes: nextPasses, log: [...log, entry], entry };
}

/** The next unchecked pass, for the demo's "scan next" button. */
export function nextPass(passes) {
  return passes.find((p) => p.status === "valid" && !p.checkedInAt) ?? null;
}

/** A pass that has already been scanned, for demonstrating duplicates. */
export function lastCheckedIn(passes) {
  const rows = passes.filter((p) => p.checkedInAt).sort((a, b) => b.checkedInAt - a.checkedInAt);
  return rows[0] ?? null;
}

/** Check-ins per hour for one day, from the audit log. */
export function throughputByHour(log, { day = null, hours = 12, startHour = 8 } = {}) {
  const rows = Array.from({ length: hours }, (_, i) => ({ hour: startHour + i, count: 0 }));
  for (const entry of log) {
    if (entry.status !== "checked-in") continue;
    if (day !== null && new Date(entry.ts).getUTCDate() !== new Date(day).getUTCDate()) continue;
    const hour = new Date(entry.ts).getUTCHours();
    const row = rows.find((r) => r.hour === hour);
    if (row) row.count++;
  }
  return rows;
}

/** The latest arrivals, newest first. */
export function recentCheckIns(log, limit = 8) {
  return log.filter((e) => e.status === "checked-in").sort((a, b) => b.ts - a.ts).slice(0, limit);
}

/** No-show list: issued but never scanned, oldest sale first. */
export function noShows(passes) {
  return passes
    .filter((p) => p.status === "valid" && !p.checkedInAt)
    .sort((a, b) => a.issuedAt - b.issuedAt);
}
