// Venue Tours — shared wedding venue tracker.
// Everything lives in Firebase Realtime Database under venuetracker/<ACCESS CODE>/:
//   meta        {createdAt}
//   settings    {guests, budget, window}
//   venues/<id> one venue: fields, questions, dates, notes, ratings, features,
//               photos (with a small inline thumbnail), files (metadata only)
//   blobs/<id>  {type, parts[]}: full-size photos and uploaded files as base64 data-URL
//               chunks, kept apart from venues so the live listener never downloads them
// The access code is the only key to the data: it is never stored in this source, and the
// database rules stop anyone listing which codes exist.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getDatabase, ref, onValue, update, set, get, push } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";
import { FIREBASE_CONFIG, FIREBASE_CONFIGURED } from "./firebase-config.js";

const STATUSES = [
  ["totour", "To tour"], ["toured", "Toured"], ["shortlist", "Shortlist"], ["booked", "Booked"], ["out", "Ruled out"]
];
const STATUS_LABEL = Object.fromEntries(STATUSES);
const STATUS_ORDER = { booked: 0, shortlist: 1, toured: 2, totour: 3, out: 4 };
const FEATURES = [
  ["ceremony", "Ceremony on-site"], ["outdoor", "Outdoor space"], ["rainplan", "Indoor rain plan"],
  ["inhouse", "In-house catering"], ["outsidefood", "Outside caterers OK"], ["byob", "Can bring own alcohol"],
  ["readyrooms", "Getting-ready rooms"], ["lodging", "Lodging on-site/nearby"], ["parking", "Parking"],
  ["accessible", "Accessible"], ["coordinator", "Coordinator included"], ["late", "Can go past 11pm"],
  ["tables", "Tables/chairs/linens included"], ["exclusive", "Only event that day"]
];
const DEFAULT_QUESTIONS = [
  "Which dates are open in our window?",
  "What does the site fee include (tables, chairs, linens, setup/teardown)?",
  "Is catering in-house only, or can we bring outside vendors?",
  "Food & beverage minimum, service charge %, and tax %?",
  "Deposit amount and payment schedule?",
  "Cancellation and postponement policy?",
  "Rain/backup plan for outdoor spaces?",
  "How many hours are included? Overtime cost?",
  "Alcohol policy and bar package options?",
  "Noise curfew or music restrictions?",
  "Getting-ready rooms for both of us?",
  "Parking, shuttles, and accessibility?",
  "Required insurance or day-of coordinator?",
  "Nearby hotels or room blocks?",
  "Any other events on-site the same day?"
];
const DATE_STATES = [["open", "Available"], ["hold", "On hold for us"], ["pref", "Our favorite"]];
const FILE_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_FILE = 10 * 1024 * 1024;   // per uploaded file; the database stores ~1.33x this
const CHUNK = 900000;                // characters per stored chunk (a node holds at most 10 MB)

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = n => n == null || isNaN(n) ? "—" : "$" + Math.round(n).toLocaleString("en-US");
const num = v => v === "" || v == null ? null : Number(v);
const live = obj => Object.entries(obj || {}).filter(([, v]) => v && typeof v === "object" && !v.deleted);
const byAt = ([, a], [, b]) => (a.at || 0) - (b.at || 0);
const parseDay = s => { if (!s) return null; const [y, m, d] = s.split("-").map(Number); return y ? new Date(y, m - 1, d) : null; };
const fmtDay = s => { const d = parseDay(s); return d ? d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" }) : "—"; };
const fmtTour = s => { if (!s) return "Not scheduled"; const d = new Date(s); return isNaN(d) ? s : d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); };
const fmtSize = n => !n ? "" : n < 1048576 ? Math.max(1, Math.round(n / 1024)) + " KB" : (n / 1048576).toFixed(1) + " MB";
const stars = n => n ? "★".repeat(Math.round(n)) + "☆".repeat(5 - Math.round(n)) : "";
const normCode = s => String(s || "").toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const personKey = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "someone";
const store = {
  get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} },
  del: k => { try { localStorage.removeItem(k); } catch (e) {} }
};

let fdb = null, base = "", me = { name: "", key: "" };
let settings = {}, venues = new Map(), loaded = false, unsubs = [];
let current = null, tab = "cards", builtFor = null;
const P = path => ref(fdb, path ? base + "/" + path : base);

// ---------- toast / banner ----------
let toastT;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 3500); }
function banner(msg) { const b = $("#banner"); b.textContent = msg || ""; b.hidden = !msg; }
const saveErr = e => { console.error(e); toast("Couldn't save that change. Check your connection and try again."); };

// ---------- writes ----------
// RTDB multi-path update: "questions.q1.answer" becomes the child path questions/q1/answer.
function writeVenue(id, field, val) {
  update(P("venues/" + id), { [field.split(".").join("/")]: val === undefined ? null : val }).catch(saveErr);
}
function writeSettings(key, val) {
  settings = { ...settings, [key]: val };
  update(P("settings"), { [key]: val === undefined ? null : val }).catch(saveErr);
}

// debounced text inputs
const pending = new Map();
function schedule(el, fn, ms = 600) {
  clearTimeout(pending.get(el)?.t);
  const t = setTimeout(() => { pending.delete(el); fn(); }, ms);
  pending.set(el, { t, fn });
}
function flush(el) { const p = pending.get(el); if (p) { clearTimeout(p.t); pending.delete(el); p.fn(); } }

function readInput(el) { if (el.type === "checkbox") return el.checked; return el.dataset.t === "num" ? num(el.value) : el.value; }
function setInput(el, v) {
  if (el === document.activeElement || pending.has(el)) return;
  if (el.type === "checkbox") el.checked = !!v;
  else { const s = v == null ? "" : String(v); if (el.value !== s) el.value = s; }
}
const getPath = (obj, path) => path.split(".").reduce((o, k) => o == null ? o : o[k], obj);

