// EventPass demo, rendering and interaction.
// The QR encoder is ../src/qr.js; ticket and promo rules are ../src/tickets.js;
// the door logic is ../src/checkin.js. This file draws and wires them together.
import { encodeQR } from "../src/qr.js";
import {
  EVENT, TIERS, PROMOS, DAY, tierById, tierAvailability, quote, issuePasses,
  revenue, revenueByTier, attendanceStats, seedSales,
} from "../src/tickets.js";
import {
  checkIn, recordCheckIn, nextPass, lastCheckedIn, recentCheckIns,
} from "../src/checkin.js";

const $ = A.$, $$ = A.$$, el = A.el, fmt = A.fmt;
const STORE_KEY = "eventpass";
const STATION = "Gate A";
const money = (n) => "Rs " + fmt.num(Math.round(n));

/* ------------------------------------------------------------------ state */

function freshData() {
  return seedSales({ now: Date.now(), count: 36, checkedIn: 12 });
}

function restore() {
  const seed = freshData();
  const saved = A.store.get(STORE_KEY, null);
  if (saved && Array.isArray(saved.passes) && Array.isArray(saved.promos)) {
    return { passes: saved.passes, log: saved.log ?? seed.log, promos: saved.promos };
  }
  return seed;
}

let data = restore();
const state = {
  view: "event",
  tier: "general",
  qty: 2,
  promo: "",
  selectedPassId: null,
  previewPassId: null,
  lastResult: null,
};

function persist() {
  A.store.set(STORE_KEY, { passes: data.passes, log: data.log, promos: data.promos });
}

/* --------------------------------------------------------------- QR canvas */

const qrCache = new Map();
function qrFor(text) {
  if (!qrCache.has(text)) qrCache.set(text, encodeQR(text, { ecLevel: "M" }));
  return qrCache.get(text);
}

function drawQR(canvas, text, { target = 190, quiet = 4 } = {}) {
  const symbol = qrFor(text);
  const total = symbol.size + quiet * 2;
  const scale = Math.max(1, Math.floor(target / total));
  const px = total * scale;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = px * dpr;
  canvas.height = px * dpr;
  canvas.style.width = `${px}px`;
  canvas.style.height = `${px}px`;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = "#0b0f1a";
  for (let row = 0; row < symbol.size; row++) {
    for (let col = 0; col < symbol.size; col++) {
      if (symbol.modules[row][col]) {
        ctx.fillRect((col + quiet) * scale, (row + quiet) * scale, scale, scale);
      }
    }
  }
  return symbol;
}

function qrCanvas(text, target = 190) {
  const canvas = el("canvas", { class: "qr-canvas" });
  drawQR(canvas, text, { target });
  return el("div", { class: "qr-frame" }, canvas);
}

function downloadQR(pass) {
  const canvas = document.createElement("canvas");
  drawQR(canvas, pass.code, { target: 480 });
  const link = document.createElement("a");
  link.href = canvas.toDataURL("image/png");
  link.download = `${pass.code}.png`;
  document.body.append(link);
  link.click();
  link.remove();
}

/* ------------------------------------------------------------- components */

function statCard({ label, value, sub, tone = "" }) {
  const color = tone === "green" ? "var(--green)" : tone === "red" ? "var(--red)" : tone === "blue" ? "#8fb4ff" : "var(--gold)";
  return el("div", { class: "card" },
    el("div", { class: "stat" },
      el("div", { class: "stat-label", text: label }),
      el("div", { class: "stat-value", style: `color:${color}`, text: value }),
      el("div", { class: "small muted", text: sub })));
}

const tierBadge = (tierId) => {
  const tier = tierById(tierId);
  return el("span", { class: `badge ${tier?.tone ?? ""}`, text: tier?.name ?? tierId });
};

const statusBadge = (status) => {
  const map = {
    "checked-in": ["green", "checked in"],
    duplicate: ["gold", "duplicate"],
    unknown: ["red", "unknown"],
    invalid: ["red", "mistyped"],
    cancelled: ["red", "cancelled"],
  };
  const [tone, label] = map[status] ?? ["", status];
  return el("span", { class: `badge ${tone}`, text: label });
};

function passStatusBadge(pass) {
  if (pass.status === "cancelled") return el("span", { class: "badge red", text: "cancelled" });
  if (pass.checkedInAt) return el("span", { class: "badge green", text: `inside · ${new Date(pass.checkedInAt).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" })}` });
  return el("span", { class: "badge gold", text: "not scanned" });
}

