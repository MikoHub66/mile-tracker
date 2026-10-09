import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  encodePolyline, decodePolyline, zonedToEpoch, localParts, fmtTime, applyWallClock,
  reportTrips, buildCsv, buildTableCsv, monthSummary, learnUse, normalizeTrip, haversineM,
} from "../www/shared/trips.js";

const here = dirname(fileURLToPath(import.meta.url));

test("shared copies match web/public/shared (run npm run sync:shared)", () => {
  for (const f of readdirSync(join(here, "..", "..", "web", "public", "shared")).filter((x) => x.endsWith(".js"))) {
    const a = readFileSync(join(here, "..", "www", "shared", f), "utf8");
    const b = readFileSync(join(here, "..", "..", "web", "public", "shared", f), "utf8");
    assert.equal(a, b, f);
  }
});

test("polyline matches Google's reference and round-trips", () => {
  const pts = [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]];
  const enc = encodePolyline(pts);
  assert.equal(enc, "_p~iF~ps|U_ulLnnqC_mqNvxq`@");
  assert.deepEqual(decodePolyline(enc), pts);
  assert.deepEqual(decodePolyline(""), []);
});

test("wall clock <-> epoch in a zone, including DST", () => {
  const tz = "America/Chicago";
  const ts = zonedToEpoch("2026-07-04", "08:05", tz);
  assert.equal(new Date(ts).toISOString(), "2026-07-04T13:05:00.000Z");
  assert.deepEqual(localParts(ts, tz), { date: "2026-07-04", time: "08:05" });
  assert.equal(fmtTime(ts, tz), "8:05 AM");
  const winter = zonedToEpoch("2026-01-15", "17:30", tz);
  assert.equal(new Date(winter).toISOString(), "2026-01-15T23:30:00.000Z");
  assert.equal(fmtTime(winter, tz), "5:30 PM");
});

test("editing times past midnight rolls the end to the next day", () => {
  const r = applyWallClock({ tz: "America/New_York" }, { date: "2026-03-01", startTime: "23:40", endTime: "00:20" });
  assert.equal(r.endTs - r.startTs, 40 * 60_000);
  assert.equal(r.date, "2026-03-01");
});

const tz = "America/Chicago";
const mk = (date, time, miles, use, extra = {}) =>
  normalizeTrip({
    id: date + time, date, tz, startTs: zonedToEpoch(date, time, tz), endTs: zonedToEpoch(date, time, tz) + 1_800_000,
    startAddress: "1 Main St, Springfield, IL", endAddress: 'Shop "A", 2 Elm St', miles, use, vehicle: "F-150", ...extra,
  });

const trips = [
  mk("2026-01-05", "08:00", 10.256, "gprs"),
  mk("2026-01-06", "09:00", 5, "personal"),
  mk("2026-02-02", "10:15", 7.5, "rustyrose"),
  mk("2026-02-03", "11:00", 300, "personal", { excluded: true, excludedReason: "plane" }),
  mk("2025-12-31", "11:00", 4, "gprs"),
];

test("report filters by year, month, use, removes excluded trips", () => {
  assert.equal(reportTrips(trips, { year: 2026 }).length, 3);
  assert.equal(reportTrips(trips, { year: 2026, month: 2 }).length, 1);
  assert.equal(reportTrips(trips, { year: 2026, uses: ["gprs", "rustyrose"] }).length, 2);
  assert.equal(reportTrips(trips, { year: 2026, vehicle: "RAV4" }).length, 0);
  const s = monthSummary(reportTrips(trips, { year: 2026 }));
  assert.equal(s["2026-01"].total, 15.26);
  assert.equal(s["2026-02"].rustyrose, 7.5);
});

test("CSV has the requested columns, quoting, subtotals", () => {
  const csv = buildCsv(reportTrips(trips, { year: 2026 }), { subtotals: true });
  const lines = csv.trim().split("\r\n");
  assert.equal(lines[0], "Vehicle,Date,Start Time,Starting Address,End Time,Ending Address,Miles,Use");
  assert.equal(lines[1], 'F-150,01/05/2026,8:00 AM,"1 Main St, Springfield, IL",8:30 AM,"Shop ""A"", 2 Elm St",10.26,GPRS');
  assert.ok(lines.includes(',,,,,January 2026 total,15.26,'));
  assert.ok(lines.includes(',,,,,February 2026 total,7.50,'));
  assert.ok(lines.includes(',,,,,Grand total,22.76,'));
  const plain = buildCsv(reportTrips(trips, { year: 2026 }), { subtotals: false }).trim().split("\r\n");
  assert.equal(plain.length, 4);
});

test("full table CSV lists every trip, including removed ones", () => {
  const rows = reportTrips(trips, { year: 2026, month: 2, includeRemoved: true });
  assert.equal(rows.length, 2);
  const lines = buildTableCsv(rows).trim().split("\r\n");
  assert.equal(lines[0], "Vehicle,Date,Start Time,Starting Address,End Time,Ending Address,Miles,Use,Counted in Reports,Removed Reason,GPS Miles,Source,Auto Rule,Notes");
  assert.equal(lines.length, 3);
  assert.match(lines[1], /,7\.50,RustyRose,Yes,,/);
  assert.match(lines[2], /,300\.00,Personal,No,Plane,/);
});

test("learnUse needs two consistent past trips on the same route (either direction)", () => {
  const A = [39.80, -89.66], B = [39.78, -89.70];
  const t = (id, from, to, use) => ({ id, startLat: from[0], startLng: from[1], endLat: to[0], endLng: to[1], use });
  const target = t("new", A, B, "unclassified");
  assert.equal(learnUse(target, [t(1, A, B, "gprs")]), null);
  assert.equal(learnUse(target, [t(1, A, B, "gprs"), t(2, B, A, "gprs")]), "gprs");
  assert.equal(learnUse(target, [t(1, A, B, "gprs"), t(2, A, B, "gprs"), t(3, A, B, "personal")]), null);
  assert.equal(learnUse(target, [t(1, A, B, "gprs"), t(2, A, [39.9, -89.7], "gprs")]), null);
});

test("haversine sanity", () => {
  assert.ok(Math.abs(haversineM(40, -75, 40, -74) - 85_300) < 300);
});
