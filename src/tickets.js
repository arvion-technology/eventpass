/**
 * EventPass ticketing: tiers, promo codes, orders and pass codes.
 *
 * Money is in Nepali rupees, stored as whole rupees. A pass code is designed to
 * be readable over the phone and cheap to validate offline:
 *
 *     EV26-GA-0042-7K
 *     event  tier sequence checksum
 *
 * The checksum is two base-36 characters derived from the event, tier and
 * sequence, so a mistyped code is rejected before it is looked up.
 */

export const DAY = 86_400_000;

const today = new Date();
const doorsAt = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 4, 15); // 10:00 in Kathmandu

export const EVENT = {
  id: "EV26",
  name: "Kathmandu Design Week",
  year: today.getUTCFullYear(),
  date: new Date(doorsAt).toISOString().slice(0, 10),
  doorsAt,
  venue: "Patan Durbar Square, Lalitpur",
  capacity: 204,
};

export const TIER_CODES = { early: "EB", general: "GA", vip: "VI" };

export const TIERS = [
  { id: "early", name: "Early bird", price: 2500, capacity: 60, tone: "gold", perks: "First release · 60 passes", code: "EB" },
  { id: "general", name: "General", price: 3500, capacity: 120, tone: "blue", perks: "Main hall access", code: "GA" },
  { id: "vip", name: "VIP", price: 7500, capacity: 24, tone: "purple", perks: "Front row, dinner and lounge", code: "VI" },
];

const PROMO_EXPIRY = Date.parse("2026-11-19T18:00:00Z");

export const PROMOS = [
  { code: "EARLY10", kind: "percent", value: 10, appliesTo: ["early"], minQty: 1, maxUses: 40, used: 0, expiresAt: PROMO_EXPIRY, description: "10% off early bird" },
  { code: "NEPAL500", kind: "fixed", value: 500, appliesTo: null, minQty: 2, maxUses: 100, used: 0, expiresAt: PROMO_EXPIRY, description: "Rs 500 off two or more passes" },
  { code: "STUDENT20", kind: "percent", value: 20, appliesTo: ["general"], minQty: 1, maxUses: 60, used: 0, expiresAt: PROMO_EXPIRY, description: "20% off general admission, student ID at the door" },
];

const HOLDERS = [
  "Aarav Shrestha", "Sita Karki", "Bipin Adhikari", "Rojina Gurung",
  "Kiran Thapa", "Anjali Rai", "Suman Lama", "Nisha Magar",
  "Prakash Bhattarai", "Sabina Poudel", "Dipesh Joshi", "Maya Basnet",
  "Rohit Tamang", "Laxmi Shahi", "Arun Khadka", "Pooja Neupane",
  "Bikash Subedi", "Rita Ghimire", "Sagar Pandey", "Manisha Maharjan",
  "Hari Dhakal", "Sarita Bhandari", "Umesh Chaudhary", "Kalpana Yadav",
  "Prabin Shrestha", "Sneha Karki", "Deepak Adhikari", "Bimala Gurung",
  "Ashish Thapa", "Nirmala Rai", "Rabin Lama", "Sunita Magar",
  "Ganesh Bhattarai", "Anita Poudel", "Milan Joshi", "Barsha Basnet",
];

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function tierById(tierId) {
  return TIERS.find((t) => t.id === tierId) ?? null;
}

export function promoByCode(promos, code) {
  const needle = String(code ?? "").trim().toUpperCase();
  if (!needle) return null;
  return promos.find((p) => p.code === needle) ?? null;
}

/* ------------------------------------------------------------ pass codes */

/** Two-character checksum over the code body. Not a signature, a typo guard. */
export function checksum(body) {
  let hash = 0;
  for (const char of body) hash = (hash * 31 + char.charCodeAt(0)) % 1296;
  return hash.toString(36).toUpperCase().padStart(2, "0");
}

export function makePassCode(eventId, tierCode, sequence) {
  const body = `${eventId}-${tierCode}-${String(sequence).padStart(4, "0")}`;
  return `${body}-${checksum(body)}`;
}