// ---------- estimate ----------
function estimate(v) {
  const guests = num(settings.guests) || 0;
  const site = num(v.siteFee) || 0, pp = num(v.perPerson) || 0, min = num(v.fbMinimum) || 0;
  const svcPct = num(v.servicePct) || 0, taxPct = num(v.taxPct) || 0, other = num(v.otherFees) || 0;
  const fbRaw = pp * guests, fb = Math.max(fbRaw, min);
  const svc = fb * svcPct / 100, sub = site + fb + svc + other, tax = sub * taxPct / 100;
  return { any: site || pp || min || other, site, fbRaw, fb, minApplied: min > fbRaw && min > 0, svc, svcPct, other, tax, taxPct, total: sub + tax, guests };
}
const budgetDelta = total => { const b = num(settings.budget); return b ? total - b : null; };
function ratingList(v) { return Object.entries(v.ratings || {}).filter(([, r]) => r && r.n > 0); }
function avgRating(v) { const r = ratingList(v); return r.length ? r.reduce((a, [, x]) => a + x.n, 0) / r.length : 0; }
function qCounts(v) { const q = live(v.questions); return { total: q.length, open: q.filter(([, x]) => !x.done).length }; }

// ---------- routing ----------
function go(id) { current = id; try { history.replaceState(null, "", id ? "#v-" + id : "#list"); } catch (e) {} render(); window.scrollTo(0, 0); }
const fromHash = () => { const m = /^#v-([A-Za-z0-9_-]+)$/.exec(location.hash); return m ? m[1] : null; };
window.addEventListener("hashchange", () => { const id = fromHash(); if (id !== current) { current = id; render(); } });

// ---------- render ----------
function render() {
  if (!base) return;
  const v = current && venues.get(current);
  $("#list-view").hidden = !!v;
  $("#detail-view").hidden = !v;
  renderSummary();
  if (v) { if (builtFor !== current) buildDetail(current); syncDetail(v); }
  else { builtFor = null; $("#detail-view").innerHTML = ""; renderList(); }
}

function renderSummary() {
  if (!loaded) return;
  const all = [...venues.values()];
  const c = s => all.filter(v => (v.status || "totour") === s).length;
  const parts = [`${all.length} venue${all.length === 1 ? "" : "s"}`];
  if (c("totour")) parts.push(`${c("totour")} to tour`);
  if (c("toured")) parts.push(`${c("toured")} toured`);
  if (c("shortlist")) parts.push(`${c("shortlist")} on the shortlist`);
  if (c("booked")) parts.push(`${c("booked")} booked`);
  $("#summary").textContent = parts.join(" · ");
}

function sortedVenues() {
  return [...venues.entries()].sort(([, a], [, b]) => {
    const s = (STATUS_ORDER[a.status || "totour"] ?? 9) - (STATUS_ORDER[b.status || "totour"] ?? 9);
    if (s) return s;
    return (a.tourAt || "9999").localeCompare(b.tourAt || "9999") || (a.name || "").localeCompare(b.name || "");
  });
}

function renderList() {
  document.querySelectorAll("[data-s]").forEach(el => setInput(el, settings[el.dataset.s]));
  ["cards", "compare", "dates"].forEach(t => { $("#tab-" + t).setAttribute("aria-pressed", tab === t); $("#" + t).hidden = tab !== t; });
  if (!loaded) return;
  const list = sortedVenues();
  if (!list.length) {
    $("#cards").innerHTML = `<div class="empty" style="grid-column:1/-1"><h3>No venues yet</h3><div>Add each place you're touring. It starts with a checklist of questions to ask, and you can both add notes, photos, costs, and open dates during the tour.</div><button type="button" class="primary" data-add>+ Add your first venue</button></div>`;
    $("#compare").innerHTML = `<div class="empty">Add venues to compare costs, ratings, and dates side by side.</div>`;
    $("#dates").innerHTML = `<div class="muted">Dates you add to each venue will be rolled up here, so you can spot a date that works at more than one place.</div>`;
    return;
  }
  $("#cards").innerHTML = list.map(([id, v]) => {
    const e = estimate(v), d = e.any ? budgetDelta(e.total) : null, q = qCounts(v), r = avgRating(v);
    const st = v.status || "totour", dates = live(v.dates).length;
    const cover = live(v.photos).sort(byAt)[0];
    return `<button type="button" class="card ${st === "out" ? "out" : ""}" data-open="${esc(id)}">
      ${cover ? `<img class="cover" src="${esc(cover[1].thumb)}" alt="">` : ""}
      <div class="row spread"><span class="pill s-${st}">${STATUS_LABEL[st]}</span>${r ? `<span class="stars" title="${r.toFixed(1)} of 5">${stars(r)}</span>` : ""}</div>
      <h3>${esc(v.name || "Untitled venue")}</h3>
      ${v.location ? `<div class="muted" style="font-size:.88rem">${esc(v.location)}</div>` : ""}
      <dl class="facts">
        <dt>Tour</dt><dd>${esc(fmtTour(v.tourAt))}</dd>
        <dt>All-in estimate</dt><dd>${e.any ? money(e.total) : "—"}${d != null ? ` <span class="${d > 0 ? "over" : "under"}">${d > 0 ? "+" : "−"}${money(Math.abs(d)).slice(1)}</span>` : ""}</dd>
        <dt>Questions</dt><dd>${q.total ? `${q.total - q.open}/${q.total} asked` : "—"}</dd>
        <dt>Open dates</dt><dd>${dates || "—"}</dd>
      </dl>
    </button>`;
  }).join("");
  $("#compare").innerHTML = `<div class="tablewrap"><table>
    <thead><tr><th>Venue</th><th>Status</th><th class="r">Capacity</th><th class="r">All-in est.</th><th class="r">vs budget</th><th class="r">Per guest</th><th>Rating</th><th class="r">Qs open</th><th class="r">Dates</th><th class="r">Features</th></tr></thead>
    <tbody>${list.map(([id, v]) => {
      const e = estimate(v), d = e.any ? budgetDelta(e.total) : null, q = qCounts(v), r = avgRating(v), st = v.status || "totour";
      const feats = Object.values(v.features || {}).filter(Boolean).length;
      const cap = num(v.capacity), g = num(settings.guests);
      return `<tr data-open="${esc(id)}">
        <td><strong>${esc(v.name || "Untitled venue")}</strong></td>
        <td><span class="pill s-${st}">${STATUS_LABEL[st]}</span></td>
        <td class="r ${cap && g && cap < g ? "over" : ""}">${cap ?? "—"}</td>
        <td class="r">${e.any ? money(e.total) : "—"}</td>
        <td class="r ${d == null ? "" : d > 0 ? "over" : "under"}">${d == null ? "—" : (d > 0 ? "+" : "−") + money(Math.abs(d)).slice(1)}</td>
        <td class="r">${e.any && e.guests ? money(e.total / e.guests) : "—"}</td>
        <td><span class="stars">${r ? stars(r) : "—"}</span></td>
        <td class="r">${q.total ? q.open : "—"}</td>
        <td class="r">${live(v.dates).length || "—"}</td>
        <td class="r">${feats}/${FEATURES.length}</td></tr>`;
    }).join("")}</tbody></table></div>`;
  const byDay = new Map();
  list.forEach(([id, v]) => {
    if ((v.status || "totour") === "out") return;
    live(v.dates).forEach(([, d]) => { if (!d.date) return; if (!byDay.has(d.date)) byDay.set(d.date, []); byDay.get(d.date).push({ id, name: v.name || "Untitled venue", state: d.state || "open", note: d.note }); });
  });
  const days = [...byDay.keys()].sort();
  $("#dates").innerHTML = `<div class="row spread"><h2>Open dates across venues</h2><span class="muted" style="font-size:.85rem">Ruled-out venues are hidden</span></div>` +
    (days.length ? `<div class="datelist">${days.map(day => {
      const xs = byDay.get(day);
      return `<div class="dateline ${xs.length > 1 ? "multi" : ""}"><div class="d num">${esc(fmtDay(day))}</div><div class="chips">${xs.map(x =>
        `<span class="chip ${x.state === "pref" ? "pref" : x.state === "hold" ? "hold" : ""}" title="${esc(x.note || "")}">${esc(x.name)}${x.state === "hold" ? " · on hold" : x.state === "pref" ? " · favorite" : ""}</span>`).join("")}</div></div>`;
    }).join("")}</div>` : `<div class="muted">No dates yet. Open a venue and add the dates they have available.</div>`);
}

// ---------- detail ----------
function field(label, f, opts = {}) {
  const input = `<input id="v-${f}" data-f="${f}" type="${opts.type || "text"}" ${opts.t ? `data-t="${opts.t}" inputmode="decimal" min="0" step="any"` : ""} placeholder="${esc(opts.ph || "")}">`;
  const wrapped = opts.money ? `<div class="money">${input}</div>` : opts.pct ? `<div class="pct">${input}</div>` : input;
  return `<label class="f"><span>${label}</span>${wrapped}</label>`;
}

function buildDetail(id) {
  builtFor = id;
  $("#detail-view").innerHTML = `
    <button type="button" class="back" data-back>← All venues</button>
    <section class="detail-head">
      <input class="name" id="v-name" data-f="name" placeholder="Venue name" aria-label="Venue name">
      <div class="grid">
        <label class="f"><span>Status</span><select id="v-status" data-f="status">${STATUSES.map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select></label>
        ${field("Tour date & time", "tourAt", { type: "datetime-local" })}
        ${field("Location", "location", { ph: "Town, or address" })}
      </div>
      <div class="webrow">${field("Website", "website", { type: "url", ph: "https://" })}<span id="weblink"></span></div>
    </section>

    <section class="panel">
      <h2>Our ratings</h2>
      <div id="ratings" class="notes"></div>
    </section>

    <section class="panel">
      <div class="row spread"><h2>Photos</h2><span class="upstatus" id="p-count"></span></div>
      <div class="uploader">
        <label class="btn" id="p-btn">+ Add photos<input type="file" id="p-input" accept="image/*" multiple></label>
        <span class="upstatus" id="p-status"></span>
      </div>
      <div class="photos" id="plist"></div>
    </section>

    <section class="panel">
      <div class="row spread"><h2>Questions to ask</h2><span class="qprog" id="qprog"></span></div>
      <div class="qlist" id="qlist"></div>
      <div class="row"><input id="q-new" type="text" placeholder="Add a question and press Enter" style="flex:1"><button type="button" id="q-add">Add</button></div>
    </section>

    <section class="panel">
      <h2>Available dates</h2>
      <div class="dl" id="dlist"></div>
      <div class="row"><input id="d-new" type="date" style="flex:1;max-width:200px"><button type="button" id="d-add">Add date</button></div>
    </section>

    <section class="panel">
      <h2>Cost</h2>
      <div class="grid">
        ${field("Site / rental fee", "siteFee", { t: "num", type: "number", money: 1, ph: "0" })}
        ${field("Food & drink per guest", "perPerson", { t: "num", type: "number", money: 1, ph: "0" })}
        ${field("F&B minimum", "fbMinimum", { t: "num", type: "number", money: 1, ph: "0" })}
        ${field("Service charge", "servicePct", { t: "num", type: "number", pct: 1, ph: "22" })}
        ${field("Tax", "taxPct", { t: "num", type: "number", pct: 1, ph: "8" })}
        ${field("Other fees", "otherFees", { t: "num", type: "number", money: 1, ph: "0" })}
        ${field("Deposit", "deposit", { t: "num", type: "number", money: 1, ph: "0" })}
        ${field("Max capacity (seated)", "capacity", { t: "num", type: "number", ph: "e.g. 180" })}
      </div>
      <div class="est" id="est"></div>
    </section>

    <section class="panel">
      <h2>Files</h2>
      <div class="uploader">
        <label class="btn alt" id="f-btn">+ Add files<input type="file" id="f-input" accept="application/pdf,.pdf,image/png,image/jpeg,image/webp,image/gif" multiple></label>
        <span class="upstatus" id="f-status">PDF brochures, pricing sheets, floor plans (up to 10 MB each)</span>
      </div>
      <div class="files" id="flist"></div>
    </section>

    <section class="panel">
      <h2>What they offer</h2>
      <div class="feat" id="feat"></div>
    </section>

    <section class="panel">
      <h2>Feedback</h2>
      <div class="addnote">
        <div class="row">
          <select id="n-kind" style="width:auto" aria-label="Kind of feedback">
            <option value="love">Loved</option><option value="concern">Concern</option><option value="note">Note</option>
          </select>
        </div>
        <textarea id="n-text" rows="3" placeholder="What stood out? The view, the bathrooms, the coordinator's vibe…"></textarea>
        <div><button type="button" class="primary" id="n-add">Add feedback</button></div>
      </div>
      <div class="notes" id="nlist"></div>
    </section>

    <section class="panel">
      <h2>Contact</h2>
      <div class="grid">
        ${field("Coordinator", "contactName", { ph: "Name" })}
        ${field("Phone / email", "contactInfo", { ph: "(555) 123-4567" })}
      </div>
    </section>

    <section class="panel">
      <div id="del-area"><button type="button" class="danger" id="del">Delete this venue</button></div>
    </section>`;
}

function syncDetail(v) {
  const root = $("#detail-view");

  // ratings: ratings/<person key> = {name, n}
  const rs = ratingList(v), mine = (v.ratings || {})[me.key]?.n || 0;
  $("#ratings").innerHTML =
    `<div class="rate-row"><span class="who">You</span><span role="group" aria-label="Your rating">${[1, 2, 3, 4, 5].map(n =>
      `<button type="button" class="starbtn ${n <= mine ? "on" : ""}" data-rate="${n}" aria-label="${n} star${n > 1 ? "s" : ""}">★</button>`).join("")}</span>${mine ? `<span class="muted">${mine}/5</span>` : `<span class="muted">Tap to rate</span>`}</div>` +
    rs.filter(([k]) => k !== me.key).map(([, r]) => `<div class="rate-row"><span class="who">${esc(r.name || "Someone")}</span><span class="stars" style="font-size:1.2rem">${stars(r.n)}</span><span class="muted">${r.n}/5</span></div>`).join("");

  // questions (keyed, so a field being typed in is never replaced)
  const qs = live(v.questions).sort(([, a], [, b]) => (a.order || 0) - (b.order || 0));
  syncKeyed($("#qlist"), qs, qid => {
    const row = document.createElement("div");
    row.className = "q"; row.dataset.key = qid;
    row.innerHTML = `<input type="checkbox" id="q-${qid}-d" data-f="questions.${qid}.done" aria-label="Asked">
      <textarea class="qt" id="q-${qid}-t" data-f="questions.${qid}.text" rows="2" aria-label="Question"></textarea>
      <button type="button" class="ghost" data-delq="${qid}" aria-label="Remove question">✕</button>
      <textarea id="q-${qid}-a" data-f="questions.${qid}.answer" rows="1" placeholder="Their answer"></textarea>`;
    return row;
  }, (row, [, q]) => row.classList.toggle("done", !!q.done));
  const qc = qCounts(v);
  $("#qprog").textContent = qc.total ? `${qc.total - qc.open} of ${qc.total} asked` : "";
  if (!qs.length) $("#qlist").innerHTML = `<div class="muted">No questions yet.</div>`;

  // dates (keyed)
  const ds = live(v.dates).sort(([, a], [, b]) => (a.date || "").localeCompare(b.date || ""));
  syncKeyed($("#dlist"), ds, did => {
    const row = document.createElement("div");
    row.className = "drow"; row.dataset.key = did;
    row.innerHTML = `<input type="date" id="d-${did}-date" data-f="dates.${did}.date" aria-label="Date">
      <select id="d-${did}-s" data-f="dates.${did}.state" aria-label="Status">${DATE_STATES.map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select>
      <input class="dnote" id="d-${did}-n" data-f="dates.${did}.note" placeholder="Note (price, time, hold expires…)" aria-label="Note">
      <button type="button" class="ghost" data-deld="${did}" aria-label="Remove date">✕</button>`;
    return row;
  });
  if (!ds.length) $("#dlist").innerHTML = `<div class="muted">No dates yet. Add each date they say is open, then mark holds and favorites.</div>`;

  root.querySelectorAll("[data-f]").forEach(el => setInput(el, getPath(v, el.dataset.f)));

  // estimate
  const e = estimate(v), b = num(settings.budget), d = b ? e.total - b : null;
  $("#est").innerHTML = !e.any ? `<div class="muted">Enter what they quote and you'll see an all-in estimate${e.guests ? ` for ${e.guests} guests` : ""}. Venues often quote prices "++", meaning service charge and tax come on top.</div>` : `
    <div class="est-total"><strong>${money(e.total)}</strong><span class="muted">all-in estimate${e.guests ? ` · ${e.guests} guests · ${money(e.total / e.guests)} per guest` : " · set a guest count on the main page"}</span></div>
    ${b ? `<div class="bar ${d > 0 ? "over" : ""}"><i style="width:${Math.min(100, e.total / b * 100).toFixed(1)}%"></i></div>
      <div class="${d > 0 ? "over" : "under"}">${d > 0 ? `${money(d)} over` : `${money(-d)} under`} your ${money(b)} budget</div>` : ""}
    <div class="breakdown">
      <span>Site fee</span><span>${money(e.site)}</span>
      <span>Food & drink${e.minApplied ? " (minimum applies)" : e.guests ? ` (${e.guests} × ${money(num(v.perPerson) || 0)})` : ""}</span><span>${money(e.fb)}</span>
      <span>Service charge ${e.svcPct ? `(${e.svcPct}% of F&B)` : ""}</span><span>${money(e.svc)}</span>
      <span>Other fees</span><span>${money(e.other)}</span>
      <span>Tax ${e.taxPct ? `(${e.taxPct}%)` : ""}</span><span>${money(e.tax)}</span>
      ${num(v.deposit) ? `<span>Deposit due to book</span><span>${money(num(v.deposit))}</span>` : ""}
    </div>`;
  const cap = num(v.capacity), g = num(settings.guests);
  $("#v-capacity").style.borderColor = cap && g && cap < g ? "var(--bad)" : "";

  // features
  const f = v.features || {};
  $("#feat").innerHTML = FEATURES.map(([k, l]) => `<button type="button" data-feat="${k}" aria-pressed="${!!f[k]}">${l}</button>`).join("");

  // feedback
  const ns = live(v.notes).sort(([, a], [, b]) => (b.at || 0) - (a.at || 0));
  const kindLabel = { love: "Loved", concern: "Concern", note: "Note" };
  $("#nlist").innerHTML = ns.length ? ns.map(([nid, n]) => `<div class="note ${esc(n.kind)}">
      <div class="meta"><strong>${esc(kindLabel[n.kind] || "Note")}</strong><span>·</span><span>${esc(n.by === me.name ? "You" : n.by || "")}</span><span>${n.at ? new Date(n.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""}</span>
      <button type="button" class="ghost" data-deln="${nid}" aria-label="Delete feedback" style="margin-left:auto">✕</button></div>
      <p>${esc(n.text)}</p></div>`).join("") : `<div class="muted">Nothing yet. Jot impressions during the tour while they're fresh.</div>`;

  // website
  const w = (v.website || "").trim();
  $("#weblink").innerHTML = /^https?:\/\//i.test(w) ? `<a href="${esc(w)}" target="_blank" rel="noopener">Open ↗</a>` : "";

  // photos (keyed, so thumbnails aren't rebuilt on every change)
  const ps = live(v.photos).sort(byAt);
  syncKeyed($("#plist"), ps, pid => {
    const btn = document.createElement("button");
    btn.type = "button"; btn.dataset.key = pid; btn.dataset.photo = pid; btn.setAttribute("aria-label", "Open photo");
    const img = document.createElement("img");
    img.alt = "Venue photo"; img.src = v.photos[pid].thumb || "";
    btn.append(img);
    return btn;
  });
  if (!ps.length) $("#plist").innerHTML = `<div class="muted" style="grid-column:1/-1">No photos yet. On your phone, Add photos lets you take one with the camera or pick from your library.</div>`;
  $("#p-count").textContent = ps.length ? `${ps.length} photo${ps.length === 1 ? "" : "s"}` : "";
  if (lb && lb.vid === current && !ps.some(([k]) => k === lb.pid)) drawLb();

  // files
  const fs = live(v.files).sort(byAt);
  $("#flist").innerHTML = fs.length ? fs.map(([fid, fl]) => {
    const pdf = /pdf/.test(fl.type || "");
    return `<div class="file"><span class="ico ${pdf ? "" : "img"}">${pdf ? "PDF" : "IMG"}</span>
      <span class="fn">${esc(fl.name || "File")}<small>${[fmtSize(fl.size), fl.by ? "from " + (fl.by === me.name ? "you" : fl.by) : "", fl.at ? new Date(fl.at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : ""].filter(Boolean).map(esc).join(" · ")}</small></span>
      <span data-open-slot="${fid}">${blobUrls.has(fl.blob) ? `<a href="${blobUrls.get(fl.blob)}" target="_blank" rel="noopener" download="${esc(fl.name || "file")}">Open ↗</a>` : `<button type="button" class="linkish" data-openf="${fid}">Open</button>`}</span>
      <button type="button" class="ghost" data-delf="${fid}" aria-label="Delete file">✕</button></div>`;
  }).join("") : `<div class="muted">No files yet.</div>`;
}

function syncKeyed(container, items, create, after) {
  const want = new Set(items.map(([k]) => k));
  [...container.children].forEach(ch => { if (!ch.dataset.key || !want.has(ch.dataset.key)) ch.remove(); });
  let prev = null;
  items.forEach(item => {
    const [k] = item;
    let row = [...container.children].find(ch => ch.dataset.key === k);
    if (!row) row = create(k);
    const anchor = prev ? prev.nextSibling : container.firstChild;
    if (row !== anchor) container.insertBefore(row, anchor);
    if (after) after(row, item);
    prev = row;
  });
}

// ---------- photos & files ----------
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => resolve({ img, done: () => URL.revokeObjectURL(url) });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("decode")); };
    img.src = url;
  });
}
function toJpeg(img, max, q) {
  const w = img.naturalWidth, h = img.naturalHeight, s = Math.min(1, max / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.round(w * s); c.height = Math.round(h * s);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", q);
}
const readDataUrl = file => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(file); });
function splitChunks(s) { const out = []; for (let i = 0; i < s.length; i += CHUNK) out.push(s.slice(i, i + CHUNK)); return out; }

