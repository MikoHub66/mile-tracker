import { api, demo, geocode, route } from "./store.js";
import { createTable, download } from "./table.js";
import { addBasemaps } from "./shared/basemaps.js";
import {
  USES, EXCLUDE_REASONS, useById, excludeLabel, fmtTime, shortAddress, decodePolyline, encodePolyline,
  localParts, browserTz, applyWallClock, round2, MONTHS, reportTrips, monthSummary, buildCsv, buildTableCsv, needsReview, learnUse,
} from "./shared/trips.js";

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const pad = (n) => String(n).padStart(2, "0");
const todayStr = () => localParts(Date.now(), browserTz()).date;

const state = {
  day: todayStr(),
  month: todayStr().slice(0, 7),
  monthTrips: [],
  vehicles: [],
  automation: {},
  selected: null,
  pendingSelect: null,
  wholeMonth: false,
  showRemoved: false,
};
let unsubMonth = null;

// ---------------- toast / dialog ----------------

let toastT;
function toast(msg, action) {
  const el = $("#toast");
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button>${esc(action.label)}</button>` : ""}`;
  el.hidden = false;
  if (action) el.querySelector("button").onclick = () => { el.hidden = true; action.run(); };
  clearTimeout(toastT);
  toastT = setTimeout(() => (el.hidden = true), action ? 6000 : 3000);
}
const dlg = $("#dlg");
function openDialog(html, onMount) {
  $("#dlgBody").innerHTML = `<div class="dlg">${html}</div>`;
  if (!dlg.open) dlg.showModal();
  onMount?.($("#dlgBody"));
}
const closeDialog = () => dlg.close();
dlg.addEventListener("click", (e) => {
  if (e.target === dlg || e.target.closest("[data-close]")) closeDialog();
});

// ---------------- map ----------------

const map = L.map("map", { zoomControl: true }).setView([39.8, -95.6], 4);
addBasemaps(map);
const tripLayer = L.layerGroup().addTo(map);
const lines = new Map();

function tripPoints(t) {
  const pts = decodePolyline(t.path);
  if (pts.length >= 2) return pts;
  if (Number.isFinite(t.startLat) && Number.isFinite(t.endLat)) return [[t.startLat, t.startLng], [t.endLat, t.endLng]];
  return [];
}

function popupHtml(t) {
  return `<b>${fmtTime(t.startTs, t.tz)} – ${fmtTime(t.endTs, t.tz)}</b> · ${Number(t.miles).toFixed(1)} mi<br>
    ${esc(shortAddress(t.startAddress))} →<br>${esc(shortAddress(t.endAddress))}<br>
    <span style="color:${useById(t.use).color};font-weight:700">${t.excluded ? "Removed: " + esc(excludeLabel(t.excludedReason)) : esc(useById(t.use).label)}</span>`;
}

function drawMap(fit = true) {
  tripLayer.clearLayers();
  lines.clear();
  const trips = visibleTrips(state.wholeMonth);
  const bounds = [];
  for (const t of trips) {
    const pts = tripPoints(t);
    if (!pts.length) continue;
    const sel = t.id === state.selected;
    const color = t.excluded ? "#8a8f98" : useById(t.use).color;
    const line = L.polyline(pts, { color, weight: sel ? 7 : 4, opacity: sel || !state.selected ? 0.95 : 0.45, dashArray: t.excluded ? "6 8" : null })
      .bindPopup(popupHtml(t))
      .on("click", () => select(t.id, false))
      .addTo(tripLayer);
    lines.set(t.id, line);
    if (sel || !state.wholeMonth) {
      L.circleMarker(pts[0], { radius: 5, color: "#fff", weight: 2, fillColor: "#6b7380", fillOpacity: 1 }).addTo(tripLayer);
      L.circleMarker(pts[pts.length - 1], { radius: 6, color: "#fff", weight: 2, fillColor: color, fillOpacity: 1 }).addTo(tripLayer);
    }
    bounds.push(...pts);
  }
  if (state.selected && lines.has(state.selected)) lines.get(state.selected).bringToFront();
  if (fit && bounds.length) map.fitBounds(L.latLngBounds(bounds), { padding: [30, 30], maxZoom: 15 });
}