export function verifyPassCode(code) {
  const value = String(code ?? "").trim().toUpperCase();
  const match = value.match(/^([A-Z0-9]{2,6})-([A-Z]{2})-(\d{4})-([0-9A-Z]{2})$/);
  if (!match) return { valid: false, reason: "format", code: value };
  const [, eventId, tierCode, sequence, sum] = match;
  if (!Object.values(TIER_CODES).includes(tierCode)) return { valid: false, reason: "tier", code: value };
  const body = `${eventId}-${tierCode}-${sequence}`;
  if (checksum(body) !== sum) return { valid: false, reason: "checksum", code: value };
  return { valid: true, code: value, eventId, tierId: Object.keys(TIER_CODES).find((id) => TIER_CODES[id] === tierCode), sequence: Number(sequence) };
}

export function normalizeCode(input) {
  return String(input ?? "").trim().toUpperCase().replace(/\s+/g, "");
}

/* --------------------------------------------------------------- selling */

export function passesForTier(passes, tierId) {
  return passes.filter((p) => p.tierId === tierId && p.status !== "cancelled");
}

export function tierAvailability(tier, passes) {
  const sold = passesForTier(passes, tier.id).length;
  return {
    tier,
    sold,
    remaining: Math.max(0, tier.capacity - sold),
    capacity: tier.capacity,
    soldOut: sold >= tier.capacity,
    pct: tier.capacity ? sold / tier.capacity : 0,
  };
}

export function revenue(passes) {
  return passes.filter((p) => p.status !== "cancelled").reduce((a, p) => a + p.pricePaid, 0);
}

export function revenueByTier(passes) {
  return TIERS.map((tier) => ({
    tier,
    sold: passesForTier(passes, tier.id).length,
    revenue: passesForTier(passes, tier.id).reduce((a, p) => a + p.pricePaid, 0),
  }));
}

/**
 * Validate a promo against one order. Returns the discount or a reason.
 * A promo use is counted per order, not per pass, one code, one order.
 */
export function validatePromo(promo, { tierId, qty, subtotal, now = Date.now() } = {}) {
  if (!promo) return { ok: false, error: "Unknown promo code", discount: 0 };
  if (now > promo.expiresAt) return { ok: false, error: `${promo.code} has expired`, discount: 0 };
  if (promo.used >= promo.maxUses) return { ok: false, error: `${promo.code} has been fully redeemed`, discount: 0 };
  if (promo.appliesTo && !promo.appliesTo.includes(tierId)) {
    return { ok: false, error: `${promo.code} does not apply to this tier`, discount: 0 };
  }
  if (qty < promo.minQty) {
    return { ok: false, error: `${promo.code} needs at least ${promo.minQty} pass${promo.minQty === 1 ? "" : "es"}`, discount: 0 };
  }
  const raw = promo.kind === "percent" ? (subtotal * promo.value) / 100 : promo.value;
  return { ok: true, discount: Math.min(subtotal, Math.round(raw)), error: null };
}

/**
 * Price one order before anything is issued.
 *
 * @param {{tierId:string, qty:number, promoCode?:string}} order
 * @returns {{ok:boolean, errors:string[], subtotal:number, discount:number,
 *            total:number, promo:object|null, tier:object|null, availability:object|null}}
 */
export function quote(order, { passes = [], promos = PROMOS, now = Date.now() } = {}) {
  const errors = [];
  const tier = tierById(order.tierId);
  const qty = Math.floor(Number(order.qty));
  if (!tier) errors.push("Choose a ticket tier.");
  if (!Number.isFinite(qty) || qty < 1) errors.push("Choose at least one pass.");
  if (qty > 10) errors.push("Ten passes per order is the limit.");
  if (!tier) return { ok: false, errors, subtotal: 0, discount: 0, total: 0, promo: null, tier: null, availability: null };

  const availability = tierAvailability(tier, passes);
  if (qty > availability.remaining) {
    errors.push(`Only ${availability.remaining} ${tier.name} pass${availability.remaining === 1 ? "" : "es"} left.`);
  }

  const subtotal = tier.price * Math.max(0, qty);
  let discount = 0;
  let promo = null;
  if (order.promoCode) {
    promo = promoByCode(promos, order.promoCode);
    const result = validatePromo(promo, { tierId: tier.id, qty, subtotal, now });
    if (!result.ok) errors.push(result.error);
    else discount = result.discount;
  }
  const total = Math.max(0, subtotal - discount);
  return { ok: errors.length === 0, errors, subtotal, discount, total, promo, tier, availability, qty };
}