async function uploadMany(input, kind) {
  const list = [...input.files]; input.value = "";
  if (!list.length || !current) return;
  const vid = current, photo = kind === "photo";
  const btn = $(photo ? "#p-btn" : "#f-btn");
  btn.classList.add("off");
  let ok = 0, lastMsg = "";
  for (let i = 0; i < list.length; i++) {
    const file = list[i];
    const st = $(photo ? "#p-status" : "#f-status");
    if (st) st.textContent = `Uploading ${i + 1} of ${list.length}…`;
    try {
      const blobId = push(P("blobs")).key, itemId = push(P("venues/" + vid + "/" + (photo ? "photos" : "files"))).key;
      const at = Date.now(), updates = {};
      if (photo) {
        const { img, done } = await loadImage(file);
        const full = toJpeg(img, 1800, 0.82), thumb = toJpeg(img, 360, 0.7);
        done();
        updates[`blobs/${blobId}`] = { type: "image/jpeg", parts: splitChunks(full) };
        updates[`venues/${vid}/photos/${itemId}`] = { thumb, blob: blobId, at, by: me.name };
      } else {
        let type = file.type || (/\.pdf$/i.test(file.name) ? "application/pdf" : "");
        if (!FILE_TYPES.includes(type)) throw new Error("Upload a PDF or a JPG, PNG, or WebP image.");
        if (file.size > MAX_FILE) throw new Error(`${file.name} is over 10 MB. Try a smaller version.`);
        const data = await readDataUrl(file);
        updates[`blobs/${blobId}`] = { type, parts: splitChunks(data) };
        updates[`venues/${vid}/files/${itemId}`] = { name: file.name, type, size: file.size, blob: blobId, at, by: me.name };
      }
      await update(P(""), updates);
      ok++;
    } catch (e) {
      console.error(e);
      lastMsg = e && e.message === "decode" ? "Couldn't read that photo. Try a JPG or PNG." : (e && e.message && !/^[A-Z_]+$/.test(e.message) && !e.code ? e.message : "Upload failed. Check your connection and try again.");
    }
  }
  btn.classList.remove("off");
  const st = $(photo ? "#p-status" : "#f-status");
  if (st) st.textContent = lastMsg ? `${ok} of ${list.length} uploaded` : (photo ? "" : "PDF brochures, pricing sheets, floor plans (up to 10 MB each)");
  toast(lastMsg || (ok === 1 ? (photo ? "Photo added" : "File added") : `${ok} ${photo ? "photos" : "files"} added`));
}

