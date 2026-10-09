// Shared trip helpers. This file is identical in web/public/shared and
// mobile-app/www/shared (`npm run sync:shared` copies it; a test checks they match).
// Pure functions only: no DOM, no Firebase.

export const USES = [
  { id: "unclassified", label: "Unclassified", color: "#8a8f98" },
  { id: "personal", label: "Personal", color: "#3b6ea8" },
  { id: "rustyrose", label: "RustyRose", color: "#b5475f" },
  { id: "gprs", label: "GPRS", color: "#c7861a" },
];

// Trips that were not driven in a vehicle you own. They stay in the database
// (so the phone does not re-detect them) but never appear in reports.
export const EXCLUDE_REASONS = [
  { id: "plane", label: "Plane" },
  { id: "train", label: "Train" },
  { id: "bike", label: "Bike" },
  { id: "uber", label: "Uber / taxi" },
  { id: "passenger", label: "Passenger" },
  { id: "other", label: "Other" },
];

export const useById = (id) => USES.find((u) => u.id === id) || USES[0];
export const useLabel = (id) => useById(id).label;
export const excludeLabel = (id) => (EXCLUDE_REASONS.find((r) => r.id === id) || { label: "Removed" }).label;

export const METERS_PER_MILE = 1609.344;
export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371008.8;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ---- Google encoded polyline (precision 5), same algorithm as PolylineCodec.java ----

