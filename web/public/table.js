// Table view: every trip in the chosen year/month as an editable grid, with
// multi-select bulk edits ("Change selected" / "Change all shown") and a
// full-table CSV export of exactly what the filters show.

import {
  USES, EXCLUDE_REASONS, useById, excludeLabel, localParts, applyWallClock, round2, MONTHS,
  buildTableCsv, needsReview,
} from "./shared/trips.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const pad = (n) => String(n).padStart(2, "0");

const BULK_LABEL = { use: "Use", vehicle: "Vehicle", status: "Counted / removed", notes: "Notes", date: "Date" };

export function createTable({ api, getVehicles, toast, showOnMap }) {
  const $ = (s) => document.querySelector(s);
  const now = new Date();
  const st = {
    year: now.getFullYear(),
    month: 0,
    use: "",
    vehicle: "",
    show: "counted",
    q: "",
    sort: "startTs",
    desc: false,
    trips: [],
    selected: new Set(),
    lastClicked: null,
    unsub: null,
    dirty: false,
    started: false,
  };

  // ---------- filters ----------

  function fillFilters() {
    const years = [0, 1, 2, 3].map((n) => now.getFullYear() - n);
    $("#tvYear").innerHTML = years.map((y) => `<option ${y === st.year ? "selected" : ""}>${y}</option>`).join("");
    $("#tvMonth").innerHTML = `<option value="0">All months</option>` + MONTHS.map((m, i) => `<option value="${i + 1}">${m}</option>`).join("");
    $("#tvUse").innerHTML = `<option value="">All uses</option><option value="business">Business (RustyRose + GPRS)</option>` +
      USES.map((u) => `<option value="${u.id}">${esc(u.label)}</option>`).join("");
    fillVehicleFilter();
  }

  function fillVehicleFilter() {
    const names = new Set([...getVehicles().map((v) => v.name), ...st.trips.map((t) => t.vehicle).filter(Boolean)]);
    const cur = st.vehicle;
    $("#tvVehicle").innerHTML = `<option value="">All vehicles</option>` +
      [...names].sort().map((n) => `<option ${n === cur ? "selected" : ""}>${esc(n)}</option>`).join("");
  }

  function load() {
    st.unsub?.();
    const from = st.month ? `${st.year}-${pad(st.month)}-01` : `${st.year}-01-01`;
    const to = st.month ? `${st.year}-${pad(st.month)}-31` : `${st.year}-12-31`;
    st.unsub = api.watchTrips(from, to, (trips) => {
      st.trips = trips;
      const ids = new Set(trips.map((t) => t.id));
      for (const id of st.selected) if (!ids.has(id)) st.selected.delete(id);
      fillVehicleFilter();
      requestRender();
    });
  }

  function filtered() {
    const q = st.q.trim().toLowerCase();
    let rows = st.trips.filter((t) => {
      if (st.show === "counted" && t.excluded) return false;
      if (st.show === "removed" && !t.excluded) return false;
      if (st.show === "review" && !needsReview(t)) return false;
      if (st.use === "business" ? !["rustyrose", "gprs"].includes(t.use) : st.use && (t.use || "unclassified") !== st.use) return false;
      if (st.vehicle && (t.vehicle || "") !== st.vehicle) return false;
      if (q && ![t.startAddress, t.endAddress, t.notes, t.vehicle, t.startPlace, t.endPlace].join(" ").toLowerCase().includes(q)) return false;
      return true;
    });
    const k = st.sort;
    const val = (t) => (k === "miles" || k === "startTs" || k === "endTs" ? Number(t[k]) || 0 : k === "excluded" ? (t.excluded ? 1 : 0) : String(t[k] ?? "").toLowerCase());
    rows.sort((a, b) => {
      const x = val(a), y = val(b);
      const c = x < y ? -1 : x > y ? 1 : a.startTs - b.startTs;
      return st.desc ? -c : c;
    });
    return rows;
  }

  // ---------- rendering ----------

  function vehicleOptions(t) {
    const vs = getVehicles();
    const opts = vs.map((v) => `<option value="${esc(v.id)}" ${v.id === t.vehicleId || (!t.vehicleId && v.name === t.vehicle) ? "selected" : ""}>${esc(v.name)}</option>`);
    if (t.vehicle && !vs.some((v) => v.id === t.vehicleId || v.name === t.vehicle)) opts.unshift(`<option value="__keep" selected>${esc(t.vehicle)}</option>`);
    return `<option value="">—</option>` + opts.join("");
  }
  const useOptions = (sel) => USES.map((u) => `<option value="${u.id}" ${(sel || "unclassified") === u.id ? "selected" : ""}>${esc(u.label)}</option>`).join("");
  const statusOptions = (t) =>
    `<option value="" ${t.excluded ? "" : "selected"}>Yes</option>` +
    EXCLUDE_REASONS.map((r) => `<option value="${r.id}" ${t.excluded && t.excludedReason === r.id ? "selected" : ""}>No – ${esc(r.label)}</option>`).join("");

  function rowHtml(t) {
    const s = localParts(t.startTs, t.tz);
    const e = localParts(t.endTs, t.tz);
    const cls = [t.excluded && "removed", st.selected.has(t.id) && "selected"].filter(Boolean).join(" ");
    return `<tr data-id="${esc(t.id)}" class="${cls}">
      <td class="c-sel"><input type="checkbox" data-sel ${st.selected.has(t.id) ? "checked" : ""} aria-label="Select trip"></td>
      <td class="veh"><select data-f="vehicle" aria-label="Vehicle">${vehicleOptions(t)}</select></td>
      <td><input type="date" data-f="date" value="${esc(t.date)}" aria-label="Date"></td>
      <td><input type="time" data-f="startTime" value="${s.time}" aria-label="Start time"></td>
      <td class="addr"><input data-f="startAddress" value="${esc(t.startAddress)}" aria-label="Starting address"></td>
      <td><input type="time" data-f="endTime" value="${e.time}" aria-label="End time"></td>
      <td class="addr"><input data-f="endAddress" value="${esc(t.endAddress)}" aria-label="Ending address"></td>
      <td class="num"><input type="number" step="0.01" min="0" data-f="miles" value="${round2(t.miles).toFixed(2)}" aria-label="Miles"></td>
      <td class="use" style="--c:${useById(t.use).color}"><select data-f="use" aria-label="Use">${useOptions(t.use)}</select></td>
      <td class="status"><select data-f="status" aria-label="Counted in reports">${statusOptions(t)}</select></td>
      <td class="notes"><input data-f="notes" value="${esc(t.notes)}" aria-label="Notes"></td>
      <td>${t.source === "manual" ? `<span class="tag">manual</span>` : ""}<button class="maplink" data-map>Map</button></td>
    </tr>`;
  }

  function render() {
    st.dirty = false;
    const rows = filtered();
    $("#tvBody").innerHTML = rows.length ? rows.map(rowHtml).join("") : `<tr><td colspan="12" style="padding:30px;text-align:center;color:var(--muted)">No trips match these filters.</td></tr>`;
    document.querySelectorAll("#tvTable th[data-sort]").forEach((th) => {
      th.classList.toggle("sorted", th.dataset.sort === st.sort);
      th.classList.toggle("desc", th.dataset.sort === st.sort && st.desc);
    });
    const counted = rows.filter((t) => !t.excluded);
    $("#tvFootLabel").textContent = `${rows.length} trip${rows.length === 1 ? "" : "s"} shown${rows.length !== counted.length ? ` (${rows.length - counted.length} removed, not in total)` : ""}`;
    $("#tvFootMiles").textContent = round2(counted.reduce((a, t) => a + Number(t.miles || 0), 0)).toFixed(2);
    renderBulk(rows);
  }

  /** Don't redraw under the user's cursor: wait until focus leaves the table body. */
  function requestRender() {
    if ($("#tvBody").contains(document.activeElement)) st.dirty = true;
    else render();
  }
  document.addEventListener("focusout", () =>
    setTimeout(() => st.dirty && !$("#tvBody").contains(document.activeElement) && render(), 0),
  );

  // ---------- inline edits ----------

  const tripById = (id) => st.trips.find((t) => t.id === id);

  function fieldsFor(t, f, value, tr) {
    switch (f) {
      case "vehicle": {
        if (value === "__keep") return null;
        const v = getVehicles().find((x) => x.id === value);
        return { vehicleId: v?.id || "", vehicle: v?.name || "" };
      }
      case "date":
      case "startTime":
      case "endTime": {
        const get = (name) => tr.querySelector(`[data-f="${name}"]`).value;
        if (!get("date") || !get("startTime") || !get("endTime")) return null;
        return applyWallClock(t, { date: get("date"), startTime: get("startTime"), endTime: get("endTime") });
      }
      case "miles":
        return { miles: round2(value) };
      case "use":
        return { use: value, useLocked: true, autoRule: "" };
      case "status":
        return { excluded: Boolean(value), excludedReason: value };
      default:
        return { [f]: value.trim() };
    }
  }

  $("#tvBody").addEventListener("change", async (e) => {
    const el = e.target;
    const tr = el.closest("tr[data-id]");
    if (!tr) return;
    const t = tripById(tr.dataset.id);
    if (!t) return;
    if (el.matches("[data-sel]")) return toggleSelect(t.id, el.checked, e.shiftKey);
    const fields = fieldsFor(t, el.dataset.f, el.value, tr);
    if (!fields) return;
    const td = el.closest("td");
    if (el.dataset.f === "use") td.style.setProperty("--c", useById(el.value).color);
    try {
      await api.updateTrip(t.id, fields);
      td.classList.add("saved");
      setTimeout(() => td.classList.remove("saved"), 900);
    } catch (err) {
      td.classList.add("failed");
      toast(`Couldn't save: ${err.message}`);
    }
  });
  // Enter in a text cell commits it (fires change) and moves down a row.
  $("#tvBody").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !e.target.matches("input[data-f]")) return;
    e.preventDefault();
    const td = e.target.closest("td");
    const next = td.parentElement.nextElementSibling?.children[td.cellIndex]?.querySelector("input,select");
    (next || e.target).focus();
    if (!next) e.target.blur();
  });
  $("#tvBody").addEventListener("click", (e) => {
    if (e.target.matches("[data-map]")) {
      const t = tripById(e.target.closest("tr").dataset.id);
      if (t) showOnMap(t);
    } else if (e.target.matches("[data-sel]")) {
      // remember shift for the change handler (change events don't carry shiftKey)
      e.target.dataset.shift = e.shiftKey ? "1" : "";
    }
  });

  // ---------- selection ----------

  function toggleSelect(id, on, _shift) {
    const cb = document.querySelector(`tr[data-id="${CSS.escape(id)}"] [data-sel]`);
    const shift = cb?.dataset.shift === "1";
    if (shift && st.lastClicked) {
      const rows = filtered().map((t) => t.id);
      const a = rows.indexOf(st.lastClicked), b = rows.indexOf(id);
      if (a >= 0 && b >= 0) for (const rid of rows.slice(Math.min(a, b), Math.max(a, b) + 1)) on ? st.selected.add(rid) : st.selected.delete(rid);
    } else if (on) st.selected.add(id);
    else st.selected.delete(id);
    st.lastClicked = id;
    render();
  }

  $("#tvAll").addEventListener("change", (e) => {
    const rows = filtered();
    if (e.target.checked) rows.forEach((t) => st.selected.add(t.id));
    else st.selected.clear();
    render();
  });

  // ---------- bulk edit ----------

  function bulkValueControl() {
    const f = $("#bulkField").value;
    const vs = getVehicles();
    const html = {
      use: `<select id="bulkVal">${useOptions("personal")}</select>`,
      vehicle: `<select id="bulkVal">${vs.map((v) => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join("")}<option value="">(none)</option></select>`,
      status: `<select id="bulkVal"><option value="">Yes, counted</option>${EXCLUDE_REASONS.map((r) => `<option value="${r.id}">No – ${esc(r.label)}</option>`).join("")}</select>`,
      notes: `<input id="bulkVal" placeholder="Replaces the notes">`,
      date: `<input id="bulkVal" type="date" value="${localParts(Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone).date}">`,
    }[f];
    $("#bulkValue").innerHTML = html;
  }

  function renderBulk(rows = filtered()) {
    const n = st.selected.size;
    $("#bulkCount").textContent = n ? `${n} selected` : "None selected";
    $("#bulkSelected").disabled = !n;
    $("#bulkDelete").disabled = !n;
    $("#bulkClear").hidden = !n;
    $("#bulkSelected").textContent = n ? `Change ${n} selected` : "Change selected";
    $("#bulkAll").textContent = `Change all ${rows.length} shown`;
    $("#bulkAll").disabled = !rows.length;
    $("#bulkBar").classList.toggle("active", n > 0);
    const all = $("#tvAll");
    all.checked = rows.length > 0 && rows.every((t) => st.selected.has(t.id));
    all.indeterminate = !all.checked && rows.some((t) => st.selected.has(t.id));
  }

  function bulkFields(t, f, v) {
    if (f === "use") return { use: v, useLocked: true, autoRule: "" };
    if (f === "vehicle") {
      const veh = getVehicles().find((x) => x.id === v);
      return { vehicleId: veh?.id || "", vehicle: veh?.name || "" };
    }
    if (f === "status") return { excluded: Boolean(v), excludedReason: v };
    if (f === "notes") return { notes: v };
    if (f === "date") {
      const s = localParts(t.startTs, t.tz), e = localParts(t.endTs, t.tz);
      return applyWallClock(t, { date: v, startTime: s.time, endTime: e.time });
    }
  }
  const PREV_KEYS = {
    use: ["use", "useLocked", "autoRule"], vehicle: ["vehicleId", "vehicle"], status: ["excluded", "excludedReason"],
    notes: ["notes"], date: ["date", "startTs", "endTs", "tz"],
  };

  async function applyBulk(trips, scopeLabel) {
    const f = $("#bulkField").value;
    const v = $("#bulkVal").value;
    if (f === "date" && !v) return toast("Pick a date first");
    if (!trips.length) return;
    const valueLabel =
      f === "use" ? useById(v).label :
      f === "vehicle" ? getVehicles().find((x) => x.id === v)?.name || "(none)" :
      f === "status" ? (v ? `Removed – ${excludeLabel(v)}` : "Counted") :
      f === "notes" ? `"${v}"` : v;
    if (!confirm(`Set ${BULK_LABEL[f]} to ${valueLabel} on ${scopeLabel} (${trips.length} trip${trips.length === 1 ? "" : "s"})?`)) return;
    const prev = trips.map((t) => ({ id: t.id, fields: Object.fromEntries(PREV_KEYS[f].map((k) => [k, t[k] ?? (k === "useLocked" ? false : "")])) }));
    try {
      await api.updateMany(trips.map((t) => ({ id: t.id, fields: bulkFields(t, f, v) })));
      toast(`Updated ${trips.length} trip${trips.length === 1 ? "" : "s"}`, { label: "Undo", run: () => api.updateMany(prev) });
    } catch (err) {
      toast(`Bulk change failed: ${err.message}`);
    }
  }

  $("#bulkField").addEventListener("change", bulkValueControl);
  $("#bulkSelected").addEventListener("click", () => applyBulk(st.trips.filter((t) => st.selected.has(t.id)), "the selected trips"));
  $("#bulkAll").addEventListener("click", () => applyBulk(filtered(), "every trip shown in the table"));
  $("#bulkClear").addEventListener("click", () => { st.selected.clear(); render(); });
  $("#bulkDelete").addEventListener("click", async () => {
    const n = st.selected.size;
    if (!n || !confirm(`Permanently delete ${n} trip${n === 1 ? "" : "s"}? To keep them out of reports instead, change "Counted / removed".`)) return;
    await api.deleteMany([...st.selected]);
    st.selected.clear();
    toast(`Deleted ${n} trip${n === 1 ? "" : "s"}`);
  });

  // ---------- toolbar ----------

  const onFilter = (reload) => () => {
    st.year = +$("#tvYear").value;
    st.month = +$("#tvMonth").value;
    st.use = $("#tvUse").value;
    st.vehicle = $("#tvVehicle").value;
    st.show = $("#tvShow").value;
    st.q = $("#tvSearch").value;
    st.selected.clear();
    if (reload) load();
    else render();
  };
  $("#tvYear").addEventListener("change", onFilter(true));
  $("#tvMonth").addEventListener("change", onFilter(true));
  ["#tvUse", "#tvVehicle", "#tvShow"].forEach((s) => $(s).addEventListener("change", onFilter(false)));
  $("#tvSearch").addEventListener("input", onFilter(false));
  document.querySelectorAll("#tvTable th[data-sort]").forEach((th) =>
    th.addEventListener("click", () => {
      if (st.sort === th.dataset.sort) st.desc = !st.desc;
      else {
        st.sort = th.dataset.sort;
        st.desc = false;
      }
      render();
    }),
  );

  $("#tvExport").addEventListener("click", () => {
    const rows = filtered();
    if (!rows.length) return toast("Nothing to export with these filters");
    const name = `mileage-table-${st.year}${st.month ? "-" + pad(st.month) : ""}.csv`;
    download(name, buildTableCsv(rows));
    toast(`Downloaded ${name} (${rows.length} trips)`);
  });

  return {
    /** Called whenever the Table view is shown. */
    show() {
      if (!st.started) {
        st.started = true;
        fillFilters();
        bulkValueControl();
        load();
      } else render();
    },
    vehiclesChanged() {
      if (!st.started) return;
      fillVehicleFilter();
      bulkValueControl();
      requestRender();
    },
  };
}

export function download(name, text) {
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob(["﻿" + text], { type: "text/csv" })),
    download: name,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
