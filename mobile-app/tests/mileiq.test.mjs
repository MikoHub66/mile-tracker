import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv, parseDateTime, parseTime, parseMileIq, toTrips, isDuplicate, guessUse, findFileDuplicates } from "../www/shared/mileiq.js";

const tz = "America/Detroit";

test("CSV parser handles quotes, embedded commas/newlines and a BOM", () => {
  const rows = parseCsv('﻿a,"b, c","say ""hi""\nthere"\r\n1,2,3');
  assert.deepEqual(rows, [["a", "b, c", 'say "hi"\nthere'], ["1", "2", "3"]]);
});

test("dates and times in the formats MileIQ has used", () => {
  assert.deepEqual(parseDateTime("1/1/2016 21:11"), { date: "2016-01-01", time: "21:11" });
  assert.deepEqual(parseDateTime("01/03/2024 08:15 AM"), { date: "2024-01-03", time: "08:15" });
  assert.deepEqual(parseDateTime("12/31/23 12:05 PM"), { date: "2023-12-31", time: "12:05" });
  assert.deepEqual(parseDateTime("2024-07-04 17:30:00"), { date: "2024-07-04", time: "17:30" });
  assert.deepEqual(parseDateTime("Jan 3, 2024 8:15 PM"), { date: "2024-01-03", time: "20:15" });
  assert.deepEqual(parseDateTime("Wednesday, January 3, 2024"), { date: "2024-01-03", time: null });
  assert.equal(parseDateTime("Total"), null);
  assert.equal(parseTime("12:10 am"), "00:10");
});

test("classic MileIQ export (START_DATE*, ... MILES*, PURPOSE*) with a totals row", () => {
  const csv = [
    "START_DATE*,END_DATE*,CATEGORY*,START*,STOP*,MILES*,PURPOSE*",
    "1/1/2016 21:11,1/1/2016 21:17,Business,Fort Pierce,Fort Pierce,5.1,Meal/Entertain",
    "1/2/2016 1:25,1/2/2016 1:37,Personal,Fort Pierce,Fort Pierce,5,",
    "Totals,,,,,10.1,",
  ].join("\n");
  const p = parseMileIq(csv);
  assert.equal(p.rows.length, 2);
  assert.equal(p.skipped.length, 1);
  assert.deepEqual(
    { date: p.rows[0].date, st: p.rows[0].startTime, et: p.rows[0].endTime, from: p.rows[0].from, miles: p.rows[0].miles, cat: p.rows[0].category, pur: p.rows[0].purpose },
    { date: "2016-01-01", st: "21:11", et: "21:17", from: "Fort Pierce", miles: 5.1, cat: "Business", pur: "Meal/Entertain" },
  );
});

test("newer export with a summary preamble, separate time columns and vehicle", () => {
  const csv = [
    "MileIQ Drives Report",
    "Name,Matt",
    "Date range,01/01/2024 - 01/31/2024",
    "",
    "Date,Start Time,End Time,Category,Purpose,Start Location,End Location,Vehicle,Distance (mi),Parking,Tolls,Notes",
    '01/05/2024,7:58 AM,8:31 AM,Business,GPRS locate,"100 Main St, Dundee, MI","Toledo, OH",F-150,"29.9",,2.50,job 44',
  ].join("\r\n");
  const p = parseMileIq(csv);
  assert.equal(p.headerIndex, 4);
  assert.equal(p.rows.length, 1);
  const r = p.rows[0];
  assert.equal(r.from, "100 Main St, Dundee, MI");
  assert.equal(r.vehicle, "F-150");
  assert.equal(r.miles, 29.9);
  const [t] = toTrips(p.rows, { tz, useOf: (x) => guessUse(x.purpose) || "unclassified", vehicleOf: (x) => ({ id: "", name: x.vehicle }) });
  assert.equal(t.use, "gprs");
  assert.equal(t.source, "mileiq");
  assert.equal(new Date(t.startTs).toISOString(), "2024-01-05T12:58:00.000Z");
  assert.equal(t.endTs - t.startTs, 33 * 60000);
  assert.match(t.notes, /job 44 · Purpose: GPRS locate · Tolls \$2\.50/);
});

test("ids are stable across re-imports and duplicates are detected", () => {
  const csv = "Start Date,End Date,Category,Start,Stop,Miles\n3/2/2024 9:00,3/2/2024 9:20,Personal,A,B,10\n3/2/2024 9:00,3/2/2024 9:20,Personal,A,B,10";
  const opts = { tz, useOf: () => "personal", vehicleOf: () => null };
  const a = toTrips(parseMileIq(csv).rows, opts);
  const b = toTrips(parseMileIq(csv).rows, opts);
  assert.deepEqual(a.map((t) => t.id), b.map((t) => t.id));
  assert.notEqual(a[0].id, a[1].id); // two identical rows stay two drives
  assert.equal(isDuplicate(b[0], a), "already imported");
  const phone = { id: "x", date: "2024-03-02", startTs: a[0].startTs + 4 * 60000, miles: 10.3 };
  assert.equal(isDuplicate({ ...a[0], id: "new" }, [phone]), "same drive already recorded");
  assert.equal(isDuplicate({ ...a[0], id: "new" }, [{ ...phone, miles: 25 }]), "");
});