const blobUrls = new Map();
async function blobUrl(blobId) {
  if (blobUrls.has(blobId)) return blobUrls.get(blobId);
  const snap = await get(P("blobs/" + blobId));
  if (!snap.exists()) throw new Error("missing");
  const { parts } = snap.val();
  const blob = await (await fetch((Array.isArray(parts) ? parts : Object.values(parts)).join(""))).blob();
  const url = URL.createObjectURL(blob);
  blobUrls.set(blobId, url);
  return url;
}
async function openFile(slotEl, f) {
  slotEl.innerHTML = `<span class="muted">Loading…</span>`;
  try {
    const url = await blobUrl(f.blob);
    slotEl.innerHTML = `<a href="${url}" target="_blank" rel="noopener" download="${esc(f.name || "file")}">Open ↗</a>`;
    slotEl.querySelector("a").click();
  } catch (e) {
    slotEl.innerHTML = `<button type="button" class="linkish" data-openf="${slotEl.dataset.openSlot}">Retry</button>`;
    toast("Couldn't load that file. Check your connection and try again.");
  }
}
function armDelete(btn, label) {
  if (btn.dataset.armed) return true;
  btn.dataset.armed = "1"; const prev = btn.textContent; btn.textContent = label;
  setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = prev; } }, 3000);
  return false;
}