// ---------------- data ----------------

function visibleTrips(whole) {
  return state.monthTrips
    .filter((t) => (whole ? true : t.date === state.day))
    .filter((t) => state.showRemoved || !t.excluded)
    .sort((a, b) => a.startTs - b.startTs);
}

function monthRange(ym) {
  const [y, m] = ym.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return [`${ym}-01`, `${ym}-${pad(last)}`];
}

function watchMonth() {
  unsubMonth?.();
  const [from, to] = monthRange(state.month);
  let first = true;
  unsubMonth = api.watchTrips(from, to, (trips) => {
    state.monthTrips = trips;
    renderAll(first && !state.pendingSelect);
    if (state.pendingSelect && trips.some((t) => t.id === state.pendingSelect)) {
      const id = state.pendingSelect;
      state.pendingSelect = null;
      select(id);
    }
    first = false;
  });
}

// ---------------- calendar & list ----------------

function renderCalendar() {
  const [y, m] = state.month.split("-").map(Number);
  $("#monthLabel").textContent = `${MONTHS[m - 1]} ${y}`;
  const firstDow = new Date(y, m - 1, 1).getDay();
  const days = new Date(y, m, 0).getDate();
  const byDay = {};
  for (const t of state.monthTrips) {
    if (t.excluded) continue;
    const d = (byDay[t.date] ||= { miles: 0, review: 0 });
    d.miles += Number(t.miles || 0);
    if (needsReview(t)) d.review++;
  }
  const today = todayStr();
  let html = ["S", "M", "T", "W", "T", "F", "S"].map((d) => `<div class="dow">${d}</div>`).join("");
  for (let i = 0; i < firstDow; i++) html += `<button class="cal-day" disabled></button>`;
  for (let d = 1; d <= days; d++) {
    const date = `${state.month}-${pad(d)}`;
    const info = byDay[date];
    const cls = ["cal-day", info && "has", date === state.day && "sel", date === today && "today"].filter(Boolean).join(" ");
    html += `<button class="${cls}" data-date="${date}">${d}${info ? `<small>${info.miles.toFixed(0)} mi</small>` : ""}${info?.review ? `<span class="rv" title="${info.review} to review"></span>` : ""}</button>`;
  }
  $("#calGrid").innerHTML = html;

  const active = state.monthTrips.filter((t) => !t.excluded);
  const sums = monthSummary(active)[state.month] || { total: 0 };
  const review = active.filter(needsReview).length;
  $("#monthStats").innerHTML =
    USES.filter((u) => sums[u.id]).map((u) => `<span><i style="background:${u.color}"></i>${esc(u.label)} <b>${sums[u.id].toFixed(1)}</b></span>`).join("") +
    `<span>Total <b>${(sums.total || 0).toFixed(1)} mi</b></span>` + (review ? `<span style="color:#c0392b">${review} to review</span>` : "");
}

function tripCard(t) {
  const u = useById(t.use);
  const chips = t.excluded
    ? `<button data-act="restore">Restore</button>`
    : USES.filter((x) => x.id !== "unclassified").map((x) => `<button data-act="use" data-use="${x.id}" style="--c:${x.color}" class="${t.use === x.id ? "on" : ""}">${esc(x.label)}</button>`).join("");
  const tags = [
    t.vehicle && `<span>${esc(t.vehicle)}</span>`,
    t.source === "manual" && `<span class="tag">manual</span>`,
    t.autoRule && `<span class="tag" title="Classified automatically">auto</span>`,
    t.excluded && `<span class="tag">Removed: ${esc(excludeLabel(t.excludedReason))}</span>`,
    t.miles !== t.gpsMiles && t.gpsMiles != null && t.source !== "manual" && `<span class="tag" title="GPS measured ${Number(t.gpsMiles).toFixed(2)} mi">edited</span>`,
  ].filter(Boolean).join("");
  return `<div class="trip ${t.excluded ? "removed" : ""} ${t.id === state.selected ? "sel" : ""}" style="--c:${t.excluded ? "#8a8f98" : u.color}" data-id="${esc(t.id)}">
    <div class="trip-top"><span class="time">${state.wholeMonth ? esc(t.date.slice(5).replace("-", "/")) + " · " : ""}${fmtTime(t.startTs, t.tz)} – ${fmtTime(t.endTs, t.tz)}</span><span class="mi">${Number(t.miles || 0).toFixed(1)} mi</span></div>
    <div class="addr"><div>${esc(t.startPlace || shortAddress(t.startAddress))}</div><div>${esc(t.endPlace || shortAddress(t.endAddress))}</div></div>
    <div class="trip-foot"><div class="tags">${tags}</div><div class="use-chips">${chips}<button data-act="edit" title="Edit every field">Edit</button></div></div>
  </div>`;
}

