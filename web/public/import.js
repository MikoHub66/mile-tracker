// "Import MileIQ" dialog: pick the MileIQ CSV export, check the column and
// category mapping, preview, and write the drives as trips (source "mileiq").

import { USES, browserTz, round2, fmtDateUS } from "./shared/trips.js";
import { parseMileIq, toTrips, isDuplicate, findFileDuplicates, guessUse, FIELD_KEYS, FIELD_LABELS } from "./shared/mileiq.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const ZONES = ["America/New_York", "America/Detroit", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu"];

export function importDialog({ api, openDialog, closeDialog, toast, vehicles, automation, onDone }) {
  const tzs = [...new Set([browserTz(), ...ZONES])];
  openDialog(
    `<h2>Import MileIQ history</h2>
     <p class="hint">In MileIQ (web dashboard → Drives, or Reports), export your drives as <b>CSV</b>, then choose the file here (you can pick several, e.g. one per year).
       Every column is matched by its header name, so older and newer MileIQ exports both work. Nothing is saved until you press Import.</p>
     <label class="field"><span>MileIQ CSV file(s)</span><input type="file" id="miFile" accept=".csv,text/csv" multiple></label>
     <div id="miBody"></div>
     <div class="err" id="miErr"></div>
     <div class="dlg-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" id="miGo" disabled>Import</button></div>`,
    (el) => {
      const $ = (s) => el.querySelector(s);
      let texts = [];
      let parsed = null;
      let cols = null;
      let existing = [];
      let plan = null;
      const st = { tz: browserTz(), catUse: {}, purUse: {}, veh: {}, skipDups: true, markFileDups: true };

      const defVeh = vehicles.find((v) => v.id === automation.defaultVehicleId) || vehicles[0];
      const vehicleOf = (r) => {
        const sel = st.veh[r.vehicle] ?? "";
        if (sel === "keep") return { id: "", name: r.vehicle };
        if (sel.startsWith("v:")) {
          const v = vehicles.find((x) => x.id === sel.slice(2));
          return v ? { id: v.id, name: v.name } : null;
        }
        return null;
      };
      const useOf = (r) => (r.purpose && st.purUse[r.purpose]) || st.catUse[r.category] || "unclassified";

      async function load() {
        $("#miErr").textContent = "";
        parsed = null;
        for (const text of texts) {
          const p = parseMileIq(text, cols);
          if (p.error) {
            parsed = p;
            break;
          }
          if (!parsed) parsed = { ...p, rows: [...p.rows], skipped: [...p.skipped] };
          else {
            parsed.rows.push(...p.rows);
            parsed.skipped.push(...p.skipped);
          }
        }
        if (parsed.error) {
          $("#miBody").innerHTML = "";
          $("#miGo").disabled = true;
          return ($("#miErr").textContent = parsed.error);
        }
        cols = parsed.cols;
        // Defaults for categories, purposes and vehicles (kept if the user already chose).
        for (const r of parsed.rows) {
          if (!(r.category in st.catUse)) st.catUse[r.category] = guessUse(r.category) || "unclassified";
          if (r.purpose && !(r.purpose in st.purUse)) st.purUse[r.purpose] = guessUse(r.purpose) || "";
          if (!(r.vehicle in st.veh)) {
            const m = vehicles.find((v) => v.name.trim().toLowerCase() === r.vehicle.toLowerCase());
            st.veh[r.vehicle] = m ? `v:${m.id}` : r.vehicle ? "keep" : defVeh ? `v:${defVeh.id}` : "";
          }
        }
        if (parsed.rows.length) {
          const dates = parsed.rows.map((r) => r.date).sort();
          $("#miBody").innerHTML = `<p class="hint">Checking for drives you already have…</p>`;
          existing = await api.getTrips(dates[0], dates[dates.length - 1]);
        }
        render();
      }

      function render() {
        const rows = parsed.rows;
        const timeKnown = rows.some((r) => r.startTime);
        const trips = toTrips(rows, { tz: st.tz, useOf, vehicleOf });
        const fileDups = timeKnown ? findFileDuplicates(trips) : new Map();
        if (st.markFileDups) {
          for (const [j, i] of fileDups) {
            const k = trips[i];
            Object.assign(trips[j], {
              excluded: true,
              excludedReason: "duplicate",
              notes: [trips[j].notes, `MileIQ recorded this drive twice; kept the ${rows[i].startTime} drive (${k.miles} mi)`].filter(Boolean).join(" · "),
            });
          }
        }
        const dups = trips.map((t) => isDuplicate(t, existing, timeKnown));
        const keep = trips.filter((_, i) => !st.skipDups || !dups[i]);
        plan = keep;
        const nDup = dups.filter(Boolean).length;
        const counted = keep.filter((t) => !t.excluded);
        const miles = round2(counted.reduce((a, t) => a + t.miles, 0));
        const dupMiles = round2([...fileDups.keys()].reduce((a, j) => a + trips[j].miles, 0));
        const dates = rows.map((r) => r.date).sort();
        const byUse = {};
        counted.forEach((t) => (byUse[t.use] = round2((byUse[t.use] || 0) + t.miles)));

        const count = (key) => rows.reduce((m, r) => ((m[r[key]] = (m[r[key]] || 0) + 1), m), {});
        const cats = Object.entries(count("category")).sort((a, b) => b[1] - a[1]);
        const purs = Object.entries(count("purpose")).filter(([k]) => k).sort((a, b) => b[1] - a[1]);
        const vehs = Object.entries(count("vehicle")).sort((a, b) => b[1] - a[1]);
        const useSel = (val, blank) =>
          (blank ? `<option value="">${esc(blank)}</option>` : "") +
          USES.map((u) => `<option value="${u.id}" ${val === u.id ? "selected" : ""}>${esc(u.label)}</option>`).join("");
        const vehSel = (name, val) =>
          `<option value="">— none</option>` +
          (name ? `<option value="keep" ${val === "keep" ? "selected" : ""}>Keep as “${esc(name)}”</option>` : "") +
          vehicles.map((v) => `<option value="v:${esc(v.id)}" ${val === "v:" + v.id ? "selected" : ""}>${esc(v.name)}</option>`).join("");
        const header = parsed.header;
        const colSel = (f) =>
          `<option value="">— not in file</option>` + header.map((h, i) => `<option value="${i}" ${cols[f] === i ? "selected" : ""}>${esc(h || `Column ${i + 1}`)}</option>`).join("");
        const unassigned = counted.filter((t) => t.use === "unclassified").length;

        $("#miBody").innerHTML = `
          <div class="mi-summary">
            <div><b>${rows.length}</b><span>drives in file</span></div>
            <div><b>${keep.length}</b><span>to import</span></div>
            <div><b>${miles.toFixed(1)}</b><span>miles counted</span></div>
            <div><b>${rows.length ? `${fmtDateUS(dates[0])} – ${fmtDateUS(dates[dates.length - 1])}` : "—"}</b><span>date range</span></div>
          </div>
          ${fileDups.size ? `<label class="mi-check"><input type="checkbox" id="miFileDups" ${st.markFileDups ? "checked" : ""}> Mark ${fileDups.size} drives MileIQ recorded twice as removed (${dupMiles.toFixed(1)} mi; two phones in the same car: same start or end within 15 min and about the same miles). They are kept, so you can restore any of them.</label>` : ""}
          ${nDup ? `<label class="mi-check"><input type="checkbox" id="miDups" ${st.skipDups ? "checked" : ""}> Skip ${nDup} drive${nDup > 1 ? "s" : ""} you already have (imported before, or also recorded by the phone)</label>` : ""}
          ${parsed.skipped.length ? `<details class="mi-det"><summary>${parsed.skipped.length} line${parsed.skipped.length > 1 ? "s" : ""} skipped (totals or rows with no date/miles)</summary>${parsed.skipped.slice(0, 8).map((s) => `<div class="hint">Line ${s.line}: ${esc(s.text)}</div>`).join("")}</details>` : ""}

          <h3>Category → Use</h3>
          <table class="sum mi-map">${cats.map(([c, n]) => `<tr><td>${esc(c || "(blank)")} <small>${n}</small></td><td><select data-cat="${esc(c)}">${useSel(st.catUse[c])}</select></td></tr>`).join("")}</table>
          ${purs.length ? `<details class="mi-det" ${purs.some(([p]) => st.purUse[p]) ? "open" : ""}><summary>Override by purpose (${purs.length})</summary>
            <p class="hint">Use this when MileIQ “Business” covers both RustyRose and GPRS but the purpose tells them apart.</p>
            <table class="sum mi-map">${purs.map(([p, n]) => `<tr><td>${esc(p)} <small>${n}</small></td><td><select data-pur="${esc(p)}">${useSel(st.purUse[p], "Use the category")}</select></td></tr>`).join("")}</table></details>` : ""}

          <h3>Vehicle</h3>
          <table class="sum mi-map">${vehs.map(([v, n]) => `<tr><td>${esc(v || "(no vehicle in file)")} <small>${n}</small></td><td><select data-veh="${esc(v)}">${vehSel(v, st.veh[v])}</select></td></tr>`).join("")}</table>

          <label class="field"><span>Time zone the drives were in</span><select id="miTz">${tzs.map((z) => `<option ${z === st.tz ? "selected" : ""}>${esc(z)}</option>`).join("")}</select></label>

          <div class="mi-use">${USES.filter((u) => byUse[u.id]).map((u) => `<span><i style="background:${u.color}"></i>${esc(u.label)} <b>${byUse[u.id].toFixed(1)}</b></span>`).join("")}</div>
          ${unassigned ? `<div class="warnbox">${unassigned} drive${unassigned > 1 ? "s" : ""} will come in as Unclassified. You can classify them afterwards in the Table view (filter Show → Needs review, then bulk change).</div>` : ""}

          <details class="mi-det"><summary>Columns found</summary>
            <div class="grid2">${FIELD_KEYS.map((f) => `<label class="field"><span>${esc(FIELD_LABELS[f])}</span><select data-col="${f}">${colSel(f)}</select></label>`).join("")}</div>
          </details>
          <details class="mi-det" open><summary>First drives</summary>
            <div class="mi-scroll"><table class="sum"><thead><tr><th>Date</th><th>Time</th><th>From</th><th>To</th><th>Miles</th><th>Use</th><th>Vehicle</th><th></th></tr></thead><tbody>
            ${trips.slice(0, 8).map((t, i) => `<tr><td>${fmtDateUS(t.date)}</td><td>${esc(rows[i].startTime || "—")}${rows[i].endTime ? "–" + esc(rows[i].endTime) : ""}</td><td>${esc(t.startAddress)}</td><td>${esc(t.endAddress)}</td><td>${t.miles.toFixed(1)}</td><td>${esc(USES.find((u) => u.id === t.use)?.label)}</td><td>${esc(t.vehicle)}</td><td>${dups[i] ? `<small title="${esc(dups[i])}">have it</small>` : fileDups.has(i) && st.markFileDups ? `<small>twice</small>` : ""}</td></tr>`).join("")}
            </tbody></table></div>
            ${!timeKnown ? `<p class="hint">No start times in this file, so drives are stored at midnight on their date.</p>` : ""}
            <p class="hint">MileIQ exports have addresses but no GPS track, so imported drives show in lists, the table and reports but not as lines on the map.</p>
          </details>`;
        $("#miGo").disabled = !keep.length;
        $("#miGo").textContent = keep.length ? `Import ${keep.length} drive${keep.length > 1 ? "s" : ""}` : "Import";
      }

      $("#miFile").onchange = async (e) => {
        const files = [...e.target.files];
        if (!files.length) return;
        texts = await Promise.all(files.map((f) => f.text()));
        cols = null;
        load().catch((err) => ($("#miErr").textContent = err.message));
      };
      $("#miBody").onchange = (e) => {
        const t = e.target;
        if (t.dataset.cat != null) st.catUse[t.dataset.cat] = t.value;
        else if (t.dataset.pur != null) st.purUse[t.dataset.pur] = t.value;
        else if (t.dataset.veh != null) st.veh[t.dataset.veh] = t.value;
        else if (t.id === "miTz") st.tz = t.value;
        else if (t.id === "miDups") st.skipDups = t.checked;
        else if (t.id === "miFileDups") st.markFileDups = t.checked;
        else if (t.dataset.col) {
          cols = { ...cols };
          if (t.value === "") delete cols[t.dataset.col];
          else cols[t.dataset.col] = +t.value;
          return load().catch((err) => ($("#miErr").textContent = err.message));
        }
        render();
      };
      $("#miGo").onclick = async () => {
        if (!plan?.length) return;
        const go = $("#miGo");
        go.disabled = true;
        try {
          await api.importTrips(plan, (done, total) => (go.textContent = `Saving ${done} / ${total}…`));
          const n = plan.length;
          const removed = plan.filter((t) => t.excluded).length;
          const first = [...plan].sort((a, b) => a.date.localeCompare(b.date))[0].date;
          closeDialog();
          toast(`Imported ${n} MileIQ drive${n > 1 ? "s" : ""}${removed ? ` (${removed} marked as duplicates)` : ""}`);
          onDone?.(first);
        } catch (err) {
          $("#miErr").textContent = err.message;
          go.disabled = false;
          go.textContent = "Try again";
        }
      };
    },
  );
}