export function encodePolyline(points) {
  let out = "";
  let pLat = 0;
  let pLng = 0;
  const enc = (v) => {
    v = v < 0 ? ~(v << 1) : v << 1;
    let s = "";
    while (v >= 0x20) {
      s += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    return s + String.fromCharCode(v + 63);
  };
  for (const [lat, lng] of points) {
    const iLat = Math.round(lat * 1e5);
    const iLng = Math.round(lng * 1e5);
    out += enc(iLat - pLat) + enc(iLng - pLng);
    pLat = iLat;
    pLng = iLng;
  }
  return out;
}

export function decodePolyline(str) {
  const pts = [];
  if (!str) return pts;
  let i = 0;
  let lat = 0;
  let lng = 0;
  const next = () => {
    let shift = 0;
    let result = 0;
    let b;
    do {
      b = str.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && i < str.length + 1);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < str.length) {
    lat += next();
    lng += next();
    pts.push([lat / 1e5, lng / 1e5]);
  }
  return pts;
}

// ---- Time zones. Trips store epoch ms plus the IANA zone they were driven in. ----

export const browserTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

const partsCache = new Map();
function partsFormatter(tz) {
  if (!partsCache.has(tz)) {
    partsCache.set(
      tz,
      new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
    );
  }
  return partsCache.get(tz);
}

function zoneParts(ts, tz) {
  const m = {};
  for (const p of partsFormatter(tz || "UTC").formatToParts(new Date(ts))) m[p.type] = p.value;
  return m;
}

/** {date: "YYYY-MM-DD", time: "HH:MM"} of `ts` as a wall clock in `tz`. */
export function localParts(ts, tz) {
  const m = zoneParts(ts, tz);
  return { date: `${m.year}-${m.month}-${m.day}`, time: `${m.hour}:${m.minute}` };
}

function offsetMs(ts, tz) {
  const m = zoneParts(ts, tz);
  const asUtc = Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour, +m.minute, +m.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/** Epoch ms for wall-clock `date` ("YYYY-MM-DD") + `time` ("HH:MM") in `tz`. */
export function zonedToEpoch(date, time, tz) {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = (time || "00:00").split(":").map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let ts = guess - offsetMs(guess, tz);
  const off2 = offsetMs(ts, tz);
  if (guess - off2 !== ts) ts = guess - off2;
  return ts;
}

/** "8:05 AM" */
export function fmtTime(ts, tz) {
  if (!Number.isFinite(ts)) return "";
  const { time } = localParts(ts, tz);
  let [h, m] = time.split(":").map(Number);
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")} ${ap}`;
}

/** "YYYY-MM-DD" -> "MM/DD/YYYY" */
export function fmtDateUS(date) {
  if (!date) return "";
  const [y, m, d] = date.split("-");
  return `${m}/${d}/${y}`;
}

export const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Re-derive date/startTs/endTs after the user edits the wall-clock fields. */
export function applyWallClock(trip, { date, startTime, endTime }) {
  const tz = trip.tz || browserTz();
  const startTs = zonedToEpoch(date, startTime, tz);
  let endTs = zonedToEpoch(date, endTime, tz);
  if (endTs < startTs) endTs += 24 * 3600 * 1000; // ended after midnight
  return { date, startTs, endTs, tz };
}

// ---- Report ----

export const CSV_HEADER = ["Vehicle", "Date", "Start Time", "Starting Address", "End Time", "Ending Address", "Miles", "Use"];

const csvCell = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Trips that belong in a report: not removed, in `year` (and `month` 1-12 if
 * given), matching `uses` (array of use ids, empty = all) and `vehicle` (name,
 * empty = all). Sorted by start time.
 */
export function reportTrips(trips, { year, month = 0, uses = [], vehicle = "", includeRemoved = false } = {}) {
  const prefix = month ? `${year}-${String(month).padStart(2, "0")}` : `${year}-`;
  return trips
    .filter((t) => (includeRemoved || !t.excluded) && t.date && t.date.startsWith(prefix))
    .filter((t) => !uses.length || uses.includes(t.use || "unclassified"))
    .filter((t) => !vehicle || (t.vehicle || "") === vehicle)
    .sort((a, b) => a.startTs - b.startTs);
}

/** Miles per month per use: { "2026-01": { personal: 12.3, ..., total }, ... } */
export function monthSummary(trips) {
  const out = {};
  for (const t of trips) {
    const key = t.date.slice(0, 7);
    const row = (out[key] ||= { total: 0 });
    const u = t.use || "unclassified";
    row[u] = round2((row[u] || 0) + Number(t.miles || 0));
    row.total = round2(row.total + Number(t.miles || 0));
  }
  return out;
}

export function buildCsv(trips, { subtotals = true } = {}) {
  const lines = [CSV_HEADER.map(csvCell).join(",")];
  const blank = (label, miles) => ["", "", "", "", "", label, round2(miles).toFixed(2), ""];
  let curMonth = null;
  let monthMiles = 0;
  const flush = () => {
    if (subtotals && curMonth) {
      const [y, m] = curMonth.split("-");
      lines.push(blank(`${MONTHS[+m - 1]} ${y} total`, monthMiles).map(csvCell).join(","));
    }
  };
  const byUse = {};
  let total = 0;
  for (const t of trips) {
    const month = t.date.slice(0, 7);
    if (month !== curMonth) {
      flush();
      curMonth = month;
      monthMiles = 0;
    }
    const miles = round2(t.miles);
    monthMiles += miles;
    total += miles;
    const u = t.use || "unclassified";
    byUse[u] = (byUse[u] || 0) + miles;
    lines.push(
      [
        t.vehicle || "",
        fmtDateUS(t.date),
        fmtTime(t.startTs, t.tz),
        t.startAddress || "",
        fmtTime(t.endTs, t.tz),
        t.endAddress || "",
        miles.toFixed(2),
        useLabel(u),
      ]
        .map(csvCell)
        .join(","),
    );
  }
  flush();
  if (subtotals && trips.length) {
    lines.push("");
    for (const u of USES) if (byUse[u.id]) lines.push(blank(`${u.label} total`, byUse[u.id]).map(csvCell).join(","));
    lines.push(blank("Grand total", total).map(csvCell).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

export const TABLE_HEADER = [
  ...CSV_HEADER, "Counted in Reports", "Removed Reason", "GPS Miles", "Source", "Auto Rule", "Notes",
];

/** Full table export: every trip given (removed ones too), one row each, all editable fields. */
export function buildTableCsv(trips) {
  const lines = [TABLE_HEADER.map(csvCell).join(",")];
  for (const t of [...trips].sort((a, b) => a.startTs - b.startTs)) {
    lines.push(
      [
        t.vehicle || "",
        fmtDateUS(t.date),
        fmtTime(t.startTs, t.tz),
        t.startAddress || "",
        fmtTime(t.endTs, t.tz),
        t.endAddress || "",
        round2(t.miles).toFixed(2),
        useLabel(t.use || "unclassified"),
        t.excluded ? "No" : "Yes",
        t.excluded ? excludeLabel(t.excludedReason) : "",
        t.gpsMiles == null || t.gpsMiles === "" ? "" : round2(t.gpsMiles).toFixed(2),
        t.source === "manual" ? "Manual" : "Phone",
        t.autoRule || "",
        t.notes || "",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

// ---- Automation ----

/**
 * Learns from history: when at least `min` earlier trips between the same two
 * places (either direction, ends within `radiusM`) were all classified the same
 * way, returns that use id. Otherwise null.
 */
export function learnUse(trip, history, { radiusM = 200, min = 2 } = {}) {
  if (!Number.isFinite(trip.startLat) || !Number.isFinite(trip.endLat)) return null;
  const near = (aLat, aLng, bLat, bLng) =>
    Number.isFinite(aLat) && Number.isFinite(bLat) && haversineM(aLat, aLng, bLat, bLng) <= radiusM;
  const uses = new Set();
  let n = 0;
  for (const h of history) {
    if (h.id === trip.id || h.excluded || !h.use || h.use === "unclassified") continue;
    const same =
      (near(h.startLat, h.startLng, trip.startLat, trip.startLng) && near(h.endLat, h.endLng, trip.endLat, trip.endLng)) ||
      (near(h.startLat, h.startLng, trip.endLat, trip.endLng) && near(h.endLat, h.endLng, trip.startLat, trip.startLng));
    if (!same) continue;
    n++;
    uses.add(h.use);
  }
  return n >= min && uses.size === 1 ? [...uses][0] : null;
}

/** Trips the phone classified on its own and nobody has looked at yet. */
export const needsReview = (t) => !t.excluded && (t.use === "unclassified" || !t.use);

// ---- Misc ----

export function newId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/** Fields a trip document always has, filled with defaults. */
export function normalizeTrip(t) {
  return {
    source: "auto",
    vehicle: "",
    vehicleId: "",
    startAddress: "",
    endAddress: "",
    use: "unclassified",
    excluded: false,
    excludedReason: "",
    notes: "",
    path: "",
    ...t,
    miles: round2(t.miles ?? (t.gpsMiles || 0)),
  };
}

/** Shortens "123 Main St, Springfield, IL 62701, USA" for compact lists. */
export function shortAddress(a) {
  if (!a) return "Unknown location";
  return a.replace(/,\s*(USA|United States)$/, "");
}