function updateBadges() {
  const stats = attendanceStats(data.passes);
  $("#nav-pass-count").textContent = String(data.passes.length);
  $("#pass-count").textContent = `${data.passes.length} issued · ${stats.checkedIn} scanned`;
  $("#capacity-badge").textContent = `${data.passes.length} of ${EVENT.capacity} passes issued`;
}

/* ------------------------------------------------------------------ event */

function renderEvent() {
  updateBadges();
  $("#tier-list").replaceChildren(...TIERS.map((tier) => {
    const availability = tierAvailability(tier, data.passes);
    return el("div", {
      class: `tier-card${state.tier === tier.id ? " selected" : ""}${availability.soldOut ? " sold-out" : ""}`,
      onclick: () => {
        if (availability.soldOut) return;
        state.tier = tier.id;
        state.qty = Math.min(state.qty, availability.remaining);
        renderEvent();
      },
    },
      el("div", {},
        el("div", { class: "tier-name", text: tier.name }),
        el("div", { class: "tier-perks", text: tier.perks })),
      el("div", { class: "tier-price" }, money(tier.price), el("small", { text: "per pass" })),
      el("div", { class: "tier-bar" },
        el("div", { class: "progress" + (availability.soldOut ? "" : " green") },
          el("i", { style: `width:${Math.min(100, availability.pct * 100)}%` }))),
      el("div", { class: "tier-meta" },
        el("span", { class: "mono", text: `${availability.sold} / ${tier.capacity} sold` }),
        el("span", { class: "spacer" }),
        availability.soldOut
          ? el("span", { class: "badge red", text: "sold out" })
          : el("span", { class: "badge green", text: `${availability.remaining} left` })));
  }));

  const priced = quote({ tierId: state.tier, qty: state.qty, promoCode: state.promo }, {
    passes: data.passes, promos: data.promos, now: Date.now(),
  });
  const pricePerPass = priced.tier?.price ?? 0;

  $("#checkout").replaceChildren(...[
    el("div", { class: "card-head" },
      el("div", { class: "card-title", text: "Checkout" }),
      el("span", { class: "spacer" }),
      tierBadge(state.tier)),
    el("div", { class: "row", style: "justify-content:space-between;margin-bottom:6px" },
      el("span", { class: "small muted", text: "Passes" }),
      el("div", { class: "qty-stepper" },
        el("button", { "aria-label": "One fewer", onclick: () => { state.qty = Math.max(1, state.qty - 1); renderEvent(); }, text: "−" }),
        el("span", { text: String(state.qty) }),
        el("button", { "aria-label": "One more", onclick: () => { state.qty = Math.min(10, state.qty + 1); renderEvent(); }, text: "+" }))),
    el("div", { class: "promo-row" },
      el("input", {
        class: "input mono", id: "promo-input", placeholder: "Promo code", value: state.promo,
        style: "flex:1;text-transform:uppercase",
        onchange: (e) => { state.promo = e.target.value.trim().toUpperCase(); renderEvent(); },
        onkeydown: (e) => { if (e.key === "Enter") { state.promo = e.target.value.trim().toUpperCase(); renderEvent(); } },
      }),
      el("button", {
        class: "btn sm",
        onclick: () => { state.promo = ($("#promo-input")?.value ?? "").trim().toUpperCase(); renderEvent(); },
        text: "Apply",
      })),
    el("div", { class: "row wrap", style: "gap:5px;margin-bottom:8px" },
      ...PROMOS.map((promo) => el("button", {
        class: "promo-hint", title: promo.description,
        onclick: () => { state.promo = promo.code; renderEvent(); },
        text: promo.code,
      }))),
    el("div", { class: "divider", style: "margin:8px 0" }),
    el("div", { class: "checkout-row" },
      el("span", { class: "small muted", text: `${state.qty} × ${money(pricePerPass)}` }),
      el("span", { class: "spacer" }),
      el("span", { class: "amount", text: money(priced.subtotal) })),
    priced.discount > 0
      ? el("div", { class: "checkout-row", style: "color:var(--green)" },
        el("span", { class: "small", text: `Promo ${priced.promo.code}` }),
        el("span", { class: "spacer" }),
        el("span", { class: "amount", text: `− ${money(priced.discount)}` }))
      : null,
    el("div", { class: "checkout-row" },
      el("span", { class: "small", style: "color:var(--text-2)", text: "Total" }),
      el("span", { class: "spacer" }),
      el("span", { class: "checkout-total", text: money(priced.total) })),
    priced.ok ? null : el("div", { class: "check-errors", text: priced.errors.join(" · ") }),
    el("button", {
      class: "btn primary lg", style: "width:100%;margin-top:10px",
      disabled: priced.ok ? null : "",
      onclick: buy,
      text: priced.ok ? `Issue ${state.qty} pass${state.qty === 1 ? "" : "es"}` : "Not available",
    }),
    el("p", { class: "small muted center", style: "margin:8px 0 0", text: "Demo checkout, no card, no account." }),
  ].filter(Boolean));

  $("#promo-table").replaceChildren(A.dataTable({
    columns: [
      { label: "Code", render: (p) => el("span", { class: "mono", text: p.code }) },
      { label: "Offer", render: (p) => el("span", { class: "small", text: p.description }) },
      { label: "Used", align: "right", render: (p) => el("span", { class: "mono small", text: `${p.used} / ${p.maxUses}` }) },
      {
        label: "Status", align: "right",
        render: (p) => el("span", { class: `badge ${p.used >= p.maxUses ? "red" : "green"}`, text: p.used >= p.maxUses ? "exhausted" : "active" }),
      },
    ],
    rows: data.promos,
  }));
}