function renderList() {
  const [y, m, d] = state.day.split("-").map(Number);
  $("#dayLabel").textContent = state.wholeMonth
    ? `All of ${MONTHS[+state.month.slice(5) - 1]}`
    : new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric", year: "numeric" });
  $("#dayPick").value = state.day;
  const trips = visibleTrips(state.wholeMonth);
  const miles = trips.filter((t) => !t.excluded).reduce((a, t) => a + Number(t.miles || 0), 0);
  $("#dayMiles").textContent = trips.length ? `${miles.toFixed(1)} mi · ${trips.length} trip${trips.length > 1 ? "s" : ""}` : "";
  $("#dayList").innerHTML = trips.length
    ? trips.map(tripCard).join("")
    : `<div class="empty">No trips ${state.wholeMonth ? "this month" : "this day"}.<br><button class="link" id="emptyAdd">Add a manual trip</button></div>`;
}

function renderAll(fit = true) {
  renderCalendar();
  renderList();
  drawMap(fit);
}

function setDay(date, fit = true) {
  state.day = date;
  state.selected = null;
  const ym = date.slice(0, 7);
  if (ym !== state.month) {
    state.month = ym;
    watchMonth();
  } else renderAll(fit);
}

function select(id, fly = true) {
  state.selected = state.selected === id ? null : id;
  renderList();
  drawMap(false);
  const line = lines.get(id);
  if (line && state.selected) {
    if (fly) map.fitBounds(line.getBounds(), { padding: [40, 40], maxZoom: 16 });
    line.openPopup();
    document.querySelector(`.trip[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
  }
}

$("#calGrid").onclick = (e) => {
  const b = e.target.closest("[data-date]");
  if (b) {
    state.wholeMonth = false;
    $("#wholeMonth").checked = false;
    setDay(b.dataset.date);
  }
};
const shiftMonth = (n) => {
  const [y, m] = state.month.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  setDay(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`);
};
$("#prevMonth").onclick = () => shiftMonth(-1);
$("#nextMonth").onclick = () => shiftMonth(1);
const shiftDay = (n) => {
  const [y, m, d] = state.day.split("-").map(Number);
  const x = new Date(y, m - 1, d + n);
  setDay(`${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`);
};
$("#prevDay").onclick = () => shiftDay(-1);
$("#nextDay").onclick = () => shiftDay(1);
$("#dayPick").onchange = (e) => e.target.value && setDay(e.target.value);
$("#wholeMonth").onchange = (e) => { state.wholeMonth = e.target.checked; state.selected = null; renderAll(); };
$("#showRemoved").onchange = (e) => { state.showRemoved = e.target.checked; renderAll(false); };
document.addEventListener("keydown", (e) => {
  if (dlg.open || /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName)) return;
  if (e.key === "ArrowLeft") shiftDay(-1);
  if (e.key === "ArrowRight") shiftDay(1);
});