test("guessUse maps the obvious categories", () => {
  assert.equal(guessUse("Personal"), "personal");
  assert.equal(guessUse("RustyRose Photography"), "rustyrose");
  assert.equal(guessUse("Business"), null);
});

// Layout of the MileIQ "Drives Report" CSV (2025/2026 exports): rates line,
// SUMMARY block with spreadsheet formulas, then DETAILED LOG. Addresses are made up.
const REPORT = [
  "rates >>>,business $,0.76,medical $,0.235,charity $,0.14,moving $,0.235",
  "",
  "SUMMARY",
  "",
  "VEHICLE,ODOMETER (START OF YEAR),BUSINESS,COMMUTE,PERSONAL (OTHER),TOTAL DISTANCE,BUSINESS VALUE IN $,PARKING IN $,TOLLS IN $,TOTAL VALUE IN $,MEDICAL,MOVING,CHARITY",
  'Car A,0,"=SUMIFS(G13:G20, L13:L20, A6, C13:C20, ""Business"")",x,x,x,x,x,x,x,x,x,x',
  ",TOTALS,=SUM(C6:C7),=SUM(D6:D7)",
  "",
  "DETAILED LOG",
  "",
  "START_DATE*,END_DATE*,CATEGORY*,START*,STOP*,RATE,MILES*,MILES_VALUE,PARKING,TOLLS,TOTAL,VEHICLE,PURPOSE,NOTES",
  // the same drive from two phones (same end ZIP, 2 min apart)
  '03/08/2026 21:43,03/08/2026 21:53,Business,Home,"500 Test St, Dundee, MI, 48131, United States",0.725,7.5,"=ROUND(PRODUCT(F13, G13), 2)",0,0,"=SUM(H13, I13, J13)",Car B,Customer Visit,',
  '03/08/2026 21:45,03/08/2026 21:56,Business,Home,"510 Test St, Dundee, MI, 48131, United States",0.725,7.1,"=ROUND(PRODUCT(F14, G14), 2)",0,0,"=SUM(H14, I14, J14)",Car B,Customer Visit,',
  // two people driving at the same time in different states: not duplicates
  '01/14/2025 11:20,01/14/2025 11:23,Business,"1 Airport Dr, Dallas, TX, 75261, United States","2 Cargo Rd, Dallas, TX, 75261, United States",0.7,3.0,"=ROUND(PRODUCT(F15, G15), 2)",0,0,"=SUM(H15, I15, J15)",Car A,Business,',
  '01/14/2025 11:33,01/14/2025 11:34,Business,"9 Main St, Toledo, OH, 43623, United States",Costco,0.7,2.6,"=ROUND(PRODUCT(F16, G16), 2)",0,0,"=SUM(H16, I16, J16)",Car A,Business,',
  // past midnight
  '10/14/2025 22:52,10/15/2025 00:48,Business,"7 Test Rd, Indianapolis, IN, 46219, United States","5 Test Rd, Woodburn, IN, 46797, United States",0.7,132.8,"=ROUND(PRODUCT(F17, G17), 2)",0,0,"=SUM(H17, I17, J17)",Car A,GPRS,',
  "Totals,,,,,,=SUM(G11:G20),=SUM(H11:H20),=SUM(I11:I20),=SUM(J11:J20),=SUM(K11:K20)",
  "",
  "Report created at MileIQ.com",
  "",
  '"* For an IRS compliant log, these are required for every drive."',
].join("\r\n");

test("MileIQ Drives Report layout: skips summary/formulas, reads the detailed log", () => {
  const p = parseMileIq(REPORT);
  assert.equal(p.rows.length, 5);
  assert.equal(p.header[0], "START_DATE*");
  const last = p.rows[4];
  assert.deepEqual([last.date, last.startTime, last.endDate, last.endTime, last.miles, last.purpose], ["2025-10-14", "22:52", "2025-10-15", "00:48", 132.8, "GPRS"]);
  const trips = toTrips(p.rows, { tz, useOf: (r) => guessUse(r.purpose) || "unclassified", vehicleOf: (r) => ({ id: "", name: r.vehicle }) });
  assert.equal(trips[4].use, "gprs");
  assert.equal(trips[4].endTs - trips[4].startTs, 116 * 60000);
  assert.equal(trips[2].notes, ""); // purpose "Business" = category, no noise
});

test("findFileDuplicates catches two-phone double recordings only", () => {
  const p = parseMileIq(REPORT);
  const trips = toTrips(p.rows, { tz, useOf: () => "unclassified", vehicleOf: () => null });
  const d = findFileDuplicates(trips);
  assert.deepEqual([...d.entries()], [[1, 0]]);
});