// ---------- lightbox ----------
let lb = null;
function drawLb() {
  let el = $("#lb");
  const v = lb && venues.get(lb.vid);
  const ps = v ? live(v.photos).sort(byAt) : [];
  const i = lb ? ps.findIndex(([k]) => k === lb.pid) : -1;
  if (i < 0) { lb = null; if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement("div"); el.id = "lb"; el.className = "lightbox";
    el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-label", "Photo viewer");
    document.body.append(el);
  }
  const [pid, p] = ps[i];
  const who = p.by ? (p.by === me.name ? "you" : p.by) : "";
  el.innerHTML = `<div class="bar-top"><span class="meta">${esc(v.name || "Venue")} · ${i + 1} of ${ps.length}${who ? " · added by " + esc(who) : ""}</span><button type="button" data-lb="close">Close</button></div>
    <div class="lb-img"><img id="lb-img" src="${esc(blobUrls.get(p.blob) || p.thumb || "")}" alt="Photo ${i + 1} of ${esc(v.name || "venue")}"></div>
    <div class="bar-bot"><span class="row"><button type="button" data-lb="prev" ${i === 0 ? "disabled" : ""}>‹ Prev</button><button type="button" data-lb="next" ${i === ps.length - 1 ? "disabled" : ""}>Next ›</button></span>
    <span class="row"><span id="lb-full"></span><button type="button" class="del" data-lb="del">Delete</button></span></div>`;
  blobUrl(p.blob).then(url => {
    if (!lb || lb.pid !== pid) return;
    $("#lb-img").src = url;
    $("#lb-full").innerHTML = `<a href="${url}" target="_blank" rel="noopener" download="photo.jpg" style="color:#CFE3DC">Full size ↗</a>`;
  }).catch(() => {});
}
function stepLb(d) {
  const v = venues.get(lb.vid), ps = live(v && v.photos).sort(byAt);
  const i = ps.findIndex(([k]) => k === lb.pid) + d;
  if (ps[i]) { lb.pid = ps[i][0]; drawLb(); }
}