$("#dayList").onclick = async (e) => {
  if (e.target.id === "emptyAdd") return editTrip(null);
  const card = e.target.closest(".trip");
  if (!card) return;
  const t = state.monthTrips.find((x) => x.id === card.dataset.id);
  const b = e.target.closest("button[data-act]");
  if (!b) return select(t.id);
  try {
    if (b.dataset.act === "use") {
      const prev = { use: t.use, autoRule: t.autoRule || "", useLocked: !!t.useLocked };
      await api.updateTrip(t.id, { use: b.dataset.use, autoRule: "", useLocked: true });
      toast(`Marked ${useById(b.dataset.use).label}`, { label: "Undo", run: () => api.updateTrip(t.id, prev) });
    } else if (b.dataset.act === "restore") await api.updateTrip(t.id, { excluded: false, excludedReason: "" });
    else if (b.dataset.act === "edit") editTrip(t);
  } catch (err) {
    toast(err.message);
  }
};

// ---------------- trip editor (edit any field / manual trip) ----------------

function vehicleOptions(selId, selName) {
  const opts = state.vehicles.map((v) => `<option value="${esc(v.id)}" ${v.id === selId || (!selId && v.name === selName) ? "selected" : ""}>${esc(v.name)}</option>`);
  if (selName && !state.vehicles.some((v) => v.id === selId || v.name === selName)) opts.unshift(`<option value="__name" selected>${esc(selName)}</option>`);
  return `<option value="">—</option>${opts.join("")}<option value="__new">+ Add vehicle…</option>`;
}