/**
 * Issue passes for a paid order. The caller owns mutation; this returns the new
 * pass objects and the promo with one more use.
 */
export function issuePasses(order, {
  passes = [], promos = PROMOS, now = Date.now(), event = EVENT, holder = null,
} = {}) {
  const priced = quote(order, { passes, promos, now });
  if (!priced.ok) return { ok: false, errors: priced.errors, passes: [], quote: priced, promos };

  const sequenceStart = passes.length
    ? Math.max(...passes.map((p) => p.sequence ?? 0)) + 1
    : 1;
  const perPass = Math.round(priced.total / priced.qty);
  const remainder = priced.total - perPass * priced.qty;
  const issued = [];
  for (let i = 0; i < priced.qty; i++) {
    const sequence = sequenceStart + i;
    const code = makePassCode(event.id, priced.tier.code, sequence);
    issued.push({
      id: `P-${sequence}`,
      code,
      sequence,
      tierId: priced.tier.id,
      holder: holder ?? HOLDERS[(sequence - 1) % HOLDERS.length],
      pricePaid: perPass + (i === 0 ? remainder : 0),
      promoCode: priced.promo?.code ?? null,
      issuedAt: now,
      status: "valid",
      checkedInAt: null,
      checkedInBy: null,
    });
  }
  const nextPromos = promos.map((p) => (p.code === priced.promo?.code ? { ...p, used: p.used + 1 } : p));
  return { ok: true, errors: [], passes: issued, quote: priced, promos: nextPromos };
}

/* ------------------------------------------------------------- attendance */

export function attendanceStats(passes, { byTier = true } = {}) {
  const valid = passes.filter((p) => p.status !== "cancelled");
  const checkedIn = valid.filter((p) => p.checkedInAt);
  const stats = {
    issued: valid.length,
    checkedIn: checkedIn.length,
    remaining: valid.length - checkedIn.length,
    rate: valid.length ? checkedIn.length / valid.length : 0,
    noShow: valid.length - checkedIn.length,
    byTier: [],
  };
  if (byTier) {
    stats.byTier = TIERS.map((tier) => {
      const rows = passesForTier(valid, tier.id);
      const inside = rows.filter((p) => p.checkedInAt).length;
      return { tier, issued: rows.length, checkedIn: inside, rate: rows.length ? inside / rows.length : 0 };
    });
  }
  return stats;
}

/** Deterministic opening state: some passes already sold and scanned in. */
export function seedSales({ now = Date.now(), count = 36, checkedIn = 12 } = {}) {
  const r = mulberry32(20261120);
  const promos = PROMOS.map((p) => ({ ...p }));
  const passes = [];
  let sequence = 1;
  for (let i = 0; i < count; i++) {
    const tier = i < 8 ? TIERS[0] : i < 30 ? TIERS[1] : TIERS[2];
    const code = makePassCode(EVENT.id, tier.code, sequence);
    const promo = i % 9 === 0 ? "NEPAL500" : null;
    const pricePaid = i % 9 === 0 ? Math.max(0, tier.price - 500) : tier.price;
    passes.push({
      id: `P-${sequence}`,
      code,
      sequence,
      tierId: tier.id,
      holder: HOLDERS[i % HOLDERS.length],
      pricePaid,
      promoCode: promo,
      issuedAt: now - (20 - Math.floor(r() * 15)) * DAY,
      status: "valid",
      checkedInAt: null,
      checkedInBy: null,
    });
    sequence++;
  }
  const log = [];
  for (let i = 0; i < checkedIn; i++) {
    const pass = passes[(i * 3) % passes.length];
    if (pass.checkedInAt) continue;
    const at = now - (checkedIn - i) * 9 * 60_000;
    pass.checkedInAt = at;
    pass.checkedInBy = "Gate A";
    log.push({ code: pass.code, ts: at, station: "Gate A", status: "checked-in", holder: pass.holder });
  }
  return { passes, log, promos };
}