function buy() {
  const result = issuePasses(
    { tierId: state.tier, qty: state.qty, promoCode: state.promo || null },
    { passes: data.passes, promos: data.promos, now: Date.now() },
  );
  if (!result.ok) { A.toast(result.errors[0] ?? "That order cannot be issued", "error"); return; }
  data.passes = [...data.passes, ...result.passes];
  data.promos = result.promos;
  state.selectedPassId = result.passes[0].id;
  state.promo = "";
  persist();
  A.toast(`${result.passes.length} pass${result.passes.length === 1 ? "" : "es"} issued`, "success");
  location.hash = "#passes";
}

/* ----------------------------------------------------------------- passes */

function selectedPass() {
  return data.passes.find((p) => p.id === state.selectedPassId)
    ?? data.passes[data.passes.length - 1]
    ?? null;
}

function renderPasses() {
  updateBadges();
  const pass = selectedPass();
  if (!pass) {
    $("#pass-large").replaceChildren(el("p", { class: "small muted", text: "No passes yet. Buy one from the event page." }));
    $("#pass-list").replaceChildren();
    return;
  }
  state.selectedPassId = pass.id;
  $("#pass-large").replaceChildren(
    qrCanvas(pass.code, 196),
    el("div", { class: "pass-holder", text: pass.holder }),
    el("div", { class: "pass-code", text: pass.code }),
    el("div", { class: "row", style: "justify-content:center;gap:8px;margin-top:8px" },
      tierBadge(pass.tierId), passStatusBadge(pass)),
    el("div", { class: "pass-meta", text: `${EVENT.name} · ${fmt.date(EVENT.doorsAt, "long")} · ${EVENT.venue}` }),
    el("div", { class: "row", style: "justify-content:center;gap:8px;margin-top:14px" },
      el("button", { class: "btn sm", onclick: () => downloadQR(pass), text: "Download PNG" }),
      el("button", { class: "btn sm ghost", onclick: () => { location.hash = "#checkin"; }, text: "Try at the door →" })));

  const list = [...data.passes].sort((a, b) => b.issuedAt - a.issuedAt).slice(0, 30);
  $("#pass-list").replaceChildren(...list.map((row) => el("div", {
    class: `pass-row${row.id === pass.id ? " selected" : ""}`,
    onclick: () => { state.selectedPassId = row.id; renderPasses(); },
  },
    el("div", { class: "mini-qr" }, el("canvas", { class: "qr-canvas" })),
    el("div", { style: "min-width:0;flex:1" },
      el("div", { class: "holder", text: row.holder }),
      el("div", { class: "code", text: row.code })),
    tierBadge(row.tierId),
    passStatusBadge(row))));
  // Draw the mini codes after the rows are in the document.
  $$("#pass-list .pass-row").forEach((row, index) => {
    const canvas = row.querySelector("canvas");
    if (canvas && list[index]) drawQR(canvas, list[index].code, { target: 40 });
  });
}

/* --------------------------------------------------------------- check-in */

function previewPass() {
  if (state.previewPassId) {
    const found = data.passes.find((p) => p.id === state.previewPassId);
    if (found) return found;
  }
  return nextPass(data.passes) ?? lastCheckedIn(data.passes) ?? null;
}