function editTrip(t) {
  const isNew = !t;
  const tz = t?.tz || browserTz();
  const defV = state.vehicles.find((v) => v.id === state.automation.defaultVehicleId) || state.vehicles[0];
  t = t || {
    source: "manual", date: state.day, tz, startTs: null, endTs: null, startAddress: "", endAddress: "",
    miles: 0, use: "unclassified", vehicleId: defV?.id || "", vehicle: defV?.name || "", notes: "", excluded: false, excludedReason: "", path: "",
  };
  const st = t.startTs ? localParts(t.startTs, tz).time : "09:00";
  const et = t.endTs ? localParts(t.endTs, tz).time : "09:30";
  let routed = null;
  openDialog(
    `<h2>${isNew ? "Add a manual trip" : "Edit trip"}</h2>
     ${isNew ? `<p class="hint">For drives the phone missed (battery died, tracking off). Enter both addresses and press Calculate to get the driving miles.</p>` : ""}
     <form id="tf">
       <div class="grid3">
         <label class="field"><span>Date</span><input type="date" name="date" required value="${esc(t.date)}"></label>
         <label class="field"><span>Start time</span><input type="time" name="startTime" required value="${st}"></label>
         <label class="field"><span>End time</span><input type="time" name="endTime" required value="${et}"></label>
       </div>
       <label class="field"><span>Starting address</span><input name="startAddress" value="${esc(t.startAddress)}" autocomplete="off"></label>
       <label class="field"><span>Ending address</span><input name="endAddress" value="${esc(t.endAddress)}" autocomplete="off"></label>
       <div class="inline">
         <label class="field"><span>Miles traveled</span><input type="number" step="0.01" min="0" name="miles" required value="${Number(t.miles || 0)}"></label>
         <button type="button" class="btn" id="calc" style="margin-bottom:8px">Calculate from addresses</button>
       </div>
       <p class="hint" id="calcMsg">${!isNew && t.gpsMiles != null && t.source !== "manual" ? `GPS measured ${Number(t.gpsMiles).toFixed(2)} mi.` : ""}</p>
       <div class="grid2">
         <label class="field"><span>Vehicle</span><select name="vehicleId">${vehicleOptions(t.vehicleId, t.vehicle)}</select></label>
         <label class="field"><span>Use</span><select name="use">${USES.map((u) => `<option value="${u.id}" ${t.use === u.id ? "selected" : ""}>${esc(u.label)}</option>`).join("")}</select></label>
       </div>
       <div class="grid2">
         <label class="field"><span>Counted in reports?</span><select name="excluded"><option value="">Yes, I drove</option><option value="1" ${t.excluded ? "selected" : ""}>No, remove it</option></select></label>
         <label class="field" id="reasonField" ${t.excluded ? "" : "hidden"}><span>Because it was a…</span><select name="excludedReason">${EXCLUDE_REASONS.map((r) => `<option value="${r.id}" ${t.excludedReason === r.id ? "selected" : ""}>${esc(r.label)}</option>`).join("")}</select></label>
       </div>
       <label class="field"><span>Notes</span><textarea name="notes" rows="2">${esc(t.notes)}</textarea></label>
       <div class="err" id="tErr"></div>
       <div class="dlg-actions">
         ${isNew ? "" : `<button type="button" class="btn danger" id="del">Delete</button>`}
         <span class="spacer"></span>
         <button type="button" class="btn" data-close>Cancel</button>
         <button class="btn primary">${isNew ? "Add trip" : "Save"}</button>
       </div>
     </form>`,
    (el) => {
      const f = $("#tf", el);
      f.excluded.onchange = () => ($("#reasonField", el).hidden = !f.excluded.value);
      f.vehicleId.onchange = async () => {
        if (f.vehicleId.value !== "__new") return;
        const name = prompt("Vehicle name (as it should appear in reports)");
        if (!name) return (f.vehicleId.value = "");
        const v = await api.saveVehicle({ name: name.trim() });
        state.vehicles = [...state.vehicles.filter((x) => x.id !== v.id), v];
        f.vehicleId.innerHTML = vehicleOptions(v.id, v.name);
      };
      $("#calc", el).onclick = async () => {
        const msg = $("#calcMsg", el);
        if (!f.startAddress.value.trim() || !f.endAddress.value.trim()) return (msg.textContent = "Enter both addresses first.");
        msg.textContent = "Looking up addresses…";
        try {
          const a = await geocode(f.startAddress.value);
          await new Promise((r) => setTimeout(r, 1100)); // Nominatim: max 1 request per second
          const b = await geocode(f.endAddress.value);
          if (!a || !b) return (msg.textContent = `Couldn't find the ${!a ? "starting" : "ending"} address. Try adding city and state.`);
          msg.textContent = "Routing…";
          const r = await route(a, b);
          if (!r) return (msg.textContent = "No driving route found.");
          routed = { a, b, r };
          f.miles.value = r.miles.toFixed(2);
          msg.textContent = `Driving route: ${r.miles.toFixed(2)} mi, about ${Math.round(r.minutes)} min. The route will be drawn on the map.`;
          if (isNew && f.startTime.value) {
            const [h, mm] = f.startTime.value.split(":").map(Number);
            const end = h * 60 + mm + Math.round(r.minutes);
            f.endTime.value = `${pad(Math.floor(end / 60) % 24)}:${pad(end % 60)}`;
          }
        } catch (err) {
          msg.textContent = "Lookup failed: " + err.message;
        }
      };
      f.onsubmit = async (e) => {
        e.preventDefault();
        const vSel = f.vehicleId.value;
        const v = state.vehicles.find((x) => x.id === vSel);
        const fields = {
          ...applyWallClock(t, { date: f.date.value, startTime: f.startTime.value, endTime: f.endTime.value }),
          startAddress: f.startAddress.value.trim(),
          endAddress: f.endAddress.value.trim(),
          miles: round2(f.miles.value),
          use: f.use.value,
          useLocked: true,
          autoRule: f.use.value === t.use ? t.autoRule || "" : "",
          excluded: Boolean(f.excluded.value),
          excludedReason: f.excluded.value ? f.excludedReason.value : "",
          notes: f.notes.value,
          vehicleId: vSel === "__name" ? t.vehicleId || "" : v?.id || "",
          vehicle: vSel === "__name" ? t.vehicle : v?.name || "",
        };
        if (routed) {
          Object.assign(fields, { startLat: routed.a.lat, startLng: routed.a.lng, endLat: routed.b.lat, endLng: routed.b.lng, path: encodePolyline(routed.r.path) });
        }
        try {
          if (isNew) await api.createTrip({ ...t, ...fields, gpsMiles: null });
          else await api.updateTrip(t.id, fields);
          closeDialog();
          toast(isNew ? "Trip added" : "Trip saved");
          if (fields.date !== state.day) setDay(fields.date);
        } catch (err) {
          $("#tErr", el).textContent = err.message;
        }
      };
      const del = $("#del", el);
      if (del) del.onclick = async () => {
        if (!confirm("Delete this trip permanently? To keep it out of reports instead, set “Counted in reports?” to No.")) return;
        await api.deleteTrip(t.id);
        closeDialog();
        toast("Trip deleted");
      };
    },
  );
}
$("#btnManual").onclick = () => editTrip(null);