// ---------- export ----------
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a"); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
function exportNotes() {
  const L = [`# Venue tours`, ``, `Exported ${new Date().toLocaleString("en-US")}`, ``];
  if (settings.guests || settings.budget || settings.window) L.push(`Guests: ${settings.guests || "—"} · Venue budget: ${settings.budget ? money(settings.budget) : "—"} · Date window: ${settings.window || "—"}`, ``);
  sortedVenues().forEach(([, v]) => {
    const e = estimate(v);
    L.push(`## ${v.name || "Untitled venue"}`, ``);
    L.push(`- Status: ${STATUS_LABEL[v.status || "totour"]}`);
    if (v.location) L.push(`- Location: ${v.location}`);
    if (v.website) L.push(`- Website: ${v.website}`);
    if (v.tourAt) L.push(`- Tour: ${fmtTour(v.tourAt)}`);
    if (v.contactName || v.contactInfo) L.push(`- Contact: ${[v.contactName, v.contactInfo].filter(Boolean).join(", ")}`);
    if (v.capacity) L.push(`- Capacity: ${v.capacity}`);
    if (e.any) L.push(`- All-in estimate: ${money(e.total)}${e.guests ? ` (${money(e.total / e.guests)} per guest)` : ""}`);
    const rs = ratingList(v); if (rs.length) L.push(`- Ratings: ${rs.map(([, r]) => `${r.name} ${r.n}/5`).join(", ")}`);
    const feats = FEATURES.filter(([k]) => (v.features || {})[k]).map(([, l]) => l); if (feats.length) L.push(`- Offers: ${feats.join(", ")}`);
    const ds = live(v.dates).sort(([, a], [, b]) => (a.date || "").localeCompare(b.date || ""));
    if (ds.length) { L.push(``, `### Available dates`); ds.forEach(([, d]) => L.push(`- ${fmtDay(d.date)} (${(DATE_STATES.find(([k]) => k === d.state) || DATE_STATES[0])[1]})${d.note ? ": " + d.note : ""}`)); }
    const qs = live(v.questions).sort(([, a], [, b]) => (a.order || 0) - (b.order || 0)).filter(([, q]) => q.done || q.answer);
    if (qs.length) { L.push(``, `### Questions`); qs.forEach(([, q]) => L.push(`- **${q.text}**${q.answer ? `\n  ${q.answer.replace(/\n/g, "\n  ")}` : ""}`)); }
    const ns = live(v.notes).sort(byAt);
    if (ns.length) { L.push(``, `### Feedback`); ns.forEach(([, n]) => L.push(`- ${({ love: "Loved", concern: "Concern" })[n.kind] || "Note"} (${n.by || "?"}): ${n.text.replace(/\n/g, " ")}`)); }
    L.push(``);
  });
  download(`venue-tours-${new Date().toISOString().slice(0, 10)}.md`, L.join("\n"), "text/markdown");
}
function exportBackup() {
  const data = { exportedAt: new Date().toISOString(), settings, venues: Object.fromEntries(venues) };
  download(`venue-tours-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2), "application/json");
}

// ---------- events ----------
document.addEventListener("input", e => {
  const el = e.target;
  if (el.dataset.s) { const k = el.dataset.s; schedule(el, () => writeSettings(k, readInput(el))); return; }
  if (el.dataset.f && current) {
    if (el.tagName === "SELECT" || el.type === "checkbox" || el.type === "date" || el.type === "datetime-local") return;
    const id = current, f = el.dataset.f;
    schedule(el, () => writeVenue(id, f, readInput(el)));
  }
});
document.addEventListener("change", e => {
  const el = e.target;
  if (el.id === "p-input") return uploadMany(el, "photo");
  if (el.id === "f-input") return uploadMany(el, "file");
  if (el.dataset.s) { flush(el); return; }
  if (el.dataset.f && current) {
    if (el.tagName === "SELECT" || el.type === "checkbox" || el.type === "date" || el.type === "datetime-local") writeVenue(current, el.dataset.f, readInput(el));
    else flush(el);
  }
});
document.addEventListener("focusout", e => { if (pending.has(e.target)) flush(e.target); });

document.addEventListener("click", e => {
  const t = e.target.closest("button, tr[data-open]");
  if (!t) return;
  if (t.id === "gate-go") return unlock();
  if (t.id === "gate-create") return createTracker();
  if (t.id === "gate-back") { $("#gate-new").hidden = true; $("#gate-form").hidden = false; return; }
  if (!base) return;
  if (t.dataset.open) return go(t.dataset.open);
  if (t.id === "tab-cards" || t.id === "tab-compare" || t.id === "tab-dates") { tab = t.id.slice(4); return renderList(); }
  if (t.id === "add-venue" || "add" in t.dataset) return addVenue();
  if (t.id === "export-md") return exportNotes();
  if (t.id === "export-json") return exportBackup();
  if (t.id === "lock") return lock();
  if ("back" in t.dataset) return go(null);
  if (t.dataset.lb) {
    const a = t.dataset.lb;
    if (a === "close") { lb = null; return drawLb(); }
    if (a === "prev") return stepLb(-1);
    if (a === "next") return stepLb(1);
    if (a === "del" && armDelete(t, "Tap again to delete")) {
      const vid = lb.vid, pid = lb.pid, p = venues.get(vid)?.photos?.[pid];
      lb = null; drawLb();
      if (p) update(P(""), { [`venues/${vid}/photos/${pid}`]: null, [`blobs/${p.blob}`]: null }).then(() => toast("Photo deleted")).catch(saveErr);
    }
    return;
  }
  if (!current) return;
  const id = current, v = venues.get(id) || {};
  if (t.dataset.photo) { lb = { vid: id, pid: t.dataset.photo }; return drawLb(); }
  if (t.dataset.rate) { const n = Number(t.dataset.rate); writeVenue(id, "ratings." + me.key, (v.ratings || {})[me.key]?.n === n ? null : { name: me.name, n }); return; }
  if (t.dataset.feat) { writeVenue(id, "features." + t.dataset.feat, (v.features || {})[t.dataset.feat] ? null : true); return; }
  if (t.dataset.delq) { writeVenue(id, "questions." + t.dataset.delq, null); return; }
  if (t.dataset.deld) { writeVenue(id, "dates." + t.dataset.deld, null); return; }
  if (t.dataset.deln) { if (armDelete(t, "Delete?")) writeVenue(id, "notes." + t.dataset.deln, null); return; }
  if (t.dataset.openf) { const f = (v.files || {})[t.dataset.openf]; if (f) openFile(t.parentElement, f); return; }
  if (t.dataset.delf) {
    if (armDelete(t, "Delete?")) { const f = (v.files || {})[t.dataset.delf]; update(P(""), { [`venues/${id}/files/${t.dataset.delf}`]: null, ...(f && f.blob ? { [`blobs/${f.blob}`]: null } : {}) }).catch(saveErr); }
    return;
  }
  if (t.id === "q-add") return addQuestion();
  if (t.id === "d-add") return addDate();
  if (t.id === "n-add") return addNote();
  if (t.id === "del") {
    $("#del-area").innerHTML = `<div class="confirm"><span>Delete <strong>${esc(v.name || "this venue")}</strong> and all its notes, photos, files, and dates?</span><button type="button" class="danger" id="del-yes">Delete</button><button type="button" id="del-no">Cancel</button></div>`;
    return;
  }
  if (t.id === "del-no") { $("#del-area").innerHTML = `<button type="button" class="danger" id="del">Delete this venue</button>`; return; }
  if (t.id === "del-yes") {
    const updates = { [`venues/${id}`]: null };
    [...live(v.photos), ...live(v.files)].forEach(([, x]) => { if (x.blob) updates[`blobs/${x.blob}`] = null; });
    update(P(""), updates).then(() => toast("Venue deleted")).catch(saveErr);
    go(null);
  }
});
document.addEventListener("keydown", e => {
  if (lb) {
    if (e.key === "Escape") { lb = null; drawLb(); return; }
    if (e.key === "ArrowLeft") return stepLb(-1);
    if (e.key === "ArrowRight") return stepLb(1);
  }
  if (e.key === "Enter" && e.target.id === "q-new") { e.preventDefault(); addQuestion(); }
  if (e.key === "Enter" && (e.target.id === "gate-code" || e.target.id === "gate-name")) { e.preventDefault(); unlock(); }
});

function addQuestion() {
  const el = $("#q-new"), text = el.value.trim();
  if (!text || !current) return;
  writeVenue(current, "questions." + push(P("x")).key, { text, answer: "", done: false, order: Date.now() });
  el.value = "";
}
function addDate() {
  const el = $("#d-new");
  if (!el.value || !current) { el.focus(); return; }
  writeVenue(current, "dates." + push(P("x")).key, { date: el.value, state: "open", note: "" });
  el.value = "";
}
function addNote() {
  const el = $("#n-text"), text = el.value.trim();
  if (!text || !current) { el.focus(); return; }
  writeVenue(current, "notes." + push(P("x")).key, { text, kind: $("#n-kind").value, by: me.name, at: Date.now() });
  el.value = "";
}
function addVenue() {
  const r = push(P("venues"));
  const questions = {};
  DEFAULT_QUESTIONS.forEach((text, i) => questions["q" + String(i).padStart(2, "0")] = { text, answer: "", done: false, order: i });
  const body = { name: "", status: "totour", questions, createdAt: Date.now() };
  venues.set(r.key, body);
  go(r.key);
  setTimeout(() => $("#v-name")?.focus(), 30);
  set(r, body).catch(saveErr);
}

// ---------- access code gate ----------
function showGate(msg) {
  $("#gate").hidden = false; $("#app").hidden = true;
  $("#gate-form").hidden = false; $("#gate-new").hidden = true;
  $("#gate-err").textContent = msg || ""; $("#gate-err").hidden = !msg;
  $("#gate-name").value = store.get("vt-name") || "";
}
async function unlock() {
  const code = normCode($("#gate-code").value), name = $("#gate-name").value.trim();
  const err = m => { $("#gate-err").textContent = m; $("#gate-err").hidden = false; };
  if (code.length < 16) return err("That code is too short. Check it and try again. It looks like VENUE-XXXX-XXXX-XXXX.");
  if (!name) return err("Add your first name so your partner can see who wrote each note.");
  $("#gate-go").disabled = true;
  try {
    const snap = await get(ref(fdb, "venuetracker/" + code + "/meta"));
    if (!snap.exists()) { $("#gate-form").hidden = true; $("#gate-new").hidden = false; $("#gate-newcode").textContent = code; return; }
    enter(code, name);
  } catch (e) {
    console.error(e);
    err(/permission/i.test(String(e && e.message)) ? "The database refused access. The rules from database.rules.json may not be published yet (see README)." : "Couldn't reach the database. Check your connection and try again.");
  } finally { $("#gate-go").disabled = false; }
}
async function createTracker() {
  const code = normCode($("#gate-code").value), name = $("#gate-name").value.trim();
  try { await set(ref(fdb, "venuetracker/" + code + "/meta"), { createdAt: Date.now() }); enter(code, name); }
  catch (e) { console.error(e); showGate("Couldn't create the tracker. Check your connection and try again."); }
}
function enter(code, name) {
  me = { name, key: personKey(name) };
  base = "venuetracker/" + code;
  if ($("#gate-remember").checked) { store.set("vt-code", code); store.set("vt-name", name); } else store.del("vt-code");
  $("#gate").hidden = true; $("#app").hidden = false;
  $("#whoami").textContent = name;
  current = fromHash();
  unsubs.forEach(u => u()); unsubs = [];
  unsubs.push(onValue(P("settings"), s => { settings = s.val() || {}; render(); }, onDbErr));
  unsubs.push(onValue(P("venues"), s => {
    venues = new Map(Object.entries(s.val() || {}));
    loaded = true;
    render();
  }, onDbErr));
  render();
}
function onDbErr(e) { console.error(e); banner("Lost access to the tracker. Reload the page, and check the code if it keeps happening."); }
function lock() {
  unsubs.forEach(u => u()); unsubs = [];
  store.del("vt-code");
  base = ""; venues = new Map(); settings = {}; loaded = false; current = null; builtFor = null;
  $("#gate-code").value = "";
  showGate();
}

// ---------- boot ----------
if (!FIREBASE_CONFIGURED) {
  $("#gate").hidden = false;
  $("#gate-form").innerHTML = `<p>This copy isn't connected to a database yet. Paste your Firebase project's config into <code>firebase-config.js</code> (see README.md).</p>`;
} else {
  fdb = getDatabase(initializeApp(FIREBASE_CONFIG));
  const code = store.get("vt-code"), name = store.get("vt-name");
  if (code && name) enter(code, name);
  else showGate();
}