function renderCheckin() {
  updateBadges();
  const stats = attendanceStats(data.passes);
  $("#ci-kpis").replaceChildren(
    statCard({ label: "Issued", value: String(stats.issued), sub: "valid passes" }),
    statCard({ label: "Inside", value: String(stats.checkedIn), sub: `${fmt.pct(stats.rate, 0)} of issued`, tone: "green" }),
    statCard({ label: "Not yet arrived", value: String(stats.noShow), sub: "passes never scanned", tone: "red" }),
    statCard({ label: "Door log", value: String(data.log.length), sub: `${recentCheckIns(data.log, 99).length} successful scans` }),
  );

  const pass = previewPass();
  $("#ci-preview-tier").textContent = pass ? tierById(pass.tierId)?.name ?? pass.tierId : ", ";
  $("#ci-preview").replaceChildren(...(pass ? [
    qrCanvas(pass.code, 152),
    el("div", { class: "pass-holder", style: "font-size:14px", text: pass.holder }),
    el("div", { class: "pass-code", style: "font-size:11.5px", text: pass.code }),
    el("div", { class: "row", style: "justify-content:center;margin-top:8px" }, passStatusBadge(pass)),
  ] : [el("p", { class: "small muted", text: "Every pass has been scanned." })]));

  $("#ci-log-count").textContent = `${data.log.length} entries`;
  const feed = [...data.log].sort((a, b) => b.ts - a.ts).slice(0, 7);
  $("#ci-feed").replaceChildren(...(feed.length ? feed.map((entry) => el("div", { class: "feed-row" },
    el("span", { class: "mono small muted", text: new Date(entry.ts).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" }) }),
    statusBadge(entry.status),
    el("span", { class: "holder", text: entry.holder ?? ", " }),
    el("span", { class: "code", text: entry.code }))) : [el("p", { class: "small muted", style: "padding:12px 16px", text: "No scans yet." })]));

  $("#ci-stats").replaceChildren(A.barList({
    rows: stats.byTier.map((row) => ({ label: `${row.tier.name} · ${row.checkedIn}/${row.issued}`, value: row.rate * 100 })),
    format: (v) => Math.round(v) + "%",
    max: 100,
  }));

  $("#station-clock").replaceChildren(
    el("span", { class: "dot pulse", style: "color:var(--green)" }),
    el("span", { class: "mono", text: new Date().toLocaleTimeString("en-US", { hour12: false }) }));

  const result = state.lastResult;
  const host = $("#ci-result");
  if (!result) {
    host.replaceChildren(el("p", { class: "small muted mb-0", text: "The result of the next scan appears here, with the reason if it is refused." }));
    return;
  }
  const tone = result.ok ? "ok" : result.status === "duplicate" ? "dup" : "err";
  host.replaceChildren(el("div", { class: `ci-result ${tone}` },
    el("div", {},
      el("strong", { text: result.ok ? "Checked in" : result.status === "duplicate" ? "Already inside" : "Refused" }),
      el("span", { text: result.message }))));
}

function doCheckIn(raw) {
  const result = checkIn(raw, data.passes, { now: Date.now(), station: STATION });
  const applied = recordCheckIn(result, { passes: data.passes, log: data.log, station: STATION });
  data.passes = applied.passes;
  data.log = result.ok
    ? applied.log
    : [...applied.log, {
      code: String(raw ?? "").trim().toUpperCase().replace(/\s+/g, ""),
      ts: Date.now(), station: STATION, status: result.status,
      holder: result.pass?.holder ?? null,
    }];
  state.lastResult = result;
  state.previewPassId = result.updatedPass?.id ?? null;
  persist();
  renderCheckin();
  updateBadges();
  const input = $("#ci-input");
  if (input) input.value = "";
  A.toast(result.message, result.ok ? "success" : "error", 3200);
}

/* ------------------------------------------------------------------ stats */

/** Arrivals per ten-minute bucket over the last two hours. */
function arrivalBuckets(log, buckets = 12) {
  const now = Date.now();
  const size = 10 * 60_000;
  const rows = Array.from({ length: buckets }, (_, i) => ({ label: i === buckets - 1 ? "now" : `−${(buckets - 1 - i) * 10}m`, count: 0 }));
  for (const entry of log) {
    if (entry.status !== "checked-in") continue;
    const age = now - entry.ts;
    const index = buckets - 1 - Math.floor(age / size);
    if (index >= 0 && index < buckets) rows[index].count++;
  }
  return rows;
}

function renderStats() {
  updateBadges();
  const stats = attendanceStats(data.passes);
  const totalRevenue = revenue(data.passes);
  $("#stats-kpis").replaceChildren(
    statCard({ label: "Revenue", value: "Rs " + fmt.compact(totalRevenue), sub: `${stats.issued} passes sold` }),
    statCard({ label: "Attendance", value: fmt.pct(stats.rate, 1), sub: `${stats.checkedIn} of ${stats.issued} scanned`, tone: "green" }),
    statCard({ label: "No-shows", value: String(stats.noShow), sub: "issued, never scanned", tone: "red" }),
    statCard({ label: "Average paid", value: "Rs " + fmt.compact(stats.issued ? totalRevenue / stats.issued : 0), sub: "after promo codes" }),
  );

  $("#revenue-tiers").replaceChildren(A.barList({
    rows: revenueByTier(data.passes).map((row) => ({ label: `${row.tier.name} · ${row.sold}`, value: row.revenue })),
    format: money,
  }));

  const buckets = arrivalBuckets(data.log);
  let running = 0;
  const cumulative = buckets.map((bucket) => {
    running += bucket.count;
    return running;
  });
  $("#arrivals-chart").replaceChildren(A.lineChart({
    series: [{ name: "Arrivals", data: cumulative }],
    labels: buckets.map((bucket) => bucket.label),
    width: 640, height: 190,
    yFormat: (v) => String(Math.round(v)),
  }));

  const missing = data.passes
    .filter((pass) => pass.status === "valid" && !pass.checkedInAt)
    .sort((a, b) => a.issuedAt - b.issuedAt);
  $("#noshow-count").textContent = `${missing.length} outstanding`;
  $("#noshow-table").replaceChildren(A.dataTable({
    columns: [
      {
        label: "Holder",
        render: (pass) => el("div", { class: "row", style: "gap:8px" },
          el("span", { class: "avatar sm", text: fmt.initials(pass.holder) }),
          el("span", { class: "small", text: pass.holder })),
      },
      { label: "Tier", render: (pass) => tierBadge(pass.tierId) },
      { label: "Code", render: (pass) => el("span", { class: "mono small muted", text: pass.code }) },
      { label: "Sold", align: "right", render: (pass) => el("span", { class: "small muted", text: fmt.date(pass.issuedAt) }) },
      { label: "Paid", align: "right", render: (pass) => el("span", { class: "mono small", text: money(pass.pricePaid) }) },
    ],
    rows: missing.slice(0, 10),
    empty: "Everyone has been scanned in.",
  }));
}

/* ----------------------------------------------------------------- routing */

const VIEWS = ["event", "passes", "checkin", "stats"];

function route() {
  const requested = (location.hash || "#event").slice(1).split("/")[0];
  state.view = VIEWS.includes(requested) ? requested : "event";
  $$("[data-view-panel]").forEach((panel) => { panel.hidden = panel.dataset.viewPanel !== state.view; });
  $$("[data-view]").forEach((a) => a.classList.toggle("active", a.dataset.view === state.view));
  if (state.view === "event") renderEvent();
  else if (state.view === "passes") renderPasses();
  else if (state.view === "checkin") renderCheckin();
  else if (state.view === "stats") renderStats();
  window.scrollTo({ top: 0 });
}

/* -------------------------------------------------------------------- wire */

function wire() {
  $("#event-date").textContent = new Date(EVENT.doorsAt).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
  $("#goto-passes").addEventListener("click", () => { location.hash = "#passes"; });
  $("#ci-submit").addEventListener("click", () => doCheckIn($("#ci-input").value));
  $("#ci-input").addEventListener("keydown", (e) => { if (e.key === "Enter") doCheckIn(e.target.value); });

  $("#ci-scan-next").addEventListener("click", () => {
    const pass = nextPass(data.passes);
    if (!pass) { A.toast("Every pass has already been scanned", "error"); return; }
    doCheckIn(pass.code);
  });
  $("#ci-duplicate").addEventListener("click", () => {
    const pass = lastCheckedIn(data.passes);
    if (!pass) { A.toast("Nothing has been scanned yet", "error"); return; }
    doCheckIn(pass.code);
  });
  $("#ci-typo").addEventListener("click", () => {
    const pass = nextPass(data.passes) ?? data.passes[0];
    if (!pass) return;
    doCheckIn(pass.code.slice(0, -2) + "ZZ");
  });

  $("#reset-data").addEventListener("click", () => {
    A.store.remove(STORE_KEY);
    data = freshData();
    state.lastResult = null;
    state.selectedPassId = null;
    state.previewPassId = null;
    state.qty = 2;
    state.promo = "";
    route();
    A.toast("Demo data regenerated from the seed", "success");
  });

  window.addEventListener("hashchange", route);
}

wire();
route();