// ---------------- vehicles ----------------

function vehiclesDialog() {
  const rows = state.vehicles.map((v) => `<div class="vrow"><div><b>${esc(v.name)}</b><small>${esc([v.year, v.make, v.model, v.plate].filter(Boolean).join(" · ") || "—")}${v.btName ? " · Bluetooth: " + esc(v.btName) : ""}${v.defaultUse ? " · always " + esc(useById(v.defaultUse).label) : ""}</small></div><button class="btn" data-v="${esc(v.id)}">Edit</button></div>`).join("");
  openDialog(
    `<h2>Vehicles</h2>${rows || `<p class="hint">No vehicles yet.</p>`}
     <p class="hint">Link a vehicle to its car Bluetooth in the phone app; the phone then picks the vehicle for each drive automatically.</p>
     <div class="dlg-actions"><button class="btn" data-close>Close</button><button class="btn primary" id="vAdd">+ Add vehicle</button></div>`,
    (el) => {
      $("#vAdd", el).onclick = () => vehicleForm();
      el.querySelectorAll("[data-v]").forEach((b) => (b.onclick = () => vehicleForm(state.vehicles.find((v) => v.id === b.dataset.v))));
    },
  );
}
function vehicleForm(v = null) {
  const isNew = !v;
  v = v || { name: "", make: "", model: "", year: "", plate: "", defaultUse: "" };
  openDialog(
    `<h2>${isNew ? "Add vehicle" : "Edit vehicle"}</h2>
     <form id="vf">
       <label class="field"><span>Name (shown in reports)</span><input name="name" required value="${esc(v.name)}"></label>
       <div class="grid2">
         <label class="field"><span>Make</span><input name="make" value="${esc(v.make)}"></label>
         <label class="field"><span>Model</span><input name="model" value="${esc(v.model)}"></label>
         <label class="field"><span>Year</span><input name="year" value="${esc(v.year)}"></label>
         <label class="field"><span>Plate</span><input name="plate" value="${esc(v.plate)}"></label>
       </div>
       <label class="field"><span>Always classify drives in this vehicle as</span><select name="defaultUse"><option value="">Ask me</option>${USES.filter((u) => u.id !== "unclassified").map((u) => `<option value="${u.id}" ${v.defaultUse === u.id ? "selected" : ""}>${esc(u.label)}</option>`).join("")}</select></label>
       <div class="dlg-actions">${isNew ? "" : `<button type="button" class="btn danger" id="vDel">Delete</button>`}<span class="spacer"></span>
         <button type="button" class="btn" id="vBack">Back</button><button class="btn primary">Save</button></div>
     </form>`,
    (el) => {
      $("#vBack", el).onclick = vehiclesDialog;
      $("#vf", el).onsubmit = async (e) => {
        e.preventDefault();
        await api.saveVehicle({ ...v, ...Object.fromEntries(new FormData(e.target)) });
        vehiclesDialog();
      };
      const del = $("#vDel", el);
      if (del) del.onclick = async () => {
        if (!confirm(`Delete ${v.name}? Existing trips keep the name.`)) return;
        await api.deleteVehicle(v.id);
        vehiclesDialog();
      };
    },
  );
}
$("#btnVehicles").onclick = vehiclesDialog;

// ---------------- report ----------------

