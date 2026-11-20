// MileIQ CSV import. Pure functions only (no DOM, no Firebase), shared with the
// app like trips.js. MileIQ has changed its export layout over the years, so
// columns are found by header name, not position, and summary/preamble lines
// before the table are skipped.
//
//   Classic export:  START_DATE*,END_DATE*,CATEGORY*,START*,STOP*,MILES*,PURPOSE*
//   Newer exports:   Date, Start Time, End Time, Start Location, End Location,
//                    Category, Purpose, Vehicle, Miles / Distance (mi), Parking,
//                    Tolls, Notes, ... (order and extras vary)

import { zonedToEpoch, round2 } from "./trips.js";

/** RFC-4180 CSV -> array of rows (array of strings). Handles quotes, CRLF, BOM. */
export function parseCsv(text) {
  text = String(text || "").replace(/^﻿/, "");
  const rows = [];
  let row = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const norm = (s) => String(s || "").toLowerCase().replace(/\*/g, "").replace(/[^a-z0-9]+/g, " ").trim();

// Field -> header tests, checked in order. The first header that matches wins.
const FIELDS = [
  ["startDateTime", (h) => /^(start date|start date time|started|start datetime|start date and time)$/.test(h)],
  ["endDateTime", (h) => /^(end date|end date time|stop date|ended|end datetime|end date and time)$/.test(h)],
  ["date", (h) => /^(date|drive date|trip date|day)$/.test(h)],
  ["startTime", (h) => /^(start time|time start|departure time|start time local)$/.test(h)],
  ["endTime", (h) => /^(end time|stop time|time end|arrival time|end time local)$/.test(h)],
  ["from", (h) => /^(start|from|start location|start address|starting address|origin|start place|from location|from address)$/.test(h)],
  ["to", (h) => /^(stop|end|to|end location|end address|ending address|destination|end place|stop location|to location|to address)$/.test(h)],
  ["miles", (h) => /^(miles|mileage|distance|distance mi|distance miles|miles driven|total miles|business miles)$/.test(h)],
  ["category", (h) => /^(category|classification|type|drive type|class)$/.test(h)],
  ["purpose", (h) => /^(purpose|business purpose|reason)$/.test(h)],
  ["vehicle", (h) => /^(vehicle|car|vehicle name)$/.test(h)],
  ["notes", (h) => /^(notes|note|description|comments|memo)$/.test(h)],
  ["parking", (h) => /^(parking|parking fees|parking cost)$/.test(h)],
  ["tolls", (h) => /^(tolls|toll|tolls fees|toll cost)$/.test(h)],
];

export const FIELD_LABELS = {
  startDateTime: "Start date/time", endDateTime: "End date/time", date: "Date", startTime: "Start time",
  endTime: "End time", from: "Starting address", to: "Ending address", miles: "Miles", category: "Category",
  purpose: "Purpose", vehicle: "Vehicle", notes: "Notes", parking: "Parking", tolls: "Tolls",
};
export const FIELD_KEYS = FIELDS.map(([k]) => k);

/** {field: columnIndex} for one header row. */
export function mapHeader(header) {
  const cols = {};
  const used = new Set();
  for (const [field, test] of FIELDS) {
    const i = header.findIndex((h, idx) => !used.has(idx) && test(norm(h)));
    if (i >= 0) {
      cols[field] = i;
      used.add(i);
    }
  }
  return cols;
}

/** Finds the table's header row (skips MileIQ's summary preamble). */
export function findHeader(rows) {
  for (let r = 0; r < Math.min(rows.length, 60); r++) {
    const cols = mapHeader(rows[r]);
    if (cols.miles != null && (cols.startDateTime != null || cols.date != null)) return { index: r, cols };
  }
  return null;
}

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const p2 = (n) => String(n).padStart(2, "0");
const fullYear = (y) => (y < 100 ? 2000 + y : y);

/** "HH:MM" from "8:15 AM", "20:15", "08:15:33", "8:15pm"; null if none. */
export function parseTime(s) {
  const m = String(s || "").match(/(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?\s*([ap])?\.?\s*m?\.?/i);
  if (!m) return null;
  let h = +m[1];
  const mi = +m[2];
  const ap = m[3]?.toLowerCase();
  if (ap === "p" && h < 12) h += 12;
  if (ap === "a" && h === 12) h = 0;
  if (h > 23 || mi > 59) return null;
  return `${p2(h)}:${p2(mi)}`;
}

/**
 * Parses a MileIQ date or date+time cell. US month/day order for slashes.
 * Returns {date: "YYYY-MM-DD", time: "HH:MM" | null} or null.
 */
export function parseDateTime(s) {
  s = String(s || "").trim();
  if (!s) return null;
  let y, mo, d, rest;
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(.*)$/))) [, y, mo, d, rest] = m;
  else if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(.*)$/))) [, mo, d, y, rest] = m;
  else if ((m = s.match(/^(?:[a-z]+,?\s+)?([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(.*)$/i))) {
    // "Jan 3, 2024 8:15 AM", "Wednesday, January 3, 2024"
    const idx = MONTH_NAMES.indexOf(m[1].slice(0, 3).toLowerCase());
    if (idx < 0) return null;
    [mo, d, y, rest] = [idx + 1, m[2], m[3], m[4]];
  } else if ((m = s.match(/^(\d{1,2})\s+([a-z]{3,9})\.?,?\s+(\d{4})(.*)$/i))) {
    // "3 Jan 2024"
    const idx = MONTH_NAMES.indexOf(m[2].slice(0, 3).toLowerCase());
    if (idx < 0) return null;
    [d, mo, y, rest] = [m[1], idx + 1, m[3], m[4]];
  } else return null;
  y = fullYear(+y);
  mo = +mo;
  d = +d;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
  return { date: `${y}-${p2(mo)}-${p2(d)}`, time: parseTime(rest) };
}

const num = (s) => {
  const v = parseFloat(String(s ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(v) ? v : null;
};

/**
 * Turns CSV text into plain drive records. `cols` overrides the detected
 * column map. Returns {rows, skipped, headerIndex, cols, header} or {error}.
 */
export function parseMileIq(text, cols = null) {
  const all = parseCsv(text);
  const found = findHeader(all);
  if (!found && !cols) return { error: "Couldn't find a header row with a date and a miles column." };
  const headerIndex = found ? found.index : 0;
  const header = all[headerIndex] || [];
  cols = cols || found.cols;
  const get = (r, f) => (cols[f] == null ? "" : String(r[cols[f]] ?? "").trim());
  const rows = [];
  const skipped = [];
  for (let i = headerIndex + 1; i < all.length; i++) {
    const r = all[i];
    if (!r.some((c) => String(c).trim())) continue;
    const start = parseDateTime(get(r, "startDateTime") || get(r, "date"));
    const miles = num(get(r, "miles"));
    if (!start || miles == null) {
      skipped.push({ line: i + 1, text: r.join(", ").slice(0, 120) });
      continue;
    }
    const end = parseDateTime(get(r, "endDateTime"));
    const startTime = start.time || parseTime(get(r, "startTime"));
    const endTime = end?.time || parseTime(get(r, "endTime"));
    rows.push({
      line: i + 1,
      date: start.date,
      startTime,
      endDate: end?.date || start.date,
      endTime,
      from: get(r, "from"),
      to: get(r, "to"),
      miles: round2(miles),
      category: get(r, "category"),
      purpose: get(r, "purpose"),
      vehicle: get(r, "vehicle"),
      notes: get(r, "notes"),
      parking: num(get(r, "parking")),
      tolls: num(get(r, "tolls")),
    });
  }
  return { rows, skipped, headerIndex, header, cols };
}

/** Best guess of this app's use for a MileIQ category or purpose. null = no opinion. */
export function guessUse(label) {
  const s = norm(label);
  if (!s) return null;
  if (/rusty|rose|photo/.test(s)) return "rustyrose";
  if (/gprs|ground pen|radar|locat|utility|scan/.test(s)) return "gprs";
  if (/personal|commut|medical|moving|charit/.test(s)) return "personal";
  if (/unclass|undecided/.test(s)) return "unclassified";
  return null;
}

function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Drive records -> trip documents. Ids are derived from the drive's contents,
 * so importing the same file twice yields the same ids (no double counting).
 *   useOf(row) -> use id; vehicleOf(row) -> {id, name}
 */
export function toTrips(rows, { tz, useOf, vehicleOf }) {
  const seen = new Map();
  return rows.map((r) => {
    const key = [r.date, r.startTime, r.endTime, r.miles, r.from, r.to].join("|");
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    const startTs = zonedToEpoch(r.date, r.startTime || "00:00", tz);
    let endTs = r.endTime ? zonedToEpoch(r.endDate, r.endTime, tz) : startTs;
    if (endTs < startTs) endTs += 24 * 3600 * 1000;
    const extra = [
      r.purpose && norm(r.purpose) !== norm(r.category) && `Purpose: ${r.purpose}`,
      r.parking ? `Parking $${r.parking.toFixed(2)}` : "",
      r.tolls ? `Tolls $${r.tolls.toFixed(2)}` : "",
    ].filter(Boolean);
    const v = vehicleOf(r) || { id: "", name: "" };
    const use = useOf(r) || "unclassified";
    return {
      id: `mileiq-${fnv(key)}${n > 1 ? "-" + n : ""}`,
      source: "mileiq",
      date: r.date,
      tz,
      startTs,
      endTs,
      startAddress: r.from,
      endAddress: r.to,
      miles: r.miles,
      gpsMiles: null,
      use,
      useLocked: use !== "unclassified",
      autoRule: "",
      vehicleId: v.id,
      vehicle: v.name,
      excluded: false,
      excludedReason: "",
      notes: [r.notes, ...extra].filter(Boolean).join(" · "),
      path: "",
      importedAt: Date.now(),
    };
  });
}

const zipOf = (a) => (String(a || "").match(/\b(\d{5})\b(?!.*\b\d{5}\b)/) || [])[1] || "";
const samePlace = (a, b) => {
  if (!a || !b) return false;
  if (norm(a) === norm(b)) return true;
  const za = zipOf(a);
  return Boolean(za) && za === zipOf(b);
};

/**
 * Drives the file itself records twice: two phones on one MileIQ account in
 * the same car log the same trip a minute or two apart. A pair counts when
 * both start within 15 minutes, miles agree within max(0.5, 10%), and the
 * start or the end is the same place (same name, or same ZIP code). Two
 * people driving at the same time in different towns never match.
 * Returns Map(laterIndex -> earlierIndex); the earlier drive is the one kept.
 */
export function findFileDuplicates(trips) {
  const order = trips.map((_, i) => i).sort((a, b) => trips[a].startTs - trips[b].startTs);
  const dup = new Map();
  for (let x = 0; x < order.length; x++) {
    const i = order[x];
    if (dup.has(i)) continue;
    const a = trips[i];
    for (let y = x + 1; y < order.length; y++) {
      const j = order[y];
      const b = trips[j];
      if (b.startTs - a.startTs > 15 * 60000) break;
      if (dup.has(j)) continue;
      const big = Math.max(a.miles, b.miles);
      if (Math.abs(a.miles - b.miles) > Math.max(0.5, big * 0.1)) continue;
      if (samePlace(a.startAddress, b.startAddress) || samePlace(a.endAddress, b.endAddress)) dup.set(j, i);
    }
  }
  return dup;
}

/**
 * Is `t` already in `existing`? Same id, or a drive that starts within 15
 * minutes with about the same miles (a drive both apps recorded). Imports with
 * no start time only match on same day + miles within 0.2.
 */
export function isDuplicate(t, existing, timeKnown = true) {
  for (const e of existing) {
    if (e.id === t.id) return "already imported";
    if (e.date !== t.date) continue;
    const dm = Math.abs(Number(e.miles || 0) - t.miles);
    if (timeKnown) {
      if (Math.abs(e.startTs - t.startTs) <= 15 * 60000 && dm <= Math.max(0.5, t.miles * 0.1)) return "same drive already recorded";
    } else if (dm <= 0.2) return "same day and miles already recorded";
  }
  return "";
}
