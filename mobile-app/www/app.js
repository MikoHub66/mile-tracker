import { store } from "./store.js";
import { tracker, isNative } from "./native.js";
import { configured } from "./firebase.js";
import { WEB_MAP_URL } from "./shared/firebase-config.js";
import { addBasemaps } from "./shared/basemaps.js";
import { LEGAL_SECTIONS, DISCLAIMER_SHORT, LEGAL_UPDATED } from "./shared/legal.js";
import {
  USES, EXCLUDE_REASONS, useById, excludeLabel, fmtTime, shortAddress, decodePolyline,
  haversineM, METERS_PER_MILE, round2, localParts, browserTz, needsReview,
} from "./shared/trips.js";

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const CAR_SVG = '<svg viewBox="0 0 24 24"><path d="M18.9 6c-.2-.6-.8-1-1.4-1h-11c-.7 0-1.2.4-1.4 1L3 12v8c0 .6.4 1 1 1h1c.6 0 1-.4 1-1v-1h12v1c0 .6.4 1 1 1h1c.6 0 1-.4 1-1v-8l-2.1-6zM6.5 16a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm11 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zM5 11l1.5-4.5h11L19 11H5z"/></svg>';

let filter = "review";
let status = null;

// ---------------- toast & sheet ----------------

let toastTimer;
function toast(msg, action) {
  const el = $("#toast");
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button>${esc(action.label)}</button>` : ""}`;
  el.hidden = false;
  if (action) el.querySelector("button").onclick = () => { el.hidden = true; action.run(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), action ? 6000 : 3000);
}

let sheetCleanup = null;
function openSheet(html, onMount) {
  closeSheet();
  $("#sheetContent").innerHTML = html;
  $("#sheet").hidden = false;
  sheetCleanup = onMount ? onMount($("#sheetContent")) : null;
}
function closeSheet() {
  if (typeof sheetCleanup === "function") sheetCleanup();
  sheetCleanup = null;
  $("#sheet").hidden = true;
  $("#sheetContent").innerHTML = "";
}
$("#sheet").addEventListener("click", (e) => { if (e.target.matches("[data-close]")) closeSheet(); });

// Runs fn shortly after a sheet opens, unless the sheet (and its map) was closed first.
const afterOpen = (map, fn) => setTimeout(() => map._mapPane && fn(), 60);


// ---------------- header: status + vehicle ----------------

async function refreshStatus() {
  try {
    status = await tracker.getStatus();
  } catch {
    status = null;
  }
  renderStatus();
}

function missingPermissions() {
  const p = status?.permissions || {};
  return ["location", "background"].filter((k) => !p[k]);
}

function renderStatus() {
  const pill = $("#statusPill");
  pill.className = "pill";
  let text;
  if (!status) text = "Tracker unavailable";
  else if (!status.enabled) { text = "Tracking off"; pill.classList.add("warn"); }
  else if (missingPermissions().length) { text = "Needs location access"; pill.classList.add("warn"); }
  else if (status.driving) { text = `Driving · ${status.tripMiles.toFixed(1)} mi`; pill.classList.add("driving"); }
  else { text = status.btConnected ? `Connected to ${status.btVehicle}` : "Tracking · waiting for a drive"; pill.classList.add("on"); }
  if (status?.uploadError) text += " · upload error";
  $("#statusText").textContent = text;
}
$("#statusPill").onclick = () => showTab("settings");

function renderVehicleSelect() {
  const sel = $("#vehicleSelect");
  const def = store.defaultVehicle();
  sel.innerHTML =
    store.vehicles.map((v) => `<option value="${esc(v.id)}" ${def?.id === v.id ? "selected" : ""}>${esc(v.name)}</option>`).join("") +
    `<option value="__add">+ Add vehicle…</option>`;
  if (!store.vehicles.length) sel.value = "__add";
}
$("#vehicleSelect").onchange = async (e) => {
  if (e.target.value === "__add") {
    renderVehicleSelect();
    return editVehicle();
  }
  await store.saveAutomation({ defaultVehicleId: e.target.value });
  toast(`New trips will use ${store.defaultVehicle()?.name}${store.vehicles.some((v) => v.btAddress) ? " unless a car's Bluetooth says otherwise" : ""}`);
};

// ---------------- trips ----------------