async function reportDialog() {
  const thisYear = new Date().getFullYear();
  const years = [thisYear, thisYear - 1, thisYear - 2];
  const useSets = {
    all: { label: "All uses", uses: [] },
    business: { label: "Business (RustyRose + GPRS)", uses: ["rustyrose", "gprs"] },
    rustyrose: { label: "RustyRose only", uses: ["rustyrose"] },
    gprs: { label: "GPRS only", uses: ["gprs"] },
    personal: { label: "Personal only", uses: ["personal"] },
  };
  openDialog(
    `<h2>Mileage report</h2>
     <form id="rf">
       <div class="grid2">
         <label class="field"><span>Year</span><select name="year">${years.map((y) => `<option>${y}</option>`).join("")}</select></label>
         <label class="field"><span>Month</span><select name="month"><option value="0">Whole year, by month</option>${MONTHS.map((m, i) => `<option value="${i + 1}">${m}</option>`).join("")}</select></label>
         <label class="field"><span>Use</span><select name="uses">${Object.entries(useSets).map(([k, s]) => `<option value="${k}">${esc(s.label)}</option>`).join("")}</select></label>
         <label class="field"><span>Vehicle</span><select name="vehicle"><option value="">All vehicles</option>${state.vehicles.map((v) => `<option>${esc(v.name)}</option>`).join("")}</select></label>
       </div>
       <label class="field"><span>CSV format</span><select name="format">
         <option value="report">Mileage report: counted trips, report columns</option>
         <option value="table">Full table: every trip on every day, incl. removed, all columns</option>
       </select></label>
       <label id="subWrap"><input type="checkbox" name="subtotals" checked> Include monthly subtotals and totals in the CSV</label>
       <div id="rPreview"><p class="hint">Loading…</p></div>
       <div class="dlg-actions"><button type="button" class="btn" data-close>Close</button><button class="btn primary">Download CSV</button></div>
     </form>`,
    (el) => {
      const f = $("#rf", el);
      let yearTrips = [];
      let loadedYear = null;
      const opts = () => ({ year: +f.year.value, month: +f.month.value, uses: useSets[f.uses.value].uses, vehicle: f.vehicle.value });
      const preview = async () => {
        if (loadedYear !== f.year.value) {
          $("#rPreview", el).innerHTML = `<p class="hint">Loading ${f.year.value}…</p>`;
          yearTrips = await api.getTrips(`${f.year.value}-01-01`, `${f.year.value}-12-31`);
          loadedYear = f.year.value;
        }
        const o = opts();
        const rows = reportTrips(yearTrips, o);
        const sum = monthSummary(rows);
        const cols = USES.filter((u) => rows.some((t) => (t.use || "unclassified") === u.id));
        const tot = { total: 0 };
        const body = Object.keys(sum).sort().map((k) => {
          const r = sum[k];
          tot.total += r.total;
          cols.forEach((c) => (tot[c.id] = (tot[c.id] || 0) + (r[c.id] || 0)));
          return `<tr><td>${MONTHS[+k.slice(5) - 1]}</td>${cols.map((c) => `<td>${(r[c.id] || 0).toFixed(1)}</td>`).join("")}<td>${r.total.toFixed(1)}</td></tr>`;
        }).join("");
        const byVehicle = {};
        rows.forEach((t) => (byVehicle[t.vehicle || "(none)"] = (byVehicle[t.vehicle || "(none)"] || 0) + Number(t.miles || 0)));
        const unclassified = reportTrips(yearTrips, { ...o, uses: ["unclassified"] }).length;
        $("#rPreview", el).innerHTML = rows.length
          ? `<table class="sum"><thead><tr><th>Month</th>${cols.map((c) => `<th style="color:${c.color}">${esc(c.label)}</th>`).join("")}<th>Total mi</th></tr></thead>
              <tbody>${body}</tbody><tfoot><tr><td>${rows.length} trips</td>${cols.map((c) => `<td>${round2(tot[c.id]).toFixed(1)}</td>`).join("")}<td>${round2(tot.total).toFixed(1)}</td></tr></tfoot></table>
             <p class="hint">By vehicle: ${Object.entries(byVehicle).map(([k, m]) => `${esc(k)} ${m.toFixed(1)} mi`).join(" · ")}</p>
             ${unclassified && o.uses.length ? `<div class="warnbox">${unclassified} unclassified trip(s) in this period aren't included. Classify them to count them.</div>` : ""}`
          : `<p class="hint" style="margin-top:12px">No trips match.</p>`;
      };
      f.onchange = () => {
        f.querySelector("#subWrap").hidden = f.format.value === "table";
        preview();
      };
      f.onsubmit = (e) => {
        e.preventDefault();
        const o = opts();
        const full = f.format.value === "table";
        const csv = full ? buildTableCsv(reportTrips(yearTrips, { ...o, includeRemoved: true })) : buildCsv(reportTrips(yearTrips, o), { subtotals: f.subtotals.checked });
        const name = `mileage-${full ? "table-" : ""}${o.year}${o.month ? "-" + pad(o.month) : ""}${f.uses.value !== "all" ? "-" + f.uses.value : ""}.csv`;
        download(name, csv);
        toast(`Downloaded ${name}`);
      };
      preview();
    },
  );
}
$("#btnReport").onclick = reportDialog;