function dayLabel(date) {
  const today = localParts(Date.now(), browserTz()).date;
  const yest = localParts(Date.now() - 864e5, browserTz()).date;
  if (date === today) return "Today";
  if (date === yest) return "Yesterday";
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function renderSummary() {
  const month = localParts(Date.now(), browserTz()).date.slice(0, 7);
  const mt = store.trips.filter((t) => !t.excluded && t.date?.startsWith(month));
  const sum = (f) => round2(mt.filter(f).reduce((a, t) => a + Number(t.miles || 0), 0));
  const biz = sum((t) => t.use === "rustyrose" || t.use === "gprs");
  const pers = sum((t) => t.use === "personal");
  const review = store.trips.filter(needsReview).length;
  $("#summary").innerHTML = `
    <div class="stat"><b>${biz.toFixed(1)}</b><span><i style="background:var(--rustyrose)"></i>Business mi</span></div>
    <div class="stat"><b>${pers.toFixed(1)}</b><span><i style="background:var(--personal)"></i>Personal mi</span></div>
    <div class="stat"><b>${review}</b><span>To review</span></div>`;
  const badge = $("#reviewBadge");
  badge.hidden = !review;
  badge.textContent = review;
}

function tripCard(t) {
  const u = useById(t.use);
  const from = t.startPlace || shortAddress(t.startAddress);
  const to = t.endPlace || shortAddress(t.endAddress);
  const meta = [
    t.vehicle && `<span>${esc(t.vehicle)}</span>`,
    t.btMatched && `<span class="tag">Bluetooth</span>`,
    t.autoRule && !t.excluded && t.use !== "unclassified" && `<span class="tag">auto: ${esc(t.autoRule)}</span>`,
    t.source === "manual" && `<span class="tag">manual</span>`,
    t.pending && `<span class="tag">not uploaded yet</span>`,
    t.excluded && `<span class="tag">Removed: ${esc(excludeLabel(t.excludedReason))}${t.autoRule ? " (auto)" : ""}</span>`,
  ].filter(Boolean).join("");
  const uses = t.excluded
    ? `<button data-act="restore" style="flex:1">Restore as a drive</button><button class="more" data-act="menu" aria-label="More">⋯</button>`
    : USES.filter((x) => x.id !== "unclassified")
        .map((x) => `<button data-act="use" data-use="${x.id}" style="--c:${x.color}" class="${t.use === x.id ? "on" : ""}">${esc(x.label)}</button>`)
        .join("") + `<button class="more" data-act="menu" aria-label="More options">⋯</button>`;
  return `<article class="trip ${t.excluded ? "removed" : ""}" style="--use:${u.color}" data-id="${esc(t.id)}">
    <div class="trip-head">
      <span class="trip-time">${fmtTime(t.startTs, t.tz)} – ${fmtTime(t.endTs, t.tz)}</span>
      <span class="trip-miles">${Number(t.miles || 0).toFixed(1)} <small>mi</small></span>
    </div>
    <div class="route"><div class="from">${esc(from)}</div><div class="to">${esc(to)}</div></div>
    ${meta ? `<div class="meta">${meta}</div>` : ""}
    <div class="uses">${uses}</div>
  </article>`;
}

function renderTrips() {
  renderSummary();
  let list = store.trips;
  if (filter === "review") list = list.filter(needsReview);
  else if (filter === "removed") list = list.filter((t) => t.excluded);
  else list = list.filter((t) => !t.excluded);
  list.sort((a, b) => b.startTs - a.startTs);
  if (!list.length) {
    const msg = {
      review: ["All caught up", "New drives show up here automatically. Classify them with one tap."],
      all: ["No drives yet", "Turn on tracking in Settings and just drive. Trips are recorded in the background."],
      removed: ["Nothing removed", "Flights, train rides, Uber trips and bike rides you remove end up here."],
    }[filter];
    $("#tripList").innerHTML = `<div class="empty"><b>${msg[0]}</b>${msg[1]}</div>`;
    return;
  }
  let html = "";
  let cur = null;
  for (const t of list) {
    if (t.date !== cur) {
      cur = t.date;
      const dayMiles = list.filter((x) => x.date === cur).reduce((a, x) => a + Number(x.miles || 0), 0);
      html += `<div class="day"><span>${esc(dayLabel(cur))}</span><span>${dayMiles.toFixed(1)} mi</span></div>`;
    }
    html += tripCard(t);
  }
  $("#tripList").innerHTML = html;
}

$("#tripFilter").onclick = (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  filter = b.dataset.f;
  [...$("#tripFilter").children].forEach((x) => x.classList.toggle("on", x === b));
  renderTrips();
};

const tripById = (id) => store.trips.find((t) => t.id === id);

async function setUse(t, use) {
  const prev = { use: t.use, autoRule: t.autoRule || "", useLocked: !!t.useLocked };
  await store.updateTrip(t, { use, autoRule: "", useLocked: true });
  if (filter === "review") toast(`Marked ${useById(use).label}`, { label: "Undo", run: () => store.updateTrip(t, prev) });
}

async function exclude(t, reason) {
  await store.updateTrip(t, { excluded: true, excludedReason: reason, autoRule: "" });
  toast(`Removed (${excludeLabel(reason)}). It won't appear in reports.`, {
    label: "Undo",
    run: () => store.updateTrip(t, { excluded: false, excludedReason: "" }),
  });
}

$("#tripList").onclick = async (e) => {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  const t = tripById(b.closest(".trip").dataset.id);
  if (!t) return;
  try {
    if (b.dataset.act === "use") await setUse(t, b.dataset.use);
    else if (b.dataset.act === "restore") await store.updateTrip(t, { excluded: false, excludedReason: "", autoRule: "" });
    else if (b.dataset.act === "menu") tripMenu(t);
  } catch (err) {
    toast(err.message || String(err));
  }
};

function tripMenu(t) {
  const reasons = EXCLUDE_REASONS.map((r) => `<button data-x="${r.id}">${esc(r.label)}</button>`).join("");
  openSheet(
    `<h3>${fmtTime(t.startTs, t.tz)} · ${Number(t.miles || 0).toFixed(1)} mi</h3>
     <p class="menu hint" style="margin-top:0">Not driving your own vehicle? Remove it from reports:</p>
     <div class="chips">${reasons}</div>
     <div class="menu">
       <button data-m="map">Show on map</button>
       <button data-m="edit">Edit miles, vehicle or notes</button>
       <button data-m="place">Save the destination as a place…</button>
       ${t.use !== "unclassified" ? `<button data-m="unclassify">Mark as unclassified</button>` : ""}
       <button data-m="delete" class="danger" style="color:var(--bad)">Delete trip</button>
     </div>`,
    (el) => {
      el.onclick = async (e) => {
        const x = e.target.closest("[data-x]");
        const m = e.target.closest("[data-m]");
        if (x) {
          closeSheet();
          await exclude(t, x.dataset.x);
        } else if (m) {
          const act = m.dataset.m;
          if (act === "map") return showTripMap(t);
          if (act === "edit") return editTrip(t);
          if (act === "place") return editPlace({ lat: t.endLat, lng: t.endLng, name: "", use: t.use !== "unclassified" ? t.use : "" });
          closeSheet();
          if (act === "unclassify") await store.updateTrip(t, { use: "unclassified", autoRule: "", useLocked: true });
          if (act === "delete" && confirm("Delete this trip permanently? (To keep it out of reports, use Remove instead.)")) await store.deleteTrip(t);
        }
      };
    },
  );
}

function showTripMap(t) {
  openSheet(`<h3>${esc(t.startPlace || shortAddress(t.startAddress))} → ${esc(t.endPlace || shortAddress(t.endAddress))}</h3><div class="map" id="tripMap"></div>
    <button class="btn block" data-close>Close</button>`, () => {
    const map = L.map("tripMap", { zoomControl: false });
    addBasemaps(map);
    const pts = decodePolyline(t.path);
    if (pts.length < 2) pts.push([t.startLat, t.startLng], [t.endLat, t.endLng]);
    const line = L.polyline(pts, { color: useById(t.use).color, weight: 5 }).addTo(map);
    L.circleMarker(pts[0], { radius: 7, color: "#fff", weight: 2, fillColor: "#6b7380", fillOpacity: 1 }).addTo(map);
    L.circleMarker(pts[pts.length - 1], { radius: 7, color: "#fff", weight: 2, fillColor: "#1f2a37", fillOpacity: 1 }).addTo(map);
    afterOpen(map, () => { map.invalidateSize(); map.fitBounds(line.getBounds(), { padding: [24, 24], animate: false }); });
    return () => map.remove();
  });
}

function useOptions(sel, withNone = "") {
  return (withNone ? `<option value="">${esc(withNone)}</option>` : "") +
    USES.filter((u) => u.id !== "unclassified").map((u) => `<option value="${u.id}" ${sel === u.id ? "selected" : ""}>${esc(u.label)}</option>`).join("");
}

function editTrip(t) {
  const vOpts = store.vehicles.map((v) => `<option value="${esc(v.id)}" ${v.id === t.vehicleId || (!t.vehicleId && v.name === t.vehicle) ? "selected" : ""}>${esc(v.name)}</option>`).join("");
  openSheet(
    `<h3>Edit trip</h3>
     <form id="tripForm">
       <div class="grid2">
         <label class="field"><span>Miles</span><input name="miles" type="number" step="0.01" min="0" value="${Number(t.miles || 0)}"></label>
         <label class="field"><span>Vehicle</span><select name="vehicleId"><option value="">—</option>${vOpts}</select></label>
       </div>
       <label class="field"><span>Notes</span><textarea name="notes" rows="2">${esc(t.notes)}</textarea></label>
       <p class="menu hint">GPS measured ${Number(t.gpsMiles ?? t.miles).toFixed(2)} mi. Dates, times and addresses can be edited on the web map.</p>
       <button class="btn primary block">Save</button>
     </form>`,
    (el) => {
      $("#tripForm", el).onsubmit = async (e) => {
        e.preventDefault();
        const f = new FormData(e.target);
        const v = store.vehicles.find((x) => x.id === f.get("vehicleId"));
        await store.updateTrip(t, { miles: round2(f.get("miles")), notes: f.get("notes"), vehicleId: v?.id || "", vehicle: v?.name || "" });
        closeSheet();
        toast("Trip saved");
      };
    },
  );
}

// ---------------- find my car ----------------

async function findCar() {
  let res;
  try {
    res = await tracker.getParked();
  } catch {
    res = {};
  }
  const p = res.parked;
  if (!p) {
    openSheet(`<h3>Find my car</h3><p>No parking spot yet. After your next drive ends (or your car's Bluetooth disconnects), the spot is saved here automatically.</p><button class="btn block" data-close>OK</button>`);
    return;
  }
  const tz = browserTz();
  const when = localParts(p.ts, tz).date === localParts(Date.now(), tz).date ? fmtTime(p.ts, tz) : `${dayLabel(localParts(p.ts, tz).date)} ${fmtTime(p.ts, tz)}`;
  const how = p.source === "bluetooth" ? "where your car's Bluetooth disconnected" : "where your last drive ended";
  const dir = `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}&travelmode=walking`;
  openSheet(
    `<h3>Find my car</h3>
     ${res.driving ? `<p class="menu hint" style="margin:0 0 6px">You're driving right now; this is where you last parked.</p>` : ""}
     <div class="car-info"><div><b id="carDist">…</b><small id="carSub">Locating you…</small></div>
       <a class="btn primary" href="${dir}" target="_blank" rel="noopener">Walking directions</a></div>
     <div class="map" id="carMap"></div>
     <p class="menu hint">${esc(p.vehicle || "Car")} parked ${esc(when)}, ${how} (±${Math.round(p.acc || 30)} m).</p>
     <button class="btn block" data-close>Close</button>`,
    () => {
      const map = L.map("carMap", { zoomControl: false }).setView([p.lat, p.lng], 18);
      addBasemaps(map);
      const icon = L.divIcon({ className: "", html: `<div class="car-pin">${CAR_SVG}</div>`, iconSize: [34, 34], iconAnchor: [17, 38] });
      L.marker([p.lat, p.lng], { icon }).addTo(map);
      L.circle([p.lat, p.lng], { radius: Math.max(10, p.acc || 30), color: "#1f2a37", weight: 1, fillOpacity: 0.08 }).addTo(map);
      afterOpen(map, () => map.invalidateSize());
      let me = null;
      let fitted = false;
      const watch = navigator.geolocation?.watchPosition(
        (pos) => {
          const ll = [pos.coords.latitude, pos.coords.longitude];
          if (!me) me = L.marker(ll, { icon: L.divIcon({ className: "me-dot", iconSize: [16, 16] }) }).addTo(map);
          else me.setLatLng(ll);
          const m = haversineM(ll[0], ll[1], p.lat, p.lng);
          const ft = m * 3.28084;
          $("#carDist").textContent = ft < 1000 ? `${Math.round(ft / 10) * 10} ft` : `${(m / METERS_PER_MILE).toFixed(2)} mi`;
          const dir = bearing(ll, [p.lat, p.lng]);
          $("#carSub").textContent = m < 3000 ? `${Math.max(1, Math.round(m / 80))} min walk · ${dir}` : `Away from the car · ${dir}`;
          if (!fitted && map._mapPane) {
            fitted = true;
            map.invalidateSize();
            map.fitBounds(L.latLngBounds([ll, [p.lat, p.lng]]), { padding: [40, 40], maxZoom: 18, animate: false });
          }
        },
        () => { $("#carSub").textContent = "Turn on location to see the distance"; $("#carDist").textContent = "—"; },
        { enableHighAccuracy: true, maximumAge: 5000 },
      );
      return () => {
        if (watch != null) navigator.geolocation.clearWatch(watch);
        map.remove();
      };
    },
  );
}

function bearing(a, b) {
  const toR = Math.PI / 180;
  const y = Math.sin((b[1] - a[1]) * toR) * Math.cos(b[0] * toR);
  const x = Math.cos(a[0] * toR) * Math.sin(b[0] * toR) - Math.sin(a[0] * toR) * Math.cos(b[0] * toR) * Math.cos((b[1] - a[1]) * toR);
  const deg = (Math.atan2(y, x) / toR + 360) % 360;
  return ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"][Math.round(deg / 45) % 8];
}
$("#findCar").onclick = findCar;

// ---------------- settings ----------------

const PERMS = [
  ["location", "Location", "Needed to record drives"],
  ["background", "Allow all the time", "Lets drives be recorded with the app closed"],
  ["activity", "Physical activity", "Detects when you get in a vehicle, saves battery"],
  ["bluetooth", "Nearby devices (Bluetooth)", "Recognises which car you're in"],
  ["notifications", "Notifications", "Shows the tracking notice Android requires"],
  ["batteryExempt", "Unrestricted battery", "Stops Android from pausing the tracker"],
];

function renderSettings() {
  const p = status?.permissions || {};
  const a = store.automation;
  const hasBt = store.vehicles.some((v) => v.btAddress);
  const days = ["S", "M", "T", "W", "T", "F", "S"];
  const permRows = PERMS.map(([k, label, hint]) => `<div class="row"><div class="label">${label}<small>${hint}</small></div>${
    p[k] ? `<span class="ok">✓ On</span>` : `<button class="btn" data-perm="${k}">Allow</button>`}</div>`).join("");
  const vehicles = store.vehicles.map((v) => `<div class="row"><div class="label">${esc(v.name)}${store.defaultVehicle()?.id === v.id ? " <small style='display:inline'>· default</small>" : ""}
      <small>${esc([v.year, v.make, v.model].filter(Boolean).join(" ") || "")}${v.btName ? ` · Bluetooth: ${esc(v.btName)}` : " · no Bluetooth linked"}${v.defaultUse ? ` · always ${esc(useById(v.defaultUse).label)}` : ""}</small></div>
      <button class="btn" data-vehicle="${esc(v.id)}">Edit</button></div>`).join("");
  const places = a.places.map((pl, i) => `<div class="row"><div class="label">${esc(pl.name)}<small>${pl.use ? esc(useById(pl.use).label) : "name only"} · ${pl.radius || 200} m radius</small></div>
      <button class="btn" data-place="${i}">Edit</button></div>`).join("");
  const account = !configured
    ? `<div class="row"><div class="label">This phone only<small>Firebase isn't set up yet, so trips stay on this phone and the web map can't see them.</small></div></div>`
    : store.user
      ? `<div class="row"><div class="label">Signed in<small>${esc(store.user.email)}</small></div><button class="btn" id="signOut">Sign out</button></div>
         ${WEB_MAP_URL ? `<div class="row"><div class="label">Web map & reports<small>${esc(WEB_MAP_URL)}</small></div><a class="btn" href="${esc(WEB_MAP_URL)}" target="_blank" rel="noopener">Open</a></div>` : ""}
         <div class="row"><div class="label">Upload<small>${status?.pendingUploads ? `${status.pendingUploads} trip(s) waiting` : "All trips uploaded"}${status?.uploadError ? ` · ${esc(status.uploadError)}` : ""}</small></div><button class="btn" id="syncNow">Sync now</button></div>`
      : `<div class="row"><div class="label">Not signed in<small>Sign in so trips sync to the web map.</small></div><button class="btn primary" id="signIn">Sign in</button></div>`;

  $("#tab-settings").innerHTML = `
    <div class="card">
      <div class="row"><div class="label"><b>Automatic tracking</b><small>${status?.enabled ? "Drives are recorded in the background" : "Off — no drives are recorded"}</small></div>
        <label class="switch"><input type="checkbox" id="trackToggle" ${status?.enabled ? "checked" : ""}><span></span></label></div>
      <div class="row"><div class="label">Battery saver<small>Checks for drives less often while parked. Leave on unless you notice missed trips.</small></div>
        <label class="switch"><input type="checkbox" id="battSaver" ${status?.batterySaverSetting !== false ? "checked" : ""} ${status?.highAccuracyAlways ? "disabled" : ""}><span></span></label></div>
      <div class="row"><div class="label">Always use GPS<small>Catches every drive, uses the most battery (overrides battery saver)</small></div>
        <label class="switch"><input type="checkbox" id="hiAcc" ${status?.highAccuracyAlways ? "checked" : ""}><span></span></label></div>
    </div>
    <div class="card"><h2>Permissions</h2>${permRows}</div>
    <div class="card"><h2>Vehicles</h2>${vehicles || `<div class="row"><div class="label"><small>Add your vehicles, then link each one to its car stereo so the app knows which car you're in.</small></div></div>`}
      <button class="btn block" id="addVehicle">+ Add vehicle</button></div>
    <div class="card"><h2>Automation</h2>
      <div class="row"><div class="label">Only count drives in my cars<small>${hasBt ? "Drives without a linked car's Bluetooth are removed as passenger / Uber (you can restore them)" : "Link a vehicle to its Bluetooth first"}</small></div>
        <label class="switch"><input type="checkbox" id="reqBt" ${a.requireBluetooth && hasBt ? "checked" : ""} ${hasBt ? "" : "disabled"}><span></span></label></div>
      <div class="row"><div class="label">Learn from my trips<small>Repeat routes get the use you gave them before</small></div>
        <label class="switch"><input type="checkbox" id="learn" ${a.learn ? "checked" : ""}><span></span></label></div>
      <div class="row"><div class="label">Work hours<small>Classify drives that start in these hours</small></div>
        <label class="switch"><input type="checkbox" id="whOn" ${a.workHours.on ? "checked" : ""}><span></span></label></div>
      <div id="whBox" ${a.workHours.on ? "" : "hidden"}>
        <div class="days">${days.map((d, i) => `<label><input type="checkbox" data-day="${i}" ${a.workHours.days.includes(i) ? "checked" : ""}><span>${d}</span></label>`).join("")}</div>
        <div class="grid2">
          <label class="field"><span>From</span><input type="time" id="whStart" value="${esc(a.workHours.start)}"></label>
          <label class="field"><span>To</span><input type="time" id="whEnd" value="${esc(a.workHours.end)}"></label>
        </div>
        <label class="field"><span>Classify as</span><select id="whUse">${useOptions(a.workHours.use, "Choose…")}</select></label>
      </div>
      <h2>Places</h2>
      ${places || `<div class="row"><div class="label"><small>Save places like Home or the GPRS office. Drives to a business place are classified automatically.</small></div></div>`}
      <button class="btn block" id="addPlace">+ Add a place at my location</button>
    </div>
    <div class="card"><h2>Account</h2>${account}</div>
    <div class="card"><h2>About</h2>
      <div class="row"><div class="label">Legal &amp; privacy<small>Disclaimer, how your data is handled</small></div><button class="btn" id="showLegal">View</button></div>
    </div>
    ${tracker.mock ? `<div class="card"><h2>Browser preview</h2><button class="btn block" id="simTrip">Simulate a finished drive</button></div>` : ""}
    <p class="menu hint" style="text-align:center">Mile Tracker ${isNative ? "" : "(browser preview)"} · trips end after 5 minutes stopped<br>${esc(DISCLAIMER_SHORT)}</p>`;
}

$("#tab-settings").addEventListener("click", async (e) => {
  const t = e.target;
  try {
    if (t.dataset.perm) {
      const k = t.dataset.perm;
      if (k === "batteryExempt") await tracker.requestBatteryExemption();
      else if (k === "background") {
        toast('Choose "Allow all the time"');
        await tracker.requestPermission({ kind: k });
      } else await tracker.requestPermission({ kind: k });
      setTimeout(refreshStatus, 800);
    } else if (t.id === "addVehicle") editVehicle();
    else if (t.dataset.vehicle) editVehicle(store.vehicles.find((v) => v.id === t.dataset.vehicle));
    else if (t.id === "addPlace") addPlaceHere();
    else if (t.dataset.place) editPlace(store.automation.places[+t.dataset.place], +t.dataset.place);
    else if (t.id === "signIn") signInSheet();
    else if (t.id === "signOut") { if (confirm("Sign out? Tracking continues; trips upload after you sign back in.")) await store.signOut(); }
    else if (t.id === "syncNow") { await tracker.syncNow(); toast("Uploading…"); setTimeout(refreshStatus, 3000); }
    else if (t.id === "showLegal") legalSheet();
    else if (t.id === "simTrip") { tracker.simulateTrip(); toast("Simulated a drive"); }
  } catch (err) {
    toast(err.message || String(err));
  }
});

$("#tab-settings").addEventListener("change", async (e) => {
  const t = e.target;
  const a = store.automation;
  try {
    if (t.id === "trackToggle") {
      if (t.checked) await startTracking();
      else await tracker.stop();
      await refreshStatus();
    } else if (t.id === "hiAcc") {
      await tracker.setConfig({ highAccuracyAlways: t.checked });
      await refreshStatus();
      renderSettings();
    } else if (t.id === "battSaver") await tracker.setConfig({ batterySaver: t.checked });
    else if (t.id === "reqBt") await store.saveAutomation({ requireBluetooth: t.checked });
    else if (t.id === "learn") await store.saveAutomation({ learn: t.checked });
    else if (t.id === "whOn") await store.saveAutomation({ workHours: { ...a.workHours, on: t.checked } });
    else if (t.dataset.day) {
      const days = [...document.querySelectorAll("[data-day]")].filter((x) => x.checked).map((x) => +x.dataset.day);
      await store.saveAutomation({ workHours: { ...a.workHours, days } });
    } else if (t.id === "whStart" || t.id === "whEnd" || t.id === "whUse") {
      await store.saveAutomation({ workHours: { ...a.workHours, start: $("#whStart").value, end: $("#whEnd").value, use: $("#whUse").value } });
    }
  } catch (err) {
    toast(err.message || String(err));
  }
});

function legalSheet() {
  const body = LEGAL_SECTIONS.map(([h, b]) => `<h4 style="margin:14px 0 4px">${esc(h)}</h4><p style="margin:0;color:var(--muted)">${esc(b)}</p>`).join("");
  openSheet(
    `<h3>Legal &amp; privacy</h3><p class="menu hint" style="margin-top:0">Last updated ${esc(LEGAL_UPDATED)}</p>${body}
     <button class="btn block" data-close style="margin-top:16px">Close</button>`,
  );
}

/** First run: show the disclaimer once and require acceptance before tracking starts. */
async function acceptDisclaimer() {
  try {
    if (localStorage.getItem("mt.legalAccepted")) return true;
  } catch {}
  return new Promise((resolve) => {
    const body = LEGAL_SECTIONS.map(([h, b]) => `<h4 style="margin:14px 0 4px">${esc(h)}</h4><p style="margin:0;color:var(--muted)">${esc(b)}</p>`).join("");
    openSheet(
      `<h3>Before you start</h3>
       <p>Mile Tracker records your location in the background to detect your drives, and the trips and distances it produces are estimates you need to review. Please read and accept this to continue.</p>
       <div style="max-height:40vh;overflow:auto;border:1px solid var(--line);border-radius:10px;padding:0 12px;margin:8px 0">${body}</div>
       <button class="btn primary block" id="legalAgree">I understand and agree</button>
       <button class="btn block" data-close id="legalDecline">Not now</button>`,
      (el) => {
        $("#legalAgree", el).onclick = () => {
          try {
            localStorage.setItem("mt.legalAccepted", new Date().toISOString());
          } catch {}
          closeSheet();
          resolve(true);
        };
        $("#legalDecline", el).onclick = () => resolve(false);
      },
    );
  });
}

async function startTracking() {
  if (!(await acceptDisclaimer())) throw new Error("You must accept the disclaimer to start tracking");
  const loc = await tracker.requestPermission({ kind: "location" });
  if (!loc.granted) throw new Error("Location permission is needed to record drives");
  await tracker.requestPermission({ kind: "notifications" }).catch(() => {});
  await tracker.start();
  const s = await tracker.getStatus();
  if (!s.permissions.background) toast('Tip: allow location "all the time" so drives record with the app closed', { label: "Allow", run: () => tracker.requestPermission({ kind: "background" }).then(refreshStatus) });
}

async function editVehicle(v = null) {
  const isNew = !v;
  v = v || { name: "", make: "", model: "", year: "", plate: "", btAddress: "", btName: "", defaultUse: "" };
  let devices = [];
  let btNote = "";
  try {
    if (!(await tracker.getStatus()).permissions.bluetooth) await tracker.requestPermission({ kind: "bluetooth" });
    devices = (await tracker.listBluetoothDevices()).devices || [];
  } catch {
    btNote = "Allow Nearby devices to link Bluetooth.";
  }
  if (v.btAddress && !devices.some((d) => d.address === v.btAddress)) devices.push({ address: v.btAddress, name: v.btName || v.btAddress });
  const btOpts = devices.map((d) => `<option value="${esc(d.address)}" ${d.address === v.btAddress ? "selected" : ""}>${esc(d.name)}</option>`).join("");
  openSheet(
    `<h3>${isNew ? "Add vehicle" : "Edit vehicle"}</h3>
     <form id="vForm">
       <label class="field"><span>Name (shown in reports)</span><input name="name" required value="${esc(v.name)}" placeholder="e.g. 2021 F-150"></label>
       <div class="grid2">
         <label class="field"><span>Make</span><input name="make" value="${esc(v.make)}"></label>
         <label class="field"><span>Model</span><input name="model" value="${esc(v.model)}"></label>
         <label class="field"><span>Year</span><input name="year" inputmode="numeric" value="${esc(v.year)}"></label>
         <label class="field"><span>Plate</span><input name="plate" value="${esc(v.plate)}"></label>
       </div>
       <label class="field"><span>Car Bluetooth (paired device)</span><select name="btAddress"><option value="">None</option>${btOpts}</select></label>
       <p class="menu hint" style="margin-top:-4px">${btNote || "When the phone connects to this device, new drives are assigned to this vehicle and GPS turns on right away."}</p>
       <label class="field"><span>Always classify drives in this vehicle as</span><select name="defaultUse">${useOptions(v.defaultUse, "Ask me (default)")}</select></label>
       <button class="btn primary block">Save vehicle</button>
       ${isNew ? "" : `<button type="button" class="btn danger block" id="vDel">Delete vehicle</button>`}
     </form>`,
    (el) => {
      $("#vForm", el).onsubmit = async (e) => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(e.target));
        f.btName = devices.find((d) => d.address === f.btAddress)?.name || "";
        await store.saveVehicle({ ...v, ...f });
        closeSheet();
        toast(isNew ? `${f.name} added` : "Vehicle saved");
      };
      const del = $("#vDel", el);
      if (del) del.onclick = async () => {
        if (!confirm(`Delete ${v.name}? Existing trips keep the name.`)) return;
        await store.deleteVehicle(v.id);
        closeSheet();
      };
    },
  );
}

function addPlaceHere() {
  if (!navigator.geolocation) return toast("Location unavailable");
  toast("Getting your location…");
  navigator.geolocation.getCurrentPosition(
    (pos) => editPlace({ name: "", use: "", lat: pos.coords.latitude, lng: pos.coords.longitude, radius: 200 }),
    () => toast("Couldn't get your location"),
    { enableHighAccuracy: true, timeout: 20000 },
  );
}

function editPlace(pl, index = -1) {
  openSheet(
    `<h3>${index < 0 ? "Save place" : "Edit place"}</h3>
     <form id="pForm">
       <label class="field"><span>Name</span><input name="name" required value="${esc(pl.name)}" placeholder="Home, GPRS office, Studio…"></label>
       <div class="grid2">
         <label class="field"><span>Drives here are</span><select name="use">${useOptions(pl.use, "Just name it")}</select></label>
         <label class="field"><span>Radius (m)</span><input name="radius" type="number" min="50" max="2000" value="${pl.radius || 200}"></label>
       </div>
       <div class="map" id="placeMap" style="height:30vh"></div>
       <button class="btn primary block">Save place</button>
       ${index < 0 ? "" : `<button type="button" class="btn danger block" id="pDel">Delete place</button>`}
     </form>`,
    (el) => {
      const map = L.map("placeMap", { zoomControl: false }).setView([pl.lat, pl.lng], 16);
      addBasemaps(map);
      const circle = L.circle([pl.lat, pl.lng], { radius: pl.radius || 200 }).addTo(map);
      afterOpen(map, () => map.invalidateSize());
      $("[name=radius]", el).oninput = (e) => circle.setRadius(+e.target.value || 200);
      $("#pForm", el).onsubmit = async (e) => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(e.target));
        const places = [...store.automation.places];
        const place = { name: f.name.trim(), use: f.use, radius: +f.radius || 200, lat: pl.lat, lng: pl.lng };
        if (index < 0) places.push(place);
        else places[index] = place;
        await store.saveAutomation({ places });
        closeSheet();
        toast(`${place.name} saved`);
      };
      const del = $("#pDel", el);
      if (del) del.onclick = async () => {
        await store.saveAutomation({ places: store.automation.places.filter((_, i) => i !== index) });
        closeSheet();
      };
      return () => map.remove();
    },
  );
}

function signInSheet() {
  openSheet(
    `<h3>Sign in</h3>
     <form id="authForm">
       <label class="field"><span>Email</span><input name="email" type="email" autocomplete="email" required></label>
       <label class="field"><span>Password</span><input name="pw" type="password" autocomplete="current-password" minlength="6" required></label>
       <div class="err" id="authErr"></div>
       <button class="btn primary block" data-mode="in">Sign in</button>
       <button class="btn block" data-mode="up">Create account</button>
       <button type="button" class="btn block" id="resetPw" style="border:0">Forgot password?</button>
     </form>`,
    (el) => {
      let mode = "in";
      el.querySelectorAll("[data-mode]").forEach((b) => (b.onclick = () => (mode = b.dataset.mode)));
      $("#authForm", el).onsubmit = async (e) => {
        e.preventDefault();
        const f = new FormData(e.target);
        try {
          if (mode === "up") await store.signUp(f.get("email"), f.get("pw"));
          else await store.signIn(f.get("email"), f.get("pw"));
          closeSheet();
          toast("Signed in. Trips will sync to the web map.");
        } catch (err) {
          $("#authErr").textContent = (err.code || err.message || "").replace("auth/", "").replace(/-/g, " ");
        }
      };
      $("#resetPw", el).onclick = async () => {
        const email = $("[name=email]", el).value;
        if (!email) return ($("#authErr").textContent = "Enter your email first");
        await store.resetPassword(email).catch(() => {});
        $("#authErr").textContent = "Password reset email sent";
      };
    },
  );
}

// ---------------- tabs & boot ----------------

function showTab(name) {
  document.querySelectorAll(".tab").forEach((s) => (s.hidden = s.id !== `tab-${name}`));
  document.querySelectorAll(".bottom button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  if (name === "settings") refreshStatus().then(renderSettings);
}
document.querySelector(".bottom").onclick = (e) => {
  const b = e.target.closest("button[data-tab]");
  if (b) showTab(b.dataset.tab);
};

function renderAll() {
  renderVehicleSelect();
  renderTrips();
  if (!$("#tab-settings").hidden) renderSettings();
}

store.onChange(renderAll);
tracker.addListener("status", (s) => {
  status = { ...(status || {}), ...s };
  renderStatus();
});

await store.init();
await refreshStatus();
renderAll();
// First run: turn tracking on (the whole point is not having to remember).
if (status && !status.enabled && !localStorage.getItem("mt.askedStart")) {
  localStorage.setItem("mt.askedStart", "1");
  startTracking().then(refreshStatus).catch(() => {}); // declining the disclaimer is a quiet no-op
}
setInterval(() => document.visibilityState === "visible" && refreshStatus(), 10_000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    store.refreshLocal();
    refreshStatus();
  }
});