// ---------------- map / table views ----------------

function setView(view) {
  document.querySelectorAll(".view-switch button").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
  $("#app").classList.toggle("table-mode", view === "table");
  $("#tableView").hidden = view !== "table";
  if (view === "table") table.show();
  else setTimeout(() => map.invalidateSize(), 0);
  try {
    localStorage.setItem("mt.view", view);
  } catch {}
}
document.querySelector(".view-switch").onclick = (e) => {
  const b = e.target.closest("button[data-view]");
  if (b) setView(b.dataset.view);
};

const table = createTable({
  api,
  getVehicles: () => state.vehicles,
  toast,
  showOnMap(t) {
    setView("map");
    state.wholeMonth = false;
    $("#wholeMonth").checked = false;
    if (t.date.slice(0, 7) === state.month) {
      state.day = t.date;
      state.selected = null;
      renderAll(false);
      select(t.id);
    } else {
      state.pendingSelect = t.id;
      setDay(t.date);
    }
  },
});

// ---------------- auth & boot ----------------

async function autoLearn() {
  if (state.automation.learn === false) return;
  for (const t of state.monthTrips) {
    if (t.use !== "unclassified" || t.excluded || t.useLocked) continue;
    const use = learnUse(t, state.monthTrips);
    if (use) await api.updateTrip(t.id, { use, autoRule: "learned from your past trips" });
  }
}

let started = false;
function start() {
  if (started) return;
  started = true;
  $("#login").hidden = true;
  $("#app").hidden = false;
  $("#demoBar").hidden = !demo;
  map.invalidateSize();
  api.watchVehicles((v) => {
    state.vehicles = v;
    table.vehiclesChanged();
  });
  api.watchAutomation((a) => { state.automation = a; });
  watchMonth();
  setTimeout(autoLearn, 3000);
  let saved = "map";
  try {
    saved = localStorage.getItem("mt.view") || "map";
  } catch {}
  if (saved === "table") setView("table");
}

api.onAuth((u) => {
  if (u) return start();
  if (started) return location.reload();
  $("#login").hidden = false;
  $("#app").hidden = true;
});

let loginMode = "in";
document.querySelectorAll("#loginForm [data-mode]").forEach((b) => (b.onclick = () => (loginMode = b.dataset.mode)));
$("#loginForm").onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    if (loginMode === "up") await api.signUp(f.get("email"), f.get("pw"));
    else await api.signIn(f.get("email"), f.get("pw"));
  } catch (err) {
    $("#loginErr").textContent = (err.code || err.message).replace("auth/", "").replace(/-/g, " ");
  }
};
$("#resetPw").onclick = async () => {
  const email = $("#loginForm").email.value;
  if (!email) return ($("#loginErr").textContent = "Enter your email first");
  await api.resetPassword(email).catch(() => {});
  $("#loginErr").textContent = "Password reset email sent";
};
$("#btnSignOut").onclick = () => (demo ? toast("Demo mode: nothing to sign out of") : api.signOut());
$("#resetDemo").onclick = () => api.resetDemo();
